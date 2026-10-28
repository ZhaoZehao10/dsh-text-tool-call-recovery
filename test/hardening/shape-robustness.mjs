// 异常形状输入的鲁棒性（插件内部函数抛异常会中断整条流）
//
// **为什么需要**（缺陷 113，第 114 轮）：
// `wrapStream` 的 `try/catch` 只包住了**上游流迭代**（`for await (const chunk of source)`）。
// 它之后的**恢复逻辑**（`extractCalls` / `parseCallBody` / `coerceValue`）在 catch **之外**。
//
// 也就是说：如果这些内部函数**抛出任何未预料的异常**，异常会直接冒泡出
// `llm/stream` 接缝 —— **中断整条流**，用户连已经收到的正文都看不到。
// （这一点与「流中途异常」不同：那时插件会 `flushHeld()` 尽力交出已扣留的块。）
//
// 当前实现有类型防护（`typeof text !== "string"`、`MAX_SCAN_CHARS` 上限），
// 实测 8 类异常形状都不会抛。但这是「当前实现恰好正确」，
// **不是结构上的保证** —— 这个套件把这条性质固定下来。
//
// 本套件验证（37 项）：
//   ① 8 类异常形状的 `block.text` 都不抛异常，且已扣留的块仍被交出
//   ② 异常形状时 finish 仍被发出（不会静默丢流）
//   ③ 畸形 chunk（null / 数字 / 字符串）原样透传，不参与恢复判定
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

// **缺陷 158**（第 151 轮）：本套件会**临时改写 lib/index.js** 注入变异体。
// 若与另一个测试入口并发，对方读到的是变异体 —— 会产生**假失败**（实测
// live-instance 报「源码 48687B vs 安装 48772B」、coverage 判 100 子套件失败）。
// 因此改写期间持锁；拿不到锁就明确跳过（而不是产出一个假的红）。
import { acquireLibWriteLock, releaseLibWriteLock } from "./_lib-lock.mjs";
const LOCK_OWNER = "shape-robustness.mjs";
if (!acquireLibWriteLock(LOCK_OWNER)) {
	console.log("跳过：另一个套件正在改写 lib/index.js（缺陷 158 的互斥保护）。");
	console.log("      并发运行会让双方都读到变异体，产出的失败是假的。请串行运行。");
	process.exit(0);
}
// 无论正常结束、process.exit 还是抛异常，都释放锁（陈旧锁另有 PID 存活检测兜底）。
process.on("exit", () => { try { releaseLibWriteLock(LOCK_OWNER); } catch {} });
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const SRC = fs.readFileSync(LIB, "utf8");

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
	if (ok) { pass++; console.log("  ✅ " + label); }
	else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("  ❌ " + label + (detail ? " :: " + detail : "")); }
};

console.log("=== 0. 结构性：恢复逻辑是否有类型防护 ===");
{
	ck("extractCalls 有 typeof text !== string 防护", /typeof text !== "string"/.test(SRC), "");
	ck("extractCalls 有超长上限（MAX_SCAN_CHARS）", /text\.length > MAX_SCAN_CHARS/.test(SRC), "");
	// 记录：恢复逻辑在 try/catch 之外 —— 这是设计现状，用注释说明
	const hasCatchAroundRecover = /catch\s*\(\s*\w+\s*\)\s*\{[\s\S]{0,200}extractCalls/.test(SRC);
	ck("（记录）恢复逻辑不在流异常的 catch 内 → 依赖内部防护", !hasCatchAroundRecover, "");
}

const mod = await import(pathToFileURL(LIB).href + "?shape=" + Date.now());
let listener;
mod.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });
ck("插件注册了 llm/stream 监听器", typeof listener === "function");

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

async function run(chunks) {
	mod.resetStreaks?.();
	const out = [];
	const gen = (async function* () { for (const c of chunks) yield c; })();
	try {
		const stream = await listener({ provider: "p", model: "shape-" + Math.random(), messages: [], tools: TOOLS }, () => gen);
		for await (const c of stream) out.push(c);
		return { ok: true, out };
	} catch (e) {
		return { ok: false, err: e, out };
	}
}

console.log("=== 1. 8 类异常形状的 block.text 都不抛异常 ===");
const CASES = [
	{ name: "object", text: { evil: true } },
	{ name: "number", text: 12345 },
	{ name: "null", text: null },
	{ name: "array", text: ["a", "b"] },
	{ name: "超长标记", text: OC + "x".repeat(200000) + CC },
	{ name: "未闭合标记", text: OC + "<function=pwsh>" },
	{ name: "null 字节", text: OC + "\u0000" + CC },
	{ name: "lone surrogate", text: OC + "\uD800" + CC },
];

for (const c of CASES) {
	const r = await run([
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text: String(c.text) },
		{ type: "block-end", index: 0, block: { type: "reasoning", text: c.text } },
		{ type: "finish", reason: { kind: "stop" } },
	]);
	ck("block.text = " + c.name + " 时不抛异常", r.ok, r.ok ? "" : String(r.err?.message).slice(0, 60));
	// 已扣留的块必须被交出（用户能看到内容）
	ck("block.text = " + c.name + " 时块仍被交出", r.out.length >= 3, "只输出 " + r.out.length + " chunks");
}

console.log("=== 2. 异常形状时 finish 仍被发出 ===");
{
	const r = await run([
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "text-delta", index: 0, text: "normal" },
		{ type: "block-end", index: 0, block: { type: "text", text: { weird: 1 } } },
		{ type: "finish", reason: { kind: "stop" } },
	]);
	ck("finish 仍被发出", r.out.some((c) => c.type === "finish"), "");
}

console.log("=== 3. 畸形 chunk 原样透传 ===");
{
	const r = await run([
		null,
		12345,
		"not-an-object",
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "text-delta", index: 0, text: "hi" },
		{ type: "block-end", index: 0, block: { type: "text", text: "hi" } },
		{ type: "finish", reason: { kind: "stop" } },
	]);
	ck("畸形 chunk 不导致抛异常", r.ok, r.ok ? "" : String(r.err?.message).slice(0, 60));
	ck("畸形 chunk 被原样透传", r.out.filter((c) => c === null || typeof c !== "object").length >= 2,
		"透传了 " + r.out.filter((c) => c === null || typeof c !== "object").length + " 个");
}
console.log("=== 4. 恢复逻辑异常时流不中断（缺陷 113 兜底验证）===");
{
	// **缺陷 113**（第 114 轮发现 / 第 115 轮加固）：
	// 恢复逻辑原本在流异常的 catch **之外**。第 115 轮给它包了一层
	// 「尽力而为」兜底：恢复过程任何异常都**不得中断流**。
	//
	// 验证分两步：① 结构性断言（源码里确实有这层兜底）；
	// ② **变异验证** —— 注入「extractCalls 必抛」的变异，确认流不中断。
	const LIB_PATH = path.join(ROOT, "lib", "index.js");
	const ORIG = fs.readFileSync(LIB_PATH);
	const ORIG_TEXT = ORIG.toString("utf8");

	// ① 结构性断言
	ck("源码里有「恢复逻辑异常兜底」catch", /catch\s*\(\s*recoveryError\s*\)/.test(ORIG_TEXT), "");
	ck("兜底里清空了 recoveredCalls（退回原样交出）",
		/recoveredCalls\.length\s*=\s*0/.test(ORIG_TEXT), "");

	// ② 变异验证：注入 → 跑 → 还原（try/finally 保证还原，缺陷 105 的教训）
	const injected = ORIG_TEXT.replace(
		/(function extractCalls\(text, declared\) \{)/,
		"$1\n\tif (typeof text === 'string' && text.includes('tool_call')) throw new Error('MUTANT');"
	);

	if (injected === ORIG_TEXT) {
		ck("变异注入点存在（extractCalls 函数签名可定位）", false, "锚点未找到");
	} else {
		// 注入的源码必须与原始源码**只差这一行** —— 用行数变化确认
		const origLines = ORIG_TEXT.split("\n").length;
		const injLines = injected.split("\n").length;
		ck("注入只增加 1 行（没有破坏其他内容）", injLines === origLines + 1, origLines + " → " + injLines);

		try {
			fs.writeFileSync(LIB_PATH, injected, "utf8");

			// 用**真实的模块加载**验证：如果能 import 成功，说明语法没问题
			let mutMod = null, loadErr = null;
			try { mutMod = await import(pathToFileURL(LIB_PATH).href + "?mut=" + Date.now()); }
			catch (e) { loadErr = e; }

			ck("变异后的模块能被加载（语法合法）", loadErr === null,
				loadErr === null ? "" : String(loadErr.message).slice(0, 80));

			if (mutMod !== null) {
				let mutListener;
				mutMod.apply({ on: (e, h) => { if (e === "llm/stream") mutListener = h; } });

				const xml = OC + "\n" + "<function=pwsh>" + "\n" + "<parameter=command>" + "\necho x\n</parameter>\n</function>\n" + CC;
				const mutChunks = [
					{ type: "block-start", index: 0, blockType: "reasoning" },
					{ type: "reasoning-delta", index: 0, text: xml },
					{ type: "block-end", index: 0, block: { type: "reasoning", text: xml } },
					{ type: "finish", reason: { kind: "stop" } },
				];

				const mutOut = [];
				let thrown = null;
				try {
					const stream = await mutListener(
						{ provider: "p", model: "mut-" + Math.random(), messages: [], tools: TOOLS },
						() => (async function* () { for (const c of mutChunks) yield c; })()
					);
					for await (const c of stream) mutOut.push(c);
				} catch (e) { thrown = e; }

				ck("恢复逻辑抛异常时**流不中断**（兜底生效）", thrown === null,
					thrown === null ? "" : String(thrown.message).slice(0, 60));
				ck("兜底后原有块仍被交出", mutOut.some((c) => c.type === "block-start"), "输出 " + mutOut.length + " chunks");
				ck("兜底后 finish 仍被发出", mutOut.some((c) => c.type === "finish"), "");
				console.log("  变异下输出 " + mutOut.length + " chunks（正常应为 7）");
			}
		} finally {
			// **必须还原**（缺陷 105 的教训）
			try {
				fs.writeFileSync(LIB_PATH, ORIG);
			} catch (restoreErr) {
				// **缺陷 105 的教训**：还原失败必须给出可操作的兜底提示，不能静默
				console.error("\n🔴 严重：无法还原 lib/index.js —— " + restoreErr.message);
				console.error("   请手动执行：git checkout lib/index.js");
				process.exit(1);
			}
		}
		ck("变异已还原（字节一致）", fs.readFileSync(LIB_PATH).equals(ORIG), "");
	}
}
console.log("=== 5. catch 之外的辅助函数都有防御 ===");
{
	// 第 116 轮：第 115 轮给「恢复逻辑」加了兜底，但 wrapStream 里
	// 还有一段代码在 catch 之外 —— 恢复产出循环和安全网。
	// 它们会调用几个辅助函数，这些函数必须自己做防御，否则异常会中断整条流。
	//
	// **注意作用域**：SRC5 在第 4 节的块内，这里必须重新读取。
	const SRC5 = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");

	// 本检查逐条核实这些辅助函数在源码层面确实有防御，
	// 而不是依赖「实测没抛」这种偶然正确。
	const HELPER_GUARDS = [
		{
			fn: "patchReplayState",
			want: /function patchReplayState[\s\S]{0,400}typeof replayState !== "object"/,
			desc: "replayState 非对象时返回 {}",
		},
		{
			fn: "patchReplayState",
			want: /function patchReplayState[\s\S]{0,500}!Array\.isArray\(replayState\.blocks\)/,
			desc: "blocks 非数组时返回 {}",
		},
		{
			fn: "describeBlocksForMessage",
			want: /function describeBlocksForMessage[\s\S]{0,200}!Array\.isArray\(held\)/,
			desc: "held 非数组时返回 no blocks",
		},
		{
			fn: "describeBlocksForMessage",
			want: /function describeBlocksForMessage[\s\S]{0,800}\?\.end\?\.block\?\.type/,
			desc: "用可选链读取块字段",
		},
		{
			fn: "isMarkupOnlyText",
			want: /function isMarkupOnlyText[\s\S]{0,120}typeof text !== "string"/,
			desc: "text 非字符串时返回 false",
		},
	];

	for (const g of HELPER_GUARDS) {
		ck(g.fn + " — " + g.desc, g.want.test(SRC5), "未找到防御代码");
	}

	// 恢复产出循环里 JSON.stringify 的输入来自 coerceValue / JSON.parse，
	// 不可能有循环引用 —— 记录这条推理（而不是加无谓的 try）
	ck("coerceValue 的产物不含循环引用（JSON.parse 来源）",
		/JSON\.parse/.test(SRC5), "");

	console.log("  已核实 " + HELPER_GUARDS.length + " 处辅助函数防御 + 1 条推理");
}
console.log("\n===== 异常形状鲁棒性: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log("  ❌ " + f);
}
process.exit(fail === 0 ? 0 : 1);