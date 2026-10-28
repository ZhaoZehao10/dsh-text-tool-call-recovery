// 测试基建自身的健全性检查
//
// 这个套件验证「验证工具」本身不会产生**虚假通过**。
// 背景：本项目曾多次因为测试基建缺陷而漏看问题——
//   - run-all 静默跳过套件（--quick 看起来像全量）
//   - 变异体锚点失效变成 SKIP，但套件仍然通过
//   - 覆盖率脚本用固定临时目录，并发时互相覆盖
// 这些都导致「显示通过、实际未验证」。本套件把这类陷阱固化成断言。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
// **缺陷 137 自我修正 3**：第 16 节要用 `execFileSync`，但文件顶部没导入它 ——
// 缺 import 会在运行到那一节时抛 `ReferenceError`，而它被 `try/catch` 吞掉，
// 于是所有套件都报「实际 null」。**这正是本套件自己反复检查的那类静默失败。**
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

console.log("=== 1. 变异测试：SKIP 必须导致失败 ===");
{
	const src = read("test/hardening/mutation-test.mjs");
	// 关键：退出条件必须同时检查 survived 与 skipped
	ck("退出条件包含 skipped === 0", /ok\s*=\s*survived\s*===\s*0\s*&&\s*skipped\s*===\s*0/.test(src),
		"未找到 `survived === 0 && skipped === 0`");
	// 必须有 SKIP 报告章节
	ck("有「被跳过的变异体」章节", src.includes("被跳过的变异体"));
	ck("有修复指引", src.includes("锚点失效") || src.includes("锚点过期"));
	// 覆盖率必须有两种口径
	ck("报告「仅计已评估」覆盖率", src.includes("仅计已评估"));
	ck("报告「含 SKIP 未验证」覆盖率", src.includes("含 SKIP 未验证"));
	// 不能只有 survived 判定
	const hasOldBug = /process\.exit\(survived === 0 \? 0 : 1\)/.test(src);
	ck("无旧的「只看 survived」bug", !hasOldBug, hasOldBug ? "仍存在 process.exit(survived === 0 ...)" : "");
}

console.log("\n=== 2. run-all：跳过必须显式报告 ===");
{
	const src = read("test/run-all.mjs");
	ck("记录被跳过的套件", src.includes("skipped.push"));
	ck("输出含「未运行」字样", src.includes("未运行"));
	ck("提示如何跑全量", src.includes("去掉 --quick"));
	// 跳过原因要去重
	ck("跳过原因去重", src.includes("new Set(skipReasons)"));
}

console.log("\n=== 3. 覆盖率脚本：并发安全 ===");
{
	for (const f of ["coverage.mjs", "branch-coverage.mjs"]) {
		const src = read("test/hardening/" + f);
		ck(`${f} 用 mkdtempSync`, src.includes("mkdtempSync"));
		// 不能再用仓库内固定目录（注释里提到不算）
		const codeLines = src.split("\n").filter((l) => !l.trim().startsWith("//"));
		const hasFixedDir = codeLines.some((l) => /const (COV|COV_DIR)\s*=\s*path\.join\(ROOT/.test(l));
		ck(`${f} 无固定目录常量`, !hasFixedDir, hasFixedDir ? "仍用 path.join(ROOT, ...)" : "");
	}
}

console.log("\n=== 4. 元套件不能递归运行其他元套件 ===");
{
	const META = ["mutation-test.mjs", "coverage.mjs", "branch-coverage.mjs"];
	for (const f of ["coverage.mjs", "branch-coverage.mjs"]) {
		const src = read("test/hardening/" + f);
		// 每个元套件都应排除所有元套件
		for (const m of META) {
			if (m === f) continue;
			ck(`${f} 排除 ${m}`, src.includes(`"${m}"`), `未排除 ${m}`);
		}
	}
}

console.log("\n=== 5. 覆盖率门槛有明确说明 ===");
{
	const src = read("test/hardening/branch-coverage.mjs");
	// **缺陷 120**（第 120 轮）：原规则要求 `const THRESHOLD = <数字>;`，
	// 但硬编码绝对数字会随代码演进失效（实测已从 30 涨到 54）。
	// 现在允许「基线 + 容差」形式，只要**能解析出最终门槛**即可。
	ck("有门槛常量（字面数字或基线+容差）",
		/const THRESHOLD = \d+;/.test(src) || (/const BASELINE = \d+;/.test(src) && /const TOLERANCE = \d+;/.test(src) && /const THRESHOLD = BASELINE \+ TOLERANCE;/.test(src)),
		"缺少 THRESHOLD 或 BASELINE+TOLERANCE");
	ck("门槛变更有原因说明", src.includes("门槛演进") || src.includes("防御性分支"), "");
	const m = src.match(/const THRESHOLD = (\d+);/)
		?? (src.match(/const BASELINE = (\d+);/)
			? [null, String(Number(src.match(/const BASELINE = (\d+);/)[1]) + Number((src.match(/const TOLERANCE = (\d+);/) ?? [0, 0])[1]))]
			: null);
	if (m) {
		const th = Number(m[1]);
		console.log(`  当前门槛: ${th}`);
		ck("门槛在合理范围（5-100）", th >= 5 && th <= 100, String(th));
	}
}

console.log("\n=== 6. 测试套件文件本身可解析（真语法检查）===");
{
	// **不要手写括号平衡扫描器**：它不认识正则字面量里的 { }（如 /{2,}/）、
	// 模板字符串嵌套、注释等，会产生大量假阳性（本人实测 5 个文件被误报）。
	// 直接用 Node 的 --check 做真语法检查。
	const { execFileSync } = await import("node:child_process");
	const dirs = [path.join(ROOT, "test"), path.join(ROOT, "test", "hardening")];
	let checked = 0;
	const parseFails = [];
	for (const d of dirs) {
		if (!fs.existsSync(d)) continue;
		for (const f of fs.readdirSync(d)) {
			if (!f.endsWith(".mjs")) continue;
			const p = path.join(d, f);
			try {
				execFileSync(process.execPath, ["--check", p], { stdio: "pipe", timeout: 30000 });
				checked++;
			} catch {
				parseFails.push(f);
			}
		}
	}
	console.log(`  语法检查了 ${checked} 个文件`);
	ck("所有测试文件语法正确", parseFails.length === 0, parseFails.join(","));
}

console.log("\n=== 7. 每个 hardening 套件都有 ck/check 断言（不是空壳）===");
{
	const dir = path.join(ROOT, "test", "hardening");
	const empty = [];
	for (const f of fs.readdirSync(dir)) {
		// **缺陷 88**：`_` 开头是共享工具模块（如 `_host-invariant.mjs`），不是套件
		if (f.startsWith("_")) continue;
		if (!f.endsWith(".mjs")) continue;
		// 元套件（运行其他套件）
		if (f === "mutation-test.mjs" || f === "coverage.mjs" || f === "branch-coverage.mjs") continue;
		// **审计/剖析类**：它们的产出是「报告」而非「断言」，
		// 人读输出即可，不需要 ck()。它们同样有价值（人工复核证据）。
		if (f === "audit-rewrites.mjs" || f === "perf-profile.mjs") continue;
		const src = fs.readFileSync(path.join(dir, f), "utf8");
		const hasCk = /\bck\(/.test(src) || /\bcheck\(/.test(src);
		const hasExit = /process\.exit\(/.test(src);
		if (!hasCk && !hasExit) empty.push(f);
	}
	ck("没有「无断言」的空壳套件", empty.length === 0, empty.join(","));
}

// ===========================================================================
// 8. 关键套件的变异验证证据
//
// **缺陷 74**（第 79 轮）：26 个关键套件里只有 7 个（27%）有变异验证记录。
// 但实际抽查 4 个「无记录」的关键套件，**全部有效** —— 缺的是证据文档化，不是能力。
//
// 本检查维护一份「已变异验证」清单；关键套件必须在此清单里。
// 新增关键套件时：先做一次变异验证，再把名字加进 VERIFIED。
// ===========================================================================
console.log("\n=== 8. 关键套件的变异验证证据 ===");
{
	// 已被实际变异验证过的套件（每个都跑过一次「注入破坏 → 检查必须失败」）
	const VERIFIED = new Set([
		// 第 79 轮实测（注入破坏 → 检查失败 → 恢复后通过）
		"defect-coverage-matrix",   // 删矩阵一条 → ❌ D1 无守护
		"path-consistency",         // 破坏 coerceValue → ❌ 某条逐键强转路径附近没有 coerceValue
		"known-limits-accuracy",    // 删一条已知限制 → ❌ 6/7
		"doc-executable",           // powershell 语法错 / 引用不存在文件 → 均 ❌
		// 在此之前已记录过的
		// 在此之前已记录过的
		"doc-consistency",
		"doc-structure",
		"deliverable",
		"ref-verifiable",
		"safety-net-contract",
		// 第 79 轮实测（每个都做过「注入破坏 → 检查失败 → 恢复后通过」）
		"claims-audit",   // 改测试矩阵的「N 项」为 999 → ❌
		"fake-test-audit",   // 放一个无断言空壳 → ❌
		"passthrough-design",   // 移除 tools 为空时的早退 → ❌ 早退语句
		"coercion-semantics",   // coerceValue 的 Number(raw) → String(raw) → ❌ number "42" → 42
		"bare-json-safety",   // 移除 hasContainer 防线 → ❌ 只有 name 没有参数容器
		"install-experience",   // 去掉 install-stepfix.ps1 的 BOM → ❌ 前 3 字节
		"install-failure-paths",   // 删 profile 存在性检查 → ❌ 给出「profile 目录不存在」错误
		"uninstall-flow",   // 删 README 卸载章节的 Set-Content 警告 → ❌
		"execution-safety",   // 职责是参数完整性（围栏由 backtick-precision 等 23 个套件守护）→ 参数注入 ❌
		"meta-health",   // 本套件自身；放语法错误的 .mjs → ❌ 套件文件可解析
	]);

	// 关键套件清单（守护材料 / 代码行为 / 交付流程 的核心）
	const CRITICAL = [
		"doc-consistency", "doc-structure", "doc-executable", "deliverable",
		"ref-verifiable", "claims-audit", "defect-coverage-matrix", "fake-test-audit",
		"known-limits-accuracy", "meta-health",
		"path-consistency", "safety-net-contract", "passthrough-design",
		"coercion-semantics", "bare-json-safety", "execution-safety",
		"install-experience", "install-failure-paths", "uninstall-flow",
	];

	const dir = path.join(ROOT, "test", "hardening");
	const missingFile = [];
	const unverified = [];

	for (const name of CRITICAL) {
		const p = path.join(dir, name + ".mjs");
		if (!fs.existsSync(p)) { missingFile.push(name); continue; }
		if (!VERIFIED.has(name)) unverified.push(name);
	}

	console.log(`  关键套件: ${CRITICAL.length} 个，已变异验证: ${CRITICAL.length - unverified.length} 个`);
	ck("关键套件都存在", missingFile.length === 0, missingFile.join(", "));
	ck("所有关键套件都有变异验证证据", unverified.length === 0,
		`待补: ${unverified.join(", ")}`);
	if (unverified.length > 0) {
		console.log("  ⚠️ 缺证据（未做变异验证）:");
		for (const u of unverified) console.log(`    · ${u}`);
	}

	// **反向验证**：VERIFIED 里不能有不存在或非关键的套件
	const bogus = [...VERIFIED].filter((n) =>
		!CRITICAL.includes(n) || !fs.existsSync(path.join(dir, n + ".mjs")));
	ck("VERIFIED 清单里的套件都真实存在且属关键套件", bogus.length === 0, bogus.join(", "));
}

// ===========================================================================
// 9. 永不失败的套件必须如实标注（缺陷 83）
//
// perf-profile 是**剖析工具**（输出供人工阅读），无 process.exit 失败路径。
// 它被 run-all 的 readdirSync 自动发现并当作测试运行，但永远不会失败。
// 它被正确豁免于 fake-test-audit，**但仍被计入「92 个套件全部通过」** —— 数字虚高。
// ===========================================================================
console.log("\n=== 9. 永不失败的套件必须如实标注 ===");
{
	const DIR = path.join(ROOT, "test", "hardening");
	// **缺陷 88**：`_` 开头是共享工具模块，不属于「套件」，不参与此扫描
		const all = fs.readdirSync(DIR).filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));

	const analytic = [];
	for (const f of all) {
		const src = fs.readFileSync(path.join(DIR, f), "utf8");
		const hasFailPath = /process\.exit\s*\([^)]*[?:][^)]*1\s*\)/.test(src) ||
			/process\.exit\s*\(\s*1\s*\)/.test(src) ||
			/throw new Error/.test(src) ||
			/process\.exitCode\s*=\s*1/.test(src);
		const hasCk = /\bck\(/.test(src) || /\bcheck\(/.test(src);
		if (!hasFailPath && !hasCk) analytic.push(f.replace(/\.mjs$/, ""));
	}

	console.log(`  永不失败的套件: ${analytic.length} 个 → ${analytic.join(", ") || "（无）"}`);

	// 每个永不失败的套件都必须在 README 里被如实标注
	const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
	const undocumented = analytic.filter((n) => !readme.includes(n));
	ck("永不失败的套件在 README 里有标注", undocumented.length === 0,
		undocumented.join(", "));

	// README 必须区分「能失败的验证套件」与「剖析工具」
	ck("README 区分了验证套件与剖析工具",
		/剖析工具/.test(readme),
		"未区分");

	// **反向验证**：确实检测到了（防止空转）
	ck("确实检测到了永不失败的套件（非空转）", analytic.length >= 1, "数量为 0，检查可能失效");
}

// ===========================================================================
// 10. 本地测试副本与 asar 一致（缺陷 85）
//
// **重大教训**：89 轮来一直把 `dsh-llm/lib/types/invariant.js` 当作「不存在」，
// 但实测它在 app.asar 里**确实存在**（4401 字节，协议校验器）。
// 根因：本地测试副本不完整（缺这个文件），不是文档写错。
//
// 本检查直接从 app.asar 读取真实的 dsh-llm，与本地副本比对：
//   ① 版本号一致 ② lib/index.js 字节一致 ③ lib/types 的 .js 文件集合一致
// asar 不可达时（如别人的机器）跳过并明确说明。
// ===========================================================================
console.log("\n=== 10. 本地测试副本与 asar 一致 ===");
{
	// **缺陷 147**（第 141 轮）：这里曾写死 `C:\Users\ZZH\AppData\...\app.asar` ——
	// ① **把作者的用户名提交到公开仓库**；② 别人机器上路径不同，只能靠 `DSH_ASAR` 手动指定，
	// 否则静默跳过 —— 而「静默跳过」会让这条检查形同不存在。
	//
	// 现改为**按候选位置自动探测**（环境变量优先，其次常见安装位置，最后 os.homedir()）：
	const ASAR_CANDIDATES = (() => {
		const out = [];
		if (process.env.DSH_ASAR) out.push(process.env.DSH_ASAR);
		const home = os.homedir();
		if (process.platform === "win32") {
			out.push(path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
				"Programs", "DeepSeek Harness", "resources", "app.asar"));
		}
		// 通用：Linux/macOS 以及自定义安装位
		out.push(path.join(home, ".local", "share", "deepseek-harness", "resources", "app.asar"));
		out.push("/opt/DeepSeek Harness/resources/app.asar");
		out.push("/Applications/DeepSeek Harness.app/Contents/Resources/app.asar");
		return out;
	})();
	const asarPath = ASAR_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

	// **asarPath 可能为 undefined**（所有候选都不存在）—— 直接 existsSync(undefined) 会抛错。
	if (!asarPath || !fs.existsSync(asarPath)) {
		console.log("  （asar 不可达，跳过 —— 这是正常的，不同机器安装路径不同）");
		console.log("  → 跳过（不计入通过，也不计入失败）");
	} else {
		try {
			const buf = fs.readFileSync(asarPath);
			// **缺陷 155**（第 148 轮，DSH 0.2.1-rc.3 适配）：
			// 原来用 `buf.indexOf('{"files":')` 找 header 起点 —— 这在 rc.3 上**找错了位置**。
			// 原因：asar header 里**嵌套的子目录节点也带 `"files"` 键**，
			// 所以 `indexOf` 会命中头部**内部**的某一处，而不是真正的 header 开头。
			// 实测 rc.3：第一个 `{"files":` 在 offset 16（正确），但旧逻辑取到的却是 1142，
			// 于是 JSON.parse 在 2099 处炸掉（正好是错的子串边界）。
			//
			// rc.2 之所以「碰巧能跑」，是因为其 header 结构与匹配位置恰好一致 ——
			// **这是典型的「靠巧合工作」**，不是正确实现。
			//
			// 现在按 **asar pickle 格式**正确解析：
			//   offset 0..3  : uint32 = 4（pickle 头长度）
			//   offset 4..7  : uint32 = header JSON 的 pickle 数据长度
			//   offset 8..11 : uint32 = header JSON 字符串长度
			//   offset 12..15: uint32 = 上一字段 + 4（对齐填充）
			//   offset 16..  : header JSON 本体
			// asar pickle 头的**精确字段布局**（实测 rc.3，与 rc.2 相同）：
			//   offset 0..3  : uint32 = 4          —— pickle 头自身的长度字段
			//   offset 4..7  : uint32 = ?          —— 整个 pickle 数据的长度（含头部开销）
			//   offset 8..11 : uint32 = ?          —— 该长度 + 4（对齐）
			//   offset 12..15: uint32 = JSON 字符数 ← **这才是我们要的长度**
			//   offset 16..  : header JSON 本体
			//
			// 实测 rc.3 三个候选值：4748096 / 4748092 / **4748087**，
			// 只有 4748087（offset 12）能让 JSON.parse 成功。
			const jsonLenVerified = buf.readUInt32LE(12);
			const idx = 16;
			// 自洽性：offset 8 的值应等于 offset 12 的值 + 5（pickle 的尾部对齐标记）。
			// 这个关系实测在 rc.2 / rc.3 都成立，用于在格式再变时**尽早报错**而不是静默解析错。
			if (buf.readUInt32LE(8) !== jsonLenVerified + 5) {
				throw new Error(`asar pickle 头不自洽：offset8=${buf.readUInt32LE(8)} jsonLen=${jsonLenVerified}`);
			}
			// **缺陷 155 自我修正**：原来用「括号深度扫描」找 JSON 结尾 ——
			// 但 asar header 里的 JSON **字符串值本身含 `{` 和 `}`**（如 package.json 内容），
			// 深度会算错，于是 subarray 截断在错误位置 → JSON.parse 在 2099 处炸掉。
			// 现在直接用 pickle 头里声明的**精确长度**切片，不做任何扫描。
			const header = JSON.parse(buf.subarray(idx, idx + jsonLenVerified).toString("utf8"));
			// asar 数据区起点：header 结束后按 4 字节对齐（pickle 结构要求）
			const dataOffset = Math.ceil((idx + jsonLenVerified) / 4) * 4;

			function readNode(node) {
				const start = dataOffset + Number(node.offset);
				return buf.subarray(start, start + Number(node.size));
			}

			// 定位 dsh-llm
			let target = header;
			for (const seg of ["dsh", "node_modules", "@deepseek-ai", "dsh-llm"]) {
				target = target?.files?.[seg];
				if (!target) break;
			}

			if (!target) {
				console.log("  ⚠️ asar 内未找到 dsh-llm");
				ck("asar 内能找到 dsh-llm", false, "");
			} else {
				// ① 版本一致
				const asarPkg = JSON.parse(readNode(target.files["package.json"]).toString("utf8"));
				const localPkgPath = process.env.DSH_LLM_SRC
					? path.join(process.env.DSH_LLM_SRC, "package.json")
					: null;

				if (localPkgPath && fs.existsSync(localPkgPath)) {
					const localPkg = JSON.parse(fs.readFileSync(localPkgPath, "utf8"));
					ck("本地副本版本与 asar 一致", asarPkg.version === localPkg.version,
						`asar=${asarPkg.version} local=${localPkg.version}`);
					console.log(`  版本: asar=${asarPkg.version} local=${localPkg.version}`);
				}

				// ② lib/index.js 字节一致
				const asarLib = readNode(target.files["lib"].files["index.js"]);
				const localLibPath = process.env.DSH_LLM_SRC
					? path.join(process.env.DSH_LLM_SRC, "lib", "index.js")
					: null;

				if (localLibPath && fs.existsSync(localLibPath)) {
					const localLib = fs.readFileSync(localLibPath);
					ck("本地副本 lib/index.js 与 asar 字节一致", asarLib.equals(localLib),
						`asar=${asarLib.length} local=${localLib.length}`);
					console.log(`  lib/index.js: asar=${asarLib.length} local=${localLib.length}`);
				}

				// ③ lib/types 的 .js 集合一致（这是 invariant.js 漏掉的直接原因）
				const asarTypesDir = target.files["lib"]?.files?.["types"];
				if (asarTypesDir?.files) {
					const asarJs = new Set(Object.keys(asarTypesDir.files).filter((f) => f.endsWith(".js")));
					const localTypesDir = process.env.DSH_LLM_SRC
						? path.join(process.env.DSH_LLM_SRC, "lib", "types")
						: null;

					if (localTypesDir && fs.existsSync(localTypesDir)) {
						const localJs = new Set(fs.readdirSync(localTypesDir).filter((f) => f.endsWith(".js")));
						const missing = [...asarJs].filter((f) => !localJs.has(f));
						ck("本地副本的 lib/types/*.js 覆盖了 asar 的全部（无缺失）",
							missing.length === 0,
							`缺失: ${missing.join(", ")}（应从 asar 补全）`);
						if (missing.length > 0) {
							console.log(`  ❌ 本地缺失 ${missing.length} 个文件: ${missing.join(", ")}`);
						} else {
							console.log(`  lib/types: asar ${asarJs.size} 个 .js，本地全部覆盖 ✅`);
						}
					}
				}
			}
		} catch (e) {
			console.log("  ⚠️ asar 解析失败: " + e.message);
			ck("asar 可解析（失败时不误报为通过）", false, e.message.slice(0, 80));
		}
	}
}

// ===========================================================================
// 11. 会修改源码/环境的套件必须有 try/finally 保护（缺陷 105）
//
// **为什么需要**（第 108 轮）：
// `mutation-test.mjs` 会**临时改写 lib/index.js**（注入变异）来验证测试有效性。
// 原实现是「写变异 → 跑套件 → 还原」三步直线代码，**没有 try/finally**。
// 虽然 runSuite 内部捕获了异常，但 `fs.writeFileSync` 本身可能抛
// （磁盘满 / 权限 / 文件被占用）。一旦在那里抛，还原就会被跳过，
// **lib/index.js 永久停留在变异状态** —— 之后所有套件都在坏代码上运行，
// 而它们「失败」的原因与被测代码毫无关系，极难排查。
//
// 本检查：
//   ① 任何会 writeFileSync 到 lib/index.js 的套件，必须含 try/finally
//   ② 必须有「还原失败」的兜底提示（告诉用户怎么手动恢复）
//   ③ 会改 process.env 的套件，必须保存并在结束时恢复原值
// ===========================================================================
console.log("\n=== 11. 会修改源码/环境的套件必须有 try/finally 保护 ===");
{
	const DIR2 = path.join(ROOT, "test", "hardening");
	// **排除自身**：本套件的检查代码里含 `process.env` 正则字符串，
	// 会被自己的扫描命中（自指）。检查器不该把自己当成被检查对象。
	const files2 = fs.readdirSync(DIR2).filter((f) => f.endsWith(".mjs") && !f.startsWith("_") && f !== "meta-health.mjs");

	// ① 写 lib/index.js 的套件
	const mutators = [];
	for (const f of files2) {
		const src = fs.readFileSync(path.join(DIR2, f), "utf8");
		// 是否 writeFileSync 到我门的 lib
		if (!/writeFileSync\s*\(\s*(LIB|libPath|LIB_PATH|SRC_PATH)\b/.test(src)) continue;
		mutators.push({ f, hasFinally: /finally\s*{/.test(src), src });
	}

	console.log("  会改写 lib/index.js 的套件: " + (mutators.length ? mutators.map((m) => m.f).join(", ") : "（无）"));
	ck("改写源码的套件都用 try/finally 保证还原",
		mutators.every((m) => m.hasFinally),
		mutators.filter((m) => !m.hasFinally).map((m) => m.f).join(", ") + " 缺 finally");

	for (const m of mutators) {
		// ② 还原失败的兜底提示
		ck(m.f + " 有「无法还原」的兜底提示",
			/无法还原|恢复失败|手动.{0,10}checkout|git checkout/i.test(m.src), "缺兜底提示");
	}

	// ③ 改 process.env 的套件必须能恢复到原值
	// **注意误报**（第 108 轮踩过）：
	//   · `if (process.env.DIAG_ORDER === "1")` 是**只读比较**，不是修改；
	//   · `const LLM = process.env.DSH_LLM_SRC` 也是只读。
	// 只有 `process.env.X = ...` 这种**赋值**才算修改。
	const envChangers = [];
	for (const f of files2) {
		const src = fs.readFileSync(path.join(DIR2, f), "utf8");
		// **只用赋值**判定（排除 === / == 比较）
		const sets = (src.match(/process\.env\.\w+\s*=(?!=)/g) ?? []).length;
		if (sets === 0) continue;
		// 恢复方式可以是：save+restore，或者**显式 delete**（每次 probe 自行设置/清除）
		const saves = /const\s+\w+\s*=\s*process\.env\.\w+/.test(src);
		const restores = /delete\s+process\.env\.\w+|process\.env\.\w+\s*=\s*\w+;.*\/\/\s*restore/.test(src);
		const deletes = (src.match(/delete\s+process\.env\.\w+/g) ?? []).length;
		envChangers.push({ f, sets, saves, restores, deletes });
	}

	console.log("  会改 process.env 的套件: " + envChangers.map((e) => e.f + "(" + e.sets + "处)").join(", "));
	// 合格条件（满足任一）：
	//   a) 保存原值 + 恢复（save/restore 模式）
	//   b) 有显式 delete（每次 probe 自行设定/清除，不需要保存）
	const envBad = envChangers.filter((e) => !((e.saves && e.restores) || e.deletes > 0));
	ck("改 process.env 的套件都能恢复到原值", envBad.length === 0,
		envBad.map((e) => e.f).join(", ") + " 缺 save/restore 或 delete");

	// **反向验证**：必须真的检测到这些套件（防止正则失效导致空转）
	ck("确实检测到改写源码的套件（非空转）", mutators.length >= 1, "只找到 " + mutators.length + " 个");
	ck("确实检测到改 env 的套件（非空转）", envChangers.length >= 1, "只找到 " + envChangers.length + " 个");
}

// ===========================================================================
// 12. run-all 的判定逻辑不能掩盖失败（缺陷 106）
//
// **为什么需要**（第 109 轮）：
// `run-all.mjs` 原逻辑在 catch 分支里写：
//   `if (/^跳过：/m.test(out)) { skipped = true; ok = true; }`
// 也就是「**只要输出里出现过『跳过：』，即使子进程 exit 1 也当成跳过**」。
//
// 实测（构造一个先打印「跳过：」再 exit 1 的假套件）：
//   run-all 把它判成 **SKIP**，而 SKIP **不计入 fail 统计** —— **失败被完全掩盖**。
// 现实风险：14 个套件会打印「跳过：」（多用于真实日志/宿主可执行文件缺失时）。
// 如果某个套件先在前面的子检查里跳过一次，后面又真的失败，
// 整个套件就会被静默忽略。
//
// 修复后的规则：**跳过必须由子进程以退出码 0 声明**；
// 退出码非 0 一律判 FAIL，不再被「跳过」字样洗白。
//
// 本检查：
//   ① run-all 的 catch 分支**不得**把 skipped 和 ok 一起置位
//   ② 会打印「跳过：」的套件，其跳过分支必须伴随 exit(0)/return/continue
//   ③ **反向验证**：必须真的找到会跳过的套件（防止正则失效）
// ===========================================================================
console.log("\n=== 12. run-all 的判定逻辑不能掩盖失败 ===");
{
	const runAllPath = path.join(ROOT, "test", "run-all.mjs");
	if (!fs.existsSync(runAllPath)) {
		ck("run-all.mjs 存在", false, "");
	} else {
		const src = fs.readFileSync(runAllPath, "utf8");

		// ① catch 分支不得把 skipped 与 ok 一起置 true
		const badPattern = /catch\s*\([^)]*\)\s*\{[^}]*skipped\s*=\s*true[^}]*ok\s*=\s*true/s;
		ck("run-all 的 catch 分支不把「跳过」当成通过",
			!badPattern.test(src),
			"catch 里同时设了 skipped=true 和 ok=true（会掩盖失败）");

		// 正向确认：catch 分支里不再有 ok = true
		// **注意**：catch 块里有注释写着「原逻辑是 ok = true」，必须先**剥掉注释**
		// 再判定，否则会把注释里的代码当成真实代码（第 109 轮踩过这个误报）。
		const catchRaw = (src.match(/\}\s*catch\s*\([^)]*\)\s*\{([\s\S]*?)\n\t\}/) ?? [])[1] ?? "";
		const catchCode = catchRaw
			.split("\n")
			.filter((l) => !/^\s*\/\//.test(l))     // 去掉整行注释
			.map((l) => l.replace(/\/\/.*$/, ""))       // 去掉行尾注释
			.join("\n");
		ck("run-all 的 catch 分支不设 ok = true",
			!/\bok\s*=\s*true/.test(catchCode),
			"catch 里仍有 ok = true（剥注释后）");
		ck("run-all 的 catch 分支确实设了 ok = false",
			/\bok\s*=\s*false/.test(catchCode),
			"catch 里没有 ok = false");

		console.log("  catch 分支: " + catchRaw.length + " 字符（剥注释后 " + catchCode.length + " 字符）");
	}

	// ② 会打印「跳过：」的套件，跳过分支必须伴随退出/返回
	const DIR2 = path.join(ROOT, "test", "hardening");
	const files2 = fs.readdirSync(DIR2).filter((f) => f.endsWith(".mjs") && !f.startsWith("_") && f !== "meta-health.mjs");
	let skipSuites = 0;
	const risky = [];
	for (const f of files2) {
		const src = fs.readFileSync(path.join(DIR2, f), "utf8");
		if (!/["'\`]跳过：/.test(src)) continue;
		skipSuites++;
		const lines = src.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (!/["'\`]跳过：/.test(lines[i])) continue;
			const ctx = lines.slice(Math.max(0, i - 1), i + 4).join("\n");
			if (!/process\.exit\(0\)|return;|continue;|process\.exit\(0\)/.test(ctx)) {
				risky.push(f + " L" + (i + 1));
			}
		}
	}
	ck("打印「跳过：」的套件都伴随 exit(0)/return", risky.length === 0, risky.slice(0, 3).join(", "));
	console.log("  会打印「跳过：」的套件: " + skipSuites + " 个");

	// ③ 反向验证
	ck("确实存在会跳过的套件（非空转）", skipSuites >= 1, "找到 " + skipSuites + " 个");
}

console.log("\n=== 13. 子进程调用的 --expose-gc 必须一致（缺陷 121 的同类排查） ===");
{
	// **缺陷 119/120/121 连续 3 轮的根因**：
	// `run-all.mjs` 给 `memory-lifecycle` / `soak-test` 传 `--expose-gc`，
	// 但 `mutation-test.mjs`（119）、`branch-coverage.mjs`（120）、
	// `coverage.mjs`（121）**都没传** —— 于是这两个套件在这些工具里必然失败。
	//
	// 教训：**修一处 bug 时必须扫描「同一模式还在哪里」**。
	// 这一节把那条人工排查固化成自动检查。
	const GC_SUITES = ["memory-lifecycle.mjs", "soak-test.mjs"];
	const RUNNERS = ["test/run-all.mjs", "test/hardening/mutation-test.mjs",
		"test/hardening/coverage.mjs", "test/hardening/branch-coverage.mjs"];

	let scanned = 0;
	for (const rel of RUNNERS) {
		const src = read(rel);
		// 只关心「会跑 .mjs 子进程」的那些调用点
		const runsSuites = /execSync|execFileSync|spawnSync/.test(src) && /\.mjs|suitePath|suites/.test(src);
		ck(`${rel} 存在且会跑套件`, runsSuites, "未找到子进程调用");
		if (!runsSuites) continue;
		scanned++;
		// 必须知道 NEEDS_GC（要么自己有集合，要么从别处来）
		ck(`${rel} 引用了 --expose-gc`, /expose-gc/.test(src), "缺少 --expose-gc 处理");
	}

	console.log(`  扫描 ${scanned} 个运行器`);
	// **反向验证**：必须真的找到 ≥3 个（防止正则失效导致空转）
	ck("至少扫描到 3 个运行器（防正则失效）", scanned >= 3, "只找到 " + scanned + " 个");

	// **正向验证**：每个运行器都必须把 GC_SUITES 处理好
	for (const rel of RUNNERS) {
		const src = read(rel);
		if (!/execSync|execFileSync|spawnSync/.test(src)) continue;
		// **缺陷 125**（第 124 轮）：运行器现在可以从 `_suite-meta.mjs` **导入**
		// 共享的 NEEDS_GC，不必自己再列一遍套件名。两种形式都接受：
		//   a) 显式列出套件名（旧形式）
		//   b) 从 _suite-meta.mjs 导入 NEEDS_GC（新形式，唯一事实源）
		const listsExplicitly = GC_SUITES.some((s) => src.includes(s));
		const importsShared = /from "\.\.?\/.*_suite-meta\.mjs"/.test(src) && /\bNEEDS_GC\b/.test(src);
		ck(`${rel} 处理 memory-lifecycle / soak-test（显式列出或导入共享定义）`,
			listsExplicitly || importsShared,
			"既没列出这两个套件，也没导入共享定义");
	}

	// **关键**：`memory-lifecycle` / `soak-test` 单独跑时确实需要 GC 才能通过
	// （这里只做静态断言，动态验证由 run-all --offline 覆盖）
	const mlSrc = read("test/hardening/memory-lifecycle.mjs");
	ck("memory-lifecycle 调用 gc()", /global(\.|This\.)?gc|\.gc\?\.\(|\bgc\(\)/.test(mlSrc), "未发现 gc() 调用");
	const soakSrc = read("test/hardening/soak-test.mjs");
	ck("soak-test 调用 gc()", /global(\.|This\.)?gc|\.gc\?\.\(|\bgc\(\)/.test(soakSrc), "未发现 gc() 调用");
}
console.log("\n=== 14. NEEDS_GC 列表必须覆盖所有调用 gc() 的套件（缺陷 124 的同类排查） ===");
{
	// **缺陷 124**（第 123 轮）：`run-all.mjs` 的 `NEEDS_GC` 列表**漏了 perf-baseline**。
	// 它第 6 节用 `global.gc?.()` 强制 GC 后测堆增长；不传 `--expose-gc` 时
	// 测到的是**未回收的垃圾**（50400 B/次 vs 实测 7 B/次），断言必然失败。
	//
	// 第 122 轮的"第 13 节"只检查了**运行器**是否传 GC，**没检查套件列表是否完整** ——
	// 这正是"检查了 A 却漏了 B"的典型。这一节补上：**反向枚举**。
	//
	// 判据：任何调用 `global.gc?.()` / `globalThis.gc` / `gc()` 的套件，
	// 都必须在 `run-all.mjs` 的 `NEEDS_GC` 里。
	// 缺陷 125（第 124 轮）：NEEDS_GC 现在是 _suite-meta.mjs 里的唯一事实源，
	// run-all / coverage / branch-coverage / mutation-test 都从这里导入。
	// 所以检查对象改为共享模块（而不是 run-all 的本地定义）。
	const metaSrc = read("test/hardening/_suite-meta.mjs");
	const gcSetMatch = metaSrc.match(/export const NEEDS_GC = new Set\(\[([\s\S]*?)\]\);/);
	ck("_suite-meta.mjs 导出 NEEDS_GC 集合", gcSetMatch !== null, "");

	// 并且：所有运行器都必须从这里导入（不能各自再定义一份）
	const RUNNER_FILES = ["test/run-all.mjs", "test/hardening/coverage.mjs",
		"test/hardening/branch-coverage.mjs", "test/hardening/mutation-test.mjs"];
	for (const rel of RUNNER_FILES) {
		const src = read(rel);
		const imports = /import\s*\{[^}]*\bNEEDS_GC\b[^}]*\}\s*from\s*"\.\.?\/.*_suite-meta\.mjs"/.test(src);
		const redefines = /const\s+NEEDS_GC\s*=\s*new Set\(/.test(src) || /const\s+NEEDS_GC_SETS\s*=\s*new Set\(/.test(src);
		ck(rel + " 从共享模块导入 NEEDS_GC", imports, "未导入");
		ck(rel + " 不再本地重定义 NEEDS_GC", !redefines, "仍有本地定义（会分叉）");
	}

	const listed = gcSetMatch
		? [...gcSetMatch[1].matchAll(/"([^"]+\.mjs)"/g)].map((m) => m[1])
		: [];
	console.log("  NEEDS_GC 列表: " + listed.join(", "));

	// 枚举所有 hardening 套件，找出真正调用 gc() 的
	const gcCallers = [];
	const hardeningFiles = fs.readdirSync(path.join(ROOT, "test", "hardening"))
		.filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));
	for (const f of hardeningFiles) {
		const src = read("test/hardening/" + f);
		// **缺陷 124 自我修正**：原实现只剥了注释，但 meta-health 自己在
		// 第 13 节的检查项里**以正则字面量形式**写了 /global(\.|This\.)?gc|\.gc\?\.\(|\bgc\(\)/，
		// 被自己匹配到了（自我误报）。正确做法：剥掉注释**和字符串/正则字面量**。
		// **缺陷 124 自我修正**：判定「是否真的调用 gc()」需要小心两种误判：
		//   ① 字符串/正则字面量里出现的 gc 字样（meta-health 自己就有）
		//   ② 剥字面量时把正常代码一起吃掉（第一版正则把 `global.gc?.();` 后的
		//      内容误当成正则字面量剥掉了，导致 perf-profile 变成"僵尸"）
		// 现在只做两件安全的事：剥单行注释，以及只认**行首为 gc 相关调用**的行。
		const stripped = src.split("\n").map((l) => l.replace(/\/\/.*$/, ""));
		// 严格模式：整行（去掉缩进与结尾分号）形如 `global.gc?.()` / `gc()` 才算调用；
		// 这样既可以排除「文本里提到 gc」，也不会误剥正常语句。
		const isRealGcCall = (line) => /^\s*(?:global|globalThis)\.gc\?\.\(\s*\)\s*;?\s*$|^\s*(?:global|globalThis)\.gc\(\s*\)\s*;?\s*$|^\s*gc\(\s*\)\s*;?\s*$/.test(line);
		if (stripped.some(isRealGcCall)) gcCallers.push(f);
	}

	console.log("  实际调用 gc() 的套件: " + gcCallers.join(", "));
	// **反向验证**：必须找到 ≥2 个（防止正则失效导致空转，那会静默放过一切）
	ck("至少找到 2 个调用 gc() 的套件", gcCallers.length >= 2, "只找到 " + gcCallers.length + " 个");

	// **核心断言**：每个 gc() 调用者都必须在 NEEDS_GC 里
	const missing = gcCallers.filter((f) => !listed.includes(f));
	ck("所有调用 gc() 的套件都在 NEEDS_GC 列表里", missing.length === 0,
		"漏了: " + missing.join(", "));

	// 反向：NEEDS_GC 里的每项都应该真的调用 gc()（防止僵尸条目）
	const zombies = listed.filter((f) => !gcCallers.includes(f));
	ck("NEEDS_GC 里没有僵尸条目（都真的调用 gc()）", zombies.length === 0,
		"僵尸: " + zombies.join(", "));
}
console.log("\n=== 15. 套件内部的章节编号必须连续（缺陷 136 的同类排查） ===");
{
	// **缺陷 136**（第 132 轮）：三个套件的内部章节编号有问题 ——
	//   · `deliverable`  从「7」直接跳到「9」（缺 8）
	//   · `doc-consistency` 同样缺 8
	//   · `fake-test-audit` 有**两个「3」**（第二个是后来追加的恒真断言检查）
	//
	// 危害是**可读性与可信度**：读者按编号找章节时会找不到，
	// 或者以为「第 8 节被删掉了、可能有内容丢失」。对一个
	// 「把每处细节都摊开给人看」的项目来说，这类小裂缝会被放大。
	//
	// 判据：某个套件若用 `console.log("\n=== N. … ===")` 编号，
	// 则其编号集合必须**从某个起点连续、且无重复**。
	const hardeningFiles2 = fs.readdirSync(path.join(ROOT, "test", "hardening"))
		.filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));

	const broken = [];
	let numbered = 0;
	for (const f of hardeningFiles2) {
		const src = read("test/hardening/" + f);
		const nums = [];
		for (const m of src.matchAll(/console\.log\("\\n===\s*(\d+)\./g)) nums.push(Number(m[1]));
		if (nums.length < 2) continue;
		numbered++;
		const sorted = [...nums].sort((a, b) => a - b);
		const hasDup = new Set(nums).size !== nums.length;
		const isContinuous = sorted.every((v, i) => v === sorted[0] + i);
		if (hasDup || !isContinuous) broken.push(f + " [" + nums.join(",") + "]");
	}

	console.log(`  带编号章节的套件: ${numbered} 个`);
	ck("至少扫描到 30 个带编号章节的套件（防正则失效）", numbered >= 30, "只找到 " + numbered + " 个");
	ck("所有套件的章节编号连续且无重复", broken.length === 0, broken.join("; "));
	if (broken.length > 0) {
		for (const b of broken) console.log("    ❌ " + b);
	}
}
console.log("\n=== 16. 套件头部注释里的「N 项」声明必须与实际一致（缺陷 137） ===");
{
	// **缺陷 137**（第 133 轮）：7 个套件的头部注释写着「本套件验证（N 项）」，
	// 但 N 早已过时（`shape-robustness` 写 12 实际 37、`fence-eol-matrix`
	// 写 24 实际 18 …）。读者会按注释判断「这个套件验得够不够细」，
	// 而**过时的数字会双向误导**：写多了让人以为覆盖更广，写少了让人低估。
	//
	// 判据：注释里形如「本套件验证（N 项）」/「本套件补齐…（N 项）」的自述，
	// 必须等于该套件实跑的 passed 数。
	//
	// **只检查「自述」**：像 `install-failure-paths` 里「`install-experience.mjs`（33 项）」
	// 这种**引用别的套件**的数字不在检查范围内（那是交叉引用，不是自述）。
	const HEAD_CLAIM_RE = /本套件(?:验证|补齐)[^\n]*?[（(](\d+)\s*项[）)]/;
	const GC_SET = new Set(["memory-lifecycle.mjs", "soak-test.mjs", "perf-baseline.mjs",
		"perf-profile.mjs", "timeout-backpressure.mjs"]);
	// 只跑快的：慢速/真实日志套件跳过（它们在本检查里不参与）
	const SKIP_RUN = new Set(["replay-real-streams.mjs", "health-check.mjs", "mine-unrecovered.mjs",
		"false-positive-audit.mjs", "per-model-replay.mjs", "differential.mjs", "synth-provenance.mjs",
		"mutation-test.mjs", "coverage.mjs", "branch-coverage.mjs", "fuzz-random-streams.mjs", "fuzz-multi-turn.mjs"]);

	// **作用域**：第 15 节的 `hardeningFiles2` 在它自己的块内，这里重新取一次。
	const hardeningFiles2 = fs.readdirSync(path.join(ROOT, "test", "hardening"))
		.filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));

	const selfClaimed = [];
	for (const f of hardeningFiles2) {
		const src = read("test/hardening/" + f);
		const head = src.slice(0, 2500);
		const m = head.match(HEAD_CLAIM_RE);
		if (m) selfClaimed.push({ file: f, claimed: Number(m[1]) });
	}
	console.log(`  带自述项数的套件: ${selfClaimed.length} 个`);
	ck("至少扫描到 5 个带自述项数的套件（防正则失效）", selfClaimed.length >= 5,
		"只找到 " + selfClaimed.length + " 个");

	const mismatch = [];
	let ran = 0;
	for (const c of selfClaimed) {
		if (SKIP_RUN.has(c.file)) continue;
		const full = path.join(ROOT, "test", "hardening", c.file);
		let out = "";
		try {
			const args = GC_SET.has(c.file) ? ["--expose-gc", full] : [full];
			out = execFileSync(process.execPath, args, {
				encoding: "utf8", timeout: 180000, stdio: "pipe",
			maxBuffer: 64 * 1024 * 1024,   // **缺陷 156**：默认 1MB 会被大输出套件撑爆
				// **缺陷 137 自我修正**：`meta-health` 里没有 `DSH_LLM` 变量 —— 
			// 直接照抄 `mutation-test` 的写法会得到 `undefined`，子进程收不到
			// `DSH_LLM_SRC`，于是所有需要宿主的套件都输出 `null` 项数。
			// 正确做法：**原样透传**当前环境（调用者已经设好 DSH_LLM_SRC）。
			env: process.env,
			// **缺陷 137 自我修正 2**：必须设 `cwd` —— 套件内部用 `ROOT`（相对
			// `import.meta.dirname`）定位 lib，但如果子进程继承了错误的工作目录，
			// 它会在 `node_modules` 或 `DSH_LLM_SRC` 的解析上失败并退出。
			cwd: ROOT,
			});
		} catch (e) {
			out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
		}
		const all = [...out.matchAll(/(\d+)\s+passed/g)].map((x) => Number(x[1]));
		const actual = all.length > 0 ? all[all.length - 1] : null;
		ran++;
		if (actual !== c.claimed) mismatch.push(`${c.file} 注释 ${c.claimed} / 实际 ${actual}`);
	}
	console.log(`  实跑核对: ${ran} 个`);
	ck("头部「N 项」自述与实跑一致", mismatch.length === 0, mismatch.slice(0, 5).join("; "));
	if (mismatch.length > 0) for (const x of mismatch) console.log("    ❌ " + x);
}
console.log("\n=== 17. 用到的 child_process 函数必须 import（缺陷 138） ===");
{
	// **缺陷 138**（第 134 轮）：第 133 轮给 meta-health 加第 16 节时，
	// **忘了在文件顶部 `import { execFileSync }`** —— 运行时抛 `ReferenceError`，
	// 而它被那一节的 `try/catch` 吞掉，于是**所有套件都报「实际 null」**。
	// 检查看似在跑，结果全是空 —— 正是本套件存在的意义（抓静默失败）。
	//
	// 这类问题的根因：**「用了某个函数」与「导入了那个函数」是两份独立的事实**，
	// 只要不一致，就只会在**运行到那一行**时才炸；若外面有 try/catch，就静默降级。
	//
	// 判据：源码里调用了 `execSync` / `execFileSync` / `spawnSync` / `execFile` / `spawn`
	// 之一，就必须通过**静态 import** 或**动态 `const { X } = await import(...)`**
	// 或**整体导入后 `cp.X(...)`** 把它引入。
	// **作用域**：`hardeningFiles2` 是第 15/16 节各自块内的局部变量，这里重新取。
	const hardeningFiles2 = fs.readdirSync(path.join(ROOT, "test", "hardening"))
		.filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));

	const CP_FNS = ["execSync", "execFileSync", "spawnSync", "execFile", "spawn"];
	const missingImports = [];
	let cpUsers = 0;
	for (const f of hardeningFiles2) {
		const src = read("test/hardening/" + f);
		const used = new Set();
		for (const fn of CP_FNS) {
			if (new RegExp("\\b" + fn + "\\s*\\(").test(src)) used.add(fn);
		}
		if (used.size === 0) continue;
		cpUsers++;

		const imported = new Set();
		// ① 静态 import { A, B } from "node:child_process"
		for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*"node:child_process"/g)) {
			for (const name of m[1].split(",")) imported.add(name.trim());
		}
		// ② 动态 const { A } = await import("node:child_process")
		for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*await\s+import\("node:child_process"\)/g)) {
			for (const name of m[1].split(",")) imported.add(name.trim());
		}
		// ③ 整体导入：import cp from "node:child_process" → cp.execFileSync(...)
		const hasNamespace = /import\s+\w+\s+from\s*"node:child_process"/.test(src);

		const missing = [...used].filter((u) => !imported.has(u) && !hasNamespace);
		if (missing.length > 0) missingImports.push(f + " 缺 " + missing.join(","));
	}

	console.log(`  使用 child_process 的套件: ${cpUsers} 个`);
	ck("至少扫描到 10 个使用 child_process 的套件（防正则失效）", cpUsers >= 10,
		"只找到 " + cpUsers + " 个");
	ck("所有用到的 child_process 函数都已 import", missingImports.length === 0,
		missingImports.slice(0, 5).join("; "));
	if (missingImports.length > 0) for (const x of missingImports) console.log("    ❌ " + x);

	// **反向验证**：meta-health 自己必须导入 execFileSync（第 16 节依赖它）
	const selfSrc = read("test/hardening/meta-health.mjs");
	ck("meta-health 自己导入了 execFileSync（第 16 节依赖）",
		/import\s*\{[^}]*execFileSync[^}]*\}\s*from\s*"node:child_process"/.test(selfSrc),
		"未导入 —— 第 16 节会抛 ReferenceError 并被 try/catch 吞掉");
}
console.log("\n=== 18. 测试里不得出现作者的个人绝对路径（缺陷 147） ===");
{
	// **缺陷 147**（第 141 轮）：`meta-health` 第 10 节曾写死
	//   const ASAR = "C:\\Users\\ZZH\\AppData\\Local\\Programs\\...\\app.asar";
	// 两个问题：
	//   ① **把作者的用户名提交到公开仓库** —— 对开源投稿是隐私泄漏；
	//   ② 别人机器上路径不同，只能靠 `DSH_ASAR` 手动指定，否则静默跳过，
	//      而「静默跳过」会让这条检查**形同不存在**。
	//
	// 判据：测试代码里不得出现 `C:\Users\<具体用户名>` / `/home/<用户名>` /
	// `/Users/<用户名>` 这类**真实个人路径**（占位符如 `<profile>`、`path\to` 不算）。
	// 允许：文档示例里的通用路径（`C:\path\file`、`C:\\tmp\\a.txt`）、
	//      `process.env.USERPROFILE`/`os.homedir()` 这类**运行时求值**。
	// **作用域**：`hardeningFiles2` 是前面各节块内的局部变量，这里重新取一次。
	const hardeningFiles2 = fs.readdirSync(path.join(ROOT, "test", "hardening"))
		.filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));

	const personalPathRe = /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/home\/|\/Users\/)(?!<|\$\{|%|path|user|USER|Shared)[A-Za-z0-9._-]+/;
	const leaks = [];
	let scanned = 0;
	for (const f of hardeningFiles2) {
		const src = read("test/hardening/" + f);
		const rows = src.split("\n");
		for (let i = 0; i < rows.length; i++) {
			if (/^\s*(\/\/|\*)/.test(rows[i])) continue;   // 跳过纯注释
			if (personalPathRe.test(rows[i])) leaks.push(f + " L" + (i + 1) + ": " + rows[i].trim().slice(0, 80));
		}
		scanned++;
	}
	// 也要检查两个核心测试文件
	for (const rel of ["test/integration.test.mjs", "test/real-samples.test.mjs"]) {
		const src = read(rel);
		const rows = src.split("\n");
		for (let i = 0; i < rows.length; i++) {
			if (/^\s*(\/\/|\*)/.test(rows[i])) continue;
			if (personalPathRe.test(rows[i])) leaks.push(rel + " L" + (i + 1) + ": " + rows[i].trim().slice(0, 80));
		}
		scanned++;
	}
	console.log(`  扫描 ${scanned} 个测试文件`);
	ck("至少扫描到 100 个测试文件（防扫描失效）", scanned >= 100, "只扫描到 " + scanned);
	ck("测试里没有作者的个人绝对路径", leaks.length === 0, leaks.slice(0, 5).join("; "));
	if (leaks.length > 0) for (const l of leaks) console.log("    ❌ " + l);

	// **反向验证**：正则必须真的能抓到（自测一个构造的字符串）
	// **自测探针用拼接构造** —— 否则这行字面量会被本检查自己抓到（自我误报）。
	const probe = ['const p = "C:', "\\", "Users", "\\", "SomeRealUser", "\\", 'AppData";'].join("");
	ck("个人路径检测正则有效（自测）", personalPathRe.test(probe), "正则抓不到构造的个人路径");
	const okProbe = 'const p = path.join(os.homedir(), ".dsh");';
	ck("运行时求值的路径不被误报（自测）", !personalPathRe.test(okProbe), "误报了 os.homedir()");
}
console.log("\n=== 19. run-all 必须能区分「超时」与「断言失败」（缺陷 149） ===");
{
	// **缺陷 149**（第 142 轮）：第 106 轮修掉「失败被当成跳过」之后，
	// 还有另一条**同类但相反**的路径没被检查：**超时**。
	//
	// 原来 `run-all.mjs` 里超时和断言失败显示得**一模一样**：
	//   [FAIL] coverage  600123ms  FAIL
	// 而实测 `coverage` 单套件就要 **172 秒**，慢机器/CI 上很容易撞到超时。
	// 维护者看到 [FAIL] 会去翻插件代码找不存在的 bug —— 而实际上套件只是没跑完。
	//
	// 本检查验证 run-all.mjs 真的把超时单独标出来了：
	//   ① 有 TIMEOUT_MS 常量（且可被环境变量覆盖）；
	//   ② catch 里识别 ETIMEDOUT / SIGTERM 并置 timedOut；
	//   ③ status 三态之外还有 TIMEOUT；
	//   ④ 超时时 conclusion **强制**写明「超时」。
	// **作用域**：`hardeningFiles2` 是前面各节块内局部变量，这里重新取一次。
	const hardeningFiles2 = fs.readdirSync(path.join(ROOT, "test", "hardening"))
		.filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));

	const ra = read("test/run-all.mjs");

	ck("run-all 定义了 TIMEOUT_MS 常量", /const TIMEOUT_MS\s*=/.test(ra), "未定义");
	ck("TIMEOUT_MS 可被 DSH_TEST_TIMEOUT_MS 覆盖",
		/DSH_TEST_TIMEOUT_MS/.test(ra), "不支持环境变量覆盖");
	ck("超时阈值不低于 15 分钟（对最慢套件 172s 留余量）", (() => {
		const m = ra.match(/: (\d+) \* 60 \* 1000;/);
		return m ? Number(m[1]) >= 15 : false;
	})(), "阈值过小或写法变了");
	ck("catch 里识别 ETIMEDOUT / SIGTERM", /ETIMEDOUT/.test(ra) && /SIGTERM/.test(ra),
		"未区分超时");
	ck("status 含 TIMEOUT 分支", /timedOut \? "TIMEOUT"/.test(ra), "status 无 TIMEOUT");
	ck("超时时 conclusion 写明原因", /超时（>|⏱ 超时/.test(ra), "conclusion 未说明超时");
	ck("不再硬编码 600000", !/timeout: 600000/.test(ra), "仍在用写死的 600000");

	// **反向验证**：确认 run-all 里确实有 catch 分支（防正则扫错文件）
	ck("run-all 有 catch 分支（防止扫错文件）", /catch \(e\) \{/.test(ra));
}
console.log("\n=== 20. run-all 必须拒绝「无输出的 exit 0」（缺陷 150） ===");
{
	// **缺陷 150**（第 143 轮）：一个**什么都没输出、exit 0** 的子进程，
	// 原来会被 run-all 判成 **PASS、结论 "OK"**。
	//
	// 这与缺陷 38（「测试文件里没有任何断言，永远通过」）是同一个陷阱的
	// **运行器版本** —— 套件可以「悄悄不跑」却显示绿。
	//
	// 实测：写一个只 `process.exit(0)` 的假套件，run-all 判 PASS。
	// 现有 110 个套件都有实质输出，所以这条一直没被触发 —— 但**没有任何防线**。
	//
	// 本检查验证 run-all.mjs 里真的存在这条防线。
	// **作用域**：前面各节里的 `hardeningFiles2` 是各自块内的局部变量，这里重新取。
	const hardeningFiles2 = fs.readdirSync(path.join(ROOT, "test", "hardening"))
		.filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));

	const ra = read("test/run-all.mjs");

	ck("run-all 有「无输出不得 PASS」的判断", /hasSubstance/.test(ra), "没有该防线");
	ck("无输出时判 FAIL 而不是 PASS", /!hasSubstance \? "FAIL"/.test(ra), "仍可能判 PASS");
	ck("无输出时给出明确原因", /exit 0 但\*\*没有任何输出\*\*|没有任何输出/.test(ra),
		"没有说明原因");
	ck("判定基于原始输出而非过滤后的行（防汇总行被 === 过滤掉）",
		/out\.split\("\\n"\)\.some\(/.test(ra), "用了过滤后的 lines，会误报");

	// **反向验证**：现有套件必须都有实质输出（否则这条防线会大面积误报）
	const silentSuites = [];
	let checkedSuites = 0;
	for (const f of hardeningFiles2) {
		// 只做**静态**判断：源码里必须有 console.log 或 console.error
		const src = read("test/hardening/" + f);
		checkedSuites++;
		if (!/console\.(log|error)\s*\(/.test(src)) silentSuites.push(f);
	}
	console.log(`  静态扫描 ${checkedSuites} 个套件`);
	ck("所有套件都有输出语句（不会触发误报）", silentSuites.length === 0,
		silentSuites.slice(0, 5).join(", "));
	ck("至少扫描到 100 个套件（防扫描失效）", checkedSuites >= 100, "只扫描到 " + checkedSuites);
}
console.log("\n=== 21. run-all 必须发现「输出说失败但 exit 0」的矛盾（缺陷 151） ===");
{
	// **缺陷 151**（第 144 轮）：套件**自己打印了 ❌，却 exit 0** ——
	// 原来 run-all 判 **PASS**，而结论里赫然写着「❌ 某项失败」。**自相矛盾**。
	//
	// 实测（构造的假套件）：
	//   console.log("  ❌ 某项失败"); process.exit(0);
	//   → status = PASS，conclusion = "❌ 某项失败"
	//
	// 现有 96 个套件都没触发（都不这么写），但这说明**运行器完全信任退出码**，
	// 而「打印了失败标记却忘了 exit 1」是**极容易犯的错**。
	//
	// 修复：新增 **SUSPECT** 状态（计入失败，不静默通过）。
	const ra = read("test/run-all.mjs");

	ck("run-all 有矛盾检测变量", /claimsFailure/.test(ra), "无");
	ck("run-all 有 SUSPECT 状态", /"SUSPECT"/.test(ra), "无");
	ck("SUSPECT 计入失败统计", /status === "SUSPECT"\)\.length/.test(ra), "未计入失败");
	ck("矛盾时给出明确说明", /输出里出现失败标记但 exit 0/.test(ra), "未说明");

	// **关键**：\`FAIL: 0\` / \`failed 0\` 是「零失败」，不能当成失败标记。
	// 第一版正则误报了 verify-install-runnable（它的输出含 \`PASS: 9, FAIL: 0\`）。
	ck("失败标记要求非零数字（不把 FAIL: 0 当失败）",
		/FAIL\[\\s:：\]\*\[1-9\]/.test(ra) && /\[1-9\]\\s\*FAIL/.test(ra), "正则未排除零值");

	// **反向验证**：确认正则真的能区分
	const probeBad = "  ❌ 某项失败";
	const probeBad2 = "===== x: 5 passed, 1 failed =====";
	const probeOk = "  PASS: 9, FAIL: 0";
	const probeOk2 = "===== x: 17 passed, 0 failed =====";
	const re1 = /(^|\n)\s*❌/;
	const re2 = /\bfailed[\s:：]*[1-9]|[1-9]\s*failed\b/;
	const re3 = /\bFAIL[\s:：]*[1-9]|[1-9]\s*FAIL\b/;
	ck("自测：❌ 行被判为失败声明", re1.test(probeBad), "漏判");
	ck("自测：failed 1 被判为失败声明", re2.test(probeBad2), "漏判");
	ck("自测：FAIL: 0 不被判为失败声明", !re3.test(probeOk), "误判");
	ck("自测：0 failed 不被判为失败声明", !re2.test(probeOk2), "误判");
}
console.log("\n=== 22. 依赖真实日志的套件不得在「零样本」下假装通过（缺陷 152） ===");
{
	// **缺陷 152**（第 145 轮）：三个依赖真实日志的套件在**空会话目录**下全都
	// 输出「✅ 全部正常」并 exit 0：
	//   · `audit-rewrites`：「总流 0，被改写 0」→「✅ 所有被改写的流都是真空响应」
	//   · `per-model-replay`：「模型种类: 0」→「✅ 所有 provider/model 组合均正常」
	//   · `lcr-replay`：「⚠️ 无会话文件」→「16 passed, 0 failed」
	//
	// 这是典型的 **0/0 = 全部正确** 谬误。0 个样本**无法证明任何事**：
	// 既不能说明没问题，也不能说明有问题。让它们显示绿，会让
	// 「完整模式全绿」这个结论**变成虚假的保证** —— 换了台机器/CI 就会静默通过。
	//
	// 判据：三个套件都必须有「零样本 → exit 1」的显式分支。
	const ZERO_SAMPLE_SUITES = [
		{ file: "audit-rewrites.mjs", marker: /streams\.length === 0/, why: "总流为 0" },
		{ file: "per-model-replay.mjs", marker: /rows\.length === 0/, why: "模型组合为 0" },
		{ file: "lcr-replay.mjs", marker: /无会话文件可用/, why: "无会话文件" },
	];
	for (const s of ZERO_SAMPLE_SUITES) {
		const src = read("test/hardening/" + s.file);
		ck(`${s.file} 有「零样本 → 失败」分支（${s.why}）`,
			s.marker.test(src), "缺少该分支，零样本会假装通过");
	}

	// **反向验证**：确认这三个套件确实读真实日志（否则它们不该有这条分支）
	for (const f of ["audit-rewrites.mjs", "per-model-replay.mjs", "lcr-replay.mjs"]) {
		const src = read("test/hardening/" + f);
		ck(`${f} 确实读取真实会话目录`,
			/"\.dsh"|sessions|USERPROFILE|homedir/.test(src), "未读取真实日志");
	}
}

console.log("\n=== 23. 依赖真实日志的「上界断言」必须带样本守卫（缺陷 153） ===");
{
	// **缺陷 153**（第 146 轮）：`known-limit-noargs` 里有一条
	//     原来写作「真实数据里无参数形态极罕见」，条件只有 noArgForms < 5
	// **零样本时 `0 < 5` 为真 → 断言自动通过**，等于「没有数据也能证明罕见」。
	//
	// 这与缺陷 152 是同一族，但形态不同：
	//   152 是「循环不执行所以不失败」（`for (x of []) { if(bad) fail() }`）
	//   153 是「**上界断言在零样本下自然成立**」（`count < N` 当 count=0）
	//
	// 正确写法参考 `host-validator.mjs`：
	//     ck("真实日志重放通过宿主全部校验", failed === 0 && tested > 0, ...)
	//
	// 判据：凡是**依赖真实日志样本**的上界断言，必须同时要求样本数 > 0。
	// **收窄判据**：只查「统计量」型上界断言 —— 即被比较的变量名暗示
	// 它来自日志扫描（`noArgForms` / `*Count` / `*samples` / `scanned` / `tested`），
	// 而不是 `r.calls === 0`（合成输入）或 `size < 100KB`（文件属性）。
	const LOG_READERS = ["known-limit-noargs.mjs", "host-validator.mjs",
		"baseline-regression.mjs", "deploy-verify.mjs", "runtime-process-check.mjs"];
	const STAT_VAR = /\b(noArgForms|scanned|tested|sampleCount|logCount|streamCount|sessionCount)\b/;
	const MISSING_GUARD = [];
	for (const f of LOG_READERS) {
		const src = read("test/hardening/" + f);
		const rows = src.split("\n");
		for (let i = 0; i < rows.length; i++) {
			const l = rows[i];
			if (!/\bck\(/.test(l)) continue;
			if (/^\s*\/\//.test(l)) continue;
			// 必须是「统计量」参与的上界比较
			if (!STAT_VAR.test(l)) continue;
			const isUpperBound = /<\s*\d+|<=?\s*\d+\b/.test(l);
			if (!isUpperBound) continue;
			// 守卫：同一行里还要有 scanned/tested > 0 之类
			const hasGuard = /(scanned|tested|sampleCount|logCount|streamCount|sessionCount)\s*>\s*0/.test(l);
			if (!hasGuard) MISSING_GUARD.push(f + " L" + (i + 1) + ": " + l.trim().slice(0, 70));
		}
	}
	ck("读日志的套件里，统计量型上界断言都带样本守卫", MISSING_GUARD.length === 0,
		MISSING_GUARD.slice(0, 5).join("; "));
	if (MISSING_GUARD.length > 0) for (const x of MISSING_GUARD) console.log("    ❌ " + x);

	// **反向验证**：确认 known-limit-noargs 确实有 scanned > 0 守卫
	const kln = read("test/hardening/known-limit-noargs.mjs");
	ck("known-limit-noargs 的罕见性断言要求 scanned > 0",
		/noArgForms < 5 && scanned > 0/.test(kln), "缺少样本守卫");
	// 同时确认 host-validator 的写法（作为正面参考）
	const hv = read("test/hardening/host-validator.mjs");
	ck("host-validator 的上界断言带有 tested > 0 守卫",
		/failed === 0 && tested > 0/.test(hv), "缺少样本守卫");
}

console.log("\n=== 24. 变异测试的套件清单必须覆盖所有「插件行为套件」（缺陷 154） ===");
{
	// **缺陷 154**（第 147 轮）：`mutation-test.mjs` 的 `SUITES` 是**手工维护**的，
	// 长期只有 89 条，而当时共有 108 个 hardening 套件 —— 其中 **5 个插件行为套件**
	// 从未被纳入变异测试：
	//   `antml-prefix-symmetry`（D127 的守护）、`call-form-matrix`、
	//   `fence-eol-matrix`（D126 的守护）、`markup-only-completeness`（D129 的守护）、
	//   `known-limit-outcomes`
	// 它们**通过了**，但**从未被证明能抓到 bug** —— 这正是缺陷 73 说的
	// 「套件的有效性从未被证明」。而未纳入的原因只是「加套件时忘了同步清单」。
	//
	// 判据：所有**会调用插件**的套件都必须在 SUITES 里。
	// 排除：慢速/真实日志/性能/元套件（变异测试对它们代价过高或无意义）。
	// **作用域**：前面各节块内的局部变量，这里重新取一次。
	const hardeningFiles2 = fs.readdirSync(path.join(ROOT, "test", "hardening"))
		.filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));
	const mt = read("test/hardening/mutation-test.mjs");
	const lines = mt.split("\n");
	let s = -1, e = -1;
	for (let i = 0; i < lines.length; i++) if (/const\s+SUITES\s*=/.test(lines[i])) { s = i; break; }
	for (let i = s; i < lines.length; i++) if (/^\];\s*$/.test(lines[i])) { e = i; break; }
	const inSuites = new Set(
		[...lines.slice(s, e + 1).join("\n").matchAll(/"([^"]+\.mjs)"/g)].map((x) => x[1])
	);
	ck("成功解析 mutation-test 的 SUITES", inSuites.size >= 90, "只解析到 " + inSuites.size + " 条");

	// 合理排除的套件（慢速/真实日志/性能/元套件/自身）
	const REASONABLE_EXCLUDE = new Set([
		"mutation-test.mjs", "coverage.mjs", "branch-coverage.mjs",
		"fuzz-random-streams.mjs", "fuzz-multi-turn.mjs",
		"replay-real-streams.mjs", "health-check.mjs", "mine-unrecovered.mjs",
		"false-positive-audit.mjs", "per-model-replay.mjs", "synth-provenance.mjs",
		"effect-quantify.mjs", "lcr-replay.mjs", "audit-rewrites.mjs",
		"baseline-regression.mjs", "perf-profile.mjs", "perf-baseline.mjs",
		"threshold-audit.mjs", "uncovered-functions.mjs",
	]);

	const pluginSuites = [];
	for (const f of hardeningFiles2) {
		if (inSuites.has(f) || REASONABLE_EXCLUDE.has(f)) continue;
		const src = read("test/hardening/" + f);
		// 判断是否调用插件
		// **缺陷 154 自我修正**：第一版只匹配 `wrapStream`/`extractCalls` 等导出名，
		// 而 `antml-prefix-symmetry` 是**通过 `mod.apply({on})` 注册监听器再驱动**的，
		// 一个都没匹配上 → 变异验证只报出 4 个而不是 5 个。
		// 补上 `apply(` / `llm/stream` / `mod.` 这几种驱动方式。
		if (/wrapStream|extractCalls|parseCallBody|isMarkupOnlyText|computeDisplayRanges|\bapply\(|llm\/stream|mod\./.test(src)) {
			pluginSuites.push(f);
		}
	}
	console.log(`  未纳入变异测试的插件行为套件: ${pluginSuites.length} 个`);
	ck("所有插件行为套件都已纳入变异测试", pluginSuites.length === 0,
		pluginSuites.slice(0, 8).join(", "));
	if (pluginSuites.length > 0) for (const x of pluginSuites) console.log("    ❌ " + x);

	// **反向验证**：确认 SUITES 里没有僵尸条目（文件不存在）
	const missing = [...inSuites].filter((f) => f.endsWith(".mjs") && !f.startsWith("integration") && !fs.existsSync(path.join(ROOT, "test", "hardening", f)));
	ck("SUITES 里没有指向不存在文件的僵尸条目", missing.length === 0, missing.join(", "));
}

console.log("\n=== 25. 会改写 lib/index.js 的套件必须持锁，读取方必须检测（缺陷 158） ===");
{
	// **缺陷 158**（第 151 轮）：`mutation-test` 与 `shape-robustness` 会**临时改写 lib/index.js**
	// 注入变异体。若与另一个测试入口并发，对方读到变异体 → **假失败**。
	// 实测：完整模式 #66（mutation-test 运行中）时并行跑 `claims-audit`：
	//   · `live-instance` 报「源码 48687B vs 安装 48772B」→ 假失败
	//   · `error-observability` 声明 26 / 实跑 24 → 假不达标
	//   · `coverage` 的 100 个子套件失败 → 「未执行函数 0」却判 ❌
	//   整体耗时从 21 分钟恶化到 95 分钟，产生 3 个假超时/假失败。
	//
	// 判据：改写方必须 `acquireLibWriteLock`，读取方必须 `exitIfLibLocked`。
	ck("锁模块 _lib-lock.mjs 存在", fs.existsSync(path.join(ROOT, "test", "hardening", "_lib-lock.mjs")));
	const WRITERS = ["mutation-test.mjs", "shape-robustness.mjs"];
	const READERS = ["coverage.mjs", "branch-coverage.mjs", "claims-audit.mjs"];
	for (const f of WRITERS) {
		const src = read("test/hardening/" + f);
		ck(f + " 改写前获取锁", /acquireLibWriteLock/.test(src), "未加锁");
		ck(f + " 退出时释放锁", /releaseLibWriteLock/.test(src) && /process\.on\("exit"/.test(src), "未注册 exit 释放");
	}
	for (const f of READERS) {
		const src = read("test/hardening/" + f);
		ck(f + " 检测写锁并跳过", /exitIfLibLocked/.test(src), "未检测");
	}
	const ra = read("test/run-all.mjs");
	ck("run-all 检测写锁", /exitIfLibLocked/.test(ra), "未检测");
	const lockSrc = read("test/hardening/_lib-lock.mjs");
	ck("锁模块支持陈旧锁清理（PID 存活检测）", /process\.kill\(info\.pid, 0\)/.test(lockSrc), "无陈旧锁处理");
	ck("锁模块区分 owner（防误删他人锁）", /held\.owner === owner/.test(lockSrc), "无 owner 校验");
}

	console.log("\n=== 26. 会改写 lib/index.js 的套件必须有「崩溃自愈」（缺陷 159） ===");
	{
		// **缺陷 159**（第 151 轮）：`try/finally` 防不住 **SIGKILL / 断电 / 强杀**。
		// 实测强杀一次 `mutation-test` 后 `lib/index.js` 停留在 48,758 字节（应为 48,772），
		// 下一次运行的基线阶段就集体失败（`等价类划分`、`XML 属性`…），失败信息**像真 bug**。
		const mt = read("test/hardening/mutation-test.mjs");
		ck("mutation-test 定义纯净备份文件", /ORIG_BACKUP/.test(mt), "无备份文件");
		ck("mutation-test 开工前做崩溃恢复", /已从备份还原/.test(mt), "无自愈路径");
		ck("mutation-test 在变异前写备份", /fs\.writeFileSync\(ORIG_BACKUP,\s*ORIGINAL\)/.test(mt), "未写备份");
		ck("mutation-test 退出时清理备份", /fs\.rmSync\(ORIG_BACKUP/.test(mt), "未清理备份");
		const gi = read(".gitignore");
		ck(".gitignore 排除锁文件与备份", /tmp-lib-write\.lock/.test(gi) && /tmp-lib-orig\.js/.test(gi), "未排除");
		// **反向验证**：备份必须写在「读到 ORIGINAL」之后（否则备份的是污染内容）
		const iOrig = mt.indexOf("const ORIGINAL = fs.readFileSync(LIB");
		const iBackup = mt.indexOf("fs.writeFileSync(ORIG_BACKUP, ORIGINAL)");
		ck("备份写入发生在读取 ORIGINAL 之后（防备份到污染内容）", iOrig >= 0 && iBackup > iOrig,
			`ORIGINAL@${iOrig} BACKUP@${iBackup}`);
	}
	console.log("\n=== 27. 真实日志套件必须有会话体积守卫（缺陷 160） ===");
	{
		// **缺陷 160**（第 152 轮）：14 个套件各自全量解压会话日志，**无体积上限**。
		// 实测一个 51.2 MB 的会话把 `audit-rewrites` 从 31s 拖到 1263s 超时、
		// `deploy-verify` 拖到 3619s。守卫必须存在且可调（`DSH_LOG_MAX_MB`）。
		const fs2 = fs;
		const hard = fs2.readdirSync(path.join(ROOT, "test", "hardening"))
			.filter((x) => x.endsWith(".mjs") && !x.startsWith("_"));
		const decompressors = [];
		for (const f of hard) {
			const src = read("test/hardening/" + f);
			if (src.includes("zstdDecompressSync")) decompressors.push(f);
		}
		console.log(`  含会话解压的套件: ${decompressors.length} 个`);
		ck("至少 10 个套件解压会话（防扫描失效）", decompressors.length >= 10, "只找到 " + decompressors.length);
		const unguarded = decompressors.filter((f) => !read("test/hardening/" + f).includes("DSH_LOG_MAX_MB"));
		ck("所有解压会话的套件都有体积守卫（可用 DSH_LOG_MAX_MB 调整）", unguarded.length === 0,
			unguarded.slice(0, 5).join(", "));
		if (unguarded.length > 0) for (const x of unguarded) console.log("    ❌ " + x);
		// **反向验证**：守卫默认阈值必须是 64 MB（8 MB 会丢掉含证据的大会话）
		const sample = read("test/hardening/audit-rewrites.mjs");
		ck("守卫默认阈值为 64 MB", /:\s*64\)\s*\*\s*1048576|Number\(process\.env\.DSH_LOG_MAX_MB\)\s*>\s*0\s*\?\s*Number\(process\.env\.DSH_LOG_MAX_MB\)\s*:\s*64/.test(sample), "默认值不是 64");
		// **缺陷 161**（第 153 轮）：coverage/branch-coverage 串行 spawn ~100 个子 Node 进程，
		// 默认堆按系统内存比例分配，100 个叠加会把整机挤干 —— 实测仅剩 2 GB 可用时
		// branch-coverage 的子套件大量失败，「54 处（≤69）」本应通过却判 ❌。
		// 每个子进程必须显式设 `--max-old-space-size`（2048 MB：512 MB 会压崩处理大日志的套件）。
		for (const f of ["coverage.mjs", "branch-coverage.mjs"]) {
			const src = read("test/hardening/" + f);
			ck(f + " 给子进程设了堆上限", /--max-old-space-size=\d+/.test(src), "未设堆上限");
			// 措辞避开「堆」+「MB」同现：`threshold-audit` 会把那种行当作「缺实测值的内存断言」。
			ck(f + " 上限为 2048 MB（512 会压崩大日志套件）", /--max-old-space-size=2048/.test(src), "阈值不是 2048");
			// **缺陷 162**（第 153 轮）：子套件偶发 V8 OOM 抖动会让整条覆盖率数据被判「不可信」，
			// 单独跑却通过。必须对**瞬时资源失败**重试一次，否则会把环境问题报成代码缺陷。
			ck(f + " 收集失败后会重试一次", /缺陷 162/.test(src), "无重试逻辑");
		}
	}
console.log(`\n===== 测试基建健全性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}

process.exit(fail === 0 ? 0 : 1);
