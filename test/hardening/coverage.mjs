// 代码覆盖率检查（V8 内置覆盖率）
// 目的：确保 lib/index.js 里**没有从未被任何测试执行过的函数**。
// 未执行的代码 = 未验证的代码 = 潜在 bug 藏身处。
// 用法：node test/hardening/coverage.mjs
// 依赖：被测插件 ../../lib/index.js；dsh-llm 用 DSH_LLM_SRC 或仓库 node_modules。
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
	exitIfLibLocked("coverage.mjs", (s) => { sawMsg = true; console.log(s); });
	if (sawMsg) process.exit(0);
}
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
// **并发安全**：早期用仓库内固定目录 `<repo>/.tmp-coverage-run`，
// 两个覆盖率脚本同时跑（或同时跑两次本脚本）会互相覆盖 NODE_V8_COVERAGE
// 的输出目录，读到别人的数据 → 未覆盖数字异常（实测出现过 23 → 129 处）。
// 改用系统临时目录下的唯一子目录，跑完即删。
const COV_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cov-"));

// 解析 dsh-llm 位置（传给子进程）
const DSH_LLM = (() => {
	const candidates = [
		process.env.DSH_LLM_SRC,
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm"),
		path.join(import.meta.dirname, "..", "..", "node_modules", "@deepseek-ai", "dsh-llm"),
	].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(path.join(c, "lib", "index.js"))) return c;
	return undefined;
})();

fs.rmSync(COV_DIR, { recursive: true, force: true });
fs.mkdirSync(COV_DIR, { recursive: true });

const hardeningDir = path.join(ROOT, "test", "hardening");
const suites = [
	path.join(ROOT, "test", "integration.test.mjs"),
	path.join(ROOT, "test", "real-samples.test.mjs"),
	...fs.readdirSync(hardeningDir)
		.filter((f) => {
			if (!f.endsWith(".mjs")) return false;
			// **排除元套件**（它们本身会运行其他套件，递归会导致超时/误导覆盖率）
			const META = ["mutation-test.mjs", "coverage.mjs", "branch-coverage.mjs"];
			if (META.includes(f)) return false;
			// **排除性能测量类**（在并发/负载下不稳定，且不增加代码路径覆盖）
			if (f.startsWith("perf-")) return false;
			// **排除依赖真实日志的套件**（覆盖率统计不需要，且它们很慢）
			const SLOW = ["replay-real-streams.mjs", "health-check.mjs", "mine-unrecovered.mjs",
				"false-positive-audit.mjs", "per-model-replay.mjs", "differential.mjs", "synth-provenance.mjs"];
			if (SLOW.includes(f)) return false;
			return true;
		})
		.map((f) => path.join(hardeningDir, f)),
];

const suiteFailures = [];

console.log(`运行 ${suites.length} 个测试套件收集 V8 覆盖率…`);
let ran = 0;
for (const s of suites) {
	try {
		// **缺陷 121**（第 121 轮）：`memory-lifecycle` / `soak-test` 需要 `--expose-gc`
		// 才能正确测量堆增长。不传的话它们**必然失败**，而失败被下面的
		// `catch` 静默吞掉 —— 它们的代码不产生覆盖率，函数覆盖率虚低。
		// 这与缺陷 119（mutation-test）、缺陷 120（branch-coverage）是同一类问题的第 4 次出现。
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
			env: {
				...process.env,
				NODE_V8_COVERAGE: COV_DIR,
				...(DSH_LLM === undefined ? {} : { DSH_LLM_SRC: DSH_LLM }),
			},
			stdio: "pipe",
			timeout: 300000,
			maxBuffer: 64 * 1024 * 1024,   // **缺陷 156**：默认 1MB 会被大输出套件撑爆
		});
		ran++;
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
		// **缺陷 121**：原为 `catch { }` —— 套件失败被完全静默。
		// 虽然这里只统计"跑了几个"，但失败意味着**覆盖率数据不完整**。
		const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
		suiteFailures.push({ name: path.basename(s), brief: out.split("\n").filter((l) => /FAIL|❌/.test(l))[0]?.trim().slice(0, 80) ?? out.slice(-80).trim() });
	}
}
console.log(`  完成 ${ran}/${suites.length}\n`);

// 汇总
const fnHits = new Map();
for (const cf of fs.readdirSync(COV_DIR).filter((f) => f.endsWith(".json"))) {
	let data;
	try { data = JSON.parse(fs.readFileSync(path.join(COV_DIR, cf), "utf8")); } catch { continue; }
	for (const script of data.result ?? []) {
		// **缺陷 146**（第 140 轮）：原来这里是**硬编码目录名**的字符串匹配 ——
		//     if (!script.url.includes("dsh-text-tool-call-recovery/lib/index.js")) continue;
		// 只要仓库被克隆到**别的目录名**（例如 `my-fork`），URL 里就没有
		// `dsh-text-tool-call-recovery` 这一段，于是**一条记录都匹配不到**，
		// 覆盖率报成 10%（只有 `apply`/`name` 等少数函数被统计）。
		// 实测：克隆到 `.tmp/clone-offline` 后 `--offline` 全量报
		// 「18 个函数从未被执行（10.0%）」，而同一份代码在作者本机是 100%。
		// **这正是「测试只在作者本机跑过」的典型后果。**
		//
		// 改为**按真实绝对路径**比较（LIB 已在上面用 path.join(ROOT, ...) 算好）：
		const libUrl = pathToFileURL(LIB).href;
		if (script.url !== libUrl && !script.url.endsWith("/lib/index.js")) continue;
		if (script.url !== libUrl) {
			// 兜底：规范化后再比（Windows 盘符大小写、斜杠方向可能不同）
			try {
				if (path.resolve(fileURLToPath(script.url)) !== path.resolve(LIB)) continue;
			} catch { continue; }
		}
		for (const fn of script.functions ?? []) {
			const name = fn.functionName || "(anonymous)";
			fnHits.set(name, (fnHits.get(name) ?? 0) + (fn.ranges?.[0]?.count ?? 0));
		}
	}
}
fs.rmSync(COV_DIR, { recursive: true, force: true });

const total = fnHits.size;
const covered = [...fnHits.values()].filter((h) => h > 0).length;
const never = [...fnHits.entries()].filter(([, h]) => h === 0).map(([n]) => n);
const pct = total > 0 ? ((covered / total) * 100).toFixed(1) : "0";

console.log("=== lib/index.js 函数覆盖率 ===");
console.log(`  记录函数 : ${total}`);
console.log(`  已执行   : ${covered}`);
console.log(`  从未执行 : ${never.length}`);
if (never.length) {
	console.log("\n  未执行的函数（未验证代码，需补测试或删除）：");
	for (const n of never) console.log(`    - ${n}`);
}
console.log(`\n函数覆盖率: ${pct}%`);

// **缺陷 121**：收集阶段有套件失败时覆盖率数据**不完整**，
// 未执行函数数会虚高。此时即使数字达标也不能算通过。
if (suiteFailures.length > 0) {
	console.log(`\n⚠️ ${suiteFailures.length} 个套件在覆盖率收集时失败（数据不完整）：`);
	for (const f of suiteFailures) console.log(`    ${f.name}: ${f.brief}`);
}

const ok = never.length === 0 && suiteFailures.length === 0;
console.log(ok ? "\n✅ 所有函数均被测试执行过" : `\n❌ ${never.length} 个函数从未被执行`);
process.exit(ok ? 0 : 1);
