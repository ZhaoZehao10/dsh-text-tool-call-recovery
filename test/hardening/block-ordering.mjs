// 深度验证 5：块顺序与交错（之前没充分测的薄弱点）
// 核心问题：插件的 heldEnds 在流末尾才放出，如果原始流里 text 块在
// tool-call 块之前，放出顺序会不会导致块关闭顺序错乱？
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
const { BlockAssembler } = await import(pathToFileURL(LLM).href);

const plugin = await import(new URL("../../lib/index.js", import.meta.url).href);
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>", CC = "</" + "tool_call>";
const OF = "<" + "function=pwsh>", CF = "</" + "function>";
const OP = "<" + "parameter=command>", CP = "</" + "parameter>";
const markup = (v) => OC + "\n" + OF + "\n" + OP + "\n" + v + "\n" + CP + "\n" + CF + "\n" + CC;

let pass = 0, fail = 0;
const ck = (l, c, d) => { if (c) { pass++; console.log(`PASS ${l}`); } else { fail++; console.log(`FAIL ${l}${d ? " :: " + d : ""}`); } };
async function collect(src) { const o = []; for await (const c of listener(OPTS, () => src)) o.push(c); return o; }

console.log("=== 1. reasoning 块在前、text 块在后（两块都含标记）===");
{
	plugin.resetStreaks?.();
	const out = await collect((async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "思考" + markup("echo R") };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "思考" + markup("echo R") } };
		yield { type: "block-start", index: 1, blockType: "text" };
		yield { type: "text-delta", index: 1, text: "正文" + markup("echo T") };
		yield { type: "block-end", index: 1, block: { type: "text", text: "正文" + markup("echo T") } };
		yield { type: "finish", reason: { kind: "stop" } };
	})());
	const tcs = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	ck("恢复 2 个调用", tcs.length === 2, String(tcs.length));
	const cmds = tcs.map((c) => JSON.parse(c.block.arguments).command);
	ck("调用顺序：reasoning 里的在前", cmds[0] === "echo R" && cmds[1] === "echo T", JSON.stringify(cmds));
	// 关键：块关闭顺序是否合法（BlockAssembler 必须能正确装配）
	const asm = new BlockAssembler();
	for (const c of out) asm.push(c);
	const { blocks } = asm.assembled();
	ck("装配块数 = 4（reasoning+tool+text+tool）", blocks.length === 4, JSON.stringify(blocks.map((b) => b.type)));
	ck("装配顺序正确", JSON.stringify(blocks.map((b) => b.type)) === JSON.stringify(["reasoning", "tool-call", "text", "tool-call"]), JSON.stringify(blocks.map((b) => b.type)));
	// 顺序细节：所有 chunk 的 block-end 是否在其 block-start 之后
	const seen = new Set();
	let orderOK = true;
	for (const c of out) {
		if (c.type === "block-start") seen.add(c.index);
		if (c.type === "block-end" && !seen.has(c.index)) orderOK = false;
	}
	ck("每个 block-end 都在其 block-start 之后", orderOK);
}

console.log("\n=== 2. text 块先于 reasoning 块（顺序反转）===");
{
	plugin.resetStreaks?.();
	const out = await collect((async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: markup("echo A") };
		yield { type: "block-end", index: 0, block: { type: "text", text: markup("echo A") } };
		yield { type: "block-start", index: 1, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 1, text: markup("echo B") };
		yield { type: "block-end", index: 1, block: { type: "reasoning", text: markup("echo B") } };
		yield { type: "finish", reason: { kind: "stop" } };
	})());
	const cmds = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").map((c) => JSON.parse(c.block.arguments).command);
	ck("顺序保持（A 在前）", cmds[0] === "echo A" && cmds[1] === "echo B", JSON.stringify(cmds));
	const asm = new BlockAssembler();
	for (const c of out) asm.push(c);
	ck("装配 4 块且顺序正确", JSON.stringify(asm.assembled().blocks.map((b) => b.type)) === JSON.stringify(["text", "tool-call", "reasoning", "tool-call"]), JSON.stringify(asm.assembled().blocks.map((b) => b.type)));
}

console.log("\n=== 3. 中间夹着结构化 tool-call 块（混用）===");
{
	plugin.resetStreaks?.();
	// 流：text(含标记) -> 结构化 tool-call -> finish=tool-calls
	// 因为 sawToolCall=true，插件应完全放行（不恢复），文本保留标记
	const out = await collect((async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: markup("echo TEXT") };
		yield { type: "block-end", index: 0, block: { type: "text", text: markup("echo TEXT") } };
		yield { type: "block-start", index: 1, blockType: "tool-call" };
		yield { type: "tool-call-delta", index: 1, id: "native", name: "pwsh", argumentsDelta: '{"command":"echo NATIVE"}' };
		yield { type: "block-end", index: 1, block: { type: "tool-call", id: "native", name: "pwsh", arguments: '{"command":"echo NATIVE"}' } };
		yield { type: "finish", reason: { kind: "tool-calls" } };
	})());
	const tcs = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	ck("只有 1 个 tool-call（结构化那个，文本标记不恢复）", tcs.length === 1, String(tcs.length));
	ck("是原生调用而非恢复", tcs[0]?.block?.id === "native", tcs[0]?.block?.id);
	const textBlock = out.find((c) => c.type === "block-end" && c.block?.type === "text");
	ck("文本块保留原样（含标记）", textBlock?.block?.text?.includes(OC), "标记被剥离了");
	const asm = new BlockAssembler();
	for (const c of out) asm.push(c);
	ck("装配 2 块", asm.assembled().blocks.length === 2);
}

console.log("\n=== 4. 三个块都含标记（压力）===");
{
	plugin.resetStreaks?.();
	const out = await collect((async function* () {
		for (let i = 0; i < 3; i++) {
			const t = (i % 2 === 0) ? "reasoning" : "text";
			yield { type: "block-start", index: i, blockType: t };
			yield { type: (t === "text" ? "text-delta" : "reasoning-delta"), index: i, text: markup("echo " + i) };
			yield { type: "block-end", index: i, block: { type: t, text: markup("echo " + i) } };
		}
		yield { type: "finish", reason: { kind: "stop" } };
	})());
	const cmds = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").map((c) => JSON.parse(c.block.arguments).command);
	ck("恢复 3 个调用", cmds.length === 3, String(cmds.length));
	ck("顺序 0,1,2", JSON.stringify(cmds) === JSON.stringify(["echo 0", "echo 1", "echo 2"]), JSON.stringify(cmds));
	const asm = new BlockAssembler();
	for (const c of out) asm.push(c);
	ck("装配 6 块", asm.assembled().blocks.length === 6, String(asm.assembled().blocks.length));
	// 块索引必须唯一
	const idxs = out.filter((c) => c.type === "block-start").map((c) => c.index);
	ck("索引唯一", new Set(idxs).size === idxs.length, JSON.stringify(idxs));
	// 装配块顺序：每个原块紧跟其恢复的调用
	const types = asm.assembled().blocks.map((b) => b.type);
	ck("装配顺序为 r,tc,t,tc,r,tc", JSON.stringify(types) === JSON.stringify(["reasoning", "tool-call", "text", "tool-call", "reasoning", "tool-call"]), JSON.stringify(types));
}

console.log("\n=== 5. usage 位置：在所有块之后、finish 之前 ===");
{
	plugin.resetStreaks?.();
	const out = await collect((async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: markup("echo U") };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup("echo U") } };
		yield { type: "usage", usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } };
		yield { type: "finish", reason: { kind: "stop" } };
	})());
	const seq = out.map((c) => c.type);
	const usageIdx = seq.indexOf("usage");
	const finIdx = seq.indexOf("finish");
	const lastEndIdx = seq.lastIndexOf("block-end");
	ck("usage 在所有 block-end 之后", usageIdx > lastEndIdx, JSON.stringify(seq));
	ck("usage 在 finish 之前", usageIdx < finIdx, JSON.stringify(seq));
	ck("usage 只出现一次", seq.filter((x) => x === "usage").length === 1);
}

console.log(`\n===== 块顺序/交错验证: ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
