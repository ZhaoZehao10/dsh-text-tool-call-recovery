// 正则等价类划分测试（equivalence class partitioning）
// 目的：把 extractCalls 能识别的「标记形态空间」按维度穷举，找出
//   (a) 应该识别但没识别的形态（漏识别）
//   (b) 不该识别却识别了的形态（误识别）
// 维度：外层包装 × 函数标记风格 × 参数风格 × 引号 × 空白 × 大小写
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const plugin = await import(new URL("../../lib/index.js", import.meta.url).href);

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } },
	{ name: "read", parameters: { type: "object", properties: { file_path: { type: "string" } } } },
];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };

const OC = "<" + "tool_call>", CC = "</" + "tool_call>";

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
	const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call")
		.map((c) => { try { return { name: c.block.name, args: JSON.parse(c.block.arguments) }; } catch { return { name: c.block.name, args: "(invalid json)" }; } });
	const fin = out.find((c) => c.type === "finish");
	return { calls, finish: fin?.reason?.kind, errorCode: fin?.reason?.failure?.code };
}

let pass = 0, fail = 0;
const failures = [];
function ck(label, cond, detail) {
	if (cond) pass++;
	else { fail++; failures.push(`${label}${detail ? " :: " + detail : ""}`); }
}

// ============ 维度 1：外层包装 ============
console.log("=== 1. 外层包装变体 ===");
{
	const inner = {
		qwenFn: "<" + "function=pwsh><" + "parameter=command>\necho A\n</" + "parameter></" + "function>",
		attrFn: "<" + "function name=\"pwsh\"><" + "parameter name=\"command\">\necho B\n</" + "parameter></" + "function>",
		invoke: "<" + "invoke name=\"pwsh\"><" + "parameter name=\"command\">\necho C\n</" + "parameter></" + "invoke>",
		antmlFn: "<" + "antml:function name=\"pwsh\"><" + "parameter name=\"command\">\necho D\n</" + "parameter></" + "antml:function>",
		antmlInvoke: "<" + "antml:invoke name=\"pwsh\"><" + "parameter name=\"command\">\necho E\n</" + "parameter></" + "antml:invoke>",
	};
	// 有 tool_call 包裹
	for (const [k, v] of Object.entries(inner)) {
		const { calls } = await recover(OC + "\n" + v + "\n" + CC);
		ck(`[包裹] ${k} 被识别`, calls.length === 1 && calls[0].name === "pwsh", JSON.stringify(calls));
	}
	// 无 tool_call 包裹（裸露）
	for (const [k, v] of Object.entries(inner)) {
		const { calls } = await recover(v);
		if (k === "qwenFn") {
			// Qwen 风格 function=pwsh 裸露：当前实现不支持（只在 tool_call 内查找）
			console.log(`  [观察] 裸露 ${k}: 识别 ${calls.length} 个`);
		} else {
			ck(`[裸露] ${k} 被识别`, calls.length === 1, JSON.stringify(calls));
		}
	}
}

// ============ 维度 2：属性引号变体 ============
console.log("\n=== 2. 属性引号变体（function/invoke/parameter 的 name）===");
{
	const variants = [
		['双引号', '<function name="pwsh"><parameter name="command">\necho Q\n</parameter></function>'],
		["单引号", "<function name='pwsh'><parameter name='command'>\necho Q\n</parameter></function>"],
		['无引号', "<function name=pwsh><parameter name=command>\necho Q\n</parameter></function>"],
		['多余空格', '<function  name = "pwsh" ><parameter  name = "command" >\necho Q\n</parameter></function>'],
	];
	for (const [label, markup] of variants) {
		const { calls } = await recover(markup);
		const ok = calls.length === 1 && calls[0].name === "pwsh" && calls[0].args.command === "echo Q";
		if (ok) pass++;
		else { fail++; failures.push(`引号变体「${label}」未被正确识别 :: ${JSON.stringify(calls)}`); }
	}
}

// ============ 维度 3：空白与换行 ============
console.log("\n=== 3. 空白与换行变体 ===");
{
	const variants = [
		["无换行", OC + "<function=pwsh><parameter=command>echo N</parameter></function>" + CC],
		["单行", OC + "\n<function=pwsh>\n<parameter=command>echo N</parameter>\n</function>\n" + CC],
		// 多空行：值首尾会保留多余换行（trimEdgeNewlines 只去一个换行）——按 normalize 后比对
		["多空行", OC + "\n\n\n<function=pwsh>\n\n<parameter=command>\n\n\necho N\n\n</parameter>\n\n</function>\n\n" + CC, "normalize"],
		["CRLF", OC + "\r\n<function=pwsh>\r\n<parameter=command>\r\necho N\r\n</parameter>\r\n</function>\r\n" + CC],
		["标签前空格", "  " + OC + "  \n  <function=pwsh>  \n  <parameter=command>  \necho N\n  </parameter>  \n</function>  \n  " + CC, "normalize"],
	];
	for (const [label, markup, mode] of variants) {
		const { calls } = await recover(markup);
		const got = calls[0]?.args?.command;
		// normalize 模式：只要求“去掉首尾空白后”等于期望（值内的多余空行是已知保留行为）
		const ok = calls.length === 1 && (mode === "normalize" ? (typeof got === "string" && got.trim() === "echo N") : got === "echo N");
		if (ok) pass++;
		else { fail++; failures.push(`空白变体「${label}」未被正确识别 :: ${JSON.stringify(calls)}`); }
	}
}

// ============ 维度 4：大小写敏感性 ============
console.log("\n=== 4. 大小写变体（预期：XML 标签不区分大小写会被识别？实际看实现）===");
{
	for (const [label, markup] of [
		["大写 TOOL_CALL", "<" + "TOOL_CALL><function=pwsh><parameter=command>echo U</parameter></function></" + "TOOL_CALL>"],
		["大写 FUNCTION", OC + "<FUNCTION=pwsh><parameter=command>echo U</parameter></FUNCTION>" + CC],
		["混合", OC + "<Function=pwsh><Parameter=command>echo U</Parameter></Function>" + CC],
	]) {
		const { calls } = await recover(markup);
		console.log(`  [观察] ${label}: 识别 ${calls.length} 个${calls.length ? " -> " + JSON.stringify(calls) : ""}`);
	}
}

// ============ 维度 5：参数值中的特殊内容 ============
// 注意：这里统一用「有 <tool_call> 外层包裹」的 Qwen 形态——实现只在该包裹内
// 解析 Qwen 风格（裸 Qwen 形态是已知不支持的，单独在维度 1 里作为观察项记录）。
console.log("\n=== 5. 参数值特殊内容 ===");
{
	const wrap = (body) => OC + "\n" + body + "\n" + CC;
	const cases = [
		["值含闭合标签文本（转义后）", wrap("<function=pwsh><parameter=command>echo &lt;/parameter&gt;</parameter></function>"), "echo </parameter>"],
		["值含 XML 实体", wrap("<function=pwsh><parameter=command>a &amp; b &lt;c&gt; &quot;d&quot;</parameter></function>"), 'a & b <c> "d"'],
		["值含反斜杠", wrap("<function=pwsh><parameter=command>C:\\path\\file</parameter></function>"), "C:\\path\\file"],
		["值含美元符号", wrap("<function=pwsh><parameter=command>$var = 1</parameter></function>"), "$var = 1"],
		["值含中文", wrap("<function=pwsh><parameter=command>echo 中文测试</parameter></function>"), "echo 中文测试"],
		["值含 emoji", wrap("<function=pwsh><parameter=command>echo 🎯</parameter></function>"), "echo 🎯"],
	];
	for (const [label, markup, expected] of cases) {
		const { calls } = await recover(markup);
		const ok = calls.length === 1 && calls[0].args.command === expected;
		if (ok) pass++;
		else { fail++; failures.push(`值内容「${label}」:: 期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(calls[0]?.args?.command)}`); }
	}
}

// ============ 维度 6：多调用组合 ============
console.log("\n=== 6. 多调用组合 ===");
{
	const mk = (v) => OC + "\n<function=pwsh>\n<parameter=command>\n" + v + "\n</parameter>\n</function>\n" + CC;
	for (const [label, markup, expect] of [
		["2 个调用（换行分隔）", mk("echo 1") + "\n" + mk("echo 2"), ["echo 1", "echo 2"]],
		["2 个调用（紧邻无分隔）", mk("echo 1") + mk("echo 2"), ["echo 1", "echo 2"]],
		["3 个调用", mk("a") + "\n" + mk("b") + "\n" + mk("c"), ["a", "b", "c"]],
	]) {
		const { calls } = await recover(markup);
		const got = calls.map((c) => c.args.command);
		const ok = JSON.stringify(got) === JSON.stringify(expect);
		if (ok) pass++;
		else { fail++; failures.push(`多调用「${label}」:: 期望 ${JSON.stringify(expect)} 实际 ${JSON.stringify(got)}`); }
	}
}

// ============ 维度 7：不该识别的形态（误识别防护）============
console.log("\n=== 7. 误识别防护（这些都不该被当成调用）===");
{
	const negatives = [
		["纯文本提及", "文档里提到 <function=pwsh> 这种写法。"],
		["代码块内", "```xml\n" + OC + "\n<function=pwsh>\n<parameter=command>\nrm -rf /\n</parameter>\n</function>\n" + CC + "\n```"],
		["行内代码内", "格式是 `<function=pwsh>` 这样。"],
		["未声明工具", OC + "\n<function=unknown_tool>\n<parameter=x>1</parameter>\n</function>\n" + CC],
		["只有开标签", "<function=pwsh>"],
		["只有参数无函数", OC + "\n<parameter=command>x</parameter>\n" + CC],
	];
	for (const [label, markup] of negatives) {
		const { calls } = await recover(markup);
		const ok = calls.length === 0;
		if (ok) pass++;
		else { fail++; failures.push(`误识别「${label}」:: 不该恢复但恢复了 ${JSON.stringify(calls)}`); }
	}
}

// ============ 维度 8：JSON 形态变体 ============
console.log("\n=== 8. JSON 形态变体 ===");
{
	const cases = [
		["标准", '{"name":"pwsh","arguments":{"command":"echo J"}}', "echo J"],
		["arguments 是字符串", '{"name":"pwsh","arguments":"{\\"command\\":\\"echo J\\"}"}', "echo J"],
		["用 input 字段", '{"name":"pwsh","input":{"command":"echo J"}}', "echo J"],
		["用 parameters 字段", '{"name":"pwsh","parameters":{"command":"echo J"}}', "echo J"],
	];
	for (const [label, json, expected] of cases) {
		const { calls } = await recover(OC + "\n" + json + "\n" + CC);
		const ok = calls.length === 1 && calls[0].args.command === expected;
		if (ok) pass++;
		else { fail++; failures.push(`JSON「${label}」:: 实际 ${JSON.stringify(calls)}`); }
	}
}

console.log(`\n===== 等价类划分测试: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
