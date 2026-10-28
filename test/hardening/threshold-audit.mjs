// 阈值宽容量审计（元套件）
//
// **为什么需要**（缺陷 103，第 106 轮）：
// 第 105 轮发现 `memory-lifecycle.mjs` 第 5 节的「LRU 有上界」断言用了
// 「500 个模型后堆增长 < 10MB」—— 但 500 个 LRU 条目合计只有 **0.048MB**，
// 所以**即使 LRU 完全没有上限，断言也会通过**（假通过）。
//
// 第 106 轮系统扫描全部套件，发现同类问题**不止一处**：
//
//   · memory-lifecycle L71  阈值 20MB，实测 0.17MB  → 大 118 倍
//   · memory-lifecycle L89  阈值 25MB，实测 0.47MB  → 大 53 倍
//   · memory-lifecycle L109 阈值 20MB，实测 0.05MB  → 大 400 倍
//   · memory-lifecycle L143 阈值 10MB，实测 ~0MB    → 无限倍
//   · soak-test       L103  阈值 50MB，实测 0.38MB  → 大 131 倍
//   · soak-test       L163  阈值 5MB， 实测 0.02MB  → 大 250 倍
//
// 换算成「每次操作可泄漏多少字节才会被发现」：
//   20MB / 3000 流 = 每流 6990 字节 —— 而一个 block 对象只有 ~500 字节。
//   **也就是说：即使每流泄漏一整个 block 对象，这些断言也全部通过。**
//
// 本元套件的作用：**扫描所有套件的内存类阈值，要求阈值不能比「实测基线」
// 高出一个数量级以上**。基线值集中记录在 BASELINES 里（每次实测更新），
// 一旦某个阈值被放宽到 10 倍以上就报错。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIR = path.join(ROOT, "test", "hardening");

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
	if (ok) { pass++; console.log("  ✅ " + label); }
	else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("  ❌ " + label + (detail ? " :: " + detail : "")); }
};

// 实测基线（MB）—— 每轮实测后更新。key = 文件名::断言特征
const BASELINES = {
	"memory-lifecycle.mjs::3000 条流": { measured: 0.17, maxAllowed: 1.5 },
	"memory-lifecycle.mjs::大块流": { measured: 0.47, maxAllowed: 1.5 },
	"memory-lifecycle.mjs::扣留块": { measured: 0.05, maxAllowed: 0.5 },
	"memory-lifecycle.mjs::中断流": { measured: 0.00, maxAllowed: 1 },
	"soak-test.mjs::2 万次请求": { measured: 0.38, maxAllowed: 3 },
	"soak-test.mjs::多模型轮转": { measured: 0.02, maxAllowed: 0.2 },
};

console.log("=== 1. 内存类阈值必须接近实测基线（不能宽 10 倍以上）===");
{
	for (const [key, base] of Object.entries(BASELINES)) {
		const [file, hint] = key.split("::");
		const p = path.join(DIR, file);
		if (!fs.existsSync(p)) {
			ck(file + " 存在", false, "");
			continue;
		}
		const src = fs.readFileSync(p, "utf8");
		const lines = src.split("\n");

		// 找到包含该提示词的 ck 断言行
		let found = null;
		for (let i = 0; i < lines.length; i++) {
			if (!lines[i].includes(hint)) continue;
			if (!/ck\(/.test(lines[i])) continue;
			// 提取阈值
			const m = lines[i].match(/<\s*([\d.]+)\s*,\s*[^)]*?(MB|toFixed)/);
			if (m) { found = { line: i + 1, threshold: Number(m[1]), raw: lines[i].trim() }; break; }
		}

		if (!found) {
			ck(file + " 的「" + hint + "」断言可定位", false, "未找到");
			continue;
		}

		const ratio = base.measured > 0 ? found.threshold / base.measured : Infinity;
		const ok = found.threshold <= base.maxAllowed;
		ck(file + " 「" + hint + "」阈值 " + found.threshold + "MB ≤ 允许上限 " + base.maxAllowed + "MB",
			ok,
			"实测 " + base.measured + "MB，阈值/实测 = " + (Number.isFinite(ratio) ? ratio.toFixed(0) + " 倍" : "∞"));
		if (ok) console.log("     L" + found.line + ": 阈值 " + found.threshold + "MB / 实测 " + base.measured + "MB（" + (Number.isFinite(ratio) ? ratio.toFixed(0) + " 倍" : "∞") + "）");
	}
}

console.log("\n=== 2. 不允许存在「比实测宽 10 倍以上」的内存阈值 ===");
{
	// 扫描所有套件里的堆内存阈值，与 BASELINES 对照
	let scanned = 0;
	const tooWide = [];
	for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith(".mjs") && !x.startsWith("_") && x !== "threshold-audit.mjs")) {
		const src = fs.readFileSync(path.join(DIR, f), "utf8");
		const lines = src.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const l = lines[i];
			if (!/MB/.test(l)) continue;
			if (!/ck\(/.test(l)) continue;
			const m = l.match(/<\s*(\d+(?:\.\d+)?)/);
			if (!m) continue;
			scanned++;
			const th = Number(m[1]);
			// 找一个对应的基线（按提示词模糊匹配）
			for (const [key, base] of Object.entries(BASELINES)) {
				const [bf, hint] = key.split("::");
				if (bf !== f) continue;
				if (!l.includes(hint)) continue;
				if (base.measured > 0 && th / base.measured > 10) {
					tooWide.push(f + " L" + (i + 1) + ": " + th + "MB / 实测 " + base.measured + "MB = " + (th / base.measured).toFixed(0) + " 倍");
				}
			}
		}
	}
	console.log("  扫描了 " + scanned + " 处 MB 类断言");
	ck("没有比实测宽 10 倍以上的内存阈值", tooWide.length === 0, tooWide.slice(0, 3).join("; "));
	for (const w of tooWide) console.log("    ❌ " + w);
}

console.log("\n=== 3. 每条内存断言都应打印实测值（便于发现阈值过宽）===");
{
	// 检查含 MB 的 ck 断言附近是否有 console.log 打印实际值
	let missing = [];
	for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith(".mjs") && !x.startsWith("_") && x !== "threshold-audit.mjs")) {
		const src = fs.readFileSync(path.join(DIR, f), "utf8");
		const lines = src.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (!/ck\(/.test(lines[i])) continue;
			if (!/MB/.test(lines[i])) continue;
			// **排除误匹配**：`100MB 单块不崩溃` 里的 MB 是提示文本，不是内存阈值。
			// 真正的内存断言必须同时含「堆 / heap / 增长 / growth」等特征词。
			if (!/堆|heap|增长|growth|deltaMB|peakMB|finalMB/i.test(lines[i])) continue;
			if (/console\.log/.test(lines[i])) continue;   // 同一行有打印
			// 看前 5 行内是否有 console.log 且含 toFixed
			let hasLog = false;
			for (let j = Math.max(0, i - 5); j < i; j++) {
				if (/console\.log/.test(lines[j]) && /toFixed/.test(lines[j])) { hasLog = true; break; }
			}
			if (!hasLog) missing.push(f + " L" + (i + 1));
		}
	}
	ck("每条 MB 类断言都有实测值打印", missing.length === 0, missing.slice(0, 4).join(", "));
	if (missing.length) console.log("  缺打印: " + missing.slice(0, 6).join(", "));
	else console.log("  全部有实测值打印");
}

console.log("\n=== 4. 反向验证：基线本身合理（不虚高）===");
{
	// 基线的 maxAllowed 不应比 measured 大 10 倍以上
	const bad = [];
	for (const [key, base] of Object.entries(BASELINES)) {
		if (base.measured === 0) continue;
		const r = base.maxAllowed / base.measured;
		if (r > 10) bad.push(key + ": " + r.toFixed(0) + " 倍");
	}
	ck("基线允许上限不超过实测的 10 倍", bad.length === 0, bad.join("; "));
	ck("基线条目数合理（≥ 5 条内存断言）", Object.keys(BASELINES).length >= 5, String(Object.keys(BASELINES).length));
}

console.log("\n=== 5. 时间类断言必须有可解释性（带宽必须被声明或量化）===");
{
	// **第 107 轮**：时间类断言与内存类不同 —— 它们必须留出 CI 抖动余量，
	// 所以「阈值紧贴实测」是不现实的（CI 上可能慢 10~100 倍）。
	// 但读者需要能判断：**这条断言是「性能保证」还是「只防挂死」**。
	//
	// 合格条件（满足任一即可）：
	//   a) 断言文本里打印了**实测值**（人能看出实际多快）
	//   b) 断言文字里有**语义声明**（「宽松」「只抓严重退化」「不挂死」「立即返回」「毫秒级」）
	//   c) **文件头**有整体声明（说明本套件的性能断言是防灾难性质）
	//
	// 不合格 = 三者皆无 → 读者会误以为阈值就是性能保证。
	const TIME_FILES = fs.readdirSync(DIR).filter((x) =>
		x.endsWith(".mjs") && !x.startsWith("_") && x !== "threshold-audit.mjs");

	const bad = [];
	let scanned = 0;

	for (const f of TIME_FILES) {
		const src = fs.readFileSync(path.join(DIR, f), "utf8");
		const lines = src.split("\n");

		// 文件头声明
		let headerDecl = false;
		for (let i = 0; i < Math.min(30, lines.length); i++) {
			if (/宽松|只抓|防灾难|防挂死|毫秒级|不阻塞|不会.{0,6}退化|ReDoS/i.test(lines[i])) { headerDecl = true; break; }
		}

		for (let i = 0; i < lines.length; i++) {
			const l = lines[i];
			if (!/\bck\(/.test(l)) continue;
			// **只认真正的耗时断言**：第 107 轮踩过一个误报 ——
			// `ck("message 长度 < 300 字符", msg.length < 300, ...)` 里的
			// 「毫秒/字符」只是**说明文字**，不是耗时断言。
			// 判据收紧为：**必须出现时间变量名**（ms / elapsed / r.ms / 耗时变量），
			// 而不是标题里恰好有「ms」或「字符」。
			if (!/\b\w*ms\b|elapsed|hrtime|\bms\s*[<>=]/i.test(l)) continue;
			if (/字符|msg\.length|字符数/.test(l)) continue;
			const m = l.match(/<\s*(\d+(?:\.\d+)?)/);
			if (!m) continue;
			scanned++;

			// a) 实测值：同一行有 toFixed/ms 输出，或前 6 行有 console.log
			let hasMeasured = /console\.log/.test(l) || /\$\{[^}]*toFixed/.test(l);
			if (!hasMeasured) {
				for (let j = Math.max(0, i - 6); j < i; j++) {
					if (/console\.log/.test(lines[j]) && /toFixed|ms/i.test(lines[j])) { hasMeasured = true; break; }
				}
			}
			// b) 文字声明
			const textDecl = /宽松|只抓|不挂死|不阻塞|立即|毫秒级|上限\s*\d+ms|不回退|快速返回/.test(l);

			if (!hasMeasured && !textDecl && !headerDecl) {
				bad.push(f + " L" + (i + 1) + ": " + l.trim().slice(0, 90));
			}
		}
	}

	console.log("  扫描了 " + scanned + " 处耗时断言");
	ck("每处耗时断言都可解释（有实测值/语义声明/文件头声明）", bad.length === 0, bad.slice(0, 3).join(" | "));
	for (const b of bad.slice(0, 6)) console.log("    ❌ " + b);

	// **反向验证**：必须真的扫到足够多的耗时断言（防止正则失效导致空转）
	ck("确实扫到了耗时断言（非空转）", scanned >= 15, "只扫到 " + scanned + " 处");
}

console.log("\n===== 阈值宽容量审计: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log("  ❌ " + f);
}
process.exit(fail === 0 ? 0 : 1);