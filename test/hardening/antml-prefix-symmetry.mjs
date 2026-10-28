// antml: 前缀在「函数层」与「参数层」必须对称
//
// **为什么需要**（缺陷 127，第 126 轮）：
// `FUNCTION_NAME_ATTR_RE` / `INVOKE_NAME_ATTR_RE` 都支持 `(?:antml:)?` 前缀，
// 但 `PARAM_NAME_RE` **只写 `<parameter`**，不接受 `<antml:parameter`。
//
// 后果是不对称的静默失败：真实 Anthropic 形态
//
//   <antml:function name="pwsh">
//     <antml:parameter name="command">echo A</antml:parameter>
//   </antml:function>
//
// 能匹配到外层函数，却**解析不出任何参数** → `parseParams` 返回空 →
// `Object.keys(args).length === 0` → 整条调用被丢弃（`continue`）。
// **用户看到文本里明明有调用，却什么都没发生。**
//
// 本套件验证（12 项）：4 种前缀组合 × 3 种行尾。
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

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href + "?antml=" + Date.now());
let listener;
mod.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const { BlockAssembler } = await import(pathToFileURL(LLM).href);

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
	if (ok) { pass++; console.log("  OK  " + label); }
	else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("  FAIL " + label + (detail ? " :: " + detail : "")); }
};

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];

async function recovered(text) {
	mod.resetStreaks?.();
	const chunks = [
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "text-delta", index: 0, text },
		{ type: "block-end", index: 0, block: { type: "text", text } },
		{ type: "finish", reason: { kind: "stop" } },
	];
	const out = [];
	const gen = (async function* () { for (const c of chunks) yield c; })();
	const stream = await listener({ provider: "p", model: "antml-" + Math.random(), messages: [], tools: TOOLS }, () => gen);
	for await (const c of stream) out.push(c);
	const asm = new BlockAssembler();
	for (const c of out) asm.push(c);
	const calls = [];
	for (const b of asm.assembled().blocks ?? []) {
		if (b.type !== "tool-call") continue;
		let args = null;
		try { args = JSON.parse(b.arguments); } catch { args = { __raw: b.arguments }; }
		calls.push({ name: b.name, args });
	}
	return calls;
}

// 四种前缀组合：外层 / 内层 各自可选 antml:
const COMBOS = [
	{ name: "function + parameter（无前缀）", fn: (s) => "<function name=\"pwsh\">" + s + "<parameter name=\"command\">echo A</parameter>" + s + "</function>" },
	{ name: "antml:function + parameter（外层带前缀）", fn: (s) => "<antml:function name=\"pwsh\">" + s + "<parameter name=\"command\">echo A</parameter>" + s + "</antml:function>" },
	{ name: "function + antml:parameter（内层带前缀）", fn: (s) => "<function name=\"pwsh\">" + s + "<antml:parameter name=\"command\">echo A</antml:parameter>" + s + "</function>" },
	{ name: "antml:function + antml:parameter（都带前缀）", fn: (s) => "<antml:function name=\"pwsh\">" + s + "<antml:parameter name=\"command\">echo A</antml:parameter>" + s + "</antml:function>" },
];

const EOLS = [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]];

console.log("=== 前缀组合 × 行尾：都必须能恢复 ===");
for (const combo of COMBOS) {
	for (const [eol, sep] of EOLS) {
		const calls = await recovered(combo.fn(sep));
		const ok = calls.length === 1 && calls[0].name === "pwsh" && calls[0].args?.command === "echo A";
		ck(combo.name + " + " + eol, ok, JSON.stringify(calls));
	}
}

console.log("");
console.log("===== antml 前缀对称性: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("--- 失败明细 ---");
	for (const f of failures) console.log("  FAIL " + f);
}
process.exit(fail === 0 ? 0 : 1);