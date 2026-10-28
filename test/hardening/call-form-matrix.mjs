// 调用形态 × 「完整/截断」的完整矩阵（缺陷 131）
//
// **为什么需要**（第 128 轮）：
// 插件能解析多种调用形态，`isMarkupOnlyText` 也列举了 10 个标记。
// 但**两者的集合是否一致**从来没被验证过：
//
//   · 能解析但不在纯标记清单 → 「只有该形态」的文本被判有实质内容
//     → 安全网不触发 → 用户看到 XML 却不执行不重试
//   · 在清单里但无法解析 → 无意义重试（虽然安全，但浪费）
//
// 另外 README 的「已知限制」一直写着「只解析 3 类标记」，但实际支持的
// 形态远比 3 类多，而**Qwen 裸 `<function=name>` 必须被 `<tool_call>` 包裹**
// 这条限制从未披露（缺陷 131）。
//
// 本套件验证（17 项）：
//   ① 10 种「完整可解析形态」各自都必须恢复出 1 个调用
//   ② 10 种「只给完整标记、不给内容」的形态都必须触发 EMPTY_RESPONSE
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

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href + "?forms=" + Date.now());
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

async function probe(text) {
	mod.resetStreaks?.();
	const chunks = [
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "text-delta", index: 0, text },
		{ type: "block-end", index: 0, block: { type: "text", text } },
		{ type: "finish", reason: { kind: "stop" } },
	];
	const out = [];
	const gen = (async function* () { for (const c of chunks) yield c; })();
	const stream = await listener({ provider: "p", model: "forms-" + Math.random(), messages: [], tools: TOOLS }, () => gen);
	for await (const c of stream) out.push(c);
	const asm = new BlockAssembler();
	for (const c of out) asm.push(c);
	let calls = 0;
	for (const b of asm.assembled().blocks ?? []) if (b.type === "tool-call") calls++;
	const fin = out.find((c) => c.type === "finish");
	return { calls, code: fin?.reason?.failure?.code, kind: fin?.reason?.kind };
}

// ① 完整可解析形态（**必须**恢复 1 个调用）
const PARSEABLE = [
	{ name: "tool_call + Qwen function=", text: "<tool_call>\n<function=pwsh>\n<parameter=command>echo A</parameter>\n</function>\n</tool_call>" },
	{ name: "Anthropic function name=", text: "<function name=\"pwsh\">\n<parameter name=\"command\">echo A</parameter>\n</function>" },
	{ name: "Anthropic invoke name=", text: "<invoke name=\"pwsh\">\n<parameter name=\"command\">echo A</parameter>\n</invoke>" },
	{ name: "antml:function", text: "<antml:function name=\"pwsh\">\n<antml:parameter name=\"command\">echo A</antml:parameter>\n</antml:function>" },
	{ name: "antml:invoke", text: "<antml:invoke name=\"pwsh\">\n<antml:parameter name=\"command\">echo A</antml:parameter>\n</antml:invoke>" },
];
console.log("=== 1. 完整可解析形态 → 必须恢复 1 个调用 ===");
for (const f of PARSEABLE) {
	const r = await probe(f.text);
	ck(f.name, r.calls === 1, "calls=" + r.calls + " kind=" + r.kind);
}

// ② 只有「完整空标记」（有闭合、无内容）→ 必须 EMPTY_RESPONSE
const EMPTY_MARKUP = [
	{ name: "<tool_call></tool_call>", text: "<tool_call></tool_call>" },
	{ name: "<function=pwsh></function>", text: "<function=pwsh></function>" },
	{ name: "<parameter=command></parameter>", text: "<parameter=command></parameter>" },
	{ name: "<parameter name=\"x\"></parameter>", text: "<parameter name=\"x\"></parameter>" },
	{ name: "<function name=\"x\"></function>", text: "<function name=\"x\"></function>" },
	{ name: "<invoke name=\"x\"></invoke>", text: "<invoke name=\"x\"></invoke>" },
	{ name: "<antml:function name=\"x\"></antml:function>", text: "<antml:function name=\"x\"></antml:function>" },
	{ name: "<antml:invoke name=\"x\"></antml:invoke>", text: "<antml:invoke name=\"x\"></antml:invoke>" },
	{ name: "<antml:parameter name=\"x\"></antml:parameter>", text: "<antml:parameter name=\"x\"></antml:parameter>" },
	{ name: "<antml:parameter=x></antml:parameter>", text: "<antml:parameter=x></antml:parameter>" },
];
console.log("=== 2. 完整空标记 → 必须 EMPTY_RESPONSE（安全网）===");
for (const f of EMPTY_MARKUP) {
	const r = await probe(f.text);
	ck(f.name, r.code === "EMPTY_RESPONSE", "kind=" + r.kind + " code=" + (r.code ?? "-"));
}

// ③ 文档化：Qwen 裸形态**不**恢复（已知限制，行为必须与文档一致）
console.log("=== 3. 已知限制：Qwen 裸形态不恢复（但落到安全网，不静默丢弃）===");
{
	const r = await probe("<function=pwsh>\n<parameter=command>echo A</parameter>\n</function>");
	ck("Qwen 裸形态不恢复", r.calls === 0, "calls=" + r.calls);
	ck("但不静默丢弃（触发 EMPTY_RESPONSE 让上层重试）", r.code === "EMPTY_RESPONSE", "kind=" + r.kind + " code=" + (r.code ?? "-"));
}

console.log("");
console.log("===== 调用形态矩阵: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("--- 失败明细 ---");
	for (const f of failures) console.log("  FAIL " + f);
}
process.exit(fail === 0 ? 0 : 1);