/**
 * 上下文重建（公开版）：从 DSH 会话日志精确重建某次请求的上下文。
 *
 * 这是“忠实重放”实验的前置步骤：把会话表面操作（compaction 的 replace 区间、
 * 工具结果修剪）重放出来，转成 OpenAI 线上格式，从而得到一个与真实请求
 * 误差极小的上下文（实测与真实 prompt_tokens 差 0.04%）。
 *
 * 用法：
 *   node rebuild-context.cjs <session.jsonl> <目标seq> [输出前缀]
 *
 * 说明：
 * - <session.jsonl> 由 DSH 会话日志解压得到（日志位于 DSH 的 sessions 目录下，
 *   格式为 session.v4.jsonl.zstd；解压步骤涉及内部路径，不随仓库分发）。
 * - <目标seq> 填目标请求的下一条 assistant/message 事件的 seq。
 * - 输出：<输出前缀>-context.json（消息数组）与 <输出前缀>-tools.json（工具定义）。
 * - 会话日志可能含敏感内容；本脚本只做结构转换，产出文件分享前请人工检查。
 */
const fs = require("node:fs");

const [inputPath, targetArg, outPrefix = "rebuilt"] = process.argv.slice(2);
if (!inputPath || !targetArg) {
	console.error("usage: node rebuild-context.cjs <session.jsonl> <target-seq> [out-prefix]");
	process.exit(1);
}
const TARGET = parseInt(targetArg, 10);
const lines = fs.readFileSync(inputPath, "utf8").split("\n").filter(Boolean);
const events = [];
for (const line of lines) {
	let o;
	try { o = JSON.parse(line); } catch { continue; }
	events.push(o);
}
events.sort((a, b) => a.seq - b.seq);

const MSG_TYPES = new Set(["system/message", "user/message", "assistant/message", "tool/result"]);

// 1) 重放表面操作（replace 替换指定 seq 区间，其余 append）
const surface = [];
for (const o of events) {
	if (o.seq >= TARGET) break;
	if (!MSG_TYPES.has(o.type)) continue;
	const op = o.surfaceOp ?? o.data?.surfaceOp;
	if (op && typeof op === "object" && op.op === "replace") {
		const start = surface.findIndex((s) => s.seq === op.startSeq);
		const end = surface.findIndex((s) => s.seq === op.endSeq);
		if (start >= 0 && end >= start) surface.splice(start, end - start + 1, { seq: o.seq, event: o });
		else surface.push({ seq: o.seq, event: o });
	} else {
		surface.push({ seq: o.seq, event: o });
	}
}

// 2) 转 OpenAI 线上格式
const wire = [];
const toolDefs = [];
for (const { event: o } of surface) {
	// user/message 是扁平结构（data.content）；其余类型在 data.message 下
	const m = o.type === "user/message"
		? { role: "user", content: o.data?.content ?? [] }
		: o.data?.message;
	if (!m) continue;
	if (m.role === "system") {
		const text = (m.content ?? []).map((b) => b.text ?? "").join("\n").trim();
		if (text) wire.push({ role: "system", content: text });
	} else if (m.role === "user") {
		const text = (m.content ?? []).map((b) => b.text ?? "").join("\n").trim();
		if (text) wire.push({ role: "user", content: text });
	} else if (m.role === "assistant") {
		const texts = [];
		const toolCalls = [];
		for (const b of m.content ?? []) {
			if (b.type === "text") texts.push(b.text ?? "");
			else if (b.type === "tool-call") toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: b.arguments ?? "{}" } });
		}
		const msg = { role: "assistant", content: texts.join("\n").trim() };
		if (toolCalls.length > 0) msg.tool_calls = toolCalls;
		if (msg.content || toolCalls.length > 0) wire.push(msg);
	} else if (m.role === "tool") {
		const text = (m.content ?? []).map((b) => b.text ?? "").join("\n");
		wire.push({ role: "tool", tool_call_id: m.toolCallId, content: text });
	}
}

// 3) 工具定义（从目标请求前后的 request/header 事件提取）
for (const o of events) {
	if (o.type !== "request/header") continue;
	const cfg = o.data?.header?.config ?? {};
	if (cfg.provider !== "step-plan-152" && cfg.provider !== "magpie") continue;
	const tools = o.data.header.tools ?? [];
	for (const t of tools) toolDefs.push({ name: t.name, description: t.description, parameters: t.parameters });
	break;
}

const chars = wire.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0)
	+ (m.tool_calls ?? []).reduce((s, t) => s + t.function.arguments.length + t.function.name.length, 0), 0);
console.log(`表面消息数: ${surface.length}`);
console.log(`线上消息数: ${wire.length}`);
console.log(`工具定义: ${toolDefs.length} 个`);
console.log(`内容字符数: ${chars.toLocaleString()}`);

fs.writeFileSync(`${outPrefix}-context.json`, JSON.stringify(wire));
fs.writeFileSync(`${outPrefix}-tools.json`, JSON.stringify(toolDefs));
console.log(`\n已写出 ${outPrefix}-context.json 与 ${outPrefix}-tools.json`);
