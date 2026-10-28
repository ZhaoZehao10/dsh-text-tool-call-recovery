// 真实数据反向挖掘（回归守护）
// 目的：从真实会话日志里找出「含工具调用标记但未被恢复」的消息，
// 断言它们**全部是应当忽略的形态**（行内代码/代码块/文字讨论）。
// 若某天出现「真实调用形态未被恢复」，本测试会失败并打印样本。
//
// 用法：node test/hardening/mine-unrecovered.mjs
// 依赖：真实日志在 %USERPROFILE%\.dsh\sessions；dsh-llm 用 DSH_LLM_SRC。
// 无日志时跳过（不算失败）。
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LLM = (() => {
	const cands = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
		path.join(import.meta.dirname, "..", "..", "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
	].filter(Boolean);
	for (const c of cands) if (fs.existsSync(c)) return c;
	return null;
})();
if (LLM === null) {
	console.log("跳过：找不到 dsh-llm（设置 DSH_LLM_SRC 或安装依赖）");
	process.exit(0);
}
const { expandAssistantStream } = await import(pathToFileURL(LLM).href);
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
if (!fs.existsSync(SESSIONS)) {
	console.log("跳过：没有真实会话日志目录");
	process.exit(0);
}

const TOOL_NAMES = ["pwsh","read","write","edit","grep","glob","todo_write","web_search","web_fetch","ask_user_question","present","skill","subagent","job_list","job_output","job_kill","list_agents","send_message","team_task_list","workflow","team_task_create"];
const TOOLS = TOOL_NAMES.map((name) => ({ name }));

// 同步收集候选
const cands = [];
(function walk(d) {
	if (!fs.existsSync(d)) return;
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
				if (!Array.isArray(raw) || !raw.length) continue;
				let chunks; try { chunks = expandAssistantStream(raw).map((r) => r.chunk); } catch { continue; }
				const texts = chunks.filter((c) => c.type === "block-end" && (c.block?.type === "text" || c.block?.type === "reasoning")).map((c) => c.block.text ?? "");
				const joined = texts.join("\n");
				if (!joined.includes("<tool_call>") && !joined.includes("<parameter")) continue;
				cands.push({ chunks, joined });
			}
		}
	}
})(SESSIONS);

if (cands.length === 0) {
	console.log("跳过：日志中没有含标记的消息");
	process.exit(0);
}

// 逐条跑插件
const unrecovered = [];
let recovered = 0;
for (const cand of cands) {
	plugin.resetStreaks?.();
	const out = [];
	const gen = (async function* () { for (const ch of cand.chunks) yield ch; })();
	try {
		for await (const c of listener({ provider: "p", model: "m", messages: [], tools: TOOLS }, () => gen)) out.push(c);
	} catch { continue; }
	const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	if (calls.length > 0) recovered++;
	else unrecovered.push(cand.joined);
}

// 分类未恢复样本：只允许「应当忽略」的类别
function classify(j) {
	// 1. 代码围栏（展示）
	if (/```[\s\S]*?(<tool_call>|<parameter)[\s\S]*?```/.test(j)) return "fenced-code";
	// 2. 行内代码包住标记（展示）
	if (/`[^`\n]*<tool_call>[^`\n]*`/.test(j) || /`[^`\n]*<parameter[^`\n]*`/.test(j) || /`[^`\n]*<\/tool_call>[^`\n]*`/.test(j)) return "inline-code";
	// 3. 文字讨论：标记出现在句中被中文/英文上下文包围，且没有完整内层结构
	const hasCompleteInner = /<function[=\s][\s\S]*?<\/function>/.test(j) && /<parameter[\s=][\s\S]*?<\/parameter>/.test(j);
	if (!hasCompleteInner) return "prose-with-markers";
	// 4. 其余：可能是真实漏识别
	return "UNEXPECTED";
}

console.log("=== 真实数据反向挖掘：未恢复样本分类 ===");
console.log(`含标记候选: ${cands.length}`);
console.log(`  已恢复: ${recovered}`);
console.log(`  未恢复: ${unrecovered.length}\n`);

const buckets = new Map();
for (const j of unrecovered) {
	const k = classify(j);
	const arr = buckets.get(k) ?? [];
	arr.push(j);
	buckets.set(k, arr);
}

let bad = 0;
for (const [kind, arr] of buckets) {
	if (kind === "UNEXPECTED") {
		bad += arr.length;
		console.log(`❌ UNEXPECTED（真实形态但未恢复）: ${arr.length} 条`);
		for (const j of arr.slice(0, 5)) {
			const i = Math.max(0, j.search(/<tool_call>|<parameter/));
			console.log(`   样本: ${JSON.stringify(j.slice(i, i + 260))}`);
		}
	} else {
		console.log(`✅ ${kind}: ${arr.length} 条（应忽略，正确）`);
	}
}

console.log(bad === 0 ? "\n✅ 所有未恢复样本均为应忽略形态（无真实漏识别）" : `\n❌ ${bad} 条真实形态未被恢复`);
process.exit(bad === 0 ? 0 : 1);
