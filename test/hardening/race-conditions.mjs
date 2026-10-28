// 并发竞态补充测试
//
// **为什么需要**：现有 `concurrency.mjs`（6 项）和 `state-isolation.mjs`（24 项）
// 覆盖了「不同模型并发」，但**没有覆盖以下三个高风险场景**：
//
//   1. **同一模型的多条流同时触发安全网** —— 共享的 `emptyResponseStreak`
//      会不会出现「全部 error」（计数丢失）或「全部 stop」（计数爆炸）？
//   2. **空响应流与正常流交错** —— 正常流会 `delete(modelKey)`，
//      可能抹掉并发空响应流刚累加的计数。
//   3. **并发中调用 `resetStreaks`** —— 最容易出竞态的操作。
//
// 另加 100 条流压测，验证高并发下状态仍一致。
//
// **第 62 轮实测结果**：全部正确，无竞态。
//   - 同模型 3 条并发 → ["error","stop","stop"]（streak 正确累积）
//   - 混合 → 正常流全部 tool-calls，空响应至少一条 error
//   - 100 条 → 66 恢复 / 34 空响应，零异常
//   - 并发中 reset → 无异常，结果都是合法 finish
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const MARKUP = OC + "\n<function=pwsh>\n<parameter=command>echo hi\n</parameter>\n</function>\n" + CC;

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const plugin = await import(pathToFileURL(LIB).href + "?race=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

function mkStream(kind) {
	if (kind === "empty") {
		return (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: "只有思考" };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
	}
	const text = "思考 " + MARKUP;
	return (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
}

async function consume(options, stream) {
	const out = [];
	for await (const c of listener(options, () => stream)) out.push(c);
	const fin = out.find((c) => c.type === "finish");
	return {
		kind: fin?.reason?.kind,
		code: fin?.reason?.failure?.code,
		calls: out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").length,
	};
}

// ===========================================================================
// 1. 同一模型的多条流**同时**触发安全网
// ===========================================================================
console.log("=== 1. 同一模型 3 条空响应并发 ===");
{
	plugin.resetStreaks?.();
	const model = "same-model-" + Date.now();
	const opts = { provider: "p", model, messages: [], tools: TOOLS };

	const results = await Promise.all([
		consume(opts, mkStream("empty")),
		consume(opts, mkStream("empty")),
		consume(opts, mkStream("empty")),
	]);

	const kinds = results.map((r) => r.kind);
	const errCount = kinds.filter((k) => k === "error").length;
	console.log(`  结果: ${JSON.stringify(kinds)}（error ${errCount}）`);

	ck("至少一条返回 error（安全网在并发下生效）", errCount >= 1, `error ${errCount}`);
	ck("不会全部返回 error（streak 累积未被并发丢失）", errCount < 3, `error ${errCount}`);
	ck("所有结果都是合法 finish",
		kinds.every((k) => k === "error" || k === "stop"), JSON.stringify(kinds));
}

// ===========================================================================
// 2. 空响应流与正常流交错（正常流会 delete(modelKey)）
// ===========================================================================
console.log("\n=== 2. 空响应流与正常流并发（同一模型）===");
{
	plugin.resetStreaks?.();
	const model = "mixed-model-" + Date.now();
	const opts = { provider: "p", model, messages: [], tools: TOOLS };

	const results = await Promise.all([
		consume(opts, mkStream("empty")),
		consume(opts, mkStream("normal")),
		consume(opts, mkStream("empty")),
		consume(opts, mkStream("normal")),
	]);

	console.log(`  结果: ${JSON.stringify(results.map((r) => ({ k: r.kind, c: r.calls })))}`);

	// 正常流必须仍然恢复出调用
	const normalResults = [results[1], results[3]];
	ck("正常流仍能恢复调用（并发不受干扰）",
		normalResults.every((r) => r.calls === 1),
		JSON.stringify(normalResults.map((r) => r.calls)));

	// 空响应流：至少一条 error
	const emptyResults = [results[0], results[2]];
	ck("至少一条空响应触发安全网",
		emptyResults.some((r) => r.kind === "error"),
		JSON.stringify(emptyResults.map((r) => r.kind)));
}

// ===========================================================================
// 3. 100 条流并发压测
// ===========================================================================
console.log("\n=== 3. 100 条流并发压测（10 个模型轮转）===");
{
	plugin.resetStreaks?.();
	const tasks = [];
	const kindsOfStream = [];
	for (let i = 0; i < 100; i++) {
		const model = `stress-${i % 10}`;
		const kind = i % 3 === 0 ? "empty" : "normal";
		kindsOfStream.push(kind);
		tasks.push(consume({ provider: "p", model, messages: [], tools: TOOLS }, mkStream(kind)));
	}
	const results = await Promise.all(tasks);

	const expectedNormal = kindsOfStream.filter((k) => k === "normal").length;
	const normalCount = results.filter((r) => r.calls === 1).length;
	console.log(`  100 条流完成：恢复出调用 ${normalCount} 条（期望 ${expectedNormal} 条）`);

	ck("压测下所有正常流都恢复出调用", normalCount === expectedNormal,
		`恢复 ${normalCount}，期望 ${expectedNormal}`);
	ck("没有流产生非法 finish",
		results.every((r) => r.kind === "error" || r.kind === "stop" || r.kind === "tool-calls"),
		JSON.stringify([...new Set(results.map((r) => r.kind))]));
}

// ===========================================================================
// 4. 并发中调用 resetStreaks（最容易出竞态）
// ===========================================================================
console.log("\n=== 4. 并发与 resetStreaks 交错 ===");
{
	plugin.resetStreaks?.();
	const model = "reset-race-" + Date.now();
	const opts = { provider: "p", model, messages: [], tools: TOOLS };

	const promises = [];
	for (let i = 0; i < 5; i++) promises.push(consume(opts, mkStream("empty")));
	plugin.resetStreaks?.();   // 立刻 reset

	let threw = false;
	let results;
	try {
		results = await Promise.all(promises);
	} catch (e) {
		threw = true;
		console.log(`  ❌ 抛异常: ${e.message}`);
	}

	ck("并发中调用 resetStreaks 不抛异常", !threw, "");
	if (!threw) {
		console.log(`  结果: ${JSON.stringify(results.map((r) => r.kind))}`);
		ck("结果都是合法 finish",
			results.every((r) => r.kind === "error" || r.kind === "stop"),
			JSON.stringify(results.map((r) => r.kind)));
	}

	// **关键补充（第 62 轮验证发现）**：必须验证 resetStreaks **真的清空了状态**，
	// 否则把它改成空操作时本套件测不出来（变异测试暴露了这个盲区）。
	plugin.resetStreaks?.();
	const afterReset = await consume(opts, mkStream("empty"));
	console.log(`  reset 后再空响应: kind=${afterReset.kind}`);
	ck("resetStreaks 后同一模型重新变「首次」（返回 error）",
		afterReset.kind === "error", `kind=${afterReset.kind}`);

	// 第二次应回到 stop（证明计数器确实从 1 重新开始）
	const afterReset2 = await consume(opts, mkStream("empty"));
	ck("reset 后第二次空响应返回 stop（计数从 1 重新开始）",
		afterReset2.kind === "stop", `kind=${afterReset2.kind}`);
}

// ===========================================================================
// 5. 并发下不同模型完全隔离
// ===========================================================================
console.log("\n=== 5. 并发下不同模型完全隔离 ===");
{
	plugin.resetStreaks?.();
	const models = ["iso-a", "iso-b", "iso-c", "iso-d", "iso-e"];
	// 每个模型都发一次空响应（首次 → 应全部 error）
	const first = await Promise.all(models.map((m) =>
		consume({ provider: "p", model: m, messages: [], tools: TOOLS }, mkStream("empty"))));
	console.log(`  首次: ${JSON.stringify(first.map((r) => r.kind))}`);
	ck("5 个不同模型首次空响应全部 error（隔离正确）",
		first.every((r) => r.kind === "error"), JSON.stringify(first.map((r) => r.kind)));

	// 第二次 → 应全部 stop
	const second = await Promise.all(models.map((m) =>
		consume({ provider: "p", model: m, messages: [], tools: TOOLS }, mkStream("empty"))));
	console.log(`  第二次: ${JSON.stringify(second.map((r) => r.kind))}`);
	ck("5 个不同模型第二次全部 stop（不空转）",
		second.every((r) => r.kind === "stop"), JSON.stringify(second.map((r) => r.kind)));
}

// ===========================================================================
// 6. 并发下 LRU 淘汰仍然生效（变异测试发现的盲区）
//
// **第 62 轮**：把淘汰条件改成 `if (false)` 时，本套件原本**测不出来** ——
// 因为前面的用例最多只用 10 个模型，淘汰分支从未触发。
// ===========================================================================
console.log("\n=== 6. 并发下 LRU 淘汰仍生效 ===");
{
	// 从源码读取上限，避免硬编码
	const libSrc = fs.readFileSync(LIB, "utf8");
	const mm = libSrc.match(/const MAX_TRACKED_MODELS\s*=\s*(\d+);/);
	const LIMIT = mm ? Number(mm[1]) : 64;
	console.log(`  MAX_TRACKED_MODELS = ${LIMIT}`);

	// **并发**填充超过上限的模型（区别于 state-isolation 的串行填充）
	plugin.resetStreaks?.();
	const fillCount = LIMIT + 8;
	const tasks = [];
	for (let i = 0; i < fillCount; i++) {
		tasks.push(consume({ provider: "p", model: `lru-c-${i}`, messages: [], tools: TOOLS }, mkStream("empty")));
	}
	await Promise.all(tasks);
	console.log(`  并发填充 ${fillCount} 个模型（上限 ${LIMIT}）`);

	// 最早的 lru-c-0 应已被淘汰 → 重新计数 → error
	const oldest = await consume({ provider: "p", model: "lru-c-0", messages: [], tools: TOOLS }, mkStream("empty"));
	console.log(`  最早模型 lru-c-0 再访问: kind=${oldest.kind}`);
	ck("并发超限后最早模型被淘汰（LRU 生效）", oldest.kind === "error", `kind=${oldest.kind}`);

	// 最新的应还在表中 → stop
	const newest = await consume({ provider: "p", model: `lru-c-${fillCount - 1}`, messages: [], tools: TOOLS }, mkStream("empty"));
	console.log(`  最新模型 lru-c-${fillCount - 1} 再访问: kind=${newest.kind}`);
	ck("最新模型未被淘汰", newest.kind === "stop", `kind=${newest.kind}`);
}

// ===========================================================================
// 7. 真正的 LRU 语义（区分 LRU 与 FIFO）
//
// **缺陷 53**（第 62 轮变异测试发现）：删掉 `emptyResponseStreak.delete(key)`
// 后本套件仍然通过 —— 说明「LRU 顺序」从未被验证过。
//
// `delete` + `set` 的作用是把 key 移到 Map 末尾（= 最近访问）。
// 删掉 delete 就退化成 FIFO（按首次插入顺序淘汰）。
//
// 区分方法：
//   1. 填满 LIMIT 个模型
//   2. **重新访问 m0**（LRU 应把它移到末尾）
//   3. 再加入 1 个（触发淘汰）
//   4. LRU → 淘汰 m1，m0 仍在（返回 stop）
//      FIFO → 淘汰 m0（返回 error）
// ===========================================================================
console.log("\n=== 7. 真正的 LRU 语义（区分 LRU 与 FIFO）===");
{
	const libSrc2 = fs.readFileSync(LIB, "utf8");
	const mm2 = libSrc2.match(/const MAX_TRACKED_MODELS\s*=\s*(\d+);/);
	const LIMIT = mm2 ? Number(mm2[1]) : 64;

	plugin.resetStreaks?.();
	const opts = { provider: "p", messages: [], tools: TOOLS };

	// 1) 填满 LIMIT 个模型（每个 streak=1）
	for (let i = 0; i < LIMIT; i++) {
		await consume({ ...opts, model: `lru2-${i}` }, mkStream("empty"));
	}
	console.log(`  已填充 ${LIMIT} 个模型`);

	// 2) 重新访问 m0 → LRU 应把它移到末尾
	const touch = await consume({ ...opts, model: "lru2-0" }, mkStream("empty"));
	console.log(`  重新访问 lru2-0: kind=${touch.kind}（应为 stop，streak=2）`);
	ck("重新访问 m0 后 streak 变成 2", touch.kind === "stop", `kind=${touch.kind}`);

	// 3) 加入新模型触发淘汰
	await consume({ ...opts, model: "lru2-trigger" }, mkStream("empty"));
	console.log(`  加入 lru2-trigger（触发淘汰）`);

	// 4) **关键判据**：m0 是否还在？
	//    LRU  → m0 刚被访问过，不会被淘汰 → 返回 stop
	//    FIFO → m0 是最早插入的，会被淘汰 → 返回 error
	const m0 = await consume({ ...opts, model: "lru2-0" }, mkStream("empty"));
	console.log(`  lru2-0 最终状态: kind=${m0.kind}`);
	ck("LRU 语义：刚访问过的模型不被淘汰（区分 LRU 与 FIFO）",
		m0.kind === "stop",
		`kind=${m0.kind}（error 说明退化成了 FIFO）`);

	// 5) 对照：m1（最久未访问）应已被淘汰
	const m1 = await consume({ ...opts, model: "lru2-1" }, mkStream("empty"));
	console.log(`  lru2-1（最久未访问）: kind=${m1.kind}`);
	ck("LRU 语义：最久未访问的模型被淘汰", m1.kind === "error", `kind=${m1.kind}`);
}

console.log(`\n===== 并发竞态补充: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
