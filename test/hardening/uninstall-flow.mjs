// 完整卸载流程验证（安装 → 卸载 → 重装 → 完全恢复）
//
// **为什么需要**：`install-experience.mjs` 的标题写着「安装/**卸载**体验」，
// 但它对卸载只验证了一句「README 里有卸载说明」—— **实际卸载流程从未被执行过**。
//
// 第 74 轮实测：完整流程走通（11 项断言），但也暴露了真实风险：
//   用 PowerShell 的 `Set-Content -NoNewline` 删两行，会把**整个 YAML 压成一行**
//   → `"# Test profile- id: base  name: ..."` → 配置彻底损坏。
//   已据此改进 README 的卸载说明（优先从备份恢复 + 警告不要用 PowerShell 重写）。
//
// 本套件验证 README 描述的步骤**真的可行**：
//   1. 安装成功
//   2. 按 README 步骤 1 删除 `- insert:` 块后，插件条目消失、原有配置仍在
//   3. 按 README 步骤 2 删除插件目录后，无残留
//   4. 卸载后能重新安装（幂等，只有一条条目）
//
// **注意**：用 `powershell`（5.1），不是 `pwsh`（7，可能没装）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync, execSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(ROOT, "install-stepfix.ps1");
const PS = "powershell";

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

function runPs(args) {
	const r = spawnSync(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], {
		encoding: "utf8", timeout: 120000, env: { ...process.env },
	});
	return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? ""), err: r.error?.message ?? null };
}

// 前置
if (!fs.existsSync(SCRIPT)) {
	console.log("❌ install-stepfix.ps1 不存在");
	process.exit(1);
}
if (runPs(["-Command", "exit 0"]).code !== 0) {
	console.log(`⚠️ ${PS} 不可用，跳过`);
	process.exit(0);
}

const TEST = path.join(os.tmpdir(), "dsh-uninst-test-" + Date.now());
fs.mkdirSync(TEST, { recursive: true });

// 用 Node 删除 insert 块（**不用 PowerShell** —— 那会压扁换行，第 74 轮实测）
function removeInsertBlock(patchText) {
	const lines = patchText.split(/\r?\n/);
	const out = [];
	let skip = 0;
	for (const l of lines) {
		if (/^\s*-\s*insert:\s*$/.test(l)) { skip = 2; continue; }
		if (skip > 0) { skip--; continue; }
		out.push(l);
	}
	return out.join("\r\n");
}

try {
	// ---- 准备 ----
	const prof = path.join(TEST, "prof");
	fs.mkdirSync(prof, { recursive: true });
	const patchPath = path.join(prof, "cordis.patch.yml");
	const ORIGINAL = [
		"# Test profile",
		"- id: base",
		"  name: '@deepseek-ai/dsh-base'",
		"  config:",
		"    agent-default-model: deepseek-v4.1-flash",
		"",
	].join("\r\n");
	fs.writeFileSync(patchPath, ORIGINAL, "utf8");

	// ---- 1. 安装 ----
	console.log("=== 1. 安装 ===");
	const installRes = runPs(["-File", SCRIPT, "-ProfileDir", prof]);
	ck("安装成功（INSTALL OK）", installRes.out.includes("INSTALL OK"), `exit ${installRes.code}`);
	ck("安装脚本打印了备份路径（卸载时可据此无损恢复）",
		/备份位置|backup/i.test(installRes.out), "");
	console.log(`  INSTALL OK: ${installRes.out.includes("INSTALL OK")}`);

	const dest = path.join(prof, "node_modules", "@zhaozehao10", "dsh-text-tool-call-recovery");
	ck("插件目录已创建", fs.existsSync(dest), "");
	let patch = fs.readFileSync(patchPath, "utf8");
	ck("patch 含插件条目", patch.includes("dsh-text-tool-call-recovery"), "");
	console.log(`  安装后 patch: ${patch.length} 字节`);

	// ---- 2. README 步骤 1：删除 insert 块 ----
	console.log("\n=== 2. 按 README 步骤 1 删除 insert 块 ===");
	{
		const before = patch;
		patch = removeInsertBlock(patch);
		fs.writeFileSync(patchPath, patch, "utf8");

		ck("插件条目已删除", !patch.includes("dsh-text-tool-call-recovery"), "");
		ck("原有配置仍在", patch.includes("agent-default-model"), "");
		ck("文件仍是多行（没被压成一行）", patch.split(/\r?\n/).filter((l) => l.trim()).length > 1,
			`${patch.split(/\r?\n/).length} 行`);
		ck("行尾仍是 CRLF（未混入纯 LF）",
			!patch.includes("\n") || patch.split("\n").every((l, i, arr) => i === arr.length - 1 || l.endsWith("\r")),
			"");
		console.log(`  卸载后 patch: ${patch.length} 字节（安装后 ${before.length}）`);
	}

	// ---- 3. README 步骤 2：删除插件目录 ----
	console.log("\n=== 3. 按 README 步骤 2 删除插件目录 ===");
	{
		fs.rmSync(dest, { recursive: true, force: true });
		ck("插件目录已删除", !fs.existsSync(dest), "");

		// 检查无残留
		const remain = [];
		(function walk(d) {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) walk(p);
				else remain.push(path.relative(prof, p));
			}
		})(prof);
		ck("profile 中无插件残留",
			!remain.some((f) => f.includes("text-tool-call-recovery")), remain.join(", "));
		console.log(`  profile 剩余文件: ${remain.join(", ") || "（仅 patch）"}`);
	}

	// ---- 4. 卸载后重新安装 ----
	console.log("\n=== 4. 卸载后重新安装 ===");
	{
		const r = runPs(["-File", SCRIPT, "-ProfileDir", prof]);
		ck("卸载后能重新安装", r.out.includes("INSTALL OK"), `exit ${r.code}`);
		const p2 = fs.readFileSync(patchPath, "utf8");
		const count = (p2.match(/dsh-text-tool-call-recovery/g) ?? []).length;
		ck("重新安装后条目数合理（1–2 处）", count >= 1 && count <= 2, `出现 ${count} 次`);
		console.log(`  重装: ${r.out.includes("INSTALL OK")}, 条目 ${count} 次`);
	}

	// ---- 5. 文档层面：卸载说明必须包含关键警告 ----
	console.log("\n=== 5. 卸载说明的完整性 ===");
	{
		const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
		const readmeEn = fs.readFileSync(path.join(ROOT, "README.en.md"), "utf8");

		const idx = readme.search(/^##\s*六、卸载/m);
		const section = idx >= 0 ? readme.slice(idx, readme.indexOf("\n## ", idx + 10)) : "";

		ck("卸载说明存在", section.length > 0, "");
		ck("卸载说明提到「从备份恢复」（无损路径）",
			/从备份恢复|备份/.test(section), "");
		ck("卸载说明提到插件目录路径",
			/node_modules/.test(section), "");
		ck("卸载说明提到重启", /重启/.test(section), "");
		ck("卸载说明警告不要用 Set-Content/Out-File",
			/Set-Content|Out-File/.test(section), "");
		console.log(`  中文卸载章节: ${section.length} 字符`);

		// 英文版
		const enIdx = readmeEn.search(/^##\s*Uninstall/m);
		const enSection = enIdx >= 0 ? readmeEn.slice(enIdx, readmeEn.indexOf("\n## ", enIdx + 10)) : "";
		ck("英文卸载说明存在", enSection.length > 0, "");
		ck("英文卸载说明警告 Set-Content", /Set-Content/.test(enSection), "");
		console.log(`  英文卸载章节: ${enSection.length} 字符`);
	}

} finally {
	try { fs.rmSync(TEST, { recursive: true, force: true }); } catch { /* ignore */ }
}


// ===========================================================================
// 缺陷 99（第 103 轮）：README 把「从备份恢复」列为**首选**卸载方式，
// 但 uninstall-flow 只测了「手工删 patch 条目」，从未实测过备份恢复。
//
// 同时发现 README 对 Set-Content 的警告**指错了环节**：
//   README 说「Set-Content 会把换行压成一行」——实测**不成立**（行数不变）。
//   真正的问题是 `Get-Content -Raw`（不指定 -Encoding）在 PS 5.1 下按 ANSI/GBK
//   解码 UTF-8 无 BOM 文件 —— **读进来的时候中文就已经坏了**，
//   写回去时再加 BOM，两步叠加才是灾难。
//
// 本检查：
//   ① 端到端：安装 → 从备份恢复 → 必须与安装前**字节完全一致**（无损）
//   ② 恢复后不得含插件条目、必须保留原有中文
//   ③ 文档必须给出可执行的备份恢复命令
//   ④ 文档的警告必须指向**读取**环节（Get-Content），而不是写入环节
// ===========================================================================
console.log("\n=== 从备份恢复（README 首选卸载方式）===");
{
	const scriptPath = path.join(ROOT, "install-stepfix.ps1");

	if (process.platform !== "win32" || !fs.existsSync(scriptPath)) {
		console.log("  （非 Windows 或无脚本，跳过）");
	} else {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-restore-"));
		try {
			const h = path.join(base, "home");
			fs.mkdirSync(path.join(h, "profiles", "desktop"), { recursive: true });
			const patch = path.join(h, "profiles", "desktop", "cordis.patch.yml");

			// 含中文的原始配置（模拟真实场景）
			const original = "# patch layer\n- id: agent-default-model\n  config:\n    name: Deepseek-V4.1-Flash · routing group\n    description: 书生专用模型\n- id: another\n  config:\n    value: 42\n";
			fs.writeFileSync(patch, original, "utf8");
			const originalBytes = fs.readFileSync(patch);

			// 安装
			let backupPath = null;
			// 用临时文件捕获脚本输出（execSync 的 stdio:pipe 在某些情况下拿不到 stdout）
			const outFile = path.join(base, "install-output.txt");
			const errFile = path.join(base, "install-error.txt");
			try {
				execSync(
					'powershell -NoProfile -ExecutionPolicy Bypass -File "' + scriptPath + '" -DshHome "' + h + '" > "' + outFile + '" 2> "' + errFile + '"',
					{ timeout: 120000, stdio: "ignore" }
				);
			} catch { /* 非 0 退出也继续，靠后面的产物断言 */ }

			let combined = "";
			for (const f of [outFile, errFile]) {
				if (fs.existsSync(f)) combined += fs.readFileSync(f, "utf8");
			}
			const bm = combined.match(/backup\s*->\s*(.+)/);
			if (bm) backupPath = bm[1].trim();

			ck("安装产生了备份文件", backupPath !== null && fs.existsSync(backupPath), String(backupPath));
			ck("安装后 patch 含插件条目", fs.readFileSync(patch, "utf8").includes("text-tool-call-recovery"));

			// 从备份恢复（这是 README 的首选方式）
			if (backupPath && fs.existsSync(backupPath)) {
				fs.copyFileSync(backupPath, patch);
				const restoredBytes = fs.readFileSync(patch);
				const restored = restoredBytes.toString("utf8");

				ck("从备份恢复后与安装前字节完全一致（无损）", originalBytes.equals(restoredBytes),
					originalBytes.length + " vs " + restoredBytes.length);
				ck("从备份恢复后不再含插件条目", !restored.includes("text-tool-call-recovery"));
				ck("从备份恢复后原有中文完好", restored.includes("书生专用模型"),
					restored.includes("涔") ? "中文已损坏" : "未找到中文");
				ck("从备份恢复后原有其他条目完好",
					restored.includes("agent-default-model") && restored.includes("another"));
			}
		} finally {
			try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	}
}

console.log("\n=== 卸载文档的编码警告准确性 ===");
{
	const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

	ck("README 给出可执行的备份恢复命令",
		/Copy-Item .*bak|Copy-Item .*<备份路径>/.test(readme), "缺 Copy-Item 命令");
	ck("README 说明恢复是「字节完全一致」的",
		/字节完全一致/.test(readme), "缺无损证明");
	ck("README 的警告指向「读取」环节（Get-Content 按 ANSI 解码）",
		/Get-Content[^\\n]*ANSI|Get-Content[^\\n]*GBK|读进来的时候中文就已经坏了/.test(readme),
		"警告没有指向读取环节");
	// 只检查**非缺陷表**的正文（缺陷表里的 D66 是历史记录，保留是正确的）
	const prose = readme.split("\n").filter((l) => !/^\| \d+ \|/.test(l)).join("\n");
	ck("README 正文不再声称「Set-Content 压成一行」（该说法不成立）",
		!/Set-Content[^\n]*压成一行/.test(prose), "正文仍在声称会压成一行");
	ck("README 给出显式 UTF-8 的安全写法",
		readme.includes("[System.IO.File]::ReadAllText") && readme.includes("[System.IO.File]::WriteAllText"),
		"缺 .NET 写法");
}
console.log(`\n===== 卸载流程: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
