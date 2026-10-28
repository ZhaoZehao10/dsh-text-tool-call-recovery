// 扫描上限与病态输入性能（MAX_SCAN_CHARS 边界）
//
// 插件在 llm/stream 接缝上处理模型文本。若对超长/病态输入没有上限，
// 会阻塞事件循环（ReDoS 或 O(n²) 扫描），**拖慢整条模型流**。
//
// MAX_SCAN_CHARS = 128KB：超限文本直接拒绝扫描（保守方向 = 视为展示，不恢复）。
// 本测试验证：
//   1. 边界精确（上限以下能恢复，超过则拒绝）
//   2. 各种病态输入都在毫秒级完成
//   3. 多标记场景不退化（不呈 O(n²)）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const src = fs.readFileSync(LIB, "utf8");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

// 从源码读出真实上限（不硬编码，改了实现测试会自动跟随）
const m = src.match(/const MAX_SCAN_CHARS = ([0-9*\s]+);/);
if (m === null) { console.log("跳过：找不到 MAX_SCAN_CHARS"); process.exit(0); }
const MAX = Function(`return ${m[1]}`)();
console.log(`MAX_SCAN_CHARS = ${MAX} 字符 (${(MAX / 1024).toFixed(0)}KB)\n`);

const plugin = await import(pathToFileURL(LIB).href + "?scanlimit=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const ONE = OC + "\n<function=pwsh>\n<parameter=command>\necho hi\n</parameter>\n</function>\n" + CC;
const OPTS = { provider: "p", model: "m", messages: [], tools: [{ name: "pwsh" }] };

async function run(text) {
	plugin.resetStreaks?.();
	const t0 = Date.now();
	let err = null;
	let calls = 0;
	try {
		const gen = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		for await (const c of listener(OPTS, () => gen)) {
			if (c.type === "block-end" && c.block?.type === "tool-call") calls++;
		}
	} catch (e) { err = e; }
	return { elapsed: Date.now() - t0, calls, err };
}

console.log("=== 1. 边界精确性 ===");
{
	// 上限以下：应恢复
	const under = "x".repeat(MAX - ONE.length - 200) + ONE;
	const r1 = await run(under);
	console.log(`  上限以下 (${(under.length / 1024).toFixed(1)}KB): 恢复 ${r1.calls} 个, ${r1.elapsed}ms`);
	ck("上限以下 → 恢复成功", r1.calls === 1, String(r1.calls));
	ck("上限以下 → 不崩溃", r1.err === null, r1.err?.message ?? "");

	// 超上限：应拒绝
	const over = "x".repeat(MAX + 100) + ONE;
	const r2 = await run(over);
	console.log(`  超上限 (${(over.length / 1024).toFixed(1)}KB): 恢复 ${r2.calls} 个, ${r2.elapsed}ms`);
	ck("超上限 → 拒绝恢复（保守方向）", r2.calls === 0, String(r2.calls));
	ck("超上限 → 不崩溃", r2.err === null, r2.err?.message ?? "");
	ck("超上限 → 立即返回（< 50ms）", r2.elapsed < 50, `${r2.elapsed}ms`);
}

console.log("\n=== 2. 病态输入性能（都必须 < 500ms）===");
{
	const cases = [
		["10MB 纯文本", "a".repeat(10 * 1024 * 1024)],
		["5MB 未闭合标记", OC.repeat(Math.floor(5 * 1024 * 1024 / OC.length))],
		["10MB 反引号", "`".repeat(10 * 1024 * 1024)],
		["5MB 闭合围栏", "```\n".repeat(Math.floor(5 * 1024 * 1024 / 4))],
		["1MB 参数名洪水", Array.from({ length: 30000 }, () => "<parameter=a>x</parameter>").join("")],
		["交替标记与反引号", Array.from({ length: 50000 }, (_, i) => i % 2 === 0 ? "`" : OC).join("")],
		["10MB 换行", "\n".repeat(10 * 1024 * 1024)],
		["5MB XML 实体", "&lt;".repeat(Math.floor(5 * 1024 * 1024 / 4))],
	];
	for (const [label, text] of cases) {
		const r = await run(text);
		console.log(`  ${label.padEnd(18)} ${(text.length / 1024 / 1024).toFixed(1)}MB → ${r.elapsed}ms, 恢复 ${r.calls}`);
		ck(`${label} 不崩溃`, r.err === null, r.err?.message ?? "");
		ck(`${label} 在 500ms 内`, r.elapsed < 500, `${r.elapsed}ms`);
	}
}

console.log("\n=== 3. 多标记不退化（检查是否 O(n²)）===");
{
	const results = [];
	for (const n of [10, 50, 100, 200, 400]) {
		const text = Array.from({ length: n }, () => ONE).join("\n");
		const r = await run(text);
		results.push({ n, elapsed: r.elapsed, calls: r.calls, len: text.length });
		console.log(`  ${String(n).padStart(4)} 个标记 (${(text.length / 1024).toFixed(1)}KB) → ${r.elapsed}ms，恢复 ${r.calls}`);
		ck(`${n} 个标记 → 全部恢复`, r.calls === n, `${r.calls}/${n}`);
	}
	// 检查时间增长：400/10 = 40 倍规模，若 O(n²) 则时间约 1600 倍
	const small = results[0].elapsed;
	const large = results[results.length - 1].elapsed;
	const ratio = small === 0 ? 0 : large / small;
	const sizeRatio = results[results.length - 1].len / results[0].len;
	console.log(`  规模增长 ${sizeRatio.toFixed(1)} 倍，耗时增长 ${ratio.toFixed(1)} 倍`);
	ck("时间增长不呈平方（ratio < sizeRatio²）", ratio < sizeRatio * sizeRatio, `${ratio.toFixed(1)} vs ${(sizeRatio * sizeRatio).toFixed(1)}`);
	ck("400 个标记在 500ms 内", large < 500, `${large}ms`);
}

console.log("\n=== 4. 上限保护在展示区计算前生效（避免白算）===");
{
	// 超上限且含大量反引号（computeDisplayRanges 会扫全文本）
	// 若上限检查在后，会先花时间算展示区
	const text = "`".repeat(MAX + 1000) + ONE;
	const r = await run(text);
	console.log(`  超上限 + 大量反引号: ${r.elapsed}ms`);
	ck("超上限时快速返回（说明上限检查先于展示区计算）", r.elapsed < 50, `${r.elapsed}ms`);
}

console.log(`\n===== 扫描上限与病态输入: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
