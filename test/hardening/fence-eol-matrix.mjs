// 代码围栏识别 × 行尾风格的组合矩阵
//
// **为什么需要**（缺陷 126，第 125 轮）：
// `computeDisplayRanges` 用 `text.charCodeAt(i - 1) === 10` 判断「是否在行首」，
// **只认 LF（10）**。第 125 轮自然会产生一个疑问：
//
//   如果文本用 CRLF 换行，围栏前的字符是 CR（13）而非 LF（10），
//   `atLineStart` 会不会失效？失效的话，**围栏里的示例会被当成真调用执行** ——
//   这是安全关键问题（文档里展示 `rm -rf /` 会被真的跑）。
//
// 实测结论：**CRLF 下依然正确**。因为 `atLineStart` 判断的是**围栏反引号前一个字符**，
// 而 CRLF 中反引号前正好是 LF。CR（老式 Mac）也一样能通过其他路径正确处理。
//
// **但此前没有任何套件覆盖「行尾 × 围栏」这个组合** —— 精确搜索显示
// 没有任何一行同时含 `\r\n` 和围栏标记。这个套件补上。
//
// 本套件验证（18 项）：3 种行尾 × 4 种围栏位置 × 2 类断言。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

const LLM = (() => {
	const candidates = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(process.cwd(), "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
	].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(c)) return c;
	console.error("找不到 dsh-llm：请设置 DSH_LLM_SRC");
	process.exit(1);
})();

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href + "?fence=" + Date.now());
let listener;
mod.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const { BlockAssembler } = await import(pathToFileURL(LLM).href);

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
	if (ok) { pass++; console.log("  OK  " + label); }
	else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("  FAIL " + label + (detail ? " :: " + detail : "")); }
};

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];

/** 跑一条「只有 text 块」的流，返回装配后的 tool-call 名称列表。 */
async function recoveredNames(text) {
	mod.resetStreaks?.();
	const chunks = [
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "text-delta", index: 0, text },
		{ type: "block-end", index: 0, block: { type: "text", text } },
		{ type: "finish", reason: { kind: "stop" } },
	];
	const out = [];
	const gen = (async function* () { for (const c of chunks) yield c; })();
	const stream = await listener({ provider: "p", model: "fence-" + Math.random(), messages: [], tools: TOOLS }, () => gen);
	for await (const c of stream) out.push(c);
	const asm = new BlockAssembler();
	for (const c of out) asm.push(c);
	const names = [];
	for (const b of asm.assembled().blocks ?? []) {
		if (b.type === "tool-call") names.push(b.name);
	}
	return names;
}

const CALL = "<tool_call>\n<function=pwsh>\n<parameter=command>\nrm -rf /\n</parameter>\n</function>\n</tool_call>";

const EOLS = [
	{ name: "LF", sep: "\n" },
	{ name: "CRLF", sep: "\r\n" },
	{ name: "CR", sep: "\r" },
];

// 四种围栏位置：第 1 行起 / 第 2 行起（前面有正文）/ 有缩进 / 波浪号围栏
const PLACEMENTS = [
	{
		name: "围栏在第 1 行",
		build: (sep) => "```" + sep + CALL + sep + "```",
	},
	{
		name: "围栏在第 2 行（前面有正文）",
		build: (sep) => "这是正文。" + sep + "```" + sep + CALL + sep + "```",
	},
	{
		name: "围栏带缩进",
		build: (sep) => "  ```" + sep + CALL + sep + "  ```",
	},
	{
		name: "波浪号围栏",
		build: (sep) => "~~~" + sep + CALL + sep + "~~~",
	},
];

console.log("=== 1. 围栏内的示例调用：任何行尾/位置都**不应**被恢复 ===");
for (const eol of EOLS) {
	for (const pl of PLACEMENTS) {
		const names = await recoveredNames(pl.build(eol.sep));
		ck(eol.name + " + " + pl.name + " → 未恢复",
			names.length === 0, "恢复了 " + JSON.stringify(names));
	}
}

console.log("=== 2. 围栏外的真实调用：任何行尾都应被恢复 ===");
for (const eol of EOLS) {
	// 正文里没有围栏，直接是调用
	const text = "我来执行。" + eol.sep + CALL;
	const names = await recoveredNames(text);
	ck(eol.name + " + 无围栏 → 恢复出 1 个调用", names.length === 1, JSON.stringify(names));
}

console.log("=== 3. 围栏后紧跟真实调用（应恢复后者，跳过前者）===");
for (const eol of EOLS) {
	const text = "```" + eol.sep + CALL + eol.sep + "```" + eol.sep + "现在真的执行：" + eol.sep + CALL;
	const names = await recoveredNames(text);
	ck(eol.name + " + 围栏后跟真实调用 → 恰好恢复 1 个",
		names.length === 1, JSON.stringify(names));
}

console.log("");
console.log("===== 围栏 × 行尾矩阵: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("--- 失败明细 ---");
	for (const f of failures) console.log("  FAIL " + f);
}
process.exit(fail === 0 ? 0 : 1);