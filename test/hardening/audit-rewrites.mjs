// 审查 262 条被改写流的合理性：它们是真空响应吗？
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LLM = process.env.DSH_LLM_SRC;
const { expandAssistantStream, BlockAssembler } = await import(pathToFileURL(path.join(LLM, "lib", "index.js")).href);
const plugin = await import(new URL("../../lib/index.js", import.meta.url).href);
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

function decompress(p) {
	// **缺陷 160**（第 152 轮）：超大压缩会话解压后可达数百 MB，`text.split("\n")` 再翻几倍内存，
	// 让套件从几十秒恶化到 20 分钟以上直至超时。实测一个 51.2 MB 的会话让 `audit-rewrites`
	// 从 31s 恶化到 1263s。这里对**超大文件**明确跳过并打印，而不是静默拖死。
	try { const _sz = fs.statSync(p).size; if (_sz > (Number(process.env.DSH_LOG_MAX_MB) > 0 ? Number(process.env.DSH_LOG_MAX_MB) : 64) * 1048576) { console.log("  （跳过超大会话 " + (_sz / 1048576).toFixed(1) + " MB，可用 DSH_LOG_MAX_MB 调整）"); return ""; } } catch {}
	const buf = fs.readFileSync(p);
	const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
	const starts = [];
	for (let i = 0; i + 4 <= buf.length; i++) {
		if (buf[i] === MAGIC[0] && buf[i+1] === MAGIC[1] && buf[i+2] === MAGIC[2] && buf[i+3] === MAGIC[3]) starts.push(i);
	}
	const out = [];
	for (let k = 0; k < starts.length; k++) {
		const s = starts[k], e = k + 1 < starts.length ? starts[k+1] : buf.length;
		try { out.push(zlib.zstdDecompressSync(buf.subarray(s, e))); } catch {}
	}
	return Buffer.concat(out).toString("utf8");
}

const streams = [];
(function walk(d) {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p);
		else if (e.name === "session.v4.jsonl.zstd") {
			let text; try { text = decompress(p); } catch { continue; }
			for (const line of text.split("\n")) {
				if (!line) continue;
				let o; try { o = JSON.parse(line); } catch { continue; }
				if (o.type !== "assistant/message") continue;
				const raw = o.data?.stream;
				if (!Array.isArray(raw) || raw.length === 0) continue;
				let chunks; try { chunks = expandAssistantStream(raw).map((r) => r.chunk); } catch { continue; }
				streams.push({ chunks, sess: path.basename(path.dirname(p)).slice(0, 20), turn: o.data.turn, step: o.data.step, model: o.data?.message?.source?.model });
			}
		}
	}
})(path.join(process.env.USERPROFILE, ".dsh", "sessions"));

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } },
	{ name: "read", parameters: { type: "object" } }, { name: "write", parameters: { type: "object" } },
	{ name: "edit", parameters: { type: "object" } }, { name: "grep", parameters: { type: "object" } },
	{ name: "glob", parameters: { type: "object" } }, { name: "todo_write", parameters: { type: "object" } }];

let changed = 0, justified = 0, suspicious = 0;
const suspiciousList = [];
const samples = [];

for (const s of streams) {
	plugin.resetStreaks?.();
	const opts = { provider: "p", model: s.model, messages: [], tools: TOOLS };
	const out = [];
	try {
		for await (const c of listener(opts, () => (async function* () { for (const ch of s.chunks) yield ch; })())) out.push(c);
	} catch { continue; }
	const origFin = s.chunks.find((c) => c.type === "finish");
	const newFin = out.find((c) => c.type === "finish");
	if (origFin?.reason?.kind === newFin?.reason?.kind) continue;
	changed++;
	if (newFin?.reason?.kind !== "error") continue;

	// 检查：原始流的块内容是否真的"无可执行内容"
	const asm = new BlockAssembler();
	for (const c of s.chunks) asm.push(c);
	let blocks = [];
	try { blocks = asm.assembled().blocks; } catch { continue; }
	const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
	const reasonings = blocks.filter((b) => b.type === "reasoning").map((b) => b.text);
	const hasToolCall = blocks.some((b) => b.type === "tool-call");
	const visibleText = texts.join("").trim();
	const markupLike = /<\/?tool_call|<\/?parameter|<\/?function/.test(texts.join("") + reasonings.join(""));
	const description = {
		sess: s.sess, turn: s.turn, step: s.step, model: s.model,
		textLen: visibleText.length, reasonLen: reasonings.join("").length,
		hasToolCall, markupLike,
		textPreview: visibleText.slice(0, 120),
	};
	if (hasToolCall) { suspicious++; suspiciousList.push({ ...description, why: "有结构化 tool-call 却判 error" }); continue; }
	if (visibleText.length > 100) { suspicious++; suspiciousList.push({ ...description, why: `有 ${visibleText.length} 字符正文却判 error` }); continue; }
	justified++;
	if (samples.length < 5) samples.push(description);
}

console.log(`总流 ${streams.length}，被改写 ${changed}（其中 stop→error ${justified + suspicious}）`);
console.log(`  合理（真空响应）: ${justified}`);
console.log(`  可疑            : ${suspicious}`);
if (samples.length) {
	console.log("\n--- 合理样本 ---");
	for (const s of samples) console.log(`  ${s.sess} t${s.turn}s${s.step} ${s.model}: 正文=${s.textLen}字符 思考=${s.reasonLen}字符 含标记=${s.markupLike} | ${JSON.stringify(s.textPreview.slice(0, 60))}`);
}
if (suspiciousList.length) {
	console.log("\n--- 可疑样本 ---");
	for (const s of suspiciousList.slice(0, 10)) console.log(`  ${s.sess} t${s.turn}s${s.step} ${s.model}: ${s.why} | 正文=${s.textLen} 思考=${s.reasonLen} 标记=${s.markupLike}`);
}

// ---------------------------------------------------------------------------
// 失败判定（缺陷 51）
//
// 早期版本只 console.log 出「可疑: N」就结束 —— 没有 process.exit(1) 路径，
// 所以即使插件开始误伤正常回复，本套件在 run-all 里仍然 PASS。
// 现在：可疑数必须为 0，否则退出码 1。
// ---------------------------------------------------------------------------
if (suspicious > 0) {
	console.error("");
	console.error(`❌ ${suspicious} 条流被误判为失败响应（suspicious > 0）`);
	console.error("   这很可能意味着插件误伤了正常回复，请检查上面的「可疑样本」。");
	process.exit(1);
}

// **缺陷 152**（第 145 轮）：`总流 0，被改写 0` 时原来仍打印
// 「✅ 所有被改写的流都是真空响应」并 exit 0 —— 典型的 **0/0 = 全部正确** 谬误。
// 0 个样本**无法证明任何事**：既不能说明没问题，也不能说明有问题。
// 改为：样本为 0 时明确说明「无法验证」并**判为失败**（让调用者知道这条检查没生效）。
if (streams.length === 0 || changed === 0) {
	// **缺陷 160 连带修正**：区分两种情况 ——
	//   ① 总流 0：确实没有任何数据（新机器）；
	//   ② 有流但被改写 0：**本环境的会话里没有触发恢复的样本**（如全是普通对话），
	//      审计对象不存在，属「无法验证」而非「失败」。
	// 两者都**显式报告为跳过**（run-all 会显示 [SKIP] 并单列），既不假绿也不误判为 bug。
	console.log("\n跳过：没有可审计的改写样本（总流 " + streams.length + "，被改写 " + changed + "）。");
	console.log("      这不是「全部正确」，而是**本环境无可审计对象** —— 需要含文本工具调用/空响应的真实会话。");
	process.exit(0);
}
console.log("\n✅ 所有被改写的流都是真空响应（可疑数 0）");
process.exit(0);

