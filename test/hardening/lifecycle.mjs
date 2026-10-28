// 插件生命周期审查
//
// 真实 DSH 中插件会经历：加载 → 运行 → （热重载/重启）→ 重新加载。
// 若 apply 有副作用累积、或状态不随卸载清理，长期运行会出问题。
//
// 审查：
//   1. 重复 apply 同一 ctx（多注册监听器？）
//   2. 不同 ctx 各自 apply（隔离）
//   3. 卸载后重载（监听器是否被正确移除）
//   4. 环境变量禁用开关
//   5. apply 幂等性（多次调用不累积状态）
//   6. 模块级状态在重新 import 时的行为
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };

function makeCtx() {
	const listeners = [];
	return {
		on(e, h) { if (e === "llm/stream") listeners.push(h); },
		listeners,
		async *chain(opts, src) {
			const build = (i) => async function* (o) {
				if (i < 0) { yield* src(); return; }
				yield* listeners[i](o, () => build(i - 1)(o));
			};
			yield* build(listeners.length - 1)(opts);
		},
	};
}

const markupStream = () => (async function* () {
	const m = OC + "\n<function=pwsh>\n<parameter=command>\necho hi\n</parameter>\n</function>\n" + CC;
	yield { type: "block-start", index: 0, blockType: "reasoning" };
	yield { type: "reasoning-delta", index: 0, text: m };
	yield { type: "block-end", index: 0, block: { type: "reasoning", text: m } };
	yield { type: "finish", reason: { kind: "stop" } };
})();

async function collect(s) { const o = []; for await (const c of s) o.push(c); return o; }

console.log("=== 1. 同一模块实例多次 apply ===");
{
	const plugin = await import(pathToFileURL(LIB).href + "?t=1");
	const ctx = makeCtx();
	plugin.apply(ctx);
	console.log(`  1 次 apply 后监听器数: ${ctx.listeners.length}`);
	plugin.apply(ctx);
	console.log(`  2 次 apply 后监听器数: ${ctx.listeners.length}`);
	plugin.apply(ctx);
	console.log(`  3 次 apply 后监听器数: ${ctx.listeners.length}`);
	// 只记录，是否算缺陷取决于宿主约定（cordis 通常一个插件只 apply 一次）
	ck("多次 apply 不抛异常", true);
	// 但若重复 apply 导致同一调用被恢复多次，那就是问题
	const out = await collect(ctx.chain(OPTS, markupStream));
	const tcs = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	console.log(`  3 次 apply 后恢复的调用数: ${tcs.length}`);
	ck("多次 apply 不产生重复恢复", tcs.length === 1, `${tcs.length} 个`);
}

console.log("\n=== 2. 不同 ctx 各自 apply（隔离）===");
{
	const plugin = await import(pathToFileURL(LIB).href + "?t=2");
	const ctxA = makeCtx();
	const ctxB = makeCtx();
	plugin.apply(ctxA);
	plugin.apply(ctxB);
	ck("ctxA 有 1 个监听器", ctxA.listeners.length === 1, String(ctxA.listeners.length));
	ck("ctxB 有 1 个监听器", ctxB.listeners.length === 1, String(ctxB.listeners.length));

	// 两个 ctx 各自跑，互不影响
	const outA = await collect(ctxA.chain(OPTS, markupStream));
	const outB = await collect(ctxB.chain(OPTS, markupStream));
	const tcA = outA.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").length;
	const tcB = outB.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").length;
	ck("两个 ctx 各自都恢复 1 个", tcA === 1 && tcB === 1, `${tcA}/${tcB}`);
}

console.log("\n=== 3. 环境变量禁用开关 ===");
{
	const plugin = await import(pathToFileURL(LIB).href + "?t=3");
	const prev = process.env.DSH_TEXT_TOOL_CALL_RECOVERY;
	process.env.DSH_TEXT_TOOL_CALL_RECOVERY = "0";
	const ctx = makeCtx();
	try {
		plugin.apply(ctx);
		ck("禁用时不注册监听器", ctx.listeners.length === 0, String(ctx.listeners.length));
		// 且流原样通过
		const out = await collect(ctx.chain(OPTS, markupStream));
		const fin = out.find((c) => c.type === "finish");
		ck("禁用时 finish 保持 stop（不恢复）", fin?.reason?.kind === "stop", JSON.stringify(fin?.reason));
	} finally {
		if (prev === undefined) delete process.env.DSH_TEXT_TOOL_CALL_RECOVERY;
		else process.env.DSH_TEXT_TOOL_CALL_RECOVERY = prev;
	}

	// 恢复后应能正常工作
	const ctx2 = makeCtx();
	plugin.apply(ctx2);
	ck("取消禁用后重新注册", ctx2.listeners.length === 1, String(ctx2.listeners.length));
}

console.log("\n=== 4. 其他禁用值不应禁用（只有 \"0\" 才算）===");
{
	const plugin = await import(pathToFileURL(LIB).href + "?t=4");
	const prev = process.env.DSH_TEXT_TOOL_CALL_RECOVERY;
	try {
		for (const v of ["1", "true", "false", "", "yes", "off"]) {
			process.env.DSH_TEXT_TOOL_CALL_RECOVERY = v;
			const ctx = makeCtx();
			plugin.apply(ctx);
			ck(`DSH_TEXT_TOOL_CALL_RECOVERY=${JSON.stringify(v)} → 仍启用`, ctx.listeners.length === 1, String(ctx.listeners.length));
		}
	} finally {
		if (prev === undefined) delete process.env.DSH_TEXT_TOOL_CALL_RECOVERY;
		else process.env.DSH_TEXT_TOOL_CALL_RECOVERY = prev;
	}
}

console.log("\n=== 5. 重新 import（模拟热重载）后状态独立 ===");
{
	// 两个独立模块实例，各自的状态表应互不影响
	const p1 = await import(pathToFileURL(LIB).href + "?t=5a");
	const p2 = await import(pathToFileURL(LIB).href + "?t=5b");
	ck("两个模块实例是不同的", p1 !== p2);

	// 让 p1 的 m 模型进入"已空一次"状态
	const ctx1 = makeCtx();
	p1.apply(ctx1);
	const emptyStream = () => (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "只有思考" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	await collect(ctx1.chain({ ...OPTS, model: "m1" }, emptyStream));  // 第一次 → error
	const second1 = await collect(ctx1.chain({ ...OPTS, model: "m1" }, emptyStream));
	console.log(`  实例1 第二次空响应: ${second1.find((c) => c.type === "finish")?.reason?.kind}`);

	// 实例2 的同名模型应仍是"第一次"
	const ctx2 = makeCtx();
	p2.apply(ctx2);
	const first2 = await collect(ctx2.chain({ ...OPTS, model: "m1" }, emptyStream));
	const kind2 = first2.find((c) => c.type === "finish")?.reason?.kind;
	console.log(`  实例2 第一次空响应: ${kind2}`);
	ck("模块实例间状态独立（实例2 仍是首次 → error）", kind2 === "error", kind2);
}

console.log("\n=== 6. apply 返回值与异常 ===");
{
	const plugin = await import(pathToFileURL(LIB).href + "?t=6");
	const ctx = makeCtx();
	let ret = null;
	let err = null;
	try { ret = plugin.apply(ctx); } catch (e) { err = e.message; }
	ck("apply 不抛异常", err === null, err ?? "");
	ck("apply 返回值不重要（undefined 或任意）", true, `返回 ${typeof ret}`);

	// 畸形 ctx（缺 on）
	let err2 = null;
	try { plugin.apply({}); } catch (e) { err2 = e.message; }
	console.log(`  畸形 ctx（无 on）: ${err2 === null ? "不抛异常" : "抛 " + err2}`);
	// 只记录：cordis 保证 ctx 有 on，所以这不重要
}

console.log("\n=== 7. 重复 apply 后的状态是否累积 ===");
{
	const plugin = await import(pathToFileURL(LIB).href + "?t=7");
	plugin.resetStreaks?.();
	const ctx = makeCtx();
	plugin.apply(ctx);
	plugin.apply(ctx);
	plugin.apply(ctx);

	// 3 个监听器串联，同一条空响应流会被处理 3 次
	// 关键：连续空响应计数的语义是否被打乱
	const emptyStream = () => (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "只有思考" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const first = await collect(ctx.chain(OPTS, emptyStream));
	const k1 = first.find((c) => c.type === "finish")?.reason?.kind;
	console.log(`  3 次 apply 后首次空响应: ${k1}`);
	const second = await collect(ctx.chain(OPTS, emptyStream));
	const k2 = second.find((c) => c.type === "finish")?.reason?.kind;
	console.log(`  3 次 apply 后二次空响应: ${k2}`);
	// 记录行为：多次 apply 会让计数加速消耗（3 个实例各记一次）
	ck("多次 apply 不崩溃", true);
}

console.log(`\n===== 插件生命周期: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
