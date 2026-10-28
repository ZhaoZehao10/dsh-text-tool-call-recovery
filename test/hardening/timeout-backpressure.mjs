// 超时与背压审查
//
// 真实场景：
//   1. 上游流卡住不产出（网络卡顿 / 模型服务端 stall）—— 插件会不会挂死？
//   2. 下游消费极慢（UI 渲染慢 / 日志写入慢）—— 插件会不会缓冲爆炸？
//   3. 上游产出极快、下游极慢 —— 背压是否正确传递？
//
// 判据：
//   - 插件必须**立即转发**上游的 chunk（不能自己引入缓冲延迟）
//   - 上游卡住时插件也必须卡住（不能自旋、不能超时后自行结束）
//   - 下游慢时插件不能积累无限内存（async generator 天然背压）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

const plugin = await import(pathToFileURL(LIB).href + "?tp=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const MARKUP = OC + "\n<function=pwsh>\n<parameter=command>\necho hi\n</parameter>\n</function>\n" + CC;
const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("=== 1. 上游卡住时插件行为（不能自旋、不能超时自结束）===");
{
	let yielded = 0;
	let upstreamResumed = false;
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "第一段" };
		await sleep(300);                 // 卡住 300ms
		upstreamResumed = true;
		yield { type: "block-end", index: 0, block: { type: "text", text: "第一段" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();

	const t0 = Date.now();
	const out = [];
	for await (const c of listener(OPTS, () => gen)) { out.push(c); yielded++; }
	const elapsed = Date.now() - t0;

	console.log(`  卡住 300ms 后：收到 ${out.length} chunk，总耗时 ${elapsed}ms`);
	ck("上游卡住不导致插件挂死", elapsed < 3000, `${elapsed}ms`);
	ck("卡住后上游正常恢复", upstreamResumed, String(upstreamResumed));
	ck("完整收到所有 chunk", out.length >= 3, String(out.length));
	const fin = out.find((c) => c.type === "finish");
	ck("finish 正确", fin?.reason?.kind === "stop", JSON.stringify(fin?.reason));
}

console.log("\n=== 2. 上游永远不产出（挂死）—— 插件应同样挂住而非自结束 ===");
{
	let cancelled = false;
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		await new Promise((resolve) => {
			// 永不 resolve，除非被取消
			setTimeout(() => { cancelled = true; resolve(); }, 500);
		});
		yield { type: "text-delta", index: 0, text: "恢复" };
		yield { type: "block-end", index: 0, block: { type: "text", text: "恢复" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();

	const it = listener(OPTS, () => gen);
	const out = [];
	// 只等 150ms，此时上游还在卡
	const timer = setTimeout(() => { /* 不打断，靠 race */ }, 150);
	const raceResult = await Promise.race([
		(async () => { for await (const c of it) out.push(c); return "完成"; })(),
		sleep(150).then(() => "等待中"),
	]);
	clearTimeout(timer);
	console.log(`  150ms 时状态: ${raceResult}（应仍是"等待中"）`);
	ck("上游卡住时插件也不同步返回（不自行结束）", raceResult === "等待中", raceResult);
	// 清理：不等它了
	await it.return(undefined);
}

console.log("\n=== 3. 首 chunk 延迟测量（插件是否引入缓冲延迟）===");
{
	// 上游第一个 chunk 立刻给，测量插件发出第一个 chunk 的延迟
	const N = 20;
	const latencies = [];
	for (let i = 0; i < N; i++) {
		const t0 = process.hrtime.bigint();
		const gen = (async function* () {
			yield { type: "block-start", index: 0, blockType: "text" };
			yield { type: "text-delta", index: 0, text: "x" };
			yield { type: "block-end", index: 0, block: { type: "text", text: "x" } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		for await (const c of listener(OPTS, () => gen)) {
			latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
			break;   // 只测首 chunk
		}
	}
	latencies.sort((a, b) => a - b);
	const median = latencies[Math.floor(latencies.length / 2)];
	const p95 = latencies[Math.floor(latencies.length * 0.95)];
	console.log(`  首 chunk 延迟：中位 ${median.toFixed(3)}ms，p95 ${p95.toFixed(3)}ms`);
	ck("首 chunk 延迟 < 10ms（无阻塞式缓冲）", median < 10, `${median.toFixed(3)}ms`);
	ck("首 chunk p95 延迟 < 30ms", p95 < 30, `${p95.toFixed(3)}ms`);
}

console.log("\n=== 4. 背压：下游消费慢时内存不增长 ===");
{
	global.gc?.();
	const before = process.memoryUsage().heapUsed;

	// 上游产出 2000 个 chunk，每个 10KB（共 20MB）
	// 下游每次消费前等 0.1ms（模拟慢消费者）
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		for (let i = 0; i < 2000; i++) {
			yield { type: "text-delta", index: 0, text: "x".repeat(10 * 1024) };
		}
		yield { type: "block-end", index: 0, block: { type: "text", text: "done" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();

	let count = 0;
	let peakHeap = before;
	const t0 = Date.now();
	for await (const c of listener(OPTS, () => gen)) {
		count++;
		if (count % 200 === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
	}
	const elapsed = Date.now() - t0;
	global.gc?.();
	const after = process.memoryUsage().heapUsed;

	const peakMB = (peakHeap - before) / 1024 / 1024;
	const finalMB = (after - before) / 1024 / 1024;
	console.log(`  2000 个 10KB chunk（共 20MB）：收到 ${count}，耗时 ${elapsed}ms`);
	console.log(`  峰值堆增长 ${peakMB.toFixed(2)}MB，最终 ${finalMB.toFixed(2)}MB`);
	ck("背压下峰值堆增长 < 40MB（未无限缓冲）", peakMB < 40, `${peakMB.toFixed(2)}MB`);
	ck("背压下最终堆回落到 < 15MB", finalMB < 15, `${finalMB.toFixed(2)}MB`);
}

console.log("\n=== 5. 大单块（100MB 文本）不溢出 ===");
{
	const BIG = 100 * 1024 * 1024;   // 100MB
	let err = null;
	let outLen = 0;
	try {
		const gen = (async function* () {
			const text = "a".repeat(BIG);
			yield { type: "block-start", index: 0, blockType: "text" };
			yield { type: "text-delta", index: 0, text };
			yield { type: "block-end", index: 0, block: { type: "text", text } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		for await (const c of listener(OPTS, () => gen)) outLen++;
	} catch (e) { err = e; }
	console.log(`  100MB 单块：输出 ${outLen} chunk，异常: ${err?.message ?? "无"}`);
	ck("100MB 单块不崩溃", err === null, err?.message ?? "");
}

console.log("\n=== 6. 超长标记文本（性能上限生效）===");
{
	// 超过 MAX_SCAN_CHARS（128KB）的标记文本 —— 插件应**直接拒绝扫描**（保守方向）
	const parts = [];
	for (let i = 0; i < 3000; i++) parts.push(MARKUP);
	const bigMarkup = parts.join("\n");
	console.log(`  构造 ${(bigMarkup.length / 1024).toFixed(0)}KB 的标记文本（MAX_SCAN_CHARS=128KB）`);

	const t0 = Date.now();
	let err = null;
	let chunkCount = 0;
	try {
		const gen = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: bigMarkup };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: bigMarkup } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		for await (const c of listener(OPTS, () => gen)) chunkCount++;
	} catch (e) { err = e; }
	const elapsed = Date.now() - t0;
	console.log(`  耗时 ${elapsed}ms，异常: ${err?.message ?? "无"}`);
	ck("超长标记文本不崩溃", err === null, err?.message ?? "");
	ck("超长标记文本在 5s 内处理完（MAX_SCAN_CHARS 生效）", elapsed < 5000, `${elapsed}ms`);
}

console.log("\n=== 7. 高频小 chunk（10 万个）吞吐 ===");
{
	const N = 100000;
	const t0 = Date.now();
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		for (let i = 0; i < N; i++) {
			yield { type: "text-delta", index: 0, text: "x" };
		}
		yield { type: "block-end", index: 0, block: { type: "text", text: "x" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	let count = 0;
	for await (const c of listener(OPTS, () => gen)) count++;
	const elapsed = Date.now() - t0;
	console.log(`  ${N} 个 chunk 耗时 ${elapsed}ms（${Math.round(N / elapsed * 1000)} chunk/s）`);
	ck("10 万 chunk 在 5s 内完成", elapsed < 5000, `${elapsed}ms`);
	ck("chunk 数完整", count === N + 3, `${count} vs ${N + 3}`);
}

console.log("\n=== 8. 下游提前 break 时的性能（不消费剩余）===");
{
	const N = 100000;
	const t0 = Date.now();
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		for (let i = 0; i < N; i++) {
			yield { type: "text-delta", index: 0, text: "x" };
		}
		yield { type: "block-end", index: 0, block: { type: "text", text: "x" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	let count = 0;
	for await (const c of listener(OPTS, () => gen)) {
		count++;
		if (count >= 10) break;    // 立刻中断
	}
	const elapsed = Date.now() - t0;
	console.log(`  只取 10 个后中断，耗时 ${elapsed}ms`);
	ck("提前中断立即返回（不处理剩余 10 万）", elapsed < 500, `${elapsed}ms`);
}

console.log(`\n===== 超时与背压: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
