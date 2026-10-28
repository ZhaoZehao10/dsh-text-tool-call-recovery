// 「纯标记」判定的标记清单必须完整（缺陷 129）
//
// **为什么需要**（第 127 轮）：
// `isMarkupOnlyText` 决定「这段文本是不是**只有标记、没有实质内容**」。
// 它一旦误判成「有实质内容」，**安全网就不会触发 EMPTY_RESPONSE** ——
// 用户看到满屏 XML 却既不执行也不重试，回合静默结束。
//
// 该函数的实现是 8 个 `text.includes(OPEN_XXX)` 的 `||` 链。这种写法的
// 根本问题是：**清单必须人工枚举，漏一个就有一类形态静默失效**。
// 第 126 轮修的是 `PARAM_NAME_RE` 漏 `antml:`（缺陷 127），
// 本轮发现**同一个 `antml:` 前缀在标记清单里也漏了**（缺陷 129）。
//
// 本套件验证（14 项）：
//   ① 7 种「只有标记」的文本都必须触发 EMPTY_RESPONSE
//   ② 7 种「标记 + 实质内容」的文本都必须**不**触发（不能误伤正常回复）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

const mod = await import(pathToFileURL(LIB).href + "?markup=" + Date.now());
let listener;
mod.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
	if (ok) { pass++; console.log("  OK  " + label); }
	else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("  FAIL " + label + (detail ? " :: " + detail : "")); }
};

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];

async function finishOf(text) {
	mod.resetStreaks?.();
	const chunks = [
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "text-delta", index: 0, text },
		{ type: "block-end", index: 0, block: { type: "text", text } },
		{ type: "finish", reason: { kind: "stop" } },
	];
	const out = [];
	const gen = (async function* () { for (const c of chunks) yield c; })();
	const stream = await listener({ provider: "p", model: "markup-" + Math.random(), messages: [], tools: TOOLS }, () => gen);
	for await (const c of stream) out.push(c);
	return out.find((c) => c.type === "finish")?.reason;
}

// ① 只有标记 → 必须 EMPTY_RESPONSE
const MARKUP_ONLY = [
	{ name: "<tool_call></tool_call>", text: "<tool_call></tool_call>" },
	{ name: "<function=pwsh></function>", text: "<function=pwsh></function>" },
	{ name: "<parameter=command></parameter>", text: "<parameter=command></parameter>" },
	{ name: "<parameter name=\"x\"></parameter>", text: "<parameter name=\"x\"></parameter>" },
	{ name: "<function name=\"x\"></function>", text: "<function name=\"x\"></function>" },
	{ name: "<invoke name=\"x\"></invoke>", text: "<invoke name=\"x\"></invoke>" },
	{ name: "<antml:function name=\"x\"></antml:function>", text: "<antml:function name=\"x\"></antml:function>" },
	{ name: "<antml:invoke name=\"x\"></antml:invoke>", text: "<antml:invoke name=\"x\"></antml:invoke>" },
	{ name: "<antml:parameter name=\"x\"></antml:parameter>", text: "<antml:parameter name=\"x\"></antml:parameter>" },
	{ name: "<antml:parameter=command></antml:parameter>", text: "<antml:parameter=command></antml:parameter>" },
];

console.log("=== 1. 只有标记 → 必须触发 EMPTY_RESPONSE ===");
for (const c of MARKUP_ONLY) {
	const reason = await finishOf(c.text);
	ck("纯标记: " + c.name, reason?.failure?.code === "EMPTY_RESPONSE",
		JSON.stringify(reason?.kind) + "/" + JSON.stringify(reason?.failure?.code));
}

// ② 标记 + 实质内容 → 必须**不**触发（不能误伤正常回复）
// **注意阈值**：`isMarkupOnlyText` 的判据是
//   「实质字符 < 20 且 标记字符占比 > 50%」→ 视为纯标记。
// 所以「标记 + 很短的正文」**按设计就是纯标记**，不是缺陷。
// 这里要用**明显超过阈值**的正文来验证「不会误伤」。
const LONG_PROSE = "这是一段足够长的正常回复内容，用来确保实质字符数远超过二十个字符的阈值，从而不会被误判成纯标记文本。";
const WITH_CONTENT = [
	{ name: "标记后有长正文", text: "<tool_call></tool_call>" + LONG_PROSE },
	{ name: "标记前有长正文", text: LONG_PROSE + "<parameter=command></parameter>" },
	{ name: "antml 标记 + 长正文", text: "<antml:parameter name=\"x\"></antml:parameter>" + LONG_PROSE },
	{ name: "无任何标记的长正文", text: LONG_PROSE },
];

console.log("=== 2. 标记 + 实质内容 → 必须**不**触发（不误伤正常回复）===");
for (const c of WITH_CONTENT) {
	const reason = await finishOf(c.text);
	ck("有实质内容: " + c.name, reason?.failure?.code !== "EMPTY_RESPONSE",
		JSON.stringify(reason?.kind) + "/" + JSON.stringify(reason?.failure?.code));
}

console.log("");
console.log("===== 纯标记判定完整性: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("--- 失败明细 ---");
	for (const f of failures) console.log("  FAIL " + f);
}
process.exit(fail === 0 ? 0 : 1);