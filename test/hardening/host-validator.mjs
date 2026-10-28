// 宿主协议校验器专项验证
//
// 宿主的 AssistantStreamAccumulator.push / assembleAssistantStream 内部有大量
// TypeError 断言（协议不变量）。这些断言是**比 BlockAssembler 更严格**的校验：
//   - time 必须是 safe integer
//   - index 必须是非负 safe integer
//   - chunk 必须可无损 JSON 序列化
//   - text 必须是 string
//   - tool-call-delta 的 id/name/argumentsDelta 必须是 string
//   - compact record 的 texts/args 必须非空等
//
// 插件输出必须能**原样通过**这些断言，否则真实运行时会在持久化阶段报错。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LLM = (() => {
	const cands = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
	].filter(Boolean);
	for (const c of cands) if (fs.existsSync(c)) return c;
	return null;
})();
if (LLM === null) { console.log("跳过：找不到 dsh-llm"); process.exit(0); }

const {
	BlockAssembler,
	AssistantStreamAccumulator,
	assembleAssistantStream,
	expandAssistantStream,
	createAssistantMessage,
} = await import(pathToFileURL(LLM).href);

const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href + "?inv=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } },
	{ name: "read", parameters: { type: "object", properties: { file_path: { type: "string" }, limit: { type: "number" } } } },
];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };

const mkCall = (tool, params) => {
	const body = Object.entries(params).map(([k, v]) => "<parameter=" + k + ">\n" + v + "\n</parameter>").join("\n");
	return OC + "\n<function=" + tool + ">\n" + body + "\n</function>\n" + CC;
};

async function produce(text, blockType = "reasoning") {
	plugin.resetStreaks?.();
	const out = [];
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType };
		yield { type: blockType === "text" ? "text-delta" : "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: blockType, text } };
		yield { type: "usage", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	for await (const c of listener(OPTS, () => gen)) out.push(c);
	return out;
}

/** 完整走一遍宿主的校验链：累加器 → 紧凑记录 → 回放 → 装配 → 消息构造 */
function validateAll(out) {
	const steps = [];
	// 1) 逐 chunk 喂进累加器（内部有 TypeErrors）
	const acc = new AssistantStreamAccumulator();
	let t = 1700000000000;
	try {
		for (const c of out) { acc.push({ time: t, chunk: c }); t += 1; }
		steps.push({ name: "accumulator.push", ok: true });
	} catch (e) {
		steps.push({ name: "accumulator.push", ok: false, err: e.message });
		return steps;
	}

	// 2) snapshot → 紧凑记录
	let snap;
	try {
		snap = acc.snapshot();
		steps.push({ name: "snapshot", ok: true, count: snap.length });
	} catch (e) {
		steps.push({ name: "snapshot", ok: false, err: e.message });
		return steps;
	}

	// 3) expandAssistantStream（反序列化紧凑记录）
	let expanded;
	try {
		expanded = expandAssistantStream(snap);
		steps.push({ name: "expandAssistantStream", ok: true, count: expanded.length });
	} catch (e) {
		steps.push({ name: "expandAssistantStream", ok: false, err: e.message });
		return steps;
	}

	// 4) assembleAssistantStream（内部断言）
	let assembled;
	try {
		assembled = assembleAssistantStream(snap).assembled();
		steps.push({ name: "assembleAssistantStream", ok: true, blocks: assembled.blocks.length });
	} catch (e) {
		steps.push({ name: "assembleAssistantStream", ok: false, err: e.message });
		return steps;
	}

	// 5) BlockAssembler（实时路径）
	let live;
	try {
		const asm = new BlockAssembler();
		for (const c of out) asm.push(c);
		live = asm.assembled();
		steps.push({ name: "BlockAssembler", ok: true, blocks: live.blocks.length });
	} catch (e) {
		steps.push({ name: "BlockAssembler", ok: false, err: e.message });
		return steps;
	}

	// 6) 实时与回放必须一致
	const fmt = (r) => JSON.stringify(r.blocks.map((b) => ({ t: b.type, n: b.name, a: b.arguments, x: b.text })));
	steps.push({ name: "live==replay", ok: fmt(live) === fmt(assembled), detail: fmt(live) === fmt(assembled) ? "" : `${fmt(live).slice(0, 100)} vs ${fmt(assembled).slice(0, 100)}` });

	// 7) 消息构造
	try {
		const msg = createAssistantMessage({ content: live.blocks });
		steps.push({ name: "createAssistantMessage", ok: true, blocks: (msg.content ?? []).length });
	} catch (e) {
		steps.push({ name: "createAssistantMessage", ok: false, err: e.message });
	}

	return steps;
}

console.log("=== 1. 各类插件输出通过宿主全部校验 ===");
{
	const cases = [
		["单选调用（reasoning 块）", mkCall("pwsh", { command: "echo hi" }), "reasoning"],
		["单选调用（text 块）", mkCall("pwsh", { command: "echo hi" }), "text"],
		["多调用", mkCall("pwsh", { command: "echo a" }) + "\n" + mkCall("read", { file_path: "/x", limit: "10" }), "reasoning"],
		["正文 + 调用", "说明文字。" + mkCall("pwsh", { command: "ls" }) + "补充。", "text"],
		["无标记（直通）", "普通回复内容。", "text"],
		["纯标记（空响应）", OC + CC, "reasoning"],
		["含特殊字符", mkCall("pwsh", { command: "echo 🎉 中文" }), "reasoning"],
		["长参数值", mkCall("pwsh", { command: "x".repeat(5000) }), "reasoning"],
	];

	for (const [label, text, bt] of cases) {
		const out = await produce(text, bt);
		const steps = validateAll(out);
		const failed = steps.filter((s) => !s.ok);
		if (failed.length > 0) {
			console.log(`  ❌ ${label}`);
			for (const f of failed) console.log(`      ${f.name}: ${f.err ?? f.detail}`);
		} else {
			console.log(`  ✅ ${label}（${steps.length} 步全过）`);
		}
		ck(`${label} 通过宿主全部校验`, failed.length === 0, failed.map((f) => f.name + ":" + (f.err ?? f.detail)).join("; "));
	}
}

console.log("\n=== 2. 合成块的每个字段都能通过类型断言 ===");
{
	const out = await produce(mkCall("pwsh", { command: "echo typecheck" }));
	const tc = out.find((c) => c.type === "block-end" && c.block?.type === "tool-call");
	console.log(`  合成块: ${JSON.stringify(tc?.block)}`);
	ck("block.type 是 'tool-call'", tc?.block?.type === "tool-call", String(tc?.block?.type));
	ck("block.id 是 string", typeof tc?.block?.id === "string", typeof tc?.block?.id);
	ck("block.id 非空", (tc?.block?.id ?? "").length > 0, "");
	ck("block.name 是 string", typeof tc?.block?.name === "string", typeof tc?.block?.name);
	ck("block.name 非空", (tc?.block?.name ?? "").length > 0, "");
	ck("block.arguments 是 string", typeof tc?.block?.arguments === "string", typeof tc?.block?.arguments);
	ck("block.arguments 是合法 JSON", (() => { try { JSON.parse(tc?.block?.arguments); return true; } catch { return false; } })(), tc?.block?.arguments);

	// tool-call-delta 的三个字符串字段
	const delta = out.find((c) => c.type === "tool-call-delta");
	console.log(`  delta: ${JSON.stringify(delta)}`);
	ck("delta.id 是 string", typeof delta?.id === "string", typeof delta?.id);
	ck("delta.name 是 string", typeof delta?.name === "string", typeof delta?.name);
	ck("delta.argumentsDelta 是 string", typeof delta?.argumentsDelta === "string", typeof delta?.argumentsDelta);
}

console.log("\n=== 3. 所有 chunk 可无损 JSON 序列化（宿主要求）===");
{
	const cases = [
		["普通调用", mkCall("pwsh", { command: "echo hi" })],
		["Unicode", mkCall("pwsh", { command: "echo 🎉 日本語 مرحبا" })],
		["控制字符", mkCall("pwsh", { command: "echo \u0001\u0002" })],
		["含引号", mkCall("pwsh", { command: 'echo "quoted" and \'single\'' })],
		["含反斜杠", mkCall("pwsh", { command: "echo C:\\path\\to\\file" })],
	];
	for (const [label, text] of cases) {
		const out = await produce(text, "reasoning");
		let allOk = true;
		let badChunk = null;
		for (const c of out) {
			try {
				const s = JSON.stringify(c);
				const back = JSON.parse(s);
				// 无损：再 stringify 应相同
				if (JSON.stringify(back) !== s) { allOk = false; badChunk = { c, why: "round-trip mismatch" }; break; }
			} catch (e) { allOk = false; badChunk = { c, why: e.message }; break; }
		}
		ck(`${label} 可无损 JSON 序列化`, allOk, badChunk ? badChunk.why : "");
	}
}

console.log("\n=== 4. 索引连续且非负（宿主要求）===");
{
	const cases = [
		["单调用", mkCall("pwsh", { command: "a" })],
		["三调用", mkCall("pwsh", { command: "a" }) + mkCall("pwsh", { command: "b" }) + mkCall("pwsh", { command: "c" })],
		["两块 + 调用", "思考" ],
	];
	for (const [label, text] of cases) {
		const out = await produce(text, "reasoning");
		const starts = out.filter((c) => c.type === "block-start").map((c) => c.index);
		const ends = out.filter((c) => c.type === "block-end").map((c) => c.index);
		const okIdx = starts.every((i) => Number.isSafeInteger(i) && i >= 0);
		ck(`${label} → 索引是非负安全整数`, okIdx, JSON.stringify(starts));
		ck(`${label} → start/end 索引一一对应`, JSON.stringify(starts.sort((a, b) => a - b)) === JSON.stringify(ends.sort((a, b) => a - b)), `${JSON.stringify(starts)} vs ${JSON.stringify(ends)}`);
	}
}

console.log("\n=== 5. 用真实日志流验证宿主校验（回放已有流）===");
// 从真实会话日志挑若干含 tool-call 的流，剥离合成块后用当前插件重放，
// 再走宿主全部校验。这是「真实数据 + 真实校验器」的双重验证。
const os = await import("node:os");
const zlib = await import("node:zlib");
const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");
if (!fs.existsSync(SESSIONS)) {
	console.log("  跳过：无会话日志");
} else {
	// 先收集候选流（同步读取，避免 for-await 在非 async 上下文里报错）
	const candidates = [];
	let files = 0;
	const collect = (d) => {
		if (candidates.length >= 5) return;
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			if (candidates.length >= 5) break;
			const fp = path.join(d, e.name);
			if (e.isDirectory()) { collect(fp); continue; }
			if (e.name !== "session.v4.jsonl.zstd") continue;
			files++;
			let text;
			try {
				// **缺陷 160**（第 152 轮）：超大压缩会话解压后可达数百 MB → OOM/超时；明确跳过并提示。
				if (fs.statSync(fp).size > (Number(process.env.DSH_LOG_MAX_MB) > 0 ? Number(process.env.DSH_LOG_MAX_MB) : 64) * 1048576) { console.log("  （跳过超大会话 " + (fs.statSync(fp).size / 1048576).toFixed(1) + " MB，可用 DSH_LOG_MAX_MB 调整）"); continue; }
				const buf = fs.readFileSync(fp);
				const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
				const st = [];
				for (let i = 0; i + 4 <= buf.length; i++) {
					if (buf[i] === M[0] && buf[i + 1] === M[1] && buf[i + 2] === M[2] && buf[i + 3] === M[3]) st.push(i);
				}
				const parts = [];
				for (let k = 0; k < st.length; k++) {
					const s2 = st[k], e2 = k + 1 < st.length ? st[k + 1] : buf.length;
					try { parts.push(zlib.zstdDecompressSync(buf.subarray(s2, e2))); } catch { /* ignore */ }
				}
				text = Buffer.concat(parts).toString("utf8");
			} catch { continue; }

			for (const line of text.split("\n")) {
				if (candidates.length >= 5) break;
				if (!line || !line.includes('"tool-call"')) continue;
				let o;
				try { o = JSON.parse(line); } catch { continue; }
				if (o.type !== "assistant/message") continue;
				const raw = o.data?.stream;
				if (!Array.isArray(raw) || !raw.length) continue;
				let chunks;
				try { chunks = expandAssistantStream(raw).map((r) => r.chunk); } catch { continue; }
				if (chunks.length === 0) continue;
				candidates.push({ chunks, model: o.data?.message?.source?.model ?? "m" });
			}
		}
	};
	collect(SESSIONS);

	console.log(`  扫描 ${files} 个会话文件，收集到 ${candidates.length} 条候选流`);
	let tested = 0;
	let failed = 0;
	for (const cand of candidates) {
		// 剥离合成块后用当前插件重放
		const synthIdx = new Set(cand.chunks.filter((c) => String(c.block?.id ?? "").startsWith("txtcall-")).map((c) => c.index));
		const rebuilt = cand.chunks.filter((c) => !(c.index !== undefined && synthIdx.has(c.index)) && c.type !== "finish");
		rebuilt.push({ type: "finish", reason: { kind: "stop" } });

		plugin.resetStreaks?.();
		const out = [];
		try {
			const gen = (async function* () { for (const c of rebuilt) yield c; })();
			for await (const c of listener({ ...OPTS, model: cand.model }, () => gen)) out.push(c);
		} catch (e) {
			failed++;
			tested++;
			console.log(`  ❌ 重放抛异常: ${e.message}`);
			continue;
		}

		const steps = validateAll(out);
		const stepFails = steps.filter((s) => !s.ok);
		tested++;
		if (stepFails.length > 0) {
			failed++;
			console.log(`  ❌ 真实流 ${tested}: ${stepFails.map((f) => f.name + ":" + (f.err ?? f.detail)).join("; ")}`);
		}
	}
	console.log(`  重放验证 ${tested} 条真实流，失败 ${failed} 条`);
	ck("真实日志重放通过宿主全部校验", failed === 0 && tested > 0, `${failed}/${tested} 失败`);
}

console.log(`\n===== 宿主协议校验器: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
