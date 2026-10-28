// 连续空响应计数（emptyResponseStreak）的并发与状态隔离验证
//
// **为什么需要**（缺陷 101，第 104 轮）：
// 插件里有一个按模型分键的 LRU（`emptyResponseStreak`，上限 64），
// 用来区分「间歇性空响应」和「模型确定性失败」：
//   · 第 1 次空响应  → 改写为可重试错误（EMPTY_RESPONSE），让默认策略重试
//   · 连续第 2+ 次   → 原样透传（不再改写成 error，避免空转烧 token）
//   · 出现可见内容   → 清空该模型计数
//
// **缺陷**：最初的实现**只在「有可见正文」分支清零**，漏掉了
// 「恢复出可执行工具调用」这条**同样属于成功**的路径。于是序列
//   空响应(streak=1) → 恢复成功(无正文，未清零) → 再空响应(streak=2)
// 会把第 3 次当成「确定性失败」原样透传 —— **用户得不到重试**。
//
// 本套件验证（19 项）：
//   ① 20 个不同模型并发跑空响应，各自独立触发 error（无串扰）
//   ② 同一模型连续空响应：第 1 次 error，第 2/3 次透传
//   ③ 两个模型交错执行时互不影响
//   ④ **恢复成功（无正文）后计数被清零**
//   ⑤ 恢复成功（有正文）后计数被清零
//   ⑥ **先空 → 恢复 → 再空，必须重新触发 error**（缺陷 101 的回归）
//   ⑦ LRU 上限 64：超过后淘汰最旧的，最近的仍在
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
	if (ok) { pass++; console.log("  ✅ " + label); }
	else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("  ❌ " + label + (detail ? " :: " + detail : "")); }
};

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const OF = (n) => "<" + "function=" + n + ">";
const CF = "</" + "function>";
const OP = (k) => "<" + "parameter=" + k + ">";
const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];

const mod = await import(pathToFileURL(LIB).href + "?streak=" + Date.now());
let listener;
mod.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });
ck("插件注册了 llm/stream 监听器", typeof listener === "function");

const mkText = (t) => [
	{ type: "block-start", index: 0, blockType: "reasoning" },
	{ type: "reasoning-delta", index: 0, text: t },
	{ type: "block-end", index: 0, block: { type: "reasoning", text: t } },
	{ type: "finish", reason: { kind: "stop" } },
];

const mkRecoverableWithText = (recoverable, text) => [
	{ type: "block-start", index: 0, blockType: "reasoning" },
	{ type: "reasoning-delta", index: 0, text: recoverable },
	{ type: "block-end", index: 0, block: { type: "reasoning", text: recoverable } },
	{ type: "block-start", index: 1, blockType: "text" },
	{ type: "text-delta", index: 1, text },
	{ type: "block-end", index: 1, block: { type: "text", text } },
	{ type: "finish", reason: { kind: "stop" } },
];

const RECOVERABLE = OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\necho hi\n</parameter>\n" + CF + "\n" + CC;
const EMPTY = "只有思考";

async function run(model, chunks) {
	const out = [];
	const gen = (async function* () { for (const c of chunks) yield c; })();
	const stream = await listener({ provider: "p", model, messages: [], tools: TOOLS }, () => gen);
	for await (const c of stream) out.push(c);
	return out;
}

const isError = (r) => r.some((c) => c.type === "finish" && c.reason?.kind === "error");
const hasToolCall = (r) => r.some((c) => c.type === "block-start" && c.blockType === "tool-call");

console.log("=== 1. 并发：20 个不同模型同时跑空响应 ===");
{
	mod.resetStreaks?.();
	const models = Array.from({ length: 20 }, (_, i) => "concurrent-" + i + "-" + Date.now());
	const results = await Promise.all(models.map((m) => run(m, mkText(EMPTY))));
	const errors = results.filter(isError).length;
	ck("20 个并发模型各自首次空响应都触发 error（无串扰）", errors === 20, errors + "/20");
}

console.log("=== 2. 同一模型连续空响应 ===");
{
	mod.resetStreaks?.();
	const m = "same-" + Date.now();
	ck("第 1 次空响应触发 error", isError(await run(m, mkText(EMPTY))) === true);
	ck("第 2 次空响应透传（不 error）", isError(await run(m, mkText(EMPTY))) === false);
	ck("第 3 次空响应也透传", isError(await run(m, mkText(EMPTY))) === false);
}

console.log("=== 3. 两个模型交错执行互不影响 ===");
{
	mod.resetStreaks?.();
	const tag = Date.now();
	const a = "inter-a-" + tag;
	const b = "inter-b-" + tag;
	ck("a 第 1 次 error", isError(await run(a, mkText(EMPTY))) === true);
	ck("b 第 1 次 error", isError(await run(b, mkText(EMPTY))) === true);
	ck("a 第 2 次透传", isError(await run(a, mkText(EMPTY))) === false);
	ck("b 第 2 次透传", isError(await run(b, mkText(EMPTY))) === false);
}

console.log("=== 4. 恢复成功（无正文）后计数被清零 ===");
{
	mod.resetStreaks?.();
	const m = "recover-notext-" + Date.now();
	const r1 = await run(m, mkText(RECOVERABLE));
	ck("恢复出 tool-call", hasToolCall(r1) === true);
	ck("恢复不报 error", isError(r1) === false);
	ck("恢复后再空响应重新触发 error（计数已清零）", isError(await run(m, mkText(EMPTY))) === true);
}

console.log("=== 5. 恢复成功（有正文）后计数被清零 ===");
{
	mod.resetStreaks?.();
	const m = "recover-withtext-" + Date.now();
	const r1 = await run(m, mkRecoverableWithText(RECOVERABLE, "这是正文"));
	ck("恢复出 tool-call（带正文）", hasToolCall(r1) === true);
	ck("带正文恢复后再空响应重新触发 error", isError(await run(m, mkText(EMPTY))) === true);
}

console.log("=== 6. 缺陷 101 回归：先空 → 恢复 → 再空 ===");
{
	mod.resetStreaks?.();
	const m = "regression-101-" + Date.now();
	ck("第 1 次空响应 error", isError(await run(m, mkText(EMPTY))) === true);
	const r2 = await run(m, mkText(RECOVERABLE));
	ck("第 2 次恢复成功（无 error）", isError(r2) === false && hasToolCall(r2) === true);
	ck("**第 3 次空响应必须重新 error**（缺陷 101 的回归断言）",
		isError(await run(m, mkText(EMPTY))) === true,
		"计数未在恢复成功时清零");
}

console.log("=== 7. LRU 上限 64 ===");
{
	mod.resetStreaks?.();
	const tag = Date.now();
	const models = Array.from({ length: 70 }, (_, i) => "lru-" + tag + "-" + i);
	for (const m of models) await run(m, mkText(EMPTY));
	ck("超过 64 个模型后最旧的被淘汰（重新 error）", isError(await run(models[0], mkText(EMPTY))) === true);
	ck("最近的模型仍在 LRU 中（第 2 次透传）", isError(await run(models[69], mkText(EMPTY))) === false);
}

console.log("\n===== 连续空响应计数与状态隔离: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log("  ❌ " + f);
}
process.exit(fail === 0 ? 0 : 1);