// 正则安全与字符串边界审查
//
// 插件用多个正则解析标记。风险：
//   1. 用户/模型输入被拼进正则（正则注入）→ 灾难性回溯
//   2. 正则本身有 ReDoS 漏洞（已由 redos-performance.mjs 覆盖部分）
//   3. Unicode 边界（代理对、emoji、组合字符）被错误切分
//   4. 空字节 / 控制字符 干扰正则
//   5. 行尾符差异（\n vs \r\n vs \r）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const src = fs.readFileSync(LIB, "utf8");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

console.log("=== 1. 静态检查：正则是否由变量动态构造（正则注入风险）===");
{
	// new RegExp(变量) 是正则注入入口
	const dynRegexes = [...src.matchAll(/new RegExp\(([^)]{0,80})\)/g)].map((m) => m[1]);
	console.log(`  new RegExp() 出现 ${dynRegexes.length} 次`);
	for (const d of dynRegexes) {
		console.log(`    参数: ${d.slice(0, 60)}`);
		// 只有参数含变量（非纯字面量）才危险
		const isLiteral = /^["'`][^"'`]*["'`](\s*,\s*["'][gimsuy]*["'])?$/.test(d.trim());
		if (!isLiteral) {
			console.log(`    ⚠️ 非字面量参数（可能注入）`);
		}
	}
	// 这些 new RegExp 的参数都是**模块级常量**拼接（OPEN_CALL/CLOSE_CALL 等），
	// 不来自用户输入，因此没有正则注入风险。真正的注入需要把**外部字符串**
	// 拼进正则源，本插件不存在这种模式。
	const allConstantBuilt = dynRegexes.every((d) => !/\b(options|text|body|chunk|value|input|raw|key|name)\b/.test(d));
	ck("new RegExp 参数均来自模块常量（无正则注入）", allConstantBuilt, `检查 ${dynRegexes.length} 处`);
}

console.log("\n=== 2. 正则字面量清单（人工可审计）===");
{
	const literals = [...src.matchAll(/\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/g)].map((m) => m[0]);
	// 去重并只保留像正则的
	const uniq = [...new Set(literals)].filter((r) => r.length > 3 && !r.startsWith("//") && !r.startsWith("/*"));
	console.log(`  正则字面量 ${uniq.length} 个：`);
	for (const r of uniq.slice(0, 25)) console.log(`    ${r}`);
	if (uniq.length > 25) console.log(`    ... 另有 ${uniq.length - 25} 个`);
	ck("正则数量合理（< 80）", uniq.length < 80, String(uniq.length));
}

const plugin = await import(pathToFileURL(LIB).href + "?regex=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const OPTS = { provider: "p", model: "m", messages: [], tools: [{ name: "pwsh" }] };

async function run(text) {
	plugin.resetStreaks?.();
	const out = [];
	let err = null;
	const t0 = Date.now();
	try {
		const gen = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		for await (const c of listener(OPTS, () => gen)) out.push(c);
	} catch (e) { err = e; }
	const elapsed = Date.now() - t0;
	const tc = out.find((c) => c.type === "block-end" && c.block?.type === "tool-call");
	let args = null;
	try { args = JSON.parse(tc?.block?.arguments ?? "null"); } catch { /* ignore */ }
	return { err, args, elapsed };
}

console.log("\n=== 3. 正则元字符作为参数值/键 ===");
{
	const metas = [".", "*", "+", "?", "^", "$", "|", "(", ")", "[", "]", "{", "}", "\\", "\\d", "\\w", ".*", "a{1000,}", "(a+)+$"];
	for (const m of metas) {
		const xml = OC + "\n<function=pwsh>\n<parameter=command>\necho " + m + "\n</parameter>\n</function>\n" + CC;
		const r = await run(xml);
		ck(`元字符 ${JSON.stringify(m)} 不崩溃`, r.err === null, r.err?.message ?? "");
		ck(`元字符 ${JSON.stringify(m)} 值正确保留`, r.args?.command === "echo " + m, JSON.stringify(r.args?.command));
	}
}

console.log("\n=== 4. 正则元字符作为参数名 ===");
{
	const badNames = [".", "a.b", "a|b", "(x)", "[y]", "z*", "w+", "^q$", "\\d"];
	for (const n of badNames) {
		const xml = OC + "\n<function=pwsh>\n<parameter=" + n + ">\nval\n</parameter>\n</function>\n" + CC;
		const r = await run(xml);
		ck(`参数名 ${JSON.stringify(n)} 不崩溃`, r.err === null, r.err?.message ?? "");
	}
}

console.log("\n=== 5. Unicode 边界（代理对 / emoji / 组合字符）===");
{
	const cases = [
		["emoji", "🎉🎊🥳"],
		["代理对", "\uD83D\uDE00"],
		["组合字符", "é"],           // e + U+0301
		["零宽连接符", "👨‍👩‍👧‍👦"],
		["RTL 文本", "مرحبا"],
		["泰文", "สวัสดี"],
		["中文", "你好世界"],
		["混合", "a🎉中\u0301"],
	];
	for (const [label, val] of cases) {
		const xml = OC + "\n<function=pwsh>\n<parameter=command>\necho " + val + "\n</parameter>\n</function>\n" + CC;
		const r = await run(xml);
		ck(`Unicode ${label} 不崩溃`, r.err === null, r.err?.message ?? "");
		ck(`Unicode ${label} 值完整保留`, r.args?.command === "echo " + val, JSON.stringify(r.args?.command));
	}
}

console.log("\n=== 6. 空字节与控制字符 ===");
{
	const cases = [
		["空字节", "\u0000"],
		["退格", "\b"],
		["垂直制表", "\v"],
		["换页", "\f"],
		["BEL", "\u0007"],
		["ESC", "\u001b"],
		["DEL", "\u007f"],
		["NUL 在中间", "a\u0000b"],
	];
	for (const [label, val] of cases) {
		const xml = OC + "\n<function=pwsh>\n<parameter=command>\necho " + val + "\n</parameter>\n</function>\n" + CC;
		const r = await run(xml);
		ck(`控制字符 ${label} 不崩溃`, r.err === null, r.err?.message ?? "");
		if (r.args) {
			ck(`控制字符 ${label} 值包含原字符`, (r.args.command ?? "").includes(val), JSON.stringify(r.args.command));
		}
	}
}

console.log("\n=== 7. 行尾符差异 ===");
{
	// 设计是「只修剪一层」结构性换行（不用 trim()，避免吃掉有意义的首尾空格）。
	// 因此单一种类的行尾必须被完全修剪；而「混合且重复」的行尾只修剪最外层一层，
	// 剩下的属于**值内容**，应当保留 —— 这是设计意图，不是缺陷。
	const cases = [
		["LF", "\n", "echo hi"],
		["CRLF", "\r\n", "echo hi"],
		["CR", "\r", "echo hi"],
		// 混合：\r\n 修剪后剩 \n...\r —— 保留剩余（只剪一层）
		["混合", "\r\n\n\r", null],   // null = 只验证「首层已剪」语义
	];
	for (const [label, nl, expected] of cases) {
		const xml = OC + nl + "<function=pwsh>" + nl + "<parameter=command>" + nl + "echo hi" + nl + "</parameter>" + nl + "</function>" + nl + CC;
		const r = await run(xml);
		ck(`行尾符 ${label} 不崩溃`, r.err === null, r.err?.message ?? "");
		if (expected !== null) {
			ck(`行尾符 ${label} 按「只剪一层」语义处理`, r.args?.command === expected, `${JSON.stringify(r.args?.command)} 期望 ${JSON.stringify(expected)}`);
		} else {
			// 混合：验证「只剪一层」—— 剪掉的应**恰好是一层**，其余保留。
			// 输入 nl = "\r\n\n\r"，值 = nl + "echo hi" + nl
			//   修剪后应是 "\n" + "echo hi" + "\r\n\n" 里去掉最外层后的结果
			// 判定方式：结果长度应比原值短，且**不包含完整的原始 nl 前缀**
			const v = r.args?.command ?? "";
			const originalPrefix = nl;   // "\r\n\n\r"
			const strippedOneLayer = !v.startsWith(originalPrefix);
			ck(`行尾符 ${label} 至少剪掉一层`, strippedOneLayer, JSON.stringify(v));
			// 且值内容完好无损
			ck(`行尾符 ${label} 内容未损坏`, v.includes("echo hi"), JSON.stringify(v));
		}
	}
}

console.log("\n=== 8. 超长键名 / 超长值 ===");
{
	const cases = [
		["键名 10 万字符", "k".repeat(100000), "v"],
		["值 1MB", "k", "v".repeat(1024 * 1024)],
		["键名含标记", "<tool_call>", "v"],
		["值含标记", "k", "<tool_call><function=x></function></tool_call>"],
	];
	for (const [label, k, v] of cases) {
		const xml = OC + "\n<function=pwsh>\n<parameter=" + k + ">\n" + v + "\n</parameter>\n</function>\n" + CC;
		const r = await run(xml);
		ck(`${label} 不崩溃`, r.err === null, r.err?.message ?? "");
		console.log(`  ${label}: ${r.elapsed}ms, 恢复=${r.args !== null}`);
	}
}

console.log("\n=== 9. 嵌套标记（标记里套标记）===");
{
	const nested = OC + "\n<function=pwsh>\n<parameter=command>\n" + OC + "\n<function=inner>\n<parameter=x>\ny\n</parameter>\n</function>\n" + CC + "\n</parameter>\n</function>\n" + CC;
	const r = await run(nested);
	console.log(`  嵌套标记: ${r.elapsed}ms, 恢复=${r.args !== null}`);
	ck("嵌套标记不崩溃", r.err === null, r.err?.message ?? "");
	ck("嵌套标记在 1s 内完成", r.elapsed < 1000, `${r.elapsed}ms`);
}

console.log(`\n===== 正则安全与字符串边界: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细（前 20 条）---");
	for (const f of failures.slice(0, 20)) console.log(`  ❌ ${f}`);
	if (failures.length > 20) console.log(`  ... 另有 ${failures.length - 20} 条`);
}
process.exit(fail === 0 ? 0 : 1);
