// 真实环境验证：插件在磁盘上的实际状态 + 加载路径 + 生效证据
//
// 前面 19 轮都在测试"源码"。本测试验证"真实环境"：
//   1. 安装位置是否正确（profile/node_modules）
//   2. cordis.patch.yml 是否真的会加载它（insert 形式）
//   3. 源码与安装副本是否一致
//   4. 环境变量开关在生产是否被误设置
//   5. 真实日志里是否有插件工作的痕迹（合成 id）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

import { sameContent } from "./_file-compare.mjs";
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC_LIB = path.join(ROOT, "lib", "index.js");
const PROFILE = path.join(os.homedir(), ".dsh", "profiles", "desktop");

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };
const skip = (l, why) => { console.log(`  ⏭️  ${l}（跳过：${why}）`); };

console.log("=== 1. 源码自检 ===");
{
	const src = fs.readFileSync(SRC_LIB, "utf8");
	ck("源码存在且非空", src.length > 10000, `${src.length} 字节`);
	ck("导出 apply", /export \{ apply/.test(src) || /apply as/.test(src), "");
	ck("导出 name", /export \{ apply, name/.test(src) || /name as/.test(src), "");
	ck("导出 VERSION（运行时确认加载版本的依据）", /export \{[^}]*VERSION/.test(src), "");
	// VERSION 必须与 package.json 一致（否则部署排查会被误导）
	const pkgPath = path.join(ROOT, "package.json");
	if (fs.existsSync(pkgPath)) {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
		const m = src.match(/const VERSION = "([^"]+)"/);
		ck("VERSION 与 package.json 一致", m !== null && m[1] === pkg.version, `lib=${m?.[1]} pkg=${pkg.version}`);
	}
	console.log(`  源码大小: ${src.length} 字节`);
}

console.log("\n=== 2. 安装位置检查 ===");
{
	if (!fs.existsSync(PROFILE)) {
		skip("profile 存在", PROFILE);
	} else {
		const pkgDir = path.join(PROFILE, "node_modules", "@zhaozehao10", "dsh-text-tool-call-recovery");
		ck("插件已安装到 profile", fs.existsSync(pkgDir), pkgDir);

		if (fs.existsSync(pkgDir)) {
			const instLib = path.join(pkgDir, "lib", "index.js");
			ck("安装副本有 lib/index.js", fs.existsSync(instLib), "");

			const srcHash = fs.readFileSync(SRC_LIB);
			const instHash = fs.readFileSync(instLib);
			// **缺陷 165**：按规范化文本比较（跨平台 CRLF/LF 差异不应判为不一致）
			const same = sameContent(srcHash, instHash);
			ck("源码与安装副本一致", same, same ? "" : `源码 ${srcHash.length}B vs 安装 ${instHash.length}B（已忽略换行符差异）`);

			const pkgJson = path.join(pkgDir, "package.json");
			if (fs.existsSync(pkgJson)) {
				const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
				console.log(`  package.json: ${pkg.name}@${pkg.version}`);
				ck("package.json 有 name", typeof pkg.name === "string" && pkg.name.length > 0, "");
				ck("package.json 有 version", typeof pkg.version === "string", "");
				ck("version 是 semver", /^\d+\.\d+\.\d+/.test(pkg.version ?? ""), pkg.version);
				ck("指定了 main/exports", Boolean(pkg.main || pkg.exports), JSON.stringify({ main: pkg.main, exports: pkg.exports }));
			} else {
				ck("安装副本有 package.json", false, pkgJson);
			}
		}
	}
}

console.log("\n=== 3. cordis.patch.yml 加载配置 ===");
{
	const patchFile = path.join(PROFILE, "cordis.patch.yml");
	if (!fs.existsSync(patchFile)) {
		skip("cordis.patch.yml 存在", patchFile);
	} else {
		const yml = fs.readFileSync(patchFile, "utf8");
		const hasEntry = yml.includes("text-tool-call-recovery");
		ck("patch 里有插件条目", hasEntry, "");

		// 关键：必须是 insert 形式（plain "- id:" 会被静默跳过）
		const insertForm = /insert:\s*\n(?:\s+.*\n)*?\s+-\s*id:\s*text-tool-call-recovery/.test(yml)
			|| /insert:\s*[\s\S]{0,500}?id:\s*text-tool-call-recovery/.test(yml);
		ck("使用 insert 形式（否则会被静默跳过）", insertForm, insertForm ? "" : "未找到 insert 包裹");

		// 打印相关片段
		const idx = yml.indexOf("text-tool-call-recovery");
		if (idx >= 0) {
			const start = Math.max(0, yml.lastIndexOf("insert:", idx));
			const seg = yml.slice(start, idx + 60);
			console.log(`\n  配置片段:\n${seg.split("\n").map((l) => "    " + l).join("\n")}`);
		}
	}
}

console.log("\n=== 4. 环境变量开关（生产不应被误设）===");
{
	const v = process.env.DSH_TEXT_TOOL_CALL_RECOVERY;
	console.log(`  DSH_TEXT_TOOL_CALL_RECOVERY = ${v === undefined ? "（未设置，插件启用）" : JSON.stringify(v)}`);
	// 这是"当前进程"的环境，不代表宿主进程；仅提示
	if (v === "0") {
		console.log("  ⚠️ 当前进程里设置了禁用开关 —— 若宿主进程也有该变量，插件会被禁用");
	}
	ck("当前进程环境不误禁用", v !== "0", v ?? "");
}

console.log("\n=== 5. 加载验证（真实 ESM 导入）===");
{
	let mod = null;
	let err = null;
	try {
		mod = await import(pathToFileURL(SRC_LIB).href + "?load=" + Date.now());
	} catch (e) { err = e; }
	ck("源码可被 ESM 导入", err === null, err?.message ?? "");
	if (mod) {
		ck("导出 apply 是函数", typeof mod.apply === "function", typeof mod.apply);
		ck("导出 name 是字符串", typeof mod.name === "string", typeof mod.name);
		console.log(`  插件名: ${mod.name}`);

		// 实际调用 apply，确认能注册监听
		const events = [];
		try {
			mod.apply({ on: (e) => events.push(e) });
		} catch (e) { err = e; }
		ck("apply 可正常调用", err === null, err?.message ?? "");
		ck("注册了 llm/stream", events.includes("llm/stream"), JSON.stringify(events));
	}
}

console.log("\n=== 6. 真实日志里的生效证据（合成调用）===");
{
	const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");
	if (!fs.existsSync(SESSIONS)) {
		skip("会话日志", SESSIONS);
	} else {
		// **必须完整解压**才能看到真实内容（zstd 压缩后明文不可见）
		const zlib = await import("node:zlib");
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
			const out = [];
			for (let k = 0; k < st.length; k++) {
				const s = st[k], e = k + 1 < st.length ? st[k + 1] : buf.length;
				try { out.push(zlib.zstdDecompressSync(buf.subarray(s, e))); } catch {}
			}
			return Buffer.concat(out).toString("utf8");
		}

		let files = 0;
		let withTxtcall = 0;
		let total = 0;
		(function walk(d) {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) walk(p);
				else if (e.name === "session.v4.jsonl.zstd") {
					files++;
					let text;
					try { text = decompress(p); } catch { return; }
					const n = (text.match(/txtcall-/g) || []).length;
					if (n > 0) { withTxtcall++; total += n; }
				}
			}
		})(SESSIONS);
		console.log(`  会话日志 ${files} 个，含 txtcall- 的 ${withTxtcall} 个，共出现 ${total} 次`);
		ck("存在插件生效的真实证据", withTxtcall > 0 && total > 0, `找到 ${withTxtcall} 个会话 / ${total} 次`);
	}
}

console.log(`\n===== 真实环境验证: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
