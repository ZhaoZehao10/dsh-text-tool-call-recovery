/**
 * 最小复现 B（harness 侧）：为什么"模型抽风"会变成"用户侧无声卡住"
 *
 * 自包含、无依赖。用 dsh-llm 的 StreamChunk 协议原样重放失败响应的 chunk 序列
 * （与 pi-ai openai-completions 适配器 toStreamChunks 对失败响应的输出一致），
 * 然后按 dsh-agent-loop 的判定逻辑展示后果。
 *
 * 运行：node harness-side.mjs
 *
 * 结论：装配出的 assistant 消息只有一个 reasoning 块、没有 tool-call 块；
 * agent loop 的 "没有 tool-call 块就 return completed" 会让回合静默结束——
 * 不报错、不重试、不执行任何工具。
 */
// 文本工具调用标记（用拼接构造，避免本文件自身触发同类解析问题）
const OPEN_CALL = "<" + "tool_call>";
const CLOSE_CALL = "</" + "tool_call>";
const OPEN_FN = "<" + "function=pwsh>";
const CLOSE_FN = "</" + "function>";
const OPEN_P = "<" + "parameter=command>";
const CLOSE_P = "</" + "parameter>";
const OPEN_P2 = "<" + "parameter=description>";
const CLOSE_P2 = "</" + "parameter>";

// ---- 1. 失败响应的 reasoning 文本（取自真实会话日志，路径已脱敏）----
const REASONING_WITH_XML = [
	"The deliverables folder is empty (no directories listed). Let me check if it exists at all.",
	"",
	"Let me be efficient.交付物目录是空的？查证，同时深入看知识库：" + OPEN_CALL,
	OPEN_FN,
	OPEN_P,
	'$d="C:\\Users\\me\\.dsh\\workspace\\deliverables"',
	"Get-ChildItem $d -Recurse -ErrorAction SilentlyContinue | Measure-Object",
	CLOSE_P,
	OPEN_P2,
	"Survey deliverables directory",
	CLOSE_P2,
	CLOSE_FN,
	CLOSE_CALL
].join("\n");

// ---- 2. 失败响应的 chunk 序列（与 pi-ai 适配器 toStreamChunks 的输出一致）----
function failingStream() {
	return (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: REASONING_WITH_XML };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: REASONING_WITH_XML } };
		yield { type: "usage", usage: { inputTokens: 1118, outputTokens: 453, totalTokens: 420131, cacheReadTokens: 418560 } };
		yield {
			type: "finish",
			reason: { kind: "stop" },
			replayState: {
				response: { kind: "pi-ai", version: 2, api: "openai-completions", provider: "step-plan-152", model: "step-5-preview", stopReason: "stop" },
				blocks: [{ type: "reasoning", thinkingSignature: "reasoning_content" }]
			}
		};
	})();
}

// ---- 3. dsh-llm BlockAssembler 的最小等价实现 ----
class MiniAssembler {
	partials = new Map();
	order = [];
	push(chunk) {
		switch (chunk.type) {
			case "block-start":
				if (!this.partials.has(chunk.index)) {
					this.order.push(chunk.index);
					this.partials.set(chunk.index, { blockType: chunk.blockType, text: "" });
				}
				return;
			case "text-delta":
			case "reasoning-delta":
				this.partials.get(chunk.index).text += chunk.text;
				return;
			case "block-end":
				this.partials.get(chunk.index).block = chunk.block;
				return;
			default:
				return;
		}
	}
	blocks() {
		return this.order.map((i) => {
			const p = this.partials.get(i);
			return p.block ?? { type: p.blockType, text: p.text };
		});
	}
}

// ---- 4. dsh-agent-loop 的判定逻辑（lib/index.js:1152-1153 等价）----
async function main() {
	const asm = new MiniAssembler();
	let finish;
	for await (const chunk of failingStream()) {
		asm.push(chunk);
		if (chunk.type === "finish") finish = chunk;
	}
	const blocks = asm.blocks();
	console.log("装配出的 assistant 消息块:");
	for (const b of blocks) {
		console.log(`  - type=${b.type}` + (b.type === "reasoning" ? ` text(${b.text.length} 字符，含 XML 工具调用标记: ${b.text.includes(OPEN_CALL)})` : ""));
	}
	const toolCalls = blocks.filter((b) => b.type === "tool-call");
	console.log(`\nfinish.reason = ${JSON.stringify(finish.reason)}`);
	console.log(`tool-call 块数量 = ${toolCalls.length}`);
	const loopResult = toolCalls.length === 0 ? { kind: "completed" } : "executeToolCalls(...)";
	console.log(`\nagent loop 判定: ${JSON.stringify(loopResult)}`);
	console.log(toolCalls.length === 0
		? "=> 回合静默结束：无错误、无重试、无工具执行。用户侧表现为'思考一会儿然后卡住'。"
		: "=> 正常执行工具。");
	console.log("\n期望行为（修复后）：解析 reasoning/text 中的 XML 工具调用标记 -> 合成 tool-call 块 -> finish 改写为 tool-calls；");
	console.log("或（无法解析时）：'stop 且无可执行内容' -> EMPTY_RESPONSE 错误 -> 触发重试策略，而不是静默结束。");
}
main();
