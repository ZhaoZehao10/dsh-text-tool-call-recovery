# 问题反馈：step-5-preview 间歇性把工具调用以 XML 文本形式放回 `reasoning_content`，`tool_calls` 为空、`finish_reason=stop`

## 一、现象

在使用阶跃星辰 `step_plan` 端点（`https://api.stepfun.com/step_plan/v1/chat/completions`）调用 `step-5-preview` 模型时，**间歇性**出现以下行为：

- 请求中正常传入了 `tools`（标准 OpenAI `function` 格式，`strict:false`），未传 `tool_choice`，`stream: true`；
- 响应中 **`tool_calls` 为空**、`finish_reason` 为 `"stop"`；
- 工具调用被写成 **XML 文本放在 `reasoning_content`（思考流）里返回**，形态为 Qwen/Hermes 风格：

  ```
  ...思考文本... [tool_call 开始标记]
  [function=pwsh 开始标记]
  [parameter=command] ...多行命令... [parameter 结束标记]
  [parameter=description] ...描述... [parameter 结束标记]
  [function 结束标记]
  [tool_call 结束标记]
  ```

- 复现率不稳定：某次实测中约 9 分钟窗口内 5 次调用失败 3 次；同一会话中相邻 11 秒的两次请求一次成功（结构化 `tool_calls`）一次失败（XML 文本）。换用其他时段则长时间全部正常。提示词简单（单工具 + 明确要求调用）时同样能复现，说明与提示词复杂度无必然关系。
- **同类现象的其他佐证**：我们另观测到经聚合网关转发的其他模型（deepseek-v4.1-flash-max）也出现过 XML 文本形式的工具调用（Anthropic 风格 `parameter name=键`，且被截断）。这说明“模型把工具调用写成文本”在不同模型/链路上都会发生，值得作为一个通用问题推动修复或给出官方规避指导。

## 二、影响

任何遵循 OpenAI 兼容协议的客户端都只认 `tool_calls` 字段。这类响应会被客户端解析为“模型只思考、没有行动”，agent 类应用表现为**思考一会儿后静默卡住**（不执行工具、不报错、不重试）。我们已在多个客户端形态上验证（含 DeepSeek Harness 的 pi-ai openai-completions 解析路径，以及经聚合网关转发的链路）。

## 三、已排除的因素（61 次受控实验）

用完全相同的请求形状直连该端点做了 61 次对照，全部返回结构化 `tool_calls`（零复现）：

| 变量 | 次数 | 结果 |
|---|---|---|
| 无 `tool_choice`（默认形状）/ 显式 `tool_choice: "auto"` | 8 + 4 | 全部结构化 |
| 流式 / 非流式 | — | 均结构化 |
| 真实 40 工具定义 + 中文任务提示 | 8 | 全部结构化 |
| 含“工具调用→工具结果”的多轮对话 | 8 | 全部结构化 |
| `step_plan/v1` 端点 vs 标准 `/v1` 端点 | 12 | 全部结构化 |
| 对失败请求上下文的忠实重放（重建误差 0.04%，42 万 token） | 21 | 全部结构化 |

即：请求形状、`tool_choice`、端点选择、**上下文长度（42 万 token 精确重放）均不触发**；失败是**逐请求的间歇性行为**，且我们观察到**时序上聚集**（某时间段内连续失败，之后自行恢复）——这一点也请协助确认是否为服务端在该时段的异常。

## 四、想问清楚的问题

1. 这是 `step_plan` 端点**自有的 Agent 工具调用格式**（即设计行为），还是模型/服务端的缺陷？如果是有意设计，文档在哪里？端点宣称 OpenAI 兼容，但该形态无法被任何标准客户端消费。
2. 如果是缺陷：能否修复？修复时间表？
3. 无论哪种：是否有**请求参数**可以强制模型走结构化 `tool_calls`（例如某个 `tool_choice` 取值、`parallel_tool_calls`、或 step_plan 特有的参数）？我们在客户端侧可以先加上作为规避。
4. 客户端侧的建议规避方式是什么？（我们目前的规避是：解析 `reasoning_content` 中的 XML 工具调用标记并当普通工具调用执行——但这只是治标。）

## 五、最小复现

附件脚本 `model-side.cjs`（Node ≥ 18，无第三方依赖）：

```bash
STEPFUN_API_KEY=sk-xxx node model-side.cjs 20
```

用一个简单工具（`get_weather`）+ 明确要求调用的提示连打 N 次，对每个响应分类：结构化 `tool_calls` / XML-in-`reasoning_content`。命中率随时间窗口变化，建议 N ≥ 20；若一次未命中，换时段或加大 N 再试（我们观察到明显的时段聚集性）。

复现输出示例（失败样本， reasoning_content 尾部）：

```
[7] finish=stop tools=- reasoningLen=453 | **BUG: XML 工具调用在 reasoning_content，tool_calls 为空，finish=stop**
    ---- reasoning_content 尾部 400 字符 ----
    ...
    先看模块内部怎么用：[tool_call 开始标记]
    [function=grep 开始标记]
    [parameter=include]*.py[/parameter]
    [parameter=path]<workspace>/src/models/module.py[/parameter]
    [parameter=pattern]parameter_name[/parameter]
    [function 结束标记]
    [tool_call 结束标记]
```

## 六、环境信息

- 模型：`step-5-preview`（provider：step_plan，`https://api.stepfun.com/step_plan/v1`）
- 协议：OpenAI Chat Completions 兼容（`stream: true` + `stream_options.include_usage`）
- 请求要点：`tools` 为标准 `{"type":"function","function":{name,description,parameters,strict:false}}` 数组；无 `tool_choice`；无 `temperature`/`max_tokens`
- 观察时间：2026-10-10 凌晨时段集中出现 3 次失败（此前此后均正常）

如需完整请求/响应样本（含完整 reasoning_content），我们可以提供脱敏后的完整记录。这个问题对 agent 类应用影响很大（静默失败最难排查），希望能推动修复或给出官方规避方案，谢谢！
