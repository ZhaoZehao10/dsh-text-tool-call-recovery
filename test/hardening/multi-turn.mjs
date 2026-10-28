// 多轮对话与工具结果回传审查
//
// 关键场景：agent loop 是**多轮**的——
//   轮 1: 模型输出文本工具调用 → 插件恢复 → 工具执行
//   轮 2: 工具结果作为 tool 消息回传 → 模型继续
//   轮 3: ...
//
// 必须验证：
//   1. 插件**不读** options.messages（无状态，只看当前流）
//   2. 历史消息里的文本工具调用不会被重复恢复
//   3. 工具结果回传后，模型继续输出正常内容时插件不干扰
//   4. 同一会话多轮之间状态不串味
//   5. 连续多轮都输出文本调用时，每轮都能正确恢复
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const LLM = (() => {
	const cands = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
	].filter(Boolean);
	for (const c of cands) if (fs.existsSync(c)) return c;
	return null;
})();
if (LLM === null) { console.log("跳过：找不到 dsh-llm"); process.exit(0); }

const { BlockAssembler, createUserMessage, createAssistantMessage, createToolResultMessage } = await import(pathToFileURL(LLM).href);

const plugin = await import(pathToFileURL(LIB).href + "?multi=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const mkCall = (tool, params) => {
	const body = Object.entries(params).map(([k, v]) => "<parameter=" + k + ">\n" + v + "\n</parameter>").join("\n");
	return OC + "\n<function=" + tool + ">\n" + body + "\n</function>\n" + CC;
};
const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } },
	{ name: "read", parameters: { type: "object", properties: { file_path: { type: "string" } } } },
];

/** 跑一轮：给定 messages 和模型输出文本，返回插件处理后的 chunk */
async function runTurn(messages, outputText, blockType = "text") {
	plugin.resetStreaks?.();
	const opts = { provider: "p", model: "m", messages, tools: TOOLS };
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType };
		yield { type: blockType === "text" ? "text-delta" : "reasoning-delta", index: 0, text: outputText };
		yield { type: "block-end", index: 0, block: { type: blockType, text: outputText } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = [];
	for await (const c of listener(opts, () => gen)) out.push(c);
	return out;
}

function summarize(out) {
	const blocks = out.filter((c) => c.type === "block-end");
	const calls = blocks.filter((b) => b.block?.type === "tool-call");
	const text = blocks.filter((b) => b.block?.type === "text").map((b) => b.block.text).join("");
	const fin = out.find((c) => c.type === "finish");
	return { calls, text, fin };
}

console.log("=== 1. 插件不读取 options.messages（无状态）===");
{
	// 用 Proxy 监控 messages 的访问
	let messagesAccessed = false;
	const spyMessages = new Proxy([], {
		get(target, prop) {
			if (prop !== "length" && prop !== Symbol.iterator && typeof prop !== "symbol") messagesAccessed = true;
			return target[prop];
		},
	});

	plugin.resetStreaks?.();
	const opts = { provider: "p", model: "m", messages: spyMessages, tools: TOOLS };
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: mkCall("pwsh", { command: "echo hi" }) };
		yield { type: "block-end", index: 0, block: { type: "text", text: mkCall("pwsh", { command: "echo hi" }) } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = [];
	for await (const c of listener(opts, () => gen)) out.push(c);

	ck("插件不读取 messages（无状态设计）", messagesAccessed === false, messagesAccessed ? "访问了 messages" : "");
	ck("不读 messages 仍能正确恢复", summarize(out).calls.length === 1, String(summarize(out).calls.length));
}

console.log("\n=== 2. 历史消息含文本调用 → 不影响当前轮 ===");
{
	// 构造含"文本工具调用"的历史（正常情况下插件恢复后，历史里应该是结构化 tool-call）
	const historyWithText = [
		createUserMessage({ content: "帮我执行命令" }),
		// 注意：历史里放**文本形式**的调用（异常情况，用于测试插件是否会被历史干扰）
		createAssistantMessage({ content: [{ type: "text", text: "我执行：" + mkCall("pwsh", { command: "echo old" }) }] }),
		createToolResultMessage({ toolCallId: "old-1", content: [{ type: "text", text: "old result" }] }),
	];

	// 当前轮输出正常文本（无调用）
	const out1 = await runTurn(historyWithText, "命令已执行完毕，结果如上。");
	const s1 = summarize(out1);
	ck("历史含文本调用时，当前轮正常文本不被恢复", s1.calls.length === 0, String(s1.calls.length));
	ck("当前轮 finish 保持 stop", s1.fin?.reason?.kind === "stop", JSON.stringify(s1.fin?.reason));

	// 当前轮也输出文本调用
	const out2 = await runTurn(historyWithText, "再执行一次：" + mkCall("pwsh", { command: "echo new" }));
	const s2 = summarize(out2);
	ck("历史含文本调用时，当前轮的调用正常恢复", s2.calls.length === 1, String(s2.calls.length));
	let args = null;
	try { args = JSON.parse(s2.calls[0]?.block?.arguments ?? "null"); } catch { /* ignore */ }
	ck("恢复的是**当前轮**的调用（echo new）", args?.command === "echo new", JSON.stringify(args));
}

console.log("\n=== 3. 模拟完整多轮 agent loop ===");
{
	// 轮 1：模型输出文本工具调用
	const messages = [createUserMessage({ content: "请查看文件 /a.txt" })];
	const turn1 = await runTurn(messages, "我先读文件：" + mkCall("read", { file_path: "/a.txt" }));
	const s1 = summarize(turn1);
	ck("轮1 恢复 1 个调用", s1.calls.length === 1, String(s1.calls.length));
	ck("轮1 finish=tool-calls", s1.fin?.reason?.kind === "tool-calls", JSON.stringify(s1.fin?.reason));

	// 构造 assistant 消息加入历史（用装配器产出真实块）
	const asm = new BlockAssembler();
	for (const c of turn1) asm.push(c);
	const assembled = asm.assembled();
	messages.push(createAssistantMessage({ content: assembled.blocks }));

	// 轮 2：工具结果回传，模型继续（正常文本回复）
	const callId = s1.calls[0].block.id;
	messages.push(createToolResultMessage({ toolCallId: callId, content: [{ type: "text", text: "文件内容：hello world" }] }));
	const turn2 = await runTurn(messages, "文件内容是 hello world，任务完成。");
	const s2 = summarize(turn2);
	ck("轮2 不产生额外调用", s2.calls.length === 0, String(s2.calls.length));
	ck("轮2 finish 保持 stop", s2.fin?.reason?.kind === "stop", JSON.stringify(s2.fin?.reason));
	ck("轮2 文本完整", s2.text.includes("任务完成"), JSON.stringify(s2.text));

	// 轮 3：模型再输出一个调用
	messages.push(createAssistantMessage({ content: [{ type: "text", text: s2.text }] }));
	messages.push(createUserMessage({ content: "再看 /b.txt" }));
	const turn3 = await runTurn(messages, "好的：" + mkCall("read", { file_path: "/b.txt" }));
	const s3 = summarize(turn3);
	ck("轮3 恢复 1 个调用", s3.calls.length === 1, String(s3.calls.length));
	let args3 = null;
	try { args3 = JSON.parse(s3.calls[0]?.block?.arguments ?? "null"); } catch { /* ignore */ }
	ck("轮3 恢复的是 /b.txt（不是历史里的 /a.txt）", args3?.file_path === "/b.txt", JSON.stringify(args3));
}

console.log("\n=== 4. 连续 10 轮都输出文本调用 ===");
{
	let bad = 0;
	for (let turn = 0; turn < 10; turn++) {
		const messages = [
			createUserMessage({ content: "第 " + turn + " 轮" }),
		];
		const out = await runTurn(messages, "执行第" + turn + "个：" + mkCall("pwsh", { command: "echo " + turn }));
		const s = summarize(out);
		let args = null;
		try { args = JSON.parse(s.calls[0]?.block?.arguments ?? "null"); } catch { /* ignore */ }
		if (s.calls.length !== 1) { bad++; console.log(`  轮 ${turn}: 调用数 ${s.calls.length}`); continue; }
		if (args?.command !== "echo " + turn) { bad++; console.log(`  轮 ${turn}: 参数 ${JSON.stringify(args)}`); continue; }
		if (s.fin?.reason?.kind !== "tool-calls") { bad++; console.log(`  轮 ${turn}: finish ${JSON.stringify(s.fin?.reason)}`); }
		// 检查 id 不与上一轮冲突（同内容才同 id，不同内容应不同）
	}
	ck("连续 10 轮均正确恢复", bad === 0, `${bad} 轮错误`);
}

console.log("\n=== 5. 工具结果回传后的边界情况 ===");
{
	const cases = [
		["工具结果是空字符串", createToolResultMessage({ toolCallId: "c1", content: [{ type: "text", text: "" }] })],
		["工具结果含工具调用标记（用户数据）", createToolResultMessage({ toolCallId: "c2", content: [{ type: "text", text: mkCall("pwsh", { command: "rm -rf /" }) }] })],
		["工具结果很长", createToolResultMessage({ toolCallId: "c3", content: [{ type: "text", text: "x".repeat(10000) }] })],
	];
	for (const [label, toolMsg] of cases) {
		const messages = [createUserMessage({ content: "继续" }), toolMsg];
		const out = await runTurn(messages, "收到结果，继续处理。");
		const s = summarize(out);
		ck(`${label} → 不误恢复`, s.calls.length === 0, String(s.calls.length));
		ck(`${label} → finish 保持 stop`, s.fin?.reason?.kind === "stop", JSON.stringify(s.fin?.reason));
	}
}

console.log("\n=== 6. 多轮中思考块（reasoning）的处理 ===");
{
	// reasoning 块里的调用（step-5-preview 的真实形态）
	const messages = [createUserMessage({ content: "执行" })];
	const out1 = await runTurn(messages, mkCall("pwsh", { command: "echo reasoning" }), "reasoning");
	const s1 = summarize(out1);
	ck("reasoning 块里的调用被恢复", s1.calls.length === 1, String(s1.calls.length));

	// 下一轮正常
	const out2 = await runTurn(messages, "完成了。");
	ck("下一轮正常不受影响", summarize(out2).calls.length === 0, "");
	ck("下一轮 finish 正确", summarize(out2).fin?.reason?.kind === "stop", "");
}

console.log("\n=== 7. 会话级状态隔离（不同会话模型名不同）===");
{
	// 会话 A 触发空响应
	const emptyStream = async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "只有思考" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
		yield { type: "finish", reason: { kind: "stop" } };
	};
	plugin.resetStreaks?.();
	let l = null;
	plugin.apply({ on: (e, h) => { if (e === "llm/stream") l = h; } });
	await (async () => { for await (const c of l({ provider: "p", model: "session-A", messages: [], tools: TOOLS }, emptyStream)) { /* consume */ } })();

	// 会话 B（不同模型名）首次空响应应该仍是 error
	const outB = [];
	for await (const c of l({ provider: "p", model: "session-B", messages: [], tools: TOOLS }, emptyStream)) outB.push(c);
	const finB = outB.find((c) => c.type === "finish");
	ck("不同会话（模型名）状态隔离", finB?.reason?.kind === "error", JSON.stringify(finB?.reason));
}

console.log(`\n===== 多轮对话与工具回传: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
