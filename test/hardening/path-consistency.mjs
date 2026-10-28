// 四条返回路径的一致性矩阵
//
// **第 64 轮发现的缺陷 55**：`<function=x>` + 裸 JSON 这条路径不做类型强转，
// 导致**四条路径三种行为**。修复后本套件确保不再出现同类不一致。
//
// 四条返回路径（源码位置）：
//   L247  `<parameter=key>` 元素 → parseParams（**已有**强转）
//   L263  `<function=x>` + 裸 JSON 参数体（**缺陷 55 修复点**）
//   L297  整段 JSON 但 arguments 不是对象 → 包成 `{ value: x }`
//   L306  整段 JSON 工具调用 → 逐键强转
//
// 判据：**同一份输入、同样的 properties 声明，四条路径必须给出相同的类型**。
// 这是「行为等价性」测试，比单测任何一条路径都强 —— 单测每条都「对」，
// 但路径之间的差异只有在对照时才暴露。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const plugin = await import(pathToFileURL(LIB).href + "?mx=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";

const TOOLS = [{
	name: "pwsh",
	parameters: {
		type: "object",
		properties: {
			str: { type: "string" },
			num: { type: "number" },
			int: { type: "integer" },
			flag: { type: "boolean" },
			untyped: {},
		},
	},
}];

async function run(text) {
	plugin.resetStreaks?.();
	const out = [];
	const gen = (async function* () {
		yield { type: "block-start", index: 0, blockType: "reasoning" };
		yield { type: "reasoning-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
		yield { type: "finish", reason: { kind: "stop" } };
	})();
	for await (const c of listener({ provider: "p", model: "mx-" + Math.random(), messages: [], tools: TOOLS }, () => gen)) out.push(c);
	const calls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call");
	if (calls.length === 0) return null;
	try {
		return JSON.parse(calls[0].block.arguments);
	} catch {
		return null;
	}
}

const VALS = { str: "s", num: "3.14", int: "42", flag: "true", untyped: "u" };
const JSON_BODY = JSON.stringify(VALS);

// **缺陷 129**（第 127 轮）：这里的 name 原来写成「L247 / L263 / L306」——
// 直接引用 `lib/index.js` 的**行号**。可是行号会随任何编辑漂移
// （第 126 轮加注释就让它全部失效），于是**标签本身变成误导**：
// 读者按 L263 去源码里找，找到的是完全不相干的行。
//
// 改为**语义标签**：说明「走的是哪条强转路径」而不是「在第几行」。
// 行号会漂移，语义不会。
const PATHS = [
	{
		name: "parseParams 逐键强转（<parameter=...> 元素）",
		text: OC + "\n<function=pwsh>\n" +
			Object.entries(VALS).map(([k, v]) => `<parameter=${k}>${v}\n</parameter>`).join("\n") +
			"\n</function>\n" + CC,
	},
	{
		name: "coercedJson 逐键强转（<function=...> + 裸 JSON）",
		text: OC + `\n<function=pwsh>\n${JSON_BODY}\n</function>\n` + CC,
	},
	{
		name: "coercedJson 逐键强转（<function name=..> + 裸 JSON）",
		text: OC + `\n<function name="pwsh">\n${JSON_BODY}\n</function>\n` + CC,
	},
	{
		name: "coerced 逐键强转（整段 JSON · arguments）",
		text: JSON.stringify({ name: "pwsh", arguments: VALS }),
	},
	{
		name: "coerced 逐键强转（整段 JSON · input）",
		text: JSON.stringify({ name: "pwsh", input: VALS }),
	},
	{
		name: "coerced 逐键强转（整段 JSON · arguments 为字符串）",
		text: JSON.stringify({ name: "pwsh", arguments: JSON_BODY }),
	},
];

console.log("=== 四条返回路径的类型矩阵 ===\n");
const results = [];
for (const p of PATHS) {
	const args = await run(p.text);
	results.push({ name: p.name, args });
	console.log(`${p.name}:`);
	if (!args) { console.log("  ❌ 未恢复"); continue; }
	for (const [k, v] of Object.entries(args)) {
		console.log(`  ${k.padEnd(10)} = ${JSON.stringify(v).padEnd(10)} (${typeof v})`);
	}
}

// ===========================================================================
// 1. 每条路径都必须恢复出调用
// ===========================================================================
console.log("\n=== 1. 所有路径都能恢复 ===");
for (const r of results) {
	ck(`${r.name} 能恢复出调用`, r.args !== null, r.args === null ? "null" : "");
}
console.log(`  ${results.filter((r) => r.args).length}/${results.length} 条路径恢复成功`);

// ===========================================================================
// 2. 所有路径的**类型**必须一致
// ===========================================================================
console.log("\n=== 2. 所有路径类型一致 ===");
const KEYS = Object.keys(VALS);
for (const k of KEYS) {
	const types = results.filter((r) => r.args && k in r.args).map((r) => ({ name: r.name, t: typeof r.args[k], v: r.args[k] }));
	const uniq = [...new Set(types.map((x) => x.t))];
	const ok = uniq.length <= 1;
	ck(`字段 ${k} 在所有路径上类型一致`, ok,
		ok ? "" : types.map((x) => `${x.name}=${x.t}`).join(", "));
	console.log(`  ${k.padEnd(10)}: ${ok ? "✅ " + uniq[0] : "❌ " + uniq.join("/")}`);
	if (!ok) {
		for (const x of types) console.log(`      ${x.name}: ${x.t} = ${JSON.stringify(x.v)}`);
	}
}

// ===========================================================================
// 3. 期望类型（按 properties 声明）
// ===========================================================================
console.log("\n=== 3. 期望类型 ===");
const EXPECTED = { str: "string", num: "number", int: "number", flag: "boolean", untyped: "string" };
for (const [k, want] of Object.entries(EXPECTED)) {
	const paths = results.filter((r) => r.args && k in r.args);
	const wrong = paths.filter((r) => typeof r.args[k] !== want);
	ck(`${k} 应为 ${want}`, wrong.length === 0,
		wrong.map((r) => `${r.name}=${typeof r.args[k]}`).join(", "));
	if (wrong.length === 0) console.log(`  ✅ ${k} 全部为 ${want}`);
}

// ===========================================================================
// 4. 安全：说明性 JSON 不得被当成调用（hasContainer 守卫）
// ===========================================================================
console.log("\n=== 4. 安全守卫：无参数容器的 JSON 不得执行 ===");
const DANGEROUS = [
	{ label: '{"command":"rm -rf /"}（无工具名）', text: '{"command":"rm -rf /"}' },
	{ label: '{"name":"pwsh"}（无容器键）', text: '{"name":"pwsh"}' },
	{ label: '{"tool":"pwsh"}（无容器键）', text: '{"tool":"pwsh"}' },
	{ label: '{"name":"unknown"}（未声明工具）', text: '{"name":"unknown","arguments":{}}' },
];
for (const d of DANGEROUS) {
	const args = await run(d.text);
	ck(`${d.label} 不被当作调用`, args === null, JSON.stringify(args));
	console.log(`  ${args === null ? "✅" : "❌"} ${d.label}`);
}

// ===========================================================================
// 5. arguments 不是对象时包成 { value: x }
// ===========================================================================
console.log("\n=== 5. 非对象 arguments 的包装 ===");
const WRAP = [
	{ label: "数字", json: '{"name":"pwsh","arguments":123}', expectVal: 123 },
	{ label: "布尔", json: '{"name":"pwsh","arguments":true}', expectVal: true },
	{ label: "数组", json: '{"name":"pwsh","arguments":["a"]}', expectVal: ["a"] },
];
for (const w of WRAP) {
	const args = await run(w.json);
	const ok = args !== null && "value" in args && JSON.stringify(args.value) === JSON.stringify(w.expectVal);
	ck(`arguments 为${w.label}时包成 { value: ... }`, ok, JSON.stringify(args));
	console.log(`  ${ok ? "✅" : "❌"} ${w.label}: ${JSON.stringify(args)}`);
}

// ===========================================================================
// 6. 源码层面：四条路径都必须有强转（防止回归）
// ===========================================================================
console.log("\n=== 6. 源码层面：四条路径的强转 ===");
const SRC = fs.readFileSync(LIB, "utf8");
const coerceCount = (SRC.match(/coerceValue\(/g) ?? []).length;
console.log(`  coerceValue 调用点: ${coerceCount} 处`);
	// 源码按行切开，供下方的内容锚点定位使用
	const lines = SRC.split(/\r?\n/);

	ck("coerceValue 至少 4 处（四条路径各一）", coerceCount >= 4, String(coerceCount));

	// **缺陷 128**（第 126 轮）：原来这里用**硬编码行号**（L263 / L306）定位
	// 「逐键强转路径」，只要在它们之前插入任意行（哪怕只是改注释），
	// 行号就偏移，这两个检查**立刻误报**。本轮给 `PARAM_NAME_RE` 加注释
	// 就触发了这个脆弱性。
	//
	// 改为**按内容锚点**定位：找「逐键强转」的两处特征代码，再看它们上方
	// 是否出现 coerceValue。这样只要语义不变，插入/删除行都不影响。
	const COERCE_ANCHORS = [
		{ name: "<function> + 裸 JSON 参数体", anchor: "coercedJson[key] = typeof value ===" },
		{ name: "整段 JSON 工具调用", anchor: "coerced[key] = typeof value ===" },
	];
	let withCoerce = 0;
	for (const ca of COERCE_ANCHORS) {
		const at = lines.findIndex((l) => l.replace(/\s+/g, " ").trim().startsWith(ca.anchor));
		if (at < 0) { console.log(`    ❌ 找不到锚点: ${ca.name}`); continue; }
		let found = false;
		// 强转调用可能是**续行**（`? coerceValue(...)` 在下一行），所以范围要向后扩。
		for (let i = Math.max(0, at - 14); i <= Math.min(at + 3, lines.length - 1); i++) {
			if (lines[i] && lines[i].includes("coerceValue")) { found = true; break; }
		}
		if (found) withCoerce++;
		else console.log(`    ❌ ${ca.name}（L${at + 1}）附近没有 coerceValue`);
	}
	ck("两条逐键强转路径都有 coerceValue", withCoerce === COERCE_ANCHORS.length,
		`${withCoerce}/${COERCE_ANCHORS.length}`);
	console.log(`  逐键强转路径: ${withCoerce}/${COERCE_ANCHORS.length} 有 coerceValue`);

// **额外**：parseParams 内部必须有强转（覆盖 L247 路径）
const parseParamsIdx = lines.findIndex((l) => /^function parseParams\(/.test(l));
if (parseParamsIdx >= 0) {
	let hasCoerceInside = false;
	for (let i = parseParamsIdx; i < Math.min(parseParamsIdx + 40, lines.length); i++) {
		if (lines[i].includes("coerceValue")) { hasCoerceInside = true; break; }
		if (/^}/.test(lines[i])) break;
	}
	ck("parseParams 内部有 coerceValue（覆盖 <parameter> 路径）", hasCoerceInside, "");
	console.log(`  parseParams 内部强转: ${hasCoerceInside}`);
}

// ===========================================================================
// 7. 合成流必须通过**宿主真实校验器**
//
// **第 66 轮**：本套件原本只验参数值，没验「合成出的流能否被宿主接受」。
// 缺陷 55 改的正是参数序列化 —— 若序列化出错（如 arguments 不是字符串），
// 宿主会拒绝整条流，而参数值检查**看不出来**。
// ===========================================================================
console.log("\n=== 7. 合成流通过宿主真实校验器 ===");
{
	// 尝试加载真实宿主；不可用时明确跳过（不静默通过）
	const LLM_CANDIDATES = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
	].filter(Boolean);
	const llmPath = LLM_CANDIDATES.find((p) => fs.existsSync(p));

	if (!llmPath) {
		console.log("  ⚠️ 找不到 dsh-llm，跳过（需 DSH_LLM_SRC）");
	} else {
		const host = await import(pathToFileURL(llmPath).href);
		const { BlockAssembler } = host;
		ck("能从 dsh-llm 导入 BlockAssembler", typeof BlockAssembler === "function", typeof BlockAssembler);

		// 对每条路径跑到真实装配器里
		for (const p of PATHS) {
			const out = [];
			plugin.resetStreaks?.();
			const gen = (async function* () {
				yield { type: "block-start", index: 0, blockType: "reasoning" };
				yield { type: "reasoning-delta", index: 0, text: p.text };
				yield { type: "block-end", index: 0, block: { type: "reasoning", text: p.text } };
				yield { type: "finish", reason: { kind: "stop" } };
			})();
			for await (const c of listener({ provider: "p", model: "hx-" + Math.random(), messages: [], tools: TOOLS }, () => gen)) out.push(c);

			let assembled;
			try {
				const acc = new BlockAssembler();
				for (const c of out) acc.push(c);
				assembled = acc.assembled();
				ck(`${p.name}: 通过宿主 BlockAssembler`, true);
			} catch (e) {
				ck(`${p.name}: 通过宿主 BlockAssembler`, false, e.message);
				continue;
			}

			const tc = assembled.blocks.find((b) => b?.type === "tool-call");
			if (!tc) {
				ck(`${p.name}: 装配后有 tool-call 块`, false, assembled.blocks.map((b) => b?.type).join(","));
				continue;
			}
			ck(`${p.name}: 装配后有 tool-call 块`, true);

			// **宿主协议**：arguments 必须是字符串（JSON）
			ck(`${p.name}: arguments 是字符串`, typeof tc.arguments === "string", typeof tc.arguments);
			if (typeof tc.arguments === "string") {
				let ok = false;
				try { JSON.parse(tc.arguments); ok = true; } catch { ok = false; }
				ck(`${p.name}: arguments 是合法 JSON`, ok, String(tc.arguments).slice(0, 60));
			}

			// id 必须是非空字符串且唯一（本流内）
			ck(`${p.name}: id 是非空字符串`, typeof tc.id === "string" && tc.id.length > 0, String(tc.id));
		}

		// **id 唯一性**：同一流里多个调用必须有不同 id（ordinal 保证）
		{
			// **关键（缺陷 57）**：必须用两个**内容完全相同**的调用。
			// 内容不同时哈希本来就不同，测不出 ordinal 的作用 ——
			// 把 `-${ordinal}` 去掉后本套件曾仍然通过。
			const ONE = OC + '\n<function=pwsh>\n{"str":"same"}\n</function>\n' + CC;
			const multiText = ONE + "\n\n" + ONE + "\n\n" + ONE;

			plugin.resetStreaks?.();
			const out2 = [];
			const gen2 = (async function* () {
				yield { type: "block-start", index: 0, blockType: "reasoning" };
				yield { type: "reasoning-delta", index: 0, text: multiText };
				yield { type: "block-end", index: 0, block: { type: "reasoning", text: multiText } };
				yield { type: "finish", reason: { kind: "stop" } };
			})();
			for await (const c of listener({ provider: "p", model: "multi-" + Math.random(), messages: [], tools: TOOLS }, () => gen2)) out2.push(c);
			const acc2 = new BlockAssembler();
			for (const c of out2) acc2.push(c);
			const tcs = acc2.assembled().blocks.filter((b) => b?.type === "tool-call");
			console.log(`  三个**完全相同**的调用: ${tcs.length} 个`);
			console.log(`  ids=${JSON.stringify(tcs.map((b) => b.id))}`);
			ck("三个完全相同的调用都能恢复", tcs.length === 3, String(tcs.length));
			const idSet = new Set(tcs.map((b) => b.id));
			ck("三个**内容相同**的调用 id 互不相同（ordinal 生效）",
				idSet.size === tcs.length,
				`${idSet.size}/${tcs.length}：${JSON.stringify(tcs.map((b) => b.id))}`);
		}
	}
}

console.log(`\n===== 四条路径一致性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
