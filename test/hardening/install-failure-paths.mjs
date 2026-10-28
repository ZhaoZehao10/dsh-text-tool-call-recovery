// 安装脚本的失败场景与幂等性
//
// **为什么需要**：`install-experience.mjs`（33 项）覆盖了**成功路径**——
// 编码、语法、真正跑一遍、产物检查、patch 形态。但它**没有覆盖失败路径**，
// 而这些才是用户实际会遇到的：
//
//   1. **profile 目录不存在**（DSH 从未启动过 / 路径写错）
//      → 必须给出「请确认 DSH 已至少启动过一次」这种可操作的提示，
//        而不是 PowerShell 异常栈
//   2. **cordis.patch.yml 缺失**（profile 不完整）
//      → 必须清晰报错，而不是静默创建或崩栈
//   3. **重复运行**（用户不确定装没装，再跑一次）
//      → 必须幂等，不能注册两条插件条目
//
// 第 72 轮实测：三个场景全部正确（14 项断言通过）。
//
// **注意**：必须用 `powershell`（5.1，Windows 自带），不是 `pwsh`（7，可能没装）。
// 第 72 轮踩过这个坑 —— 用 `pwsh` 时所有场景都返回 ENOENT，看起来像脚本全挂。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(ROOT, "install-stepfix.ps1");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const PS = "powershell";

function runPs(args, cwd) {
	const r = spawnSync(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], {
		encoding: "utf8", timeout: 120000, cwd: cwd ?? undefined, env: { ...process.env },
	});
	return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? ""), err: r.error?.message ?? null };
}

// 前置：脚本存在 + PowerShell 可用
if (!fs.existsSync(SCRIPT)) {
	console.log("❌ install-stepfix.ps1 不存在");
	process.exit(1);
}
const probe = runPs(["-Command", "exit 0"]);
if (probe.code !== 0) {
	console.log(`⚠️ ${PS} 不可用（${probe.err ?? probe.code}），跳过`);
	process.exit(0);
}

const TEST_ROOT = path.join(os.tmpdir(), "dsh-inst-test-" + Date.now());
fs.mkdirSync(TEST_ROOT, { recursive: true });

try {
	// =======================================================================
	// 1. profile 目录不存在 → 可操作的错误提示
	// =======================================================================
	console.log("=== 1. ProfileDir 不存在 ===");
	{
		const ghost = path.join(TEST_ROOT, "no-such-profile");
		const r = runPs(["-File", SCRIPT, "-ProfileDir", ghost]);
		console.log(`  退出码: ${r.code}`);
		for (const l of r.out.split(/\r?\n/).filter((x) => x.trim()).slice(0, 4)) {
			console.log(`    ${l.slice(0, 100)}`);
		}

		ck("给出「profile 目录不存在」错误", /profile 目录不存在/.test(r.out), r.out.slice(0, 100));
		ck("错误里含可操作建议（启动过 DSH 或指定路径）",
			/请确认 DSH 已至少启动过|ProfileDir/.test(r.out), "");
		ck("非零退出", r.code !== 0, `exit ${r.code}`);
		ck("不暴露 PowerShell 异常栈",
			!/MethodInvocationException|CategoryInfo|FullyQualifiedErrorId/.test(r.out), "");
	}

	// =======================================================================
	// 2. cordis.patch.yml 缺失 → 清晰报错
	// =======================================================================
	console.log("\n=== 2. cordis.patch.yml 缺失 ===");
	{
		const prof = path.join(TEST_ROOT, "prof-nopatch");
		fs.mkdirSync(prof, { recursive: true });
		const r = runPs(["-File", SCRIPT, "-ProfileDir", prof]);
		console.log(`  退出码: ${r.code}`);
		for (const l of r.out.split(/\r?\n/).filter((x) => x.trim()).slice(0, 4)) {
			console.log(`    ${l.slice(0, 100)}`);
		}

		ck("给出「找不到 patch 文件」错误", /找不到.*cordis\.patch\.yml|找不到/.test(r.out), "");
		ck("非零退出", r.code !== 0, `exit ${r.code}`);
		ck("不在 profile 里留下半成品",
			!fs.existsSync(path.join(prof, "node_modules")), "");
	}

	// =======================================================================
	// 3. 正常安装 + 幂等性
	// =======================================================================
	console.log("\n=== 3. 正常安装 + 幂等性 ===");
	{
		const prof = path.join(TEST_ROOT, "prof-ok");
		fs.mkdirSync(prof, { recursive: true });
		fs.writeFileSync(path.join(prof, "cordis.patch.yml"), [
			"# Test profile",
			"- id: base",
			"  name: '@deepseek-ai/dsh-base'",
			"  config:",
			"    agent-default-model: deepseek-v4.1-flash",
			"",
		].join("\r\n"), "utf8");

		const r = runPs(["-File", SCRIPT, "-ProfileDir", prof]);
		console.log(`  退出码: ${r.code}`);
		for (const l of r.out.split(/\r?\n/).filter((x) => x.trim()).slice(0, 14)) {
			console.log(`    ${l.slice(0, 100)}`);
		}

		ck("安装成功（INSTALL OK）", r.out.includes("INSTALL OK"), `exit ${r.code}`);
		ck("提示需要重启", /重启/.test(r.out), "");

		const dest = path.join(prof, "node_modules", "@zhaozehao10", "dsh-text-tool-call-recovery");
		ck("插件已复制", fs.existsSync(path.join(dest, "lib", "index.js")), "");
		ck("package.json 已复制", fs.existsSync(path.join(dest, "package.json")), "");

		if (fs.existsSync(path.join(dest, "lib", "index.js"))) {
			const a = fs.readFileSync(path.join(ROOT, "lib", "index.js"));
			const b = fs.readFileSync(path.join(dest, "lib", "index.js"));
			ck("复制的插件与源码字节一致", a.equals(b), `${a.length} vs ${b.length}`);
		}

		const patchPath = path.join(prof, "cordis.patch.yml");
		const patch = fs.readFileSync(patchPath, "utf8");
		ck("patch 含插件条目", patch.includes("dsh-text-tool-call-recovery"), "");
		ck("patch 使用 insert 形式（普通条目会被静默跳过）", /insert:/.test(patch), "");
		ck("原有配置未被破坏", patch.includes("agent-default-model"), "");

		// 幂等
		const r2 = runPs(["-File", SCRIPT, "-ProfileDir", prof]);
		const patch2 = fs.readFileSync(patchPath, "utf8");
		const c1 = (patch.match(/dsh-text-tool-call-recovery/g) ?? []).length;
		const c2 = (patch2.match(/dsh-text-tool-call-recovery/g) ?? []).length;
		console.log(`  幂等: 条目数 ${c1} → ${c2}`);
		ck("重复运行不重复注册（幂等）", c1 === c2, `${c1} → ${c2}`);
		ck("重复运行仍成功", r2.code === 0, `exit ${r2.code}`);

		// 备份文件应写到系统临时目录（不污染仓库/profile）
		ck("备份不写入 profile 目录",
			!fs.readdirSync(prof).some((f) => f.includes(".bak")), "");
	}
} finally {
	try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n===== 安装失败场景与幂等性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
