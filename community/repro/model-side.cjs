/**
 * 最小复现 A（模型侧）：step-5-preview 间歇性把工具调用写成 XML 文本塞进 reasoning_content
 *
 * 用法：
 *   STEPFUN_API_KEY=sk-xxx node model-side.cjs [次数=10]
 *
 * 观察：大多数请求返回结构化 tool_calls（finish_reason=tool_calls），
 * 偶发请求在 reasoning_content 里返回 XML 文本形式的工具调用，且
 * tool_calls 为空、finish_reason=stop。命中率不稳定（实测约 20%-60%，
 * 与时间段相关），与上下文长度无必然关系（已用 42 万 token 忠实重放排除）。
 *
 * 自包含 / self-contained: no dependencies, no imports from this repo.
 */
const KEY = process.env.STEPFUN_API_KEY;
if (!KEY) {
	console.error("");
	console.error("  ERROR: STEPFUN_API_KEY is not set.");
	console.error("");
	console.error("  This script calls the real StepFun API to reproduce the model-side bug,");
	console.error("  which is intermittent — it needs a real key to drive the model.");
	console.error("");
	console.error("  Usage:");
	console.error("    Windows (PowerShell):  $env:STEPFUN_API_KEY = \"sk-...\"; node model-side.cjs 20");
	console.error("    macOS / Linux:         STEPFUN_API_KEY=sk-... node model-side.cjs 20");
	console.error("");
	console.error("  If you do not have a key, run the harness-side repro instead — it needs");
	console.error("  no API key and reproduces the user-visible symptom in ~5 seconds:");
	console.error("    node harness-side.mjs");
	console.error("");
	process.exit(1);
}
const URL = "https://api.stepfun.com/step_plan/v1/chat/completions";
const N = parseInt(process.argv[2] ?? "10", 10);

const TOOLS = [
	{
		type: "function",
		function: {
			name: "get_weather",
			description: "查询指定城市的当前天气",
			parameters: { type: "object", properties: { city: { type: "string", description: "城市名" } }, required: ["city"] },
			strict: false
		}
	}
];
const MESSAGES = [
	{ role: "system", content: "你是一个工具调用助手。需要实时信息时调用提供的工具。" },
	{ role: "user", content: "北京现在天气怎么样？请调用 get_weather 工具查询。" }
];

async function once(i) {
	const body = { model: "step-5-preview", messages: MESSAGES, tools: TOOLS, stream: true, stream_options: { include_usage: true } };
	const resp = await fetch(URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(120000)
	});
	if (!resp.ok) {
		console.log(`[${i}] HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
		return;
	}
	let content = "", reasoning = "", finish = null;
	const toolNames = [];
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
				const d = chunk.choices?.[0]?.delta ?? {};
				if (typeof d.content === "string") content += d.content;
				if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
				if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) if (tc.function?.name) toolNames.push(tc.function.name);
				if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
			} catch { /* SSE 注释行 */ }
		}
	}
	const xml = /<tool_call>[\s\S]*?(?:<\/tool_call>|<\/function>)/.test(reasoning);
	const verdict = toolNames.length > 0 ? "OK 结构化 tool_calls" : xml ? "**BUG: XML 工具调用在 reasoning_content，tool_calls 为空，finish=stop**" : "其他";
	console.log(`[${i}] finish=${finish} tools=${toolNames.join(",") || "-"} reasoningLen=${reasoning.length} | ${verdict}`);
	if (xml && toolNames.length === 0) {
		console.log("    ---- reasoning_content 尾部 400 字符 ----");
		console.log(reasoning.slice(-400).split("\n").map((l) => "    " + l).join("\n"));
	}
}

(async () => {
	for (let i = 1; i <= N; i++) await once(i);
	console.log(`\n${N} 次请求完成。统计 XML-in-reasoning 的命中次数即可估计复现率。`);
})();
