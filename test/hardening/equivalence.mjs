// 加固 2：等价性验证
// 问题：插件"恢复"出的调用，经过真实 BlockAssembler 装配后，
// 是否与"模型本来直接返回结构化 tool_calls"完全等价？
// 方法：构造同一语义的两条流（A=文本标记经恢复；B=原生结构化），
//       分别装配后逐字段比对。
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const LLM = process.env.DSH_LLM_SRC
	? path.join(process.env.DSH_LLM_SRC, "lib", "index.js")
	: new URL("../../../node_modules/@deepseek-ai/dsh-llm/lib/index.js", import.meta.url).pathname.replace(/^\//, "");
const { BlockAssembler } = await import(pathToFileURL(LLM).href);

const pluginPath = new URL("../../lib/index.js", import.meta.url).pathname.replace(/^\//, "");
const plugin = await import("file:///" + pluginPath.replace(/\\/g, "/"));
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [
	{ name: "pwsh", description: "x", parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" }, verbose: { type: "boolean" } } } },
	{ name: "read", description: "x", parameters: { type: "object", properties: { file_path: { type: "string" }, limit: { type: "integer" } } } }
];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>", CC = "</" + "tool_call>";
const OF = (n) => "<" + "function=" + n + ">", CF = "</" + "function>";
const OP = (k) => "<" + "parameter=" + k + ">", CP = "</" + "parameter>";
const OPN = (k) => "<" + "parameter name=" + JSON.stringify(k) + ">";

let pass = 0, fail = 0;
const ck = (label, cond, detail) => { if (cond) pass++; else { fail++; console.log(`FAIL ${label}${detail ? " :: " + detail : ""}`); } };

async function assemble(chunks) {
	const asm = new BlockAssembler();
	for (const c of chunks) asm.push(c);
	return asm.assembled();
}
async function runStream(src) {
	const out = [];
	for await (const c of listener(OPTS, () => src)) out.push(c);
	return out;
}

// 语义等价的两种流
function textMarkupStream(markup, blockType = "reasoning") {
	return (async function* () {
		yield { type: "block-start", index: 0, blockType };
		const dt = blockType === "text" ? "text-delta" : "reasoning-delta";
		yield { type: dt, index: 0, text: markup };
		yield { type: "block-end", index: 0, block: { type: blockType, text: markup } };
		yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
}
function nativeToolCallStream(calls, textPrefix = "") {
	return (async function* () {
		let idx = 0;
		if (textPrefix) {
			yield { type: "block-start", index: idx, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: idx, text: textPrefix };
			yield { type: "block-end", index: idx, block: { type: "reasoning", text: textPrefix } };
			idx++;
		}
		for (const c of calls) {
			const argsJson = JSON.stringify(c.arguments);
			yield { type: "block-start", index: idx, blockType: "tool-call" };
			yield { type: "tool-call-delta", index: idx, id: c.id, name: c.name, argumentsDelta: argsJson };
			yield { type: "block-end", index: idx, block: { type: "tool-call", id: c.id, name: c.name, arguments: argsJson } };
			idx++;
		}
		yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
		yield { type: "finish", reason: { kind: "tool-calls" } };
	})();
}

// ---- 等价性 1：单调用，名称/参数完全一致 ----
console.log("=== 1. 单调用等价性 ===");
{
	const markup = OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\nGet-Date\n" + CP + "\n" + CF + "\n" + CC;
	const recovered = await assemble(await runStream(textMarkupStream(markup)));
	const native = await assemble(await runStream(nativeToolCallStream([{ id: "x", name: "pwsh", arguments: { command: "Get-Date" } }])));
	const rCalls = recovered.blocks.filter((b) => b.type === "tool-call");
	const nCalls = native.blocks.filter((b) => b.type === "tool-call");
	ck("调用数量一致", rCalls.length === nCalls.length, `${rCalls.length} vs ${nCalls.length}`);
	ck("工具名一致", rCalls[0]?.name === nCalls[0]?.name, `${rCalls[0]?.name} vs ${nCalls[0]?.name}`);
	const rArgs = JSON.parse(rCalls[0]?.arguments ?? "{}"), nArgs = JSON.parse(nCalls[0]?.arguments ?? "{}");
	ck("参数语义一致", JSON.stringify(rArgs) === JSON.stringify(nArgs), `${JSON.stringify(rArgs)} vs ${JSON.stringify(nArgs)}`);
}

// ---- 等价性 2：类型强转后与原生一致 ----
console.log("=== 2. 类型强转等价性 ===");
{
	const cases = [
		{ key: "timeout", raw: "30", native: 30 },
		{ key: "verbose", raw: "true", native: true },
		{ key: "command", raw: "echo hi", native: "echo hi" },
		{ key: "limit", raw: "5", native: 5, tool: "read", param: "limit" },
	];
	for (const c of cases) {
		const toolName = c.tool ?? "pwsh";
		const markup = OC + "\n" + OF(toolName) + "\n" + OP(c.key) + "\n" + c.raw + "\n" + CP + "\n" + CF + "\n" + CC;
		const recovered = await assemble(await runStream(textMarkupStream(markup)));
		const rCalls = recovered.blocks.filter((b) => b.type === "tool-call");
		const rArgs = JSON.parse(rCalls[0]?.arguments ?? "{}");
		ck(`${c.key} 强转后与原生一致`, JSON.stringify(rArgs[c.key]) === JSON.stringify(c.native), `${JSON.stringify(rArgs[c.key])} vs ${JSON.stringify(c.native)}`);
	}
}

// ---- 等价性 3：多调用顺序等价 ----
console.log("=== 3. 多调用顺序等价性 ===");
{
	const mk = (n, v) => OC + "\n" + OF(n) + "\n" + (n === "pwsh" ? OP("command") : OP("file_path")) + "\n" + v + "\n" + CP + "\n" + CF + "\n" + CC;
	const markup = [mk("pwsh", "echo 1"), mk("read", "/a.txt"), mk("pwsh", "echo 3")].join("\n");
	const recovered = await assemble(await runStream(textMarkupStream(markup, "text")));
	const native = await assemble(await runStream(nativeToolCallStream([
		{ id: "1", name: "pwsh", arguments: { command: "echo 1" } },
		{ id: "2", name: "read", arguments: { file_path: "/a.txt" } },
		{ id: "3", name: "pwsh", arguments: { command: "echo 3" } }
	])));
	const r = recovered.blocks.filter((b) => b.type === "tool-call").map((b) => ({ name: b.name, args: JSON.parse(b.arguments) }));
	const n = native.blocks.filter((b) => b.type === "tool-call").map((b) => ({ name: b.name, args: JSON.parse(b.arguments) }));
	ck("多调用数量一致", r.length === n.length, `${r.length} vs ${n.length}`);
	ck("多调用顺序与内容一致", JSON.stringify(r) === JSON.stringify(n), JSON.stringify(r));
}

// ---- 等价性 4：文本块顺序保持（reasoning 在前，tool-call 在后）----
console.log("=== 4. 块顺序等价性 ===");
{
	const markup = OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\necho x\n" + CP + "\n" + CF + "\n" + CC;
	// 恢复流的结构是：reasoning 块（含标记）→ 恢复出的 tool-call。
	// 因此"语义等价"的原生流也必须是 reasoning 在前、tool-call 在后。
	// （nativeToolCallStream 的 textPrefix 会先发 reasoning 块，正好对应。）
	const recovered = await assemble(await runStream(textMarkupStream(markup, "reasoning")));
	// 显式构造原生流（不用带状态的辅助函数，避免测试自身的顺序 bug）：
	// reasoning(0) → tool-call(1) → usage → finish(tool-calls)
	const native = await assemble(await runStream((async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "思考内容" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "思考内容" } };
		yield { type: "block-start", index: 1, blockType: "tool-call" };
		yield { type: "tool-call-delta", index: 1, id: "x", name: "pwsh", argumentsDelta: JSON.stringify({ command: "echo x" }) };
		yield { type: "block-end", index: 1, block: { type: "tool-call", id: "x", name: "pwsh", arguments: JSON.stringify({ command: "echo x" }) } };
		yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
		yield { type: "finish", reason: { kind: "tool-calls" } };
	})()));
	const rTypes = recovered.blocks.map((b) => b.type);
	const nTypes = native.blocks.map((b) => b.type);
	// 诊断：打印两边 chunk 序列（仅此项）
	if (process.env.DIAG_ORDER === "1") {
		console.log("  恢复 chunks:", recovered.blocks.map((b) => `${b.type}`).join(","));
		console.log("  原生 chunks:", native.blocks.map((b) => `${b.type}`).join(","));
	}
	ck("块类型序列一致", JSON.stringify(rTypes) === JSON.stringify(nTypes), `${JSON.stringify(rTypes)} vs ${JSON.stringify(nTypes)}`);
}

// ---- 等价性 5：finish 语义等价 ----
console.log("=== 5. finish 语义等价性 ===");
{
	const markup = OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\necho x\n" + CP + "\n" + CF + "\n" + CC;
	const recChunks = await runStream(textMarkupStream(markup));
	const natChunks = await runStream(nativeToolCallStream([{ id: "x", name: "pwsh", arguments: { command: "echo x" } }]));
	const rFin = recChunks.find((c) => c.type === "finish")?.reason;
	const nFin = natChunks.find((c) => c.type === "finish")?.reason;
	ck("finish.kind 一致", rFin?.kind === nFin?.kind, `${rFin?.kind} vs ${nFin?.kind}`);
	const rA = new BlockAssembler(); for (const c of recChunks) rA.push(c);
	const nA = new BlockAssembler(); for (const c of natChunks) nA.push(c);
	ck("装配后 finish 语义一致", rA.finish?.kind === nA.finish?.kind, `${rA.finish?.kind} vs ${nA.finish?.kind}`);
}

// ---- 等价性 6：usage 不丢失 ----
console.log("=== 6. usage 保持 ===");
{
	const markup = OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\necho x\n" + CP + "\n" + CF + "\n" + CC;
	const recChunks = await runStream(textMarkupStream(markup));
	const usage = recChunks.find((c) => c.type === "usage");
	ck("恢复后 usage 仍存在", usage !== undefined, JSON.stringify(usage));
	// assembled() 只返回 {blocks, replay}；usage/finish 由独立访问器读取。
	const asm2 = new BlockAssembler();
	for (const c of recChunks) asm2.push(c);
	ck("装配后 usage 正确", asm2.usage?.inputTokens === 10 && asm2.usage?.outputTokens === 5, JSON.stringify(asm2.usage));
}

// ---- 等价性 7：Anthropic 形态与原生等价 ----
console.log("=== 7. Anthropic 形态等价性 ===");
{
	const markup = "<" + "antml:function name=\"read\">\n" + OPN("file_path") + "\n/b.txt\n" + CP + "\n</" + "antml:function>";
	const recovered = await assemble(await runStream(textMarkupStream(markup)));
	const native = await assemble(await runStream(nativeToolCallStream([{ id: "y", name: "read", arguments: { file_path: "/b.txt" } }])));
	const rCalls = recovered.blocks.filter((b) => b.type === "tool-call");
	const nCalls = native.blocks.filter((b) => b.type === "tool-call");
	ck("antml 调用与原生等价",
		rCalls.length === 1 && rCalls[0].name === nCalls[0].name && JSON.stringify(JSON.parse(rCalls[0].arguments)) === JSON.stringify(JSON.parse(nCalls[0].arguments)),
		JSON.stringify(rCalls.map((c) => ({ n: c.name, a: c.arguments }))));
}

console.log(`\n===== 等价性验证: ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
