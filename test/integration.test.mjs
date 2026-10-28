// 集成测试：用复刻自真实失败样本的 chunk 序列验证修复插件
// 1) 复刻失败流（reasoning 内含 XML 工具调用 + finish stop）
// 2) 过插件包装 -> 过真实 BlockAssembler -> 断言合成出 tool-call 块
// 3) 覆盖：结构化 tool_calls 直通、纯文本直通、只有思考 -> EMPTY_RESPONSE、
//    Anthropic 风格、截断标记安全网等 13 个用例组共 46 项断言。
//
// 依赖说明（可移植）：
// - 被测插件：同仓库 lib/index.js，按相对路径导入。
// - 真实 BlockAssembler：来自 @deepseek-ai/dsh-llm。默认从本仓库 node_modules
//   解析；若尚未安装依赖，可用 DSH_LLM_SRC 环境变量指向任意一份 dsh-llm 源码目录
//   （例如从 DSH 安装包的 app.asar 中解出的 dsh/node_modules/@deepseek-ai/dsh-llm）。
import * as plugin from "../lib/index.js";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const BlockAssembler = (await (async () => {
	const candidates = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(process.cwd(), "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
		path.join(process.cwd(), "..", "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js")
	].filter(Boolean);
	for (const c of candidates) {
		if (fs.existsSync(c)) return import(pathToFileURL(c).href);
	}
	console.error("找不到 @deepseek-ai/dsh-llm 的 BlockAssembler。请设置 DSH_LLM_SRC 指向 dsh-llm 源码目录，");
	console.error("或在本仓库执行 npm install @deepseek-ai/dsh-llm（版本需与你的 DSH 匹配）。");
	process.exit(1);
})()).BlockAssembler;

let passed = 0, failed = 0;
function check(label, cond, detail) {
	if (cond) { passed++; console.log(`  PASS ${label}`); }
	else { failed++; console.log(`  FAIL ${label}${detail ? " :: " + detail : ""}`); }
}

// ---- 捕获 llm/stream 监听器（走插件公开入口 apply） ----
let listener;
const mockCtx = { on: (event, handler) => { if (event === "llm/stream") listener = handler; } };
plugin.apply(mockCtx);
if (typeof listener !== "function") { console.log("FATAL: listener not registered"); process.exit(1); }

// ---- 用拼接构造字面标记，避免本文件自身触发同类解析问题 ----
const OPEN_CALL = "<" + "tool_call>";
const CLOSE_CALL = "</" + "tool_call>";
const OPEN_FN = "<" + "function=pwsh>";
const CLOSE_FN = "</" + "function>";
const OPEN_P1 = "<" + "parameter=command>";
const CLOSE_P1 = "</" + "parameter>";
const OPEN_P2 = "<" + "parameter=description>";
const CLOSE_P2 = "</" + "parameter>";

// 复刻真实失败样本的 reasoning 结构（取自一次 step-5-preview 的生产会话，
// 路径与目录名已替换为占位符——原样本包含内部项目路径）。
const REAL_REASONING =
	"The deliverables folder is empty (no directories listed). Let me check if it exists at all.\n\n" +
	"Let me be efficient. 目录是空的？查证，同时深入看知识库：" + OPEN_CALL + "\n" +
	OPEN_FN + "\n" +
	OPEN_P1 + "\n$d=\"<workspace>\\deliverables\"\necho \"=== 目录存在性 ===\"\nif (Test-Path $d) {\n  \"  OK exists\"\n  $all = Get-ChildItem $d -Recurse -ErrorAction SilentlyContinue\n  \"  total: \" + ($all | Measure-Object).Count\n} else {\n  \"  MISSING\"\n}\n" + CLOSE_P1 + "\n" +
	OPEN_P2 + "\nCheck the deliverables directory in detail\n" + CLOSE_P2 + "\n" +
	CLOSE_FN + "\n" + CLOSE_CALL;

const TOOLS = [
	{ name: "pwsh", description: "Run PowerShell", parameters: { type: "object", properties: { command: { type: "string" }, description: { type: "string" } }, required: ["command"] } },
	{ name: "read", description: "Read a file", parameters: { type: "object", properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } } } }
];
const OPTIONS = { provider: "step-plan-152", model: "step-5-preview", messages: [], tools: TOOLS };

// ---- 流构造辅助 ----
function reasoningOnlyStream(text, replayBlocks) {
	return (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
		yield { type: "usage", usage: { inputTokens: 1118, outputTokens: 453, totalTokens: 420131 } };
		yield { type: "finish", reason: { kind: "stop" }, replayState: { response: { kind: "pi-ai", version: 2, api: "openai-completions", provider: "step-plan-152", model: "step-5-preview", stopReason: "stop" }, blocks: replayBlocks ?? [{ type: "reasoning" }] } };
	})();
}

async function collect(stream) {
	const out = [];
	for await (const chunk of stream) out.push(chunk);
	return out;
}

// 复刻 dsh-llm 不变式校验器的关键规则
function validateStream(chunks) {
	const open = new Map();
	let usageSeen = false, finished = false;
	for (const c of chunks) {
		if (finished) return `chunk ${c.type} after terminal finish`;
		switch (c.type) {
			case "block-start":
				if (!Number.isSafeInteger(c.index) || c.index < 0) return `bad index ${c.index}`;
				if (open.has(c.index)) return `repeated block-start ${c.index}`;
				open.set(c.index, c.blockType);
				break;
			case "text-delta":
			case "reasoning-delta":
			case "tool-call-delta":
				if (open.get(c.index) === undefined) return `${c.type} for closed index ${c.index}`;
				break;
			case "block-end": {
				const t = open.get(c.index);
				if (t === undefined) return `block-end without open block ${c.index}`;
				if (c.block.type !== t) return `block-end type ${c.block.type} != ${t}`;
				open.delete(c.index);
				break;
			}
			case "usage":
				if (usageSeen) return "usage twice";
				usageSeen = true;
				break;
			case "finish":
				if (open.size > 0 && c.reason.kind !== "error" && c.reason.kind !== "aborted") return `finish with ${open.size} open block(s)`;
				finished = true;
				break;
		}
	}
	if (!finished) return "no terminal finish";
	return null;
}

function assemble(chunks) {
	const asm = new BlockAssembler();
	for (const c of chunks) asm.push(c);
	return asm.assembled();
}

// ================= 用例 1：真实失败样本 =================
console.log("\n[用例 1] step-5-preview 把工具调用写进 reasoning（真实样本）");
{
	const chunks = await collect(listener(OPTIONS, () => reasoningOnlyStream(REAL_REASONING)));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
	const { blocks, replay } = assemble(chunks);
	const toolCalls = blocks.filter((b) => b.type === "tool-call");
	check("合成了 1 个 tool-call 块", toolCalls.length === 1, JSON.stringify(blocks.map((b) => b.type)));
	const finish = chunks.find((c) => c.type === "finish");
	check("finish 改写为 tool-calls", finish?.reason?.kind === "tool-calls", JSON.stringify(finish?.reason));
	if (toolCalls.length === 1) {
		const args = JSON.parse(toolCalls[0].arguments);
		check("工具名是 pwsh", toolCalls[0].name === "pwsh", toolCalls[0].name);
		check("command 参数完整且首尾无多余换行", typeof args.command === "string" && args.command.startsWith("$d=") && args.command.endsWith("}"), JSON.stringify(args).slice(0, 120));
		check("description 参数正确", args.description === "Check the deliverables directory in detail", JSON.stringify(args.description));
		check("id 非空", typeof toolCalls[0].id === "string" && toolCalls[0].id.length > 0, toolCalls[0].id);
	}
	const reasoning = blocks.find((b) => b.type === "reasoning");
	check("reasoning 里的标记被剥离", reasoning && !reasoning.text.includes("tool_call"), reasoning?.text?.slice(-80));
	check("reasoning 保留了思考正文", reasoning && reasoning.text.includes("目录是空的"), reasoning?.text?.slice(0, 80));
	check("replay 块数与装配块数对齐", replay !== undefined && replay.blocks.length === blocks.length, replay ? `${replay.blocks.length} vs ${blocks.length}` : "replay dropped");
	check("replay stopReason 更新为 toolUse", replay?.response?.stopReason === "toolUse", JSON.stringify(replay?.response?.stopReason));
}

// ================= 用例 2：安全网（只有思考、无标记） =================
console.log("\n[用例 2] 只有 reasoning、没有任何可执行内容 -> EMPTY_RESPONSE");
{
	const chunks = await collect(listener(OPTIONS, () => reasoningOnlyStream("Just some thinking, nothing else.")));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
	const finish = chunks.find((c) => c.type === "finish");
	check("finish 改写为 error/EMPTY_RESPONSE", finish?.reason?.kind === "error" && finish.reason.failure.code === "EMPTY_RESPONSE", JSON.stringify(finish?.reason));
	check("错误信息点名模型", /step-5-preview/.test(finish?.reason?.failure?.message ?? ""), finish?.reason?.failure?.message);
}

// ================= 用例 3：结构化 tool_calls 直通 =================
console.log("\n[用例 3] 模型正常返回结构化 tool_calls -> 原样放行");
{
	const structured = (async function* () {
		yield { type: "block-start", index: 0, blockType: "tool-call" };
		yield { type: "tool-call-delta", index: 0, id: "chatcmpl-tool-1", name: "pwsh", argumentsDelta: "{\"command\":\"ls\"}" };
		yield { type: "block-end", index: 0, block: { type: "tool-call", id: "chatcmpl-tool-1", name: "pwsh", arguments: "{\"command\":\"ls\"}" } };
		yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
		yield { type: "finish", reason: { kind: "tool-calls" }, replayState: { response: { stopReason: "toolUse" }, blocks: [{ type: "tool-call" }] } };
	})();
	const chunks = await collect(listener(OPTIONS, () => structured));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
	const { blocks } = assemble(chunks);
	check("tool-call 块原样保留", blocks.length === 1 && blocks[0].id === "chatcmpl-tool-1", JSON.stringify(blocks));
	const finish = chunks.find((c) => c.type === "finish");
	check("finish 保持 tool-calls 且 replay 未被改动", finish?.reason?.kind === "tool-calls" && finish.replayState.blocks.length === 1, JSON.stringify(finish?.replayState));
}

// ================= 用例 4：普通文本回复直通 =================
console.log("\n[用例 4] 普通文本回复 -> 原样放行");
{
	const textStream = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "你好，这是普通回复。" };
		yield { type: "block-end", index: 0, block: { type: "text", text: "你好，这是普通回复。" } };
		yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const chunks = await collect(listener(OPTIONS, () => textStream));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
	const finish = chunks.find((c) => c.type === "finish");
	check("finish 保持 stop", finish?.reason?.kind === "stop", JSON.stringify(finish?.reason));
	const { blocks } = assemble(chunks);
	check("文本块保留", blocks.length === 1 && blocks[0].text === "你好，这是普通回复。", JSON.stringify(blocks));
}

// ================= 用例 5：无 tools（compaction/title）直通 =================
console.log("\n[用例 5] 请求没有 tools（compaction/session-title）-> 完全直通");
{
	const noTools = { provider: "deepseek-account", model: "deepseek-flash", messages: [] };
	const src = reasoningOnlyStream("summary thinking");
	const chunks = await collect(listener(noTools, () => src));
	check("chunk 序列原样（同一对象直通）", chunks.length > 0 && chunks[chunks.length - 1].reason.kind === "stop", JSON.stringify(chunks[chunks.length - 1]?.reason));
}

// ================= 用例 6：未声明工具名的标记不被执行 =================
console.log("\n[用例 6] 标记里是未声明的工具名 -> 不当成调用，走 EMPTY_RESPONSE 重试");
{
	const bogus = "思考中：" + OPEN_CALL + "\n" + "<" + "function=evil_tool>" + "\n" + OPEN_P1 + "\nx\n" + CLOSE_P1 + "\n" + "</" + "function>" + "\n" + CLOSE_CALL;
	const chunks = await collect(listener(OPTIONS, () => reasoningOnlyStream(bogus)));
	const { blocks } = assemble(chunks);
	check("没有合成 tool-call", !blocks.some((b) => b.type === "tool-call"), JSON.stringify(blocks.map((b) => b.type)));
	const finish = chunks.find((c) => c.type === "finish");
	check("模型想调工具但调不了 -> EMPTY_RESPONSE（不静默结束）", finish?.reason?.kind === "error" && finish.reason.failure.code === "EMPTY_RESPONSE", JSON.stringify(finish?.reason));
}

// ================= 用例 7：多个工具调用 =================
console.log("\n[用例 7] 一次响应里多个文本工具调用");
{
	const OPEN_P_FILE = "<" + "parameter=file_path>";
	const two = "先做两步：" + OPEN_CALL + "\n" + "<" + "function=read>" + "\n" + OPEN_P_FILE + "\nREADME.md\n" + CLOSE_P1 + "\n" + "</" + "function>" + "\n" + CLOSE_CALL +
		"\n然后：" + OPEN_CALL + "\n" + "<" + "function=pwsh>" + "\n" + OPEN_P1 + "\nls\n" + CLOSE_P1 + "\n" + "</" + "function>" + "\n" + CLOSE_CALL;
	const chunks = await collect(listener(OPTIONS, () => reasoningOnlyStream(two)));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
	const { blocks } = assemble(chunks);
	const calls = blocks.filter((b) => b.type === "tool-call");
	check("合成了 2 个 tool-call", calls.length === 2, JSON.stringify(blocks.map((b) => b.type)));
	check("顺序保持（read 然后 pwsh）", calls[0]?.name === "read" && calls[1]?.name === "pwsh", calls.map((c) => c.name).join(","));
	check("id 唯一", new Set(calls.map((c) => c.id)).size === 2, calls.map((c) => c.id).join(","));
	check("read 参数正确", JSON.parse(calls[0].arguments).file_path === "README.md", calls[0].arguments);
}

// ================= 用例 8：JSON 形式工具调用 =================
console.log("\n[用例 8] JSON 形式的文本工具调用");
{
	const jsonForm = "用 JSON 形式：" + OPEN_CALL + '\n{"name":"pwsh","arguments":{"command":"echo hi","description":"say hi"}}\n' + CLOSE_CALL;
	const chunks = await collect(listener(OPTIONS, () => reasoningOnlyStream(jsonForm)));
	const { blocks } = assemble(chunks);
	const calls = blocks.filter((b) => b.type === "tool-call");
	check("合成了 1 个 tool-call", calls.length === 1, JSON.stringify(blocks.map((b) => b.type)));
	check("参数解析正确", calls.length === 1 && JSON.parse(calls[0].arguments).command === "echo hi", calls[0]?.arguments);
}

// ================= 用例 9：标记出现在 text 块（有的模型走 content） =================
console.log("\n[用例 9] 工具调用标记出现在 text 块");
{
	const textWithMarkup = "我来执行：" + OPEN_CALL + "\n" + "<" + "function=pwsh>" + "\n" + OPEN_P1 + "\nGet-Date\n" + CLOSE_P1 + "\n" + "</" + "function>" + "\n" + CLOSE_CALL;
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: textWithMarkup };
		yield { type: "block-end", index: 0, block: { type: "text", text: textWithMarkup } };
		yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
		yield { type: "finish", reason: { kind: "stop" }, replayState: { response: { stopReason: "stop" }, blocks: [{ type: "text" }] } };
	})();
	const chunks = await collect(listener(OPTIONS, () => src));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
	const { blocks } = assemble(chunks);
	const calls = blocks.filter((b) => b.type === "tool-call");
	check("从 text 块合成了 tool-call", calls.length === 1 && calls[0].name === "pwsh", JSON.stringify(blocks.map((b) => b.type)));
	check("text 块保留说明文字", blocks.some((b) => b.type === "text" && b.text === "我来执行："), JSON.stringify(blocks.filter((b) => b.type === "text")));
	const finish = chunks.find((c) => c.type === "finish");
	check("finish 改写为 tool-calls", finish?.reason?.kind === "tool-calls", JSON.stringify(finish?.reason));
}

// ================= 用例 10：多行代码参数 + XML 实体 =================
console.log("\n[用例 10] 多行代码参数与 XML 实体解码");
{
	const codeBody = "line1\n  indented\nline3 & <tag> \"quoted\"";
	const escaped = codeBody.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const OPEN_P_CONTENT = "<" + "parameter=content>";
	const markup = "写文件：" + OPEN_CALL + "\n" + "<" + "function=write>" + "\n" + OPEN_P_CONTENT + "\n" + escaped + "\n" + CLOSE_P1 + "\n" + "</" + "function>" + "\n" + CLOSE_CALL;
	const toolsWithWrite = [...TOOLS, { name: "write", description: "Write", parameters: { type: "object", properties: { content: { type: "string" } } } }];
	const opts = { ...OPTIONS, tools: toolsWithWrite };
	const chunks = await collect(listener(opts, () => reasoningOnlyStream(markup)));
	const { blocks } = assemble(chunks);
	const calls = blocks.filter((b) => b.type === "tool-call");
	check("合成了 write 调用", calls.length === 1 && calls[0].name === "write", JSON.stringify(blocks.map((b) => b.type)));
	if (calls.length === 1) {
		const args = JSON.parse(calls[0].arguments);
		check("多行内容完整保留", args.content === codeBody, JSON.stringify(args.content));
	}
}

// ================= 用例 11：Anthropic 风格 parameter name=key 格式 =================
console.log("\n[用例 11] Anthropic 风格 parameter name=key 文本工具调用");
{
	const markup = "执行检查：" + OPEN_CALL + "\n" + "<" + "function=pwsh>" + "\n"
		+ "<" + "parameter name=\"command\">" + "\nGet-Date\n" + CLOSE_P1 + "\n"
		+ "<" + "parameter name=\"description\">" + "\nCheck time\n" + CLOSE_P1 + "\n"
		+ "</" + "function>" + "\n" + CLOSE_CALL;
	const chunks = await collect(listener(OPTIONS, () => reasoningOnlyStream(markup)));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
	const { blocks } = assemble(chunks);
	const calls = blocks.filter((b) => b.type === "tool-call");
	check("合成了 1 个 tool-call（name 属性风格）", calls.length === 1 && calls[0].name === "pwsh", JSON.stringify(blocks.map((b) => b.type)));
	if (calls.length === 1) {
		const args = JSON.parse(calls[0].arguments);
		check("command 参数正确", args.command === "Get-Date", JSON.stringify(args));
		check("description 参数正确", args.description === "Check time", JSON.stringify(args));
	}
	const finish = chunks.find((c) => c.type === "finish");
	check("finish 改写为 tool-calls", finish?.reason?.kind === "tool-calls", JSON.stringify(finish?.reason));
}

// ================= 用例 12：被截断的工具调用标记（网关 flash-max 实测形态） =================
console.log("\n[用例 12] 被截断的工具调用标记 -> 触发 EMPTY_RESPONSE 而非静默结束");
{
	// 重置“连续空响应”计数：本用例断言的是**首次**出现时的行为。
	plugin.resetStreaks?.();
	// 复刻真实样本：Anthropic 风格标记，结尾是不完整的闭合标签（路径已脱敏）
	const truncated = "<" + "parameter name=\"command\">$wd=\"<workspace>\"\nGet-ChildItem $wd\n" + CLOSE_P1 + "\n"
		+ "<" + "parameter name=\"description\">Verify\n" + CLOSE_P1 + "\n"
		+ "</" + "tool"; // 截断：不完整的 tool_call 闭合标签
	const chunks = await collect(listener(OPTIONS, () => reasoningOnlyStream(truncated)));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
	const { blocks } = assemble(chunks);
	check("没有合成 tool-call（标记不完整）", !blocks.some((b) => b.type === "tool-call"), JSON.stringify(blocks.map((b) => b.type)));
	const finish = chunks.find((c) => c.type === "finish");
	check("截断标记触发 EMPTY_RESPONSE（不静默结束）", finish?.reason?.kind === "error" && finish.reason.failure.code === "EMPTY_RESPONSE", JSON.stringify(finish?.reason));
}

// ================= 用例 13：截断标记在 text 块 + 有前置文字 =================
console.log("\n[用例 13] 截断标记混在 text 块（含前置文字）");
{
	// 同样断言“首次”行为，先重置计数。
	plugin.resetStreaks?.();
	const mixed = "先做检查：" + "<" + "parameter name=\"command\">\nls\n" + CLOSE_P1;
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: mixed };
		yield { type: "block-end", index: 0, block: { type: "text", text: mixed } };
		yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const chunks = await collect(listener(OPTIONS, () => src));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
	const finish = chunks.find((c) => c.type === "finish");
	check("只含截断标记的文本 -> EMPTY_RESPONSE", finish?.reason?.kind === "error" && finish.reason.failure.code === "EMPTY_RESPONSE", JSON.stringify(finish?.reason));
}

// ================= 用例 14：正常正文偶然提及标记（防误伤）=================
console.log("\n[用例 14] 正常正文里提到标记写法 -> 不得误判为截断");
{
	// 真实风险：模型在解释/写文档时会顺带提到这类标记，文本有实质内容，
	// 不能因为出现标记就把一条正常回复改成 EMPTY_RESPONSE 重试。
	const prose = "在文档里我们提到 <" + "parameter=foo> 这种写法是危险的，建议避免使用。";
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: prose };
		yield { type: "block-end", index: 0, block: { type: "text", text: prose } };
		yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const chunks = await collect(listener(OPTIONS, () => src));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
	const finish = chunks.find((c) => c.type === "finish");
	check("正文提及标记 -> 保持 stop（不误伤）", finish?.reason?.kind === "stop", JSON.stringify(finish?.reason));
	check("没有合成 tool-call", !chunks.some((c) => c.type === "block-start" && c.blockType === "tool-call"));
}

// ================= 用例 15：usage 必须排在 block-end 之后 =================
console.log("\n[用例 15] 扣留 block-end 时 usage 顺序保持 block-end -> usage -> finish");
{
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "普通回复" };
		yield { type: "block-end", index: 0, block: { type: "text", text: "普通回复" } };
		yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const chunks = await collect(listener(OPTIONS, () => src));
	const order = chunks.map((c) => c.type);
	const endIdx = order.indexOf("block-end");
	const usageIdx = order.indexOf("usage");
	const finIdx = order.indexOf("finish");
	check("顺序为 block-end -> usage -> finish", endIdx >= 0 && usageIdx > endIdx && finIdx > usageIdx, JSON.stringify(order));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
}

// ================= 用例 16：恢复调用时 usage 也保持正确顺序 =================
console.log("\n[用例 16] 恢复文本工具调用后 usage 顺序仍正确");
{
	const markup = "执行：" + OPEN_CALL + "\n" + "<" + "function=pwsh>" + "\n" + OPEN_P1 + "\nGet-Date\n" + CLOSE_P1 + "\n" + "</" + "function>" + "\n" + CLOSE_CALL;
	const chunks = await collect(listener(OPTIONS, () => reasoningOnlyStream(markup)));
	const order = chunks.map((c) => c.type);
	const lastEnd = order.lastIndexOf("block-end");
	const usageIdx = order.indexOf("usage");
	const finIdx = order.indexOf("finish");
	check("所有 block-end 都在 usage 之前", lastEnd >= 0 && usageIdx > lastEnd, JSON.stringify(order));
	check("usage 在 finish 之前", finIdx > usageIdx, JSON.stringify(order));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
	check("finish 为 tool-calls", chunks.find((c) => c.type === "finish")?.reason?.kind === "tool-calls");
}

// ================= 用例 17：代码块里的示例不得被执行（安全关键）=================
console.log("\n[用例 17] Markdown 代码块内的标记是“展示”，不得恢复为调用");
{
	// 安全风险：模型讲解格式时常把调用标记放进 ``` 代码块，若被当成真调用会
	// 执行示例命令（例如文档里展示 rm -rf）。必须在恢复阶段排除展示区。
	const dangerous = OPEN_CALL + "\n" + "<" + "function=pwsh>" + "\n" + OPEN_P1 + "\nrm -rf /\n" + CLOSE_P1 + "\n" + "</" + "function>" + "\n" + CLOSE_CALL;
	const doc = "格式示例：\n\n```xml\n" + dangerous + "\n```\n\n以上是示例，不要执行。";
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: doc };
		yield { type: "block-end", index: 0, block: { type: "text", text: doc } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const chunks = await collect(listener(OPTIONS, () => src));
	check("没有从代码块里恢复调用", !chunks.some((c) => c.type === "block-start" && c.blockType === "tool-call"));
	check("finish 保持 stop", chunks.find((c) => c.type === "finish")?.reason?.kind === "stop");
	const text = chunks.filter((c) => c.type === "block-end" && c.block?.type === "text").map((c) => c.block.text).join("");
	check("代码块内容原样保留", text.includes("rm -rf /") && text.includes("以上是示例"));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
}

// ================= 用例 18：行内代码里的标记同样不执行 =================
console.log("\n[用例 18] 行内代码（单反引号）内的标记不执行");
{
	const inline = "模型会输出 `" + OPEN_CALL + "` 这样的开始标记，注意处理。";
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: inline };
		yield { type: "block-end", index: 0, block: { type: "text", text: inline } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const chunks = await collect(listener(OPTIONS, () => src));
	check("行内代码不触发恢复", !chunks.some((c) => c.type === "block-start" && c.blockType === "tool-call"));
	check("finish 保持 stop", chunks.find((c) => c.type === "finish")?.reason?.kind === "stop");
}

// ================= 用例 19：Anthropic antml / invoke 形态（无 tool_call 包裹）=================
console.log("\n[用例 19] Anthropic 官方形态：function/invoke 无外层包裹");
{
	// 这是 Anthropic 工具调用 XML 的真实形态，没有 <tool_call> 包裹。
	const antml = "<" + "antml:function name=\"pwsh\">\n" + "<" + "parameter name=\"command\">\necho antml\n" + CLOSE_P1 + "\n</" + "antml:function>";
	const invoke = "<" + "invoke name=\"pwsh\">\n" + "<" + "parameter name=\"command\">\necho invoke\n" + CLOSE_P1 + "\n</" + "invoke>";
	for (const [label, markup, expected] of [["antml:function", antml, "echo antml"], ["invoke", invoke, "echo invoke"]]) {
		const src = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: markup };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		const chunks = await collect(listener(OPTIONS, () => src));
		const { blocks } = assemble(chunks);
		const calls = blocks.filter((b) => b.type === "tool-call");
		check(`${label} 被恢复为调用`, calls.length === 1 && calls[0].name === "pwsh", JSON.stringify(blocks.map((b) => b.type)));
		if (calls.length === 1) check(`${label} 参数正确`, JSON.parse(calls[0].arguments).command === expected, calls[0].arguments);
	}
}

// ================= 用例 20：防御性——异常输入不得抛异常中断流 =================
console.log("\n[用例 20] 异常输入防御（接缝内抛异常会中断整条流）");
{
	// tools 形状异常
	const weirdOpts = { ...OPTIONS, tools: [{ function: { name: "pwsh" } }, null, 42] };
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "hi" };
		yield { type: "block-end", index: 0, block: { type: "text", text: "hi" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	let threw = null;
	let weirdOut = [];
	try { weirdOut = await collect(listener(weirdOpts, () => src)); } catch (e) { threw = e.message; }
	check("tools 形状异常不抛异常", threw === null, threw);

	// 【变异测试补强】{function:{name}} 形状必须能被识别（否则恢复能力静默失效）
	// 若把 Array.isArray 防御换成裸 options.tools，这里不会抛异常但会**静默不恢复**，
	// 因此必须断言“确实恢复了”。
	const fnShapeOpts = { ...OPTIONS, tools: [{ function: { name: "pwsh" } }] };
	const markupForFnShape = OPEN_CALL + "\n" + OPEN_FN + "\n" + OPEN_P1 + "\necho fn\n" + CLOSE_P1 + "\n" + CLOSE_FN + "\n" + CLOSE_CALL;
	const srcFn = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: markupForFnShape };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: markupForFnShape } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const fnOut = await collect(listener(fnShapeOpts, () => srcFn));
	check("【关键】{function:{name}} 形状的 tools 能识别并恢复调用",
		fnOut.some((c) => c.type === "block-start" && c.blockType === "tool-call"),
		`finish=${JSON.stringify(fnOut.find((c) => c.type === "finish")?.reason)}`);

	// tools 为 null / 非数组时直通（不崩溃、不改写）
	for (const bad of [null, undefined, "not-array", 42, {}]) {
		const opts = { ...OPTIONS, tools: bad };
		let err2 = null;
		let out2 = [];
		// 每条都要用**全新的流**（生成器只能消费一次）
		const freshSrc = () => (async function* () {
			yield { type: "block-start", index: 0, blockType: "text" };
			yield { type: "text-delta", index: 0, text: "hi" };
			yield { type: "block-end", index: 0, block: { type: "text", text: "hi" } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		try { out2 = await collect(listener(opts, freshSrc)); } catch (e) { err2 = e.message; }
		check(`tools=${JSON.stringify(bad) ?? "undefined"} 时直通不崩溃`, err2 === null, err2);
		check(`tools=${JSON.stringify(bad) ?? "undefined"} 时 finish 保持原样`,
			out2.find((c) => c.type === "finish")?.reason?.kind === "stop");
	}

	// block 缺失
	const src2 = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "hi" };
		yield { type: "block-end", index: 0 };   // 缺 block
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	let threw2 = null;
	try { await collect(listener(OPTIONS, () => src2)); } catch (e) { threw2 = e.message; }
	check("block 缺失不抛异常", threw2 === null, threw2);

	// reason 缺失
	const src3 = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "hi" };
		yield { type: "block-end", index: 0, block: { type: "text", text: "hi" } };
		yield { type: "finish" };   // 缺 reason
	})();
	let threw3 = null;
	try { await collect(listener(OPTIONS, () => src3)); } catch (e) { threw3 = e.message; }
	check("reason 缺失不抛异常", threw3 === null, threw3);
}

// ================= 用例 21：确定性失败保护（不空转重试）=================
console.log("\n[用例 21] 同一模型连续空响应 -> 首次重试、之后放行（不空转 5 次）");
{
	plugin.resetStreaks?.();
	const emptyResponseStream = () => (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "只有思考，没有正文也没有调用" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考，没有正文也没有调用" } };
		yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
		yield { type: "finish", reason: { kind: "stop" }, replayState: { response: { stopReason: "stop" }, blocks: [{ type: "reasoning" }] } };
	})();

	// 第 1 次：改写为可重试错误（给间歇性失败一次自愈机会）
	const first = await collect(listener(OPTIONS, emptyResponseStream));
	const f1 = first.find((c) => c.type === "finish");
	check("首次 -> EMPTY_RESPONSE（可重试）", f1?.reason?.kind === "error" && f1.reason.failure.code === "EMPTY_RESPONSE", JSON.stringify(f1?.reason));

	// 第 2 次：同一模型再空 -> 原样放行 stop，避免 5 次空转
	const second = await collect(listener(OPTIONS, emptyResponseStream));
	const f2 = second.find((c) => c.type === "finish");
	check("连续第 2 次 -> 放行 stop（不再空转）", f2?.reason?.kind === "stop", JSON.stringify(f2?.reason));
	check("放行时回放 usage", second.some((c) => c.type === "usage"));

	// 有可见正文后，计数清零：再空一次应重新触发重试
	const normal = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "正常回复内容" };
		yield { type: "block-end", index: 0, block: { type: "text", text: "正常回复内容" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	await collect(listener(OPTIONS, () => normal));
	const third = await collect(listener(OPTIONS, emptyResponseStream));
	const f3 = third.find((c) => c.type === "finish");
	check("恢复正常后计数清零 -> 再次空响应仍触发重试", f3?.reason?.kind === "error", JSON.stringify(f3?.reason));

	// 流合法性
	const err1 = validateStream(first), err2 = validateStream(second), err3 = validateStream(third);
	check("三条流均通过不变式校验", err1 === null && err2 === null && err3 === null, [err1, err2, err3].filter(Boolean).join("; "));
	plugin.resetStreaks?.();
}

// ================= 用例 25：状态表有上界（内存不无界增长）=================
console.log("\n[用例 25] 连续空响应计数表有上界（避免长跑进程内存无界增长）");
{
	// 让 200 个不同模型各产生 1 次空响应，然后检查最早那个模型是否已被淘汰。
	// 若状态表无上界，早期模型会被永久记住 → 不会再触发重试（放行 stop）。
	plugin.resetStreaks?.();
	const emptyStream = () => (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "只有思考" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const runFor = async (model) => {
		const opts = { ...OPTIONS, model };
		const out = await collect(listener(opts, emptyStream));
		return out.find((c) => c.type === "finish")?.reason?.kind;
	};
	for (let i = 0; i < 200; i++) await runFor("bound-model-" + i);
	const kind0 = await runFor("bound-model-0");
	check("【关键】状态表有上界：早期模型已被淘汰（重新触发重试）", kind0 === "error", "实际 kind=" + kind0);
	const kind199 = await runFor("bound-model-199");
	check("最近模型仍被记住（第二次空响应放行）", kind199 === "stop", "实际 kind=" + kind199);
	plugin.resetStreaks?.();
}

// ================= 用例 26：覆盖 safeJsonParse 的两条兜底路径 =================
console.log("\n[用例 26] JSON 兜底路径（覆盖 safeJsonParse 的 catch 分支）");
{
	// 覆盖率分析显示 safeJsonParse 从未被执行过：说明“非法 JSON 参数体”和
	// “arguments 是字符串”这两条兜底路径没有测试。这里逐一覆盖。
	plugin.resetStreaks?.();

	// 26a. 函数体是**非法** JSON（以 { 开头但不合法）→ safeJsonParse 返回 { value }
	const badJsonBody = "{" + "not valid json at all";
	const markupBadJson = OPEN_CALL + "\n" + "<" + "function=pwsh>" + "\n" + badJsonBody + "\n" + "</" + "function>" + "\n" + CLOSE_CALL;
	{
		const src = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: markupBadJson };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: markupBadJson } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		let threw = null;
		let out = [];
		try { out = await collect(listener(OPTIONS, () => src)); } catch (e) { threw = e.message; }
		check("非法 JSON 函数体不抛异常", threw === null, threw);
		const err = validateStream(out);
		check("流通过不变式校验", err === null, err);
	}

	// 26b. 纯 JSON 形式，但 arguments 是**字符串**（需要 safeJsonParse 再解析一次）
	const jsonFormStrArgs = JSON.stringify({ name: "pwsh", arguments: JSON.stringify({ command: "echo str-args" }) });
	{
		const src = (async function* () {
			yield { type: "block-start", index: 0, blockType: "text" };
			yield { type: "text-delta", index: 0, text: OPEN_CALL + "\n" + jsonFormStrArgs + "\n" + CLOSE_CALL };
			yield { type: "block-end", index: 0, block: { type: "text", text: OPEN_CALL + "\n" + jsonFormStrArgs + "\n" + CLOSE_CALL } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		const out = await collect(listener(OPTIONS, () => src));
		const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
		check("arguments 是字符串时仍能解析成对象", calls.length === 1, String(calls.length));
		if (calls.length === 1) {
			const args = JSON.parse(calls[0].block.arguments);
			check("解析出的参数正确", args.command === "echo str-args", JSON.stringify(args));
		}
		const err = validateStream(out);
		check("流通过不变式校验", err === null, err);
	}

	// 26c. arguments 是字符串但**内容非法 JSON** → safeJsonParse 的 catch 分支
	const jsonFormBadStr = JSON.stringify({ name: "pwsh", arguments: "{broken" });
	{
		const src = (async function* () {
			yield { type: "block-start", index: 0, blockType: "text" };
			yield { type: "text-delta", index: 0, text: OPEN_CALL + "\n" + jsonFormBadStr + "\n" + CLOSE_CALL };
			yield { type: "block-end", index: 0, block: { type: "text", text: OPEN_CALL + "\n" + jsonFormBadStr + "\n" + CLOSE_CALL } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		let threw = null;
		let out = [];
		try { out = await collect(listener(OPTIONS, () => src)); } catch (e) { threw = e.message; }
		check("arguments 字符串内容非法时不抛异常", threw === null, threw);
		const err = validateStream(out);
		check("流通过不变式校验", err === null, err);
	}
	plugin.resetStreaks?.();
}

// ================= 用例 27：覆盖此前未走到的分支 =================
console.log("\n[用例 27] 边角分支：空参数名 / 无参函数体 / 超长文本 / 无 tools 直通 / 禁用开关");
{
	plugin.resetStreaks?.();
	const mkSrc = (text, blockType) => (async function* () {
		yield { type: "block-start", index: 0, blockType };
		yield { type: blockType === "text" ? "text-delta" : "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: blockType, text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();

	// 27a. 空参数名（<parameter=>）→ parseParams 应跳过该参数
	{
		const markup = OPEN_CALL + "\n" + OPEN_FN + "\n" + "<" + "parameter=>" + "\nignored\n" + CLOSE_P1 + "\n" + OPEN_P1 + "\necho ok\n" + CLOSE_P1 + "\n" + CLOSE_FN + "\n" + CLOSE_CALL;
		const out = await collect(listener(OPTIONS, () => mkSrc(markup, "reasoning")));
		const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
		check("空参数名被跳过，有效参数保留", calls.length === 1 && Object.keys(JSON.parse(calls[0].block.arguments)).join(",") === "command", JSON.stringify(calls.map((c) => c.block.arguments)));
	}

	// 27b. 无参函数体（<function=pwsh></function>）→ 不应恢复（没有参数无法执行）
	{
		const markup = OPEN_CALL + "\n" + OPEN_FN + "\n" + CLOSE_FN + "\n" + CLOSE_CALL;
		const out = await collect(listener(OPTIONS, () => mkSrc(markup, "reasoning")));
		const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
		check("无参函数体不恢复为调用", calls.length === 0, String(calls.length));
		const err = validateStream(out);
		check("流通过不变式校验", err === null, err);
	}

	// 27c. 超长文本走 hasCodeFence 的上限分支（> 128K）
	{
		const huge = "普通文本。".repeat(50000); // ~250K
		const out = await collect(listener(OPTIONS, () => mkSrc(huge, "text")));
		const fin = out.find((c) => c.type === "finish");
		check("超长文本不崩溃且保持 stop", fin?.reason?.kind === "stop", JSON.stringify(fin?.reason));
		const err = validateStream(out);
		check("流通过不变式校验", err === null, err);
	}

	// 27d. 超长文本走 isMarkupOnlyText 的上限分支
	// 关键：必须**同时含标记且超长**。若不含标记，会在 `if (!hasMarker) return false`
	// 处提前返回，走不到上限检查（这是上一版测试没覆盖到的原因）。
	{
		const markup = OPEN_CALL + "\n" + OPEN_FN + "\n" + OPEN_P1 + "\necho big\n" + CLOSE_P1 + "\n" + CLOSE_FN + "\n" + CLOSE_CALL;
		const hugeMarkup = markup + "\n" + "填充。".repeat(100000); // ~300K，含标记
		const out = await collect(listener(OPTIONS, () => mkSrc(hugeMarkup, "text")));
		const fin = out.find((c) => c.type === "finish");
		// 超长时不恢复、也不误判为纯标记 → 应保持 stop（有大量实质正文）
		check("超长含标记文本按有内容处理（stop）", fin?.reason?.kind === "stop", JSON.stringify(fin?.reason));
	}

	// 27e. tools 为空数组 → declared.size===0 → 完全直通
	{
		const noToolsOpts = { ...OPTIONS, tools: [] };
		const out = await collect(listener(noToolsOpts, () => mkSrc("正常文本", "text")));
		check("无 tools 时直通（finish 保持 stop）", out.find((c) => c.type === "finish")?.reason?.kind === "stop");
		check("无 tools 时返回原始流对象", Array.isArray(out) && out.length > 0);
	}

	// 27f. 环境变量禁用开关 → apply 直接 return（不注册监听器）
	{
		const { apply } = await import("../lib/index.js");
		const events = [];
		const prev = process.env.DSH_TEXT_TOOL_CALL_RECOVERY;
		process.env.DSH_TEXT_TOOL_CALL_RECOVERY = "0";
		try {
			apply({ on: (e) => events.push(e) });
			check("禁用开关生效（不注册监听器）", events.length === 0, JSON.stringify(events));
		} finally {
			if (prev === undefined) delete process.env.DSH_TEXT_TOOL_CALL_RECOVERY;
			else process.env.DSH_TEXT_TOOL_CALL_RECOVERY = prev;
		}
	}

	// 27g. replayState 为 null / 非对象（patchReplayState 的兜底）
	{
		const markup = OPEN_CALL + "\n" + OPEN_FN + "\n" + OPEN_P1 + "\necho x\n" + CLOSE_P1 + "\n" + CLOSE_FN + "\n" + CLOSE_CALL;
		for (const bad of [null, 42, "str"]) {
			const src = (async function* () {
				yield { type: "block-start", index: 0, blockType: "reasoning" };
				yield { type: "reasoning-delta", index: 0, text: markup };
				yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
				yield { type: "finish", reason: { kind: "stop" }, replayState: bad };
			})();
			let threw = null;
			let out = [];
			try { out = await collect(listener(OPTIONS, () => src)); } catch (e) { threw = e.message; }
			check(`replayState=${JSON.stringify(bad)} 不崩溃且仍恢复调用`, threw === null && out.some((c) => c.type === "block-start" && c.blockType === "tool-call"), threw ?? "未恢复");
		}
	}
	plugin.resetStreaks?.();
}

// ================= 用例 28：覆盖 22 处此前未走到的分支 =================
console.log("\n[用例 28] 分支覆盖补全（V8 覆盖率分析定位到 22 处未执行代码块）");
{
	const RICH_TOOLS = [{
		name: "pwsh",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string" },
				n: { type: "number" },
				b: { type: "boolean" },
				o: { type: "object" },
				a: { type: "array" },
				any: {},
			},
		},
	}];
	const richOpts = { ...OPTIONS, tools: RICH_TOOLS };
	const runRich = async (text) => {
		plugin.resetStreaks?.();
		const src = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		const out = [];
		for await (const c of listener(richOpts, () => src)) out.push(c);
		return out;
	};
	const callsOf = (out) => out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call")
		.map((c) => { try { return { name: c.block.name, args: JSON.parse(c.block.arguments) }; } catch { return { name: c.block.name, args: null }; } });
	const wrap28 = (inner) => OPEN_CALL + "\n" + inner + "\n" + CLOSE_CALL;

	// L105/L148：工具声明省略 parameters
	{
		const t2 = [{ name: "pwsh" }];
		const m = wrap28("<function=pwsh><parameter=command>x</parameter></function>");
		const out = await collect(listener({ ...OPTIONS, tools: t2 }, () => (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: m };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: m } };
			yield { type: "finish", reason: { kind: "stop" } };
		})()));
		check("L105/L148 工具无 parameters 时仍能解析", callsOf(out).length === 1, JSON.stringify(callsOf(out)));
	}

	// L119/L123/L128/L118：各 schema 类型强转
	{
		const out = await runRich(wrap28('<function=pwsh><parameter=n>42.5</parameter><parameter=b>true</parameter><parameter=o>{"k":1}</parameter><parameter=a>[1,2]</parameter><parameter=any>raw</parameter></function>'));
		const args = callsOf(out)[0]?.args ?? {};
		check("L119 number 强转", args.n === 42.5, JSON.stringify(args.n));
		check("L123 boolean 强转", args.b === true, JSON.stringify(args.b));
		check("L128 object 强转", JSON.stringify(args.o) === '{"k":1}', JSON.stringify(args.o));
		check("L128 array 强转", JSON.stringify(args.a) === "[1,2]", JSON.stringify(args.a));
		check("L118 无 type 属性保持字符串", args.any === "raw", JSON.stringify(args.any));
	}

	// L146：空参数名跳过
	{
		const out = await runRich(wrap28("<function=pwsh><parameter=>ignored</parameter><parameter=command>ok</parameter></function>"));
		const args = callsOf(out)[0]?.args ?? {};
		check("L146 空参数名被跳过", Object.keys(args).length === 1 && args.command === "ok", JSON.stringify(args));
	}

	// L162：空块体
	{
		const out = await runRich(wrap28(""));
		check("L162 空 tool_call 体不恢复", callsOf(out).length === 0, JSON.stringify(callsOf(out)));
	}

	// L169：块内普通文本
	{
		const out = await runRich(wrap28("这只是一段普通文本"));
		check("L169 块内普通文本不恢复", callsOf(out).length === 0, JSON.stringify(callsOf(out)));
	}

	// L175：函数体是纯 JSON
	{
		const out = await runRich(wrap28('<function=pwsh>{"command":"echo j"}</function>'));
		const c = callsOf(out)[0];
		check("L175 函数体为 JSON 时能解析", c?.args?.command === "echo j", JSON.stringify(c));
	}

	// L232：值内含 < 导致扫描 break
	{
		const out = await runRich(wrap28("<function=pwsh><parameter=command>a < b</parameter></function>"));
		check("L232 值内含 < 时不崩溃", callsOf(out).length === 1, JSON.stringify(callsOf(out)));
	}

	// L346：tool_call 内是未知格式 → 保留原文
	{
		const out = await runRich(wrap28("<<<未知格式>>>"));
		check("L346 未知格式保留原文不恢复", callsOf(out).length === 0, JSON.stringify(callsOf(out)));
		const err = validateStream(out);
		check("L346 流仍合法", err === null, err);
	}

	// L368/L372：replayState 畸形
	{
		const cases = [["非对象", "not-an-object"], ["缺 response", { blocks: [{ type: "reasoning" }] }], ["null", null]];
		for (const [label, rs] of cases) {
			const m = wrap28("<function=pwsh><parameter=command>x</parameter></function>");
			const src = (async function* () {
				yield { type: "block-start", index: 0, blockType: "reasoning" };
				yield { type: "reasoning-delta", index: 0, text: m };
				yield { type: "block-end", index: 0, block: { type: "reasoning", text: m } };
				yield { type: "finish", reason: { kind: "stop" }, replayState: rs };
			})();
			let threw = null;
			let out = [];
			try { out = await collect(listener(richOpts, () => src)); } catch (e) { threw = e.message; }
			check("L368/L372 replayState " + label + " 不崩溃且仍恢复", threw === null && callsOf(out).length === 1, threw ?? JSON.stringify(callsOf(out)));
		}
	}

	// L420：tools 非数组
	{
		const m = wrap28("<function=pwsh><parameter=command>x</parameter></function>");
		const src = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: m };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: m } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		let threw = null;
		let out = [];
		try { out = await collect(listener({ ...OPTIONS, tools: "not-an-array" }, () => src)); } catch (e) { threw = e.message; }
		check("L420 tools 非数组时不崩溃（直通）", threw === null && out.find((c) => c.type === "finish")?.reason?.kind === "stop", threw ?? "");
	}

	// L424：{function:{name}} 形状
	{
		const t2 = [{ function: { name: "pwsh" } }];
		const m = wrap28("<function=pwsh><parameter=command>x</parameter></function>");
		const out = await collect(listener({ ...OPTIONS, tools: t2 }, () => (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: m };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: m } };
			yield { type: "finish", reason: { kind: "stop" } };
		})()));
		check("L424 {function:{name}} 形状被识别", callsOf(out).length === 1, JSON.stringify(callsOf(out)));
	}

	// L427：tools 空数组直通
	{
		const out = await collect(listener({ ...OPTIONS, tools: [] }, () => (async function* () {
			yield { type: "block-start", index: 0, blockType: "text" };
			yield { type: "text-delta", index: 0, text: "hi" };
			yield { type: "block-end", index: 0, block: { type: "text", text: "hi" } };
			yield { type: "finish", reason: { kind: "stop" } };
		})()));
		check("L427 tools 空数组直通", out.find((c) => c.type === "finish")?.reason?.kind === "stop");
	}

	// L428：options 缺 provider/model
	{
		const m = wrap28("<function=pwsh><parameter=command>x</parameter></function>");
		const src = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: m };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: m } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		let threw = null;
		let out = [];
		try { out = await collect(listener({ messages: [], tools: RICH_TOOLS }, () => src)); } catch (e) { threw = e.message; }
		check("L428 缺 provider/model 不崩溃", threw === null && callsOf(out).length === 1, threw ?? "");
	}

	// L503：未知 chunk 类型直通
	{
		const out = await collect(listener(richOpts, () => (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: "x" };
			yield { type: "unknown-chunk-type", index: 0 };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: "x" } };
			yield { type: "finish", reason: { kind: "stop" } };
		})()));
		check("L503 未知 chunk 类型直通", out.some((c) => c.type === "unknown-chunk-type"), JSON.stringify(out.map((c) => c.type)));
	}

	// L533：块未闭合
	{
		const out = await collect(listener(richOpts, () => (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: "未闭合" };
			yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
			yield { type: "finish", reason: { kind: "stop" } };
		})()));
		check("L533 块未闭合不崩溃", out.length > 0, String(out.length));
	}

	// L538：剥离标记后文本为空
	{
		const m = wrap28("<function=pwsh><parameter=command>x</parameter></function>");
		const out = await runRich(m);
		const reasoning = out.filter((c) => c.type === "block-end" && c.block?.type === "reasoning").map((c) => c.block.text).join("");
		check("L538 纯标记文本剥离后为空", reasoning === "", JSON.stringify(reasoning));
	}

	// L600：heldBlocks 为空
	{
		const out = await collect(listener({ ...OPTIONS, tools: [] }, () => (async function* () {
			yield { type: "block-start", index: 0, blockType: "tool-call" };
			yield { type: "tool-call-delta", index: 0, id: "c", name: "pwsh", argumentsDelta: "{}" };
			yield { type: "block-end", index: 0, block: { type: "tool-call", id: "c", name: "pwsh", arguments: "{}" } };
			yield { type: "finish", reason: { kind: "tool-calls" } };
		})()));
		check("L600 无扣留块时直通", out.find((c) => c.type === "finish")?.reason?.kind === "tool-calls");
	}

	plugin.resetStreaks?.();
}

// ================= 用例 29：剩余 18 处分支覆盖 =================
console.log("\n[用例 29] 边界值分支：类型强转失败 / JSON 形态异常 / 行内代码扫描");
{
	const T29 = [{
		name: "pwsh",
		parameters: { type: "object", properties: {
			n: { type: "number" }, b: { type: "boolean" }, i: { type: "integer" },
			o: { type: "object" }, a: { type: "array" }, s: { type: "string" },
		} },
	}];
	const O29 = { ...OPTIONS, tools: T29 };
	const run29 = async (text) => {
		plugin.resetStreaks?.();
		const src = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		const out = [];
		for await (const c of listener(O29, () => src)) out.push(c);
		return out;
	};
	const calls29 = (out) => out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call")
		.map((c) => { try { return { name: c.block.name, args: JSON.parse(c.block.arguments) }; } catch { return { name: c.block.name, args: null }; } });
	const w29 = (inner) => OPEN_CALL + "\n" + inner + "\n" + CLOSE_CALL;

	// coerceValue L121/L124/L125/L131：类型强转的边界值
	{
		// number 但值非数字 → Number() 得到 NaN → 走 ? parsed : raw 的 raw 分支
		{
			const out = await run29(w29("<function=pwsh><parameter=n>不是数字</parameter></function>"));
			const v = calls29(out)[0]?.args?.n;
			check("coerceValue L121 number 非数字时回退原字符串", v === "不是数字", JSON.stringify(v));
		}
		// integer 且值是数字字符串
		{
			const out = await run29(w29("<function=pwsh><parameter=i>7</parameter></function>"));
			check("coerceValue integer 强转", calls29(out)[0]?.args?.i === 7, JSON.stringify(calls29(out)[0]?.args?.i));
		}
		// boolean 但值不是 true/false → 走最后的 return raw
		{
			const out = await run29(w29("<function=pwsh><parameter=b>yes</parameter></function>"));
			check("coerceValue L125 boolean 非 true/false 时回退字符串", calls29(out)[0]?.args?.b === "yes", JSON.stringify(calls29(out)[0]?.args?.b));
		}
		// boolean false
		{
			const out = await run29(w29("<function=pwsh><parameter=b>false</parameter></function>"));
			check("coerceValue L124 boolean false", calls29(out)[0]?.args?.b === false, JSON.stringify(calls29(out)[0]?.args?.b));
		}
		// object 但值不是合法 JSON → catch 分支 return raw
		{
			const out = await run29(w29("<function=pwsh><parameter=o>{broken</parameter></function>"));
			check("coerceValue L131 object 非法 JSON 时回退字符串", calls29(out)[0]?.args?.o === "{broken", JSON.stringify(calls29(out)[0]?.args?.o));
		}
		// array 但值是合法 JSON 数组
		{
			const out = await run29(w29("<function=pwsh><parameter=a>[3]</parameter></function>"));
			check("coerceValue array 强转", JSON.stringify(calls29(out)[0]?.args?.a) === "[3]", JSON.stringify(calls29(out)[0]?.args?.a));
		}
	}

	// parseParams L146：空键 continue（用 parameter name= 形态，键为空）
	{
		const out = await run29(w29('<function name="pwsh"><parameter name="">x</parameter><parameter name="s">ok</parameter></function>'));
		const args = calls29(out)[0]?.args ?? {};
		check("parseParams L146 空键跳过（name 属性形态）", Object.keys(args).length === 1 && args.s === "ok", JSON.stringify(args));
	}

	// parseCallBody L188/L189/L190/L192/L193：纯 JSON 形态的边界
	{
		// L189：JSON 里 name 不是字符串 → return null
		{
			const out = await run29(w29('{"arguments":{"command":"x"}}'));
			check("parseCallBody L189 JSON 无 name 时不恢复", calls29(out).length === 0, JSON.stringify(calls29(out)));
		}
		// L189：name 是未声明工具 → return null
		{
			const out = await run29(w29('{"name":"nope","arguments":{}}'));
			check("parseCallBody L189 未声明工具不恢复", calls29(out).length === 0, JSON.stringify(calls29(out)));
		}
		// L190：JSON 无 arguments 字段 → 走 ?? {}
		{
			const out = await run29(w29('{"name":"pwsh"}'));
			const c = calls29(out)[0];
			// **安全收紧**：缺参数容器的 JSON（如 {"name":"pwsh"}）一律拒绝恢复。
// 理由：正文里的数据对象 `{"name":"xxx"}` 会被误当成调用（真实事故：
// 汇报文本里的 {"command":"rm -rf /"} 曾被当成真调用执行）。
// 无参数工具的合法调用仍可用空容器表达：{"name":"list_agents","arguments":{}}
check("parseCallBody L190 缺参数容器时拒绝恢复（安全收紧）", c === undefined, JSON.stringify(c));
		}
		// L192：arguments 是标量（非对象）→ 走 : { value: args }
		{
			const out = await run29(w29('{"name":"pwsh","arguments":42}'));
			const c = calls29(out)[0];
			check("parseCallBody L192 arguments 为标量时包成 {value}", c !== undefined && c.args?.value === 42, JSON.stringify(c));
		}
		// L193：非法 JSON → catch return null
		{
			const out = await run29(w29('{"name":"pwsh",,}'));
			check("parseCallBody L193 非法 JSON 不恢复", calls29(out).length === 0, JSON.stringify(calls29(out)));
		}
	}

	// hasCodeFence L295：行内代码扫描中的 j = closeEnd; continue
	{
		// 含行内代码 → hasCodeFence=true → 不做恢复；而这段文本几乎无正文，
		// 安全网据此判 EMPTY_RESPONSE（这是**正确**行为：行内代码属展示区）。
		// 这里只断言"不崩溃且流合法"，不假设 finish 种类。
		plugin.resetStreaks?.();
		const out = await run29("三个反引号 `a` 和 ``b`` 混合出现");
		const fin = out.find((c) => c.type === "finish");
		check("hasCodeFence L295 混合行内代码不崩溃且流合法", fin !== undefined && validateStream(out) === null, JSON.stringify(fin?.reason));
		check("hasCodeFence L295 行内代码文本不恢复调用", calls29(out).length === 0, JSON.stringify(calls29(out)));
	}

	// extractCalls L352/L355：无 g 标志的正则（FUNCTION_NAME_ATTR_RE 无 g）
	{
		// 两个裸露的 function name= 元素 → 第二个说明走了 new RegExp 加 g 的分支
		const two = '<function name="pwsh"><parameter name="command">a</parameter></function>\n' +
			'<function name="pwsh"><parameter name="command">b</parameter></function>';
		const out = await run29(two);
		check("extractCalls L352 多个裸露 function 都被识别", calls29(out).length === 2, JSON.stringify(calls29(out).map((c) => c.args?.command)));
	}

	// recovered L475：块未匹配 openByIndex 的 delta 直通
	{
		const out = await collect(listener(O29, () => (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: "x" };
			yield { type: "reasoning-delta", index: 99, text: "孤儿 delta" };  // 无对应 block-start
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: "x" } };
			yield { type: "finish", reason: { kind: "stop" } };
		})()));
		check("recovered L475 孤儿 delta 直通", out.some((c) => c.type === "reasoning-delta" && c.index === 99), JSON.stringify(out.map((c) => c.type + ":" + c.index)));
	}

	// recovered L512：确定性失败放行时回放 usage
	{
		plugin.resetStreaks?.();
		const emptySrc = () => (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: "只有思考" };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
			yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		await collect(listener(O29, emptySrc));   // 第 1 次 -> error
		const second = await collect(listener(O29, emptySrc));  // 第 2 次 -> 放行
		check("recovered L512 放行时回放 usage", second.some((c) => c.type === "usage"), JSON.stringify(second.map((c) => c.type)));
	}

	// recovered L600：heldBlocks 为空时的 "empty" 分支
	{
		plugin.resetStreaks?.();
		const out = await collect(listener({ ...O29, tools: [] }, () => (async function* () {
			yield { type: "finish", reason: { kind: "stop" } };  // 完全空流
		})()));
		check("recovered L600 空流不崩溃", out.length === 1 && out[0].type === "finish", JSON.stringify(out.map((c) => c.type)));
	}

	plugin.resetStreaks?.();
}

// ================= 用例 22：交错块形态（真实适配器的真实形态）=================
console.log("\n[用例 22] 交错块：先发所有 start，再交错 delta，最后逐个 end");
{
	// 实测自真实会话日志的形态：block-start(0) → block-start(1) → delta(0)…
	// → delta(1)… → block-end(0) → block-end(1) → usage → finish
	// 旧实现假设"块连续"，会把块错配成空块，导致有正文的正常回复被判 error
	//（实测曾误伤 254 条真实回复）。
	plugin.resetStreaks?.();
	const longText = "这是一段很长的正常回复内容，包含大量文字。".repeat(60);
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "block-start", index: 1, blockType: "text" };
		for (let i = 0; i < 5; i++) yield { type: "reasoning-delta", index: 0, text: "思考" + i };
		for (let i = 0; i < 30; i++) yield { type: "text-delta", index: 1, text: "正文" + i };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "思考0思考1思考2思考3思考4" } };
		yield { type: "block-end", index: 1, block: { type: "text", text: longText } };
		yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const chunks = await collect(listener(OPTIONS, () => src));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
	const finish = chunks.find((c) => c.type === "finish");
	check("【关键】交错块有正文 -> 保持 stop（不误判 error）", finish?.reason?.kind === "stop", JSON.stringify(finish?.reason));
	const { blocks } = assemble(chunks);
	check("装配出 2 个块", blocks.length === 2, JSON.stringify(blocks.map((b) => b.type)));
	check("text 内容完整保留", blocks.find((b) => b.type === "text")?.text === longText, `len=${blocks.find((b) => b.type === "text")?.text?.length}`);
}

// ================= 用例 23：交错块中的标记仍能正确恢复 =================
console.log("\n[用例 23] 交错块中的标记仍能正确恢复，且顺序正确");
{
	plugin.resetStreaks?.();
	const markup = OPEN_CALL + "\n" + OPEN_FN + "\n" + OPEN_P1 + "\necho interleaved\n" + CLOSE_P1 + "\n" + CLOSE_FN + "\n" + CLOSE_CALL;
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "block-start", index: 1, blockType: "text" };
		yield { type: "reasoning-delta", index: 0, text: "思考" + markup };
		yield { type: "text-delta", index: 1, text: "正文说明" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "思考" + markup } };
		yield { type: "block-end", index: 1, block: { type: "text", text: "正文说明" } };
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const chunks = await collect(listener(OPTIONS, () => src));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
	const { blocks } = assemble(chunks);
	const calls = blocks.filter((b) => b.type === "tool-call");
	check("从交错块的 reasoning 里恢复出 1 个调用", calls.length === 1 && calls[0].name === "pwsh", JSON.stringify(blocks.map((b) => b.type)));
	check("参数正确", calls.length === 1 && JSON.parse(calls[0].arguments).command === "echo interleaved", calls[0]?.arguments);
	const types = blocks.map((b) => b.type);
	check("装配顺序 reasoning -> tool-call -> text", JSON.stringify(types) === JSON.stringify(["reasoning", "tool-call", "text"]), JSON.stringify(types));
}

console.log(`\n===== 结果: ${passed} passed, ${failed} failed =====`);
process.exit(failed === 0 ? 0 : 1);