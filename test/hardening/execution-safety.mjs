// 执行安全专项审查
//
// 核心风险不是「不执行」，而是「执行了不完整/错误的东西」。
// 本测试系统性检查：恢复出的调用，其**参数内容**是否与模型原意一致。
//
// 审查维度（每一条都可能导致执行错误命令）：
//   1. 参数值被截断（值内出现类标签文本）
//   2. 参数值被误解码（实体二次解码、转义丢失）
//   3. 参数类型被改变（字符串被强转成数字/布尔，语义变化）
//   4. 参数键被改变（大小写、空白、特殊字符）
//   5. 参数丢失（多参数只保留部分）
//   6. 参数串味（多个调用的参数互相混入）
//   7. 调用被合并（两个调用变成一个）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "number" }, description: { type: "string" } } } },
	{ name: "write", parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } } } },
	{ name: "grep", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" } } } },
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
		.map((c) => { try { return { name: c.block.name, args: JSON.parse(c.block.arguments) }; } catch { return { name: c.block.name, args: "(invalid json)" }; } });
}
const wrap = (s) => OC + "\n" + s + "\n" + CC;

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

// ============ 1. 参数值被截断 ============
console.log("=== 1. 参数值截断（最危险：执行半截命令）===");
{
	const cases = [
		["值内裸 </parameter>", "<function=pwsh><parameter=command>rm -rf /tmp/a</parameter></parameter></function>"],
		["值内裸 </function>", "<function=pwsh><parameter=command>rm -rf /tmp/a</function></parameter></function>"],
		["值内裸 </tool_call>", "<function=pwsh><parameter=command>rm -rf /tmp/a</tool_call></parameter></function>"],
		["Anthropic 值内裸 </parameter>", '<function name="pwsh"><parameter name="command">rm -rf /tmp/a</parameter></parameter></function>'],
	];
	for (const [label, body] of cases) {
		const calls = await recover(wrap(body));
		ck(`${label} → 拒绝执行（防半截命令）`, calls.length === 0, JSON.stringify(calls));
	}
}

// ============ 2. 参数值误解码 ============
console.log("\n=== 2. 参数值误解码（转义丢失会导致命令变化）===");
{
	const cases = [
		// &amp;amp; 应解成 &amp;（一次），不是 &
		["双重转义 &amp;amp;", "a &amp;amp; b", "a &amp; b"],
		// 反斜杠必须原样保留（Windows 路径）
		["Windows 路径", "C:\\Program Files\\x", "C:\\Program Files\\x"],
		["UNC 路径", "\\\\server\\share", "\\\\server\\share"],
		// 引号必须保留
		["嵌套引号", 'echo "it\'s"', 'echo "it\'s"'],
	];
	for (const [label, input, expected] of cases) {
		const calls = await recover(wrap("<function=pwsh><parameter=command>" + input + "</parameter></function>"));
		ck(`${label} 解码正确`, calls.length === 1 && calls[0].args.command === expected, `期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(calls[0]?.args?.command)}`);
	}
}

// ============ 3. 参数类型被改变（语义变化）============
console.log("\n=== 3. 参数类型改变（可能导致工具行为不同）===");
{
	// schema 声明 string 的必须保持字符串，不能因为"看起来像数字"就转
	const cases = [
		["schema=string 值=42 → 保持字符串", "command", "42", (a) => a.command === "42"],
		["schema=string 值=true → 保持字符串", "command", "true", (a) => a.command === "true"],
		["schema=string 值=007 → 保持字符串（不能变 7）", "command", "007", (a) => a.command === "007"],
		["schema=string 值=1e5 → 保持字符串", "command", "1e5", (a) => a.command === "1e5"],
		["schema=string 值=0x1F → 保持字符串", "command", "0x1F", (a) => a.command === "0x1F"],
		// schema=number 的才转
		["schema=number 值=5000 → 转数字", "timeoutMs", "5000", (a) => a.timeoutMs === 5000],
		["schema=number 值=abc → 保持字符串（转不了）", "timeoutMs", "abc", (a) => a.timeoutMs === "abc"],
	];
	for (const [label, key, value, pred] of cases) {
		const calls = await recover(wrap(`<function=pwsh><parameter=${key}>${value}</parameter></function>`));
		ck(label, calls.length === 1 && pred(calls[0].args), JSON.stringify(calls[0]?.args));
	}
}

// ============ 4. 参数键被改变 ============
console.log("\n=== 4. 参数键改变（键名错 → 工具收不到参数）===");
{
	const cases = [
		// 观察项：`<parameter= key >`（等号后带空格）当前不被识别。
		// 真实日志扫描（9,626 条消息）中该形态出现 **0 次**（唯一 1 次是本项目的
		// 汇报文本自身），属「合理宽松解析未覆盖」而非缺陷；不识别比识别错安全。
		["键含空格（已知限制：不识别）", "<function=pwsh><parameter= command >x</parameter></function>", "__EXPECT_NO_RECOVERY__", null],
		["键大小写不同（应保持原样）", '<function name="pwsh"><parameter name="COMMAND">x</parameter></function>', "COMMAND", "x"],
		["键含连字符", '<function name="pwsh"><parameter name="timeout-ms">5</parameter></function>', "timeout-ms", "5"],
	];
	for (const [label, body, expectKey, expectVal] of cases) {
		const calls = await recover(wrap(body));
		if (expectKey === "__EXPECT_NO_RECOVERY__") {
			// 已知限制：不识别（安全侧行为，不是误执行）
			ck(`${label} → 不识别（安全）`, calls.length === 0, JSON.stringify(calls));
		} else {
			ck(`${label} → 键名正确`, calls.length === 1 && calls[0].args[expectKey] === expectVal, JSON.stringify(calls[0]?.args));
		}
	}
}

// ============ 5. 参数丢失 ============
console.log("\n=== 5. 参数丢失（少参数 → 工具行为不完整）===");
{
	const cases = [
		["三参数全保留", "<function=pwsh><parameter=command>a</parameter><parameter=description>b</parameter><parameter=timeoutMs>5</parameter></function>", 3],
		["空值参数保留", "<function=pwsh><parameter=command></parameter><parameter=description>x</parameter></function>", 2],
		["重复键（后者覆盖）", "<function=pwsh><parameter=command>a</parameter><parameter=command>b</parameter></function>", 1],
	];
	for (const [label, body, expectCount] of cases) {
		const calls = await recover(wrap(body));
		ck(`${label}`, calls.length === 1 && Object.keys(calls[0].args).length === expectCount, JSON.stringify(calls[0]?.args));
	}
}

// ============ 6. 参数串味 ============
console.log("\n=== 6. 参数串味（两个调用的参数不能混）===");
{
	const one = OC + '\n<function name="pwsh"><parameter name="command">cmd1</parameter></function>\n' + CC;
	const two = OC + '\n<function name="grep"><parameter name="pattern">pat2</parameter></function>\n' + CC;
	const calls = await recover(one + "\n" + two);
	ck("两个调用参数不混", calls.length === 2
		&& calls[0].name === "pwsh" && calls[0].args.command === "cmd1" && Object.keys(calls[0].args).length === 1
		&& calls[1].name === "grep" && calls[1].args.pattern === "pat2" && Object.keys(calls[1].args).length === 1,
		JSON.stringify(calls));

	// XML + JSON 混合，参数不能混
	const mixed = wrap('<function name="pwsh"><parameter name="command">xml_cmd</parameter></function>\n{"name":"grep","arguments":{"pattern":"json_pat"}}');
	const mc = await recover(mixed);
	ck("XML+JSON 参数不混", mc.length >= 1
		&& mc.every((c, i) => (c.name === "pwsh" ? c.args.command === "xml_cmd" : c.name === "grep" ? c.args.pattern === "json_pat" : false)),
		JSON.stringify(mc));
}

// ============ 7. 调用被合并 ============
console.log("\n=== 7. 调用被合并（两个调用变一个 → 少执行）===");
{
	const a = OC + '\n<function name="pwsh"><parameter name="command">A</parameter></function>\n' + CC;
	const b = OC + '\n<function name="pwsh"><parameter name="command">B</parameter></function>\n' + CC;
	const c = OC + '\n<function name="pwsh"><parameter name="command">C</parameter></function>\n' + CC;
	const calls = await recover(a + b + c);
	ck("三个调用不合并", calls.length === 3 && calls.map((x) => x.args.command).join(",") === "A,B,C", JSON.stringify(calls.map((x) => x.args?.command)));
}

// ============ 8. 高危命令的完整性 ============
console.log("\n=== 8. 高危命令必须完整执行或完全不执行 ===");
{
	const dangerous = [
		"rm -rf /tmp/specific-dir",
		"del /F /Q C:\\specific\\file.txt",
		"Remove-Item -Recurse -Force D:\\specific",
		"shutdown /s /t 0",
	];
	for (const cmd of dangerous) {
		const calls = await recover(wrap(`<function=pwsh><parameter=command>${cmd}</parameter></function>`));
		const got = calls[0]?.args?.command;
		ck(`高危命令完整无损: ${cmd.slice(0, 30)}`, calls.length === 1 && got === cmd, `期望 ${JSON.stringify(cmd)} 实际 ${JSON.stringify(got)}`);
	}
}

console.log(`\n===== 执行安全专项审查: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细（每一条都可能导致执行错误命令）---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
