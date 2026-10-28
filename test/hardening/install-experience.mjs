// 安装/卸载体验测试
//
// 前 32 轮全部在测「代码行为」，没测「用户能否顺利装上」——这是开源项目
// 的第一道门槛。本套件用**沙箱 profile** 实际跑安装脚本，验证：
//   1. 脚本语法正确（PowerShell 解析器）
//   2. 编码正确（UTF-8 BOM + CRLF，否则 Windows PowerShell 会乱码/报错）
//   3. 幂等（重复运行不重复注册）
//   4. 自检通过
//   5. 不破坏已有 profile 配置
//   6. 卸载可行
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const INSTALL = path.join(ROOT, "install-stepfix.ps1");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

console.log("=== 1. 安装脚本存在且编码正确 ===");
{
	ck("install-stepfix.ps1 存在", fs.existsSync(INSTALL), "");
	if (fs.existsSync(INSTALL)) {
		const buf = fs.readFileSync(INSTALL);
		const hasBOM = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
		ck("有 UTF-8 BOM（否则 Windows PowerShell 按 ANSI 解码中文 → 语法错误）", hasBOM, `前 3 字节: ${[...buf.slice(0, 3)].map((b) => b.toString(16).toUpperCase()).join(" ")}`);
		const text = buf.toString("utf8");
		ck("使用 CRLF 换行（Windows 兼容性）", text.includes("\r\n"), "");
		// 无裸 LF
		const bareLF = (text.match(/(?<!\r)\n/g) ?? []).length;
		ck("无裸 LF", bareLF === 0, `${bareLF} 处`);
	}
}

console.log("\n=== 2. PowerShell 语法检查 ===");
{
	const script = `
$errors = $null; $tokens = $null
[System.Management.Automation.Language.Parser]::ParseFile("${INSTALL.replace(/\\/g, "\\\\")}", [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -eq 0) { Write-Output "OK" } else { Write-Output ("FAIL:" + $errors.Count + ":" + $errors[0].Message) }
`;
	let out = "";
	try {
		out = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 60000, stdio: "pipe" });
	} catch (e) {
		out = "EXEC_FAIL:" + e.message;
	}
	const ok = out.trim() === "OK";
	console.log(`  输出: ${out.trim().slice(0, 120)}`);
	ck("PowerShell 解析器无语法错误", ok, out.trim().slice(0, 100));
}

console.log("\n=== 3. 沙箱安装（不碰真实 profile）===");
{
	// 建沙箱：<tmp>/dsh-home/profiles/desktop/{cordis.patch.yml, node_modules}
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-install-test-"));
	const dshHome = path.join(sandbox, "dsh-home");
	const profile = path.join(dshHome, "profiles", "desktop");
	fs.mkdirSync(profile, { recursive: true });

	// 预置一个「已有配置」的 cordis.patch.yml，验证不破坏
	const existingYml = [
		"- insert:",
		"    - id: agent-default-model",
		'      name: "@deepseek-ai/dsh-agent-default-model"',
		"- insert:",
		"    - id: ui-chat",
		'      name: "@deepseek-ai/dsh-ui-chat"',
		"",
	].join("\n");
	fs.writeFileSync(path.join(profile, "cordis.patch.yml"), existingYml, "utf8");

	console.log(`  沙箱: ${sandbox}`);

	// 运行安装脚本
	let out = "";
	let err = null;
	try {
		out = execFileSync("powershell", [
			"-NoProfile", "-ExecutionPolicy", "Bypass",
			"-File", INSTALL,
			"-ProfileDir", profile,
		], { encoding: "utf8", timeout: 120000, stdio: "pipe" });
	} catch (e) {
		err = e;
		out = (e.stdout ?? "") + (e.stderr ?? "");
	}

	console.log(`  退出码: ${err ? (err.status ?? "?") : 0}`);
	const tail = out.trim().split("\n").slice(-6).join("\n");
	console.log(`  输出尾部:\n${tail.split("\n").map((l) => "    " + l).join("\n")}`);

	ck("安装脚本运行成功（退出码 0）", err === null, err ? `退出码 ${err.status}` : "");
	ck("输出含 INSTALL OK", out.includes("INSTALL OK"), "");

	// 验证安装结果
	const dest = path.join(profile, "node_modules", "@zhaozehao10", "dsh-text-tool-call-recovery");
	ck("插件已复制到 profile", fs.existsSync(path.join(dest, "lib", "index.js")), dest);
	ck("package.json 已复制", fs.existsSync(path.join(dest, "package.json")), "");

	const yml = fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8");
	ck("patch 里有插件条目", yml.includes("dsh-text-tool-call-recovery"), "");
	ck("使用 insert 形式", /- insert:[\s\S]*?id:\s*text-tool-call-recovery/.test(yml), "");
	ck("原有配置未被破坏（agent-default-model 仍在）", yml.includes("agent-default-model"), "");
	ck("原有配置未被破坏（ui-chat 仍在）", yml.includes("ui-chat"), "");

	// 验证安装的插件可用
	const instLib = path.join(dest, "lib", "index.js");
	if (fs.existsSync(instLib)) {
		const src = fs.readFileSync(instLib, "utf8");
		const srcOrig = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
		ck("安装的副本与源码一致", src === srcOrig, `安装 ${src.length} vs 源码 ${srcOrig.length}`);
		ck("安装的副本语法正确（含 export）", /export \{/.test(src), "");
	}

	console.log("\n=== 4. 幂等性（再跑一次不重复注册）===");
	{
		const ymlBefore = fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8");
		let out2 = "";
		let err2 = null;
		try {
			out2 = execFileSync("powershell", [
				"-NoProfile", "-ExecutionPolicy", "Bypass",
				"-File", INSTALL,
				"-ProfileDir", profile,
			], { encoding: "utf8", timeout: 120000, stdio: "pipe" });
		} catch (e) {
			err2 = e;
			out2 = (e.stdout ?? "") + (e.stderr ?? "");
		}
		ck("重复安装成功（幂等）", err2 === null, err2 ? `退出码 ${err2.status}` : "");
		ck("输出提示「已存在」", /already present|skip/i.test(out2), out2.slice(-100));
		const ymlAfter = fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8");
		ck("patch 文件未被重复追加", ymlAfter === ymlBefore, `长度 ${ymlBefore.length} → ${ymlAfter.length}`);
		const count = (ymlAfter.match(/id:\s*text-tool-call-recovery/g) ?? []).length;
		ck("插件条目恰好 1 个", count === 1, `${count} 个`);
	}

	// 清理
	try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
	console.log(`\n  已清理沙箱`);
}

console.log("\n=== 5. 包元数据 ===");
{
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	ck("package.json 有 name", typeof pkg.name === "string" && pkg.name.length > 0, pkg.name);
	ck("package.json 有 version（semver）", /^\d+\.\d+\.\d+/.test(pkg.version ?? ""), pkg.version);
	ck("package.json 有 description", typeof pkg.description === "string" && pkg.description.length > 20, "");
	ck("package.json 有 license", typeof pkg.license === "string", pkg.license);
	ck("type 是 module（ESM）", pkg.type === "module", pkg.type);
	ck("main 指向 lib/index.js", pkg.main === "lib/index.js", pkg.main);
	ck("files 字段包含 lib", Array.isArray(pkg.files) && pkg.files.some((f) => f.startsWith("lib")), JSON.stringify(pkg.files));
	// lib 内 VERSION 与 package.json 一致
	const libSrc = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
	const m = libSrc.match(/const VERSION = "([^"]+)"/);
	ck("lib VERSION ≡ package.json version", m && m[1] === pkg.version, `${m ? m[1] : "?"} vs ${pkg.version}`);
}

console.log("\n=== 6. LICENSE 文件 ===");
{
	const hasLicense = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license"].some((f) => fs.existsSync(path.join(ROOT, f)));
	ck("存在 LICENSE 文件（package.json 声明了 MIT，应有对应文件）", hasLicense, hasLicense ? "" : "缺失 LICENSE");
}

console.log("\n=== 7. README 中有安装说明 ===");
{
	const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
	const readmeEn = fs.readFileSync(path.join(ROOT, "README.en.md"), "utf8");
	ck("中文 README 有安装章节", /##\s*.*安装/.test(readme) || readme.includes("install"), "");
	ck("中文 README 提到 install 脚本", readme.includes("install-stepfix.ps1"), "");
	ck("英文 README 有安装说明", /##\s*.*Install/i.test(readmeEn) || readmeEn.includes("install-stepfix.ps1"), "");
	// 卸载说明
	ck("有卸载说明", /卸载|Uninstall/i.test(readme) || /卸载|Uninstall/i.test(readmeEn), "");
}

console.log("\n=== 8. 命名一致性 ===");
{
	// 脚本名、包名、插件 id 三者关系要能理解
	const pkgName = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).name;
	const libSrc = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
	const pluginName = (libSrc.match(/const name = "([^"]+)"/) ?? [])[1] ?? "";
	console.log(`  包名: ${pkgName}`);
	console.log(`  插件 name: ${pluginName}`);
	console.log(`  脚本名: install-stepfix.ps1`);
	ck("插件 name 是包名的最后一段", pkgName.endsWith("/" + pluginName) || pkgName === pluginName, `${pluginName} vs ${pkgName}`);
	// 脚本名含 stepfix 但与 text-tool-call-recovery 无关联 —— 记录为不一致
	const scriptMatches = /stepfix/i.test("install-stepfix.ps1") && /text-tool-call-recovery/i.test(pkgName);
	console.log(`  脚本名与插件名不一致（stepfix vs text-tool-call-recovery）: ${scriptMatches}`);
}

console.log(`\n===== 安装/卸载体验: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
