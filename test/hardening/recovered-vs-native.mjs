// 恢复出来的调用 == 原生结构化调用（等价性證明）
//
// **为什么需要**（缺陷 109，第 111 轮）：
// `recovered-ab-consistency.mjs` 验证的是「**A/B 两条消费路径**对同一个恢复结果
// 装配是否一致」（实时 BlockAssembler vs 持久化 Accumulator）。
//
// 但那**不是**插件最根本的承诺。插件最根本的承诺是：
//
//   > **从 XML 文本恢复出来的调用，必须与模型直接给出结构化 `tool_calls` 时
//   > 得到的结果无法区分。**
//
// 否则：用户在 step-5-preview 上看到的工具调用行为，与在别的模型上看到的会不同 ——
// 这是最影响信任的隐性 bug，而且**从未被直接验证过**。
//
// 本套件用**真实的 BlockAssembler** 分别装配两条路径，然后逐字段比对：
//   路径 A（原生）：block-start{tool-call} + tool-call-delta{argumentsDelta=JSON}
//                    + block-end{tool-call, arguments=JSON}
//   路径 B（恢复）：reasoning-delta 里塞 XML 文本 → 插件恢复 → tool-call 块
//
// 断言：两边的 `{ name, args }` 数组**深度相等**（含类型：number/boolean 不能被强转成 string）。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

const LLM = (() => {
	const candidates = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(process.cwd(), "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
	].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(c)) return c;
	console.error("找不到 dsh-llm：请设置 DSH_LLM_SRC");
	process.exit(1);
})();

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href + "?rvn=" + Date.now());
let listener;
mod.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const { BlockAssembler } = await import(pathToFileURL(LLM).href);

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
	if (ok) { pass++; console.log("  ✅ " + label); }
	else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("  ❌ " + label + (detail ? " :: " + detail : "")); }
};
ck("插件注册了 llm/stream 监听器", typeof listener === "function");
ck("拿到宿主真实的 BlockAssembler", typeof BlockAssembler === "function");

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const OF = (n) => "<" + "function=" + n + ">";
const CF = "</" + "function>";
const OP = (k) => "<" + "parameter=" + k + ">";

const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: {
		command: { type: "string" }, timeout_ms: { type: "number" }, force: { type: "boolean" },
	} } },
	{ name: "read", parameters: { type: "object", properties: { file_path: { type: "string" } } } },
];

async function runPlugin(chunks) {
	mod.resetStreaks?.();
	const out = [];
	const gen = (async function* () { for (const c of chunks) yield c; })();
	const stream = await listener({ provider: "p", model: "rvn-" + Math.random(), messages: [], tools: TOOLS }, () => gen);
	for await (const c of stream) out.push(c);
	return out;
}

/** 用真实的 BlockAssembler 装配。 */
function assemble(chunks) {
	const asm = new BlockAssembler();
	for (const c of chunks) asm.push(c);
	return asm.assembled();
}

/** 把装配结果里的 tool-call 块标准化成可比较的 { name, args } 数组。 */
function extractCalls(assembled) {
	const calls = [];
	for (const b of assembled.blocks ?? []) {
		if (b.type !== "tool-call") continue;
		let args;
		if (typeof b.arguments === "string") {
			try { args = JSON.parse(b.arguments); } catch { args = { __raw: b.arguments }; }
		} else args = b.arguments;
		calls.push({ name: b.name, args });
	}
	return calls;
}

/** 把 XML 文本包装成一条「只有 reasoning」的流（模拟 step-5-preview 的形态）。 */
async function recoverFrom(text) {
	return runPlugin([
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text },
		{ type: "block-end", index: 0, block: { type: "reasoning", text } },
		{ type: "finish", reason: { kind: "stop" } },
	]);
}

/** 构造一条原生结构化 tool-call 流。 */
function nativeStream(calls) {
	const chunks = [];
	calls.forEach((c, i) => {
		const json = JSON.stringify(c.args);
		chunks.push({ type: "block-start", index: i, blockType: "tool-call" });
		chunks.push({ type: "tool-call-delta", index: i, id: "native-" + i, name: c.name, argumentsDelta: json });
		chunks.push({ type: "block-end", index: i, block: { type: "tool-call", id: "native-" + i, name: c.name, arguments: json } });
	});
	chunks.push({ type: "finish", reason: { kind: "tool-calls" } });
	return chunks;
}

function toXml(calls) {
	return calls.map((c) =>
		OC + "\n" + OF(c.name) + "\n" +
		Object.entries(c.args).map(([k, v]) => OP(k) + "\n" + String(v) + "\n</parameter>\n").join("") +
		CF + "\n" + CC
	).join("\n");
}

/** 核心断言：给定调用列表，比较原生装配结果 vs 恢复装配结果。 */
async function assertEquivalent(label, calls) {
	console.log("=== " + label + " ===");
	const nativeCalls = extractCalls(assemble(nativeStream(calls)));
	const recoveredCalls = extractCalls(assemble(await recoverFrom(toXml(calls))));
	console.log("  原生:   " + JSON.stringify(nativeCalls));
	console.log("  恢复后: " + JSON.stringify(recoveredCalls));
	ck(label + ": 调用数量一致", nativeCalls.length === recoveredCalls.length, nativeCalls.length + " vs " + recoveredCalls.length);
	ck(label + ": 逐字段深度相等（含类型）",
		JSON.stringify(nativeCalls) === JSON.stringify(recoveredCalls),
		JSON.stringify(nativeCalls) + " vs " + JSON.stringify(recoveredCalls));
}

await assertEquivalent("1. 单参数文本", [{ name: "pwsh", args: { command: "echo hello" } }]);
await assertEquivalent("2. 多参数含类型强转", [{ name: "pwsh", args: { command: "dir", timeout_ms: 30000, force: true } }]);
await assertEquivalent("3. 两个调用（顺序敏感）", [
	{ name: "pwsh", args: { command: "echo A" } },
	{ name: "read", args: { file_path: "/a.txt" } },
]);

console.log("=== 4. 类型强转单独验证 ===");
{
	const recoveredCalls = extractCalls(assemble(await recoverFrom(toXml([
		{ name: "pwsh", args: { command: "dir", timeout_ms: 30000, force: true } },
	]))));
	ck("timeout_ms 是 number 而不是字符串", typeof recoveredCalls[0]?.args?.timeout_ms === "number", typeof recoveredCalls[0]?.args?.timeout_ms);
	ck("force 是 boolean 而不是字符串", typeof recoveredCalls[0]?.args?.force === "boolean", typeof recoveredCalls[0]?.args?.force);
	ck("command 仍是 string", typeof recoveredCalls[0]?.args?.command === "string", typeof recoveredCalls[0]?.args?.command);
}

console.log("\n===== 恢复 vs 原生等价性: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log("  ❌ " + f);
}
process.exit(fail === 0 ? 0 : 1);