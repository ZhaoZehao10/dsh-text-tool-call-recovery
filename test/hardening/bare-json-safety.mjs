// 真实事故回归测试：裸 JSON 片段绝不能恢复成调用
//
// 真实案例（2026-10-22 03:48，session-965a9f2f turn=23 step=41）：
//   模型在汇报文本末尾输出了说明性的 JSON 片段：
//     ...随时可以复跑。
//     {"command":"rm -rf /"}
//   旧版插件把它恢复成了 pwsh({"command":"rm -rf /"}) —— **差点执行删根命令**。
//   剥离旧版合成块后用当前版本重放：恢复 0 个（已修复）。
//
// 判据演进：
//   旧：只要文本以 { 开头就尝试当 JSON 工具调用解析
//   新：必须「整段以 { 开头、以 } 结尾」+ 有明确的工具名键 + 有参数容器键
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" }, description: { type: "string" } } } },
	{ name: "read", parameters: { type: "object", properties: { file_path: { type: "string" } } } },
];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

async function run(text) {
	plugin.resetStreaks?.();
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "text", text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = [];
	for await (const c of listener(OPTS, () => src)) out.push(c);
	return out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call")
		.map((c) => { try { return { name: c.block.name, args: JSON.parse(c.block.arguments) }; } catch { return { name: c.block.name, args: "(bad)" }; } });
}

console.log("=== 1. 真实事故复现：文本末尾的说明性 JSON 片段 ===");
{
	// 完全复刻真实事故的文本结构（末尾裸 JSON，不带工具名）
	const realIncident = `# 汇报

上一轮我说"修完两个 bug 就完善了"，结果这轮又找出三个。

如果你想再加一道保险，[fuzz.mjs](.tmp/fuzz.mjs) 都保留着，随时可以复跑。
{"command":"rm -rf /"}`;
	const calls = await run(realIncident);
	ck("【真实事故】末尾裸 JSON 片段不恢复", calls.length === 0, JSON.stringify(calls));
}

console.log("\n=== 2. 各种裸 JSON 片段形态（都不能恢复）===");
{
	const cases = [
		["纯参数对象（无工具名）", '{"command":"rm -rf /"}'],
		["文本 + 参数对象", '说明文字。\n{"command":"rm -rf /"}'],
		["前置文本+JSON", '这是示例：{"command":"ls"}'],
		["JSON 后面还有文本", '{"command":"ls"} 以上是示例'],
		["数组形态", '["a","b"]'],
		["嵌套的任意对象", '{"a":{"b":1}}'],
		["只有 arguments 没有 name", '{"arguments":{"command":"x"}}'],
		["只有 name 没有参数容器", '{"name":"pwsh"}'],
		["name 是未声明工具", '{"name":"unknown","arguments":{}}'],
	];
	for (const [label, text] of cases) {
		const calls = await run(text);
		ck(`${label} → 不恢复`, calls.length === 0, JSON.stringify(calls));
	}
}

console.log("\n=== 3. 合法的 JSON 工具调用仍必须恢复（不误伤）===");
{
	const cases = [
		["标准 arguments", '{"name":"pwsh","arguments":{"command":"echo hi"}}', (c) => c.args.command === "echo hi"],
		["input 容器", '{"name":"pwsh","input":{"command":"echo hi"}}', (c) => c.args.command === "echo hi"],
		["parameters 容器", '{"name":"pwsh","parameters":{"command":"echo hi"}}', (c) => c.args.command === "echo hi"],
		["args 容器", '{"name":"pwsh","args":{"command":"echo hi"}}', (c) => c.args.command === "echo hi"],
		["tool 键代替 name", '{"tool":"pwsh","arguments":{"command":"echo hi"}}', (c) => c.args.command === "echo hi"],
		["arguments 是字符串", '{"name":"pwsh","arguments":"{\\"command\\":\\"echo hi\\"}"}', (c) => c.args.command === "echo hi"],
	];
	for (const [label, text, pred] of cases) {
		const calls = await run(text);
		ck(`${label} → 恢复`, calls.length === 1 && calls[0].name === "pwsh" && pred(calls[0]), JSON.stringify(calls));
	}
}

console.log("\n=== 4. tool_call 包裹内的 JSON（仍然合法）===");
{
	const wrapped = OC + '\n{"name":"pwsh","arguments":{"command":"echo hi"}}\n' + CC;
	const calls = await run(wrapped);
	ck("tool_call 包裹的 JSON → 恢复", calls.length === 1 && calls[0].args.command === "echo hi", JSON.stringify(calls));
}

console.log("\n=== 5. 代码块里的 JSON 示例不恢复 ===");
{
	const fenced = "```json\n{\"name\":\"pwsh\",\"arguments\":{\"command\":\"rm -rf /\"}}\n```";
	const calls = await run(fenced);
	ck("代码块里的 JSON 示例 → 不恢复", calls.length === 0, JSON.stringify(calls));
}

console.log(`\n===== 裸 JSON 安全事故回归: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
