// 双层包装的 finish.kind 稳定性（缺陷 117）
//
// 为什么需要（第 118 轮）：
// 第 117 轮的 `double-registration.mjs` 只验证了「恢复不重复、streak 行为一致」，
// 但**没有验证双层包装下的 `finish.kind`**。第 118 轮做了 3 个变异测试：
//
//   变异 1：去掉 `sawToolCall ||` 条件          → 未被发现
//   变异 2：去掉 `finish.kind !== "stop"` 条件  → 未被发现
//   变异 3：内层 finish 保持 `stop`（改为 `tool-calls`）→ 未被发现
//   变异 1+3 组合                                → **finish 被错误改写为 error**，仍未被发现
//
// 这说明第 117 轮的 9 项测试**漏掉了 `finish.kind` 这个维度**。
//
// 双层安全的真正机制（本轮实测确认）：
//   ① 内层恢复后 `finish.kind = "tool-calls"`（≠ "stop"）→ 外层直接放行
//   ② 即使外层进入恢复逻辑，内层已把 XML **剥离**，外层无从恢复
//   ③ 但若两者都被破坏，外层会把「已无可见文本」误判 → EMPTY_RESPONSE
//
// 本套件补齐 `finish.kind` 维度的验证（9 项）。
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

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href + "?fk=" + Date.now());
const { BlockAssembler } = await import(pathToFileURL(LLM).href);

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
	if (ok) { pass++; console.log("  OK  " + label); }
	else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("  FAIL " + label + (detail ? " :: " + detail : "")); }
};

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

function extractCalls(assembled) {
	const calls = [];
	for (const b of assembled.blocks ?? []) {
		if (b.type !== "tool-call") continue;
		let args;
		try { args = typeof b.arguments === "string" ? JSON.parse(b.arguments) : b.arguments; } catch { args = {}; }
		calls.push({ name: b.name, args });
	}
	return calls;
}

function assemble(chunks) {
	const asm = new BlockAssembler();
	for (const c of chunks) asm.push(c);
	return asm.assembled();
}

async function runWith(listeners, chunks, model) {
	let stream = (async function* () { for (const c of chunks) yield c; })();
	for (let i = listeners.length - 1; i >= 0; i--) {
		const prev = stream;
		stream = await listeners[i]({ provider: "p", model, messages: [], tools: TOOLS }, () => prev);
	}
	const out = [];
	for await (const c of stream) out.push(c);
	return out;
}

function mk(n) {
	const ls = [];
	for (let i = 0; i < n; i++) mod.apply({ on: (e, h) => { if (e === "llm/stream") ls.push(h); } });
	return ls;
}

const xml = OC + "\n<function=pwsh>\n<parameter=command>\necho x\n</parameter>\n</function>\n" + CC;
const recoverChunks = [
	{ type: "block-start", index: 0, blockType: "reasoning" },
	{ type: "reasoning-delta", index: 0, text: xml },
	{ type: "block-end", index: 0, block: { type: "reasoning", text: xml } },
	{ type: "finish", reason: { kind: "stop" } },
];

console.log("=== 1. 单层恢复：finish.kind 必须改写成 tool-calls ===");
{
	mod.resetStreaks?.();
	const out = await runWith(mk(1), recoverChunks, "fk1-" + Date.now());
	const fin = out.find((c) => c.type === "finish");
	ck("单层恢复后 finish.kind = tool-calls", fin?.reason?.kind === "tool-calls", JSON.stringify(fin?.reason));
	ck("单层恢复后 calls = 1", extractCalls(assemble(out)).length === 1, "");
}

console.log("=== 2. 双层恢复：finish.kind 仍必须是 tool-calls（不是 error）===");
{
	mod.resetStreaks?.();
	const out = await runWith(mk(2), recoverChunks, "fk2-" + Date.now());
	const fin = out.find((c) => c.type === "finish");
	ck("双层恢复后 finish.kind = tool-calls", fin?.reason?.kind === "tool-calls", JSON.stringify(fin?.reason));
	ck("双层恢复后**不是** error（外层不应误判为空响应）", fin?.reason?.kind !== "error", JSON.stringify(fin?.reason));
	ck("双层恢复后 calls = 1（不重复）", extractCalls(assemble(out)).length === 1, "");
}

console.log("=== 3. 三层恢复：同样必须是 tool-calls ===");
{
	mod.resetStreaks?.();
	const out = await runWith(mk(3), recoverChunks, "fk3-" + Date.now());
	const fin = out.find((c) => c.type === "finish");
	ck("三层恢复后 finish.kind = tool-calls", fin?.reason?.kind === "tool-calls", JSON.stringify(fin?.reason));
	ck("三层恢复后 calls = 1", extractCalls(assemble(out)).length === 1, "");
}

console.log("=== 4. 内层已剥离 XML：外层看到的 reasoning 文本里没有标记 ===");
{
	mod.resetStreaks?.();
	const out = await runWith(mk(2), recoverChunks, "fk4-" + Date.now());
	// 找 reasoning 的 block-end
	const reBlock = out.find((c) => c.type === "block-end" && c.block?.type === "reasoning");
	const text = reBlock?.block?.text ?? "";
	ck("双层下交出的 reasoning 文本**不含** tool_call 标记",
		!text.includes(OC), JSON.stringify(text.slice(0, 60)));
	ck("双层下交出的 reasoning 文本**不含** function 标记",
		!text.includes("<function"), JSON.stringify(text.slice(0, 60)));
}

console.log("");
console.log("===== 双层 finish.kind 稳定性: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("--- 失败明细 ---");
	for (const f of failures) console.log("  FAIL " + f);
}
process.exit(fail === 0 ? 0 : 1);