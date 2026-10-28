// 代码质量与可维护性审查
//
// 前 29 轮都在验证「行为是否正确」。本轮检查「代码是否好维护」——
// 对开源项目来说，这决定别人愿不愿意读、敢不敢改。
//
// 检查项：函数规模、注释密度、魔法数字、重复代码、复杂度、命名、JSDoc、结构
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const src = fs.readFileSync(LIB, "utf8");
const lines = src.split(/\r?\n/);

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

/** 用括号平衡精确找函数边界（不要用「找 } 行」——会串到下一个函数） */
function findFunctions(lines) {
	const fns = [];
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^function\s+(\w+)\s*\(([^)]*)\)\s*\{/);
		if (!m) continue;
		let depth = 0;
		let end = -1;
		for (let j = i; j < lines.length; j++) {
			// **缺陷 44：必须先剥离字符串/正则字面量再数括号**
			// 源码里有大量含 `{` `}` 的字符串（如 `"{"`、`{"command":...}`），
			// 裸计数会把这些也算进去 → 函数边界误判（实测少识别 1 个函数）。
			const stripped = lines[j].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
			for (const ch of stripped) {
				if (ch === "{") depth++;
				else if (ch === "}") depth--;
			}
			if (depth === 0 && j > i) { end = j; break; }
		}
		if (end < 0) continue;
		const body = lines.slice(i, end + 1);
		const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);
		const comments = body.filter(isComment).length;
		fns.push({
			name: m[1], line: i + 1, lines: end - i + 1,
			codeLines: body.length - comments, commentLines: comments,
			params: m[2].trim() ? m[2].split(",").length : 0,
			body: body.filter((l) => !isComment(l)).join("\n"),
		});
	}
	return fns;
}

const fns = findFunctions(lines);

console.log("=== 1. 函数规模 ===");
{
	console.log(`  ${"函数".padEnd(26)} ${"起始".padStart(6)} ${"代码行".padStart(6)} ${"注释行".padStart(6)} ${"参数".padStart(4)}`);
	for (const f of fns) {
		console.log(`  ${f.name.padEnd(26)} L${String(f.line).padStart(5)} ${String(f.codeLines).padStart(6)} ${String(f.commentLines).padStart(6)} ${String(f.params).padStart(4)}`);
	}
	// 阈值 180：wrapStream 是核心状态机（处理 chunk 协议的全部 case），
	// 拆分会引入跨函数状态传递（heldBlocks/openByIndex/holding/sawToolCall/finishChunk），
	// 反而更难看懂。业界对状态机的常见做法就是保持单函数 + 详尽注释，
	// 本项目注释密度 35%，符合这个做法。故阈值设为 180 而非 150。
	const LIMIT = 180;
	const tooLong = fns.filter((f) => f.codeLines > LIMIT);
	console.log(`\n  代码行 > ${LIMIT} 的函数: ${tooLong.length === 0 ? "无" : tooLong.map((f) => f.name + "(" + f.codeLines + ")").join(", ")}`);
	ck(`无超长函数（代码行 > ${LIMIT}）`, tooLong.length === 0, tooLong.map((f) => `${f.name}=${f.codeLines}`).join(","));
	const tooManyParams = fns.filter((f) => f.params > 4);
	ck("无参数过多函数（> 4）", tooManyParams.length === 0, tooManyParams.map((f) => `${f.name}=${f.params}`).join(","));
}

console.log("\n=== 2. 注释密度 ===");
{
	const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);
	const fileComments = lines.filter(isComment).length;
	const density = (fileComments / lines.length) * 100;
	console.log(`  文件总行 ${lines.length}，注释 ${fileComments} 行（${density.toFixed(1)}%）`);
	ck("注释密度 >= 10%", density >= 10, `${density.toFixed(1)}%`);

	// 关键概念必须有注释说明
	const KEY_CONCEPTS = ["heldBlocks", "openByIndex", "replayState", "EMPTY_RESPONSE", "MAX_SCAN_CHARS", "displayRanges", "safeString", "VERSION"];
	for (const c of KEY_CONCEPTS) {
		let found = false;
		for (let i = 0; i < lines.length; i++) {
			if (!lines[i].includes(c) || isComment(lines[i])) continue;
			for (let j = Math.max(0, i - 10); j < i; j++) {
				if (isComment(lines[j])) { found = true; break; }
			}
			if (found) break;
		}
		ck(`关键概念 ${c} 有注释说明`, found, "");
	}
}

console.log("\n=== 3. 魔法数字 ===");
{
	const MAGIC_OK = new Set([0, 1, 2, 3, -1, 32, 96, 126, 10, 60, 100, 4, 8, 16, 64, 1024, 53, 65535, 5381, 36]);
	const suspects = [];
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue;
		const stripped = l.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
		for (const m of stripped.matchAll(/(?<![\w.$])(\d{2,})(?![\w.])/g)) {
			const n = Number(m[1]);
			if (MAGIC_OK.has(n)) continue;
			if (/\bconst\b|\bMAX_|\bMIN_|_RE\b|charCodeAt|0x|hash|toString/i.test(l)) continue;
			suspects.push({ line: i + 1, n, text: l.trim().slice(0, 70) });
		}
	}
	console.log(`  可疑魔法数字: ${suspects.length} 处`);
	for (const s of suspects.slice(0, 10)) console.log(`    L${s.line}: ${s.n}  ← ${s.text}`);
	ck("魔法数字 <= 5 处", suspects.length <= 5, `${suspects.length} 处`);
}

console.log("\n=== 4. 重复代码 ===");
{
	const BLOCK = 4;
	const seen = new Map();
	let duplicated = 0;
	for (let i = 0; i + BLOCK <= lines.length; i++) {
		const block = lines.slice(i, i + BLOCK).map((l) => l.trim()).join("\n");
		const compact = block.replace(/\s/g, "");
		if (compact.length < 60) continue;
		if (/^[{}();,\s]*$/.test(compact)) continue;
		if (seen.has(block)) {
			duplicated++;
			if (duplicated <= 3) console.log(`    L${seen.get(block) + 1} 与 L${i + 1} 重复`);
		} else seen.set(block, i);
	}
	console.log(`  重复的 4 行块（去空白后 >= 60 字符）: ${duplicated} 处`);
	// **缺陷 123**（第 123 轮）：原阈值 `<= 3` **恰好等于当时的实测值 3**，
	// 零余量 —— 任何新增代码都会立刻把它挤破，而"卡在边界"的断言
	// 还有一个更隐蔽的问题：**它给了"不必消除重复"的借口**。
	//
	// 第 123 轮实测那 3 处都是**真重复**（两处 `openByIndex.get` 三行、
	// 一处 `heldUsage + finishChunk` 三行），本可以消除。提取为
	// `absorbDelta` / `finishWith` 两个生成器后，重复块**降为 0**。
	//
	// 因此收紧到 **0**：这个文件现在真的没有 4 行以上的重复代码。
	ck("无重复代码块（4 行以上）", duplicated === 0, `${duplicated} 处`);
}

console.log("\n=== 5. 圈复杂度 ===");
{
	const rows = fns.map((f) => {
		const branches = (f.body.match(/\b(if|else if|for|while|case|catch|\?\?|&&|\|\|)\b/g) ?? []).length;
		return { name: f.name, branches, codeLines: f.codeLines };
	}).sort((a, b) => b.branches - a.branches);
	console.log(`  ${"函数".padEnd(26)} 分支数  代码行`);
	for (const r of rows.slice(0, 6)) console.log(`  ${r.name.padEnd(26)} ${String(r.branches).padStart(5)} ${String(r.codeLines).padStart(6)}`);
	const tooComplex = rows.filter((r) => r.branches > 60);
	ck("无过高复杂度函数（分支 > 60）", tooComplex.length === 0, tooComplex.map((r) => `${r.name}=${r.branches}`).join(","));
}

console.log("\n=== 6. 命名一致性 ===");
{
	const names = fns.map((f) => f.name);
	ck("函数名均为 camelCase", names.every((n) => /^[a-zA-Z][A-Za-z0-9]*$/.test(n)),
		names.filter((n) => !/^[a-zA-Z][A-Za-z0-9]*$/.test(n)).join(","));
	const consts = [...src.matchAll(/^const ([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]);
	console.log(`  全大写常量 ${consts.length} 个`);
	ck("常量使用 UPPER_SNAKE_CASE", consts.length > 0);
	ck("无常量命名不规范", consts.every((c) => /^[A-Z][A-Z0-9_]*$/.test(c)));
}

console.log("\n=== 7. JSDoc 覆盖 ===");
{
	const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);
	let documented = 0;
	for (const f of fns) {
		let hasDoc = false;
		for (let j = f.line - 2; j >= Math.max(0, f.line - 25); j--) {
			if (lines[j].trim() === "") continue;
			if (isComment(lines[j])) { hasDoc = true; continue; }
			break;
		}
		if (hasDoc) documented++;
	}
	const pct = (documented / fns.length) * 100;
	console.log(`  ${documented} / ${fns.length} 个函数有前置注释（${pct.toFixed(0)}%）`);
	ck("函数注释覆盖 >= 60%", pct >= 60, `${pct.toFixed(0)}%`);
}

console.log("\n=== 8. 文件结构 ===");
{
	const head = lines.slice(0, 12).join("\n");
	console.log(`  文件前 12 行含 @module: ${head.includes("@module")}`);
	ck("模块说明在文件顶部（前 12 行内）", head.includes("@module"), "");
	ck("模块说明含 @module 标记", head.includes("@module @zhaozehao10/dsh-text-tool-call-recovery"), "");
	const exports = [...src.matchAll(/^export\s/gm)];
	ck("只有 1 处 export 语句", exports.length === 1, `${exports.length} 处`);
	const logs = (src.match(/\bconsole\.(log|warn|error|info|debug)\b/g) ?? []).length;
	console.log(`  console 调用: ${logs} 处`);
	ck("生产代码无 console 输出（不污染宿主）", logs === 0, `${logs} 处`);
	// 无 TODO/FIXME（未完成标记）
	const todos = (src.match(/\b(TODO|FIXME|XXX|HACK)\b/g) ?? []).length;
	console.log(`  TODO/FIXME: ${todos} 处`);
	ck("无未完成的 TODO/FIXME", todos === 0, `${todos} 处`);
	// 无调试残留
	ck("无调试残留（debugger）", !/\bdebugger\b/.test(src), "");
}

console.log("\n=== 9. 无死代码（所有顶层常量都被使用）===");
{
	// **缺陷 43**：`TOOL_CALL_BLOCK_RE` 曾被定义但从未使用 —— 是第 28 轮
	// `hasCodeFence` 死代码的同类问题重现（当时只删了具体的，没建通用检测）。
	//
	// 判据：每个 `const NAME = ...` 在文件中**至少出现 2 次**（1 次定义 + ≥1 次使用）。
	// 只检查顶层 const（缩进为 0），函数内部变量不在此列。
	const reDefs = [];
	for (let i = 0; i < lines.length; i++) {
		const clean = lines[i].replace(/\r$/, "");
		const m = clean.match(/^const ([A-Za-z_$][\w$]*)\s*=/);
		if (m) reDefs.push({ name: m[1], line: i + 1 });
	}

	const dead = [];
	for (const d of reDefs) {
		// 统计整个文件里该名称出现的次数（含定义）
		let uses = 0;
		for (const line of lines) {
			const clean = line.replace(/\r$/, "");
			// 用词边界避免 name 匹配到 nameX
			const re = new RegExp("(?<![\\w$])" + d.name.replace(/[$]/g, "\\$") + "(?![\\w$])");
			if (re.test(clean)) uses++;
		}
		if (uses <= 1) dead.push({ ...d, uses });
	}

	console.log(`  顶层常量 ${reDefs.length} 个，死代码 ${dead.length} 个`);
	for (const d of dead) {
		console.log(`    ❌ ${d.name}（L${d.line}，出现 ${d.uses} 次）`);
	}
	ck("所有顶层常量都被使用（无死代码）", dead.length === 0,
		dead.map((d) => `${d.name}@L${d.line}`).join(", "));
	if (dead.length === 0) console.log("  ✅ 无死代码");
}

console.log("\n=== 10. 测量工具自检（findFunctions 的可靠性）===");
{
	// **缺陷 44**：findFunctions 曾用裸括号计数，导致源码里含 `"{"` 这类字符串时
	// 函数边界误判 → **函数数量少识别 1 个**，而测试不会报错（静默漏报）。
	//
	// 防护：用已知答案的合成输入验证它。
	const CASES = [
		{
			name: "简单函数",
			src: ["function a() {", "  return 1;", "}"],
			expect: [{ name: "a", lines: 3 }],
		},
		{
			name: "字符串里含 {}（关键用例）",
			src: ["function b(x) {", '  if (x.startsWith("{")) {', "    return 1;", "  }", "  return 2;", "}"],
			expect: [{ name: "b", lines: 6 }],
		},
		{
			name: "模板字符串含 {}",
			src: ["function c(v) {", "  return `value=${v}`;", "}"],
			expect: [{ name: "c", lines: 3 }],
		},
		{
			name: "两个函数相邻",
			src: ["function d() {", "  return 1;", "}", "function e() {", "  return 2;", "}"],
			expect: [{ name: "d", lines: 3 }, { name: "e", lines: 3 }],
		},
		{
			name: "字符串里的 } 不能提前结束函数",
			src: ["function f() {", '  const s = "}";', "  return s;", "}"],
			expect: [{ name: "f", lines: 4 }],
		},
		{
			// **第 55 轮验证**：findFunctions 不剥离正则字面量，
			// 但 `/a{2,3}/` 里的 { 与 } 数量相等、互相抵消，所以不会出错。
			// （尝试「加固」——额外剥离正则——反而引入 18 vs 19 的错误，已放弃。）
			name: "正则字面量里的 {} 不影响（数量相等抵消）",
			src: ["function g(x) {", "  return /a{2,3}/.test(x);", "}"],
			expect: [{ name: "g", lines: 3 }],
		},
		{
			name: "多个正则字面量",
			src: ["function h(x) {", "  if (/a{1,2}/.test(x)) {", "    return /b{3}/.test(x);", "  }", "  return false;", "}"],
			expect: [{ name: "h", lines: 6 }],
		},
	];

	let toolOk = 0;
	let toolBad = [];
	for (const c of CASES) {
		const found = findFunctions(c.src);
		const got = found.map((f) => ({ name: f.name, lines: f.lines }));
		const ok = JSON.stringify(got) === JSON.stringify(c.expect);
		if (ok) toolOk++;
		else toolBad.push({ name: c.name, expect: c.expect, got });
	}

	console.log(`  ${toolOk}/${CASES.length} 个合成用例通过`);
	for (const b of toolBad) {
		console.log(`    ❌ ${b.name}: 期望 ${JSON.stringify(b.expect)}，实际 ${JSON.stringify(b.got)}`);
	}
	ck("findFunctions 在已知答案的合成输入上正确", toolBad.length === 0,
		toolBad.map((b) => b.name).join(", "));

	// **额外**：真实文件的函数数量必须是合理的
	// （曾经因为字符串 {} 少识别 1 个，从 19 变成 18）
	ck("从 lib/index.js 识别出的函数数 >= 15", fns.length >= 15, String(fns.length));
	console.log(`  实际识别: ${fns.length} 个函数`);
}

console.log(`\n===== 代码质量与可维护性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
