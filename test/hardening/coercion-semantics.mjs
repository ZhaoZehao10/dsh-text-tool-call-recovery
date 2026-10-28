// 类型强转的语义安全性审查
//
// 风险：如果 schema 声明是 number，但模型给的字符串"看起来像数字但语义不同"，
// 强转后工具行为可能与模型意图不符。
// 例：模型给 "007"（可能是字符串 ID），schema 说 number → 变成 7，语义变了。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [{
	name: "test",
	parameters: {
		type: "object",
		properties: {
			s: { type: "string" },
			n: { type: "number" },
			i: { type: "integer" },
			b: { type: "boolean" },
			o: { type: "object" },
			a: { type: "array" },
			any: {},
			nullable: { type: "string", nullable: true },
			enumf: { type: "string", enum: ["a", "b"] },
		},
	},
}];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

async function recover(key, value) {
	plugin.resetStreaks?.();
	const text = OC + "\n<function=test><parameter=" + key + ">" + value + "</parameter></function>\n" + CC;
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = [];
	for await (const c of listener(OPTS, () => src)) out.push(c);
	const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	if (calls.length === 0) return { recovered: false };
	try { return { recovered: true, args: JSON.parse(calls[0].block.arguments) }; }
	catch { return { recovered: true, args: null, raw: calls[0].block.arguments }; }
}

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

console.log("=== 1. schema=string 必须**永不**强转（防止语义变化）===");
{
	// 这些值"看起来像"其它类型，但 schema 是 string → 必须保持字符串
	const cases = [
		["42", "42"],
		["007", "007"],           // 关键：前导零不能丢
		["3.14", "3.14"],
		["1e5", "1e5"],
		["0x1F", "0x1F"],
		["true", "true"],
		["false", "false"],
		["null", "null"],
		["undefined", "undefined"],
		["NaN", "NaN"],
		["Infinity", "Infinity"],
		["-0", "-0"],
		["[]", "[]"],
		["{}", "{}"],
		['{"a":1}', '{"a":1}'],
	];
	for (const [input, expected] of cases) {
		const r = await recover("s", input);
		ck(`string "${input}" 保持字符串`, r.recovered && r.args.s === expected, JSON.stringify(r.args?.s));
	}
}

console.log("\n=== 2. schema=number 强转边界 ===");
{
	const cases = [
		["42", 42, true],
		["3.14", 3.14, true],
		["-5", -5, true],
		["1e5", 100000, true],
		["0x1F", 31, true],
		["  42  ", 42, true],
		["abc", "abc", false],       // 转不了 → 保持字符串
		["", "", false],
		["Infinity", "Infinity", false],  // Number("Infinity") = Infinity，不是有限数
		["NaN", "NaN", false],
	];
	for (const [input, expected, shouldBeNumber] of cases) {
		const r = await recover("n", input);
		const got = r.args?.n;
		const ok = shouldBeNumber ? got === expected : got === expected;
		ck(`number "${input}" → ${JSON.stringify(expected)}`, r.recovered && ok, JSON.stringify(got));
	}
}

console.log("\n=== 3. schema=integer 与 number 的不同 ===");
{
	// integer 应该保持整数语义
	const cases = [
		["42", 42],
		["3.7", 3.7],   // 当前实现是否取整？观察
	];
	for (const [input, expected] of cases) {
		const r = await recover("i", input);
		console.log(`  integer "${input}" → ${JSON.stringify(r.args?.i)} (期望 ${JSON.stringify(expected)})`);
	}
}

console.log("\n=== 4. schema=boolean ===");
{
	const cases = [
		["true", true],
		["false", false],
		["TRUE", "TRUE"],   // 大小写不同 → 不能转（保守）
		["1", "1"],         // 不转（避免歧义）
		["yes", "yes"],
	];
	for (const [input, expected] of cases) {
		const r = await recover("b", input);
		ck(`boolean "${input}" → ${JSON.stringify(expected)}`, r.recovered && r.args.b === expected, JSON.stringify(r.args?.b));
	}
}

console.log("\n=== 5. schema=object/array ===");
{
	const cases = [
		["o", '{"a":1}', (a) => JSON.stringify(a.o) === '{"a":1}'],
		["o", "{broken", (a) => a.o === "{broken"],     // 非法 JSON → 回退字符串
		["a", "[1,2,3]", (a) => JSON.stringify(a.a) === "[1,2,3]"],
		["a", "[broken", (a) => a.a === "[broken"],
	];
	for (const [key, input, pred] of cases) {
		const r = await recover(key, input);
		ck(`${key} "${input}"`, r.recovered && pred(r.args), JSON.stringify(r.args?.[key]));
	}
}

console.log("\n=== 6. 无 type 声明（不应强转）===");
{
	const cases = ["42", "true", '{"a":1}', "[1,2]"];
	for (const input of cases) {
		const r = await recover("any", input);
		ck(`无 type "${input}" 保持字符串`, r.recovered && r.args.any === input, JSON.stringify(r.args?.any));
	}
}

console.log("\n=== 7. enum 约束（不应破坏枚举值）===");
{
	for (const input of ["a", "b"]) {
		const r = await recover("enumf", input);
		ck(`enum "${input}" 保持字符串`, r.recovered && r.args.enumf === input, JSON.stringify(r.args?.enumf));
	}
}

console.log("\n=== 8. 数字精度（大整数不能丢精度）===");
{
	// **精度保护**：超过 2^53 的整数转 number 会静默丢精度
	// （9007199254740993 → 9007199254740992），可能让工具操作**错误的对象**。
	// 要求：这类值保持字符串，由工具自行解析。
	const bigCases = [
		["9007199254740993", "2^53+1"],
		["1234567890123456789", "19 位整数"],
		["18446744073709551615", "2^64-1"],
		["-9007199254740993", "负数"],
	];
	for (const [big, label] of bigCases) {
		const r = await recover("n", big);
		const got = r.args?.n;
		ck(`大整数 ${label} 保持字符串（不丢精度）`, r.recovered && got === big, `${JSON.stringify(big)} → ${JSON.stringify(got)}`);
	}
	// 对照：安全范围内的整数仍应转成 number
	{
		const safe = "9007199254740991";  // 2^53 - 1（安全）
		const r = await recover("n", safe);
		ck("安全范围内整数仍转 number", r.recovered && r.args.n === Number(safe), `${JSON.stringify(r.args?.n)} (类型 ${typeof r.args?.n})`);
	}
	// 对照：小数不应被误判为大整数
	{
		const r = await recover("n", "3.14159");
		ck("小数正常转 number", r.recovered && r.args.n === 3.14159, JSON.stringify(r.args?.n));
	}
}

console.log(`\n===== 类型强转语义安全: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
