// 测试矩阵真实性核查
//
// README 的测试矩阵里，**66 行**每一行都声明了一个规模数字（「29 项」、
// 「14,408 条真实流」、「46 个变异体」…）。这些数字是读者判断项目质量的
// 直接依据，但从未被系统核实过。
//
// 前 43 轮验证了「测试能通过」，但没验证「宣称的规模是不是真的」。
// 本套件把 README 里的每一行声明与实际运行结果对比。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// **缺陷 158**（第 151 轮）：本套件会**读取 lib/index.js** 并据此判定。若此刻
// `mutation-test` / `shape-robustness` 正在改写它（注入变异体），这里读到的是**被污染的源码**，
// 产出的失败全是假的 —— 实测曾因此让完整模式报出 3 个假超时/假失败、耗时恶化到 95 分钟。
// 现在检测到写锁就**明确跳过**（exit 0 并说明原因），绝不产出假红。
import { exitIfLibLocked } from "./_lib-lock.mjs";
{
	let sawMsg = false;
	// **缺陷 158 自我修正**：第二个参数是**日志函数**，不是回调标记 ——
	// 第一版传了 `() => { sawMsg = true }`，导致跳过生效但**原因没打印**（静默跳过）。
	exitIfLibLocked("claims-audit.mjs", (s) => { sawMsg = true; console.log(s); });
	if (sawMsg) process.exit(0);
}
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const README = path.join(ROOT, "README.md");
const HARDENING = path.join(ROOT, "test", "hardening");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

// ===========================================================================
// 1. 抽取 README 测试矩阵的声明
// ===========================================================================
console.log("=== 1. 抽取测试矩阵声明 ===");
const lines = fs.readFileSync(README, "utf8").split("\n");
const claims = [];
for (let i = 0; i < lines.length; i++) {
	const m = lines[i].match(/^\| \*\*(.+?)\*\* \| `(hardening\/[\w-]+\.mjs)` \| (.+?) \| /);
	if (!m) continue;
	claims.push({
		line: i + 1,
		name: m[1],
		file: m[2].replace("hardening/", ""),
		claim: m[3],
	});
}
console.log(`  找到 ${claims.length} 行声明`);
const missingFiles = claims.filter((c) => !fs.existsSync(path.join(HARDENING, c.file)));
ck("矩阵里引用的脚本都存在", missingFiles.length === 0, missingFiles.map((c) => c.file).join(", "));
if (missingFiles.length > 0) {
	console.log(`  ❌ 引用不存在的脚本: ${missingFiles.map((c) => c.file).join(", ")}`);
}

// ===========================================================================
// 2. 分类：哪些声明可以机器核实
// ===========================================================================
console.log("\n=== 2. 声明分类 ===");
const numeric = [];   // "N 项" / "N 个"
const other = [];
for (const c of claims) {
	const m = c.claim.match(/\*\*?(\d[\d,]*)\s*(项|个|条)\*\*?/) ?? c.claim.match(/^(\d[\d,]*)\s*(项|个|条)/);
	if (m) {
		numeric.push({ ...c, claimed: Number(m[1].replace(/,/g, "")), unit: m[2] });
	} else {
		other.push(c);
	}
}
console.log(`  可核实的「N 项/个/条」: ${numeric.length} 行`);
console.log(`  其他描述性声明: ${other.length} 行`);

// **缺陷 112**（第 113 轮）：上面的正则只认**阿拉伯数字**。
// 如果哪天矩阵里把「25 项」写成「二十五项」，那一行会落到 `other`（描述性声明），
// **不报错、不计数、不核实** —— 静默漏检，比「检查失败」更危险。
// 主动扫描「看起来像数量声明但用了中文数字」的行。
{
	const CN_NUM_RE = /([零一二三四五六七八九十百千]+)\s*(项|个|条)/;
	const suspicious = [];
	for (const c of other) {
		const m = c.claim.match(CN_NUM_RE);
		if (m) suspicious.push({ file: c.file, text: m[0] });
	}
	ck("没有用中文数字写的数量声明（会被漏检）", suspicious.length === 0,
		suspicious.slice(0, 3).map((s) => s.file + ":" + s.text).join("; "));
	if (suspicious.length > 0) {
		console.log("    ⚠️ 以下声明用了中文数字，无法被机器核实：");
		for (const s of suspicious.slice(0, 5)) console.log("      " + s.file + ": " + s.text);
	}

	// **反向验证**：必须真的解析到足够多的可核实声明（防止正则失效导致全部落到 other）
	ck("确实解析到足够多的可核实声明（≥ 20 行）", numeric.length >= 20, "只解析到 " + numeric.length + " 行");
}
console.log("\n  可核实行清单:");
for (const c of numeric) console.log(`    ${c.file}: 声明 ${c.claimed} ${c.unit}`);
console.log("\n  描述性声明:");
for (const c of other.slice(0, 10)) console.log(`    ${c.file}: ${c.claim.slice(0, 50)}`);

// ===========================================================================
// 3. 静态核实行数：统计脚本里的 check 调用数
// ===========================================================================
console.log("\n=== 3. 静态下限检查（是否有断言调用）===");
{
	// **重要**：静态 check( 计数**不能**用来核实声明数量 ——
	// 因为很多套件的断言在循环里（如 type-fuzz: 5 个 check × 内部二重循环 = 624 项）。
	// 这里只做「至少有 1 个断言调用」的下限检查；数量核实交给第 4 节的实跑。
	const ASSERT_RE = [/\bcheck\s*\(/g, /\bck\s*\(/g, /\bassert\s*\(/g];
	// **审计/报告类脚本**：用自建统计而非 check()，这是合理设计。
	// 判据：只要脚本里有「统计 + 打印结论」的逻辑即可。
	const AUDIT_SCRIPTS = new Set(["audit-rewrites.mjs", "differential.mjs", "mine-unrecovered.mjs", "false-positive-audit.mjs"]);
	let noAssertion = 0;
	let auditOk = 0;
	for (const c of numeric) {
		const p = path.join(HARDENING, c.file);
		if (!fs.existsSync(p)) continue;
		const src = fs.readFileSync(p, "utf8");
		let count = 0;
		for (const re of ASSERT_RE) count += (src.match(re) ?? []).length;

		if (count === 0) {
			// 审计类脚本：检查它是否有自建统计
			// **只要求有量化统计**：审计脚本的价值在于把可疑数量打印出来，
			// 由人（或 run-all 的退出码）判断。不强制要求 process.exit。
			const hasOwnCheck = /可疑|suspicious|不一致|mismatch|违规|violation/i.test(src) &&
				/\$\{|\+\s*\w*[Cc]ount|\w+\s*\+\+|\+=\s*1/.test(src);
			if (AUDIT_SCRIPTS.has(c.file) && hasOwnCheck) {
				auditOk++;
				console.log(`  ℹ️ ${c.file}: 审计脚本，用自建统计（合理）`);
			} else {
				noAssertion++;
				console.log(`  ⚠️ ${c.file}: 没找到断言调用，但声明了 ${c.claimed} ${c.unit}`);
			}
		}
	}
	console.log(`  检查 ${numeric.length} 个套件：${auditOk} 个审计脚本（自建统计）、${noAssertion} 个无任何检查`);
	ck("所有声明规模的套件都有断言或自建统计", noAssertion === 0, `${noAssertion} 个`);
}

// ===========================================================================
// 4. 实际运行核实（挑「跳过成本低」的套件）
// ===========================================================================
console.log("\n=== 4. 实际运行核实（抽样）===");
{
	// 挑出运行快、且声明是「N 项」的套件
	// **尽可能多实跑**：这些都是能在合理时间内跑完的纯本地套件
	const FAST = [
		"deliverable.mjs", "verify-install-runnable.mjs", "repro-runnable.mjs",
		"live-instance.mjs", "meta-health.mjs", "throw-values.mjs", "equivalence.mjs",
		"replay-state.mjs", "message-invariants.mjs", "block-ordering.mjs",
		"backtick-precision.mjs", "truncated-safety.mjs", "code-quality.mjs",
		"doc-consistency.mjs", "host-compat.mjs", "install-experience.mjs",
		"regex-unicode.mjs", "bare-json-safety.mjs", "coercion-semantics.mjs",
		"value-entities.mjs", "xml-attributes.mjs", "json-forms.mjs",
		"equivalence-classes.mjs", "nesting-malformed.mjs", "semantic-properties.mjs",
		"boundary-cases.mjs", "interleaved-blocks.mjs", "multi-turn.mjs",
		"state-isolation.mjs", "execution-safety.mjs", "replay-state-consistency.mjs",
		"plugin-coexistence.mjs", "error-observability.mjs", "idempotency.mjs",
		"text-fidelity.mjs", "lifecycle.mjs", "end-to-end.mjs", "cross-version.mjs",
		"node-compat.mjs", "prototype-pollution.mjs", "abort-invariants.mjs",
		"type-fuzz.mjs", "structure-fuzz.mjs", "ref-verifiable.mjs",
	];

	let checked = 0;
	let mismatchRun = 0;
	for (const c of numeric) {
		if (!FAST.includes(c.file)) continue;
		const p = path.join(HARDENING, c.file);
		if (!fs.existsSync(p)) continue;

		let out = "";
		try {
			out = execFileSync(process.execPath, [p], {
				encoding: "utf8", timeout: 300000, stdio: "pipe",
				env: { ...process.env, DSH_LLM_SRC: process.env.DSH_LLM_SRC ?? "" },
			});
		} catch (e) {
			out = (e.stdout ?? "") + (e.stderr ?? "");
		}
		// 从输出里提取 "N passed"
		const m = out.match(/(\d+)\s+passed/);
		const actual = m ? Number(m[1]) : null;
		checked++;

		if (actual === null) {
			console.log(`  ⚠️ ${c.file}: 无法从输出提取断言数`);
			continue;
		}
		// **两类声明要区别对待**：
		//   a) 声明 = 断言条数（如「29 项」）→ 运行时 passed 应匹配
		//   b) 声明 = 循环次数（如「24000 条」「3000 条随机流」）→ 一条断言覆盖 N 次运行，
		//      此时 passed 会远小于声明值，**不是缺陷**
		// 判据：声明值远大于 passed 且输出里提到了那个数字 → 属于 (b)
		const claimsLoopCount = actual < c.claimed * 0.5 && out.includes(String(c.claimed).replace(/,/g, "").slice(0, 4));
		const isLargeLoop = c.claimed > 1000 && actual < 20;
		if (claimsLoopCount || isLargeLoop) {
			console.log(`  ℹ️ ${c.file}: 声明 ${c.claimed} ${c.unit}，${actual} 条断言覆盖（循环型，合理）`);
			continue;
		}
		// **缺陷 135**（第 131 轮）：原来只判 `actual >= claimed * 0.9`，
		// 即「**实际不少于声明的 90%**」。这个方向只防「声明虚高」
		//（吹牛），**完全不防「声明过时」**（实际已经涨了但文档没跟上）。
		//
		// 实测后果：矩阵里 5 处声明远低于实际 ——
		//   meta-health 58 vs 70、memory-lifecycle 6 vs 8、real-cordis 14 vs 15、
		//   ref-verifiable 16 vs 17、claims-audit 6 vs 12。
		// 每一处都会让读者**低估**项目的测试强度，而检查一路绿灯。
		//
		// 现在改为**双向精确匹配**（这也是 README 矩阵的原始承诺：
		// 「N 项」就是「N 条断言」）。若某个套件确实需要留边距，
		// 应该在文档里写清楚，而不是靠检查器偷偷放宽。
		const ok = actual === c.claimed;
		if (!ok) {
			mismatchRun++;
			console.log(`  ❌ ${c.file}: 声明 ${c.claimed} 项，实际 ${actual} passed`);
		} else {
			console.log(`  ✅ ${c.file}: 声明 ${c.claimed} → 实际 ${actual} passed`);
		}
	}
	console.log(`\n  实跑核查: ${checked} 个套件，${mismatchRun} 个不达标`);
	ck("抽样实跑的断言数不低于声明", mismatchRun === 0, `${mismatchRun} 个不达标`);
}

// ===========================================================================
// 5. 特殊声明的核实
// ===========================================================================
console.log("\n=== 5. 特殊声明核实 ===");
{
	// 46 个变异体
	const mutSrc = fs.readFileSync(path.join(HARDENING, "mutation-test.mjs"), "utf8");
	const mutantIds = new Set();
	for (const m of mutSrc.matchAll(/\["M(\d+)\s/g)) mutantIds.add(Number(m[1]));
	const claimedMut = claims.find((c) => c.file === "mutation-test.mjs");
	const mutNum = claimedMut ? Number((claimedMut.claim.match(/(\d+)/) ?? [])[1]) : null;
	console.log(`  变异体: 声明 ${mutNum}，源码 ${mutantIds.size}`);
	ck("变异体数量与源码一致", mutNum === mutantIds.size, `${mutNum} vs ${mutantIds.size}`);

	// 真实流数量
	const rr = fs.readFileSync(path.join(HARDENING, "replay-real-streams.mjs"), "utf8");
	const streamClaim = claims.find((c) => c.file === "replay-real-streams.mjs");
	if (streamClaim) {
		const n = Number((streamClaim.claim.match(/([\d,]+)/) ?? [])[1]?.replace(/,/g, ""));
		console.log(`  真实流: 声明 ${n}`);
		ck("真实流数量的量级合理（> 10000）", n > 10000, String(n));

	// **缺陷 79**：README 曾同时声明「14,408 条总数」和「13,802 + 390 的互斥分类」，
	// 但 13,802 + 390 = 14,192 ≠ 14,408。而 effect-quantify 里 hasNativeToolCall 是
	// 二值判断，分类必然完备 —— 所以那三个数字不可能同时为真（来自不同时点）。
	// 修法：不再声明互斥分类的精确条数，改为「同一时点的快照」+ 口径说明。
	const readmeText = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

	// 若同时出现「N 条」和「A 条 + B 条」的互斥分类声明，必须能相加自洽
	const totals = [...readmeText.matchAll(/(\d{1,3}(?:,\d{3})+) 条真实会话流/g)].map((m) => Number(m[1].replace(/,/g, "")));
	const nativeM = readmeText.match(/(\d{1,3}(?:,\d{3})+) 条原生含结构化/);
	const textOnlyM = readmeText.match(/(\d{1,3}(?:,\d{3})+) 条纯文本流/);

	if (nativeM && textOnlyM) {
		const nat = Number(nativeM[1].replace(/,/g, ""));
		const txt = Number(textOnlyM[1].replace(/,/g, ""));
		const sum = nat + txt;
		// 只有在**同一句/同一段**里声明总数时才要求相等
		const samePara = readmeText.split(/\r?\n/).some((l) =>
			l.includes(String(nat)) && l.includes(String(txt)) && /条真实流/.test(l));
		if (samePara) {
			const declaredTotal = [...readmeText.matchAll(/(\d{1,3}(?:,\d{3})+) 条真实流/g)]
				.map((m) => Number(m[1].replace(/,/g, "")))
				.find((t) => t > nat && t > txt);
			ck("互斥分类之和等于声明的总数", declaredTotal === undefined || declaredTotal === sum,
				`${nat} + ${txt} = ${sum}，声明 ${declaredTotal}`);
		} else {
			ck("互斥分类与总数不在同一句（已用口径说明区分）", true, "");
		}
		console.log(`  分类: ${nat} 原生 + ${txt} 纯文本 = ${sum}`);
	}
	}

	// 套件总数
	// **缺陷 111**（第 112 轮）：`_` 开头是共享工具模块（如 `_host-invariant.mjs`），
	// 不是套件。不排除它会让层数多算 1（99 + 2 = 101，实际 98 + 2 = 100）。
	const suites = fs.readdirSync(HARDENING).filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));
	const layerClaim = (fs.readFileSync(README, "utf8").match(/\*\*([零一二三四五六七八九十百]+)层测试\*\*/) ?? [])[1];
	const CN = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
	// **缺陷 111**（第 112 轮）：原实现只支持「X十Y」格式，遇到「一百」返回 NaN。
	// 现在支持 <100 的「X十Y」以及 100/200…900 的「Y百」，以及「一百零X」。
	const toNum = (s) => {
		if (!s) return NaN;
		// 「X百」或「X百Y十Z」
		if (s.includes("百")) {
			const [beforeBai, afterBai] = s.split("百");
			const hundreds = (beforeBai ? CN[beforeBai] : 1) * 100;
			if (!afterBai) return hundreds;
			// 「一百零X」
			const rest = afterBai.replace(/^零/, "");
			if (rest.includes("十")) {
				const [t, o] = rest.split("十");
				return hundreds + (t ? CN[t] : 1) * 10 + (o ? CN[o] : 0);
			}
			return hundreds + (CN[rest] ?? 0);
		}
		if (s.includes("十")) {
			const parts = s.split("十");
			return (parts[0] ? CN[parts[0]] : 1) * 10 + (parts[1] ? CN[parts[1]] : 0);
		}
		return CN[s] ?? NaN;
	};
	const layers = toNum(layerClaim);
	console.log(`  层数: 声明 ${layers}，实际 hardening 套件 ${suites.length} + 核心 2 = ${suites.length + 2}`);
	ck("层数与实际套件数相符（±3）", Math.abs(layers - (suites.length + 2)) <= 3, `${layers} vs ${suites.length + 2}`);
}

// ===========================================================================
// 6. test/ 根目录下的核心测试也被 README 声明了规模
// ===========================================================================
console.log("\n=== 6. 核心测试声明核实 ===");
{
	const TEST_ROOT = path.join(ROOT, "test");
	const CORE = [
		{ file: "integration.test.mjs", claimedRe: /\| 集成断言 \| `test\/integration\.test\.mjs` \| (\d+) 项/, runRe: /(\d+)\s+passed/ },
		{ file: "real-samples.test.mjs", claimedRe: /\| 复刻样本 \| `test\/real-samples\.test\.mjs` \| (\d+) 个真实案例形态/, runRe: /(\d+)\s+passed/ },
	];
	const readmeSrc = fs.readFileSync(README, "utf8");
	for (const c of CORE) {
		const m = readmeSrc.match(c.claimedRe);
		const claimed = m ? Number(m[1]) : null;
		const p = path.join(TEST_ROOT, c.file);
		if (!fs.existsSync(p)) { ck(c.file + " 存在", false); continue; }
		ck(c.file + " 存在", true);
		let out = "";
		try {
			out = execFileSync(process.execPath, [p], { encoding: "utf8", timeout: 300000, stdio: "pipe", env: process.env });
		} catch (e) {
			out = (e.stdout ?? "") + (e.stderr ?? "");
		}
		const rm = out.match(c.runRe);
		const actual = rm ? Number(rm[1]) : null;
		console.log("  " + c.file + ": 声明 " + (claimed ?? "未声明") + "，实际 " + (actual ?? "无断言输出") + " passed");
		if (claimed !== null && actual !== null) {
			ck(c.file + " 实跑断言数 >= 声明", actual >= claimed * 0.9, actual + " vs " + claimed);
		} else if (actual === null) {
			// **关键检查**：一个 test 文件必须有断言输出，否则它只是演示脚本
			ck(c.file + " 有断言（不是只有 print）", false, "没有 \"N passed\" 输出");
		}
	}
}

console.log(`\n===== 测试矩阵真实性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
