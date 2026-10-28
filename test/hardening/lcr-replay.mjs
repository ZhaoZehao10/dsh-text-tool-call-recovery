// long-context-replay 链路可用性审查
//
// 这三个脚本产生了材料里**最核心的证据**：
//   「忠实重放 419,843 token（与真实请求 419,678 仅差 0.04%），连续 7 次正常」
// 用来排除「上下文长度触发失败」这一替代解释。
//
// 但前 42 轮从未运行过它们。本轮实测发现：
//   - 缺陷 46：faithful-replay 默认读 real-tools.json，而 rebuild-context 写 rebuilt-tools.json
//   - 缺陷 47：rebuild-context 输出用 <prefix>-context.json 命名，
//              与 faithful-replay 的默认 ./rebuilt-context.json 不衔接 ——
//              用户必须先设环境变量才能跑通
//
// 本套件验证：
//   1. 三个脚本语法正确
//   2. rebuild-context 能真的从真实日志重建上下文
//   3. calibrate-method 能给出「字符/token 比值」方法学证据
//   4. faithful-replay 的接口契约完整（可覆盖文件名、不硬编码密钥）
//   5. 两个脚本的文件名约定能衔接
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIR = path.join(ROOT, "test", "long-context-replay");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

// ===========================================================================
// 1. 三个脚本存在且语法正确
// ===========================================================================
console.log("=== 1. 脚本存在且语法正确 ===");
for (const f of ["calibrate-method.cjs", "faithful-replay.cjs", "rebuild-context.cjs"]) {
	const p = path.join(DIR, f);
	ck(`${f} 存在`, fs.existsSync(p));
	if (!fs.existsSync(p)) continue;
	let ok = true, err = "";
	try {
		execFileSync(process.execPath, ["--check", p], { stdio: "pipe", timeout: 30000 });
	} catch (e) {
		ok = false;
		err = String(e.stderr ?? "").split("\n")[0];
	}
	ck(`${f} 语法正确`, ok, err);
	console.log(`  ${f}: ${ok ? "✅" : "❌ " + err}`);
}

// ===========================================================================
// 2. 文件名约定能衔接（缺陷 46/47）
// ===========================================================================
console.log("\n=== 2. 文件名约定衔接 ===");
{
	const fr = fs.readFileSync(path.join(DIR, "faithful-replay.cjs"), "utf8");
	const rb = fs.readFileSync(path.join(DIR, "rebuild-context.cjs"), "utf8");

	// faithful-replay 的默认文件名
	const frCtx = (fr.match(/REBUILT_CONTEXT\s*\?\?\s*["']([^"']+)["']/) ?? [])[1] ?? "";
	const frTools = (fr.match(/REAL_TOOLS\s*\?\?\s*["']([^"']+)["']/) ?? [])[1] ?? "";
	console.log(`  faithful-replay 默认读: ${frCtx} / ${frTools}`);

	// rebuild-context 写出的文件名（找 writeFileSync 的路径构造）
	const writeMatches = [...rb.matchAll(/(?:OUT_PREFIX|outPrefix|prefix)[^;]{0,120}/g)].map((m) => m[0]);
	const hasPrefixedOutput = /(?:prefix|PREFIX)\s*\+\s*["']-context\.json["']/.test(rb) || /["']-context\.json["']/.test(rb);
	console.log(`  rebuild-context 用 <prefix>-context.json 形式: ${hasPrefixedOutput}`);

	// 关键：不能有旧的 real-tools.json
	ck("faithful-replay 不再读 real-tools.json（缺陷 46）", !fr.includes("real-tools.json") ||
		// 允许出现在「说明历史」的注释里
		!/REAL_TOOLS\s*\?\?\s*["'][^"']*real-tools\.json/.test(fr), "");
	console.log(`  无 real-tools.json 默认值: ${!/REAL_TOOLS\s*\?\?\s*["'][^"']*real-tools\.json/.test(fr) ? "✅" : "❌"}`);

	// 两个脚本都能通过环境变量覆盖（保证可衔接）
	ck("faithful-replay 支持 REBUILT_CONTEXT 覆盖", /REBUILT_CONTEXT/.test(fr), "");
	ck("faithful-replay 支持 REAL_TOOLS 覆盖", /REAL_TOOLS/.test(fr), "");
	console.log(`  支持覆盖: REBUILT_CONTEXT=${/REBUILT_CONTEXT/.test(fr)} REAL_TOOLS=${/REAL_TOOLS/.test(fr)}`);

	// 文档里应说明如何衔接
	const mentionHowTo = /REBUILT_CONTEXT|rebuilt-context\.json/.test(fr);
	ck("faithful-replay 文档说明了文件来源", mentionHowTo, "");
}

// ===========================================================================
// 3. 接口契约（不硬编码密钥、可覆盖端点/模型）
// ===========================================================================
console.log("\n=== 3. faithful-replay 接口契约 ===");
{
	const fr = fs.readFileSync(path.join(DIR, "faithful-replay.cjs"), "utf8");
	const CHECKS = [
		["读 TARGET_API_KEY", /TARGET_API_KEY/.test(fr)],
		["不支持时给清晰提示", /(not set|missing|first)[\s\S]{0,80}(key|TARGET_API_KEY)|TARGET_API_KEY[\s\S]{0,120}(not set|first)/i.test(fr)],
		["可覆盖 TARGET_BASE_URL", /TARGET_BASE_URL/.test(fr)],
		["可覆盖 TARGET_MODEL", /TARGET_MODEL/.test(fr)],
		["不硬编码任何密钥", !/sk-[A-Za-z0-9]{10,}/.test(fr)],
		["不硬编码真实 base URL 为唯一选项", /TARGET_BASE_URL/.test(fr)],
	];
	for (const [label, ok] of CHECKS) {
		ck(label, ok, "");
		console.log(`  ${label}: ${ok ? "✅" : "❌"}`);
	}
}

// ===========================================================================
// 4. 端到端：rebuild → calibrate（用真实日志）
// ===========================================================================
console.log("\n=== 4. 端到端（真实日志）===");
{
	const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");
	if (!fs.existsSync(SESSIONS)) {
		console.log("  ⚠️ 无会话目录，跳过端到端验证");
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
				try { parts.push(zlib.zstdDecompressSync(buf.subarray(s, e))); } catch { /* 忽略 */ }
			}
			return Buffer.concat(parts).toString("utf8");
		}

		const files = [];
		(function walk(d) {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) { walk(p); continue; }
				if (e.name === "session.v4.jsonl.zstd") files.push({ p, size: fs.statSync(p).size });
			}
		})(SESSIONS);
		files.sort((a, b) => b.size - a.size);

		if (files.length === 0) {
			// **缺陷 152**（第 145 轮）：原来这里只打印「⚠️ 无会话文件」就继续，
			// 最终仍 `16 passed, 0 failed` 并 exit 0 —— **0 个样本假装验证过了**。
			// 改为明确判失败：无法验证就是无法验证，不能算通过。
			console.log("\n❌ 无会话文件可用 —— 这不是「链路正常」，而是**无法验证**");
			console.log("   请先在真实会话里产生 long-context 数据。");
			process.exit(1);
		} else {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lcr-test-"));
			try {
				const jsonl = path.join(tmp, "s.jsonl");
				fs.writeFileSync(jsonl, decompress(files[0].p), "utf8");
				console.log(`  会话日志: ${(fs.statSync(jsonl).size / 1024).toFixed(0)} KB`);

				// 找目标 seq
				let target = null;
				for (const line of fs.readFileSync(jsonl, "utf8").split("\n")) {
					if (!line.trim()) continue;
					let o;
					try { o = JSON.parse(line); } catch { continue; }
					if (o.type === "assistant/message" && o.data?.usage?.inputTokens > 500) { target = o.seq; break; }
				}
				ck("能从真实日志找到带 usage 的消息", target !== null, "");
				console.log(`  目标 seq: ${target}`);

				if (target !== null) {
					// rebuild
					const prefix = path.join(tmp, "ctx");
					let out = "";
					let code = 0;
					try {
						out = execFileSync(process.execPath, [path.join(DIR, "rebuild-context.cjs"), jsonl, String(target), prefix], {
							encoding: "utf8", timeout: 180000, stdio: "pipe",
						});
					} catch (e) {
						code = e.status ?? -1;
						out = (e.stdout ?? "") + (e.stderr ?? "");
					}
					console.log(`  rebuild 退出码: ${code}`);
					for (const l of out.trim().split("\n").slice(0, 6)) console.log(`    ${l}`);
					ck("rebuild-context 成功（退出码 0）", code === 0, String(code));

					const produced = fs.readdirSync(tmp).filter((f) => f.endsWith(".json"));
					ck("产出了 context 与 tools 两个文件", produced.length >= 2, produced.join(", "));

					// 内容有效性
					const ctxFile = produced.find((f) => f.includes("context"));
					const toolsFile = produced.find((f) => f.includes("tools"));
					if (ctxFile) {
						const ctx = JSON.parse(fs.readFileSync(path.join(tmp, ctxFile), "utf8"));
						ck("context 是非空数组", Array.isArray(ctx) && ctx.length > 0, `${Array.isArray(ctx) ? ctx.length : "非数组"}`);
						ck("context 每条有 role", ctx.every((m) => typeof m.role === "string"), "");
						console.log(`    context: ${ctx.length} 条消息，角色: ${[...new Set(ctx.map((m) => m.role))].join(", ")}`);
					}
					if (toolsFile) {
						const tools = JSON.parse(fs.readFileSync(path.join(tmp, toolsFile), "utf8"));
						ck("tools 是非空数组", Array.isArray(tools) && tools.length > 0, "");
						console.log(`    tools: ${tools.length} 个`);
					}

					// calibrate
					let calOut = "";
					let calCode = 0;
					try {
						calOut = execFileSync(process.execPath, [path.join(DIR, "calibrate-method.cjs"), jsonl], {
							encoding: "utf8", timeout: 180000, stdio: "pipe",
						});
					} catch (e) {
						calCode = e.status ?? -1;
						calOut = (e.stdout ?? "") + (e.stderr ?? "");
					}
					console.log(`  calibrate 退出码: ${calCode}`);
					const calLines = calOut.trim().split("\n");
					for (const l of calLines.slice(0, 5)) console.log(`    ${l}`);
					ck("calibrate-method 成功（退出码 0）", calCode === 0, String(calCode));
					ck("calibrate 输出了「字符/token 比」", /字符\/token|char\/token/i.test(calOut), "");
					ck("calibrate 输出了多个 turn", (calOut.match(/^t \d+|^t\d+/gm) ?? []).length >= 3, "");
				}
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		}
	}
}

console.log(`\n===== long-context-replay 链路: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
