// 错误消息与可观测性审查
//
// 插件在接缝里会改写 finish 为 error/EMPTY_RESPONSE。若消息质量差：
//   - 用户看不懂（只看到"出错了"）
//   - 维护者无法定位（没有 model/原因/上下文）
//   - 消息里泄漏内部实现细节或敏感数据
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

async function run(text, model = "test-model", blockType = "reasoning", tools = TOOLS) {
	plugin.resetStreaks?.();
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType };
		yield { type: blockType === "text" ? "text-delta" : "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: blockType, text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = [];
	for await (const c of listener({ provider: "p", model, messages: [], tools }, () => src)) out.push(c);
	return out.find((c) => c.type === "finish");
}

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

console.log("=== 1. EMPTY_RESPONSE 消息的结构 ===");
{
	const fin = await run("只有思考没有正文", "step-5-preview");
	console.log(`  kind: ${fin?.reason?.kind}`);
	console.log(`  code: ${fin?.reason?.failure?.code}`);
	console.log(`  message: ${fin?.reason?.failure?.message}`);

	ck("kind 是 error", fin?.reason?.kind === "error", fin?.reason?.kind);
	ck("有明确的 code", typeof fin?.reason?.failure?.code === "string" && fin.reason.failure.code.length > 0);
	ck("code 是 EMPTY_RESPONSE", fin?.reason?.failure?.code === "EMPTY_RESPONSE", fin?.reason?.failure?.code);
	ck("有可读的 message", typeof fin?.reason?.failure?.message === "string" && fin.reason.failure.message.length > 20);
	// 消息应包含模型名（便于定位）
	ck("消息里含模型名", String(fin?.reason?.failure?.message).includes("step-5-preview"), fin?.reason?.failure?.message);
	// 消息应说明「只有什么块」
	ck("消息说明块类型", /blocks:/i.test(String(fin?.reason?.failure?.message)), fin?.reason?.failure?.message);
}

console.log("\n=== 2. 消息不含敏感信息 ===");
{
	const fin = await run("只有思考", "model-with-secret-name");
	const msg = String(fin?.reason?.failure?.message ?? "");
	console.log(`  message: ${msg}`);
	// 不应含文件路径、密钥、内部变量名
	const leaks = [
		{ name: "文件路径", re: /[A-Z]:\\|\/Users\/|\.js:\d+/ },
		{ name: "疑似密钥", re: /sk-[A-Za-z0-9]{8,}/ },
		{ name: "堆栈", re: /\bat\s+\w+\s+\(|Error:\s/ },
	];
	for (const l of leaks) {
		ck(`消息不含${l.name}`, !l.re.test(msg), msg);
	}
}

console.log("\n=== 3. 消息长度合理（不刷屏）===");
{
	const fin = await run("只有思考", "m");
	const msg = String(fin?.reason?.failure?.message ?? "");
	ck("message 长度 < 300 字符", msg.length < 300, `${msg.length} 字符`);
	console.log(`  长度: ${msg.length} 字符`);
}

console.log("\n=== 4. 消息如实反映真实块类型（关键：误导排查）===");
{
	// 旧实现把块类型写死成 "only reasoning blocks"，即使实际是 text 块也说 reasoning，
	// 会把维护者的排查方向带偏。所以必须逐情形断言。

	// 4a. 只有 reasoning 块 → 消息应含 "reasoning"
	{
		const fin = await run("只有思考没有正文", "m", "reasoning");
		const msg = String(fin?.reason?.failure?.message ?? "");
		ck("reasoning 块 → 消息含 reasoning", msg.includes("reasoning"), msg);
		ck("reasoning 块 → 消息不含 text", !msg.includes("only text"), msg);
	}

	// 4b. 只有 text 块 → 消息应含 "text"，且**不能**说 reasoning
	{
		const fin = await run("   ", "m", "text");   // 纯空白文本块
		const msg = String(fin?.reason?.failure?.message ?? "");
		ck("text 块 → 消息含 text", msg.includes("text"), msg);
		ck("text 块 → 消息**不含** reasoning（旧 bug）", !msg.includes("reasoning"), msg);
	}

	// 4c. 完全没有块 → 消息应说明无块
	{
		plugin.resetStreaks?.();
		const src = (async function* () {
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		const out = [];
		for await (const c of listener({ provider: "p", model: "m", messages: [], tools: TOOLS }, () => src)) out.push(c);
		const fin2 = out.find((c) => c.type === "finish");
		const msg = String(fin2?.reason?.failure?.message ?? "");
		ck("无块 → 消息含 no blocks", msg.includes("no blocks"), msg);
		ck("无块 → 消息不含 reasoning", !msg.includes("reasoning"), msg);
	}

	// 4d. 内容全空 → 消息应标明 all empty（区别于"有内容但不可执行"）
	{
		const fin = await run("", "m", "reasoning");
		const msg = String(fin?.reason?.failure?.message ?? "");
		ck("空内容 → 消息含 all empty", msg.includes("all empty"), msg);
	}

	// 4e. 有实质内容但不可执行（如只剩不可解析标记）→ 不应标 all empty
	{
		const markup = OC + "\n<function=pwsh>\n<parameter=command>\n";   // 截断，不可解析
		const fin = await run(markup, "m", "reasoning");
		const msg = String(fin?.reason?.failure?.message ?? "");
		ck("有内容但不可执行 → 不标 all empty", !msg.includes("all empty"), msg);
	}
}

console.log("\n=== 5. 不该报错时绝不产生 error ===");
{
	const cases = [
		["正常正文", "这是一段正常的回复内容，有足够的实质文字。".repeat(5), "text"],
		["正文含少量标记引用", "我提到 `<parameter=x>` 这个写法。" + "正常内容。".repeat(20), "text"],
		["正文含代码围栏", "示例：\n```\ncode\n```\n" + "说明文字。".repeat(20), "text"],
		["思考 + 正文", "思考内容", "reasoning"],
	];
	for (const [label, text, bt] of cases) {
		if (label === "思考 + 正文") {
			// 特殊：两个块
			plugin.resetStreaks?.();
			const src = (async function* () {
				yield { type: "block-start", index: 0, blockType: "reasoning" };
				yield { type: "reasoning-delta", index: 0, text: "思考" };
				yield { type: "block-end", index: 0, block: { type: "reasoning", text: "思考" } };
				yield { type: "block-start", index: 1, blockType: "text" };
				yield { type: "text-delta", index: 1, text: "正文内容".repeat(20) };
				yield { type: "block-end", index: 1, block: { type: "text", text: "正文内容".repeat(20) } };
				yield { type: "finish", reason: { kind: "stop" } };
			})();
			const out = [];
			for await (const c of listener({ provider: "p", model: "m", messages: [], tools: TOOLS }, () => src)) out.push(c);
			const fin = out.find((c) => c.type === "finish");
			ck(`${label} → 保持 stop`, fin?.reason?.kind === "stop", JSON.stringify(fin?.reason));
			continue;
		}
		const fin = await run(text, "m", bt);
		ck(`${label} → 保持 stop`, fin?.reason?.kind === "stop", JSON.stringify(fin?.reason));
	}
}

console.log("\n=== 6. 成功的恢复不产生任何告警噪音 ===");
{
	const markup = OC + "\n<function=pwsh>\n<parameter=command>\necho hi\n</parameter>\n</function>\n" + CC;
	const fin = await run(markup, "m", "reasoning");
	ck("恢复成功 → finish=tool-calls", fin?.reason?.kind === "tool-calls", JSON.stringify(fin?.reason));
	ck("恢复成功 → 无 failure 字段", fin?.reason?.failure === undefined, JSON.stringify(fin?.reason?.failure));
	// 恢复出的块应干净（无多余字段）
	plugin.resetStreaks?.();
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: markup };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: markup } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const out = [];
	for await (const c of listener({ provider: "p", model: "m", messages: [], tools: TOOLS }, () => src)) out.push(c);
	const tc = out.find((c) => c.type === "block-end" && c.block?.type === "tool-call");
	ck("合成块字段完整", tc?.block?.type === "tool-call" && typeof tc.block.id === "string" && typeof tc.block.name === "string" && typeof tc.block.arguments === "string", JSON.stringify(tc?.block));
	ck("合成块 id 有可识别前缀", String(tc?.block?.id).startsWith("txtcall-"), tc?.block?.id);
}

console.log(`\n===== 错误消息与可观测性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
