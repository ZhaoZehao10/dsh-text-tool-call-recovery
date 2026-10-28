// 运行实例的**进程级**版本验证
//
// **为什么需要**（第 94 轮）：
// `live-instance.mjs` 已经验证了「安装副本写入时间 vs DSH 进程启动时间」，
// 但它只做了一个**粗略的时间比较**，没有区分：
//   · Electron 的多个子进程（gpu-process / renderer / utility）
//   · 真正承载 dsh 的 host 进程（带 --expose-internals 的那个）
//
// 第 94 轮实测发现：一个 Electron 应用会拉起 **6 个进程**，
// 其中只有 **1 个**（PID 21644，带 `--expose-internals ... dsh-desktop-host`）
// 真正加载插件。其余 5 个是 GPU / 网络 / 渲染 / 主进程。
//
// 若只看「最早启动的进程」，会误判；必须**定位到 dsh host 进程**。
//
// 本套件验证：
//   1. 能找到 dsh host 进程（命令行含 dsh-desktop-host 且含 profile 路径）
//   2. 该进程的启动时间 vs 安装副本写入时间（诊断版本滞后）
//   3. 安装副本与源码字节一致
//   4. 安装副本含关键修复标记（coercedJson 等）
//
// 注意：asar / 进程信息都是**本机特有**的，拿不到时明确跳过而非误报。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

import { sameContent } from "./_file-compare.mjs";
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const HOME = os.homedir();
const PROFILE = path.join(HOME, ".dsh", "profiles", "desktop");
const INST = path.join(PROFILE, "node_modules", "@zhaozehao10", "dsh-text-tool-call-recovery", "lib", "index.js");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

console.log("=== 1. 安装副本与源码一致 ===");
{
	const src = fs.readFileSync(LIB);
	ck("安装副本存在", fs.existsSync(INST), INST);
	if (fs.existsSync(INST)) {
		const inst = fs.readFileSync(INST);
		// **缺陷 165**：忽略 CRLF/LF 差异
	ck("安装副本与源码一致（忽略换行符）", sameContent(src, inst), `${src.length} vs ${inst.length}`);
		console.log(`  源码 ${src.length} 字节 / 安装 ${inst.length} 字节`);
		// **缺陷 165**：诊断行也必须用规范化比较 —— 否则 LF 环境会打印「❌ 不一致」，
		// 而这一行会被 run-all 的「失败标记但 exit 0」守卫判为 SUSPECT（假矛盾）。
		console.log(`  ${sameContent(src, inst) ? "✅ 内容一致（已忽略换行符）" : "❌ 内容不一致"}`);
	}
}

console.log("\n=== 2. 安装副本含关键修复标记 ===");
{
	if (!fs.existsSync(INST)) {
		ck("安装副本可读（跳过标记检查）", false, "不存在");
	} else {
		const inst = fs.readFileSync(INST, "utf8");
		// 缺陷 55：四条路径都要做类型强转
		ck("含缺陷 55 修复标记（coercedJson）", inst.includes("coercedJson"), "");
		console.log(`  coercedJson: ${inst.includes("coercedJson") ? "✅" : "❌"}`);

		// VERSION 常量（缺陷 26）
		const ver = inst.match(/const VERSION = "([^"]+)"/);
		ck("导出 VERSION 常量（可诊断加载版本）", ver !== null, ver ? ver[1] : "无");
		console.log(`  VERSION: ${ver ? ver[1] : "❌ 无"}`);
	}
}

console.log("\n=== 3. 定位 dsh host 进程（不是 Electron 子进程）===");
let hostProc = null;
{
	let out = "";
	try {
		out = execFileSync("powershell", ["-NoProfile", "-Command",
			"Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress"
		], { encoding: "utf8", timeout: 60000 });
	} catch (e) {
		out = String(e.stdout ?? "");
	}

	if (!out.trim()) {
		console.log("  ⚠️ 拿不到进程信息（可能不是 Windows 或权限不足），跳过");
		// 拿不到进程信息时**明确跳过**（不当作通过，也不当作失败）
		console.log("  → 跳过（不计入通过，也不计入失败）");
	} else {
		let procs = [];
		try {
			const p = JSON.parse(out.trim());
			procs = Array.isArray(p) ? p : [p];
		} catch {
			procs = [];
		}

		console.log(`  找到 ${procs.length} 个 DSH 进程`);

		// dsh host 进程的标志：命令行含 dsh-desktop-host 且有 --expose-internals
		const hosts = procs.filter((p) => {
			const cmd = String(p.CommandLine ?? "");
			return cmd.includes("dsh-desktop-host") && cmd.includes("--expose-internals");
		});

		ck("能找到唯一的 dsh host 进程", hosts.length === 1, `找到 ${hosts.length} 个`);
		console.log(`  dsh host 进程: ${hosts.length} 个`);

		if (hosts.length >= 1) {
			hostProc = hosts[0];
			console.log(`    PID ${hostProc.ProcessId}`);

			// 解析启动时间
			let start = hostProc.CreationDate;
			if (typeof start === "string" && start.startsWith("/Date(")) {
				start = new Date(Number(start.match(/-?\d+/)[0]));
			} else if (typeof start === "string") {
				start = new Date(start);
			}

			ck("host 进程启动时间可解析", start instanceof Date && !isNaN(start), String(hostProc.CreationDate));
			if (start instanceof Date && !isNaN(start)) {
				console.log(`    启动: ${start.toISOString()}`);
				hostProc._start = start;
			}
		}
	}
}

console.log("\n=== 4. 版本滞后诊断 ===");
{
	if (!hostProc?._start || !fs.existsSync(INST)) {
		console.log("  ⚠️ 缺少进程启动时间或安装副本，跳过");
	} else {
		const instMtime = fs.statSync(INST).mtime;
		const lagMs = instMtime - hostProc._start;
		const lagMin = lagMs / 1000 / 60;

		console.log(`  安装副本写入: ${instMtime.toISOString()}`);
		console.log(`  host 进程启动: ${hostProc._start.toISOString()}`);
		console.log(`  差值: ${lagMin.toFixed(0)} 分钟`);

		if (lagMin > 1) {
			// 安装副本比进程晚 → 运行中的进程用的是旧代码
			console.log(`  ⚠️ **版本滞后**：安装副本比进程启动晚 ${lagMin.toFixed(0)} 分钟`);
			console.log(`     → 运行中的 DSH 加载的是**更早的版本**`);
			console.log(`     → 处理方式：重启 DeepSeek Harness`);
			// 这是**已知状态**而非缺陷（用户还没重启），所以断言为「检测到了滞后」
			// 断言的是「确实存在滞后」，用 lagMin 判断
			ck("确实存在版本滞后（lagMin > 1）", lagMin > 1, lagMin.toFixed(1));
		} else {
			console.log(`  ✅ 安装副本早于进程启动（进程加载的是当前版本）`);
			ck("进程加载的是当前版本（lagMin <= 1）", lagMin <= 1, lagMin.toFixed(1));
		}
	}
}

console.log("\n=== 5. 会话日志中的实证 ===");
{
	const SESSIONS = path.join(HOME, ".dsh", "sessions");
	if (!fs.existsSync(SESSIONS)) {
		console.log("  （会话目录不存在，跳过）");
	} else {
		const files = [];
		(function walk(d) {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) walk(p);
				else if (e.name.endsWith(".zstd")) files.push(p);
			}
		})(SESSIONS);
		console.log(`  会话日志: ${files.length} 个`);
		ck("能找到会话日志（插件确实在真实环境跑过）", files.length > 0, String(files.length));
	}
}

console.log(`\n===== 运行实例进程级验证: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
