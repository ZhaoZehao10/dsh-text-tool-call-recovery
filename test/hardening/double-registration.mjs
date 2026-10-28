// 重复注册（apply() 被调用多次）的行为验证
//
// 为什么需要（第 117 轮）：
// apply(ctx) 里没有重复注册保护 —— 每次调用都 ctx.on("llm/stream", ...)。
// 宿主在以下情况可能重复调用 apply()：
//   · 插件被热重载（开发时改了源码）
//   · profile 里同一个包被列了两次
//   · Cordis 的 group / isolate 组合导致同一插件挂载多次
//
// 如果重复注册会造成重复执行（同一条 rm 跑两次）或状态被消费两次
// （缺陷 54 的「确定性失败空转」保护失效），后果都很严重。
//
// 本套件验证（9 项）：
//   1. apply() 调用 N 次就注册 N 个监听器（确认没有静默去重）
//   2. 双层包装下恢复不重复（内层恢复出 tool-call 后，外层 sawToolCall 放行）
//   3. 1/2/3 层包装下 streak 行为完全一致（第 1 次 error，后续透传）
//   4. 多层包装的性能线性（只记录趋势，不做硬断言 —— 见缺陷 104 的教训）
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

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href + "?dbl=" + Date.now());
const { BlockAssembler } = await import(pathToFileURL(LLM).href);

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
	if (ok) { pass++; console.log("  OK  " + label); }
	else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("  FAIL " + label + (detail ? " :: " + detail : "")); }
};

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

function assemble(chunks) {
	const asm = new BlockAssembler();
	for (const c of chunks) asm.push(c);
	return asm.assembled();
}

function extractCalls(assembled) {
	const calls = [];
	for (const b of assembled.blocks ?? []) {
		if (b.type !== "tool-call") continue;
		let args;
		try { args = typeof b.arguments === "string" ? JSON.parse(b.arguments) : b.arguments; } catch { args = {}; }
		calls.push({ name: b.name, args });
	}
	return calls;
}

async function runWith(listeners, chunks, model) {
	let stream = (async function* () { for (const c of chunks) yield c; })();
	for (let i = listeners.length - 1; i >= 0; i--) {
		const prev = stream;
		stream = await listeners[i]({ provider: "p", model, messages: [], tools: TOOLS }, () => prev);
	}
	const out = [];
	for await (const c of stream) out.push(c);
	return out;
}

function makeListeners(n) {
	const ls = [];
	for (let i = 0; i < n; i++) mod.apply({ on: (e, h) => { if (e === "llm/stream") ls.push(h); } });
	return ls;
}

const xml = OC + "\n<function=pwsh>\n<parameter=command>\necho x\n</parameter>\n</function>\n" + CC;
const recoverChunks = [
	{ type: "block-start", index: 0, blockType: "reasoning" },
	{ type: "reasoning-delta", index: 0, text: xml },
	{ type: "block-end", index: 0, block: { type: "reasoning", text: xml } },
	{ type: "finish", reason: { kind: "stop" } },
];
const emptyChunks = [
	{ type: "block-start", index: 0, blockType: "reasoning" },
	{ type: "reasoning-delta", index: 0, text: "只有思考" },
	{ type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } },
	{ type: "finish", reason: { kind: "stop" } },
];

console.log("=== 1. apply() 调用 N 次就注册 N 个监听器（无静默去重）===");
for (const n of [1, 2, 3]) {
	const ls = makeListeners(n);
	ck("apply() " + n + " 次 -> " + ls.length + " 个监听器", ls.length === n, "实际 " + ls.length);
}

console.log("=== 2. 双层包装下恢复不重复 ===");
{
	mod.resetStreaks?.();
	const out = await runWith(makeListeners(2), recoverChunks, "d2r-" + Date.now());
	const calls = extractCalls(assemble(out));
	ck("双层下只恢复 1 个调用", calls.length === 1, JSON.stringify(calls));
	ck("双层下 chunk 数仍为 7", out.length === 7, String(out.length));
}

console.log("=== 3. 1/2/3 层包装下 streak 行为一致 ===");
for (const n of [1, 2, 3]) {
	mod.resetStreaks?.();
	const ls = makeListeners(n);
	const model = n + "layer-" + Date.now() + "-" + Math.random();
	const seq = [];
	for (let k = 1; k <= 3; k++) {
		const out = await runWith(ls, emptyChunks, model);
		const f = out.find((c) => c.type === "finish");
		seq.push(f?.reason?.kind === "error" ? "error" : "passthrough");
	}
	console.log("  " + n + " 层: " + seq.join(" -> "));
	ck(n + " 层包装下 streak 行为正确",
		seq[0] === "error" && seq[1] === "passthrough" && seq[2] === "passthrough",
		seq.join(" -> "));
}

console.log("=== 4. 多层包装的性能（只记录趋势，不做硬断言）===");
{
	const times = [];
	for (const n of [1, 2, 5, 10]) {
		const ls = makeListeners(n);
		const t0 = performance.now();
		for (let k = 0; k < 20; k++) await runWith(ls, recoverChunks, "perf-" + Date.now() + "-" + k);
		const per = (performance.now() - t0) / 20;
		times.push(per);
		console.log("  " + n + " 层: 每次 " + per.toFixed(3) + "ms");
	}
	ck("10 层包装下每请求仍 < 5ms（宽松上限）", times[times.length - 1] < 5,
		times[times.length - 1].toFixed(3) + "ms");
	console.log("  -> 层数越多越慢（线性），无去重保护时会累积到进程重启");
}

console.log("");
console.log("===== 重复注册行为: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("--- 失败明细 ---");
	for (const f of failures) console.log("  FAIL " + f);
}
process.exit(fail === 0 ? 0 : 1);