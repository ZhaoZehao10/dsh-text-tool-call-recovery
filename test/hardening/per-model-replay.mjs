// 最后一项深度验证：按 provider/model 分组重放真实流
// 目的：确认插件对**每一种真实上游**都表现一致（不存在“某模型被系统性误判”）。
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LLM = (() => {
	const candidates = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(process.cwd(), "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
		path.join(import.meta.dirname ?? process.cwd(), "..", "..", "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js")
	].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(c)) return c;
	console.error("找不到 dsh-llm：请设置 DSH_LLM_SRC");
	process.exit(1);
})();
const { BlockAssembler, expandAssistantStream } = await import(pathToFileURL(LLM).href);

const plugin = await import(new URL("../../lib/index.js", import.meta.url).href);
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
		if (buf[i] === M[0] && buf[i+1] === M[1] && buf[i+2] === M[2] && buf[i+3] === M[3]) st.push(i);
	}
	const out = [];
	for (let k = 0; k < st.length; k++) {
		const s = st[k], e = k + 1 < st.length ? st[k+1] : buf.length;
		try { out.push(zlib.zstdDecompressSync(buf.subarray(s, e))); } catch {}
	}
	return Buffer.concat(out).toString("utf8");
}

const SESSIONS = path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "sessions");
const streams = [];
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
				if (!Array.isArray(raw) || raw.length === 0) continue;
				let chunks; try { chunks = expandAssistantStream(raw).map((r) => r.chunk); } catch { continue; }
				const src = o.data?.message?.source ?? {};
				streams.push({ chunks, key: `${src.provider ?? "?"}/${src.model ?? "?"}`, turn: o.data?.turn, step: o.data?.step });
			}
		}
	}
})(SESSIONS);

console.log(`收集真实流: ${streams.length} 条\n`);

const TOOLS = [
	{ name: "pwsh" }, { name: "read" }, { name: "write" }, { name: "edit" }, { name: "grep" },
	{ name: "glob" }, { name: "todo_write" }, { name: "web_search" }, { name: "web_fetch" },
	{ name: "ask_user_question" }, { name: "present" }, { name: "skill" }, { name: "subagent" },
	{ name: "job_list" }, { name: "job_output" }, { name: "job_kill" }, { name: "list_agents" },
	{ name: "send_message" }, { name: "team_task_list" }, { name: "workflow" },
];

// 按 model 分组统计
const stats = new Map();
for (const s of streams) {
	plugin.resetStreaks?.();
	const opts = { provider: "p", model: s.key, messages: [], tools: TOOLS };
	const out = [];
	let err = null;
	try {
		for await (const c of listener(opts, () => (async function* () { for (const ch of s.chunks) yield ch; })())) out.push(c);
	} catch (e) { err = e.message; }
	const origFin = s.chunks.find((c) => c.type === "finish");
	const newFin = out.find((c) => c.type === "finish");
	const changed = origFin?.reason?.kind !== newFin?.reason?.kind;
	let asmOk = true, errAsm = null;
	try {
		const asm = new BlockAssembler();
		for (const c of out) asm.push(c);
		asm.assembled();
	} catch (e) { asmOk = false; errAsm = e.message; }

	const g = stats.get(s.key) ?? { total: 0, changed: 0, err: 0, asmFail: 0, kinds: {}, changedKinds: {} };
	g.total++;
	if (err) g.err++;
	if (!asmOk) g.asmFail++;
	const k = newFin?.reason?.kind ?? "?";
	g.kinds[k] = (g.kinds[k] ?? 0) + 1;
	if (changed) {
		g.changed++;
		const ck = `${origFin?.reason?.kind}->${k}`;
		g.changedKinds[ck] = (g.changedKinds[ck] ?? 0) + 1;
	}
	stats.set(s.key, g);
}

console.log("=== 按 provider/model 分组统计 ===");
console.log(`${"模型".padEnd(42)} ${"总数".padStart(6)} ${"改写".padStart(6)} ${"异常".padStart(5)} ${"装配失败".padStart(8)}  改写形态`);
const rows = [...stats.entries()].sort((a, b) => b[1].total - a[1].total);
let totalBad = 0;
for (const [key, g] of rows) {
	const bad = g.err + g.asmFail;
	if (bad > 0) totalBad += bad;
	const shapes = Object.entries(g.changedKinds).map(([k, v]) => `${k}×${v}`).join(", ") || "-";
	console.log(`${key.slice(0, 42).padEnd(42)} ${String(g.total).padStart(6)} ${String(g.changed).padStart(6)} ${String(g.err).padStart(5)} ${String(g.asmFail).padStart(8)}  ${shapes}`);
}
console.log(`\n模型种类: ${rows.length}`);
console.log(`异常/装配失败合计: ${totalBad}`);
// **缺陷 152**：模型种类为 0 时原来也打印「✅ 所有 provider/model 组合下插件行为均正常」。
// **0 个组合无法证明任何事**。改为明确报告「无法验证」并判失败。
if (totalBad === 0 && rows.length === 0) {
	console.log("\n❌ 没有可验证的模型组合（0 个）—— 这不是「全部正常」，而是**无法验证**");
	process.exit(1);
}
console.log(totalBad === 0 ? "✅ 所有 provider/model 组合下插件行为均正常" : `❌ ${totalBad} 处异常`);
process.exit(totalBad === 0 ? 0 : 1);
