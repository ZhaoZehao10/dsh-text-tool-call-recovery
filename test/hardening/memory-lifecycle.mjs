// 内存与生命周期审查
//
// 插件运行在宿主进程内且长期不退出。若内部状态随流数量无限增长，
// 长时间运行会 OOM。本测试系统检查：
//   1. 每次流结束后，per-stream 状态是否释放（heldBlocks / openByIndex）
//   2. 全局 Map（emptyResponseStreak）是否有上界
//   3. 大量流连续处理后堆内存不持续增长
//   4. 异常/中断的流不残留状态
//   5. 插件不持有 chunk/block 的强引用（否则会把整个会话历史留在内存）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

// 各种规模的流
const mkStream = (n, kind = "text") => (async function* () {
	if (kind === "text") {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "x".repeat(n) };
		yield { type: "block-end", index: 0, block: { type: "text", text: "x".repeat(n) } };
	} else if (kind === "markup") {
		const markup = OC + "\n<function=pwsh>\n<parameter=command>\n" + "y".repeat(n) + "\n</parameter>\n</function>\n" + CC;
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: markup };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
	} else if (kind === "multi") {
		// 多块
		for (let i = 0; i < n; i++) {
			yield { type: "block-start", index: i, blockType: "text" };
			yield { type: "text-delta", index: i, text: "blk" + i };
			yield { type: "block-end", index: i, block: { type: "text", text: "blk" + i } };
		}
	}
	yield { type: "finish", reason: { kind: "stop" } };
})();

async function runOnce(model = "m") {
	const out = [];
	for await (const c of listener({ ...OPTS, model }, () => mkStream(100))) out.push(c);
	return out;
}

console.log("=== 1. 大量流后堆内存不持续增长 ===");
{
	plugin.resetStreaks?.();
	// 预热
	for (let i = 0; i < 200; i++) await runOnce("m");
	global.gc?.();
	const before = process.memoryUsage().heapUsed;
	// 跑 3000 条流
	for (let i = 0; i < 3000; i++) await runOnce("m");
	global.gc?.();
	const after = process.memoryUsage().heapUsed;
	const deltaMB = (after - before) / 1024 / 1024;
	console.log(`  3000 条流前后堆变化: ${deltaMB.toFixed(2)} MB`);
	// 允许小幅增长（V8 内部结构），但不应线性增长
	// **缺陷 103**：阈值原为 20MB，实测仅 0.47MB —— 比实测大 42 倍。
	// 20MB / 3000 条流 = 每流可泄漏 6990 字节才被发现，
	// 而一个 block 对象只有 ~500 字节 —— 泄漏一整个 block 也测不出来。
	// 收紧到 1.5MB（基线 × 3 + 1MB GC 余量）。
	console.log(`  实测堆变化: ${deltaMB.toFixed(2)} MB（阈值 1.5MB）`);
	ck("3000 条流后堆增长 < 1.5MB", deltaMB < 1.5, `${deltaMB.toFixed(2)}MB`);
}

console.log("\n=== 2. 大块流不残留（每流 500KB 文本）===");
{
	plugin.resetStreaks?.();
	for (let i = 0; i < 50; i++) await runOnce("m");  // 预热
	global.gc?.();
	const before = process.memoryUsage().heapUsed;
	// 50 条 × 500KB = 25MB 数据流过
	for (let i = 0; i < 50; i++) {
		const out = [];
		for await (const c of listener(OPTS, () => mkStream(500 * 1024))) out.push(c);
	}
	global.gc?.();
	const after = process.memoryUsage().heapUsed;
	const deltaMB = (after - before) / 1024 / 1024;
	console.log(`  50 条 500KB 流后堆变化: ${deltaMB.toFixed(2)} MB（流过数据共 25MB）`);
	// **缺陷 103**：原阈值 25MB 太宽（实测 0.47MB），收紧到 1.5MB。
	ck("大块流不残留（增长 < 1.5MB）", deltaMB < 1.5, `${deltaMB.toFixed(2)}MB`);
}

console.log("\n=== 3. 含标记的流（会扣留块）不残留 ===");
{
	plugin.resetStreaks?.();
	for (let i = 0; i < 100; i++) {
		const out = [];
		for await (const c of listener(OPTS, () => mkStream(1000, "markup"))) out.push(c);
	}
	global.gc?.();
	const before = process.memoryUsage().heapUsed;
	for (let i = 0; i < 500; i++) {
		const out = [];
		for await (const c of listener(OPTS, () => mkStream(1000, "markup"))) out.push(c);
	}
	global.gc?.();
	const after = process.memoryUsage().heapUsed;
	const deltaMB = (after - before) / 1024 / 1024;
	console.log(`  500 条含标记流后堆变化: ${deltaMB.toFixed(2)} MB`);
	// **缺陷 103**：原阈值 20MB 太宽（实测 0.05MB），收紧到 1MB。
	ck("扣留块不残留（增长 < 0.5MB）", deltaMB < 0.5, `${deltaMB.toFixed(2)}MB`);
}

console.log("\n=== 4. 中断的流不残留状态 ===");
{
	plugin.resetStreaks?.();
	// 抛出异常的流 500 次
	for (let i = 0; i < 500; i++) {
		const src = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: "x" };
			throw new Error("中断");
		})();
		try {
			for await (const c of listener(OPTS, () => src)) { /* consume */ }
		} catch { /* expected */ }
	}
	global.gc?.();
	const m1 = process.memoryUsage().heapUsed;
	// 再跑 500 次，看是否线性增长
	for (let i = 0; i < 500; i++) {
		const src = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: "x" };
			throw new Error("中断");
		})();
		try {
			for await (const c of listener(OPTS, () => src)) { /* consume */ }
		} catch { /* expected */ }
	}
	global.gc?.();
	const m2 = process.memoryUsage().heapUsed;
	const deltaMB = (m2 - m1) / 1024 / 1024;
	console.log(`  又 500 次中断后堆变化: ${deltaMB.toFixed(2)} MB`);
	// **缺陷 103**：原阈值 10MB 太宽（实测 ~0MB，500 次中断），
	// 10MB / 500 = 每次可泄漏 20971 字节。收紧到 1MB。
	ck("中断流不残留（增长 < 1MB）", deltaMB < 1, `${deltaMB.toFixed(2)}MB`);
}

console.log("\n=== 5. emptyResponseStreak 有上界（直接数条目，不看堆内存）===");
{
	// **缺陷 102**：原来这里断言的是「500 个模型后堆增长 < 10MB」。
	// 但实测每个 LRU 条目只存一个小的模型名 + 整数计数（约 100 字节），
	// 500 个条目合计仅 **0.048 MB** —— 远小于 10MB 阈值。
	// 也就是说 **LRU 即使完全没有上限，这个断言也会通过**（假通过）。
	//
	// 正确做法：**直接数还在 Map 里的条目**。通过「再跑一次空响应」的行为
	// 推断：仍在 Map（streak=2）→ 透传（无 error）；已被淘汰（streak=1）→ 重新 error。
	plugin.resetStreaks?.();
	const emptyStream = () => (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "只有思考" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();

	const N = 200;
	for (let i = 0; i < N; i++) {
		for await (const c of listener({ ...OPTS, model: "mem-model-" + i }, emptyStream)) { /* consume */ }
	}

	let stillInMap = 0;
	for (let i = 0; i < N; i++) {
		const out = [];
		for await (const c of listener({ ...OPTS, model: "mem-model-" + i }, emptyStream)) out.push(c);
		const hasError = out.some((c) => c.type === "finish" && c.reason?.kind === "error");
		if (!hasError) stillInMap++;
	}

	console.log(`  ${N} 个模型后，仍留在 Map 中: ${stillInMap} 个（上限应为 64）`);
	// **注意**：跑 N=200 个模型后，最早的那些**全部被淘汰**（上限 64），
	// 所以第二轮的「仍在 Map 中」会接近 0 —— 这是**正确行为**，不是缺陷。
	// 真正要断言的是：**上限生效**（≤ 64），以及**最近的 64 个确实还在**。
	ck("LRU 条目数不超过 64（直接计数，不靠堆内存）", stillInMap <= 64, `实际 ${stillInMap} 个`);

	// 单独验证「最近的模型仍在 Map 中」：只跑 10 个模型（< 64），再各跑一次
	plugin.resetStreaks?.();
	const recentModels = Array.from({ length: 10 }, (_, i) => "recent-" + i + "-" + Date.now());
	for (const m of recentModels) {
		for await (const c of listener({ ...OPTS, model: m }, emptyStream)) { /* consume */ }
	}
	let recentStillInMap = 0;
	for (const m of recentModels) {
		const out = [];
		for await (const c of listener({ ...OPTS, model: m }, emptyStream)) out.push(c);
		if (!out.some((c) => c.type === "finish" && c.reason?.kind === "error")) recentStillInMap++;
	}
	ck("少于上限时条目都保留（10 个模型全部在 Map 中）", recentStillInMap === 10, `${recentStillInMap}/10`);

	// 另外仍然保留一个宽松的堆内存冒烟检查（防止每条目占大对象）
	global.gc?.();
	const before2 = process.memoryUsage().heapUsed;
	for (let i = 0; i < 200; i++) {
		for await (const c of listener({ ...OPTS, model: "mem2-" + i }, emptyStream)) { /* consume */ }
	}
	global.gc?.();
	const delta2 = (process.memoryUsage().heapUsed - before2) / 1024 / 1024;
	console.log(`  再 200 个模型后堆变化: ${delta2.toFixed(2)} MB`);
	ck("堆增长仍在合理范围（< 10MB）", delta2 < 10, `${delta2.toFixed(2)}MB`);
}

console.log("\n=== 6. 不持有 chunk 强引用 ===");
{
	// 用 WeakRef 检查：流结束后 chunk 是否可被回收
	plugin.resetStreaks?.();
	let weakRefs = [];
	for (let i = 0; i < 20; i++) {
		const bigText = "z".repeat(100000);
		const chunk = { type: "block-end", index: 0, block: { type: "text", text: bigText } };
		weakRefs.push(new WeakRef(chunk));
		const src = (async function* () {
			yield { type: "block-start", index: 0, blockType: "text" };
			yield { type: "text-delta", index: 0, text: bigText };
			const c2 = { ...chunk };
			yield c2;
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		for await (const c of listener(OPTS, () => src)) { /* consume */ }
	}
	// 强制 GC 多次
	for (let i = 0; i < 5; i++) { global.gc?.(); await new Promise((r) => setTimeout(r, 10)); }
	const alive = weakRefs.filter((w) => w.deref() !== undefined).length;
	console.log(`  20 个 100KB chunk 中仍存活: ${alive} 个`);
	// 若能回收大部分，说明插件没持有强引用
	// **注意**：WeakRef 的回收需要 V8 真正执行 GC，单次 global.gc() 不一定够。
	// 这里多跑几次 GC 并用 setImmediate 让微任务队列清空，再做判定。
	for (let round = 0; round < 5; round++) {
		global.gc?.();
		await new Promise((r) => setImmediate(r));
	}
	const alive2 = weakRefs.filter((w) => w.deref() !== undefined).length;
	// **关键是趋势**：至少大部分应被回收。若全部存活，说明确实持有强引用。
	ck("插件不持有 chunk 强引用（多数已被回收）", alive2 <= 5, `${alive2}/20 个仍存活`);
}

console.log(`\n===== 内存与生命周期: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
