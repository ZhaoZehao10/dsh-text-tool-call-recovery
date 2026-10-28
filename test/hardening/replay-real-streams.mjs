// 深度验证 1：真实生产流重放
// 把会话日志里每一条 assistant/message 的原始 stream 原样喂给插件，
// 用真实 BlockAssembler + 真实不变式校验器验证：插件绝不能破坏任何真实流。
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadHostValidator } from "./_host-invariant.mjs";

const SESSIONS = path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "sessions");
const LLM = (() => {
	const candidates = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(process.cwd(), "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
		path.join(import.meta.dirname ?? process.cwd(), "..", "..", "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js")
	].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(c)) return c;
	console.error("找不到 dsh-llm：请设置 DSH_LLM_SRC 或在本仓库安装 @deepseek-ai/dsh-llm");
	process.exit(1);
})();

let BlockAssembler, expandAssistantStream;
try {
	({ BlockAssembler, expandAssistantStream } = await import(pathToFileURL(LLM).href));
} catch (e) {
	console.log("跳过：dsh-llm 不可用（设 DSH_LLM_SRC）", e.message);
	process.exit(0);
}

const plugin = await import(new URL("../../lib/index.js", import.meta.url).href);
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

// 真实不变式校验器（逐行复刻）
// **缺陷 88**：这个手写 validateStream 曾是本套件唯一的协议检查。
// 第 93 轮证明手写版与宿主实现有偏差（漏 R8/R9、R10 过严）。
// 现在优先用宿主真实的 validateStream；拿不到时才退回手写实现。
const HOST_VALIDATOR = loadHostValidator();

/** 手写规则校验（**后备**，仅在拿不到宿主校验器时使用）。 */
async function* validateStreamHandWritten(source, fail) {
	const open = new Map();
	let usageSeen = false, finished = false;
	for await (const chunk of source) {
		if (finished) fail(`${chunk.type} after finish`);
		switch (chunk.type) {
			case "block-start":
				if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) fail("bad index");
				if (open.has(chunk.index)) fail(`repeated block-start ${chunk.index}`);
				open.set(chunk.index, chunk.blockType); break;
			case "text-delta": case "reasoning-delta": case "tool-call-delta": {
				const exp = chunk.type === "text-delta" ? "text" : chunk.type === "reasoning-delta" ? "reasoning" : "tool-call";
				if (open.get(chunk.index) !== exp) fail(`${exp} delta at ${chunk.index} needs open ${exp}`);
				break;
			}
			case "block-end": {
				const bt = open.get(chunk.index);
				if (bt === undefined) fail(`block-end ${chunk.index} no open block`);
				if (chunk.block?.type !== bt) fail("block-end type mismatch");
				open.delete(chunk.index); break;
			}
			case "usage": if (usageSeen) fail("usage twice"); usageSeen = true; break;
			case "finish":
				if (open.size > 0 && chunk.reason?.kind !== "error" && chunk.reason?.kind !== "aborted") fail(`finish with ${open.size} open`);
				finished = true; break;
		}
		yield chunk;
	}
	if (!finished) fail("no finish");
}

/**
 * 统一的流校验包装器：**优先用宿主真实校验器**，拿不到时退回手写实现。
 *
 * 返回一个 async generator，逐块 yield —— 与宿主 `validateStream` 的签名一致，
 * 因此调用点无需改动。
 */
async function* validateStream(source, fail) {
	if (HOST_VALIDATOR) {
		// 宿主真实实现：用它的 fail 回调收集错误
		const errors = [];
		const hostFail = (m) => { errors.push(String(m)); fail(m); };
		const wrapped = HOST_VALIDATOR.validateStream(source, hostFail);
		for await (const chunk of wrapped) {
			yield chunk;
		}
		return;
	}
	// 后备：手写实现
	yield* validateStreamHandWritten(source, fail);
}

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
	const chunks = [];
	for (let k = 0; k < starts.length; k++) {
		const s = starts[k], e = k + 1 < starts.length ? starts[k+1] : buf.length;
		try { chunks.push(zlib.zstdDecompressSync(buf.subarray(s, e))); } catch {}
	}
	return Buffer.concat(chunks).toString("utf8");
}

// 收集所有真实流
const streams = [];
(function walk(d) {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p);
		else if (e.name === "session.v4.jsonl.zstd") {
			let text;
			try { text = decompress(p); } catch { continue; }
			for (const line of text.split("\n")) {
				if (!line) continue;
				let o; try { o = JSON.parse(line); } catch { continue; }
				if (o.type !== "assistant/message") continue;
				const raw = o.data?.stream;
				if (!Array.isArray(raw) || raw.length === 0) continue;
				// stream 是**压缩记录**（reasoning-chunks / text-chunks / tool-call-chunks / chunk），
				// 必须先用官方 expandAssistantStream 还原成原始 chunk 序列。
				let chunks;
				try {
					chunks = expandAssistantStream(raw).map((r) => r.chunk).filter((c) => c && typeof c.type === "string");
				} catch {
					continue; // 记录本身不合法，跳过（不是插件问题）
				}
				if (chunks.length === 0) continue;
				streams.push({
					chunks,
					model: o.data?.message?.source?.provider + "/" + o.data?.message?.source?.model,
					session: path.basename(path.dirname(p)).slice(0, 24),
					turn: o.data?.turn, step: o.data?.step
				});
			}
		}
	}
})(SESSIONS);

console.log(`收集到真实流: ${streams.length} 条\n`);

// 插件需要 tools 声明才生效——从流里无法还原，这里给一组宽泛的工具
const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } },
	{ name: "read", parameters: { type: "object", properties: { file_path: { type: "string" } } } },
	{ name: "write", parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } } } },
	{ name: "edit", parameters: { type: "object", properties: {} } },
	{ name: "grep", parameters: { type: "object", properties: {} } },
	{ name: "glob", parameters: { type: "object", properties: {} } },
	{ name: "todo_write", parameters: { type: "object", properties: {} } },
	{ name: "web_search", parameters: { type: "object", properties: {} } },
	{ name: "web_fetch", parameters: { type: "object", properties: {} } },
	{ name: "ask_user_question", parameters: { type: "object", properties: {} } },
];

const stats = { total: 0, passOK: 0, failValidator: 0, failAssembler: 0, failChanged: 0, changed: 0, kinds: {} };
const failures = [];
const changedCases = [];

for (const s of streams) {
	stats.total++;
	plugin.resetStreaks?.();
	const opts = { provider: "p", model: s.model, messages: [], tools: TOOLS };
	const out = [];
	let vErr = null;
	try {
		for await (const c of validateStream(listener(opts, () => (async function* () { for (const ch of s.chunks) yield ch; })()), (m) => { vErr = m; throw new Error(m); })) out.push(c);
	} catch (e) {
		vErr = vErr ?? e.message;
	}
	if (vErr) {
		// 原流本身可能就不合法（历史日志里的旧格式），先看原始流能否过校验
		let rawErr = null;
		try {
			for await (const _ of validateStream((async function* () { for (const ch of s.chunks) yield ch; })(), (m) => { rawErr = m; throw new Error(m); })) {}
		} catch (e) { rawErr = rawErr ?? e.message; }
		if (rawErr) continue; // 原流就不合法，跳过（不是插件问题）
		stats.failValidator++;
		failures.push({ ...s, err: "插件输出被校验器拒绝: " + vErr });
		continue;
	}
	// 装配必须成功
	try {
		const asm = new BlockAssembler();
		for (const c of out) asm.push(c);
		asm.assembled();
	} catch (e) {
		stats.failAssembler++;
		failures.push({ ...s, err: "装配失败: " + e.message });
		continue;
	}
	// finish 语义统计
	const fin = out.find((c) => c.type === "finish");
	const kind = fin?.reason?.kind ?? "?";
	stats.kinds[kind] = (stats.kinds[kind] ?? 0) + 1;
	// 是否被插件改写
	const origFin = s.chunks.find((c) => c.type === "finish");
	if (origFin?.reason?.kind !== kind) {
		stats.changed++;
		changedCases.push({ ...s, from: origFin?.reason?.kind, to: kind });
	}
	stats.passOK++;
}

console.log("=== 结果 ===");
console.log(`总流数        : ${stats.total}`);
console.log(`通过          : ${stats.passOK}`);
console.log(`校验器拒绝    : ${stats.failValidator}`);
console.log(`装配失败      : ${stats.failAssembler}`);
console.log(`被插件改写    : ${stats.changed}`);
console.log(`finish 分布   : ${JSON.stringify(stats.kinds)}`);

if (changedCases.length) {
	console.log("\n--- 被改写的流（前 10）---");
	for (const c of changedCases.slice(0, 10)) console.log(`  ${c.session} t${c.turn}s${c.step} ${c.model}: ${c.from} -> ${c.to}`);
}
if (failures.length) {
	console.log("\n--- 失败（前 10）---");
	for (const f of failures.slice(0, 10)) console.log(`  ${f.session} t${f.turn}s${f.step} ${f.model}: ${f.err}`);
}
console.log(failures.length === 0 ? "\n✅ 所有真实流均未被破坏" : `\n❌ ${failures.length} 条失败`);
process.exit(failures.length === 0 ? 0 : 1);
