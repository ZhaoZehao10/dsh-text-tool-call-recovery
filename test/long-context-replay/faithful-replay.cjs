/**
 * 忠实重放实验（公开版）：把重建的请求上下文原样打给目标 API，
 * 验证重建精度，并观察是否复现"XML-in-reasoning"行为。
 *
 * 用法：
 *   1) 先从会话日志重建上下文（内部步骤，该脚本不随仓库分发），产出两个文件：
 *      rebuilt-context.json（OpenAI 消息数组）与 rebuilt-tools.json（工具定义数组）。
 *   2) 本脚本从环境变量读取凭据——绝不在代码或仓库中保存任何密钥：
 *        TARGET_API_KEY=sk-xxx node faithful-replay.cjs [次数=1]
 *      可选环境变量：TARGET_BASE_URL（默认 StepFun step_plan）、TARGET_MODEL、
 *      REBUILT_CONTEXT / REAL_TOOLS（覆盖默认文件名）。
 *
 * 安全说明：本地取证版本曾从本地凭据文件读取密钥并引用会话日志；公开版已改为
 * 环境变量注入，且不引用任何会话日志或内部路径。
 */
const fs = require("node:fs");

const KEY = process.env.TARGET_API_KEY;
if (!KEY) {
	console.error("set TARGET_API_KEY first (the key comes from the environment; never commit it)");
	process.exit(1);
}
const BASE = process.env.TARGET_BASE_URL ?? "https://api.stepfun.com/step_plan/v1";
const MODEL = process.env.TARGET_MODEL ?? "step-5-preview";
const N = parseInt(process.argv[2] ?? "1", 10);

const wire = JSON.parse(fs.readFileSync(process.env.REBUILT_CONTEXT ?? "./rebuilt-context.json", "utf8"));
const rawTools = JSON.parse(fs.readFileSync(process.env.REAL_TOOLS ?? "./rebuilt-tools.json", "utf8"));
// 按 pi-ai convertTools 的线上格式包装：{type:"function", function:{..., strict:false}}
const tools = rawTools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters, strict: false } }));

console.log(`base: ${BASE}`);
console.log(`model: ${MODEL}`);
console.log(`上下文: ${wire.length} 条消息 | 工具: ${tools.length} 个 | 计划请求 ${N} 次\n`);

async function runOnce(i) {
	const body = { model: MODEL, messages: wire, tools, stream: true, stream_options: { include_usage: true } };
	const started = Date.now();
	try {
		const resp = await fetch(`${BASE}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(600000)
		});
		if (!resp.ok) {
			const t = await resp.text().catch(() => "");
			console.log(`[${i}] HTTP ${resp.status}: ${t.slice(0, 300)}`);
			return;
		}
		let content = "", reasoning = "", finish = null, promptTokens = null, completionTokens = null;
		const toolNamesSeen = [];
		const reader = resp.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx;
			while ((idx = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, idx).trim();
				buf = buf.slice(idx + 1);
				if (!line.startsWith("data:")) continue;
				const p = line.slice(5).trim();
				if (p === "[DONE]") continue;
				try {
					const chunk = JSON.parse(p);
					if (chunk.usage) {
						promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
						completionTokens = chunk.usage.completion_tokens ?? completionTokens;
					}
					const d = chunk.choices?.[0]?.delta ?? {};
					if (typeof d.content === "string") content += d.content;
					if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
					if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) if (tc.function?.name) toolNamesSeen.push(tc.function.name);
					if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
				} catch { /* SSE 注释行 */ }
			}
		}
		const secs = ((Date.now() - started) / 1000).toFixed(0);
		const xmlInReasoning = /<tool_call>[\s\S]*?(?:<\/tool_call>|<\/function>)/.test(reasoning);
		const xmlInContent = /<tool_call>[\s\S]*?(?:<\/tool_call>|<\/function>)/.test(content);
		const verdict = toolNamesSeen.length > 0
			? `结构化 tool_calls (${toolNamesSeen.join(",")})`
			: xmlInReasoning
				? "*** XML 在 reasoning_content —— 复现！ ***"
				: xmlInContent
					? "*** XML 在 content —— 复现！ ***"
					: content.trim() ? "纯文本回复" : "空回复";
		console.log(`[${i}] ${secs}s prompt_tokens=${promptTokens ?? "?"} completion=${completionTokens ?? "?"} finish=${finish} | ${verdict} | reasoningLen=${reasoning.length}`);
		if (xmlInReasoning || xmlInContent) {
			// 复现样本只写本地文件；分享前必须人工脱敏。
			fs.writeFileSync(`./repro-sample-${i}.txt`, `=== reasoning ===\n${reasoning}\n\n=== content ===\n${content}`);
			console.log(`     样本已写到 ./repro-sample-${i}.txt（分享前请人工脱敏）`);
		}
	} catch (e) {
		console.log(`[${i}] 请求失败: ${e.message}`);
	}
}

(async () => {
	for (let i = 1; i <= N; i++) await runOnce(i);
	console.log("\n实验结束");
})();
