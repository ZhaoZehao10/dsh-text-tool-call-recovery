// 原生调用与文本恢复的共存/互斥行为
//
// **为什么需要**（缺陷 110，第 112 轮）：
// 前 111 轮分别验证了「纯原生」「纯文本恢复」两条路径，但**没有验证两者共存**。
// 真实的模型输出可能出现：
//   · 已经给出结构化 `tool_calls`，同时又在正文里重复写了一遍 XML 文本；
//   · 或者反过来，先写 XML 文本、后面又补一个结构化调用。
//
// 最危险的是**重复执行**：如果插件在已有原生调用的情况下还去恢复 XML 文本，
// 同一条命令会被执行两次（`rm` / `git push` 这类操作直接灾难）。
//
// 本套件验证插件的**保守行为**（6 项 + 4 项边界）：
//   ① 原生调用在前 + XML 在后 → 只执行原生，不重复
//   ② XML 在前 + 原生在后 → 只执行原生
//   ③ reasoning 里 XML + text 正文 + 原生调用 → 只执行原生
//   ④ 原生与 XML 表示同一个调用 → 只执行一次
//   ⑤ finish.kind 不是 stop（tool-calls / error / aborted）→ **原样放行，不恢复**
//   ⑥ sawToolCall 时 finish.kind 保持原值（不改写成 tool-calls）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

const LLM = (() => {
	const candidates = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(process.cwd(), "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
	].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(c)) return c;
	console.error("找不到 dsh-llm：请设置 DSH_LLM_SRC");
	process.exit(1);
})();

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href + "?mix=" + Date.now());
let listener;
mod.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const { BlockAssembler } = await import(pathToFileURL(LLM).href);

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
	if (ok) { pass++; console.log("  ✅ " + label); }
	else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("  ❌ " + label + (detail ? " :: " + detail : "")); }
};
ck("插件注册了 llm/stream 监听器", typeof listener === "function");
ck("拿到宿主真实的 BlockAssembler", typeof BlockAssembler === "function");

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const OF = (n) => "<" + "function=" + n + ">";
const CF = "</" + "function>";
const OP = (k) => "<" + "parameter=" + k + ">";

const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } },
	{ name: "read", parameters: { type: "object", properties: { file_path: { type: "string" } } } },
];

const mkXml = (name, key, val) => OC + "\n" + OF(name) + "\n" + OP(key) + "\n" + val + "\n</parameter>\n" + CF + "\n" + CC;

async function runChunks(chunks) {
	mod.resetStreaks?.();
	const out = [];
	const gen = (async function* () { for (const c of chunks) yield c; })();
	const stream = await listener({ provider: "p", model: "mix-" + Math.random(), messages: [], tools: TOOLS }, () => gen);
	for await (const c of stream) out.push(c);
	return out;
}

function assemble(chunks) {
	const asm = new BlockAssembler();
	for (const c of chunks) asm.push(c);
	return asm.assembled();
}

function extractCalls(assembled) {
	const calls = [];
	for (const b of assembled.blocks ?? []) {
		if (b.type !== "tool-call") continue;
		let args;
		try { args = typeof b.arguments === "string" ? JSON.parse(b.arguments) : b.arguments; } catch { args = { __raw: b.arguments }; }
		calls.push({ name: b.name, args });
	}
	return calls;
}

/** 构造一个原生 tool-call 块。 */
const nativeBlock = (index, name, args) => {
	const json = JSON.stringify(args);
	return [
		{ type: "block-start", index, blockType: "tool-call" },
		{ type: "tool-call-delta", index, id: "n" + index, name, argumentsDelta: json },
		{ type: "block-end", index, block: { type: "tool-call", id: "n" + index, name, arguments: json } },
	];
};

console.log("=== 1. 原生调用在前 + XML 在后 ===");
{
	const xml = mkXml("read", "file_path", "/xml.txt");
	const chunks = [
		...nativeBlock(0, "pwsh", { command: "echo native" }),
		{ type: "block-start", index: 1, blockType: "text" },
		{ type: "text-delta", index: 1, text: xml },
		{ type: "block-end", index: 1, block: { type: "text", text: xml } },
		{ type: "finish", reason: { kind: "tool-calls" } },
	];
	const calls = extractCalls(assemble(await runChunks(chunks)));
	ck("只执行原生调用（不重复恢复）", calls.length === 1 && calls[0].name === "pwsh", JSON.stringify(calls));
}

console.log("=== 2. XML 在前 + 原生调用在后 ===");
{
	const xml = mkXml("read", "file_path", "/xml.txt");
	const chunks = [
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "text-delta", index: 0, text: xml },
		{ type: "block-end", index: 0, block: { type: "text", text: xml } },
		...nativeBlock(1, "pwsh", { command: "echo native" }),
		{ type: "finish", reason: { kind: "tool-calls" } },
	];
	const calls = extractCalls(assemble(await runChunks(chunks)));
	ck("只执行原生调用", calls.length === 1 && calls[0].name === "pwsh", JSON.stringify(calls));
}

console.log("=== 3. reasoning 里 XML + text 正文 + 原生调用 ===");
{
	const xml = mkXml("read", "file_path", "/xml.txt");
	const chunks = [
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text: xml },
		{ type: "block-end", index: 0, block: { type: "reasoning", text: xml } },
		{ type: "block-start", index: 1, blockType: "text" },
		{ type: "text-delta", index: 1, text: "这是正文" },
		{ type: "block-end", index: 1, block: { type: "text", text: "这是正文" } },
		...nativeBlock(2, "pwsh", { command: "echo native" }),
		{ type: "finish", reason: { kind: "tool-calls" } },
	];
	const calls = extractCalls(assemble(await runChunks(chunks)));
	ck("只执行原生调用", calls.length === 1 && calls[0].name === "pwsh", JSON.stringify(calls));
}

console.log("=== 4. 原生与 XML 表示同一个调用 ===");
{
	const xml = mkXml("pwsh", "command", "echo same");
	const chunks = [
		...nativeBlock(0, "pwsh", { command: "echo same" }),
		{ type: "block-start", index: 1, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 1, text: xml },
		{ type: "block-end", index: 1, block: { type: "reasoning", text: xml } },
		{ type: "finish", reason: { kind: "tool-calls" } },
	];
	const calls = extractCalls(assemble(await runChunks(chunks)));
	ck("同一调用未被重复执行", calls.length === 1, "调用数 " + calls.length);
}

console.log("=== 5. finish.kind 不是 stop → 原样放行，不恢复 ===");
for (const kind of ["tool-calls", "error", "aborted"]) {
	const xml = mkXml("pwsh", "command", "echo " + kind);
	const reason = kind === "error"
		? { kind, failure: { code: "X", message: "boom" } }
		: { kind };
	const out = await runChunks([
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text: xml },
		{ type: "block-end", index: 0, block: { type: "reasoning", text: xml } },
		{ type: "finish", reason },
	]);
	const calls = extractCalls(assemble(out));
	const finish = out.find((c) => c.type === "finish");
	ck("finish.kind=" + kind + " 时不恢复", calls.length === 0, "恢复了 " + calls.length + " 个");
	ck("finish.kind=" + kind + " 原样放行", finish?.reason?.kind === kind, JSON.stringify(finish?.reason));
}

console.log("=== 6. sawToolCall 且 kind=stop → finish 保持 stop（不改写成 tool-calls）===");
{
	const chunks = [
		...nativeBlock(0, "pwsh", { command: "echo native" }),
		{ type: "finish", reason: { kind: "stop" } },
	];
	const out = await runChunks(chunks);
	const finish = out.find((c) => c.type === "finish");
	ck("finish.kind 保持 stop", finish?.reason?.kind === "stop", JSON.stringify(finish?.reason));
}

console.log("\n===== 原生与恢复共存行为: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log("  ❌ " + f);
}
process.exit(fail === 0 ? 0 : 1);