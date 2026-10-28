// 用复刻自真实失败样本的数据验证插件（所有标记均由常量拼接，避免字面标记干扰）
// 注意：样本复刻自两次生产故障（StepFun step-5-preview 与网关路由 flash-max），
// 其中的路径、目录名、文件名、技术标识符均已替换为占位符；只保留“形态”。
//
// 依赖说明（可移植）：
// - 被测插件：同仓库 lib/index.js，按相对路径导入。
// - 真实 BlockAssembler：来自 @deepseek-ai/dsh-llm。默认从本仓库 node_modules
//   解析；若尚未安装依赖，可用 DSH_LLM_SRC 环境变量指向任意一份 dsh-llm 源码目录。
import * as plugin from "../lib/index.js";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const BlockAssembler = (await (async () => {
	const candidates = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(process.cwd(), "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
		path.join(process.cwd(), "..", "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js")
	].filter(Boolean);
	for (const c of candidates) {
		if (fs.existsSync(c)) return import(pathToFileURL(c).href);
	}
	console.error("找不到 @deepseek-ai/dsh-llm 的 BlockAssembler。请设置 DSH_LLM_SRC 指向 dsh-llm 源码目录，");
	console.error("或在本仓库执行 npm install @deepseek-ai/dsh-llm（版本需与你的 DSH 匹配）。");
	process.exit(1);
})()).BlockAssembler;

let listener;
plugin.apply({ on: (event, handler) => { if (event === "llm/stream") listener = handler; } });

// ---------------------------------------------------------------------------
// 断言计数（缺陷 50）
//
// 早期版本这里**只有 console.log，没有任何断言** —— 插件回归时该文件仍会
// 退出 0，等于一个永远通过的"测试"。现在每个样本都有真实断言。
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, detail) {
	if (cond) {
		pass += 1;
	} else {
		fail += 1;
		failures.push(label + (detail ? " :: " + detail : ""));
	}
}

const TOOLS = [
	{ name: "pwsh", description: "Run PowerShell", parameters: { type: "object", properties: { command: { type: "string" }, description: { type: "string" } }, required: ["command"] } },
	{ name: "grep", description: "Search", parameters: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, include: { type: "string" } } } }
];
const OPTIONS = { provider: "magpie", model: "group/auto-deepseek-v4-1-flash", messages: [], tools: TOOLS };

// 所有标记均由常量拼接
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const OF = "<" + "function=pwsh>";
const CF = "</" + "function>";
const OP = "<" + "parameter=command>";
const CP = "</" + "parameter>";
const OPD = "<" + "parameter=description>";
const OPI = "<" + "parameter=include>";
const OPP = "<" + "parameter=path>";
const OPAT = "<" + "parameter=pattern>";
const OPN = (k) => "<" + "parameter name=" + JSON.stringify(k) + ">";

// 样本 A：Anthropic 风格 name 属性 + 截断的 tool_call 闭合（复刻自网关 flash-max 案例）
const SAMPLE_A = [
	OPN("command") + "$wd=\"<workspace>\"",
	"$py=\"<python.exe>\"",
	"& $py -c \"import ast,pathlib; print('OK')\" 2>&1 | Select-Object -First 3",
	CP,
	OPN("description") + "Verify the parameter description fixes",
	CP,
	CC.slice(0, -1) // 复刻真实截断：不完整的闭合标签
].join("\n");

// 样本 B：Qwen 风格完整调用（复刻自 step-5-preview 案例）
const SAMPLE_B = [
	"The deliverables folder is empty. Let me check if it exists at all.",
	"",
	"Let me be efficient. 目录是空的？查证，同时深入看知识库：" + OC,
	OF,
	OP,
	"$d=\"<workspace>\\deliverables\"",
	"if (Test-Path $d) { \"  OK exists\" } else { \"  MISSING\" }",
	CP,
	OPD,
	"Check the deliverables directory in detail",
	CP,
	CF,
	CC
].join("\n");

// 样本 C：Qwen 风格 + grep 工具（复刻自 step-5-preview 案例）
const SAMPLE_C = [
	"先看模块内部怎么用：" + OC,
	"<" + "function=grep>",
	OPI,
	"*.py",
	CP,
	OPP,
	"<workspace>/src/models/module.py",
	CP,
	OPAT,
	"parameter_name",
	CP,
	"</" + "function>",
	CC
].join("\n");

async function run(label, text, blockType, provider) {
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType };
		yield { type: blockType === "text" ? "text-delta" : "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: blockType, text } };
		yield { type: "usage", usage: { inputTokens: 748392, outputTokens: 303, totalTokens: 748695 } };
		yield { type: "finish", reason: { kind: "stop" }, replayState: { response: { kind: "pi-ai", version: 2, api: "openai-completions", provider, model: "group/auto-deepseek-v4-1-flash", stopReason: "stop" }, blocks: [{ type: blockType === "text" ? "text" : "reasoning" }] } };
	})();
	const chunks = [];
	for await (const c of listener(OPTIONS, () => src)) chunks.push(c);
	const asm = new BlockAssembler();
	for (const c of chunks) asm.push(c);
	const { blocks } = asm.assembled();
	const finish = chunks.find((c) => c.type === "finish");
	console.log("\n=== " + label + " ===");
	console.log("  块: " + blocks.map((b) => b.type).join(", "));
	const calls = blocks.filter((b) => b.type === "tool-call");
	for (const c of calls) {
		const args = JSON.parse(c.arguments);
		console.log("  恢复的调用: " + c.name);
		console.log("    参数键: " + Object.keys(args).join(", "));
		for (const [k, v] of Object.entries(args)) {
			console.log("      " + k + ": " + JSON.stringify(String(v).slice(0, 60)));
		}
	}
	console.log("  finish: " + JSON.stringify(finish?.reason));

	// **真实断言**（缺陷 50）：把「应该是什么」写死，
	// 插件行为一旦变化就会失败，而不是永远打印完就退出 0。
	return { blocks, calls, finish, asm };
}

// ---------------------------------------------------------------------------
// 样本 A：Anthropic 风格 + 截断闭合
//
// **期望：不恢复调用**。这是安全网的设计意图 —— 截断的标记不可执行，
// 应当走 EMPTY_RESPONSE 或原样放行，而不是执行半截命令。
// ---------------------------------------------------------------------------
{
	const r = await run("样本 A：Anthropic 风格 name 属性 + 截断闭合", SAMPLE_A, "text", "magpie");
	check("A 截断样本不恢复调用（安全）", r.calls.length === 0,
		"恢复了 " + r.calls.length + " 个");
	check("A 块类型正确（无 tool-call）",
		!r.blocks.some((b) => b.type === "tool-call"),
		r.blocks.map((b) => b.type).join(","));
	check("A finish 仍然是 stop（未改写成 tool-calls）",
		r.finish?.reason?.kind === "stop",
		String(r.finish?.reason?.kind));
}

// ---------------------------------------------------------------------------
// 样本 B：Qwen 风格完整调用
//
// **期望：恢复 1 个调用**，工具名 pwsh，两个参数齐全且内容正确。
// ---------------------------------------------------------------------------
{
	const r = await run("样本 B：Qwen 风格完整", SAMPLE_B, "reasoning", "step-plan-152");
	check("B 恰好恢复 1 个调用", r.calls.length === 1, String(r.calls.length));
	if (r.calls.length === 1) {
		const c = r.calls[0];
		check("B 工具名是 pwsh", c.name === "pwsh", String(c.name));
		const args = JSON.parse(c.arguments);
		check("B 恢复出 command 参数", typeof args.command === "string" && args.command.length > 0,
			JSON.stringify(args.command));
		check("B command 含 deliverables 路径",
			typeof args.command === "string" && args.command.includes("deliverables"),
			JSON.stringify(args.command));
		check("B 恢复出 description 参数",
			typeof args.description === "string" && args.description.includes("deliverables"),
			JSON.stringify(args.description));
		check("B command 不含残留标记",
			typeof args.command === "string" && !args.command.includes("<parameter") && !args.command.includes("</"),
			JSON.stringify(args.command));
	}
	check("B finish 被改写为 tool-calls",
		r.finish?.reason?.kind === "tool-calls",
		String(r.finish?.reason?.kind));
}

// ---------------------------------------------------------------------------
// 样本 C：Qwen 风格 + grep 工具
//
// **期望：恢复 1 个调用**，工具名 grep，参数是 path/pattern/include
// （不是 command/description —— 早期打印里显示空值是个显示 bug，这里验证真相）。
// ---------------------------------------------------------------------------
{
	const r = await run("样本 C：Qwen 风格 + grep", SAMPLE_C, "reasoning", "step-plan-152");
	check("C 恰好恢复 1 个调用", r.calls.length === 1, String(r.calls.length));
	if (r.calls.length === 1) {
		const c = r.calls[0];
		check("C 工具名是 grep", c.name === "grep", String(c.name));
		const args = JSON.parse(c.arguments);
		check("C 恢复出 include 参数", args.include === "*.py", JSON.stringify(args.include));
		check("C 恢复出 path 参数",
			typeof args.path === "string" && args.path.includes("module.py"),
			JSON.stringify(args.path));
		check("C 恢复出 pattern 参数", args.pattern === "parameter_name", JSON.stringify(args.pattern));
		check("C 不含多余参数", Object.keys(args).length === 3, Object.keys(args).join(","));
	}
	check("C finish 被改写为 tool-calls",
		r.finish?.reason?.kind === "tool-calls",
		String(r.finish?.reason?.kind));
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log("\n===== 复刻样本: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log("  ❌ " + f);
}
process.exit(fail === 0 ? 0 : 1);
