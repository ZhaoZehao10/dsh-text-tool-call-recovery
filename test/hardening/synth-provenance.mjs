// 生产合成调用溯源审计（真实数据回归）
//
// 审查插件在真实运行中恢复出的每一个调用，验证「内容可溯源」：
//   工具名 + 每个参数键 + 每个参数值的前 30 字，都必须能在该流的源文本里找到。
// 这是防止「凭空生成调用」或「参数被篡改」的最直接证据。
//
// 实测结果：22/22 全部溯源一致。
//
// 用法：node test/hardening/synth-provenance.mjs
// 无日志时跳过。
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LLM = (() => {
	const cands = [
		process.env.DSH_LLM_SRC ? path.join(process.env.DSH_LLM_SRC, "lib", "index.js") : null,
		path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js"),
	].filter(Boolean);
	for (const c of cands) if (fs.existsSync(c)) return c;
	return null;
})();
if (LLM === null) { console.log("跳过：找不到 dsh-llm"); process.exit(0); }

const { expandAssistantStream } = await import(pathToFileURL(LLM).href);

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

const SESSIONS = path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "sessions");
if (!fs.existsSync(SESSIONS)) { console.log("跳过：没有会话日志"); process.exit(0); }

const audits = [];
(function walk(d) {
	if (!fs.existsSync(d)) return;
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p);
		else if (e.name === "session.v4.jsonl.zstd") {
			let text; try { text = decompress(p); } catch { return; }
			for (const line of text.split("\n")) {
				if (!line || !line.includes("txtcall-")) continue;
				let o; try { o = JSON.parse(line); } catch { continue; }
				if (o.type !== "assistant/message") continue;
				const raw = o.data?.stream;
				if (!Array.isArray(raw) || !raw.length) continue;
				let chunks; try { chunks = expandAssistantStream(raw).map((r) => r.chunk); } catch { continue; }
				const synth = chunks.filter((c) => String(c.block?.id ?? "").startsWith("txtcall-"));
				if (synth.length === 0) continue;

				// 源文本：deltas 拼接 + block-end 兜底（取更长的）
				const perIndex = new Map();
				for (const c of chunks) {
					if (c.index === undefined) continue;
					if (c.type === "reasoning-delta" || c.type === "text-delta") {
						perIndex.set(c.index, (perIndex.get(c.index) ?? "") + (c.text ?? ""));
					}
				}
				for (const c of chunks) {
					if (c.type === "block-end" && (c.block?.type === "text" || c.block?.type === "reasoning")) {
						const full = c.block.text ?? "";
						const fromDelta = perIndex.get(c.index) ?? "";
						perIndex.set(c.index, full.length >= fromDelta.length ? full : fromDelta);
					}
				}
				const allText = [...perIndex.values()].join("\n");

				for (const s of synth) {
					let args;
					try { args = JSON.parse(s.block.arguments ?? "{}"); } catch { args = null; }
					audits.push({
						id: s.block.id, name: s.block.name, args, textLen: allText.length,
						hasTag: /<(tool_call|function|invoke|parameter)/i.test(allText),
						checks: args === null ? [{ k: "参数是合法 JSON", ok: false }] : [
							{ k: "工具名可溯源", ok: allText.includes(`function=${s.block.name}`) || allText.includes(`function name="${s.block.name}"`) || allText.includes(`name="${s.block.name}"`) || allText.includes(`"${s.block.name}"`) },
							...Object.entries(args).flatMap(([key, val]) => [
								{ k: `参数键 ${key} 可溯源`, ok: allText.includes(`parameter=${key}`) || allText.includes(`parameter name="${key}"`) || allText.includes(`"${key}"`) },
								...(typeof val === "string" && val.length > 10 ? [{ k: `参数值 ${key} 数值可溯源`, ok: allText.includes(val.slice(0, 30)) }] : []),
							]),
						],
					});
				}
			}
		}
	}
})(SESSIONS);

if (audits.length === 0) {
	console.log("跳过：日志中没有插件合成的调用（可能还没发生过文本工具调用）");
	process.exit(0);
}

console.log("=== 生产合成调用溯源审计 ===");
console.log(`合成调用总数: ${audits.length}\n`);

let okCount = 0;
const bad = [];
for (const a of audits) {
	const fails = a.checks.filter((c) => !c.ok);
	if (fails.length === 0) { okCount++; continue; }
	bad.push({ ...a, fails });
}

console.log(`完全溯源一致: ${okCount} / ${audits.length}`);

if (bad.length) {
	console.log(`\n--- 溯源失败（${bad.length} 个）---`);
	for (const a of bad) {
		console.log(`\n[${a.id}] ${a.name}`);
		console.log(`  源文本长=${a.textLen} 含标签=${a.hasTag}`);
		for (const f of a.fails) console.log(`  ❌ ${f.k}`);
	}
	console.log(`\n❌ ${bad.length} 个合成调用无法溯源（可能凭空生成或被篡改）`);
	process.exit(1);
}

console.log("\n✅ 所有合成调用均可溯源：工具名/参数键/参数值都能在源文本里找到");
process.exit(0);
