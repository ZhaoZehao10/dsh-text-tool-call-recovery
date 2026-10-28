// 原型污染与解析器安全审查
//
// 这是真实且常见的漏洞类别。模型输出完全不可信 —— 攻击者（或模型失控）
// 可能输出 `__proto__` / `constructor` / `prototype` 作为参数名。
//
// 风险：
//   1. 参数对象构造时用 `obj[key] = value`，key = "__proto__" 会污染 Object.prototype
//   2. JSON.parse 的 __proto__ 处理（JSON.parse 本身不会污染，但后续赋值可能）
//   3. 污染后影响整个进程（宿主所有插件/会话）
//   4. 用 Object.create(null) 可彻底避免，但要验证不影响下游
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

const plugin = await import(pathToFileURL(LIB).href + "?proto=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const OPTS = { provider: "p", model: "m", messages: [], tools: TOOLS };

async function run(text) {
	plugin.resetStreaks?.();
	const out = [];
	let err = null;
	try {
		const gen = (async function* () {
			yield { type: "block-start", index: 0, blockType: "reasoning" };
			yield { type: "reasoning-delta", index: 0, text };
			yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
			yield { type: "finish", reason: { kind: "stop" } };
		})();
		for await (const c of listener(OPTS, () => gen)) out.push(c);
	} catch (e) { err = e; }
	const tc = out.find((c) => c.type === "block-end" && c.block?.type === "tool-call");
	let args = null;
	try { args = JSON.parse(tc?.block?.arguments ?? "null"); } catch { /* ignore */ }
	return { out, err, args, raw: tc?.block?.arguments };
}

// 发送前清除探测标记，确保每次都是干净起点
function cleanProbe() {
	delete Object.prototype.__polluted__;
	delete Object.prototype.polluted;
	delete Object.prototype.isAdmin;
}

console.log("=== 1. XML 参数名 __proto__ ===");
{
	const xml = OC + "\n<function=pwsh>\n<parameter=__proto__>\n{\"polluted\":\"yes\"}\n</parameter>\n<parameter=command>echo hi</parameter>\n</function>\n" + CC;
	const r = await run(xml);
	console.log(`  恢复成功: ${r.args !== null}`);
	if (r.args) console.log(`  参数: ${JSON.stringify(r.args)}`);
	console.log(`  Object.prototype.polluted = ${Object.prototype.polluted}`);
	ck("__proto__ 参数名不污染原型", Object.prototype.polluted === undefined, String(Object.prototype.polluted));
	ck("其他参数仍正确", r.args?.command === "echo hi", JSON.stringify(r.args));
	cleanProbe();
}

console.log("\n=== 2. JSON 参数名 __proto__ ===");
{
	const json = '{"name":"pwsh","arguments":{"__proto__":{"polluted":"yes"},"command":"echo hi"}}';
	const r = await run(json);
	console.log(`  恢复成功: ${r.args !== null}`);
	console.log(`  参数: ${JSON.stringify(r.args)}`);
	console.log(`  Object.prototype.polluted = ${Object.prototype.polluted}`);
	ck("JSON __proto__ 不污染原型", Object.prototype.polluted === undefined, String(Object.prototype.polluted));
	cleanProbe();
}

console.log("\n=== 3. 参数名 constructor / prototype ===");
{
	const xml = OC + "\n<function=pwsh>\n<parameter=constructor>\nx\n</parameter>\n<parameter=prototype>\ny\n</parameter>\n<parameter=command>echo hi</parameter>\n</function>\n" + CC;
	const r = await run(xml);
	console.log(`  参数: ${JSON.stringify(r.args)}`);
	// **关键区分**：
	//   - `obj["__proto__"] = v` 会改原型 → 必须拒绝
	//   - `obj["constructor"] = v` 只设自有属性 → 安全，应保留
	// 因此这里的正确断言是：
	//   (a) 全局 Object/Array 构造器未被破坏
	//   (b) constructor 作为普通键**被保留**（不是被丢掉）
	ck("constructor 参数不破坏全局 Object", typeof Object === "function" && Object.prototype !== null, "");
	ck("constructor 参数不破坏全局 Array", typeof Array === "function" && Array.prototype !== null, "");
	ck("constructor 作为普通键被保留（未误丢）", Object.hasOwn(r.args ?? {}, "constructor") && r.args.constructor === "x", JSON.stringify(r.args));
	ck("constructor 是自有属性而非原型链上的", Object.keys(r.args ?? {}).includes("constructor"), JSON.stringify(Object.keys(r.args ?? {})));
	// 但 __proto__ 必须被拒绝
	ck("__proto__ 被拒绝（两个键行为不同是正确的）", r.args !== null && !Object.keys(r.args).includes("__proto__"), JSON.stringify(Object.keys(r.args ?? {})));
	cleanProbe();
}

console.log("\n=== 4. 任何 Object.prototype 污染检测（全面扫描）===");
{
	// 记录污染前所有原型属性
	const before = new Set(Object.getOwnPropertyNames(Object.prototype));
	const beforeArray = new Set(Object.getOwnPropertyNames(Array.prototype));

	// 各种攻击载荷
	const payloads = [
		'{"name":"pwsh","arguments":{"__proto__":{"x":1}}}',
		'{"name":"pwsh","arguments":{"constructor":{"prototype":{"y":2}}}}',
		'{"name":"pwsh","arguments":{"__proto__":{"toString":"evil"}}}',
		'{"__proto__":{"z":3},"name":"pwsh","arguments":{}}',
		'{"name":"pwsh","__proto__":{"w":4},"arguments":{}}',
	];
	for (const p of payloads) {
		await run(p);
	}
	// XML 路径
	await run(OC + "\n<function=pwsh>\n<parameter=__proto__>\n{\"v\":5}\n</parameter>\n</function>\n" + CC);
	await run(OC + "\n<function=pwsh>\n<parameter=constructor>\n{\"prototype\":{\"u\":6}}\n</parameter>\n</function>\n" + CC);

	const after = new Set(Object.getOwnPropertyNames(Object.prototype));
	const afterArray = new Set(Object.getOwnPropertyNames(Array.prototype));

	const added = [...after].filter((k) => !before.has(k));
	const addedArr = [...afterArray].filter((k) => !beforeArray.has(k));
	console.log(`  Object.prototype 新增属性: ${added.length ? JSON.stringify(added) : "无"}`);
	console.log(`  Array.prototype 新增属性: ${addedArr.length ? JSON.stringify(addedArr) : "无"}`);

	ck("Object.prototype 无新增属性", added.length === 0, JSON.stringify(added));
	ck("Array.prototype 无新增属性", addedArr.length === 0, JSON.stringify(addedArr));
	ck("{} 仍是干净的", ({}).x === undefined && ({}).polluted === undefined, "");
	ck("数组仍是干净的", [].y === undefined, "");
	cleanProbe();
}

console.log("\n=== 5. 参数对象的原型是否被替换 ===");
{
	const r = await run('{"name":"pwsh","arguments":{"__proto__":{"evil":1},"command":"echo hi"}}');
	if (r.args) {
		const proto = Object.getPrototypeOf(r.args);
		console.log(`  参数对象原型: ${proto === null ? "null" : proto === Object.prototype ? "Object.prototype" : "其他"}`);
		ck("参数对象原型未被替换成攻击者对象", proto === Object.prototype || proto === null, String(proto));
		ck("参数对象无继承来的 evil 属性", r.args.evil === undefined, String(r.args.evil));
	}
}

console.log("\n=== 6. 下游使用安全性（宿主消费参数）===");
{
	// 模拟宿主的工具调用：读出所有键
	const r = await run('{"name":"pwsh","arguments":{"__proto__":{"x":1},"command":"echo hi","n":42}}');
	if (r.args) {
		const keys = Object.keys(r.args);
		console.log(`  Object.keys: ${JSON.stringify(keys)}`);
		ck("Object.keys 不含 __proto__", !keys.includes("__proto__"), JSON.stringify(keys));
		// for...in 会遍历继承属性 —— 这是真正的风险点
		const forIn = [];
		for (const k in r.args) forIn.push(k);
		console.log(`  for...in: ${JSON.stringify(forIn)}`);
		ck("for...in 不含可疑继承属性", !forIn.includes("x"), JSON.stringify(forIn));
		// JSON.stringify 是否泄漏
		console.log(`  JSON.stringify: ${JSON.stringify(r.args)}`);
	}
}

console.log("\n=== 7. 嵌套深度攻击（栈溢出）===");
{
	// 深度 5000 的嵌套 JSON
	let deep = "1";
	for (let i = 0; i < 5000; i++) deep = '{"a":' + deep + "}";
	const payload = '{"name":"pwsh","arguments":{"deep":' + deep + "}}";
	let err = null;
	try { await run(payload); } catch (e) { err = e; }
	// 只需要"不崩溃进程" —— JSON.parse 会抛 RangeError，应被 catch
	ck("深度嵌套 JSON 不崩溃", err === null, err?.message ?? "");
}

console.log("\n=== 8. 超大键名 / 超多键 ===");
{
	// 10 万个参数键
	const manyKeys = {};
	for (let i = 0; i < 100000; i++) manyKeys["k" + i] = "v";
	const payload = JSON.stringify({ name: "pwsh", arguments: manyKeys });
	const t0 = Date.now();
	let err = null;
	try { await run(payload); } catch (e) { err = e; }
	const elapsed = Date.now() - t0;
	console.log(`  10 万个参数键: ${elapsed}ms, 异常: ${err?.message ?? "无"}`);
	ck("超多键不崩溃", err === null, err?.message ?? "");
}

console.log(`\n===== 原型污染与解析器安全: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
cleanProbe();
process.exit(fail === 0 ? 0 : 1);
