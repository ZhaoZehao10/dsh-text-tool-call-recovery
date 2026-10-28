// 插件安全网的宿主契约验证
//
// 插件的「确定性失败保护」依赖一个**跨模块契约**：
//   插件产出 finish.reason.kind = "error" + code = "EMPTY_RESPONSE"
//   → 宿主的 retry-policy 必须把 EMPTY_RESPONSE 视为「可重试」
//   → 宿主自动重试一次（间歇性失败可自愈）
//
// 前 49 轮只验证了「插件确实改写成 error」，**从未验证宿主那头认不认**。
// 如果宿主不把 EMPTY_RESPONSE 当可重试，这个安全网就是无效的。
//
// 本套件用**宿主真实的 error.js / retry-policy.js** 验证这个契约。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const PLUGIN_SRC = fs.readFileSync(LIB, "utf8");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

// 找 dsh-llm 源码
const LLM_TYPES = (() => {
	const cands = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "types") : null,
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm", "lib", "types"),
	].filter(Boolean);
	for (const c of cands) if (fs.existsSync(path.join(c, "error.js"))) return c;
	return null;
})();

if (LLM_TYPES === null) {
	console.log("跳过：找不到 dsh-llm 源码（设置 DSH_LLM_SRC）");
	process.exit(0);
}
console.log(`dsh-llm types 目录: ${LLM_TYPES}\n`);

// ===========================================================================
// 1. 插件确实产出 EMPTY_RESPONSE 错误码
// ===========================================================================
console.log("=== 1. 插件产出 EMPTY_RESPONSE ===");
{
	// 插件的 code 来源：应该引用或硬编码 "EMPTY_RESPONSE"
	const hasCode = /EMPTY_RESPONSE/.test(PLUGIN_SRC);
	ck("插件源码里出现 EMPTY_RESPONSE", hasCode, "");

	// 具体位置
	const lines = PLUGIN_SRC.split(/\r?\n/);
	const hits = [];
	for (let i = 0; i < lines.length; i++) {
		if (/EMPTY_RESPONSE/.test(lines[i])) hits.push({ n: i + 1, l: lines[i].trim() });
	}
	console.log(`  出现 ${hits.length} 处:`);
	for (const h of hits.slice(0, 5)) console.log(`    L${h.n}: ${h.l.slice(0, 110)}`);

	ck("插件至少有一处产出 EMPTY_RESPONSE", hits.length > 0, "");
}

// ===========================================================================
// 2. 宿主定义了 EMPTY_RESPONSE_CODE
// ===========================================================================
console.log("\n=== 2. 宿主定义 EMPTY_RESPONSE_CODE ===");
let emptyCode = null;
{
	try {
		const errMod = await import(pathToFileURL(path.join(LLM_TYPES, "error.js")).href);
		emptyCode = errMod.EMPTY_RESPONSE_CODE;
		ck("宿主导出 EMPTY_RESPONSE_CODE", typeof emptyCode === "string", typeof emptyCode);
		console.log(`  EMPTY_RESPONSE_CODE = ${JSON.stringify(emptyCode)}`);
		ck("EMPTY_RESPONSE_CODE 值就是 EMPTY_RESPONSE", emptyCode === "EMPTY_RESPONSE", String(emptyCode));
	} catch (e) {
		ck("能加载宿主 error.js", false, e.message);
	}
}

// ===========================================================================
// 3. ★ 核心：宿主的默认重试策略把 EMPTY_RESPONSE 列为可重试
// ===========================================================================
console.log("\n=== 3. 宿主默认重试策略包含 EMPTY_RESPONSE ===");
{
	const retrySrc = fs.readFileSync(path.join(LLM_TYPES, "retry-policy.js"), "utf8");

	// 找 DEFAULT_RETRYABLE_CODES 数组
	const m = retrySrc.match(/DEFAULT_RETRYABLE_CODES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
	ck("能定位 DEFAULT_RETRYABLE_CODES", m !== null, "");
	if (m) {
		const codes = m[1].split(/[,\n]/).map((s) => s.trim()).filter((s) => s.length > 0);
		console.log(`  默认可重试代码（${codes.length} 个）:`);
		for (const c of codes) console.log(`    ${c}`);

		const hasEmpty = codes.some((c) => /EMPTY_RESPONSE/.test(c));
		ck("DEFAULT_RETRYABLE_CODES 含 EMPTY_RESPONSE", hasEmpty, codes.join(", "));
		if (hasEmpty) {
			console.log("\n  ✅ **插件安全网的契约成立**：宿主默认把 EMPTY_RESPONSE 当可重试");
		} else {
			console.log("\n  ❌ **插件安全网无效**：宿主不把 EMPTY_RESPONSE 当可重试");
		}
	}
}

// ===========================================================================
// 4. resolveRetryPolicy 的默认策略里也包含（不只是常量）
// ===========================================================================
console.log("\n=== 4. 解析后的默认策略也包含 ===");
{
	try {
		const retryMod = await import(pathToFileURL(path.join(LLM_TYPES, "retry-policy.js")).href);
		const resolve = retryMod.resolveRetryPolicy;
		ck("resolveRetryPolicy 可调用", typeof resolve === "function", typeof resolve);

		// 尝试用默认配置解析
		// 签名是 (config, path) 或 (path, config)，两种都试
		let policy = null;
		let lastErr = null;
		for (const args of [
			[{ mode: "normal" }, "test"],
			["test", { mode: "normal" }],
			[{ mode: "normal" }],
			["test"],
		]) {
			try {
				const r = resolve(...args);
				if (r && typeof r === "object") { policy = r; break; }
			} catch (e) { lastErr = e; }
		}

		if (policy) {
			console.log(`  解析结果: mode=${policy.mode} maxRetries=${policy.maxRetries}`);
			const codes = policy.retryableCodes ?? [];
			console.log(`  retryableCodes (${codes.length}): ${codes.join(", ")}`);
			ck("解析后的策略含 EMPTY_RESPONSE", codes.includes("EMPTY_RESPONSE"), codes.join(", "));
			ck("maxRetries > 0（确实会重试）", (policy.maxRetries ?? 0) > 0, String(policy.maxRetries));
		} else {
			console.log(`  ⚠️ 无法用默认配置调用 resolveRetryPolicy（${lastErr?.message ?? "返回非对象"}）`);
			// 退而求其次：检查源码里默认值的构造
			const src = fs.readFileSync(path.join(LLM_TYPES, "retry-policy.js"), "utf8");
			const hasDefaultSpread = /retryableCodes:\s*\[?\.\.\.DEFAULT_RETRYABLE_CODES|retryableCodes:\s*DEFAULT_RETRYABLE_CODES/.test(src);
			ck("源码里默认策略展开 DEFAULT_RETRYABLE_CODES", hasDefaultSpread, "");
			console.log(`  源码里展开默认代码: ${hasDefaultSpread}`);
		}
	} catch (e) {
		console.log(`  ⚠️ 加载 retry-policy 失败: ${e.message}`);
	}
}

// ===========================================================================
// 5. 插件行为验证：实际产出的 error 码与宿主常量一致
// ===========================================================================
console.log("\n=== 5. 端到端：插件产出的码 === 宿主认可的码 ===");
{
	const plugin = await import(pathToFileURL(LIB).href + "?contract=" + Date.now());
	let listener;
	plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

	// **确定性失败保护的设计**（缺陷 6）：
	//   同一模型**首次**出现「stop 且无可见内容」→ 改写为 error + EMPTY_RESPONSE（触发重试）
	//   同一模型**连续**再次出现 → 原样放行 stop（避免确定性失败空转）
	// 所以必须用**全新模型名**并连续跑两次来观察完整行为。
	const emptyStream = () => (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text: "只有思考，没有正文" };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考，没有正文" } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();

	plugin.resetStreaks?.();
	const model = "contract-model-" + Date.now();
	const observed = [];
	for (let round = 0; round < 3; round++) {
		const out = [];
		// **注意**：必须传非空 tools —— 插件在 tools 为空时不触发安全网
		// （没有声明工具就没有「本该调用」可言）。这是设计行为，不是缺陷。
		const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
		for await (const c of listener({ provider: "p", model, messages: [], tools: TOOLS }, emptyStream)) {
			out.push(c);
		}
		const fin = out.find((c) => c.type === "finish");
		observed.push({
			round: round + 1,
			kind: fin?.reason?.kind,
			code: fin?.reason?.failure?.code,
			msg: fin?.reason?.failure?.message,
		});
	}

	console.log("  连续 3 次「空响应」的 finish:");
	// （tools 非空 —— 安全网只在「声明了工具但没调用」时才应触发）
	for (const o of observed) {
		console.log(`    第 ${o.round} 次: kind=${o.kind} code=${JSON.stringify(o.code)}`);
		if (o.msg) console.log(`      msg: ${String(o.msg).slice(0, 100)}`);
	}

	const first = observed[0];
	ck("第 1 次产出 kind=error（触发重试）", first.kind === "error", String(first.kind));
	ck("第 1 次的 code 是 EMPTY_RESPONSE", first.code === "EMPTY_RESPONSE", String(first.code));
	if (emptyCode !== null) {
		ck("插件 code 与宿主常量完全相同", first.code === emptyCode, `${first.code} vs ${emptyCode}`);
	}

	// 后续应在首次之后原样放行（避免确定性失败空转）
	const later = observed.slice(1);
	ck("后续不再产出 error（避免空转）", later.every((o) => o.kind !== "error"),
		later.map((o) => o.kind).join(", "));
}

// ===========================================================================
// 6. 反向验证：如果不是 EMPTY_RESPONSE 会怎样（说明契约的重要性）
// ===========================================================================
console.log("\n=== 6. 契约敏感性（如果码写错会怎样）===");
{
	const retrySrc = fs.readFileSync(path.join(LLM_TYPES, "retry-policy.js"), "utf8");
	const m = retrySrc.match(/DEFAULT_RETRYABLE_CODES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
	if (m) {
		const codes = m[1].split(/[,\n]/).map((s) => s.trim()).filter((s) => s.length > 0);
		// **解析出真实的代码字符串**（源码里写的是常量名 EMPTY_RESPONSE_CODE，
		// 需要替换成它的实际值）
		const resolved = codes.map((c) => {
			if (/EMPTY_RESPONSE_CODE/.test(c)) return "EMPTY_RESPONSE";
			return c.replace(/^['"]|['"]$/g, "");
		});
		console.log(`  解析后的代码: ${resolved.join(", ")}`);

		// **精确相等**匹配（不能用 includes —— "EMPTY" 是 "EMPTY_RESPONSE" 的子串，
		// 但宿主不会把 "EMPTY" 当作合法 code）
		const WRONG_CODES = ["EMPTY", "empty_response", "EMPTYRESPONSE", "NO_CONTENT", "EMPTY_RESPONSES"];
		for (const w of WRONG_CODES) {
			const exactMatch = resolved.includes(w);
			ck(`宿主不认「${w}」这个码（说明必须精确写 EMPTY_RESPONSE）`, !exactMatch, resolved.join(","));
		}
		console.log(`  验证了 ${WRONG_CODES.length} 个错误拼写：宿主只认精确的 EMPTY_RESPONSE`);
	}
}

console.log(`\n===== 安全网宿主契约: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
