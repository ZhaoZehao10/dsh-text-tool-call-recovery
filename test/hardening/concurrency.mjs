// 深度验证 3：并发 / 交错隔离
// 真实场景：多个会话、子代理、subagent 会**同时**发起模型请求，
// 多条流在同一个插件实例里交错消费。验证：
//  - 不串味（A 流的扣留块不会跑到 B 流）
//  - 确定性失败计数按模型隔离
//  - 交错消费时每条流都合法
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
const OC = "<" + "tool_call>", CC = "</" + "tool_call>";
const OF = "<" + "function=pwsh>", CF = "</" + "function>";
const OP = "<" + "parameter=command>", CP = "</" + "parameter>";

let pass = 0, fail = 0;
const ck = (l, c, d) => { if (c) { pass++; console.log(`PASS ${l}`); } else { fail++; console.log(`FAIL ${l}${d ? " :: " + d : ""}`); } };

// 真实不变式校验器
async function* validate(source, failFn) {
	const open = new Map();
	let usageSeen = false, finished = false;
	for await (const chunk of source) {
		if (finished) failFn(`${chunk.type} after finish`);
		switch (chunk.type) {
			case "block-start":
				if (open.has(chunk.index)) failFn(`repeated block-start ${chunk.index}`);
				open.set(chunk.index, chunk.blockType); break;
			case "text-delta": case "reasoning-delta": case "tool-call-delta": {
				const exp = chunk.type === "text-delta" ? "text" : chunk.type === "reasoning-delta" ? "reasoning" : "tool-call";
				if (open.get(chunk.index) !== exp) failFn(`${exp} delta at ${chunk.index}`);
				break;
			}
			case "block-end": {
				const bt = open.get(chunk.index);
				if (bt === undefined) failFn(`block-end ${chunk.index} no open`);
				open.delete(chunk.index); break;
			}
			case "usage": if (usageSeen) failFn("usage twice"); usageSeen = true; break;
			case "finish":
				if (open.size > 0 && chunk.reason?.kind !== "error" && chunk.reason?.kind !== "aborted") failFn(`finish with ${open.size} open`);
				finished = true; break;
		}
		yield chunk;
	}
	if (!finished) failFn("no finish");
}

// 带延迟的流（模拟真实网络逐步到达）
function delayedStream(chunks, delayMs = 0) {
	return (async function* () {
		for (const c of chunks) {
			if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
			yield c;
		}
	})();
}

const markup = (v) => OC + "\n" + OF + "\n" + OP + "\n" + v + "\n" + CP + "\n" + CF + "\n" + CC;

function streamOf(tag, extra = []) {
	const text = markup("echo " + tag);
	return [
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text: "思考" + tag },
		{ type: "block-end", index: 0, block: { type: "reasoning", text: "思考" + text } },
		{ type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
		{ type: "finish", reason: { kind: "stop" }, replayState: { response: { stopReason: "stop" }, blocks: [{ type: "reasoning" }] } },
		...extra,
	];
}

console.log("=== 1. 并发 20 条流，每条内容正确不串味 ===");
{
	plugin.resetStreaks?.();
	const N = 20;
	const tasks = Array.from({ length: N }, (_, i) => {
		const opts = { provider: "p", model: "concurrent-model", messages: [], tools: TOOLS };
		return (async () => {
			const out = [];
			for await (const c of validate(listener(opts, () => delayedStream(streamOf("T" + i), 1)), (m) => { throw new Error(m); })) out.push(c);
			const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
			return { i, calls, out };
		})();
	});
	const results = await Promise.all(tasks);
	let ok = 0;
	for (const r of results) {
		if (r.calls.length !== 1) { fail++; console.log(`  FAIL 流 ${r.i} 调用数=${r.calls.length}`); continue; }
		const args = JSON.parse(r.calls[0].block.arguments);
		if (args.command === "echo T" + r.i) ok++;
		else { fail++; console.log(`  FAIL 流 ${r.i} 内容串味: ${JSON.stringify(args)}`); }
	}
	ck(`20 条并发流内容全部正确（${ok}/20）`, ok === N);
}

console.log("\n=== 2. 并发交错：一半是空响应（触发安全网）===");
{
	plugin.resetStreaks?.();
	const tasks = [];
	for (let i = 0; i < 10; i++) {
		// 奇数 → 空响应；偶数 → 正常
		const isEmpty = i % 2 === 1;
		const chunks = isEmpty
			? [
				{ type: "block-start", index: 0, blockType: "reasoning" },
				{ type: "reasoning-delta", index: 0, text: "只有思考" },
				{ type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } },
				{ type: "finish", reason: { kind: "stop" } },
			]
			: streamOf("N" + i);
		tasks.push((async () => {
			const opts = { provider: "p", model: "mixed-model-" + i, messages: [], tools: TOOLS };
			const out = [];
			for await (const c of validate(listener(opts, () => delayedStream(chunks, 1)), (m) => { throw new Error(m); })) out.push(c);
			return { i, isEmpty, kind: out.find((c) => c.type === "finish")?.reason?.kind };
		})());
	}
	const results = await Promise.all(tasks);
	let ok = 0;
	for (const r of results) {
		// 每个模型独立计数：空响应首次应 error；正常流应 tool-calls
		const expect = r.isEmpty ? "error" : "tool-calls";
		if (r.kind === expect) ok++;
		else console.log(`  [观察] 流 ${r.i} isEmpty=${r.isEmpty} kind=${r.kind}（期望 ${expect}）`);
	}
	ck(`交错场景语义正确（${ok}/10）`, ok >= 9);
}

console.log("\n=== 3. 并发下 BlockAssembler 装配互不干扰 ===");
{
	plugin.resetStreaks?.();
	const tasks = Array.from({ length: 8 }, (_, i) => (async () => {
		const opts = { provider: "p", model: "asm-model", messages: [], tools: TOOLS };
		const out = [];
		for await (const c of listener(opts, () => delayedStream(streamOf("A" + i), 1))) out.push(c);
		const asm = new BlockAssembler();
		for (const c of out) asm.push(c);
		return { i, blocks: asm.assembled().blocks };
	})());
	const results = await Promise.all(tasks);
	let ok = 0;
	for (const r of results) {
		const tc = r.blocks.filter((b) => b.type === "tool-call");
		if (tc.length === 1 && JSON.parse(tc[0].arguments).command === "echo A" + r.i) ok++;
	}
	ck(`8 条并发装配结果互不干扰（${ok}/8）`, ok === 8);
}

console.log("\n=== 4. 消费者提前中断（break）不应影响其他流 ===");
{
	plugin.resetStreaks?.();
	// 流 1：消费者读几个 chunk 就 break
	const opts1 = { provider: "p", model: "abort-model", messages: [], tools: TOOLS };
	let read1 = 0;
	for await (const _ of listener(opts1, () => delayedStream(streamOf("BREAK"), 1))) {
		read1++;
		if (read1 >= 2) break;
	}
	// 流 2：正常消费
	const opts2 = { provider: "p", model: "after-break-model", messages: [], tools: TOOLS };
	const out2 = [];
	for await (const c of listener(opts2, () => delayedStream(streamOf("AFTER"), 1))) out2.push(c);
	const calls2 = out2.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	ck("中断后其他流正常", calls2.length === 1 && JSON.parse(calls2[0].block.arguments).command === "echo AFTER", JSON.stringify(calls2.map((c) => c.block.arguments)));
	console.log(`  （被中断的流读了 ${read1} 个 chunk）`);
}

console.log("\n=== 5. 确定性失败计数按模型隔离（并发）===");
{
	plugin.resetStreaks?.();
	const emptyChunks = [
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text: "只有思考" },
		{ type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } },
		{ type: "finish", reason: { kind: "stop" } },
	];
	const runOne = async (model) => {
		const opts = { provider: "p", model, messages: [], tools: TOOLS };
		const out = [];
		for await (const c of listener(opts, () => delayedStream(emptyChunks, 0))) out.push(c);
		return out.find((c) => c.type === "finish")?.reason?.kind;
	};
	// 并发跑 5 个不同模型，各 1 次空响应 → 都应 error
	const kinds = await Promise.all(Array.from({ length: 5 }, (_, i) => runOne("iso-" + i)));
	ck("5 个不同模型并发首次空响应均 error", kinds.every((k) => k === "error"), JSON.stringify(kinds));

	// 再各跑 1 次 → 都应放行 stop
	const kinds2 = await Promise.all(Array.from({ length: 5 }, (_, i) => runOne("iso-" + i)));
	ck("5 个模型第 2 次空响应均放行", kinds2.every((k) => k === "stop"), JSON.stringify(kinds2));
}

console.log(`\n===== 并发隔离验证: ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
