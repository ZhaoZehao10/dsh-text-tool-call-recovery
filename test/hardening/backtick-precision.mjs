// 反引号误判修复的回归测试
//
// 缺陷：`hasCodeFence` 原先把「整段文本有无行内代码」作为判据，导致
// 参数值内部的合法反引号（Python 代码、Markdown 语法、`word`）被误判为
// 展示意图，**整条工具调用被丢弃**。
// 真实证据：真实日志中有 4 条正常调用因此未被恢复（grep/write/pwsh），
//          修复后全部恢复（反向挖掘：已恢复 64 → 69 条）。
//
// 修复：改为「按标记位置判定」——只有工具调用标记**本身**落在展示区
//      （代码围栏内 / 行内代码内）才拒绝恢复。
//
// 本测试同时守护两侧：
//   (a) 参数含反引号 → 必须恢复
//   (b) 标记在展示区内 → 必须不恢复（安全边界，不得为修 (a) 而破坏）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } },
	{ name: "write", parameters: { type: "object", properties: { content: { type: "string" } } } },
	{ name: "grep", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" } } } },
];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

let pass = 0, fail = 0;
const ck = (l, c, d) => { if (c) { pass++; console.log(`  PASS ${l}`); } else { fail++; console.log(`  FAIL ${l}${d ? " :: " + d : ""}`); } };

async function run(text, blockType = "reasoning") {
	plugin.resetStreaks?.();
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType };
		yield { type: blockType === "text" ? "text-delta" : "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: blockType, text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = [];
	for await (const c of listener(OPTS, () => src)) out.push(c);
	return out;
}
const callsOf = (out) => out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call")
	.map((c) => { try { return { name: c.block.name, args: JSON.parse(c.block.arguments) }; } catch { return { name: c.block.name, args: null }; } });

// ============ (a) 参数含反引号：必须恢复 ============
console.log("\n=== A. 参数值含合法反引号 → 必须恢复 ===\n");

{
	const cases = [
		["markdown 行内代码（真实 #3 形态）",
			OC + "\n<function=grep>\n<parameter=pattern>\n`some_pattern`\n</parameter>\n<parameter=path>\nD:\\X\\dir\n</parameter>\n</function>\n" + CC,
			"grep", (a) => a.pattern === "`some_pattern`"],
		["Python 代码里的反引号（真实 #4 形态）",
			OC + "\n<function=write>\n<parameter=content>\nprint(`_unpack`, `total_files`)\n</parameter>\n</function>\n" + CC,
			"write", (a) => a.content === "print(`_unpack`, `total_files`)"],
		["shell 命令里的反引号（命令替换）",
			OC + "\n<function=pwsh>\n<parameter=command>\necho `date`\n</parameter>\n</function>\n" + CC,
			"pwsh", (a) => a.command === "echo `date`"],
		["Markdown 文档内容里的反引号",
			OC + "\n<function=write>\n<parameter=content>\n见 `README.md` 的说明\n</parameter>\n</function>\n" + CC,
			"write", (a) => a.content === "见 `README.md` 的说明"],
		["双反引号包裹",
			OC + "\n<function=pwsh>\n<parameter=command>\nuse ``code`` here\n</parameter>\n</function>\n" + CC,
			"pwsh", (a) => a.command === "use ``code`` here"],
		["参数里含成对反引号 + 多参数",
			OC + "\n<function=grep>\n<parameter=include>\n*.py\n</parameter>\n<parameter=pattern>\n`some_pattern`|`other`\n</parameter>\n</function>\n" + CC,
			"grep", (a) => a.pattern === "`some_pattern`|`other`" && a.include === "*.py"],
	];
	for (const [label, text, expectName, pred] of cases) {
		const out = await run(text);
		const c = callsOf(out);
		ck(`${label} → 恢复`, c.length === 1 && c[0].name === expectName, JSON.stringify(c));
		ck(`${label} → 参数正确`, c.length === 1 && pred(c[0].args), JSON.stringify(c[0]?.args));
	}
}

// ============ (b) 标记在展示区：必须不恢复（安全边界）============
console.log("\n=== B. 标记在展示区 → 必须不恢复（安全边界）===\n");

{
	// B1. 代码围栏内展示完整调用（最危险：示例中的危险命令绝不能执行）
	const fenced = "```xml\n" + OC + "\n<function=pwsh>\n<parameter=command>\nrm -rf /\n</parameter>\n</function>\n" + CC + "\n```";
	{
		const out = await run(fenced);
		ck("围栏内展示危险命令 → 不恢复", callsOf(out).length === 0, JSON.stringify(callsOf(out)));
	}

	// B2. 行内代码里展示标记
	{
		const inline = "格式是 `" + OC + "<function=pwsh><parameter=command>x</parameter></function>" + CC + "` 这样。";
		const out = await run(inline);
		ck("行内代码里展示完整调用 → 不恢复", callsOf(out).length === 0, JSON.stringify(callsOf(out)));
	}

	// B3. 围栏结束后紧跟真实调用 → 必须恢复（围栏已闭合，不在展示区）
	{
		const mixed = "```xml\n" + OC + "\n<function=pwsh>\n<parameter=command>\nrm -rf /\n</parameter>\n</function>\n" + CC + "\n```\n\n现在执行：\n" + OC + "\n<function=pwsh>\n<parameter=command>\necho safe\n</parameter>\n</function>\n" + CC;
		const out = await run(mixed);
		const c = callsOf(out);
		ck("围栏后的真实调用 → 恢复（且只恢复真实那个）", c.length === 1 && c[0].args.command === "echo safe", JSON.stringify(c));
	}

	// B4. 未闭合围栏（截断）→ 不恢复（保守）
	{
		const unclosed = "```xml\n" + OC + "\n<function=pwsh>\n<parameter=command>\necho x\n</parameter>\n</function>\n" + CC;
		const out = await run(unclosed);
		const c = callsOf(out);
		ck("未闭合围栏 → 不恢复（保守）", c.length === 0, JSON.stringify(c));
	}

	// B5. 行内代码包裹「单个词」+ 真实调用（不应因那个词而丢弃调用）
	{
		const mixed2 = "说明：用 `word` 表示占位。\n" + OC + "\n<function=pwsh>\n<parameter=command>\necho real\n</parameter>\n</function>\n" + CC;
		const out = await run(mixed2);
		const c = callsOf(out);
		ck("正文有行内代码但调用在正文外 → 恢复", c.length === 1 && c[0].args.command === "echo real", JSON.stringify(c));
	}
}

// ============ (c) 行内代码包裹单行调用：必须不恢复（安全边界，M24 守护）============
console.log("\n=== C. 行内代码包裹调用 → 必须不恢复 ===\n");
{
	// C1. 单行内代码包住完整调用（最典型的「格式说明」形态）
	const inlineFull = "格式是 `" + OC + "<function=pwsh><parameter=command>rm -rf /</parameter></function>" + CC + "` 这样。";
	{
		const out = await run(inlineFull);
		ck("单行内代码包住完整调用 → 不恢复", callsOf(out).length === 0, JSON.stringify(callsOf(out)));
	}

	// C2. 双反引号包裹
	const inlineDouble = "用 ``" + OC + "<function=pwsh><parameter=command>echo x</parameter></function>" + CC + "`` 表示。";
	{
		const out = await run(inlineDouble);
		ck("双反引号包住完整调用 → 不恢复", callsOf(out).length === 0, JSON.stringify(callsOf(out)));
	}

	// C3. 跨行反引号包住多行调用（安全优先：模型会这样包裹多行示例）
	const multilineInline = "先看 `" + OC + "\n<function=pwsh>\n<parameter=command>\nrm -rf /\n</parameter>\n</function>\n" + CC + "` 这段。";
	{
		const out = await run(multilineInline);
		ck("跨行反引号包住多行调用 → 不恢复（防执行示例）", callsOf(out).length === 0, JSON.stringify(callsOf(out)));
	}

	// C4. 行内代码只包住标记开头，真实调用在其后
	const mixed = "`" + OC + "` 是标记。然后真实调用：\n" + OC + "\n<function=pwsh>\n<parameter=command>\necho x\n</parameter>\n</function>\n" + CC;
	{
		const out = await run(mixed);
		const c = callsOf(out);
		ck("行内代码只包标记名、真实调用在后 → 恢复真实调用", c.length === 1 && c[0].args.command === "echo x", JSON.stringify(c));
	}
}

console.log(`\n===== 反引号误判修复: ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
