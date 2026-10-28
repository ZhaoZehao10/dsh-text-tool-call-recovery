// 状态隔离与生命周期审查
//
// 插件唯一的内部可变状态是 emptyResponseStreak（按 model 记录连续空响应次数）。
// 本测试系统审查它的隔离性与生命周期：
//   1. 模型隔离：A 模型的状态不影响 B 模型
//   2. 并发隔离：同时跑多条流，计数不串
//   3. 语义正确：第一次空响应→error，第二次→放行，有正文→清零
//   4. 上界：超过 64 个模型时淘汰最旧的
//   5. 重置：resetStreaks 彻底清理
//   6. 异常路径：中途抛异常后状态不被污染
//   7. 键构造：provider/model 缺失、含特殊字符时不冲突
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [{ name: "pwsh" }];
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

// 空响应流（只有思考，无可执行内容）
const emptyStream = () => (async function* () {
	yield { type: "block-start", index: 0, blockType: "reasoning" };
	yield { type: "reasoning-delta", index: 0, text: "只有思考" };
	yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
	yield { type: "finish", reason: { kind: "stop" } };
})();

// 正常流（有正文）
const normalStream = () => (async function* () {
	yield { type: "block-start", index: 0, blockType: "text" };
	yield { type: "text-delta", index: 0, text: "正常回复内容。".repeat(10) };
	yield { type: "block-end", index: 0, block: { type: "text", text: "正常回复内容。".repeat(10) } };
	yield { type: "finish", reason: { kind: "stop" } };
})();

async function run(model, streamFactory, provider = "p") {
	const out = [];
	for await (const c of listener({ provider, model, messages: [], tools: TOOLS }, streamFactory)) out.push(c);
	return out.find((c) => c.type === "finish")?.reason?.kind;
}

const kindOf = () => {};

console.log("=== 1. 模型隔离 ===");
{
	plugin.resetStreaks?.();
	// A 模型第一次空 -> error
	ck("A 首次空响应 → error", (await run("model-A", emptyStream)) === "error");
	// A 模型第二次空 -> 放行 stop
	ck("A 再次空响应 → stop（放行）", (await run("model-A", emptyStream)) === "stop");
	// B 模型第一次空 -> 仍应 error（不受 A 影响）
	ck("B 首次空响应 → error（A 不影响 B）", (await run("model-B", emptyStream)) === "error");
	// C 模型（provider 不同但 model 同名）-> 应为独立键
	ck("不同 provider 同名 model 独立 → error", (await run("model-A", emptyStream, "p2")) === "error");
}

console.log("\n=== 2. 语义正确性 ===");
{
	plugin.resetStreaks?.();
	ck("首次空 → error", (await run("m1", emptyStream)) === "error");
	ck("再次空 → stop", (await run("m1", emptyStream)) === "stop");
	// 有正常回复 -> 应清零
	ck("正常回复 → stop", (await run("m1", normalStream)) === "stop");
	// 清零后再空 -> 应重新 error
	ck("清零后空响应 → error（计数已重置）", (await run("m1", emptyStream)) === "error");
}

console.log("\n=== 3. 并发隔离 ===");
{
	plugin.resetStreaks?.();
	// 同时跑 20 条：10 个不同模型各 2 次空响应
	const tasks = [];
	for (let i = 0; i < 10; i++) {
		tasks.push(run("conc-" + i, emptyStream));
		tasks.push(run("conc-" + i, emptyStream));
	}
	const results = await Promise.all(tasks);
	// 每个模型：第一次 error、第二次 stop
	let ok = true;
	for (let i = 0; i < 10; i++) {
		const first = results[i * 2], second = results[i * 2 + 1];
		// 注意：并发时顺序不保证，只要求「一 error 一 stop」
		const kinds = [first, second].sort().join(",");
		if (kinds !== "error,stop") { ok = false; console.log(`  conc-${i}: ${first},${second}`); }
	}
	ck("并发 10 模型 × 2 次：计数不串（各得一个 error 一个 stop）", ok, JSON.stringify(results));
}

console.log("\n=== 4. 状态表上界（LRU 淘汰）===");
{
	plugin.resetStreaks?.();
	// 填 100 个模型（超过 MAX_TRACKED_MODELS=64）
	for (let i = 0; i < 100; i++) await run("lr-" + i, emptyStream);
	// 最早的 lr-0 应已被淘汰 -> 再次空响应应 error（当作首次）
	ck("超过上界后最早模型被淘汰 → error", (await run("lr-0", emptyStream)) === "error");
	// 最近的 lr-99 仍在表中 -> 再次空响应应 stop
	ck("最近模型仍在表中 → stop", (await run("lr-99", emptyStream)) === "stop");
}

console.log("\n=== 5. resetStreaks 彻底清理 ===");
{
	plugin.resetStreaks?.();
	await run("reset-me", emptyStream);   // 首次 error
	ck("reset 前第二次 → stop", (await run("reset-me", emptyStream)) === "stop");
	plugin.resetStreaks?.();
	ck("reset 后 → error（当作首次）", (await run("reset-me", emptyStream)) === "error");
}

console.log("\n=== 6. 异常路径不污染状态 ===");
{
	plugin.resetStreaks?.();
	// 抛出异常的流
	const throwingStream = () => (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "x" };
		throw new Error("模拟上游中断");
	})();
	let threw = false;
	try { await run("throw-model", throwingStream); } catch { threw = true; }
	ck("异常流确实抛出了", threw);
	// 该模型的状态不应被"成功"污染：首次空仍应 error
	ck("异常后该模型首次空 → error", (await run("throw-model", emptyStream)) === "error");
}

console.log("\n=== 7. 键构造边界 ===");
{
	plugin.resetStreaks?.();
	// provider/model 缺失
	ck("provider/model 缺失不崩溃", (await (async () => {
		const out = [];
		for await (const c of listener({ messages: [], tools: TOOLS }, emptyStream)) out.push(c);
		return out.find((x) => x.type === "finish")?.reason?.kind;
	})()) === "error");

	// model 含特殊字符（斜杠、空格、中文）
	const weird = ["a/b", "a b", "模型/名", "a\\b", "a:b", ""];
	for (const m of weird) {
		let threw = null;
		try { await run(m, emptyStream); } catch (e) { threw = e.message; }
		ck(`model=${JSON.stringify(m)} 不崩溃`, threw === null, threw ?? "");
	}

	// 不同组合不应冲突
	plugin.resetStreaks?.();
	await run("x", emptyStream, "p1");   // p1/x 首次 error
	const k2 = await run("x", emptyStream, "p2");  // p2/x 应独立 -> error
	ck("provider 不同则键不同（p2/x 首次 → error）", k2 === "error");
}

console.log("\n=== 8. 大量模型下的性能 ===");
{
	plugin.resetStreaks?.();
	const t0 = Date.now();
	for (let i = 0; i < 200; i++) await run("perf-" + i, emptyStream);
	const ms = Date.now() - t0;
	ck("200 个模型顺序处理 < 3 秒（宽松上限，只防状态泄漏导致 O(n²)）", ms < 3000, `${ms}ms`);
	console.log(`      实际耗时: ${ms}ms`);
}

console.log(`\n===== 状态隔离与生命周期: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
