// 参数值含尖括号 / 实体 / 边界字符的穷举测试
// 目标：XML 里参数值可能包含需要转义或容易误判的字符，逐一验证解析正确性。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } },
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
		.map((c) => { try { return { name: c.block.name, args: JSON.parse(c.block.arguments) }; } catch { return { name: c.block.name, args: "(invalid json)" }; } });
}

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };
const wrap = (s) => OC + "\n" + s + "\n" + CC;
const qwen = (val) => wrap("<function=pwsh><parameter=command>" + val + "</parameter></function>");
const anthropic = (val) => wrap('<function name="pwsh"><parameter name="command">' + val + "</parameter></function>");

console.log("=== 1. XML 实体解码（Qwen 风格）===");
{
	const cases = [
		["&lt; → <", "a &lt; b", "a < b"],
		["&gt; → >", "a &gt; b", "a > b"],
		["&amp; → &", "a &amp; b", "a & b"],
		["&quot; → \"", 'a &quot;b&quot;', 'a "b"'],
		["&apos; → '", "a &apos;b&apos;", "a 'b'"],
		["&#39; → '", "a &#39;b&#39;", "a 'b'"],
		["&#65; → A", "&#65;BC", "ABC"],
		["&#x41; 十六进制（不支持则原样）", "&#x41;BC", null],  // null = 只检查不崩溃
		["混合实体", "a &lt;b&gt; &amp; c", "a <b> & c"],
		["未转义的裸 <", "a < b", "a < b"],
		["未转义的裸 >", "a > b", "a > b"],
	];
	for (const [label, input, expected] of cases) {
		const calls = await recover(qwen(input));
		if (expected === null) {
			ck(`${label}（不崩溃）`, calls.length === 1, JSON.stringify(calls));
		} else {
			ck(label, calls.length === 1 && calls[0].args.command === expected, `期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(calls[0]?.args?.command)}`);
		}
	}
}

console.log("\n=== 2. XML 实体解码（Anthropic 风格）===");
{
	const cases = [
		["&lt; &gt;", "a &lt; b &gt; c", "a < b > c"],
		["&amp;", "x &amp; y", "x & y"],
	];
	for (const [label, input, expected] of cases) {
		const calls = await recover(anthropic(input));
		ck(`Anthropic ${label}`, calls.length === 1 && calls[0].args.command === expected, JSON.stringify(calls[0]?.args?.command));
	}
}

console.log("\n=== 3. 值内含类标签文本（关键：不能误截断）===");
{
	const cases = [
		["值含 </parameter> 的转义形式", "echo &lt;/parameter&gt;", "echo </parameter>"],
		["值含 &lt;function= 转义形式", "echo &lt;function=x&gt;", "echo <function=x>"],
		["值含 &lt;tool_call&gt; 转义形式", "echo &lt;tool_call&gt;", "echo <tool_call>"],
	];
	for (const [label, input, expected] of cases) {
		const calls = await recover(qwen(input));
		ck(label, calls.length === 1 && calls[0].args.command === expected, `期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(calls[0]?.args?.command)}`);
	}
}

console.log("\n=== 4. 特殊字符与编码 ===");
{
	const cases = [
		["反斜杠", "C:\\path\\file", "C:\\path\\file"],
		["双反斜杠", "a\\\\b", "a\\\\b"],
		["美元符号", "$var = 1", "$var = 1"],
		["反引号", "echo `date`", "echo `date`"],
		["单引号", "echo 'hi'", "echo 'hi'"],
		["双引号（裸）", 'echo "hi"', 'echo "hi"'],
		["中文", "echo 中文测试", "echo 中文测试"],
		["emoji", "echo 🎯🚀", "echo 🎯🚀"],
		["制表符", "a\tb", "a\tb"],
		["管道符号", "a | b", "a | b"],
		["分号", "a; b", "a; b"],
		["百分号", "%PATH%", "%PATH%"],
		["波浪号", "~/dir", "~/dir"],
		["花括号", "{a,b}", "{a,b}"],
	];
	for (const [label, input, expected] of cases) {
		const calls = await recover(qwen(input));
		ck(label, calls.length === 1 && calls[0].args.command === expected, `期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(calls[0]?.args?.command)}`);
	}
}

console.log("\n=== 5. JSON 形态的实体处理（不应解码，JSON 有自己的转义）===");
{
	// JSON 里的 &lt; 应该原样保留，因为 JSON 不用 XML 实体
	const json = JSON.stringify({ name: "pwsh", arguments: { command: "a &lt; b" } });
	const calls = await recover(wrap(json));
	ck("JSON 里的 &lt; 原样保留", calls.length === 1 && calls[0].args.command === "a &lt; b", JSON.stringify(calls[0]?.args?.command));
}

console.log("\n=== 6. 值内包含换行/多行 ===");
{
	const cases = [
		["单行", "echo a", "echo a"],
		["双行", "echo a\necho b", "echo a\necho b"],
		["三行", "line1\nline2\nline3", "line1\nline2\nline3"],
		["含空行", "a\n\nb", "a\n\nb"],
	];
	for (const [label, input, expected] of cases) {
		const calls = await recover(qwen(input));
		ck(`多行：${label}`, calls.length === 1 && calls[0].args.command === expected, JSON.stringify(calls[0]?.args?.command));
	}
}

console.log("\n=== 7. 首尾空白处理（trimEdgeNewlines 的边界）===");
{
	// 只应去掉首尾各一个换行，保留其他空白
	const cases = [
		[`\nvalue\n`, "value", "首尾单个换行被去掉"],
		[`\n\nvalue\n\n`, null, "首尾多个换行（只去一个）"],
		[`  value  `, "  value  ", "空格不被去掉"],
	];
	for (const [input, expected, label] of cases) {
		const calls = await recover(qwen(input));
		const got = calls[0]?.args?.command;
		if (expected === null) {
			ck(`${label}（记录实际值）`, calls.length === 1, JSON.stringify(got));
			console.log(`      实际值: ${JSON.stringify(got)}`);
		} else {
			ck(label, got === expected, `期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(got)}`);
		}
	}
}

console.log("\n=== 8. 极端：值内包含完整标记（应保留或安全截断，不能崩溃）===");
{
	const cases = [
		["值内裸 </function>", "<function=pwsh><parameter=command>echo </function></parameter></function>"],
		["值内裸 </parameter>", "<function=pwsh><parameter=command>echo </parameter></parameter></function>"],
		["值内裸 <tool_call>", "<function=pwsh><parameter=command>echo <tool_call></parameter></function>"],
	];
	for (const [label, body] of cases) {
		let threw = null;
		let calls = [];
		try { calls = await recover(wrap(body)); } catch (e) { threw = e.message; }
		ck(`${label} → 不崩溃`, threw === null, threw ?? "");
		console.log(`      恢复 ${calls.length} 个，参数: ${JSON.stringify(calls[0]?.args?.command)}`);
	}
}

// ============ 9. 截断检测：值内裸闭合标签必须拒绝恢复（安全）============
console.log("\n=== 9. 值内裸闭合标签 → 必须拒绝恢复（防执行半截命令）===");
{
	// 风险场景：`<parameter=command>rm -rf /tmp/x</parameter></parameter>`
	// 惰性匹配会停在第一个 </parameter>，得到 "rm -rf /tmp/x"；若照常执行看似无害，
	// 但真实截断样本可能是 `rm -rf /tmp/x` 被截成 `rm -rf /tmp` —— 危险。
	// 判据：闭合标签后紧跟另一个**闭合类**标签 ⇒ XML 损坏 ⇒ 拒绝恢复。
	const risky = [
		["值内裸 </parameter>", "<function=pwsh><parameter=command>echo </parameter></parameter></function>"],
		["值内裸 </function>", "<function=pwsh><parameter=command>echo </function></parameter></function>"],
		["值内裸 </tool_call>", "<function=pwsh><parameter=command>echo </tool_call></parameter></function>"],
	];
	for (const [label, body] of risky) {
		const calls = await recover(wrap(body));
		ck(`${label} → 拒绝恢复`, calls.length === 0, JSON.stringify(calls));
	}

	// 对照：正常多参数不能被误伤
	const safe = [
		["Qwen 双参数紧邻", "<function=pwsh><parameter=command>a</parameter><parameter=description>b</parameter></function>", (a) => a.command === "a" && a.description === "b"],
		["参数间有换行", "<function=pwsh><parameter=command>a</parameter>\n<parameter=description>b</parameter></function>", (a) => a.command === "a"],
		["参数间大段空白", "<function=pwsh><parameter=command>a</parameter>\n\n  \n<parameter=description>b</parameter></function>", (a) => a.command === "a"],
		["值以 < 开头", "<function=pwsh><parameter=command><x>y</x></parameter></function>", (a) => a.command === "<x>y</x>"],
	];
	for (const [label, body, pred] of safe) {
		const calls = await recover(wrap(body));
		ck(`${label} → 正常恢复（不误伤）`, calls.length === 1 && pred(calls[0].args), JSON.stringify(calls));
	}
}

console.log(`\n===== 值/实体边界: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
