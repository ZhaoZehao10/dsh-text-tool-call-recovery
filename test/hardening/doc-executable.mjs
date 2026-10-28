// 文档可执行性审查
//
// 前 35 轮验证了代码行为，但从未验证文档里的**命令与示例**能否真的执行。
// 这是文档最致命的缺陷类型：「照着做但跑不通」。
//
// 本套件抽取 README / README.en / SUBMIT-GUIDE 里的代码块，逐类验证：
//   1. powershell 块：语法可解析（用 PowerShell 解析器）
//   2. yaml 块：可被 YAML 解析（cordis.patch.yml 片段）
//   3. js 块：语法正确（node --check）
//   4. 文中提到的文件路径：真的存在
//   5. 文中提到的命令：对应的脚本/工具真的存在
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

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

const DOCS = ["README.md", "README.en.md", "SUBMIT-GUIDE.zh.md", "community/discussion-deepseek-harness.md"]
	.filter((f) => fs.existsSync(path.join(ROOT, f)));

console.log(`=== 检查 ${DOCS.length} 个文档 ===`);
for (const d of DOCS) console.log(`  ${d}`);

/** 抽取 markdown 代码块 */
function extractBlocks(text) {
	const lines = text.split("\n");
	const blocks = [];
	let i = 0;
	while (i < lines.length) {
		const m = lines[i].match(/^(`{3,})(\w*)\s*$/);
		if (!m) { i++; continue; }
		const fence = m[1];
		const lang = m[2] || "";
		const start = i;
		const body = [];
		i++;
		while (i < lines.length && !lines[i].startsWith(fence)) {
			body.push(lines[i]);
			i++;
		}
		// 跳过可选的引用前缀（"> ```"）
		blocks.push({ lang, body: body.join("\n"), startLine: start + 1 });
		i++;
	}
	// 处理 "> ```" 形式的引用块（表格里嵌的）
	return blocks;
}

// ===========================================================================
// 1. PowerShell 块语法检查
// ===========================================================================
console.log("\n=== 1. PowerShell 代码块语法 ===");
{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-ps-"));
	let checked = 0;
	for (const doc of DOCS) {
		const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
		const blocks = extractBlocks(text).filter((b) => b.lang === "powershell" || b.lang === "ps1" || b.lang === "pwsh");
		for (let k = 0; k < blocks.length; k++) {
			const b = blocks[k];
			// 跳过「占位符」块（含 <path> 之类，无法直接执行）
			const hasPlaceholder = /<[^>\n]{1,40}>/.test(b.body);
			const f = path.join(tmpDir, `block-${checked}.ps1`);
			fs.writeFileSync(f, "\uFEFF" + b.body.replace(/\r?\n/g, "\r\n"), "utf8");
			const script = `
$errors = $null; $tokens = $null
[System.Management.Automation.Language.Parser]::ParseFile("${f.replace(/\\/g, "\\\\")}", [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -eq 0) { Write-Output "OK" } else { Write-Output ("FAIL:" + $errors[0].Message) }
`;
			let out = "";
			try {
				out = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 60000, stdio: "pipe" });
			} catch (e) {
				out = "EXEC_FAIL";
			}
			const ok = out.trim() === "OK";
			// **额外检查**：PowerShell 里 `<` 是保留运算符，裸 <path> 占位符会让用户
			// 复制下来的命令直接报 "The '<' operator is reserved for future use."
			// （真实缺陷 D36：英文 README 的安装命令曾用 -ProfileDir <path>）
			const barePlaceholder = /<[a-zA-Z][\w-]*>/.test(b.body) && !/["'][^"']*<[^>]+>[^"']*["']/.test(b.body);
			const allOk = ok && !barePlaceholder;
			console.log(`  ${doc}:${b.startLine} powershell → ${allOk ? "✅ 可用" : "❌ " + (ok ? "含裸 <> 占位符" : out.trim().slice(0, 80))}`);
			ck(`${doc}:${b.startLine} powershell 语法正确`, ok, out.trim().slice(0, 100));
			ck(`${doc}:${b.startLine} powershell 无裸 <> 占位符（可直接复制执行）`, !barePlaceholder, "含裸占位符会被 PowerShell 拒绝");
			checked++;
		}
	}
	console.log(`  共检查 ${checked} 个 powershell 块`);
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ===========================================================================
// 2. YAML 块可解析
// ===========================================================================
console.log("\n=== 2. YAML 代码块可解析 ===");
{
	// 不引入新依赖：写一个极简 YAML 校验（只验证结构合理性：缩进一致、无 tab、键值形态）
	function validateYamlSimple(body) {
		const lines = body.split("\n");
		let issues = [];
		for (let i = 0; i < lines.length; i++) {
			const l = lines[i];
			if (l.trim() === "" || l.trim().startsWith("#")) continue;
			// tab 缩进是 YAML 禁止的
			if (/^\t/.test(l)) issues.push(`L${i + 1}: 用 tab 缩进`);
			// 列表项必须有空格
			if (/^-\S/.test(l)) issues.push(`L${i + 1}: 列表项 "-" 后缺空格`);
		}
		return issues;
	}
	let checked = 0;
	for (const doc of DOCS) {
		const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
		const blocks = extractBlocks(text).filter((b) => b.lang === "yaml" || b.lang === "yml");
		for (const b of blocks) {
			const issues = validateYamlSimple(b.body);
			console.log(`  ${doc}:${b.startLine} yaml → ${issues.length === 0 ? "✅ 结构合理" : "❌ " + issues.join("; ")}`);
			ck(`${doc}:${b.startLine} yaml 结构合理`, issues.length === 0, issues.join("; "));
			checked++;
		}
	}
	console.log(`  共检查 ${checked} 个 yaml 块`);
}

// ===========================================================================
// 3. JS 块语法检查
// ===========================================================================
console.log("\n=== 3. JS 代码块语法 ===");
{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-js-"));
	let checked = 0;
	for (const doc of DOCS) {
		const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
		const blocks = extractBlocks(text).filter((b) => b.lang === "js" || b.lang === "javascript");
		for (const b of blocks) {
			const f = path.join(tmpDir, `block-${checked}.mjs`);
			fs.writeFileSync(f, b.body, "utf8");
			let ok = true;
			let errMsg = "";
			try {
				execFileSync(process.execPath, ["--check", f], { stdio: "pipe", timeout: 30000 });
			} catch (e) {
				ok = false;
				errMsg = String(e.stderr ?? "").split("\n").slice(0, 2).join(" ");
			}
			console.log(`  ${doc}:${b.startLine} js → ${ok ? "✅ 语法正确" : "❌ " + errMsg.slice(0, 80)}`);
			ck(`${doc}:${b.startLine} js 语法正确`, ok, errMsg.slice(0, 100));
			checked++;
		}
	}
	console.log(`  共检查 ${checked} 个 js 块`);
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ===========================================================================
// 4. 文中提到的仓库文件路径真的存在
// ===========================================================================
console.log("\n=== 4. 文档中引用的仓库文件存在 ===");
{
	// 找形如 lib/index.js / test/hardening/xxx.mjs / package.json 的路径
	const PATH_RE = /`((?:lib|test|community)\/[\w./-]+\.(?:mjs|cjs|js|md))`/g;
	const referenced = new Set();
	for (const doc of DOCS) {
		const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
		for (const m of text.matchAll(PATH_RE)) referenced.add(m[1]);
	}
	console.log(`  文档引用了 ${referenced.size} 个仓库内文件路径`);
	const missing = [];
	for (const p of [...referenced].sort()) {
		if (path.isAbsolute(p) || p.includes("..")) continue;
		const full = path.join(ROOT, p);
		if (!fs.existsSync(full)) missing.push(p);
	}
	if (missing.length > 0) {
		console.log(`  ❌ 引用了不存在的文件:`);
		for (const m of missing) console.log(`     ${m}`);
	}
	ck("文档引用的仓库文件都存在", missing.length === 0, missing.join(", "));

	// 单独检查包名/脚本名
	const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
	if (readme.includes("install-stepfix.ps1")) {
		ck("install-stepfix.ps1 存在", fs.existsSync(path.join(ROOT, "install-stepfix.ps1")), "");
	}
}

// ===========================================================================
// 5. 文中给出的命令确实可运行
// ===========================================================================
console.log("\n=== 5. 文档中的命令可运行 ===");
{
	const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
	const readmeEn = fs.readFileSync(path.join(ROOT, "README.en.md"), "utf8");
	const allText = readme + "\n" + readmeEn;

	// 提取所有 test/xxx.mjs 形式的命令
	const cmds = new Set();
	for (const m of allText.matchAll(/node\s+(test\/[\w./-]+\.(?:mjs|cjs))/g)) cmds.add(m[1]);
	console.log(`  文档给出 ${cmds.size} 条 node 命令`);

	let broken = [];
	for (const c of [...cmds].sort()) {
		const full = path.join(ROOT, c);
		if (!fs.existsSync(full)) { broken.push(c); continue; }
		// 实际执行一次「快速」验证：--check 能过
		try {
			execFileSync(process.execPath, ["--check", full], { stdio: "pipe", timeout: 30000 });
		} catch (e) {
			broken.push(c + "（语法错误）");
		}
	}
	if (broken.length > 0) console.log(`  ❌ 无法运行: ${broken.join(", ")}`);
	ck("文档给出的 node 命令对应的文件都存在且语法正确", broken.length === 0, broken.join(", "));

	// 检查 run-all 的三种模式说明是否与实际一致
	const hasQuick = allText.includes("--quick");
	const hasOffline = allText.includes("--offline");
	console.log(`  文档提到 --quick: ${hasQuick}, --offline: ${hasOffline}`);
	if (hasQuick) {
		// run-all 确实支持
		const runAll = fs.readFileSync(path.join(ROOT, "test", "run-all.mjs"), "utf8");
		ck("--quick 确实是 run-all 支持的参数", runAll.includes('"--quick"') || runAll.includes("--quick"), "");
	}
	if (hasOffline) {
		const runAll = fs.readFileSync(path.join(ROOT, "test", "run-all.mjs"), "utf8");
		ck("--offline 确实是 run-all 支持的参数", runAll.includes("--offline"), "");
	}
}

// ===========================================================================
// 6. 环境变量名一致
// ===========================================================================
console.log("\n=== 6. 文档中的环境变量名与实际代码一致 ===");
{
	const lib = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
	const envNames = new Set();
	for (const m of lib.matchAll(/process\.env\.(\w+)/g)) envNames.add(m[1]);
	console.log(`  代码读取的环境变量: ${[...envNames].join(", ") || "（无）"}`);

	for (const doc of DOCS) {
		const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
		for (const m of text.matchAll(/\b(DSH_[A-Z_]{3,})\b/g)) {
			const name = m[1];
			// 只检查看起来像本插件环境变量的
			if (!name.startsWith("DSH_TEXT_TOOL_CALL_RECOVERY") && !name.startsWith("DSH_LLM_SRC") && !name.startsWith("DSH_HOME")) continue;
			if (name === "DSH_LLM_SRC" || name === "DSH_HOME") {
				console.log(`  ${doc}: ${name}（测试/安装辅助变量，非插件读取）`);
				continue;
			}
			ck(`${doc} 提到的 ${name} 与代码一致`, envNames.has(name), `代码没有读取 ${name}`);
		}
	}
}

// ===========================================================================
// 7. YAML 片段与安装脚本生成的内容一致
// ===========================================================================
console.log("\n=== 7. 文档里的 YAML 与脚本实际写入的一致 ===");
{
	const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
	const script = fs.readFileSync(path.join(ROOT, "install-stepfix.ps1"), "utf8");

	// 文档里的 YAML 片段应该包含 id / name，且与脚本写入的一致
	const idInDoc = readme.includes("id: text-tool-call-recovery");
	const idInScript = script.includes("text-tool-call-recovery");
	ck("文档 YAML 的 id 与脚本一致", idInDoc && idInScript, `doc=${idInDoc} script=${idInScript}`);

	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	const nameInDoc = readme.includes(pkg.name);
	const nameInScript = script.includes(pkg.name);
	ck("文档 YAML 的 name 与 package.json 一致", nameInDoc && nameInScript, `doc=${nameInDoc} script=${nameInScript}`);

	// 文档说要「用 insert 形式」
	ck("文档说明必须用 insert 形式", /insert/.test(readme), "");
	ck("脚本实际使用 insert 形式", /- insert:/.test(script) || /"- insert:"/.test(script), "");
}

console.log(`\n===== 文档可执行性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细（前 15 条）---");
	for (const f of failures.slice(0, 15)) console.log(`  ❌ ${f}`);
	if (failures.length > 15) console.log(`  ... 另有 ${failures.length - 15} 条`);
}
process.exit(fail === 0 ? 0 : 1);
