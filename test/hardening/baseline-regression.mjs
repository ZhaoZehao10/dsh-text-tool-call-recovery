// 真实流行为基线回归
//
// **为什么需要这个套件**：
// 现有 `replay-real-streams.mjs` 只验证「插件没破坏任何真实流」，但它无法发现
// **行为漂移** —— 例如：
//   - 以前能从某种流里恢复调用，现在不恢复了（**漏识别回归**）
//   - 以前不改写某种流，现在开始改写了（**误伤回归**）
// 这两类问题都不会让「没破坏」的断言失败。
//
// **做法**：把「插件会改写哪些流 + 改成什么」固化成基线快照
// （`real-stream-baseline.json`），之后每次跑都对比。
//
// **基线设计要点**（第 53 轮实测确认）：
//   - 只记录**被改写**的流（1.4 万条里只有 5 条），文件 1KB
//   - 指纹 = 流内容的 SHA256 前 16 位（与 session id / 时间无关）
//   - **不记录扫描总数** —— 它会随日常使用增长，参与比对会造成假失败
//   - 记录 lib 哈希，便于确认基线对应哪一版代码
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LIB = path.join(ROOT, "lib", "index.js");
const BASELINE = path.join(ROOT, "test", "hardening", "real-stream-baseline.json");
const LLM = (() => {
	const cands = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
	].filter(Boolean);
	for (const c of cands) if (fs.existsSync(c)) return c;
	return null;
})();

let pass = 0, fail = 0;
const failures = [];
const ck = (l, c, d) => { if (c) pass++; else { fail++; failures.push(`${l}${d ? " :: " + d : ""}`); } };

// ===========================================================================
// 1. 基线文件存在且格式正确
// ===========================================================================
console.log("=== 1. 基线文件 ===");
if (!fs.existsSync(BASELINE)) {
	console.log("  ⚠️ 基线不存在，跳过（首次请运行 test/hardening/build-baseline.mjs）");
	process.exit(0);
}
let baseline;
try {
	baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
} catch (e) {
	console.log(`  ❌ 基线解析失败: ${e.message}`);
	process.exit(1);
}

console.log(`  生成时间: ${baseline.generatedAt}`);
console.log(`  lib 版本: ${baseline.libVersion}（哈希 ${baseline.libSha256}）`);
console.log(`  改写条目: ${baseline.changed.length}`);
console.log(`  文件大小: ${(fs.statSync(BASELINE).size / 1024).toFixed(1)} KB`);

ck("基线有 changed 数组", Array.isArray(baseline.changed), typeof baseline.changed);
ck("基线有 lib 哈希", typeof baseline.libSha256 === "string", typeof baseline.libSha256);
ck("基线文件足够小（< 100KB，可提交）", fs.statSync(BASELINE).size < 100 * 1024,
	`${fs.statSync(BASELINE).size} 字节`);
ck("基线条目数合理（< 1000）", baseline.changed.length < 1000, String(baseline.changed.length));

// ===========================================================================
// 2. 当前 lib 是否与基线时一致（不一致要多加小心）
// ===========================================================================
console.log("\n=== 2. 代码版本对比 ===");
const libSha = createHash("sha256").update(fs.readFileSync(LIB)).digest("hex").slice(0, 16);
console.log(`  基线时 lib: ${baseline.libSha256}`);
console.log(`  当前 lib:   ${libSha}`);
const sameCode = libSha === baseline.libSha256;
console.log(`  代码相同: ${sameCode ? "✅" : "⚠️ 已变更（预期行为可能变化）"}`);

if (!sameCode) {
	console.log("  提示：如果你**有意**改了插件行为，需要重新生成基线：");
	console.log("        node test/hardening/build-baseline.mjs");
}

// ===========================================================================
// 3. 重放真实流，与基线对比
// ===========================================================================
console.log("\n=== 3. 重放并对比 ===");
if (LLM === null) {
	console.log("  ⚠️ 找不到 dsh-llm，跳过重放");
	process.exit(fail === 0 ? 0 : 1);
}

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
		try { parts.push(zlib.zstdDecompressSync(buf.subarray(s, e))); } catch { /* ignore */ }
	}
	return Buffer.concat(parts).toString("utf8");
}

const { expandAssistantStream } = await import(pathToFileURL(LLM).href);
const plugin = await import(pathToFileURL(LIB).href + "?regress=" + Date.now());
let listener;
plugin.apply({ on: (e, h) => { if (e === "llm/stream") listener = h; } });

const SESSIONS = path.join(os.homedir(), ".dsh", "sessions");
if (!fs.existsSync(SESSIONS)) {
	console.log("  ⚠️ 无会话日志，跳过");
	process.exit(fail === 0 ? 0 : 1);
}

const files = [];
(function walk(d) {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) { walk(p); continue; }
		if (e.name === "session.v4.jsonl.zstd") files.push({ p, size: fs.statSync(p).size });
	}
})(SESSIONS);

const current = [];
let scanned = 0;
for (const f of files) {
	let text;
	try { text = decompress(f.p); } catch { continue; }
	const sessionName = path.basename(path.dirname(f.p)).slice(0, 8);

	for (const line of text.split("\n")) {
		if (!line.includes('"assistant/message"')) continue;
		let o;
		try { o = JSON.parse(line); } catch { continue; }
		if (o.type !== "assistant/message") continue;
		const raw = o.data?.stream;
		if (!Array.isArray(raw) || !raw.length) continue;

		let chunks;
		try { chunks = expandAssistantStream(raw).map((r) => r.chunk); } catch { continue; }
		if (!chunks || !chunks.length) continue;
		scanned++;

		const fp = createHash("sha256").update(JSON.stringify(chunks)).digest("hex").slice(0, 16);
		plugin.resetStreaks?.();
		const out = [];
		const model = o.data?.message?.source?.model ?? "?";
		const provider = o.data?.message?.source?.provider ?? "?";
		try {
			const gen = (async function* () { for (const c of chunks) yield c; })();
			for await (const c of listener({ provider, model, messages: [], tools: [{ name: "pwsh" }] }, () => gen)) out.push(c);
		} catch { continue; }

		const inCalls = chunks.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").length;
		const outCalls = out.filter((c) => c.type === "block-end" && c.block?.type === "tool-call").length;
		const inFin = chunks.find((c) => c.type === "finish")?.reason?.kind ?? null;
		const outFin = out.find((c) => c.type === "finish")?.reason?.kind ?? null;

		if (inCalls !== outCalls || inFin !== outFin) {
			current.push({ fp, session: sessionName, inCalls, outCalls, inFin, outFin });
		}
	}
}
current.sort((a, b) => a.fp.localeCompare(b.fp));

console.log(`  扫描流: ${scanned}（基线时 ${baseline.totals.streamsScanned}，**不参与比对**）`);
console.log(`  当前改写: ${current.length}（基线 ${baseline.changed.length}）`);

// 按指纹对比
const baseMap = new Map(baseline.changed.map((e) => [e.fp, e]));
const curMap = new Map(current.map((e) => [e.fp, e]));

const missing = [];    // 基线有、当前没有 → 不再改写（可能漏识别回归）
const added = [];      // 基线没有、当前有 → 新增改写（可能误伤回归）
const changedResult = [];

for (const [fp, e] of baseMap) {
	if (!curMap.has(fp)) { missing.push(e); continue; }
	const c = curMap.get(fp);
	if (c.outCalls !== e.outCalls || c.outFin !== e.outFin) {
		changedResult.push({ fp, was: e, now: c });
	}
}
for (const [fp, e] of curMap) {
	if (!baseMap.has(fp)) added.push(e);
}

console.log(`\n  基线有但当前没有（不再改写）: ${missing.length}`);
for (const e of missing.slice(0, 10)) {
	console.log(`    ${e.fp} ${e.session} 原: ${e.inFin}(${e.inCalls}) -> ${e.outFin}(${e.outCalls})`);
}
console.log(`  基线没有但当前有（新增改写）: ${added.length}`);
for (const e of added.slice(0, 10)) {
	console.log(`    ${e.fp} ${e.session} 现: ${e.inFin}(${e.inCalls}) -> ${e.outFin}(${e.outCalls})`);
}
console.log(`  改写结果变了: ${changedResult.length}`);
for (const c of changedResult.slice(0, 10)) {
	console.log(`    ${c.fp} 原 ${c.was.outFin}(${c.was.outCalls}) -> 现 ${c.now.outFin}(${c.now.outCalls})`);
}

// ===========================================================================
// 4. 判定
// ===========================================================================
console.log("\n=== 4. 判定 ===");
{
	// **核心判据**：如果一个流被插件改写过，现在**不应该不再改写**（那是漏识别回归）
	// 例外：如果代码有意改了（lib 哈希不同），需要重新生成基线
	if (missing.length > 0) {
		ck("没有「不再改写」的流（漏识别回归）", false,
			`${missing.length} 条: ${missing.map((e) => e.fp).join(", ")}`);
		console.log(`  ❌ ${missing.length} 条流不再被改写 —— 这可能是漏识别回归`);
		console.log(`     如确认是有意修改，请重新生成基线`);
	} else {
		ck("没有「不再改写」的流（漏识别回归）", true);
		console.log("  ✅ 所有基线里的改写都仍然发生");
	}

	// **新增改写**：可能是误伤回归，但如果代码变了则是预期的
	if (added.length > 0) {
		if (sameCode) {
			ck("代码未变时不应新增改写（误伤回归）", false, `${added.length} 条新增`);
			console.log(`  ❌ 代码未变却新增了 ${added.length} 条改写 —— 这可能是误伤回归`);
		} else {
			console.log(`  ℹ️ 代码已变更，新增 ${added.length} 条改写可能是预期行为`);
			ck("新增改写需人工确认（代码已变）", true);
		}
	} else {
		ck("没有新增改写", true);
		console.log("  ✅ 没有新增改写");
	}

	if (changedResult.length > 0) {
		ck("改写结果未变化", false, `${changedResult.length} 条结果变了`);
		console.log(`  ❌ ${changedResult.length} 条流的改写结果变了`);
	} else {
		ck("改写结果未变化", true);
		console.log("  ✅ 改写结果完全一致");
	}
}

console.log(`\n===== 真实流行为基线: ${pass} passed, ${fail} failed =====`);
if (failures.length) {
	console.log("\n--- 失败明细 ---");
	for (const f of failures) console.log(`  ❌ ${f}`);
	console.log("\n提示：若这是**有意**的行为变更，运行下面命令更新基线：");
	console.log("  node test/hardening/build-baseline.mjs");
}
process.exit(fail === 0 ? 0 : 1);
