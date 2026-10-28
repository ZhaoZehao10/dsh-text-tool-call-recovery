// 全量真实数据健康检查（固化版）
// 对每条真实流：跑插件 → 校验不变式 → 实时装配 → 持久化回放装配 → 比对一致性
// 断言：零失败、零校验拒绝、两路径一致
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadHostValidator } from "./_host-invariant.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LLM = (() => {
	const cands = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
	].filter(Boolean);
	for (const c of cands) if (fs.existsSync(c)) return c;
	return null;
})();
if (LLM === null) { console.log("跳过：找不到 dsh-llm"); process.exit(0); }

const { expandAssistantStream, BlockAssembler, AssistantStreamAccumulator, assembleAssistantStream } = await import(pathToFileURL(LLM).href);
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

function decompress(p) {
	// **缺陷 160**（第 152 轮）：超大压缩会话解压后可达数百 MB，`text.split("\n")` 再翻几倍内存，
	// 让套件从几十秒恶化到 20 分钟以上直至超时。实测一个 51.2 MB 的会话让 `audit-rewrites`
	// 从 31s 恶化到 1263s。这里对**超大文件**明确跳过并打印，而不是静默拖死。
	try { const _sz = fs.statSync(p).size; if (_sz > (Number(process.env.DSH_LOG_MAX_MB) > 0 ? Number(process.env.DSH_LOG_MAX_MB) : 64) * 1048576) { console.log("  （跳过超大会话 " + (_sz / 1048576).toFixed(1) + " MB，可用 DSH_LOG_MAX_MB 调整）"); return ""; } } catch {}
	const buf = fs.readFileSync(p);
	const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
	const st = [];
	for (let i = 0; i + 4 <= buf.length; i++) {
		if (buf[i] === M[0] && buf[i + 1] === M[1] && buf[i + 2] === M[2] && buf[i + 3] === M[3]) st.push(i);
	}
	const out = [];
	for (let k = 0; k < st.length; k++) {
		const s = st[k], e = k + 1 < st.length ? st[k + 1] : buf.length;
		try { out.push(zlib.zstdDecompressSync(buf.subarray(s, e))); } catch {}
	}
	return Buffer.concat(out).toString("utf8");
}

const SESSIONS = path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "sessions");
if (!fs.existsSync(SESSIONS)) { console.log("跳过：没有会话日志"); process.exit(0); }

const TOOL_NAMES = ["pwsh","read","write","edit","grep","glob","todo_write","web_search","web_fetch","ask_user_question","present","skill","subagent","job_list","job_output","job_kill","list_agents","send_message","team_task_list","workflow","team_task_create"];
const TOOLS = TOOL_NAMES.map((name) => ({ name }));

const records = [];
(function walk(d) {
	if (!fs.existsSync(d)) return;
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p);
		else if (e.name === "session.v4.jsonl.zstd") {
			let text; try { text = decompress(p); } catch { return; }
			for (const line of text.split("\n")) {
				if (!line) continue;
				let o; try { o = JSON.parse(line); } catch { continue; }
				if (o.type !== "assistant/message") continue;
				const raw = o.data?.stream;
				if (!Array.isArray(raw) || !raw.length) continue;
				let chunks; try { chunks = expandAssistantStream(raw).map((r) => r.chunk); } catch { continue; }
				if (chunks.length === 0) continue;
				records.push({ chunks, model: o.data?.message?.source?.model });
			}
		}
	}
})(SESSIONS);

if (records.length === 0) { console.log("跳过：没有可用的流"); process.exit(0); }

// **缺陷 88**：这个手写校验器曾是本套件唯一的协议检查。
// 第 93 轮证明手写版与宿主实现有偏差（漏 R8/R9、R10 过严）。
// 现在优先用宿主真实的 validateStream；拿不到时才退回手写实现。
const HOST_VALIDATOR = loadHostValidator();

/** 用手写规则校验（**后备**，仅在拿不到宿主校验器时使用）。 */
function validateHandWritten(chunks) {
	const open = new Map();
	let usageSeen = false, finished = false;
	for (const c of chunks) {
		if (finished) return "chunk after finish";
		switch (c.type) {
			case "block-start":
				if (open.has(c.index)) return "repeated block-start";
				open.set(c.index, c.blockType); break;
			case "text-delta": case "reasoning-delta": case "tool-call-delta": {
				const exp = c.type === "text-delta" ? "text" : c.type === "reasoning-delta" ? "reasoning" : "tool-call";
				if (open.get(c.index) !== exp) return "delta for wrong block";
				break;
			}
			case "block-end": {
				const bt = open.get(c.index);
				if (bt === undefined) return "block-end without open";
				if (c.block?.type !== bt) return "block-end type mismatch";
				open.delete(c.index); break;
			}
			case "usage":
				if (usageSeen) return "usage twice";
				usageSeen = true; break;
			case "finish":
				if (open.size > 0 && c.reason?.kind !== "error" && c.reason?.kind !== "aborted") return "finished with open blocks";
				finished = true; break;
		}
	}
	return finished ? null : "no finish";
}

/** 统一入口：**优先使用宿主真实校验器**，拿不到时退回手写实现。 */
async function validate(chunks) {
	if (HOST_VALIDATOR) {
		return await HOST_VALIDATOR.validate(chunks);
	}
	// 后备：手写实现返回 string|null，这里统一成数组
	const r = validateHandWritten(chunks);
	return r === null ? [] : [String(r)];
}

let liveOk = 0, liveFail = 0, replayOk = 0, replayFail = 0, rejects = 0, rewrites = 0, incomplete = 0;
const samples = [];

for (const rec of records) {
	plugin.resetStreaks?.();
	const produced = [];
	const gen = (async function* () { for (const ch of rec.chunks) yield ch; })();
	try { for await (const c of listener({ provider: "p", model: rec.model ?? "m", messages: [], tools: TOOLS }, () => gen)) produced.push(c); }
	catch (e) { liveFail++; if (samples.length < 3) samples.push(`抛异常: ${e.message}`); continue; }

	// 不变式校验只对「原始流本身完整（含 finish）」的记录做：
	// 历史日志里存在被中断/保存不完整的流（原始就没有 finish），
	// 插件对这类流原样透传是正确行为，不应算作拒绝。
	const origComplete = rec.chunks.some((c) => c.type === "finish");
	if (origComplete) {
		// **缺陷 88**：validate() 现在优先用宿主真实校验器（异步），必须 await。
		// 返回 string[]，空数组 = 合规。
		const vErrs = await validate(produced);
		if (vErrs.length > 0) {
			rejects++;
			if (samples.length < 5) {
				samples.push(`校验拒绝[${vErrs[0]}] model=${rec.model} chunks=${produced.length} finish数=${produced.filter((c) => c.type === "finish").length}`);
			}
		}
	} else {
		incomplete++;
	}

	let live = null, replay = null;
	try {
		const asm = new BlockAssembler();
		for (const c of produced) asm.push(c);
		live = asm.assembled();
		liveOk++;
	} catch (e) { liveFail++; if (samples.length < 3) samples.push(`live: ${e.message}`); continue; }

	try {
		const acc = new AssistantStreamAccumulator();
		let t = 1700000000000;
		for (const c of produced) { acc.push({ time: t, chunk: c }); t += 5; }
		replay = assembleAssistantStream(acc.snapshot()).assembled();
		replayOk++;
	} catch (e) { replayFail++; if (samples.length < 3) samples.push(`replay: ${e.message}`); continue; }

	const fmt = (a) => JSON.stringify(a.blocks.map((b) => ({ t: b.type, x: b.type === "tool-call" ? b.name : b.text })));
	if (fmt(live) !== fmt(replay)) { replayFail++; if (samples.length < 3) samples.push("live/replay 不一致"); }

	const of = rec.chunks.find((c) => c.type === "finish");
	const nf = produced.find((c) => c.type === "finish");
	if (of?.reason?.kind !== nf?.reason?.kind) rewrites++;
}

console.log("=== 全量真实数据健康检查 ===");
console.log(`真实流      : ${records.length}`);
console.log(`实时装配    : ${liveOk} 成功 / ${liveFail} 失败`);
console.log(`持久化回放  : ${replayOk} 成功 / ${replayFail} 失败`);
console.log(`不变式拒绝  : ${rejects}`);
console.log(`原始不完整流: ${incomplete}（无 finish，原样透传）`);
console.log(`流被改写    : ${rewrites}`);

const ok = liveFail === 0 && replayFail === 0 && rejects === 0;
if (!ok && samples.length) {
	console.log("\n--- 失败样本 ---");
	for (const s of samples) console.log(`  ${s}`);
}
console.log(ok ? "\n✅ 全部真实流：零失败、零拒绝、两路径一致" : `\n❌ 存在问题`);
process.exit(ok ? 0 : 1);
