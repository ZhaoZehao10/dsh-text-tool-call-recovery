// README「已知限制」的真实性验证
//
// **为什么需要**：README 的「十二、已知限制（诚实清单）」列出了 8 条做不到的事，
// 但这些**「做不到」的宣称本身从未被验证过**。如果限制描述不准确，
// 读者会得到错误预期（要么低估风险、要么以为某个功能不存在）。
//
// 本套件逐条验证：
//   1. 其他文本格式不解析（Markdown 围栏 / 其他 XML 方言）→ 不执行、落到安全网
//   5. 完全无参数的调用不恢复 → 不执行、落到安全网
//   6. 只处理「工具调用被写成文本」这一类 → 正常回复不改动、其他异常不在范围
//   4. 绑定 llm/stream 接缝与 StreamChunk 协议 → 接缝名正确、处理全部 chunk 类型
//   3. 跨版本证据分两类 → 模拟脚本存在、README 标注「不可自动复现」
//
// **关键注意（第 73 轮踩过的坑）**：
//   安全网只把 **text 块** 视为「可见文本」，**reasoning 块不算**。
//   所以「测试正常回复不被改动」必须用 `blockType: "text"` ——
//   用 reasoning 会触发安全网（这是设计意图，不是 bug）。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const plugin = await import(pathToFileURL(LIB).href + "?kl=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];

async function run(text, tools = TOOLS, blockType = "reasoning") {
	plugin.resetStreaks?.();
	const out = [];
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType };
		yield { type: blockType === "text" ? "text-delta" : "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: blockType, text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	for await (const c of listener({ provider: "p", model: "kl-" + Math.random(), messages: [], tools }, () => gen)) out.push(c);
	const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	const fin = out.find((c) => c.type === "finish");
	return { calls: calls.length, kind: fin?.reason?.kind, code: fin?.reason?.failure?.code };
}

// ===========================================================================
// 限制 1：其他文本格式不解析
// ===========================================================================
console.log("=== 限制 1：其他文本格式不解析 ===");
{
	const fenced = "```\n" + OC + "\n<function=pwsh>\n<parameter=command>echo hi\n</parameter>\n</function>\n" + CC + "\n```";
	const r = await run(fenced);
	console.log(`  Markdown 围栏包裹: calls=${r.calls} kind=${r.kind}`);
	ck("围栏里的调用不执行", r.calls === 0, `calls=${r.calls}`);
	ck("围栏里的调用落到安全网（不是静默结束）", r.kind === "error", `kind=${r.kind}`);

	const otherXml = '<tool>\n<name>pwsh</name>\n<args>{"command":"echo hi"}</args>\n</tool>';
	const r2 = await run(otherXml);
	console.log(`  其他 XML 方言: calls=${r2.calls} kind=${r2.kind}`);
	ck("其他 XML 方言不执行", r2.calls === 0, `calls=${r2.calls}`);
	ck("其他 XML 方言落到安全网", r2.kind === "error", `kind=${r2.kind}`);
}

// ===========================================================================
// 限制 5：完全无参数的调用不恢复
// ===========================================================================
console.log("\n=== 限制 5：无参数调用不恢复 ===");
{
	const text = OC + "\n<function=noargs>\n</function>\n" + CC;
	const tools = [{ name: "noargs", parameters: { type: "object", properties: {} } }];
	const r = await run(text, tools);
	console.log(`  <function=noargs></function>: calls=${r.calls} kind=${r.kind}`);
	ck("无参数调用不被恢复", r.calls === 0, `calls=${r.calls}`);
	ck("无参数调用落到安全网", r.kind === "error", `kind=${r.kind}`);
	ck("安全网错误码正确", r.code === "EMPTY_RESPONSE", String(r.code));
}

// ===========================================================================
// 限制 6：只处理「工具调用被写成文本」这一类
// ===========================================================================
console.log("\n=== 限制 6：处理范围的边界 ===");
{
	// **必须用 text 块**：reasoning 块不算「可见文本」，会触发安全网
	const normalText = "这是一段完全正常的回复，没有任何工具调用标记。";
	const r = await run(normalText, TOOLS, "text");
	console.log(`  正常文本回复（text 块）: calls=${r.calls} kind=${r.kind}`);
	ck("正常文本回复不被改动", r.calls === 0 && r.kind === "stop", `calls=${r.calls} kind=${r.kind}`);

	// reasoning 块：这是设计意图（只有思考 = 无输出 = 应重试）
	const rReason = await run(normalText, TOOLS, "reasoning");
	console.log(`  只有思考（reasoning 块）: kind=${rReason.kind}`);
	ck("只有思考时触发安全网（设计意图）", rReason.kind === "error", `kind=${rReason.kind}`);

	// 真实工具调用：属于范围
	const realCall = OC + "\n<function=pwsh>\n<parameter=command>echo hi\n</parameter>\n</function>\n" + CC;
	const r2 = await run(realCall);
	console.log(`  真实文本工具调用: calls=${r2.calls} kind=${r2.kind}`);
	ck("真实文本工具调用会被恢复", r2.calls === 1 && r2.kind === "tool-calls", `calls=${r2.calls} kind=${r2.kind}`);
}

// ===========================================================================
// 限制 4：绑定 llm/stream 接缝与 StreamChunk 协议
// ===========================================================================
console.log("\n=== 限制 4：绑定的协议 ===");
{
	const src = fs.readFileSync(LIB, "utf8");
	ck("插件监听 llm/stream 接缝", /ctx\.on\(\s*["']llm\/stream["']/.test(src), "");
	ck("插件导出 VERSION（可诊断加载版本）", /const VERSION = "/.test(src) && /export\s*\{[\s\S]*VERSION/.test(src), "");

	// StreamChunk 类型
	const CHUNK_TYPES = ["block-start", "text-delta", "reasoning-delta", "tool-call-delta", "block-end", "usage", "finish"];
	const missing = CHUNK_TYPES.filter((t) => !src.includes(t));
	ck("处理全部 7 种 StreamChunk 类型", missing.length === 0, missing.join(", "));
	console.log(`  chunk 类型: ${CHUNK_TYPES.length} 种，缺失 ${missing.length}`);
}

// ===========================================================================
// 限制 3：跨版本证据分两类（历史记录 vs 自动守护）
// ===========================================================================
console.log("\n=== 限制 3：跨版本证据分级 ===");
{
	const cv = path.join(ROOT, "test", "hardening", "cross-version.mjs");
	ck("cross-version.mjs（自动守护）存在", fs.existsSync(cv), "");
	if (fs.existsSync(cv)) {
		const cvSrc = fs.readFileSync(cv, "utf8");
		ck("cross-version.mjs 模拟协议差异（非真实版本对比）",
			/模拟|simulat|协议差异|未知 chunk/.test(cvSrc), "");
	}

	const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
	ck("README 标注三版本实测「不可自动复现」", /不可自动复现|手工跑的历史记录/.test(readme), "");
	ck("README 有「已知限制」章节（诚实清单）", /已知限制/.test(readme), "");
}

// ===========================================================================
// 额外：README 的「已知限制」必须包含无参数调用这一条
// ===========================================================================
console.log("\n=== 已知限制章节的完整性 ===");
{
	const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
	// **修正**：不能用 indexOf("已知限制（诚实清单）") —— 
	// 它会匹配到 D40 缺陷行里对这个章节的**引用**（在缺陷表中间）。
	// 必须用章节标题定位。
	const sectionMatch = readme.match(/^##\s*十二、已知限制.*$/m);
	const idx = sectionMatch ? readme.indexOf(sectionMatch[0]) : -1;
	if (idx < 0) {
		ck("README 有「已知限制（诚实清单）」章节", false, "");
	} else {
		ck("README 有「已知限制（诚实清单）」章节", true);
		// 取到下一个 `## ` 章节为止（而不是固定 6000 字符）
		const afterIdx = readme.search(/\n##\s*(?!十二)/) > idx ? readme.search(/\n##\s*(?!十二)/) : -1;
		const section = afterIdx > idx ? readme.slice(idx, afterIdx) : readme.slice(idx);

		const EXPECTED = [
			{ name: "写明支持的 3 类标记（其他方言不解析）", re: /只解析 3 类标记|three markup families/i },
			{ name: "上游丢 token 无法检测", re: /丢失输出 token|丢 token/ },
			{ name: "跨版本证据分两类", re: /不可自动复现/ },
			{ name: "绑定特定接缝", re: /llm\/stream/ },
			{ name: "无参数调用不恢复", re: /无参数的文本工具调用不会被恢复/ },
		// **缺陷 131**（第 128 轮）：这条限制一直在行为里存在，但 **README 没写**。
		// 实测裸 `<function=name>`（无 `<tool_call>` 外层）不会被恢复 ——
		// 因为「裸露元素」那条路径只匹配 `<function name="x">` 这种带引号属性的写法。
		// 行为本身是安全的（落到安全网 → EMPTY_RESPONSE → 重试），
		// 但**没写出来就是隐性限制**：用户会以为「写了调用就应该被执行」。
		{ name: "Qwen 裸形态需 tool_call 包裹", re: /Qwen 风格的裸|bare .*function=name.* only inside/ },
			{ name: "处理范围有限", re: /只处理「工具调用被写成文本」/ },
			{ name: "无法保证没有 bug", re: /无法保证「没有 bug」/ },
		];
		let present = 0;
		for (const e of EXPECTED) {
			const ok = e.re.test(section);
			if (ok) present++;
			else console.log(`    ⚠️ 缺失: ${e.name}`);
		}
			// **缺陷 75**：原「其他文本格式不解析」把插件**明确支持**的 `<invoke name=…>`
	// 归入「不解析」，会误导读者。必须写明实际支持哪 3 类。
	ck("已知限制写明支持的 3 类标记", /只解析 3 类标记|three markup families/i.test(section),
		"未写明支持范围");
	ck("已知限制提到 <invoke> 是支持的", /<invoke/.test(section), "");
	ck("已知限制不再笼统说「其他 XML 方言不解析」",
		!/其他文本格式不解析\*\*（如 Markdown 围栏里的工具调用、其他 XML 方言）/.test(section),
		"仍有笼统表述");

	ck("已知限制含全部 7 类", present === EXPECTED.length, `${present}/${EXPECTED.length}`);
		console.log(`  已知限制条目: ${present}/${EXPECTED.length}`);
	}
}

console.log(`\n===== 已知限制真实性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
