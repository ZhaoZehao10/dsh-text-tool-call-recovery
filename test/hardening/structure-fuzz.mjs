// 结构化随机模糊测试（structure fuzz）
//
// type-fuzz 覆盖「已知字段 + 已知坏值」的组合。本测试覆盖**随机畸形结构**：
// 随机生成 chunk 序列（字段随机缺失/多余/类型错乱/顺序错乱/嵌套异常），
// 验证插件在任意输入下都不抛异常。
//
// 判据：
//   - 插件**不得抛异常**（在 llm/stream 接缝抛异常 = 中断整条模型流）
//   - 插件输出必须是数组（流可被消费）
//   - 不得吞掉 finish（正常流必须有终态）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

// 可复现的伪随机
let seed = 20251023;
function rnd() {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

/** 安全序列化（BigInt/Symbol/函数都可能出现在模糊值里） */
function safeStr(v) {
	try {
		return JSON.stringify(v, (_k, x) => {
			if (typeof x === "bigint") return x.toString() + "n";
			if (typeof x === "symbol") return x.toString();
			if (typeof x === "function") return "[function]";
			return x;
		});
	} catch (e) {
		return "[unserializable: " + e.message + "]";
	}
}
const chance = (p) => rnd() < p;

const CHUNK_TYPES = [
	"block-start", "text-delta", "reasoning-delta", "tool-call-delta",
	"block-end", "usage", "finish", "unknown-type", "",
];
const BLOCK_TYPES = ["text", "reasoning", "tool-call", "image", "unknown", "", null];
const BAD_VALUES = [
	undefined, null, 0, 1, -1, NaN, Infinity, true, false,
	[], [1], {}, { a: 1 }, "", "   ", "x", "x".repeat(500), 123n, Symbol("s"),
	function () {},
];

function badValue() { return pick(BAD_VALUES); }

/** 随机生成一个畸形 chunk */
function randomChunk() {
	if (chance(0.05)) return badValue();     // 整个 chunk 是坏值
	if (chance(0.05)) return {};             // 空对象
	const c = {};
	c.type = chance(0.92) ? pick(CHUNK_TYPES) : badValue();
	if (chance(0.85)) c.index = chance(0.9) ? Math.floor(rnd() * 5) : badValue();
	if (chance(0.5)) c.blockType = chance(0.8) ? pick(BLOCK_TYPES) : badValue();
	if (chance(0.6)) c.text = chance(0.85) ? pick([
		"", "   ", "hello", "<tool_call>", "</tool_call>",
		"<function=pwsh>", "<parameter=command>ls</parameter>",
		"```", "`x`", "&lt;", "\\n", "\u0000", "日本語", "🎉",
	]) : badValue();
	if (chance(0.4)) c.block = chance(0.85) ? {
		type: chance(0.8) ? pick(BLOCK_TYPES) : badValue(),
		...(chance(0.7) ? { text: chance(0.85) ? "blk" : badValue() } : {}),
		...(chance(0.3) ? { id: chance(0.8) ? "id-1" : badValue() } : {}),
		...(chance(0.3) ? { name: chance(0.8) ? "pwsh" : badValue() } : {}),
		...(chance(0.3) ? { arguments: chance(0.8) ? '{"a":1}' : badValue() } : {}),
	} : badValue();
	if (chance(0.3)) c.id = chance(0.8) ? "call-1" : badValue();
	if (chance(0.3)) c.name = chance(0.8) ? "pwsh" : badValue();
	if (chance(0.3)) c.argumentsDelta = chance(0.8) ? '{"a":' : badValue();
	if (chance(0.3)) c.usage = chance(0.7) ? {
		inputTokens: chance(0.8) ? 10 : badValue(),
		outputTokens: chance(0.8) ? 20 : badValue(),
		totalTokens: chance(0.8) ? 30 : badValue(),
	} : badValue();
	if (chance(0.4)) c.reason = chance(0.7) ? {
		kind: chance(0.8) ? pick(["stop", "error", "aborted", "tool-calls", "unknown"]) : badValue(),
		...(chance(0.3) ? { failure: chance(0.7) ? { code: "X", message: "m" } : badValue() } : {}),
	} : badValue();
	if (chance(0.3)) c.replayState = chance(0.7) ? {
		...(chance(0.7) ? { response: chance(0.7) ? { stopReason: chance(0.8) ? "stop" : badValue() } : badValue() } : {}),
		...(chance(0.7) ? { blocks: chance(0.7) ? [{ type: "reasoning" }] : badValue() } : {}),
	} : badValue();
	if (chance(0.1)) c.__extra = badValue();
	return c;
}

/** 随机生成一条完整的畸形流 */
function randomStream() {
	const n = Math.floor(rnd() * 12) + 1;
	const chunks = [];
	for (let i = 0; i < n; i++) chunks.push(randomChunk());
	// 一半概率追加一个"看似正常"的 finish，测试插件是否能正确终结
	if (chance(0.5)) {
		chunks.push({ type: "finish", reason: { kind: pick(["stop", "error", "aborted"]) } });
	}
	return chunks;
}

function randomTools() {
	if (chance(0.1)) return badValue();
	if (!chance(0.9)) return [];
	const n = Math.floor(rnd() * 4);
	const out = [];
	for (let i = 0; i < n; i++) {
		if (chance(0.1)) { out.push(badValue()); continue; }
		const t = { name: chance(0.85) ? pick(["pwsh", "read", "write", "unknown"]) : badValue() };
		if (chance(0.7)) {
			t.parameters = chance(0.85) ? {
				type: "object",
				properties: chance(0.8) ? {
					command: { type: "string" },
				} : badValue(),
			} : badValue();
		}
		out.push(t);
	}
	return out;
}

const plugin = await import(pathToFileURL(LIB).href + "?sfuzz=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

async function runOne(chunks, opts) {
	plugin.resetStreaks?.();
	const gen = (async function* () { for (const c of chunks) yield c; })();
	const out = [];
	let err = null;
	try {
		for await (const c of listener(opts, () => gen)) out.push(c);
	} catch (e) {
		err = e;
	}
	return { err, out };
}

console.log("=== 结构化随机模糊测试 ===");
console.log("（随机 chunk 序列，验证插件永不抛异常）\n");

// **三种子 × 8000 条 = 24,000 条**（README 声明的规模）。
//
// 缺陷 49：早期这里只有 `const N = 5000` 单种子，但 README 写的是
// 「3 个随机种子 × 8000 条 = 24,000 条」。选择**提升代码**而非降低声明——
// 24,000 条实测只需几百毫秒，没有理由用更弱的证据。
const SEEDS = [0x5eed, 0xc0ffee, 0xdeadbe];
const PER_SEED = 8000;
const N = SEEDS.length * PER_SEED;
let crashes = 0;
const crashSamples = [];
{
	let seedIdx = 0;
	for (const seedValue of SEEDS) {
		// 随机源是模块级 `let seed`；直接赋值即可让每个种子产生独立的分布
		seed = seedValue;
		for (let i = 0; i < PER_SEED; i++) {
			const chunks = randomStream();
			const opts = { provider: "p", model: chance(0.8) ? "m" : badValue(), messages: [], tools: randomTools() };
			const { err, out } = await runOne(chunks, opts);
			if (err !== null) {
				crashes++;
				if (crashSamples.length < 5) {
					crashSamples.push({ seed: "0x" + seedValue.toString(16), i, msg: err.message, chunks: safeStr(chunks).slice(0, 300) });
				}
			}
		}
		seedIdx++;
	}
}

console.log(`跑了 ${N} 条随机畸形流（${SEEDS.length} 个种子 × ${PER_SEED} 条），崩溃 ${crashes} 次`);
ck(`${N} 条随机畸形流不崩溃`, crashes === 0, `${crashes} 次崩溃`);

if (crashSamples.length) {
	console.log("\n--- 崩溃样本 ---");
	for (const s of crashSamples) {
		console.log(`  #${s.i}: ${s.msg}`);
		console.log(`    chunks: ${s.chunks}`);
	}
}

// ---------------------------------------------------------------------------
// 不变量：插件输出不应"消失"（输入的 finish 必须出现在输出里或被替换为等价终态）
// ---------------------------------------------------------------------------
console.log("\n=== 不变量检查（1000 条健全流）===");
{
	let missingFinish = 0;
	let extraAfterFinish = 0;
	const OC = "<" + "tool_call>";
	const CC = "</" + "tool_call>";
	for (let i = 0; i < 1000; i++) {
		const payload = chance(0.5)
			? OC + "\n<function=pwsh>\n<parameter=command>echo x\n</parameter>\n</function>\n" + CC
			: "normal text " + i;
		const chunks = [
			{ type: "block-start", index: 0, blockType: pick(["text", "reasoning"]) },
			{ type: pick(["text-delta", "reasoning-delta"]), index: 0, text: payload },
			{ type: "block-end", index: 0, block: { type: pick(["text", "reasoning"]), text: payload } },
			{ type: "finish", reason: { kind: "stop" } },
		];
		const { err, out } = await runOne(chunks, { provider: "p", model: "m", messages: [], tools: [{ name: "pwsh" }] });
		if (err !== null) { ck(`健全流 ${i} 不崩溃`, false, err.message); break; }
		const finishIdx = out.findIndex((c) => c && c.type === "finish");
		if (finishIdx < 0) missingFinish++;
		else if (finishIdx !== out.length - 1) extraAfterFinish++;
	}
	ck("健全流都有 finish 终态", missingFinish === 0, `${missingFinish} 条缺失`);
	ck("finish 是最后一个 chunk", extraAfterFinish === 0, `${extraAfterFinish} 条 finish 后有内容`);
}

console.log(`\n===== 结构化随机模糊: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
