// 性能剖析与基线建立
//
// 目标：找出热路径的真实耗时占比，建立可回归的性能基线。
// 不用微基准（噪声大），而是用**真实场景的代表性负载**：
//   - 典型模型回复（2-5KB，含 0-2 个调用）
//   - 大回复（20KB）
//   - 病态输入（已由 scan-limit 覆盖）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const plugin = await import(pathToFileURL(LIB).href + "?perf=" + Date.now());

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };

const mkCall = (cmd) => OC + "\n<function=pwsh>\n<parameter=command>\n" + cmd + "\n</parameter>\n</function>\n" + CC;

const PROSE = "这是一段典型的模型回复文字，用来模拟真实场景中的说明内容。" +
	"它包含中文、标点，以及偶尔出现的英文单词和代码片段 `inline`。" +
	"通常模型会在调用工具前后各写一两段说明。\n";

function makeStream(chunksSpec) {
	return (async function* () {
		for (const spec of chunksSpec) {
			if (spec.kind === "text") {
				yield { type: "block-start", index: spec.index, blockType: "text" };
				// 模拟流式：切成 50 字符一片
				for (let i = 0; i < spec.text.length; i += 50) {
					yield { type: "text-delta", index: spec.index, text: spec.text.slice(i, i + 50) };
				}
				yield { type: "block-end", index: spec.index, block: { type: "text", text: spec.text } };
			} else {
				yield { type: "block-start", index: spec.index, blockType: "reasoning" };
				for (let i = 0; i < spec.text.length; i += 50) {
					yield { type: "reasoning-delta", index: spec.index, text: spec.text.slice(i, i + 50) };
				}
				yield { type: "block-end", index: spec.index, block: { type: "reasoning", text: spec.text } };
			}
		}
		yield { type: "usage", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
}

async function timed(spec) {
	plugin.resetStreaks?.();
	const t0 = process.hrtime.bigint();
	const out = [];
	for await (const c of listener(OPTS, () => makeStream(spec))) out.push(c);
	const ns = Number(process.hrtime.bigint() - t0);
	return { ns, out };
}

/** 多轮取中位数（降低噪声） */
async function bench(label, spec, rounds = 200) {
	const samples = [];
	let out = null;
	// 预热
	for (let i = 0; i < 20; i++) await timed(spec);
	for (let i = 0; i < rounds; i++) {
		const r = await timed(spec);
		samples.push(r.ns);
		out = r.out;
	}
	samples.sort((a, b) => a - b);
	const median = samples[Math.floor(samples.length / 2)];
	const p95 = samples[Math.floor(samples.length * 0.95)];
	const min = samples[0];
	return { label, median, p95, min, out };
}

const fmt = (ns) => (ns / 1e6).toFixed(3) + "ms";

console.log("=== 1. 代表性负载基线 ===");
const scenarios = [
	{
		label: "短回复（纯文本 ~200B，无调用）",
		spec: [{ kind: "text", index: 0, text: PROSE.slice(0, 200) }],
	},
	{
		label: "典型回复（~600B 正文 + 1 调用）",
		spec: [{ kind: "text", index: 0, text: PROSE + mkCall("echo hi") + PROSE }],
	},
	{
		label: "典型回复（~1.2KB 正文 + 2 调用）",
		spec: [{ kind: "text", index: 0, text: PROSE + mkCall("echo a") + PROSE + mkCall("echo b") + PROSE }],
	},
	{
		label: "思考块（~600B reasoning + 1 调用）",
		spec: [{ kind: "reasoning", index: 0, text: PROSE + mkCall("echo hi") }],
	},
	{
		label: "长回复（~20KB 正文 + 1 调用）",
		spec: [{ kind: "text", index: 0, text: PROSE.repeat(100) + mkCall("echo long") }],
	},
	{
		label: "多块（3 块，共 ~3KB）",
		spec: [
			{ kind: "reasoning", index: 0, text: PROSE.repeat(5) },
			{ kind: "text", index: 1, text: PROSE.repeat(5) + mkCall("echo x") },
			{ kind: "text", index: 2, text: PROSE.repeat(5) },
		],
	},
	{
		label: "纯文本直通（~2KB，无任何标记）",
		spec: [{ kind: "text", index: 0, text: PROSE.repeat(11) }],
	},
	{
		label: "含代码围栏（~1KB，不恢复）",
		spec: [{ kind: "text", index: 0, text: PROSE.slice(0, 300) + "\n```xml\n" + mkCall("rm -rf /") + "\n```\n" + PROSE.slice(0, 300) }],
	},
];

const results = [];
for (const s of scenarios) {
	const r = await bench(s.label, s.spec);
	results.push(r);
	const calls = r.out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").length;
	console.log(`  ${r.label.padEnd(38)} 中位 ${fmt(r.median).padStart(9)}  p95 ${fmt(r.p95).padStart(9)}  恢复 ${calls}`);
}

console.log("\n=== 2. 每 KB 处理成本（判断是否有 O(n²) 苗头）===");
{
	const sizes = [500, 1000, 2000, 4000, 8000, 16000, 32000, 64000];
	const rows = [];
	for (const size of sizes) {
		const text = "x".repeat(size - mkCall("echo n").length) + mkCall("echo n");
		const r = await bench(`${size}B`, [{ kind: "text", index: 0, text }], 100);
		const perKB = r.median / (text.length / 1024);
		rows.push({ size: text.length, median: r.median, perKB });
		console.log(`  ${String(text.length).padStart(6)}B  中位 ${fmt(r.median).padStart(9)}  每 KB ${fmt(perKB).padStart(9)}`);
	}
	// 每 KB 成本应大致恒定（线性），不应随规模显著上升
	const first = rows[0].perKB;
	const last = rows[rows.length - 1].perKB;
	const growth = last / first;
	console.log(`\n  每 KB 成本从 ${fmt(first)} 增至 ${fmt(last)}（增长 ${growth.toFixed(2)}×）`);
	console.log(`  判定：${growth < 3 ? "✅ 线性（无 O(n²) 苗头）" : "⚠️ 可能超线性"}`);
}

console.log("\n=== 3. 块数量影响 ===");
{
	for (const n of [1, 2, 4, 8, 16, 32]) {
		const spec = Array.from({ length: n }, (_, i) => ({
			kind: i % 2 ? "text" : "reasoning",
			index: i,
			text: PROSE.repeat(2) + (i === 0 ? mkCall("echo x") : ""),
		}));
		const r = await bench(`${n} 块`, spec, 100);
		console.log(`  ${String(n).padStart(2)} 块  中位 ${fmt(r.median).padStart(9)}`);
	}
}

console.log("\n=== 4. 最坏真实场景（大回复 + 多调用 + 围栏）===");
{
	const spec = [
		{ kind: "reasoning", index: 0, text: PROSE.repeat(50) },
		{ kind: "text", index: 1, text: PROSE.repeat(50) + mkCall("echo a") + PROSE.repeat(20) + "```\n" + mkCall("echo b") + "\n```" + PROSE.repeat(20) + mkCall("echo c") },
		{ kind: "text", index: 2, text: PROSE.repeat(50) },
	];
	const r = await bench("最坏真实场景", spec, 100);
	const calls = r.out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").length;
	const totalChars = spec.reduce((a, s) => a + s.text.length, 0);
	console.log(`  输入 ${(totalChars / 1024).toFixed(1)}KB，中位 ${fmt(r.median)}，p95 ${fmt(r.p95)}，恢复 ${calls} 个调用`);
	console.log(`  → 每个调用约 ${fmt(r.median / Math.max(calls, 1))}`);
}

console.log("\n=== 5. 吞吐量（流式 chunk 处理速度）===");
{
	// 大量小 chunk（真实流式场景）
	const chunks = [];
	const total = 20000;
	const text = PROSE.repeat(600);   // ~40KB
	for (let i = 0; i < text.length; i += 2) chunks.push(text.slice(i, i + 2));
	console.log(`  ${chunks.length} 个 2 字符 chunk（共 ${(text.length / 1024).toFixed(0)}KB）`);
	const t0 = process.hrtime.bigint();
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		for (const c of chunks) yield { type: "text-delta", index: 0, text: c };
		yield { type: "block-end", index: 0, block: { type: "text", text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	let count = 0;
	for await (const c of listener(OPTS, () => gen)) count++;
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	console.log(`  耗时 ${ms.toFixed(1)}ms（${count} chunk，${Math.round(count / ms * 1000).toLocaleString()} chunk/s）`);
}

console.log("\n=== 6. 与「无插件」基线对比（衡量插件开销）===");
{
	// 直接把源流跑完（不经过插件），对比耗时
	const spec = [{ kind: "text", index: 0, text: PROSE.repeat(20) + mkCall("echo hi") + PROSE.repeat(20) }];
	const measure = async (usePlugin) => {
		const samples = [];
		for (let i = 0; i < 20; i++) {
			// 预热
			if (usePlugin) await timed(spec); else { for await (const c of makeStream(spec)) { /* consume */ } }
		}
		for (let i = 0; i < 100; i++) {
			const t0 = process.hrtime.bigint();
			if (usePlugin) { for await (const c of listener(OPTS, () => makeStream(spec))) { /* consume */ } }
			else { for await (const c of makeStream(spec)) { /* consume */ } }
			samples.push(Number(process.hrtime.bigint() - t0));
		}
		samples.sort((a, b) => a - b);
		return samples[Math.floor(samples.length / 2)];
	};
	const base = await measure(false);
	const withPlugin = await measure(true);
	console.log(`  无插件: ${fmt(base)}`);
	console.log(`  有插件: ${fmt(withPlugin)}`);
	console.log(`  插件开销: ${fmt(withPlugin - base)}（${((withPlugin / base - 1) * 100).toFixed(0)}%）`);
	console.log(`  → 单次请求开销 ${fmt(withPlugin - base)}，相对真实模型响应时间（数百毫秒~数秒）可忽略`);
}

console.log("\n=== 7. 内存分配（GC 压力）===");
{
	global.gc?.();
	const before = process.memoryUsage();
	const spec = [{ kind: "text", index: 0, text: PROSE.repeat(20) + mkCall("echo hi") }];
	for (let i = 0; i < 500; i++) await timed(spec);
	global.gc?.();
	const after = process.memoryUsage();
	console.log(`  500 次处理：堆增长 ${((after.heapUsed - before.heapUsed) / 1024 / 1024).toFixed(2)}MB`);
	console.log(`  → ${((after.heapUsed - before.heapUsed) / 500 / 1024).toFixed(1)}KB/次`);
}
