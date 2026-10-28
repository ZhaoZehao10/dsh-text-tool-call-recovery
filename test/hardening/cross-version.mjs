// 跨版本兼容性审查
//
// 插件依赖宿主的若干内部约定（BlockAssembler 语义、chunk 协议、
// replayState 形状、stopReason 值域）。宿主升级时这些可能变。
// 本测试检查插件对「宿主行为变化」的容错度：
//   1. 新字段出现（未知 chunk 类型、未知块类型）
//   2. 字段缺失（block 没有 text、finish 没有 reason）
//   3. 协议扩展（新的 usage 字段、新的 replayState 字段）
//   4. 已知的三个版本（0.2.0-rc.2 / 0.2.1-rc.1 / 0.2.1-rc.2）的差异
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };
const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

async function run(label, chunks) {
	plugin.resetStreaks?.();
	const gen = (async function* () { for (const c of chunks) yield c; })();
	let err = null;
	const out = [];
	try {
		for await (const c of listener(OPTS, () => gen)) out.push(c);
	} catch (e) { err = e.message; }
	const fin = out.find((c) => c.type === "finish");
	const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	return { label, err, out, fin, calls };
}

console.log("=== 1. 未知 chunk 类型（宿主新版可能新增）===");
{
	const r = await run("未知 chunk", [
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "text-delta", index: 0, text: "正常" },
		{ type: "brand-new-chunk-type", index: 0, foo: "bar" },
		{ type: "block-end", index: 0, block: { type: "text", text: "正常" } },
		{ type: "finish", reason: { kind: "stop" } },
	]);
	ck("未知 chunk 不崩溃", r.err === null, r.err ?? "");
	ck("未知 chunk 被直通（不吞掉）", r.out.some((c) => c.type === "brand-new-chunk-type"), JSON.stringify(r.out.map((c) => c.type)));
	ck("正常内容不受影响", r.fin?.reason?.kind === "stop");
}

console.log("\n=== 2. 未知块类型（宿主新版可能新增）===");
{
	const r = await run("未知块类型", [
		{ type: "block-start", index: 0, blockType: "brand-new-block" },
		{ type: "block-end", index: 0, block: { type: "brand-new-block", data: 1 } },
		{ type: "block-start", index: 1, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 1, text: OC + "<function=pwsh><parameter=command>echo x</parameter></function>" + CC },
		{ type: "block-end", index: 1, block: { type: "reasoning", text: OC + "<function=pwsh><parameter=command>echo x</parameter></function>" + CC } },
		{ type: "finish", reason: { kind: "stop" } },
	]);
	ck("未知块类型不崩溃", r.err === null, r.err ?? "");
	ck("未知块类型被直通", r.out.some((c) => c.block?.type === "brand-new-block"), JSON.stringify(r.out.map((c) => c.block?.type).filter(Boolean)));
	ck("同时含标记的块仍能恢复", r.calls.length === 1, String(r.calls.length));
}

console.log("\n=== 3. 字段缺失 ===");
{
	const cases = [
		["block-end 缺 block", [
			{ type: "block-start", index: 0, blockType: "text" },
			{ type: "text-delta", index: 0, text: "x" },
			{ type: "block-end", index: 0 },
			{ type: "finish", reason: { kind: "stop" } },
		]],
		["finish 缺 reason", [
			{ type: "block-start", index: 0, blockType: "text" },
			{ type: "text-delta", index: 0, text: "x" },
			{ type: "block-end", index: 0, block: { type: "text", text: "x" } },
			{ type: "finish" },
		]],
		["block 缺 text", [
			{ type: "block-start", index: 0, blockType: "text" },
			{ type: "text-delta", index: 0, text: "x" },
			{ type: "block-end", index: 0, block: { type: "text" } },
			{ type: "finish", reason: { kind: "stop" } },
		]],
		["block.text 是数字", [
			{ type: "block-start", index: 0, blockType: "text" },
			{ type: "text-delta", index: 0, text: "x" },
			{ type: "block-end", index: 0, block: { type: "text", text: 42 } },
			{ type: "finish", reason: { kind: "stop" } },
		]],
		["usage 缺字段", [
			{ type: "block-start", index: 0, blockType: "text" },
			{ type: "text-delta", index: 0, text: "x" },
			{ type: "block-end", index: 0, block: { type: "text", text: "x" } },
			{ type: "usage", usage: {} },
			{ type: "finish", reason: { kind: "stop" } },
		]],
	];
	for (const [label, chunks] of cases) {
		const r = await run(label, chunks);
		ck(`${label} → 不崩溃`, r.err === null, r.err ?? "");
	}
}

console.log("\n=== 4. 协议扩展：新字段不应影响判断 ===");
{
	// 给各 chunk 加宿主动态出现的新字段
	const extra = { __newField: true, futureMeta: { a: 1 } };
	const markup = OC + "<function=pwsh><parameter=command>echo x</parameter></function>" + CC;
	const r = await run("带额外字段", [
		{ ...extra, type: "block-start", index: 0, blockType: "reasoning" },
		{ ...extra, type: "reasoning-delta", index: 0, text: markup },
		{ ...extra, type: "block-end", index: 0, block: { ...extra, type: "reasoning", text: markup } },
		{ ...extra, type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, __newTokenKind: 5 } },
		{ ...extra, type: "finish", reason: { kind: "stop", __newReason: "x" }, replayState: { response: { stopReason: "stop", __newField: 1 }, blocks: [{ type: "reasoning" }] } },
	]);
	ck("额外字段不崩溃", r.err === null, r.err ?? "");
	ck("额外字段下仍能恢复", r.calls.length === 1, String(r.calls.length));
	ck("finish 改为 tool-calls", r.fin?.reason?.kind === "tool-calls", JSON.stringify(r.fin?.reason));
	// 额外字段应被保留（不主动剥离）
	ck("合成的块保留额外字段（不主动剥离）", r.out.some((c) => c.type === "block-start" && c.__newField === true), "");
}

console.log("\n=== 5. replayState 新形状 ===");
{
	const cases = [
		["replayState 多新字段", { response: { kind: "pi-ai", version: 3, stopReason: "stop", __v3: true }, blocks: [{ type: "reasoning" }], __newSection: {} }],
		["blocks 里带新字段", { response: { stopReason: "stop" }, blocks: [{ type: "reasoning", thinkingSignature: "x", __new: 1 }] }],
		["version 是字符串", { response: { version: "2", stopReason: "stop" }, blocks: [] }],
	];
	const markup = OC + "<function=pwsh><parameter=command>echo x</parameter></function>" + CC;
	for (const [label, rs] of cases) {
		const r = await run(label, [
			{ type: "block-start", index: 0, blockType: "reasoning" },
			{ type: "reasoning-delta", index: 0, text: markup },
			{ type: "block-end", index: 0, block: { type: "reasoning", text: markup } },
			{ type: "finish", reason: { kind: "stop" }, replayState: rs },
		]);
		ck(`${label} → 不崩溃`, r.err === null, r.err ?? "");
		ck(`${label} → 仍恢复`, r.calls.length === 1, String(r.calls.length));
	}
}

console.log("\n=== 6. 三个已知宿主版本的协议差异 ===");
{
	// 0.2.0-rc.2：finish.reason.kind 用 "tool-calls"
	// 0.2.1-rc.x：同上；replayState.response.stopReason 用 "toolUse"
	// 差异点：stopReason 值域。插件应兼容两种。
	const markup = OC + "<function=pwsh><parameter=command>echo x</parameter></function>" + CC;
	for (const stopReason of ["stop", "toolUse", "tool_calls", "end_turn", undefined]) {
		const r = await run(`stopReason=${stopReason}`, [
			{ type: "block-start", index: 0, blockType: "reasoning" },
			{ type: "reasoning-delta", index: 0, text: markup },
			{ type: "block-end", index: 0, block: { type: "reasoning", text: markup } },
			{ type: "finish", reason: { kind: "stop" }, replayState: { response: { stopReason }, blocks: [{ type: "reasoning" }] } },
		]);
		ck(`旧 replayState.stopReason=${stopReason} → 仍能恢复`, r.calls.length === 1, String(r.calls.length));
		const newStop = r.fin?.replayState?.response?.stopReason;
		ck(`  → 改写为宿主认可的 toolUse`, newStop === "toolUse", String(newStop));
	}
}

console.log("\n=== 7. 极端：完全未知的 finish.reason.kind ===");
{
	const markup = OC + "<function=pwsh><parameter=command>echo x</parameter></function>" + CC;
	for (const kind of ["brand-new-reason", "", null]) {
		const r = await run(`kind=${JSON.stringify(kind)}`, [
			{ type: "block-start", index: 0, blockType: "reasoning" },
			{ type: "reasoning-delta", index: 0, text: markup },
			{ type: "block-end", index: 0, block: { type: "reasoning", text: markup } },
			{ type: "finish", reason: { kind } },
		]);
		ck(`未知 finish.kind=${JSON.stringify(kind)} → 不崩溃`, r.err === null, r.err ?? "");
		// 未知 kind 应视为"非 stop" → 原样放行（不恢复）
		ck(`未知 finish.kind → 原样放行（不恢复）`, r.calls.length === 0, String(r.calls.length));
	}
}

console.log(`\n===== 跨版本兼容性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
