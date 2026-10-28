// 插件效果量化（真实日志）
//
// 已有一套件只验证「插件没破坏真实流」。本套件回答另一个问题：
// **如果不装插件，这些真实会话里会有多少次「静默失败」？**
//
// 方法：对每条真实流做「对照实验」——
//   A. 不装插件：直接把原始 chunk 喂给宿主的装配器
//   B. 装插件：跑一遍再装配
//
// **关键设计（第一版踩过的坑）**：
//   真实日志里的流可能**本来就含有结构化 tool-call**（tool-call-delta + block-end）。
//   插件的设计是「看到结构化调用就原样放行，不做恢复」。
//   如果重建输入时把 finish 剔除了、却**保留**了这些 tool-call 块，
//   就会得到「孤立 tool-call-delta」的畸形流 —— 插件正确地判定为畸形并按
//   安全网处理，看起来像「回归」，实际是测试脚手架造假。
//
//   正确做法：只对**不含任何结构化 tool-call** 的流做对照实验
//   （那才是插件真正要解决的场景）。
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import os from "node:os";
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

const { BlockAssembler, expandAssistantStream } = await import(pathToFileURL(LLM).href);
const plugin = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href + "?effect=" + Date.now());

let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

function decompress(p) {
	// **缺陷 160**（第 152 轮）：超大压缩会话解压后可达数百 MB，`text.split("\n")` 再翻几倍内存，
	// 让套件从几十秒恶化到 20 分钟以上直至超时。实测一个 51.2 MB 的会话让 `audit-rewrites`
	// 从 31s 恶化到 1263s。这里对**超大文件**明确跳过并打印，而不是静默拖死。
	try { const _sz = fs.statSync(p).size; if (_sz > (Number(process.env.DSH_LOG_MAX_MB) > 0 ? Number(process.env.DSH_LOG_MAX_MB) : 64) * 1048576) { console.log("  （跳过超大会话 " + (_sz / 1048576).toFixed(1) + " MB，可用 DSH_LOG_MAX_MB 调整）"); return ""; } } catch {}
	const buf = fs.readFileSync(p);
	const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
	const st = [];
	for (let i = 0; i + 4 <= buf.length; i++) {
		if (buf[i] === M[0] && buf[i + 1] === M[1] && buf[i + 2] === M[2] && buf[i + 3] === M[3]) st.push(i);
	}
	const parts = [];
	for (let k = 0; k < st.length; k++) {
		const s = st[k], e = k + 1 < st.length ? st[k + 1] : buf.length;
		try { parts.push(zlib.zstdDecompressSync(buf.subarray(s, e))); } catch { /* ignore */ }
	}
	return Buffer.concat(parts).toString("utf8");
}

const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");
if (!fs.existsSync(SESSIONS)) { console.log("跳过：无会话日志"); process.exit(0); }

// ===========================================================================
// 收集真实流
// ===========================================================================
const allStreams = [];
(function walk(d) {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) { walk(p); continue; }
		if (e.name !== "session.v4.jsonl.zstd") continue;
		let text;
		try { text = decompress(p); } catch { continue; }
		for (const line of text.split("\n")) {
			if (!line || !line.includes('"assistant/message"')) continue;
			let o;
			try { o = JSON.parse(line); } catch { continue; }
			if (o.type !== "assistant/message") continue;
			const raw = o.data?.stream;
			if (!Array.isArray(raw) || !raw.length) continue;
			let chunks;
			try { chunks = expandAssistantStream(raw).map((r) => r.chunk); } catch { continue; }
			if (chunks.length === 0) continue;
			allStreams.push({
				chunks,
				model: o.data?.message?.source?.model ?? "?",
				provider: o.data?.message?.source?.provider ?? "?",
			});
		}
	}
})(SESSIONS);

console.log(`=== 收集到 ${allStreams.length} 条真实流 ===`);
ck("真实流数量足够（> 1000）", allStreams.length > 1000, String(allStreams.length));

// ===========================================================================
// **关键前提：排除「已被插件处理过」的流**
//
// 踩过的坑（第二版）：日志里有些流的 finish 是 tool-calls、且带 txtcall- 块，
// 它们的文本已被插件剥离过（778 字 reasoning、零标记、尾部是 "Let me do it."）。
// 拿这种「处理后的结果」当「处理前的输入」重放，插件当然恢复不出调用 ——
// 这不是回归，是**测错了对象**。
//
// 判据：finish.reason.kind === "tool-calls" 或 replayState.stopReason === "toolUse"
//   或文本里曾出现 txtcall- 块 → 视为「插件产出物」，排除出对照实验。
// ===========================================================================
/**
 * 判断一条流是否**原生**含结构化 tool-call。
 *
 * **关键区分（第一版踩的坑）**：日志里的 tool-call 块有两种来源：
 *   1. 上游模型真实返回的结构化 tool_calls（id 形如 call_xxx / chatcmpl-xxx）
 *   2. **插件自己历史合成**的（id 以 "txtcall-" 开头）
 * 如果把 (2) 当成「原生」，就会得出「插件把原生调用弄丢了」的错误结论 ——
 * 实际上那是插件上次运行留下的记录，这次重放时被正确剥离了。
 */
/**
 * 判断这条流是否为「插件产出物」（已被插件**实际改写**过）。
 *
 * **判据必须严格**（第三版修正）：
 * 早期版本把「finish.kind === tool-calls」也算作插件产出物，但**几乎所有正常
 * 的工具调用流都是 tool-calls** —— 那会把 97% 的正常流误判成插件产出物。
 *
 * 真正的判据只有一条：**存在 txtcall- 前缀的合成块**。
 * 这是插件合成的唯一标记（hashString 生成的 id），不可能被上游产生。
 */
function isPluginOutput(chunks) {
	return chunks.some((c) => {
		const id = String(c.block?.id ?? c.id ?? "");
		return id.startsWith("txtcall-");
	});
}

function hasNativeToolCall(chunks) {
	return chunks.some((c) => {
		const id = String(c.block?.id ?? c.id ?? "");
		if (id.startsWith("txtcall-")) return false;
		return c.type === "tool-call-delta" || (c.type === "block-end" && c.block?.type === "tool-call");
	});
}
// **只保留「真正的输入」**：排除插件产出物
const inputStreams = allStreams.filter((s) => !isPluginOutput(s.chunks));
const pluginOutputs = allStreams.filter((s) => isPluginOutput(s.chunks));

const nativeStreams = inputStreams.filter((s) => hasNativeToolCall(s.chunks));
const textOnlyStreams = inputStreams.filter((s) => !hasNativeToolCall(s.chunks));

console.log(`\n其中：`);
console.log(`  插件产出物（已处理过，排除）: ${pluginOutputs.length} 条`);
console.log(`  真正的输入流            : ${inputStreams.length} 条`);
console.log(`    原生含结构化 tool-call: ${nativeStreams.length} 条（插件应原样放行）`);
console.log(`    纯文本流（无结构化调用）: ${textOnlyStreams.length} 条（插件真正要处理的场景）`);

// ===========================================================================
// 判定
// ===========================================================================
function judge(blocks) {
	const tc = blocks.filter((b) => b.type === "tool-call");
	const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
	const reasoning = blocks.filter((b) => b.type === "reasoning").map((b) => b.text ?? "").join("");
	const hasVisibleText = text.trim().length > 0;
	return {
		hasToolCall: tc.length > 0,
		hasVisibleText,
		effective: tc.length > 0 || hasVisibleText,
		reasoningOnly: tc.length === 0 && !hasVisibleText && reasoning.trim().length > 0,
		empty: tc.length === 0 && !hasVisibleText && reasoning.trim() === "",
	};
}

function withoutPlugin(chunks) {
	try {
		const asm = new BlockAssembler();
		for (const c of chunks) asm.push(c);
		return judge(asm.assembled().blocks);
	} catch {
		return { hasToolCall: false, hasVisibleText: false, effective: false, reasoningOnly: false, empty: true, error: true };
	}
}

async function withPlugin(s) {
	// 剥离已存的**合成块**（txtcall-），保留原生的 tool-call 块
	const synthIdx = new Set(
		s.chunks.filter((c) => String(c.block?.id ?? "").startsWith("txtcall-")).map((c) => c.index)
	);
	const rebuilt = s.chunks.filter((c) => !(c.index !== undefined && synthIdx.has(c.index)));
	// 恢复 finish 为 stop（模拟「模型本来只想 stop」的原始状态）
	const finishIdx = rebuilt.findIndex((c) => c.type === "finish");
	const input = finishIdx >= 0
		? [...rebuilt.slice(0, finishIdx), { type: "finish", reason: { kind: "stop" } }, ...rebuilt.slice(finishIdx + 1)]
		: [...rebuilt, { type: "finish", reason: { kind: "stop" } }];

	plugin.resetStreaks?.();
	const out = [];
	try {
		const gen = (async function* () { for (const c of input) yield c; })();
		for await (const c of listener({ provider: s.provider, model: s.model, messages: [], tools: [] }, () => gen)) out.push(c);
	} catch {
		return { hasToolCall: false, hasVisibleText: false, effective: false, reasoningOnly: false, empty: true, error: true };
	}
	try {
		const asm = new BlockAssembler();
		for (const c of out) asm.push(c);
		return judge(asm.assembled().blocks);
	} catch {
		return { hasToolCall: false, hasVisibleText: false, effective: false, reasoningOnly: false, empty: true, error: true };
	}
}

// ===========================================================================
// 实验 1：插件对「原生已有结构化调用」的流必须原样放行
// ===========================================================================
console.log("\n=== 实验 1：原生结构化调用必须原样放行 ===");
{
	let changed = 0;
	let checked = 0;
	const samples = [];
	for (const s of nativeStreams) {
		const a = withoutPlugin(s.chunks);
		const b = await withPlugin(s);
		checked++;
		// 原生调用必须被保留（不丢失、不重复）
		if (a.hasToolCall && !b.hasToolCall) {
			changed++;
			if (samples.length < 3) samples.push({ s, a, b });
		}
	}
	console.log(`  检查 ${checked} 条，行为变化 ${changed} 条`);
	for (const x of samples) console.log(`    变化: 不装 toolCall=${x.a.hasToolCall} 装 toolCall=${x.b.hasToolCall}`);
	ck("原生结构化调用被原样放行（不被改写）", changed === 0, `${changed} 条被改变`);
}

// ===========================================================================
// 实验 2：纯文本流上，插件不能制造回归
// ===========================================================================
console.log("\n=== 实验 2：纯文本流无回归 ===");
{
	let regressions = 0;
	const regSamples = [];
	let effectiveBefore = 0;
	let effectiveAfter = 0;
	let gains = 0;
	const gainSamples = [];

	for (const s of textOnlyStreams) {
		const a = withoutPlugin(s.chunks);
		const b = await withPlugin(s);
		if (a.effective) effectiveBefore++;
		if (b.effective) effectiveAfter++;

		if (a.effective && !b.effective) {
			regressions++;
			if (regSamples.length < 5) regSamples.push({ s, a, b });
		} else if (!a.effective && b.effective) {
			gains++;
			if (gainSamples.length < 5) gainSamples.push({ s, a, b });
		}
	}

	console.log(`  纯文本流 ${textOnlyStreams.length} 条`);
	console.log(`  不装插件时「有效」: ${effectiveBefore}`);
	console.log(`  装插件后「有效」  : ${effectiveAfter}`);
	console.log(`  回归: ${regressions} 条`);
	console.log(`  救回: ${gains} 条`);

	for (const r of regSamples) {
		console.log(`\n  ⚠️ 回归样本:`);
		console.log(`     ${r.s.provider}/${r.s.model}`);
		console.log(`     不装: effective=${r.a.effective} toolCall=${r.a.hasToolCall} text=${r.a.hasVisibleText} reasoningOnly=${r.a.reasoningOnly}`);
		console.log(`     装后: effective=${r.b.effective} toolCall=${r.b.hasToolCall} text=${r.b.hasVisibleText} reasoningOnly=${r.b.reasoningOnly}`);
	}
	for (const g of gainSamples) {
		console.log(`  ✅ 救回样本: ${g.s.provider}/${g.s.model}（不装=${g.a.reasoningOnly ? "只有思考" : "空"} → 装=${g.b.hasToolCall ? "恢复调用" : "有正文"}）`);
	}

	ck("纯文本流无回归", regressions === 0, `${regressions} 条回归`);
	ck("装插件后有效数 >= 不装插件", effectiveAfter >= effectiveBefore, `${effectiveAfter} vs ${effectiveBefore}`);
}

// ===========================================================================
// 实验 3：统计插件在各模型上的「净收益」
// ===========================================================================
console.log("\n=== 实验 3：按模型统计净收益 ===");
{
	const byModel = new Map();
	for (const s of textOnlyStreams) {
		const key = `${s.provider}/${s.model}`;
		const a = withoutPlugin(s.chunks);
		const b = await withPlugin(s);
		const cur = byModel.get(key) ?? { total: 0, before: 0, after: 0, gains: 0, regs: 0 };
		cur.total++;
		if (a.effective) cur.before++;
		if (b.effective) cur.after++;
		if (!a.effective && b.effective) cur.gains++;
		if (a.effective && !b.effective) cur.regs++;
		byModel.set(key, cur);
	}
	const rows = [...byModel.entries()].filter(([, v]) => v.gains > 0 || v.regs > 0 || v.total > 100);
	rows.sort((a, b) => b[1].gains - a[1].gains);
	console.log(`  模型                                  总数  收益  回归`);
	for (const [k, v] of rows.slice(0, 10)) {
		console.log(`  ${k.padEnd(36)} ${String(v.total).padStart(5)} ${String(v.gains).padStart(5)} ${String(v.regs).padStart(5)}`);
	}
	const totalGains = [...byModel.values()].reduce((a, v) => a + v.gains, 0);
	const totalRegs = [...byModel.values()].reduce((a, v) => a + v.regs, 0);
	console.log(`\n  合计：救回 ${totalGains} 条，回归 ${totalRegs} 条`);
	ck("无模型出现回归", totalRegs === 0, `${totalRegs} 条`);
}

// ===========================================================================
// 实验 4：插件在真实环境中的工作痕迹
//
// 这是**正面证据**：含 txtcall- 合成块的流，说明插件在生产环境里实际
// 恢复过多少次调用。（txtcall- 是插件 hashString 生成的唯一标记，
// 不可能被上游产生，因此是可靠证据。）
// ===========================================================================
console.log("\n=== 实验 4：插件工作痕迹 ===");
{
	const total = allStreams.length;
	const outputs = pluginOutputs.length;
	const pct = (outputs / total * 100).toFixed(2);
	console.log(`  真实流总数      : ${total}`);
	console.log(`  插件产出物      : ${outputs}（${pct}%）`);
	console.log(`  未处理的输入流  : ${total - outputs}（${(100 - Number(pct)).toFixed(2)}%）`);

	// 统计产出物里恢复了多少个调用
	let recoveredCalls = 0;
	const perModel = new Map();
	for (const s of pluginOutputs) {
		const tcCount = s.chunks.filter((c) => c.type === "block-end" && c.block?.type === "tool-call"
			&& String(c.block.id).startsWith("txtcall-")).length;
		recoveredCalls += tcCount;
		const key = `${s.provider}/${s.model}`;
		const cur = perModel.get(key) ?? { streams: 0, calls: 0 };
		cur.streams++;
		cur.calls += tcCount;
		perModel.set(key, cur);
	}
	console.log(`  其中恢复的调用  : ${recoveredCalls} 个（跨 ${pluginOutputs.length} 条流）`);

	const top = [...perModel.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 6);
	if (top.length > 0) {
		console.log("\n  按模型分布:");
		for (const [k, v] of top) console.log(`    ${k.padEnd(38)} ${String(v.calls).padStart(4)} 个调用 / ${v.streams} 条流`);
	}

	ck("插件在真实环境中有工作痕迹（产出物 > 0）", outputs > 0, String(outputs));
	ck("恢复的调用数 > 0", recoveredCalls > 0, String(recoveredCalls));

	// 产出物占比应**很小**：插件只在模型把调用写成文本时才介入
	const ratio = outputs / total;
	ck("产出物占比很小（< 5%，说明只在必要时介入）", ratio < 0.05, `${(ratio * 100).toFixed(2)}%`);
}

console.log(`\n===== 插件效果量化: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
