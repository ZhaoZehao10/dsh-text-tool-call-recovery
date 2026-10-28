// 变异测试（mutation testing）
// 目的：检验我们的测试套件是否真的能抓到 bug。
// 方法：对 lib/index.js 逐条植入“典型 bug”，跑测试套件，看是否 FAIL。
// 若某个变异“存活”（测试仍全绿），说明测试对该类缺陷有盲区。
import fs from "node:fs";
import path from "node:path";
import { NEEDS_GC } from "./_suite-meta.mjs";
import { execSync } from "node:child_process";

// **缺陷 158**（第 151 轮）：本套件会**临时改写 lib/index.js** 注入变异体。
// 若与另一个测试入口并发，对方读到的是变异体 —— 会产生**假失败**（实测
// live-instance 报「源码 48687B vs 安装 48772B」、coverage 判 100 子套件失败）。
// 因此改写期间持锁；拿不到锁就明确跳过（而不是产出一个假的红）。
import { acquireLibWriteLock, releaseLibWriteLock } from "./_lib-lock.mjs";
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
// **缺陷 159**（第 151 轮）：`mutation-test` 会把变异体写进 `lib/index.js`，靠 try/finally 还原。
// 但 **`try/finally` 对 SIGKILL / 断电 / 用户强杀无效** —— 实测我 `Stop-Process -Force`
// 终止一次运行后，`lib/index.js` 停留在 **48,758 字节**（安装副本 48,772），
// 后续所有套件都读到被变异的源码：`等价类划分`、`XML 属性` 等**基线集体失败**，
// 而这些失败看起来完全像真 bug。
//
// 对策：**开工前先做崩溃恢复** —— 若存在上一次留下的纯净备份且与当前源码不同，
// 就先用它还原，再读 ORIGINAL。这样即使上次被强杀，本次也能自愈。
const ORIG_BACKUP = path.join(ROOT, ".tmp-lib-orig.js");
let recoveredFrom = null;
try {
	if (fs.existsSync(ORIG_BACKUP)) {
		const backup = fs.readFileSync(ORIG_BACKUP, "utf8");
		const current = fs.readFileSync(LIB, "utf8");
		if (current !== backup) {
			fs.writeFileSync(LIB, backup);
			recoveredFrom = backup.length;
			console.log(`⚠️ 检测到上次异常中断留下的变异源码（${current.length} → ${backup.length} 字节），已从备份还原`);
		}
	}
} catch (e) { console.log("⚠️ 崩溃恢复检查失败（将继续，但可能读到变异源码）: " + e.message); }
const ORIGINAL = fs.readFileSync(LIB, "utf8");

// 解析 dsh-llm 位置（供子进程使用）：优先环境变量，其次仓库 node_modules
const DSH_LLM = (() => {
	const candidates = [
		process.env.DSH_LLM_SRC,
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm"),
		path.join(import.meta.dirname, "..", "..", "node_modules", "@deepseek-ai", "dsh-llm")
	].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(path.join(c, "lib", "index.js"))) return c;
	return undefined;
})();

// 测试套件（快速子集，每个都独立进程运行）
const SUITES = [
	["集成断言", path.join(ROOT, "test", "integration.test.mjs")],
	["语义属性", path.join(ROOT, "test", "hardening", "semantic-properties.mjs")],
	["边界穷举", path.join(ROOT, "test", "hardening", "boundary-cases.mjs")],
	["块顺序", path.join(ROOT, "test", "hardening", "block-ordering.mjs")],
	["交错块", path.join(ROOT, "test", "hardening", "interleaved-blocks.mjs")],
	["等价性", path.join(ROOT, "test", "hardening", "equivalence.mjs")],
	["replayState", path.join(ROOT, "test", "hardening", "replay-state.mjs")],
	["消息不变量", path.join(ROOT, "test", "hardening", "message-invariants.mjs")],
	["ReDoS 性能", path.join(ROOT, "test", "hardening", "redos-performance.mjs")],
	["差分测试", path.join(ROOT, "test", "hardening", "differential.mjs")],
	["分模型重放", path.join(ROOT, "test", "hardening", "per-model-replay.mjs")],
	["等价类划分", path.join(ROOT, "test", "hardening", "equivalence-classes.mjs")],
	["JSON 形态", path.join(ROOT, "test", "hardening", "json-forms.mjs")],
	["XML 属性", path.join(ROOT, "test", "hardening", "xml-attributes.mjs")],
	["嵌套与畸形", path.join(ROOT, "test", "hardening", "nesting-malformed.mjs")],
	["值/实体边界", path.join(ROOT, "test", "hardening", "value-entities.mjs")],
	["执行安全", path.join(ROOT, "test", "hardening", "execution-safety.mjs")],
	["类型强转语义", path.join(ROOT, "test", "hardening", "coercion-semantics.mjs")],
	["状态隔离", path.join(ROOT, "test", "hardening", "state-isolation.mjs")],
	["replayState 一致性", path.join(ROOT, "test", "hardening", "replay-state-consistency.mjs")],
	["裸 JSON 安全", path.join(ROOT, "test", "hardening", "bare-json-safety.mjs")],
	["合成调用溯源", path.join(ROOT, "test", "hardening", "synth-provenance.mjs")],
	["错误消息", path.join(ROOT, "test", "hardening", "error-observability.mjs")],
	["内存生命周期", path.join(ROOT, "test", "hardening", "memory-lifecycle.mjs")],
	["多插件共存", path.join(ROOT, "test", "hardening", "plugin-coexistence.mjs")],
	["端到端链路", path.join(ROOT, "test", "hardening", "end-to-end.mjs")],
	["跨版本兼容", path.join(ROOT, "test", "hardening", "cross-version.mjs")],
	["插件生命周期", path.join(ROOT, "test", "hardening", "lifecycle.mjs")],
	["类型模糊", path.join(ROOT, "test", "hardening", "type-fuzz.mjs")],
	["结构模糊", path.join(ROOT, "test", "hardening", "structure-fuzz.mjs")],
	["中断与取消", path.join(ROOT, "test", "hardening", "cancellation.mjs")],
	["断流不变量", path.join(ROOT, "test", "hardening", "abort-invariants.mjs")],
	["超时与背压", path.join(ROOT, "test", "hardening", "timeout-backpressure.mjs")],
	["扫描上限", path.join(ROOT, "test", "hardening", "scan-limit.mjs")],
	["部署验证", path.join(ROOT, "test", "hardening", "deploy-verify.mjs")],
	["Node 兼容", path.join(ROOT, "test", "hardening", "node-compat.mjs")],
	["原型污染", path.join(ROOT, "test", "hardening", "prototype-pollution.mjs")],
	["正则与Unicode", path.join(ROOT, "test", "hardening", "regex-unicode.mjs")],
	["文本保真度", path.join(ROOT, "test", "hardening", "text-fidelity.mjs")],
	["幂等确定性", path.join(ROOT, "test", "hardening", "idempotency.mjs")],
	["宿主校验器", path.join(ROOT, "test", "hardening", "host-validator.mjs")],
	["性能基线", path.join(ROOT, "test", "hardening", "perf-baseline.mjs")],
	["多轮对话", path.join(ROOT, "test", "hardening", "multi-turn.mjs")],
	["异常值", path.join(ROOT, "test", "hardening", "throw-values.mjs")],
	["测试基建健全性", path.join(ROOT, "test", "hardening", "meta-health.mjs")],
	["文档一致性", path.join(ROOT, "test", "hardening", "doc-consistency.mjs")],
	["代码质量", path.join(ROOT, "test", "hardening", "code-quality.mjs")],
	["缺陷回归矩阵", path.join(ROOT, "test", "hardening", "defect-regression.mjs")],
	["效果量化", path.join(ROOT, "test", "hardening", "effect-quantify.mjs")],
	["安装体验", path.join(ROOT, "test", "hardening", "install-experience.mjs")],
	["跨宿主配置", path.join(ROOT, "test", "hardening", "host-compat.mjs")],
	["长时稳定性", path.join(ROOT, "test", "hardening", "soak-test.mjs")],
	["文档可执行性", path.join(ROOT, "test", "hardening", "doc-executable.mjs")],
	["真实Cordis", path.join(ROOT, "test", "hardening", "real-cordis.mjs")],
	["引用可核实", path.join(ROOT, "test", "hardening", "ref-verifiable.mjs")],
	["复现脚本", path.join(ROOT, "test", "hardening", "repro-runnable.mjs")],
	["运行实例", path.join(ROOT, "test", "hardening", "live-instance.mjs")],
	["交付物完整性", path.join(ROOT, "test", "hardening", "deliverable.mjs")],
	["安装校验脚本", path.join(ROOT, "test", "hardening", "verify-install-runnable.mjs")],
	["LCR链路", path.join(ROOT, "test", "hardening", "lcr-replay.mjs")],
	["声明真实性", path.join(ROOT, "test", "hardening", "claims-audit.mjs")],
	["假测试扫描", path.join(ROOT, "test", "hardening", "fake-test-audit.mjs")],
	["缺陷覆盖矩阵", path.join(ROOT, "test", "hardening", "defect-coverage-matrix.mjs")],
	["文档结构", path.join(ROOT, "test", "hardening", "doc-structure.mjs")],
	["安全网契约", path.join(ROOT, "test", "hardening", "safety-net-contract.mjs")],
	["直通设计", path.join(ROOT, "test", "hardening", "passthrough-design.mjs")],
	["已知限制", path.join(ROOT, "test", "hardening", "known-limit-noargs.mjs")],
	["边界 off-by-one", path.join(ROOT, "test", "hardening", "boundary-offbyone.mjs")],
	["并发竞态", path.join(ROOT, "test", "hardening", "race-conditions.mjs")],
	["路径一致性", path.join(ROOT, "test", "hardening", "path-consistency.mjs")],
	["安装失败路径", path.join(ROOT, "test", "hardening", "install-failure-paths.mjs")],
	["已知限制真实性", path.join(ROOT, "test", "hardening", "known-limits-accuracy.mjs")],
	["恢复调用的 A/B 一致性", path.join(ROOT, "test", "hardening", "recovered-ab-consistency.mjs")],
	["package.json 契约", path.join(ROOT, "test", "hardening", "package-contract.mjs")],
	["宿主协议规则符合性", path.join(ROOT, "test", "hardening", "invariant-conformance.mjs")],
	["运行实例进程级验证", path.join(ROOT, "test", "hardening", "runtime-process-check.mjs")],
	["卸载流程", path.join(ROOT, "test", "hardening", "uninstall-flow.mjs")],
	["反引号精确", path.join(ROOT, "test", "hardening", "backtick-precision.mjs")],
	["截断安全", path.join(ROOT, "test", "hardening", "truncated-safety.mjs")],
	["误恢复审计", path.join(ROOT, "test", "hardening", "false-positive-audit.mjs")],
	// **缺陷 118**（第 119 轮）：下面 9 个套件是第 110-118 轮新增的，
	// 它们一直「全绿」，但**从未被变异测试验证过** —— 也就是说
	// 没人证明它们真的能抓到 bug。第 118 轮就发现 3 个变异从
	// `double-registration.mjs` 逃逸，说明「新增套件」必须有变异覆盖。
	["恢复 vs 原生等价", path.join(ROOT, "test", "hardening", "recovered-vs-native.mjs")],
	["中文与换行保真", path.join(ROOT, "test", "hardening", "unicode-fidelity.mjs")],
	["原生与恢复共存", path.join(ROOT, "test", "hardening", "mixed-native-recovery.mjs")],
	["异常形状鲁棒性", path.join(ROOT, "test", "hardening", "shape-robustness.mjs")],
	["streak 状态隔离", path.join(ROOT, "test", "hardening", "streak-resolution.mjs")],
	["重复注册", path.join(ROOT, "test", "hardening", "double-registration.mjs")],
	["双层 finish.kind", path.join(ROOT, "test", "hardening", "double-finish-kind.mjs")],
	["环境变量禁用语义", path.join(ROOT, "test", "hardening", "env-disable-semantics.mjs")],
	["并发", path.join(ROOT, "test", "hardening", "concurrency.mjs")],
	// **缺陷 154**（第 147 轮）：以下 5 个**插件行为套件**长期未纳入变异测试，
	// 它们守护着真实缺陷（D126 围栏行尾、D127 antml 前缀、D129 markup-only），
	// 却**从未被证明能抓到 bug**。到此 SUITES 覆盖全部可变异的行为套件。
	["antml 前缀对称性", path.join(ROOT, "test", "hardening", "antml-prefix-symmetry.mjs")],
	["调用形态矩阵", path.join(ROOT, "test", "hardening", "call-form-matrix.mjs")],
	["围栏行尾矩阵", path.join(ROOT, "test", "hardening", "fence-eol-matrix.mjs")],
	["仅标记文本完整性", path.join(ROOT, "test", "hardening", "markup-only-completeness.mjs")],
	["已知限制行为", path.join(ROOT, "test", "hardening", "known-limit-outcomes.mjs")],
];

// 变异体：每个是 [名称, 查找串, 替换串]
const MUTANTS = [
	// --- 恢复逻辑 ---
	["M01 不校验工具名（任何名字都当调用）", 'if (tool === undefined) continue;', 'if (false) continue;'],
	["M02 不剥离标记（文本残留 XML）", 'return { calls, stripped };', 'return { calls, stripped: text };'],
	["M03 不做类型强转", 'args[key] = coerceValue(value, properties ? properties[key] : undefined);', 'args[key] = value;'],
	["M04 不合成 tool-call 块（只改 finish）", 'yield { type: "block-start", index, blockType: "tool-call" };', '// removed block-start'],
	["M05 不把 finish 改为 tool-calls", 'yield { type: "finish", reason: { kind: "tool-calls" }, ...patchReplayState(finishChunk.replayState, recoveredCalls.length) };', 'yield finishChunk;'],
	// --- 安全网 ---
	["M06 安全网永不触发（静默结束）", 'if (!hasVisibleText) {', 'if (false) {'],
	["M07 安全网永远触发（正常回复被判错）", 'if (!hasVisibleText) {', 'if (true) {'],
	["M08 纯标记判据失效", 'return substantiveChars < 20 && tagChars / Math.max(trimmed.length, 1) > 0.5;', 'return false;'],
	// --- 代码块保护（安全） ---
	["M09 去掉展示区拦截（示例会被执行）", "if (isInRanges(displayRanges, openAt)) {", "if (false) {"],
	// --- 顺序 / 交错 ---
	["M10 交错块不按 index 跟踪（回到旧 bug）", "const block = openByIndex.get(chunk.index);", "const block = heldBlocks.length > 0 ? heldBlocks[heldBlocks.length - 1] : undefined;"],
	["M11 恢复后不重排索引（调用顺序错）", 'yield { ...block.start, index: blockIndex };', 'yield block.start;'],
	// --- 防御性 ---
	["M12 移除 tools 形状防御", 'const toolList = Array.isArray(options?.tools) ? options.tools : [];', 'const toolList = options.tools ?? [];'],
	["M13 移除 reason 可选链（畸形 finish 崩溃）", 'if (sawToolCall || finishChunk.reason?.kind !== "stop") {', 'if (sawToolCall || finishChunk.reason.kind !== "stop") {'],
	// --- 确定性失败 / 性能 ---
	["M14 去掉确定性失败保护（空转 5 次）", 'const streak = bumpEmptyStreak(modelKey);', 'const streak = 1;'],
	// M15 同时移除**两处**上限（hasCodeFence 与 isMarkupOnlyText）——单点移除会被
	// 另一处冗余保护兜住，测不出真实防护是否存在。
	["M15 去掉 ReDoS 上限（两处同时）", "__COMBO__", "__COMBO__"],
	// ===== 第二轮：更隐蔽的变异（检验细粒度防护）=====
	["M17 XML 实体不解码（&lt; 残留）", "for (const [entity, char] of ENTITIES) out = out.replaceAll(entity, char);", "for (const [entity, char] of ENTITIES) void entity, void char;"],
	["M18 参数换行不修剪（值带多余换行）", "return text.replace(/^(?:\\r\\n|[\\r\\n])/, \"\").replace(/(?:\\r\\n|[\\r\\n])$/, \"\");", "return text;"],
	["M19 合成块索引全用 0（索引冲突）", "const blockIndex = cursor;", "const blockIndex = 0;"],
	["M20 replayState 不补块（装配器丢弃 replay）", '...patchReplayState(finishChunk.replayState, recoveredCalls.length)', '...({})'],
	["M21 空响应计数不清零（永久抑制安全网）", 'emptyResponseStreak.delete(modelKey);', '// no clear'],
	["M22 状态表无上界（内存泄漏）", 'if (emptyResponseStreak.size > MAX_TRACKED_MODELS) {', 'if (false) {'],
	["M23 JSON 形式不解析", "if (trimmed.startsWith(\"{\") && trimmed.endsWith(\"}\")) {", "if (false) {"],
	["M24 展示区区间全部失效（示例会被执行）", "__COMBO2__", "__COMBO2__"],
	["M25 只保留第一个调用（丢弃多调用）", 'for (const call of calls) recoveredCalls.push(call);', 'if (calls.length > 0 && recoveredCalls.length === 0) recoveredCalls.push(calls[0]);'],
	["M29 JSON 参数不做类型强转（与 XML 路径不一致）", "coerced[key] = typeof value === \"string\"", "coerced[key] = false && typeof value === \"string\""],
	["M31 属性位置无关失效（name 必须紧跟标签）", "function[^>]*?\\\\bname", "function\\\\s+name"],
	["M32 截断检测失效（执行半截命令）", "if (/^\\s*<\\s*\\//.test(afterClose)) return null;", "if (false) return null;"],
	["M35 整段 JSON 兜底失效（合法 JSON 调用丢失）", "if (t.startsWith(\"{\") && t.endsWith(\"}\")) {", "if (false) {"],
	["M37 消息写死块类型（误导排查）", "const base = types.length === 1 ? `only ${types[0]} blocks` : `${types.join(\", \")} blocks`;", "const base = \"only reasoning blocks\";"],
	["M38 deltas 不同步剥离（流式显示残留标记）", "const cleanedDeltas = b.deltas.length === 0", "const cleanedDeltas = b.deltas;"],
	["M39 移除类型守卫（畸形 text 导致崩溃）", "if (typeof rawText !== \"string\") return false;", "// no type guard"],
	["M40 移除 chunk 守卫（null chunk 崩溃）", "if (chunk === null || typeof chunk !== \"object\") {", "if (false) {"],
	["M41 移除 safeString 保护（Symbol 崩溃）", "const modelKey = `${safeString(options?.provider)}/${safeString(options?.model)}`;", "const modelKey = \"m\";"],
	["M42 断流时不交出扣留块（用户看不到内容）", "throw streamError;", "return;"],
	["M43 去掉扫描上限（病态输入卡死）", "if (text.length > MAX_SCAN_CHARS) return { calls: [], stripped: text };", "if (false) return { calls: [], stripped: text };"],
	["M44 行尾只支持 LF（CR 行尾命令带 \\r）", "return text.replace(/^(?:\\r\\n|[\\r\\n])/, \"\").replace(/(?:\\r\\n|[\\r\\n])$/, \"\");", "return text.replace(/^\\n/, \"\").replace(/\\n$/, \"\");"],
	["M45 剥离时丢掉正文（用户看到内容缺失）", "stripped += text.slice(cursor, openAt);", ";"],
	["M46 无法解析时丢弃标记文本（内容丢失）", "stripped += text.slice(openAt, closeEnd);", ";"],
	["M47 合成块 arguments 用对象（宿主断言拒绝）", "const argumentsJson = JSON.stringify(call.arguments);", "const argumentsJson = call.arguments;"],
	["M36 不要求参数容器（数据对象被误判）", "if (!hasContainer) return null;", "if (false) return null;"],
	["M33 空字符串被强转成 0（语义改变）", "if (typeof raw === \"string\" && raw.trim() === \"\") return raw;", "if (false) return raw;"],
	["M34 大整数丢精度（操作错误对象）", "if (typeof raw === \"string\" && /^-?\\d{16,}$/.test(raw.trim()) && !Number.isSafeInteger(parsed)) return raw;", "if (false) return raw;"],
	["M30 不识别 args 字段", "parsed.arguments ?? parsed.input ?? parsed.parameters ?? parsed.args ?? {}", "parsed.arguments ?? parsed.input ?? parsed.parameters ?? {}"],
	// ===== 第三轮：属性空格容忍（等价类划分发现的缺陷）=====
	["M27 属性等号不容忍空格（回到旧 bug）", "(?:antml:)?function[^>]*?\\\\bname\\\\s*=\\\\s*", "(?:antml:)?function[^>]*?\\\\bname="],
	["M28 parameter name 不容忍空格", "parameter[^>]*?\\\\bname\\\\s*=\\\\s*", "parameter[^>]*?\\\\bname="],
	// --- usage 顺序 ---
	["M16 usage 不扣留（顺序倒置）", 'heldUsage = chunk;', 'yield chunk;'],
];

// **缺陷 119**（第 119 轮）：`run-all.mjs` 会给 `memory-lifecycle` / `soak-test`
// 传 `--expose-gc`（否则堆测量不准），但这里**没传** —— 于是这两个套件在
// 变异测试里**基线就失败**。基线失败意味着「这个套件本来就不通过」，
// 用它判断变异是否被杀死**毫无意义**。
// 共享定义见 _suite-meta.mjs（缺陷 125：曾有四份不同步的副本）
// 本地不再维护第二份列表。

function runSuite(suitePath) {
	try {
		const base = path.basename(suitePath);
		const nodeArgs = NEEDS_GC.has(base) ? ["--expose-gc"] : [];
		execSync(`"C:\\Program Files\\nodejs\\node.exe" ${nodeArgs.concat([suitePath]).map((a) => `"${a}"`).join(" ")}`, {
			cwd: ROOT,
			env: { ...process.env, ...(DSH_LLM === undefined ? {} : { DSH_LLM_SRC: DSH_LLM }), DIAG_ORDER: "0" },
			stdio: "pipe",
			timeout: 120000,
			maxBuffer: 64 * 1024 * 1024,   // **缺陷 156**：默认 1MB 会被大输出套件撑爆
		});
		return { ok: true };
	} catch (e) {
		const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
		return { ok: false, msg: out.split("\n").filter((l) => l.includes("FAIL")).slice(0, 2).join(" | ") || out.slice(-200) };
	}
}

console.log("=== 基線（未变异）===");
let baseFail = 0;
for (const [name, p] of SUITES) {
	const r = runSuite(p);
	if (!r.ok) { baseFail++; console.log(`  ❌ 基线失败: ${name} :: ${r.msg}`); }
}
if (baseFail === 0) {
	console.log("  ✅ 所有测试基线全绿");
} else {
	// **缺陷 119**（第 119 轮）：原实现只打印警告，**仍然 exit 0** ——
	// 于是「基线失败（套件本身就不通过）」被静默吞掉，变异测试结果显示
	// 「46/46 KILLED，100%」看起来完美，实际**用的是失效的套件**。
	// 这与缺陷 106（失败被判成跳过）是同一类问题：**失败必须能被看见**。
	console.log(`  ❌ ${baseFail} 个基线失败 —— 变异测试结果**不可信**，必须修复`);
	console.log("    （基线失败的套件本来就不通过，用它判断变异是否被杀死毫无意义）");
	process.exitCode = 1;
}

// **缺陷 158 自我修正**：第一版在**整个脚本生命周期**持锁，连「基线（未变异）」阶段也持锁 ——
// 而基线阶段会跑 `shape-robustness`（它也是改写方，需要锁）→ 它拿不到锁就跳过 →
// `meta-health` 看到它没有输出（actual=null）→ 基线失败 → 变异测试被自己判为「不可信」。
//
// 正确做法：**基线阶段不需要锁**（此时 lib/index.js 未被变异，任何读者读到的都是真代码），
// 只在**变异循环期间**持锁。
if (!acquireLibWriteLock("mutation-test.mjs")) {
	console.log("跳过：另一个套件正在改写 lib/index.js（缺陷 158 的互斥保护）。");
	process.exit(0);
}
process.on("exit", () => { try { releaseLibWriteLock("mutation-test.mjs"); } catch {} });

// 写纯净备份：若本次被强杀，下次启动能据此自愈（缺陷 159）。
try { fs.writeFileSync(ORIG_BACKUP, ORIGINAL); } catch (e) { console.log("⚠️ 备份失败: " + e.message); }
process.on("exit", () => { try { fs.rmSync(ORIG_BACKUP, { force: true }); } catch {} });

console.log("\n=== 变异测试 ===");
const results = [];
for (const [mname, find, replace] of MUTANTS) {
	// 组合变异：同时替换多处（用于验证冗余保护）
	const COMBO3 = {
		"M35 裸 JSON 无边界检查（两处同时，误恢复文本片段）": [
			["if (trimmed.startsWith(\"{\") && trimmed.endsWith(\"}\")) {", "if (trimmed.includes(\"{\")) {"],
			["if (t.startsWith(\"{\") && t.endsWith(\"}\")) {", "if (t.includes(\"{\")) {"]
		]
	};
	const COMBO2 = {
		"M24 展示区区间全部失效（示例会被执行）": [
			["ranges.push([i, fenceEnd]);", "void fenceEnd;"],
			["ranges.push([i, closedAt]);", "void closedAt;"],
			["ranges.push([i, found]);", "void found;"]
		]
	};
	const COMBO = {
		// hasCodeFence 已在第 25 轮作为死代码删除，所以只剩两处上限
		"M15 去掉 ReDoS 上限（两处同时）": [
			["if (text.length > MAX_SCAN_CHARS) return false;", "// no cap (isMarkupOnlyText)"],
			["if (text.length > MAX_SCAN_CHARS) return { calls: [], stripped: text };", "// no cap (extractCalls)"]
		]
	};
	let mutated;
	if (find === "__COMBO3__") {
		mutated = ORIGINAL;
		let ok3 = true;
		for (const [f4, r4] of COMBO3[mname]) {
			if (!mutated.includes(f4)) { ok3 = false; break; }
			mutated = mutated.replace(f4, r4);
		}
		if (!ok3) {
			results.push({ mname, status: "SKIP", detail: "COMBO3 锚点未找到" });
			console.log("  ⚠️ SKIP " + mname + "（COMBO3 锚点未找到）");
			continue;
		}
	} else if (find === "__COMBO2__") {
		mutated = ORIGINAL;
		let ok2 = true;
		for (const [f3, r3] of COMBO2[mname]) {
			if (!mutated.includes(f3)) { ok2 = false; break; }
			mutated = mutated.replace(f3, r3);
		}
		if (!ok2) {
			results.push({ mname, status: "SKIP", detail: "COMBO2 锚点未找到" });
			console.log("  ⚠️ SKIP " + mname + "（COMBO2 锚点未找到）");
			continue;
		}
	} else if (find === "__COMBO__") {
		mutated = ORIGINAL;
		let allFound = true;
		for (const [f2, r2] of COMBO[mname]) {
			if (!mutated.includes(f2)) { allFound = false; break; }
			mutated = mutated.replace(f2, r2);
		}
		if (!allFound) {
			results.push({ mname, status: "SKIP", detail: "组合锚点未找到" });
			console.log("  ⚠️ SKIP " + mname + "（组合锚点未找到）");
			continue;
		}
	} else {
		if (!ORIGINAL.includes(find)) {
			results.push({ mname, status: "SKIP", detail: "找不到变异锚点（代码已变）" });
			console.log("  ⚠️ SKIP " + mname + "（锚点未找到）");
			continue;
		}
		const idx = ORIGINAL.indexOf(find);
		mutated = ORIGINAL.slice(0, idx) + replace + ORIGINAL.slice(idx + find.length);
	}
	// **缺陷 105**：写变异 → 跑套件 → 还原 这三步原来没有 try/finally 保护。
	// 虽然 runSuite 内部捕获了异常，但 `fs.writeFileSync` 本身可能抛
	// （磁盘满 / 权限 / 文件被占用）。一旦抛在这里，L268 的还原就会被跳过，
	// `lib/index.js` 会**永久停留在变异状态** —— 后续所有套件都会在坏代码上运行。
	// 改成 try/finally，保证无论发生什么都会还原。
	try {
		fs.writeFileSync(LIB, mutated);
		let killedBy2 = null;
		for (const [name, p] of SUITES) {
			const r = runSuite(p);
			if (!r.ok) { killedBy2 = { name, msg: r.msg }; break; }
		}
		if (killedBy2) {
			results.push({ mname, status: "KILLED", by: killedBy2.name });
			console.log(`  ✅ KILLED  ${mname}  （被「${killedBy2.name}」抓到）`);
		} else {
			results.push({ mname, status: "SURVIVED" });
			console.log(`  ❌ SURVIVED ${mname}  ← 测试盲区！`);
		}
	} finally {
		// 无论成功、失败还是抛异常，都必须还原
		try { fs.writeFileSync(LIB, ORIGINAL); } catch (e) {
			console.error("\n🔴 严重：无法还原 lib/index.js —— " + e.message);
			console.error("   请手动执行：git checkout lib/index.js");
			process.exit(1);
		}
	}
}
fs.writeFileSync(LIB, ORIGINAL); // 确保最终还原

const killed = results.filter((r) => r.status === "KILLED").length;
const survived = results.filter((r) => r.status === "SURVIVED").length;
const skipped = results.filter((r) => r.status === "SKIP").length;
console.log(`\n=== 结果 ===`);
console.log(`  抓到 (KILLED) : ${killed}`);
console.log(`  漏掉 (SURVIVED): ${survived}`);
console.log(`  跳过 (SKIP)   : ${skipped}`);

// **SKIP 必须算失败**。
//
// 背景：SKIP 表示「变异体的锚点找不到目标代码」——通常意味着
// 源码改动后变异体失效，该变异体**完全没有被验证**。
// 早期版本只在 survived > 0 时退出码为 1，于是 SKIP 被完全忽略：
// 本项目因此**连续四轮没发现锚点已失效**（M15/M18/M35 等），
// 变异覆盖率还在显示 100%，属于最危险的「虚假通过」。
// 现在：只要出现 SKIP，套件就失败，并明确列出每个 SKIP 的原因。
if (skipped > 0) {
	console.log("\n⚠️ 被跳过的变异体（锚点失效 → 该变异**未被验证**）：");
	for (const r of results.filter((x) => x.status === "SKIP")) {
		console.log(`  - ${r.mname}   （${r.detail ?? "原因未知"}）`);
	}
	console.log("\n  → 这通常意味着源码已改动、变异体锚点过期。");
	console.log("     请更新 mutation-test.mjs 中对应变异体的锚点字符串，让变异体重新生效。");
}
if (survived > 0) {
	console.log("\n漏掉的变异体（测试盲区）：");
	for (const r of results.filter((x) => x.status === "SURVIVED")) console.log(`  - ${r.mname}`);
}

// **真实变异覆盖率**：分母应包含 SKIP（未验证的一律不计入「已覆盖」）。
const total = results.length;
const realCoverage = total > 0 ? (killed / total) * 100 : 0;
const evaluated = killed + survived;
const evaluatedCoverage = evaluated > 0 ? (killed / evaluated) * 100 : 0;
console.log(`\n变异覆盖率（仅计已评估）: ${evaluatedCoverage.toFixed(1)}%（${killed}/${evaluated}）`);
console.log(`变异覆盖率（含 SKIP 未验证）: ${realCoverage.toFixed(1)}%（${killed}/${total}，目标 ≥ 90%）`);

	// **缺陷 119**（第 119 轮）：基线失败（套件本身就不通过）也必须算失败 ——
	// 否则「用失效套件跑出的 100% 覆盖率」会被当成通过。
	const ok = survived === 0 && skipped === 0 && realCoverage >= 90 && baseFail === 0;
if (!ok) {
		if (baseFail > 0) console.log(`\n❌ ${baseFail} 个套件基线失败 —— 变异测试结果不可信`);
	if (survived > 0) console.log("\n❌ 有变异体存活 —— 测试覆盖不足");
	if (skipped > 0) console.log("\n❌ 有变异体被跳过 —— 锚点失效，该变异未被验证");
	if (realCoverage < 90) console.log(`\n❌ 真实变异覆盖率 ${realCoverage.toFixed(1)}% < 90%`);
}
process.exit(ok ? 0 : 1);
