// 运行中实例的版本一致性审查
//
// DSH 是长驻进程。插件的 `apply()` 只在**进程启动时**被调用一次，
// 之后就算把新文件写到 profile，运行中的进程也**仍然用旧代码**。
//
// 这是本项目的真实盲区：前 39 轮全部直接 `import` 源码做测试，
// 从来没验证过「**正在跑的那个进程**加载的是不是最新版」。
//
// 本轮实测发现：
//   DSH 进程启动 2026-10-22T13:45:17Z
//   安装副本写入 2026-10-23T01:01:29Z（晚 11 小时）
//   → 运行中的进程加载的是更早的版本
//
// 本套件验证：
//   1. 源码 ≡ 安装副本（否则用户拿到的不是测过的代码）
//   2. 安装副本的写入时间 vs DSH 进程启动时间（诊断是否存在版本滞后）
//   3. 运行中的会话日志证明插件确实在工作（txtcall- 标记）
//   4. 若存在滞后，明确告警并给出重启建议
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

import { sameContent } from "./_file-compare.mjs";
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const HOME = os.homedir();
const INST = path.join(HOME, ".dsh", "profiles", "desktop", "node_modules", "@zhaozehao10", "dsh-text-tool-call-recovery", "lib", "index.js");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

// ===========================================================================
// 1. 源码 ≡ 安装副本
// ===========================================================================
console.log("=== 1. 源码与安装副本一致 ===");
{
	ck("源码存在", fs.existsSync(LIB));
	if (fs.existsSync(INST)) {
		const a = fs.readFileSync(LIB);
		const b = fs.readFileSync(INST);
		// **缺陷 165**：忽略 CRLF/LF 差异（跨平台克隆后字节数必然不同）
		ck("安装副本存在且与源码一致", sameContent(a, b), `源码 ${a.length}B vs 安装 ${b.length}B（已忽略换行符差异）`);
		console.log(`  源码: ${a.length} 字节`);
		console.log(`  安装: ${b.length} 字节`);
		console.log(`  一致: ${a.equals(b) ? "✅" : "❌"}`);
	} else {
		console.log("  ⚠️ 未安装到当前 profile（可能是别的 profile 或未安装）");
	}
}

// ===========================================================================
// 2. 版本滞后诊断（安装副本 vs DSH 进程启动时间）
// ===========================================================================
console.log("\n=== 2. 运行中进程的版本滞后诊断 ===");
let lagDetected = false;
let procStartMs = null;
{
	// 读 DSH 进程启动时间（由调用方通过环境变量或文件传入；否则从父进程推断）
	// 更可靠的做法：让测试读一个可选的诊断文件
	const diagFile = path.join(HOME, ".dsh", "profiles", "desktop", ".dsh-process-start");
	let procStart = null;

	// 尝试 1：环境变量
	if (process.env.DSH_PROCESS_START) {
		procStart = new Date(process.env.DSH_PROCESS_START);
	}
	// 尝试 2：直接查询进程（仅 Windows）
	if (!procStart) {
		try {
			const { execFileSync } = await import("node:child_process");
			const out = execFileSync("powershell", [
				"-NoProfile", "-Command",
				"(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1).StartTime.ToString('o')",
			], { encoding: "utf8", timeout: 30000, stdio: "pipe" });
			const s = out.trim();
			if (s) procStart = new Date(s);
		} catch { /* 忽略 */ }
	}

	if (!procStart || Number.isNaN(procStart.getTime())) {
		console.log("  ⚠️ 无法确定 DSH 进程启动时间（非 Windows 或进程未运行），跳过诊断");
	} else {
		procStartMs = procStart.getTime();
		console.log(`  DSH 进程启动: ${procStart.toISOString()}`);
		if (fs.existsSync(INST)) {
			const instMtime = fs.statSync(INST).mtime;
			console.log(`  安装副本写入: ${instMtime.toISOString()}`);
			const lag = instMtime.getTime() - procStart.getTime();
			if (lag > 0) {
				lagDetected = true;
				const lagMin = Math.round(lag / 60000);
				console.log(`  ⚠️ 安装副本比进程启动晚 ${lagMin} 分钟`);
				console.log(`     → 运行中的进程加载的是**更早的版本**`);
				console.log(`     → 建议重启 DeepSeek Harness 使最新版本生效`);
			} else {
				console.log(`  ✅ 安装副本在进程启动之前就位（运行中的是当前版本）`);
			}
		}
	}
	// 关键约束：即使检测到滞后，也**不应**让套件失败 —— 因为这是
	// 「环境状态」而不是「代码缺陷」。但必须明确打印告警。
	ck("版本滞后诊断已完成（不阻断，仅告警）", true);
}

// ===========================================================================
// 3. 运行中的会话日志证明插件在工作
// ===========================================================================
console.log("\n=== 3. 插件在真实会话中确实工作过 ===");
{
	const SESSIONS = path.join(HOME, ".dsh", "sessions");
	if (!fs.existsSync(SESSIONS)) {
		console.log("  ⚠️ 无会话目录，跳过");
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
				if (e.name === "session.v4.jsonl.zstd") files.push({ p, mtime: fs.statSync(p).mtime });
			}
		})(SESSIONS);
		files.sort((a, b) => b.mtime - a.mtime);
		console.log(`  会话文件 ${files.length} 个`);

		// 统计最新会话里的 txtcall- 标记
		let totalTxtcall = 0;
		let totalStreams = 0;
		let checkedSessions = 0;
		for (const f of files.slice(0, 3)) {
			let text;
			try { text = decompress(f.p); } catch { continue; }
			checkedSessions++;
			for (const line of text.split("\n")) {
				if (!line.includes('"assistant/message"')) continue;
				let o;
				try { o = JSON.parse(line); } catch { continue; }
				if (o.type !== "assistant/message") continue;
				const raw = o.data?.stream;
				if (!Array.isArray(raw) || !raw.length) continue;
				totalStreams++;
				if (JSON.stringify(raw).includes("txtcall-")) totalTxtcall++;
			}
		}
		console.log(`  检查 ${checkedSessions} 个最新会话，${totalStreams} 条流`);
		console.log(`  含 txtcall- 合成块: ${totalTxtcall} 条`);
		ck("插件在真实会话中确实工作过（有 txtcall- 标记）", totalTxtcall > 0, `${totalTxtcall} 条`);
	}
}

// ===========================================================================
// 4. 插件版本与实际加载的一致性（可观测行为）
// ===========================================================================
console.log("\n=== 4. 可观测的版本特征 ===");
{
	const src = fs.readFileSync(LIB, "utf8");
	const FEATURES = [
		["VERSION 常量（D26）", /const VERSION = "\d+\.\d+\.\d+"/],
		["完整包名（D35）", /const name = "@zhaozehao10\//],
		["行尾三覆盖（D27）", /\(\?:\\r\\n\|\[\\r\\n\]\)/],
		["断流交出内容（D25）", /catch \(streamError\)[\s\S]{0,200}yield\* flushHeld\(\)/],
		["deltas 一致性（D21）", /const cleanedDeltas = b\.deltas\.length === 0/],
		["模块说明在顶部（D32）", /^\/\*\*\r?\n \* @module/m],
	];
	for (const [label, re] of FEATURES) {
		const ok = re.test(src);
		ck(`源码含特性：${label}`, ok, "");
		console.log(`  ${label}: ${ok ? "✅" : "❌"}`);
	}
}

// ===========================================================================
// 5. 结论汇总
// ===========================================================================
console.log("\n=== 5. 结论 ===");
if (lagDetected) {
	console.log("  ⚠️ 检测到版本滞后：运行中的进程未加载最新插件。");
	console.log("     这不是代码缺陷，但会让「已验证的修复」暂时不生效。");
	console.log("     处理方式：重启 DeepSeek Harness。");
} else {
	console.log("  ✅ 运行中的进程与最新源码一致（或未检测到滞后）。");
}

console.log(`\n===== 运行实例版本一致性: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
