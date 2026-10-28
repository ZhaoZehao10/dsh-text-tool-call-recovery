// 文档结构完整性审查
//
// 前 47 轮验证了文档的**内容**（数字、引用、命令），但没验证**结构**：
//   - 章节编号是否连续（本轮发现中文 README 有两个「九、」）
//   - 中英文版本的关键内容是否对等
//   - 是否有重复的章节/标题
//
// 这类问题不影响正确性，但会让读者觉得文档没整理，对开源提交是减分项。
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

const readDoc = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const ZH = readDoc("README.md");
const EN = readDoc("README.en.md");
const DISC = readDoc("community/discussion-deepseek-harness.md");

// ===========================================================================
// 1. 中文 README 的章节编号必须连续
// ===========================================================================
console.log("=== 1. 中文 README 章节编号 ===");
{
	const CN_NUMS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四"];
	const sections = [];
	for (const line of ZH.split(/\r?\n/)) {
		const m = line.replace(/\r$/, "").match(/^##\s*([一二三四五六七八九十]+)、(.*)$/);
		if (m) sections.push({ n: m[1], t: m[2] });
	}
	console.log(`  找到 ${sections.length} 个编号章节`);
	for (const s of sections) console.log(`    ${s.n}、${s.t.slice(0, 40)}`);

	const nums = sections.map((s) => s.n);
	const expected = sections.map((_, i) => CN_NUMS[i]);
	const numOk = JSON.stringify(nums) === JSON.stringify(expected);
	ck("章节编号从「一」开始且连续", numOk, `实际 ${nums.join(",")}`);
	if (!numOk) {
		console.log(`  ❌ 实际: ${nums.join(", ")}`);
		console.log(`  ❌ 应为: ${expected.join(", ")}`);
	}

	// 无重复
	const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
	ck("章节编号无重复", dup.length === 0, dup.join(", "));
	if (dup.length > 0) console.log(`  ❌ 重复编号: ${dup.join(", ")}`);
}

// ===========================================================================
// 2. Markdown 标题层级不能跳级
// ===========================================================================
console.log("\n=== 2. 标题层级 ===");
for (const [name, text] of [["README.md", ZH], ["README.en.md", EN], ["discussion", DISC]]) {
	let prev = 0;
	const jumps = [];
	const lines = text.split(/\r?\n/);
	let inFence = false;
	let fenceMark = "";
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].replace(/\r$/, "");
		// **必须跳过代码块**：里面的 "# xxx" 是注释，不是标题
		const fm = raw.match(/^(`{3,})/);
		if (fm) {
			if (!inFence) { inFence = true; fenceMark = fm[1]; }
			else if (fm[1].length >= fenceMark.length) { inFence = false; }
			continue;
		}
		if (inFence) continue;

		const m = raw.match(/^(#{1,6})\s/);
		if (!m) continue;
		const level = m[1].length;
		// 允许：同级、下降 1 级、任意上升
		if (level > prev + 1 && prev > 0) {
			jumps.push({ n: i + 1, from: prev, to: level, text: raw.trim().slice(0, 60) });
		}
		prev = level;
	}
	ck(`${name} 标题层级不跳级`, jumps.length === 0,
		jumps.map((j) => `L${j.n} h${j.from}→h${j.to}: ${j.text}`).join("; "));
	console.log(`  ${name}: ${jumps.length === 0 ? "✅ 无跳级" : "❌ " + jumps.length + " 处跳级"}`);
	for (const j of jumps.slice(0, 5)) console.log(`    L${j.n}: h${j.from} → h${j.to} ${j.text}`);
}

// ===========================================================================
// 3. 英文 README 必须覆盖中文的核心证据
// ===========================================================================
console.log("\n=== 3. 中英文关键内容对等 ===");
{
	// 这些是材料的**核心证据**，英文版必须也有（否则国际维护者看不到）
	const KEY_CONTENT = [
		{ name: "61 次受控实验", zhRe: /61\s*(次|个)/, enRe: /\b61\b/ },
		{ name: "忠实重放", zhRe: /忠实重放/, enRe: /faithful replay/i },
		{ name: "419,843 token", zhRe: /419,843/, enRe: /419,843/ },
		{ name: "跨版本验证", zhRe: /跨版本验证/, enRe: /cross-version/i },
		{ name: "对抗性审查", zhRe: /对抗性审查/, enRe: /adversarial review/i },
		{ name: "已知限制", zhRe: /已知限制|已知问题|局限/, enRe: /known limits?|limitations?/i },
		{ name: "卸载", zhRe: /卸载/, enRe: /uninstall/i },
		{ name: "许可证", zhRe: /许可证|LICENSE/, enRe: /license/i },
	];
	for (const k of KEY_CONTENT) {
		const inZh = k.zhRe.test(ZH);
		const inEn = k.enRe.test(EN);
		ck(`中文含「${k.name}」`, inZh, "");
		ck(`英文含「${k.name}」`, inEn, `中文有、英文缺`);
		console.log(`  ${k.name}: 中文=${inZh ? "✅" : "❌"} 英文=${inEn ? "✅" : "❌"}`);
	}
}

// ===========================================================================
// 4. 中英文缺陷数量/层数必须一致
// ===========================================================================
console.log("\n=== 4. 中英文数字一致 ===");
{
	// 缺陷数
	const zhDef = (ZH.match(/(\d+)\s*个[自身]*缺陷/) ?? [])[1];
	// 英文版的写法可能是 "41 of my own defects" 或 "forty-one self-inflicted defects"
	const enDef = (EN.match(/(\d+)\s*of my own defects/) ?? [])[1] ??
		(() => {
			const m = EN.match(/(\w+(?:-\w+)?)\s+self-inflicted defects/i);
			if (!m) return undefined;
			const W = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
				ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
			let total = 0;
			for (const part of m[1].toLowerCase().split("-")) {
				if (W[part] !== undefined) total += W[part];
			}
			return total > 0 ? String(total) : undefined;
		})();
	console.log(`  缺陷数: 中文=${zhDef ?? "?"} 英文=${enDef ?? "?"}`);
	if (zhDef && enDef) ck("中英文缺陷数一致", zhDef === enDef, `${zhDef} vs ${enDef}`);

	// 层数（中文用汉字、英文用英文单词）
	const CN = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
	const toNum = (s) => {
		if (!s) return NaN;
		if (/^\d+$/.test(s)) return Number(s);
		if (s.includes("十")) {
			const [a, b] = s.split("十");
			return (a ? CN[a] : 1) * 10 + (b ? CN[b] : 0);
		}
		return CN[s] ?? NaN;
	};
	const EN_WORDS = { ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
	const parseEn = (s) => {
		if (!s) return NaN;
		// "seventy-nine" → 79
		const parts = s.toLowerCase().split("-");
		let total = 0;
		for (const p of parts) {
			if (EN_WORDS[p] !== undefined) total += EN_WORDS[p];
			else if (p === "one") total += 1;
			else if (p === "two") total += 2;
			else if (p === "three") total += 3;
			else if (p === "four") total += 4;
			else if (p === "five") total += 5;
			else if (p === "six") total += 6;
			else if (p === "seven") total += 7;
			else if (p === "eight") total += 8;
			else if (p === "nine") total += 9;
		}
		return total;
	};
	const zhLayer = (ZH.match(/\*\*([零一二三四五六七八九十]+)层测试\*\*/) ?? [])[1];
	const enLayer = (EN.match(/\*\*([a-z-]+) layers? of testing\*\*/) ?? [])[1];
	const zhL = toNum(zhLayer);
	const enL = parseEn(enLayer);
	console.log(`  层数: 中文=${zhLayer}(${zhL}) 英文=${enLayer}(${enL})`);
	if (!Number.isNaN(zhL) && !Number.isNaN(enL)) {
		ck("中英文层数一致", zhL === enL, `${zhL} vs ${enL}`);
	}
}

// ===========================================================================
// 5. 讨论帖的结构完整性
// ===========================================================================
console.log("\n=== 5. 讨论帖结构 ===");
{
	// 四个必需章节，各恰好 1 个
	const CHECKS = [
		["### 标题", 1],
		["### 正文", 1],
		["### Title", 1],
		["### Body", 1],
	];
	for (const [header, expected] of CHECKS) {
		const re = new RegExp(`^${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "gm");
		const count = (DISC.match(re) ?? []).length;
		ck(`讨论帖有恰好 ${expected} 个「${header}」`, count === expected, `实际 ${count} 个`);
		console.log(`  ${header}: ${count === expected ? "✅" : "❌"} ${count} 个`);
	}

	// 正文不能为空
	const lines = DISC.split(/\r?\n/);
	const find = (s) => lines.findIndex((l) => l.trim() === s);
	const[zhTitleIdx, zhBodyIdx] = [find("### 标题"), find("### 正文")];
	if (zhTitleIdx >= 0 && zhBodyIdx > zhTitleIdx) {
		const title = lines.slice(zhTitleIdx + 1, zhBodyIdx).filter((l) => l.trim()).join("\n").trim();
		ck("中文标题非空", title.length > 10, `${title.length} 字符`);
		console.log(`  中文标题: ${title.length} 字符`);
	}
}

// ===========================================================================
// 6. 没有遗留的临时/调试标记
// ===========================================================================
console.log("\n=== 6. 无调试残留 ===");
{
	const DOCS = [
		["README.md", ZH], ["README.en.md", EN], ["discussion", DISC],
		["PASTE-READY.zh.md", readDoc("PASTE-READY.zh.md")],
	];
	const BAD_MARKERS = [
		{ re: /\bTODO\b/i, name: "TODO" },
		{ re: /\bFIXME\b/i, name: "FIXME" },
		{ re: /\bXXX\b/, name: "XXX" },
		{ re: /待补充|待填写|TBD/i, name: "待补充" },
		{ re: /lorem ipsum/i, name: "lorem" },
	];
	for (const [name, text] of DOCS) {
		// **排除「描述检查规则本身」的行**：文档里可能写「无 TODO/FIXME 残留」
		// 这类句子是**规则描述**，不是真的残留标记。
		// 判据：该行同时含「无/no/without」与标记名 → 视为规则描述，跳过。
		const found = [];
		for (const m of BAD_MARKERS) {
			const re = new RegExp(m.re.source, m.re.flags.includes("g") ? m.re.flags : m.re.flags + "g");
			let hit = false;
			for (const line of text.split(/\r?\n/)) {
				re.lastIndex = 0;
				if (!re.test(line)) continue;
				// 否定语境 → 规则描述，跳过
				if (/无\s*(TODO|FIXME|XXX)|no\s+(TODO|FIXME|TBD)|without\s+(TODO|FIXME)/i.test(line)) continue;
				hit = true;
				break;
			}
			if (hit) found.push(m.name);
		}
		ck(`${name} 无调试残留标记`, found.length === 0, found.map((x) => x.name || x).join(", "));
		console.log(`  ${name}: ${found.length === 0 ? "✅" : "❌ " + found.join(", ")}`);
	}
}

// ===========================================================================
// 7. 不可自动复现的声明必须有诚实标注
//
// README 里有若干「我手工跑过」的实测记录（三版本验证、61 次对照实验等）。
// 这些**无法在当前仓库自动复现**，如果不加标注，读者会以为能一键验证。
// 本检查确保这类声明旁边有明确的「历史记录/不可复现」说明。
// ===========================================================================
console.log("\n=== 7. 不可复现声明的诚实标注 ===");
{
	const UNREPRODUCIBLE_CLAIMS = [
		{
			name: "三版本实测",
			zhAnchor: /155 项集成断言[\s\S]{0,200}?(三个版本|0\.2\.0-rc\.2)/,
			zhNote: /历史实测记录|不可.*自动复现|手工跑过/,
			enAnchor: /Cross-version verification/i,
			enNote: /historical record|not reproducible|manual testing/i,
		},
	];
	for (const c of UNREPRODUCIBLE_CLAIMS) {
		const inZh = c.zhAnchor.test(ZH);
		const noteZh = c.zhNote.test(ZH);
		const inEn = c.enAnchor.test(EN);
		const noteEn = c.enNote.test(EN);
		console.log(`  ${c.name}: 中文声明=${inZh} 中文标注=${noteZh} 英文声明=${inEn} 英文标注=${noteEn}`);
		if (inZh) ck(`中文版「${c.name}」有诚实标注`, noteZh, "声明了但没说明不可自动复现");
		if (inEn) ck(`英文版「${c.name}」有诚实标注`, noteEn, "declared but not marked as non-reproducible");
	}
}

// ===========================================================================
// 8. 缺陷表结构完整性（Markdown 表格必须可解析）
//
// **缺陷 46**：曾出现「D26 与 D27 被合并到同一行」（13 个 |）+「D27 重复两行」。
// 后果：Markdown 渲染出错、D27 在表格里"消失"、解析器只认出 38 行（实际 45）。
//
// 另一个隐患：D27 的修复描述里有正则 `/(?:\r\n|[\r\n])/`，
// 其中的 `|` 未转义会让 Markdown 把一格切成两格。
// ===========================================================================
console.log("\n=== 8. 缺陷表结构完整性 ===");
{
	const defectLines = [];
	for (let i = 0; i < ZH.split(/\r?\n/).length; i++) {
		const line = ZH.split(/\r?\n/)[i];
		const m = line.match(/^\| (\d+) \|/);
		if (m) defectLines.push({ n: Number(m[1]), line: i + 1, text: line });
	}
	console.log(`  缺陷行: ${defectLines.length}`);

	// 8a. 每行的未转义 | 必须恰好 6 个（5 列）
	const badPipes = [];
	for (const d of defectLines) {
		let pipes = 0;
		for (let j = 0; j < d.text.length; j++) {
			if (d.text[j] === "|" && (j === 0 || d.text[j - 1] !== "\\")) pipes++;
		}
		if (pipes !== 6) badPipes.push({ n: d.n, line: d.line, pipes });
	}
	ck("缺陷表每行都是 5 列（6 个未转义的 |）", badPipes.length === 0,
		badPipes.map((b) => `D${b.n}@L${b.line}=${b.pipes}`).join(", "));
	for (const b of badPipes.slice(0, 5)) console.log(`    ❌ D${b.n} (L${b.line}): ${b.pipes} 个 |`);
	if (badPipes.length === 0) console.log("  ✅ 所有行都是 5 列");

	// 8b. 编号无重复
	const nums = defectLines.map((d) => d.n);
	const dups = nums.filter((n, i) => nums.indexOf(n) !== i);
	ck("缺陷编号无重复", dups.length === 0, [...new Set(dups)].join(", "));
	if (dups.length > 0) console.log(`    ❌ 重复: ${[...new Set(dups)].join(", ")}`);
	else console.log("  ✅ 编号无重复");

	// 8c. 编号连续（1..N 无缺失）
	const maxN = nums.length > 0 ? Math.max(...nums) : 0;
	const missing = [];
	for (let n = 1; n <= maxN; n++) if (!nums.includes(n)) missing.push(n);
	ck("缺陷编号连续无缺失", missing.length === 0, missing.join(", "));
	if (missing.length > 0) console.log(`    ❌ 缺失: ${missing.join(", ")}`);
	else console.log("  ✅ 编号连续");

	// 8d. 每列内容非空
	const emptyCells = [];
	for (const d of defectLines) {
		// 按未转义的 | 分割
		const cells = [];
		let cur = "";
		for (let j = 0; j < d.text.length; j++) {
			const ch = d.text[j];
			if (ch === "|" && (j === 0 || d.text[j - 1] !== "\\")) {
				cells.push(cur);
				cur = "";
			} else {
				cur += ch;
			}
		}
		cells.push(cur);
		// cells[0] 是空（开头 | 前），cells[1] 是编号，2-5 是内容
		for (let k = 2; k <= 5 && k < cells.length; k++) {
			if (cells[k].trim().length === 0) emptyCells.push(`D${d.n} 第${k}列`);
		}
	}
	ck("缺陷表无空单元格", emptyCells.length === 0, emptyCells.slice(0, 5).join(", "));
	if (emptyCells.length > 0) console.log(`    ❌ 空单元格: ${emptyCells.slice(0, 5).join(", ")}`);
	else console.log("  ✅ 无空单元格");
}

// ===========================================================================
// 9. 所有 Markdown 表格的列数一致性
//
// **缺陷 47**：第 56 轮只检查了缺陷表，漏掉了其他表格。实测发现：
//   a) 测试矩阵的行被误插进缺陷表（4 列混进 5 列表）；
//   b) 英文版 README 的 D26/D27 也被合并到同一行（13 个 |）。
//
// 判据：同一个表格内，所有行的**未转义 | 数量必须相同**。
// ===========================================================================
console.log("\n=== 9. 所有表格的列数一致性 ===");
{
	const FILES = {
		"README.md": ZH,
		"README.en.md": EN,
	};

	const countPipes = (line) => {
		let n = 0;
		for (let j = 0; j < line.length; j++) {
			if (line[j] === "|" && (j === 0 || line[j - 1] !== "\\")) n++;
		}
		return n;
	};

	let totalTables = 0;
	const badTables = [];

	for (const [name, text] of Object.entries(FILES)) {
		const ls = text.split(/\r?\n/);
		let cur = null;
		const tables = [];
		let inFence = false;
		for (let i = 0; i < ls.length; i++) {
			// **缺陷 69 修复**：必须跳过代码块 —— 代码块里的 `|`（bash 管道、
			// 正则 `a|b`）会被误判成表格行，导致「164 个表格」这种假数字。
			if (/^\s*```/.test(ls[i])) {
				inFence = !inFence;
				if (cur) { tables.push(cur); cur = null; }
				continue;
			}
			if (inFence) continue;

			if (/^\s*\|/.test(ls[i])) {
				if (!cur) cur = { start: i + 1, rows: [] };
				cur.rows.push({ n: i + 1, p: countPipes(ls[i]) });
			} else if (cur) {
				tables.push(cur);
				cur = null;
			}
		}
		if (cur) tables.push(cur);

		totalTables += tables.length;
		for (let k = 0; k < tables.length; k++) {
			const tb = tables[k];
			const uniq = [...new Set(tb.rows.map((r) => r.p))];
			if (uniq.length > 1) {
				badTables.push({
					file: name,
					index: k + 1,
					start: tb.start,
					uniq,
					rows: tb.rows.length,
				});
			}
		}
	}

	console.log(`  检查 ${totalTables} 个表格，${badTables.length} 个列数不一致`);
	ck("所有 Markdown 表格列数一致", badTables.length === 0,
		badTables.map((b) => `${b.file}#${b.index}@L${b.start}(${b.uniq.join("/")})`).join(", "));
	for (const b of badTables) {
		console.log(`    ❌ ${b.file} 第 ${b.index} 个表 (L${b.start} 起, ${b.rows} 行): 列数 ${b.uniq.join("/")}`);
	}
	if (badTables.length === 0) console.log("  ✅ 全部一致");

	// **额外**：表格数量必须合理（防止整段表格被误删）
	ck("README 至少含 5 个表格", (() => {
		const ls = ZH.split(/\r?\n/);
		let n = 0, inT = false;
		for (const l of ls) {
			const isRow = /^\s*\|/.test(l);
			if (isRow && !inT) { n++; inT = true; }
			else if (!isRow) inT = false;
		}
		return n >= 5;
	})(), "表格数量过少");
}

// ===========================================================================
// 10. 中英文缺陷表对等
//
// **缺陷 48**：英文 README 的缺陷表停在 D27，中文已到 D47（滞后 20 条）。
// 英文读者会以为只有 27 个缺陷。
//
// 根因：第 8 节只检查中文版，第 9 节只检查列数，都不检查「内容对等」。
// ===========================================================================
console.log("\n=== 10. 中英文缺陷表对等 ===");
{
	const extractDefectNums = (text) => {
		const out = [];
		for (const line of text.split(/\r?\n/)) {
			const m = line.match(/^\| (\d+) \| \*\*/);
			if (m) out.push(Number(m[1]));
		}
		return out;
	};

	const zhNums = extractDefectNums(ZH);
	const enNums = extractDefectNums(EN);
	console.log(`  中文 ${zhNums.length} 条，英文 ${enNums.length} 条`);

	// 10a. 数量一致
	ck("中英文缺陷数量一致", zhNums.length === enNums.length,
		`中文 ${zhNums.length} vs 英文 ${enNums.length}`);

	// 10b. 编号集合一致（找出英文缺失/多出的）
	const zhSet = new Set(zhNums);
	const enSet = new Set(enNums);
	const enMissing = [...zhSet].filter((n) => !enSet.has(n)).sort((a, b) => a - b);
	const enExtra = [...enSet].filter((n) => !zhSet.has(n)).sort((a, b) => a - b);

	ck("英文版没有遗漏缺陷编号", enMissing.length === 0,
		enMissing.length > 0 ? `缺失 D${enMissing.join(", D")}` : "");
	if (enMissing.length > 0) {
		console.log(`    ❌ 英文缺失 ${enMissing.length} 条: D${enMissing.join(", D")}`);
	} else {
		console.log("  ✅ 英文无遗漏");
	}

	ck("英文版没有多余的缺陷编号", enExtra.length === 0,
		enExtra.length > 0 ? `多出 D${enExtra.join(", D")}` : "");
	if (enExtra.length > 0) console.log(`    ❌ 英文多出: D${enExtra.join(", D")}`);

	// 10c. 英文每条都有实质性内容（不是空壳）
	const enEmpty = [];
	for (const line of EN.split(/\r?\n/)) {
		const m = line.match(/^\| (\d+) \| \*\*(.+?)\*\* \| (.+?) \| (.+?) \| (.+?) \|/);
		if (!m) continue;
		const [, num, title, cause, symptom, fix] = m;
		// 标题阈值放宽到 4：`ReDoS` 这类技术术语本身就是短词，不是"内容空洞"。
		if (title.length < 4 || cause.length < 8 || symptom.length < 15 || fix.length < 8) {
			enEmpty.push(`D${num}`);
		}
	}
	ck("英文缺陷条目都有实质内容", enEmpty.length === 0, enEmpty.slice(0, 5).join(", "));
	if (enEmpty.length > 0) console.log(`    ❌ 内容过短: ${enEmpty.slice(0, 5).join(", ")}`);
	else console.log("  ✅ 英文条目内容充实");
}

// ===========================================================================
// 11. Markdown 文件换行符一致（全部 LF）
//
// **缺陷 59**：README.md 曾是 CRLF，其余 7 个 .md 是 LF ——
// 我在修复「3703 行空行」时用 PowerShell 写入引入了 CRLF。
// 后果：git diff 噪声、部分工具对混合换行处理不一致。
// ===========================================================================
console.log("\n=== 11. Markdown 换行符一致性 ===");
{
	const mdFiles = [];
	(function walk(d) {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) {
				if (!e.name.startsWith(".") && e.name !== "node_modules") walk(p);
				continue;
			}
			if (e.name.endsWith(".md")) mdFiles.push(p);
		}
	})(ROOT);

	const eolProblems = [];
	for (const f of mdFiles) {
		const text = fs.readFileSync(f).toString("utf8");
		const crlf = (text.match(/\r\n/g) ?? []).length;
		const doubleCr = (text.match(/\r\r\n/g) ?? []).length;
		const loneCr = (text.match(/\r(?!\n)/g) ?? []).length;
		if (crlf > 0 || doubleCr > 0 || loneCr > 0) {
			eolProblems.push(`${path.relative(ROOT, f)}: CRLF=${crlf} 双CR=${doubleCr} 单CR=${loneCr}`);
		}
	}

	console.log(`  检查 ${mdFiles.length} 个 Markdown 文件，${eolProblems.length} 个换行符不统一`);
	ck("所有 Markdown 文件都只用 LF", eolProblems.length === 0, eolProblems.slice(0, 5).join("; "));
	for (const p of eolProblems.slice(0, 5)) console.log(`    ❌ ${p}`);
	if (eolProblems.length === 0) console.log("  ✅ 全部 LF");

	// **额外**：不应有超长连续空行（防止文件被写坏）
	const bloated = [];
	for (const f of mdFiles) {
		const text = fs.readFileSync(f).toString("utf8");
		const maxRun = Math.max(0, ...(text.match(/\n{3,}/g) ?? []).map((m) => m.length));
		if (maxRun > 4) bloated.push(`${path.relative(ROOT, f)}: ${maxRun} 个连续换行`);
	}
	ck("Markdown 无异常空行堆积", bloated.length === 0, bloated.slice(0, 5).join("; "));
	console.log(`  空行堆积: ${bloated.length} 个文件`);
}

// ===========================================================================
// 12. 所有交付物文档的基础结构（覆盖 SUBMIT-GUIDE 与 community 草稿）
//
// **缺陷 69**：第 76 轮实测覆盖矩阵发现——结构/换行符检查只覆盖 4/8 个文档：
//   README / README.en / PASTE-READY / discussion。
//   未覆盖：SUBMIT-GUIDE（用户操作手册）、feedback-stepfun、issue ×2。
//
// **注意**：统计 H1 时**必须跳过代码块** —— SUBMIT-GUIDE 的 powershell 块里有
// `# 跑这个套件...` 这种注释，直接按行首 `# ` 统计会误判成 H1。
// ===========================================================================
console.log("\n=== 12. 所有交付物文档的基础结构 ===");
{
	const ALL_DOCS = [
		"README.md",
		"README.en.md",
		"SUBMIT-GUIDE.zh.md",
		"PASTE-READY.zh.md",
		"community/discussion-deepseek-harness.md",
		"community/feedback-stepfun.zh.md",
		"community/issue-deepseek-harness.zh.md",
		"community/issue-deepseek-harness.en.md",
	];

	const structProblems = [];
	let checked = 0;

	for (const doc of ALL_DOCS) {
		const p = path.join(ROOT, doc);
		if (!fs.existsSync(p)) { structProblems.push(`${doc}: 不存在`); continue; }
		checked++;

		const text = fs.readFileSync(p).toString("utf8");
		const ls = text.split(/\r?\n/);

		// 12a. 换行符一致（禁止 CRLF / 双 CR / 单 CR）
		const crlf = (text.match(/\r\n/g) ?? []).length;
		const doubleCr = (text.match(/\r\r\n/g) ?? []).length;
		const loneCr = (text.match(/\r(?!\n)/g) ?? []).length;
		if (crlf > 0 || doubleCr > 0 || loneCr > 0) {
			structProblems.push(`${doc}: 换行符 CRLF=${crlf} 双CR=${doubleCr} 单CR=${loneCr}`);
		}

		// 12b. 必须只有一个 H1（**跳过代码块**）
		let inFence = false;
		let h1 = 0;
		let h2 = 0;
		for (const line of ls) {
			if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
			if (inFence) continue;
			if (/^#\s/.test(line)) h1++;
			else if (/^##\s/.test(line)) h2++;
		}
		if (h1 !== 1) {
			structProblems.push(`${doc}: H1 数量 ${h1}（应为 1）`);
		}
		if (h2 === 0) {
			structProblems.push(`${doc}: 没有 H2 章节`);
		}

		// 12c. 表格列数一致（跳过代码块）
		let fence = false;
		let curTable = null;
		const tableBad = [];
		for (let i = 0; i < ls.length; i++) {
			if (/^\s*```/.test(ls[i])) { fence = !fence; curTable = null; continue; }
			if (fence) continue;

			if (/^\s*\|/.test(ls[i])) {
				const pipes = (ls[i].match(/(?<!\\)\|/g) ?? []).length;
				if (!curTable) curTable = { start: i + 1, counts: [] };
				curTable.counts.push(pipes);
			} else if (curTable) {
				const uniq = [...new Set(curTable.counts)];
				if (uniq.length > 1) tableBad.push(`L${curTable.start} 列数 ${uniq.join("/")}`);
				curTable = null;
			}
		}
		if (curTable) {
			const uniq = [...new Set(curTable.counts)];
			if (uniq.length > 1) tableBad.push(`L${curTable.start} 列数 ${uniq.join("/")}`);
		}
		if (tableBad.length > 0) {
			structProblems.push(`${doc}: 表格 ${tableBad.join(", ")}`);
		}

		// 12d. 不能为空
		if (text.trim().length < 100) {
			structProblems.push(`${doc}: 内容过短（${text.trim().length} 字符）`);
		}
	}

	console.log(`  检查 ${checked}/${ALL_DOCS.length} 个文档，${structProblems.length} 处问题`);
	ck("所有交付物文档的基础结构正确", structProblems.length === 0,
		structProblems.slice(0, 5).join("; "));
	for (const p of structProblems.slice(0, 8)) console.log(`    ❌ ${p}`);
	if (structProblems.length === 0) console.log("  ✅ 全部正确");
}

// ===========================================================================
// 13. 表格行之间不得夹空行（否则 Markdown 把表格截断成多个小表）
//
// **缺陷 70**：中文 README 的缺陷表 68 行被 55 个空行切成 56 个独立小表，
// 测试矩阵 75 行被 75 个空行切开 —— GitHub 上所有表格渲染错误。
// 英文版是正确的（0 个空行）。
// ===========================================================================
console.log("\n=== 13. 表格行之间不得夹空行 ===");
{
	const TABLE_DOCS = [
		"README.md",
		"README.en.md",
		"SUBMIT-GUIDE.zh.md",
		"PASTE-READY.zh.md",
		"community/discussion-deepseek-harness.md",
	];

	const splitProblems = [];

	for (const doc of TABLE_DOCS) {
		const p = path.join(ROOT, doc);
		if (!fs.existsSync(p)) continue;
		const ls = fs.readFileSync(p).toString("utf8").split(/\r?\n/);

		let inFence = false;
		// 找出所有被空行打断的表格
		let inTable = false;
		let emptyAfterTable = 0;
		let lastWasTable = false;
		let breaks = 0;

		for (let i = 0; i < ls.length; i++) {
			if (/^\s*```/.test(ls[i])) { inFence = !inFence; lastWasTable = false; continue; }
			if (inFence) continue;

			const isTableRow = /^\s*\|/.test(ls[i]);
			const isEmpty = ls[i].trim() === "";

			if (isEmpty && lastWasTable) {
				// 向后找第一个非空行
				let next = "";
				for (let j = i + 1; j < ls.length; j++) {
					if (ls[j].trim() !== "") { next = ls[j]; break; }
				}
				if (/^\s*\|/.test(next)) {
					breaks++;
					if (breaks <= 3) {
						splitProblems.push(`${doc} L${i + 1}: 表格中间的空行（下一行 L${i + 2} 又是表格行）`);
					}
				}
			}

			if (!isTableRow) lastWasTable = false;
			else lastWasTable = true;
		}

		if (breaks > 3) {
			splitProblems.push(`${doc}: 共 ${breaks} 处表格被空行打断`);
		}
	}

	console.log(`  检查 ${TABLE_DOCS.length} 个文档，${splitProblems.length} 处表格被空行打断`);
	ck("表格行之间没有空行（否则 Markdown 渲染错误）", splitProblems.length === 0,
		splitProblems.slice(0, 5).join("; "));
	for (const p of splitProblems.slice(0, 8)) console.log(`    ❌ ${p}`);
	if (splitProblems.length === 0) console.log("  ✅ 无表格被截断");

	// **反向验证**：确认确实检测到了表格（防止「文档里根本没表格」的空转）
	let tableCount = 0;
	for (const doc of TABLE_DOCS) {
		const p = path.join(ROOT, doc);
		if (!fs.existsSync(p)) continue;
		const ls = fs.readFileSync(p).toString("utf8").split(/\r?\n/);
		let inFence = false, seen = false;
		for (const l of ls) {
			if (/^\s*```/.test(l)) { inFence = !inFence; continue; }
			if (inFence) continue;
			if (/^\s*\|/.test(l)) { if (!seen) { tableCount++; seen = true; } }
			else seen = false;
		}
	}
	console.log(`  检测到的表格总数: ${tableCount}`);
	ck("确实检测到表格（非空转）", tableCount >= 5, String(tableCount));
}

// ===========================================================================
// 14. Markdown 渲染健康度（代码块/空行/围栏/表格分隔行）
//
// **缺陷 71**：README.md 实测发现——
//   · 代码块内 **35 处空行**（powershell/yaml 块每行之间都有空行）
//   · **8 处连续空行**（段落之间两个空行）
//   · **测试矩阵 4 行被错位插入到「安装步骤」章节**（L131-134）
//   · **D3 单元格里写了裸三重反引号**，干扰围栏识别
// ===========================================================================
console.log("\n=== 14. Markdown 渲染健康度 ===");
{
	const RENDER_DOCS = [
		"README.md",
		"README.en.md",
		"SUBMIT-GUIDE.zh.md",
		"PASTE-READY.zh.md",
		"community/discussion-deepseek-harness.md",
		"community/feedback-stepfun.zh.md",
		"community/issue-deepseek-harness.zh.md",
		"community/issue-deepseek-harness.en.md",
	];

	const FENCE = "`".repeat(3);
	const renderProblems = [];

	for (const doc of RENDER_DOCS) {
		const p = path.join(ROOT, doc);
		if (!fs.existsSync(p)) continue;
		const ls = fs.readFileSync(p).toString("utf8").split(/\r?\n/);

		// 14a. 围栏必须成对（块引用内的也算）
		let fences = 0;
		for (const l of ls) {
			const stripped = l.replace(/^\s*(?:>\s*)+/, "").trimStart();
			if (stripped.startsWith(FENCE)) fences++;
		}
		if (fences % 2 !== 0) renderProblems.push(`${doc}: 围栏 ${fences} 个（未配对）`);

		// 14b. 代码块内不得有空行
		let inFence = false;
		let inFenceBlanks = 0;
		for (const l of ls) {
			if (l.trimStart().startsWith(FENCE)) { inFence = !inFence; continue; }
			if (inFence && l.trim() === "") inFenceBlanks++;
		}
		if (inFenceBlanks > 0) renderProblems.push(`${doc}: 代码块内 ${inFenceBlanks} 处空行`);

		// 14c. 不得有连续空行（≥2）
		let run = 0, runs = 0;
		inFence = false;
		for (const l of ls) {
			if (l.trimStart().startsWith(FENCE)) { inFence = !inFence; run = 0; continue; }
			if (inFence) continue;
			if (l.trim() === "") { run++; if (run === 2) runs++; }
			else run = 0;
		}
		if (runs > 0) renderProblems.push(`${doc}: ${runs} 处连续空行`);

		// 14d. 行首围栏之外不得出现裸围栏（干扰解析器）
		// **注意**：块引用内的围栏（"> \`\`\`powershell"）是合法的 Markdown，
		// 必须先剥掉 "> " 前缀再判断。
		let inlineBare = 0;
		for (const l of ls) {
			const stripped = l.replace(/^\s*(?:>\s*)+/, "").trimStart();
			if (stripped.startsWith(FENCE)) continue;
			if (stripped.includes(FENCE)) inlineBare++;
		}
		if (inlineBare > 0) renderProblems.push(`${doc}: ${inlineBare} 行含行内裸围栏`);

		// 14e. 表格第 2 行必须是分隔行
		inFence = false;
		let cur = null;
		const tables = [];
		for (let i = 0; i < ls.length; i++) {
			if (ls[i].trimStart().startsWith(FENCE)) { inFence = !inFence; if (cur) { tables.push(cur); cur = null; } continue; }
			if (inFence) continue;
			if (/^\s*\|/.test(ls[i])) {
				if (!cur) cur = { start: i, rows: [] };
				cur.rows.push(i);
			} else if (cur) { tables.push(cur); cur = null; }
		}
		if (cur) tables.push(cur);

		for (const tb of tables) {
			if (tb.rows.length < 2) {
				renderProblems.push(`${doc} L${tb.start + 1}: 单行表格（缺分隔行）`);
				continue;
			}
			const sep = ls[tb.rows[1]];
			if (!/^\s*\|[\s:|-]+\|\s*$/.test(sep)) {
				renderProblems.push(`${doc} L${tb.rows[1] + 1}: 表格第 2 行不是分隔行`);
			}
		}

		// 14f. 表格列数一致（**排除行内代码里的 `|`**）
		for (const tb of tables) {
			const counts = new Set();
			for (const idx of tb.rows) {
				let n = 0, inCode = false;
				for (let j = 0; j < ls[idx].length; j++) {
					if (ls[idx][j] === "`") inCode = !inCode;
					if (ls[idx][j] === "|" && (j === 0 || ls[idx][j - 1] !== "\\") && !inCode) n++;
				}
				counts.add(n);
			}
			if (counts.size > 1) {
				renderProblems.push(`${doc} L${tb.start + 1}: 表格列数 ${[...counts].join("/")}`);
			}
		}
	}

	console.log(`  检查 ${RENDER_DOCS.length} 个文档，${renderProblems.length} 处渲染问题`);
	ck("所有文档的 Markdown 渲染结构正确", renderProblems.length === 0,
		renderProblems.slice(0, 5).join("; "));
	for (const p of renderProblems.slice(0, 8)) console.log(`    ❌ ${p}`);
	if (renderProblems.length === 0) console.log("  ✅ 全部正确");
}

// ===========================================================================
// 15. 真实解析规则验证（缺陷 84）
//
// 现有检查是「结构启发式」（以 | 开头就算表格行），但 CommonMark 的真实规则是
// **必须 header + delimiter 行**；没有 delimiter 的 | 块不会渲染成表格。
// 而且第 9 节只覆盖 2 个文件、第 13 节只覆盖 5 个，实际有 8 个文档、22 个表格。
// ===========================================================================
console.log("\n=== 15. 真实解析规则验证 ===");
{
	const ALL8 = [
		"README.md",
		"README.en.md",
		"SUBMIT-GUIDE.zh.md",
		"PASTE-READY.zh.md",
		"community/discussion-deepseek-harness.md",
		"community/feedback-stepfun.zh.md",
		"community/issue-deepseek-harness.zh.md",
		"community/issue-deepseek-harness.en.md",
	];

	// 按 CommonMark 规则找表格：必须 header + delimiter
	function findRealTables(ls) {
		let inFence = false;
		let fenceChar = null;
		const out = [];
		let i = 0;
		while (i < ls.length) {
			const fm = ls[i].match(/^\s*(`{3,}|~{3,})/);
			if (fm) {
				if (!inFence) { inFence = true; fenceChar = fm[1][0]; }
				else if (fm[1][0] === fenceChar) inFence = false;
				i++;
				continue;
			}
			if (inFence) { i++; continue; }

			const isRow = /^\s*\|/.test(ls[i]);
			const next = ls[i + 1] ?? "";
			const isDelim = /^\s*\|?[\s:|-]*\|[\s:|-]*$/.test(next) && /-/.test(next);

			if (isRow && isDelim) {
				const start = i;
				const rows = [ls[i], next];
				i += 2;
				while (i < ls.length && /^\s*\|/.test(ls[i])) { rows.push(ls[i]); i++; }
				out.push({ startLine: start + 1, rows });
				continue;
			}
			i++;
		}
		return out;
	}

	function countPipesReal(line) {
		let n = 0;
		for (let i = 0; i < line.length; i++) {
			if (line[i] === "\\") { i++; continue; }
			if (line[i] === "|") n++;
		}
		return n;
	}

	const problems = [];
	let totalTables = 0;
	let totalFences = 0;

	for (const doc of ALL8) {
		const fp = path.join(ROOT, doc);
		if (!fs.existsSync(fp)) continue;
		const text = fs.readFileSync(fp).toString("utf8");
		const ls = text.split(/\r?\n/);

		// 围栏闭合检查（含 ~ 与 ` 两种）
		let inF = false, fChar = null, fStart = 0, fences = 0;
		for (let i = 0; i < ls.length; i++) {
			const m = ls[i].match(/^\s*(`{3,}|~{3,})/);
			if (!m) continue;
			if (!inF) { inF = true; fChar = m[1][0]; fStart = i + 1; fences++; }
			else if (m[1][0] === fChar) { inF = false; }
		}
		if (inF) problems.push(doc + " L" + fStart + ": 围栏未闭合");
		totalFences += fences;

		// 表格检查
		const tables = findRealTables(ls);
		totalTables += tables.length;

		for (let k = 0; k < tables.length; k++) {
			const tb = tables[k];
			const counts = tb.rows.map(countPipesReal);
			const uniq = [...new Set(counts)];
			if (uniq.length > 1) {
				problems.push(doc + " L" + tb.startLine + ": 表格列数 " + uniq.join("/"));
			}
		}
	}

	console.log("  检查 " + ALL8.length + " 个文档");
	console.log("  真实表格: " + totalTables + " 个，代码围栏: " + totalFences + " 个");
	console.log("  问题: " + problems.length + " 处");

	ck("8 个文档的真实渲染结构正确", problems.length === 0, problems.slice(0, 4).join("; "));
	for (const p of problems.slice(0, 8)) console.log(`    ❌ ${p}`);
	if (problems.length === 0) console.log("  ✅ 全部正确");

	// **反向验证**：必须真的找到足够多的表格（防止空转）
	ck("找到足够的真实表格（非空转）", totalTables >= 20, "只找到 " + totalTables + " 个");
	// 围栏必须成对
	// **缺陷 100**：这里原来断言 totalFences % 2 === 0，但 totalFences 数的是
	// 「起始围栏数」（只有开启时 +1）。当某个文件里出现 **缩进围栏** 或
	// **info string 变体**（例如 ```bash / ```），起止识别可能不对称，
	// 于是这个断言会因为**度量方式**而失败，而不是文档真的有问题。
	//
	// 正确做法：统计**所有围栏行**（开+关），要求每个文件内为偶数。
	let allFenceLines = 0;
	const oddFiles = [];
	for (const doc of ALL8) {
		const fp = path.join(ROOT, doc);
		if (!fs.existsSync(fp)) continue;
		const ls = fs.readFileSync(fp).toString("utf8").split(/\r?\n/);
		let n = 0;
		for (const l of ls) if (/^\s*(`{3,}|~{3,})/.test(l)) n++;
		allFenceLines += n;
		if (n % 2 !== 0) oddFiles.push(doc + "(" + n + ")");
	}
	ck("每个文档的代码围栏都成对（围栏行数为偶数）", oddFiles.length === 0, oddFiles.join(", "));
	console.log("  围栏行总数: " + allFenceLines + (oddFiles.length === 0 ? "（全部成对）" : "，奇数文件: " + oddFiles.join(", ")));
}

console.log("\n=== 16. 有序列表的编号必须连续（缺陷 144） ===");
{
	// **缺陷 144**（第 138 轮）：第 137 轮我给英文 README 换掉一段警告文字时，
	// **多删了一行** —— 结果 `## Uninstall` 的编号从 `1 → 2 → 4. Restart`，
	// **步骤 3（删除插件目录）整段消失**。英文读者会以为「删完 patch 条目就完事了」。
	//
	// 同一轮我还把中文卸载命令块上方的围栏写重了一行，Markdown 渲染出空代码块。
	// **两类损伤都不会让任何既有断言失败** —— 只有专门检查才会发现。
	//
	// 判据：连续的有序列表项，编号必须逐个 +1（同缩进层级内）。空行或非列表行会打断列表。
	const OLV_FILES = ["README.md", "README.en.md", "SUBMIT-GUIDE.zh.md",
		"community/discussion-deepseek-harness.md", "PASTE-READY.zh.md"];
	const olvBad = [];
	let olvChecked = 0;
	for (const rel of OLV_FILES) {
		const p = path.join(ROOT, rel);
		if (!fs.existsSync(p)) continue;
		const ls = fs.readFileSync(p, "utf8").split("\n");
		let inFence = false, prevNum = -1, prevLine = -1;
		for (let i = 0; i < ls.length; i++) {
			const l = ls[i];
			// **缺陷 144 自我修正**：围栏**不重置** `prevNum` ——
			// 代码块常是有序列表项**本身的内容**（例如「2. 编辑文件：」）
			//         ```yaml
			//         - insert: ...
			//         ```
			// 若围栏处把 prevNum 清空，紧随其后的「3.」就会被当成新列表的开头，
			// **跳号永远检测不到**（第一版正是因此漏掉了注入的变异）。
			if (/^\s*```/.test(l)) { inFence = !inFence; continue; }
			if (inFence) continue;
			if (l.trim() === "") { prevNum = -1; continue; }
			const m = l.match(/^(\s*)(\d+)\.\s+/);
			if (!m) { if (/^\S/.test(l)) prevNum = -1; continue; }
			const num = Number(m[2]), indent = m[1].length;
			if (prevNum > 0 && num !== prevNum + 1 && indent <= 3) {
				olvBad.push(`${rel} L${i + 1}: ${prevNum} → ${num}（L${prevLine} 之后跳号）`);
			}
			prevNum = num; prevLine = i + 1;
			olvChecked++;
		}
	}
	console.log(`  检查 ${OLV_FILES.length} 个文档，有序列表项 ${olvChecked} 个`);
	// **反向验证**：必须真的扫到足够多的列表项（防正则失效后空转）
	ck("至少扫描到 40 个有序列表项（防正则失效）", olvChecked >= 40, "只扫描到 " + olvChecked);
	ck("有序列表编号连续（无跳号）", olvBad.length === 0, olvBad.slice(0, 5).join("; "));
	if (olvBad.length > 0) for (const b of olvBad) console.log("    ❌ " + b);
}
console.log(`\n===== 文档结构完整性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
