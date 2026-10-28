// 不变量验证：断流时绝不恢复调用
//
// 理由：恢复调用意味着改写 finish 为 tool-calls 并合成 tool-call 块。
// 但流已异常终止，上游会按错误处理 —— 若我们同时合成了调用，
// 会导致「既报错又执行工具」的矛盾状态。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const plugin = await import(pathToFileURL(LIB).href + "?inv=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const MARKUP = OC + "\n<function=pwsh>\n<parameter=command>\necho hi\n</parameter>\n</function>\n" + CC;
const OPTS = { provider: "p", model: "m", messages: [], tools: [{ name: "pwsh" }] };

async function run(gen) {
	plugin.resetStreaks?.();
	const out = [];
	let err = null;
	try {
		for await (const c of listener(OPTS, () => gen)) out.push(c);
	} catch (e) { err = e; }
	return { out, err };
}

console.log("=== 断流路径下绝不能恢复调用 ===\n");

const cases = [
	{
		name: "block-end 之前断开",
		gen: () => (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: MARKUP };
			throw new Error("ECONNRESET");
		})(),
	},
	{
		name: "block-end 之后、finish 之前断开",
		gen: () => (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: MARKUP };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: MARKUP } };
			throw new Error("ECONNRESET");
		})(),
	},
	{
		name: "usage 之后、finish 之前断开",
		gen: () => (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: MARKUP };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: MARKUP } };
			yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
			throw new Error("ECONNRESET");
		})(),
	},
	{
		name: "多个块后断开",
		gen: () => (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: "思考内容" };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: "思考内容" } };
			yield { type: "block-start", index: 1, blockType: "text" };
			yield { type: "text-delta", index: 1, text: MARKUP };
			yield { type: "block-end", index: 1, block: { type: "text", text: MARKUP } };
			throw new Error("ECONNRESET");
		})(),
	},
];

for (const c of cases) {
	const { out, err } = await run(c.gen());
	const toolCalls = out.filter((x) => x.type === "block-end" && x.block?.type === "tool-call");
	const fin = out.find((x) => x.type === "finish");

	console.log(`${c.name}:`);
	console.log(`  异常透传: ${err !== null ? "✅" : "❌ 未抛异常"}`);
	console.log(`  合成的 tool-call: ${toolCalls.length} 个 ${toolCalls.length === 0 ? "✅" : "❌"}`);
	console.log(`  伪造的 finish: ${fin === undefined ? "✅ 无" : "❌ " + JSON.stringify(fin.reason)}`);

	ck(`${c.name} → 异常透传`, err !== null, err?.message ?? "未抛异常");
	ck(`${c.name} → 不恢复调用`, toolCalls.length === 0, `${toolCalls.length} 个`);
	ck(`${c.name} → 不伪造 finish`, fin === undefined, JSON.stringify(fin?.reason));
}

console.log("\n=== 对照：正常结束（未断流）必须恢复 ===\n");
{
	const { out, err } = await run((async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: MARKUP };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: MARKUP } };
		yield { type: "finish", reason: { kind: "stop" } };
	})());
	const toolCalls = out.filter((x) => x.type === "block-end" && x.block?.type === "tool-call");
	const fin = out.find((x) => x.type === "finish");
	console.log(`  异常: ${err?.message ?? "无"}`);
	console.log(`  合成的 tool-call: ${toolCalls.length} 个`);
	console.log(`  finish: ${JSON.stringify(fin?.reason)}`);
	ck("正常结束 → 恢复 1 个调用", toolCalls.length === 1, String(toolCalls.length));
	ck("正常结束 → finish=tool-calls", fin?.reason?.kind === "tool-calls", JSON.stringify(fin?.reason));
}

console.log(`\n===== 断流不变量: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
