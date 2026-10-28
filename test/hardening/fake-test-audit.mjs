// 「假测试」扫描
//
// 一个看起来是测试、但**永远不会失败**的文件，比没有测试更糟 ——
// 它制造「已验证」的假象。
//
// 前 45 轮踩过两次：
//   - 缺陷 50：test/real-samples.test.mjs 只 print 后 exit 0
//   - 缺陷 51：test/hardening/audit-rewrites.mjs 打印「可疑: 0」但从不检查
//
// 本套件扫描**每一个**测试脚本，验证它有真正的失败路径。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) { walk(p, out); continue; }
		if (/\.(mjs|cjs)$/.test(e.name)) out.push(p);
	}
	return out;
}

const allFiles = walk(path.join(ROOT, "test"));

// ===========================================================================
// 1. 分类：哪些是测试，哪些是工具/演示
// ===========================================================================
console.log("=== 1. 脚本分类 ===");
/**
 * 判断一个脚本是否「在 run-all 里被当作测试跑」。
 * 只有这些才必须能失败。
 */
const runAll = fs.readFileSync(path.join(ROOT, "test", "run-all.mjs"), "utf8");
const inRunAll = new Set();
for (const m of runAll.matchAll(/["']([\w-]+\.(?:mjs|cjs))["']/g)) inRunAll.add(m[1]);
// 也抓 path.join(...) 形式
for (const m of runAll.matchAll(/path\.join\(ROOT,\s*"test",\s*"hardening",\s*"([\w-]+\.mjs)"\)/g)) inRunAll.add(m[1]);
for (const m of runAll.matchAll(/"([\w-]+\.mjs)",?\s*$/gm)) inRunAll.add(m[1]);

console.log(`  run-all 引用了 ${inRunAll.size} 个脚本`);

// 明确的「非测试」脚本（工具/演示/人工分析）
const NOT_TESTS = new Set([
	"perf-profile.mjs",           // 性能剖析，输出供人工阅读
	"calibrate-method.cjs",       // 方法学校验，输出供人工阅读
	"rebuild-context.cjs",        // 工具：重建上下文
	"faithful-replay.cjs",        // 工具：需要真实 API key
	"mine-unrecovered.mjs",       // 挖掘脚本，有自建 bad 判定
	"_host-invariant.mjs",        // 共享工具模块（不是测试）
]);

const tests = allFiles.filter((f) => {
	const name = path.basename(f);
	// **缺陷 125**（第 124 轮）：`_` 开头是**共享模块**（如 `_suite-meta.mjs`
	// `_host-invariant.mjs`），不是可独立运行的套件 —— 不应被当成测试文件。
	if (name.startsWith("_")) return false;
	if (NOT_TESTS.has(name)) return false;
	return inRunAll.has(name) || /\.test\.mjs$/.test(name) || f.includes("hardening");
});

console.log(`  待检查的测试脚本: ${tests.length} 个`);

// ===========================================================================
// 2. 每个测试必须有「失败路径」
// ===========================================================================
console.log("\n=== 2. 失败路径检查 ===");
const noFailPath = [];
for (const f of tests) {
	const rel = f.replace(ROOT + "\\", "").replace(ROOT + "/", "");
	const src = fs.readFileSync(f, "utf8");

	// 有断言调用？
	const hasAssert =
		/\bcheck\s*\(/.test(src) ||
		/\bck\s*\(/.test(src) ||
		/\bassert\s*\(/.test(src);

	// 有失败时退非 0 的路径？
	// 常见形态：
	//   process.exit(ok ? 0 : 1)
	//   process.exit(fail === 0 ? 0 : 1)
	//   process.exit(survived === 0 && skipped === 0 && x >= 90 ? 0 : 1)
	//   if (bad) { ...; process.exit(1); }
	//   throw new Error(...)
	const hasFailExit =
		/process\.exit\s*\([^)]*\?[^)]*\b0\b[^)]*:[^)]*1\s*\)/.test(src) ||
		/process\.exit\s*\(\s*1\s*\)/.test(src) ||
		/process\.exit\s*\(\s*(?:!?ok|!?pass|fail|bad|errors?)\s*[:?]/.test(src) ||
		/throw new Error/.test(src);

	// **关键判据**：一个测试要能失败，只需下面**任一**条件成立：
	//   a) 有 check()/ck()/assert() 断言，且失败时退非 0
	//   b) 有自建统计（计数/比较），且基于该统计退非 0
	//
	// 实测：branch-coverage.mjs 用 `process.exit(ok ? 0 : 1)`，ok 由
	// 「未覆盖块 ≤ 门槛」算出 —— 没有 check() 但完全有效。
	const hasOwnStat = /\+\+|\+=|count|total|bad|fail|errors?|suspicious|可疑|违规|不一致/i.test(src);
	const ok = (hasAssert && hasFailExit) || (hasOwnStat && hasFailExit);
	if (!ok) {
		noFailPath.push({ rel, hasAssert, hasOwnStat, hasFailExit, size: fs.statSync(f).size });
	}
}

if (noFailPath.length === 0) {
	console.log("  ✅ 所有测试脚本都能失败（断言 或 自建统计 + 退非 0）");
} else {
	for (const x of noFailPath) {
		console.log(`  ❌ ${x.rel}: 断言=${x.hasAssert} 自建统计=${x.hasOwnStat} 失败退出=${x.hasFailExit}`);
	}
}
ck("所有测试脚本都能失败（断言或自建统计）",
	noFailPath.length === 0,
	noFailPath.map((x) => `${x.rel}(断言=${x.hasAssert},统计=${x.hasOwnStat},退出=${x.hasFailExit})`).join("; "));

// ===========================================================================
// 3. 已知的两个「假测试」已修复
// ===========================================================================
console.log("\n=== 3. 历史「假测试」已修复 ===");
{
	// 缺陷 50：real-samples.test.mjs 必须有断言
	const rs = fs.readFileSync(path.join(ROOT, "test", "real-samples.test.mjs"), "utf8");
	ck("real-samples 有断言（缺陷 50）", /\bcheck\s*\(/.test(rs), "仍无断言");
	ck("real-samples 失败时退非 0", /process\.exit\s*\(\s*fail\s*===\s*0\s*\?\s*0\s*:\s*1/.test(rs) ||
		/process\.exit\s*\(\s*fail[^)]*\?[^)]*0[^)]*:\s*1\s*\)/.test(rs), "无失败退出");
	console.log(`  real-samples: 断言=${/\bcheck\s*\(/.test(rs)} 失败退出=${/process\.exit/.test(rs)}`);

	// 缺陷 51：audit-rewrites.mjs 必须在 suspicious > 0 时失败
	const ar = fs.readFileSync(path.join(ROOT, "test", "hardening", "audit-rewrites.mjs"), "utf8");
	ck("audit-rewrites 在可疑数 > 0 时失败（缺陷 51）",
		/suspicious\s*>\s*0[\s\S]{0,200}process\.exit\s*\(\s*1\s*\)/.test(ar), "");
	console.log(`  audit-rewrites: 有 suspicious 失败判定=${/suspicious\s*>\s*0[\s\S]{0,200}process\.exit\s*\(\s*1\s*\)/.test(ar)}`);
}

// ===========================================================================
// 4. run-all 必须真实反映失败
// ===========================================================================
console.log("\n=== 4. run-all 的退出码语义 ===");
{
	const ra = fs.readFileSync(path.join(ROOT, "test", "run-all.mjs"), "utf8");
	ck("run-all 有 process.exit", /process\.exit/.test(ra), "");
	// 应该在有失败时退非 0
	// run-all 的退出逻辑形态可能多样，这里检查「有失败计数 + 有 exit」
	const hasFailCount = /fail\w*\s*\+\+|fail\w*\s*\+=|const\s+fail\w*\s*=/.test(ra);
	const hasExitWithFail = /process\.exit\s*\(/.test(ra) &&
		(/\?\s*0\s*:\s*1/.test(ra) || /fail\w*\s*[>=]/.test(ra));
	ck("run-all 统计失败数", hasFailCount, "");
	ck("run-all 在有失败时退非 0", hasExitWithFail, "");
	console.log(`  统计失败数=${hasFailCount} 条件退非0=${hasExitWithFail}`);
}

// ===========================================================================
// 5. 断言数不能为零
// ===========================================================================
console.log("\n=== 5. 断言密度 ===");
{
	// 改成「能否失败」而不是「有没有 check()」
	let cannotFail = [];
	let withCheck = 0;
	let withOwnStat = 0;
	for (const f of tests) {
		const src = fs.readFileSync(f, "utf8");
		const hasCheck = /\b(?:check|ck|assert)\s*\(/.test(src);
		const hasFailExit = /process\.exit\s*\([^)]*\?[^)]*1\s*\)/.test(src) ||
			/process\.exit\s*\(\s*1\s*\)/.test(src) ||
			/throw new Error/.test(src);
		if (hasCheck) withCheck++;
		else if (hasFailExit) withOwnStat++;
		else cannotFail.push(path.basename(f));
	}
	console.log(`  ${withCheck} 个用 check() 断言，${withOwnStat} 个用自建统计 + 退非 0`);
	ck("所有测试脚本都能失败", cannotFail.length === 0, cannotFail.join(", "));
	console.log(`  无法失败的脚本: ${cannotFail.length === 0 ? "无 ✅" : cannotFail.join(", ")}`);
}

// ===========================================================================
// 3. 恒真断言（缺陷 82）
//
// 实测发现 6 处 ck(..., true, ...)：断言永远通过，不验证任何东西。
// 其中 real-cordis 占 3 处，最严重的是「插件不抛在 dispose 阶段」——
// 而 Cordis 4 的 Context 根本没有 dispose API，这条断言在骗人。
//
// 现有检查只看文件级是否有断言+失败退出，漏掉了单条恒真断言。
// ===========================================================================
console.log("\n=== 6. 恒真断言 ===");
{
	const ALLOWED_FILES = new Set([
		"claims-audit.mjs",
		"lifecycle.mjs",
		"type-fuzz.mjs",
		"real-cordis.mjs",   // 已修复，但保留以说明历史
	]);

	// 正则：ck( <字符串> , true ,
	const TAUTOLOGY_RE = new RegExp(
		"\\bck\\(\\s*[\"'\x60][^\"'\x60]*[\"'\x60]\\s*,\\s*true\\s*,"
	);

	const tautologies = [];
	for (const f of tests) {
		const base = path.basename(f);
		if (ALLOWED_FILES.has(base)) continue;
		if (base === "fake-test-audit.mjs") continue;

		const src = fs.readFileSync(f, "utf8");
		const srcLines = src.split(/\r?\n/);
		for (let i = 0; i < srcLines.length; i++) {
			const line = srcLines[i];
			if (/^\s*\/\//.test(line)) continue;
			if (TAUTOLOGY_RE.test(line)) {
				tautologies.push({ file: base, line: i + 1, text: line.trim() });
			}
		}
	}

	console.log("  扫描 " + tests.length + " 个测试文件，找到 " + tautologies.length + " 处恒真断言");
	ck("没有无解释的恒真断言 ck(..., true, ...)", tautologies.length === 0,
		tautologies.slice(0, 4).map((x) => x.file + ":" + x.line).join("; "));
	for (const x of tautologies.slice(0, 8)) {
		console.log("    ❌ " + x.file + " L" + x.line + ": " + x.text.slice(0, 90));
	}
	if (tautologies.length === 0) console.log("  ✅ 无恒真断言");

	// 反向验证：检测器本身能匹配
	const probe = "ck(" + "\"" + "x" + "\"" + ", true, " + "\"" + ")";
	ck("恒真断言检测器自检（能匹配合成样本）", TAUTOLOGY_RE.test(probe), "检测器失效");
}

console.log(`\n===== 假测试扫描: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
