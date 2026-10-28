// 异常值与退出路径审查
//
// JS 允许 throw 任意值（字符串、null、undefined、数字、对象）。
// 若代码访问 error.message 就会崩。本测试覆盖：
//   1. 上游抛非 Error 值 → 插件必须原样透传（不访问属性）
//   2. 上游抛 null / undefined → 不能崩
//   3. generator 的 return() / throw() 协议
//   4. 消费者在 await 中断开（AbortSignal + 真实 await）
//   5. finally 清理是否执行
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const plugin = await import(pathToFileURL(LIB).href + "?thr=" + Date.now());

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

/** 上游产出给定 chunk 后抛出指定值 */
function streamThatThrows(chunks, thrown) {
	return (async function* () {
		for (const c of chunks) yield c;
		throw thrown;
	})();
}

async function run(gen) {
	plugin.resetStreaks?.();
	const out = [];
	let caught = undefined;
	let threw = false;
	try {
		for await (const c of listener(OPTS, () => gen)) out.push(c);
	} catch (e) {
		threw = true;
		caught = e;
	}
	return { out, threw, caught };
}

console.log("=== 1. 上游抛非 Error 值 → 插件必须原样透传 ===");
{
	const thrownValues = [
		["字符串", "boom"],
		["空字符串", ""],
		["数字", 42],
		["0", 0],
		["NaN", NaN],
		["true", true],
		["false", false],
		["null", null],
		["undefined", undefined],
		["对象（无 message）", { code: "X" }],
		["数组", [1, 2, 3]],
		["Symbol", Symbol("s")],
		["BigInt", 99n],
		["Error 实例", new Error("normal")],
		["TypeError 实例", new TypeError("typed")],
		["带 message 的普通对象", { message: "fake" }],
	];
	for (const [label, val] of thrownValues) {
		const { out, threw, caught } = await run(streamThatThrows([
			{ type: "block-start", index: 0, blockType: "reasoning" },
			{ type: "reasoning-delta", index: 0, text: MARKUP },
		], val));
		// 关键：插件不得因访问错误属性而崩溃（否则会变成别的 Error）。
		// 注意 NaN !== NaN，必须用 Object.is（它把 NaN 视为相等，也不区分 +0/-0）。
		const isOriginal = Object.is(caught, val);
		ck(`抛 ${label} → 异常被透传`, threw, "未抛出");
		ck(`抛 ${label} → 透传的是原值`, isOriginal, `caught=${String(caught)} typeof=${typeof caught}`);
		// 已扣留的块应被交出（断流 flush）
		const blockStarts = out.filter((c) => c.type === "block-start").length;
		ck(`抛 ${label} → 已扣留块被交出`, blockStarts >= 1, `${blockStarts} 个 block-start`);
	}
}

console.log("\n=== 2. 上游在第一个 chunk 之前就抛 ===");
{
	for (const [label, val] of [["字符串", "early"], ["null", null], ["undefined", undefined]]) {
		const { threw, caught } = await run(streamThatThrows([], val));
		ck(`首 chunk 前抛 ${label} → 透传`, threw && caught === val, `caught=${String(caught)}`);
	}
}

console.log("\n=== 3. generator 协议：消费者调用 return() ===");
{
	let finallyRan = false;
	const gen = (async function* () {
		try {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: MARKUP };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: MARKUP } };
			yield { type: "finish", reason: { kind: "stop" } };
		} finally {
			finallyRan = true;
		}
	})();

	const it = listener(OPTS, () => gen);
	const r1 = await it.next();
	ck("首次 next 有值", r1.done === false, JSON.stringify(r1.done));
	const r2 = await it.return(undefined);
	ck("return() 返回 done", r2.done === true, JSON.stringify(r2.done));
	await new Promise((res) => setTimeout(res, 20));
	ck("上游 finally 被执行（无泄漏）", finallyRan, String(finallyRan));
}

console.log("\n=== 4. generator 协议：消费者调用 throw() ===");
{
	let err = null;
	let caught = undefined;
	try {
		const gen = (async function* () {
			yield { type: "block-start", index: 0, blockType: "text" };
			yield { type: "text-delta", index: 0, text: "x" };
			yield { type: "block-end", index: 0, block: { type: "text", text: "x" } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		const it = listener(OPTS, () => gen);
		await it.next();
		// 向插件抛入一个异常
		await it.throw(new Error("consumer abort"));
	} catch (e) {
		err = e;
		caught = e;
	}
	ck("消费者 throw() 传入的异常被传播", err !== null && String(err.message).includes("consumer abort"), err ? err.message : "未抛");
}

console.log("\n=== 5. 消费者 throw() 非 Error 值 ===");
{
	for (const [label, val] of [["字符串", "consumer-str"], ["null", null], ["数字", 7]]) {
		let caught = undefined;
		let threw = false;
		try {
			const gen = (async function* () {
				yield { type: "block-start", index: 0, blockType: "text" };
				yield { type: "text-delta", index: 0, text: "x" };
				yield { type: "finish", reason: { kind: "stop" } };
			})();
			const it = listener(OPTS, () => gen);
			await it.next();
			await it.throw(val);
		} catch (e) {
			threw = true;
			caught = e;
		}
		ck(`消费者 throw(${label}) → 插件不崩且原样抛出`, threw && caught === val, `caught=${String(caught)}`);
	}
}

console.log("\n=== 6. 真实 await 中断（模拟 UI 取消）===");
{
	let aborted = false;
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: MARKUP };
		// 模拟网络延迟
		await new Promise((r) => setTimeout(r, 50));
		aborted = true;
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: MARKUP } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();

	const it = listener(OPTS, () => gen);
	const out = [];
	for await (const c of it) {
		out.push(c);
		if (out.length >= 1) break;   // 模拟用户中断
	}
	await new Promise((r) => setTimeout(r, 80));
	ck("真实 await 中断后不崩溃", out.length >= 1, String(out.length));
	ck("中断后上游继续跑完（未被卡住）", aborted, String(aborted));
}

console.log("\n=== 7. 嵌套 try/finally 中的清理 ===");
{
	// 上游在 finally 里做清理，插件不得阻止
	let cleanups = 0;
	const gen = (async function* () {
		try {
			yield { type: "block-start", index: 0, blockType: "text" };
			yield { type: "text-delta", index: 0, text: "a" };
			yield { type: "text-delta", index: 0, text: "b" };
			yield { type: "block-end", index: 0, block: { type: "text", text: "ab" } };
			yield { type: "finish", reason: { kind: "stop" } };
		} finally {
			cleanups++;
		}
	})();
	for await (const c of listener(OPTS, () => gen)) { /* consume all */ }
	ck("正常消费完 → finally 执行 1 次", cleanups === 1, String(cleanups));
}

console.log("\n=== 8. 上游抛错后再次使用同一 listener ===");
{
	// 抛错一次
	await run(streamThatThrows([{ type: "block-start", index: 0, blockType: "reasoning" }], "fail-once"));
	// 再正常跑
	const { out, threw } = await run((async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: MARKUP };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: MARKUP } };
		yield { type: "finish", reason: { kind: "stop" } };
	})());
	ck("抛错后同一 listener 仍可用", threw === false, "再次抛错");
	const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	ck("抛错后仍能正确恢复", calls.length === 1, String(calls.length));
}

console.log(`\n===== 异常值与退出路径: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细（前 20 条）---");
	for (const f of failures.slice(0, 20)) console.log(`  ❌ ${f}`);
	if (failures.length > 20) console.log(`  ... 另有 ${failures.length - 20} 条`);
}
process.exit(fail === 0 ? 0 : 1);
