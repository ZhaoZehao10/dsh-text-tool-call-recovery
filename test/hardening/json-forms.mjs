// parseCallBody 的 JSON 形态等价类穷举
// 目标：把所有合法的 JSON 工具调用写法穷举一遍，找出漏识别 / 误识别。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "number" } } } },
	{ name: "write", parameters: { type: "object", properties: { content: { type: "string" }, file_path: { type: "string" } } } },
];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

async function recover(text) {
	plugin.resetStreaks?.();
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = [];
	for await (const c of listener(OPTS, () => src)) out.push(c);
	return out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call")
		.map((c) => { try { return { name: c.block.name, args: JSON.parse(c.block.arguments) }; } catch { return { name: c.block.name, args: "(invalid)" }; } });
}

let pass = 0, fail = 0;
const failures = [];
const ck = (label, cond, detail) => { if (cond) pass++; else { fail++; failures.push(`${label}${detail ? " :: " + detail : ""}`); } };

const wrap = (s) => OC + "\n" + s + "\n" + CC;

console.log("=== 1. 标准 JSON 形态 ===");
{
	const cases = [
		["name + arguments（对象）", '{"name":"pwsh","arguments":{"command":"echo A"}}', "pwsh", (a) => a.command === "echo A"],
		["name + arguments（字符串）", '{"name":"pwsh","arguments":"{\\"command\\":\\"echo B\\"}"}', "pwsh", (a) => a.command === "echo B"],
		["name + input", '{"name":"pwsh","input":{"command":"echo C"}}', "pwsh", (a) => a.command === "echo C"],
		["name + parameters", '{"name":"pwsh","parameters":{"command":"echo D"}}', "pwsh", (a) => a.command === "echo D"],
		["name + args", '{"name":"pwsh","args":{"command":"echo E"}}', "pwsh", (a) => a.command === "echo E"],
		["带前后空白", '\n\n  {"name":"pwsh","arguments":{"command":"echo F"}}  \n\n', "pwsh", (a) => a.command === "echo F"],
		["带缩进的 JSON", '{\n  "name": "pwsh",\n  "arguments": {\n    "command": "echo G"\n  }\n}', "pwsh", (a) => a.command === "echo G"],
	];
	for (const [label, json, name, pred] of cases) {
		const calls = await recover(wrap(json));
		ck(label, calls.length === 1 && calls[0].name === name && pred(calls[0].args), JSON.stringify(calls));
	}
}

console.log("\n=== 2. JSON 里的类型强转 ===");
{
	const cases = [
		["数字参数", '{"name":"pwsh","arguments":{"timeoutMs":5000}}', (a) => a.timeoutMs === 5000],
		["数字字符串 → 强转为 number", '{"name":"pwsh","arguments":{"timeoutMs":"5000"}}', (a) => a.timeoutMs === 5000],
		["布尔值", '{"name":"write","arguments":{"file_path":"/a","content":"x"}}', (a) => a.file_path === "/a"],
		["嵌套对象保持不变", '{"name":"write","arguments":{"file_path":"/a","content":"y","extra":{"k":1}}}', (a) => JSON.stringify(a.extra) === '{"k":1}'],
	];
	for (const [label, json, pred] of cases) {
		const calls = await recover(wrap(json));
		ck(label, calls.length === 1 && pred(calls[0].args), JSON.stringify(calls));
	}
}

console.log("\n=== 3. JSON 边界：不该恢复的 ===");
{
	const cases = [
		["缺 name", '{"arguments":{"command":"x"}}'],
		["name 不是字符串", '{"name":123,"arguments":{}}'],
		["未声明的工具", '{"name":"nonexistent","arguments":{"a":1}}'],
		["非法 JSON", '{"name":"pwsh",,}'],
		["空 JSON 对象", '{}'],
		["JSON 数组（非对象）", '[{"name":"pwsh"}]'],
		["只有 arguments", '{"arguments":{"command":"x"}}'],
	];
	for (const [label, json] of cases) {
		const calls = await recover(wrap(json));
		ck(`${label} → 不恢复`, calls.length === 0, JSON.stringify(calls));
	}
}

console.log("\n=== 4. 特殊字符与编码 ===");
{
	const cases = [
		["JSON 里的转义引号", '{"name":"pwsh","arguments":{"command":"echo \\"hello\\""}}', (a) => a.command === 'echo "hello"'],
		["JSON 里的换行", '{"name":"pwsh","arguments":{"command":"echo a\\necho b"}}', (a) => a.command === "echo a\necho b"],
		["JSON 里的反斜杠路径", '{"name":"write","arguments":{"file_path":"C:\\\\tmp\\\\a.txt"}}', (a) => a.file_path === "C:\\tmp\\a.txt"],
		["JSON 里的中文", '{"name":"pwsh","arguments":{"command":"echo 中文测试"}}', (a) => a.command === "echo 中文测试"],
		["JSON 里的 emoji", '{"name":"pwsh","arguments":{"command":"echo 🎯"}}', (a) => a.command === "echo 🎯"],
		["JSON 里的反引号", '{"name":"pwsh","arguments":{"command":"echo `date`"}}', (a) => a.command === "echo `date`"],
		["JSON 里的 < > 字符", '{"name":"pwsh","arguments":{"command":"echo a > b < c"}}', (a) => a.command === "echo a > b < c"],
	];
	for (const [label, json, pred] of cases) {
		const calls = await recover(wrap(json));
		ck(label, calls.length === 1 && pred(calls[0].args), JSON.stringify(calls[0]?.args));
	}
}

console.log("\n=== 5. JSON 与 XML 混合 ===");
{
	// tool_call 里既有 XML 又有 JSON（异常但可能发生）
	const mixed = wrap('<function=pwsh><parameter=command>echo xml</parameter></function>\n{"name":"pwsh","arguments":{"command":"echo json"}}');
	const calls = await recover(mixed);
	ck("XML + JSON 混合时至少恢复一个", calls.length >= 1, JSON.stringify(calls));
}

console.log("\n=== 6. 多调用 JSON ===");
{
	const two = wrap('{"name":"pwsh","arguments":{"command":"a"}}') + "\n" + wrap('{"name":"pwsh","arguments":{"command":"b"}}');
	const calls = await recover(two);
	ck("两个 JSON 调用都恢复且顺序正确", calls.length === 2 && calls[0].args.command === "a" && calls[1].args.command === "b", JSON.stringify(calls.map((c) => c.args?.command)));
}

console.log("\n=== 7. 超长 JSON（性能与上限）===");
{
	const longStr = "填充".repeat(30000); // ~60K 字符
	const json = JSON.stringify({ name: "write", arguments: { file_path: "/a", content: longStr } });
	const t0 = process.hrtime.bigint();
	const calls = await recover(wrap(json));
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	ck("超长 JSON 能恢复且耗时 < 2 秒", calls.length === 1 && ms < 2000, `${calls.length} 个, ${ms.toFixed(0)}ms`);
}

console.log(`\n===== JSON 形态穷举: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
