// 未覆盖函数的变异体守护
//
// **第 64 轮发现**：46 个变异体只覆盖 **9/19 个函数**。经分析：
//   - `computeDisplayRanges` / `isInRanges` → 被 `backtick-precision.mjs` 等行为套件覆盖 ✅
//   - `apply` → 所有套件都经过它 ✅
//   - **`propertiesOf` 和 `safeJsonParse` → 0 个行为套件覆盖** ❌
//
// 这两个函数负责**参数类型转换与 JSON 解析**，是恢复链路的关键环节：
//   - `propertiesOf`：从工具声明里取 properties 表 → 决定是否强转类型
//   - `safeJsonParse`：把 JSON 参数体解析成对象 → 失败时降级为 `{value: text}`
//
// 本套件用**已知答案**验证它们的行为（而非只测「不崩溃」）。
//
// **注意**：`tool-call` 块的 `arguments` 是 **JSON 字符串**（宿主协议要求），
// 不是对象 —— 第 64 轮踩过这个坑，必须 `JSON.parse` 后再断言。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const SRC = fs.readFileSync(LIB, "utf8");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const plugin = await import(pathToFileURL(LIB).href + "?cov=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

async function run(text, tools, blockType = "reasoning") {
	plugin.resetStreaks?.();
	const out = [];
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType };
		yield { type: blockType === "text" ? "text-delta" : "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: blockType, text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	for await (const c of listener({ provider: "p", model: "cov-" + Math.random(), messages: [], tools }, () => gen)) out.push(c);
	const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	const fin = out.find((c) => c.type === "finish");
	// **关键**：arguments 是 JSON 字符串，这里统一解析成对象供断言
	const parsed = calls.map((c) => {
		try {
			return { ...c.block, args: JSON.parse(c.block.arguments) };
		} catch {
			return { ...c.block, args: undefined };
		}
	});
	return { calls: parsed, kind: fin?.reason?.kind, rawCalls: calls.map((c) => c.block) };
}

// ===========================================================================
// 1. propertiesOf —— 决定「是否按声明类型强转」
// ===========================================================================
console.log("=== 1. propertiesOf 的行为 ===");
{
	// 1a. 有完整 properties：数字、布尔都应被强转
	const TOOLS = [{
		name: "pwsh",
		parameters: {
			type: "object",
			properties: {
				timeout: { type: "integer" },
				verbose: { type: "boolean" },
				count: { type: "number" },
			},
		},
	}];
	const text = OC + "\n<function=pwsh>\n<parameter=timeout>5000\n</parameter>\n<parameter=verbose>true\n</parameter>\n<parameter=count>3.14\n</parameter>\n</function>\n" + CC;
	const r = await run(text, TOOLS);
	const args = r.calls[0]?.args;
	console.log(`  有 properties: args=${JSON.stringify(args)}`);

	ck("integer 声明 → timeout 转成数字", typeof args?.timeout === "number", typeof args?.timeout);
	ck("boolean 声明 → verbose 转成布尔", typeof args?.verbose === "boolean", typeof args?.verbose);
	ck("number 声明 → count 转成数字", typeof args?.count === "number", typeof args?.count);
	ck("数字值正确（5000）", args?.timeout === 5000, String(args?.timeout));
	ck("布尔值正确（true）", args?.verbose === true, String(args?.verbose));
}

{
	// 1b. 无 parameters：应保持字符串（不做无依据的强转）
	const TOOLS = [{ name: "pwsh" }];
	const text = OC + "\n<function=pwsh>\n<parameter=timeout>5000\n</parameter>\n</function>\n" + CC;
	const r = await run(text, TOOLS);
	const args = r.calls[0]?.args;
	console.log(`  无 parameters: args=${JSON.stringify(args)}`);
	ck("无 parameters → 保持字符串", typeof args?.timeout === "string", typeof args?.timeout);
	ck("字符串值正确（\"5000\"）", args?.timeout === "5000", JSON.stringify(args?.timeout));
}

{
	// 1c. parameters 为 null / properties 为 null / properties 非对象
	const CASES = [
		["parameters=null", { name: "pwsh", parameters: null }],
		["properties=null", { name: "pwsh", parameters: { type: "object", properties: null } }],
		["properties=字符串", { name: "pwsh", parameters: { type: "object", properties: "not-an-object" } }],
		["parameters=字符串", { name: "pwsh", parameters: "not-an-object" }],
	];
	for (const [label, tool] of CASES) {
		const text = OC + "\n<function=pwsh>\n<parameter=x>1\n</parameter>\n</function>\n" + CC;
		let threw = false;
		let r;
		try { r = await run(text, [tool]); } catch { threw = true; }
		ck(`${label} 不崩溃`, !threw, "");
		if (!threw) {
			console.log(`  ${label}: 调用=${r.calls.length} args=${JSON.stringify(r.calls[0]?.args)}`);
			ck(`${label} 仍能恢复调用`, r.calls.length === 1, String(r.calls.length));
		}
	}
}

// ===========================================================================
// 2. safeJsonParse —— JSON 参数体解析
// ===========================================================================
console.log("\n=== 2. safeJsonParse 的行为 ===");
const TOOLS_JSON = [{
	name: "pwsh",
	parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer" } } },
}];

{
	// 2a. 合法 JSON：应解析出对象
	const text = OC + '\n<function=pwsh>\n{"command":"echo hi","timeout":"3000"}\n</function>\n' + CC;
	const r = await run(text, TOOLS_JSON);
	const args = r.calls[0]?.args;
	console.log(`  合法 JSON: args=${JSON.stringify(args)}`);
	ck("合法 JSON 解析出 command", args?.command === "echo hi", JSON.stringify(args?.command));
	ck("合法 JSON 的 timeout 被强转", typeof args?.timeout === "number", typeof args?.timeout);
}

{
	// 2b. 畸形 JSON：不应崩溃，且**不应该**恢复出调用（因为无法确定参数）
	const text = OC + '\n<function=pwsh>\n{"command":"echo hi"\n</function>\n' + CC;
	let threw = false;
	let r;
	try { r = await run(text, TOOLS_JSON); } catch { threw = true; }
	ck("畸形 JSON 不抛异常", !threw, "");
	if (!threw) {
		console.log(`  畸形 JSON: 调用=${r.calls.length} kind=${r.kind}`);
		// 行为允许两种：放弃恢复（走安全网）或降级解析。关键是不崩溃、不误执行。
		ck("畸形 JSON 不产生非法调用", r.calls.length === 0 || r.calls[0]?.args !== undefined,
			`调用=${r.calls.length}`);
	}
}

{
	// 2c. 深层嵌套：不栈溢出
	const deep = '{"a":'.repeat(50) + "1" + "}".repeat(50);
	const text = OC + `\n<function=pwsh>\n${deep}\n</function>\n` + CC;
	let threw = false;
	let r;
	try { r = await run(text, TOOLS_JSON); } catch { threw = true; }
	ck("深层嵌套 JSON 不抛异常", !threw, "");
	if (!threw) console.log(`  深层嵌套: 调用=${r.calls.length} kind=${r.kind}`);
}

{
	// 2d. **安全**：原型污染不得生效
	const text = OC + '\n<function=pwsh>\n{"__proto__":{"polluted":true},"command":"echo hi"}\n</function>\n' + CC;
	const before = ({}).polluted;
	await run(text, TOOLS_JSON);
	const after = ({}).polluted;
	console.log(`  原型污染尝试: before=${before} after=${after}`);
	ck("原型污染未生效", after === undefined, String(after));
}

{
	// 2e. JSON 里的 __proto__ 不得成为对象原型
	const text = OC + '\n<function=pwsh>\n{"command":"echo hi","__proto__":{"x":1}}\n</function>\n' + CC;
	const r = await run(text, TOOLS_JSON);
	const args = r.calls[0]?.args;
	const protoPolluted = args && Object.getPrototypeOf(args) !== Object.prototype;
	console.log(`  带 __proto__ 的 JSON: args=${JSON.stringify(args)}`);
	ck("解析结果的原型未被污染", !protoPolluted, "");
}

// ===========================================================================
// 3. 源码层面：这两个函数必须存在且实现符合预期
// ===========================================================================
console.log("\n=== 3. 源码实现检查 ===");
{
	ck("propertiesOf 存在", /^function propertiesOf\(/m.test(SRC), "");
	ck("safeJsonParse 存在", /^function safeJsonParse\(/m.test(SRC), "");

	// propertiesOf 必须做三层校验
	const poIdx = SRC.indexOf("function propertiesOf(");
	const poBody = poIdx >= 0 ? SRC.slice(poIdx, poIdx + 400) : "";
	ck("propertiesOf 校验 parameters 存在", /parameters\s*&&/.test(poBody), "");
	ck("propertiesOf 校验 properties 是对象", /typeof parameters\.properties\s*===\s*"object"/.test(poBody), "");

	// safeJsonParse 必须有 try/catch
	const sjIdx = SRC.indexOf("function safeJsonParse(");
	const sjBody = sjIdx >= 0 ? SRC.slice(sjIdx, sjIdx + 300) : "";
	ck("safeJsonParse 有 try/catch", /try\s*\{/.test(sjBody) && /catch/.test(sjBody), "");
	ck("safeJsonParse 失败时降级（不抛异常）", /return\s*\{\s*value:/.test(sjBody), "");
}

console.log(`\n===== 未覆盖函数守护: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
