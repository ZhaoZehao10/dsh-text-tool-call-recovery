// 幂等性与确定性审查
//
// 插件必须满足：
//   1. **同一输入多次处理结果完全一致**（除合成 id 外）—— 否则用户重试会得到不同结果
//   2. **处理顺序无关**：连续处理 N 条流后，输出不受前序影响
//   3. **无隐藏全局状态**：两个独立实例处理同一输入结果相同
//   4. **合成 id 稳定**：同内容应生成同 id（便于去重与追溯）
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

const mkCall = (cmd) => OC + "\n<function=pwsh>\n<parameter=command>\n" + cmd + "\n</parameter>\n</function>\n" + CC;

function makeStream(text) {
	return (async function* () {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "text", text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
}

async function runWith(plugin, text) {
	const out = [];
	for await (const c of pluginListener(plugin, text)) out.push(c);
	return out;
}

let cachedListener = null;
function pluginListener(plugin, text) {
	cachedListener = null;
	plugin.apply({ on: (e, h) => { if (e === "llm/stream") cachedListener = h; } });
	const gen = makeStream(text);
	return cachedListener(OPTS, () => gen);
}

/** 把输出序列化用于比较（忽略 txtcall id 里的 ordinal 后缀） */
function fingerprint(out) {
	return JSON.stringify(out.map((c) => {
		if (c.type === "block-end" && c.block?.type === "tool-call") {
			return { t: c.type, type: c.block.type, name: c.block.name, args: c.block.arguments, idKind: String(c.block.id).replace(/-\d+$/, "") };
		}
		if (c.block) return { t: c.type, i: c.index, b: { type: c.block.type, text: c.block.text, name: c.block.name, arguments: c.block.arguments } };
		if (c.type === "finish") return { t: c.type, kind: c.reason?.kind, replay: c.replayState ? "yes" : "no" };
		if (c.type === "usage") return { t: c.type, usage: c.usage };
		return { t: c.type, i: c.index, text: c.text, bt: c.blockType };
	}));
}

const p1 = await import(pathToFileURL(LIB).href + "?idem1=" + Date.now());

console.log("=== 1. 同一输入连续处理 20 次，结果必须完全一致 ===");
{
	const text = "说明文字。" + mkCall("echo hi") + "补充说明。";
	const first = fingerprint(await runWith(p1, text));
	let mismatches = 0;
	for (let i = 0; i < 20; i++) {
		const f = fingerprint(await runWith(p1, text));
		if (f !== first) { mismatches++; if (mismatches <= 1) console.log(`  第 ${i + 2} 次不一致:\n    ${f.slice(0, 200)}\n    ${first.slice(0, 200)}`); }
	}
	ck("20 次处理结果完全一致", mismatches === 0, `${mismatches} 次不一致`);
}

console.log("\n=== 2. 处理顺序无关（先跑其他流不影响结果）===");
{
	const target = "目标文本。" + mkCall("ls") + "结束。";
	const baseline = fingerprint(await runWith(p1, target));

	// 插入各种干扰流
	const noise = [
		mkCall("rm -rf /"),
		"纯文本",
		OC + CC,
		mkCall("echo a") + mkCall("echo b"),
		"",
	];
	for (const n of noise) await runWith(p1, n);

	const after = fingerprint(await runWith(p1, target));
	ck("干扰流后结果仍一致", after === baseline, "结果变化");

	// 再跑 100 次干扰
	for (let i = 0; i < 100; i++) await runWith(p1, i % 2 ? mkCall("echo " + i) : "文本" + i);
	const after2 = fingerprint(await runWith(p1, target));
	ck("100 次干扰后结果仍一致", after2 === baseline, "结果变化");
}

console.log("\n=== 3. 不同模块实例处理同一输入结果相同 ===");
{
	const p2 = await import(pathToFileURL(LIB).href + "?idem2=" + Date.now());
	const text = "跨实例测试。" + mkCall("echo cross");
	const f1 = fingerprint(await runWith(p1, text));
	const f2 = fingerprint(await runWith(p2, text));
	ck("两个模块实例结果一致", f1 === f2, `不一致`);
}

console.log("\n=== 4. 合成 id 稳定性（同内容 → 同 hash 前缀）===");
{
	const text = mkCall("echo stable");
	const r1 = await runWith(p1, text);
	const r2 = await runWith(p1, text);
	const id1 = r1.find((c) => c.block?.type === "tool-call")?.block?.id;
	const id2 = r2.find((c) => c.block?.type === "tool-call")?.block?.id;
	console.log(`  id1 = ${id1}`);
	console.log(`  id2 = ${id2}`);
	const hash1 = String(id1).replace(/-\d+$/, "");
	const hash2 = String(id2).replace(/-\d+$/, "");
	ck("同内容 → 同 id hash（可去重）", hash1 === hash2, `${hash1} vs ${hash2}`);

	// 不同内容 → 不同 hash
	const r3 = await runWith(p1, mkCall("echo different"));
	const id3 = r3.find((c) => c.block?.type === "tool-call")?.block?.id;
	const hash3 = String(id3).replace(/-\d+$/, "");
	ck("不同内容 → 不同 id hash", hash1 !== hash3, `${hash1} vs ${hash3}`);
}

console.log("\n=== 5. 多调用的 ordinal 顺序稳定 ===");
{
	const text = mkCall("echo a") + "\n" + mkCall("echo b") + "\n" + mkCall("echo c");
	const r = await runWith(p1, text);
	const ids = r.filter((c) => c.block?.type === "tool-call").map((c) => c.block.id);
	console.log(`  ids = ${JSON.stringify(ids)}`);
	ck("恢复 3 个调用", ids.length === 3, String(ids.length));
	// ordinal 应为 0,1,2
	const ordinals = ids.map((id) => Number(String(id).split("-").pop()));
	ck("ordinal 递增且从 0 开始", JSON.stringify(ordinals) === JSON.stringify([0, 1, 2]), JSON.stringify(ordinals));
}

console.log("\n=== 6. 并发处理（Promise.all 交错）结果正确 ===");
{
	// 同时发起多个流，交错消费
	const texts = Array.from({ length: 10 }, (_, i) => "流" + i + "：" + mkCall("echo " + i));
	const listeners = texts.map(() => {
		let l = null;
		p1.apply({ on: (e, h) => { if (e === "llm/stream") l = h; } });
		return l;
	});
	const iters = texts.map((t, i) => listeners[i](OPTS, () => makeStream(t)));

	// 交错消费
	const results = texts.map(() => []);
	let done = texts.map(() => false);
	while (done.some((d) => !d)) {
		for (let i = 0; i < iters.length; i++) {
			if (done[i]) continue;
			const r = await iters[i].next();
			if (r.done) done[i] = true;
			else results[i].push(r.value);
		}
	}

	let bad = 0;
	for (let i = 0; i < texts.length; i++) {
		const calls = results[i].filter((c) => c.block?.type === "tool-call");
		const txt = results[i].filter((c) => c.type === "block-end" && c.block?.type === "text").map((c) => c.block.text).join("");
		let args = null;
		try { args = JSON.parse(calls[0]?.block?.arguments ?? "null"); } catch { /* ignore */ }
		if (calls.length !== 1) { bad++; console.log(`  流 ${i}: 调用数 ${calls.length}（应为 1）`); }
		else if (args?.command !== "echo " + i) { bad++; console.log(`  流 ${i}: 参数 ${JSON.stringify(args)}（应为 echo ${i}）`); }
		else if (!txt.includes("流" + i + "：")) { bad++; console.log(`  流 ${i}: 文本 ${JSON.stringify(txt)} 丢了前缀`); }
	}
	ck("10 个并发流各自结果正确（无串味）", bad === 0, `${bad} 个错误`);
}

console.log("\n=== 7. 空响应计数不污染正常流 ===");
{
	// 先让某个模型进入"连续空响应"状态
	const emptyStream = () => (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "只有思考" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	let l = null;
	p1.apply({ on: (e, h) => { if (e === "llm/stream") l = h; } });
	for (let i = 0; i < 5; i++) {
		for await (const c of l({ ...OPTS, model: "polluted-model" }, emptyStream)) { /* consume */ }
	}

	// 再用同模型跑一条正常流（应不受影响）
	let l2 = null;
	p1.apply({ on: (e, h) => { if (e === "llm/stream") l2 = h; } });
	const out = [];
	for await (const c of l2({ ...OPTS, model: "polluted-model" }, () => makeStream("正常内容。"))) out.push(c);
	const fin = out.find((c) => c.type === "finish");
	ck("空响应计数不影响正常流", fin?.reason?.kind === "stop", JSON.stringify(fin?.reason));
}

console.log(`\n===== 幂等与确定性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
