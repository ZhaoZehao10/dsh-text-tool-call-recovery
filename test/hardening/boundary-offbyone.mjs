// 边界条件精确测试（off-by-one 守护）
//
// **为什么需要**：off-by-one 是最经典的 bug 类型，而且**普通测试很难发现**
// —— 大多数测试用「明显超过」或「明显低于」的值，正好绕过边界。
//
// 本套件对源码里**每一个边界常量**做精确测试：
//   - `MAX_SCAN_CHARS` = 131072：测 131071 / 131072 / 131073
//   - `MAX_TRACKED_MODELS` = 64：测 64 个 / 65 个模型
//   - `MAX_MULTILINE_INLINE_SCAN` = 8192：测 8191 / 8192 / 8292
//
// **关键测试技巧**（第 62 轮踩过的坑）：
// 测 LRU 时**不能每次 resetStreaks**，否则状态永远清空、淘汰逻辑测不到。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const SRC = fs.readFileSync(LIB, "utf8");

// 从源码读取常量（而不是硬编码，避免源码改动后测试失准）
const readConst = (name) => {
	const m = SRC.match(new RegExp(`const ${name}\\s*=\\s*([0-9*\\s+]+);`));
	if (!m) return null;
	try {
		return Function(`"use strict"; return (${m[1]});`)();
	} catch {
		return null;
	}
};

const MAX_SCAN_CHARS = readConst("MAX_SCAN_CHARS");
const MAX_TRACKED_MODELS = readConst("MAX_TRACKED_MODELS");
const MAX_MULTILINE_INLINE_SCAN = readConst("MAX_MULTILINE_INLINE_SCAN");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

console.log("=== 0. 从源码读取边界常量 ===");
console.log(`  MAX_SCAN_CHARS = ${MAX_SCAN_CHARS}`);
console.log(`  MAX_TRACKED_MODELS = ${MAX_TRACKED_MODELS}`);
console.log(`  MAX_MULTILINE_INLINE_SCAN = ${MAX_MULTILINE_INLINE_SCAN}`);

ck("MAX_SCAN_CHARS 可从源码读取", MAX_SCAN_CHARS === 128 * 1024, String(MAX_SCAN_CHARS));
ck("MAX_TRACKED_MODELS 可从源码读取", MAX_TRACKED_MODELS === 64, String(MAX_TRACKED_MODELS));
ck("MAX_MULTILINE_INLINE_SCAN 可从源码读取", MAX_MULTILINE_INLINE_SCAN === 8192, String(MAX_MULTILINE_INLINE_SCAN));

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const MARKUP = OC + "\n<function=pwsh>\n<parameter=command>echo hi\n</parameter>\n</function>\n" + CC;

const plugin = await import(pathToFileURL(LIB).href + "?bnd=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

async function run(text, blockType = "reasoning", model = "boundary", doReset = true) {
	if (doReset) plugin.resetStreaks?.();
	const out = [];
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType };
		yield { type: blockType === "text" ? "text-delta" : "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: blockType, text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	for await (const c of listener({ provider: "p", model, messages: [], tools: TOOLS }, () => gen)) out.push(c);
	const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	const fin = out.find((c) => c.type === "finish");
	return { calls: calls.length, kind: fin?.reason?.kind, code: fin?.reason?.failure?.code };
}

// ===========================================================================
// 1. MAX_SCAN_CHARS off-by-one
// ===========================================================================
console.log("\n=== 1. MAX_SCAN_CHARS off-by-one ===");
if (MAX_SCAN_CHARS) {
	const ML = MARKUP.length;

	const exact = await run("x".repeat(MAX_SCAN_CHARS - ML) + MARKUP, "reasoning", "e-" + Date.now());
	console.log(`  length == MAX (${exact.calls > 0 ? "恢复" : "拒绝"}): 恢复=${exact.calls} kind=${exact.kind}`);
	ck("length == MAX 时仍能恢复（不是 > 才拒绝吗？边界必须含等号）", exact.calls === 1, `恢复 ${exact.calls}`);

	const over = await run("x".repeat(MAX_SCAN_CHARS - ML + 1) + MARKUP, "reasoning", "o-" + Date.now());
	console.log(`  length == MAX+1: 恢复=${over.calls} kind=${over.kind}`);
	ck("length == MAX+1 时拒绝扫描", over.calls === 0, `恢复 ${over.calls}`);
	ck("length == MAX+1 时走安全网（非静默丢弃）", over.kind === "error", `kind=${over.kind}`);

	const under = await run("x".repeat(MAX_SCAN_CHARS - ML - 1) + MARKUP, "reasoning", "u-" + Date.now());
	console.log(`  length == MAX-1: 恢复=${under.calls}`);
	ck("length == MAX-1 时正常恢复", under.calls === 1, `恢复 ${under.calls}`);
}

// ===========================================================================
// 2. MAX_TRACKED_MODELS LRU 淘汰
// ===========================================================================
console.log("\n=== 2. MAX_TRACKED_MODELS LRU 淘汰 ===");
if (MAX_TRACKED_MODELS) {
	plugin.resetStreaks?.();

	for (let i = 0; i < MAX_TRACKED_MODELS; i++) {
		await run("只有思考", "reasoning", `lr-${i}`, false);
	}
	console.log(`  已填充 ${MAX_TRACKED_MODELS} 个模型`);
	await run("只有思考", "reasoning", `lr-${MAX_TRACKED_MODELS}`, false);
	console.log(`  第 ${MAX_TRACKED_MODELS + 1} 个模型 → 触发淘汰`);

	const r0 = await run("只有思考", "reasoning", "lr-0", false);
	console.log(`  最旧模型 lr-0 再访问: kind=${r0.kind}`);
	ck("被淘汰的模型重新触发安全网（LRU 生效）", r0.kind === "error", `kind=${r0.kind}`);

	const rNew = await run("只有思考", "reasoning", `lr-${MAX_TRACKED_MODELS}`, false);
	console.log(`  最新模型再访问: kind=${rNew.kind}`);
	ck("最新模型仍在表中（返回 stop，证明没被误淘汰）", rNew.kind === "stop", `kind=${rNew.kind}`);

	const rPrev = await run("只有思考", "reasoning", `lr-${MAX_TRACKED_MODELS - 1}`, false);
	console.log(`  次新模型再访问: kind=${rPrev.kind}`);
	ck("次新模型仍在表中", rPrev.kind === "stop", `kind=${rPrev.kind}`);
}

// ===========================================================================
// 3. MAX_MULTILINE_INLINE_SCAN
// ===========================================================================
console.log("\n=== 3. MAX_MULTILINE_INLINE_SCAN ===");
if (MAX_MULTILINE_INLINE_SCAN) {
	for (const len of [MAX_MULTILINE_INLINE_SCAN - 1, MAX_MULTILINE_INLINE_SCAN, MAX_MULTILINE_INLINE_SCAN + 100]) {
		const text = "`" + "z".repeat(len) + "`\n\n" + MARKUP;
		const r = await run(text, "text", "il-" + len + "-" + Date.now());
		console.log(`  行内代码 ${len} 字符 + 真实调用: 恢复=${r.calls}`);
		ck(`行内代码 ${len} 字符后的真实调用仍能恢复`, r.calls >= 1, `恢复 ${r.calls}`);
	}
}

console.log(`\n===== 边界条件 off-by-one: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
