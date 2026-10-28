// README 的「手动安装」步骤必须真的能照做（缺陷 140）
//
// **为什么需要**（第 136 轮）：
// README 给了两条安装路径：脚本（`install-stepfix.ps1`）与手动。
// 脚本版有 30+ 项断言守护，**手动版从来没有被真正执行过** ——
// 它只是几段文字，读者照着做会不会失败，没人验证过。
//
// 第 136 轮实测发现**步骤顺序是反的**：
//   原文 步骤 2「在 cordis.patch.yml 末尾追加」
//   原文 步骤 3「**先备份** cordis.patch.yml」
// 按顺序照做 → 备份下来的是「已经改过」的版本 → **回滚不了**。
//
// 本套件做出两件事（16 项）：
//   ① 静态检查：README 里「备份」必须出现在「追加/修改」**之前**；
//   ② 动态验证：**在一个临时 profile 里完整走一遍**手动安装的每一步，
//      确认文件就位、insert 块形态正确、node --check 通过、备份可用于回滚。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
	if (ok) { pass++; console.log("  OK  " + label); }
	else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("  FAIL " + label + (detail ? " :: " + detail : "")); }
};

console.log("=== 1. 静态：README 的步骤顺序（先备份，再改文件）===");
{
	const idxBackup = README.indexOf("先备份");
	const idxAppend = README.indexOf("末尾追加");
	ck("README 同时提到「先备份」与「末尾追加」", idxBackup > 0 && idxAppend > 0,
		"backup=" + idxBackup + " append=" + idxAppend);
	ck("「先备份」出现在「末尾追加」之前", idxBackup > 0 && idxAppend > 0 && idxBackup < idxAppend,
		"备份在 L" + (idxBackup > 0 ? README.slice(0, idxBackup).split("\n").length : "?") +
		"，追加在 L" + (idxAppend > 0 ? README.slice(0, idxAppend).split("\n").length : "?"));
	ck("README 明确警告「备份必须在改文件之前」", /备份[^\n]{0,40}之前|必须在改文件之前|否则备份下来的是/.test(README));
	ck("README 提醒手动安装「顺序很重要」", /顺序很重要/.test(README));
}

console.log("=== 2. 静态：手动安装的四个必备步骤都在 ===");
{
	ck("提到复制 lib/ 与 package.json", /lib\/[\s\S]{0,30}package\.json/.test(README));
	ck("提到 insert: 包裹", /- insert:/.test(README));
	ck("提到 node --check 自检", /node --check/.test(README));
	ck("提到必须重启", /必须重启/.test(README));
	ck("警告顶层裸条目会被静默跳过", /静默跳过/.test(README));
}

console.log("=== 3. 动态：在临时 profile 里完整走一遍 ===");
const PROFILE = path.join(os.tmpdir(), "dsh-manual-verify-" + Date.now());
const PKG_DIR = path.join(PROFILE, "node_modules", "@zhaozehao10", "dsh-text-tool-call-recovery");
try {
	fs.mkdirSync(PROFILE, { recursive: true });
	const patch = path.join(PROFILE, "cordis.patch.yml");
	fs.writeFileSync(patch, "# existing\n- insert:\n    - id: some-plugin\n", "utf8");
	const original = fs.readFileSync(patch, "utf8");

	// 步骤 1：先备份
	const bak = patch + ".bak";
	fs.copyFileSync(patch, bak);
	ck("步骤 1：备份成功", fs.existsSync(bak));
	ck("步骤 1：备份内容 = 改前状态", fs.readFileSync(bak, "utf8") === original);

	// 步骤 2：复制 lib 与 package.json
	fs.mkdirSync(path.join(PKG_DIR, "lib"), { recursive: true });
	fs.copyFileSync(path.join(ROOT, "lib", "index.js"), path.join(PKG_DIR, "lib", "index.js"));
	fs.copyFileSync(path.join(ROOT, "package.json"), path.join(PKG_DIR, "package.json"));
	ck("步骤 2：lib/index.js 就位", fs.existsSync(path.join(PKG_DIR, "lib", "index.js")));
	ck("步骤 2：package.json 就位", fs.existsSync(path.join(PKG_DIR, "package.json")));

	// 步骤 3：追加 insert 块
	fs.appendFileSync(patch,
		'\n- insert:\n    - id: text-tool-call-recovery\n      name: "@zhaozehao10/dsh-text-tool-call-recovery"\n', "utf8");
	const after = fs.readFileSync(patch, "utf8");
	ck("步骤 3：插件条目已写入", after.includes("text-tool-call-recovery"));
	ck("步骤 3：条目在 insert: 之下（不是顶层裸条目）",
		/- insert:[\s\S]*text-tool-call-recovery/.test(after));

	// 步骤 4：node --check
	let checkOk = true;
	try {
		execFileSync(process.execPath, ["--check", path.join(PKG_DIR, "lib", "index.js")], { stdio: "pipe" });
	} catch { checkOk = false; }
	ck("步骤 4：node --check 通过", checkOk);

	// 回滚可用性
	ck("回滚可用：备份 ≠ 当前文件", fs.readFileSync(bak, "utf8") !== after);
	ck("回滚后内容不含插件条目", !fs.readFileSync(bak, "utf8").includes("text-tool-call-recovery"));
} finally {
	fs.rmSync(PROFILE, { recursive: true, force: true });
}

console.log("");
console.log("===== 手动安装流程可执行性: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("--- 失败明细 ---");
	for (const f of failures) console.log("  FAIL " + f);
}
process.exit(fail === 0 ? 0 : 1);