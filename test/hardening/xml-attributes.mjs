// XML 属性形态的笛卡尔积穷举
// 目标：把 <function>/<invoke>/<parameter> 的属性写法空间穷举，找出漏识别/误识别。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "number" } } } },
	{ name: "read", parameters: { type: "object", properties: { file_path: { type: "string" }, limit: { type: "number" } } } },
	{ name: "my-tool.v2", parameters: { type: "object", properties: { x: { type: "string" } } } },
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
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };
const wrap = (s) => OC + "\n" + s + "\n" + CC;

console.log("=== 1. function name 属性：引号 × 空白 笛卡尔积 ===");
{
	// 引号形态 × 等号空白形态
	const quotes = [
		["双引号", '"'],
		["单引号", "'"],
		["无引号", ""],
	];
	const spacing = [
		["紧贴", "name="],
		["等号前空格", "name ="],
		["等号后空格", "name= "],
		["两侧空格", "name = "],
	];
	for (const [ql, q] of quotes) {
		for (const [sl, sp] of spacing) {
			const attr = sp + (q || "") + "pwsh" + (q || "");
			const markup = wrap(`<function ${attr}><parameter name="command">echo A</parameter></function>`);
			const calls = await recover(markup);
			// 无引号 + 紧贴 是最标准的，其他变体也应识别
			ck(`function ${ql} × ${sl}`, calls.length === 1 && calls[0].name === "pwsh", JSON.stringify(calls));
		}
	}
}

console.log("\n=== 2. parameter name 属性：引号 × 空白 ===");
{
	const quotes = [["双引号", '"'], ["单引号", "'"], ["无引号", ""]];
	const spacing = [["紧贴", "name="], ["两侧空格", "name = "]];
	for (const [ql, q] of quotes) {
		for (const [sl, sp] of spacing) {
			const attr = sp + (q || "") + "command" + (q || "");
			const markup = wrap(`<function name="pwsh"><parameter ${attr}>echo B</parameter></function>`);
			const calls = await recover(markup);
			ck(`parameter ${ql} × ${sl}`, calls.length === 1 && calls[0].args.command === "echo B", JSON.stringify(calls));
		}
	}
}

console.log("\n=== 3. 多属性形态（name 不是唯一属性）===");
{
	const cases = [
		["name 在前 + 额外属性", `<function name="pwsh" id="c1"><parameter name="command">echo C</parameter></function>`, "pwsh"],
		["额外属性在前 + name", `<function id="c1" name="pwsh"><parameter name="command">echo C</parameter></function>`, "pwsh"],
		["name + 多个额外属性", `<function a="1" name="pwsh" b="2"><parameter name="command">echo C</parameter></function>`, "pwsh"],
	];
	for (const [label, body, name] of cases) {
		const calls = await recover(wrap(body));
		ck(label, calls.length === 1 && calls[0].name === name, JSON.stringify(calls));
	}
}

console.log("\n=== 4. 工具名特殊字符 ===");
{
	const cases = [
		["带连字符", "my-tool.v2", `<function name="my-tool.v2"><parameter name="x">v</parameter></function>`],
		["带下划线", "pwsh", `<function name="pwsh"><parameter name="command">echo D</parameter></function>`],
	];
	for (const [label, expectName, body] of cases) {
		const calls = await recover(wrap(body));
		ck(`${label}（${expectName}）`, calls.length === 1 && calls[0].name === expectName, JSON.stringify(calls));
	}
	// 带点号的裸形态（function=pwsh.v2）
	{
		const calls = await recover(wrap(`<function=my-tool.v2><parameter=x>v</parameter></function>`));
		ck("点号工具名的裸形态", calls.length === 1 && calls[0].name === "my-tool.v2", JSON.stringify(calls));
	}
}

console.log("\n=== 5. antml: 前缀 × 属性形态 ===");
{
	const cases = [
		["antml:function name=", `<antml:function name="pwsh"><parameter name="command">echo E</parameter></antml:function>`],
		["antml:invoke name=", `<antml:invoke name="pwsh"><parameter name="command">echo E</parameter></antml:invoke>`],
		["antml:function 空格变体", `<antml:function name = "pwsh"><parameter name = "command">echo E</parameter></antml:function>`],
	];
	for (const [label, body] of cases) {
		const calls = await recover(wrap(body));
		ck(label, calls.length === 1 && calls[0].args.command === "echo E", JSON.stringify(calls));
	}
}

console.log("\n=== 6. 不该识别的属性形态 ===");
{
	const cases = [
		["缺 name 属性", `<function><parameter name="command">x</parameter></function>`],
		["name 为空", `<function name=""><parameter name="command">x</parameter></function>`],
		["name 是未声明工具", `<function name="unknown"><parameter name="x">v</parameter></function>`],
		["只有属性没有 body", `<function name="pwsh"></function>`],
	];
	for (const [label, body] of cases) {
		const calls = await recover(wrap(body));
		ck(`${label} → 不恢复`, calls.length === 0, JSON.stringify(calls));
	}
}

console.log("\n=== 7. 参数值类型（按 schema 强转）===");
{
	const cases = [
		["number 参数（字符串值）", `<function name="pwsh"><parameter name="timeoutMs">5000</parameter><parameter name="command">x</parameter></function>`, (a) => a.timeoutMs === 5000],
		["number 参数（非数字值）", `<function name="pwsh"><parameter name="timeoutMs">abc</parameter><parameter name="command">x</parameter></function>`, (a) => a.timeoutMs === "abc"],
		["多参数顺序无关", `<function name="pwsh"><parameter name="command">x</parameter><parameter name="timeoutMs">100</parameter></function>`, (a) => a.command === "x" && a.timeoutMs === 100],
	];
	for (const [label, body, pred] of cases) {
		const calls = await recover(wrap(body));
		ck(label, calls.length === 1 && pred(calls[0].args), JSON.stringify(calls[0]?.args));
	}
}

console.log("\n=== 8. 自闭合与异常标签 ===");
{
	const cases = [
		["自闭合 parameter", `<function name="pwsh"><parameter name="command"/></function>`],
		["嵌套 parameter", `<function name="pwsh"><parameter name="command"><parameter name="x">y</parameter></parameter></function>`],
	];
	for (const [label, body] of cases) {
		let threw = null;
		let calls = [];
		try { calls = await recover(wrap(body)); } catch (e) { threw = e.message; }
		ck(`${label} → 不抛异常`, threw === null, threw ?? "");
	}
}

console.log(`\n===== XML 属性穷举: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
