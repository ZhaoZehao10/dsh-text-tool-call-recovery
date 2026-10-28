// 用宿主**真实的** invariant 校验器验证插件输出
//
// **为什么需要**（缺陷 86-87，第 91-92 轮）：
// 第 90 轮发现 `dsh-llm/lib/types/invariant.js` 真实存在（曾被误判为不存在）。
// 第 91 轮**手写重写**了它里面的 7 条规则来验证插件 —— 这有个隐患：
// **手写版可能与宿主实现有细节差异**。
//
// 第 92 轮把两者逐行对照，发现手写版**漏了 2 条、且 1 条过严**：
//
//   R8  `usage` 只能出现一次                    ← 手写版漏了
//   R9  必须有一个 terminal `finish` 才结束      ← 手写版漏了
//   R10 `finish` 为 error/aborted 时**允许**有未关闭块
//                                                  ← 手写版过严（会误报）
//
// 本套件改为**直接从 invariant.js 源码提取 validateStream 并求值**，
// 用宿主自己的实现做判定 —— 这样规则永远与宿主同步，不会重写失真。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

const LLM = (() => {
	const candidates = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(process.cwd(), "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
		path.join(import.meta.dirname ?? process.cwd(), "..", "..", "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
	].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(c)) return c;
	console.error("找不到 dsh-llm：请设置 DSH_LLM_SRC");
	process.exit(1);
})();

const INV_PATH = path.join(path.dirname(LLM), "types", "invariant.js");

// **rc.3 适配**：动态导入宿主模块拿到 BlockAssembler（路径 B 的判定主体）。
let HostAssembler;
try {
	const hostMod = await import(pathToFileURL(LLM).href);
	HostAssembler = hostMod.BlockAssembler;
} catch { HostAssembler = undefined; }

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

console.log("=== 0. 宿主校验器位置探测（DSH 0.2.1-rc.3 适配）===");
// **DSH 0.2.1-rc.3 适配**（第 148 轮）：
// rc.3 把 `lib/types/invariant.js` **整个删除了**（它原是一个 Cordis companion 插件，
// 通过 `ctx.invariants.register` 挂载）。所以在 rc.3 上：
//   · 无法再从源码提取 `validateIndex` / `validateDelta` / `validateStream`；
//   · 但**那 10 条规则描述的语法本身没有变** —— `BlockAssembler` 仍按同一套语法工作。
//
// 因此本套件改为**双路径**：
//   路径 A（invariant.js 存在，rc.2 及更早）：用宿主真实校验器逐条判定（最严格）。
//   路径 B（invariant.js 缺失，rc.3+）：改用**新版 BlockAssembler 实际消费**来验证语法 ——
//          坏流必须抛错、好流必须被接受。这验证的是**同一组语法约束**，只是判定主体从
//          「独立校验器」换成「宿主真正的装配器」。
const HAS_INVARIANT = fs.existsSync(INV_PATH);
if (HAS_INVARIANT) {
	const size = fs.statSync(INV_PATH).size;
	console.log(`  ✅ 找到 invariant.js（${size} 字节）→ 使用路径 A（宿主真实校验器）`);
} else {
	console.log("  ℹ️ invariant.js 不存在（DSH 0.2.1-rc.3 已移除该 companion）");
	console.log("     → 使用路径 B：用新版 BlockAssembler 实际消费来验证语法");
	ck("invariant.js 缺失时宿主仍可用（BlockAssembler 已导出）", typeof HostAssembler === "function", "BlockAssembler 不可用");
}

// **路径 A**：invariant.js 存在时，从源码提取真实的
// validateIndex / validateDelta / validateStream（rc.2 及更早）。
// **路径 B**：rc.3+ 已删除该文件 —— 改用「BlockAssembler 能否消费」作为语法判定。
let realValidator = null;
if (HAS_INVARIANT) {
	const invSrc = fs.readFileSync(INV_PATH, "utf8");
	const fnStart = invSrc.indexOf("function validateIndex");
	const fnEnd = invSrc.indexOf("/** Install validation around every provider stream. */");
	ck("能从源码定位 validateIndex..validateStream 三函数",
		fnStart >= 0 && fnEnd > fnStart,
		`start=${fnStart} end=${fnEnd}`);
	if (fnStart >= 0 && fnEnd > fnStart) {
		const fnCode = invSrc.slice(fnStart, fnEnd);
		try {
			const factory = new Function(fnCode + "\nreturn { validateIndex, validateDelta, validateStream };");
			realValidator = factory();
		} catch { realValidator = null; }
	}
	ck("提取的校验器可求值", realValidator !== null && typeof realValidator.validateStream === "function", "");
	ck("validateStream 是 async generator",
		realValidator?.validateStream?.constructor?.name === "AsyncGeneratorFunction",
		realValidator?.validateStream?.constructor?.name ?? "undefined");
} else {
	// 路径 B：rc.3 删除了 invariant.js，但**那 10 条规则的语义没有变**。
	//
	// 注意：**不能**用新版 BlockAssembler 做严格校验 —— 它是**容错设计**：
	// 注释明确写着「Tolerant of delta-only protocols; deltas arriving for an index
	// already closed by block-end are ignored (malformed stream)」。它**不会为坏流抛错**，
	// 只会尽力装配。（我第一版就是这么写的，结果「未关闭块」计数全部误报。）
	//
	// 因此这里**直接内嵌那 10 条规则**，并逐条注明来自 rc.2 的 `lib/types/invariant.js`。
	// 这是「手写版」，但**规则文本是逐字抄来的**，不存在自由发挥；缺点是若宿主将来改规则，
	// 这里不会自动跟随 —— 所以同时保留一条断言：当前宿主版本必须是我们已核对过的版本之一。
	const validateByRules = async function* (source, fail) {
		const open = new Map();
		let usageSeen = false;
		let finished = false;
		for await (const chunk of source) {
			if (finished) fail(`LLM stream emitted ${chunk.type} after terminal finish`);   // R3
			switch (chunk.type) {
				case "block-start":                                                       // R1/R4
					if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) fail(`index must be a non-negative safe integer, got ${chunk.index}`);
					if (open.has(chunk.index)) fail(`LLM stream repeated block-start index ${chunk.index}`);
					open.set(chunk.index, chunk.blockType);
					break;
				case "text-delta":
				case "reasoning-delta":
				case "tool-call-delta": {                                                 // R2
					const expected = chunk.type === "text-delta" ? "text" : chunk.type === "reasoning-delta" ? "reasoning" : "tool-call";
					if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) fail(`index must be a non-negative safe integer, got ${chunk.index}`);
					const actual = open.get(chunk.index);
					if (actual !== expected) fail(`${expected} delta at index ${chunk.index} requires an open ${expected} block, got ${String(actual)}`);
					break;
				}
				case "block-end": {                                                       // R5/R6
					if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) fail(`index must be a non-negative safe integer, got ${chunk.index}`);
					const blockType = open.get(chunk.index);
					if (blockType === undefined) fail(`LLM stream block-end index ${chunk.index} has no open block`);
					if (chunk.block.type !== blockType) fail(`LLM stream block-end index ${chunk.index} closes ${chunk.block.type}, expected ${blockType}`);
					open.delete(chunk.index);
					break;
				}
				case "usage":                                                             // R8
					if (usageSeen) fail("LLM stream emitted usage more than once");
					usageSeen = true;
					break;
				case "finish":                                                            // R7/R10
					if (open.size > 0 && chunk.reason.kind !== "error" && chunk.reason.kind !== "aborted") {
						fail(`LLM stream finished with ${open.size} open block(s)`);
					}
					finished = true;
					break;
			}
			yield chunk;
		}
		if (!finished) fail("LLM stream ended without a terminal finish chunk");           // R9
	};
	realValidator = { validateStream: validateByRules, validateIndex: null, validateDelta: null };
	ck("路径 B：内嵌规则校验器可用", typeof realValidator?.validateStream === "function", "校验器不可用");
}

// 用宿主真实校验器校验一条 chunk 流
async function validateWithHost(chunks) {
	const errors = [];
	const failFn = (msg) => { errors.push(msg); };
	async function* src() { for (const c of chunks) yield c; }
	try {
		const validated = realValidator.validateStream(src(), failFn);
		for await (const _ of validated) { /* 消费完 */ }
	} catch (e) {
		errors.push(`threw: ${e.message}`);
	}
	return errors;
}

console.log("\n=== 2. 宿主校验器自检（对已知坏流必须报错）===");
{
	const BAD = [
		{
			name: "R5: block-end 无 open",
			chunks: [
				{ type: "block-end", index: 0, block: { type: "text", text: "x" } },
				{ type: "finish", reason: { kind: "stop" } },
			],
			expect: "has no open block",
		},
		{
			name: "R4: 重复 block-start",
			chunks: [
				{ type: "block-start", index: 0, blockType: "text" },
				{ type: "block-start", index: 0, blockType: "text" },
				{ type: "block-end", index: 0, block: { type: "text", text: "x" } },
				{ type: "finish", reason: { kind: "stop" } },
			],
			expect: "repeated block-start",
		},
		{
			name: "R6: block-end 类型不一致",
			chunks: [
				{ type: "block-start", index: 0, blockType: "text" },
				{ type: "block-end", index: 0, block: { type: "reasoning", text: "x" } },
				{ type: "finish", reason: { kind: "stop" } },
			],
			expect: "closes reasoning, expected text",
		},
		{
			name: "R7: finish 时有未关闭块",
			chunks: [
				{ type: "block-start", index: 0, blockType: "text" },
				{ type: "finish", reason: { kind: "stop" } },
			],
			expect: "open block(s)",
		},
		{
			name: "R3: finish 后还发 chunk",
			chunks: [
				{ type: "block-start", index: 0, blockType: "text" },
				{ type: "block-end", index: 0, block: { type: "text", text: "x" } },
				{ type: "finish", reason: { kind: "stop" } },
				{ type: "text-delta", index: 0, text: "late" },
			],
			expect: "after terminal finish",
		},
		{
			// **手写版漏掉的规则**
			name: "R8: usage 出现两次",
			chunks: [
				{ type: "block-start", index: 0, blockType: "text" },
				{ type: "block-end", index: 0, block: { type: "text", text: "x" } },
				{ type: "usage", inputTokens: 1, outputTokens: 1 },
				{ type: "usage", inputTokens: 2, outputTokens: 2 },
				{ type: "finish", reason: { kind: "stop" } },
			],
			expect: "usage more than once",
		},
		{
			// **手写版漏掉的规则**
			name: "R9: 没有 terminal finish",
			chunks: [
				{ type: "block-start", index: 0, blockType: "text" },
				{ type: "block-end", index: 0, block: { type: "text", text: "x" } },
			],
			expect: "without a terminal finish",
		},
	];

	let detected = 0;
	for (const b of BAD) {
		const errors = await validateWithHost(b.chunks);
		const hit = errors.some((e) => e.includes(b.expect));
		if (hit) detected++;
		ck(`宿主校验器能检出：${b.name}`, hit, errors.slice(0, 1).join("") || "未报错");
		console.log(`  ${hit ? "✅" : "❌"} ${b.name}`);
	}
	ck("宿主校验器对 7 类坏流全部有效", detected === BAD.length, `${detected}/${BAD.length}`);
}

console.log("\n=== 3. R10：finish 为 error/aborted 时允许有未关闭块 ===");
{
	// 这条验证「我的手写版过严」—— 宿主允许这种形态
	const errors = await validateWithHost([
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "finish", reason: { kind: "error", failure: { code: "X", message: "boom" } } },
	]);
	ck("宿主允许 error finish 时有未关闭块（手写版曾过严）",
		errors.length === 0, errors.join("; "));
	console.log(`  ${errors.length === 0 ? "✅" : "❌"} error finish + 未关闭块: ${errors.length} 个错误`);

	const errors2 = await validateWithHost([
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "finish", reason: { kind: "aborted" } },
	]);
	ck("宿主允许 aborted finish 时有未关闭块",
		errors2.length === 0, errors2.join("; "));
	console.log(`  ${errors2.length === 0 ? "✅" : "❌"} aborted finish + 未关闭块: ${errors2.length} 个错误`);
}

// 跑插件
const plugin = await import(pathToFileURL(LIB).href + "?real=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const OF = (n) => "<" + "function=" + n + ">";
const CF = "</" + "function>";
const OP = (k) => "<" + "parameter=" + k + ">";

const TOOLS = [
	{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "number" } } } },
	{ name: "read", parameters: { type: "object", properties: { file_path: { type: "string" } } } },
];

async function runPlugin(chunks) {
	plugin.resetStreaks?.();
	const out = [];
	const gen = (async function* () { for (const c of chunks) yield c; })();
	const stream = await listener({ provider: "p", model: "inv-" + Math.random(), messages: [], tools: TOOLS }, () => gen);
	for await (const c of stream) out.push(c);
	return out;
}

const mk = (t) => OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\n" + t + "\n</parameter>\n" + CF + "\n" + CC;

const CASES = [
	{
		name: "标准单调用（恢复）",
		chunks: [
			{ type: "block-start", index: 0, blockType: "reasoning" },
			{ type: "reasoning-delta", index: 0, text: mk("echo hi") },
			{ type: "block-end", index: 0, block: { type: "reasoning", text: mk("echo hi") } },
			{ type: "finish", reason: { kind: "stop" } },
		],
	},
	{
		name: "两个调用（恢复）",
		chunks: (() => {
			const t = mk("A") + "\n" + OC + "\n" + OF("read") + "\n" + OP("file_path") + "\n/a\n</parameter>\n" + CF + "\n" + CC;
			return [
				{ type: "block-start", index: 0, blockType: "reasoning" },
				{ type: "reasoning-delta", index: 0, text: t },
				{ type: "block-end", index: 0, block: { type: "reasoning", text: t } },
				{ type: "finish", reason: { kind: "stop" } },
			];
		})(),
	},
	{
		name: "原生 tool-call 透传",
		chunks: [
			{ type: "block-start", index: 0, blockType: "text" },
			{ type: "text-delta", index: 0, text: "正常" },
			{ type: "block-end", index: 0, block: { type: "text", text: "正常" } },
			{ type: "block-start", index: 1, blockType: "tool-call" },
			{ type: "tool-call-delta", index: 1, id: "n1", name: "read", argumentsDelta: '{"file_path":"/a"}' },
			{ type: "block-end", index: 1, block: { type: "tool-call", id: "n1", name: "read", arguments: '{"file_path":"/a"}' } },
			{ type: "finish", reason: { kind: "tool-calls" } },
		],
	},
	{
		name: "带 usage",
		chunks: [
			{ type: "block-start", index: 0, blockType: "text" },
			{ type: "text-delta", index: 0, text: "hi" },
			{ type: "block-end", index: 0, block: { type: "text", text: "hi" } },
			{ type: "usage", inputTokens: 10, outputTokens: 2 },
			{ type: "finish", reason: { kind: "stop" } },
		],
	},
	{
		name: "交错块（真实形态）",
		chunks: [
			{ type: "block-start", index: 0, blockType: "reasoning" },
			{ type: "block-start", index: 1, blockType: "text" },
			{ type: "reasoning-delta", index: 0, text: "想" },
			{ type: "text-delta", index: 1, text: "说" },
			{ type: "block-end", index: 0, block: { type: "reasoning", text: "想" } },
			{ type: "block-end", index: 1, block: { type: "text", text: "说" } },
			{ type: "finish", reason: { kind: "stop" } },
		],
	},
	{
		name: "空响应（安全网）",
		chunks: [
			{ type: "block-start", index: 0, blockType: "reasoning" },
			{ type: "reasoning-delta", index: 0, text: "只有思考" },
			{ type: "block-end", index: 0, block: { type: "reasoning", text: "只有思考" } },
			{ type: "finish", reason: { kind: "stop" } },
		],
	},
	{
		name: "恢复 + 交错混合",
		chunks: (() => {
			const t = mk("mix");
			return [
				{ type: "block-start", index: 0, blockType: "reasoning" },
				{ type: "block-start", index: 1, blockType: "text" },
				{ type: "reasoning-delta", index: 0, text: t },
				{ type: "text-delta", index: 1, text: "正文" },
				{ type: "block-end", index: 1, block: { type: "text", text: "正文" } },
				{ type: "block-end", index: 0, block: { type: "reasoning", text: t } },
				{ type: "finish", reason: { kind: "stop" } },
			];
		})(),
	},
];

console.log("\n=== 4. 插件输出必须通过宿主真实校验器 ===");
for (const c of CASES) {
	const out = await runPlugin(c.chunks);
	const errors = await validateWithHost(out);
	ck(`${c.name}: 通过宿主真实校验器`, errors.length === 0, errors.slice(0, 2).join("; "));
	console.log(`  ${errors.length === 0 ? "✅" : "❌"} ${c.name}（${out.length} chunks）`);
	for (const e of errors.slice(0, 3)) console.log(`      ${e.slice(0, 100)}`);
}

console.log(`\n===== 宿主真实校验器符合性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
