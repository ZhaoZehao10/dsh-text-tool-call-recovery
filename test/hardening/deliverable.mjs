// 交付物完整性审查
//
// 前 40 轮验证了代码、测试、文档、安装、复现脚本，但没有一个套件检查
// **交付清单本身是否完整、正确**：
//   - 用户照着提交指南做，会不会误传不该传的文件？
//   - 指南里说「跑测试」，但用户跑得通吗？
//   - 仓库里有没有 .gitignore 防止误传？
//   - 指南里的关键数字与 README 是否一致？
//
// 本轮实测发现：
//   - 缺少 .gitignore（临时文件/草稿可能被误传）
//   - SUBMIT-GUIDE 让用户"全选上传"，会把 SUBMIT-GUIDE 自己和 PASTE-READY 传上去
//   - SUBMIT-GUIDE 从没提到"提交前跑一遍测试"，也没给出关键数字速查
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import os from "node:os";

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


let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

// ===========================================================================
// 1. .gitignore 存在且覆盖关键项
// ===========================================================================
console.log("=== 1. .gitignore ===");
{
	const giPath = path.join(ROOT, ".gitignore");
	ck(".gitignore 存在", fs.existsSync(giPath), "");
	if (fs.existsSync(giPath)) {
		const gi = fs.readFileSync(giPath, "utf8");
		const rules = gi.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).map((l) => l.trim());
		console.log(`  规则数: ${rules.length}`);

		const MUST = [
			["node_modules", "依赖目录"],
			[".tmp", "临时工作区"],
			["PASTE-READY.zh.md", "提交草稿"],
			["SUBMIT-GUIDE.zh.md", "本地操作指南"],
			["*.log", "日志"],
		];
		for (const [pat, why] of MUST) {
			const hit = rules.some((r) => r === pat || r === pat + "/" || r.replace(/\/$/, "") === pat.replace(/\/$/, ""));
			ck(`.gitignore 覆盖 ${pat}（${why}）`, hit, "");
			console.log(`  ${pat}（${why}）: ${hit ? "✅" : "❌"}`);
		}
		// 不能把核心文件忽略掉
		const libIgnored = rules.some((r) => r === "lib" || r === "lib/" || r === "*.js");
		ck(".gitignore 不忽略 lib/（核心源码）", !libIgnored, "");
	}
}

// ===========================================================================
// 2. 会被误传的文件清单
// ===========================================================================
console.log("\n=== 2. 会被误传的文件 ===");
{
	// 这些文件如果被上传，会泄露本地信息或造成困惑
	const RISKY = [
		["SUBMIT-GUIDE.zh.md", "本地操作指南（含路径与流程）"],
		["PASTE-READY.zh.md", "提交草稿（含未替换占位符）"],
	];
	for (const [f, why] of RISKY) {
		const p = path.join(ROOT, f);
		if (!fs.existsSync(p)) { console.log(`  ${f}: 不存在`); continue; }
		const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
		const ignored = gi.split("\n").some((l) => l.trim() === f);
		ck(`${f} 已被 .gitignore 排除（${why}）`, ignored, "");
		console.log(`  ${f}: ${ignored ? "✅ 已排除" : "❌ 未被排除"}（${why}）`);
	}
}

// ===========================================================================
// 3. SUBMIT-GUIDE 完整性
// ===========================================================================
console.log("\n=== 3. SUBMIT-GUIDE 完整性 ===");
{
	const p = path.join(ROOT, "SUBMIT-GUIDE.zh.md");
	ck("SUBMIT-GUIDE 存在", fs.existsSync(p));
	if (fs.existsSync(p)) {
		const sg = fs.readFileSync(p, "utf8");
		const CHECKS = [
			["提到跑测试", /run-all\.mjs/, "让用户在提交前验证"],
			["提到 --quick --offline", /--quick[\s\S]{0,20}--offline/, "给出最快的验证方式"],
			// **注意方向**：文档里的写法往往是「千万不要传这两个：A、B」——
			// 警告在**前**、文件名在**后**。所以两个方向都要匹配。
			["提到不要上传 SUBMIT-GUIDE", /(不要传|不上传|千万别传)[\s\S]{0,200}SUBMIT-GUIDE|SUBMIT-GUIDE[\s\S]{0,80}(不要传|不上传|千万别)/, "防止误传"],
			["提到不要上传 PASTE-READY", /(不要传|不上传|千万别传)[\s\S]{0,200}PASTE-READY|PASTE-READY[\s\S]{0,80}(不要传|不上传|千万别)/, "防止误传"],
			["列出要上传的文件", /lib\/[\s\S]{0,200}test\//, "明确的提交清单"],
			["提到 .gitignore", /\.gitignore/, ""],
			// **不要硬编码层数**：从 README 动态读取，
			// 再检查 SUBMIT-GUIDE 是否提到同一个数（层数会随迭代变化）
			["给出关键数字（层数）", (() => {
				const readmeSrc = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
				const CN = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
				const m = readmeSrc.match(/\*\*([零一二三四五六七八九十百]+)层测试\*\*/);
				if (!m) return /\d+\s*层/;
				const s = m[1];
				// **缺陷 111**（第 112 轮）：原实现只支持「X十Y」，遇到「一百」会得到 NaN，
				// 于是生成 /NaN\s*层/ 这个永远匹配不上的正则，断言必然失败。
				const toNum = (str) => {
					if (!str) return NaN;
					if (str.includes("百")) {
						const [b, a] = str.split("百");
						const hundreds = (b ? CN[b] : 1) * 100;
						if (!a) return hundreds;
						const rest = a.replace(/^零/, "");
						if (rest.includes("十")) {
							const [tt, oo] = rest.split("十");
							return hundreds + (tt ? CN[tt] : 1) * 10 + (oo ? CN[oo] : 0);
						}
						return hundreds + (CN[rest] ?? 0);
					}
					if (str.includes("十")) {
						const parts = str.split("十");
						return (parts[0] ? CN[parts[0]] : 1) * 10 + (parts[1] ? CN[parts[1]] : 0);
					}
					return CN[str] ?? NaN;
				};
				const n = toNum(s);
				if (!Number.isFinite(n)) return /NEVER_MATCH_SUCH_THING/;
				// **缺陷 111**：`\b` 在 `**100 层` 里不成立（`*` 是非单词字符，`1` 是单词字符，`\b` 位置在 `*|1` 处确实成立...）。
				// 实测问题是 SUBMIT-GUIDE 里写的是 `**100 层测试全通过**`，`\b100\s*层` 应该能匹配。
				// 改用更宽松的「数字 + 空格 + 层」并且前后不能是数字。
				return new RegExp("(?<!\\d)" + n + "\\s*层(?!\\d)");
			})(), "用户心里有数"],
			// **不要硬编码数字**：从 README 动态读取实际缺陷数，
			// 再检查 SUBMIT-GUIDE 是否提到同一个数（缺陷数会随迭代变化）
			["给出关键数字（缺陷数）", (() => {
				const readmeSrc = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
				const actual = [...readmeSrc.matchAll(/^\| (\d+) \| \*\*/gm)].length;
				return new RegExp("\\b" + actual + "\\s*个自身缺陷");
			})(), "用户心里有数"],
			["提到 topic dsh-plugin", /dsh-plugin/, "仓库可检索"],
			// **缺陷 139**（第 135 轮）：README 从未说明这是「非官方项目」，
			// 而包名用了 `@deepseek-ai/` 这个**官方 npm scope**。
			// `package.json` 里 `private: true` 表明不会发布，但读者光看 README
			// 会误以为这是官方产物 —— 对投稿材料来说这是**定位不清**。
			["README 明确声明「非官方项目」", /非官方项目|Unofficial project/, "避免被误认为官方产物"],
			// **缺陷 166**：声明必须说明包名归属（用作者本人命名空间、不占用官方 scope），
	// 而不是继续解释早已废弃的 `@deepseek-ai/` 前缀（改名后原文未同步）。
	["声明说明了包名归属（不占用官方 scope）", /不占用任何官方 scope|does not occupy any official scope|作者本人的命名空间|author's own namespace/, "说明包名归属"],
		];
		for (const [label, re, why] of CHECKS) {
			const ok = re.test(sg);
			ck(`SUBMIT-GUIDE ${label}`, ok, why);
			console.log(`  ${label}: ${ok ? "✅" : "❌"}`);
		}

		// 不应含绝对本地路径
		const hasAbs = /C:\\Users\\[A-Za-z0-9]+/.test(sg);
		ck("SUBMIT-GUIDE 不含绝对本地路径（除模板占位）", !hasAbs, "");
	}
}

// ===========================================================================
// 4. 指南里的命令真的能跑
// ===========================================================================
console.log("\n=== 4. 指南里的命令可运行 ===");
{
	const p = path.join(ROOT, "SUBMIT-GUIDE.zh.md");
	if (fs.existsSync(p)) {
		const sg = fs.readFileSync(p, "utf8");
		// 提取 node xxx 命令
		const cmds = new Set();
		for (const m of sg.matchAll(/node\s+(test\/[\w./-]+\.(?:mjs|cjs))/g)) cmds.add(m[1]);
		console.log(`  提取到 ${cmds.size} 条 node 命令`);
		for (const c of cmds) {
			const full = path.join(ROOT, c);
			const exists = fs.existsSync(full);
			ck(`指南里的命令 ${c} 对应文件存在`, exists, "");
			console.log(`  ${c}: ${exists ? "✅" : "❌"}`);
		}
		ck("指南至少给出一条可运行的测试命令", cmds.size > 0, "");
	}
}

// ===========================================================================
// 5. package.json 的 files 字段合理（npm 发布只带必要文件）
// ===========================================================================
console.log("\n=== 5. package.json files 字段 ===");
{
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	ck("package.json 有 files 字段", Array.isArray(pkg.files), "");
	if (Array.isArray(pkg.files)) {
		console.log(`  files: ${JSON.stringify(pkg.files)}`);
		// 必须包含 lib
		ck("files 包含 lib/index.js", pkg.files.some((f) => f === "lib/index.js" || f === "lib"), "");
		// 不应包含 test（npm 包不需要全部测试）
		const hasTest = pkg.files.some((f) => f.startsWith("test"));
		console.log(`  files 含 test: ${hasTest}（不计入缺陷，只是提示）`);
		// 不应包含草稿
		const hasDraft = pkg.files.some((f) => /PASTE-READY|SUBMIT-GUIDE/.test(f));
		ck("files 不含提交草稿", !hasDraft, "");
	}
}

// ===========================================================================
// 6. 关键文档之间的数字一致
// ===========================================================================
console.log("\n=== 6. 提交指南 vs README 数字一致 ===");
{
	const sg = fs.readFileSync(path.join(ROOT, "SUBMIT-GUIDE.zh.md"), "utf8");
	const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

	// 提取层数
	const sgLayers = (sg.match(/(\d+)\s*层测试/) ?? [])[1];
	const readmeLayers = (readme.match(/\*\*([零一二三四五六七八九十百\d]+)层测试\*\*/) ?? [])[1];
	console.log(`  SUBMIT-GUIDE 层数: ${sgLayers ?? "未提及"}`);
	console.log(`  README 层数: ${readmeLayers ?? "未提及"}`);

	// 提取缺陷数
	const sgDefects = (sg.match(/(\d+)\s*个自身缺陷/) ?? [])[1];
	const readmeDefects = (readme.match(/共发现并(?:修掉|修复)\s*(\d+)\s*个自身缺陷/) ?? [])[1];
	console.log(`  SUBMIT-GUIDE 缺陷数: ${sgDefects ?? "未提及"}`);
	console.log(`  README 缺陷数: ${readmeDefects ?? "未提及"}`);

	if (sgDefects && readmeDefects) {
		ck("SUBMIT-GUIDE 与 README 缺陷数一致", sgDefects === readmeDefects, `${sgDefects} vs ${readmeDefects}`);
	}
	if (sgLayers && readmeLayers) {
		// README 用中文数字，需要转换
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
		const n = toNum(readmeLayers);
		console.log(`  README 层数转换: ${n}`);
		ck("SUBMIT-GUIDE 与 README 层数一致", Number(sgLayers) === n, `${sgLayers} vs ${n}`);
	}
}

// ===========================================================================
// 7. 仓库不含临时/备份文件
// ===========================================================================
console.log("\n=== 7. 仓库卫生 ===");
{
	const BAD_PATTERNS = [/\.bak$/, /\.orig$/, /~$/, /\.tmp$/, /\.swp$/, /^\.DS_Store$/];
	const bad = [];
	(function walk(d) {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) {
				if (["node_modules", ".git"].includes(e.name) || e.name.startsWith(".tmp")) continue;
				walk(p);
				continue;
			}
			if (BAD_PATTERNS.some((re) => re.test(e.name))) bad.push(path.relative(ROOT, p));
		}
	})(ROOT);
	ck("无临时/备份文件", bad.length === 0, bad.slice(0, 5).join(", "));
	console.log(`  临时/备份文件: ${bad.length === 0 ? "无 ✅" : bad.join(", ")}`);

	// 不应有 node_modules
	ck("仓库无 node_modules", !fs.existsSync(path.join(ROOT, "node_modules")), "");
}

// ===========================================================================
// 9. SUBMIT-GUIDE 的可执行性与完整性
//
// **缺陷 62**：指南里的预期输出写「58 通过」（实际 73）、耗时写「约 30 秒」
// （实际 89 秒），且**完全没有「装完必须重启」的提醒** ——
// 零基础用户装完插件后运行中的 DSH 仍用旧代码，会以为修复无效。
// ===========================================================================
console.log("\n=== 8. SUBMIT-GUIDE 可执行性与完整性 ===");
{
	const guidePath = path.join(ROOT, "SUBMIT-GUIDE.zh.md");
	if (!fs.existsSync(guidePath)) {
		ck("SUBMIT-GUIDE 存在", false, "");
	} else {
		const guide = fs.readFileSync(guidePath, "utf8");

		// 9a. 必须提醒「重启」（这是最容易忘、后果最直接的一步）
		ck("SUBMIT-GUIDE 提醒「装完必须重启」", /重启/.test(guide), "完全没提重启");
		ck("SUBMIT-GUIDE 说明重启的原因", /长驻|进程启动时|apply\(\)|旧代码/.test(guide), "");

		// 9b. 预期输出里的数字必须与实际 quick 模式一致
		const runAllPath = path.join(ROOT, "test", "run-all.mjs");
		if (fs.existsSync(runAllPath)) {
			const raSrc = fs.readFileSync(runAllPath, "utf8");
			const extractSet = (name) => {
			// **缺陷 125**（第 124 轮）：这些列表已移到 _suite-meta.mjs（唯一事实源），
			// 所以要读共享模块，而不是 run-all 的本地定义。
			const metaSrc = fs.readFileSync(path.join(ROOT, "test", "hardening", "_suite-meta.mjs"), "utf8");
			const m = metaSrc.match(new RegExp("export const " + name + "\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)"));
				if (!m) return [];
				return [...m[1].matchAll(/"([^"]+\.mjs)"/g)].map((x) => x[1]);
			};
			const NEEDS_LOGS = extractSet("NEEDS_LOGS");
			const SLOW = extractSet("SLOW");
			// **缺陷 88**：`_` 开头是共享工具模块，不是套件
			const hardeningFiles = fs.readdirSync(path.join(ROOT, "test", "hardening")).filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));

			let quickRuns = 0;
			for (const f of hardeningFiles) {
				if (f === "mutation-test.mjs") continue;
				if (NEEDS_LOGS.includes(f)) continue;
				if (SLOW.includes(f)) continue;
				quickRuns++;
			}
			quickRuns += 2;

			const m = guide.match(/结果：(\d+) 通过/);
			if (m) {
				const claimed = Number(m[1]);
				ck(`SUBMIT-GUIDE 的「${claimed} 通过」= quick 模式实际套件数 ${quickRuns}`,
					claimed === quickRuns, `声明 ${claimed}`);
				console.log(`  预期输出: 声明 ${claimed}，实际 ${quickRuns}`);
			} else {
				ck("SUBMIT-GUIDE 有预期输出示例", false, "");
			}
		}

		// 9c. 指南里给出的命令必须都存在（防止命令失效）
		const cmds = [...guide.matchAll(/`(node test\/[\w./-]+\.mjs[^`]*)`/g)].map((x) => x[1]);
		let missing = 0;
		const missingList = [];
		for (const c of cmds) {
			// **修正**：先从 `node <path> [args]` 里取出路径，不能用 split(" ")[0]
			// （那会取到字面量 "node"）
			const m = c.match(/^node\s+(test\/[\w./-]+\.mjs)/);
			if (!m) continue;
			const script = m[1];
			if (!fs.existsSync(path.join(ROOT, script))) {
				missing++;
				missingList.push(script);
			}
		}
		console.log(`  命令引用: ${cmds.length} 条，缺失 ${missing} 条`);
		for (const m of missingList) console.log(`    ❌ 不存在: ${m}`);
		ck("SUBMIT-GUIDE 里的命令都指向存在的脚本", missing === 0, `${missing} 条指向不存在的文件`);
		console.log(`  命令引用: ${cmds.length} 条，缺失 ${missing} 条`);
	}
}

// ===========================================================================
// 10. git 可提交性（模拟 git init + add，验证上传集合正确）
//
// **缺陷 63**（第 70 轮）：这套验证此前只手工跑过，从未固化成套件。
// 若 .gitignore 规则或目录结构变动，可能悄悄上传草稿或漏掉关键文件。
// ===========================================================================
console.log("\n=== 9. git 可提交性 ===");
{
	try {
		const os = await import("node:os");
		const { execFileSync } = await import("node:child_process");

		const tmpDir = path.join(os.tmpdir(), "dsh-deliv-check-" + Date.now());

		// 复制（排除 node_modules / .git / .tmp）
		const copyDir = (src, dst) => {
			fs.mkdirSync(dst, { recursive: true });
			for (const e of fs.readdirSync(src, { withFileTypes: true })) {
				if (["node_modules", ".git", ".tmp"].includes(e.name)) continue;
				if (e.name.startsWith(".tmp")) continue;
				const s = path.join(src, e.name);
				const d = path.join(dst, e.name);
				if (e.isDirectory()) copyDir(s, d);
				else fs.copyFileSync(s, d);
			}
		};

		copyDir(ROOT, tmpDir);

		const git = (args) => execFileSync("git", args, { cwd: tmpDir, encoding: "utf8", stdio: "pipe" });
		git(["init", "-q"]);
		git(["config", "user.email", "t@e.com"]);
		git(["config", "user.name", "T"]);
		git(["add", "-A"]);

		const staged = git(["diff", "--cached", "--name-only"]).trim().split("\n").filter(Boolean);
		console.log(`  staged ${staged.length} 个文件`);

		// 10a. 草稿文件必须被排除
		const MUST_EXCLUDE = [
			"SUBMIT-GUIDE.zh.md",
			"PASTE-READY.zh.md",
			"community/issue-deepseek-harness.zh.md",
			"community/issue-deepseek-harness.en.md",
		];
		const leaked = MUST_EXCLUDE.filter((f) => staged.includes(f));
		ck("草稿文件不会被提交", leaked.length === 0, leaked.join(", "));
		console.log(`  草稿泄漏: ${leaked.length}`);

		// 10b. 关键文件必须被包含
		const MUST_INCLUDE = [
			"README.md",
			"README.en.md",
			"LICENSE",
			"package.json",
			"lib/index.js",
			"install-stepfix.ps1",
			".gitignore",
			"community/discussion-deepseek-harness.md",
			"community/repro/model-side.cjs",
			"community/repro/harness-side.mjs",
		];
		const missing = MUST_INCLUDE.filter((f) => !staged.includes(f));
		ck("关键文件都会被提交", missing.length === 0, missing.join(", "));
		console.log(`  关键文件缺失: ${missing.length}`);

		// 10c. 没有意外文件（日志/备份/临时）
		const junk = staged.filter((f) =>
			/\.(log|tmp|bak|swp|orig)$/.test(f) ||
			f.includes("node_modules") ||
			f.includes("/.tmp") ||
			/backup/i.test(f)
		);
		ck("提交集合中没有临时/备份文件", junk.length === 0, junk.slice(0, 5).join(", "));
		console.log(`  临时文件: ${junk.length}`);

		// 10d. 测试脚本应被提交（透明度）
		const testCount = staged.filter((f) => f.startsWith("test/")).length;
		ck("测试脚本会被提交（透明度）", testCount >= 80, `${testCount} 个`);
		console.log(`  test/ 下: ${testCount} 个`);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch (e) {
		console.log(`  ⚠️ git 模拟失败（跳过）: ${e.message}`);
		ck("git 可提交性可验证", false, e.message.slice(0, 100));
	}
}

// ===========================================================================
// 11. 占位符与填写说明（缺陷 78）
//
// `package.json` 有 4 个待填占位符，但 SUBMIT-GUIDE 第 5 步只说「PASTE-READY 有 1 处」
// —— 用户照做后 npm 页面的 Repository / Homepage / Issues 三个链接都会 404。
// ===========================================================================
console.log("\n=== 10. 占位符与填写说明 ===");
{
	// 待填占位符 = 大写尖括号形式（如 <YOUR_GITHUB_USERNAME>）
	// 注意：<DSH_HOME> 是**路径示意**（不是待填），由 PATH_PLACEHOLDERS 排除。
	// **缺陷 148**（第 141 轮）：缺陷 147 的记录里为了让示例不带真实用户名，
	// 写成了 \`C:\\Users\\<USERNAME>\\...\` —— 而下面的正则把 \`<USERNAME>\` 当成了
	// **待填占位符**，于是「缺陷表里没有待填占位符」这条断言失败。
	// 这类占位符是**历史记录里的说明性占位**（告诉读者「这里原本是用户名」），
	// 不是「你必须去填的东西」，应当排除。
	const PATH_PLACEHOLDERS = new Set(["DSH_HOME", "PROFILE", "TEMP", "USERPROFILE", "USERNAME"]);

	const SCAN = [
		"package.json",
		"README.md",
		"README.en.md",
		"SUBMIT-GUIDE.zh.md",
		"community/discussion-deepseek-harness.md",
		"PASTE-READY.zh.md",
	];

	const found = new Map();   // placeholder -> [files]
	for (const f of SCAN) {
		const p = path.join(ROOT, f);
		if (!fs.existsSync(p)) continue;
		const text = fs.readFileSync(p).toString("utf8");
		for (const m of text.matchAll(/<([A-Z][A-Z0-9_]{3,})>/g)) {
			const name = m[1];
			if (PATH_PLACEHOLDERS.has(name)) continue;
			if (!found.has(name)) found.set(name, []);
			if (!found.get(name).includes(f)) found.get(name).push(f);
		}
	}

	console.log(`  待填占位符: ${found.size} 种`);
	for (const [name, files] of found) {
		console.log(`    <${name}> → ${files.join(", ")}`);
	}

	// 11a. package.json 的占位符必须在 SUBMIT-GUIDE 里有说明
	const sgPath = path.join(ROOT, "SUBMIT-GUIDE.zh.md");
	const sg = fs.existsSync(sgPath) ? fs.readFileSync(sgPath).toString("utf8") : "";

	const pkgPlaceholders = [...found.entries()]
		.filter(([, files]) => files.includes("package.json"))
		.map(([name]) => name);

	const undocumented = pkgPlaceholders.filter((name) => !sg.includes(name));
	ck("package.json 的每个占位符都在 SUBMIT-GUIDE 里有说明",
		undocumented.length === 0,
		`未说明: ${undocumented.join(", ")}`);
	console.log(`  package.json 占位符: ${pkgPlaceholders.length} 种，未说明 ${undocumented.length} 种`);

	// 11b. README 的缺陷表里不得出现待填占位符
	//      （缺陷表是历史记录，出现大写占位符会被读者当成「我还得填这个」）
	const readmePath = path.join(ROOT, "README.md");
	const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath).toString("utf8") : "";
	const defectLines = readme.split(/\r?\n/).filter((l) => /^\| \d+ \|/.test(l));
	const badDefectLines = defectLines.filter((l) =>
		/<[A-Z][A-Z0-9_]{3,}>/.test(l) &&
		![...l.matchAll(/<([A-Z][A-Z0-9_]{3,})>/g)].every((m) => PATH_PLACEHOLDERS.has(m[1])));
	ck("缺陷表里没有待填占位符（历史记录不应被当成待填）",
		badDefectLines.length === 0,
		badDefectLines.slice(0, 2).map((l) => l.slice(0, 60)).join(" | "));
	console.log(`  缺陷表行数: ${defectLines.length}，含待填占位符: ${badDefectLines.length}`);

	// 11c. SUBMIT-GUIDE 必须给出「共几处」的总数
	ck("SUBMIT-GUIDE 说明待填占位符的总数", /共 \d+ 处|\d+ 处占位符/.test(sg),
		"未给出总数");

	// **缺陷 163**（第 154 轮）：这里的「反向验证」原来断言**真实 package.json 里必须有占位符**，
	// 于是作者把占位符填好、准备发布时，这个检查反而失败 —— **测试与作者的交接状态耦合**。
	// 正确做法：用**合成样本**验证「检测器本身有效」，再用单独一条断言真实文件是否已就绪。
	const synthetic = "<YOUR_GITHUB_USERNAME> and <YOUR_NAME>";
	const syntheticHits = [...synthetic.matchAll(/<[A-Z_]+>/g)].length;
	ck("占位符检测器本身有效（合成样本，不依赖真实文件状态）", syntheticHits === 2,
		`合成样本命中 ${syntheticHits} 个`);
	ck("package.json 已就绪（无待填占位符）", pkgPlaceholders.length === 0,
		`仍有 ${pkgPlaceholders.length} 种: ${pkgPlaceholders.slice(0, 3).join(", ")}`);
}

﻿// ===========================================================================
// 12. README 的 Top-Down 可达性（缺陷 90）
//
// 陌生人要读到第 101 行才知道怎么装 —— 前 100 行全是问题现象 + 根因调查。
// 开源 README 惯例：开头必须有 30 秒能看完的 TL;DR。
// ===========================================================================
console.log("\n=== 11. README 的 Top-Down 可达性 ===");
{
	const readmePath = path.join(ROOT, "README.md");
	const readmeEnPath = path.join(ROOT, "README.en.md");

	if (!fs.existsSync(readmePath)) {
		ck("README 存在", false, "");
	} else {
		const zh = fs.readFileSync(readmePath).toString("utf8");
		const zhLines = zh.split(/\r?\n/);
		const HEAD = zhLines.slice(0, 40).join("\n");

		ck("README 前 40 行有「30 秒摘要」", /30\s*秒摘要/.test(HEAD), "未找到摘要区块");

		const SUMMARY_ITEMS = [
			{ name: "问题描述", re: /问题|卡住|静默结束/ },
			{ name: "安装命令", re: /install-stepfix\.ps1/ },
			{ name: "必须重启", re: /必须重启|重启 DeepSeek/ },
			{ name: "怎么验证", re: /live-instance\.mjs|runtime-process-check\.mjs|确认生效/ },
		];
		let present = 0;
		for (const item of SUMMARY_ITEMS) {
			if (item.re.test(HEAD)) present++;
			else console.log("    ⚠️ 摘要缺少: " + item.name);
		}
		ck("摘要包含 4 个关键点", present === SUMMARY_ITEMS.length, present + "/" + SUMMARY_ITEMS.length);
		console.log("  摘要关键点: " + present + "/" + SUMMARY_ITEMS.length);

		let installAt = -1;
		for (let i = 0; i < zhLines.length; i++) {
			if (/install-stepfix\.ps1/.test(zhLines[i])) { installAt = i + 1; break; }
		}
		ck("安装命令在前 50 行内可达", installAt > 0 && installAt <= 50, installAt > 0 ? "L" + installAt : "未找到");
		console.log("  安装入口: " + (installAt > 0 ? "L" + installAt : "未找到"));

		if (fs.existsSync(readmeEnPath)) {
			const en = fs.readFileSync(readmeEnPath).toString("utf8");
			const enHead = en.split(/\r?\n/).slice(0, 40).join("\n");
			ck("英文版前 40 行有 30-second summary", /30-second summary/i.test(enHead), "");
			ck("英文版摘要含安装命令", /install-stepfix\.ps1/.test(enHead), "");
		}

		ck("摘要指向「已知限制」", /已知限制|Known limits/.test(HEAD), "");

		const summaryStart = zhLines.findIndex((l) => /30\s*秒摘要/.test(l));
		if (summaryStart >= 0) {
			const block = zhLines.slice(summaryStart, summaryStart + 35).join("\n");
			ck("摘要区块有实质内容（>= 15 行）", block.split("\n").length >= 15, String(block.split("\n").length));
		}

		console.log("  README 总行数: " + zhLines.length);
	}
}

﻿// ===========================================================================
// 13. 内部锚点链接可达性（缺陷 91）
//
// 第 95 轮加 TL;DR 时用了 5 个内部锚点，但其中 2 个**失效**：
//   · README.md L28: 锚点写「89 个自身缺陷」，标题实际是「90 个」→ 跳不过去
//   · README.en.md L36: 链接写 #verification，标题实际是 ## Verify → slug 是 #verify
//
// 这类问题**肉眼几乎看不出来**（链接文字是对的），只有点下去才发现 404。
// ===========================================================================
console.log("\n=== 12. 内部锚点链接可达性 ===");
{
	// GitHub 风格锚点：小写、去标点、空格转连字符（保留 CJK）
	const slugify = (text) => text.trim().toLowerCase()
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\*\*([^*]*)\*\*/g, "$1")
		.replace(/\*([^*]*)\*/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s+/g, "-");

	const collectHeadings = (text) => {
		const out = [];
		let inFence = false;
		const seen = new Map();
		for (const line of text.split(/\r?\n/)) {
			if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
			if (inFence) continue;
			const m = line.match(/^(#{1,6})\s+(.+)$/);
			if (!m) continue;
			let slug = slugify(m[2]);
			const n = seen.get(slug) ?? 0;
			seen.set(slug, n + 1);
			if (n > 0) slug = slug + "-" + n;
			out.push(slug);
		}
		return out;
	};

	const collectAnchors = (text) => {
		const out = [];
		let inFence = false;
		const ls = text.split(/\r?\n/);
		for (let i = 0; i < ls.length; i++) {
			if (/^\s*```/.test(ls[i])) { inFence = !inFence; continue; }
			if (inFence) continue;
			// **缺陷 91 的教训**：缺陷表里会写「示例链接」（如 [Verify](#verification)）
			// 用来说明某个锚点曾经失效 —— 那不是真实链接，必须跳过。
			if (/^\| \d+ \|/.test(ls[i])) continue;
			for (const m of ls[i].matchAll(/\[([^\]]*)\]\(#([^)]+)\)/g)) {
				out.push({ line: i + 1, text: m[1], anchor: m[2] });
			}
		}
		return out;
	};

	const LINK_DOCS = [
		"README.md", "README.en.md", "SUBMIT-GUIDE.zh.md",
		"community/discussion-deepseek-harness.md",
	];

	let totalLinks = 0;
	const brokenLinks = [];

	for (const doc of LINK_DOCS) {
		const p = path.join(ROOT, doc);
		if (!fs.existsSync(p)) continue;
		const text = fs.readFileSync(p).toString("utf8");
		const anchors = collectAnchors(text);
		if (anchors.length === 0) continue;
		const slugs = new Set(collectHeadings(text));

		for (const a of anchors) {
			totalLinks++;
			if (!slugs.has(a.anchor)) {
				brokenLinks.push(doc + " L" + a.line + " → #" + a.anchor);
			}
		}
	}

	console.log("  锚点链接: " + totalLinks + " 个，失效 " + brokenLinks.length + " 个");
	ck("所有内部锚点链接都能跳转", brokenLinks.length === 0, brokenLinks.slice(0, 3).join("; "));
	for (const b of brokenLinks.slice(0, 5)) console.log("    ❌ " + b);

	// **反向验证**：必须真的找到锚点（防止「没有链接所以通过」）
	ck("确实存在内部锚点链接（非空转）", totalLinks >= 5, "只找到 " + totalLinks + " 个");
}

﻿// ===========================================================================
// 14. 安装脚本的编码安全（缺陷 93 + 94）
//
// **两个独立但相关的编码缺陷**：
//
// 缺陷 94（更严重）：`install-stepfix.ps1` 自己是 UTF-8 **无 BOM**，但含大量
//   中文注释与字符串。PowerShell 5.1 会按 **ANSI（中文系统是 GBK）** 解码脚本
//   源码 → 中文变乱码，且**可能破坏字符串边界** → 脚本直接语法错误，
//   用户**第一条命令就失败**。实测读到 `# 瀹夎 dsh-text-tool-call-recovery 鎻掍欢鍒?DSH profile`。
//
// 缺陷 93：脚本用 `Get-Content -Raw`（无 -Encoding）读 `cordis.patch.yml`，
//   而该文件是 UTF-8 无 BOM 且可能含中文（例如模型名）。读进来已乱码，
//   再 `WriteAllText` 写回 → **用户配置里的中文被永久损坏**。
//   实测：「书生专用」→「涔︾敓涓撶敤」。
//
// 本检查（在 PowerShell 5.1 下真实执行）：
//   ① 脚本必须带 UTF-8 BOM（否则 5.1 读不对）
//   ② 脚本能通过 PowerShell 语法解析
//   ③ 端到端：含中文的 patch 文件 → 安装 → 中文完好
//   ④ 幂等：重复运行不改变文件、不重复插入
//   ⑤ BOM 状态保持（原文件无 BOM 则写回也无 BOM）
// ===========================================================================
console.log("\n=== 13. 安装脚本的编码安全 ===");
{
	const scriptPath = path.join(ROOT, "install-stepfix.ps1");
	const ckPs = (label, ok, detail) => {
		if (ok) pass++; else { fail++; failures.push(label + (detail ? " :: " + detail : "")); }
		console.log("  " + (ok ? "✅" : "❌") + " " + label + (detail && !ok ? " :: " + detail : ""));
	};

	if (!fs.existsSync(scriptPath)) {
		ckPs("安装脚本存在", false, scriptPath);
	} else {
		// 14a. 必须有 UTF-8 BOM
		const bytes = fs.readFileSync(scriptPath);
		const hasBom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
		ckPs("install-stepfix.ps1 带 UTF-8 BOM（PowerShell 5.1 才能正确读中文）", hasBom,
			hasBom ? "" : "无 BOM，PS 5.1 会按 ANSI 解码导致语法错误");

		// 14b. 文件里确有非 ASCII（证明 BOM 不是多余的）
		let nonAscii = 0;
		for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x7F) nonAscii++;
		ckPs("脚本确实含非 ASCII 字符（BOM 有必要）", nonAscii > 0, String(nonAscii));

		// 14c. 必须显式用 UTF-8 读写 patch 文件（不能用 Get-Content -Raw 裸读后写回）
		const src = fs.readFileSync(scriptPath, "utf8");
		const usesExplicitUtf8 = /Encoding\]::UTF8|UTF8Encoding/.test(src);
		ckPs("脚本显式指定 UTF-8 读写（避免损坏用户配置里的中文）", usesExplicitUtf8,
			"未找到 Encoding::UTF8");

		// 14d. 不得有「裸 Get-Content 后 WriteAllText」的组合
		const hasBareRead = /Get-Content\s+\$patchFile\s+-Raw/.test(src);
		const hasWrite = /WriteAllText\(\s*\$patchFile/.test(src);
		ckPs("不存在「ANSI 读 + UTF-8 写」的危险组合", !(hasBareRead && hasWrite),
			hasBareRead && hasWrite ? "裸 Get-Content -Raw 后 WriteAllText" : "");

		// 14e. PowerShell 语法检查（真实执行 powershell）
		// **注意**：PS 5.1 里 [ref] 参数在 -Command 字符串中不可靠，
		// 改用「-File 执行脚本 + 检查退出码」这个更稳的方式：
		// 语法错误会让 powershell 直接失败（非 0 退出码）。
		// 用一个不改变任何状态的开关：脚本在 profile 不存在时立刻 exit 1，
		// 所以传一个不存在的 DshHome，正确解析时得到 exit 1 + "profile 目录不存在"，
		// 语法错误时得到 exit 1 + ParserError —— 两者靠 stderr 内容区分。
		if (process.platform === "win32") {
			try {
				const missing = path.join(ROOT, ".nonexistent-profile-for-syntax-check");
				const out = execSync(
					'powershell -NoProfile -ExecutionPolicy Bypass -File "' + scriptPath + '" -DshHome "' + missing + '"',
					{ encoding: "utf8", timeout: 60000, stdio: "pipe" }
				);
				// 正常情况不会走到这里（脚本会 exit 1）
				ckPs("PowerShell 5.1 能正确解析脚本", false, "预期脚本因 profile 不存在而失败，但它成功了");
			} catch (e) {
				const stdout = String(e.stdout ?? "");
				const stderr = String(e.stderr ?? "");
				const combined = stdout + stderr;

				// 语法错误特征
				const hasSyntaxError = /ParserError|Missing closing|Unexpected token|字符串缺少终止符|缺少右/.test(combined);
				// 正常路径特征：脚本能读到自己的中文提示
				const hasExpectedPath = /profile 目录不存在/.test(combined);

				ckPs("PowerShell 5.1 能正确解析脚本（无 ParserError）", !hasSyntaxError,
					hasSyntaxError ? "出现 ParserError，脚本源码编码有问题" : "");
				ckPs("脚本中文提示正常显示（BOM 生效）", hasExpectedPath,
					hasExpectedPath ? "" : "未看到「profile 目录不存在」，中文可能乱码");
			}
		} else {
			console.log("  （非 Windows，跳过 PowerShell 语法检查）");
		}
	}
}

﻿// ===========================================================================
// 15. 安装脚本的错误路径与友好提示（缺陷 95）
//
// 前 98 轮只测了**成功路径**。第 99 轮测错误路径时发现：
// 权限不足时脚本直接抛 .NET `UnauthorizedAccessException` 堆栈，
// 用户看到的是 `CategoryInfo : PermissionDenied: ...` 这种东西，
// 既不知道发生了什么，也不知道怎么修。
//
// 本检查（真实执行 install-stepfix.ps1）：
//   ① profile 不存在 → 退出码 1 + 明确提示
//   ② 缺 cordis.patch.yml → 退出码 1 + 明确提示
//   ③ 正常路径 → 退出码 0
//   ④ 错误输出**不得包含**原始 .NET 异常堆栈特征
//   ⑤ 错误输出必须给出**可操作**的处理建议
// ===========================================================================
console.log("\n=== 14. 安装脚本的错误路径与友好提示 ===");
{
	const scriptPath = path.join(ROOT, "install-stepfix.ps1");
	const ckPs = (label, ok, detail) => {
		if (ok) pass++; else { fail++; failures.push(label + (detail ? " :: " + detail : "")); }
		console.log("  " + (ok ? "✅" : "❌") + " " + label + (detail && !ok ? " :: " + detail : ""));
	};

	if (process.platform !== "win32") {
		console.log("  （非 Windows，跳过）");
	} else if (!fs.existsSync(scriptPath)) {
		ckPs("安装脚本存在", false, scriptPath);
	} else {
		const runPs = (dshHome) => {
			try {
				const out = execSync(
					'powershell -NoProfile -ExecutionPolicy Bypass -File "' + scriptPath + '" -DshHome "' + dshHome + '"',
					{ encoding: "utf8", timeout: 120000, stdio: "pipe" }
				);
				return { code: 0, output: String(out) };
			} catch (e) {
				return {
					code: e.status ?? 1,
					output: String(e.stdout ?? "") + String(e.stderr ?? ""),
				};
			}
		};

		const base = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-install-err-"));

		// ① profile 不存在
		{
			const missing = path.join(base, "no-such-home");
			const r = runPs(missing);
			ckPs("profile 不存在时退出码为 1", r.code === 1, "exit=" + r.code);
			ckPs("profile 不存在时给出明确提示", /profile 目录不存在/.test(r.output), r.output.slice(0, 120));
		}

		// ② 缺 cordis.patch.yml
		{
			const h = path.join(base, "no-patch");
			fs.mkdirSync(path.join(h, "profiles", "desktop"), { recursive: true });
			const r = runPs(h);
			ckPs("缺 cordis.patch.yml 时退出码为 1", r.code === 1, "exit=" + r.code);
			ckPs("缺 cordis.patch.yml 时给出明确提示", /找不到/.test(r.output), r.output.slice(0, 120));
		}

		// ③ 正常路径（含中文，验证编码修复）
		{
			const h = path.join(base, "ok");
			fs.mkdirSync(path.join(h, "profiles", "desktop"), { recursive: true });
			const patch = path.join(h, "profiles", "desktop", "cordis.patch.yml");
			fs.writeFileSync(patch, "- id: t\n  config:\n    name: 书生专用\n", "utf8");
			const r = runPs(h);
			ckPs("正常路径退出码为 0", r.code === 0, "exit=" + r.code + " :: " + r.output.slice(-120));
			ckPs("正常路径输出 INSTALL OK", /INSTALL OK/.test(r.output), r.output.slice(-150));

			// 中文必须保留
			const after = fs.readFileSync(patch, "utf8");
			ckPs("安装后配置里的中文完好（缺陷 93 回归）", after.includes("书生专用"),
				after.includes("涔") ? "中文已损坏" : "未找到中文");
		}

		// ④⑤ 错误输出不得是原始堆栈，且必须给建议
		{
			const h = path.join(base, "readonly");
			fs.mkdirSync(path.join(h, "profiles", "desktop"), { recursive: true });
			const patch = path.join(h, "profiles", "desktop", "cordis.patch.yml");
			fs.writeFileSync(patch, "- id: t\n", "utf8");

			// 用 icacls 设为只读
			try {
				execSync('icacls "' + patch + '" /deny "' + (process.env.USERNAME ?? "") + ':(W)"', { stdio: "pipe", timeout: 30000 });
			} catch { /* 设置失败就跳过这项 */ }

			const r = runPs(h);

			// 恢复权限后清理
			try {
				execSync('icacls "' + patch + '" /remove:d "' + (process.env.USERNAME ?? "") + '"', { stdio: "pipe", timeout: 30000 });
			} catch { /* ignore */ }

			// 如果权限设置没生效（r.code === 0），说明环境不允许，跳过这两项
			if (r.code !== 0) {
				const looksLikeRawStack = /CategoryInfo\s*:\s*PermissionDenied|FullyQualifiedErrorId\s*:|UnauthorizedAccessException\s*$/.test(r.output)
					&& !/可能的原因与处理方式/.test(r.output);
				ckPs("权限错误时给出友好提示而非原始堆栈", !looksLikeRawStack, r.output.slice(0, 200));
				ckPs("权限错误时给出可操作的处理建议", /可能的原因与处理方式/.test(r.output), r.output.slice(0, 200));
				ckPs("权限错误时说明「尚未修改配置」（可安全重试）", /尚未修改|配置未修改/.test(r.output), "");
			} else {
				console.log("  （环境不允许设置只读，跳过权限错误检查）");
			}
		}

		// 清理
		try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

﻿// ===========================================================================
// 16. 特殊路径与备份轮转（缺陷 96）
//
// 第 99 轮只测了「无空格无中文」的路径。第 100 轮补测三个**中文用户必然
// 遇到**的场景，并发现备份**从不清理**：
//
//   · 路径含空格（C:\Users\John Smith\）
//   · 路径含中文（C:\Users\张三\）—— 中文用户必然遇到
//   · -ProfileDir 参数（README 提到但从未测）
//   · 备份轮转：实测累积 1114 个文件，脚本从不删除
//
// 本检查（真实执行）：
//   ① 路径含空格能装成功，中文保留
//   ② 路径含中文能装成功，中文保留
//   ③ -ProfileDir 参数有效
//   ④ 备份数量受控（≤ KeepBackups + 1）
//   ⑤ 轮转不误删其他文件
// ===========================================================================
console.log("\n=== 15. 特殊路径与备份轮转 ===");
{
	const scriptPath = path.join(ROOT, "install-stepfix.ps1");
	const ckPs = (label, ok, detail) => {
		if (ok) pass++; else { fail++; failures.push(label + (detail ? " :: " + detail : "")); }
		console.log("  " + (ok ? "✅" : "❌") + " " + label + (detail && !ok ? " :: " + detail : ""));
	};

	if (process.platform !== "win32") {
		console.log("  （非 Windows，跳过）");
	} else if (!fs.existsSync(scriptPath)) {
		ckPs("安装脚本存在", false, scriptPath);
	} else {
		const runPs = (args) => {
			try {
				const out = execSync(
					'powershell -NoProfile -ExecutionPolicy Bypass -File "' + scriptPath + '" ' + args,
					{ encoding: "utf8", timeout: 120000, stdio: "pipe" }
				);
				return { code: 0, output: String(out) };
			} catch (e) {
				return { code: e.status ?? 1, output: String(e.stdout ?? "") + String(e.stderr ?? "") };
			}
		};

		const base = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-install-path-"));
		const setup = (dir, content) => {
			fs.mkdirSync(path.join(dir, "profiles", "desktop"), { recursive: true });
			const patch = path.join(dir, "profiles", "desktop", "cordis.patch.yml");
			fs.writeFileSync(patch, content ?? "- id: t\n  config:\n    name: 书生专用\n", "utf8");
			return patch;
		};

		// ① 路径含空格
		{
			const h = path.join(base, "with space dir");
			const patch = setup(h);
			const r = runPs('-DshHome "' + h + '"');
			ckPs("路径含空格时安装成功", r.code === 0, "exit=" + r.code + " :: " + r.output.slice(-120));
			const after = fs.readFileSync(patch, "utf8");
			ckPs("路径含空格时中文保留", after.includes("书生专用"), after.includes("涔") ? "中文损坏" : "");
			ckPs("路径含空格时插件条目写入", after.includes("text-tool-call-recovery"), "");
		}

		// ② 路径含中文
		{
			const h = path.join(base, "测试目录中文");
			const patch = setup(h);
			const r = runPs('-DshHome "' + h + '"');
			ckPs("路径含中文时安装成功", r.code === 0, "exit=" + r.code + " :: " + r.output.slice(-120));
			const after = fs.readFileSync(patch, "utf8");
			ckPs("路径含中文时中文保留", after.includes("书生专用"), after.includes("涔") ? "中文损坏" : "");
		}

		// ③ -ProfileDir 参数
		{
			const h = path.join(base, "profiledir");
			fs.mkdirSync(h, { recursive: true });
			const patch = path.join(h, "cordis.patch.yml");
			fs.writeFileSync(patch, "- id: t\n", "utf8");
			const r = runPs('-ProfileDir "' + h + '"');
			ckPs("-ProfileDir 参数有效", r.code === 0, "exit=" + r.code + " :: " + r.output.slice(-120));
			const after = fs.readFileSync(patch, "utf8");
			ckPs("-ProfileDir 模式下插件条目写入", after.includes("text-tool-call-recovery"), "");
			ckPs("-ProfileDir 模式下 node_modules 创建",
				fs.existsSync(path.join(h, "node_modules", "@zhaozehao10", "dsh-text-tool-call-recovery", "lib", "index.js")), "");
		}

		// ④⑤ 备份轮转
		{
			const backupDir = path.join(os.tmpdir(), "dsh-install-backup");
			// 先塞一批假的旧备份（用不同时间戳），验证轮转会清掉
			fs.mkdirSync(backupDir, { recursive: true });
			const decoys = [];
			for (let i = 0; i < 15; i++) {
				const name = "cordis.patch.yml.bak-20200101-0000" + String(i).padStart(2, "0");
				const p = path.join(backupDir, name);
				fs.writeFileSync(p, "# decoy " + i + "\n", "utf8");
				decoys.push(p);
			}
			// 一个不该被删的「其他文件」
			const otherFile = path.join(backupDir, "not-a-backup.txt");
			fs.writeFileSync(otherFile, "keep me\n", "utf8");

			const h = path.join(base, "rotation");
			setup(h);
			const r = runPs('-DshHome "' + h + '"');
			ckPs("轮转场景安装成功", r.code === 0, "exit=" + r.code);

			const remaining = fs.readdirSync(backupDir).filter((f) => /^cordis\.patch\.yml\.bak-/.test(f));
			ckPs("备份数量受控（≤ 11）", remaining.length <= 11, "实际 " + remaining.length);
			ckPs("轮转不误删非备份文件", fs.existsSync(otherFile), "not-a-backup.txt 被删了");
			console.log("  剩余备份: " + remaining.length + " 个");

			// 清理 decoys 和 other
			try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}

		try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

﻿// ===========================================================================
// 17. 手动安装路径与脚本等价（缺陷 97）
//
// 前 100 轮只测了**脚本安装**。README 同时给了「手动安装」（不想用脚本时）
// 这条路，但它**从未被测试**，而且实测发现两个问题：
//
//   ① 中文版手动步骤**没提**「必须重启 / 备份 / 自检」——
//      而脚本版全都提了。手动安装的用户装完不重启，会以为「装了没反应」。
//   ② **英文版根本没有手动安装段落**（只有脚本），中英不对等。
//
// 本检查：
//   ① 中文版手动步骤必须包含：重启、备份、自检（node --check）
//   ② 英文版必须有 Manual install 段落，且同样含这三项
//   ③ 手动安装的产物与脚本安装**等价**（真实执行两边并对比）
// ===========================================================================
console.log("\n=== 16. 手动安装路径与脚本等价 ===");
{
	const ckPs = (label, ok, detail) => {
		if (ok) pass++; else { fail++; failures.push(label + (detail ? " :: " + detail : "")); }
		console.log("  " + (ok ? "✅" : "❌") + " " + label + (detail && !ok ? " :: " + detail : ""));
	};

	// ① 中文版手动步骤
	{
		const p = path.join(ROOT, "README.md");
		const lines = fs.readFileSync(p).toString("utf8").split(/\r?\n/);
		let start = -1;
		for (let i = 0; i < lines.length; i++) {
			if (/\*\*手动安装\*\*/.test(lines[i])) { start = i; break; }
		}
		ckPs("中文 README 有「手动安装」段落", start >= 0, "未找到");

		if (start >= 0) {
			let end = lines.length;
			for (let i = start + 1; i < lines.length; i++) {
				if (/^#{2,3}\s/.test(lines[i])) { end = i; break; }
			}
			const section = lines.slice(start, end).join("\n");
			ckPs("手动步骤提到「必须重启」", /必须重启/.test(section), "缺重启说明");
			ckPs("手动步骤提到「备份」", /备份/.test(section), "缺备份说明");
			ckPs("手动步骤提到「自检」(node --check)", /node --check/.test(section), "缺自检命令");
			console.log("  中文手动步骤: " + (end - start) + " 行");
		}
	}

	// ② 英文版
	{
		const p = path.join(ROOT, "README.en.md");
		if (!fs.existsSync(p)) {
			ckPs("英文 README 存在", false, "");
		} else {
			const lines = fs.readFileSync(p).toString("utf8").split(/\r?\n/);
			let start = -1;
			for (let i = 0; i < lines.length; i++) {
				if (/Manual install/i.test(lines[i])) { start = i; break; }
			}
			ckPs("英文 README 有 Manual install 段落", start >= 0, "未找到（中英不对等）");

			if (start >= 0) {
				let end = lines.length;
				for (let i = start + 1; i < lines.length; i++) {
					if (/^#{2,3}\s/.test(lines[i])) { end = i; break; }
				}
				const section = lines.slice(start, end).join("\n");
				ckPs("英文手动步骤提到必须重启", /must restart/i.test(section), "缺重启说明");
				ckPs("英文手动步骤提到备份", /back it up|backup/i.test(section), "缺备份说明");
				ckPs("英文手动步骤提到自检", /node --check|self-check/i.test(section), "缺自检");
				console.log("  英文手动步骤: " + (end - start) + " 行");
			}
		}
	}

	// ③ 真实执行：手动 vs 脚本，产物必须等价
	if (process.platform === "win32" && fs.existsSync(path.join(ROOT, "install-stepfix.ps1"))) {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-manual-vs-script-"));
		try {
			const mk = (name) => {
				const h = path.join(base, name);
				fs.mkdirSync(path.join(h, "profiles", "desktop"), { recursive: true });
				fs.writeFileSync(path.join(h, "profiles", "desktop", "cordis.patch.yml"), "- id: existing\n", "utf8");
				return h;
			};

			// A：脚本安装
			const ha = mk("script");
			try {
				execSync(
					'powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(ROOT, "install-stepfix.ps1") + '" -DshHome "' + ha + '"',
					{ encoding: "utf8", timeout: 120000, stdio: "pipe" }
				);
			} catch { /* 忽略，后面靠产物判断 */ }

			// B：手动安装（严格照 README）
			const hb = mk("manual");
			const destB = path.join(hb, "profiles", "desktop", "node_modules", "@zhaozehao10", "dsh-text-tool-call-recovery");
			fs.mkdirSync(destB, { recursive: true });
			fs.cpSync(path.join(ROOT, "lib"), path.join(destB, "lib"), { recursive: true });
			fs.copyFileSync(path.join(ROOT, "package.json"), path.join(destB, "package.json"));
			const patchB = path.join(hb, "profiles", "desktop", "cordis.patch.yml");
			const blockB = "- insert:\n    - id: text-tool-call-recovery\n      name: \"@zhaozehao10/dsh-text-tool-call-recovery\"\n";
			fs.writeFileSync(patchB, fs.readFileSync(patchB, "utf8") + blockB, "utf8");

			// 对比产物
			const destA = path.join(ha, "profiles", "desktop", "node_modules", "@zhaozehao10", "dsh-text-tool-call-recovery");
			ckPs("脚本安装产出 lib/index.js", fs.existsSync(path.join(destA, "lib", "index.js")), "");
			ckPs("手动安装产出 lib/index.js", fs.existsSync(path.join(destB, "lib", "index.js")), "");

			// 两个 patch 都必须含同样的 insert 块（忽略空白差异）
			const norm = (s) => s.replace(/\r\n/g, "\n").replace(/\n+/g, "\n").trim();
			const patchA = norm(fs.readFileSync(path.join(ha, "profiles", "desktop", "cordis.patch.yml"), "utf8"));
			const patchBNorm = norm(fs.readFileSync(patchB, "utf8"));
			ckPs("手动安装与脚本安装的 patch 语义等价", patchA === patchBNorm,
				patchA === patchBNorm ? "" : "A=" + JSON.stringify(patchA.slice(-120)) + " B=" + JSON.stringify(patchBNorm.slice(-120)));

			// 两者都必须含 insert 形式与插件名
			for (const [name, p] of [["脚本", patchA], ["手动", patchBNorm]]) {
				ckPs(name + "安装的 patch 含 insert 形式", /- insert:/.test(p), "");
				ckPs(name + "安装的 patch 含插件名", p.includes("@zhaozehao10/dsh-text-tool-call-recovery"), "");
			}
		} finally {
			try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	} else {
		console.log("  （非 Windows 或无脚本，跳过产物对比）");
	}
}

console.log(`\n===== 交付物完整性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
