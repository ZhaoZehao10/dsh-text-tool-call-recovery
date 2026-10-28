// 代码审查 harness：针对插件的边界条件做穷举验证
// 用真实不变式校验器（逐行复刻 asar 中提取的 invariant.js）验证插件输出
import fs from "node:fs";
import path from "node:path";

// 复刻真实校验器（逐行对照提取到的 invariant.js）
function makeFail() {
	const errors = [];
	const fail = (msg) => { errors.push(msg); throw new Error(msg); };
	return { fail, errors };
}
async function* validateStream(source, fail) {
	const open = new Map();
	let usageSeen = false;
	let finished = false;
	for await (const chunk of source) {
		if (finished) fail(`LLM stream emitted ${chunk.type} after terminal finish`);
		switch (chunk.type) {
			case "block-start":
				if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) fail(`bad index ${chunk.index}`);
				if (open.has(chunk.index)) fail(`LLM stream repeated block-start index ${chunk.index}`);
				open.set(chunk.index, chunk.blockType);
				break;
			case "text-delta":
			case "reasoning-delta":
			case "tool-call-delta": {
				const expected = chunk.type === "text-delta" ? "text" : chunk.type === "reasoning-delta" ? "reasoning" : "tool-call";
				if (open.get(chunk.index) !== expected) fail(`${expected} delta at index ${chunk.index} requires an open ${expected} block`);
				break;
			}
			case "block-end": {
				const bt = open.get(chunk.index);
				if (bt === undefined) fail(`LLM stream block-end index ${chunk.index} has no open block`);
				if (chunk.block.type !== bt) fail(`block-end index ${chunk.index} closes ${chunk.block.type}, expected ${bt}`);
				open.delete(chunk.index);
				break;
			}
			case "usage":
				if (usageSeen) fail("usage more than once");
				usageSeen = true;
				break;
			case "finish":
				if (open.size > 0 && chunk.reason.kind !== "error" && chunk.reason.kind !== "aborted") fail(`finished with ${open.size} open block(s)`);
				finished = true;
				break;
		}
		yield chunk;
	}
	if (!finished) fail("LLM stream ended without a terminal finish chunk");
}

// 载入被测插件
const pluginPath = new URL("../../lib/index.js", import.meta.url).pathname.replace(/^\//, "");
const plugin = await import("file:///" + pluginPath.replace(/\\/g, "/"));
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [
	{ name: "pwsh", description: "Run PowerShell", parameters: { type: "object", properties: { command: { type: "string" } } } },
	{ name: "read", description: "Read", parameters: { type: "object", properties: { file_path: { type: "string" } } } }
];
const OPTS = { provider: "x", model: "m", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>", CC = "</" + "tool_call>";
const makeCalls = (n) => Array.from({ length: n }, (_, i) => OC + "\n<function=pwsh>\n<parameter=command>\necho " + i + "\n</parameter>\n</function>\n" + CC).join("\n");

let pass = 0, failCount = 0;
const results = [];
function t(label, ok, detail) {
	results.push({ label, ok, detail });
	if (ok) { pass++; console.log(`  PASS ${label}`); }
	else { failCount++; console.log(`  FAIL ${label} :: ${detail ?? ""}`); }
}

async function run(label, streamFactory, opts = OPTS) {
	const { fail } = makeFail();
	const chunks = [];
	let err = null;
	try {
		for await (const c of validateStream(listener(opts, streamFactory), fail)) chunks.push(c);
	} catch (e) { err = e.message; }
	return { chunks, err };
}

// ---- 边界 1：结构化 tool-call + 同时有文本标记（检查块交错是否违规）----
{
	const src = (async function* () {
		// 先 text 块（不关），再 tool-call 块，再关 text —— 真实适配器会这样交错吗？
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "想一下" + makeCalls(1) };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "想一下" + makeCalls(1) } };
		yield { type: "block-start", index: 1, blockType: "tool-call" };
		yield { type: "tool-call-delta", index: 1, id: "a", name: "pwsh", argumentsDelta: "{}" };
		yield { type: "block-end", index: 1, block: { type: "tool-call", id: "a", name: "pwsh", arguments: "{}" } };
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
		yield { type: "finish", reason: { kind: "tool-calls" }, replayState: { response: { stopReason: "toolUse" }, blocks: [{ type: "reasoning" }, { type: "tool-call" }] } };
	})();
	const { chunks, err } = await run("结构化+文本标记", () => src);
	t("已有结构化 tool-call 时流仍合法", err === null, err);
	t("已有结构化调用时 finish 保持 tool-calls", chunks.find((c) => c.type === "finish")?.reason?.kind === "tool-calls");
}

// ---- 边界 2：多个 text/reasoning 块 + 无 finish（流被截断）----
{
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: makeCalls(2) };
		yield { type: "block-end", index: 0, block: { type: "text", text: makeCalls(2) } };
		// 没有 usage、没有 finish
	})();
	const { err } = await run("无 finish", () => src);
	t("流无 finish 时被真实校验器拒绝（预期行为，非插件问题）", err !== null, "err=" + err);
}

// ---- 边界 3：只有 reasoning 块 + finish stop（原始 bug 场景）----
{
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "思考" + makeCalls(1) };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "思考" + makeCalls(1) } };
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
		yield { type: "finish", reason: { kind: "stop" }, replayState: { response: { stopReason: "stop" }, blocks: [{ type: "reasoning" }] } };
	})();
	const { chunks, err } = await run("原始 bug", () => src);
	t("原始 bug 场景流合法", err === null, err);
	const fin = chunks.find((c) => c.type === "finish");
	t("finish 改写为 tool-calls", fin?.reason?.kind === "tool-calls", JSON.stringify(fin?.reason));
	const tcCount = chunks.filter((c) => c.type === "block-start" && c.blockType === "tool-call").length;
	t("合成 1 个 tool-call", tcCount === 1, String(tcCount));
	t("合成块索引不与已有块冲突", !chunks.some((c, i) => c.type === "block-start" && chunks.slice(0, i).some((p) => p.type === "block-start" && p.index === c.index)));
}

// ---- 边界 4：aborted（非 stop）应原样放行 ----
{
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: makeCalls(1) };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: makeCalls(1) } };
		yield { type: "finish", reason: { kind: "aborted", failure: { message: "abort" } } };
	})();
	const { chunks, err } = await run("aborted", () => src);
	t("aborted 流合法", err === null, err);
	const fin = chunks.find((c) => c.type === "finish");
	t("aborted 不被改写", fin?.reason?.kind === "aborted", JSON.stringify(fin?.reason));
	t("aborted 不合成 tool-call", !chunks.some((c) => c.type === "block-start" && c.blockType === "tool-call"));
}

// ---- 边界 5：max-tokens 应原样放行 ----
{
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: makeCalls(1) };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: makeCalls(1) } };
		yield { type: "finish", reason: { kind: "max-tokens" } };
	})();
	const { chunks, err } = await run("max-tokens", () => src);
	t("max-tokens 流合法", err === null, err);
	t("max-tokens 不被改写", chunks.find((c) => c.type === "finish")?.reason?.kind === "max-tokens");
}

// ---- 边界 6：无 tools 时完全直通 ----
{
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "hi" };
		yield { type: "block-end", index: 0, block: { type: "text", text: "hi" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const { chunks, err } = await run("无 tools", () => src, { ...OPTS, tools: [] });
	t("无 tools 时流合法", err === null, err);
	t("无 tools 时 finish 不变", chunks.find((c) => c.type === "finish")?.reason?.kind === "stop");
}

// ---- 边界 7：块索引不连续（真实适配器可能跳号）----
{
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: makeCalls(1) };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: makeCalls(1) } };
		yield { type: "block-start", index: 5, blockType: "text" };
		yield { type: "text-delta", index: 5, text: "后文" };
		yield { type: "block-end", index: 5, block: { type: "text", text: "后文" } };
		yield { type: "finish", reason: { kind: "stop" }, replayState: { response: { stopReason: "stop" }, blocks: [{ type: "reasoning" }, { type: "text" }] } };
	})();
	const { chunks, err } = await run("跳号索引", () => src);
	t("跳号索引流合法", err === null, err);
	const starts = chunks.filter((c) => c.type === "block-start").map((c) => c.index);
	// 恢复路径会**重排**索引（原块偶数位 + 其调用紧随其后），因此断言改为：
	// 索引唯一、从 0 开始连续（BlockAssembler 按首次出现顺序装配）。
	const uniqueSorted = [...new Set(starts)].sort((a, b) => a - b);
	const contiguousFromZero = uniqueSorted.every((v, i) => v === i);
	t("合成块索引唯一且从 0 连续", new Set(starts).size === starts.length && contiguousFromZero, JSON.stringify(starts));
}

// ---- 边界 8：多个块都有标记（混合 text+reasoning）----
{
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "思考1" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "思考1" + makeCalls(1) } };
		yield { type: "block-start", index: 1, blockType: "text" };
		yield { type: "text-delta", index: 1, text: makeCalls(1) };
		yield { type: "block-end", index: 1, block: { type: "text", text: makeCalls(1) } };
		yield { type: "finish", reason: { kind: "stop" }, replayState: { response: { stopReason: "stop" }, blocks: [{ type: "reasoning" }, { type: "text" }] } };
	})();
	const { chunks, err } = await run("两块各带标记", () => src);
	t("两块各带标记流合法", err === null, err);
	const tcCount = chunks.filter((c) => c.type === "block-start" && c.blockType === "tool-call").length;
	t("两块各合成 1 个调用（共 2）", tcCount === 2, String(tcCount));
}

// ---- 边界 9：标记里工具名未声明 → 安全网 EMPTY_RESPONSE ----
{
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: OC + "\n<function=unknown_tool>\n<parameter=x>1\n</function>\n" + CC };
		yield { type: "block-end", index: 0, block: { type: "text", text: OC + "\n<function=unknown_tool>\n<parameter=x>1\n</function>\n" + CC } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const { chunks, err } = await run("未声明工具", () => src);
	t("未声明工具流合法", err === null, err);
	const fin = chunks.find((c) => c.type === "finish");
	t("未声明工具 → EMPTY_RESPONSE", fin?.reason?.kind === "error" && fin.reason.failure.code === "EMPTY_RESPONSE", JSON.stringify(fin?.reason));
}

// ---- 边界 10：正常长文本（不应被误判）----
{
	const longText = "这是一段很长的正常回复。".repeat(200);
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: longText };
		yield { type: "block-end", index: 0, block: { type: "text", text: longText } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const { chunks, err } = await run("正常长文本", () => src);
	t("正常长文本流合法", err === null, err);
	t("正常长文本不被改写", chunks.find((c) => c.type === "finish")?.reason?.kind === "stop");
}

// ---- 边界 11：文本里偶然提到 parameter 标记（误判风险）----
{
	const prose = "在文档里我们提到 <parameter=foo> 这种写法是危险的，建议避免。";
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: prose };
		yield { type: "block-end", index: 0, block: { type: "text", text: prose } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const { chunks, err } = await run("正文提及标记", () => src);
	t("正文提及标记流合法", err === null, err);
	const fin = chunks.find((c) => c.type === "finish");
	t("【关键】正文提及标记不被误判为截断（应保持 stop）", fin?.reason?.kind === "stop", JSON.stringify(fin?.reason));
}

console.log(`\n===== ${pass} passed, ${failCount} failed =====`);
process.exit(failCount === 0 ? 0 : 1);
