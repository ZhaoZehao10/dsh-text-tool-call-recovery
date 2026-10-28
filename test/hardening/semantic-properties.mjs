// 语义属性测试：不只看流是否合法，还验证"恢复出的调用内容与原文一致"
import fs from "node:fs";

const pluginPath = new URL("../../lib/index.js", import.meta.url).pathname.replace(/^\//, "");
const plugin = await import("file:///" + pluginPath.replace(/\\/g, "/"));
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [
	{ name: "pwsh", description: "x", parameters: { type: "object", properties: {
		command: { type: "string" }, timeout: { type: "number" }, count: { type: "integer" },
		verbose: { type: "boolean" }, opts: { type: "object" }, list: { type: "array" }, note: { type: "string" }
	} } },
	{ name: "read", description: "x", parameters: { type: "object", properties: { file_path: { type: "string" }, limit: { type: "number" } } } }
];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>", CC = "</" + "tool_call>";
const OF = (n) => "<" + "function=" + n + ">", CF = "</" + "function>";
const OP = (k) => "<" + "parameter=" + k + ">", CP = "</" + "parameter>";
const OPN = (k) => "<" + "parameter name=" + JSON.stringify(k) + ">";

let pass = 0, fail = 0;
function ck(label, cond, detail) {
	if (cond) { pass++; }
	else { fail++; console.log(`FAIL ${label}${detail ? " :: " + detail : ""}`); }
}

async function collect(src) {
	const out = [];
	for await (const c of listener(OPTS, () => src)) out.push(c);
	return out;
}
function callsOf(out) {
	return out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call")
		.map((c) => ({ name: c.block.name, args: JSON.parse(c.block.arguments) }));
}

// ---- 语义测试 1：类型强转是否正确 ----
{
	const cases = [
		["timeout", "30", 30],
		["count", "7", 7],
		["verbose", "true", true],
		["verbose", "false", false],
		["opts", '{"a":1,"b":[2]}', { a: 1, b: [2] }],
		["list", "[1,2,3]", [1, 2, 3]],
		["command", "Get-Date", "Get-Date"],
		["command", "42", "42"],           // string 类型不应转成 number
		["note", "true", "true"],          // string 类型不应转成 boolean
	];
	for (const [key, raw, expected] of cases) {
		const markup = OC + "\n" + OF("pwsh") + "\n" + OP(key) + "\n" + raw + "\n" + CP + "\n" + CF + "\n" + CC;
		const src = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: markup };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		const calls = callsOf(await collect(src));
		ck(`类型转换 ${key}=${JSON.stringify(raw).slice(0, 20)}`,
			calls.length === 1 && JSON.stringify(calls[0].args[key]) === JSON.stringify(expected),
			`实际 ${JSON.stringify(calls[0]?.args[key])} 期望 ${JSON.stringify(expected)}`);
	}
}

// ---- 语义测试 2：多行/特殊字符保真 ----
{
	const tricky = [
		"line1\nline2\nline3",
		"  indented\n    deeper",
		"tab\there",
		"& <tag> \"quoted\" 'single'",
		"中文与 emoji 🎯",
		"a".repeat(5000),
		"path\\to\\file",
		"$var = \"value\"",
	];
	for (const raw of tricky) {
		const escaped = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
		const markup = OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\n" + escaped + "\n" + CP + "\n" + CF + "\n" + CC;
		const src = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: markup };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		const calls = callsOf(await collect(src));
		ck(`保真 ${JSON.stringify(raw.slice(0, 25))}`, calls.length === 1 && calls[0].args.command === raw,
			`实际 ${JSON.stringify(calls[0]?.args.command?.slice(0, 40))}`);
	}
}

// ---- 语义测试 3：多个调用的顺序与内容 ----
{
	const markup = [
		OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\necho 1\n" + CP + "\n" + CF + "\n" + CC,
		OC + "\n" + OF("read") + "\n" + OP("file_path") + "\n/a.txt\n" + CP + "\n" + CF + "\n" + CC,
		OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\necho 3\n" + CP + "\n" + CF + "\n" + CC
	].join("\n");
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: markup };
		yield { type: "block-end", index: 0, block: { type: "text", text: markup } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const calls = callsOf(await collect(src));
	ck("3 个调用都被恢复", calls.length === 3, String(calls.length));
	ck("顺序保持", calls[0]?.args.command === "echo 1" && calls[1]?.name === "read" && calls[2]?.args.command === "echo 3",
		JSON.stringify(calls.map((c) => c.name + ":" + JSON.stringify(c.args))));
}

// ---- 语义测试 4：恢复后文本里不留标记残留 ----
{
	const markup = "前置说明：" + OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\necho hi\n" + CP + "\n" + CF + "\n" + CC + "\n后置说明";
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: markup };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = await collect(src);
	const reasoning = out.filter((c) => c.type === "block-end" && c.block?.type === "reasoning").map((c) => c.block.text).join("");
	ck("标记已从文本剥离", !reasoning.includes(OC) && !reasoning.includes(OF("pwsh")), JSON.stringify(reasoning));
	ck("前后文字保留", reasoning.includes("前置说明") && reasoning.includes("后置说明"), JSON.stringify(reasoning));
	ck("恢复 1 个调用", callsOf(out).length === 1);
}

// ---- 语义测试 5：Anthropic 风格（带 antml 前缀）----
{
	const markup = "<" + "antml:function name=\"pwsh\">\n" + OPN("command") + "\necho antml\n" + CP + "\n</" + "antml:function>";
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: markup };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const calls = callsOf(await collect(src));
	ck("antml 前缀也能解析", calls.length === 1 && calls[0].args.command === "echo antml",
		JSON.stringify(calls));
}

// ---- 语义测试 6：invoke 形态 ----
{
	const markup = "<" + "invoke name=\"read\">\n" + OPN("file_path") + "\n/b.md\n" + CP + "\n</" + "invoke>";
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: markup };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const calls = callsOf(await collect(src));
	ck("invoke 形态能解析", calls.length === 1 && calls[0].name === "read" && calls[0].args.file_path === "/b.md", JSON.stringify(calls));
}

// ---- 语义测试 7：JSON 形态 ----
{
	const markup = JSON.stringify({ name: "pwsh", arguments: { command: "echo json", timeout: 5 } });
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: OC + "\n" + markup + "\n" + CC };
		yield { type: "block-end", index: 0, block: { type: "text", text: OC + "\n" + markup + "\n" + CC } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const calls = callsOf(await collect(src));
	ck("JSON 形态能解析", calls.length === 1 && calls[0].args.command === "echo json", JSON.stringify(calls));
}

// ---- 语义测试 8：未声明工具不执行（安全关键）----
{
	const markup = OC + "\n" + OF("rm_rf") + "\n" + OP("path") + "\n/\n" + CP + "\n" + CF + "\n" + CC;
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: markup };
		yield { type: "block-end", index: 0, block: { type: "text", text: markup } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = await collect(src);
	ck("未声明工具绝不执行", callsOf(out).length === 0, JSON.stringify(callsOf(out)));
	ck("未声明工具 → 安全网 error", out.find((c) => c.type === "finish")?.reason?.kind === "error");
}

// ---- 语义测试 9：正常回复（含代码块展示标记）不应被改写 ----
{
	const doc = "## 说明\n\n工具调用格式如下：\n\n```xml\n" + OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\nls\n" + CP + "\n" + CF + "\n" + CC + "\n```\n\n以上是示例。";
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: doc };
		yield { type: "block-end", index: 0, block: { type: "text", text: doc } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = await collect(src);
	const fin = out.find((c) => c.type === "finish");
	// 注意：文档里出现**完整可解析**的调用，插件会把它恢复成真调用（设计如此——
	// 无法区分"模型想调用"与"模型在展示格式"）。这里只验证不会丢内容/不崩。
	ck("文档含完整调用时不会崩溃且流合法", fin !== undefined, JSON.stringify(fin?.reason));
	console.log(`  [观察] 文档含完整调用 → finish=${fin?.reason?.kind}，恢复 ${callsOf(out).length} 个调用`);
	console.log(`         （这是已知设计取舍：完整可解析的调用会被执行，见 README 已知限制）`);
}

console.log(`\n===== 语义测试: ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
