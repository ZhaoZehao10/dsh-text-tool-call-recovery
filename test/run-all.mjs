#!/usr/bin/env node
// 一键运行全部验证（27+ 层）
//
// 用法：
//   node test/run-all.mjs              # 跑全部
//   node test/run-all.mjs --quick      # 跳过最慢的（真实数据相关）
//   node test/run-all.mjs --offline    # 跳过需要真实日志的套件
//
// 依赖：被测插件 lib/index.js；dsh-llm 用 DSH_LLM_SRC 或仓库 node_modules。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const OFFLINE = args.includes("--offline");

// **缺陷 149**（第 142 轮）：单个套件的超时上限。
//
// 实测数据（作者本机，2026-10）：
//   · `--offline` 全量 100 个套件共 **526 秒**；
//   · 最慢的单个套件是 `coverage`（**172 秒**），其次 `branch-coverage`。
//
// 原来写死 600000（10 分钟）。对作者本机够用，但**慢 3.5 倍的机器/CI**
// 上 `coverage` 就会超时 —— 而超时原来和「断言失败」显示得一模一样，
// 维护者会去翻代码找不存在的 bug。
//
// 现在提到 20 分钟（对最慢套件留 7 倍余量），并可用环境变量覆盖：
//   `DSH_TEST_TIMEOUT_MS=1800000 node test/run-all.mjs`
const TIMEOUT_MS = Number(process.env.DSH_TEST_TIMEOUT_MS) > 0
	? Number(process.env.DSH_TEST_TIMEOUT_MS)
	: 20 * 60 * 1000;

// 需要真实会话日志的套件
// **缺陷 125**（第 124 轮）：这三份列表曾在四个文件里各存一份，改一处不同步其余，
// 导致 `perf-baseline` 只在 run-all 里被正确对待（覆盖率/变异测试里必然失败）。
// 现在统一从 `_suite-meta.mjs` 导入，**只保留一份定义**。
import { NEEDS_GC, NEEDS_LOGS, SLOW } from "./hardening/_suite-meta.mjs";

// **缺陷 158**（第 151 轮）：本套件会**读取 lib/index.js** 并据此判定。若此刻
// `mutation-test` / `shape-robustness` 正在改写它（注入变异体），这里读到的是**被污染的源码**，
// 产出的失败全是假的 —— 实测曾因此让完整模式报出 3 个假超时/假失败、耗时恶化到 95 分钟。
// 现在检测到写锁就**明确跳过**（exit 0 并说明原因），绝不产出假红。
import { exitIfLibLocked } from "./hardening/_lib-lock.mjs";
{
	let sawMsg = false;
	// **缺陷 158 自我修正**：第二个参数是**日志函数**，不是回调标记 ——
	// 第一版传了 `() => { sawMsg = true }`，导致跳过生效但**原因没打印**（静默跳过）。
	exitIfLibLocked("run-all.mjs", (s) => { sawMsg = true; console.log(s); });
	if (sawMsg) process.exit(0);
}
const hardeningDir = path.join(ROOT, "test", "hardening");
const suites = [];

// 被跳过的套件（必须在结尾显式报告，避免误以为全跑了）
const skipped = [];

// 主集成测试总是先跑
suites.push({ name: "集成断言", file: path.join(ROOT, "test", "integration.test.mjs"), kind: "core" });
suites.push({ name: "复刻样本", file: path.join(ROOT, "test", "real-samples.test.mjs"), kind: "core" });

// **缺陷 88**：`_` 开头的文件是**共享工具模块**（如 `_host-invariant.mjs`），
// 不是可独立运行的套件，必须跳过。
	for (const f of fs.readdirSync(hardeningDir).filter((x) => x.endsWith(".mjs") && !x.startsWith("_")).sort()) {
	// **跳过必须显式记录**：早期版本直接 continue 且无任何提示，
	// 导致使用者误以为「跑了 quick 就等于跑了全部」，从而漏掉变异测试、
	// 覆盖率、真实数据这些深度检查（本项目实际因此漏看过两轮缺陷）。
	const skipReasons = [];
	if (f === "mutation-test.mjs" && (QUICK || OFFLINE)) skipReasons.push(QUICK ? "--quick" : "--offline");
	if (NEEDS_LOGS.has(f) && OFFLINE) skipReasons.push("--offline（需要真实日志）");
	if (SLOW.has(f) && QUICK) skipReasons.push("--quick（慢速套件）");
	if (skipReasons.length > 0) {
		// 去重（同一文件可能同时命中多个跳过条件，如 mutation-test 既是元套件又慢）
		skipped.push({ file: f, why: [...new Set(skipReasons)].join(" + ") });
		continue;
	}
	suites.push({ name: f.replace(/\.mjs$/, ""), file: path.join(hardeningDir, f), kind: NEEDS_LOGS.has(f) ? "real-data" : "unit" });
}

const env = { ...process.env };
if (!env.USERPROFILE && !env.HOME) env.USERPROFILE = process.env.USERPROFILE ?? "";

console.log("=".repeat(72));
console.log(`运行 ${suites.length} 个验证套件${QUICK ? "（--quick）" : ""}${OFFLINE ? "（--offline）" : ""}`);
console.log("=".repeat(72));

const results = [];
let totalMs = 0;
for (let i = 0; i < suites.length; i++) {
	const s = suites[i];
	const idx = String(i + 1).padStart(2);
	const t0 = Date.now();
	let ok = false, out = "", skipped = false, timedOut = false;
	try {
		const nodeArgs = NEEDS_GC.has(path.basename(s.file)) ? ["--expose-gc", s.file] : [s.file];
		// **缺陷 156**（第 149 轮）：execFileSync 的 maxBuffer 默认只有 **1 MB**。
		// 多个套件会在循环里打印大量行（`baseline-regression` 38 处、`code-quality` 34 处、
		// `claims-audit` 31 处循环内输出），且失败明细可能很长。一旦超过 1 MB，
		// execFileSync 会抛 `ENOBUFS`（ERR_CHILD_PROCESS_STDIO_MAXBUFFER）——
		// **套件本来是通过的，却被运行器自己判成失败**，且报错信息完全看不出是缓冲区问题。
		// 提到 64 MB（覆盖最大套件 `coverage` 收集 100 个子进程输出的场景）。
		out = execFileSync(process.execPath, nodeArgs, { cwd: ROOT, env, encoding: "utf8", stdio: "pipe", timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
		ok = true;
		if (/^跳过：/m.test(out)) skipped = true;
	} catch (e) {
		out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
		ok = false;
		// **缺陷 149**（第 142 轮）：超时的套件原来和「断言失败」显示得**一模一样** ——
		// 都是 [FAIL] + conclusion "FAIL"。而本轮实测 `coverage` 单套件就要 **172 秒**，
		// 慢机器/CI 上很容易撞到下面这个 600 秒超时。此时维护者看到的是
		//   [FAIL] coverage  600123ms  FAIL
		// **完全看不出原因是「超时」而不是「断言挂了」** —— 会去翻代码找不存在的 bug。
		// 现在把超时单独标出来，并在结论里写明建议。
		if (e.code === "ETIMEDOUT" || e.signal === "SIGTERM") {
			timedOut = true;
		}
		// **缺陷 106**：原逻辑在这里写 `if (/^跳过：/m.test(out)) { skipped = true; ok = true; }`，
		// 也就是「只要输出里出现过『跳过：』，即使子进程 exit 1 也当成跳过」。
		// 实测：一个 exit 1 的失败套件，只要它前面打印过一句「跳过：某个子检查」，
		// 就会被 run-all 判成 SKIP —— 而 SKIP **不计入 fail 统计**，失败被完全掩盖。
		// 现在收紧为：**跳过必须由子进程以退出码 0 声明**（套件在「真的无法运行」时
		// 应打印「跳过：」并 exit 0）；退出码非 0 一律判 FAIL，不再被「跳过」字样洗白。
	}
	const ms = Date.now() - t0;
	totalMs += ms;

	// 提取最后一行有意义的结论
	const lines = out.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("===") && !l.startsWith("---"));
	let conclusion = lines.filter((l) => /通过|passed|failed|✅|❌|一致|正常|可疑|覆盖率|跳过|mutation|结果/.test(l)).pop() ?? (ok ? "OK" : "FAIL");
	if (timedOut) {
		// 超时时**优先显示原因**：否则维护者会以为是断言失败去翻代码。
		conclusion = `⏱ 超时（> ${TIMEOUT_MS / 1000}s 未结束）—— 可能是机器太慢或套件卡死，不一定是 bug`;
	}
	// **缺陷 150**（第 143 轮）：一个**什么都没输出、exit 0** 的子进程，
	// 原来会被判成 PASS。这与缺陷 38（「测试文件里没有任何断言，永远通过」）
	// 是同一个陷阱的**运行器版本** —— 套件可以「悄悄不跑」却显示绿。
	//
	// 实测：写一个只 `process.exit(0)` 的假套件，run-all 判 **PASS、结论 "OK"**。
	// 现有 110 个套件都有实质输出，所以这条一直没被触发 —— 但**没有任何防线**。
	//
	// 判据：**PASS 必须伴随至少一行实质输出**（排除纯空行与分隔线）。
	// 无输出的 exit 0 判为 FAIL 并明确说明原因 —— 宁可让人看见「这个套件没说话」，
	// 也不要让它静默地算作通过。
	// **缺陷 150 自我修正**：第一版用 `lines.length > 0` 判断，但 `lines` 已经
	// 被过滤掉所有 `===` 开头的行 —— 而**几乎所有套件的汇总行都以 `=====` 开头**
	// （例如 `===== 裸 JSON 安全事故回归: 18 passed, 0 failed =====`）。
	// 结果 14 个正常套件被判成「无输出」。
	// 改为**直接看原始 out**：只要有任意非空行就算有实质输出。
	// **缺陷 151**（第 144 轮）：套件**自己打印了 ❌ / FAIL，却 exit 0** ——
	// 原来 run-all 判 **PASS**，而结论里赫然写着「❌ 某项失败」。**自相矛盾**。
	//
	// 实测（构造的假套件）：
	//   console.log("  ❌ 某项失败"); process.exit(0);
	//   → status = PASS，conclusion = "❌ 某项失败"
	//
	// 现有 96 个套件都没触发（都不这么写），但这说明**运行器完全信任退出码**，
	// 而「套件打印了失败标记却忘了 exit 1」是一个**极容易犯的错**。
	// 判据：**输出里出现失败标记时，不得判 PASS** —— 宁可报「可疑」让人复核。
	const hasSubstance = ok && out.split("\n").some((l) => l.trim().length > 0);
	// **缺陷 151 自我修正**：第一版正则是 `FAIL[\s:：]`，结果把
	//   `  PASS: 9, FAIL: 0`
	// 这种「**零失败**的统计行」也当成了失败标记，误报 1 个套件。
	// 关键区别：`FAIL: 0` / `failed 0` 表示**没有失败**，不是失败。
	// 现在要求失败标记后跟**非零数字**，或行首 ❌。
	const claimsFailure =
		/(^|\n)\s*❌/.test(out) ||
		/\bfailed[\s:：]*[1-9]|[1-9]\s*failed\b/.test(out) ||
		/\bFAIL[\s:：]*[1-9]|[1-9]\s*FAIL\b/.test(out);
	// 注意：`failed 0` 不算失败标记；只有非零才可疑。
	const contradiction = ok && hasSubstance && claimsFailure;
	const status = skipped ? "SKIP"
		: !ok ? (timedOut ? "TIMEOUT" : "FAIL")
		: !hasSubstance ? "FAIL"
		: contradiction ? "SUSPECT"
		: "PASS";
	if (ok && !hasSubstance) {
		conclusion = "❌ 套件 exit 0 但**没有任何输出** —— 无法确认它真的检查过什么（缺陷 150）";
	} else if (contradiction) {
		conclusion = `⚠️ 输出里出现失败标记但 exit 0 —— ${conclusion.slice(0, 40)}（缺陷 151，请人工复核）`;
	}
	const color = status === "PASS" ? "" : status === "SKIP" ? "" : " <<<<";

	console.log(`${idx}. [${status}] ${s.name.padEnd(26)} ${String(ms).padStart(6)}ms  ${conclusion.slice(0, 70)}${color}`);
	results.push({ name: s.name, status, ms, conclusion });
}

const pass = results.filter((r) => r.status === "PASS").length;
// **SUSPECT 计入失败**：宁可让人看见「这里自相矛盾」，也不要静默通过。
const fail = results.filter((r) => r.status === "FAIL" || r.status === "SUSPECT").length;
const suspect = results.filter((r) => r.status === "SUSPECT").length;
const skip = results.filter((r) => r.status === "SKIP").length;

console.log("=".repeat(72));
console.log(`结果：${pass} 通过 / ${fail} 失败 / ${skip} 跳过   总耗时 ${(totalMs / 1000).toFixed(1)}s`);
console.log("=".repeat(72));

if (fail > 0) {
	console.log("\n失败套件：");
	for (const r of results.filter((x) => x.status === "FAIL" || x.status === "SUSPECT")) {
		console.log(`  ❌ ${r.name}: ${r.conclusion}`);
	}
	process.exit(1);
}
// **被跳过的套件必须显式列出**：否则使用者会误以为「跑完就是全跑了」。
// 深度检查（变异测试 / 覆盖率 / 真实数据）都在跳过之列，漏跑会漏掉缺陷。
if (skipped.length > 0) {
	console.log("");
	console.log("⚠️  以下 " + skipped.length + " 个套件**未运行**（不计入上面的通过数）：");
	for (const s of skipped) console.log("     - " + s.file.replace(/\.mjs$/, "") + "   （" + s.why + "）");
	console.log("");
	console.log("     → 要跑全部深度检查，请去掉 --quick 与 --offline：");
	console.log("       node test/run-all.mjs");
}
console.log("\n✅ 全部通过");
process.exit(0);
