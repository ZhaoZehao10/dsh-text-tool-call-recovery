// 性能基线回归
//
// 目的：把性能特征固化成**可回归的断言**，防止未来改动引入性能退化。
// 不用绝对时间（受机器影响），而用**结构性判据**：
//   1. 代表性场景必须在合理上限内（宽松阈值，只抓严重退化）
//   2. 每 KB 成本必须随规模**不上升**（抓 O(n²) 退化）
//   3. 块数量成本必须大致线性（抓按块数的平方级开销）
//   4. 插件开销相对无插件必须可控（抓意外引入的重计算）
//
// 基线数据（实测，Node 25 / 本机）：
//   典型回复 600B+1调用   : 0.020ms
//   长回复 20KB+1调用     : 0.090ms
//   每 KB 成本 64KB       : 0.007ms（随规模下降）
//   吞吐（2 字符 chunk）  : 约 100 万 chunk/s
//   插件开销（vs 无插件） : +0.018ms
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const plugin = await import(pathToFileURL(LIB).href + "?perfbase=" + Date.now());

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const mkCall = (cmd) => OC + "\n<function=pwsh>\n<parameter=command>\n" + cmd + "\n</parameter>\n</function>\n" + CC;
const PROSE = "这是一段典型的模型回复文字，用来模拟真实场景中的说明内容。包含中文与标点，以及英文词和 `code`。";
const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };

function makeStream(spec) {
	return (async function* () {
		for (const s of spec) {
			yield { type: "block-start", index: s.index, blockType: s.kind };
			// 流式切片，更接近真实
			for (let i = 0; i < s.text.length; i += 50) {
				yield { type: s.kind === "text" ? "text-delta" : "reasoning-delta", index: s.index, text: s.text.slice(i, i + 50) };
			}
			yield { type: "block-end", index: s.index, block: { type: s.kind, text: s.text } };
		}
		yield { type: "finish", reason: { kind: "stop" } };
	})();
}

/** 取中位数（降低噪声） */
async function median(spec, rounds = 100, warmup = 15) {
	plugin.resetStreaks?.();
	const run = async () => {
		const t0 = process.hrtime.bigint();
		for await (const c of listener(OPTS, () => makeStream(spec))) { /* consume */ }
		return Number(process.hrtime.bigint() - t0);
	};
	for (let i = 0; i < warmup; i++) await run();
	const s = [];
	for (let i = 0; i < rounds; i++) s.push(await run());
	s.sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

const ms = (ns) => ns / 1e6;

console.log("=== 1. 代表性场景的绝对上限（宽松，只抓严重退化）===");
{
	const cases = [
		{ label: "典型回复 600B+1调用", spec: [{ kind: "text", index: 0, text: PROSE + mkCall("echo hi") + PROSE }], limitMs: 5 },
		{ label: "长回复 20KB+1调用", spec: [{ kind: "text", index: 0, text: PROSE.repeat(100) + mkCall("echo long") }], limitMs: 20 },
		{ label: "思考块 600B+1调用", spec: [{ kind: "reasoning", index: 0, text: PROSE + mkCall("echo hi") }], limitMs: 5 },
		{ label: "无标记直通 2KB", spec: [{ kind: "text", index: 0, text: PROSE.repeat(11) }], limitMs: 5 },
		{ label: "含围栏不恢复 1KB", spec: [{ kind: "text", index: 0, text: "说明\n```\n" + mkCall("echo x") + "\n```\n" }], limitMs: 5 },
	];
	for (const c of cases) {
		const t = ms(await median(c.spec));
		console.log(`  ${c.label.padEnd(24)} ${t.toFixed(3)}ms（上限 ${c.limitMs}ms）`);
		ck(`${c.label} 在 ${c.limitMs}ms 内`, t < c.limitMs, `${t.toFixed(3)}ms`);
	}
}

console.log("\n=== 2. 每 KB 成本不随规模上升（抓 O(n²)）===");
{
	// 每 KB 成本应大致恒定或下降；若显著上升说明有超线性环节
	const sizes = [2000, 8000, 32000, 128000];
	const perKB = [];
	for (const size of sizes) {
		const text = "x".repeat(size - mkCall("echo n").length) + mkCall("echo n");
		const t = ms(await median([{ kind: "text", index: 0, text }], 60));
		const p = t / (text.length / 1024);
		perKB.push({ size: text.length, t, p });
		console.log(`  ${String(text.length).padStart(7)}B  ${t.toFixed(3)}ms  每 KB ${p.toFixed(4)}ms`);
	}
	// 最大规模的每 KB 成本不应超过最小规模的 4 倍（留足噪声余量）
	const growth = perKB[perKB.length - 1].p / perKB[0].p;
	console.log(`  每 KB 成本增长 ${growth.toFixed(2)}×（阈值 < 4×）`);
	ck("每 KB 成本不随规模超线性上升", growth < 4, `${growth.toFixed(2)}×`);
}

console.log("\n=== 3. 块数量成本大致线性 ===");
{
	// 固定总字节，只增加块数
	const TOTAL = PROSE.repeat(20).length;
	const rows = [];
	for (const n of [1, 8, 32, 128]) {
		const per = Math.floor(TOTAL / n);
		const spec = Array.from({ length: n }, (_, i) => ({
			kind: "text",
			index: i,
			text: i === 0 ? mkCall("echo x") + "x".repeat(Math.max(0, per - 100)) : "y".repeat(per),
		}));
		const t = ms(await median(spec, 60));
		rows.push({ n, t });
		console.log(`  ${String(n).padStart(3)} 块  ${t.toFixed(3)}ms  每块 ${(t / n).toFixed(4)}ms`);
	}
	// 块数从 1 → 128（128 倍），耗时增长不应超过 256 倍（平方级会远超）
	const tGrowth = rows[rows.length - 1].t / rows[0].t;
	const nGrowth = rows[rows.length - 1].n / rows[0].n;
	console.log(`  块数增长 ${nGrowth}×，耗时增长 ${tGrowth.toFixed(1)}×（线性应为 ~${nGrowth}×，平方级 ~${(nGrowth * nGrowth).toFixed(0)}×）`);
	ck("块数量成本大致线性（非平方级）", tGrowth < nGrowth * nGrowth * 0.5, `${tGrowth.toFixed(1)}× vs ${(nGrowth * nGrowth).toFixed(0)}×`);
	// 绝对值上限：128 块也应很快
	ck("128 块在 30ms 内", rows[rows.length - 1].t < 30, `${rows[rows.length - 1].t.toFixed(1)}ms`);
}

console.log("\n=== 4. 吞吐量：流式小 chunk ===");
{
	const text = PROSE.repeat(200);   // ~13KB
	const chunks = [];
	for (let i = 0; i < text.length; i += 2) chunks.push(text.slice(i, i + 2));

	const runOnce = async () => {
		const gen = (async function* () {
			yield { type: "block-start", index: 0, blockType: "text" };
			for (const c of chunks) yield { type: "text-delta", index: 0, text: c };
			yield { type: "block-end", index: 0, block: { type: "text", text } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		const t0 = process.hrtime.bigint();
		let n = 0;
		for await (const c of listener(OPTS, () => gen)) n++;
		return { ns: Number(process.hrtime.bigint() - t0), n };
	};
	for (let i = 0; i < 5; i++) await runOnce();
	const samples = [];
	for (let i = 0; i < 20; i++) samples.push(await runOnce());
	samples.sort((a, b) => a.ns - b.ns);
	const med = samples[Math.floor(samples.length / 2)];
	const rate = med.n / (med.ns / 1e9);
	console.log(`  ${med.n} chunk 耗时 ${(med.ns / 1e6).toFixed(1)}ms → ${Math.round(rate).toLocaleString()} chunk/s`);
	ck("吞吐 >= 20 万 chunk/s", rate >= 200000, `${Math.round(rate)}/s`);
}

console.log("\n=== 5. 插件开销相对无插件可控 ===");
{
	const spec = [{ kind: "text", index: 0, text: PROSE.repeat(20) + mkCall("echo hi") + PROSE.repeat(20) }];
	const measure = async (usePlugin) => {
		const run = async () => {
			const t0 = process.hrtime.bigint();
			if (usePlugin) { for await (const c of listener(OPTS, () => makeStream(spec))) { /* consume */ } }
			else { for await (const c of makeStream(spec)) { /* consume */ } }
			return Number(process.hrtime.bigint() - t0);
		};
		for (let i = 0; i < 15; i++) await run();
		const s = [];
		for (let i = 0; i < 100; i++) s.push(await run());
		s.sort((a, b) => a - b);
		return s[Math.floor(s.length / 2)];
	};
	const base = await measure(false);
	const withPlugin = await measure(true);
	const overhead = withPlugin - base;
	console.log(`  无插件 ${ms(base).toFixed(3)}ms / 有插件 ${ms(withPlugin).toFixed(3)}ms / 开销 +${ms(overhead).toFixed(3)}ms`);
	// 开销绝对上限 5ms（远小于真实模型响应时间）
	ck("插件开销 < 5ms", ms(overhead) < 5, `${ms(overhead).toFixed(3)}ms`);
}

console.log("\n=== 6. 内存：无按请求累积 ===");
{
	global.gc?.();
	const before = process.memoryUsage().heapUsed;
	const spec = [{ kind: "text", index: 0, text: PROSE.repeat(20) + mkCall("echo hi") }];
	for (let i = 0; i < 500; i++) {
		for await (const c of listener(OPTS, () => makeStream(spec))) { /* consume */ }
	}
	global.gc?.();
	const after = process.memoryUsage().heapUsed;
	const perReq = (after - before) / 500;
	console.log(`  500 次后堆变化 ${((after - before) / 1024 / 1024).toFixed(3)}MB（${perReq.toFixed(0)} 字节/次）`);
	// 允许少量噪声（V8 内部结构），但不应该是正比于请求数的累积
	ck("无按请求累积（< 5KB/次）", perReq < 5120, `${perReq.toFixed(0)} B/次`);
}

console.log(`\n===== 性能基线回归: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
