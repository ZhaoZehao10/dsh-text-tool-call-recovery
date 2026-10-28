// Node 版本兼容性审查
//
// 插件在宿主的嵌入式 Node/Electron 里运行，版本可能与开发环境（Node 25）不同。
// 本测试检查插件使用的所有 API 的最低 Node 版本要求。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const src = fs.readFileSync(LIB, "utf8");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

console.log("=== 1. 现代 API 使用检查（可能在旧 Node 缺失）===\n");

// (API 名, 正则, 引入版本, 是否危险)
const APIS = [
	["Array.prototype.at()", /\.at\(-?\d+\)/, "Node 16.6", true],
	["Object.hasOwn()", /Object\.hasOwn\(/, "Node 16.9", true],
	["structuredClone()", /structuredClone\(/, "Node 17.0", true],
	["Array.prototype.findLast()", /\.findLast\(/, "Node 18.0", true],
	["Array.prototype.findLastIndex()", /\.findLastIndex\(/, "Node 18.0", true],
	["String.prototype.replaceAll()", /\.replaceAll\(/, "Node 15.0", true],
	["Promise.any()", /Promise\.any\(/, "Node 15.0", true],
	["Array.prototype.flat()", /\.flat\(/, "Node 11.0", false],
	["Object.fromEntries()", /Object\.fromEntries\(/, "Node 12.0", false],
	["String.prototype.trimStart/End", /\.trim(Start|End)\(/, "Node 10.0", false],
	["Array.from()", /Array\.from\(/, "Node 4.0", false],
	["globalThis", /globalThis/, "Node 12.0", false],
	["String.raw", /String\.raw/, "Node 4.0", false],
	["RegExp 命名捕获组", /\(\?<\w+>/, "Node 10.0", false],
	["RegExp 后行断言", /\(\?<=/, "Node 8.3（V8 6.2）", true],
	["RegExp 先行断言", /\(\?=/, "Node 4.0", false],
	["可选链 ?.", /\?\.[a-zA-Z_$[(]/, "Node 14.0", true],
	["空值合并 ??", /\?\?/, "Node 14.0", true],
	["逻辑赋值 ||= &&= ??=", /(\|\|=|&&=|\?\?=)/, "Node 15.0", true],
	["BigInt 字面量", /\d+n\b/, "Node 10.4", false],
	["Array.prototype.includes", /\.includes\(/, "Node 6.0", false],
	["Object.entries/values", /Object\.(entries|values)\(/, "Node 7.0", false],
	["async generator", /async function\*/, "Node 10.0", false],
	["for await...of", /for await \(/, "Node 10.0", false],
	["Symbol.asyncIterator", /Symbol\.asyncIterator/, "Node 10.0", false],
	["String.prototype.matchAll", /\.matchAll\(/, "Node 12.0", true],
	["Array.prototype.flatMap", /\.flatMap\(/, "Node 11.0", false],
	["Object.getOwnPropertyDescriptors", /Object\.getOwnPropertyDescriptors/, "Node 7.0", false],
	["WeakRef", /new WeakRef\(/, "Node 14.6", true],
	["FinalizationRegistry", /new FinalizationRegistry\(/, "Node 14.6", true],
	["AggregateError", /AggregateError/, "Node 15.0", true],
	["String.prototype.at", /String\.prototype\.at|["'`][^"'`]*["'`]\.at\(/, "Node 16.6", true],
];

const found = [];
for (const [name, re, ver, risky] of APIS) {
	const m = src.match(re);
	if (m) {
		found.push({ name, ver, risky });
		console.log(`  ${risky ? "⚠️ " : "✅ "} ${name.padEnd(36)} 需要 ${ver}`);
	}
}

const riskyFound = found.filter((f) => f.risky);
console.log(`\n  总计使用 ${found.length} 种现代 API，其中 ${riskyFound.length} 种需要 Node ≥ 14`);

// 判定：DSH 0.2.1 用的 Electron 至少是 Node 18+（Electron 22+），所以 Node 15+ 的 API 都安全
ck("无 Node 18+ 独占 API（Electron 22 以下不兼容）",
	!found.some((f) => ["structuredClone()", "Array.prototype.findLast()", "Array.prototype.findLastIndex()"].includes(f.name)),
	found.filter((f) => ["structuredClone()", "Array.prototype.findLast()", "Array.prototype.findLastIndex()"].includes(f.name)).map((f) => f.name).join(","));

console.log("\n=== 2. 实际运行时 API 探测 ===");
{
	// 检查插件运行所需的 API 在当前 Node 上是否可用（间接证明兼容性）
	const checks = [
		["Array.prototype.at", () => [1, 2, 3].at(-1) === 3],
		["Object.hasOwn", () => Object.hasOwn({ a: 1 }, "a")],
		["String.prototype.replaceAll", () => "a-b".replaceAll("-", "_") === "a_b"],
		["RegExp 后行断言", () => /(?<=a)b/.test("ab")],
		["async generator", () => { const g = (async function* () { yield 1; })(); return typeof g[Symbol.asyncIterator] === "function"; }],
		["for await...of", () => typeof Symbol.asyncIterator === "symbol"],
	];
	for (const [name, fn] of checks) {
		let ok = false;
		let err = null;
		try { ok = fn(); } catch (e) { err = e.message; }
		console.log(`  ${ok ? "✅" : "❌"} ${name}`);
		ck(`运行时支持 ${name}`, ok === true, err ?? "");
	}
}

console.log("\n=== 3. ESM 语法兼容性（插件用 export/import）===");
{
	const isESM = /^export \{/m.test(src) || /^export /m.test(src);
	console.log(`  插件是 ESM: ${isESM}`);
	ck("插件使用 ESM 导出（与宿主一致）", isESM, "");
	// 检查是否混用 require（ESM 里不能直接 require）
	const hasRequire = /(^|[^.\w])require\s*\(/.test(src);
	console.log(`  含 require(): ${hasRequire}`);
	ck("ESM 里不混用 require()", !hasRequire, "");
	// 检查是否用 import.meta（ESM 专有）
	const hasImportMeta = /import\.meta/.test(src);
	console.log(`  含 import.meta: ${hasImportMeta}`);
}

console.log("\n=== 4. 不依赖宿主私有内部模块 ===");
{
	const badImports = [
		"internal/modules",
		"internal/process",
		"node:internal",
		"@deepseek-ai/dsh-llm",
		"dsh-llm/lib/types",
		"require('fs')",
	];
	for (const b of badImports) {
		const found2 = src.includes(b);
		console.log(`  ${found2 ? "⚠️" : "✅"} 不导入 ${b}`);
		ck(`不依赖 ${b}`, !found2, "");
	}
	// 列出所有 import
	const imports = [...src.matchAll(/^import\s+.*?from\s+["'](.+?)["']/gm)].map((m) => m[1]);
	console.log(`  import 语句: ${imports.length > 0 ? JSON.stringify(imports) : "无（纯自包含）"}`);
	ck("插件无外部依赖（自包含）", imports.length === 0, JSON.stringify(imports));
}

console.log(`\n===== Node 版本兼容性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
