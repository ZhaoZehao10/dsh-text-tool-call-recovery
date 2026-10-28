// 材料引用可核实性审查
//
// 提交材料里引用 DSH 源码（文件名、行号、函数名）时，**必须能核实**。
// 否则维护者一查就发现对不上，整份材料的可信度会崩塌。
//
// **第 90 轮订正**：缺陷 37 曾判定 invariant.js 不存在，实测它确实存在（asar 内 4401 字节）。
// 当初的误判源于本地副本不完整。以下为原始记录：
// 踩过的坑（缺陷 37）：材料 3 处引用 `dsh-llm/lib/types/invariant.js`，
// 但该文件**不存在** —— 宿主真正的流不变式校验在 `assistant-stream.js`。
// 还有 2 处引用本地无法核实的包，却写得像精确行号。
//
// **设计要点**：修复缺陷后，文档里仍然会提到 `invariant.js`
// （例如缺陷表写「3 处引用 invariant.js，但该文件不存在」）——
// 这是**正确**的历史记录，不是错误引用。必须排除这类「历史叙述」行，
// 否则测试会把修复记录本身当成违规。
import fs from "node:fs";
import path from "node:path";

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

// 找可用的 dsh 包目录（可能有多处）
const PKG_ROOTS = [
	path.join(ROOT, "..", ".tmp", "audit-deps", "node_modules", "@deepseek-ai"),
	path.join(ROOT, "..", ".tmp", "asar-src", "node_modules", "@deepseek-ai"),
].filter((p) => fs.existsSync(p));

function findPkgFile(pkg, rel) {
	for (const r of PKG_ROOTS) {
		const f = path.join(r, pkg, rel);
		if (fs.existsSync(f)) return f;
	}
	return null;
}

/**
 * 判断一行是否为「历史叙述」——这类行提到已废弃/不存在的引用是**正确**的，
 * 因为它记录的是「曾经错了、现已修正」。
 */
function isHistorical(line) {
	// 缺陷表格行（| 37 | **...**）
	if (/^\|\s*\d+\s*\|/.test(line)) return true;
	// 含历史标记
	if (/不存在|does not exist|曾经|旧值|过时|实际校验|real validator lives|硬伤|凭记忆|已证伪|永久禁止|were wrong|incorrect/.test(line)) return true;
	return false;
}

// **缺陷 61**：原本只检查这 4 个文档，漏了 community/ 下 3 个草稿。
// 那 3 个也引用了上游路径（如 `openai-completions.js`），从未被核验。
const DOCS = [
	"README.md",
	"README.en.md",
	"community/discussion-deepseek-harness.md",
	"PASTE-READY.zh.md",
	"community/feedback-stepfun.zh.md",
	"community/issue-deepseek-harness.en.md",
	"community/issue-deepseek-harness.zh.md",
].filter((f) => fs.existsSync(path.join(ROOT, f)));

// **已知无法本地核实的上游文件**（不在 dsh-llm 包里）：
// pi-ai 适配器是宿主内部包，本仓库不含，因此这些引用只能标注不能核验。
const KNOWN_UNVERIFIABLE = new Set([
	"openai-completions.js",
]);

// ===========================================================================
// 1. 提取所有 DSH 源码引用（排除历史叙述行）
// ===========================================================================
console.log("=== 1. 提取 DSH 源码引用（排除历史叙述）===");
const REF_RE = /`?(dsh-[\w-]+)\/(lib\/[\w./-]+?\.(?:js|cjs))(?::(\d+)(?:-(\d+))?)?`?/g;
const refs = [];
let historicalCount = 0;
for (const doc of DOCS) {
	const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (const m of line.matchAll(REF_RE)) {
			if (isHistorical(line)) { historicalCount++; continue; }
			refs.push({
				doc, line: i + 1,
				pkg: m[1], file: m[2],
				from: m[3] ? Number(m[3]) : null,
				to: m[4] ? Number(m[4]) : (m[3] ? Number(m[3]) : null),
				raw: m[0],
			});
		}
	}
}
console.log(`  有效引用 ${refs.length} 处，跳过历史叙述 ${historicalCount} 处`);
for (const r of refs) {
	console.log(`    ${r.doc}:${r.line} → ${r.pkg}/${r.file}${r.from ? ":" + r.from + (r.to !== r.from ? "-" + r.to : "") : ""}`);
}

// ===========================================================================
// 2. 引用的文件必须存在（若能找到该包）
// ===========================================================================
console.log("\n=== 2. 引用的文件存在性 ===");
{
	const byPkg = new Map();
	for (const r of refs) {
		if (!byPkg.has(r.pkg)) byPkg.set(r.pkg, []);
		byPkg.get(r.pkg).push(r);
	}
	for (const [pkg, list] of byPkg) {
		const available = PKG_ROOTS.some((r) => fs.existsSync(path.join(r, pkg)));
		console.log(`  ${pkg}: ${available ? "本地可用 ✅" : "本地无此包 ⚠️（无法核实文件存在性）"}`);
		if (!available) continue;
		for (const r of list) {
			const f = findPkgFile(pkg, r.file);
			ck(`${pkg}/${r.file} 存在（${r.doc}:${r.line}）`, f !== null, f === null ? "文件不存在！" : "");
			if (f === null) console.log(`    ❌ ${r.doc}:${r.line} 引用了不存在的文件 ${pkg}/${r.file}`);
		}
	}
}

// ===========================================================================
// 3. 引用的行号在范围内
// ===========================================================================
console.log("\n=== 3. 引用行号在文件范围内 ===");
{
	let checked = 0;
	for (const r of refs) {
		if (r.from === null) continue;
		const f = findPkgFile(r.pkg, r.file);
		if (!f) continue;
		const lineCount = fs.readFileSync(f, "utf8").split("\n").length;
		const ok = r.from >= 1 && r.to <= lineCount;
		ck(`${r.doc}:${r.line} 行号 ${r.from}-${r.to} 在范围内（文件 ${lineCount} 行）`, ok, ok ? "" : `超出 ${lineCount}`);
		if (!ok) console.log(`    ❌ ${r.doc}:${r.line} 引用 ${r.from}-${r.to}，但文件只有 ${lineCount} 行`);
		checked++;
	}
	if (checked === 0) console.log("  （无带行号的引用需检查）");
}

// ===========================================================================
// 4. 引用的符号确实存在
// ===========================================================================
console.log("\n=== 4. 引用中提到的符号存在 ===");
{
	const CANDIDATE = new Map();
	for (const doc of DOCS) {
		const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
		for (const m of text.matchAll(/(\w{6,})\.push\b/g)) CANDIDATE.set(m[1], doc);
		for (const m of text.matchAll(/`(assembleAssistantStream|AssistantStreamAccumulator|expandAssistantStream|BlockAssembler)`/g)) {
			if (!CANDIDATE.has(m[1])) CANDIDATE.set(m[1], doc);
		}
	}
	const srcFiles = [
		findPkgFile("dsh-llm", "lib/types/assistant-stream.js"),
		findPkgFile("dsh-llm", "lib/types/assembler.js"),
	].filter(Boolean);
	if (srcFiles.length > 0) {
		const sources = srcFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
		for (const [sym, doc] of CANDIDATE) {
			const exists = sources.includes(sym);
			ck(`文档提到的符号 ${sym} 在 dsh-llm 中真实存在`, exists, exists ? "" : `${doc} 提到的 ${sym} 找不到`);
			if (!exists) console.log(`    ❌ ${doc} 提到 ${sym}，但 dsh-llm 里找不到`);
		}
		console.log(`  检查了 ${CANDIDATE.size} 个符号: ${[...CANDIDATE.keys()].join(", ")}`);
	} else {
		console.log("  ⚠️ 找不到 dsh-llm 源码，跳过符号检查");
	}
}

// ===========================================================================
// 5. 曾被误判为「不存在」的文件：现在必须验证它**确实存在**
//
// **缺陷 85**（第 90 轮订正）：`dsh-llm/lib/types/invariant.js` 曾被记为「不存在」，
// 但实测它在 `app.asar` 里**确实存在**（4,401 字节，内容是
// `validateStream` / `validateIndex` / `validateDelta` 协议校验器）。
//
// 当初判定「不存在」是因为**本地测试副本不完整**（缺这个文件），不是文档写错。
// 现在的检查改为：如果文档引用了它，必须能**在本地副本里找到**；
// 找不到就说明副本不完整，应该报警而不是当作「文档引用错了」。
// ===========================================================================
console.log("\n=== 5. 曾误判的文件：必须能在本地副本里找到 ===");
{
	// 曾误判为「不存在」、实际存在的文件
	const ONCE_MISJUDGED = [
		{ pkg: "dsh-llm", file: "lib/types/invariant.js", what: "协议校验器 validateStream/validateIndex/validateDelta" },
	];

	for (const km of ONCE_MISJUDGED) {
		const pkgFile = findPkgFile(km.pkg, km.file);
		ck(`${km.pkg}/${km.file} 在本地副本里存在（${km.what}）`,
			pkgFile !== null,
			pkgFile === null ? "本地测试副本不完整：应从 app.asar 补全" : pkgFile);
		if (pkgFile) {
			const size = fs.statSync(pkgFile).size;
			console.log(`    ✅ ${km.file}: ${size} 字节`);
		} else {
			console.log(`    ❌ ${km.file}: 本地副本缺失 —— 这不代表文档写错，而是副本不完整`);
		}
	}
}

// ===========================================================================
// 6. 无法核实的引用不应写成精确行号
// ===========================================================================
console.log("\n=== 6. 无法核实的引用不写成精确行号 ===");
{
	let flagged = 0;
	for (const r of refs) {
		const available = PKG_ROOTS.some((root) => fs.existsSync(path.join(root, r.pkg)));
		if (available) continue;
		if (r.from !== null) {
			flagged++;
			console.log(`    ❌ ${r.doc}:${r.line} ${r.raw} —— 本地无 ${r.pkg}，行号无法核实`);
		}
	}
	ck("不可核实的引用均未写成精确行号", flagged === 0, `${flagged} 处`);
	if (flagged === 0) console.log("  ✅ 无可疑的不可核实行号引用");
}

// ===========================================================================
// 7. 引用总量合理性
// ===========================================================================
console.log("\n=== 7. 引用总量合理性 ===");
{
	ck("材料里确实存在可核实的源码引用", refs.length > 0, `有效引用 ${refs.length} 处`);
	const ratio = refs.length / (refs.length + historicalCount || 1);
	ck("有效引用占比合理（历史叙述未淹没全部）", ratio >= 0.2, `${(ratio * 100).toFixed(0)}%`);
	console.log(`  有效 ${refs.length} 处 / 历史 ${historicalCount} 处（有效占 ${(ratio * 100).toFixed(0)}%）`);
}

// ===========================================================================
// 8. 文档引用的仓库文件路径是否存在
//
// **缺陷 73**（第 78 轮）：前 7 节只检查 `dsh-xxx/lib/xxx.js` 这类宿主源码引用，
// 但文档里大量引用**仓库内文件**（`test/hardening/xxx.mjs`、`lib/index.js`…）。
// 文件被改名/删除后，文档会指向空气而无人发现。
//
// 允许的三类「看起来不存在但其实正确」：
//   ① **路径缩写**：`hardening/foo.mjs` → `test/hardening/foo.mjs`
//   ② **外部依赖**：宿主内部文件（`assistant-stream.js` 等），本仓库不含
//   ③ **运行时生成物**：`real-tools.json` / `rebuilt-tools.json`（脚本产出，不随仓库分发）
//      —— 且只出现在缺陷 46 的历史记录里。
// ===========================================================================
console.log("\n=== 8. 文档引用的仓库文件路径 ===");
{
	const REPO_DOCS = [
		"README.md",
		"README.en.md",
		"SUBMIT-GUIDE.zh.md",
		"PASTE-READY.zh.md",
		"community/discussion-deepseek-harness.md",
		"community/feedback-stepfun.zh.md",
		"community/issue-deepseek-harness.zh.md",
		"community/issue-deepseek-harness.en.md",
	];

	// 仓库实际文件
	const actualFiles = new Set();
	const actualBasenames = new Set();
	(function walk(d, base) {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith(".tmp")) continue;
			const full = path.join(d, e.name);
			const rel = path.relative(base, full).split(path.sep).join("/");
			if (e.isDirectory()) walk(full, base);
			else { actualFiles.add(rel); actualBasenames.add(e.name); }
		}
	})(ROOT, ROOT);

	// 允许「看起来不存在但正确」的类别
	const EXTERNAL_FILES = new Set([
		// invariant.js 已补全到本地副本（第 90 轮），因此不再列为「无法核实」；
		// 但它仍是**宿主内部文件**（不是本仓库文件），第 8 节「仓库文件路径」应归为外部
		"assistant-stream.js", "error.js", "retry-policy.js", "invariant.js",
		"openai-completions.js", "cordis.patch.yml", "package.json",
		// dsh-llm 的 types 文件（宿主内部，不是本仓库文件）
		"adapter-failure.js", "api-key.js", "assembler.js", "attribution.js",
		"brand.js", "call-config.js", "content.js", "message.js", "types.js",
	]);
	const RUNTIME_ARTIFACTS = new Set([
		"real-tools.json", "rebuilt-tools.json",
		"rebuilt-context.json", "real-context.json",
	]);

	const REF_RE = /`([a-zA-Z0-9_@][\w./@-]*\.(?:mjs|cjs|js|md|json|ps1|yml|yaml))`/g;

	const missing = [];
	let totalRefs = 0;
	let resolved = 0;

	for (const doc of REPO_DOCS) {
		const p = path.join(ROOT, doc);
		if (!fs.existsSync(p)) continue;
		const text = fs.readFileSync(p, "utf8");
		const lines = text.split(/\r?\n/);

		for (let i = 0; i < lines.length; i++) {
			if (isHistorical(lines[i])) continue;   // 历史记录里的旧文件名不算

			for (const m of lines[i].matchAll(REF_RE)) {
				const ref = m[1].replace(/^\.\//, "");
				// **缺陷 85**：`dsh-*` 前缀是**宿主源码引用**（第 2–4 节负责），
				// 不是本仓库文件 —— 第 8 节必须跳过，否则误报「仓库里不存在」。
				if (/^dsh-[\w-]+\//.test(ref)) continue;
				totalRefs++;

				// ① 精确存在
				if (actualFiles.has(ref)) { resolved++; continue; }

				// ② 路径缩写：尝试补全常见前缀
				const candidates = ["test/" + ref, "community/" + ref, "community/repro/" + ref, "lib/" + ref];
				let found = false;
				for (const c of candidates) if (actualFiles.has(c)) { found = true; break; }
				if (found) { resolved++; continue; }

				// ③ 只有 basename 形式
				const base = ref.split("/").pop();
				if (!ref.includes("/") && actualBasenames.has(base)) { resolved++; continue; }

				// ④ 外部依赖 / 运行时生成物
				if (EXTERNAL_FILES.has(base) || RUNTIME_ARTIFACTS.has(base)) { resolved++; continue; }

				// ⑤ 用户环境路径（不是仓库文件）
				if (/^(\.dsh|~|%TEMP%|%USERPROFILE%|node_modules)\//.test(ref)) { resolved++; continue; }

				missing.push(`${doc} L${i + 1}: ${ref}`);
			}
		}
	}

	console.log(`  文档引用总数: ${totalRefs}，可解析: ${resolved}，缺失: ${missing.length}`);
	ck("文档引用的仓库文件都存在（或属外部/运行时生成物）", missing.length === 0,
		missing.slice(0, 5).join("; "));
	for (const m of missing.slice(0, 8)) console.log(`    ❌ ${m}`);
	if (missing.length === 0) console.log("  ✅ 全部可解析");

	// **反向验证**：必须真的解析出足够多的引用（防止空转）
	ck("文档中确实有文件路径引用（非空转）", totalRefs >= 50, `只有 ${totalRefs} 个`);
}

console.log(`\n===== 材料引用可核实性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
