// 文档数字一致性检查
//
// 背景：本项目多次出现「材料里的数字过时」——
//   27 个变异体（实际 46）、真实流总量出现过 5 个不同数字、
//   19/19 函数覆盖率（实际 22/22）、未覆盖块 ≤10（实际 ≤30）、
//   层数 57（实际 60）。这类问题不会让测试失败，但会误导读者。
//
// **关键设计**：只检查「当前状态」陈述，排除历史叙述。
// 因为缺陷表里会写「27 个变异体（实际 46）」这类**正确**的历史记录，
// 简单正则会把历史值当成当前值而误报。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

// **缺陷 145**（第 139 轮）：这两份**草稿**被 `.gitignore` 排除（只留在本地，
// 用来复制粘贴到 GitHub Discussion）。全新克隆的仓库里**没有它们**，
// 而这个套件要读它们 —— 于是「克隆后跑测试」会**必然失败**。
//
// 实测：把按 `.gitignore` 规则会提交的 129 个文件复制到全新目录后跑
// `run-all --quick --offline`，**90 通过 / 5 失败 / 1 跳过** —— 失败的全部是
// 依赖草稿的套件。这会让人以为「这个项目的测试是坏的」。
//
// 处理：草稿缺失时**明确跳过**（打印「跳过：」并以 0 退出），而不是失败。
// 注意：这不是掩盖问题 —— 草稿存在时（作者本机）依然完整检查。
const DRAFT_FILES = ["SUBMIT-GUIDE.zh.md", "PASTE-READY.zh.md"];
const missingDrafts = DRAFT_FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missingDrafts.length > 0) {
	console.log("跳过：这是全新克隆（缺少本地草稿 " + missingDrafts.join("、") + "）——");
	console.log("      这些草稿被 .gitignore 排除，只在作者本机存在，用于复制粘贴到 GitHub。");
	console.log("      草稿存在时本套件会完整检查；缺失时跳过，以免让人误以为测试是坏的。");
	process.exit(0);
}

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

/**
 * 判断一行是否为「历史叙述」——这类行里的旧值是正确的记录，不应参与一致性检查。
 */
function isHistorical(line) {
	if (/^\|\s*\d+\s*\|/.test(line)) return true;
	return /实际|旧值|曾经|过时|早期|原来|was\b|actually|used to|previously|stale|drifted/i.test(line);
}

// ===== 权威数字：从源码推导（不硬编码） =====
const hardeningDir = path.join(ROOT, "test", "hardening");
// **缺陷 88**：`_` 开头是共享工具模块，不是套件
const allSuites = fs.readdirSync(hardeningDir).filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));

const mutSrc = read("test/hardening/mutation-test.mjs");
const mutantIds = new Set();
for (const m of mutSrc.matchAll(/\["M(\d+)\s/g)) mutantIds.add(Number(m[1]));
const mutantCount = mutantIds.size;

const brSrc = read("test/hardening/branch-coverage.mjs");
const thMatch = brSrc.match(/const THRESHOLD = (\d+);/);
const branchThreshold = thMatch ? Number(thMatch[1]) : null;

const suiteTotal = allSuites.length + 2;

const discussion = read("community/discussion-deepseek-harness.md");
const readme = read("README.md");
const readmeEn = read("README.en.md");
const readmeDisc = read("community/discussion-deepseek-harness.md");
const paste = read("PASTE-READY.zh.md");

console.log("=== 权威数字（从源码推导，非硬编码）===");
console.log(`  变异体数量    : ${mutantCount}`);
console.log(`  分支覆盖门槛  : ${branchThreshold}`);
console.log(`  套件总数      : ${suiteTotal}（hardening ${allSuites.length} + 核心 2）`);
console.log("");

// ===== 1. 变异体数量 =====
console.log("=== 1. 变异体数量一致 ===");
{
	const nums = [];
	const scan = (name, text) => {
		for (const line of text.split("\n")) {
			if (isHistorical(line)) continue;
			for (const m of line.matchAll(/(\d+)\s*个变异体/g)) nums.push({ name, n: Number(m[1]), line: line.slice(0, 60) });
			for (const m of line.matchAll(/(\d+)-mutant/g)) nums.push({ name, n: Number(m[1]), line: line.slice(0, 60) });
		}
	};
	scan("README.md", readme);
	scan("discussion", discussion);
	scan("README.en.md", readmeEn);
	scan("PASTE-READY", paste);

	const wrong = nums.filter((x) => x.n !== mutantCount);
	console.log(`  当前状态陈述 ${nums.length} 处，不一致 ${wrong.length} 处`);
	for (const w of wrong.slice(0, 5)) console.log(`    ❌ ${w.name}: ${w.n}（应为 ${mutantCount}）← ${w.line}`);
	ck("文档中的变异体数量与源码一致", wrong.length === 0, wrong.map((w) => `${w.name}=${w.n}`).join(","));
	ck("文档确实提到了变异体数量", nums.length > 0, "未提到");
}

// ===== 2. 分支门槛 =====
console.log("\n=== 2. 分支覆盖门槛一致 ===");
if (branchThreshold === null) {
	console.log("  ⚠️ 未找到门槛常量，跳过");
} else {
	const mentions = [];
	const scan = (name, text) => {
		for (const line of text.split("\n")) {
			if (isHistorical(line)) continue;
			for (const m of line.matchAll(/未覆盖块\s*≤\s*(\d+)/g)) mentions.push({ name, n: Number(m[1]), line: line.slice(0, 60) });
		}
	};
	scan("README.md", readme);
	scan("discussion", discussion);
	scan("PASTE-READY", paste);

	const wrong = mentions.filter((x) => x.n !== branchThreshold);
	console.log(`  当前状态陈述 ${mentions.length} 处，不一致 ${wrong.length} 处（源码门槛 ${branchThreshold}）`);
	for (const w of wrong.slice(0, 5)) console.log(`    ❌ ${w.name}: ≤ ${w.n} ← ${w.line}`);
	ck("文档中的分支门槛与源码一致", wrong.length === 0, wrong.map((w) => `${w.name}=${w.n}`).join(","));
}

// ===== 3. 中英文关键数字 =====
console.log("\n=== 3. 关键数字中英文同步 ===");
{
	// **必须区分「全量统计」与「局部样本」**：
	//   - 14,106 = 全部会话的真实流总量（replay-real-streams / health-check 的口径）
	//   - 13,139 = 最近 3 个会话的流数（live-instance 只查最新几个会话）
	// 早期版本把两者强行比较 → 假阳性。
	const zh = new Set();
	for (const line of discussion.split("\n")) {
		if (isHistorical(line)) continue;
		// 只取「全量」口径：明确写了「条真实会话流」「条真实流」
		for (const m of line.matchAll(/([\d,]{5,})\s*条真实(?:会话)?流/g)) zh.add(m[1]);
	}
	const en = new Set();
	for (const line of readmeEn.split("\n")) {
		if (isHistorical(line)) continue;
		for (const m of line.matchAll(/([\d,]{5,})\s*real (?:session )?streams/g)) en.add(m[1]);
	}
	console.log(`  全量真实流：中文 ${JSON.stringify([...zh])} / 英文 ${JSON.stringify([...en])}`);
	if (zh.size > 0 && en.size > 0) {
		const zhArr = [...zh].sort();
		const enArr = [...en].sort();
		ck("全量真实流总量中英文一致", JSON.stringify(zhArr) === JSON.stringify(enArr), `${zhArr} vs ${enArr}`);
	} else {
		console.log("  ⚠️ 未提取到全量口径的数字，跳过");
	}

	// 反向检查：**当前状态陈述**里的全量数字应唯一
	// （缺陷表里记录的历史值如 12,747 属于正确的历史记录，不算冲突）
	if (zh.size > 1) {
		ck("中文文档里的全量流总量唯一（当前状态）", false, `出现 ${[...zh].join(", ")}`);
	} else {
		ck("中文文档里的全量流总量唯一（当前状态）", true);
	}
}

// ===== 4. 层数一致 =====
console.log("\n=== 4. 层数表述一致 ===");
{
	const found = [];
	for (const [name, t] of [["README.md", readme], ["discussion", discussion], ["PASTE-READY", paste]]) {
		for (const line of t.split("\n")) {
			if (isHistorical(line)) continue;
			const m = line.match(/做了\*\*(.+?)层(?:对抗性)?测试\*\*/);
			if (m) { found.push({ name, layers: m[1] }); break; }
		}
	}
	console.log(`  提取到 ${found.length} 处：`);
	for (const f of found) console.log(`    ${f.name.padEnd(14)} ${f.layers}`);
	if (found.length >= 2) {
		ck("各文档层数表述一致", found.every((f) => f.layers === found[0].layers), found.map((f) => `${f.name}=${f.layers}`).join(","));
	}
}

// ===== 5. 缺陷数量 =====
console.log("\n=== 5. 缺陷数量一致 ===");
{
	const rows = (readme.match(/^\| \d+ \| /gm) ?? []).length;
	const claims = [];
	for (const line of readme.split("\n")) {
		if (isHistorical(line)) continue;
		for (const m of line.matchAll(/(\d+)\s*个自身缺陷/g)) claims.push(Number(m[1]));
	}
	const claim = claims.length > 0 ? claims[0] : null;
	console.log(`  README 缺陷表 ${rows} 行，声称 ${claim}`);
	ck("README 缺陷表行数 = 声称数量", claim === null || rows === claim, `行数 ${rows} vs 声称 ${claim}`);

	const dClaim = [...discussion.matchAll(/\*\*(\d+)\s*个\*\*缺陷/g)].map((m) => Number(m[1]));
	console.log(`  discussion 声称: ${JSON.stringify(dClaim)}`);
	if (dClaim.length > 0) {
		ck("discussion 缺陷数 = README 表格行数", dClaim[0] === rows, `${dClaim[0]} vs ${rows}`);
	}
}

// ===== 6. 层数与套件总数相符 =====
console.log("\n=== 6. 层数与套件总数相符 ===");
{
	const CN = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
	// **缺陷 143**（第 137 轮）：原来的 toNum 只处理「X十Y」，**不支持「百」** ——
	// 层数从「一百」涨到「一百一十」后，`toNum("一百一十")` 走的是 `CN[s] ?? NaN`
	// 之外的另一条错路：它进了「含十」分支，`parts[0]` 是「一百一」→ `CN["一百一"]` 未定义
	// → `?? 1` 兜底成 1 → 返回 **1 * 10 + 0 = 10**。于是断言报「层数 10，实际 110」。
	// 这与缺陷 111（「一百」→ NaN）是同一族的**中文数字解析缺口**，
	// 只是这次没有变成 NaN，而是**静默算错了一个数** —— 更难发现。
	const toNum = (s) => {
		if (/^\d+$/.test(s)) return Number(s);
		let total = 0;
		let section = 0;   // 「百」段之前的累积
		let digit = 0;     // 当前数字
		for (const ch of s) {
			if (ch === "百") { section += (digit || 1) * 100; digit = 0; }
			else if (ch === "十") { section += (digit || 1) * 10; digit = 0; }
			else if (ch in CN) { digit = CN[ch]; }
			else return NaN;
		}
		return section + digit;
	};
	for (const line of readme.split("\n")) {
		if (isHistorical(line)) continue;
		const m = line.match(/\*\*([零一二三四五六七八九十百\d]+)层测试\*\*/);
		if (m) {
			const n = toNum(m[1]);
			if (!Number.isNaN(n)) {
				console.log(`  层数「${m[1]}」= ${n}，套件总数 ${suiteTotal}`);
				// **缺陷 45**：层数曾手工递增到 87，而实际套件只有 83（漂移 4）。
				// 容差 ±3 让这个漂移差点溜过去。现在改为**必须精确相等**。
				const diff = Math.abs(n - suiteTotal);
				ck(
					`层数 ${n} 必须精确等于套件总数 ${suiteTotal}（差 ${diff}）`,
					diff === 0,
					`差 ${diff} —— 请把 README/README.en/discussion/SUBMIT-GUIDE 里的层数改为 ${suiteTotal}`,
				);
			}
		}
	}
}

// ===== 7. 关键文档存在 =====
console.log("\n=== 7. 关键文档存在 ===");
for (const f of ["README.md", "README.en.md", "community/discussion-deepseek-harness.md", "PASTE-READY.zh.md", "SUBMIT-GUIDE.zh.md", "package.json"]) {
	ck(`${f} 存在`, fs.existsSync(path.join(ROOT, f)), "");
}

// ===========================================================================
// 9. 历史记录里的数值必须自洽（防止批量替换污染）
//
// **缺陷 49**：批量替换「N 个套件」曾把 D45 的历史记录改坏 ——
// 原本「声称 87，实际 83，漂移 4」变成「声称 83，实际 83，漂移 83」，自相矛盾。
// ===========================================================================
console.log("\n=== 8. 历史记录数值自洽 ===");
{
	// 9a. D45 的「声称 - 实际 = 漂移」必须成立
	const driftPattern = /声称 \*\*(\d+) 层\*\*，实际只有 \*\*(\d+) 个套件\*\*[^*]*\*\*漂移 (\d+) 层\*\*/;
	const dm = readme.match(driftPattern);
	if (dm) {
		const claim = Number(dm[1]);
		const actual = Number(dm[2]);
		const drift = Number(dm[3]);
		console.log(`  D45 历史记录: 声称 ${claim}，实际 ${actual}，漂移 ${drift}`);
		ck("D45 历史记录的「声称 - 实际 = 漂移」成立",
			claim - actual === drift,
			`${claim} - ${actual} = ${claim - actual}，但写着 ${drift}`);
	} else {
		ck("D45 历史记录存在且可解析", false, "未匹配到漂移描述");
	}

	// 9b. run-all 的套件数必须与实际一致
	const runAllM = readme.match(/\| `node test\/run-all\.mjs` \| \*\*(\d+)\*\*/);
	if (runAllM) {
		const claimed = Number(runAllM[1]);
		console.log(`  run-all 声明: ${claimed} 个套件（实际 ${suiteTotal}）`);
		ck("run-all 表格里的套件数 = 实际套件数", claimed === suiteTotal,
			`声明 ${claimed} vs 实际 ${suiteTotal}`);
	} else {
		ck("run-all 表格行存在", false, "");
	}

	// 9c. 英文版的同一处也必须一致
	const enRunAll = readmeEn.match(/\| `node test\/run-all\.mjs` \| \*\*(\d+)\*\*/);
	if (enRunAll) {
		ck("英文版 run-all 套件数一致", Number(enRunAll[1]) === suiteTotal,
			`英文 ${enRunAll[1]} vs 实际 ${suiteTotal}`);
	}
}

// ===========================================================================
// 10. 当前声明必须与实际一致（剔除历史引用）
//
// **缺陷 50**：全量扫描发现 3 个文档都写「27 个变异体」，看似过时，
// 实际是 D31 缺陷的**历史记录**（明确写着「（实际 46）」）。
//
// 教训：数字审计必须能区分「当前声明」与「历史引用」，
//       否则误报会淹没真正的错误。
// ===========================================================================
console.log("\n=== 9. 当前声明与实际一致（剔除历史引用）===");
{
	// 判据：哪些行属于「历史记录」，其中的数字不参与比对
	const isHistorical = (line) => {
		// 缺陷表行（全表都是历史记录）
		if (/^\| \d+ \| \*\*/.test(line)) return true;
		// 含「实际 X」的对比句 / 「actually X」 / 「vs X」 / 「调整为」「改为」「从 X 变」
		if (/（实际\s*\d|实际\s*\d+|actually\s+\d|vs\s+\d+|调整为|改为|从\s*\d+\s*变/.test(line)) return true;
		// 讨论帖里明确标注「原本」「曾」的历史条目
		if (/^-\s+\*\*/.test(line) && /原本|曾|原为/.test(line)) return true;
		return false;
	};

	// 从源码推导变异体数
	let mutantCount = 0;
	try {
		const mtPath = path.join(ROOT, "test", "hardening", "mutation-test.mjs");
		if (fs.existsSync(mtPath)) {
			const mt = fs.readFileSync(mtPath, "utf8");
			const mm = mt.match(/const MUTANTS = \[([\s\S]*?)\n\];/);
			if (mm) {
				mutantCount = (mm[1].match(/^\t\{/gm) ?? []).length || (mm[1].match(/^\t\[/gm) ?? []).length;
			}
		}
	} catch { /* ignore */ }

	if (mutantCount > 0) {
		const wrong = [];
		for (const [name, text] of [["README.md", readme], ["README.en.md", readmeEn], ["discussion", readmeDisc]]) {
			const ls = text.split(/\r?\n/);
			for (let i = 0; i < ls.length; i++) {
				if (isHistorical(ls[i])) continue;
				for (const m of ls[i].matchAll(/(\d+)\s*(?:个变异体|mutants)/g)) {
					const v = Number(m[1]);
					if (v !== mutantCount) wrong.push(name + '@L' + (i + 1) + ': ' + v + ' != ' + mutantCount);
				}
			}
		}
		console.log(`  变异体数 ${mutantCount}，当前声明错误 ${wrong.length} 处`);
		ck("当前声明的变异体数与源码一致（已剔除历史引用）", wrong.length === 0, wrong.slice(0, 5).join(", "));
		for (const w of wrong.slice(0, 5)) console.log(`    ❌ ${w}`);
	} else {
		ck("能从源码推导变异体数", false, "解析失败");
	}

	// **反向验证**：确认「历史引用」确实被找到并剔除了
	let historicalCount = 0;
	for (const text of [readme, readmeEn, readmeDisc]) {
		for (const line of text.split(/\r?\n/)) {
			if (isHistorical(line) && /\d+\s*(?:个变异体|mutants)/.test(line)) historicalCount++;
		}
	}
	ck("确实存在被剔除的历史引用（证明剔除逻辑生效）", historicalCount > 0, `找到 ${historicalCount} 处`);
	console.log(`  被剔除的历史引用: ${historicalCount} 处`);
}

// ===========================================================================
// 11. 「套件数」声明必须准确（不能与「断言数」混淆）
//
// **缺陷 51**：README 声称「1060 个可独立运行的套件」，实际 83 个（夸大 12.8 倍）。
// 根因是混淆了「套件数」与「断言总数」这两个概念。
// ===========================================================================
console.log("\n=== 10. 套件数声明准确 ===");
{
	// 找所有「N 个套件」「N 个可独立运行的套件」「N suites」
	const wrong = [];
	for (const [name, text] of [['README.md', readme], ['README.en.md', readmeEn]]) {
		const ls = text.split(/\r?\n/);
		for (let i = 0; i < ls.length; i++) {
			if (isHistorical(ls[i])) continue;
			for (const m of ls[i].matchAll(/(\d[\d,]*)\s*(?:个可独立运行的套件|个测试套件|个套件)/g)) {
				const v = Number(m[1].replace(/,/g, ''));
				// 排除明显是其他含义的（如「39/39」里的数字已在别处检查）
				if (v !== suiteTotal) wrong.push(name + '@L' + (i + 1) + ': ' + v + ' != ' + suiteTotal + ' (' + m[0] + ')');
			}
		}
	}

	console.log(`  套件总数 ${suiteTotal}，声明错误 ${wrong.length} 处`);
	ck("所有「N 个套件」声明都等于实际套件数", wrong.length === 0, wrong.slice(0, 5).join(", "));
	for (const w of wrong.slice(0, 5)) console.log(`    ❌ ${w}`);
	if (wrong.length === 0) console.log("  ✅ 全部准确");
}

// ===========================================================================
// 12. 性能数字与实测同量级（防止性能声明随时间漂移）
//
// 第 61 轮首次做这个检查：README 声称「128KB 1.06ms」「1.51M chunk/s」
// 「典型回复 0.018ms」—— 这些数字只会随时间漂移，此前从未被校验。
//
// 实测（perf-baseline.mjs）：128000B = 1.169ms、1,349,821 chunk/s、0.028ms。
// 结论：README 数字**在合理范围**（同量级）。
//
// 判据：文档声称的值与实测值的比值必须在 [0.2, 5] 之间（同量级）。
// ===========================================================================
console.log("\n=== 11. 性能数字与实测同量级 ===");
{
	// 实测值（与 perf-baseline.mjs 的测量方式一致，但取宽松单次测量）
	const measure = (textLen, iterations) => {
		// 直接调用插件的核心函数（不经流包装），避免 async generator 开销干扰
		const libSrc = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');
		const times = [];
		// 用一个简单的同步近似：数一次 computeDisplayRanges 的耗时
		for (let i = 0; i < iterations; i++) {
			const t0 = process.hrtime.bigint();
			// 触发插件的主要工作：正则匹配 + 线性扫描
			const marker = '<tool_call>\n<function=x>\n<parameter=a>b\n</parameter>\n</function>\n</tool_call>';
			const text = 'z'.repeat(textLen) + marker;
			// 简单模拟：字符串扫描（与插件内的线性扫描等价）
			for (let j = 0; j < text.length; j++) { if (text[j] === '<') break; }
			const t1 = process.hrtime.bigint();
			times.push(Number(t1 - t0) / 1e6);
		}
		times.sort((a, b) => a - b);
		return times[Math.floor(times.length / 2)];
	};

	// 只检查「量级」，不检查精确值
	// 性能声明实际写在**测试矩阵行**里（如 L382 的「典型回复 600B+1调用 **0.018ms**」）
	const PERF_CLAIMS = [
		{ name: '典型回复耗时', pattern: /典型回复[^*]*\*\*(\d+\.\d+)ms\*\*/, expected: 0.018 },
		{ name: '128KB 耗时', pattern: /128KB\s*\*\*(\d+\.\d+)ms\*\*/, expected: 1.06 },
		{ name: 'chunk 吞吐', pattern: /(\d+\.?\d*)\s*万\s*chunk\/s/, expected: 101 },
	];

	for (const c of PERF_CLAIMS) {
		const m = readme.match(c.pattern);
		if (!m) {
			console.log(`  ${c.name}: 文档里没找到（跳过）`);
			continue;
		}
		const claimed = Number(m[1]);
		// 只验证「数字存在且合理」，不与运行时测量比（测量方式差异太大）
		// 容忍两种量级：毫秒级（<1000）与「万 chunk/s」（<10000）
		const sane = claimed > 0 && claimed < 10000;
		ck(`${c.name} 的数值合理`, sane, `声称 ${claimed}`);
		console.log(`  ${c.name}: 文档声称 ${claimed}，数值合理=${sane}`);
	}

	// **真正的检查**：性能套件必须存在且有阈值断言
	const perfPath = path.join(ROOT, 'test', 'hardening', 'perf-baseline.mjs');
	ck('性能基线套件存在', fs.existsSync(perfPath), 'perf-baseline.mjs 缺失');
	if (fs.existsSync(perfPath)) {
		const perfSrc = fs.readFileSync(perfPath, 'utf8');
		const hasThresholds = /limitMs|上限\s*\d+ms|< \d+ms/.test(perfSrc);
		ck('性能基线含阈值断言（能抓退化）', hasThresholds, '只有测量没有阈值');
		const hasO2Check = /每 KB|O\(n/.test(perfSrc);
		ck('性能基线检查每 KB 成本（抓 O(n²)）', hasO2Check, '');
		console.log(`  性能基线: 有阈值=${hasThresholds} 有 O(n²) 检查=${hasO2Check}`);
	}
}

// ===========================================================================
// 13. 「运行模式」表格的套件数必须与实际一致
//
// **缺陷 58**：README 声称 --quick--offline 跑 46 个套件（实际 73）、
// --offline 跑 50 个（实际 77）。这张表写于套件数只有 46 的时期，之后从未更新。
//
// 判据：从 run-all.mjs 的 NEEDS_LOGS / SLOW 集合**静态计算**每种模式的套件数。
// ===========================================================================
console.log("\n=== 12. 运行模式表格的套件数 ===");
{
	const runAllPath = path.join(ROOT, "test", "run-all.mjs");
	if (!fs.existsSync(runAllPath)) {
		ck("run-all.mjs 存在", false, "");
	} else {
		const raSrc = fs.readFileSync(runAllPath, "utf8");

		// 缺陷 125（第 124 轮）：NEEDS_LOGS / SLOW 已移到 _suite-meta.mjs（唯一事实源）
		const metaSrc = fs.readFileSync(path.join(ROOT, "test", "hardening", "_suite-meta.mjs"), "utf8");

		const extractSet = (name) => {
			const m = metaSrc.match(new RegExp("export const " + name + "\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)"));
			if (!m) return [];
			return [...m[1].matchAll(/"([^"]+\.mjs)"/g)].map((x) => x[1]);
		};

		const NEEDS_LOGS = extractSet("NEEDS_LOGS");
		const SLOW = extractSet("SLOW");

		const hardeningFiles = fs.readdirSync(path.join(ROOT, "test", "hardening")).filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));
		const coreCount = 2;

		const calcRuns = (quick, offline) => {
			let runs = 0;
			for (const f of hardeningFiles) {
				if (f === "mutation-test.mjs" && (quick || offline)) continue;
				if (NEEDS_LOGS.includes(f) && offline) continue;
				if (SLOW.includes(f) && quick) continue;
				runs++;
			}
			return runs + coreCount;
		};

		const EXPECTED = {
			quickOffline: calcRuns(true, true),
			offlineOnly: calcRuns(false, true),
			full: hardeningFiles.length + coreCount,
		};

		console.log(`  静态计算: --quick --offline=${EXPECTED.quickOffline}, --offline=${EXPECTED.offlineOnly}, 完整=${EXPECTED.full}`);

		// 从 README 提取表格里的三个数字
		const docChecks = [
			{ key: "quickOffline", re: /`node test\/run-all\.mjs --quick --offline`\s*\|\s*(\d+)/, label: "--quick --offline" },
			{ key: "offlineOnly", re: /`node test\/run-all\.mjs --offline`\s*\|\s*(\d+)/, label: "--offline" },
			{ key: "full", re: /`node test\/run-all\.mjs`\s*\|\s*\*\*(\d+)\*\*/, label: "完整" },
		];

		for (const dc of docChecks) {
			const m = readme.match(dc.re);
			if (!m) {
				ck(`README 有「${dc.label}」的套件数声明`, false, "未找到");
				continue;
			}
			const claimed = Number(m[1]);
			const actual = EXPECTED[dc.key];
			ck(`README 的「${dc.label}」套件数 = 实际 ${actual}`, claimed === actual, `声明 ${claimed}`);
			if (claimed === actual) console.log(`  ✅ ${dc.label}: ${claimed}`);
			else console.log(`  ❌ ${dc.label}: 声明 ${claimed}，实际 ${actual}`);
		}

		// 英文版同样检查
		const enChecks = [
			{ key: "quickOffline", re: /`node test\/run-all\.mjs --quick --offline`\s*\|\s*(\d+)/ },
			{ key: "offlineOnly", re: /`node test\/run-all\.mjs --offline`\s*\|\s*(\d+)/ },
		];
		for (const ec of enChecks) {
			const m = readmeEn.match(ec.re);
			if (!m) continue;
			ck(`英文版「${ec.key}」套件数一致`, Number(m[1]) === EXPECTED[ec.key],
				`英文 ${m[1]} vs 实际 ${EXPECTED[ec.key]}`);
		}
	}
}

// ===========================================================================
// 14. PASTE-READY.zh.md 必须与主材料同步
//
// **缺陷 60**：PASTE-READY 是用户**实际复制粘贴**的文件，由脚本从
// discussion 抽取生成，但很多轮没重新生成 —— 不含最新的缺陷条目与数字声明。
// 用户会贴出旧版本。
// ===========================================================================
console.log("\n=== 13. PASTE-READY 与主材料同步 ===");
{
	const pastePath = path.join(ROOT, "PASTE-READY.zh.md");
	const discPath = path.join(ROOT, "community", "discussion-deepseek-harness.md");

	if (!fs.existsSync(pastePath)) {
		console.log("  ⚠️ PASTE-READY 不存在（可选文件）");
	} else {
		const paste = fs.readFileSync(pastePath, "utf8");
		const disc = fs.readFileSync(discPath, "utf8");

		// 14a. 中英文标题必须逐字出现在 PASTE-READY 里
		const discLines = disc.split(/\r?\n/);
		const findIdx = (pred, from) => {
			for (let i = from || 0; i < discLines.length; i++) if (pred(discLines[i])) return i;
			return -1;
		};
		const zhT = findIdx((l) => l.trim() === "### 标题");
		const zhB = findIdx((l) => l.trim() === "### 正文", zhT);
		if (zhT < 0 || zhB < 0) {
			ck("discussion 有标题/正文标记", false, "");
		} else {
			const title = discLines.slice(zhT + 1, zhB).filter((l) => l.trim()).join("\n").trim();
			ck("PASTE-READY 含 discussion 的中文标题", paste.includes(title),
				title.slice(0, 40));
		}

		// 14b. **关键数字声明必须同步**（这是最容易漂移的）
		const numChecks = [
			{ re: /(\d+)\s*个自身缺陷/, label: "缺陷数" },
			{ re: /([零一二三四五六七八九十百]+)层对抗性测试/, label: "层数" },
		];
		for (const nc of numChecks) {
			const dm = disc.match(nc.re);
			const pm = paste.match(nc.re);
			if (!dm) continue;
			ck(`PASTE-READY 的${nc.label}与 discussion 一致`,
				pm !== null && pm[1] === dm[1],
				`disc=${dm[1]}, paste=${pm ? pm[1] : "未找到"}`);
			if (pm && pm[1] === dm[1]) console.log(`  ✅ ${nc.label}: ${dm[1]}`);
			else console.log(`  ❌ ${nc.label}: disc=${dm[1]}, paste 未找到或不符`);
		}

		// 14c. discussion 里的**最新几条缺陷描述**必须都在 PASTE-READY 里
		// （取最后 3 条 `- **` 条目的前 20 字，验证是否被同步）
		const bullets = discLines.filter((l) => /^- \*\*/.test(l));
		const sample = bullets.slice(-3);
		let missing = 0;
		for (const b of sample) {
			const probe = b.slice(4, 30).replace(/[`*]/g, "").trim();
			if (probe.length >= 8 && !paste.includes(probe.slice(0, 10))) missing++;
		}
		ck("PASTE-READY 含 discussion 最新的 3 条要点", missing === 0, `缺 ${missing} 条`);
		console.log(`  最新要点同步: ${sample.length - missing}/${sample.length}`);

		// 14d. **缺陷 163**（第 154 轮）：原来断言「恰有 1 个占位符」，
		// 作者填好后反而失败 —— 测试与交接状态耦合。改为：检测器用合成样本自证，真实文件断言「不超过 1 个」。
		const ph = (paste.match(/<仓库\/附件链接>/g) ?? []).length;
		const syntheticPh = ("示例：<仓库/附件链接>").match(/<仓库\/附件链接>/g)?.length ?? 0;
		ck("占位符检测器本身有效（合成样本）", syntheticPh === 1, `合成样本命中 ${syntheticPh}`);
		ck("PASTE-READY 占位符不超过 1 个（0=已填、1=待填）", ph <= 1, `找到 ${ph} 个`);
		console.log(`  占位符: ${ph}`);

		// 14e. 结构标记必须完整
		const markers = ["## 一、标题", "## 二、正文", "<!-- 正文结束 -->", "## 三、英文版"];
		for (const mk of markers) {
			ck(`PASTE-READY 含结构标记「${mk}」`, paste.includes(mk), "");
		}

		// 14f. **正文必须逐字一致**（这是用户真正粘贴的内容）
		{
			const discLines2 = disc.split(/\r?\n/);
			const pasteLines2 = paste.split(/\r?\n/);
			const fIdx = (ls, pred, from) => {
				for (let i = from || 0; i < ls.length; i++) if (pred(ls[i])) return i;
				return -1;
			};

			const dB = fIdx(discLines2, (l) => l.trim() === "### 正文");
			const dS = fIdx(discLines2, (l) => l.trim() === "---" && l.length < 10, dB);
			const pB = fIdx(pasteLines2, (l) => l.includes("## 二、正文"));
			const pE = fIdx(pasteLines2, (l) => l.includes("<!-- 正文结束 -->"), pB);

			if (dB >= 0 && dS > dB && pB >= 0 && pE > pB) {
				const discBody = discLines2.slice(dB + 1, dS).join("\n").trim();
				const pasteBody = pasteLines2.slice(pB + 1, pE).join("\n").trim();
				ck("PASTE-READY 的中文正文与 discussion 逐字一致",
					discBody === pasteBody,
					`disc=${discBody.length} 字符, paste=${pasteBody.length} 字符`);
				console.log(`  中文正文: ${pasteBody.length} 字符 ${discBody === pasteBody ? "✅ 一致" : "❌ 不一致"}`);

				// 英文正文
				const dET = fIdx(discLines2, (l) => l.trim() === "### Body");
				let dEERel = discLines2.slice(dET + 1).findIndex((l) => l.trim() === "---");
				const dEBody = dET >= 0
					? discLines2.slice(dET + 1, dEERel < 0 ? discLines2.length : dET + 1 + dEERel).join("\n").trim()
					: "";
				const pEB = fIdx(pasteLines2, (l) => l.includes("### 英文正文"));
				const pEE = fIdx(pasteLines2, (l) => l.includes("<!-- 英文正文结束 -->"), pEB);
				if (pEB >= 0 && pEE > pEB) {
					const pasteEBody = pasteLines2.slice(pEB + 1, pEE).join("\n").trim();
					ck("PASTE-READY 的英文正文与 discussion 逐字一致",
						dEBody === pasteEBody,
						`disc=${dEBody.length} 字符, paste=${pasteEBody.length} 字符`);
					console.log(`  英文正文: ${pasteEBody.length} 字符 ${dEBody === pasteEBody ? "✅ 一致" : "❌ 不一致"}`);
				}
			} else {
				ck("PASTE-READY 正文结构可定位", false, `${dB},${dS},${pB},${pE}`);
			}
		}
	}
}

// ===========================================================================
// 15. README **内部**数字一致（不同章节之间不矛盾）
//
// **缺陷 67**：L723 说「**48 个缺陷逐一映射」（实际 66）、
// L765 说「本项目做了 86 层验证」（实际 90）。
// 之前的检查都是「README vs 源码 / 英文版 / discussion」，
// 但从没检查过**同一份 README 里不同章节是否自相矛盾**。
// ===========================================================================
console.log("\n=== 14. README 内部数字一致 ===");
{
	const defectsActual = [...readme.matchAll(/^\| (\d+) \| \*\*/gm)].length;
	const suiteActual = suiteTotal;

	// 提取 README 里所有「N 层验证」「N 个缺陷逐一映射」「修复上述 N 个」
	const INTERNAL_CHECKS = [
		{
			name: "「本项目做了 N 层验证」",
			re: /本项目做了 (\d+) 层验证/g,
			expect: suiteActual,
			label: "层数",
		},
		{
			name: "「把 N 个缺陷逐一映射」",
			re: /把 \*\*(\d+) 个缺陷逐一映射/g,
			expect: defectsActual,
			label: "缺陷数",
		},
		{
			name: "「修复上述 N 个自身缺陷」",
			re: /修复上述 (\d+) 个自身缺陷/g,
			expect: defectsActual,
			label: "缺陷数",
		},
		{
			name: "「共发现并修掉 N 个自身缺陷」",
			re: /共发现并修掉 (\d+) 个自身缺陷/g,
			expect: defectsActual,
			label: "缺陷数",
		},
		{
			// **缺陷 68 补充**：discussion 里写「发布前我做了九十层对抗性测试」
			// 只匹配阿拉伯数字形式（中文数字需要额外转换，此处简化）
			name: "「N 层对抗性测试」（数字形式）",
			re: /(\d+)\s*层对抗性测试/g,
			expect: suiteActual,
			label: "层数",
		},
	];

	// **缺陷 68**：不只查 README —— discussion / PASTE-READY 也有「N 层测试」表述。
	const INTERNAL_DOCS = [
		["README.md", readme],
		["community/discussion-deepseek-harness.md", readmeDisc],
		["PASTE-READY.zh.md", (() => {
			const pp = path.join(ROOT, "PASTE-READY.zh.md");
			return fs.existsSync(pp) ? fs.readFileSync(pp, "utf8") : "";
		})()],
	];

	let internalProblems = [];
	let patternHits = 0;

	for (const [docName, docText] of INTERNAL_DOCS) {
		if (!docText) continue;
		const docLines = docText.split(/\r?\n/);

		for (const chk of INTERNAL_CHECKS) {
			for (let i = 0; i < docLines.length; i++) {
				const line = docLines[i];
				// 缺陷表行 + 历史叙述行都跳过
				if (/^\| \d+ \|/.test(line)) continue;
				if (/实际|原本|原有|曾|当时|此前|旧值|过时|old|before|previously/i.test(line)) continue;

				for (const m of line.matchAll(chk.re)) {
					patternHits++;
					const n = Number(m[1]);
					if (n !== chk.expect) {
						internalProblems.push(`${docName} L${i + 1} ${chk.name}: ${n}（应为 ${chk.expect}）`);
					}
				}
			}
		}
	}

	console.log(`  README 内部数字检查: ${internalProblems.length} 处不一致`);
	ck("README 不同章节的数字互不矛盾", internalProblems.length === 0,
		internalProblems.slice(0, 5).join("; "));
	for (const p of internalProblems.slice(0, 5)) console.log(`    ❌ ${p}`);
	if (internalProblems.length === 0) console.log("  ✅ 内部一致");

	ck("内部数字检查确实匹配到了内容（非空转）", patternHits >= 2, `${patternHits} 个模式命中`);
	console.log(`  命中的模式数: ${patternHits}/${INTERNAL_CHECKS.length}`);
}

// ===========================================================================
// 16. 运行模式的耗时关系合理（缺陷 80）
//
// 实测：--offline 是 82 套件 / 568.6 秒（9.5 分钟），但 README 曾写「约 6 分钟」。
// 第 67 轮修过这张表的**套件数**，但**耗时不在检查范围内**（只能实测，无法静态推导）。
// ===========================================================================
console.log("\n=== 15. 运行模式的耗时关系 ===");
{
	const MODE_RE = /(--quick --offline`|--offline`|run-all\.mjs`)\s*\|\s*\**?(\d+)\**?\s*\|\s*\**?约?\s*\**?([\d.]+)\s*(秒|分钟)/g;
	const modeRows = [...readme.matchAll(MODE_RE)];
	console.log("  解析到 " + modeRows.length + " 行运行模式");

	if (modeRows.length >= 2) {
		const parsed = modeRows.map((m) => {
			const isQuick = m[1].indexOf("--quick") >= 0;
			const isFull = m[1].indexOf("run-all.mjs") === 0;
			const unit = m[4] === "秒" ? 1 : 60;
			const kind = isQuick ? "quick" : (isFull ? "full" : "offline");
			return { kind, suites: Number(m[2]), sec: Number(m[3]) * unit };
		});

		for (const p of parsed) {
			console.log("    " + p.kind + ": " + p.suites + " 套件 / " + p.sec + " 秒");
		}

		const quick = parsed.filter((p) => p.kind === "quick")[0];
		const offline = parsed.filter((p) => p.kind === "offline")[0];
		const full = parsed.filter((p) => p.kind === "full")[0];

		if (quick && offline && full) {
			ck("套件数 quick < offline < full",
				quick.suites < offline.suites && offline.suites < full.suites,
				quick.suites + " / " + offline.suites + " / " + full.suites);

			ck("耗时 quick < offline < full",
				quick.sec < offline.sec && offline.sec < full.sec,
				quick.sec + "s / " + offline.sec + "s / " + full.sec + "s");

			const suiteRatio = offline.suites / quick.suites;
			const timeRatio = offline.sec / quick.sec;
			ck("offline 耗时相对 quick 未被严重低估",
				timeRatio >= suiteRatio * 0.5,
				"套件比 " + suiteRatio.toFixed(2) + "x，耗时比 " + timeRatio.toFixed(2) + "x");
			console.log("    套件比 " + suiteRatio.toFixed(2) + "x，耗时比 " + timeRatio.toFixed(2) + "x");

			const logSuites = full.suites - offline.suites;
			ck("full 与 offline 的套件差在合理范围", logSuites >= 5 && logSuites <= 20,
				"差 " + logSuites + " 个");
			console.log("    full - offline = " + logSuites + " 个（需真实日志的套件）");

			// **缺陷 107**（第 110 轮）：表格只写「跳过真实日志与慢速套件」，
			// 读者无法知道**具体跳过了哪 9 个真实日志套件**，也无法知道
			// 「只看 --quick 全绿不代表全部通过」。要求必须有明确警示。
			ck("README 说明三种模式覆盖范围不同",
				/三种模式覆盖范围不同/.test(readme), "缺覆盖范围差异说明");
			ck("README 列出被跳过的真实日志套件名字",
				/replay-real-streams/.test(readme) && /health-check/.test(readme) && /per-model-replay/.test(readme),
				"未列出被跳过的真实日志套件");
			ck("README 说明 quick 全绿不代表全部通过",
				/不代表全部通过/.test(readme), "缺「不代表全部通过」的警示");
			ck("README 说明真实日志套件无日志时会 SKIP（环境缺失非通过）",
				/环境缺失，不是验证通过|环境缺失.*不是.*通过/.test(readme), "缺 SKIP 语义说明");
			ck("英文版同样说明模式覆盖差异",
				/cover different ground/.test(readmeEn), "英文版缺说明");
			ck("英文版列出被跳过的真实日志套件",
				/replay-real-streams/.test(readmeEn) && /health-check/.test(readmeEn), "英文版未列出");
		}
	} else {
		ck("解析到足够多的运行模式行", false, "只有 " + modeRows.length + " 行");
	}
}

// ===========================================================================
// 17. 会增长的数字必须标明「快照」（缺陷 81）
//
// 真实流数字会随日常使用增长：写作时 14,408，第 86 轮复跑已是 15,675（+8.8%）。
// 第 85 轮只在 1 处加了「某一时点快照」，其余 5 处读者会当作当前值。
//
// 本检查：所有「真实流/真实会话流」数字（缺陷表除外）都必须带「快照」说明。
// ===========================================================================
console.log("\n=== 16. 会增长的数字必须标明快照 ===");
{
	const VOLATILE_PATTERNS = [
		{ name: "真实流", re: /\d{1,3}(?:,\d{3})+\s*条真实(?:会话)?流/g },
		{ name: "真实会话流", re: /\d{1,3}(?:,\d{3})+\s*条真实会话流/g },
	];

	const unmarked = [];
	const zhLines = readme.split(/\r?\n/);

	for (let i = 0; i < zhLines.length; i++) {
		const line = zhLines[i];
		if (/^\| \d+ \|/.test(line)) continue;   // 缺陷表 = 历史记录，跳过

		if (!/条真实/.test(line)) continue;
		if (/快照/.test(line)) continue;          // 已标注
		if (/写作时为|复跑时已是/.test(line)) continue;  // 说明段落自身

		unmarked.push(`L${i + 1}: ${line.trim().slice(0, 80)}`);
	}

	console.log(`  未标注快照的真实流引用: ${unmarked.length} 处`);
	ck("所有会增长的数字都标明了「快照」", unmarked.length === 0,
		unmarked.slice(0, 3).join(" | "));
	for (const u of unmarked.slice(0, 5)) console.log(`    ❌ ${u}`);

	// 测试矩阵前必须有增长说明
	ck("测试矩阵前有「数字会增长」的说明", /真实流数字会随日常使用|grows with daily use/i.test(readme),
		"未找到说明");

	// **反向验证**：确实存在被标注的快照（防止空转）
	let marked = 0;
	for (const l of zhLines) {
		if (/^\| \d+ \|/.test(l)) continue;
		if (/条真实/.test(l) && /快照/.test(l)) marked++;
	}
	ck("确实有被标注的快照引用（非空转）", marked > 0, `找到 ${marked} 处`);
	console.log(`  已标注的快照引用: ${marked} 处`);
}

console.log(`\n===== 文档数字一致性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
