// 「已知限制」文档与实际行为的一致性（缺陷 132）
//
// **为什么需要**（第 129 轮）：
// README 的已知限制写着「其他方言不解析：这类会落到安全网（重试）」。
// 第 129 轮逐条核对 10 条限制时实测：
//
//   `<tool><name>pwsh</name><args><command>echo A</command></args></tool>`
//
// **没有**落到安全网，而是**原样放行 `stop`**（回合正常结束）。
// 原因：`isMarkupOnlyText` 的第一道判断是「文本里是否含**已知标记**」，
// 而 `<tool>` 不在那 10 个标记里 → 直接 `return false` → 按「有可见文本」放行。
//
// 也就是说文档描述的走向**是错的**。这不是插件 bug（两种走向都安全，
// 都不会误执行示例），但**文档与行为不符**就是缺陷 —— 维护者照文档
// 去排查会找错方向。
//
// 本套件验证（6 项）：
//   ① 含已知标记但不可解析 → 落到安全网
//   ② 完全不含已知标记 → 原样放行 stop
//   ③ 两种走向都**不**执行示例（安全底线）
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

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href + "?kl=" + Date.now());
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
	// 每次用全新 model 名，避免「确定性失败保护」（streak>1 会原样放行）干扰
	const stream = await listener({ provider: "p", model: "kl-" + Date.now() + "-" + Math.random(), messages: [], tools: TOOLS }, () => gen);
	for await (const c of stream) out.push(c);
	const asm = new BlockAssembler();
	for (const c of out) asm.push(c);
	let calls = 0;
	for (const b of asm.assembled().blocks ?? []) if (b.type === "tool-call") calls++;
	const fin = out.find((c) => c.type === "finish");
	return { calls, kind: fin?.reason?.kind, code: fin?.reason?.failure?.code };
}

console.log("=== 1. 含已知标记但不可解析 → 落到安全网（EMPTY_RESPONSE）===");
{
	// 含 <tool_call> 已知标记，但内部是第 4 类方言 → 判为纯标记 → 安全网
	const text = "<tool_call><tool><name>pwsh</name></args></tool></tool_call>";
	const r = await probe(text);
	ck("含 <tool_call> 但不可解析 → EMPTY_RESPONSE", r.code === "EMPTY_RESPONSE",
		"kind=" + r.kind + " code=" + (r.code ?? "-"));
	ck("不执行示例", r.calls === 0, "calls=" + r.calls);
}

console.log("=== 2. 完全不含已知标记 → 原样放行 stop（按有可见文本处理）===");
{
	const text = "<tool><name>pwsh</name><args><command>echo A</command></args></tool>";
	const r = await probe(text);
	ck("不含已知标记 → 原样放行 stop", r.kind === "stop" && r.code === undefined,
		"kind=" + r.kind + " code=" + (r.code ?? "-"));
	ck("不执行示例（安全底线）", r.calls === 0, "calls=" + r.calls);
}

console.log("=== 3. 截断的开标记（无闭合）→ 按有可见文本放行 ===");
{
	const r = await probe("<function=");
	ck("截断开标记 → 不执行", r.calls === 0, "calls=" + r.calls);
	ck("截断开标记 → 原样放行（不重试）", r.kind === "stop", "kind=" + r.kind);
}

console.log("");
console.log("===== 已知限制一致性: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("--- 失败明细 ---");
	for (const f of failures) console.log("  FAIL " + f);
}
process.exit(fail === 0 ? 0 : 1);