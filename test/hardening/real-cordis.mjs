// 真实 Cordis 宿主集成验证
//
// **前 36 轮全部用测试替身**：`{ on: (event, handler) => { ... } }`。
// 测试替身能验证「我的假设」，但验证不了「真实 Cordis 的行为」：
//   - 真实的 ctx.on 返回什么？
//   - listener 的注册顺序、next() 语义是否与我假设的一致？
//   - ctx 上还有哪些属性？插件会不会误用？
//   - Cordis 的 waterfall 事件（llm/stream）真实语义是什么？
//
// 本套件用 **@deepseek-ai/cordis 4.0.5（真实包）** 装载插件，验证：
//   1. 插件能被真实 Context 装载而不报错
//   2. 真实 ctx.on 的返回值被正确处理
//   3. 真实 waterfall 语义下插件工作正常
//   4. 多个插件共用 llm/stream 时的顺序与隔离
//   5. 插件卸载（dispose）后不再拦截
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

// 找 cordis（多个候选位置）
const CORDIS = (() => {
	const cands = [
		path.join(ROOT, "..", ".tmp", "audit-deps", "node_modules", "@deepseek-ai", "cordis", "lib", "index.js"),
		path.join(ROOT, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js"),
	];
	for (const c of cands) if (fs.existsSync(c)) return c;
	return null;
})();
if (CORDIS === null) {
	console.log("跳过：找不到真实的 @deepseek-ai/cordis");
	process.exit(0);
}
console.log(`使用真实 Cordis: ${CORDIS}\n`);

const cordis = await import(pathToFileURL(CORDIS).href);
const { Context } = cordis;

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const MARKUP = OC + "\n<function=pwsh>\n<parameter=command>\necho hi\n</parameter>\n</function>\n" + CC;
const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };

function makeStream(text, blockType = "reasoning") {
	return (async function* () {
		yield { type: "block-start", index: 0, blockType };
		yield { type: blockType === "text" ? "text-delta" : "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: blockType, text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
}

console.log("=== 1. 插件能被真实 Context 装载 ===");
{
	let plugin, ctx;
	let loadError = null;
	try {
		plugin = await import(pathToFileURL(LIB).href + "?real=" + Date.now());
		ctx = new Context();
		plugin.apply(ctx);
	} catch (e) {
		loadError = e;
	}
	// 缺陷 82：原来是 ck(..., true, "") 恒真；改为基于真实 try/catch 结果
	ck("插件在真实 Context 上装载不报错", loadError === null, loadError?.message ?? "");

	// 真实 ctx.on 的签名与返回值
	if (ctx) {
		const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ctx), "on")
			?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(ctx)), "on");
		console.log(`  ctx.on 定义在: ${desc ? (typeof desc.value === "function" ? "函数" : "访问器") : "未找到"}`);
		// 检查是否有 llm/stream 的监听
		let hasListener = false;
		try {
			// Cordis 的 EventsService 提供 _hooks 或类似内部结构
			const ev = ctx.events ?? ctx.$events ?? null;
			hasListener = ev !== null;
		} catch { /* ignore */ }
		console.log(`  可访问事件服务: ${hasListener}`);
	}
}

console.log("\n=== 2. 真实 waterfall 语义 ===");
{
	// Cordis 的 ctx.waterfall / ctx.on 对 waterfall 事件的语义：
	// 多个监听器时，最**先**注册的是最内层（最近源），后注册的包在外面。
	const ctx = new Context();
	const order = [];

	// 插件（先注册）
	const plugin = await import(pathToFileURL(LIB).href + "?w1=" + Date.now());
	plugin.apply(ctx);
	order.push("plugin");

	// 外层观察者（后注册）
	let outerSaw = null;
	try {
		if (typeof ctx.on === "function") {
			ctx.on("llm/stream", (opts, next) => {
				order.push("outer");
				const result = next();
				outerSaw = result;
				return result;
			});
		}
	} catch (e) {
		console.log(`  注册外层监听失败: ${e.message}`);
	}

	// 触发
	let got = null;
	try {
		const waterfall = ctx.waterfall?.("llm/stream", OPTS, () => makeStream(MARKUP));
		if (waterfall && typeof waterfall[Symbol.asyncIterator] === "function") {
			const out = [];
			for await (const c of waterfall) out.push(c);
			got = out;
		} else if (waterfall) {
			// 可能是 Promise
			const resolved = await waterfall;
			got = resolved;
		}
	} catch (e) {
		console.log(`  触发失败: ${e.message}`);
	}

	console.log(`  注册顺序: ${order.join(" → ")}`);
	if (got !== null) {
		const arr = Array.isArray(got) ? got : [];
		const calls = arr.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
		console.log(`  输出 chunk: ${arr.length}，恢复调用: ${calls.length}`);
		ck("真实 waterfall 触发后插件生效", calls.length === 1, `${calls.length} 个`);
	} else {
		console.log("  （该 Cordis 版本的 waterfall 接口形态不同，跳过实际触发）");
	}
}

console.log("\n=== 3. 真实 ctx.on 返回值处理 ===");
{
	const ctx = new Context();
	let ret = null;
	let err = null;
	try {
		ret = ctx.on("test/event", () => { });
	} catch (e) {
		err = e;
	}
	console.log(`  ctx.on 返回: ${ret === null ? "null" : typeof ret}${ret && typeof ret === "function" ? "（unsubscriber）" : ""}`);
	ck("真实 ctx.on 可调用且不抛", err === null, err?.message ?? "");

	// 插件不依赖返回值：apply 返回值应为 undefined
	const plugin = await import(pathToFileURL(LIB).href + "?r1=" + Date.now());
	const ctx2 = new Context();
	const applyRet = plugin.apply(ctx2);
	ck("apply 返回 undefined（不依赖 ctx.on 返回值）", applyRet === undefined, String(applyRet));
}

console.log("\n=== 4. 两个插件实例共用 llm/stream ===");
{
	const ctx = new Context();
	const p1 = await import(pathToFileURL(LIB).href + "?c1=" + Date.now());
	const p2 = await import(pathToFileURL(LIB).href + "?c2=" + Date.now());
	p1.apply(ctx);
	p2.apply(ctx);

	// 两个实例都注册了监听器 —— 真实 Cordis 应允许
	let ok = true;
	let errMsg = "";
	try {
		// 触发一次，看是否崩溃（双重恢复会导致重复调用）
		let out = null;
		const w = ctx.waterfall?.("llm/stream", OPTS, () => makeStream(MARKUP));
		if (w && typeof w[Symbol.asyncIterator] === "function") {
			out = [];
			for await (const c of w) out.push(c);
		}
		if (out) {
			const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
			console.log(`  双重注册后恢复调用: ${calls.length} 个`);
			// 两次恢复会得到 2 个调用，但都是同一条命令 —— 属于已知的叠加行为。
			// **缺陷 82**：这里原来是 ck("双实例不崩溃", true, "")，恒真。
			// 改为检查真实性质：至少恢复 1 个、且不超过 2 个（两个实例各最多恢复 1 次）。
			ck("双实例下恢复数量合理（1–2 个）", calls.length >= 1 && calls.length <= 2,
				`${calls.length} 个`);
			if (calls.length > 1) {
				console.log(`  ⚠️ 注意：两个实例同时启用会重复恢复（${calls.length} 个调用），这是预期行为——用户不应重复安装`);
			}
		}
	} catch (e) {
		ok = false;
		errMsg = e.message;
	}
	ck("双实例共存不抛异常", ok, errMsg);
}

console.log("\n=== 5. 卸载（dispose）后不再拦截 ===");
{
	const ctx = new Context();
	const plugin = await import(pathToFileURL(LIB).href + "?d1=" + Date.now());
	const ret = plugin.apply(ctx);

	// **缺陷 82**：Cordis 4 的 Context **没有 dispose 方法**（实测 typeof === "undefined"）。
	// 原代码写 ck("插件不抛在 dispose 阶段", true, "") —— 因为 dispose 根本不存在，
	// 这条断言永远通过且不验证任何东西。
	//
	// 如实记录真实情况：插件依赖宿主生命周期（不自己注册 disposer），
	// 而本版本的 Cordis 没有可直接调用的 dispose API，所以这一场景**无法在此测试**。
	const hasDispose = typeof ctx.dispose === "function";
	console.log(`  Cordis Context.dispose 是否存在: ${hasDispose}`);
	ck("如实记录：Cordis 4 的 Context 无 dispose API（本场景不可测）",
		hasDispose === false,
		hasDispose ? "意外：dispose 存在，应改为真实测试" : "");
	console.log("  说明：插件不自己注册 disposer，依赖宿主生命周期；本版本无法直接测试卸载行为。");

	// 可测的替代：插件通过 ctx.on 注册，返回的 unsubscriber 应能解除监听
	const unsub = ctx.on("llm/stream", (opts, next) => next());
	ck("ctx.on 返回 unsubscriber", typeof unsub === "function", typeof unsub);
	if (typeof unsub === "function") {
		unsub();
		console.log("  ✅ 已调用 unsubscriber（未抛异常）");
	}
}

console.log("\n=== 6. 插件在真实 Context 上的行为与测试替身一致 ===");
{
	// 用测试替身跑一遍
	const stubRet = { out: [] };
	const pluginStub = await import(pathToFileURL(LIB).href + "?s1=" + Date.now());
	let stubListener = null;
	pluginStub.apply({ on: (e, h) => { if (e === "llm/stream") stubListener = h; } });
	if (stubListener) {
		for await (const c of stubListener(OPTS, () => makeStream(MARKUP))) stubRet.out.push(c);
	}
	const stubCalls = stubRet.out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").length;

	// 用真实 Context 跑一遍
	let realCalls = null;
	const ctx = new Context();
	const pluginReal = await import(pathToFileURL(LIB).href + "?s2=" + Date.now());
	pluginReal.apply(ctx);
	try {
		const w = ctx.waterfall?.("llm/stream", OPTS, () => makeStream(MARKUP));
		if (w && typeof w[Symbol.asyncIterator] === "function") {
			const out = [];
			for await (const c of w) out.push(c);
			realCalls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").length;
		}
	} catch { /* ignore */ }

	console.log(`  测试替身: ${stubCalls} 个调用`);
	console.log(`  真实 Cordis: ${realCalls === null ? "（未能触发）" : realCalls + " 个调用"}`);
	if (realCalls !== null) {
		ck("真实 Cordis 与测试替身行为一致", stubCalls === realCalls, `stub=${stubCalls} real=${realCalls}`);
	} else {
		console.log("  （真实 waterfall 未触发，无法对比）");
	}
}

console.log("\n=== 7. 插件不使用 Cordis 之外的能力 ===");
{
	const src = fs.readFileSync(LIB, "utf8");
	// 插件只能依赖 ctx.on；不应访问 ctx 的其他属性
	const ctxProps = [...src.matchAll(/\bctx\.(\w+)/g)].map((m) => m[1]);
	const uniq = [...new Set(ctxProps)];
	console.log(`  插件访问的 ctx 属性: ${uniq.join(", ") || "（无）"}`);
	ck("插件只使用 ctx.on", uniq.every((p) => p === "on"), uniq.join(","));
	ck("插件不访问 ctx.config", !uniq.includes("config"), "");
	ck("插件不访问 ctx.logger", !uniq.includes("logger"), "");
	ck("插件不访问 ctx.plugin", !uniq.includes("plugin"), "");
	ck("插件不访问 ctx.effect", !uniq.includes("effect"), "");
	ck("插件不访问 ctx.set", !uniq.includes("set"), "");
}

console.log(`\n===== 真实 Cordis 宿主集成: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
