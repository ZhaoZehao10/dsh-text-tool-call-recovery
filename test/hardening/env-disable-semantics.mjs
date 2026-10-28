import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
	if (ok) { pass++; console.log("  ✅ " + label); }
	else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("  ❌ " + label + (detail ? " :: " + detail : "")); }
};

const OC = "<" + "tool_call>";
const CC = "</" + "tool_call>";
const OF = (n) => "<" + "function=" + n + ">";
const CF = "</" + "function>";
const OP = (k) => "<" + "parameter=" + k + ">";
const TOOLS = [{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" } } } }];

async function probe(envValue) {
	if (envValue === undefined) delete process.env.DSH_TEXT_TOOL_CALL_RECOVERY;
	else process.env.DSH_TEXT_TOOL_CALL_RECOVERY = envValue;

	const mod = await import(pathToFileURL(LIB).href + "?e=" + Date.now() + Math.random());
	let listener;
	mod.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

	if (typeof listener !== "function") return { registered: false };

	const text = OC + "\n" + OF("pwsh") + "\n" + OP("command") + "\necho hi\n</parameter>\n" + CF + "\n" + CC;
	const chunks = [
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text },
		{ type: "block-end", index: 0, block: { type: "reasoning", text } },
		{ type: "finish", reason: { kind: "stop" } },
	];
	const out = [];
	const gen = (async function* () { for (const c of chunks) yield c; })();
	const stream = await listener({ provider: "p", model: "e-" + Math.random(), messages: [], tools: TOOLS }, () => gen);
	for await (const c of stream) out.push(c);
	return { registered: true, hasToolCall: out.some((c) => c.type === "block-start" && c.blockType === "tool-call") };
}

console.log("=== 1. 未设置：正常恢复 ===");
{
	const r = await probe(undefined);
	ck("未设置时注册监听器", r.registered === true);
	ck("未设置时恢复出 tool-call 块", r.hasToolCall === true);
}

console.log("=== 2. 设为字符串 0：完全不干预 ===");
{
	const r = await probe("0");
	ck("设为 0 时不注册监听器（等于没装）", r.registered === false);
}

console.log("=== 3. 设为字符串 1：正常恢复 ===");
{
	const r = await probe("1");
	ck("设为 1 时注册监听器", r.registered === true);
	ck("设为 1 时恢复出 tool-call 块", r.hasToolCall === true);
}

console.log("=== 4. 只认字面 0（容错性差的验证）===");
for (const v of ["false", "", "00", "0 "]) {
	const r = await probe(v);
	ck('设为 "' + v + '" 时仍注册（不是精确 0）', r.registered === true);
	ck('设为 "' + v + '" 时不生效为禁用', r.hasToolCall === true);
}

delete process.env.DSH_TEXT_TOOL_CALL_RECOVERY;

console.log("=== 5. 文档必须说明这两个坑 ===");
{
	const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
	ck("README 说明只认精确的字符串", /只认精确的字符串/.test(readme), "缺说明");
	ck("README 说明必须在 DSH 启动前设置", /必须在 DSH 启动前/.test(readme), "缺说明");
	ck("README 给出用户级变量写法", /SetEnvironmentVariable/.test(readme), "缺 SetEnvironmentVariable 写法");
	ck("README 警告写错不会报错", /不会报错|以为禁用了/.test(readme), "缺警告");

	const en = fs.readFileSync(path.join(ROOT, "README.en.md"), "utf8");
	ck("英文版同样说明只认精确字符串", /Only the exact string/.test(en), "缺说明");
	ck("英文版同样说明必须在启动前", /must exist before DSH starts/.test(en), "缺说明");
}

console.log("===== 环境变量禁用语义: " + pass + " passed, " + fail + " failed =====");
if (failures.length) {
	console.log("--- 失败明细 ---");
	for (const f of failures) console.log("  ❌ " + f);
}
process.exit(fail === 0 ? 0 : 1);