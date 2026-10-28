// 文本保真度审查（stripped text fidelity）
//
// 插件恢复调用后，会从文本里剥离掉工具调用标记，剩下的文本是**用户看到的模型消息**。
// 若剥离过程丢字、重复、顺序错乱，用户就会看到错误内容——这是最直接的体验问题。
//
// 本测试的核心不变量：
//   stripped == 原文 - 所有被识别为调用的标记区间（一字不差，顺序不变）
//
// 覆盖：
//   1. 单个/多个调用
//   2. 调用前后都有正文
//   3. 调用在开头/结尾
//   4. 无法解析的标记必须**原样保留**（不能丢）
//   5. 展示区内的标记必须保留
//   6. 文本中无调用时必须完全不变
//   7. 剥离后为空 / 只剩空白
//   8. 特殊字符（emoji、换行、制表符）保持原样
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

const plugin = await import(pathToFileURL(LIB).href + "?fid=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } },
	{ name: "read", parameters: { type: "object", properties: { file_path: { type: "string" } } } },
];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };

async function run(text) {
	plugin.resetStreaks?.();
	const out = [];
	let err = null;
	try {
		const gen = (async function* () {
			yield { type: "block-start", index: 0, blockType: "text" };
			yield { type: "text-delta", index: 0, text };
			yield { type: "block-end", index: 0, block: { type: "text", text } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		for await (const c of listener(OPTS, () => gen)) out.push(c);
	} catch (e) { err = e; }

	// 恢复后的文本 = 所有 text 块的 block-end.text 拼接
	const textBlocks = out.filter((c) => c.type === "block-end" && c.block?.type === "text");
	const stripped = textBlocks.map((c) => c.block.text ?? "").join("");
	const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	const fin = out.find((c) => c.type === "finish");
	return { stripped, calls, fin, err, out };
}

const mkCall = (tool, key, val) => OC + "\n<function=" + tool + ">\n<parameter=" + key + ">\n" + val + "\n</parameter>\n</function>\n" + CC;

console.log("=== 1. 调用前后都有正文 → 正文必须完整保留 ===");
{
	const before = "这是调用前的说明文字。";
	const after = "这是调用后的补充说明。";
	const text = before + "\n" + mkCall("pwsh", "command", "echo hi") + "\n" + after;
	const r = await run(text);
	console.log(`  原文: ${JSON.stringify(text.slice(0, 60))}...`);
	console.log(`  恢复后: ${JSON.stringify(r.stripped)}`);
	ck("恢复了 1 个调用", r.calls.length === 1, String(r.calls.length));
	ck("调用前正文完整", r.stripped.includes(before), JSON.stringify(r.stripped));
	ck("调用后正文完整", r.stripped.includes(after), JSON.stringify(r.stripped));
	ck("不含残留标记", !r.stripped.includes(OC) && !r.stripped.includes("<function="), JSON.stringify(r.stripped));
	// 顺序必须保持
	ck("正文顺序正确", r.stripped.indexOf(before) < r.stripped.indexOf(after), JSON.stringify(r.stripped));
}

console.log("\n=== 2. 多个调用 → 之间的正文必须保留 ===");
{
	const a = "第一段。";
	const b = "第二段。";
	const c = "第三段。";
	const text = a + mkCall("pwsh", "command", "echo 1") + b + mkCall("read", "file_path", "/x") + c;
	const r = await run(text);
	console.log(`  恢复后: ${JSON.stringify(r.stripped)}`);
	ck("恢复了 2 个调用", r.calls.length === 2, String(r.calls.length));
	ck("第一段保留", r.stripped.includes(a), "");
	ck("第二段保留", r.stripped.includes(b), "");
	ck("第三段保留", r.stripped.includes(c), "");
	ck("三段顺序正确", r.stripped.indexOf(a) < r.stripped.indexOf(b) && r.stripped.indexOf(b) < r.stripped.indexOf(c), JSON.stringify(r.stripped));
}

console.log("\n=== 3. 调用在开头 / 结尾 ===");
{
	const call = mkCall("pwsh", "command", "echo hi");
	const cases = [
		["开头", call + "后面的正文。", "后面的正文。"],
		["结尾", "前面的正文。" + call, "前面的正文。"],
		["只有调用", call, ""],
	];
	for (const [label, text, expectContains] of cases) {
		const r = await run(text);
		ck(`${label} → 恢复 1 个调用`, r.calls.length === 1, String(r.calls.length));
		if (expectContains) {
			ck(`${label} → 正文保留`, r.stripped.includes(expectContains), JSON.stringify(r.stripped));
		} else {
			ck(`${label} → 剥离后为空`, r.stripped.trim() === "", JSON.stringify(r.stripped));
		}
	}
}

console.log("\n=== 4. 无法解析的标记必须原样保留（不能丢内容）===");
{
	const cases = [
		["未声明工具", OC + "\n<function=unknown_tool>\n<parameter=x>\ny\n</parameter>\n</function>\n" + CC],
		["空函数体", OC + CC],
		["只有开标记", OC + "\n<function=pwsh>"],
		["只有闭标记", "</function></tool_call>"],
		["畸形嵌套", OC + "\n<function=pwsh>\n" + OC + "\n</function>\n"],
	];
	for (const [label, text] of cases) {
		const r = await run(text);
		const unchanged = r.stripped === text;
		console.log(`  ${label}: 恢复 ${r.calls.length} 个, 文本${unchanged ? "原样保留" : "被修改"}`);
		if (r.calls.length === 0) {
			ck(`${label} → 无法解析时文本原样保留`, unchanged, `原=${JSON.stringify(text)} 后=${JSON.stringify(r.stripped)}`);
		}
	}
}

console.log("\n=== 5. 展示区内的标记必须保留 ===");
{
	const call = mkCall("pwsh", "command", "rm -rf /");
	const cases = [
		["代码围栏", "示例：\n```xml\n" + call + "\n```\n以上是示例。"],
		["行内代码", "写法是 `" + call.replace(/\n/g, " ") + "` 这样。"],
	];
	for (const [label, text] of cases) {
		const r = await run(text);
		console.log(`  ${label}: 恢复 ${r.calls.length} 个`);
		ck(`${label} → 不恢复`, r.calls.length === 0, String(r.calls.length));
		ck(`${label} → 文本原样保留`, r.stripped === text, `原=${text.length} 后=${r.stripped.length}`);
	}
}

console.log("\n=== 6. 无调用时文本必须完全不变（逐字节）===");
{
	const cases = [
		["普通文本", "这是一段普通的回复内容，没有任何标记。"],
		["提到标记名", "我使用 tool_call 这个机制来调用工具。"],
		["含尖括号", "比较 a < b 和 c > d。"],
		["含代码围栏", "```\ncode\n```"],
		["含 emoji", "完成 🎉 加油 💪"],
		["含制表符", "列1\t列2\t列3"],
		["多行", "第一行\n第二行\n第三行"],
		["空字符串", ""],
		["只有空白", "   \n\t  "],
	];
	for (const [label, text] of cases) {
		const r = await run(text);
		ck(`${label} → 不恢复`, r.calls.length === 0, String(r.calls.length));
		ck(`${label} → 文本完全不变`, r.stripped === text, `原=${JSON.stringify(text)} 后=${JSON.stringify(r.stripped)}`);
	}
}

console.log("\n=== 7. 特殊字符在调用周围必须完整 ===");
{
	const specials = [
		["emoji", "🎉🎊🥳"],
		["中文", "你好世界"],
		["RTL", "مرحبا"],
		["组合字符", "e\u0301"],
		["制表符", "a\tb"],
		["长文本", "x".repeat(1000)],
	];
	for (const [label, content] of specials) {
		const text = content + mkCall("pwsh", "command", "echo hi") + content;
		const r = await run(text);
		ck(`${label} → 恢复 1 个`, r.calls.length === 1, String(r.calls.length));
		// 前后两段都应保留（出现 2 次）
		const count = (r.stripped.match(new RegExp(content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
		ck(`${label} → 前后两段都保留`, count === 2, `出现 ${count} 次`);
	}
}

console.log("\n=== 8. 剥离后的文本与「原文去掉调用」严格等价 ===");
{
	// 构造：正文1 + 调用1 + 正文2 + 调用2 + 正文3
	const p1 = "AAA", p2 = "BBB", p3 = "CCC";
	const c1 = mkCall("pwsh", "command", "echo 1");
	const c2 = mkCall("read", "file_path", "/f");
	const text = p1 + c1 + p2 + c2 + p3;
	const r = await run(text);

	// 期望：p1 + p2 + p3（去掉两个调用后拼接）
	const expected = p1 + p2 + p3;
	console.log(`  期望: ${JSON.stringify(expected)}`);
	console.log(`  实际: ${JSON.stringify(r.stripped)}`);
	ck("剥离结果严格等于「原文去掉调用」", r.stripped === expected, JSON.stringify(r.stripped));
}

console.log("\n=== 9. 恢复后 finish 与文本同时正确 ===");
{
	const text = "说明：" + mkCall("pwsh", "command", "ls");
	const r = await run(text);
	ck("finish = tool-calls", r.fin?.reason?.kind === "tool-calls", JSON.stringify(r.fin?.reason));
	ck("文本保留了说明", r.stripped.includes("说明："), JSON.stringify(r.stripped));
}

console.log(`\n===== 文本保真度: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细（前 20 条）---");
	for (const f of failures.slice(0, 20)) console.log(`  ❌ ${f}`);
	if (failures.length > 20) console.log(`  ... 另有 ${failures.length - 20} 条`);
}
process.exit(fail === 0 ? 0 : 1);
