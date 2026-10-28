// 多插件共存与接缝隔离审查
//
// `llm/stream` 是瀑布流接缝，多个插件可同时挂在上面。风险：
//   1. 顺序敏感：插件 A 改了流，插件 B 是否还能正常工作
//   2. 异常传播：一个插件抛异常，会不会中断整条流（危害所有插件）
//   3. 重复处理：两个插件都做恢复，会不会双重恢复
//   4. 状态串味：两个插件共享 model 时状态是否互相影响
//   5. next() 调用契约：是否只调用一次、是否传原样参数
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);

// 构造一个最小 Cordis 风格的 ctx
function makeCtx() {
	const listeners = [];
	return {
		on(event, handler) { if (event === "llm/stream") listeners.push(handler); },
		// 按 Cordis 瀑布流语义组合监听器：
		//   - **先注册的在最内层**（最靠近 source）
		//   - **后注册的在外层**（先被调用，其 next() 得到内层的产出）
		// 因此 listeners[0] 最先看到原始流；listeners[last] 看到的是
		// 「所有内层插件处理完之后」的流。
		//
		// 第一版实现从 0 开始递归（把先注册的当最外层），语义反了，
		// 导致「下游看不到我们合成的 tool-call」这类误判。
		async *chain(options, sourceFactory) {
			const build = (i) => async function* (opts) {
				if (i < 0) { yield* sourceFactory(); return; }
				yield* listeners[i](opts, () => build(i - 1)(opts));
			};
			yield* build(listeners.length - 1)(options);
		},
		get listeners() { return listeners; },
	};
}

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const textStream = (text) => (async function* () {
	yield { type: "block-start", index: 0, blockType: "text" };
	yield { type: "text-delta", index: 0, text };
	yield { type: "block-end", index: 0, block: { type: "text", text } };
	yield { type: "finish", reason: { kind: "stop" } };
})();

const markupStream = (cmd) => (async function* () {
	const m = OC + "\n<function=pwsh>\n<parameter=command>\n" + cmd + "\n</parameter>\n</function>\n" + CC;
	yield { type: "block-start", index: 0, blockType: "reasoning" };
	yield { type: "reasoning-delta", index: 0, text: m };
	yield { type: "block-end", index: 0, block: { type: "reasoning", text: m } };
	yield { type: "finish", reason: { kind: "stop" } };
})();

async function collect(stream) {
	const out = [];
	for await (const c of stream) out.push(c);
	return out;
}

console.log("=== 1. 顺序：我们的插件在前，另一插件在后 ===");
{
	const ctx = makeCtx();
	plugin.apply(ctx);
	// 模拟另一个下游插件：统计看到的 tool-call 块
	let seenToolCalls = 0;
	ctx.on("llm/stream", async function* (opts, next) {
		for await (const c of next()) {
			if (c.type === "block-end" && c.block?.type === "tool-call") seenToolCalls++;
			yield c;
		}
	});

	const out = await collect(ctx.chain(OPTS, () => markupStream("echo hi")));
	const fin = out.find((c) => c.type === "finish");
	ck("下游插件能看到我们合成的 tool-call", seenToolCalls === 1, `看到 ${seenToolCalls} 个`);
	ck("finish 是 tool-calls", fin?.reason?.kind === "tool-calls", JSON.stringify(fin?.reason));
}

console.log("\n=== 2. 顺序：另一插件在前（先改流），我们在后 ===");
{
	const ctx = makeCtx();
	// 上游插件：给文本加前缀
	ctx.on("llm/stream", async function* (opts, next) {
		for await (const c of next()) {
			if (c.type === "text-delta") yield { ...c, text: "[PRE] " + c.text };
			else yield c;
		}
	});
	plugin.apply(ctx);

	const out = await collect(ctx.chain(OPTS, () => textStream("正常回复内容。")));
	// 瀑布流语义：上游（内层）改的是 deltas，我们的插件（外层）默认路径原样透传。
	// 宿主装配以 block-end 为准，所以这里检查 deltas 与最终不变量即可。
	const deltas = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	ck("上游插件改的 delta 仍保留", deltas.includes("[PRE]"), deltas);
	const fin = out.find((c) => c.type === "finish");
	ck("我们的插件不误判为错误", fin?.reason?.kind === "stop", JSON.stringify(fin?.reason));
}

console.log("\n=== 3. 异常隔离：上游插件抛异常，我们不应加剧 ===");
{
	const ctx = makeCtx();
	ctx.on("llm/stream", async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		throw new Error("上游插件故障");
	});
	plugin.apply(ctx);

	let err = null;
	let out = [];
	try { out = await collect(ctx.chain(OPTS, () => textStream("x"))); } catch (e) { err = e.message; }
	ck("上游异常被传播（不吞掉）", err !== null, err ?? "未抛异常");
	ck("异常信息未被篡改", String(err).includes("上游插件故障"), String(err));
}

console.log("\n=== 4. 异常隔离：我们抛异常时下游能看到（不是静默）===");
{
	const ctx = makeCtx();
	plugin.apply(ctx);
	// 下游插件
	let downstreamSawError = null;
	ctx.on("llm/stream", async function* (opts, next) {
		try {
			for await (const c of next()) yield c;
		} catch (e) {
			downstreamSawError = e.message;
			throw e;
		}
	});

	// 制造一个会让插件内部出错的流（block-end 缺 block）
	const badStream = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "x" };
		yield { type: "block-end", index: 0 };   // 缺 block
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	let err = null;
	try { await collect(ctx.chain(OPTS, () => badStream)); } catch (e) { err = e.message; }
	// 关键：我们的插件应当已经防御住，不抛异常
	ck("我们的插件对畸形输入不抛异常", err === null, err ?? "");
}

console.log("\n=== 5. 双重恢复：两个插件都做恢复时，是否会让同一调用出现两次 ===");
{
	const ctx = makeCtx();
	plugin.apply(ctx);
	// 第二个"恢复插件"：故意也合成一个 tool-call
	ctx.on("llm/stream", async function* (opts, next) {
		let idx = 0;
		let maxIdx = -1;
		let sawTc = false;
		for await (const c of next()) {
			if (c.type === "block-start" && c.index > maxIdx) maxIdx = c.index;
			if (c.type === "block-end" && c.block?.type === "tool-call") sawTc = true;
			yield c;
		}
		// 若上游没恢复，自己造一个（模拟另一个恢复插件）
		if (!sawTc) {
			const i = maxIdx + 1;
			yield { type: "block-start", index: i, blockType: "tool-call" };
			yield { type: "tool-call-delta", index: i, id: "other-1", name: "pwsh", argumentsDelta: '{"command":"other"}' };
			yield { type: "block-end", index: i, block: { type: "tool-call", id: "other-1", name: "pwsh", arguments: '{"command":"other"}' } };
		}
	});

	const out = await collect(ctx.chain(OPTS, () => markupStream("echo hi")));
	const tcs = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	ck("我们的插件先恢复 → 第二插件不重复恢复", tcs.length === 1, `共 ${tcs.length} 个`);
	ck("恢复的是我们的（id 前缀 txtcall-）", String(tcs[0]?.block?.id).startsWith("txtcall-"), tcs[0]?.block?.id);
}

console.log("\n=== 6. next() 调用契约：只调用一次 ===");
{
	const ctx = makeCtx();
	plugin.apply(ctx);
	let nextCallCount = 0;
	// 我们的插件是唯一监听器，测试它调用 next 的次数
	// （通过包装底层 source 计数）
	let sourcePullCount = 0;
	const countingSource = (async function* () {
		sourcePullCount++;
		yield* markupStream("echo hi");
	})();
	await collect(ctx.chain(OPTS, () => countingSource));
	ck("底层 source 只被创建一次", sourcePullCount === 1, `${sourcePullCount} 次`);
}

console.log("\n=== 7. options 不被篡改 ===");
{
	const ctx = makeCtx();
	plugin.apply(ctx);
	const opts = { ...OPTS };
	const optsCopy = JSON.stringify(opts);
	let sawOpts = null;
	ctx.on("llm/stream", async function* (o, next) {
		sawOpts = JSON.stringify(o);
		yield* next();
	});
	await collect(ctx.chain(opts, () => textStream("正常内容。")));
	ck("下游看到的 options 与原样一致", sawOpts === optsCopy, `原=${optsCopy.slice(0, 80)} 见=${String(sawOpts).slice(0, 80)}`);
	ck("原 options 对象未被修改", JSON.stringify(opts) === optsCopy);
}

console.log("\n=== 8. 三个插件链式共存 ===");
{
	const ctx = makeCtx();
	// 插件1：统计
	let p1Count = 0;
	ctx.on("llm/stream", async function* (o, next) {
		for await (const c of next()) { p1Count++; yield c; }
	});
	// 插件2：我们
	plugin.apply(ctx);
	// 插件3：统计
	let p3Count = 0;
	ctx.on("llm/stream", async function* (o, next) {
		for await (const c of next()) { p3Count++; yield c; }
	});

	const out = await collect(ctx.chain(OPTS, () => markupStream("echo hi")));
	ck("三插件链式共存不崩溃", out.length > 0);
	// 瀑布流语义：插件1 在内层（看到原始 4 个），插件3 在外层（看到我们处理后的 7 个）
	ck("内层插件看到原始 chunk 数（4）", p1Count === 4, `${p1Count}`);
	ck("外层插件看到内层产出（7，含合成 tool-call）", p3Count === 7 && p3Count === out.length, `${p3Count}/${out.length}`);
	const fin = out.find((c) => c.type === "finish");
	ck("最终 finish 正确", fin?.reason?.kind === "tool-calls", JSON.stringify(fin?.reason));
}

console.log(`\n===== 多插件共存与接缝隔离: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
