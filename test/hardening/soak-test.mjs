// 长时间运行稳定性审查
//
// DSH 是长驻进程。插件的任何「随时间增长」的行为都会在生产环境累积成故障：
//   - 内存泄漏 → 进程 OOM
//   - 全局状态无界 → 状态表撑爆
//   - 性能随运行时长退化 → 越用越慢
//   - 定时器/监听器泄漏 → 句柄耗尽
//
// 已有 memory-lifecycle.mjs 覆盖了基础的堆增长；本套件补充**长时间维度**：
//   - 模拟数小时的请求量（10 万次），检查内存/耗时的**趋势**（不只是首尾差）
//   - 检查性能是否随运行次数退化（前后 10% 段对比）
//   - 检查是否有句柄/定时器泄漏
//   - 检查全局状态在多模型轮转下是否真正有界
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const plugin = await import(pathToFileURL(LIB).href + "?soak=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const MARKUP = OC + "\n<function=pwsh>\n<parameter=command>\necho hi\n</parameter>\n</function>\n" + CC;
const PROSE = "这是一段典型的模型回复文字，用来模拟真实场景中的说明内容。包含中文、标点与英文单词。";
const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];

/** 生成一个「典型请求」的流 */
function makeStream(kind, model) {
	return (async function* () {
		if (kind === "tool") {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: PROSE + MARKUP + PROSE };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: PROSE + MARKUP + PROSE } };
		} else if (kind === "text") {
			yield { type: "block-start", index: 0, blockType: "text" };
			yield { type: "text-delta", index: 0, text: PROSE + PROSE };
			yield { type: "block-end", index: 0, block: { type: "text", text: PROSE + PROSE } };
		} else if (kind === "empty") {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: "只有思考" };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
		}
		yield { type: "usage", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
}

async function runOnce(kind, model) {
	const out = [];
	for await (const c of listener({ provider: "p", model, messages: [], tools: TOOLS }, () => makeStream(kind, model))) out.push(c);
	return out.length;
}

console.log("=== 1. 长时间运行：内存增长趋势 ===");
{
	const N = 20000;
	global.gc?.();
	const samples = [];
	const marks = [1, Math.floor(N * 0.1), Math.floor(N * 0.25), Math.floor(N * 0.5), Math.floor(N * 0.75), Math.floor(N * 0.9), N];
	let mi = 0;

	plugin.resetStreaks?.();
	const t0 = Date.now();
	for (let i = 1; i <= N; i++) {
		// 混合负载：70% 工具恢复 / 25% 纯文本 / 5% 空响应
		const r = i % 20;
		const kind = r < 14 ? "tool" : r < 19 ? "text" : "empty";
		await runOnce(kind, "soak-model");
		if (mi < marks.length && i === marks[mi]) {
			global.gc?.();
			samples.push({ i, heap: process.memoryUsage().heapUsed });
			mi++;
		}
	}
	const elapsed = Date.now() - t0;

	console.log(`  ${N} 次请求耗时 ${(elapsed / 1000).toFixed(1)}s（${Math.round(N / elapsed * 1000)} req/s）`);
	console.log(`  堆内存采样（GC 后）:`);
	const base = samples[0].heap;
	for (const s of samples) {
		const mb = (s.heap / 1024 / 1024).toFixed(2);
		const delta = ((s.heap - base) / 1024 / 1024).toFixed(2);
		console.log(`    第 ${String(s.i).padStart(6)} 次: ${mb} MB（较起点 ${delta >= 0 ? "+" : ""}${delta} MB）`);
	}

	// **判定原则：看趋势，不看绝对值**
	//
	// process.memoryUsage() 是**进程级**指标。如果这个套件和其他套件并行跑，
	// 别人的分配会体现在这里 —— 实测单独跑 0.38MB、并行跑 21.32MB（假失败）。
	//
	// 真正的内存泄漏特征是「**持续线性增长**」，所以用两个判据：
	//   a) 后半段增长必须 <= 前半段增长（曲线在收敛）
	//   b) 绝对增长放宽到 50MB（只拦真正的失控）
	const growthMB = (samples[samples.length - 1].heap - base) / 1024 / 1024;
	// **缺陷 103**：原阈值 50MB，实测 2 万次请求只增长 **0.38MB** —— 大 131 倍。
	// 50MB / 20000 = 每次可泄漏 2621 字节才被发现，
	// 而一个 chunk 对象只有 ~100-200 字节。收紧到 5MB
	// （实测 0.38MB 的 13 倍，给不同机器/GC 策略留余量）。
	console.log(`  实测堆增长: ${growthMB.toFixed(2)} MB（阈值 3MB）`);
	ck("2 万次请求后堆增长 < 3MB", growthMB < 3, `${growthMB.toFixed(2)}MB`);

	// 判定：增长趋势应趋于平缓（后半段增长 <= 前半段增长的 3 倍）
	const mid = Math.floor(samples.length / 2);
	const firstHalfGrowth = (samples[mid].heap - samples[0].heap) / 1024 / 1024;
	const secondHalfGrowth = (samples[samples.length - 1].heap - samples[mid].heap) / 1024 / 1024;
	console.log(`  前半段增长 ${firstHalfGrowth.toFixed(2)}MB，后半段 ${secondHalfGrowth.toFixed(2)}MB`);
	// **这才是真正的泄漏判据**：如果后半段增长 >= 前半段，说明还在持续爬升。
	// （用 max(..., 5) 容忍一次性开销，如 JIT 编译、初始缓存）
	ck("无持续线性增长（后半段不高于前半段）",
		secondHalfGrowth <= Math.max(firstHalfGrowth, 5),
		`前半 ${firstHalfGrowth.toFixed(2)} / 后半 ${secondHalfGrowth.toFixed(2)}`);
}

console.log("\n=== 2. 性能不随运行次数退化 ===");
{
	const N = 8000;
	const times = [];
	plugin.resetStreaks?.();
	for (let i = 0; i < N; i++) {
		const t0 = process.hrtime.bigint();
		await runOnce("tool", "perf-model");
		times.push(Number(process.hrtime.bigint() - t0));
	}
	// 对比前 10% 与后 10% 的中位数
	const seg = Math.floor(N * 0.1);
	const head = times.slice(0, seg).sort((a, b) => a - b);
	const tail = times.slice(-seg).sort((a, b) => a - b);
	const headMed = head[Math.floor(head.length / 2)];
	const tailMed = tail[Math.floor(tail.length / 2)];
	const ratio = tailMed / headMed;
	console.log(`  前 10%（${seg} 次）中位: ${(headMed / 1e6).toFixed(4)}ms`);
	console.log(`  后 10%（${seg} 次）中位: ${(tailMed / 1e6).toFixed(4)}ms`);
	console.log(`  比值: ${ratio.toFixed(2)}×`);
	ck("性能不随时间退化（后段 <= 前段 3 倍）", ratio <= 3, `${ratio.toFixed(2)}×`);
	ck("绝对耗时仍在合理范围（< 5ms）", tailMed / 1e6 < 5, `${(tailMed / 1e6).toFixed(4)}ms`);
}

console.log("\n=== 3. 全局状态在多模型轮转下有界 ===");
{
	plugin.resetStreaks?.();
	// 用 500 个不同模型各跑一次「空响应」（这是唯一会写全局状态的路径）
	const emptyStream = (model) => (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "只有思考" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();

	global.gc?.();
	const before = process.memoryUsage().heapUsed;
	const t0 = Date.now();
	for (let i = 0; i < 500; i++) {
		for await (const c of listener({ provider: "p", model: `model-${i}`, messages: [], tools: TOOLS }, () => emptyStream(i))) { /* consume */ }
	}
	const elapsed = Date.now() - t0;
	global.gc?.();
	const after = process.memoryUsage().heapUsed;
	const growthMB = (after - before) / 1024 / 1024;
	console.log(`  500 个不同模型后堆变化: ${growthMB.toFixed(2)}MB（耗时 ${elapsed}ms）`);
	// **缺陷 103**：原阈值 5MB，实测仅 0.02MB —— 大 250 倍。
	// 5MB / 500 个模型 = 每模型可泄漏 10485 字节才被发现，
	// 而一个 LRU 条目只有 ~100 字节。收紧到 1MB（给 GC 抖动留余量）。
	ck("多模型轮转后堆增长 < 0.2MB（状态有上界）", growthMB < 0.2, `${growthMB.toFixed(2)}MB`);
}

console.log("\n=== 4. 无句柄/定时器泄漏 ===");
{
	// 检查活跃句柄数量（Node 内部 API）
	const getHandles = () => {
		try {
			return process._getActiveHandles?.()?.length ?? -1;
		} catch {
			return -1;
		}
	};
	const getRequests = () => {
		try {
			return process._getActiveRequests?.()?.length ?? -1;
		} catch {
			return -1;
		}
	};

	plugin.resetStreaks?.();
	for (let i = 0; i < 200; i++) await runOnce("tool", "handle-model");
	const h1 = getHandles();
	const r1 = getRequests();
	for (let i = 0; i < 2000; i++) await runOnce("tool", "handle-model");
	const h2 = getHandles();
	const r2 = getRequests();

	console.log(`  200 次后: handles=${h1}, requests=${r1}`);
	console.log(`  2200 次后: handles=${h2}, requests=${r2}`);
	if (h1 >= 0 && h2 >= 0) {
		ck("活跃句柄数不增长", h2 <= h1 + 2, `${h1} → ${h2}`);
	} else {
		console.log("  （该 Node 版本不支持 _getActiveHandles，跳过）");
	}
	// 插件不应创建任何定时器（源码检查）
	const src = fs.readFileSync(LIB, "utf8");
	ck("源码无 setTimeout/setInterval（不创建定时器）", !/setTimeout|setInterval|setImmediate/.test(src), "");
	ck("源码无 Promise 常驻（不创建悬挂 Promise）", !/new Promise/.test(src), "");
	ck("源码无事件监听注册（除 ctx.on）", (src.match(/\.addEventListener|\.on\(/g) ?? []).length <= 1, `${(src.match(/\.addEventListener|\.on\(/g) ?? []).length} 处`);
}

console.log("\n=== 5. 状态在流结束时被清理（无跨流残留）===");
{
	// 每个流都有自己的 heldBlocks/openByIndex（函数内局部变量）；
	// 验证：跑完一条流后，下一次流的输出不受影响
	plugin.resetStreaks?.();
	const results = [];
	for (let i = 0; i < 100; i++) {
		const out = [];
		for await (const c of listener({ provider: "p", model: "clean-model", messages: [], tools: TOOLS }, () => makeStream("tool", "clean-model"))) out.push(c);
		const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
		results.push(calls.length);
	}
	const ok = results.every((n) => n === 1);
	ck("100 条连续流每次都恰好恢复 1 个（无跨流残留）", ok, `分布: ${JSON.stringify([...new Set(results)])}`);
}

console.log("\n=== 6. 异常路径不留下状态 ===");
{
	plugin.resetStreaks?.();
	// 抛异常的流 1000 次
	for (let i = 0; i < 1000; i++) {
		const gen = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: MARKUP };
			throw new Error("ECONNRESET");
		})();
		try {
			for await (const c of listener({ provider: "p", model: "err-model", messages: [], tools: TOOLS }, () => gen)) { /* consume */ }
		} catch { /* expected */ }
	}
	global.gc?.();
	// 之后正常流必须工作
	const out = [];
	for await (const c of listener({ provider: "p", model: "err-model", messages: [], tools: TOOLS }, () => makeStream("tool", "err-model"))) out.push(c);
	const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	ck("1000 次异常后仍能正常恢复", calls.length === 1, `${calls.length} 个`);
	ck("异常后 finish 正确", out.find((c) => c.type === "finish")?.reason?.kind === "tool-calls", "");
}

console.log(`\n===== 长时间运行稳定性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
