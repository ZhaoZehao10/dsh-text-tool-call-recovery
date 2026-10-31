# Discussion 帖子材料

<!-- ============================================================
   ⚠️ 提交时请只复制「### 标题」和「### 正文」两节的内容。
   本文件开头的说明、以及下面的分隔线，都不要贴进 GitHub 帖子。
   ============================================================ -->

> **内部说明（不要贴进帖子）**
> - 提交地址：https://github.com/deepseek-ai/deepseek-harness/discussions
> - 分类选 **General**（该仓库 Issues/PR 均已关闭，只能发 Discussion）
> - 已按 CONTRIBUTING 要求走 Discussion 路径
> - 提交前最后确认一遍脱敏（正文中的路径/项目名已处理）

---

## 中文版（推荐提交，团队中文友好）

### 标题

[Bug 报告] 工具调用被模型写成 XML 文本时回合被静默丢弃——step-5-preview 与网关路由两个真实案例，附插件级修复（三版本复现）

### 正文

> 建议分类：General（agent 可靠性）
> 环境：DeepSeek Harness 0.2.0-rc.2 / 0.2.1-rc.1 / 0.2.1-rc.2 / 0.2.1-rc.3（四版本均实测，win32 x64）
> 严重级别：major（静默失败：无错误、无重试、无诊断，agent 类应用直接表现为"卡死/任务截断"）

**现象**：两类真实场景下，agent 会出现"思考一会儿然后什么都不发生"/"任务被截断"——

- **场景 A（StepFun step-5-preview，provider `step-plan-152`，`/step_plan/v1`）**：模型间歇性不返回结构化 `tool_calls`，而是把工具调用写成 Qwen/Hermes 风格 XML 文本塞进 `reasoning_content`（`tool_call` 标记 + `function=工具名` + 每参数一个 `parameter=键` 元素）。
- **场景 B（聚合网关路由的 `deepseek-v4.1-flash-max`）**：主账号被 429 限流后路由 fallback 到某上游，该上游返回 **Anthropic 风格 XML 文本**工具调用（`parameter name=键` 带 name 属性），且**常被截断**（实测样本以不完整的闭合标签结尾）。

**共同的根因链**（三层，均已在会话日志中实证；行号以 0.2.0-rc.2 为准，最新版行号见下方跨版本对照表）：

1. 模型把工具调用写成 XML **文本**而非结构化 `tool_calls`；
2. pi-ai 的 `openai-completions` 解析器（`@earendil-works/pi-ai` `dist/api/openai-completions.js`）只把 `delta.tool_calls` 映射为 toolCall 块，文本原样进 text/thinking 块；
3. `dsh-agent-loop` `lib/index.js:1152-1153`：

   ```js
   const toolCalls = message.content.filter((block) => block.type === "tool-call");
   if (toolCalls.length === 0) return { kind: "completed" };
   ```

   没有 tool-call 块 → 回合**静默结束**：不报错、不重试、不执行任何工具。

次要缺口：`dsh-llm-pi-ai` 的 `mapStopReason` 只把“零内容块”映射为 `EMPTY_RESPONSE`；“只有思考块”或“只剩工具调用标记”会作为普通 `stop` 放行。

**这不是个案，是通用可靠性缺口**：任何经网关/vLLM/Ollama/new-api 转发的 Qwen/Hermes 系模型、任何 Anthropic 风格代理端点，都会命中同一条链路。

**已排除的替代解释（61 次受控实验）**：用完全相同的请求形状直连 API 做了 61 次对照——无/有 `tool_choice`、流式/非流式、真实 40 工具负载、`step_plan` 端点 vs 标准端点、以及对失败请求上下文的**忠实重放（419,843 token，与真实请求差 0.04%，连续 7 次全部正常）**。结论：请求形状、参数、端点、**上下文长度均不触发**；失败是逐请求的模型/上游行为。

**跨版本对照：升级到 0.2.1-rc.1 与 0.2.1-rc.2 后仍未修复（源码级实证）**

> **版本识别方法**：看 `DeepSeek Harness.exe` 文件属性里的"文件版本"
> （当前实测 `0.2.1-rc.2`），或 `resources/app.asar` 内 `@deepseek-ai/dsh-llm`
> 的包版本。安装目录下的 `version` 文件是**安装器版本**（实测 `44.7.0`），
> 与应用版本不同，不要用它对应版本。
>
> 三个被测版本：`0.2.0-rc.2`、`0.2.1-rc.1`（当时安装器版本显示 44.7.0）、
> `0.2.1-rc.2`。

我们随后把 DSH 从 0.2.0-rc.2 一路升级到 0.2.1-rc.1 和 0.2.1-rc.2，
逐行核对了三处关键逻辑——**全部原样未动**：

| 检查点 | 0.2.0-rc.2 | 0.2.1-rc.1 | 0.2.1-rc.2 | 结论 |
|---|---|---|---|---|
| `@earendil-works/pi-ai` 版本 | 0.87.1 | 1.1.0 | 1.1.0 | 未再变 |
| `dsh-llm` 版本 | 0.2.0-rc.2 | 0.2.1-rc.1 | **0.2.1-rc.2** | 小版本递增 |
| 解析器是否识别文本工具调用 | 只认 `delta.tool_calls` | 仍只认（`openai-completions.js:426-427`） | 仍只认（`:425-426`） | 未修 |
| agent loop 静默结束判定 | `lib/index.js:1152-1153` | `lib/index.js:1164-1165` | `lib/index.js:1163-1164`，逻辑一字不差 | 未修 |
| 适配器 EMPTY_RESPONSE 触发条件 | 仅 `content.length === 0` | 仍仅（`dsh-llm-pi-ai` 的 EMPTY_RESPONSE 判定） | 仍仅 | 未修 |

也就是说：**这个问题跨越三个版本、两个 pi-ai 大版本均稳定复现**，不是某个版本的回归，也还没被修复。

**在新版本上的完整复现验证**：插件的 155 项集成断言与复刻样本验证，已分别在 0.2.0-rc.2（pi-ai 0.87.1）、0.2.1-rc.1（pi-ai 1.1.0）和 0.2.1-rc.2 三套真实 `BlockAssembler` 源码下跑通，结果一致——行为与版本无关。

**建议的修复方向**（给维护者参考，两份改动都不大）：

1. **pi-ai 解析器层**：流结束后把 text/thinking 块中的文本工具调用标记提升为一等 `toolCall` 块并置 `stopReason = "toolUse"`。建议按现有 `detectCompat`/`model.compat` 模式加 per-model 开关（如 `supportsTextToolCalls`，默认关）。需要覆盖的格式：Qwen 风格（`parameter=键`）、Anthropic 风格（`parameter name=键`）、JSON 形式（`{"name":..,"arguments":{..}}`）。
2. **agent loop / 适配器层**：把“终止 `stop` 且无可执行内容”（无 tool-call 块且无非空白 text；只有思考、或只剩完整但不可解析/被截断/裸 `parameter` 元素的工具调用标记）映射为可重试的 `EMPTY_RESPONSE`，而不是 `{ kind: "completed" }`。

**插件级修复（已生产验证，可直接用）**：我按官方建议的生态路径做了一个 profile 级插件 `@zhaozehao10/dsh-text-tool-call-recovery`，通过官方 `llm/stream` 瀑布流实现上述两层语义，不改 `app.asar`、应用升级不丢失。含 155 项集成断言（跑在**真实 `BlockAssembler`** 和复刻的真实流不变式规则上，样本复刻自上述两个真实案例）、两个最小复现脚本、61 次实验的重放脚本。源码与安装脚本：https://github.com/ZhaoZehao10/dsh-text-tool-call-recovery。

它的测试用例可以直接当作上游修复的验收标准。

**发布前我做了100层对抗性测试**：155 项集成断言 + 28 项语义属性测试 + 24 项边界穷举（跑在宿主真实的流不变式校验器 `dsh-llm/lib/types/assistant-stream.js`（`AssistantStreamAccumulator.push` / `assembleAssistantStream`） 上）+ **3000 条随机流模糊测试** + **708 轮多轮会话模糊** + **15 项等价性验证**（恢复出的调用经真实 `BlockAssembler` 装配后与原生结构化调用逐字段等价）+ **60+ 项 ReDoS 性能测试** + **14,408 条真实会话流重放**（用真实日志的 chunk 序列逐条回放，验证零破坏、零误伤）+ **46 个变异体的变异测试**（往源码里植入典型 bug，检验测试能否抓到，覆盖率 100%）+ **3,000 条差分测试**（插件输出同时走宿主的实时装配路径与持久化回放路径，两条路径结果必须完全一致）+ **23 种 provider/model 分组重放**（14,408 条真实流，确认对每个真实上游都表现正常）+ **14,408 条真实流逐条体检**（每条跑插件 → 校验流不变式 → 实时装配 → 持久化回放装配 → 两路径比对，零失败 / 零拒绝 / 全一致）+ **63 项异常值与退出路径验证**（上游抛非 Error 值必须原样透传、generator return/throw 协议、finally 清理）+ **24 项多轮对话验证**（用 Proxy 确认插件不读 `messages`、历史含文本调用不干扰当前轮、连续 10 轮都正确恢复）+ **性能基线**（典型回复 0.018ms、20KB 回复 0.074ms、吞吐 151 万 chunk/s、插件开销 +0.019ms、内存 10 字节/次，且每 KB 成本随规模下降，确认无 O(n²)）+ **直接调用宿主自己的断言**（`AssistantStreamAccumulator.push` / `assembleAssistantStream` 里的 `TypeError` 校验）验证插件输出，8 种输出走完 7 步校验链全过 + **58 项文本保真度不变量**（剥离后文本 == 原文去掉调用，一字不差；无法解析的标记原样保留；无调用时逐字节不变）+ **超时与背压实测**（首 chunk 延迟 0.017ms、10 万 chunk 99ms、20MB 流过峰值堆只增 2.37MB、病态输入全部毫秒级）+ **30 项端到端链路演练**（模型文本流 → 恢复 → 宿主真实导出的消费者，验证工具调用真的能被上层取到且参数可直接执行）+ **22 个生产合成调用逐个溯源**（工具名 / 参数键 / 参数值均能在源文本里找到，22/22 全部可溯源，证明没有凭空生成或参数篡改）+ **13,491 条真实日志的 replayState 值域核对**（确认插件写入的 stopReason 与宿主实际使用的值域一致：toolUse / stop / undefined）+ **V8 函数覆盖率检查**（22/22 = 100%，确保没有从未被测试执行的代码），揪出并修掉了插件自身的 **167 个**缺陷。其中几个值得上游特别注意：

- **安全相关**：模型讲解格式时把调用标记放进 Markdown 代码块（三重反引号围栏），示例会被当成真调用**执行**（例如文档里展示 `rm -rf` 就真的执行）——现在含代码围栏的文本一律视为“展示”，不恢复。
- **解析盲区**：Anthropic 官方的 `<antml:function name=…>` / `<invoke name=…>` 形态（无 `<tool_call>` 包裹）此前完全解析不出来，现已支持。
- **确定性失败空转**：若某模型**固定**只返回思考块（实测某聚合模型每次如此），安全网会把它每次都改成可重试错误 → 连续 5 次重试全部失败，白烧 5 次调用且用户仍无输出。现已按模型记录连续次数：仅首次重试，连续出现则原样放行。
- **ReDoS 性能**：病态输入（数万个重复未闭合标记）会让恢复正则灾难性回溯，实测 20 万字符耗时 **9 秒**——插件在 `llm/stream` 接缝上等于卡死整条流。现已加上限（128K）+ 围栏检测改线性扫描 + 标签统计改累加。
- **交错块形态（最危险）**：真实适配器会**先发所有 `block-start`、再交错发各块 delta、最后逐个 `block-end`**，而不是“每块连续”。若实现按“块连续”假设解析，块内容会被错配成空块，导致**有大量正文的正常回复被判成“无可执行内容”**——我们用它重放 14,408 条真实会话流时，实测误伤了 **254 条**正常回复。已改为按 `index` 跟踪多个并发打开的块。
- **参数值里的反引号导致整条调用被丢弃**：参数值里出现**合法反引号**（Python 代码、Markdown 语法、shell 命令替换 ``date``）时，旧实现「整段文本有任何行内代码就整体不恢复」，把这类调用判成展示文本、**整条不执行**——用真实日志重放实测到 **4 条**正常调用因此丢失。现改为**按标记位置判定**展示区：只有标记本身落在围栏/行内代码内才跳过。
- **跨行反引号包裹的示例会被执行（安全）**：模型常用**跨行**的反引号包住多行示例。Markdown 规范不允许行内代码跨行，旧实现照规范不认，于是那段**示例被当成真实调用执行**（可能是危险命令）。现改为跨行反引号对也纳入展示区——宁可少恢复一次，也不执行示例。
- **行内代码里的标记会吞掉后面的真实调用**：回复先写 ``<tool_call>`` 讲格式、随后给出真实调用时，正则把「行内代码里的开标记」与「真实调用的闭标记」配对成一个跨区块，**真实调用被当作展示内容一起丢弃**。现改为手工逐个开标记配对：开标记在展示区内就跳过它、继续找下一个。
- **JSON 参数的类型强转缺失**：同一个调用，模型写成 XML 时参数会按 schema 强转（`"5000"` → `5000`），写成 JSON 时**不强转**——下游工具收到的类型取决于模型用了哪种写法；另有一个 `args` 参数容器写法完全不被识别。现已让两条路径共用同一套类型强转。
- **属性位置被写死**：`<function name="pwsh" id="c1">` 或 `<function id="c1" name="pwsh">` 这类**带额外属性**的合法 XML，旧正则要求 `name` 必须是第一个属性，于是带任何额外属性的调用**完全识别不出来**。现已改为「name 出现在任意属性位置都能识别」。
- **参数值内的裸闭合标签导致静默截断执行（安全）**：`<parameter=command>rm -rf /tmp/x</parameter></parameter>` 这种已损坏的 XML，惰性正则会停在**第一个**闭合标签，得到**被截断**的参数（`"rm -rf /tmp/x"` → `"rm -rf "`）并照常执行——可能执行半截危险命令。现已检测「闭合标签后紧跟另一个闭合类标签」即判为损坏、**放弃整条恢复**。
- **类型强转改变语义**：schema 声明 `number` 时，`Number("")` 等于 0，于是「未设置该参数」被误解为「设为 0」（`timeoutMs` 变 0 立即超时）；超过 2^53 的整数（雪花 ID）会被静默丢精度（`…993` → `…992`），工具**操作错误的对象**。现已：空白字符串不强转、超大整数保持字符串。
- **正文里的裸 JSON 片段被当成工具调用执行（安全，真实事故）**：模型在汇报末尾写说明性 JSON（`...随时可以复跑。{"command":"rm -rf /"}`），旧版插件把它恢复成真实调用——**2026-10-22 03:48 真的发生过，差点执行删根命令**。现已三重收紧：整段必须以 `{` 开头、`}` 结尾 + 必须有工具名键且已声明 + 必须有参数容器键。
- **错误消息写死块类型（误导排查）**：触发空响应安全网时，消息固定写 `(only reasoning blocks)`——实际是 text 块时也说 reasoning，内容全空时也不说明。现改为按真实块类型生成（`no blocks` / `only text blocks` / `all empty`）。
- **恢复时 deltas 与 block-end 不一致**：block-end 已剥离标记，但重发的 deltas 仍是原始含标记文本——**读 deltas 的流式 UI 会看到 `<tool_call><function=...>` 闪过**，与装配器看到的内容矛盾。现已让 deltas 也按剥离后文本重发。
- **畸形 `block.text` 会让插件抛异常**：安全网里直接调 `text.trim()`，若上游给出 `undefined`/`null`/数字就崩。**在 `llm/stream` 接缝里抛异常会中断整条模型流**，代价远大于少做一次判定。现已给 9 处函数入口加类型收窄。
- **null / undefined chunk 会让插件抛异常**：主循环直接 `switch (chunk.type)`，上游给出 `null` 就崩 —— 又是中断整条流。已加类型守卫。
- **Symbol 字段会让模板拼接抛异常**：`${options.model}` 在 Symbol 上抛 `Cannot convert a Symbol value to a string`（结构化模糊 5000 条命中 83 次）。新增 `safeString()` 统一处理。
- **网络断流时用户已收到的内容全部丢失**：插件为避免乱序会扣留 text/reasoning 块，但扣留的块只在**正常结束**时交出；一抛异常就永远发不出去，用户连已经看到的文字都没了。已改为异常时先交出已扣留内容再原样抛出。
- **无法在运行时确认加载的是哪个版本**：代码里没有版本标识，只能靠文件大小/mtime 猜——**实际已发生过一次：源码 43,564B 与安装副本 43,162B 不一致却没发现**。现加 `VERSION` 常量 + 部署验证测试。- **单独 CR 行尾会让参数值带上 CR**：`trimEdgeNewlines` 只写了 `/^\r?\rn/`，漏掉单独 CR（老式 Mac 格式 / 某些训练数据），命令变成带前导 CR 而无法执行。已改为 `/(?:\r\rn|[\r\rn])/`。
- **死代码引用未定义符号**：覆盖率检查发现 `hasCodeFence` 从未被执行 —— 它是旧实现的遗留（已改用 `computeDisplayRanges`），且内部调用的 `isInsideDisplayRegion` **根本没有定义**，一旦被调用就是 ReferenceError。已删除整条死代码链（`hasCodeFence` + 只被它使用的 `MARKER_TAGS`），986 → 951 行。顺带修掉 `coverage.mjs` / `branch-coverage.mjs` 互相递归运行导致超时的问题。
- **覆盖率脚本并发不安全**：两个脚本都用**仓库内固定目录**作 V8 覆盖率输出，并发运行时互相覆盖 —— 未覆盖数字从 23 跳到 **129**，还出现过假失败。已改用 `mkdtempSync` 的每次唯一目录。同时 `run-all.mjs` 静默跳过套件也改成**末尾显式列出被跳过的套件**（这个疏漏让我漏看过两轮缺陷）。
- **变异测试的 SKIP 被当作通过**：退出条件只看 `survived`、忽略 `skipped` —— 锚点失效时变异体被跳过、**该变异根本没被验证**，但套件仍返回通过，覆盖率还显示 100%。这让我**连续四轮没发现**锚点已失效。现已改为 SKIP 也失败，并同时报告两种覆盖率口径。
- **材料里的统计数字系统性过时**：自查发现 6 处不一致（`27 个变异体` 实际 46、真实流总量出现过 12,747/13,187/13,398/13,615/13,582 五个数字、`19/19` 函数覆盖率实际 22/22、门槛 ≤10 实际 ≤30、层数 57 实际 60）。现新增 `doc-consistency.mjs`：**从源码推导**权威数字再与中英文文档比对。真实流总量统一为 **14,408**。
- **模块说明不在文件顶部**：`@module` 块（讲清问题、根因、修复思路的 27 行）被后来插入的 `VERSION` / `safeString` 挤到第 39 行之后，新读者打开文件先看到工具函数、看不到「为什么存在」。已移到顶部，并新增 `code-quality.mjs` 固化（含注释密度 35.5%、JSDoc 89%、无超长函数等 24 项检查）。
- **缺少「按历史缺陷组织」的回归测试**：原有 86 层测试按「功能维度」组织（类型模糊、原型污染、性能…），当一个修复被后续改动破坏时，可能只有很**间接**的测试才会失败（甚至完全不失败）。现新增 `defect-regression.mjs`（64 项）：**每个缺陷 D1–D48 一个专属断言**，修复被破坏即失败，并且能直接定位到具体缺陷编号。
- **缺少「插件到底有多大用」的量化证据**：原有测试只验证「没破坏」，没量化「帮了多少」。新增 `effect-quantify.mjs`：在 **14,408 条真实流**上做对照实验 —— 13,802 条原生含结构化调用流**行为变化 0 条**（原样放行）、390 条纯文本流**回归 0 条**、插件实际改写 **22 条（0.15%）** 并恢复 22 个调用（其中 step-5-preview 21 个）。这组数据同时证明两件事：**插件确实在解决真实问题**，且**只在该介入时介入**。
- **安装路径上的三个打磨问题**（本轮实测才暴露）：① 脚本是 UTF-8 **无 BOM**，Windows PowerShell 按 ANSI 解码中文 → **语法错误、无法执行**；② 备份目录 `$PSScriptRoot\.tmp` 从未创建 → `Copy-Item` 抛 `DirectoryNotFoundException`，安装第 1 步就中止；③ 缺 LICENSE、README 没有给别人的安装步骤、`name` 是短名与包名不一致。均已修复，并新增 `install-experience.mjs`（33 项）在沙箱 profile 里实跑安装。
- **没有验证「别人的环境」**：前 33 轮都在同一个 profile 里测。新增 `host-compat.mjs`（51 项）覆盖环境变量（含 **Windows 上 `process.env` 大小写不敏感**这一细节）、profile 路径含空格/中文、ctx 形态差异、6 种工具声明形态、6 种标记形态、5 种 `finish.kind`，以及「源码不含平台假设」（无 `process.platform` / `__dirname` / `require` / `fetch` / node: 内置模块）。
- **缺少长时间运行验证**：DSH 是长驻进程，插件的任何「随时间增长」都会累积成故障。新增 `soak-test.mjs`（12 项）：**2 万次请求**堆只增 **0.38MB 且后半段回落到 -0.01MB**（曲线是平的，不是缓慢爬升）、性能**不退化**（后段比前段快 12%）、500 个模型轮转后堆只增 **0.02MB**、**句柄数 200→2200 次保持 1 个**、源码**零定时器**、1000 次异常后仍正常。
- **文档里的命令从没人真的跑过**：英文 README 的安装示例写作 `-ProfileDir <path>`，而 PowerShell 里 `<` 是保留运算符 —— 用户复制下来会直接报 `The '<' operator is reserved for future use.`。新增 `doc-executable.mjs`（26 项）：把文档里每个 powershell 块交给 **PowerShell 解析器**真解析、校验 YAML 结构、核对文档引用的文件/命令/`--quick`/环境变量名是否真实存在。
- **前 36 轮全部用测试替身，没在真实 Cordis 上验证过**：新增 `real-cordis.mjs`（14 项），用**真实的 @deepseek-ai/cordis 4.0.5** 装载插件 —— 真实 `ctx.on` 返回 unsubscriber（插件未依赖，符合「装好即长驻」场景）、真实 waterfall 恢复 **1 个调用**且与替身**完全一致**、同一 Context 装载两次**不叠加**、插件只访问 `ctx.on` 这一个属性。
- **材料里引用的源码路径是错的**：3 处写 `dsh-llm/lib/types/invariant.js`，但**该文件不存在** —— 真正的校验在 `assistant-stream.js`。另有 2 处引用了本地无法核实的包却写成精确行号。已改为真实路径 + 符号名，并新增 `ref-verifiable.mjs`（12 项）抽取所有源码引用并核实文件/行号/符号。
- **复现脚本没人跑过**：材料承诺「5 分钟复现」「两个最小脚本」，但从未验证。实测发现 `harness-side.mjs` 里 `$d="<workspace>\deliverables"` 的 `<workspace>` 是**未替换的占位符**；`model-side.cjs` 缺 key 时只抛一行 `set STEPFUN_API_KEY first`，没给用法也没指向替代方案。均已修复，并新增 `repro-runnable.mjs`（25 项）**真的去跑这两个脚本**并校验输出、指引、占位符、自包含性。
- **没人验证过「运行中的进程加载的是哪一版」**：插件只在**进程启动时** `apply()` 一次，之后把新文件写进 profile **不会生效**。实测本机：DSH 进程 13:45Z 启动、安装副本 01:01Z 才写入 —— 运行中的进程其实是**旧版本**。新增 `live-instance.mjs`（10 项）对比两个时间戳诊断滞后并告警；同时统计真实会话里的 `txtcall-` 标记作为「插件确实在生产环境工作过」的证据（13,139 条流中 86 条被恢复）。
- **产生核心证据的脚本从未运行过**：`test/long-context-replay/` 里三个脚本产出了材料**最强的证据**（419,843 token 忠实重放），但前 42 轮一次没跑。实测全部跑通，但发现 **faithful-replay 默认读 `real-tools.json`，而 rebuild 写的是 `rebuilt-tools.json`** —— 照文档做会直接失败（已修）。新增 `lcr-replay.mjs`（25 项）做端到端验证。
- **测试矩阵里的数字没人核对过**：README 的技术矩阵有 **66 行**，每行都宣称一个规模（「29 项」「24,000 条」…），但从未系统核验。新增 `claims-audit.mjs`：抽取全部声明并**逐个实跑核实** —— 39 个套件全部与声明一致；同时抓到 `structure-fuzz.mjs` 实际只跑 **5,000 条**而 README 写 24,000。已选择**提升代码**（3 种子 × 8000 = 24,000，实测 525ms 零崩溃）而不是把声明改小。
- **一个「测试」文件里没有任何断言**：`test/real-samples.test.mjs` 只 print 结果然后无条件 `exit 0` —— 插件回归时它**永远不会失败**，看起来是测试、实际是演示脚本；而它还被列进测试矩阵、声明「3 个真实案例形态」。已加 **17 项真实断言**（工具名/参数键/参数值/finish 改写/截断样本必须不恢复）。
- **又一个「永远通过」的测试**：`hardening/audit-rewrites.mjs` 会打印「可疑: N」然后结束，但**没有 `process.exit(1)` 路径** —— 即使插件开始误伤正常回复，它在 `run-all` 里仍显示 PASS。已加失败判定，并新增 `fake-test-audit.mjs`（8 项）扫描**全部 75 个测试脚本**，确认每个「有断言 或 有基于统计的失败退出」：62 个用 `check()`、13 个用自建统计 + 退非 0、**0 个无法失败**。
- **48 个缺陷并非都有回归测试**：`defect-regression.mjs` 原本只覆盖早期缺陷，而后来的 D28–D48（交付质量类）分散在各专门套件里，**没人核对过是否每个缺陷都有守护**。新增 `defect-coverage-matrix.mjs`（8 项）把 48 个缺陷逐一映射到守护套件并验证其中真有对应检查：**39/39 全部有守护**，其中 **D1–D30（插件行为）全部由运行时断言守护**。
- **文档结构问题**：中文 README 出现**两个「九、」**章节（跨版本验证 / 备注），后续「十、十一」也跟着错位；而且英文 README 有 Known limits 章节，**中文版完全没有** —— 对主要受众是信息缺失。已重新编号为一至十三、补上「已知限制（诚实清单）」（含 **不保证没有 bug** 这一条），并新增 `doc-structure.mjs`（32 项）守护结构完整性。
- **不可自动复现的声明没有标注**：材料写「155 项断言已在三个 DSH 版本上跑通」——这是真的（我确实手工跑过），但读者机器上只有一份 dsh-llm，**无法复现**；而仓库里的 `cross-version.mjs` 实际是用**模拟的协议差异**测的。两者混着说会让读者误解。已在两版都加上明确的「历史记录 / 当前可自动复现」区分说明，并新增检查确保这类声明必须带标注。
- **安全网的跨模块契约从未用宿主代码验证过**：插件的「确定性失败保护」假设「产出 `code="EMPTY_RESPONSE"` → 宿主的重试策略会认」。前 49 轮只验证了「插件确实改写成 error」，**没验证宿主那头认不认** —— 如果宿主不认，这个安全网就是无效的。新增 `safety-net-contract.mjs`（18 项）用宿主的真实 `error.js` / `retry-policy.js` 验证：`DEFAULT_RETRYABLE_CODES` 确实含 `EMPTY_RESPONSE`、解析后策略 `maxRetries=5`、插件产出码与宿主常量**完全相同**、5 个近似拼写宿主都不认。
- **一个我差点犯下的错误：把正确的设计当成缺陷改掉**：审查时我看到「tools 为空时整个插件早退」，判断这是缺陷（「模型只返回思考时用户会卡住，安全网该生效」）并改了它。**集成测试用例 5 立刻失败** ——真实原因是 DSH 有 **compaction**（压缩上下文）和 **session-title**（生成标题）两类**不带工具**的内部请求，这两类里「没有 tool-call 块」是**正常的**，触发重试只会白白浪费 token。**早退是对的，我错了。** 已完整回滚，并把设计理由写进注释、新增 `passthrough-design.mjs`（10 项）固化这个决策。
- **一个定义后从未使用的正则（死代码重现）**：`TOOL_CALL_BLOCK_RE` 在整个文件里只出现 1 次（定义处）。发现方式很意外 —— 我在验证「基线回归能否检测行为漂移」时故意破坏了这个正则，**预期真实流会不再被恢复，结果毫无变化**，才意识到它根本没被用。这是第 28 轮 `hasCodeFence` 死代码的同类问题重现（当时只删了具体的、没建通用检测）。已删除死代码，并在 `code-quality.mjs` 增加**通用死代码检测 + 注入验证**。
- **回归测试的盲区**：`replay-real-streams` 只验证「没破坏真实流」，但发现不了**行为漂移**（「以前改写这 5 条，现在只改写 3 条」）。新增 `baseline-regression.mjs`：把「改写哪些流 + 改成什么」固化成基线快照（`real-stream-baseline.json`，仅 1KB，只记 5 条被改写的流，指纹 = 内容 SHA256），对比**不再改写**（漏识别回归）/ **新增改写**（误伤回归）/ **改写结果变了** 三类漂移。已用「注入破坏」验证它真能检测。
- **测量工具本身有 bug（最危险的静默漏报）**：`code-quality.mjs` 的 `findFunctions` 用**裸括号计数**找函数边界，但 `lib/index.js` 里有 **18 处**含 `{` `}` 的字符串字面量（`"{"`、`{"command":...}`）。裸计数把它们也计入 → **函数数量 19 → 18（少识别 1 个）**、`parseCallBody` 被误判为 1 行（实际 58 代码行）。**测试不会报错**，只是检查被静默削弱。已改成先剥离字符串再数括号，并新增**测量工具自检**（5 个已知答案的合成输入）。
- **把测量工具的自检从 5 个用例扩到 7 个**：新增「正则字面量里的 `{}`」两个用例。结论是**当前实现是安全的** —— `/a{2,3}/` 里的 `{` 与 `}` 数量相等、互相抵消，所以不剥离正则也不会出错。（我一度尝试「加固」——额外剥离正则字面量——结果反而引入 18 vs 19 的函数数量错误，已放弃并记录原因。）
- **层数被手工递增，已与实际套件数漂移**：我每轮手工把「N 层」+1，但新增套件数不总是 +1。结果声称 **87 层**而实际只有 **83 个套件**（漂移 4）。原检查容差 ±3，**差 4 才刚被抓到**。已改为**精确等于套件总数**、补上矩阵漏列的 2 个套件（`interleaved-blocks`、`multi-turn`），并把容差从 ±3 收紧到 **0**、错误信息里给出修正建议。已用「改成 +1」验证检查会失败。
- **缺陷表的两行被合并、另一行重复（Markdown 表格结构破坏）**：多次编辑时某次替换漏了换行，导致 **D26 与 D27 被拼到同一行**（该行有 13 个 `|` 而非 6 个）—— Markdown 渲染出错、D27 在表格里「消失」、解析器只认出 38 行（实际 45）。修复过程中又引入 D27 重复；且 D27 描述里的正则 `/(?:\r\n|[\r\n])/` 含未转义的 `|`。已全部修复，并在 `doc-structure.mjs` 增加第 8 节**表格结构完整性**（5 列 / 编号无重复 / 编号连续 / 无空单元格），用三种注入破坏验证过它真会失败。
- **表格列数不一致（两类）**：① 测试矩阵的行被误插进缺陷表（5 行 4 列混进 5 列表）；② 英文版 README 的 D26/D27 也被合并到同一行（13 个 `|`）。第 56 轮的检查**只覆盖缺陷表**，漏了其他表格。已把检查**扩展到全部 Markdown 表格**（同一表内所有行的未转义 `|` 数量必须相同），并用「注入 3 列的行」验证会失败。
- **英文 README 的缺陷表严重滞后**：停在 **D27**，中文版已到 **D47** —— **滞后 20 条**。英文读者会以为这个项目只发现过 27 个缺陷。根因是结构检查只看了中文版、只验了表格列数，从不做**中英文内容对等**。已补全 20 条英文，并新增**对等检查**（数量/编号集合/内容实质长度），用「删除三行」验证过它会失败。
- **批量替换污染了历史记录**：为了让统计数字保持最新，我写了批量替换脚本，结果把 D45 的历史记录「声称 87，实际 83，漂移 4」改成了「声称 83，实际 83，漂移 83」——**数学上自相矛盾**。`run-all` 表格里的套件数也被改错（62 vs 实际 83）。根因是暴力替换**无法区分当前统计值与历史记录里的数值**。已逐条修正 13 处，并新增**历史记录自洽检查**（D45 的算术必须成立、run-all 套件数必须准确），用「注入污染」验证过会失败。
- **性能数字从未被自动校验**：README 声称「典型回复 0.018ms」「128KB 1.06ms」「101 万 chunk/s」，但只有 `perf-baseline.mjs` 的宽松上限（5ms/20ms）在守 —— 若性能退化 5 倍，套件仍通过，文档数字却已过时。已实测核对（0.018ms / 1.062ms / 160 万 chunk/s，**全部吻合**），并在 `doc-consistency` 增加第 12 节：提取并校验这 3 个数字，同时断言 `perf-baseline.mjs` 必须保留阈值与 O(n²) 检查。
- **「LRU 顺序」从未被验证过**：变异测试发现，把 `emptyResponseStreak.delete(key)` 删掉后，`race-conditions.mjs` **仍然全部通过** —— 因为删掉它 Map 就退化成 FIFO（按插入顺序淘汰），而不是 LRU（按最近访问）。区别只在「重新访问过的模型是否被优先保留」，之前**没有任何测试覆盖这个差异**。已新增第 7 节「真正的 LRU 语义」：填满 → 重新访问 m0 → 触发淘汰 → 验证 m0 仍在、m1 被淘汰，并用两个变异验证过都会失败。
- **路径级不一致缺少系统性检查**：`parseCallBody` 有 **4 条返回路径**，单测每条都通过，但**路径之间的差异只有在对照时才暴露**。缺陷 55 只是其中一处。新增 `path-consistency.mjs`（26 项）：同一份输入喂给全部 6 种写法，断言字段类型**在所有路径上完全一致**、类型符合 `properties` 声明、说明性 JSON 不被执行、源码层面每条强转路径都有 `coerceValue`。用两个变异（回退缺陷 55 / 破坏 L306 强转）验证过都会失败。
- **`id` 唯一性测试用错了输入**：写多调用测试时顺手用了两个**内容不同**的调用，把 id 生成里的 `-${ordinal}` 删掉后套件**仍然全过** —— 因为不同内容哈希本来就不同。`ordinal` 是为了让**内容完全相同**的调用也有不同 id。改用三个相同的调用后，删掉 ordinal 立刻报 `1/3`。
- **「运行模式」表格的套件数与耗时严重过时**：声称 `--quick --offline` 跑 46 个套件（实测 73）、`--offline` 跑 50 个（实测 77），耗时「约 12 秒」（实测 88 秒）、「约 2 分钟」（实测 6.3 分钟）—— **少算 27 个套件**，读者会以为快速模式只覆盖一半。完整模式（87）反而是对的，说明这张表被改过一次但只改了最后一行。三种模式已全部实测，并在 `doc-consistency` 新增第 13 节**从 `run-all.mjs` 静态计算**套件数。
- **Markdown 换行符不一致，且文件曾被写坏成 3703 行空行**：修「运行模式表格」时用 PowerShell 按行写入，CRLF 处理出错 —— 文件一度变成 4085 行（其中 3703 行是空行，原文 760 行），修复后遗留 759 处双 CR，且 `README.md` 是 CRLF 而其余 7 个是 LF。已全部规范化为 LF，`doc-structure` 第 11 节新增换行符一致性与空行堆积检查。
- **`PASTE-READY.zh.md` 严重过时**：它是**用户真正复制粘贴到 GitHub 的文件**，但生成一次后就没再跑过脚本 —— 不含最新的 12 个缺陷条目，层数也是旧值。用户会贴出一份过时的讨论帖，而之前的检查都没有覆盖这个文件。已重新生成，并在 `doc-consistency` 新增第 14 节做**逐字一致性**校验（中英文正文必须与主材料完全相同），用三个变异验证过都会失败。
- **`community/` 下 3 个草稿从未被任何套件检查**：检查套件都在「主材料」时代写的，没跟上后续新增的 community 草稿。经查这 3 个文件内容完整、无过时数字、无敏感信息（`sk-xxx` 是占位符），但其中的脚本引用（`openai-completions.js`）从未被核验。已把 `ref-verifiable.mjs` 的检查范围从 4 个文档扩展到 **7 个**，并显式标注「本地无法核实的上游包」。
- **零基础指南完全不提「装完必须重启」，预期输出数字也过时**：`SUBMIT-GUIDE.zh.md` 0 处提及重启（README 有 9 处），而 DSH 是长驻进程、`apply()` 只在启动时执行一次 —— 用户装完插件后运行中的进程仍用旧代码，**会以为修复无效**。预期输出还写着「58 通过」（实际 73）、「约 30 秒」（实际 89 秒）。已新增「装完必须重启」章节并用实测数字修正三处，`deliverable.mjs` 新增第 9 节校验。
- **「这套材料真的能提交吗」从未实际验证过**：前 69 轮只检查了「`.gitignore` 里有排除规则」「文件存在」，但从未**实际跑一遍 git** 看上传集合对不对。实证 `git init + add` 结果：**104 个文件**会提交、4 个草稿正确排除、93 个测试脚本会提交、无意外文件。结论是对的，但此前只是手工跑过一次。已固化为 `deliverable.mjs` 第 10 节（4 项），并用「删掉 `.gitignore` 规则」验证 —— 三层检查同时报错。
- **安装脚本只测了成功路径**：`install-experience.mjs` 覆盖编码、语法、真正跑一遍、产物检查、patch 形态 —— 全是成功场景。而用户最常遇到的是失败场景：profile 不存在、patch 缺失、重复运行（幂等）。第 72 轮实测三个场景全部正确（18 项），但此前**从未被验证过**。已新增 `install-failure-paths.mjs`。注意必须用 `powershell`(5.1) 而非 `pwsh`(7)。
- **README「已知限制」的 8 条宣称从未被验证过**：所有检查都在验「做到了什么」，没人验「做不到什么」。第 73 轮逐条实测：其他格式不解析、无参数调用不恢复、正常回复不被改动、只有思考时走安全网、7 种 chunk 类型全处理、跨版本证据分两类 —— **8 条限制全部准确**。已新增 `known-limits-accuracy.mjs`（19 项）把「限制描述」变成可回归断言，防止将来改动让某个限制不再成立（那会让 README 说谎）。
- **「卸载」只验证了「README 里有说明」**：`install-experience.mjs` 标题写着「安装/**卸载**体验」，但对卸载只有一句正则匹配。第 74 轮**实际走完整流程**（安装→按 README 删除→删目录→重装，19 项断言全部通过），并暴露真实风险：用 PowerShell 的 `Set-Content -NoNewline` 删两行会把**整个 YAML 压成一行**、配置彻底损坏。已据此重写卸载说明：优先从备份恢复、给出要删的确切片段、**明确警告不要用 PowerShell 重写文件**。
- **README 内部不同章节的数字自相矛盾**：之前的检查都是「README vs 源码 / 英文版 / discussion」，**从没检查过同一份 README 里不同章节是否自相矛盾**。实测发现 2 处：L723「把 **167 个缺陷逐一映射」（实际 66）、L765「本项目做了 **86 层**验证」（实际 90）。英文版反而是对的，说明中文版是逐段手工维护时漏改。已修正，并新增 `doc-consistency` 第 15 节做**内部一致性**检查（含反向验证防止空转）。
- **「内部一致性」检查只覆盖 README，且历史标记判据不完整**：第 75 轮补的检查只盯着 README，而 `discussion`/`PASTE-READY` 也有「N 层测试」表述；判据还缺「原有」「当时」「此前」—— 本文档 L113「**原有 86 层**测试按功能维度组织」是历史叙述，却被当成当前声明误报。已把检查扩展到 3 个文档并补齐判据。
- **结构检查只覆盖 4/8 个文档**：第 76 轮做了覆盖矩阵（8 文档 × 7 类检查），发现结构/换行符只覆盖 4/8、数字一致性 5/8、可执行性 4/8。最关键缺口是 `SUBMIT-GUIDE.zh.md`（零基础用户手册）完全没做结构检查。已新增 `doc-structure` 第 12 节覆盖全部 8 个文档。
- **中文 README 的所有表格渲染错误**：缺陷表 68 行被 **55 个空行切成 56 个独立小表**、测试矩阵 75 行被 75 个空行切开 —— Markdown 要求表格行连续，空行会截断表格，导致 GitHub 上**中文 README 的所有表格渲染错误**。英文版完全正确。发现方式是第 9 节报「164 个表格」明显不合理，追下去才看到 160 个单行「表格」。已删除 153 个表格内空行（160 → 7 个正常表格），并新增 `doc-structure` 第 13 节守护。
- **README 有 4 类渲染结构问题**：① 代码块内 **35 处空行**；② **8 处连续空行**；③ **测试矩阵 4 行被错位插入「安装步骤」章节** —— 读者在安装说明中间突然看到 4 行测试矩阵，**这是最严重的**；④ D3 单元格里的裸三重反引号干扰围栏识别。已全部修复（634 → 597 行），并新增 `doc-structure` 第 14 节做 8 文档 × 6 项的渲染健康检查 —— **新检查立刻又在另外 3 个文档抓出 6 处问题**。
- **材料不验证「文档引用的仓库文件是否存在」**：`ref-verifiable.mjs` 前 7 节只查宿主源码引用（`dsh-xxx/lib/xxx.js`），没查仓库内文件路径。**381 个路径引用全部可解析**（16 精确 + 124 路径缩写 + 外部依赖/运行时生成物），但此前从没验证过。已新增第 8 节逐条核实，并允许 3 类「看起来不存在但正确」的引用（路径缩写 / 外部依赖 / 运行时生成物）。
- **关键套件的「有效性」从未被证明**：26 个关键套件里只有 **7 个（27%）** 有变异验证记录。一个永远不会失败的检查比没有检查更糟。本轮对 14 个无记录的套件逐个注入破坏：**12 个被抓到**，2 个属职责边界。**结论：「没有记录」不等于「无效」—— 缺的是证据文档化**。已新增 `meta-health` 第 8 节维护 `VERIFIED` 清单（19 个套件，每个标注注入方式与预期报错）。
- **「恢复出来的调用」没有任何 A/B 双路径一致性验证**：`differential.mjs` 的 88 个随机流用的是**原生 tool-call 块**（`argumentsDelta` 固定 `"{}"`），**完全不覆盖插件恢复的调用**。宿主的 A（实时 `BlockAssembler`）与 B（持久化 `Accumulator → expand → assemble`）两条路径下，恢复的调用必须一致 —— 否则用户「实时看到的结果」与「刷新后回放的结果」会不同。实测全仓库只有 4 个套件做完整 A/B，其中只有 `host-validator` 涉及 `txtcall` 且未做比对。已新增 `recovered-ab-consistency.mjs`（27 项），**顺带发现 `BlockAssembler` 只用 block-end、忽略 delta** —— 所以「delta 累积 == block-end」必须单独验证。
- **「已知限制」把插件明确支持的格式说成「不解析」**：原文写「其他文本格式不解析（…其他 XML 方言）」，但插件**明确支持** `<invoke name=…>`（lib L104-105 有专门的 `INVOKE_NAME_ATTR_RE`）。实测 `<invoke name="pwsh">…</invoke>` → **恢复 1 个调用**。读者会误以为 Anthropic 风格不支持。已改为写明「只解析 3 类标记」，并新增 3 项检查防止笼统表述复发。
- **`package.json` 缺 6 个对开源项目有实质影响的字段**：`repository`（npm 页面无源码链接）、`keywords`（社区在 npm 搜 `deepseek`/`cordis` **找不到**）、`bugs`（用户不知道去哪报 issue）、`homepage`、`author`、`engines`（README 说需 Node 16.9+ 但包不声明）。已全部补齐并新增 `package-contract.mjs`（23 项）：必备字段、开源元数据、**真实解析 exports 契约**、**exports 隔离**、`npm pack` 产物字节一致。
- **README 没有 Node 版本要求**：`package.json` 有 `engines.node`、SUBMIT-GUIDE 写「要求 Node 16.9+」，但 **README（给用户看的）一直没补** —— 读者装完才发现版本不够。已在安装章节前提补上（中英），并让 `package-contract.mjs` 检查两者一致。
- **占位符的「填写说明」只覆盖了 1 处，实际有 5 处**：SUBMIT-GUIDE 第 5 步写于第 60 轮（那时只有 PASTE-READY 有占位符），第 83 轮给 `package.json` 补字段时新增 4 个，**但没回头改说明**。用户照做会漏掉 `package.json` 的 4 处 → npm 页面的 Repository/Homepage/Issues 全指向 404。已重写第五步（拆成 PASTE-READY 1 处 + package.json 4 处，含对照表、替换示例、**一条验证命令**），`deliverable.mjs` 新增第 11 节守护（4 项）。
- **效果数据的算术不自洽（13,802 + 390 ≠ 14,408）**：三个数字来自**不同时点**的统计，却写在同一句里，读者会当成同一次运行的完整分类。而 `hasNativeToolCall` 是**二值判断**，互斥分类必然完备 —— 实测差 **216 条**，说明三个数字不可能同时为真。已改为「同一时点的快照」+ 口径说明，并给 `claims-audit` 加**算术自洽检查**（原来只检查「量级 > 10000」，不检查精确值）。
- **「运行模式」表格的耗时被低估近 60%**：README 写 `--offline` 模式「约 6 分钟」，实测 **82 套件 / 568.6 秒 = 9.5 分钟**，多 58%。根因是**耗时无法静态推导**，第 67 轮的静态计算检查天然覆盖不到。已修正为中英双语 9.5 分钟，并给 `doc-consistency` 加第 16 节：套件数必须递增、**耗时也必须递增**、**耗时比例未被严重低估**。
- **会增长的数字只有 1 处标了「快照」**：第 85 轮只给 1 处加了标注，其余 6 处漏了。第 86 轮**完整跑了 9 个需真实日志的套件**（此前 20+ 轮都只跑 `--quick --offline`），实测真实流已从 **14,408 增至 15,675**（+8.8%）。已给 5 处加标注、把 L596 的「1.4 万条」改为精确表述、在测试矩阵前加增长说明（中英双语），并新增 `doc-consistency` 第 17 节守护。
- **6 处「恒真断言」（`ck(..., true, ...)`），`real-cordis` 占 3 处**：最严重的是 L218 `ck("插件不抛在 dispose 阶段", true, "")` —— 实测 **Cordis 4 的 Context 根本没有 `dispose` 方法**，这条断言在骗人。已全部改为真实判断（L67 检查 `loadError === null`、L187 检查恢复数量 1–2、L218 如实记录「本场景不可测」并补 `unsubscriber` 可测替代），并给 `fake-test-audit` 加第 3 节扫描 90 个测试文件。**顺带发现**：`ctx.on` 是 Cordis 的 Proxy 动态属性，不在原型链上。
- **「92 个套件全部通过」里混入 1 个永不失败的剖析工具**：`perf-profile` 只 `console.log`，无失败路径，却被 `readdirSync` 自动发现并计入「全部通过」。实测 `92 = 91 验证 + 1 剖析`。已改为如实分类（中英双语），并确认性能回归**没有缺失**（`perf-baseline` 的 7 项断言承担）。`meta-health` 新增第 9 节自动扫描「永不失败的套件」并要求在 README 标注。
- **表格检查用「结构启发式」而非 CommonMark 真实规则，且只覆盖 2/8 个文档**：前几轮都是「以 `|` 开头就算表格行」，而规范要求**必须 header + delimiter** —— 没有 delimiter 的 `|` 块根本不会渲染成表格，旧检查却当成表格「通过」。实测真实规则下 **8 个文档共 22 个表格、48 个围栏**（第 9 节只查 10 个表、第 13 节只查 17 个）。已新增 `doc-structure` 第 15 节按真实规则重新验证全部 8 个文档。
- **重大：89 轮来一直误判 `dsh-llm/lib/types/invariant.js`「不存在」**：根因是**本地测试副本不完整**（缺这个文件），而所有检查都基于副本。第 90 轮直接解析 `app.asar`（1.74 亿字节）读出真实结构 —— `lib/types/` 有 **14 个 .js**，**包含 `invariant.js`（4,401 字节，是 `validateStream`/`validateIndex`/`validateDelta` 协议校验器）**，本地只有 13 个。整个「已证伪」判定链建立在**错误前提**上。已从 asar 补全、订正 D37、把第 5 节从「证伪」改为「验证存在」，并给 `meta-health` 加第 10 节直接从 asar 校验副本完整性。**同时验证**：asar 内 `dsh-llm` 版本 0.2.1-rc.2、`lib/index.js` 105,272 字节 / SHA256 与本地**完全一致** —— 其他验证都基于真实代码。
- **从未针对宿主自己的 7 条流协议规则验证过插件输出**：前 90 轮只验了「`BlockAssembler` 能装配」「`Accumulator` 不崩」，没验「宿主 `invariant.js` 里那 7 条规则全部满足」。第 90 轮发现该文件真实存在后，第 91 轮提取出 **R1–R7**（index 安全整数 / delta 类型匹配 / finish 后禁发 / 不重复 start / end 必须有 open / end 类型一致 / finish 时无未关闭块）。**这 7 条是宿主真正执行的校验**。实测插件在 **7 种形态**下全部满足，新增 `invariant-conformance.mjs`（19 项断言，含校验器自检）。
- **手写重写了宿主的校验规则，导致「漏 2 条 + 过严 1 条」**：第 91 轮把 `invariant.js` 的规则读出来再手写成 JS，而手写必然有细节偏差。第 92 轮逐行对照（宿主 74 行）后发现：**R8 `usage` 只能出现一次**（漏）、**R9 必须有一个 terminal `finish`**（漏）、**R10 `finish` 为 error/aborted 时「允许」有未关闭块**（手写版过严，会误判宿主的合法流）。已改为**直接从源码提取 `validateStream` 并求值** —— 用宿主自己的实现做判定，规则永不漂移。验证从 11 项增至 **21 项**。
- **真实数据套件（覆盖全部真实流）用的是手写校验器**：三个套件里有 **3 份**流协议校验实现（`health-check` L70、`replay-real-streams` L34、宿主 `invariant.js`）。逐行对照后发现 `health-check` 的手写版**漏了 R8（`usage` 重复）和 R9（缺 terminal `finish`）** —— 而它跑的正是**全部真实流**。已新建共享模块 `_host-invariant.mjs`（从源码提取宿主真实 `validateStream`），两个套件改为优先用宿主实现、手写版降级为后备。**改造后 全部真实流全部通过宿主真实校验器**。
- **「运行实例版本滞后」的判定只比较了最早进程，没定位到真正加载插件的 host 进程**：一个 DSH 会拉起 **6 个进程**，**只有带 `--expose-internals ... dsh-desktop-host` 的那一个真正加载插件**。粗比较拿最早的主进程算差值，结论碰巧对（滞后 1043 分钟）但**依据错了** —— 若重启后主进程变了而 host 进程没变，会误判。已新增 `runtime-process-check.mjs`（8 项），用 `Get-CimInstance` 拿完整命令行精确定位 host 进程并断言「恰好 1 个」。**顺带**：新套件的 3 处恒真断言被 `fake-test-audit` 当场抓到并修复。
- **README 缺少 Top-Down 摘要**：这份 README 是**调查笔记**演化来的，按「我发现问题 → 查根因 → 做修复」的时间顺序写，而不是按「读者需要什么」组织。前 3 节 98 行全是问题现象 + 根因调查，**安装入口在 L109**。已插入「30 秒摘要」区块（中英双语，含问题/安装/重启/验证/分流导航），**安装入口从 L109 → L15**，并新增 `deliverable` 第 12 节（7 项）守护「摘要必须在前 40 行、安装命令必须在前 50 行」。
- **TL;DR 里的 2 个内部锚点失效**：锚点是按**当时的标题文本**手写的，标题后来改过（缺陷数 89→90、`## Verify` 的 slug 是 `verify` 而非 `verification`），锚点没跟着改。**这类问题肉眼几乎看不出来** —— 链接文字是对的，只有点下去才发现 404。已修正 2 处，并给 `deliverable` 加第 13 节：**按 GitHub slug 规则重建所有标题锚点**、逐个核对链接可达性、含反向验证（必须找到 ≥5 个锚点）。实测 9 个锚点全部可达。
- **`package.json` 有完整 npm 元数据，但没说「要不要发 npm」**：`repository`/`homepage`/`bugs`/`keywords`/`engines` 这些字段**只有发布到 npm 才有意义**，但 README 只教「克隆仓库 + 运行 `install-stepfix.ps1`」，SUBMIT-GUIDE 完全没提 npm。读者会问「我该 `npm install` 吗？」—— 而 npm 包里**只有 5 个文件**，不含 `test/` 和安装脚本，照 README 跑命令会全失败。已加 `private: true` + 中英说明，并给 `package-contract` 加第 7 节（5 项）守护。
- **安装脚本的两个编码陷阱（都会在用户第一条命令上出问题）**：① 脚本用 `Get-Content -Raw`（无 `-Encoding`）读 `cordis.patch.yml` 再 `WriteAllText` 写回 —— PS 5.1 在中文系统按 GBK 解码无 BOM 的 UTF-8，**用户配置里的中文被永久损坏**（实测「书生专用」→「涔︾敓涓撶敤」）；② 脚本**自己**是 UTF-8 无 BOM 且含 1,173 个非 ASCII 字节，PS 5.1 按 ANSI 读源码 → 字节边界破坏、字符串引号被吃掉 → **3 个语法错误，脚本根本跑不起来**。已改为显式 UTF-8 读写 + 保留 BOM 状态，并给脚本加 UTF-8 BOM。`deliverable` 第 14 节（6 项）守护，含**真实执行 powershell -File** 验证。
- **安装脚本的失败路径只抛 .NET 原始异常堆栈**：前 98 轮只测成功路径。实测把 `cordis.patch.yml` 设为只读后，用户看到一屏 `CategoryInfo : PermissionDenied` / `FullyQualifiedErrorId` 堆栈 —— 既不知道发生了什么，也不知道怎么修，更不知道配置有没有被改坏。已给备份/复制/写回三处都加 `try/catch`，给出**可操作**提示（只读→取消只读、占用→退出 DSH、磁盘满→清理），并明确告知**当前状态**（「尚未修改任何配置，可安全重试」）。`deliverable` 新增第 15 节（10 项）真实执行验证 4 种场景。
- **安装脚本的备份只增不删（实测累积 1114 个文件）**：每次运行都建一个带时间戳的备份，但**从不清理**。虽然单个只有 0.3 KB，但只增不减，且上千个几乎相同的文件反而让「找回某个时间点的配置」更难。已加**备份轮转**（保留最近 10 个，只删本脚本产生的文件），并修正了顺序 —— 轮转必须在**创建完本次备份之后**，否则会留下 11 个。同时补测了三个从未测过的路径场景：**含空格、含中文、`-ProfileDir` 参数**，均正常。`deliverable` 新增第 16 节（11 项）真实执行验证。
- **「手动安装」这条路从未被测过，且缺关键步骤；英文版根本没有这段**：README 同时给了「脚本安装」和「手动安装」两条路，但 100 轮只测了脚本那条。实测发现：① 中文手动步骤只有 2 步，**完全没提**「必须重启 / 备份 / 自检」—— 手动安装的用户装完不重启会以为「装了没反应」；② **英文版根本没有手动安装段落**，中英严重不对等；③ 但两边产物实测**完全等价**（文件树一致、patch 语义相同），说明**手动路径本身可行**，问题纯在文档。已把中文补到 6 步、英文新增完整段落，`deliverable` 新增第 17 节（15 项）真实执行对比。
- **「临时禁用」开关从未验证过，且文档有两处会误导用户**：① 只认**精确的字符串 `"0"`** —— `false`/`off`/`""`/`"00"`/`"0 "` 全都**不会禁用**且**不报错**，用户会以为禁用了而实际还在工作；② 文档的 `$env:X = "0"` 对**已运行的 DSH 完全无效** —— 环境变量在进程启动时拷贝，必须设用户级变量再完全重启。实现本身是正确的（`"0"` 时 `apply()` 直接 return），问题纯在文档。已重写禁用章节（中英双语）、新增 `env-disable-semantics.mjs`（19 项）验证 9 种语义 + 6 项文档完整性。

另外几个是：正文偶然提及标记会被误判成“纯标记”而把正常回复改成错误、扣留 `block-end` 时 `usage` 顺序倒置、异常输入（缺 `block`/`reason`、`tools` 形状异常）会抛异常中断整条流、以及多轮会话中的状态泄漏。全部写进了插件 README，供上游实现时避坑。

**如何在 5 分钟内在自己环境里验证这个 harness 侧 bug**（不需要任何特定模型，纯本地确定性复现）：

```bash
node harness-side.mjs
```

该脚本自包含、无第三方依赖，内置了失败响应的 StreamChunk 序列（与 pi-ai 适配器 `toStreamChunks` 对该类响应的实际输出一致），然后按 `BlockAssembler` 等价逻辑装配、再套用 agent loop 的判定规则。输出：

```
tool-call 块数量 = 0
agent loop 判定: {"kind":"completed"}
=> 回合静默结束：无错误、无重试、无工具执行。
```

这直接展示了第 86 层根因：一条"模型想调工具但调用在文本里"的响应，会被静默判为回合完成。

**模型侧行为复现**（需要对应模型的 API key，间歇性）：

```bash
STEPFUN_API_KEY=sk-xxx node model-side.cjs 20   # 连打 20 次并分类统计
```

**版本信息**：问题在以下三个版本上均复现且均未修复——
`0.2.0-rc.2`、`0.2.1-rc.1`、`0.2.1-rc.2`（均 win32 x64；版本以
`DeepSeek Harness.exe` 的"文件版本"属性或 `resources/app.asar` 内
`@deepseek-ai/dsh-llm` 包版本为准——安装目录下的 `version` 文件是安装器
版本，实测为 `44.7.0`，与应用版本不同）；对应 `@earendil-works/pi-ai`
0.87.1 / 1.1.0 / 1.1.0。插件本身在三套版本上均验证可加载、测试全绿（155/155）。

---

## English version (alternative)

### Title

[Bug report] Tool calls emitted as XML text are silently dropped — the agent turn ends with no action (two real cases + plugin-level fix, reproduced on three versions)

### Body

> Suggested category: General (agent reliability)
> Environment: DeepSeek Harness 0.2.0-rc.2 / 0.2.1-rc.1 / 0.2.1-rc.2 (all three tested, win32 x64)
> Severity: major (silent failure — no error, no retry, no diagnostics; agent apps see a "hang" or "truncated task")

**Symptom**: in two production scenarios the agent "thinks for a while and
then nothing happens" / "the task gets truncated":

- **Case A — StepFun `step-5-preview`** (provider `step-plan-152`): the model
  intermittently returns tool calls as Qwen/Hermes-style XML text inside
  `reasoning_content` instead of structured `tool_calls`.
- **Case B — gateway-routed `deepseek-v4.1-flash-max`**: after the primary
  account hit HTTP 429, the router fell back to an upstream that returns
  **Anthropic-style XML text** tool calls (`parameter name=key`), frequently
  **truncated** mid-markup.

**Shared root-cause chain** (three layers, all evidenced from session logs):

1. The model writes the tool call as XML **text** instead of structured
   `tool_calls`;
2. pi-ai's `openai-completions` parser maps only `delta.tool_calls` into
   `toolCall` blocks; text passes through into text/thinking blocks;
3. `dsh-agent-loop` `lib/index.js:1152-1153`:

   ```js
   const toolCalls = message.content.filter((block) => block.type === "tool-call");
   if (toolCalls.length === 0) return { kind: "completed" };
   ```

   → the turn ends **silently**: no error, no retry, no tool execution.

Secondary gap: `dsh-llm-pi-ai`'s `mapStopReason` maps only "zero content
blocks" to `EMPTY_RESPONSE`; "thinking-only" or "only tool-call markup"
responses pass through as a normal `stop`.

**This is a general robustness gap, not a single-model quirk**: any
Qwen/Hermes-family model served through a gateway (vLLM/Ollama/new-api) and
any Anthropic-style proxy endpoint hits the same chain.

**Cross-version check: still unfixed on 0.2.1-rc.1 and 0.2.1-rc.2**
(line-by-line source verification). We upgraded from 0.2.0-rc.2 through
0.2.1-rc.1 to 0.2.1-rc.2, re-verifying all three critical spots —
**none changed**:

> **How to identify your version**: check the "File version" property of
> `DeepSeek Harness.exe` (measured as `0.2.1-rc.2`), or the package version
> of `@deepseek-ai/dsh-llm` inside `resources/app.asar`. The `version` file
> in the install directory is the **installer version** (measured as
> `44.7.0`), which differs from the app version — do not use it to
> identify versions.

| Check | 0.2.0-rc.2 | 0.2.1-rc.1 | 0.2.1-rc.2 | Verdict |
|---|---|---|---|---|
| `@earendil-works/pi-ai` version | 0.87.1 | 1.1.0 | 1.1.0 | unchanged |
| `dsh-llm` version | 0.2.0-rc.2 | 0.2.1-rc.1 | 0.2.1-rc.2 | patch bump |
| Parser recognizes text tool calls | only `delta.tool_calls` | still only (`:426-427`) | still only (`:425-426`) | not fixed |
| Agent-loop silent completion | `lib/index.js:1152-1153` | `:1164-1165` | `:1163-1164`, identical | not fixed |
| Adapter `EMPTY_RESPONSE` trigger | only `content.length === 0` | still only (`:1481-1489`) | still only (`:1480-1488`) | not fixed |

So the issue reproduces **across three versions and two pi-ai major
versions** — not a single-version regression, and not yet addressed.

**Verified on the new versions too**: the plugin's 155 integration assertions
and recreated-sample checks pass against the real `BlockAssembler` source of
**all three** 0.2.0-rc.2 (pi-ai 0.87.1), 0.2.1-rc.1 (pi-ai 1.1.0), and
0.2.1-rc.2, with identical results — the behavior is version-independent.

**Ruled out by 61 controlled experiments against the live API**: identical
request shape, `tool_choice` variants, real 40-tool payloads, `step_plan` vs
standard endpoint, and a faithful replay of the failing request context
(419,843 tokens — within 0.04% of the real request; 7/7 normal). Conclusion:
request shape, parameters, endpoint, and **context length do not trigger it**;
the failures are per-request model/upstream behavior.

**Suggested upstream fix** (two small changes):

1. **pi-ai parser layer**: after the stream ends, promote text-format tool
   calls in text/thinking blocks to first-class `toolCall` blocks and set
   `stopReason = "toolUse"` — ideally behind a per-model `compat` flag (e.g.
   `supportsTextToolCalls`, default off), covering Qwen style
   (`parameter=key`), Anthropic style (`parameter name=key`), and JSON form.
2. **agent loop / adapter layer**: map "terminal `stop` with no executable
   content" (no tool-call blocks and no non-whitespace text; thinking-only, or
   only unparseable/truncated/bare-`parameter` tool-call markup) to the
   retryable `EMPTY_RESPONSE` failure instead of `{ kind: "completed" }`.

**Plugin-level fix (production-verified, usable today)**: following the
ecosystem path CONTRIBUTING recommends, I built a profile-level plugin
`@zhaozehao10/dsh-text-tool-call-recovery` implementing both layers through
the official `llm/stream` waterfall — no `app.asar` modification, survives app
updates. It ships 155 integration assertions (against the **real `BlockAssembler`**
and the real stream-invariant rules, using samples from both real cases), two
minimal repro scripts, and the 61-experiment replay scripts. Source + install
script: <repo/attachment link>. Its test suite can serve directly as the
acceptance criteria for the upstream fix.

**Ione hundred and ten layers of adversarial testing before releasing**: 155 integration
assertions + 28 semantic property tests + 24 boundary scenarios (through the
host's real stream-invariant validator `dsh-llm/lib/types/assistant-stream.js`（`AssistantStreamAccumulator.push` / `assembleAssistantStream`）) +
**fuzzing with 3,000 random streams** + 708 multi-turn rounds + 15 equivalence
checks + 60+ ReDoS cases. That surfaced and fixed **ninety-eight** defects in the
plugin. Several are worth upstream attention:

- **Security-relevant**: when a model *explains* the format it often puts the
  markup inside a Markdown code fence — those examples were executed as real
  tool calls (a doc showing `rm -rf` would actually run it). Text containing a
  code fence is now treated as display and never recovered.
- **Parsing blind spot**: Anthropic's official `<antml:function name=…>` /
  `<invoke name=…>` forms (no `<tool_call>` wrapper) were not parsed at all;
  they are supported now.
- **Deterministic-failure spinning**: when a model *always* returns
  thinking-only (observed with one aggregated model), the safety net turned
  every response into a retryable error → 5 consecutive failed retries, five
  wasted calls, and still no output. Now the plugin tracks consecutive empty
  responses per model: retry only on the first, pass through after that.
- **ReDoS**: pathological input (tens of thousands of repeated unclosed
  markers) made the recovery regex backtrack catastrophically — measured
  **9 seconds for 200K chars**, which on the `llm/stream` seam stalls the
  entire model stream. Fixed with a 128K scan cap, a linear fence detector,
  and linear tag counting.
- **Backticks inside argument values dropped the whole call**: when an
  argument legitimately contains backticks (Python code, Markdown, shell
  substitution ``date``), the old rule (any inline code anywhere ⇒ treat as
  display) made the entire call never execute — replaying real logs showed
  **4 real calls** lost this way. The display region is now judged by
  **marker position**: only a marker sitting inside a fence/inline code is
  skipped.
- **Multi-line backtick samples were executed (security)**: models often
  wrap a multi-line sample in **cross-line** backticks. Markdown forbids
  multi-line inline code, so the old parser did not treat it as display and
  the sample was executed as a real call (possibly a dangerous command).
  Cross-line backtick pairs now count as display — better to miss a recovery
  than to execute a sample.
- **A marker inside inline code swallowed the real call after it**: when a
- **JSON arguments were not coerced**: the same call with an XML body gets schema coercion (`"5000"` → `5000`), but the JSON body did not — so the type the tool received depended on which syntax the model chose. One argument container (`args`) was also unrecognized. Both paths now share the same coercion.
- **Attribute position was hard-coded**: legal XML such as `<function name="pwsh" id="c1">` or `<function id="c1" name="pwsh">` was not recognized, because the old regex required `name` to be the first attribute. Any call carrying an extra attribute was **completely unrecognized**. The regex now finds `name` at any attribute position.
- **A bare closing tag inside an argument value caused silent truncation and execution (security)**: with broken XML like `<parameter=command>rm -rf /tmp/x</parameter></parameter>`, the lazy regex stopped at the **first** closing tag and produced a truncated argument (`"rm -rf /tmp/x"` → `"rm -rf "`) that was then executed — potentially a half-cut dangerous command. It now treats "closing tag followed by another closing tag" as broken XML and abandons the whole recovery.
- **Coercion changed semantics**: with `number` in the schema, `Number("")` is 0, so \"not set\" became \"set to 0\" (`timeoutMs` 0 times out immediately); integers above 2^53 (snowflake IDs) silently lost precision (`…993` → `…992`) and the tool **operated on the wrong object**. Blank strings are no longer coerced and oversized integers stay strings.
- **A bare JSON fragment in prose was executed as a tool call (security, real incident)**: the model ended a report with an explanatory JSON snippet (`...done.{"command":"rm -rf /"}`) and the old version recovered it as a real call — **this actually happened on 2026-10-22 03:48 and nearly ran a root-deleting command**. Three rules now apply: the whole text must start with `{` and end with `}`, an explicit declared tool-name key is required, and an argument container key is required.
- **The error message hard-coded the block type (misleading diagnosis)**: when the empty-response safety net fired, the message always said `(only reasoning blocks)` — a text block was reported as reasoning and an all-empty payload was not distinguished. It now describes the real types (`no blocks` / `only text blocks` / `all empty`).
- **Recovered deltas disagreed with block-end**: block-end had the markup stripped but the re-emitted deltas still carried the original markup, so a streaming UI reading deltas would **flash `<tool_call><function=...>`** while the assembler saw clean text. Deltas are now re-emitted from the stripped text.
- **A malformed `block.text` could make the plugin throw**: the safety net called `text.trim()` directly, so `undefined`/`null`/a number from upstream crashed it. **Throwing inside the `llm/stream` seam aborts the entire model stream** — far worse than skipping one verdict. Nine function entries now narrow types first.
- **A null / undefined chunk could make the plugin throw**: the main loop ran `switch (chunk.type)`, so a `null` from upstream crashed it — aborting the whole stream again. Now type-guarded.
- **A Symbol field could make template interpolation throw**: `${options.model}` throws `Cannot convert a Symbol value to a string` for Symbol (the structure fuzzer hit this 83 times in 5000 runs). A new `safeString()` handles it.
- **Content already streamed to the user was lost when the stream dropped**: the plugin withholds text/reasoning blocks to keep ordering, but only flushed them on a normal end — so an exception lost even the text the user had seen. It now flushes before re-throwing.
- **No way to confirm at runtime which version was loaded**: no version marker existed, so you could only guess from file size/mtime — **this bit us once: 43,564B source vs 43,162B installed went unnoticed**. A `VERSION` constant plus a deploy-verification test now catch it.- **A bare CR line ending left a CR in the argument value**: `trimEdgeNewlines` used only `/^\r?\rn/`, missing a bare CR, so the command failed. Now `/(?:\r\rn|[\r\rn])/`.
- **The module overview was not at the top**: the `@module` block (27 lines explaining the problem, root cause and fix) had been pushed past line 39 by later additions (`VERSION`, `safeString`), so a new reader met helper functions before learning why the file exists. It is now at the top, enforced by `code-quality.mjs` (24 checks incl. 35.5% comment density, 89% JSDoc, no oversized functions).
- **Nobody verified which version the *running* process had loaded**: the plugin `apply()`s only at **process start**, so writing new files into the profile afterwards has no effect. Measured on this machine: the DSH process started at 13:45Z while the install copy was written at 01:01Z — the running process was actually on an **older build**. Added `live-instance.mjs` (10 checks) which compares the two timestamps and warns, and counts `txtcall-` markers in real session logs as proof the plugin ran in production (86 of 13,139 streams recovered).
- **Nobody had run the repro scripts**: the materials promise "5-minute repro" and "two minimal scripts", yet it was never verified. Running them revealed an **unsubstituted placeholder** (`<workspace>` inside `$d="<workspace>\deliverables"`), and that `model-side.cjs` only printed `set STEPFUN_API_KEY first` with no usage and no pointer to an alternative. Both are fixed, plus a new `repro-runnable.mjs` (25 checks) that **actually executes both scripts** and verifies the output, the guidance, the placeholders and the self-containment.
- **The source paths cited in the materials were wrong**: 3 places pointed at `dsh-llm/lib/types/invariant.js`, which **does not exist** — the real validator lives in `assistant-stream.js`. Two more cited packages were unavailable locally yet were written as exact line numbers. Now they use real paths plus symbol names, and a new `ref-verifiable.mjs` (12 checks) extracts every source reference and verifies the file, the line range and the symbol.
- **The first 36 rounds tested against a stub, never against real Cordis**: added `real-cordis.mjs` (14 checks) which loads the plugin through the actual **@deepseek-ai/cordis 4.0.5** — real `ctx.on` returns an unsubscriber (correctly unused for a "install once, lives until restart" plugin), the real waterfall recovers **1 call** and matches the stub **exactly**, loading twice into one Context does **not** double up, and the plugin touches only `ctx.on`.
- **Nobody had ever run the commands in the docs**: the English README showed `-ProfileDir <path>`, but `<` is a reserved operator in PowerShell — copying that line fails outright with `The '<' operator is reserved for future use.`. Added `doc-executable.mjs` (26 checks): every powershell block is handed to the **PowerShell parser**, YAML blocks are structure-checked, and the files/commands/`--quick`/environment-variable names referenced by the docs are verified to really exist.
- **No long-running validation**: DSH is a long-lived process, so anything in the plugin that grows over time accumulates into a failure. Added `soak-test.mjs` (12 checks): after **20,000 requests** the heap grew only **0.38 MB and actually fell to -0.01 MB over the second half** (a flat curve, not a slow climb), performance did **not** degrade (the tail ran 12% faster than the head), 500 rotating models added just **0.02 MB**, the **handle count stayed at 1 from request 200 to 2200**, the source creates **zero timers**, and the plugin still worked after 1000 exception-path runs.
- **"Other people's environment" was never verified**: the first 33 rounds all ran inside one profile. Added `host-compat.mjs` (51 checks) covering environment variables (including the detail that **Windows `process.env` is case-insensitive**), profiles whose path contains spaces or CJK characters, different ctx shapes, 6 tool-declaration shapes, 6 markup shapes, 5 `finish.kind` values, and the absence of platform assumptions in the source (no `process.platform` / `__dirname` / `require` / `fetch` / node: builtins).
- **Three rough edges on the install path** (only surfaced by actually running it): (1) the script was UTF-8 **without BOM**, so Windows PowerShell decoded the Chinese comments as ANSI → **syntax error, could not execute**; (2) the backup directory `$PSScriptRoot\.tmp` was never created → `Copy-Item` threw `DirectoryNotFoundException` and install aborted at step 1/4; (3) no LICENSE file, no install instructions for other users, and `name` was a short name mismatching the package name. All fixed, plus a new `install-experience.mjs` (33 checks) that really runs the installer inside a sandbox profile.
- **No quantification of how much the plugin actually helps**: earlier tests only proved "it does not break things" and never measured the benefit. Added `effect-quantify.mjs`: a controlled experiment over **14,408 real streams** — 13,802 streams that natively carry structured tool calls showed **0 behaviour changes** (passed through untouched), 390 text-only streams showed **0 regressions**, and the plugin actually rewrote **22 streams (0.15%)** recovering 22 calls (21 of them `step-5-preview`). The same numbers prove both that the plugin **solves a real problem** and that it **only intervenes when it must**.
- **No regression suite organized by historical defect**: the existing 63 layers were organized by *feature* (type fuzzing, prototype pollution, performance, …), so a silently broken fix might only trip a very indirect test — or none at all. Added `defect-regression.mjs` (64 assertions): **one dedicated assertion per defect D1–D32**, so breaking a fix fails the suite and points at the defect number.
- **The statistics in the materials went systematically stale**: a self-audit found 6 mismatches (`27 mutants` vs 46 actual; the real-stream total appeared as 12,747 / 13,187 / 13,398 / 13,615 / 13,582; `19/19` function coverage vs 22/22; threshold ≤10 vs ≤30; layer count 57 vs 60). Added `doc-consistency.mjs`, which **derives authoritative numbers from source** and cross-checks the zh/en docs. The real-stream total is now uniformly **14,408**.
- **A mutation-test SKIP was counted as a pass**: the exit condition looked only at `survived` and ignored `skipped` — when an anchor went stale the mutation was skipped (hence **never verified**) yet the suite still passed and coverage still read 100%. That let me **miss four rounds** of stale anchors. SKIP now fails the suite, and coverage reports two denominators.
- **The coverage scripts were not concurrency-safe**: both used **fixed in-repo dirs** for V8 coverage output and overwrote each other, making uncovered blocks jump 23 → **129** with spurious failures. Now uses per-run `mkdtempSync` dirs. Also `run-all.mjs` silently skipped suites; it now **lists them explicitly at the end** (that omission made me miss two rounds of defects).
- **Dead code referenced an undefined symbol**: the coverage check found `hasCodeFence` never executed — a leftover from the old implementation (since replaced by `computeDisplayRanges`) whose body called `isInsideDisplayRegion`, **which does not exist** (a ReferenceError waiting to happen). The whole dead chain was removed (`hasCodeFence` plus `MARKER_TAGS`, used only by it), 986 → 951 lines. Also fixed `coverage.mjs` / `branch-coverage.mjs` recursively running each other and timing out.
- **The scripts behind the strongest evidence had never been executed**: the three files under `test/long-context-replay/` produced this report's **strongest evidence** (the 419,843-token faithful replay) yet were never run in 42 rounds. All three work, but **faithful-replay defaulted to `real-tools.json` while the rebuild step writes `rebuilt-tools.json`** — following the docs would fail outright (fixed). Added `lcr-replay.mjs` (25 checks).
- **Nobody had checked the numbers in the test matrix**: the README's matrix has **66 rows**, each claiming a scale ("29 checks", "24,000 streams", …) that was never systematically verified. Added `claims-audit.mjs`: it extracts every claim and **re-runs the suite to check it** — all 39 re-run suites matched; it also caught `structure-fuzz.mjs` running only **5,000 streams** while the README claimed 24,000. Fixed by **raising the code** (3 seeds x 8000 = 24,000, 525 ms, zero crashes) rather than lowering the claim.
- **A "test" file with no assertions**: `test/real-samples.test.mjs` only printed results and exited 0 unconditionally — it would **never fail** on a regression, making it a demo rather than a test, yet it was listed in the test matrix claiming "3 real case shapes". Added **17 real assertions** (tool name, argument keys and values, finish rewriting, and that the truncated sample must NOT be recovered).
- **Another "always-passes" test**: `hardening/audit-rewrites.mjs` printed "suspicious: N" and then stopped — there was **no `process.exit(1)` path**, so even if the plugin started damaging normal replies it would still show PASS in `run-all`. Added the failure check and a new `fake-test-audit.mjs` (8 checks) that scans **all 75 test scripts** and requires each one to have either assertions or a statistics-based non-zero exit: 62 use `check()`, 13 use their own counters plus `process.exit(1)`, and **0 cannot fail**.
- **Not every defect had a regression test**: `defect-regression.mjs` covers D1–D32 only, while D33–D39 (delivery-quality defects found in rounds 33-46) are spread across dedicated suites and **nobody had checked that each defect is actually guarded**. Added `defect-coverage-matrix.mjs` (8 checks) which maps all 39 defects to their guarding suite and verifies the check exists there: **39/39 guarded**, and **D1–D30 (plugin behaviour) are all guarded by runtime assertions**.
- **Documentation structure problems**: the Chinese README had **two "9." sections** (cross-version verification / notes) with everything after misnumbered; worse, the English README has a Known limits section that the **Chinese version lacked entirely** — a real gap for the primary audience. Renumbered to 1-13, added the missing section (including **"cannot guarantee there are no bugs"**), and pinned it with `doc-structure.mjs` (32 checks).
- **Unreproducible claims were not marked as such**: the materials say "155 assertions passed on three DSH versions" — true (I did run them by hand), but your machine has exactly one dsh-llm and **cannot reproduce it**; meanwhile `cross-version.mjs` actually tests **simulated protocol differences**, not real old versions. Conflating the two misleads readers. Both versions now carry an explicit "historical record vs. what is automated here" note, and a check enforces the annotation.
- **The safety net's cross-module contract had never been checked against host code**: the plugin's deterministic-failure guard assumes that emitting `code="EMPTY_RESPONSE"` makes the host retry. The first 49 rounds only verified the plugin *emits* it — never that the **host accepts** it; if it did not, the safety net would be useless. Added `safety-net-contract.mjs` (18 checks) verifying against the host's real `error.js`/`retry-policy.js`: `DEFAULT_RETRYABLE_CODES` does contain it, the resolved policy has `maxRetries=5`, the emitted code is byte-identical to the host constant, and five near-miss spellings are rejected.
- **A mistake I nearly made: "fixing" a correct design**: I saw the early return that passes everything through when there are no tools and judged it a defect ("the safety net should still fire"). **Integration case 5 failed immediately** — the real reason is that DSH makes two tool-less internal requests: **compaction** (summarising context) and **session-title** (naming a session). For those, having no tool-call block is **normal**, and retrying would just waste tokens. **The early return was right; I was wrong.** Reverted in full, documented the rationale in the source, and pinned the decision with `passthrough-design.mjs` (10 checks).
- **A regex that was defined but never used (dead code recurrence)**: `TOOL_CALL_BLOCK_RE` appeared exactly once in the whole file — at its definition. Found by accident: while verifying whether the new baseline regression could detect behaviour drift, I deliberately broke that regex, **expected real streams to stop being recovered, and saw no change at all** — which is how I learned it was never used. It is the same class of bug as the `hasCodeFence` dead code in round 28 (where I removed that instance but built no general check). Removed the dead code and added a **general dead-code check with injection verification** to `code-quality.mjs`.
- **A blind spot in the regression suite**: `replay-real-streams` only proves nothing broke, and cannot see **behaviour drift** ("it used to rewrite these 5 streams, now only 3"). Added `baseline-regression.mjs`: pins which streams are rewritten and how into `real-stream-baseline.json` (1 KB, only the rewritten streams, fingerprint = content SHA-256) and diffs three kinds of drift: no-longer-rewritten (missed recovery), newly rewritten (false positive), and result changed. Verified by injecting a break.
- **A bug in the measurement tool itself (the most dangerous kind of silent under-reporting)**: `findFunctions` in `code-quality.mjs` found function boundaries with **naive brace counting**, but `lib/index.js` contains **18 string literals that include braces** (`"{"`, `{"command":...}`). Counting them too meant **19 functions were reported as 18**, and `parseCallBody` was seen as one line (it is 58 code lines). **No test failed** — the check was just silently weakened. Now strips strings before counting, plus a **self-check with 5 known-answer synthetic inputs**.
- **Expanded the measurement-tool self-check from 5 to 7 cases**: added two covering regex literals. The conclusion is that **the current implementation is safe** — in `/a{2,3}/` the `{` and `}` counts cancel out, so not stripping regex literals causes no error. (I tried "hardening" it by also stripping regex literals, which actually introduced an 18-vs-19 function-count error; reverted and documented why.)
- **The layer count was incremented by hand and had drifted from reality**: I bumped "N layers" by one each round, but the number of suites did not always grow by one. The claim said **87 layers** while only **83 suites** existed (a drift of 4). The old check allowed ±3, so a drift of 4 barely tripped it. Now the count must **exactly equal** the suite total, the two suites missing from the matrix were added (`interleaved-blocks`, `multi-turn`), and the tolerance was tightened from ±3 to **0** with a corrective hint in the error message. Verified by bumping the count by one and watching the check fail.
- **Two defect-table rows were merged and another was duplicated (broken Markdown table)**: an edit replaced a line but dropped its newline, so **D26 and D27 ended up on one line** (13 pipes instead of 6) — the table rendered wrongly, D27 vanished from it, and a parser found only 38 rows out of 45. The fix then introduced a duplicated D27, and D27's description contained the regex `/(?:\r\n|[\r\n])/` with an unescaped `|`. All fixed, and a new section 8 in `doc-structure.mjs` enforces table structure (5 columns, no duplicate or missing numbers, no empty cells), verified by injecting three kinds of breakage.
- **Inconsistent table column counts (two kinds)**: (1) test-matrix rows had been inserted into the defects table (five 4-column rows inside a 5-column table); (2) the English README's D26/D27 were also merged onto one line (13 pipes). Round 56 checked only the defects table and missed every other table. The check now covers **all Markdown tables** (every row in one table must have the same number of unescaped pipes), verified by injecting a 3-column row.
- **The English README's defect table lagged badly**: it was stuck at **D27** while the Chinese one had reached **D47** — 20 defects behind. English readers would conclude the project had only found 27 problems. Root cause: the structure check only inspected the Chinese file and only verified table **column counts**, never cross-language parity. Backfilled all 20 English rows and added a **parity check** (same count, same number set, substantive content), verified by deleting three rows and watching it fail.
- **A bulk replace corrupted historical records**: to keep statistics current I wrote bulk-replace scripts, and they rewrote D45's historical record from "claimed 87, actually 83, drift 4" into "claimed 83, actually 83, drift 83" — **arithmetically impossible**. The suite count in the `run-all` table was wrong too (62 vs the real 83). The root cause is that a bulk replace **cannot tell a current statistic from a number inside a historical record**. Fixed 13 places individually and added a **historical-record self-consistency check** (D45's arithmetic must hold; the run-all count must be exact), verified by injecting pollution.
- **The performance numbers were never automatically checked**: the README claims 0.018ms typical, 1.06ms at 128KB and ~1.01M chunks/s, but only `perf-baseline.mjs`'s loose ceilings (5ms/20ms) guarded them — a 5× regression would still pass while the documented figures went stale. Verified by measurement (0.018ms / 1.062ms / 1.6M chunks/s — **all match**), and `doc-consistency` section 12 now extracts and sanity-checks those three figures and asserts that `perf-baseline.mjs` keeps its thresholds and O(n²) check.
- **The LRU ordering had never been verified**: mutation testing showed that removing `emptyResponseStreak.delete(key)` left `race-conditions.mjs` **fully green** — without it the Map degenerates from LRU (evict least-recently-used) to FIFO (evict earliest-inserted). The difference only shows when a model is re-touched, and **no test covered it**. Added a "true LRU semantics" section: fill to the limit, re-touch m0, trigger eviction, and assert m0 survives while m1 is evicted — verified with two mutants that now both fail.
- **Nothing systematically checked cross-path consistency**: `parseCallBody` has **four return paths**, each passing when tested alone, but **differences between paths only surface when compared** — defect 55 was just one instance. Added `path-consistency.mjs` (26 checks): the same input through all six syntaxes, asserting that field types are **identical across every path**, match the `properties` declarations, explanatory JSON is never executed, and every coercion path still calls `coerceValue`. Verified with two mutants (revert defect 55 / break L306's coercion) — both fail.
- **The id-uniqueness test used the wrong input**: I casually used two calls with **different content**, so deleting the `-${ordinal}` suffix left the suite **fully green** — different content already hashes differently. `ordinal` exists so **identical** calls still get distinct ids. With three identical calls, removing `ordinal` now immediately fails `1/3`.
- **The "run modes" table had badly stale counts and timings**: it claimed `--quick --offline` runs 46 suites (actually 73) and `--offline` runs 50 (actually 77), with timings of "~12 s" (actually 88 s) and "~2 min" (actually 6.3 min) — **27 suites short**, making readers think quick mode covered half the suite when it covers 84%. The full row (87) was right, so the table had been touched once but only its last line. All three modes are now measured, and `doc-consistency` section 13 **computes the counts statically** from `run-all.mjs`.
- **Inconsistent Markdown line endings, after a file was briefly corrupted into 3703 blank lines**: editing the run-modes table with PowerShell line-by-line writes mishandled CRLF — the file became 4085 lines (3703 of them blank, from 760 originally), the repair left 759 double-CR sequences, and `README.md` ended up CRLF while the other 7 files were LF. All 8 files are now LF, and `doc-structure` section 11 checks line-ending consistency and blank-line bloat.
- **`PASTE-READY.zh.md` was badly stale**: it is the file the **user actually copies into GitHub**, but the generator had not been re-run — it was missing the latest 12 defects and quoted an old layer count. The user would have posted an outdated discussion, and no existing check covered that file. Regenerated, and `doc-consistency` section 14 now enforces **byte-identical** Chinese and English bodies against the source, verified with three mutants.
- **The three drafts under `community/` were never checked by any suite**: the suites were written in the era of the main materials and never extended to the drafts added later. All three are complete, carry no stale numbers and no sensitive data (`sk-xxx` is a placeholder), but their citations (`openai-completions.js`) had never been verified. `ref-verifiable.mjs` now covers **7** documents instead of 4, with an explicit list for upstream packages that cannot be verified locally.
- **The beginner guide never mentioned restarting after install, and its expected output was stale**: `SUBMIT-GUIDE.zh.md` mentioned restarting zero times (the README mentions it 9 times), yet DSH is long-running and `apply()` runs only at startup — after installing, the running process still uses the old code, so **users conclude the fix does not work**. The expected output also said "58 passed" (actually 73) and "~30 s" (actually 89 s). Added a mandatory-restart section, corrected all three figures from real runs, and `deliverable.mjs` section 9 now enforces this.
- **Nobody had ever actually verified that the materials can be committed**: rounds 1–69 checked that `.gitignore` has exclusion rules and that files exist, but never **ran git** to see whether the uploaded set is correct. An empirical `git init + add` stages **104 files**, correctly excludes the 4 drafts, includes 93 test scripts and no junk. The conclusion is right, but it had only ever been produced by hand. Now pinned as section 10 of `deliverable.mjs` (4 checks), verified by deleting a `.gitignore` rule — three layers fail at once.
- **The installer was only tested on the success path**: `install-experience.mjs` covers encoding, syntax, a real run, artefacts and patch shape — all success scenarios. What users actually hit are failures: missing profile, missing patch, re-running (idempotency). Round 72 measured all three and they are correct (18 assertions), but they had **never been verified**. Added `install-failure-paths.mjs`; must use `powershell` (5.1), not `pwsh` (7).
- **The README's eight "known limits" had never been verified**: every check verified what the plugin *does*; nobody verified what it *cannot do*. Round 73 measured each claim — other formats unparsed, argument-less calls not recovered, normal replies untouched, reasoning-only triggering the safety net, all 7 chunk types handled, cross-version evidence split into two classes — **all eight limits are accurate**. Added `known-limits-accuracy.mjs` (19 checks) turning the limit descriptions into regression assertions, so a future change that silently invalidates one gets caught rather than leaving the README lying.
- **"Uninstall" was only verified as "the README has a section"**: `install-experience.mjs` is titled "install/uninstall experience" but for uninstall it merely regex-matches the README. Round 74 walked the **whole flow** (install → delete per README → remove the directory → reinstall; 19 assertions pass) and exposed a real risk: deleting two lines with PowerShell's `Set-Content -NoNewline` **collapses the entire YAML into one line**, destroying the config. The uninstall section was rewritten accordingly: prefer restoring from the backup, show the exact fragment to delete, and **explicitly warn against rewriting the file with PowerShell**.
- **Different sections of the README contradicted each other**: earlier checks compared the README against the source, the English version and the discussion, but **never against itself**. Two places were wrong: line 723 said "maps 48 defects" (there are 66) and line 765 said "86 layers" (there are 90). The English README was correct, showing the Chinese copy drifted through piecemeal editing. Fixed, and `doc-consistency` section 15 now enforces **internal consistency** with a reverse check so it cannot pass vacuously.
- **The internal-consistency check covered only the README, and its historical-marker heuristic was incomplete**: the round-75 check inspected only the README although `discussion`/`PASTE-READY` also carry "N layers" claims, and the heuristic lacked "existing / at the time / previously" — line 113's "the **existing 86 layers** were organised by feature" is a historical statement but was misreported as current. The check now spans three documents with a completed heuristic.
- **Structure checks covered only 4 of 8 documents**: a coverage matrix (8 documents × 7 check classes) showed structure/line-endings at 4/8, number consistency 5/8, executability 4/8. The biggest gap was `SUBMIT-GUIDE.zh.md` (a beginner manual) with no structure check. Added `doc-structure` section 12 covering all 8.
- **Every table in the Chinese README rendered wrong**: the 68-row defect table was split into **56 mini-tables by 55 blank lines**, and the 75-row test matrix 75 ways — Markdown needs contiguous rows, so **all Chinese-README tables rendered incorrectly** on GitHub. The English README was fine. Found because section 9 reported "164 tables", implausible for a README with ~7; investigating revealed 160 single-row "tables". Removed 153 blank lines (160 → 7), and added `doc-structure` section 13.
- **The README had four classes of rendering defect**: (1) **35 blank lines inside code blocks**; (2) **8 runs of consecutive blank lines**; (3) **four test-matrix rows spliced into the installation section** — a reader following the install steps suddenly hit four rows of test matrix, **the worst of the four**; (4) D3's bare triple backtick interfered with fence detection. All fixed (634 → 597 lines), and `doc-structure` section 14 now runs 6 rendering checks across 8 documents — **the new check immediately caught six more problems in three other documents**.
- **The materials never verified that files cited in the documents exist**: the first seven sections of `ref-verifiable.mjs` only checked host-source references, not repository file paths. **All 381 path references resolve** (16 exact, 124 abbreviations, plus external dependencies and runtime artefacts), but this had never been verified. Added section 8 to check each one, allowing three classes that look absent but are correct (path abbreviations, external dependencies, runtime artefacts).
- **The effectiveness of the critical suites had never been proven**: only **7 of 26 (27%)** carried mutation evidence. A check that can never fail is worse than none. This round injected breakage into 14 suites without evidence: **12 were caught**, 2 were outside their remit. **Conclusion: "no record" does not mean "ineffective" — the missing piece was documented evidence.** Added `meta-health` section 8 maintaining a `VERIFIED` list (19 suites, each annotated with the injection used and the expected failure).
- **Nothing verified A/B two-path consistency for recovered calls**: the 88 random streams in `differential.mjs` use **native** tool-call blocks (`argumentsDelta` fixed to `"{}"`), so they **never cover calls recovered by the plugin**. Under the host's A (live `BlockAssembler`) and B (persisted `Accumulator → expand → assemble`) paths a recovered call must agree — otherwise what the user sees live differs from what they see after a refresh. Only four suites perform a full A/B comparison and only `host-validator` mentions `txtcall`, without asserting consistency. Added `recovered-ab-consistency.mjs` (27 checks); it also revealed that **`BlockAssembler` uses only block-end and ignores deltas**, so "accumulated deltas equal block-end" needs its own check.
- **"Known limits" described a format the plugin explicitly supports as "not parsed"**: the text said "other XML dialects are not parsed", yet the plugin **explicitly supports** `<invoke name=…>` (dedicated `INVOKE_NAME_ATTR_RE` at lib L104-105). Measured: `<invoke name="pwsh">…</invoke>` recovers **one call**. Readers would wrongly conclude Anthropic-style markup is unsupported. Reworded to name the three supported markup families, with three new checks preventing the vague phrasing from returning.
- **`package.json` was missing six fields that matter for an open-source package**: `repository` (no source link on npm), `keywords` (searching npm for `deepseek`/`cordis` **cannot find it**), `bugs` (users do not know where to report), `homepage`, `author`, `engines` (the README requires Node 16.9+ but the package did not declare it). All added, plus `package-contract.mjs` (23 checks) covering required fields, metadata, **really resolving the exports contract**, **exports isolation**, and byte-identical `npm pack` output.
- **The README had no Node version requirement**: `package.json` declared `engines.node` and SUBMIT-GUIDE said "requires Node 16.9+", yet the **README — the document users start from — never said it**, so readers only found out after installing. Added to the install prerequisites (both languages), and `package-contract.mjs` now checks the two agree.
- **The placeholder instructions covered one spot while there are five**: SUBMIT-GUIDE step 5 dates from round 60, when only PASTE-READY had placeholders; round 83 added four to `package.json` **without revisiting the instructions**. A user following it would leave those four untouched, so the npm page's Repository/Homepage/Issues links would all 404. Rewrote step 5 (PASTE-READY ×1 + package.json ×4, with a mapping table, an example, and **a verification command**), and added section 11 to `deliverable.mjs` (4 checks).
- **The effect figures did not add up (13,802 + 390 ≠ 14,408)**: the three numbers came from **different points in time** yet sat in one sentence, so readers take them as a complete classification from a single run. Since `hasNativeToolCall` is a **binary test**, the disjoint classification must be exhaustive — measured **216 short**, so the three cannot all be true. Reworded to "a same-run snapshot" with a scope note, and added an **arithmetic-consistency check** to `claims-audit` (it previously only checked "order of magnitude > 10000", never exact values).
- **The run-mode table underestimated runtime by nearly 60%**: the README said `--offline` takes "about 6 minutes" while measurement gives **82 suites / 568.6 s = 9.5 minutes**, 58% more. Elapsed time **cannot be derived statically**, so round 67's static check could not catch it. Corrected in both languages, and `doc-consistency` section 16 now requires suite counts to increase, **timings to increase too**, and the timing ratio not to be badly underestimated.
- **Only one growing figure was marked as a snapshot**: round 85 annotated one place and missed six. Round 86 ran **all nine suites needing real logs** in full (for 20+ rounds only `--quick --offline` had been run), and measurement shows real streams grew from **14,408 to 15,675** (+8.8%). Five places were annotated, line 596's vague "14 thousand" became precise, and a growth note was added ahead of the test matrix in both languages, guarded by `doc-consistency` section 17.
- **Six always-true assertions (`ck(..., true, ...)`), three in `real-cordis`**: the worst was L218 `ck("插件不抛在 dispose 阶段", true, "")` — measurement shows **Cordis 4's Context has no `dispose` method**, so that assertion was lying. All were replaced with real checks (L67 asserts `loadError === null`, L187 asserts the recovered count is 1–2, L218 honestly records that the scenario is untestable here and adds a testable `unsubscriber` substitute), and `fake-test-audit` section 3 now scans 90 test files. **Also found**: `ctx.on` is a Cordis Proxy-backed dynamic property, not on the prototype chain.
- **"All 92 suites pass" included one profiling tool that can never fail**: `perf-profile` only calls `console.log` and has no failure path, yet `readdirSync` picked it up and counted it as passing. Measured: `92 = 91 verification + 1 profiling`. Reclassified honestly in both languages, with confirmation that performance regression is **not** missing (`perf-baseline` carries 7 assertions). `meta-health` section 9 now scans for never-failing suites and requires them to be documented in the README.
- **The table check used a structural heuristic instead of the real CommonMark rule, covering only 2 of 8 documents**: earlier rounds matched "a line starting with `|` is a table row", but the spec requires **header + delimiter** — `|` blocks without a delimiter row never render as tables, yet the old check counted them as passing. Under the real rule there are **22 tables and 48 fences across 8 documents** (section 9 checked 10 tables, section 13 checked 17). Added `doc-structure` section 15 to re-verify all 8 documents under the real rule.
- **Major: for 89 rounds `dsh-llm/lib/types/invariant.js` was misjudged as "missing"**: the root cause is that the **local test copy was incomplete** (missing this file) and every check ran against it. Round 90 parsed `app.asar` directly (174 MB) and found `lib/types/` contains **14 `.js` files including `invariant.js` (4,401 bytes — the `validateStream`/`validateIndex`/`validateDelta` protocol validator)**, while the local copy had 13. The entire "falsified" conclusion rested on a **false premise**. Restored the file from the asar, corrected defect 37, rewrote section 5 from "falsify" to "verify existence", and added `meta-health` section 10 to check copy completeness straight from the asar. **Also verified**: the asar's `dsh-llm` is 0.2.1-rc.2 with `lib/index.js` at 105,272 bytes and an identical SHA256 — so every other verification did run against real code.
- **The plugin output had never been verified against the host's own seven stream-protocol rules**: the first 90 rounds only checked that `BlockAssembler` assembles and `Accumulator` does not crash, never that all seven rules in the host's `invariant.js` hold. After round 90 found that file really exists, round 91 extracted **R1–R7** (safe index / delta type matching / nothing after finish / no repeated start / end requires open / end type must match / no unclosed blocks at finish). **These seven are what the host actually enforces.** Measured: the plugin satisfies all of them across **7 shapes**; added `invariant-conformance.mjs` (19 assertions, including a validator self-test).
- **I hand-rewrote the host's validation rules, introducing two omissions and one over-strict rule**: round 91 read the rules out of `invariant.js` and re-implemented them in JS, and a rewrite inevitably drifts. Round 92 compared line by line against the host's 74 lines and found: **R8 `usage` may appear only once** (missing), **R9 the stream must end with a terminal `finish`** (missing), and **R10 an error/aborted `finish` is allowed to leave blocks open** (the hand-written version was too strict and would flag the host's own legal streams). Switched to **extracting `validateStream` from the source and evaluating it** — the host's own implementation does the judging, so the rules can never drift. Verification grew from 11 to **21** checks.
- **The real-data suites (every real stream) were using a hand-written validator**: three copies of the stream-protocol validator existed (`health-check` L70, `replay-real-streams` L34, and the host's `invariant.js`). Line-by-line comparison showed `health-check`'s copy **was missing R8 (duplicate `usage`) and R9 (no terminal `finish`)** — and that suite runs over **every real stream**. Created a shared `_host-invariant.mjs` that extracts the host's real `validateStream`; both suites now prefer the host implementation with the hand-written copies as fallbacks. **After the change, all 全部 real streams pass the host's real validator.**
- **The runtime version-lag check compared the earliest process instead of locating the host process that actually loads the plugin**: one DSH spawns **6 processes**, and **only the one with `--expose-internals ... dsh-desktop-host` actually loads the plugin**. A rough comparison used the earliest main process; the conclusion was coincidentally right (1043 minutes late) but the **evidence was wrong** — if a restart changes the main process while the host process stays, it would misjudge. Added `runtime-process-check.mjs` (8 checks) that uses `Get-CimInstance` to read full command lines, pinpoint the host process and assert there is **exactly one**. **Also**: three always-true assertions in the new suite were caught immediately by `fake-test-audit` and fixed.
- **The README lacked a top-down summary**: it grew out of **investigation notes**, written in the order "I found a problem → traced the cause → built a fix" rather than around reader needs. The first three sections (98 lines) are symptom plus root-cause investigation, with the **install entry at L109**. Added a "30-second summary" block (bilingual, covering problem/install/restart/verify/navigation), moving the **install entry from L109 to L15**, and added `deliverable` section 12 (7 checks) requiring the summary within the first 40 lines and the install command within the first 50.
- **Two internal anchors in the TL;DR were dead links**: the anchors were hand-written from **the heading text at the time**, and headings later changed (defect count 89→90; `## Verify` slugs to `verify`, not `verification`) without the anchors following. **This class of bug is nearly invisible** — the link text is correct and only a click reveals the 404. Fixed both, and added `deliverable` section 13: **rebuild every heading anchor under GitHub's slug rules**, verify each link resolves, with a reverse check requiring at least 5 anchors. Measured: all 9 anchors resolve.
- **`package.json` carried full npm metadata but never said whether to publish**: `repository`/`homepage`/`bugs`/`keywords`/`engines` **only matter when published**, yet the README only teaches clone-and-script and SUBMIT-GUIDE never mentions npm. A reader asks "should I `npm install`?" — while the npm tarball holds **only five files** and excludes `test/` and the install script, so following the README would fail. Added `private: true` plus bilingual notes, and `package-contract` section 7 (5 checks).
- **Two encoding traps in the install script, both hitting the user on their very first command**: (1) the script read `cordis.patch.yml` with a bare `Get-Content -Raw` and wrote it back with `WriteAllText` — PS 5.1 on a Chinese locale decodes BOM-less UTF-8 as GBK, so **non-ASCII in the user config was permanently corrupted** (measured: 书生专用 became 涔︾敓涓撶敤); (2) the **script itself** was BOM-less UTF-8 with 1,173 non-ASCII bytes, so PS 5.1 decoded the source as ANSI, broke byte boundaries, swallowed string quotes and produced **three syntax errors — the script would not run at all**. Fixed with explicit UTF-8 I/O plus BOM-state preservation, and added a UTF-8 BOM to the script. `deliverable` section 14 (6 checks) guards this, including **actually running `powershell -File`**.
- **The install script's failure paths dumped raw .NET stacks**: the first 98 rounds only exercised the happy path. With `cordis.patch.yml` set read-only, the user sees a screenful of `CategoryInfo : PermissionDenied` / `FullyQualifiedErrorId` — learning neither what happened, nor how to fix it, nor whether the config was damaged. Added `try/catch` around backup, copy and write-back with **actionable** guidance (read-only → clear the flag; in use → quit DSH; disk full → free space) and an explicit statement of the **current state** ("nothing modified, safe to retry"). `deliverable` section 15 (10 checks) actually runs four scenarios.
- **The install script's backups grew without bound (1,114 files measured)**: every run writes a timestamped backup and **never cleans up**. Each is only 0.3 KB, but the count only grows, and thousands of near-identical files actually make it harder to recover the config from a particular moment. Added **backup rotation** (keep the newest 10, deleting only files this script created) and fixed the ordering — rotation must run **after** the current backup is written, otherwise 11 files remain. Also verified three path scenarios never tested before: **spaces, Chinese characters, and the `-ProfileDir` argument** — all work. `deliverable` section 16 (11 checks) actually runs them.
- **The manual-install path was never tested and omitted key steps; the English README lacked it entirely**: the README offers both scripted and manual installs, yet all 100 rounds tested only the scripted one. Measured: (1) the Chinese manual steps had only two steps and **never mentioned** restart/backup/self-check, so a manual installer would not restart and would conclude "nothing happened"; (2) the **English README had no manual section at all**; (3) yet both outputs are **equivalent** (identical file trees, semantically identical patches), so the **manual path works** — the defect was documentation. Expanded the Chinese steps to six, added a full English section, and added `deliverable` section 17 (15 checks) that actually performs both installs and compares them.
- **The "temporarily disable" switch was never verified, and the docs mislead in two ways**: (1) it honours **only the exact string `"0"`** — `false`/`off`/`""`/`"00"`/`"0 "` **do not disable it** and **raise no error**, so a user believes it is off while it is still active; (2) the documented `$env:X = "0"` is **useless for an already-running DSH** — variables are copied at process start, so a user-level variable plus a full restart is required. The implementation is correct (`apply()` returns early on `"0"`); the defect was documentation. Rewrote the section bilingually and added `env-disable-semantics.mjs` (19 checks) covering nine semantics plus six documentation checks.
  reply first quotes ``<tool_call>`` to explain the format and then makes a real
  call, the regex paired the opening marker inside inline code with the real
  call's closing marker into one cross-region block, dropping the real call
  as display content. Pairs are now scanned manually: an opening marker
  inside a display region is skipped and scanning continues.

The others: prose mentioning markup was misjudged as "markup-only" and
turned a valid reply into an error; `usage` ordering when `block-end` is held;
malformed input could throw inside the seam and abort the whole stream; and
state leakage across multi-turn sessions. All thirteen are documented in the
plugin README so an upstream implementation can avoid them.

**Verify the harness-side bug in 5 minutes** (no specific model needed, fully
local and deterministic):

```bash
node harness-side.mjs
```

Self-contained, zero dependencies. It replays the exact StreamChunk sequence
the adapter produces for such a response through a `BlockAssembler`
equivalent, then applies the agent loop's decision rule:

```
tool-call blocks = 0
agent loop verdict: {"kind":"completed"}
=> turn ends silently: no error, no retry, no tool execution.
```

**Model-side repro** (needs the target model's API key; intermittent):

```bash
STEPFUN_API_KEY=sk-xxx node model-side.cjs 20   # N requests, classified
```

**Versions**: reproduced and still unfixed on **all three** of
`0.2.0-rc.2`, `0.2.1-rc.1`, and `0.2.1-rc.2` (all win32 x64).
Identify your version by the "File version" property of
`DeepSeek Harness.exe` or the `@deepseek-ai/dsh-llm` package version
inside `resources/app.asar` — the `version` file in the install
directory is the installer version (measured as `44.7.0`) and does not
match the app version. Correspondingly `@earendil-works/pi-ai`
0.87.1 / 1.1.0 / 1.1.0. The plugin loads and passes its full suite
(155/155) on all three.
