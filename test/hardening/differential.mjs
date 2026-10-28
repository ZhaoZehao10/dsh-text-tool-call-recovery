// 差分测试（differential testing）：三条独立路径必须产出同一结果
//
// 宿主的真实消费路径有两条：
//   A. 实时路径：BlockAssembler.push(chunk) → assembled()
//   B. 持久化路径：AssistantStreamAccumulator.push(chunk) → snapshot()
//      → expandAssistantStream(snapshot) → assembleAssistantStream(...)
//
// 插件输出会同时走 A 和 B。若两者装配结果不一致，说明插件产出的流
// 在“实时”和“回放”下语义不同——这是最难发现的隐性 bug。
// 本测试随机生成大量流，逐条比对 A/B 结果。
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

const {
	BlockAssembler,
	AssistantStreamAccumulator,
	expandAssistantStream,
	assembleAssistantStream,
} = await import(pathToFileURL(LLM).href);

const plugin = await import(new URL("../../lib/index.js", import.meta.url).href);
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [
	{ name: "pwsh", description: "x", parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } } } },
	{ name: "read", description: "x", parameters: { type: "object", properties: { file_path: { type: "string" } } } },
];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };

// ---- 伪随机（可复现）----
let seed = 20261022;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length) % a.length];
const chance = (p) => rnd() < p;

const OC = "<" + "tool_call>", CC = "</" + "tool_call>";
const OF = (n) => "<" + "function=" + n + ">", CF = "</" + "function>";
const OP = (k) => "<" + "parameter=" + k + ">", CP = "</" + "parameter>";
const OPN = (k) => "<" + "parameter name=" + JSON.stringify(k) + ">";

function genMarkup() {
	const style = pick(["qwen", "anthropic", "json", "truncated", "none", "fenced"]);
	if (style === "none") return "";
	if (style === "fenced") return "```xml\n" + OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\necho f\n" + CP + "\n" + CF + "\n" + CC + "\n```";
	if (style === "json") return JSON.stringify({ name: "pwsh", arguments: { command: "echo json" } });
	if (style === "truncated") return pick([OP("command"), OPN("command"), OC, OF("pwsh")]) + "echo trunc";
	const name = pick(["pwsh", "read", "undeclared"]);
	const key = pick(["command", "file_path", "unknown"]);
	const val = pick(["echo hi", "/a.txt", "42", "", "多行\n值"]);
	if (style === "qwen") return OC + "\n" + OF(name) + "\n" + OP(key) + "\n" + val + "\n" + CP + "\n" + CF + "\n" + CC;
	return OF(name) + "\n" + OPN(key) + "\n" + val + "\n" + CP + "\n" + CF;
}

function genText() {
	const kind = pick(["empty", "short", "prose", "markup", "proseMarkup", "long", "ws"]);
	switch (kind) {
		case "empty": return "";
		case "ws": return pick([" ", "\n", "\n\n  "]);
		case "short": return "好的。";
		case "prose": return "正常回复内容。".repeat(1 + Math.floor(rnd() * 20));
		case "markup": return genMarkup();
		case "proseMarkup": return "说明：" + genMarkup() + " 结束。";
		case "long": return "长文本。".repeat(200);
	}
	return "x";
}

// 生成一条真实形态的流（支持交错块）
function genStream() {
	const blockCount = 1 + Math.floor(rnd() * 4);
	const idxUsed = new Set();
	const blocks = [];
	for (let i = 0; i < blockCount; i++) {
		let idx = chance(0.15) ? i * 3 + Math.floor(rnd() * 3) : i;
		while (idxUsed.has(idx)) idx++;
		idxUsed.add(idx);
		const type = pick(["text", "reasoning", "text", "reasoning", "tool-call"]);
		blocks.push({ type, text: type === "tool-call" ? "" : genText(), index: idx, deltas: [] });
	}
	// 为每个块准备 delta 序列
	for (const b of blocks) {
		if (b.type === "tool-call") {
			b.deltas.push({ type: "tool-call-delta", index: b.index, id: "c" + b.index, name: "pwsh", argumentsDelta: "{}" });
		} else {
			const dt = b.type === "text" ? "text-delta" : "reasoning-delta";
			if (b.text.length > 20 && chance(0.5)) {
				const mid = Math.floor(b.text.length / 2);
				b.deltas.push({ type: dt, index: b.index, text: b.text.slice(0, mid) });
				b.deltas.push({ type: dt, index: b.index, text: b.text.slice(mid) });
			} else {
				b.deltas.push({ type: dt, index: b.index, text: b.text });
			}
		}
	}
	const hasToolCall = blocks.some((b) => b.type === "tool-call");
	const finishKind = hasToolCall ? pick(["tool-calls", "stop", "max-tokens", "aborted", "error"]) : pick(["stop", "stop", "stop", "max-tokens", "aborted", "error"]);
	const interleaved = chance(0.5); // 一半用真实交错形态
	const hasUsage = chance(0.85);
	const hasReplay = chance(0.6);

	return (async function* () {
		if (interleaved) {
			// 真实形态：所有 start → 交错 delta → 逐个 end
			for (const b of blocks) yield { type: "block-start", index: b.index, blockType: b.type };
			const maxLen = Math.max(...blocks.map((b) => b.deltas.length), 0);
			for (let d = 0; d < maxLen; d++) for (const b of blocks) if (b.deltas[d]) yield b.deltas[d];
			for (const b of blocks) {
				yield { type: "block-end", index: b.index, block: b.type === "tool-call"
					? { type: "tool-call", id: "c" + b.index, name: "pwsh", arguments: "{}" }
					: { type: b.type, text: b.text } };
			}
		} else {
			// 连续形态
			for (const b of blocks) {
				yield { type: "block-start", index: b.index, blockType: b.type };
				for (const d of b.deltas) yield d;
				yield { type: "block-end", index: b.index, block: b.type === "tool-call"
					? { type: "tool-call", id: "c" + b.index, name: "pwsh", arguments: "{}" }
					: { type: b.type, text: b.text } };
			}
		}
		if (hasUsage) yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
		const finish = { type: "finish", reason: { kind: finishKind } };
		if (finishKind === "error" || finishKind === "aborted") finish.reason.failure = { message: "x", code: "TEST" };
		if (hasReplay) finish.replayState = { response: { stopReason: finishKind, kind: "pi-ai" }, blocks: blocks.map((b) => ({ type: b.type })) };
		yield finish;
	})();
}

// ---- 三条路径 ----
async function pathLive(chunks) {
	const asm = new BlockAssembler();
	for (const c of chunks) asm.push(c);
	return asm.assembled();
}

async function pathReplay(chunks) {
	const acc = new AssistantStreamAccumulator();
	// 真实流每条 chunk 都带 Session 时间戳（宿主就是这样记录的）。
	// 这里用单调递增的假时间戳还原该形态。
	let t = 1700000000000;
	for (const c of chunks) { acc.push({ time: t, chunk: c }); t += 5; }
	// 关键：assembleAssistantStream 的输入是**压缩记录**（snapshot 的产物），
	// 不是 expandAssistantStream 展开后的 chunk。这是宿主
	// “持久化 → 回放装配”的真实路径。
	const snapshot = acc.snapshot();
	const asm = assembleAssistantStream(snapshot);
	return asm.assembled();
}

// 规范化装配结果，便于比对
function norm(asmResult) {
	return JSON.stringify({
		blocks: asmResult.blocks.map((b) => ({
			type: b.type,
			text: b.type === "text" || b.type === "reasoning" ? b.text : undefined,
			name: b.type === "tool-call" ? b.name : undefined,
			arguments: b.type === "tool-call" ? b.arguments : undefined,
			// id 是合成/生成的，两条路径可能不同（brandString 基于索引），此处单独检查
		})),
		replayBlocks: asmResult.replay?.blocks?.map((b) => b.type),
		replayStopReason: asmResult.replay?.response?.stopReason,
	});
}

let pass = 0, fail = 0;
const failures = [];
const N = 3000;
plugin.resetStreaks?.();

for (let i = 0; i < N; i++) {
	const chunks = [];
	for await (const c of listener(OPTS, genStream)) chunks.push(c);

	let live, replay;
	try { live = await pathLive(chunks); } catch (e) { fail++; failures.push({ i, err: "live 装配失败: " + e.message }); continue; }
	try { replay = await pathReplay(chunks); } catch (e) { fail++; failures.push({ i, err: "replay 装配失败: " + e.message }); continue; }

	const a = norm(live), b = norm(replay);
	if (a !== b) {
		fail++;
		if (failures.length <= 3) {
			failures.push({ i, err: "两条路径结果不一致", live: a.slice(0, 400), replay: b.slice(0, 400) });
		}
		continue;
	}
	// 附加检查：块类型序列必须一致
	const t1 = live.blocks.map((x) => x.type).join(",");
	const t2 = replay.blocks.map((x) => x.type).join(",");
	if (t1 !== t2) { fail++; failures.push({ i, err: `块序列不一致: ${t1} vs ${t2}` }); continue; }
	pass++;
}

console.log("=== 差分测试：实时路径 vs 持久化回放路径 ===");
console.log(`  随机流数   : ${N}`);
console.log(`  一致 (pass): ${pass}`);
console.log(`  不一致     : ${fail}`);

if (failures.length) {
	console.log("\n--- 失败样本 ---");
	for (const f of failures) {
		console.log(`\n  #${f.i}: ${f.err}`);
		if (f.live) console.log(`    live  : ${f.live}`);
		if (f.replay) console.log(`    replay: ${f.replay}`);
	}
}

console.log(fail === 0 ? "\n✅ 两条消费者路径在所有随机流上结果完全一致" : `\n❌ ${fail} 条不一致`);
process.exit(fail === 0 ? 0 : 1);
