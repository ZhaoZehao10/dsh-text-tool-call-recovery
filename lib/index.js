/**
 * @module @zhaozehao10/dsh-text-tool-call-recovery
 *
 * 修复两类模型把工具调用写成文本、导致 harness 静默丢弃调用的问题：
 *  A. step-5-preview（StepFun step_plan）：XML 文本工具调用塞进 reasoning_content；
 *  B. deepseek-v4.1-flash-max（经 magpie 路由 fallback）：Anthropic 风格
 *     `parameter name=key` 文本工具调用，且常被上游截断（如以不完整的
 *     闭合标签结尾）。
 *
 * 根因（两层）：
 *  1. 模型/上游把工具调用写成 XML 文本而非结构化 tool_calls 字段；
 *  2. agent loop（dsh-agent-loop lib/index.js:1152-1153）把“没有 tool-call 块”
 *     判定为“回合完成”——静默结束，不报错、不重试。用户侧表现为
 *     “任务自动截断/思考一会儿就卡住”。
 *
 * 修复（两层，均通过官方 llm/stream 瀑布流接缝完成，无需改动 app.asar）：
 *   1. 工具调用恢复：扫描 text/reasoning 块中的工具调用标记，解析出函数名与
 *      参数键值（Qwen 风格 parameter=key 与 Anthropic 风格 parameter name=key
 *      均支持，另兼容 JSON 形式），按工具 JSON Schema 做强类型转换，合成正式
 *      tool-call 流块并把 finish 改写为 tool-calls。仅在响应没有任何结构化
 *      tool_calls 时生效；工具名必须在本次请求声明的 tools 里。
 *   2. 安全网：stop 结束但没有任何可执行内容（只有思考、或只剩无法解析的
 *      标记、或只剩**被截断的**工具调用标记）时，把 finish 改写为可重试的
 *      EMPTY_RESPONSE，让默认重试策略重试，而不是静默结束回合。
 *
 * 禁用：设置环境变量 DSH_TEXT_TOOL_CALL_RECOVERY=0 后重启应用。
 */

/**
 * 插件版本号。与 package.json 的 version 保持一致。
 *
 * **为什么要在代码里也放一份**：插件运行在宿主进程内，日志与错误消息里
 * 若不带版本号，出现"改了代码但没生效"这类问题时无法快速定位。
 * 部署排查时可以 import 这个模块直接读 VERSION 确认加载的是哪一版。
 */
const VERSION = "0.2.0";

/**
 * 把任意值安全地转成字符串，用于消息拼接与键构造。
 *
 * **为什么需要**：模板字符串 `${x}` 在 x 是 **Symbol** 时会抛
 * `TypeError: Cannot convert a Symbol value to a string`；对象则会变成
 * "[object Object]"。这些都发生在 llm/stream 接缝里 —— 抛异常会**中断整条
 * 模型流**。因此所有把外部值拼进字符串的地方都走这个函数。
 *
 * 规则：
 *   - string          → 原样
 *   - number/boolean  → String()
 *   - bigint          → String() + "n"
 *   - symbol          → String(symbol)（即 "Symbol(x)"）
 *   - null/undefined  → fallback
 *   - 其他对象        → 尝试 JSON，失败则 String()，再失败则 fallback
 * @param value - 任意待转换值。
 * @param fallback - 无法表示时的兜底文本，默认 "?"。
 */
function safeString(value, fallback = "?") {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "symbol") return String(value);
	if (value === null || value === undefined) return fallback;
	try { return JSON.stringify(value); } catch { /* 循环引用等 */ }
	try { return String(value); } catch { /* Symbol 之类 */ }
	return fallback;
}

/** Cordis 插件名（Loader 诊断用）。 */
const name = "@zhaozehao10/dsh-text-tool-call-recovery";

// 文本工具调用标记。用拼接构造，避免源码里出现字面闭合标签。
const OPEN_CALL = "<" + "tool_call>";
const CLOSE_CALL = "</" + "tool_call>";
const OPEN_FUNCTION = "<" + "function=";
const CLOSE_FUNCTION = "</" + "function>";
const OPEN_PARAMETER = "<" + "parameter=";
const CLOSE_PARAMETER = "</" + "parameter>";
const OPEN_PARAM_NAME = "<" + "parameter name=";
const OPEN_FUNCTION_TAG = "<" + "function ";
const OPEN_INVOKE_TAG = "<" + "invoke ";
const OPEN_ANTML_FUNCTION = "<" + "antml:function ";
const OPEN_ANTML_INVOKE = "<" + "antml:invoke ";
// **缺陷 129**（第 127 轮）：下面两个常量用于「纯标记判定」。
// 它们与上面 8 个是**同一个概念的不同写法**：`<parameter` 与 `<antml:parameter`。
// 只要有一处漏掉，「只有标记」的文本就会被判成「有实质内容」，
// 安全网随之失效（用户看到 XML 却不执行、不重试）。
const OPEN_ANTML_PARAMETER = "<" + "antml:parameter ";
const OPEN_ANTML_PARAMETER_EQ = "<" + "antml:parameter=";

/** Qwen 风格函数形式：function=name ... /function（等号两侧容许空白）。 */
const FUNCTION_EQ_RE = new RegExp(OPEN_FUNCTION + "([^>\\s]+)\\s*>([\\s\\S]*?)" + CLOSE_FUNCTION);
/** Qwen 风格参数形式：parameter=key value /parameter（等号两侧容许空白）。 */
const PARAM_EQ_RE = new RegExp(OPEN_PARAMETER + "([^>\\s]+)\\s*>([\\s\\S]*?)" + CLOSE_PARAMETER, "g");
/**
 * Anthropic 风格函数形式：function name="x" … /function（可带 antml: 前缀）。
 *
 * **属性位置无关**：`name` 可以出现在任意位置，前面/后面可以有任意其它属性：
 *   <function name="pwsh">                    ← 最常见
 *   <function name="pwsh" id="c1">            ← 带额外属性
 *   <function id="c1" name="pwsh">            ← name 不在首位
 *   <function id="c1" name="pwsh" x="y">     ← 前后都有属性
 * 因此用 `[^>]*?` 吞掉 name 之前的属性，用 `[^>]*` 吞掉 name 之后的属性。
 * 同时容许 `name = "x"` 这类等号两侧带空白的合法 XML 变体。
 */
const FUNCTION_NAME_ATTR_RE = new RegExp(
	"<" + "(?:antml:)?function[^>]*?\\bname\\s*=\\s*(?:\"|')?([^\"'\\s>]+)(?:\"|')?[^>]*>([\\s\\S]*?)</" + "(?:antml:)?function" + ">",
	"i",
);
/** Anthropic 风格 invoke 形式：invoke name="x" … /invoke（同上：属性位置无关、容许空白）。 */
const INVOKE_NAME_ATTR_RE = new RegExp(
	"<" + "(?:antml:)?invoke[^>]*?\\bname\\s*=\\s*(?:\"|')?([^\"'\\s>]+)(?:\"|')?[^>]*>([\\s\\S]*?)</" + "(?:antml:)?invoke" + ">",
	"i",
);
/**
 * Anthropic 风格参数形式：parameter name=key value /parameter（同上：属性位置无关、容许空白）。
 *  注意：`OPEN_PARAM_NAME` 常量含 `name=`，这里单独写前缀以容许 `name = "k"` 的空白变体。
 *
 * **缺陷 127**（第 126 轮）：原来只写 `<parameter`，**不接受 `antml:` 前缀** ——
 * 于是真实的 Anthropic 形态（`<antml:function>` 里用 `<antml:parameter>`）
 * 能匹配到外层函数，却**解析不出任何参数**，整条调用被丢弃。
 * 这与 `FUNCTION_NAME_ATTR_RE` / `INVOKE_NAME_ATTR_RE` **支持 `antml:` 前缀**
 * 形成不对称 —— 同一个前缀，外层认、内层不认。
 */
const PARAM_NAME_RE = new RegExp(
	"<" + "(?:antml:)?parameter[^>]*?\\bname\\s*=\\s*(?:\"|')?([^\"'\\s>]+)(?:\"|')?[^>]*>([\\s\\S]*?)</" + "(?:antml:)?parameter" + ">",
	"gi",
);
/** 常见 XML 实体（按序解码，&amp; 放最后）。 */
const ENTITIES = [
	["&lt;", "<"],
	["&gt;", ">"],
	["&quot;", "\""],
	["&apos;", "'"],
	["&#39;", "'"],
	["&amp;", "&"]
];

/** 解码 XML 实体（含数字实体）。 */
function decodeEntities(text) {
	if (typeof text !== "string") return "";
	let out = text;
	for (const [entity, char] of ENTITIES) out = out.replaceAll(entity, char);
	return out.replace(/&#(\d+);/g, (match, code) => {
		const point = Number(code);
		return Number.isFinite(point) && point > 0 ? String.fromCodePoint(point) : match;
	});
}

/** 去掉参数值首尾各一个换行（模型格式化产物），保留内部缩进。 */
function trimEdgeNewlines(text) {
	if (typeof text !== "string") return "";
	// 换行符覆盖三种：LF(\n) / CRLF(\r\n) / **单独 CR(\r)**。
	// 早期实现只写 \r?\n，漏掉了单独的 \r —— 模型偶尔用 \r 作行尾
	// （老式 Mac 格式 / 某些训练数据的产物），会让参数值带上 \r，
	// 使命令变成 "\recho hi" 而无法执行。
	return text.replace(/^(?:\r\n|[\r\n])/, "").replace(/(?:\r\n|[\r\n])$/, "");
}

/** 稳定短哈希，用于生成合成的 tool-call id。 */
function hashString(text) {
	let hash = 5381;
	for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
	return hash.toString(36);
}

function propertiesOf(parameters) {
	return parameters && typeof parameters === "object" && parameters.properties && typeof parameters.properties === "object"
		? parameters.properties
		: undefined;
}

function safeJsonParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return { value: text };
	}
}

/** 按工具 JSON Schema 把文本参数值转成合适的 JS 类型。 */
function coerceValue(raw, schema) {
	const type = schema && typeof schema === "object" ? schema.type : undefined;
	// **保守策略**：空白字符串不做任何强转。
	// `Number("")` 与 `Number("   ")` 都等于 0，会把「模型未设置该参数」
	// 误解为「设为 0」——例如 timeoutMs 变 0（立即超时）、limit 变 0（不取数据）。
	if (typeof raw === "string" && raw.trim() === "") return raw;
	if (type === "number" || type === "integer") {
		const parsed = Number(raw);
		if (!Number.isFinite(parsed)) return raw;
		// **精度保护**：超过 2^53 的整数用 JS number 会静默丢精度
		// （9007199254740993 → 9007199254740992），可能让工具操作**错误的对象**。
		// 这类值保持字符串，由工具自行决定如何解析。
		if (typeof raw === "string" && /^-?\d{16,}$/.test(raw.trim()) && !Number.isSafeInteger(parsed)) return raw;
		return parsed;
	}
	if (type === "boolean") {
		if (raw === "true") return true;
		if (raw === "false") return false;
		return raw;
	}
	if (type === "object" || type === "array") {
		try {
			return JSON.parse(raw);
		} catch {
			return raw;
		}
	}
	return raw;
}

/** 从函数体提取参数（Qwen 风格与 Anthropic 风格均支持）。 */
function parseParams(body, properties) {
	if (typeof body !== "string") return {};
	const args = {};
	for (const re of [PARAM_EQ_RE, PARAM_NAME_RE]) {
		re.lastIndex = 0;
		let match;
		while ((match = re.exec(body)) !== null) {
			const key = match[1].trim();
			if (key.length === 0) continue;
			// **安全关键**：惰性匹配会停在**第一个** </parameter>。若该闭合标签之后
			// 紧跟另一个闭合标签（如 `</parameter></parameter>`），说明第一个闭合是
			// **值内容的一部分**、XML 已被截断/损坏。此时若照常取值，会得到被**静默
			// 截断**的参数（如 `rm -rf /tmp/x` → `rm -rf `），进而执行半截危险命令。
			// 正确做法：整条调用视为不可信 → 由调用方（parseCallBody）返回 null 放弃恢复。
			const afterClose = body.slice(re.lastIndex, re.lastIndex + 32);
			if (/^\s*</.test(afterClose)) {
				// 仅当紧跟的是「闭合类」标签时才判为损坏（开标签属正常的后续参数）。
				if (/^\s*<\s*\//.test(afterClose)) return null;
			}
			const value = trimEdgeNewlines(decodeEntities(match[2]));
			args[key] = coerceValue(value, properties ? properties[key] : undefined);
		}
	}
	return args;
}

/**
 * 解析一个 tool_call 块体（Qwen 风格与 Anthropic 风格均支持）。
 * @param body - 标记之间的原始文本。
 * @param declared - 本次请求声明的工具表（name -> ToolSchema）。
 * @returns 解析出的调用，或 null（不是可识别的工具调用 / 工具未声明）。
 */
function parseCallBody(body, declared) {
	if (typeof body !== "string") return null;
	const trimmed = body.trim();
	if (trimmed.length === 0) return null;
	const candidates = [
		FUNCTION_EQ_RE.exec(trimmed),
		FUNCTION_NAME_ATTR_RE.exec(trimmed),
		INVOKE_NAME_ATTR_RE.exec(trimmed)
	];
	for (const fn of candidates) {
		if (!fn) continue;
		const toolName = fn[1].trim();
		const tool = declared.get(toolName);
		if (tool === undefined) continue;
		const properties = propertiesOf(tool.parameters);
		const args = parseParams(fn[2], properties);
		if (args === null) continue;   // 参数区损坏（见 parseParams 注释）：放弃该调用
		if (Object.keys(args).length > 0) return { name: toolName, arguments: args };
		// 函数体非空但没解析出参数：尝试 JSON 形式的参数体
		const jsonBody = fn[2].trim();
		if (jsonBody.startsWith("{")) {
			const parsed = safeJsonParse(jsonBody);
			// **缺陷 55 修复**：必须与其余三条路径一致，按 properties 做强转。
			// 否则模型用「函数标签 + 裸 JSON 参数体」写法时，
			// `"timeout":"3000"` 会保持字符串（其余路径都会转成数字 3000）。
			if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
				const coercedJson = {};
				for (const [key, value] of Object.entries(parsed)) {
					if (key.length === 0) continue;
					coercedJson[key] = typeof value === "string"
						? coerceValue(value, properties ? properties[key] : undefined)
						: value;
				}
				return { name: toolName, arguments: coercedJson };
			}
		}
		continue;
	}
	// 纯 JSON 形式：{"name":..,"arguments":{..}}
	//
	// **安全关键**：只接受「整段就是工具调用 JSON」的形态。
	// 真实事故：模型在汇报里写了 `{"command":"rm -rf /"}` 作为**说明文字**，
	// 若不加限制，任何「看起来像参数对象」的裸 JSON 都会被恢复成真实调用执行。
	// 因此要求：
	//   1. 必须**恰好以 `{` 开头、以 `}` 结尾**（整段就是 JSON，不是文本里的片段）
	//   2. 必须含明确的工具名键（name / tool / function），且是已声明的工具
	//   3. 参数容器必须是 arguments / input / parameters / args 之一
	//      —— 只有 `{"command": ...}` 这类没有工具名的对象一律拒绝
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
			// 工具名键：只认明确的键名，不接受猜测
			const rawName = typeof parsed.name === "string" ? parsed.name
				: typeof parsed.tool === "string" ? parsed.tool
					: typeof parsed.function === "string" ? parsed.function
						: undefined;
			if (rawName === undefined || !declared.has(rawName)) return null;
			// 参数容器：必须有明确容器键，避免把「任意 JSON 对象」当参数
			const hasContainer = Object.hasOwn(parsed, "arguments") || Object.hasOwn(parsed, "input")
				|| Object.hasOwn(parsed, "parameters") || Object.hasOwn(parsed, "args");
			if (!hasContainer) return null;
			const tool = declared.get(rawName);
			const properties = propertiesOf(tool?.parameters);
			const rawArgs = parsed.arguments ?? parsed.input ?? parsed.parameters ?? parsed.args ?? {};
			const decoded = typeof rawArgs === "string" ? safeJsonParse(rawArgs) : rawArgs;
			if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
				return { name: rawName, arguments: { value: decoded } };
			}
			const coerced = {};
			for (const [key, value] of Object.entries(decoded)) {
				if (key.length === 0) continue;
				coerced[key] = typeof value === "string"
					? coerceValue(value, properties ? properties[key] : undefined)
					: value;
			}
			return { name: rawName, arguments: coerced };
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * 判定文本是否“只是工具调用标记”（无法构成可执行内容）。
 *
 * 判据 = **标记之外还剩多少实质文字**，而不是“是否出现标记”：
 *  - 真实截断/畸形样本里，标记占据文本主体（如整段都是 parameter 元素）；
 *  - 正常正文里偶然提及 `<parameter=foo>` 这种写法时，实质文字占主导。
 * 因此两种形态都按“标记外的实质字符数”判定，避免把正常回复误判成错误。
 *
 * 注意：这个函数只影响**安全网**（stop 且无可见内容 → EMPTY_RESPONSE）。
 * 它绝不会把有实质内容的正常回复改成错误。
 */
function isMarkupOnlyText(text) {
	if (typeof text !== "string") return false;
	const hasMarker = text.includes(OPEN_CALL)
		|| text.includes(OPEN_FUNCTION)
		|| text.includes(OPEN_PARAMETER)
		|| text.includes(OPEN_PARAM_NAME)
		|| text.includes(OPEN_FUNCTION_TAG)
		|| text.includes(OPEN_INVOKE_TAG)
		|| text.includes(OPEN_ANTML_FUNCTION)
		|| text.includes(OPEN_ANTML_INVOKE)
		// **缺陷 129**（第 127 轮）：漏了 `antml:parameter`。
		// `isMarkupOnlyText` 的职责是「这段文本只有标记、没有实质内容」，
		// 一旦判 false，安全网就不会触发 EMPTY_RESPONSE —— 用户看到满屏 XML
		// 却什么都不发生（既不执行也不重试）。
		// 前 8 个标记都覆盖了，唯独 `antml:parameter` 没覆盖，
		// 这与缺陷 127（`PARAM_NAME_RE` 漏 `antml:`）是**同一类不对称**。
		|| text.includes(OPEN_ANTML_PARAMETER)
		|| text.includes(OPEN_ANTML_PARAMETER_EQ);
	if (!hasMarker) return false;
	// 性能保护：超长文本不参与“纯标记”判定，按“有实质内容”处理（保守方向：
	// 宁可放行让用户看到内容，也不误判成错误并重试）。
	if (text.length > MAX_SCAN_CHARS) return false;
	const trimmed = text.trim();
	// 统计标签字符数：线性扫描累加，避免 `match` 产生大量小字符串再 join
	// （32 万字符的病态输入下，后者实测耗时数秒）。
	let tagChars = 0;
	let i = 0;
	while (i < trimmed.length) {
		if (trimmed.charCodeAt(i) === 60 /* < */) {
			const close = trimmed.indexOf(">", i + 1);
			if (close < 0) break;
			tagChars += close - i + 1;
			i = close + 1;
			continue;
		}
		i += 1;
	}
	const substantiveChars = trimmed.length - tagChars;
	// 实质文字少于 20 个字符，且标记字符占比过半 → 视为“纯标记文本”。
	// 20 是保守阈值：真实畸形样本的实质文字通常只有空白与换行；正常正文远超此值。
	return substantiveChars < 20 && tagChars / Math.max(trimmed.length, 1) > 0.5;
}

/**
 * 单个块做恢复扫描的文本长度上限（字符）。
 *
 * **性能保护**：恢复用的正则在病态输入（大量重复的未闭合标记）上会回溯，
 * 实测 20 万字符的病态输入可耗时数秒——而插件挂在 `llm/stream` 接缝上，
 * 卡住即等于卡住整条模型流。超过上限时**放弃恢复**（原样放行），
 * 由安全网判断是否为空响应。
 *
 * 128K 字符已远超正常模型输出（正常回复通常 < 20K 字符），
 * 不会影响真实场景。
 */
const MAX_SCAN_CHARS = 128 * 1024;

/** 跨行反引号对的向后扫描上限（安全优先，避免病态输入下变慢）。 */
const MAX_MULTILINE_INLINE_SCAN = 8192;

/**
 * Markdown 代码围栏（展示区）与行内代码的识别。
 *
 * **安全关键**：模型在讲解格式时会把工具调用标记放进代码块里展示
 * （```xml ... ``` 或 `inline code`）。这些是“示例”，绝不能当成真调用执行。
 * 因此含围栏/行内代码的文本整体视为展示，不做恢复。
 *
 * **性能关键**：这里刻意**不用正则**做围栏匹配。正则版本
 * `(```+)[\s\S]*?(?:\3|$)` 在大量未闭合围栏上会灾难性回溯（实测 6 万字符
 * 的重复围栏耗时近 6 秒）。改为线性扫描：只要发现任一围栏标记行或成对
 * 行内代码，即判定为展示文本。判定只需要“有没有”，不需要“匹配区间”。
 */

/**
 * 判断 `offset` 位置是否落在 Markdown 展示区内（代码围栏内或行内代码内）。
 *
 * 围栏：行首（可带缩进）连续 >=3 个反引号或波浪号，成对出现；
 *       未闭合的围栏视为「其后的内容都在展示区」（保守）。
 * 行内代码：同一行内成对的等长反引号串（仅在围栏外生效）。
 *
 * 线性扫描 O(offset)，不使用正则（避免病态输入下的灾难性回溯）。
 * @param text - 块的完整文本。
 * @param offset - 待判定的偏移位置。
 */
/**
 * 计算「展示区区间表」：一次性线性扫描，返回按起始位置排序的 [start, end) 区间。
 * 展示区包括：Markdown 代码围栏（含未闭合时直到文本末尾）与行内代码。
 *
 * **性能关键**：早期实现是「对每个标记调用一次 O(n) 判定」，在大量标记的
 * 病态输入下退化为 O(n²)（实测 20 万字符 6 秒）。改为一次性扫描 + 二分查询。
 * @param text - 块的完整文本。
 * @returns 升序的展示区区间数组。
 */
function computeDisplayRanges(text) {
	if (typeof text !== "string") return [];
	const ranges = [];
	let i = 0;
	while (i < text.length) {
		const ch = text.charCodeAt(i);
		// **缺陷 126**（第 125 轮）：原来只认 LF（10）。
		// 纯 CR（老式 Mac 行尾）文本里一个 LF 都没有，于是围栏扫描
		// `indexOf("\n")` 永远返回 -1、`close` 保持 -1、`fenceEnd` 退化成
		// `text.length` —— **整个剩余文本都被当成围栏内容**，后面的真实调用
		// 全部丢失（实测：CR + 围栏后跟真实调用 → 恢复出 0 个）。
		// 现在同时接受 LF 与 CR。
		const prev = i === 0 ? -1 : text.charCodeAt(i - 1);
		const atLineStart = i === 0 || prev === 10 || prev === 13;
		// 围栏：行首（可带缩进）连续 >=3 个反引号或波浪号
		if (atLineStart && (ch === 96 || ch === 126)) {
			let k = i;
			while (k < text.length && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k += 1;
			const fc = text.charCodeAt(k);
			if (fc === 96 || fc === 126) {
				let runEnd = k;
				while (runEnd < text.length && text.charCodeAt(runEnd) === fc) runEnd += 1;
				if (runEnd - k >= 3) {
					let close = -1;
					let scan = runEnd;
					while (scan < text.length) {
						// **同时找 LF 与 CR**：纯 CR 文本里 `indexOf("\n")` 恒为 -1，
						// 会让围栏一路吃到文本末尾（真实调用随之丢失）。
						const nlLf = text.indexOf("\n", scan);
						const nlCr = text.indexOf("\r", scan);
						const nl = nlLf < 0 ? nlCr : (nlCr < 0 ? nlLf : Math.min(nlLf, nlCr));
						if (nl < 0) break;
						let q = nl + 1;
						while (q < text.length && (text.charCodeAt(q) === 32 || text.charCodeAt(q) === 9)) q += 1;
						if (text.charCodeAt(q) === fc) {
							let r = q;
							while (r < text.length && text.charCodeAt(r) === fc) r += 1;
							if (r - q >= 3) { close = r; break; }
						}
						scan = nl + 1;
					}
					const fenceEnd = close < 0 ? text.length : close;
					ranges.push([i, fenceEnd]);
					i = fenceEnd;
					continue;
				}
			}
		}
		// 行内代码：同一行内成对的等长反引号串
		if (ch === 96) {
			let runEnd = i;
			while (runEnd < text.length && text.charCodeAt(runEnd) === 96) runEnd += 1;
			const runLength = runEnd - i;
			let j = runEnd;
			let closedAt = -1;
			while (j < text.length) {
				const c = text.charCodeAt(j);
				if (c === 10) break;
				if (c === 96) {
					let closeEnd = j;
					while (closeEnd < text.length && text.charCodeAt(closeEnd) === 96) closeEnd += 1;
					if (closeEnd - j === runLength) { closedAt = closeEnd; break; }
					j = closeEnd;
					continue;
				}
				j += 1;
			}
			if (closedAt > 0) {
				ranges.push([i, closedAt]);
				i = closedAt;
				continue;
			}
			// **安全优先**：同一行内没找到闭合时，继续向后找（允许跨行）。
			// Markdown 规范不允许行内代码跨行，但模型实际会写出跨行的反引号对
			// 来包裹多行示例；若按规范不认，那段示例就会被当成真实调用执行。
			// 宁可少恢复一次，也不执行示例中的（可能是危险的）命令。
			{
				let k2 = i + runLength;
				let found = -1;
				let scanned = 0;
				while (k2 < text.length && scanned < MAX_MULTILINE_INLINE_SCAN) {
					if (text.charCodeAt(k2) === 96) {
						let ce = k2;
						while (ce < text.length && text.charCodeAt(ce) === 96) ce += 1;
						if (ce - k2 === runLength) { found = ce; break; }
						k2 = ce;
						continue;
					}
					k2 += 1;
					scanned += 1;
				}
				if (found > 0) {
					ranges.push([i, found]);
					i = found;
					continue;
				}
			}
			i = runEnd;
			continue;
		}
		i += 1;
	}
	return ranges;
}

/**
 * 判断 `offset` 是否落在展示区区间内（二分查找，O(log n)）。
 * @param ranges - computeDisplayRanges 的结果（升序、互不重叠）。
 * @param offset - 待判定位置。
 */
function isInRanges(ranges, offset) {
	let lo = 0;
	let hi = ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const [s, e] = ranges[mid];
		if (offset < s) hi = mid - 1;
		else if (offset >= e) lo = mid + 1;
		else return true;
	}
	return false;
}

/**
 * 从一段文本中提取全部文本格式工具调用，并返回剥离标记后的文本。
 *
 * 两遍扫描：
 *  1. 先处理带 `<tool_call>` 外层包裹的块（Qwen 风格与部分 Anthropic 风格）；
 *  2. 再处理**没有外层包裹**的裸露 `<function name=…>` / `<invoke name=…>`
 *     形态（Anthropic 官方工具调用格式就是这种，不带 tool_call 包裹）。
 *
 * 安全约束：位于 Markdown 代码块/行内代码里的标记**一律不恢复**（那是展示，
 * 不是调用）——避免模型讲解格式时把示例当成真命令执行。
 *
 * @param text - text/reasoning 块的完整文本。
 * @param declared - 本次请求声明的工具表。
 */
function extractCalls(text, declared) {
	if (typeof text !== "string") return { calls: [], stripped: "" };
	// 病态输入保护：超长文本不做恢复（保守方向：视为展示）。
	if (text.length > MAX_SCAN_CHARS) return { calls: [], stripped: text };
	const displayRanges = computeDisplayRanges(text);
	const calls = [];
	// **按块判定展示区，而不是整体否决**：
	//   - 块落在代码围栏 / 行内代码内  → 视为示例，保留原文不恢复（安全）
	//   - 块在普通正文中            → 正常恢复（即使参数值里含反引号）
	//
	// 早期实现有两个极端，都实测出过问题：
	//   (1) 「整段文本有行内代码就整体不恢复」→ 参数里含 `word` 的正常调用被整条丢弃；
	//   (2) 「按展示区切段再分别处理」→ 参数里的反引号把调用切成两半，同样恢复失败。
	// 现在改为：整段扫描，但**用块自身的起始偏移**判断它是否在展示区。
	// **手工配对扫描**：不能用一次性正则 replace，因为「行内代码里的 `<tool_call>`」
	// 会与「后面真实调用的 `</tool_call>`」被配对成一个跨越两者的块，
	// 导致真实调用被当作展示区内容一起丢弃（真实数据中已观测到该形态）。
	// 因此逐个开标记扫描：若开标记在展示区内，**跳过它**继续找下一个。
	let stripped = "";
	{
		let cursor = 0;
		while (cursor < text.length) {
			const openAt = text.indexOf(OPEN_CALL, cursor);
			if (openAt < 0) { stripped += text.slice(cursor); break; }
			stripped += text.slice(cursor, openAt);
			const openEnd = openAt + OPEN_CALL.length;
			// 开标记本身在展示区 -> 保留原文，继续从这个开标记之后找下一个。
			if (isInRanges(displayRanges, openAt)) {
				stripped += text.slice(openAt, openEnd);
				cursor = openEnd;
				continue;
			}
			const closeAt = text.indexOf(CLOSE_CALL, openEnd);
			if (closeAt < 0) {
				stripped += text.slice(openAt);
				break;
			}
			const closeEnd = closeAt + CLOSE_CALL.length;
			const body = text.slice(openEnd, closeAt);
			const call = parseCallBody(body, declared);
			if (call === null) {
				stripped += text.slice(openAt, closeEnd);
			} else {
				calls.push(call);
			}
			cursor = closeEnd;
		}
	}
	// 裸露的 function/invoke 元素：同样按各自出现位置判定展示区。
	for (const baseRe of [FUNCTION_NAME_ATTR_RE, INVOKE_NAME_ATTR_RE]) {
		const flags = baseRe.flags.includes("g") ? baseRe.flags : baseRe.flags + "g";
		const re = new RegExp(baseRe.source, flags);
		let result = "";
		let lastIdx = 0;
		let m;
		re.lastIndex = 0;
		while ((m = re.exec(stripped)) !== null) {
			const whole = m[0];
			// 裸露元素必然整体出现在剥离后的文本里；用原文中最先出现的位置做展示区判定。
			const probe = text.indexOf(whole);
			const inDisplay = probe >= 0 && isInRanges(displayRanges, probe);
			if (inDisplay) continue;
			const call = parseCallBody(whole, declared);
			if (call === null) continue;
			calls.push(call);
			result += stripped.slice(lastIdx, m.index);
			lastIdx = m.index + whole.length;
		}
		if (lastIdx > 0) stripped = result + stripped.slice(lastIdx);
	}
	// **整段 JSON 工具调用兜底**：文本块本身就是合法 JSON 工具调用时（无任何 XML 标签），
	// 上面的两遍扫描都碰不到，这里补一次。
	// 严格条件（安全）：
	//   1. 整段（去空白后）必须以 { 开头、以 } 结尾
	//   2. 必须有明确的工具名键（name / tool / function）且在声明列表内
	//   3. 必须有参数容器键（arguments / input / parameters / args）
	// 这三条共同保证：不会把正文里「看起来像参数对象」的 JSON 片段误当调用
	// （真实事故：汇报文本末尾的 {"command":"rm -rf /"} 曾被当成真调用执行）。
	if (calls.length === 0) {
		const t = stripped.trim();
		if (t.startsWith("{") && t.endsWith("}")) {
			const call = parseCallBody(t, declared);
			if (call !== null) {
				calls.push(call);
				stripped = "";
			}
		}
	}
	return { calls, stripped };
}

/**
 * 为 EMPTY_RESPONSE 消息生成「真实块类型」描述。
 *
 * **为什么要如实描述**：消息是维护者定位问题的第一手信息。旧实现写死
 * `only reasoning blocks`，即使实际块类型是 text（或内容为空）也照样这么说，
 * 会把排查方向带偏。
 *
 * 输出形式：
 *   - 无块            → "no blocks"
 *   - 单一类型        → "only text blocks"
 *   - 多种类型        → "reasoning, text blocks"
 *   - 全部内容为空    → 追加 ", all empty"
 * 只列**类型与空否**，不含块内容（避免把用户数据写进错误消息）。
 * @param held - 每个元素形如 { start, deltas, end }。
 */
function describeBlocksForMessage(held) {
	if (!Array.isArray(held) || held.length === 0) return "no blocks";
	const types = [];
	let emptyCount = 0;
	for (const b of held) {
		const t = b?.end?.block?.type ?? b?.start?.blockType;
		if (typeof t === "string" && !types.includes(t)) types.push(t);
		const text = b?.end?.block?.text;
		if (typeof text === "string" && text.trim() === "") emptyCount += 1;
	}
	if (types.length === 0) return "no blocks";
	const base = types.length === 1 ? `only ${types[0]} blocks` : `${types.join(", ")} blocks`;
	if (emptyCount === held.length) return base + ", all empty";
	return base;
}

/**
 * 把 replay 信封补上与合成 tool-call 块对齐的条目，避免装配器因块数不匹配
 * 而丢弃整条 replay 元数据（丢弃后仍能降级发送，但会产生告警噪声）。
 */
function patchReplayState(replayState, count) {
	if (replayState === undefined || replayState === null || typeof replayState !== "object") return {};
	if (!Array.isArray(replayState.blocks)) return {};
	const response = replayState.response && typeof replayState.response === "object"
		? { ...replayState.response, stopReason: "toolUse" }
		: replayState.response;
	const blocks = [...replayState.blocks];
	for (let i = 0; i < count; i += 1) blocks.push({ type: "tool-call" });
	return { replayState: { ...replayState, response, blocks } };
}

/**
 * 每个模型的“连续无可执行内容”计数。
 *
 * 用途：区分**间歇性失败**（重试可自愈，如 step-5-preview）与**确定性失败**
 * （模型固定行为，重试纯浪费 token，如某些上游每次只回思考块）。
 * 计数 > 1 时不再改写为可重试错误，直接原样放行。
 *
 * 只保留最近若干个模型的计数，避免长跑进程里无界增长。
 */
const emptyResponseStreak = new Map();
const MAX_TRACKED_MODELS = 64;

/**
 * 记录一次“无可执行内容”，并返回累计次数。
 * @param key - 模型标识。
 */
function bumpEmptyStreak(key) {
	const next = (emptyResponseStreak.get(key) ?? 0) + 1;
	emptyResponseStreak.delete(key);
	emptyResponseStreak.set(key, next);
	if (emptyResponseStreak.size > MAX_TRACKED_MODELS) {
		const oldest = emptyResponseStreak.keys().next().value;
		if (oldest !== undefined) emptyResponseStreak.delete(oldest);
	}
	return next;
}

/**
 * 包装一条模型流：恢复文本格式工具调用；对“无可执行内容”的 stop 响应改写为
 * 可重试的 EMPTY_RESPONSE（仅首次；连续出现则原样放行，避免确定性失败空转）。
 *
 * 实现说明：text/reasoning 的 block-end 会被扣留到流末尾，以便在需要时重写
 * 块文本（剥离已恢复的标记）。扣留只延迟“块定稿”时刻，增量 delta 仍实时
 * 下发，UI 的流式显示不受影响。
 *
 * @param options - 本次模型请求（用于读取声明的 tools 与 model 名）。
 * @param source - 下游（适配器）产生的原始 chunk 流。
 * @returns 包装后的 chunk 流。
 */
function wrapStream(options, source) {
	// 防御：tools 不是数组时按“无工具”处理（直通），绝不在接缝里抛异常——
	// 接缝里抛出的异常会中断整条模型流，代价远大于少做一次恢复。
	const toolList = Array.isArray(options?.tools) ? options.tools : [];
	const declared = new Map();
	for (const tool of toolList) {
		// 同时兼容 {name} 与 {function:{name}} 两种声明形状。
		const name = typeof tool?.name === "string" ? tool.name : typeof tool?.function?.name === "string" ? tool.function.name : undefined;
		if (name !== undefined) declared.set(name, tool);
	}
// **为什么 tools 为空时整体直通**（这是正确设计，不是缺陷）：
//
// DSH 有两类**不带工具**的内部请求：
//   - compaction（压缩上下文）：模型只返回摘要，本来就没有「可执行内容」；
//   - session-title（生成会话标题）：只需一行短标题，不需要工具。
// 这两类请求里「没有 tool-call 块」是**正常的**，不应触发 EMPTY_RESPONSE 重试
// —— 否则每次压缩/起标题都会白白重试，浪费 token 且拖慢响应。
//
// 因此 tools 为空时完全直通是**有意为之**。
// （曾在 R51 尝试改为「恢复跳过但安全网生效」，被集成测试用例 5 拦下 —— 正确。）
if (declared.size === 0) return source;
	const modelKey = `${safeString(options?.provider)}/${safeString(options?.model)}`;
	return (async function* recovered() {
		// 扣留的“可恢复块”：整个块（start + deltas + end）都暂存，以便在流末尾
		// 按「原块 → 其恢复出的调用 → 下一原块」的正确顺序重排索引。
		//
		// 为什么必须扣留整个块：BlockAssembler 按 block-start **首次出现顺序**
		// 排列最终块。若只扣留 block-end，原块的 block-start 已带旧索引发出，
		// 合成的调用只能排在所有原块之后，导致「前一个块里的调用」排到
		// 「后一个块里的调用」后面，破坏模型的真实意图顺序。
		//
		// **必须按 index 跟踪多个并发打开的块**：真实适配器会先发若干个
		// block-start，再交错发各块的 delta，最后才逐个发 block-end（实测
		// 真实会话流就是 0(reasoning) → 1(text) → delta(0)… → delta(1)…
		// → end(0) → end(1)）。若按“单块连续”假设处理，块会被错配成空块，
		// 正常回复会被误判为“无可执行内容”。
		const heldBlocks = [];             // 按 block-start 出现顺序的块表
		const openByIndex = new Map();     // index -> 块对象（已 start 未 end）
		let heldUsage;
		let sawToolCall = false;
		let finishChunk;
		// 一旦扣留了任何可恢复块，后续块一律扣留，到流末尾统一发出，
		// 保证最终顺序完全由我们决定。
		let holding = false;
		/** 按 block-start 出现顺序发出所有已扣留块（原始索引，直通路径）。 */
		const flushHeld = function* () {
			for (const b of heldBlocks) {
				yield b.start;
				for (const d of b.deltas) yield d;
				if (b.end !== undefined) yield b.end;
			}
		};
		/**
		 * 把 delta 归到它所属的扣留块；找不到所属块时原样透传。
		 *
		 * **缺陷 123**（第 123 轮）：`text-delta` / `reasoning-delta` / `tool-call-delta`
		 * 三个 case 原本各自重复了这段 3 行逻辑（`code-quality` 的重复块检测
		 * 恰好报了 3 处，卡在阈值边界上）。提取为生成器后重复消失。
		 *
		 * 返回「是否已消费该 chunk」由调用方决定是否 `yield`——这里用生成器
		 * 表达「要么产出 chunk（透传），要么不产出（已归入块）」。
		 */
		const absorbDelta = function* (chunk) {
			const block = openByIndex.get(chunk.index);
			if (block !== undefined) block.deltas.push(chunk);
			else yield chunk;
		};
		/** 收尾：回放 usage（若有）后发 finish 并结束流。 */
		const finishWith = function* (fin) {
			if (heldUsage !== undefined) yield heldUsage;
			yield fin;
		};
		try {
			for await (const chunk of source) {
			// **健壮性**：chunk 来自上游（宿主适配器或其他插件），理论上一定是对象，
			// 但在 llm/stream 接缝里 null/undefined 会让 switch 抛异常并**中断整条流**。
			// 这类畸形 chunk 直接原样透传（不参与恢复判定），由下游消费者自行处理。
			if (chunk === null || typeof chunk !== "object") {
				yield chunk;
				continue;
			}
			switch (chunk.type) {
				case "block-start": {
					if (holding || chunk.blockType === "text" || chunk.blockType === "reasoning") {
						holding = true;
						const block = { start: chunk, deltas: [], end: undefined };
						heldBlocks.push(block);
						openByIndex.set(chunk.index, block);
					} else {
						yield chunk;
					}
					break;
				}
				case "text-delta":
				case "reasoning-delta": {
					yield* absorbDelta(chunk);
					break;
				}
				case "tool-call-delta": {
					sawToolCall = true;
					yield* absorbDelta(chunk);
					break;
				}
				case "block-end": {
					const block = openByIndex.get(chunk.index);
					if (block !== undefined) {
						block.end = chunk;
						openByIndex.delete(chunk.index);
					} else {
						yield chunk;
					}
					break;
				}
				case "usage":
					// usage 也扣留：正常协议顺序是 block-end → usage → finish。
					heldUsage = chunk;
					break;
				case "finish":
					finishChunk = chunk;
					break;
				default:
					yield chunk;
			}
			if (finishChunk !== undefined) break;
		}
		} catch (streamError) {
			// **流中途异常（网络断开 / 上游取消 / 适配器崩溃）**：
			// 已扣留的块必须尽力交出，否则用户在网络抖动时**连已经收到的文字都看不到**。
			// 交出后原样抛出异常 —— 不吞掉、不包装成"空响应"，由上层按既有规则处理。
			yield* flushHeld();
			if (heldUsage !== undefined) yield heldUsage;
			throw streamError;
		}
		// 流在没有 finish 的情况下结束（中止或协议违规）：交出扣留的块，
		// 由上游按既有规则处理，不改变任何语义。
		if (finishChunk === undefined) {
			yield* flushHeld();
			if (heldUsage !== undefined) yield heldUsage;
			return;
		}
		// 模型已经使用了结构化 tool_calls，或响应以非 stop 结束
		// （max-tokens / error / aborted）：原样放行。
		// 防御：reason 缺失/形状异常时按“非 stop”处理（原样放行），绝不改写。
		if (sawToolCall || finishChunk.reason?.kind !== "stop") {
			yield* flushHeld();
			yield* finishWith(finishChunk);
			return;
		}
		// 尝试从 text/reasoning 块恢复文本格式工具调用（Qwen 与 Anthropic 风格）。
		//
		// **顺序关键**：BlockAssembler 按 block-start 首次出现的顺序排列最终块。
		// 因为上面把整个块都扣留了，这里可以**重新编号**：原块占偶数位
		// （0,2,4…）、它的恢复调用占紧随其后的奇数位，从而让每个调用都紧跟
		// 它的来源块——模型的意图顺序因此被完整保留。
		//
		// **缺陷 113（第 114 轮发现，第 115 轮加固）**：这一段恢复逻辑原本
		// **在流异常的 catch 之外**。`extractCalls` / `parseCallBody` / `coerceValue`
		// 内部有类型防护（`typeof text !== "string"`、`MAX_SCAN_CHARS` 上限），
		// 实测 8 类异常形状都不抛 —— 但那是「当前实现恰好正确」，不是结构保证。
		// 万一将来某个改动让它们抛出未预料的异常，异常会冒泡出 `llm/stream`
		// 接缝，**中断整条流**，用户连已收到的正文都看不到。
		//
		// 因此这里再包一层「尽力而为」兜底：恢复过程**任何**异常都不得中断流——
		// 一旦出错就退回「原样交出已扣留的块」，行为与「无可恢复调用」一致。
		// 这个兜底**不会掩盖**正常路径的 bug（那些仍有 101 层测试覆盖），
		// 它只保证「即使恢复逻辑坏了，用户也不会失去已有内容」。
		const recoveredCalls = [];
		const blocksWithCalls = [];
		try {
			for (const b of heldBlocks) {
				const { calls, stripped } = extractCalls(b.end?.block?.text ?? "", declared);
				if (calls.length === 0) {
					blocksWithCalls.push({ block: b, calls: [] });
					continue;
				}
			const cleaned = stripped.trim() === "" ? "" : stripped;
			// **一致性关键**：deltas 必须与剥离后的 block-end 内容一致。
			// 宿主装配以 block-end 为准，但**流式消费者读取的是 deltas**：
			// 若 deltas 仍含原始标记，用户在流式输出时会看到
			// `<tool_call><function=...>` 这类 XML 闪过（真实体验问题）。
			// 因此把 deltas 按剥离后的文本重新承载：
			//   - 原块无 delta → 保持无
			//   - 否则用单个 delta 承载完整剥离文本（分片边界对下游无意义）
			const cleanedDeltas = b.deltas.length === 0
				? []
				: [{ ...b.deltas[0], text: cleaned }];
			blocksWithCalls.push({
				block: { start: b.start, deltas: cleanedDeltas, end: { ...b.end, block: { ...b.end.block, text: cleaned } } },
				calls
			});
			for (const call of calls) recoveredCalls.push(call);
			}
		} catch (recoveryError) {
			// **缺陷 113 兜底**：恢复过程本身出错时，绝不中断流。
			// 退回「原样交出已扣留的块」，让下游按既有规则处理 —— 与
			// 「无可恢复调用」完全一致。恢复出来的东西本来只是**增强**，
			// 增强失败不应该让用户失去已经收到的内容。
			recoveredCalls.length = 0;
			blocksWithCalls.length = 0;
		}
		// 无调用可恢复：原样交出所有块，让后续安全网按原逻辑判断。
		if (recoveredCalls.length === 0) {
			yield* flushHeld();
		} else {
			let cursor = 0;
			let ordinal = 0;
			for (const { block, calls } of blocksWithCalls) {
				const blockIndex = cursor;
				cursor += 1;
				yield { ...block.start, index: blockIndex };
				for (const d of block.deltas) yield { ...d, index: blockIndex };
				yield { ...block.end, index: blockIndex };
				for (const call of calls) {
					const index = cursor;
					cursor += 1;
					const id = `txtcall-${hashString(`${safeString(call.name)}:${safeString(call.arguments, "{}")}`)}-${ordinal}`;
					ordinal += 1;
					const argumentsJson = JSON.stringify(call.arguments);
					yield { type: "block-start", index, blockType: "tool-call" };
					yield { type: "tool-call-delta", index, id, name: call.name, argumentsDelta: argumentsJson };
					yield { type: "block-end", index, block: { type: "tool-call", id, name: call.name, arguments: argumentsJson } };
				}
			}
			if (heldUsage !== undefined) yield heldUsage;
			// **缺陷 101**：恢复成功也必须**清空该模型的连续空响应计数**。
			// 之前只在「有可见正文」分支（下面 L947 附近）清零，于是出现这种
			// 序列时计数会残留：空响应（streak=1）→ 恢复成功（无正文，未清零）
			// → 再空响应（streak=2 → 被当成“确定性失败”原样透传，**不重试**）。
			// 恢复出可执行工具调用显然是**成功**，理应重置计数。
			emptyResponseStreak.delete(modelKey);
			yield { type: "finish", reason: { kind: "tool-calls" }, ...patchReplayState(finishChunk.replayState, recoveredCalls.length) };
			return;
		}
		// 安全网：没有任何可执行内容。**只含工具调用标记（完整但不可解析、
		// 或被截断、或裸 parameter 元素）的文本不算“可见文本”**：这类响应
		// 必须触发重试，而不是让回合静默结束。
		// 安全网：没有任何可执行内容。**只含工具调用标记（完整但不可解析、
		// 或被截断、或裸 parameter 元素）的文本不算"可见文本"**：这类响应
		// 必须触发重试，而不是让回合静默结束。
		//
		// **健壮性**：宿主的 block.text 理论上一定是字符串，但插件跑在
		// llm/stream 接缝上，任何未预期的形状（undefined / null / 数字 /
		// 对象）都会让这里 .trim() 抛异常 —— 在接缝里抛异常会**中断整条
		// 模型流**，代价远大于少做一次恢复判定。因此先做类型收窄。
		const hasVisibleText = blocksWithCalls.some(({ block }) => {
			if (block.end?.block?.type !== "text") return false;
			const rawText = block.end.block.text;
			if (typeof rawText !== "string") return false;   // 形状异常：按“无可见文本”处理
			if (rawText.trim() === "") return false;
			if (isMarkupOnlyText(rawText)) return false;
			return true;
		});
		if (!hasVisibleText) {
			// 确定性失败保护：如果这个模型**上一次**也是"无可执行内容"，
			// 说明是模型的固定行为（而非间歇抖动），继续重试只会白烧 token。
			// 此时不再改写为可重试错误，而是原样放行 finish，让 harness 按
			// 原有语义处理（宁可静默结束，也不空转 5 次）。
			const streak = bumpEmptyStreak(modelKey);
			if (streak > 1) {
				yield* finishWith(finishChunk);
				return;
			}
			// 首次出现：改写为终态 error，让默认重试策略重试一次（间歇性失败可自愈）。
			// 不回放原 usage（该响应会被重试）。
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						message: `model "${safeString(options?.model)}" returned a completed response with no executable content (blocks: ${describeBlocksForMessage(heldBlocks)})`,
						code: "EMPTY_RESPONSE"
					}
				}
			};
			return;
		}
		// 有可见正文：清零该模型的连续空响应计数。
		emptyResponseStreak.delete(modelKey);
		yield* finishWith(finishChunk);
	})();
}

/**
 * Cordis 插件入口：在 llm/stream 瀑布流上挂接恢复逻辑。
 * @param ctx - 拥有该监听的插件上下文。
 */
function apply(ctx) {
	if (process.env.DSH_TEXT_TOOL_CALL_RECOVERY === "0") return;
	ctx.on("llm/stream", (options, next) => wrapStream(options, next()));
}

/**
 * 清空“连续空响应”计数（仅供测试使用；生产无需调用）。
 */
function resetStreaks() {
	emptyResponseStreak.clear();
}

export { apply, name, resetStreaks, VERSION };
