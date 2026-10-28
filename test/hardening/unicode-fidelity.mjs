// 中文与换行保真测试
//
// **为什么需要**（第 110 轮）：
// 前 109 轮验证了「恢复得对不对」，但**从未验证「恢复出来的内容是否与原文逐字节一致」**
// 这一点在中英文混合 + 各种换行符的场景下尤其重要：
//   · 中文用户的工具参数里经常有中文（路径、echo 内容、文件内容）
//   · 模型输出的换行可能是 LF / CRLF / 混合
//   · emoji 是**代理对**（2 个 UTF-16 码元），容易在切片时被切断
//   · 参数值里可能出现 XML 特殊字符（< > &）
//
// 任何一个被改动，都会让 `write` / `pwsh` 这类工具**执行出错误的结果**
// （例如写文件内容少一行、路径变成乱码）。
//
// 本套件验证（13 项）：
//   ① 中文命令内容逐字符一致
//   ② CRLF 完整保留（不被归一化成 LF）
//   ③ LF 完整保留
//   ④ 混合 CRLF + LF 完整保留
//   ⑤ 中文 + 反斜杠路径
//   ⑥ XML 特殊字符（< > &）
//   ⑦ 中文文件名 + 中文内容 + CRLF（write 工具，多参数）
//   ⑧ emoji（代理对）不被切断
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

const plugin = await import(pathToFileURL(LIB).href + "?unicode=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
	if (ok) { pass++; console.log("  ✅ " + label); }
	else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("  ❌ " + label + (detail ? " :: " + detail : "")); }
};
ck("插件注册了 llm/stream 监听器", typeof listener === "function");

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const OF = (n) => "<" + "function=" + n + ">";
const CF = "</" + "function>";
const OP = (k) => "<" + "parameter=" + k + ">";

const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } },
	{ name: "write", parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } } } },
];

async function run(text) {
	const chunks = [
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text },
		{ type: "block-end", index: 0, block: { type: "reasoning", text } },
		{ type: "finish", reason: { kind: "stop" } },
	];
	const out = [];
	const gen = (async function* () { for (const c of chunks) yield c; })();
	const stream = await listener({ provider: "p", model: "unicode-" + Math.random(), messages: [], tools: TOOLS }, () => gen);
	for await (const c of stream) out.push(c);
	return out;
}

/** 取出恢复出来的 tool-call 块并解析参数。 */
function getCall(out) {
	const end = out.find((c) => c.type === "block-end" && c.block?.type === "tool-call");
	if (!end) return null;
	let args;
	try { args = JSON.parse(end.block.arguments); } catch { args = { __parseFailed: end.block.arguments }; }
	return { name: end.block.name, args };
}

const mk = (cmd) => OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\n" + cmd + "\n</parameter>\n" + CF + "\n" + CC;

console.log("=== 1. 中文命令内容 ===");
{
	const cmd = "echo 你好世界";
	const c = getCall(await run(mk(cmd)));
	ck("恢复出调用", c !== null);
	ck("参数值逐字符保留中文", c?.args?.command === cmd, JSON.stringify(c?.args?.command));
}

console.log("=== 2. CRLF 换行 ===");
{
	const cmd = "echo line1\r\necho line2";
	const c = getCall(await run(mk(cmd)));
	ck("CRLF 完整保留（未被归一化成 LF）", c?.args?.command === cmd, JSON.stringify(c?.args?.command));
}

console.log("=== 3. LF 换行 ===");
{
	const cmd = "echo line1\necho line2";
	const c = getCall(await run(mk(cmd)));
	ck("LF 完整保留", c?.args?.command === cmd, JSON.stringify(c?.args?.command));
}

console.log("=== 4. 混合 CRLF + LF ===");
{
	const cmd = "a\r\nb\nc";
	const c = getCall(await run(mk(cmd)));
	ck("混合换行完整保留", c?.args?.command === cmd, JSON.stringify(c?.args?.command));
}

console.log("=== 5. 中文 + 反斜杠路径 ===");
{
	const cmd = 'echo "中文测试" && echo 路径\\文件.txt';
	const c = getCall(await run(mk(cmd)));
	ck("中文 + 反斜杠保留", c?.args?.command === cmd, JSON.stringify(c?.args?.command));
}

console.log("=== 6. XML 特殊字符 ===");
{
	const cmd = "echo <div> & echo a>b";
	const c = getCall(await run(mk(cmd)));
	ck("尖括号与 & 保留", c?.args?.command === cmd, JSON.stringify(c?.args?.command));
}

console.log("=== 7. 中文文件名 + 中文内容 + CRLF（多参数）===");
{
	const t = OC + "\n" + OF("write") + "\n" + OP("file_path") + "\n/中文目录/文件.txt\n</parameter>\n" + OP("content") + "\n第一行\r\n第二行\n</parameter>\n" + CF + "\n" + CC;
	const c = getCall(await run(t));
	ck("恢复出 write 调用", c !== null);
	ck("中文路径逐字符保留", c?.args?.file_path === "/中文目录/文件.txt", JSON.stringify(c?.args?.file_path));
	ck("中文内容 + CRLF 保留", c?.args?.content === "第一行\r\n第二行", JSON.stringify(c?.args?.content));
}

console.log("=== 8. emoji（代理对）===");
{
	const cmd = "echo 🎉🚀 测试";
	const c = getCall(await run(mk(cmd)));
	ck("emoji 未被切断", c?.args?.command === cmd, JSON.stringify(c?.args?.command));
	// 额外：确认码元数量正确（代理对 = 2 个 UTF-16 码元/字符）
	ck("emoji 码元数正确", (c?.args?.command?.length ?? 0) === cmd.length, ((c?.args?.command?.length ?? 0) + " vs " + cmd.length));
}

console.log("\n===== 中文与换行保真: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log("  ❌ " + f);
}
process.exit(fail === 0 ? 0 : 1);