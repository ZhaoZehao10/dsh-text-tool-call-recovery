// 中断与取消审查
//
// 真实场景：用户在 GUI 里按 Esc 中断模型响应、或切换会话、或客户端断连。
// 此时消费者会**提前停止消费**流（break / return / abort）。
//
// 风险：
//   1. 插件内部的 per-stream 状态（heldBlocks / openByIndex）未清理
//   2. 下一次请求复用同一闭包状态 → 串味
//   3. 提前 break 时，async generator 的 return() 是否被正确处理
//   4. AbortSignal 触发时的行为
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

const plugin = await import(pathToFileURL(LIB).href + "?abort=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const MARKUP = OC + "\n<function=pwsh>\n<parameter=command>\necho hi\n</parameter>\n</function>\n" + CC;
const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };

// 一条"慢流"：每次 yield 之间可被中断
const slowMarkupStream = (onFinally) => (async function* () {
	try {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: MARKUP.slice(0, 20) };
		yield { type: "reasoning-delta", index: 0, text: MARKUP.slice(20, 60) };
		yield { type: "reasoning-delta", index: 0, text: MARKUP.slice(60) };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: MARKUP } };
		yield { type: "finish", reason: { kind: "stop" } };
	} finally {
		onFinally?.();
	}
})();

console.log("=== 1. 消费者在第一个 chunk 后 break ===");
{
	let sourceClosed = false;
	const gen = (async function* () {
		const src = slowMarkupStream(() => { sourceClosed = true; });
		for await (const c of src) yield c;
	})();
	const it = listener(OPTS, () => gen);
	const seen = [];
	for await (const c of it) {
		seen.push(c);
		if (seen.length >= 1) break;   // 立即中断
	}
	// 让微任务跑完，观察上游是否被 close
	await new Promise((r) => setTimeout(r, 20));
	console.log(`  收到 ${seen.length} 个 chunk，上游被关闭: ${sourceClosed}`);
	ck("提前 break 不抛异常", true);
	ck("上游被正确关闭（无泄漏）", sourceClosed, String(sourceClosed));
}

console.log("\n=== 2. 消费者在流中途 return（模拟取消）===");
{
	let sourceClosed = false;
	const gen = (async function* () {
		for await (const c of slowMarkupStream(() => { sourceClosed = true; })) yield c;
	})();
	const it = listener(OPTS, () => gen);
	const result = await it.next();
	ck("首次 next 返回值正确", result.done === false && result.value !== undefined, JSON.stringify(result.done));
	await it.return(undefined);   // 模拟取消
	await new Promise((r) => setTimeout(r, 20));
	console.log(`  取消后上游被关闭: ${sourceClosed}`);
	ck("取消时上游被关闭", sourceClosed, String(sourceClosed));
}

console.log("\n=== 3. 中断后立即发起新请求（状态是否串味）===");
{
	// 先中断一条"含标记"的流
	const gen1 = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: MARKUP };
		// 故意不给 block-end 就断
	})();
	const it1 = listener(OPTS, () => gen1);
	for await (const c of it1) { break; }
	await new Promise((r) => setTimeout(r, 10));

	// 再跑一条正常流，结果必须正确
	const normal = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "正常回复内容。" };
		yield { type: "block-end", index: 0, block: { type: "text", text: "正常回复内容。" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = [];
	for await (const c of listener(OPTS, () => normal)) out.push(c);
	const fin = out.find((c) => c.type === "finish");
	ck("中断后新请求正常（finish=stop）", fin?.reason?.kind === "stop", JSON.stringify(fin?.reason));
	const text = out.filter((c) => c.type === "block-end" && c.block?.type === "text").map((c) => c.block.text).join("");
	ck("中断后新请求内容正确", text === "正常回复内容。", JSON.stringify(text));
	ck("中断后不残留旧块", !out.some((c) => c.block?.type === "tool-call"), JSON.stringify(out.map((c) => c.block?.type).filter(Boolean)));
}

console.log("\n=== 4. 含标记的流被中断后，不能影响下一条含标记的流 ===");
{
	// 中断一条含标记但未完成的流
	const gen1 = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "<tool_call>\n<function=pwsh>" };
	})();
	for await (const c of listener(OPTS, () => gen1)) { break; }
	await new Promise((r) => setTimeout(r, 10));

	// 完整的一条
	const gen2 = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: MARKUP };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: MARKUP } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = [];
	for await (const c of listener(OPTS, () => gen2)) out.push(c);
	const tcs = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	ck("中断后仍能正确恢复下一条", tcs.length === 1, String(tcs.length));
	let args = null;
	try { args = JSON.parse(tcs[0]?.block?.arguments ?? "{}"); } catch { /* ignore */ }
	ck("恢复参数未被污染", args?.command === "echo hi", JSON.stringify(args));
}

console.log("\n=== 5. options.signal（AbortSignal）行为 ===");
{
	const ac = new AbortController();
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "部分内容" };
		// 模拟上游感知 signal 后停止
		if (ac.signal.aborted) return;
		yield { type: "block-end", index: 0, block: { type: "text", text: "部分内容" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const it = listener({ ...OPTS, signal: ac.signal }, () => gen);
	const out = [];
	let err = null;
	try {
		for await (const c of it) {
			out.push(c);
			if (out.length === 2) ac.abort();   // 中途取消
		}
	} catch (e) { err = e; }
	console.log(`  AbortSignal 取消后：收到 ${out.length} 个 chunk，异常: ${err?.message ?? "无"}`);
	ck("AbortSignal 取消不产生未处理异常", err === null || String(err.name).includes("Abort"), err?.message ?? "");
}

console.log("\n=== 6. 上游在 yield 中途抛异常（网络断开）===");
{
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: MARKUP };
		throw new Error("ECONNRESET");
	})();
	let err = null;
	const out = [];
	try {
		for await (const c of listener(OPTS, () => gen)) out.push(c);
	} catch (e) { err = e; }
	console.log(`  网络断开：收到 ${out.length} 个 chunk，异常: ${err?.message}`);
	ck("网络断开的异常被透传（不吞掉）", err !== null && String(err.message).includes("ECONNRESET"), err?.message ?? "未抛异常");
	// 关键：不应把网络错误包装成"空响应"
	const fin = out.find((c) => c.type === "finish");
	ck("网络断开不伪造 finish", fin === undefined, JSON.stringify(fin?.reason));
}

console.log("\n=== 7. 连续 100 次中断不累积状态 ===");
{
	for (let i = 0; i < 100; i++) {
		const gen = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: MARKUP };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: MARKUP } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		const it = listener(OPTS, () => gen);
		await it.next();   // 只取第一个
		await it.return(undefined);
	}
	await new Promise((r) => setTimeout(r, 30));

	// 之后跑一条正常流，必须完全正确
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: MARKUP };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: MARKUP } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = [];
	for await (const c of listener(OPTS, () => gen)) out.push(c);
	const tcs = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	ck("100 次中断后仍能正确恢复", tcs.length === 1, String(tcs.length));
	const fin = out.find((c) => c.type === "finish");
	ck("100 次中断后 finish 正确", fin?.reason?.kind === "tool-calls", JSON.stringify(fin?.reason));

	// 检查块索引没有累积错乱
	const starts = out.filter((c) => c.type === "block-start").map((c) => c.index);
	const ends = out.filter((c) => c.type === "block-end").map((c) => c.index);
	ck("100 次中断后索引无错乱", JSON.stringify(starts) === JSON.stringify(ends), `${JSON.stringify(starts)} vs ${JSON.stringify(ends)}`);
}

console.log("\n=== 8. 两个流并发（交错消费）===");
{
	const genA = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: MARKUP };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: MARKUP } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const genB = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "流 B 的正常文本内容。" };
		yield { type: "block-end", index: 0, block: { type: "text", text: "流 B 的正常文本内容。" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();

	const itA = listener(OPTS, () => genA);
	const itB = listener({ ...OPTS, model: "m2" }, () => genB);

	// 交错消费
	const outA = [], outB = [];
	let doneA = false, doneB = false;
	while (!doneA || !doneB) {
		if (!doneA) { const r = await itA.next(); if (r.done) doneA = true; else outA.push(r.value); }
		if (!doneB) { const r = await itB.next(); if (r.done) doneB = true; else outB.push(r.value); }
	}

	const tcA = outA.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	ck("并发流 A 正确恢复", tcA.length === 1, String(tcA.length));
	const finA = outA.find((c) => c.type === "finish");
	ck("并发流 A finish=tool-calls", finA?.reason?.kind === "tool-calls", JSON.stringify(finA?.reason));

	const finB = outB.find((c) => c.type === "finish");
	ck("并发流 B finish=stop（不受 A 影响）", finB?.reason?.kind === "stop", JSON.stringify(finB?.reason));
	ck("并发流 B 无 tool-call", !outB.some((c) => c.block?.type === "tool-call"), "");
}

console.log(`\n===== 中断与取消: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
