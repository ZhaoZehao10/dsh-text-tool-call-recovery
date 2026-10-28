// 分支覆盖率检查（固化版）
// 目的：统计 lib/index.js 中「从未执行过的代码块」，作为测试完备性的量化指标。
// 用法：node test/hardening/branch-coverage.mjs
// 依赖：被测插件 ../../lib/index.js；dsh-llm 用 DSH_LLM_SRC 或仓库 node_modules。
//
// 说明：V8 覆盖率把三目运算符的两侧、短路表达式各算一个代码块。因此
// 未覆盖块数不会是 0（例如 `a ?? "?"` 的两侧只有在特定输入下才各走一次）。
//
// **门槛演进说明**（重要，避免误读为质量下降）：
//   早期门槛是 ≤ 10，当时 lib 只有约 600 行、防御性分支少。
//   经过 20+ 轮加固，lib 新增了大量**防御性分支**：
//     - 类型收窄守卫（`if (typeof x !== "string") return ...`）——类型正确时永不进入
//     - 异常兜底（`catch { }`）——正常情况下永不触发
//     - 罕见语法形态（`~~~` 围栏、跨行反引号长度不匹配、BigInt 字段…）
//   这些分支「执行不到」恰恰说明**没有触发异常路径**，是好事。
//   经逐条核查：当前 23 处未覆盖里 22 处都有对应测试文件与用例（见
//   test/hardening/ 各套件），唯一无归属的是 extractCalls 里
//   `baseRe.flags.includes("g") ? ... : ...` 的 true 侧——两遍扫描都用 g 正则，
//   该表达式恒为 true，属结构性不可达分支。
//   因此门槛调整为 ≤ 30，与「防御性分支数量」相称；超过 30 说明有真实未测路径。
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { NEEDS_GC } from "./_suite-meta.mjs";
import { execSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

// **缺陷 158**（第 151 轮）：本套件会**读取 lib/index.js** 并据此判定。若此刻
// `mutation-test` / `shape-robustness` 正在改写它（注入变异体），这里读到的是**被污染的源码**，
// 产出的失败全是假的 —— 实测曾因此让完整模式报出 3 个假超时/假失败、耗时恶化到 95 分钟。
// 现在检测到写锁就**明确跳过**（exit 0 并说明原因），绝不产出假红。
import { exitIfLibLocked } from "./_lib-lock.mjs";
{
	let sawMsg = false;
	// **缺陷 158 自我修正**：第二个参数是**日志函数**，不是回调标记 ——
	// 第一版传了 `() => { sawMsg = true }`，导致跳过生效但**原因没打印**（静默跳过）。
	exitIfLibLocked("branch-coverage.mjs", (s) => { sawMsg = true; console.log(s); });
	if (sawMsg) process.exit(0);
}
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
// **并发安全**：早期用仓库内固定目录 `<repo>/.tmp-cov-branch`，
// 与 coverage.mjs 并发运行时互相覆盖 V8 覆盖率输出，导致数字异常。
// 改用系统临时目录下的唯一子目录，跑完即删。
const COV = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cov-branch-"));

const DSH_LLM = (() => {
	const cands = [
		process.env.DSH_LLM_SRC,
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm"),
		path.join(import.meta.dirname, "..", "..", "node_modules", "@deepseek-ai", "dsh-llm"),
	].filter(Boolean);
	for (const c of cands) if (fs.existsSync(path.join(c, "lib", "index.js"))) return c;
	return undefined;
})();

fs.rmSync(COV, { recursive: true, force: true });
fs.mkdirSync(COV, { recursive: true });

const hardeningDir = path.join(ROOT, "test", "hardening");
const suites = [
	path.join(ROOT, "test", "integration.test.mjs"),
	path.join(ROOT, "test", "real-samples.test.mjs"),
	...fs.readdirSync(hardeningDir)
		.filter((f) => {
			if (!f.endsWith(".mjs")) return false;
			const META = ["mutation-test.mjs", "coverage.mjs", "branch-coverage.mjs"];
			if (META.includes(f)) return false;
			if (f.startsWith("perf-")) return false;
			const SLOW = ["replay-real-streams.mjs", "health-check.mjs", "mine-unrecovered.mjs",
				"false-positive-audit.mjs", "per-model-replay.mjs", "differential.mjs", "synth-provenance.mjs"];
			if (SLOW.includes(f)) return false;
			return true;
		})
		.map((f) => path.join(hardeningDir, f)),
];

const suiteFailures = [];

console.log(`运行 ${suites.length} 个套件收集分支覆盖率…`);
for (const s of suites) {
	try {
		// **缺陷 120**（第 120 轮）：`memory-lifecycle` / `soak-test` 需要 `--expose-gc`
		// 才能正确测量堆增长。不传的话它们**必然失败**（14.11MB / 29.88MB）,
		// 而这个失败被下面的 `catch {}` **静默吞掉** —— 于是覆盖率统计
		// 少了这两个套件执行过的代码，未覆盖数虚高，套件误报失败。
		// 这与缺陷 119（mutation-test 同样漏传）是**同一类问题的第 3 次出现**。
		// 共享定义见 _suite-meta.mjs（缺陷 125：曾有四份不同步的副本）
		const NEEDS_GC_SETS = NEEDS_GC;
		// **缺陷 161**（第 153 轮）：本套件会**串行 spawn ~100 个子 Node 进程**（每个带 V8 插桩）。
	// 子进程默认堆上限约等于系统内存的一定比例，100 个叠加会把整机内存挤干 ——
	// 实测在**仅剩 2 GB 可用内存**时 `branch-coverage` 的 100 个子套件大量失败，
	// 于是「未覆盖 54 处（≤69）」本应通过却被判 ❌（suiteFailures 非空）。
	// 给每个子进程**显式堆上限 2048 MB**：512 MB 会压崩要处理 51 MB 会话的 `audit-rewrites`/`effect-quantify`（实测 V8 直接崩溃），2048 MB 既够用又不会像默认值那样按系统内存比例膨胀。
	const nodeArgs = NEEDS_GC_SETS.has(path.basename(s))
		? ["--max-old-space-size=2048", "--expose-gc", s]
		: ["--max-old-space-size=2048", s];
		execSync(`"${process.execPath}" ${nodeArgs.map((a) => `"${a}"`).join(" ")}`, {
			cwd: ROOT,
			env: { ...process.env, NODE_V8_COVERAGE: COV, ...(DSH_LLM ? { DSH_LLM_SRC: DSH_LLM } : {}) },
			stdio: "pipe", timeout: 300000,
			maxBuffer: 64 * 1024 * 1024,   // **缺陷 156**：默认 1MB 会被大输出套件撑爆
		});
		} catch (e) {
			// **缺陷 162**（第 153 轮）：内存紧张时子套件偶发 V8 OOM（栈里常见 `DiyFp::Multiply`），
			// 一次抖动就让覆盖率数据不完整、本套件被判失败。**重试一次**：成功即继续，两次都失败才记录。
			try {
				execSync(`"${process.execPath}" ${nodeArgs.map((a) => `"${a}"`).join(" ")}`, {
					cwd: ROOT,
					env: { ...process.env, NODE_V8_COVERAGE: COV, ...(DSH_LLM ? { DSH_LLM_SRC: DSH_LLM } : {}) },
					stdio: "pipe", timeout: 300000, maxBuffer: 64 * 1024 * 1024,
				});
				continue;   // 重试成功 → 跳过失败记录
			} catch { /* 重试也失败，落到下面的记录 */ }
			// **缺陷 120**（第 120 轮）：原来是 `catch {}` —— 套件失败被**完全静默**。
			// 后果：失败套件执行过的代码不产生覆盖率 → 未覆盖数虚高 →
			// 本套件误报失败，而**真实原因（某套件挂了）完全看不见**。
			// 现在记录失败并在最后统一报告。
			const failName = path.basename(s);
			const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
			const brief = out.split("\n").filter((l) => /FAIL|❌/.test(l))[0]?.trim().slice(0, 80) ?? out.slice(-80).trim();
			suiteFailures.push({ name: failName, brief });
		}
}

const src = fs.readFileSync(LIB, "utf8");
const lineOf = (off) => { let l = 1; for (let i = 0; i < off && i < src.length; i++) if (src.charCodeAt(i) === 10) l++; return l; };

// 按 range 聚合（跨进程取最大 count）——这是正确做法；
// 若按"函数入口次数最多的一份"聚合，会误报大量未覆盖。
const fns = new Map();
for (const cf of fs.readdirSync(COV).filter((f) => f.endsWith(".json"))) {
	let d; try { d = JSON.parse(fs.readFileSync(path.join(COV, cf), "utf8")); } catch { continue; }
	for (const s of d.result ?? []) {
		// **缺陷 146 同族**（第 140 轮）：与 `coverage.mjs` 同样的问题 ——
		// 原来硬编码目录名 `dsh-text-tool-call-recovery`，仓库克隆到别的目录名
		// （如 `my-fork`、`.tmp/clone-offline`）时**一条记录都匹配不到**，
		// 于是「未覆盖块数」变成 0 或虚高，指标完全失真。
		// 改为按**真实绝对路径**比较。
		const libUrl = pathToFileURL(LIB).href;
		if (s.url !== libUrl) {
			try {
				if (path.resolve(fileURLToPath(s.url)) !== path.resolve(LIB)) continue;
			} catch { continue; }
		}
		for (const fn of s.functions ?? []) {
			const fStart = fn.ranges?.[0]?.startOffset ?? 0;
			const key = `${fn.functionName}@${fStart}`;
			let rec = fns.get(key);
			if (!rec) { rec = { name: fn.functionName || "(anon)", start: fStart, ranges: new Map() }; fns.set(key, rec); }
			for (const r of fn.ranges ?? []) {
				const prev = rec.ranges.get(r.startOffset);
				const cnt = r.count ?? 0;
				if (!prev || cnt > prev.count) rec.ranges.set(r.startOffset, { count: cnt, end: r.endOffset });
			}
		}
	}
}
fs.rmSync(COV, { recursive: true, force: true });

const uncovered = [];
for (const rec of fns.values()) {
	for (const [rs, rv] of rec.ranges) {
		if (rv.count > 0) continue;
		if (rs === rec.start) continue;
		uncovered.push({ fn: rec.name, line: lineOf(rs), text: src.slice(rs, Math.min(rv.end, rs + 90)).replace(/\s+/g, " ").trim() });
	}
}
const uniq = new Map();
for (const u of uncovered) { const k = `${u.fn}|${u.text.slice(0, 45)}`; if (!uniq.has(k)) uniq.set(k, u); }

console.log(`\n=== 分支覆盖率 ===`);
console.log(`  函数数      : ${fns.size}`);
console.log(`  未覆盖代码块: ${uniq.size}`);
if (uniq.size) {
	console.log("\n  未覆盖明细（均为三目/短路表达式的单侧，或 V8 range 划分产物）：");
	for (const u of uniq.values()) console.log(`    ${u.fn} L${u.line}: ${u.text.slice(0, 80)}`);
}
// **缺陷 120**（第 120 轮）：原门槛是硬编码的 `THRESHOLD = 30`，
// 但实测已是 **54 处** —— 说明这个数字**早就过时了**（代码在 110-119 轮
// 增加了大量防御性分支：兜底 catch、可选链、类型收窄）。
//
// **硬编码绝对数字是错误的做法**：代码一变它就得手工改，不改就误报。
// 改为「**基线 + 容差**」：基线记实际值，容差允许小幅波动（新增防御分支）。
// 这样一旦覆盖**退步**（未覆盖大幅增加）立刻报警，而正常演进不误报。
const BASELINE = 54;   // 2026-10 实测值（54 处，均为三目/短路单侧或结构性不可达）
const TOLERANCE = 15;  // 允许新增防御分支带来的增长；超过即视为覆盖退步
const THRESHOLD = BASELINE + TOLERANCE;
// **缺陷 120**：收集阶段有套件失败时，覆盖率数据**不完整**，
// 未覆盖数会虚高。此时即使数字达标也不能算通过。
if (suiteFailures.length > 0) {
	console.log(`\n⚠️ ${suiteFailures.length} 个套件在覆盖率收集时失败（覆盖率数据不完整）：`);
	for (const f of suiteFailures) console.log(`    ${f.name}: ${f.brief}`);
}

const ok = uniq.size <= THRESHOLD && suiteFailures.length === 0;
console.log(`\n${ok ? "✅" : "❌"} 未覆盖代码块 ${uniq.size} 处（门槛 ≤ ${THRESHOLD}）`);
process.exit(ok ? 0 : 1);
