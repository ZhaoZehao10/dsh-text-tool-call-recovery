// 「tools 为空时直通」设计决策的回归守护
//
// **背景（第 51 轮的真实教训）**：
//   我一度认为 `if (declared.size === 0) return source;` 是缺陷 ——
//   「模型只返回思考时，无论有没有工具，用户都会看到卡住，安全网应该生效」。
//   于是改成「恢复跳过但安全网生效」。
//
//   **结果：集成测试用例 5 立刻失败** ——
//     [用例 5] 请求没有 tools（compaction/session-title）-> 完全直通
//
//   真相：DSH 有两类**不带工具**的内部请求：
//     - compaction（压缩上下文）：模型只返回摘要，本来就没有「可执行内容」
//     - session-title（生成会话标题）：只需一行短标题
//   这两类里「没有 tool-call 块」是**正常的**。若触发 EMPTY_RESPONSE 重试，
//   每次压缩/起标题都会白白重试，浪费 token 且拖慢响应。
//
//   **所以早退是正确的设计，我的"修复"是错的。** 已完整回滚。
//
// 本套件把这个决策固化为测试，防止将来有人（包括我）再次误改。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const SRC = fs.readFileSync(LIB, "utf8");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const plugin = await import(pathToFileURL(LIB).href + "?passthrough=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const REASONING_ONLY = () => (async function* () {
	yield { type: "block-start", index: 0, blockType: "reasoning" };
	yield { type: "reasoning-delta", index: 0, text: "我在思考这个问题……" };
	yield { type: "block-end", index: 0, block: { type: "reasoning", text: "我在思考这个问题……" } };
	yield { type: "finish", reason: { kind: "stop" } };
})();

const TEXT_ONLY = () => (async function* () {
	yield { type: "block-start", index: 0, blockType: "text" };
	yield { type: "text-delta", index: 0, text: "这是一段正常的回复正文。" };
	yield { type: "block-end", index: 0, block: { type: "text", text: "这是一段正常的回复正文。" } };
	yield { type: "finish", reason: { kind: "stop" } };
})();

const MARKUP = "<" + "tool_call>\n<function=pwsh>\n<parameter=command>echo hi\n</parameter>\n</function>\n</" + "tool_call>";

async function run(tools, streamFactory, model) {
	plugin.resetStreaks?.();
	const opts = { provider: "p", model, messages: [] };
	if (tools !== undefined) opts.tools = tools;
	const out = [];
	for await (const c of listener(opts, streamFactory)) out.push(c);
	const fin = out.find((c) => c.type === "finish");
	return {
		kind: fin?.reason?.kind,
		code: fin?.reason?.failure?.code,
		calls: out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").length,
		chunks: out.length,
	};
}

// ===========================================================================
// 1. 源码层面：早退语句必须存在
// ===========================================================================
console.log("=== 1. 早退语句存在 ===");
{
	const hasEarlyReturn = /if \(declared\.size === 0\) return source;/.test(SRC);
	ck("源码含 `if (declared.size === 0) return source;`", hasEarlyReturn,
		"缺失 —— 可能被误改成「安全网也生效」，会破坏 compaction/session-title");
	console.log(`  早退语句: ${hasEarlyReturn ? "✅" : "❌"}`);

	// 不能有 recoveryEnabled 之类的半吊子改法
	const hasHalftone = /recoveryEnabled/.test(SRC);
	ck("没有 recoveryEnabled 这类半成品改造", !hasHalftone, "发现 recoveryEnabled 残留");
	console.log(`  recoveryEnabled 残留: ${hasHalftone ? "❌ 有" : "✅ 无"}`);
}

// ===========================================================================
// 2. 行为层面：tools 为空时必须完全直通
// ===========================================================================
console.log("\n=== 2. tools 为空 → 完全直通 ===");
{
	// 2a. tools 空数组 + 只有思考 → stop（不触发安全网）
	{
		const r = await run([], REASONING_ONLY, "passthrough-empty-array-" + Date.now());
		console.log(`  tools=[] + 只有思考: kind=${r.kind} chunks=${r.chunks}`);
		ck("tools=[] 时不触发安全网（compaction/session-title 场景）", r.kind === "stop", String(r.kind));
	}

	// 2b. tools 缺失 + 只有思考 → stop
	{
		const r = await run(undefined, REASONING_ONLY, "passthrough-undefined-" + Date.now());
		console.log(`  tools 缺失 + 只有思考: kind=${r.kind}`);
		ck("tools 缺失时不触发安全网", r.kind === "stop", String(r.kind));
	}

	// 2c. tools 空数组 + 正常文本 → stop（直通）
	{
		const r = await run([], TEXT_ONLY, "passthrough-text-" + Date.now());
		console.log(`  tools=[] + 正常文本: kind=${r.kind}`);
		ck("tools=[] 时正常文本保持 stop", r.kind === "stop", String(r.kind));
	}
}

// ===========================================================================
// 3. 对照：tools 非空时安全网必须生效
// ===========================================================================
console.log("\n=== 3. tools 非空 → 安全网生效（对照组）===");
{
	const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
	const r = await run(TOOLS, REASONING_ONLY, "safety-on-" + Date.now());
	console.log(`  tools 非空 + 只有思考: kind=${r.kind} code=${r.code}`);
	ck("tools 非空时触发安全网", r.kind === "error", String(r.kind));
	ck("错误码是 EMPTY_RESPONSE", r.code === "EMPTY_RESPONSE", String(r.code));
}

// ===========================================================================
// 4. tools 为空时不做工具恢复（即使文本里有完整标记）
// ===========================================================================
console.log("\n=== 4. tools 为空 → 不做文本工具调用恢复 ===");
{
	// 没有声明工具时，即使文本里是完整的工具调用标记，也不该恢复
	// （不知道有哪些工具，无法校验工具名）
	const sysText = () => (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: MARKUP };
		yield { type: "block-end", index: 0, block: { type: "text", text: MARKUP } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const r = await run([], sysText, "no-recovery-" + Date.now());
	console.log(`  tools=[] + 完整标记: 恢复调用=${r.calls} kind=${r.kind}`);
	ck("tools 为空时不恢复工具调用", r.calls === 0, `${r.calls} 个`);
}

// ===========================================================================
// 5. 集成测试里确实有用例 5 守护这件事
// ===========================================================================
console.log("\n=== 5. 集成测试有对应用例 ===");
{
	const intPath = path.join(ROOT, "test", "integration.test.mjs");
	const intSrc = fs.readFileSync(intPath, "utf8");
	const hasCase5 = /请求没有 tools/.test(intSrc) && /完全直通/.test(intSrc);
	ck("集成测试含「请求没有 tools -> 完全直通」用例", hasCase5,
		"这个用例是拦住错误改动的关键防线");
	console.log(`  集成测试用例 5: ${hasCase5 ? "✅ 存在" : "❌ 缺失"}`);
}

// ===========================================================================
// 6. 源码注释解释了为什么这样做
// ===========================================================================
console.log("\n=== 6. 设计理由有注释 ===");
{
	// 早退语句附近应该有解释
	const idx = SRC.indexOf("if (declared.size === 0) return source;");
	const context = idx >= 0 ? SRC.slice(Math.max(0, idx - 1200), idx) : "";
	const explains = /compaction|session-title|压缩|标题/.test(context);
	ck("早退语句前有注释解释 compaction/session-title", explains, "");
	console.log(`  有设计说明: ${explains ? "✅" : "❌"}`);
	if (explains) {
		// 显示注释关键行
		for (const line of context.split("\n").slice(-14)) {
			if (line.includes("compaction") || line.includes("session-title") || line.includes("压缩") || line.includes("标题") || line.includes("直通")) {
				console.log(`    ${line.trim().slice(0, 100)}`);
			}
		}
	}
}

console.log(`\n===== tools 直通设计守护: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
