// 截断/未闭合形态的安全性测试（固化「不恢复不完整调用」这一安全边界）
// 证据来源：真实日志 t86s11 出现过「Anthropic 风格 XML 调用标记断在半途」
//          以及本会话中 4 条截断样本。
// 安全理由：外层闭合标签缺失 ⇒ 输出被截断 ⇒ 内层参数也很可能不完整。
//          盲目恢复可能执行**被截断的命令**（如 `rm -rf /tmp/x` 截成 `rm -rf /tmp`），
//          危害大于「不执行」。因此这是**有意的保守设计**，不是缺陷。
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
const ck = (l, c, d) => { if (c) { pass++; console.log(`  PASS ${l}`); } else { fail++; console.log(`  FAIL ${l}${d ? " :: " + d : ""}`); } };

async function run(text) {
	plugin.resetStreaks?.();
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = [];
	for await (const c of listener(OPTS, () => src)) out.push(c);
	return out;
}
const calls = (out) => out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call")
	.map((c) => { try { return JSON.parse(c.block.arguments); } catch { return "(bad)"; } });

console.log("=== 截断形态：不恢复不完整调用（安全边界）===\n");

// 1. 截断的 Anthropic 形态（真实 t86s11）
{
	const t = '<parameter name="command">\necho hello\n<parameter name="timeout">\n30\n</tool';
	const out = await run(t);
	ck("断在 </tool 处：不恢复", calls(out).length === 0, JSON.stringify(calls(out)));
	ck("断在 </tool 处：不崩溃", out.length > 0);
}

// 2. 外层 </tool_call> 缺失，内层完整 —— 仍不恢复（保守）
{
	const t = OC + "\n<function=pwsh>\n<parameter=command>\necho hi\n</parameter>\n</function>";
	const out = await run(t);
	ck("缺外层 </tool_call>（内层完整）：仍不恢复（保守设计）", calls(out).length === 0, JSON.stringify(calls(out)));
}

// 3. 缺 </function>
{
	const t = OC + "\n<function=pwsh>\n<parameter=command>\necho hi\n</parameter>";
	const out = await run(t);
	ck("缺 </function>：不恢复", calls(out).length === 0, JSON.stringify(calls(out)));
}

// 4. 断在命令中间（危险场景：恢复会执行半截命令）
{
	const t = OC + "\n<function=pwsh>\n<parameter=command>\nrm -rf /tmp/x";
	const out = await run(t);
	ck("断在命令中间：不恢复（防止执行半截危险命令）", calls(out).length === 0, JSON.stringify(calls(out)));
}

// 5. 两个调用都缺外层
{
	const t = OC + "\n<function=pwsh>\n<parameter=command>\na\n</parameter>\n</function>\n" + OC + "\n<function=pwsh>\n<parameter=command>\nb\n</parameter>\n</function>";
	const out = await run(t);
	ck("多个缺外层调用：均不恢复", calls(out).length === 0, JSON.stringify(calls(out)));
}

// 6. 裸 parameter（无 function 包裹，无法确定工具名）
{
	const t = '<parameter name="command">\necho bare\n</parameter>';
	const out = await run(t);
	ck("裸 parameter：不恢复（无法确定工具名）", calls(out).length === 0, JSON.stringify(calls(out)));
}

// 7. 真实 #10 形态：断在半途、含 Windows 路径与反斜杠
{
	const t = '<parameter name="command">$wd="D:\\workspace\\X"\n$py="C:\\Python\\python.exe"\ncd $wd\n& $py -c "import ast';
	const out = await run(t);
	ck("断在半途 Windows 路径：不恢复且不崩溃", calls(out).length === 0 && out.length > 0, JSON.stringify(calls(out)));
}

// 8. 完整调用 + 后续截断调用：只恢复完整的那个
{
	const full = OC + "\n<function=pwsh>\n<parameter=command>\necho first\n</parameter>\n</function>\n" + CC;
	const trunc = "\n" + OC + "\n<function=pwsh>\n<parameter=command>\necho sec";
	const out = await run(full + trunc);
	const c = calls(out);
	ck("完整调用恢复、截断的不恢复", c.length === 1 && c[0].command === "echo first", JSON.stringify(c));
}

// 9. 行内代码中讨论标记（真实样本形态）
{
	const t = '日志显示文本末尾跟了一段 `<tool_call>` 标记的 pwsh 调用，但 `finish=stop`。';
	const out = await run(t);
	ck("行内代码讨论标记：不恢复", calls(out).length === 0, JSON.stringify(calls(out)));
}

// 10. 代码块中展示标记（安全：避免执行示例）
{
	const t = "```xml\n" + OC + "\n<function=pwsh>\n<parameter=command>\nrm -rf /\n</parameter>\n</function>\n" + CC + "\n```";
	const out = await run(t);
	ck("代码块内示例：不恢复（防止执行示例中的危险命令）", calls(out).length === 0, JSON.stringify(calls(out)));
}

console.log(`\n===== 截断/安全边界: ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
