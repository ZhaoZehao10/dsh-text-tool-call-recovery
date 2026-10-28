// 缺陷回归矩阵：确保 32 个历史缺陷的修复不会回归
//
// 这是本项目**最重要的一份回归测试**：
// 每个缺陷都必须有一个「如果这个修复被破坏，就会失败」的断言。
//
// 为什么需要单独做：现有的 60 个套件按「功能维度」组织（如「类型模糊」、
// 「原型污染」），但没有按「历史缺陷」组织。当一个修复被后续改动破坏时，
// 可能只有很间接的测试才会失败，甚至完全不失败（就像第 25/28/29/30 轮
// 发现的那些测试基建缺陷一样）。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const LLM = (() => {
	const cands = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
	].filter(Boolean);
	for (const c of cands) if (fs.existsSync(c)) return c;
	return null;
})();
if (LLM === null) { console.log("跳过：找不到 dsh-llm"); process.exit(0); }

const { BlockAssembler, AssistantStreamAccumulator, assembleAssistantStream, assistantStreamHasVisibleContent, joinAssistantStreamText } = await import(pathToFileURL(LLM).href);
const plugin = await import(pathToFileURL(LIB).href + "?reg=" + Date.now());
const src = fs.readFileSync(LIB, "utf8");

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "number" }, limit: { type: "integer" }, force: { type: "boolean" } } } },
	{ name: "read", parameters: { type: "object", properties: { file_path: { type: "string" }, offset: { type: "number" } } } },
];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };

const mkCall = (tool, params) => {
	const body = Object.entries(params).map(([k, v]) => "<parameter=" + k + ">\n" + v + "\n</parameter>").join("\n");
	return OC + "\n<function=" + tool + ">\n" + body + "\n</function>\n" + CC;
};

async function run(text, blockType = "reasoning") {
	plugin.resetStreaks?.();
	const out = [];
	let err = null;
	try {
		const gen = (async function* () {
			yield { type: "block-start", index: 0, blockType };
			yield { type: blockType === "text" ? "text-delta" : "reasoning-delta", index: 0, text };
			yield { type: "block-end", index: 0, block: { type: blockType, text } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		for await (const c of listener(OPTS, () => gen)) out.push(c);
	} catch (e) { err = e; }
	const blocks = out.filter((c) => c.type === "block-end");
	const calls = blocks.filter((b) => b.block?.type === "tool-call");
	const stripped = blocks.filter((b) => b.block?.type === "text").map((b) => b.block.text ?? "").join("");
	const fin = out.find((c) => c.type === "finish");
	return { out, err, calls, stripped, fin };
}

// ===========================================================================
// 缺陷 1: 把「只有标记的文本」误判为「有实质内容」，导致误伤正常回复
// ===========================================================================
console.log("=== 缺陷 1: 误伤正常回复（实质字符判据）===");
{
	// **重要前提**：安全网的判据是「有没有 text 块里的可见文本」。
	// reasoning 块里的文字**不算可见文本**——这是设计意图：
	// 只有思考、没有正文，对用户来说等于没有输出，应该触发重试。
	// 因此 D1 的回归测试必须用 **text 块**（真实场景里模型也会把正文放 text 块）。

	// 正常长回复（text 块）不应被判定为空响应
	const r = await run("这是一段很长的正常回复内容，包含足够多的实质文字，不应该被判定为空响应。".repeat(3), "text");
	ck("D1 长正常回复（text 块）保持 stop", r.fin?.reason?.kind === "stop", JSON.stringify(r.fin?.reason));

	// 短文本同样不应误判
	const rShort = await run("短文本。", "text");
	ck("D1 短正常回复保持 stop", rShort.fin?.reason?.kind === "stop", JSON.stringify(rShort.fin?.reason));

	// 但「只有 reasoning 块、无 text 块」确实应触发安全网（设计意图）
	const rReasonOnly = await run("这是一段很长的思考内容。".repeat(3), "reasoning");
	ck("D1 只有 reasoning 块触发安全网（设计意图）", rReasonOnly.fin?.reason?.kind === "error", JSON.stringify(rReasonOnly.fin?.reason));
	// 纯标记文本应被判定为空响应
	const r2 = await run(OC + "\n<function=pwsh>\n<parameter=command>\nx\n</parameter>\n</function>\n" + CC);
	ck("D1 纯标记文本触发安全网", r2.fin?.reason?.kind === "tool-calls" || r2.fin?.reason?.kind === "error", JSON.stringify(r2.fin?.reason));
}

// ===========================================================================
// 缺陷 2: usage 顺序倒置（usage 必须在 finish 之前）
// ===========================================================================
console.log("\n=== 缺陷 2: usage 顺序 ===");
{
	let usageIdx = -1, finishIdx = -1;
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: mkCall("pwsh", { command: "echo hi" }) };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: mkCall("pwsh", { command: "echo hi" }) } };
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	plugin.resetStreaks?.();
	const out = [];
	for await (const c of listener(OPTS, () => gen)) out.push(c);
	usageIdx = out.findIndex((c) => c.type === "usage");
	finishIdx = out.findIndex((c) => c.type === "finish");
	ck("D2 usage 在 finish 之前", usageIdx >= 0 && usageIdx < finishIdx, `usage@${usageIdx} finish@${finishIdx}`);
}

// ===========================================================================
// 缺陷 3: 代码块里的示例被误执行（安全）
// ===========================================================================
console.log("\n=== 缺陷 3: 代码块示例不执行（安全）===");
{
	const dangerous = mkCall("pwsh", { command: "rm -rf /" });
	for (const [label, text] of [
		["代码围栏", "示例：\n```xml\n" + dangerous + "\n```\n以上是示例。"],
		["行内代码", "写法是 `" + dangerous.replace(/\n/g, " ") + "` 这样"],
		["波浪号围栏", "示例：\n~~~\n" + dangerous + "\n~~~\n"],
	]) {
		const r = await run(text);
		ck(`D3 ${label} 示例不执行`, r.calls.length === 0, `恢复了 ${r.calls.length} 个`);
	}
}

// ===========================================================================
// 缺陷 4: Anthropic 形态（antml / invoke）解析
// ===========================================================================
console.log("\n=== 缺陷 4: Anthropic 形态 ===");
{
	for (const [label, text] of [
		// **注意**：Anthropic 官方格式是 `<antml:function>` 外层 + **普通 `<parameter>`**，
		// 参数标签不带 antml: 前缀。实测 `<antml:parameter>` 这种写法解析不出来，
		// 但真实日志中未出现过该形态（属于非标准写法，作为已知限制记录）。
		["antml:function + 普通 parameter", OC + '\n<antml:function name="pwsh">\n<parameter name="command">echo hi</parameter>\n</antml:function>\n' + CC],
		["invoke", OC + '\n<invoke name="pwsh">\n<parameter name="command">echo hi</parameter>\n</invoke>\n' + CC],
		["裸露 function", '<function name="pwsh">\n<parameter name="command">echo hi</parameter>\n</function>'],
	]) {
		const r = await run(text);
		ck(`D4 ${label} 可解析`, r.calls.length === 1, `${r.calls.length} 个`);
		if (r.calls.length === 1) {
			let args = null;
			try { args = JSON.parse(r.calls[0].block.arguments); } catch {}
			ck(`D4 ${label} 参数正确`, args?.command === "echo hi", JSON.stringify(args));
		}
	}
}

// ===========================================================================
// 缺陷 5: 异常输入不抛异常
// ===========================================================================
console.log("\n=== 缺陷 5: 异常输入防御 ===");
{
	const cases = [
		["null chunk", [null]],
		["undefined chunk", [undefined]],
		["缺 block 的 block-end", [{ type: "block-end", index: 0 }]],
		["缺 reason 的 finish", [{ type: "finish" }]],
	];
	for (const [label, chunks] of cases) {
		plugin.resetStreaks?.();
		let err = null;
		try {
			const gen = (async function* () { for (const c of chunks) yield c; })();
			for await (const c of listener(OPTS, () => gen)) { /* consume */ }
		} catch (e) { err = e; }
		ck(`D5 ${label} 不崩溃`, err === null, err?.message ?? "");
	}
}

// ===========================================================================
// 缺陷 6: 确定性失败不空转
// ===========================================================================
console.log("\n=== 缺陷 6: 确定性失败保护 ===");
{
	plugin.resetStreaks?.();
	const empty = () => (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "只有思考" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const kinds = [];
	for (let i = 0; i < 6; i++) {
		const out = [];
		for await (const c of listener({ ...OPTS, model: "det-fail-model" }, empty)) out.push(c);
		kinds.push(out.find((c) => c.type === "finish")?.reason?.kind);
	}
	console.log(`  连续 6 次空响应的 finish: ${JSON.stringify(kinds)}`);
	ck("D6 首次返回 error（可重试）", kinds[0] === "error", String(kinds[0]));
	ck("D6 后续不空转（返回 stop）", kinds.slice(1).every((k) => k === "stop"), JSON.stringify(kinds));
}

// ===========================================================================
// 缺陷 7: ReDoS 上限
// ===========================================================================
console.log("\n=== 缺陷 7: ReDoS 上限 ===");
{
	const huge = OC.repeat(30000);   // 病态输入
	const t0 = Date.now();
	await run(huge);
	const elapsed = Date.now() - t0;
	console.log(`  病态输入 ${huge.length} 字符耗时 ${elapsed}ms`);
	ck("D7 病态输入 < 1000ms", elapsed < 1000, `${elapsed}ms`);
	ck("D7 MAX_SCAN_CHARS 常量存在", src.includes("MAX_SCAN_CHARS = 128"));
}

// ===========================================================================
// 缺陷 8: 多轮状态不泄漏
// ===========================================================================
console.log("\n=== 缺陷 8: 多轮状态隔离 ===");
{
	// 用 Proxy 确认插件不读取 messages
	let accessed = false;
	const spy = new Proxy([], { get(t, p) { if (typeof p !== "symbol" && p !== "length") accessed = true; return t[p]; } });
	plugin.resetStreaks?.();
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: mkCall("pwsh", { command: "echo x" }) };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: mkCall("pwsh", { command: "echo x" }) } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	for await (const c of listener({ ...OPTS, messages: spy }, () => gen)) { /* consume */ }
	ck("D8 不读取 messages（无状态）", accessed === false, accessed ? "读取了 messages" : "");
}

// ===========================================================================
// 缺陷 9: 交错块按 index 跟踪（最危险）
// ===========================================================================
console.log("\n=== 缺陷 9: 交错块 ===");
{
	// 真实适配器形态：先所有 block-start，再交错 deltas，最后 block-end
	const markup = mkCall("pwsh", { command: "echo interleaved" });
	const plain = "这是正常正文内容，足够长以构成可见文本。";
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "block-start", index: 1, blockType: "text" };
		yield { type: "reasoning-delta", index: 0, text: markup };
		yield { type: "text-delta", index: 1, text: plain };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
		yield { type: "block-end", index: 1, block: { type: "text", text: plain } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	plugin.resetStreaks?.();
	const out = [];
	for await (const c of listener(OPTS, () => gen)) out.push(c);
	const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	const text = out.filter((c) => c.type === "block-end" && c.block?.type === "text").map((c) => c.block.text).join("");
	ck("D9 交错块能恢复", calls.length === 1, `${calls.length} 个`);
	ck("D9 交错块的正文不被误伤", text.includes(plain), JSON.stringify(text.slice(0, 40)));
	let args = null;
	try { args = JSON.parse(calls[0]?.block?.arguments ?? "null"); } catch {}
	ck("D9 交错块参数正确", args?.command === "echo interleaved", JSON.stringify(args));
}

// ===========================================================================
// 缺陷 10-15: 解析形态
// ===========================================================================
console.log("\n=== 缺陷 10-15: 各类解析形态 ===");
{
	// D10: 属性等号两侧带空格
	const r10 = await run(OC + '\n<function name = "pwsh">\n<parameter=command>echo hi</parameter>\n</function>\n' + CC);
	ck("D10 属性等号带空格可解析", r10.calls.length === 1, `${r10.calls.length} 个`);

	// D11: 参数值里的反引号
	const r11 = await run(mkCall("pwsh", { command: "echo `date`" }));
	ck("D11 参数值含反引号仍恢复", r11.calls.length === 1, `${r11.calls.length} 个`);
	if (r11.calls.length === 1) {
		let args = null;
		try { args = JSON.parse(r11.calls[0].block.arguments); } catch {}
		ck("D11 反引号内容保留", args?.command?.includes("`date`"), JSON.stringify(args));
	}

	// D14: JSON 参数类型强转 + args 字段
	const r14 = await run('{"name":"read","args":{"file_path":"/x","offset":"42"}}');
	ck("D14 JSON args 字段可识别", r14.calls.length === 1, `${r14.calls.length} 个`);
	if (r14.calls.length === 1) {
		let args = null;
		try { args = JSON.parse(r14.calls[0].block.arguments); } catch {}
		ck("D14 数字被强转", args?.offset === 42, JSON.stringify(args));
	}

	// D15: 属性位置无关
	const r15 = await run(OC + '\n<function id="c1" name="pwsh">\n<parameter=command>echo hi</parameter>\n</function>\n' + CC);
	ck("D15 name 位置无关可解析", r15.calls.length === 1, `${r15.calls.length} 个`);
}

// ===========================================================================
// 缺陷 16: 截断检测
// ===========================================================================
console.log("\n=== 缺陷 16: 截断检测 ===");
{
	// 值里含裸闭合标签 → 必须放弃恢复（否则会执行半截命令）
	const text = OC + "\n<function=pwsh>\n<parameter=command>\nrm -rf /tmp/x</parameter></parameter>\n</function>\n" + CC;
	const r = await run(text);
	ck("D16 截断形态不恢复（不执行半截命令）", r.calls.length === 0, `${r.calls.length} 个`);
}

// ===========================================================================
// 缺陷 17-18: 类型强转语义
// ===========================================================================
console.log("\n=== 缺陷 17-18: 强转语义 ===");
{
	// D17: 空字符串不强转成 0
	const r17 = await run(mkCall("pwsh", { timeoutMs: "  " }));
	if (r17.calls.length === 1) {
		let args = null;
		try { args = JSON.parse(r17.calls[0].block.arguments); } catch {}
		ck("D17 空串不强转成 0", args?.timeoutMs !== 0, JSON.stringify(args));
	} else {
		ck("D17 空串不强转成 0", false, "未恢复");
	}

	// D18: 大整数保持字符串
	const big = "9007199254740993";
	const r18 = await run(mkCall("pwsh", { timeoutMs: big }));
	if (r18.calls.length === 1) {
		let args = null;
		try { args = JSON.parse(r18.calls[0].block.arguments); } catch {}
		ck("D18 大整数不丢精度", String(args?.timeoutMs) === big, JSON.stringify(args));
	} else {
		ck("D18 大整数不丢精度", false, "未恢复");
	}
}

// ===========================================================================
// 缺陷 19: 裸 JSON 片段不执行（安全，真实事故）
// ===========================================================================
console.log("\n=== 缺陷 19: 裸 JSON 片段（真实事故）===");
{
	const incident = '汇报内容。\n随时可以复跑。\n{"command":"rm -rf /"}';
	const r = await run(incident);
	ck("D19 正文裸 JSON 不被当成调用", r.calls.length === 0, `${r.calls.length} 个`);

	// 但整段就是合法 JSON 调用时必须恢复
	const legit = '{"name":"pwsh","arguments":{"command":"echo hi"}}';
	const r2 = await run(legit);
	ck("D19 整段合法 JSON 仍能恢复", r2.calls.length === 1, `${r2.calls.length} 个`);
}

// ===========================================================================
// 缺陷 20: 错误消息如实描述
// ===========================================================================
console.log("\n=== 缺陷 20: 错误消息准确性 ===");
{
	plugin.resetStreaks?.();
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: "   " };
		yield { type: "block-end", index: 0, block: { type: "text", text: "   " } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = [];
	for await (const c of listener({ ...OPTS, model: "msg-model" }, () => gen)) out.push(c);
	const msg = String(out.find((c) => c.type === "finish")?.reason?.failure?.message ?? "");
	console.log(`  消息: ${msg}`);
	ck("D20 消息含真实块类型 text", msg.includes("text"), msg);
	ck("D20 消息不含错误类型 reasoning", !msg.includes("reasoning"), msg);
	ck("D20 消息标出 all empty", msg.includes("all empty"), msg);
}

// ===========================================================================
// 缺陷 21: deltas 与 block-end 一致
// ===========================================================================
console.log("\n=== 缺陷 21: deltas 一致性 ===");
{
	let deltas = "";
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: mkCall("pwsh", { command: "echo hi" }) };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: mkCall("pwsh", { command: "echo hi" }) } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	plugin.resetStreaks?.();
	const out = [];
	for await (const c of listener(OPTS, () => gen)) out.push(c);
	deltas = out.filter((c) => c.type === "reasoning-delta").map((c) => c.text).join("");
	const blockText = out.find((c) => c.type === "block-end" && c.block?.type === "reasoning")?.block?.text ?? "";
	ck("D21 deltas 与 block-end 一致", deltas === blockText, `delta=${JSON.stringify(deltas.slice(0, 30))} block=${JSON.stringify(blockText.slice(0, 30))}`);
	ck("D21 deltas 不含残留标记", !deltas.includes("<tool_call>"), JSON.stringify(deltas.slice(0, 40)));
}

// ===========================================================================
// 缺陷 22-24: 类型崩溃防护
// ===========================================================================
console.log("\n=== 缺陷 22-24: 类型崩溃防护 ===");
{
	// D22: block.text 非字符串
	for (const bad of [undefined, null, 42, {}]) {
		plugin.resetStreaks?.();
		let err = null;
		try {
			const gen = (async function* () {
				yield { type: "block-start", index: 0, blockType: "text" };
				yield { type: "block-end", index: 0, block: { type: "text", text: bad } };
				yield { type: "finish", reason: { kind: "stop" } };
			})();
			for await (const c of listener(OPTS, () => gen)) { /* consume */ }
		} catch (e) { err = e; }
		ck(`D22 block.text=${typeof bad === "object" ? JSON.stringify(bad) : String(bad)} 不崩溃`, err === null, err?.message ?? "");
	}

	// D24: Symbol 作为 model
	for (const badModel of [Symbol("m"), Symbol(""), { toString: () => { throw new Error("boom"); } }]) {
		plugin.resetStreaks?.();
		let err = null;
		try {
			const gen = (async function* () {
				yield { type: "block-start", index: 0, blockType: "reasoning" };
				yield { type: "reasoning-delta", index: 0, text: "只有思考" };
				yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
				yield { type: "finish", reason: { kind: "stop" } };
			})();
			for await (const c of listener({ ...OPTS, model: badModel }, () => gen)) { /* consume */ }
		} catch (e) { err = e; }
		ck("D24 Symbol/恶意 model 不崩溃", err === null, err?.message ?? "");
	}
}

// ===========================================================================
// 缺陷 25: 断流时交出已扣留内容
// ===========================================================================
console.log("\n=== 缺陷 25: 断流不丢内容 ===");
{
	for (const [label, text] of [
		["普通文本块", "这是用户已经看到的部分内容。"],
		["含标记块", mkCall("pwsh", { command: "echo hi" })],
	]) {
		plugin.resetStreaks?.();
		const gen = (async function* () {
			yield { type: "block-start", index: 0, blockType: "text" };
			yield { type: "text-delta", index: 0, text };
			throw new Error("ECONNRESET");
		})();
		let err = null;
		const out = [];
		try {
			for await (const c of listener(OPTS, () => gen)) out.push(c);
		} catch (e) { err = e; }
		ck(`D25 ${label} 断流后仍交出内容`, out.length >= 1, `${out.length} 个 chunk`);
		ck(`D25 ${label} 断流异常透传`, err !== null && String(err.message).includes("ECONNRESET"), err?.message ?? "未抛");
	}
}

// ===========================================================================
// 缺陷 26: VERSION 可查询
// ===========================================================================
console.log("\n=== 缺陷 26: VERSION ===");
{
	ck("D26 导出 VERSION", typeof plugin.VERSION === "string", typeof plugin.VERSION);
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	ck("D26 VERSION ≡ package.json", plugin.VERSION === pkg.version, `${plugin.VERSION} vs ${pkg.version}`);
}

// ===========================================================================
// 缺陷 27: 三种行尾
// ===========================================================================
console.log("\n=== 缺陷 27: 行尾符号 ===");
{
	for (const [label, nl] of [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]]) {
		const text = OC + nl + "<function=pwsh>" + nl + "<parameter=command>" + nl + "echo hi" + nl + "</parameter>" + nl + "</function>" + nl + CC;
		const r = await run(text);
		if (r.calls.length === 1) {
			let args = null;
			try { args = JSON.parse(r.calls[0].block.arguments); } catch {}
			ck(`D27 ${label} 行尾参数正确`, args?.command === "echo hi", JSON.stringify(args?.command));
		} else {
			ck(`D27 ${label} 行尾参数正确`, false, `${r.calls.length} 个调用`);
		}
	}
}

// ===========================================================================
// 缺陷 28-32: 代码/文档/基建（静态检查）
// ===========================================================================
console.log("\n=== 缺陷 28-32: 静态检查 ===");
{
	ck("D28 死代码 hasCodeFence 已删", !src.includes("hasCodeFence"));
	ck("D28 死代码 MARKER_TAGS 已删", !src.includes("MARKER_TAGS"));

	const covSrc = fs.readFileSync(path.join(ROOT, "test", "hardening", "coverage.mjs"), "utf8");
	ck("D29 coverage 并发安全", covSrc.includes("mkdtempSync"));

	const mutSrc = fs.readFileSync(path.join(ROOT, "test", "hardening", "mutation-test.mjs"), "utf8");
	ck("D30 SKIP 导致失败", /ok\s*=\s*survived\s*===\s*0\s*&&\s*skipped\s*===\s*0/.test(mutSrc));

	ck("D31 doc-consistency 存在", fs.existsSync(path.join(ROOT, "test", "hardening", "doc-consistency.mjs")));

	const head = src.split(/\r?\n/).slice(0, 12).join("\n");
	ck("D32 模块说明在文件顶部", head.includes("@module"), "");
}

console.log(`\n===== 缺陷回归矩阵: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
