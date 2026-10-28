// 安装校验（公开版）：确认插件已正确装入 DSH profile 且 patch 条目形式正确。
//
// 用法：
//   node verify-install.cjs [profile-dir]
//   - profile-dir 默认取 $DSH_HOME/profiles/desktop，也可传任意 profile 路径。
//
// 校验内容：bare specifier 可从 profile 目录解析、包结构完整、
// cordis.patch.yml 使用 insert 形式（否则会被 applyEntryPatches 静默跳过）、
// 原有条目完好、未给 profile 引入注册表依赖。
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

// 解析 profile 目录，优先级：
//   1) 命令行第一个参数
//   2) $DSH_HOME/profiles/desktop
//   3) ~/.dsh/profiles/desktop（与 install-stepfix.ps1 的回退逻辑一致）
const os = require("node:os");
const profileDir =
	process.argv[2]
	?? (process.env.DSH_HOME
		? path.join(process.env.DSH_HOME, "profiles", "desktop")
		: path.join(os.homedir(), ".dsh", "profiles", "desktop"));

if (!fs.existsSync(profileDir)) {
	console.error("ERROR: profile directory not found: " + profileDir);
	console.error("");
	console.error("  Usage:");
	console.error("    node test/verify-install.cjs [profile-dir]");
	console.error("");
	console.error("  Or set DSH_HOME to your .dsh directory.");
	console.error("  If DSH has never been started, the profile does not exist yet —");
	console.error("  start DeepSeek Harness once, then re-run this check.");
	process.exit(1);
}
const pkgName = "@zhaozehao10/dsh-text-tool-call-recovery";

let failed = 0;
function check(label, cond, detail) {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${cond ? "" : " :: " + detail}`);
	if (!cond) failed += 1;
}

// 1) bare specifier 可从 profile 目录解析（与宿主 loader 相同的 node_modules 向上查找）
const base = path.join(profileDir, "cordis.yml");
const req = createRequire(base);
try {
	const resolved = req.resolve(pkgName);
	check("bare specifier 可从 profile 目录解析", resolved.includes("dsh-text-tool-call-recovery"), resolved);
	check("解析到 profile 内的副本", resolved.startsWith(path.join(profileDir, "node_modules")), resolved);
} catch (error) {
	check("bare specifier 可从 profile 目录解析", false, error.message);
}

// 2) 包结构完整
const pkgPath = path.join(profileDir, "node_modules", ...pkgName.split("/"), "package.json");
check("package.json 存在", fs.existsSync(pkgPath));
let pkg = {};
if (fs.existsSync(pkgPath)) {
	pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
	check("name 与 patch 条目一致", pkg.name === pkgName, pkg.name);
	check("main 指向存在的文件", fs.existsSync(path.join(path.dirname(pkgPath), pkg.main ?? "lib/index.js")), pkg.main);
}

// 3) patch 条目结构（必须是 insert 形式，否则会被 applyEntryPatches 静默跳过）
const patchPath = path.join(profileDir, "cordis.patch.yml");
if (fs.existsSync(patchPath)) {
	const patch = fs.readFileSync(patchPath, "utf8");
	const insertRe = /- insert:\s*\n\s*- id: text-tool-call-recovery\s*\n\s*name: "@zhaozehao10\/dsh-text-tool-call-recovery"/;
	check("cordis.patch.yml 含 insert 形式条目", insertRe.test(patch), insertRe.test(patch) ? "" : "entry must use the insert form");
	check("原有条目未被破坏（llm-pi-ai 仍在）", patch.includes('- id: llm-pi-ai'));
	check("原有条目未被破坏（agent-default-model 仍在）", patch.includes('- id: agent-default-model'));
} else {
	check("cordis.patch.yml 存在", false, patchPath);
}

// 4) 本插件**不应**被写进 profile 的 dependencies
//    （正确做法是通过 cordis.patch.yml 的 insert 条目加载，不污染 profile 的依赖表）
//
//    **缺陷 43**：早期版本写的是「profile 的 package.json 不能有任何 dependencies」，
//    这会把用户**其他插件**也算成失败 —— 任何装了别的插件的用户都会看到误报。
//    正确判据：只看**本插件包名**是否出现。
try {
	const profilePkgPath = path.join(profileDir, "package.json");
	if (fs.existsSync(profilePkgPath)) {
		const profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, "utf8"));
		const deps = {
			...(profilePkg.dependencies ?? {}),
			...(profilePkg.devDependencies ?? {}),
			...(profilePkg.peerDependencies ?? {}),
		};
		check(
			"本插件未被写进 profile 的 dependencies",
			!(pkgName in deps),
			JSON.stringify(deps),
		);
		const others = Object.keys(deps).filter((k) => k !== pkgName);
		if (others.length > 0) {
			console.log("INFO profile 里还有其他依赖（与本插件无关，正常）: " + others.join(", "));
		}
	} else {
		console.log("INFO profile 无 package.json，跳过依赖表检查");
	}
} catch (error) {
	console.log("INFO 无法读取 profile package.json: " + error.message);
}

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
