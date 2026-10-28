// 深度验证 2：replayState 回灌
// 关键问题：插件把 finish.replayState 的 blocks 补了 {type:"tool-call"} 并把
// stopReason 改成 toolUse。这个 replay 信封会被存进会话、下一轮请求时回传给
// pi-ai。如果形状不对，下一轮请求可能失败。
// 验证：用真实 dsh-llm 的 BlockAssembler 装配，检查 replay 是否被保留且形状正确。
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

let pass = 0, fail = 0;
const ck = (l, c, d) => { if (c) { pass++; console.log(`PASS ${l}`); } else { fail++; console.log(`FAIL ${l}${d ? " :: " + d : ""}`); } };

async function collect(src) {
	const out = [];
	for await (const c of listener(OPTS, () => src)) out.push(c);
	return out;
}

console.log("=== 1. 恢复调用后 replayState 形状 ===");
{
	plugin.resetStreaks?.();
	const markup = OC + "\n" + OF + "\n" + OP + "\necho hi\n" + CP + "\n" + CF + "\n" + CC;
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: markup };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
		yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
		yield { type: "finish", reason: { kind: "stop" }, replayState: { response: { kind: "pi-ai", version: 2, api: "openai-completions", provider: "p", model: "m", stopReason: "stop" }, blocks: [{ type: "text" }] } };
	})();
	const out = await collect(src);
	const fin = out.find((c) => c.type === "finish");
	ck("replayState 存在", fin?.replayState !== undefined);
	ck("response.stopReason 改为 toolUse", fin?.replayState?.response?.stopReason === "toolUse", JSON.stringify(fin?.replayState?.response));
	ck("blocks 补齐为 2 个", fin?.replayState?.blocks?.length === 2, JSON.stringify(fin?.replayState?.blocks));
	ck("最后一个 block 是 tool-call", fin?.replayState?.blocks?.[1]?.type === "tool-call", JSON.stringify(fin?.replayState?.blocks));

	// 真实 BlockAssembler 必须保留 replay（块数匹配）
	const asm = new BlockAssembler();
	for (const c of out) asm.push(c);
	const asmOut = asm.assembled();
	ck("BlockAssembler 保留 replay（块数匹配）", asmOut.replay !== undefined, "replay 被丢弃");
	ck("replay.blocks 数量与装配块数一致", asmOut.replay?.blocks?.length === asmOut.blocks.length, `${asmOut.replay?.blocks?.length} vs ${asmOut.blocks.length}`);
	ck("response 其它字段未丢失", asmOut.replay?.response?.kind === "pi-ai" && asmOut.replay?.response?.api === "openai-completions", JSON.stringify(asmOut.replay?.response));
}

console.log("\n=== 2. 多调用时 replayState 补齐数量 ===");
{
	plugin.resetStreaks?.();
	const mk = (v) => OC + "\n" + OF + "\n" + OP + "\n" + v + "\n" + CP + "\n" + CF + "\n" + CC;
	const markup = [mk("echo 1"), mk("echo 2"), mk("echo 3")].join("\n");
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: markup };
		yield { type: "block-end", index: 0, block: { type: "text", text: markup } };
		yield { type: "finish", reason: { kind: "stop" }, replayState: { response: { stopReason: "stop" }, blocks: [{ type: "text" }] } };
	})();
	const out = await collect(src);
	const fin = out.find((c) => c.type === "finish");
	const tcCount = out.filter((c) => c.type === "block-start" && c.blockType === "tool-call").length;
	ck("恢复 3 个调用", tcCount === 3, String(tcCount));
	ck("replay.blocks 补齐为 1+3=4", fin?.replayState?.blocks?.length === 4, JSON.stringify(fin?.replayState?.blocks?.map((b) => b.type)));
	const asm = new BlockAssembler();
	for (const c of out) asm.push(c);
	const asmOut = asm.assembled();
	ck("装配后 replay 保留", asmOut.replay !== undefined);
	ck("replay 与装配块数一致", asmOut.replay?.blocks?.length === asmOut.blocks.length, `${asmOut.replay?.blocks?.length} vs ${asmOut.blocks.length}`);
}

console.log("\n=== 3. 无 replayState 时（适配器未提供）不应崩溃 ===");
{
	plugin.resetStreaks?.();
	const markup = OC + "\n" + OF + "\n" + OP + "\necho x\n" + CP + "\n" + CF + "\n" + CC;
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: markup };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
		yield { type: "finish", reason: { kind: "stop" } };  // 无 replayState
	})();
	let threw = null;
	let out = [];
	try { out = await collect(src); } catch (e) { threw = e.message; }
	ck("无 replayState 不崩溃", threw === null, threw);
	const fin = out.find((c) => c.type === "finish");
	ck("finish 仍为 tool-calls", fin?.reason?.kind === "tool-calls", JSON.stringify(fin?.reason));
	ck("replayState 为 undefined（不强造）", fin?.replayState === undefined, JSON.stringify(fin?.replayState));
}

console.log("\n=== 4. replayState.blocks 非数组时（畸形）===");
{
	plugin.resetStreaks?.();
	const markup = OC + "\n" + OF + "\n" + OP + "\necho x\n" + CP + "\n" + CF + "\n" + CC;
	for (const bad of [{ response: {} }, { response: {}, blocks: "not-array" }, { blocks: null }]) {
		const src = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: markup };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
			yield { type: "finish", reason: { kind: "stop" }, replayState: bad };
		})();
		let threw = null;
		let out = [];
		try { out = await collect(src); } catch (e) { threw = e.message; }
		ck(`畸形 replayState ${JSON.stringify(bad).slice(0, 30)} 不崩溃`, threw === null, threw);
		ck(`  仍恢复调用`, out.some((c) => c.type === "block-start" && c.blockType === "tool-call"));
	}
}

console.log("\n=== 5. 安全网 error 时不应保留 replayState ===");
{
	plugin.resetStreaks?.();
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "只有思考" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
		yield { type: "finish", reason: { kind: "stop" }, replayState: { response: { stopReason: "stop" }, blocks: [{ type: "reasoning" }] } };
	})();
	const out = await collect(src);
	const fin = out.find((c) => c.type === "finish");
	ck("安全网输出 error", fin?.reason?.kind === "error");
	ck("error 不带 replayState（该响应会被重试）", fin?.replayState === undefined, JSON.stringify(fin?.replayState));
}

console.log("\n=== 6. 确定性失败放行时保留原 replayState ===");
{
	plugin.resetStreaks?.();
	const makeStream = () => (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "只有思考" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
		yield { type: "finish", reason: { kind: "stop" }, replayState: { response: { stopReason: "stop" }, blocks: [{ type: "reasoning" }] } };
	})();
	await collect(makeStream());          // 第 1 次 -> error
	const second = await collect(makeStream());  // 第 2 次 -> 放行
	const fin = second.find((c) => c.type === "finish");
	ck("第 2 次放行为 stop", fin?.reason?.kind === "stop", JSON.stringify(fin?.reason));
	ck("放行时保留原 replayState", fin?.replayState !== undefined, "replay 丢失");
	ck("放行时 replay.response.stopReason 未改", fin?.replayState?.response?.stopReason === "stop", JSON.stringify(fin?.replayState?.response));
}

console.log(`\n===== replayState 验证: ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
