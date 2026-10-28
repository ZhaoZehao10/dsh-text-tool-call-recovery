// 卸载步骤必须「两步都做」且与备份恢复一致（缺陷 141）
//
// **为什么需要**（第 137 轮）：
// 第 136 轮用「新用户视角」走手动安装，发现了步骤顺序错误。
// 第 137 轮把同一视角用到**卸载**上，发现第 4 节里那条命令
// **只删插件目录、不删 cordis.patch.yml 条目**，而它上面的注释
// 却写「删除插件目录 + 移除 patch 条目」——**注释与实际命令不符**。
//
// 后果：Cordis Loader 下次启动仍会尝试加载那个条目，而目录已不存在。
// 具体表现取决于 Loader 版本（报错或被静默跳过），但**都不是干净卸载**。
//
// 本套件验证（17 项）：
//   ① 中文/英文 README 的卸载说明都要求「两步」（移除 patch 条目 + 删目录）；
//   ② 第 4 节那条命令块里**必须同时出现** `cordis.patch.yml` 与 `Remove-Item`；
//   ③ 动态验证：只删目录确实会留下悬空条目；两步都做才是干净的。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const README_EN = fs.readFileSync(path.join(ROOT, "README.en.md"), "utf8");

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
	if (ok) { pass++; console.log("  OK  " + label); }
	else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("  FAIL " + label + (detail ? " :: " + detail : "")); }
};

console.log("=== 1. 中文 README：第 4 节的卸载命令块必须同时含两步 ===");
{
	// 定位「### 临时禁用 / 卸载」到下一个 ### 之间
	const start = README.indexOf("### 临时禁用 / 卸载");
	const end = README.indexOf("\n### ", start + 10);
	const section = start >= 0 ? README.slice(start, end < 0 ? undefined : end) : "";
	ck("找到「临时禁用 / 卸载」小节", section.length > 0, "未找到");

	// 找该小节里的 powershell 卸载命令块
	// **修正**：README 里代码围栏前的缩进为空，但块内可能含多个命令；
	// 用更宽松的匹配（允许围栏后直接换行）。
	const blocks = [...section.matchAll(/```powershell\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
	console.log("    找到 " + blocks.length + " 个 powershell 块");
	for (const b of blocks) console.log("      - 含 Remove-Item: " + b.includes("Remove-Item") + ", 含插件名: " + b.includes("dsh-text-tool-call-recovery"));
	// **修正**：块内同时出现 `Remove-Item` 与插件名即可（它们可能不在同一行 ——
	// 命令块里 \`<profile>\` 是占位符，插件名跟在后面）。
	const uninstallBlock = blocks.find((b) => b.includes("Remove-Item") && b.includes("dsh-text-tool-call-recovery"));
	ck("卸载小节里有 Remove-Item 命令块", uninstallBlock !== undefined, "未找到");
	if (uninstallBlock) {
		ck("该命令块**同时**提到 cordis.patch.yml（先移除条目）",
			uninstallBlock.includes("cordis.patch.yml"), "只删目录，没删条目");
		ck("该命令块声明「分两步」", /分两步|两步都要做|两步/.test(uninstallBlock), "未说明两步");
	}
	ck("正文警告「只删目录会留悬空条目」", /悬空|只删目录/.test(section));
	ck("指向第六节完整步骤", /第六节/.test(section));
}

console.log("=== 2. 英文 README：Uninstall 必须包含三步以上 ===");
{
	const start = README_EN.indexOf("## Uninstall");
	const end = README_EN.indexOf("\n## ", start + 5);
	const section = start >= 0 ? README_EN.slice(start, end < 0 ? undefined : end) : "";
	ck("找到 ## Uninstall", section.length > 0);
	ck("要求从备份恢复", /restore from the backup/i.test(section));
	ck("要求手工删 insert 两行", /delete the two lines/i.test(section) || /- insert:/.test(section));
	// **修正**：英文版可能写成 "Delete `node_modules/...`" 或 "delete the plugin directory"。
	ck("要求删除插件目录", /Delete\s+[`"]?node_modules\/@zhaozehao10\/dsh-text-tool-call-recovery|delete the plugin directory/i.test(section), section.slice(0, 200));
	ck("要求重启", /Restart the app/i.test(section));
	ck("编码警告指向「读入时」而非「换行被压」", /already corrupted on the way in|decodes it as \*\*ANSI\/GBK\*\*/i.test(section));
	ck("不再声称「Set-Content 压成一行」", !/collapse the remaining line breaks into one long line/i.test(section));
}

console.log("=== 3. 动态：只删目录 vs 两步都做 ===");
const PROFILE = path.join(os.tmpdir(), "dsh-uninstall-verify-" + Date.now());
const PKG_DIR = path.join(PROFILE, "node_modules", "@zhaozehao10", "dsh-text-tool-call-recovery");
try {
	const ENTRY = '\n- insert:\n    - id: text-tool-call-recovery\n      name: "@zhaozehao10/dsh-text-tool-call-recovery"\n';
	const patch = path.join(PROFILE, "cordis.patch.yml");

	const install = () => {
		fs.mkdirSync(path.join(PKG_DIR, "lib"), { recursive: true });
		fs.copyFileSync(path.join(ROOT, "lib", "index.js"), path.join(PKG_DIR, "lib", "index.js"));
		fs.copyFileSync(path.join(ROOT, "package.json"), path.join(PKG_DIR, "package.json"));
		fs.writeFileSync(patch, ENTRY, "utf8");
	};

	// 场景 A：只删目录
	fs.mkdirSync(PROFILE, { recursive: true });
	install();
	fs.rmSync(PKG_DIR, { recursive: true, force: true });
	ck("只删目录后：目录不存在", !fs.existsSync(PKG_DIR));
	ck("只删目录后：patch 仍指向它（悬空条目）", fs.readFileSync(patch, "utf8").includes("text-tool-call-recovery"));

	// 场景 B：两步都做
	install();
	fs.rmSync(PKG_DIR, { recursive: true, force: true });
	let yaml = fs.readFileSync(patch, "utf8");
	yaml = yaml.replace(/\n- insert:\s*\n\s*- id: text-tool-call-recovery\s*\n\s*name: "@zhaozehao10\/dsh-text-tool-call-recovery"\s*\n?/, "\n");
	fs.writeFileSync(patch, yaml, "utf8");
	ck("两步都做后：目录不存在", !fs.existsSync(PKG_DIR));
	ck("两步都做后：patch 条目已移除（干净）", !fs.readFileSync(patch, "utf8").includes("text-tool-call-recovery"));
} finally {
	fs.rmSync(PROFILE, { recursive: true, force: true });
}

console.log("");
console.log("===== 卸载完整性: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("--- 失败明细 ---");
	for (const f of failures) console.log("  FAIL " + f);
}
process.exit(fail === 0 ? 0 : 1);