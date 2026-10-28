// 交错块形态回归测试（真实适配器的实际 chunk 形态）
// 运行：node test/hardening/interleaved-blocks.mjs
// 依赖：被测插件 ../lib/index.js；dsh-llm 用 DSH_LLM_SRC 或仓库 node_modules。
import * as plugin from "../../lib/index.js";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const BlockAssembler = await (async () => {
	const candidates = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(process.cwd(), "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
		path.join(process.cwd(), "..", "..", "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js")
	].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(c)) return (await import(pathToFileURL(c).href)).BlockAssembler;
	console.error("找不到 dsh-llm，请设置 DSH_LLM_SRC");
	process.exit(1);
})();

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

let passed = 0, failed = 0;
function check(label, cond, detail) {
	if (cond) { passed++; console.log(`  PASS ${label}`); }
	else { failed++; console.log(`  FAIL ${label}${detail ? " :: " + detail : ""}`); }
}
async function collect(stream) { const o = []; for await (const c of stream) o.push(c); return o; }
function assemble(chunks) { const a = new BlockAssembler(); for (const c of chunks) a.push(c); return a.assembled(); }

// 复刻真实不变式校验规则
function validateStream(chunks) {
	const open = new Map();
	let usageSeen = false, finished = false;
	for (const c of chunks) {
		if (finished) return `chunk ${c.type} after terminal finish`;
		switch (c.type) {
			case "block-start":
				if (!Number.isSafeInteger(c.index) || c.index < 0) return `bad index ${c.index}`;
				if (open.has(c.index)) return `repeated block-start ${c.index}`;
				open.set(c.index, c.blockType); break;
			case "text-delta": case "reasoning-delta": case "tool-call-delta": {
				const exp = c.type === "text-delta" ? "text" : c.type === "reasoning-delta" ? "reasoning" : "tool-call";
				if (open.get(c.index) !== exp) return `${c.type} for wrong block ${c.index}`;
				break;
			}
			case "block-end": {
				const bt = open.get(c.index);
				if (bt === undefined) return `block-end without open block ${c.index}`;
				if (c.block.type !== bt) return `block-end type mismatch ${c.index}`;
				open.delete(c.index); break;
			}
			case "usage":
				if (usageSeen) return "usage more than once";
				usageSeen = true; break;
			case "finish":
				if (open.size > 0 && c.reason?.kind !== "error" && c.reason?.kind !== "aborted") return `finished with ${open.size} open block(s)`;
				finished = true; break;
		}
	}
	if (!finished) return "no terminal finish";
	return null;
}

const TOOLS = [{ name: "pwsh", description: "x", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTIONS = { provider: "step-plan-152", model: "step-5-preview", messages: [], tools: TOOLS };
const OPEN_CALL = "<" + "tool_call>";
const CLOSE_CALL = "</" + "tool_call>";
const OPEN_FN = "<" + "function=pwsh>";
const CLOSE_FN = "</" + "function>";
const OPEN_P1 = "<" + "parameter=command>";
const CLOSE_P1 = "</" + "parameter>";
// ================= 用例 22：交错块形态（真实适配器的真实形态）=================
console.log("\n[用例 22] 交错块：先发所有 start，再交错 delta，最后逐个 end");
{
	// 实测自真实会话日志的形态：
	//   block-start(0,reasoning) → block-start(1,text) → delta(0)… → delta(1)…
	//   → block-end(0) → block-end(1) → usage → finish
	// 旧实现假设“块连续”，会把块错配成空块，导致有正文的正常回复被判 error
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

// ================= 用例 24：三块交错 + 两块含标记 =================
console.log("\n[用例 24] 三块交错，两块含标记，顺序保持");
{
	plugin.resetStreaks?.();
	const mk = (v) => OPEN_CALL + "\n" + OPEN_FN + "\n" + OPEN_P1 + "\n" + v + "\n" + CLOSE_P1 + "\n" + CLOSE_FN + "\n" + CLOSE_CALL;
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "block-start", index: 1, blockType: "text" };
		yield { type: "block-start", index: 2, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "A" + mk("echo A") };
		yield { type: "text-delta", index: 1, text: "中间正文" };
		yield { type: "reasoning-delta", index: 2, text: "C" + mk("echo C") };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "A" + mk("echo A") } };
		yield { type: "block-end", index: 1, block: { type: "text", text: "中间正文" } };
		yield { type: "block-end", index: 2, block: { type: "reasoning", text: "C" + mk("echo C") } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const chunks = await collect(listener(OPTIONS, () => src));
	const err = validateStream(chunks);
	check("流通过不变式校验", err === null, err);
	const { blocks } = assemble(chunks);
	const calls = blocks.filter((b) => b.type === "tool-call").map((b) => JSON.parse(b.arguments).command);
	check("恢复 2 个调用", calls.length === 2, JSON.stringify(calls));
	check("顺序为 A 然后 C", JSON.stringify(calls) === JSON.stringify(["echo A", "echo C"]), JSON.stringify(calls));
	check("正文保留", blocks.some((b) => b.type === "text" && b.text === "中间正文"));
}

console.log(`\n===== 结果: ${passed} passed, ${failed} failed =====`);
process.exit(failed === 0 ? 0 : 1);