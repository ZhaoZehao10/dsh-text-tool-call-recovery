// 跨宿主配置兼容性审查
//
// 前 33 轮都在**同一个 profile** 里测。但真实用户的配置千差万别：
//   - 不同的 profile 名（不只是 desktop）
//   - 插件被其他 bundle 包裹（不在顶层）
//   - 用户设了同名环境变量
//   - 其他插件也挂 llm/stream（已在 plugin-coexistence 覆盖）
//   - profile 路径含空格/中文/非 ASCII
//
// 本套件验证插件在这些环境下是否仍然工作。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const src = fs.readFileSync(LIB, "utf8");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const MARKUP = OC + "\n<function=pwsh>\n<parameter=command>\necho hi\n</parameter>\n</function>\n" + CC;
const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };

console.log("=== 1. 环境变量污染 ===");
{
	const ENV_NAME = "DSH_TEXT_TOOL_CALL_RECOVERY";

	// 1a: 未设置 → 启用
	{
		delete process.env[ENV_NAME];
		const p = await import(pathToFileURL(LIB).href + "?e1=" + Date.now());
		let listener = null;
		p.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });
		ck("未设环境变量 → 启用", listener !== null, String(listener));
	}

	// 1b: 设为 "0" → 禁用（设计意图）
	{
		process.env[ENV_NAME] = "0";
		const p = await import(pathToFileURL(LIB).href + "?e2=" + Date.now());
		let listener = null;
		p.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });
		ck("设为 0 → 禁用（设计意图）", listener === null, String(listener));
	}

	// 1c: 其他各种值 → 仍启用（避免用户误设）
	for (const v of ["1", "true", "false", "yes", "no", "on", "off", "", " ", "00", " 0 ", "0.0"]) {
		process.env[ENV_NAME] = v;
		const p = await import(pathToFileURL(LIB).href + "?e3=" + encodeURIComponent(v) + Date.now());
		let listener = null;
		p.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });
		ck(`设为 ${JSON.stringify(v)} → 仍启用`, listener !== null, String(listener));
	}

	// 1d: 大小写变体
	//
	// **踩过的坑（我的测试 bug，不是插件缺陷）**：
	//   Windows 的 process.env 是**大小写不敏感**的（底层是 Windows 环境块）。
	//   所以 `delete process.env["DSH_TEXT_TOOL_CALL_RECOVERY"]` 会把小写变体
	//   `dsh_text_tool_call_recovery` **也一起删掉**。
	//   第一版测试先设小写、再 delete 大写（想清理残留），结果两个都没了，
	//   插件读到 undefined 正常启用，而断言期望"禁用"→ 假失败。
	//
	//   正确做法：只在**同一个键名**上操作，不混用大小写；
	//   并且断言按平台区分（Windows 不敏感 / 其他敏感）。
	const isWindows = process.platform === "win32";
	{
		// 先彻底清理（用大写键，Windows 上会连带清理小写）
		delete process.env[ENV_NAME];

		// Windows：设小写，插件读大写 → 应能读到（不敏感）
		if (isWindows) {
			process.env["dsh_text_tool_call_recovery"] = "0";
			const readBack = process.env[ENV_NAME];
			ck("Windows: 小写设置能被大写键读到（大小写不敏感）", readBack === "0", String(readBack));
			delete process.env[ENV_NAME];
			ck("Windows: 清理后读到 undefined", process.env[ENV_NAME] === undefined, String(process.env[ENV_NAME]));
		} else {
			// 非 Windows：设小写，插件读大写 → 读不到 → 插件应**仍然启用**
			process.env["dsh_text_tool_call_recovery"] = "0";
			const p2 = await import(pathToFileURL(LIB).href + "?e4=" + Date.now());
			let listener2 = null;
			p2.apply({ on: (e, h) => { if (e === "llm/stream") listener2 = h; } });
			ck("非 Windows: 小写设置不影响大写开关（大小写敏感）", listener2 !== null, String(listener2));
			delete process.env["dsh_text_tool_call_recovery"];
		}
	}

	delete process.env[ENV_NAME];
}

console.log("\n=== 2. profile 路径含特殊字符（安装脚本视角）===");
{
	// 插件的 lib/index.js 本身不读路径，但安装脚本会处理路径。
	// 这里验证「安装到含空格/中文的 profile」后插件仍可加载。
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-special-path-"));
	const cases = [
		["含空格", path.join(base, "my profile")],
		["含中文", path.join(base, "我的配置")],
		["含空格+中文", path.join(base, "我的 profile 2")],
	];
	for (const [label, profileDir] of cases) {
		const dest = path.join(profileDir, "node_modules", "@zhaozehao10", "dsh-text-tool-call-recovery", "lib");
		try {
			fs.mkdirSync(dest, { recursive: true });
			fs.copyFileSync(LIB, path.join(dest, "index.js"));
			// 尝试用 ESM 加载（路径含特殊字符 → 需要正确的 URL 编码）
			const url = pathToFileURL(path.join(dest, "index.js")).href;
			const m = await import(url + "?sp=" + Date.now());
			ck(`profile ${label} → 插件可加载`, typeof m.apply === "function", typeof m.apply);
			// 且能实际工作
			let listener = null;
			m.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });
			ck(`profile ${label} → 注册成功`, listener !== null, "");
		} catch (e) {
			ck(`profile ${label} → 插件可加载`, false, e.message);
		}
	}
	fs.rmSync(base, { recursive: true, force: true });
}

console.log("\n=== 3. 插件在不同调用方式下工作 ===");
{
	const plugin = await import(pathToFileURL(LIB).href + "?modes=" + Date.now());

	// 3a: 正常 apply
	{
		let listener = null;
		const ret = plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });
		ck("apply 返回正常", ret === undefined || ret !== null, String(ret));
		ck("apply 注册 llm/stream", listener !== null, "");
	}

	// 3b: ctx.on 返回 unsubscriber 时（cordis 风格）
	{
		let listener = null;
		const unsub = () => { };
		const ctx = { on: (e, h) => { if (e === "llm/stream") listener = h; return unsub; } };
		const ret = plugin.apply(ctx);
		ck("ctx.on 返回 unsubscribe 时 apply 不崩", listener !== null, "");
		// apply 不应吞掉 unsubscribe 而报错
		ck("apply 不因返回值异常", ret === undefined || ret !== null, "");
	}

	// 3c: ctx 有多余属性
	{
		let listener = null;
		const ctx = {
			on: (e, h) => { if (e === "llm/stream") listener = h; },
			logger: { info() { }, error() { } },
			config: {},
			plugin: () => { },
		};
		plugin.apply(ctx);
		ck("ctx 含额外属性时正常工作", listener !== null, "");
	}
}

console.log("\n=== 4. 宿主给的工具声明形态差异 ===");
{
	const plugin2 = await import(pathToFileURL(LIB).href + "?tools=" + Date.now());
	let listener = null;
	plugin2.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

	async function runWithTools(tools) {
		plugin2.resetStreaks?.();
		const out = [];
		const gen = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text: MARKUP };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text: MARKUP } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		try {
			for await (const c of listener({ provider: "p", model: "m", messages: [], tools }, () => gen)) out.push(c);
		} catch (e) {
			return { calls: 0, err: e.message };
		}
		return { calls: out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").length, err: null };
	}

	const shapes = [
		["标准 {name, parameters}", [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }]],
		["OpenAI {type,function}", [{ type: "function", function: { name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } } }]],
		["只有 name", [{ name: "pwsh" }]],
		["name + 空 parameters", [{ name: "pwsh", parameters: {} }]],
		["name + parameters 无 properties", [{ name: "pwsh", parameters: { type: "object" } }]],
		["数组含多个工具", [{ name: "read" }, { name: "pwsh", parameters: { properties: { command: { type: "string" } } } }]],
	];
	for (const [label, tools] of shapes) {
		const r = await runWithTools(tools);
		ck(`工具声明 ${label} → 能恢复`, r.calls === 1, `calls=${r.calls} err=${r.err ?? ""}`);
	}
}

console.log("\n=== 5. 插件不假设特定的 tool_call 标记形态 ===");
{
	const plugin3 = await import(pathToFileURL(LIB).href + "?shapes=" + Date.now());
	let listener = null;
	plugin3.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

	async function run(text) {
		plugin3.resetStreaks?.();
		const out = [];
		const gen = (async function* () {
			yield { type: "block-start", index: 0, blockType: "text" };
			yield { type: "text-delta", index: 0, text };
			yield { type: "block-end", index: 0, block: { type: "text", text } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		for await (const c of listener(OPTS, () => gen)) out.push(c);
		return out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").length;
	}

	const shapes = [
		["Qwen <function=>", OC + "\n<function=pwsh>\n<parameter=command>echo a\n</parameter>\n</function>\n" + CC],
		["Qwen <function name=>", OC + "\n<function name=\"pwsh\">\n<parameter name=\"command\">echo b</parameter>\n</function>\n" + CC],
		["antml:function", OC + "\n<antml:function name=\"pwsh\">\n<parameter name=\"command\">echo c</parameter>\n</antml:function>\n" + CC],
		["invoke", OC + "\n<invoke name=\"pwsh\">\n<parameter name=\"command\">echo d</parameter>\n</invoke>\n" + CC],
		["裸露（无 tool_call 包裹）", "<function name=\"pwsh\">\n<parameter name=\"command\">echo e</parameter>\n</function>"],
		["纯 JSON", '{"name":"pwsh","arguments":{"command":"echo f"}}'],
	];
	for (const [label, text] of shapes) {
		const n = await run(text);
		ck(`标记形态 ${label} → 能恢复`, n === 1, `${n} 个`);
	}
}

console.log("\n=== 6. 插件对 finish.reason.kind 的兼容 ===");
{
	const plugin4 = await import(pathToFileURL(LIB).href + "?kinds=" + Date.now());
	let listener = null;
	plugin4.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

	async function run(kind) {
		plugin4.resetStreaks?.();
		const out = [];
		const gen = (async function* () {
			yield { type: "block-start", index: 0, blockType: "text" };
			yield { type: "text-delta", index: 0, text: MARKUP };
			yield { type: "block-end", index: 0, block: { type: "text", text: MARKUP } };
			yield { type: "finish", reason: { kind } };
		})();
		for await (const c of listener(OPTS, () => gen)) out.push(c);
		return out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").length;
	}

	// 只有 stop 时才恢复（其他 kind 原样放行）
	for (const [kind, shouldRecover] of [["stop", true], ["length", false], ["error", false], ["aborted", false], ["content_filter", false]]) {
		const n = await run(kind);
		ck(`finish.kind=${kind} → ${shouldRecover ? "恢复" : "原样放行"}`, shouldRecover ? n === 1 : n === 0, `${n} 个`);
	}
}

console.log("\n=== 7. 插件源码不假设特定平台 ===");
{
	ck("无 Windows 专用路径分隔符硬编码", !/["'][A-Z]:\\\\/.test(src), "");
	ck("无 Unix 专用路径硬编码", !/["']\/(?:usr|home|etc)\//.test(src), "");
	ck("无平台判断分支", !/process\.platform/.test(src), "");
	ck("无 __dirname/__filename（ESM 不应使用）", !/__dirname|__filename/.test(src), "");
	ck("无 require()（ESM 不应使用）", !/(^|[^.\w])require\s*\(/.test(src), "");
	ck("无 fetch/网络调用", !/\bfetch\s*\(/.test(src), "");
	ck("无 fs/path 等 Node 内置模块导入", !/from\s+["']node:(fs|path|os|child_process)/.test(src), "");
}

console.log(`\n===== 跨宿主配置兼容性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细（前 15 条）---");
	for (const f of failures.slice(0, 15)) console.log(`  ❌ ${f}`);
	if (failures.length > 15) console.log(`  ... 另有 ${failures.length - 15} 条`);
}
process.exit(fail === 0 ? 0 : 1);
