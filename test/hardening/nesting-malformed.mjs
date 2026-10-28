// 极端嵌套与畸形 XML 的解析行为测试
// 目标：确认深层嵌套 / 重复标签 / 交叉嵌套不会导致：
//   - 崩溃
//   - 无限循环 / 性能爆炸
//   - 错误解析（把内层当外层、参数串味）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

async function run(text) {
	plugin.resetStreaks?.();
	const t0 = process.hrtime.bigint();
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = [];
	let threw = null;
	try { for await (const c of listener(OPTS, () => src)) out.push(c); } catch (e) { threw = e.message; }
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call")
		.map((c) => { try { return { name: c.block.name, args: JSON.parse(c.block.arguments) }; } catch { return { name: c.block.name, args: "(invalid)" }; } });
	return { calls, threw, ms, out };
}

console.log("=== 1. 深层嵌套 parameter ===");
{
	const depths = [2, 5, 10, 50];
	for (const d of depths) {
		let inner = "echo nested";
		for (let i = 0; i < d; i++) inner = `<parameter name="p${i}">${inner}</parameter>`;
		const markup = OC + "<function name=\"pwsh\">" + inner + "</function>" + CC;
		const r = await run(markup);
		ck(`嵌套 ${d} 层不崩溃`, r.threw === null, r.threw ?? "");
		ck(`嵌套 ${d} 层耗时 < 1s`, r.ms < 1000, `${r.ms.toFixed(0)}ms`);
	}
}

console.log("\n=== 2. 嵌套 tool_call ===");
{
	const markup = OC + "<function name=\"pwsh\"><parameter name=\"command\">" + OC + "echo x" + CC + "</parameter></function>" + CC;
	const r = await run(markup);
	ck("嵌套 tool_call 不崩溃", r.threw === null, r.threw ?? "");
	ck("嵌套 tool_call 耗时 < 1s", r.ms < 1000, `${r.ms.toFixed(0)}ms`);
}

console.log("\n=== 3. 交叉嵌套（不合法但可能发生）===");
{
	const cases = [
		["未闭合外层 + 完整内层", OC + "<function name=\"pwsh\"><parameter name=\"command\">echo a</parameter></function>"],
		["完整外层 + 未闭合内层", OC + "<function name=\"pwsh\"><parameter name=\"command\">echo a</function>" + CC],
		["开标签重复", OC + OC + "<function name=\"pwsh\"><parameter name=\"command\">echo a</parameter></function>" + CC],
		["闭标签重复", OC + "<function name=\"pwsh\"><parameter name=\"command\">echo a</parameter></function>" + CC + CC],
		["闭在开之前", CC + "<function name=\"pwsh\"><parameter name=\"command\">echo a</parameter></function>" + OC],
	];
	for (const [label, markup] of cases) {
		const r = await run(markup);
		ck(`${label} → 不崩溃`, r.threw === null, r.threw ?? "");
		ck(`${label} → 耗时 < 1s`, r.ms < 1000, `${r.ms.toFixed(0)}ms`);
	}
}

console.log("\n=== 4. 大量重复标签（性能）===");
{
	const cases = [
		["1000 个开标签", OC.repeat(1000)],
		["1000 个闭标签", CC.repeat(1000)],
		["1000 个 function 开", ("<function name=\"pwsh\">").repeat(1000)],
		["1000 个 parameter 开", ("<parameter name=\"command\">").repeat(1000)],
	];
	for (const [label, markup] of cases) {
		const r = await run(markup);
		ck(`${label} → 不崩溃`, r.threw === null, r.threw ?? "");
		ck(`${label} → 耗时 < 2s`, r.ms < 2000, `${r.ms.toFixed(0)}ms`);
	}
}

console.log("\n=== 5. 参数串味检查（多层嵌套时不能把内层参数当外层）===");
{
	// 外层函数 pwsh，内层文本里又有 parameter，但外层只应有 command
	const markup = OC + "<function name=\"pwsh\"><parameter name=\"command\">echo </parameter></function>" + CC;
	const r = await run(markup);
	// 注意：`<parameter name="command">echo </parameter>` 的值确实含尾随空格，只 trim 首尾换行 → 期望 "echo "（不是 "echo"）
		ck("参数正确归属（不串味，值原样保留）", r.calls.length === 1 && r.calls[0].args.command.trim() === "echo", JSON.stringify(r.calls));
}

console.log("\n=== 6. 多调用与嵌套混合 ===");
{
	const one = OC + "<function name=\"pwsh\"><parameter name=\"command\">a</parameter></function>" + CC;
	const two = OC + "<function name=\"pwsh\"><parameter name=\"command\">b</parameter></function>" + CC;
	const r = await run(one + "\n" + two);
	ck("两个调用都恢复且顺序正确", r.calls.length === 2 && r.calls[0].args.command === "a" && r.calls[1].args.command === "b", JSON.stringify(r.calls.map((c) => c.args?.command)));
}

console.log("\n=== 7. 极长单行（无换行）===");
{
	const markup = OC + "<function name=\"pwsh\"><parameter name=\"command\">" + "x".repeat(50000) + "</parameter></function>" + CC;
	const r = await run(markup);
	ck("5 万字符单行 → 不崩溃", r.threw === null, r.threw ?? "");
	ck("5 万字符单行 → 耗时 < 2s", r.ms < 2000, `${r.ms.toFixed(0)}ms`);
	ck("5 万字符单行 → 参数完整", r.calls.length === 1 && r.calls[0].args.command.length === 50000, `${r.calls[0]?.args?.command?.length}`);
}

console.log("\n=== 8. 流不变量（所有畸形输入后仍合法）===");
{
	const inputs = [
		OC + "<function name=\"pwsh\"><parameter name=\"command\">x",
		"<function name=\"pwsh\">",
		CC + OC,
		OC.repeat(100),
	];
	for (let i = 0; i < inputs.length; i++) {
		const r = await run(inputs[i]);
		// 校验：finish 唯一、无重复 index、块配对
		const fins = r.out.filter((c) => c.type === "finish");
		ck(`畸形输入 #${i + 1} → finish 唯一`, fins.length === 1, `${fins.length}`);
		const open = new Set();
		let ok = true;
		for (const c of r.out) {
			if (c.type === "block-start") {
				if (open.has(c.index)) { ok = false; break; }
				open.add(c.index);
			} else if (c.type === "block-end") {
				if (!open.has(c.index)) { ok = false; break; }
				open.delete(c.index);
			}
		}
		ck(`畸形输入 #${i + 1} → 块索引合法`, ok, "");
	}
}

console.log(`\n===== 嵌套与畸形解析: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
