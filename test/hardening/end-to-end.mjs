// 端到端链路演练
//
// 前 14 轮都是"插件输入 → 插件输出"的局部测试。本测试走完整链路：
//   模型文本流 → 插件恢复 → 宿主真实消费者（装配器/可见性判定/文本拼接/消息构造）
//   → 验证工具调用真的能被上层取到并执行
//
// 使用的都是宿主**真实导出**的函数：
//   BlockAssembler / assembleAssistantStream / AssistantStreamAccumulator
//   assistantStreamHasVisibleContent / assistantStreamChunks / joinAssistantStreamText
//   createAssistantMessage / chunkHasVisibleText
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LLM = (() => {
	const cands = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
	].filter(Boolean);
	for (const c of cands) if (fs.existsSync(c)) return c;
	return null;
})();
if (LLM === null) { console.log("跳过：找不到 dsh-llm"); process.exit(0); }

const {
	BlockAssembler,
	AssistantStreamAccumulator,
	assembleAssistantStream,
	assistantStreamHasVisibleContent,
	assistantStreamChunks,
	joinAssistantStreamText,
	createAssistantMessage,
	chunkHasVisibleText,
} = await import(pathToFileURL(LLM).href);

const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } },
	{ name: "read", parameters: { type: "object", properties: { file_path: { type: "string" } } } },
	{ name: "write", parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } } } },
];
const OPTS = { provider: "step-plan-152", model: "step-5-preview", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

// 模拟"模型输出文本工具调用"的流（真实形态：交错块）
function modelTextCallStream(toolName, args, opts = {}) {
	const params = Object.entries(args).map(([k, v]) => `<parameter=${k}>\n${v}\n</parameter>`).join("\n");
	const markup = OC + "\n<function=" + toolName + ">\n" + params + "\n</function>\n" + CC;
	return (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "让我执行命令。" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "让我执行命令。" } };
		yield { type: "block-start", index: 1, blockType: "text" };
		yield { type: "text-delta", index: 1, text: markup };
		yield { type: "block-end", index: 1, block: { type: "text", text: markup } };
		yield { type: "usage", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
		const fin = { type: "finish", reason: { kind: "stop" } };
		if (opts.replayState) fin.replayState = opts.replayState;
		yield fin;
	})();
}

/**
 * 把展开后的 chunk 数组转成宿主的「压缩记录」。
 *
 * 宿主的 assistantStreamHasVisibleContent / assistantStreamChunks /
 * joinAssistantStreamText / assembleAssistantStream 都吃**压缩记录**
 * （AssistantStreamAccumulator.snapshot() 的产物），不是裸 chunk 数组。
 * 因此这里统一走一次累加器，得到与宿主一致的真实输入形态。
 */
function toRecords(chunks) {
	const acc = new AssistantStreamAccumulator();
	let t = 1700000000000;
	for (const c of chunks) { acc.push({ time: t, chunk: c }); t += 5; }
	return acc.snapshot();
}

async function throughPlugin(streamFactory) {
	plugin.resetStreaks?.();
	const out = [];
	for await (const c of listener(OPTS, streamFactory)) out.push(c);
	return out;
}

console.log("=== 1. 端到端：文本工具调用 → 插件恢复 → 装配器 → 拿到可执行的 tool-call ===");
{
	const produced = await throughPlugin(() => modelTextCallStream("pwsh", { command: "echo hello" }));

	// 宿主真实装配
	const asm = new BlockAssembler();
	for (const c of produced) asm.push(c);
	const { blocks } = asm.assembled();

	const toolCalls = blocks.filter((b) => b.type === "tool-call");
	ck("装配器产出 1 个 tool-call 块", toolCalls.length === 1, JSON.stringify(blocks.map((b) => b.type)));
	ck("工具名正确", toolCalls[0]?.name === "pwsh", toolCalls[0]?.name);
	let parsedArgs = null;
	try { parsedArgs = JSON.parse(toolCalls[0]?.arguments); } catch { /* ignore */ }
	ck("参数可 JSON 解析", parsedArgs !== null, toolCalls[0]?.arguments);
	ck("参数内容正确（可直接执行）", parsedArgs?.command === "echo hello", JSON.stringify(parsedArgs));
	ck("保留原始推理内容", blocks.some((b) => b.type === "reasoning"), JSON.stringify(blocks.map((b) => b.type)));
}

console.log("\n=== 2. 端到端：finish 原因被上层正确识别 ===");
{
	const produced = await throughPlugin(() => modelTextCallStream("read", { file_path: "/a.txt" }));
	const fin = produced.find((c) => c.type === "finish");
	ck("finish.kind = tool-calls", fin?.reason?.kind === "tool-calls", JSON.stringify(fin?.reason));
	ck("finish 无 failure", fin?.reason?.failure === undefined, JSON.stringify(fin?.reason?.failure));
}

console.log("\n=== 3. 端到端：宿主可见性判定（assistantStreamHasVisibleContent）===");
{
	// 有工具调用的响应，应被视为"有可见内容"（输入是压缩记录）
	const produced = await throughPlugin(() => modelTextCallStream("pwsh", { command: "ls" }));
	let hasVisible = null;
	try { hasVisible = assistantStreamHasVisibleContent(toRecords(produced)); } catch (e) { hasVisible = `抛异常: ${e.message}`; }
	ck("恢复后被视为有可见内容", hasVisible === true, String(hasVisible));

	// 对照：无标记的正常文本
	const normal = await throughPlugin(() => (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "正常回复内容。" };
		yield { type: "block-end", index: 0, block: { type: "text", text: "正常回复内容。" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})());
	const normalVisible = (() => { try { return assistantStreamHasVisibleContent(toRecords(normal)); } catch (e) { return "抛异常: " + e.message; } })();
	ck("正常文本被视为有可见内容", normalVisible === true, String(normalVisible));
}

console.log("\n=== 4. 端到端：宿主的 chunk 提取与文本拼接 ===");
{
	const produced = await throughPlugin(() => modelTextCallStream("pwsh", { command: "echo hi" }));
	// assistantStreamChunks：宿主用它取所有 chunk
	const records = toRecords(produced);
	let chunks = null;
	try { chunks = assistantStreamChunks(records, "text-delta"); } catch (e) { chunks = `抛异常: ${e.message}`; }
	ck("assistantStreamChunks 可处理插件输出", Array.isArray(chunks), typeof chunks);

	// joinAssistantStreamText：宿主用它拼文本
	let text = null;
	try { text = joinAssistantStreamText(records); } catch (e) { text = `抛异常: ${e.message}`; }
	ck("joinAssistantStreamText 不抛异常", typeof text === "string", String(text));
	// 关键：拼接出的文本不应含原始 XML 标记（已被剥离）
	if (typeof text === "string") {
		ck("拼接文本不含 <tool_call>（标记已剥离）", !text.includes("<tool_call>"), JSON.stringify(text.slice(0, 120)));
		ck("拼接文本不含 <function=", !text.includes("<function="), JSON.stringify(text.slice(0, 120)));
	}
}

console.log("\n=== 5. 端到端：chunkHasVisibleText 逐 chunk 判定 ===");
{
	const produced = await throughPlugin(() => modelTextCallStream("pwsh", { command: "ls" }));
	// chunkHasVisibleText 接受单个 chunk；每个 chunk 都应能被判定（不抛异常）
	let err = null;
	for (const c of produced) {
		try { chunkHasVisibleText(c); } catch (e) { err = `${c.type}: ${e.message}`; break; }
	}
	ck("所有 chunk 都能被 chunkHasVisibleText 处理", err === null, err ?? "");

	// **重要**：纯工具调用的响应在剥离后没有可见文本 —— 这是**正确**行为
	// （模型只输出了调用，没有可展示内容）。因此这里断言的是「不抛异常」，
	// 而不是「一定有可见文本」。
	//
	// 对照：带说明文字的响应，剥离后说明文字必须保留。
	const withProse = await throughPlugin(() => (async function* () {
		const m = OC + "\n<function=pwsh>\n<parameter=command>\necho x\n</parameter>\n</function>\n" + CC;
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "我先执行命令：" + m };
		yield { type: "block-end", index: 0, block: { type: "text", text: "我先执行命令：" + m } };
		yield { type: "finish", reason: { kind: "stop" } };
	})());
	const proseVisible = withProse.filter((c) => { try { return chunkHasVisibleText(c); } catch { return false; } });
	ck("带说明文字时可见文本必须保留", proseVisible.length > 0, String(proseVisible.length));

	// 且说明文字本身要完整保留（不被剥离逻辑吃掉）
	const proseText = joinAssistantStreamText(toRecords(withProse));
	ck("说明文字内容完整保留", proseText === "我先执行命令：", JSON.stringify(proseText));
}

console.log("\n=== 6. 端到端：持久化 → 回放 → 仍是可执行的 tool-call ===");
{
	const produced = await throughPlugin(() => modelTextCallStream("write", { file_path: "/tmp/a.txt", content: "data" }));

	// 保存到累加器（模拟写入会话日志）
	const acc = new AssistantStreamAccumulator();
	let t = 1700000000000;
	for (const c of produced) { acc.push({ time: t, chunk: c }); t += 5; }
	const snapshot = acc.snapshot();

	// 从快照回放装配
	const replayAsm = assembleAssistantStream(snapshot);
	const { blocks: replayBlocks } = replayAsm.assembled();

	const replayToolCalls = replayBlocks.filter((b) => b.type === "tool-call");
	ck("回放后仍有 1 个 tool-call", replayToolCalls.length === 1, JSON.stringify(replayBlocks.map((b) => b.type)));
	ck("回放后工具名一致", replayToolCalls[0]?.name === "write", replayToolCalls[0]?.name);
	let replayArgs = null;
	try { replayArgs = JSON.parse(replayToolCalls[0]?.arguments); } catch { /* ignore */ }
	ck("回放后参数完整", replayArgs?.file_path === "/tmp/a.txt" && replayArgs?.content === "data", JSON.stringify(replayArgs));
}

console.log("\n=== 7. 端到端：多工具调用（模型一次输出两个）===");
{
	const mk = (tool, args) => {
		const params = Object.entries(args).map(([k, v]) => `<parameter=${k}>\n${v}\n</parameter>`).join("\n");
		return OC + "\n<function=" + tool + ">\n" + params + "\n</function>\n" + CC;
	};
	const twoCalls = mk("pwsh", { command: "echo 1" }) + "\n" + mk("read", { file_path: "/b.txt" });

	const produced = await throughPlugin(() => (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: twoCalls };
		yield { type: "block-end", index: 0, block: { type: "text", text: twoCalls } };
		yield { type: "finish", reason: { kind: "stop" } };
	})());

	const asm = new BlockAssembler();
	for (const c of produced) asm.push(c);
	const { blocks } = asm.assembled();
	const tcs = blocks.filter((b) => b.type === "tool-call");
	ck("两个调用都被恢复", tcs.length === 2, JSON.stringify(tcs.map((b) => b.name)));
	ck("调用顺序正确", tcs[0]?.name === "pwsh" && tcs[1]?.name === "read", JSON.stringify(tcs.map((b) => b.name)));
	ck("参数各自独立", JSON.parse(tcs[0]?.arguments ?? "{}").command === "echo 1"
		&& JSON.parse(tcs[1]?.arguments ?? "{}").file_path === "/b.txt", JSON.stringify(tcs.map((b) => b.arguments)));
}

console.log("\n=== 8. 端到端：带 replayState 的完整链路 ===");
{
	const rs = {
		response: { kind: "pi-ai", version: 2, api: "openai-completions", provider: "magpie", model: "auto/deepseek-v4.1-flash", stopReason: "stop" },
		blocks: [{ type: "reasoning" }, { type: "text" }],
	};
	const produced = await throughPlugin(() => modelTextCallStream("pwsh", { command: "echo rs" }, { replayState: rs }));

	const asm = new BlockAssembler();
	for (const c of produced) asm.push(c);
	const live = asm.assembled();
	ck("有 replayState 时装配成功", live.blocks.length > 0, String(live.blocks.length));
	ck("replay 被保留（块数已对齐）", live.replay !== undefined, JSON.stringify(live.replay?.blocks?.map((b) => b.type)));
	ck("replay.stopReason 是宿主认可值", ["toolUse", "stop"].includes(live.replay?.response?.stopReason), live.replay?.response?.stopReason);

	// 回放路径
	const acc = new AssistantStreamAccumulator();
	let t = 1700000000000;
	for (const c of produced) { acc.push({ time: t, chunk: c }); t += 5; }
	const replay = assembleAssistantStream(acc.snapshot()).assembled();
	const fmt = (r) => JSON.stringify(r.blocks.map((b) => ({ t: b.type, n: b.name, a: b.arguments, x: b.text })));
	ck("实时与回放内容完全一致", fmt(live) === fmt(replay), `live=${fmt(live).slice(0, 100)} replay=${fmt(replay).slice(0, 100)}`);
}

console.log("\n=== 9. 端到端：消息构造（createAssistantMessage）===");
{
	const produced = await throughPlugin(() => modelTextCallStream("pwsh", { command: "ls" }));
	const asm = new BlockAssembler();
	for (const c of produced) asm.push(c);
	const { blocks } = asm.assembled();

	let msg = null;
	let err = null;
	try {
		msg = createAssistantMessage({ content: blocks });
	} catch (e) { err = e.message; }
	ck("createAssistantMessage 可接受装配结果", err === null, err ?? "");
	if (msg) {
		ck("消息里有 tool-call 内容块", (msg.content ?? []).some((b) => b.type === "tool-call"), JSON.stringify((msg.content ?? []).map((b) => b.type)));
	}
}

console.log("\n=== 10. 端到端：不该恢复的场景不产生 tool-call ===");
{
	// 正常文本（含"工具"字样但无标记）
	const normal = await throughPlugin(() => (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "我用 pwsh 工具执行命令。这是一段正常说明。" };
		yield { type: "block-end", index: 0, block: { type: "text", text: "我用 pwsh 工具执行命令。这是一段正常说明。" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})());
	const asm = new BlockAssembler();
	for (const c of normal) asm.push(c);
	const { blocks } = asm.assembled();
	ck("正常文本不产生 tool-call", blocks.filter((b) => b.type === "tool-call").length === 0, JSON.stringify(blocks.map((b) => b.type)));
	ck("正常文本 finish 保持 stop", normal.find((c) => c.type === "finish")?.reason?.kind === "stop");
}

console.log(`\n===== 端到端链路演练: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
