// 复现脚本可用性审查
//
// 提交材料向维护者承诺：「5 分钟能复现」「两个最小复现脚本」。但这些脚本
// 从来没人验证过能不能跑 —— 这是开源材料里最容易翻车的地方：
// 维护者照着跑，报错，直接关闭 issue。
//
// 本套件验证：
//   1. 脚本语法正确
//   2. harness-side.mjs **真能跑通**，且输出真的复现了「静默卡住」
//   3. model-side.cjs 缺 key 时给出可操作的指引（而不是只抛一行错）
//   4. 脚本无未替换的占位符（如 <workspace>）
//   5. 脚本自包含（不依赖仓库内其他文件）
//   6. 材料里描述的运行方式与脚本实际行为一致
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const REPRO = path.join(ROOT, "community", "repro");
const HARNESS = path.join(REPRO, "harness-side.mjs");
const MODEL = path.join(REPRO, "model-side.cjs");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

console.log("=== 1. 脚本存在且语法正确 ===");
{
	for (const [label, f] of [["harness-side.mjs", HARNESS], ["model-side.cjs", MODEL]]) {
		ck(`${label} 存在`, fs.existsSync(f));
		if (!fs.existsSync(f)) continue;
		let ok = true, err = "";
		try {
			execFileSync(process.execPath, ["--check", f], { stdio: "pipe", timeout: 30000 });
		} catch (e) {
			ok = false;
			err = String(e.stderr ?? "").split("\n").slice(0, 2).join(" ");
		}
		ck(`${label} 语法正确`, ok, err);
		console.log(`  ${label}: ${ok ? "✅" : "❌ " + err}`);
	}
}

console.log("\n=== 2. harness-side.mjs 真能跑通并复现问题 ===");
{
	let out = "";
	let code = 0;
	try {
		out = execFileSync(process.execPath, [HARNESS], { encoding: "utf8", timeout: 60000, stdio: "pipe" });
	} catch (e) {
		code = e.status ?? -1;
		out = (e.stdout ?? "") + (e.stderr ?? "");
	}
	console.log(`  退出码: ${code}`);
	const lines = out.trim().split("\n");
	console.log(`  输出（${lines.length} 行）:`);
	for (const l of lines.slice(0, 12)) console.log(`    ${l}`);

	ck("harness-side 退出码 0", code === 0, String(code));
	ck("harness-side 有输出", out.trim().length > 50, `${out.length} 字符`);

	// 关键：输出必须真的展示「静默结束」这一症状
	ck("输出展示了 tool-call 块数量为 0", /tool-call\s*块数量\s*=\s*0/.test(out), "");
	ck("输出展示了 finish.reason 是 stop", /"kind"\s*:\s*"stop"/.test(out), "");
	ck("输出展示了 agent loop 判定为 completed", /completed/.test(out), "");
	ck("输出点明了「静默结束」这一结论", /静默结束|silently|no error|无错误/i.test(out), "");
}

console.log("\n=== 3. model-side.cjs 缺 key 时给出可操作指引 ===");
{
	// 确保没有 key 的环境
	const env = { ...process.env };
	delete env.STEPFUN_API_KEY;

	let out = "";
	let code = 0;
	try {
		out = execFileSync(process.execPath, [MODEL], { encoding: "utf8", timeout: 30000, stdio: "pipe", env });
	} catch (e) {
		code = e.status ?? -1;
		out = (e.stdout ?? "") + (e.stderr ?? "");
	}
	console.log(`  退出码: ${code}（期望非 0，因为没有 key）`);
	console.log(`  输出:`);
	for (const l of out.trim().split("\n").slice(0, 14)) console.log(`    ${l}`);

	ck("缺 key 时退出码非 0", code !== 0, String(code));
	ck("提示里说明了缺少什么", /STEPFUN_API_KEY/.test(out), "");
	ck("提示里给出了 usage 示例", /Usage|STEPFUN_API_KEY=sk-|env:STEPFUN_API_KEY/.test(out), "");
	ck("提示里指出了替代方案（harness-side）", /harness-side/.test(out), "");
	console.log(`  指引完整度: ${/Usage/.test(out) && /harness-side/.test(out) ? "✅ 有 usage + 替代方案" : "⚠️ 不完整"}`);
}

console.log("\n=== 4. 无未替换的占位符 ===");
{
	for (const [label, f] of [["harness-side.mjs", HARNESS], ["model-side.cjs", MODEL]]) {
		if (!fs.existsSync(f)) continue;
		const src = fs.readFileSync(f, "utf8");
		// 找形如 <workspace> / <path> / <your-key> 的裸占位符（在字符串里）
		const placeholders = [];
		for (const m of src.matchAll(/["'`][^"'`]*<([a-z][a-z0-9_-]{2,})>[^"'`]*["'`]/gi)) {
			const name = m[1].toLowerCase();
			// 排除真实的 HTML/XML 标签（tool_call / function / parameter 等）与泛型
			const OK_NAMES = ["tool_call", "function", "parameter", "invoke", "antml", "pkg", "file", "path", "包", "文件"];
			if (OK_NAMES.includes(name)) continue;
			placeholders.push(name);
		}
		ck(`${label} 无未替换的占位符`, placeholders.length === 0, placeholders.join(", "));
		console.log(`  ${label}: ${placeholders.length === 0 ? "✅ 无" : "❌ " + placeholders.join(", ")}`);
	}
}

console.log("\n=== 5. 脚本自包含（不依赖仓库内其他文件）===");
{
	for (const [label, f] of [["harness-side.mjs", HARNESS], ["model-side.cjs", MODEL]]) {
		if (!fs.existsSync(f)) continue;
		const src = fs.readFileSync(f, "utf8");
		// 不应 import 仓库内的相对路径
		const relativeImports = [...src.matchAll(/(?:from|require\()\s*["'](\.\.?\/[^"']+)["']/g)].map((m) => m[1]);
		ck(`${label} 不依赖仓库内相对路径`, relativeImports.length === 0, relativeImports.join(", "));
		// 说明注释应提到「自包含」「无依赖」
		const mentionsSelfContained = /自包含|无依赖|self-contained|no dependencies|standalone/i.test(src);
		console.log(`  ${label}: 相对导入 ${relativeImports.length} 处，提到自包含: ${mentionsSelfContained}`);
	}
}

console.log("\n=== 6. 材料描述与脚本行为一致 ===");
{
	const disc = fs.readFileSync(path.join(ROOT, "community", "discussion-deepseek-harness.md"), "utf8");
	const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
	const combined = disc + "\n" + readme;

	// 材料提到 harness-side 时，应说明「不需要模型/API key」
	ck("材料说明 harness-side 不需要特定模型", /(harness-side[\s\S]{0,200}?(no specific model|不需要|无需)[\s\S]{0,100}?(model|key|模型))|(no specific model needed)/i.test(combined), "");
	// 材料提到 model-side 时，应说明「需要 API key」且「间歇性」
	ck("材料说明 model-side 需要 API key", /model-side[\s\S]{0,200}?(API key|STEPFUN_API_KEY)/i.test(combined), "");
	ck("材料说明 model-side 是间歇性的", /(intermittent|间歇)/i.test(combined), "");

	// 材料里给出的命令必须与脚本真实用法一致
	ck("材料给出的 harness-side 命令是 node harness-side.mjs", /node harness-side\.mjs/.test(combined), "");
	ck("材料给出的 model-side 命令含 STEPFUN_API_KEY", /STEPFUN_API_KEY[=\s].*model-side\.cjs|model-side\.cjs.*STEPFUN_API_KEY/.test(combined), "");
}

console.log("\n=== 7. 复现脚本在干净环境下可运行 ===");
{
	// 复制脚本到临时目录单独跑（模拟维护者只下载了脚本）
	const os = await import("node:os");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repro-standalone-"));
	try {
		fs.copyFileSync(HARNESS, path.join(tmp, "harness-side.mjs"));
		let out = "";
		let code = 0;
		try {
			out = execFileSync(process.execPath, [path.join(tmp, "harness-side.mjs")], {
				encoding: "utf8", timeout: 60000, stdio: "pipe", cwd: tmp,
			});
		} catch (e) {
			code = e.status ?? -1;
			out = (e.stdout ?? "") + (e.stderr ?? "");
		}
		ck("harness-side 在临时目录单独可跑", code === 0, String(code));
		ck("单独运行输出与仓库内一致", /tool-call\s*块数量\s*=\s*0/.test(out), "");
		console.log(`  单独运行: 退出码 ${code}，输出 ${out.length} 字符`);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

console.log(`\n===== 复现脚本可用性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
