// 模糊测试 + 属性测试：随机生成数千条流，用真实校验器规则检查插件输出的不变量
// 目标：找出我"想象不到的"边界 bug
import fs from "node:fs";

// ---- 真实不变式校验器（逐行复刻 dsh-llm/lib/types/invariant.js）----
async function* validateStream(source, fail) {
	const open = new Map();
	let usageSeen = false;
	let finished = false;
	for await (const chunk of source) {
		if (finished) fail(`emitted ${chunk.type} after terminal finish`);
		switch (chunk.type) {
			case "block-start":
				if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) fail(`bad index ${chunk.index}`);
				if (open.has(chunk.index)) fail(`repeated block-start index ${chunk.index}`);
				open.set(chunk.index, chunk.blockType);
				break;
			case "text-delta":
			case "reasoning-delta":
			case "tool-call-delta": {
				const exp = chunk.type === "text-delta" ? "text" : chunk.type === "reasoning-delta" ? "reasoning" : "tool-call";
				if (open.get(chunk.index) !== exp) fail(`${exp} delta at ${chunk.index} requires open ${exp} block, got ${String(open.get(chunk.index))}`);
				break;
			}
			case "block-end": {
				const bt = open.get(chunk.index);
				if (bt === undefined) fail(`block-end ${chunk.index} has no open block`);
				if (chunk.block?.type !== bt) fail(`block-end ${chunk.index} closes ${chunk.block?.type}, expected ${bt}`);
				open.delete(chunk.index);
				break;
			}
			case "usage":
				if (usageSeen) fail("usage more than once");
				usageSeen = true;
				break;
			case "finish":
				if (open.size > 0 && chunk.reason?.kind !== "error" && chunk.reason?.kind !== "aborted") fail(`finished with ${open.size} open block(s)`);
				finished = true;
				break;
		}
		yield chunk;
	}
	if (!finished) fail("ended without terminal finish");
}

// ---- 载入插件 ----
const pluginPath = new URL("../../lib/index.js", import.meta.url).pathname.replace(/^\//, "");
const plugin = await import("file:///" + pluginPath.replace(/\\/g, "/"));
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

// ---- 伪随机（可复现）----
let seed = 20261022;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(arr) { return arr[Math.floor(rnd() * arr.length) % arr.length]; }
function chance(p) { return rnd() < p; }

const TOOLS = [
	{ name: "pwsh", description: "x", parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" }, verbose: { type: "boolean" }, opts: { type: "object" }, list: { type: "array" } } } },
	{ name: "read", description: "x", parameters: { type: "object", properties: { file_path: { type: "string" }, limit: { type: "integer" } } } },
	{ name: "grep", description: "x", parameters: { type: "object", properties: { pattern: { type: "string" }, include: { type: "string" } } } }
];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };

// ---- 标记片段生成器 ----
const OC = "<" + "tool_call>", CC = "</" + "tool_call>";
const OF = (n) => "<" + "function=" + n + ">", CF = "</" + "function>";
const OP = (k) => "<" + "parameter=" + k + ">", CP = "</" + "parameter>";
const OPN = (k) => "<" + "parameter name=" + JSON.stringify(k) + ">";
const TOOL_NAMES = ["pwsh", "read", "grep", "undeclared_tool", ""];
const PARAM_KEYS = ["command", "file_path", "pattern", "include", "limit", "timeout", "verbose", "opts", "list", "unknown_key", ""];
const VALUES = ["Get-Date", "42", "true", "{\"a\":1}", "[1,2]", "line1\nline2", "& <tag> \"q\"", "", "  spaced  ", "中文值", "a".repeat(300)];

function genMarkup() {
	const style = pick(["qwen", "anthropic", "json", "truncated", "bare", "none"]);
	const nArgs = Math.floor(rnd() * 4);
	if (style === "none") return "";
	if (style === "json") {
		const n = pick(TOOL_NAMES);
		if (!n) return '{"name":"","arguments":{}}';
		return JSON.stringify({ name: n, arguments: nArgs === 0 ? {} : { command: pick(VALUES) } });
	}
	if (style === "truncated") {
		// 截断形态：有开头无结尾
		return pick([OP(pick(PARAM_KEYS)), OPN(pick(PARAM_KEYS)), OF(pick(TOOL_NAMES)), OC, OC + OF(pick(TOOL_NAMES))]) + pick(VALUES);
	}
	if (style === "bare") {
		// 裸元素（无外层包装）
		return pick([OP(pick(PARAM_KEYS)) + pick(VALUES) + CP, OPN(pick(PARAM_KEYS)) + pick(VALUES) + CP, OF(pick(TOOL_NAMES)) + pick(VALUES) + CF]);
	}
	const name = pick(TOOL_NAMES);
	let body = "";
	for (let i = 0; i < nArgs; i++) {
		const key = pick(PARAM_KEYS);
		body += (style === "qwen" ? OP(key) : OPN(key)) + pick(VALUES) + CP + "\n";
	}
	if (style === "qwen") return OC + "\n" + OF(name) + "\n" + body + CF + "\n" + CC;
	return OF(name) + "\n" + body + CF;
}

function genText() {
	const kind = pick(["empty", "short", "prose", "long", "proseWithMarkup", "markupOnly", "whitespace", "codeblock"]);
	switch (kind) {
		case "empty": return "";
		case "whitespace": return pick([" ", "\n", "\n\n  \t", "   "]);
		case "short": return pick(["好", "OK", "已修复。", "18/18 + 回归 pass。"]);
		case "prose": return "这是一段正常回复，包含若干说明文字。" .repeat(Math.floor(rnd() * 20) + 1);
		case "long": return "长文本内容，用于测试。".repeat(200);
		case "proseWithMarkup": return "文档里提到 " + genMarkup() + " 这种写法要避免，正文继续说明。" .repeat(Math.floor(rnd() * 3) + 1);
		case "markupOnly": return genMarkup();
		case "codeblock": return "示例：\n```xml\n" + genMarkup() + "\n```\n以上是格式示例。";
	}
	return "text";
}

// ---- 随机流生成器 ----
function genStream() {
	const blockCount = 1 + Math.floor(rnd() * 4);
	// 先分配唯一索引（可跳号，但绝不重复）
	const usedIdx = new Set();
	const baseIdx = [];
	for (let i = 0; i < blockCount; i++) {
		let idx = chance(0.15) ? i * 3 + Math.floor(rnd() * 3) : i;
		while (usedIdx.has(idx)) idx++;          // 保证唯一
		usedIdx.add(idx);
		baseIdx.push(idx);
	}
	const blocks = [];
	for (let i = 0; i < blockCount; i++) {
		const type = pick(["text", "reasoning", "text", "reasoning", "tool-call"]);
		blocks.push({ type, text: type === "tool-call" ? "" : genText(), index: baseIdx[i] });
	}
	// finish 与内容保持一致：只有真的存在 tool-call 块时才可能 tool-calls
	const hasToolCallDelta = blocks.some((b) => b.type === "tool-call");
	const finishKind = hasToolCallDelta
		? pick(["tool-calls", "stop", "max-tokens", "aborted", "error"])
		: pick(["stop", "stop", "stop", "max-tokens", "aborted", "error"]);
	const hasUsage = chance(0.85);
	const hasReplay = chance(0.6);

	return (async function* () {
		for (const b of blocks) {
			yield { type: "block-start", index: b.index, blockType: b.type };
			if (b.type === "tool-call") {
				yield { type: "tool-call-delta", index: b.index, id: "call_" + b.index, name: pick(["pwsh", "read"]), argumentsDelta: "{}" };
			} else {
				const deltaType = b.type === "text" ? "text-delta" : "reasoning-delta";
				if (b.text.length > 10 && chance(0.5)) {
					const mid = Math.floor(b.text.length / 2);
					yield { type: deltaType, index: b.index, text: b.text.slice(0, mid) };
					yield { type: deltaType, index: b.index, text: b.text.slice(mid) };
				} else {
					yield { type: deltaType, index: b.index, text: b.text };
				}
			}
			yield { type: "block-end", index: b.index, block: b.type === "tool-call"
				? { type: "tool-call", id: "call_" + b.index, name: "pwsh", arguments: "{}" }
				: { type: b.type, text: b.text } };
		}
		if (hasUsage) yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
		const finish = { type: "finish", reason: { kind: finishKind } };
		if (finishKind === "error" || finishKind === "aborted") finish.reason.failure = { message: "x", code: "TEST" };
		if (hasReplay) finish.replayState = { response: { stopReason: finishKind }, blocks: blocks.map((b) => ({ type: b.type })) };
		yield finish;
	})();
}

// ---- 属性检查 ----
const STATS = { runs: 0, fail: 0, kinds: {}, recovered: 0, safeNet: 0, passThrough: 0 };

async function runOne(i) {
	const { fail: _fail } = { fail: null };
	const errors = [];
	const fail = (m) => { errors.push(m); throw new Error(m); };
	const out = [];
	let streamErr = null;
	try {
		for await (const c of validateStream(listener(OPTS, genStream), fail)) out.push(c);
	} catch (e) {
		streamErr = e.message;
	}
	STATS.runs++;
	if (streamErr) {
		STATS.fail++;
		console.log(`\n[FAIL #${i}] 校验器拒绝: ${streamErr}`);
		return false;
	}
	// 属性 1：必须以 finish 结束，且只有一个
	const finishes = out.filter((c) => c.type === "finish");
	if (finishes.length !== 1) { STATS.fail++; console.log(`\n[FAIL #${i}] finish 数量=${finishes.length}`); return false; }
	const kind = finishes[0].reason?.kind ?? "(none)";
	STATS.kinds[kind] = (STATS.kinds[kind] ?? 0) + 1;
	if (kind === "tool-calls") STATS.recovered++;
	if (kind === "error" && finishes[0].reason.failure?.code === "EMPTY_RESPONSE") STATS.safeNet++;
	if (kind === "stop") STATS.passThrough++;

	// 属性 2：合成块索引必须唯一且不与已有块冲突
	const starts = out.filter((c) => c.type === "block-start").map((c) => c.index);
	if (new Set(starts).size !== starts.length) { STATS.fail++; console.log(`\n[FAIL #${i}] 重复 block-start: ${JSON.stringify(starts)}`); return false; }

	// 属性 3：每个 block-start 都有对应 block-end（error 除外）
	const ends = out.filter((c) => c.type === "block-end").map((c) => c.index);
	if (kind !== "error" && kind !== "aborted") {
		const missing = starts.filter((s) => !ends.includes(s));
		if (missing.length) { STATS.fail++; console.log(`\n[FAIL #${i}] 未闭合块: ${JSON.stringify(missing)} kind=${kind}`); return false; }
	}

	// 属性 4：usage 至多一次，且必须在 finish 之前
	const usages = out.filter((c) => c.type === "usage");
	if (usages.length > 1) { STATS.fail++; console.log(`\n[FAIL #${i}] usage 重复 ${usages.length} 次`); return false; }

	// 属性 5：tool-calls 时必须有 tool-call 块
	if (kind === "tool-calls" && !out.some((c) => c.type === "block-end" && c.block?.type === "tool-call")) {
		STATS.fail++; console.log(`\n[FAIL #${i}] finish=tool-calls 但没有 tool-call 块`); return false;
	}

	// 属性 6：合成的 tool-call 参数必须是合法 JSON
	for (const c of out) {
		if (c.type === "block-end" && c.block?.type === "tool-call" && typeof c.block.arguments === "string") {
			try { JSON.parse(c.block.arguments); } catch {
				STATS.fail++; console.log(`\n[FAIL #${i}] 非法 JSON 参数: ${c.block.arguments.slice(0, 100)}`); return false;
			}
		}
	}

	// 属性 7：stop 时不能有残留的可恢复标记被静默丢弃
	// （即：如果 finish=stop 且文本里含完整可解析调用，应该已经恢复成 tool-calls）
	// —— 这条只能粗略检查：stop 且存在完整 qwen 调用块却没恢复 → 可疑
	if (kind === "stop") {
		const textBlocks = out.filter((c) => c.type === "block-end" && (c.block?.type === "text" || c.block?.type === "reasoning"));
		for (const b of textBlocks) {
			const t = b.block.text ?? "";
			// 完整 qwen 形态：tool_call + function=pwsh + parameter=command + 闭合
			if (t.includes(OC) && t.includes(OF("pwsh")) && t.includes(OP("command")) && t.includes(CC)) {
				STATS.fail++;
				console.log(`\n[FAIL #${i}] finish=stop 但文本里残留完整可解析调用（未恢复）`);
				console.log("  文本片段:", JSON.stringify(t.slice(0, 200)));
				return false;
			}
		}
	}
	return true;
}

console.log("=== 模糊测试：随机流不变量检查 ===");
const N = 3000;
let ok = 0;
for (let i = 0; i < N; i++) if (await runOne(i)) ok++;

console.log(`\n运行 ${STATS.runs} 条随机流`);
console.log(`  通过: ${ok}`);
console.log(`  失败: ${STATS.fail}`);
console.log(`  finish 分布:`, JSON.stringify(STATS.kinds));
console.log(`  恢复为 tool-calls: ${STATS.recovered}`);
console.log(`  安全网 EMPTY_RESPONSE: ${STATS.safeNet}`);
console.log(`  直通 stop: ${STATS.passThrough}`);
process.exit(STATS.fail === 0 ? 0 : 1);
