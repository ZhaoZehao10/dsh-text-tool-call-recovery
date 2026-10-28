// 「已知限制」验证：无参数工具调用不被恢复
//
// 第 52 轮的审查发现：`parseCallBody` 要求「至少有一个参数」才恢复调用
// （L250: `if (Object.keys(args).length > 0) return ...`）。
//
// 这意味着 `<function=noargs></function>`（完全无参数的调用）**不会被恢复**。
//
// **判断：这是正确的保守设计，不应修改。** 理由：
//   1. 真实日志里从未出现过无参数文本调用（扫描 5 个会话，0 次）
//   2. 「参数非空」是防止「把空标记误当真实调用」的一道防线
//   3. 若放松，可能让畸形/截断形态被当成合法调用执行（安全风险 > 功能收益）
//
// 本套件把这个已知限制**固化为可验证的行为**，并确认它不是意外：
//   - 无参数调用 → 安全网兜底（error + EMPTY_RESPONSE，会重试）
//   - 而不是静默丢失（stop）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const plugin = await import(pathToFileURL(LIB).href + "?limit=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } },
	{ name: "noargs", parameters: { type: "object", properties: {} } },
];

async function run(text, model) {
	plugin.resetStreaks?.();
	const out = [];
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	for await (const c of listener({ provider: "p", model, messages: [], tools: TOOLS }, () => gen)) out.push(c);
	const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	const fin = out.find((c) => c.type === "finish");
	return { calls: calls.length, kind: fin?.reason?.kind, code: fin?.reason?.failure?.code };
}

// ===========================================================================
// 1. 无参数调用：不恢复，但**安全网兜底**（不是静默丢失）
// ===========================================================================
console.log("=== 1. 无参数调用 → 安全网兜底 ===");
{
	const text = OC + "\n<function=noargs>\n</function>\n" + CC;
	const r = await run(text, "noargs-" + Date.now());
	console.log(`  ${JSON.stringify(text.slice(0, 40))}...`);
	console.log(`  恢复=${r.calls} kind=${r.kind} code=${r.code}`);
	ck("无参数调用不被恢复（已知限制）", r.calls === 0, String(r.calls));
	ck("但走安全网（error，会重试）而不是静默丢失", r.kind === "error", String(r.kind));
	ck("安全网错误码正确", r.code === "EMPTY_RESPONSE", String(r.code));
}

// ===========================================================================
// 2. 对照：有参数调用正常恢复
// ===========================================================================
console.log("\n=== 2. 对照：有参数调用正常恢复 ===");
{
	const text = OC + "\n<function=pwsh>\n<parameter=command>echo hi\n</parameter>\n</function>\n" + CC;
	const r = await run(text, "withargs-" + Date.now());
	console.log(`  恢复=${r.calls} kind=${r.kind}`);
	ck("有参数调用正常恢复", r.calls === 1, String(r.calls));
	ck("finish 改写为 tool-calls", r.kind === "tool-calls", String(r.kind));
}

// ===========================================================================
// 3. 源码：确实有「参数非空」这道防线
// ===========================================================================
console.log("\n=== 3. 源码防线存在 ===");
{
	const src = fs.readFileSync(LIB, "utf8");
	const hasGuard = /if \(Object\.keys\(args\)\.length > 0\) return \{ name: toolName, arguments: args \};/.test(src);
	ck("源码有「参数非空才返回」的防线", hasGuard, "");
	console.log(`  防线: ${hasGuard ? "✅" : "❌"}`);

	// 注释说明了为什么
	const idx = src.indexOf("if (Object.keys(args).length > 0) return");
	const context = idx >= 0 ? src.slice(Math.max(0, idx - 800), idx) : "";
	const explains = /参数区损坏|放弃该调用/.test(context);
	ck("附近注释解释了原因", explains, "");
	console.log(`  有解释: ${explains ? "✅" : "❌"}`);
}

// ===========================================================================
// 4. 真实数据：这种形态从未出现过
// ===========================================================================
console.log("\n=== 4. 真实日志里的出现频率 ===");
{
	// 这一步需要扫描日志，成本较高 —— 只在有日志时做
	const os = await import("node:os");
	const zlib = await import("node:zlib");
	const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");
	if (!fs.existsSync(SESSIONS)) {
		console.log("  ⚠️ 无会话日志，跳过");
	} else {
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
		const files = [];
		(function walk(d) {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) { walk(p); continue; }
				if (e.name === "session.v4.jsonl.zstd") files.push(p);
			}
		})(SESSIONS);

		let noArgForms = 0;
		let scanned = 0;
		for (const f of files.slice(0, 3)) {
			let text;
			try { text = decompress(f); } catch { continue; }
			scanned++;
			for (const line of text.split("\n")) {
				// <function=xxx> 紧跟 </function>（无 parameter）
				if (/<function=\w+>\s*<\/function>/.test(line)) noArgForms++;
			}
		}
		console.log(`  扫描 ${scanned} 个会话，无参数形态出现 ${noArgForms} 次`);
		// **缺陷 153**（第 146 轮）：原来是 `ck(..., noArgForms < 5)` ——
		// **零样本时 `0 < 5` 为真，断言自动通过**，等于「没数据也能证明罕见」。
		// 这与缺陷 152（零样本假装验证过）是同一族，只是形态不同：
		// 152 是「循环不执行所以不失败」，153 是「**上界断言在零样本下自然成立**」。
		//
		// 对照：`host-validator.mjs` L315 写的是 `failed === 0 && tested > 0`，
		// **那才是正确写法** —— 用 `tested > 0` 守卫住「没数据」的情况。
		ck(`真实数据里无参数形态极罕见（< 5 次，且至少扫描到 1 个会话）`,
			noArgForms < 5 && scanned > 0,
			`${noArgForms} 次 / 扫描 ${scanned} 个会话`);
	}
}

console.log(`\n===== 无参数调用已知限制: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
