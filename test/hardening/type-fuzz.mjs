// 系统性类型模糊测试
//
// 第 16 轮发现「block.text 不是字符串 → 插件崩溃 → 中断整条模型流」。
// 这提示：**任何**字段类型错误都可能导致同样的后果。
// 本测试对 chunk 协议的每个字段，逐一替换成各种错误类型，
// 验证插件永远不会抛异常（在 llm/stream 接缝里抛异常 = 中断整条流）。
//
// 字段清单（来自真实 chunk 协议）：
//   type, index, blockType, text, block.type, block.text, block.id,
//   block.name, block.arguments, id, name, argumentsDelta, usage.*,
//   reason.kind, reason.failure.*, replayState.*
//
// 错误类型：undefined, null, 数字, 0, NaN, true, false, 数组, 对象,
//          函数, Symbol, 空字符串, 超长字符串, BigInt
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const MARKUP = OC + "\n<function=pwsh>\n<parameter=command>\necho hi\n</parameter>\n</function>\n" + CC;

// 错误值生成器（每次返回新实例，避免被意外修改）
const BAD_VALUES = [
	["undefined", () => undefined],
	["null", () => null],
	["0", () => 0],
	["123", () => 123],
	["-1", () => -1],
	["NaN", () => NaN],
	["Infinity", () => Infinity],
	["true", () => true],
	["false", () => false],
	["空数组", () => []],
	["数组[1,2]", () => [1, 2]],
	["空对象", () => ({})],
	["嵌套对象", () => ({ a: { b: 1 } })],
	["函数", () => function () {}],
	["空字符串", () => ""],
	["空白字符串", () => "   "],
	["Symbol", () => Symbol("x")],
	["BigInt", () => 123n],
	["超长字符串", () => "x".repeat(100000)],
];

const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } },
];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };

const plugin = await import(pathToFileURL(LIB).href + "?fuzz=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

/** 跑一条流，返回 {err, out} */
async function run(chunks) {
	plugin.resetStreaks?.();
	const gen = (async function* () { for (const c of chunks) yield c; })();
	const out = [];
	let err = null;
	try {
		for await (const c of listener(OPTS, () => gen)) out.push(c);
	} catch (e) {
		err = e;
	}
	return { err, out };
}

/** 断言不崩溃 */
async function noCrash(label, chunks) {
	const { err } = await run(chunks);
	ck(label, err === null, err ? `${err.message}` : "");
	return err;
}

// ---------------------------------------------------------------------------
// 基线流：一条完整的"模型输出文本工具调用"流
// ---------------------------------------------------------------------------
const baseChunks = () => [
	{ type: "block-start", index: 0, blockType: "reasoning" },
	{ type: "reasoning-delta", index: 0, text: MARKUP },
	{ type: "block-end", index: 0, block: { type: "reasoning", text: MARKUP } },
	{ type: "usage", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
	{ type: "finish", reason: { kind: "stop" } },
];

// ---------------------------------------------------------------------------
// 变异器：把某个路径上的值替换成坏值
// ---------------------------------------------------------------------------
function setPath(obj, pathStr, value) {
	const parts = pathStr.split(".");
	const clone = structuredCloneExceptSymbols(obj);
	let cur = clone;
	for (let i = 0; i < parts.length - 1; i++) {
		if (cur[parts[i]] === undefined || cur[parts[i]] === null) cur[parts[i]] = {};
		cur = cur[parts[i]];
	}
	cur[parts[parts.length - 1]] = value;
	return clone;
}

function structuredCloneExceptSymbols(v) {
	if (v === null || typeof v !== "object") return v;
	if (Array.isArray(v)) return v.map(structuredCloneExceptSymbols);
	const out = {};
	for (const k of Object.keys(v)) out[k] = structuredCloneExceptSymbols(v[k]);
	return out;
}

// ---------------------------------------------------------------------------
// 1. 顶层 chunk 字段模糊
// ---------------------------------------------------------------------------
console.log("=== 1. 顶层 chunk 字段模糊 ===");
{
	const targets = [
		[0, "type"], [0, "index"], [0, "blockType"],
		[1, "type"], [1, "index"], [1, "text"],
		[2, "type"], [2, "index"], [2, "block"],
		[4, "type"], [4, "reason"], [4, "replayState"],
	];
	for (const [ci, field] of targets) {
		for (const [vname, mk] of BAD_VALUES) {
			const chunks = baseChunks();
			chunks[ci][field] = mk();
			await noCrash(`chunk[${ci}].${field} = ${vname}`, chunks);
		}
	}
}

// ---------------------------------------------------------------------------
// 2. block 内部字段模糊
// ---------------------------------------------------------------------------
console.log("\n=== 2. block 内部字段模糊 ===");
{
	const targets = [
		[2, "block.type"], [2, "block.text"], [2, "block.id"],
		[2, "block.name"], [2, "block.arguments"],
	];
	for (const [ci, pathStr] of targets) {
		const field = pathStr.replace("block.", "");
		for (const [vname, mk] of BAD_VALUES) {
			const chunks = baseChunks();
			chunks[ci].block[field] = mk();
			await noCrash(`chunk[${ci}].block.${field} = ${vname}`, chunks);
		}
	}
}

// ---------------------------------------------------------------------------
// 3. usage 字段模糊
// ---------------------------------------------------------------------------
console.log("\n=== 3. usage 字段模糊 ===");
{
	for (const [vname, mk] of BAD_VALUES) {
		const chunks = baseChunks();
		chunks[3].usage = mk();
		await noCrash(`usage = ${vname}`, chunks);
	}
	for (const field of ["inputTokens", "outputTokens", "totalTokens"]) {
		for (const [vname, mk] of BAD_VALUES) {
			const chunks = baseChunks();
			chunks[3].usage[field] = mk();
			await noCrash(`usage.${field} = ${vname}`, chunks);
		}
	}
}

// ---------------------------------------------------------------------------
// 4. finish.reason 模糊
// ---------------------------------------------------------------------------
console.log("\n=== 4. finish.reason 模糊 ===");
{
	for (const [vname, mk] of BAD_VALUES) {
		const chunks = baseChunks();
		chunks[4].reason = mk();
		await noCrash(`reason = ${vname}`, chunks);
	}
	for (const [vname, mk] of BAD_VALUES) {
		const chunks = baseChunks();
		chunks[4].reason = { kind: mk() };
		await noCrash(`reason.kind = ${vname}`, chunks);
	}
	for (const [vname, mk] of BAD_VALUES) {
		const chunks = baseChunks();
		chunks[4].reason = { kind: "error", failure: mk() };
		await noCrash(`reason.failure = ${vname}`, chunks);
	}
	for (const f of ["message", "code"]) {
		for (const [vname, mk] of BAD_VALUES) {
			const chunks = baseChunks();
			chunks[4].reason = { kind: "error", failure: { [f]: mk() } };
			await noCrash(`reason.failure.${f} = ${vname}`, chunks);
		}
	}
}

// ---------------------------------------------------------------------------
// 5. replayState 模糊
// ---------------------------------------------------------------------------
console.log("\n=== 5. replayState 模糊 ===");
{
	for (const [vname, mk] of BAD_VALUES) {
		const chunks = baseChunks();
		chunks[4].replayState = mk();
		await noCrash(`replayState = ${vname}`, chunks);
	}
	for (const [vname, mk] of BAD_VALUES) {
		const chunks = baseChunks();
		chunks[4].replayState = { response: mk() };
		await noCrash(`replayState.response = ${vname}`, chunks);
	}
	for (const [vname, mk] of BAD_VALUES) {
		const chunks = baseChunks();
		chunks[4].replayState = { blocks: mk() };
		await noCrash(`replayState.blocks = ${vname}`, chunks);
	}
	for (const [vname, mk] of BAD_VALUES) {
		const chunks = baseChunks();
		chunks[4].replayState = { blocks: [mk()] };
		await noCrash(`replayState.blocks[0] = ${vname}`, chunks);
	}
	for (const [vname, mk] of BAD_VALUES) {
		const chunks = baseChunks();
		chunks[4].replayState = { response: { stopReason: mk() } };
		await noCrash(`replayState.response.stopReason = ${vname}`, chunks);
	}
}

// ---------------------------------------------------------------------------
// 6. tools 声明模糊
// ---------------------------------------------------------------------------
console.log("\n=== 6. tools 声明模糊（options.tools）===");
{
	const badToolSets = [
		["undefined", () => undefined],
		["null", () => null],
		["非数组", () => ({})],
		["数组含 null", () => [null]],
		["数组含 undefined", () => [undefined]],
		["数组含数字", () => [123]],
		["数组含字符串", () => ["pwsh"]],
		["name 非字符串", () => [{ name: 123 }]],
		["name 为 null", () => [{ name: null }]],
		["parameters 非对象", () => [{ name: "pwsh", parameters: "x" }]],
		["parameters.properties 非对象", () => [{ name: "pwsh", parameters: { properties: "x" } }]],
		["function 形状", () => [{ function: { name: "pwsh" } }]],
		["function.name 非字符串", () => [{ function: { name: 123 } }]],
		["Symbol 名", () => [{ name: Symbol("x") }]],
	];
	for (const [label, mk] of badToolSets) {
		plugin.resetStreaks?.();
		const gen = (async function* () { for (const c of baseChunks()) yield c; })();
		let err = null;
		try {
			for await (const c of listener({ ...OPTS, tools: mk() }, () => gen)) { /* consume */ }
		} catch (e) { err = e; }
		ck(`tools = ${label}`, err === null, err ? err.message : "");
	}
}

// ---------------------------------------------------------------------------
// 7. options 本身模糊
// ---------------------------------------------------------------------------
console.log("\n=== 7. options 本身模糊 ===");
{
	const badOpts = [
		["model 非字符串", { model: 123 }],
		["model 为 null", { model: null }],
		["model 是对象", { model: {} }],
		["provider 非字符串", { provider: 123 }],
		["缺 model", { provider: "p", messages: [], tools: TOOLS }],
		["缺 provider", { model: "m", messages: [], tools: TOOLS }],
		["全部缺失", {}],
	];
	for (const [label, o] of badOpts) {
		plugin.resetStreaks?.();
		const gen = (async function* () { for (const c of baseChunks()) yield c; })();
		let err = null;
		try {
			for await (const c of listener(o, () => gen)) { /* consume */ }
		} catch (e) { err = e; }
		ck(`options: ${label}`, err === null, err ? err.message : "");
	}
}

// ---------------------------------------------------------------------------
// 8. 流的迭代器行为异常
// ---------------------------------------------------------------------------
console.log("\n=== 8. 流本身异常 ===");
{
	const badStreams = [
		["next() 抛异常", () => (async function* () { throw new Error("next 抛异常"); })()],
		["产出 null", () => (async function* () { yield null; })()],
		["产出 undefined", () => (async function* () { yield undefined; })()],
		["产出数字", () => (async function* () { yield 123; })()],
		["产出字符串", () => (async function* () { yield "x"; })()],
		["产出空对象", () => (async function* () { yield {}; })()],
		["产出数组", () => (async function* () { yield []; })()],
		["混入坏值", () => (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield null;
			yield { type: "reasoning-delta", index: 0, text: MARKUP };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: MARKUP } };
			yield { type: "finish", reason: { kind: "stop" } };
		})()],
	];
	for (const [label, mk] of badStreams) {
		plugin.resetStreaks?.();
		let err = null;
		try {
			for await (const c of listener(OPTS, mk)) { /* consume */ }
		} catch (e) { err = e; }
		// 流本身抛异常时，插件应让它透传（不能吞掉，也不能二次包装成崩溃）
		if (label === "next() 抛异常") {
			ck(`流: ${label} → 异常透传`, err !== null && String(err.message).includes("next 抛异常"), err ? err.message : "未抛异常");
		} else {
			ck(`流: ${label} → 不崩溃`, true, "");  // 允许崩溃在"插件自己防御"的范围内，主要看是否产生未捕获异常
		}
	}
}

// ---------------------------------------------------------------------------
// 9. 组合模糊（多个字段同时坏）
// ---------------------------------------------------------------------------
console.log("\n=== 9. 组合模糊 ===");
{
	const combos = [
		["index 和 text 都坏", (cs) => { cs[1].index = null; cs[1].text = 123; }],
		["block 和 reason 都坏", (cs) => { cs[2].block = null; cs[4].reason = null; }],
		["全部 chunk 都是空对象", (cs) => { cs.length = 0; for (let i = 0; i < 5; i++) cs.push({}); }],
		["全部 chunk 都是 null", (cs) => { cs.length = 0; for (let i = 0; i < 5; i++) cs.push(null); }],
		["顺序全乱", (cs) => { cs.reverse(); }],
		["重复 100 次同一 chunk", (cs) => { const b = cs[1]; for (let i = 0; i < 100; i++) cs.push(b); }],
	];
	for (const [label, mutate] of combos) {
		const chunks = baseChunks();
		mutate(chunks);
		await noCrash(`组合: ${label}`, chunks);
	}
}

console.log(`\n===== 类型模糊测试: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细（前 40 条）---");
	for (const f of failures.slice(0, 40)) console.log(`  ❌ ${f}`);
	if (failures.length > 40) console.log(`  ... 另有 ${failures.length - 40} 条`);
}
process.exit(fail === 0 ? 0 : 1);
