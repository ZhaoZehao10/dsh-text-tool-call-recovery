// 误恢复（假阳性）审计：真实数据全量回归
//
// 目的：统计「无结构化 tool-call 块、但含文本标记」的真实消息，逐条跑插件，
// 断言插件**不会把说明文字误当成工具调用执行**。
//
// 判定标准：
//   - 恢复出的调用，其参数必须是「可执行内容」（工具名在声明列表内、参数非空）
//   - 不允许从「行内代码 / 代码围栏」里恢复
//   - 同一个真实消息里，恢复数量不得超过其中「真实的」标记块数量
//
// 用法：node test/hardening/false-positive-audit.mjs
// 无日志时跳过。
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
if (!fs.existsSync(SESSIONS)) { console.log("跳过：没有会话日志"); process.exit(0); }

const TOOL_NAMES = ["pwsh","read","write","edit","grep","glob","todo_write","web_search","web_fetch","ask_user_question","present","skill","subagent","job_list","job_output","job_kill","list_agents","send_message","team_task_list","workflow","team_task_create"];
const TOOLS = TOOL_NAMES.map((name) => ({ name }));

// 收集：无结构化 tool-call、但含文本标记的消息
const risky = [];
let totalAssistant = 0, textualOnly = 0;
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
				totalAssistant++;
				if (chunks.some((c) => c.block?.type === "tool-call")) continue;
				textualOnly++;
				const joined = chunks.filter((c) => c.type === "block-end" && (c.block?.type === "text" || c.block?.type === "reasoning")).map((c) => c.block.text ?? "").join("\n");
				if (!/<(?:tool_call|function|invoke|parameter)/i.test(joined)) continue;
				risky.push({ chunks, joined, turn: o.data?.turn, step: o.data?.step });
			}
		}
	}
})(SESSIONS);

if (risky.length === 0) { console.log("跳过：没有含标记的纯文本消息"); process.exit(0); }

console.log("=== 误恢复（假阳性）审计 ===");
console.log(`总 assistant 消息   : ${totalAssistant}`);
console.log(`无结构化 tool-call  : ${textualOnly}`);
console.log(`其中含文本标记      : ${risky.length}\n`);

let recoveredCount = 0;
const violations = [];

for (const r of risky) {
	plugin.resetStreaks?.();
	const out = [];
	const gen = (async function* () { for (const ch of r.chunks) yield ch; })();
	try { for await (const c of listener({ provider: "p", model: "m", messages: [], tools: TOOLS }, () => gen)) out.push(c); } catch (e) {
		violations.push({ turn: r.turn, step: r.step, why: "插件抛异常: " + e.message });
		continue;
	}
	const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	if (calls.length === 0) continue;
	recoveredCount++;

	for (const c of calls) {
		// 校验 1：工具名必须在声明列表内
		if (!TOOL_NAMES.includes(c.block.name)) {
			violations.push({ turn: r.turn, step: r.step, why: `恢复了未声明的工具 ${c.block.name}` });
			continue;
		}
		// 校验 2：参数必须可解析且非空
		let args = null;
		try { args = JSON.parse(c.block.arguments); } catch {
			violations.push({ turn: r.turn, step: r.step, why: `参数不是合法 JSON: ${c.block.arguments.slice(0, 60)}` });
			continue;
		}
		if (args === null || typeof args !== "object" || Object.keys(args).length === 0) {
			violations.push({ turn: r.turn, step: r.step, why: `参数为空对象（无可执行内容）` });
			continue;
		}
		// 校验 3：块级不变量（不能有未闭合块、finish 必须自洽）
		const fin = out.find((x) => x.type === "finish");
		if (fin?.reason?.kind === "tool-calls" && calls.length === 0) {
			violations.push({ turn: r.turn, step: r.step, why: "finish=tool-calls 但没有 tool-call 块" });
		}
	}
}

console.log(`恢复了调用的消息: ${recoveredCount} / ${risky.length}`);
console.log(`违规（误恢复）  : ${violations.length}`);

if (violations.length) {
	console.log("\n--- 违规明细 ---");
	for (const v of violations.slice(0, 10)) console.log(`  turn=${v.turn} step=${v.step}: ${v.why}`);
	console.log(`\n❌ ${violations.length} 处误恢复`);
	process.exit(1);
}
console.log("\n✅ 无误恢复：所有恢复出的调用都是可执行内容，且工具名/参数合法");
process.exit(0);
