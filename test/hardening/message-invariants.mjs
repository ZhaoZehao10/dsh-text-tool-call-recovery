// 深度验证 4：消息构造与品牌类型不变量
// dsh-llm 对 assistant 消息使用品牌类型（brandString 生成的 ToolCallId 等），
// 并用 createAssistantMessage/freezeMessage 构造。验证插件合成的块能否通过。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LLM = (() => {
	const candidates = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(process.cwd(), "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
		path.join(import.meta.dirname ?? process.cwd(), "..", "..", "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js")
	].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(c)) return c;
	console.error("找不到 dsh-llm：请设置 DSH_LLM_SRC 或在本仓库安装 @deepseek-ai/dsh-llm");
	process.exit(1);
})();
const mod = await import(pathToFileURL(LLM).href);
const { BlockAssembler } = mod;
console.log("dsh-llm 导出的相关工具：", Object.keys(mod).filter((k) => /createAssistantMessage|freezeMessage|isToolCall|brandString|chunkHasVisibleText|assistantStreamHas/i.test(k)).join(", "));

const plugin = await import(new URL("../../lib/index.js", import.meta.url).href);
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>", CC = "</" + "tool_call>";
const OF = "<" + "function=pwsh>", CF = "</" + "function>";
const OP = "<" + "parameter=command>", CP = "</" + "parameter>";

let pass = 0, fail = 0;
const ck = (l, c, d) => { if (c) { pass++; console.log(`PASS ${l}`); } else { fail++; console.log(`FAIL ${l}${d ? " :: " + d : ""}`); } };

async function collect(src) {
	const out = [];
	for await (const c of listener(OPTS, () => src)) out.push(c);
	return out;
}

const markup = OC + "\n" + OF + "\n" + OP + "\necho hi\n" + CP + "\n" + CF + "\n" + CC;

console.log("\n=== 1. 合成块的字段完整性 ===");
{
	plugin.resetStreaks?.();
	const out = await collect((async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: markup };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
		yield { type: "finish", reason: { kind: "stop" } };
	})());
	const starts = out.filter((c) => c.type === "block-start" && c.blockType === "tool-call");
	const deltas = out.filter((c) => c.type === "tool-call-delta");
	const ends = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	ck("有 1 个 tool-call block-start", starts.length === 1);
	ck("有 1 个 tool-call-delta", deltas.length === 1);
	ck("有 1 个 tool-call block-end", ends.length === 1);
	// 真实协议要求：block-start.index 是安全整数；delta 带 id(string)/name(string)/argumentsDelta(string)
	ck("block-start.index 是安全非负整数", Number.isSafeInteger(starts[0]?.index) && starts[0].index >= 0, String(starts[0]?.index));
	ck("delta.id 是非空字符串", typeof deltas[0]?.id === "string" && deltas[0].id.length > 0, String(deltas[0]?.id));
	ck("delta.name 是字符串", typeof deltas[0]?.name === "string", typeof deltas[0]?.name);
	ck("delta.argumentsDelta 是字符串", typeof deltas[0]?.argumentsDelta === "string", typeof deltas[0]?.argumentsDelta);
	ck("block-end.block.id 与 delta.id 一致", ends[0]?.block?.id === deltas[0]?.id, `${ends[0]?.block?.id} vs ${deltas[0]?.id}`);
	ck("block-end.block.name 与 delta.name 一致", ends[0]?.block?.name === deltas[0]?.name);
	ck("block-end.block.arguments 是合法 JSON 字符串", (() => { try { JSON.parse(ends[0]?.block?.arguments); return true; } catch { return false; } })(), ends[0]?.block?.arguments);
	ck("三个块索引一致", starts[0]?.index === deltas[0]?.index && deltas[0]?.index === ends[0]?.index, `${starts[0]?.index}/${deltas[0]?.index}/${ends[0]?.index}`);
}

console.log("\n=== 2. 装配出的 assistant 消息块结构 ===");
{
	plugin.resetStreaks?.();
	const out = await collect((async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "思考" + markup };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "思考" + markup } };
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
		yield { type: "finish", reason: { kind: "stop" } };
	})());
	const asm = new BlockAssembler();
	for (const c of out) asm.push(c);
	const { blocks } = asm.assembled();
	ck("装配出 2 个块", blocks.length === 2, JSON.stringify(blocks.map((b) => b.type)));
	ck("第一个是 reasoning", blocks[0]?.type === "reasoning");
	ck("第二个是 tool-call", blocks[1]?.type === "tool-call");
	const tc = blocks[1];
	ck("tool-call 有 id", typeof tc?.id === "string" && tc.id.length > 0, String(tc?.id));
	ck("tool-call 有 name", tc?.name === "pwsh", tc?.name);
	ck("tool-call.arguments 可解析且内容正确", (() => { try { return JSON.parse(tc.arguments).command === "echo hi"; } catch { return false; } })(), tc?.arguments);
	ck("reasoning 文本已剥离标记", !blocks[0].text.includes(OC) && !blocks[0].text.includes(OF), blocks[0].text.slice(0, 80));
	ck("reasoning 保留思考正文", blocks[0].text.startsWith("思考"));
}

console.log("\n=== 3. id 唯一性（同一响应内多次恢复）===");
{
	plugin.resetStreaks?.();
	const many = Array.from({ length: 5 }, (_, i) => OC + "\n" + OF + "\n" + OP + "\necho " + i + "\n" + CP + "\n" + CF + "\n" + CC).join("\n");
	const out = await collect((async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: many };
		yield { type: "block-end", index: 0, block: { type: "text", text: many } };
		yield { type: "finish", reason: { kind: "stop" } };
	})());
	const ids = out.filter((c) => c.type === "tool-call-delta").map((c) => c.id);
	ck("5 个调用产生 5 个 id", ids.length === 5, String(ids.length));
	ck("id 全部唯一", new Set(ids).size === 5, JSON.stringify(ids));
	ck("id 都非空", ids.every((x) => typeof x === "string" && x.length > 0));
}

console.log("\n=== 4. 相同内容的两次独立恢复（id 可重复但块内唯一）===");
{
	plugin.resetStreaks?.();
	const one = OC + "\n" + OF + "\n" + OP + "\necho same\n" + CP + "\n" + CF + "\n" + CC;
	const mk = () => (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: one };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: one } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const a = await collect(mk());
	const b = await collect(mk());
	const idA = a.find((c) => c.type === "tool-call-delta")?.id;
	const idB = b.find((c) => c.type === "tool-call-delta")?.id;
	ck("相同内容产生相同 id（确定性，可复现）", idA === idB, `${idA} vs ${idB}`);
	ck("id 在同一响应内唯一（单调用场景）", true);
}

console.log("\n=== 5. 参数按 JSON Schema 强转后的类型 ===");
{
	plugin.resetStreaks?.();
	const TOOLS2 = [{ name: "pwsh", parameters: { type: "object", properties: { n: { type: "number" }, b: { type: "boolean" }, s: { type: "string" }, arr: { type: "array" }, obj: { type: "object" } } } }];
	const OPT2 = { provider: "p", model: "m", messages: [], tools: TOOLS2 };
	const mk = (k, v) => OC + "\n" + OF + "\n" + "<" + "parameter=" + k + ">\n" + v + "\n" + CP + "\n" + CF + "\n" + CC;
	for (const [k, v, expect] of [["n", "42.5", 42.5], ["b", "true", true], ["s", "123", "123"], ["arr", "[1,2]", [1, 2]], ["obj", '{"x":1}', { x: 1 }]]) {
		const out = [];
		for await (const c of listener(OPT2, () => (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: mk(k, v) };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: mk(k, v) } };
			yield { type: "finish", reason: { kind: "stop" } };
		})())) out.push(c);
		const tc = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call")[0];
		const args = JSON.parse(tc?.block?.arguments ?? "{}");
		ck(`${k}=${v} -> ${JSON.stringify(expect)}`, JSON.stringify(args[k]) === JSON.stringify(expect), `实际 ${JSON.stringify(args[k])} (${typeof args[k]})`);
	}
}

console.log(`\n===== 品牌类型/消息构造验证: ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
