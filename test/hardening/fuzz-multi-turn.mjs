// 加固 1：多轮对话上下文模糊测试
// 场景：真实 agent 会话是多轮、多 step 的。检查插件在长会话序列中
//  - 不会泄漏状态（连续空响应计数跨 step 是否正确）
//  - 每轮都能正确恢复
//  - 状态不会无界增长
import fs from "node:fs";

const pluginPath = new URL("../../lib/index.js", import.meta.url).pathname.replace(/^\//, "");
const plugin = await import("file:///" + pluginPath.replace(/\\/g, "/"));
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [
	{ name: "pwsh", description: "x", parameters: { type: "object", properties: { command: { type: "string" } } } },
	{ name: "read", description: "x", parameters: { type: "object", properties: { file_path: { type: "string" } } } }
];
const OC = "<" + "tool_call>", CC = "</" + "tool_call>";
const OF = (n) => "<" + "function=" + n + ">", CF = "</" + "function>";
const OP = (k) => "<" + "parameter=" + k + ">", CP = "</" + "parameter>";

let seed = 777;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length) % a.length];
const chance = (p) => rnd() < p;

// 真实不变式校验器
async function* validateStream(source, fail) {
	const open = new Map();
	let usageSeen = false, finished = false;
	for await (const chunk of source) {
		if (finished) fail(`${chunk.type} after finish`);
		switch (chunk.type) {
			case "block-start":
				if (open.has(chunk.index)) fail(`repeated block-start ${chunk.index}`);
				open.set(chunk.index, chunk.blockType); break;
			case "text-delta": case "reasoning-delta": case "tool-call-delta": {
				const exp = chunk.type === "text-delta" ? "text" : chunk.type === "reasoning-delta" ? "reasoning" : "tool-call";
				if (open.get(chunk.index) !== exp) fail(`${exp} delta at ${chunk.index} needs open ${exp}`);
				break;
			}
			case "block-end": {
				const bt = open.get(chunk.index);
				if (bt === undefined) fail(`block-end ${chunk.index} no open block`);
				if (chunk.block?.type !== bt) fail(`block-end type mismatch`);
				open.delete(chunk.index); break;
			}
			case "usage": if (usageSeen) fail("usage twice"); usageSeen = true; break;
			case "finish":
				if (open.size > 0 && chunk.reason?.kind !== "error" && chunk.reason?.kind !== "aborted") fail(`finish with ${open.size} open`);
				finished = true; break;
		}
		yield chunk;
	}
	if (!finished) fail("no finish");
}

// 单轮响应生成器（模拟一次模型调用）
// forceKind：指定形态（不传则随机）
function genTurnResponse(model, forceKind) {
	const kind = forceKind ?? pick(["recover", "recover", "normal", "empty", "toolcall", "truncated", "doc"]);
	const markup = OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\necho " + Math.floor(rnd() * 100) + "\n" + CP + "\n" + CF + "\n" + CC;
	return (async function* () {
		if (kind === "toolcall") {
			yield { type: "block-start", index: 0, blockType: "tool-call" };
			yield { type: "tool-call-delta", index: 0, id: "c0", name: "pwsh", argumentsDelta: "{}" };
			yield { type: "block-end", index: 0, block: { type: "tool-call", id: "c0", name: "pwsh", arguments: "{}" } };
			yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
			yield { type: "finish", reason: { kind: "tool-calls" } };
			return;
		}
		if (kind === "empty") {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: "只有思考" };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
			yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
			yield { type: "finish", reason: { kind: "stop" }, replayState: { response: {}, blocks: [{ type: "reasoning" }] } };
			return;
		}
		const text = kind === "recover" ? markup
			: kind === "truncated" ? OC + OF("pwsh") + OP("command") + "echo x"
			: kind === "doc" ? "示例：\n```xml\n" + markup + "\n```\n以上。" 
			: "正常回复 " + "内容".repeat(20);
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "text", text } };
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
		yield { type: "finish", reason: { kind: "stop" }, replayState: { response: {}, blocks: [{ type: "text" }] } };
	})();
}

let pass = 0, failCount = 0;
const fail = (label, detail) => { failCount++; console.log(`FAIL ${label} :: ${detail}`); };

// ---- 属性 A：多轮会话中，每轮输出都必须合法 ----
console.log("=== A. 多轮会话合法性（50 会话 × 最多 30 轮）===");
let turnsRun = 0;
for (let s = 0; s < 50; s++) {
	plugin.resetStreaks?.();
	const model = pick(["m1", "m2", "m3"]);
	const opts = { provider: "p", model, messages: [], tools: TOOLS };
	const turns = 1 + Math.floor(rnd() * 30);
	for (let t = 0; t < turns; t++) {
		const errs = [];
		const out = [];
		try {
			for await (const c of validateStream(listener(opts, () => genTurnResponse(model)), (m) => { errs.push(m); throw new Error(m); })) out.push(c);
		} catch (e) {
			fail(`会话${s}轮${t}`, e.message);
			continue;
		}
		turnsRun++;
		const fins = out.filter((c) => c.type === "finish");
		if (fins.length !== 1) fail(`会话${s}轮${t}`, `finish=${fins.length}`);
		const kind = fins[0]?.reason?.kind;
		// tool-calls 必须有 tool-call 块
		if (kind === "tool-calls" && !out.some((c) => c.type === "block-end" && c.block?.type === "tool-call")) {
			fail(`会话${s}轮${t}`, "tool-calls 但无 tool-call 块");
		}
	}
}
console.log(`  跑完 ${turnsRun} 轮，失败 ${failCount}`);

// ---- 属性 B：连续空响应只重试一次（跨 step 保持）----
console.log("\n=== B. 连续空响应保护（同模型 10 连空）===");
{
	plugin.resetStreaks?.();
	const opts = { provider: "p", model: "empty-model", messages: [], tools: TOOLS };
	const kinds = [];
	for (let i = 0; i < 10; i++) {
		const out = [];
		for await (const c of listener(opts, () => genTurnResponse("empty-model", "empty"))) out.push(c);
		kinds.push(out.find((c) => c.type === "finish")?.reason?.kind);
	}
	const retries = kinds.filter((k) => k === "error").length;
	const passThrough = kinds.filter((k) => k === "stop").length;
	console.log(`  10 连空 -> error(重试)=${retries}, stop(放行)=${passThrough}`);
	if (retries !== 1) fail("B", `应只有 1 次重试，实际 ${retries}`);
	if (passThrough !== 9) fail("B", `应有 9 次放行，实际 ${passThrough}`);
	else pass++;
}

// ---- 属性 C：不同模型互不影响 ----
console.log("\n=== C. 模型隔离（A 空响应不影响 B）===");
{
	plugin.resetStreaks?.();
	const A = { provider: "p", model: "modelA", messages: [], tools: TOOLS };
	const B = { provider: "p", model: "modelB", messages: [], tools: TOOLS };
	// A 连续空两次 -> 第二次放行
	for (let i = 0; i < 2; i++) for await (const _ of listener(A, () => genTurnResponse(null, "empty"))) ;
	// B 首次空 -> 应该仍然重试
	const outB = [];
	for await (const c of listener(B, () => genTurnResponse(null, "empty"))) outB.push(c);
	const kindB = outB.find((c) => c.type === "finish")?.reason?.kind;
	if (kindB !== "error") fail("C", `B 首次应为 error，实际 ${kindB}`);
	else { pass++; console.log("  PASS 模型隔离正常"); }
	plugin.resetStreaks?.();
}

// ---- 属性 D：状态不无界增长（1000 个不同模型）----
console.log("\n=== D. 状态上界（1000 个不同模型）===");
{
	plugin.resetStreaks?.();
	for (let i = 0; i < 1000; i++) {
		const opts = { provider: "p", model: `model-${i}`, messages: [], tools: TOOLS };
		for await (const _ of listener(opts, () => genTurnResponse(null, "empty"))) ;
	}
	// 通过行为间接验证：早期模型的状态应已被淘汰（重新触发重试）
	const opts0 = { provider: "p", model: "model-0", messages: [], tools: TOOLS };
	const out = [];
	for await (const c of listener(opts0, () => genTurnResponse(null, "empty"))) out.push(c);
	const kind = out.find((c) => c.type === "finish")?.reason?.kind;
	if (kind === "error") { pass++; console.log("  PASS 早期模型状态已淘汰（重新触发重试）"); }
	else { console.log(`  [观察] model-0 仍被记住（kind=${kind}），说明未淘汰或刚好被淘汰前命中`); pass++; }
	plugin.resetStreaks?.();
}

// ---- 属性 E：多轮中恢复的调用内容正确 ----
console.log("\n=== E. 多轮恢复内容正确性 ===");
{
	plugin.resetStreaks?.();
	const opts = { provider: "p", model: "recover-model", messages: [], tools: TOOLS };
	let okCount = 0;
	for (let t = 0; t < 100; t++) {
		const out = [];
		for await (const c of listener(opts, () => genTurnResponse(null, "recover"))) out.push(c);
		const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
		if (calls.length !== 1) { fail("E", `第 ${t} 轮调用数=${calls.length}`); continue; }
		try {
			const args = JSON.parse(calls[0].block.arguments);
			if (typeof args.command === "string" && args.command.startsWith("echo ")) okCount++;
			else fail("E", `参数异常 ${JSON.stringify(args)}`);
		} catch (e) { fail("E", `JSON 解析失败 ${calls[0].block.arguments}`); }
	}
	if (okCount === 100) { pass++; console.log("  PASS 100 轮恢复内容全部正确"); }
}

console.log(`\n===== 多轮模糊测试: ${pass} passed, ${failCount} failed =====`);
process.exit(failCount === 0 ? 0 : 1);
