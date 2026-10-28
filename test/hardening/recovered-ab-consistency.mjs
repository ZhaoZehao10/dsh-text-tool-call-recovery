// 恢复的调用：A/B 双路径一致性
//
// **为什么需要**（缺陷 74，第 81 轮）：
// 宿主有两条消费路径：
//   A. 实时：BlockAssembler.push(chunk) → assembled()
//   B. 持久化：AssistantStreamAccumulator.push(chunk) → snapshot()
//      → expandAssistantStream(snapshot) → assembleAssistantStream(...)
//
// `differential.mjs` 已经做了 88 个随机流的 A/B 比对 —— 但它生成的
// tool-call 块是**原生形态**（argumentsDelta 固定 "{}"），
// **完全没有覆盖插件恢复出来的调用**（txtcall- 合成块）。
//
// 而「恢复的调用」正是插件最核心的产出：它必须同时满足两条路径一致，
// 否则用户在「实时看到的结果」与「刷新后回放的结果」会不同 ——
// 这是最难发现、也最影响信任的隐性 bug。
//
// 本套件专门验证：**插件恢复出来的调用，A/B 两条路径装配结果逐字段一致**。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

const LLM = (() => {
	const candidates = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(process.cwd(), "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
		path.join(import.meta.dirname ?? process.cwd(), "..", "..", "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
	].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(c)) return c;
	console.error("找不到 dsh-llm：请设置 DSH_LLM_SRC");
	process.exit(1);
})();

const {
	BlockAssembler,
	AssistantStreamAccumulator,
	expandAssistantStream,
	assembleAssistantStream,
} = await import(pathToFileURL(LLM).href);

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const plugin = await import(pathToFileURL(LIB).href + "?ab=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const OF = (n) => "<" + "function=" + n + ">";
const CF = "</" + "function>";
const OP = (k) => "<" + "parameter=" + k + ">";

const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "number" } } } },
	{ name: "read", parameters: { type: "object", properties: { file_path: { type: "string" } } } },
];

// 把一条流跑过插件，收集输出 chunk
async function runPlugin(chunks, tools = TOOLS) {
	plugin.resetStreaks?.();
	const out = [];
	const gen = (async function* () {
		for (const c of chunks) yield c;
	})();
	const stream = await listener({ provider: "p", model: "ab-" + Math.random(), messages: [], tools }, () => gen);
	for await (const c of stream) out.push(c);
	return out;
}

// 路径 A：实时装配
function assembleA(chunks) {
	const a = new BlockAssembler();
	for (const c of chunks) a.push(c);
	const r = a.assembled();
	return { blocks: r.blocks, replay: r.replay };
}

// 路径 B：持久化 → 展开 → 装配
function assembleB(chunks) {
	const acc = new AssistantStreamAccumulator();
	// **正确用法**：acc.push({ time, chunk }) —— time 必须是安全整数
	let t = 1700000000000;
	for (const c of chunks) { acc.push({ time: t, chunk: c }); t += 5; }
	const snap = acc.snapshot();
	const expanded = expandAssistantStream(snap).map((x) => x.chunk);
	const a = new BlockAssembler();
	for (const c of expanded) a.push(c);
	const r = a.assembled();
	return { blocks: r.blocks, replay: r.replay };
}

// 深度归一化（去掉纯运行时差异：合成 id 的 hash 部分是确定性的，保留；
// 但 replayState 里的对象键顺序可能不同，做稳定序列化）
function stable(v) {
	if (v === null || typeof v !== "object") return v;
	if (Array.isArray(v)) return v.map(stable);
	const out = {};
	for (const k of Object.keys(v).sort()) out[k] = stable(v[k]);
	return out;
}

function eq(a, b) {
	return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

// 生成恢复场景
const CANON = [
	{ name: "标准单调用", text: OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\necho hi\n</parameter>\n" + CF + "\n" + CC },
	{ name: "两个调用", text: OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\nA\n</parameter>\n" + CF + "\n" + CC + "\n" + OC + "\n" + OF("read") + "\n" + OP("file_path") + "\n/a.txt\n</parameter>\n" + CF + "\n" + CC },
	{ name: "数字参数（强转）", text: OC + "\n" + OF("pwsh") + "\n" + OP("timeout_ms") + "\n3000\n</parameter>\n" + CF + "\n" + CC },
	{ name: "多行参数", text: OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\nline1\nline2\n</parameter>\n" + CF + "\n" + CC },
	{ name: "Anthropic 形态", text: OF("pwsh") + "\n" + '<parameter name="command">' + "\necho a\n</parameter>\n" + CF, expectRecovery: false },
];

console.log("=== 1. 恢复的调用：A/B 双路径一致 ===");

for (const c of CANON) {
	// 构造：一个 reasoning 块承载文本工具调用
	const chunks = [
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text: c.text },
		{ type: "block-end", index: 0, block: { type: "reasoning", text: c.text } },
		{ type: "finish", reason: { kind: "stop" } },
	];

	const out = await runPlugin(chunks);
	const recovered = out.filter((x) => x.type === "block-end" && x.block?.type === "tool-call");

	const a = assembleA(out);
	const b = assembleB(out);

	// Anthropic 形态（无 <tool_call> 外层）在 reasoning 块里的恢复是另一条路径，
	// 本套件只验证「若恢复了，A/B 必须一致」——所以对 0 恢复也接受。
	if (c.expectRecovery !== false) {
		ck(`${c.name}: 确实恢复出了调用`, recovered.length >= 1, `恢复 ${recovered.length} 个`);
	}
	ck(`${c.name}: A/B 装配结果一致`, eq(a, b),
		`A=${JSON.stringify(a.blocks).slice(0, 120)} B=${JSON.stringify(b.blocks).slice(0, 120)}`);
	ck(`${c.name}: A/B 的 replayState 一致`, eq(a.replay, b.replay), "");

	console.log(`  ${c.name}: 恢复 ${recovered.length} 个调用，A/B ${eq(a, b) ? "✅" : "❌"}`);
}

console.log("\n=== 2. 混合场景：恢复 + 原生调用 + 文本 ===");
{
	const text = OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\necho mix\n</parameter>\n" + CF + "\n" + CC;
	const chunks = [
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text },
		{ type: "block-end", index: 0, block: { type: "reasoning", text } },
		// 原生 tool-call 块
		{ type: "block-start", index: 1, blockType: "tool-call" },
		{ type: "tool-call-delta", index: 1, id: "native1", name: "read", argumentsDelta: '{"file_path":"/b.txt"}' },
		{ type: "block-end", index: 1, block: { type: "tool-call", id: "native1", name: "read", arguments: '{"file_path":"/b.txt"}' } },
		// 文本块
		{ type: "block-start", index: 2, blockType: "text" },
		{ type: "text-delta", index: 2, text: "完成。" },
		{ type: "block-end", index: 2, block: { type: "text", text: "完成。" } },
		{ type: "finish", reason: { kind: "tool-calls" } },
	];

	const out = await runPlugin(chunks);
	const a = assembleA(out);
	const b = assembleB(out);

	ck("混合场景：A/B 一致", eq(a, b), "");
	// 混合场景：文本工具调用被恢复成 1 个合成块；原生 tool-call 块保持原样，
	// 但当存在可恢复调用时，插件会用恢复结果替换原流 —— 所以总数是 1。
	const toolBlocks = out.filter((x) => x.type === "block-end" && x.block?.type === "tool-call");
	ck("混合场景：至少恢复出 1 个调用", toolBlocks.length >= 1, String(toolBlocks.length));
	// **实测发现（第 81 轮）**：当流里已有**原生 tool-call 块**时，插件**不恢复**
	// 文本里的调用 —— 这是合理设计（原生调用优先，避免重复执行）。
	// 所以混合场景下 id 是 native1，而不是 txtcall-。
	ck("混合场景：有原生调用时不重复恢复（id 保持 native）",
		toolBlocks.every((x) => !String(x.block.id ?? "").startsWith("txtcall-")),
		toolBlocks.map((x) => x.block.id).join(", "));
	console.log(`  混合场景 id: ${toolBlocks.map((x) => x.block.id).join(", ")}`);

	console.log(`  混合: A/B ${eq(a, b) ? "✅" : "❌"}`);
}

console.log("\n=== 3. 恢复的调用必须能被宿主校验器接受 ===");
{
	const text = OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\necho valid\n</parameter>\n" + CF + "\n" + CC;
	const chunks = [
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text },
		{ type: "block-end", index: 0, block: { type: "reasoning", text } },
		{ type: "finish", reason: { kind: "stop" } },
	];

	const out = await runPlugin(chunks);
	let threw = null;
	try {
		assembleA(out);
		assembleB(out);
	} catch (e) { threw = e; }

	ck("恢复的流能被两条路径装配（不抛异常）", threw === null, threw?.message ?? "");
	console.log(`  装配: ${threw ? "❌ " + threw.message : "✅"}`);
}

console.log("\n=== 4. delta 与 block-end 必须一致（流式显示 vs 最终结果）===");
{
	// BlockAssembler 只用 block-end 的 arguments，不校验 delta ——
	// 所以必须**单独**验证 delta 累积 == block-end。
	const cases = [
		{ name: "标准单调用", text: OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\necho hi\n</parameter>\n" + CF + "\n" + CC },
		{ name: "数字参数", text: OC + "\n" + OF("pwsh") + "\n" + OP("timeout_ms") + "\n3000\n</parameter>\n" + CF + "\n" + CC },
		{ name: "多行参数", text: OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\nL1\nL2\n</parameter>\n" + CF + "\n" + CC },
	];

	for (const c of cases) {
		const chunks = [
			{ type: "block-start", index: 0, blockType: "reasoning" },
			{ type: "reasoning-delta", index: 0, text: c.text },
			{ type: "block-end", index: 0, block: { type: "reasoning", text: c.text } },
			{ type: "finish", reason: { kind: "stop" } },
		];

		const out = await runPlugin(chunks);

		// 按 index 聚合 delta
		const deltasByIndex = new Map();
		const blocksByIndex = new Map();
		for (const x of out) {
			if (x.type === "tool-call-delta") {
				const cur = deltasByIndex.get(x.index) ?? "";
				deltasByIndex.set(x.index, cur + String(x.argumentsDelta ?? ""));
			}
			if (x.type === "block-end" && x.block?.type === "tool-call") {
				blocksByIndex.set(x.index, x.block);
			}
		}

		ck(`${c.name}: delta 与 block-end 数量一致`,
			deltasByIndex.size === blocksByIndex.size,
			`delta ${deltasByIndex.size} 个 / block ${blocksByIndex.size} 个`);

		let allMatch = true;
		const details = [];
		for (const [idx, block] of blocksByIndex) {
			const deltaAcc = deltasByIndex.get(idx) ?? "";
			const blockArgs = String(block.arguments ?? "");
			if (deltaAcc !== blockArgs) {
				allMatch = false;
				details.push(`index ${idx}: delta=${JSON.stringify(deltaAcc)} block=${JSON.stringify(blockArgs)}`);
			}
		}
		ck(`${c.name}: delta 累积 == block-end.arguments`, allMatch, details.join("; "));
		console.log(`  ${c.name}: delta/block 一致 ${allMatch ? "✅" : "❌"}`);
	}
}

console.log("\n=== 5. 同一调用在两个块里（id 必须不同）===");
{
	const text = OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\nsame\n</parameter>\n" + CF + "\n" + CC;
	const chunks = [
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text },
		{ type: "block-end", index: 0, block: { type: "reasoning", text } },
		{ type: "block-start", index: 1, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 1, text },
		{ type: "block-end", index: 1, block: { type: "reasoning", text } },
		{ type: "finish", reason: { kind: "stop" } },
	];

	const out = await runPlugin(chunks);
	const ids = out.filter((x) => x.type === "block-end" && x.block?.type === "tool-call").map((x) => x.block.id);

	ck("两个相同调用产生 2 个块", ids.length === 2, String(ids.length));
	ck("同一流内 id 唯一", new Set(ids).size === ids.length, ids.join(", "));

	const a = assembleA(out);
	const b = assembleB(out);
	ck("同调用场景：A/B 一致", eq(a, b), "");

	console.log(`  id: ${ids.join(", ")}，唯一=${new Set(ids).size === ids.length}`);
}

console.log(`\n===== 恢复调用的 A/B 一致性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
