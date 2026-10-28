// 加固 3：ReDoS / 性能测试
// 目标：extractCalls 里的正则在恶意/极端输入下是否会灾难性回溯（指数级耗时），
// 从而拖死模型流。这是插件挂在 llm/stream 接缝上的真实风险。
import fs from "node:fs";

const pluginPath = new URL("../../lib/index.js", import.meta.url).pathname.replace(/^\//, "");
const plugin = await import("file:///" + pluginPath.replace(/\\/g, "/"));
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [{ name: "pwsh", description: "x", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>", CC = "</" + "tool_call>";
const OF = "<" + "function=pwsh>", CF = "</" + "function>";
const OP = "<" + "parameter=command>", CP = "</" + "parameter>";

async function timeRun(text) {
	const src = (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "text", text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	const t0 = process.hrtime.bigint();
	let chunks = 0;
	for await (const _ of listener(OPTS, () => src)) chunks++;
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	return { ms, chunks };
}

let fail = 0;
const LIMIT_MS = 2000;  // 单次处理超过 2 秒视为异常
async function check(label, text) {
	const { ms } = await timeRun(text);
	const ok = ms < LIMIT_MS;
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}: ${ms.toFixed(1)}ms (len=${text.length})`);
	if (!ok) fail++;
	return ms;
}

console.log("=== A. 未闭合标记（灾难性回溯经典触发点）===");
for (const n of [1000, 5000, 20000, 50000]) {
	await check(`${n} 个 "<" 无闭合`, "<".repeat(n));
	await check(`${n} 个未闭合 tool_call`, (OC).repeat(n));
	await check(`${n} 个未闭合 parameter`, (OP).repeat(n));
	await check(`${n} 个未闭合 function`, (OF).repeat(n));
}

console.log("\n=== B. 嵌套/重复开头标记 ===");
for (const n of [1000, 5000, 20000]) {
	await check(`${n} 层嵌套 tool_call 开头`, (OC + OF + OP).repeat(n));
	await check(`${n} 个 "parameter name=" 无值`, ("<" + "parameter name=").repeat(n));
	await check(`${n} 个 antml 开头`, ("<" + "antml:function name=\"pwsh\">").repeat(n));
}

console.log("\n=== C. 超长单块（合法但极大）===");
{
	const big = OC + "\n" + OF + "\n" + OP + "\n" + "x".repeat(500000) + "\n" + CP + "\n" + CF + "\n" + CC;
	await check("500KB 单参数值", big);
	const many = Array.from({ length: 2000 }, (_, i) => OC + "\n" + OF + "\n" + OP + "\necho " + i + "\n" + CP + "\n" + CF + "\n" + CC).join("\n");
	await check("2000 个完整调用", many);
}

console.log("\n=== D. 病态模式（正则回溯陷阱）===");
for (const n of [1000, 5000, 20000]) {
	await check(n + " 个 comment-open", "<!--".repeat(n));
	await check(n + " 个 triple-backtick", "```".repeat(n));
	await check(n + " 个 pipe", "|".repeat(n));
	await check(n + " 个 backtick", "`".repeat(n));
	await check(n + " 个 tag-open", "<a".repeat(n));
	await check(n + " 个 tag-close", "</".repeat(n));
}

console.log("\n=== E. 混合病态（标记 + 围栏 + 超长）===");
{
	const mixed = (OC + "```" + OF + "<".repeat(100) + OP).repeat(2000);
	await check("2000 组混合病态", mixed);
	const fences = ("```xml\n" + OC + "\n").repeat(3000);
	await check("3000 个未闭合围栏", fences);
}

console.log("\n=== F. 正常大输入基线（对照）===");
{
	await check("100KB 普通文本", "正常文本内容。".repeat(10000));
	const normalCalls = Array.from({ length: 500 }, (_, i) => OC + "\n" + OF + "\n" + OP + "\necho " + i + "\n" + CP + "\n" + CF + "\n" + CC).join("\n");
	await check("500 个正常调用", normalCalls);
}

console.log("\n=== G. 超长文本必须放弃恢复（MAX_SCAN_CHARS 保护）===");
{
	// **行为断言**：超过 128K 的文本必须放弃恢复（原样放行）。
	// 若移除了 MAX_SCAN_CHARS 上限（两处），下面第一个断言就会失败——
	// 因为它会去解析那个完整可解析的标记并恢复出调用。
	const OC2 = "<" + "tool_call>", CC2 = "</" + "tool_call>";
	const OF2 = "<" + "function=pwsh>", CF2 = "</" + "function>";
	const OP2 = "<" + "parameter=command>", CP2 = "</" + "parameter>";
	const markup = OC2 + "\n" + OF2 + "\n" + OP2 + "\necho big\n" + CP2 + "\n" + CF2 + "\n" + CC2;

	const runOne = async (text) => {
		const src = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		const out = [];
		for await (const c of listener(OPTS, () => src)) out.push(c);
		return {
			recovered: out.some((c) => c.type === "block-start" && c.blockType === "tool-call"),
			finish: out.find((c) => c.type === "finish")?.reason?.kind,
		};
	};

	// 超过上限（~150K > 128K）：必须不恢复
	const huge = markup + "\n" + "填充内容。".repeat(30000);
	{
		const r = await runOne(huge);
		const ok = !r.recovered;
		console.log(`  ${ok ? "PASS" : "FAIL"} 超上限文本（${huge.length} 字符）放弃恢复`);
		if (!ok) fail++;
	}
	// 上限内（~100K）：必须能恢复（确认上限没有误伤正常大文本）
	const bordered = markup + "\n" + "填充内容。".repeat(20000);
	{
		const r = await runOne(bordered);
		const ok = r.recovered;
		console.log(`  ${ok ? "PASS" : "FAIL"} 上限内大文本（${bordered.length} 字符）仍能恢复`);
		if (!ok) fail++;
	}
	// 病态超大输入（不恢复 + 必须快速）
	{
		const pathological = ("<" + "parameter name=").repeat(20000);
		const t0 = process.hrtime.bigint();
		await runOne(pathological);
		const ms = Number(process.hrtime.bigint() - t0) / 1e6;
		const ok = ms < 2000;
		console.log(`  ${ok ? "PASS" : "FAIL"} 病态超大输入 ${pathological.length} 字符耗时 ${ms.toFixed(0)}ms < 2000ms`);
		if (!ok) fail++;
	}
}

console.log(`\n===== ReDoS/性能测试: ${fail === 0 ? "全部通过" : fail + " 项失败"} =====`);
process.exit(fail === 0 ? 0 : 1);
