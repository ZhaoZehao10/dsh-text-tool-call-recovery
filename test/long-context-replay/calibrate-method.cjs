/**
 * 方法学校验（公开版）：验证“上下文重建”的保真度。
 *
 * 思路：对多个 turn 分别用 rebuild-context.cjs 的方法重建上下文，统计内容
 * 字符数，与该 turn 真实 usage（inputTokens + cacheReadTokens）对比。若两者
 * 的比值（字符/token）在不同 turn 间保持稳定，说明重建方法与真实请求一致。
 *
 * 用法：node calibrate-method.cjs <session.jsonl>
 *
 * 注意：会话日志可能含敏感内容；输出只有聚合数字，但请自行确认日志来源
 * 是否适合分享。
 */
const fs = require("node:fs");

const inputPath = process.argv[2];
if (!inputPath) {
	console.error("usage: node calibrate-method.cjs <session.jsonl>");
	process.exit(1);
}
const lines = fs.readFileSync(inputPath, "utf8").split("\n").filter(Boolean);
const events = [];
for (const line of lines) {
	let o;
	try { o = JSON.parse(line); } catch { continue; }
	events.push(o);
}
events.sort((a, b) => a.seq - b.seq);

// 每个 turn 最后一次 assistant/message 的真实 usage
const usageByTurn = new Map();
for (const o of events) {
	if (o.type !== "assistant/message") continue;
	const u = o.data?.usage;
	if (!u) continue;
	const prev = usageByTurn.get(o.data.turn);
	if (!prev || o.seq > prev.seq) usageByTurn.set(o.data.turn, { seq: o.seq, u });
}

const MSG_TYPES = new Set(["system/message", "user/message", "assistant/message", "tool/result"]);

// 与 rebuild-context.cjs 相同的重放逻辑，统计到每个 turn 的内容字符数（不含 reasoning）
function rebuildChars(targetSeq) {
	const surface = [];
	for (const o of events) {
		if (o.seq >= targetSeq) break;
		if (!MSG_TYPES.has(o.type)) continue;
		const op = o.surfaceOp ?? o.data?.surfaceOp;
		if (op && typeof op === "object" && op.op === "replace") {
			const start = surface.findIndex((s) => s.seq === op.startSeq);
			const end = surface.findIndex((s) => s.seq === op.endSeq);
			if (start >= 0 && end >= start) surface.splice(start, end - start + 1, { seq: o.seq, event: o });
			else surface.push({ seq: o.seq, event: o });
		} else surface.push({ seq: o.seq, event: o });
	}
	let chars = 0;
	for (const { event: o } of surface) {
		const blocks = o.type === "user/message" ? o.data?.content ?? [] : o.data?.message?.content ?? [];
		for (const b of blocks) {
			if (b.type === "reasoning") continue; // 历史思考不回传
			if (typeof b.text === "string") chars += b.text.length;
			if (typeof b.arguments === "string") chars += b.arguments.length;
		}
	}
	return { chars, n: surface.length };
}

console.log("turn | 真实usage | 重建字符(不含reasoning) | 字符/token 比");
for (const [turn, { seq, u }] of [...usageByTurn.entries()].sort((a, b) => a[0] - b[0])) {
	const real = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0);
	const { chars, n } = rebuildChars(seq + 1);
	const ratio = real > 0 ? (chars / real).toFixed(2) : "-";
	console.log(`t${String(turn).padStart(2)} (seq ${seq}) | ${String(real).padStart(8)} | ${String(chars).padStart(9)} (${n}条) | ${ratio}`);
}
