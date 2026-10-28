// replayState 深度一致性审查
//
// replayState 是宿主用来「事后回放」的元数据。插件恢复调用后会修改它
// （补上合成的 tool-call 块条目）。若补得不对：
//   - 块数不匹配 → 装配器丢弃整条 replay（降级，但不报错）
//   - 顺序错 → 回放的块顺序与实时不一致
//   - 内容错 → 回放出的调用与实时不同
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
if (!LLM) { console.log("跳过：找不到 dsh-llm"); process.exit(0); }

const { BlockAssembler, AssistantStreamAccumulator, assembleAssistantStream } = await import(pathToFileURL(LLM).href);
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } },
	{ name: "grep", parameters: { type: "object", properties: { pattern: { type: "string" } } } },
];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

async function run(text, extra = {}) {
	plugin.resetStreaks?.();
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
		yield { type: "finish", reason: { kind: "stop" }, ...extra };
	})();
	const out = [];
	for await (const c of listener(OPTS, () => src)) out.push(c);
	return out;
}

const markup = OC + "\n<function=pwsh>\n<parameter=command>\necho hi\n</parameter>\n</function>\n" + CC;

console.log("=== 1. 无 replayState（最常见）===");
{
	const out = await run(markup);
	const fin = out.find((c) => c.type === "finish");
	ck("finish 改为 tool-calls", fin?.reason?.kind === "tool-calls", JSON.stringify(fin?.reason));
	ck("没有凭空塞 replayState", fin.replayState === undefined, JSON.stringify(fin?.replayState));
}

console.log("\n=== 2. 有 replayState，块数对齐 ===");
{
	const out = await run(markup, { replayState: { response: { stopReason: "stop" }, blocks: [{ type: "reasoning" }] } });
	const fin = out.find((c) => c.type === "finish");
	ck("finish 改为 tool-calls", fin?.reason?.kind === "tool-calls");
	ck("replayState.blocks 已补齐（原 1 块 + 1 合成）", Array.isArray(fin.replayState?.blocks) && fin.replayState.blocks.length === 2, JSON.stringify(fin.replayState?.blocks));
	ck("补的块类型是 tool-call", fin.replayState?.blocks?.[1]?.type === "tool-call", JSON.stringify(fin.replayState?.blocks));
	// **值域来源**：从 13,491 条真实日志的 replayState 提取，宿主实际只用三个值：
	//   "toolUse"（9,854 次）、"stop"（291 次）、undefined（3,346 次，另一 provider）
	// 插件写 "toolUse" 与宿主一致，是正确的。
	ck("stopReason 改为宿主认可的 toolUse", fin.replayState?.response?.stopReason === "toolUse", JSON.stringify(fin.replayState?.response));
	ck("stopReason 是宿主真实值域之一", ["toolUse", "stop", undefined].includes(fin.replayState?.response?.stopReason), JSON.stringify(fin.replayState?.response?.stopReason));
}

console.log("\n=== 3. 多调用时块数对齐 ===");
{
	const two = markup + "\n" + OC + "\n<function=grep>\n<parameter=pattern>\nx\n</parameter>\n</function>\n" + CC;
	const out = await run(two, { replayState: { response: { stopReason: "stop" }, blocks: [{ type: "reasoning" }] } });
	const fin = out.find((c) => c.type === "finish");
	ck("恢复 2 个调用", out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").length === 2);
	ck("replayState.blocks 补 2 个（1+2=3）", fin.replayState?.blocks?.length === 3, JSON.stringify(fin.replayState?.blocks));
}

console.log("\n=== 4. 畸形 replayState 的处理 ===");
{
	const cases = [
		["replayState 为 null", null],
		["replayState 为字符串", "not-an-object"],
		["replayState 为数字", 42],
		["缺 blocks", { response: { stopReason: "stop" } }],
		["blocks 非数组", { response: { stopReason: "stop" }, blocks: "x" }],
		["blocks 为空数组", { response: { stopReason: "stop" }, blocks: [] }],
	];
	for (const [label, rs] of cases) {
		let threw = null;
		let out = [];
		try { out = await run(markup, { replayState: rs }); } catch (e) { threw = e.message; }
		const fin = out.find((c) => c.type === "finish");
		ck(`${label} → 不崩溃`, threw === null, threw ?? "");
		ck(`${label} → 仍恢复调用`, out.some((c) => c.type === "block-end" && c.block?.type === "tool-call"), "");
		ck(`${label} → finish=tool-calls`, fin?.reason?.kind === "tool-calls", JSON.stringify(fin?.reason?.kind));
	}
}

console.log("\n=== 5. 实时与回放的块数一致（装配器不丢弃 replay）===");
{
	plugin.resetStreaks?.();
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: markup };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
		yield { type: "finish", reason: { kind: "stop" }, replayState: { response: { stopReason: "stop" }, blocks: [{ type: "reasoning" }] } };
	})();
	const produced = [];
	for await (const c of listener(OPTS, () => src)) produced.push(c);

	const asm = new BlockAssembler();
	for (const c of produced) asm.push(c);
	const live = asm.assembled();

	// 装配器的 replay 是否保留（块数匹配才保留）
	ck("装配结果保留了 replay", live.replay !== undefined, JSON.stringify(live.replay));
	ck("replay.blocks 数量 = 实际块数", live.replay?.blocks?.length === live.blocks.length, `${live.replay?.blocks?.length} vs ${live.blocks.length}`);
	ck("replay 顺序与块顺序一致", JSON.stringify(live.replay?.blocks?.map((b) => b.type)) === JSON.stringify(live.blocks.map((b) => b.type)), JSON.stringify(live.replay?.blocks?.map((b) => b.type)) + " vs " + JSON.stringify(live.blocks.map((b) => b.type)));
}

console.log("\n=== 6. 持久化回放路径与实时一致 ===");
{
	plugin.resetStreaks?.();
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: markup };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
		yield { type: "finish", reason: { kind: "stop" }, replayState: { response: { stopReason: "stop" }, blocks: [{ type: "reasoning" }] } };
	})();
	const produced = [];
	for await (const c of listener(OPTS, () => src)) produced.push(c);

	const liveAsm = new BlockAssembler();
	for (const c of produced) liveAsm.push(c);
	const live = liveAsm.assembled();

	const acc = new AssistantStreamAccumulator();
	let t = 1700000000000;
	for (const c of produced) { acc.push({ time: t, chunk: c }); t += 5; }
	const replay = assembleAssistantStream(acc.snapshot()).assembled();

	const fmt = (r) => JSON.stringify({
		blocks: r.blocks.map((b) => ({ t: b.type, x: b.type === "tool-call" ? b.name + "|" + b.arguments : b.text })),
		replayBlocks: r.replay?.blocks?.map((b) => b.type),
		stopReason: r.replay?.response?.stopReason,
	});
	ck("实时与回放结果完全一致", fmt(live) === fmt(replay), `live=${fmt(live)} replay=${fmt(replay)}`);
}

console.log("\n=== 7. 不该恢复时 replayState 保持原样 ===");
{
	// 正常正文（无需恢复）
	const normal = "这是一段正常回复，没有任何工具调用标记。";
	const orig = { response: { stopReason: "stop" }, blocks: [{ type: "reasoning" }, { type: "text" }] };
	plugin.resetStreaks?.();
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "思考" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "思考" } };
		yield { type: "block-start", index: 1, blockType: "text" };
		yield { type: "text-delta", index: 1, text: normal };
		yield { type: "block-end", index: 1, block: { type: "text", text: normal } };
		yield { type: "finish", reason: { kind: "stop" }, replayState: orig };
	})();
	const out = [];
	for await (const c of listener(OPTS, () => src)) out.push(c);
	const fin = out.find((c) => c.type === "finish");
	ck("正常回复 finish 保持 stop", fin?.reason?.kind === "stop", JSON.stringify(fin?.reason));
	ck("replayState 未被改动", JSON.stringify(fin.replayState) === JSON.stringify(orig), JSON.stringify(fin.replayState));
}

console.log(`\n===== replayState 一致性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
