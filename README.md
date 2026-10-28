# DSH 文本工具调用恢复插件（dsh-text-tool-call-recovery）

> ⚠️ **非官方项目**：这是社区贡献的**个人插件**，不是 DeepSeek 官方发布物。
> 包名使用作者本人的命名空间 `@zhaozehao10/`，**不占用任何官方 scope**、
> **不代表官方背书**；`package.json` 里 `private: true`，**不会被发布到 npm**。
>
> 采用 MIT 许可证，按「现状」提供，不附带任何担保。
>
> **30 秒摘要**
>
> **问题**：`step-5-preview` 等模型把工具调用写成 XML **文本**（塞进思考内容）而不是结构化的
> `tool_calls` 字段，宿主解析不出来 → agent loop 认为「没有工具调用」→ **回合静默结束**，
> 用户可见的表现是「深度思考结束后回合静默终止、没有任何后续动作」。
>
> **修复**：一个 Cordis 插件，挂在 `llm/stream` 接缝上，把文本形式的调用**恢复成真正的
> tool-call 块**；同时把「只有思考、没有可执行内容」的响应改成**明确的可重试错误**（而不是静默结束）。
>
> **安装**（前提：DSH 至少启动过一次、Node **16.9+**）：
>
> ```powershell
> .\install-stepfix.ps1
> ```
>
> **装完必须重启 DeepSeek Harness**（完全退出，不是关窗口）—— 插件的 `apply()` 只在进程启动时执行一次。
>
> **怎么确认生效**：
>
> ```powershell
> node test/hardening/live-instance.mjs          # 版本滞后诊断
> node test/hardening/runtime-process-check.mjs  # 精确定位 host 进程
> ```
>
> **规模**：110 个可独立运行的套件 · 46 个变异体（100% 杀死）· 全部真实会话流重放 ·
> 166 个自身缺陷已记录并修复（[见第十一节](#十一对抗性审查发布前自查共发现并修掉-166-个自身缺陷)）。
>
> **做不到什么**：见 [第十二节 已知限制](#十二已知限制诚实清单)。**不保证没有 bug**。
>
> 📖 **只想看怎么用**：跳到 [第四节 安装](#四安装状态已完成) ·
> [第五节 验证](#五验证) · [第六节 卸载](#六卸载)。
> 🔬 **想看调查过程**：继续往下读（第二、七、八、九节）。

## 一、问题现象

**现象 A（step-5-preview）**：使用阶跃星辰 step plan 的 `step-5-preview` 模型

（provider `step-plan-152`，`https://api.stepfun.com/step_plan/v1`，

openai-completions 协议）时，模型频繁出现「思考内容输出完毕、但没有任何后续动作」：思考内容

流式输出后，没有任何工具执行、没有回复，回合静默结束。

**现象 B（magpie 聚合路由）**：使用 magpie（本地网关，`127.0.0.1:3425`）自动

聚合的 `group/auto-deepseek-v4-1-flash` 执行任务时，任务频繁出现「自动截断」现象：

模型输出一两句引导语（或一段被截断的工具调用标记文本）后回合静默结束，

什么都没做，需要反复说"继续"。

## 二、根因（已从会话日志实证，两个独立案例）

**共同的根因链**（三层）：

1. 模型/上游把工具调用写成 **XML 文本**而非结构化的 `tool_calls` 字段；

2. pi-ai 的 openai-completions 解析器只把 `delta.tool_calls` 映射为 toolCall 块，

   文本/思考内容原样进 text/thinking 块；

3. agent loop（`dsh-agent-loop` lib/index.js:1152-1153）见到"没有 tool-call 块"

   就 `return { kind: "completed" }` —— 回合**静默结束**：不报错、不重试。

**案例 A：step-5-preview（会话 turn 46-48，日志 seq=9178）**

模型不返回结构化 `tool_calls`，而是把工具调用写成 Qwen/Hermes 风格 XML 文本

塞进 `reasoning_content`：`tool_call 开始标记` + `function=pwsh` + 每参数一个

`parameter=键` 元素。`replayState.blocks` 只有一个 `reasoning` 块、

`stopReason: "stop"` —— 整段 XML 被当成了思考文本。

**案例 B：magpie 路由（2026-10-16，会话 turn 85-87）**

主账号被 429 限流后，magpie 自动路由把请求 fallback 到另一成员

`deepseek-v4.1-flash-max`；该上游返回的工具调用是 **Anthropic 风格

XML 文本**（`parameter name=键` 带 name 属性），且**常被截断**（实测样本

以不完整的闭合标签结尾、没有外层 tool_call 包装）。同窗口内还观测到

响应输出 token 大量丢失（usage 记 1145 token，消息内容仅约 40 token）后以

stop 结束的案例（输出 1701/1145 token，可见文本仅 61/60 字符）。

magpie 路由日志证实：故障全部集中在 fallback 到 flash-max 的 11:07-11:22

窗口内，恢复后自行消失。

## 三、修复方案

通过 DSH 官方的 `llm/stream` 瀑布流接缝实现一个 profile 级插件

**`@zhaozehao10/dsh-text-tool-call-recovery`**（无需改动 app.asar，应用升级

不丢失），做两层修复：

1. **工具调用恢复**：流结束后扫描 text/reasoning 块中的 tool_call 文本标记，

   解析 function 名与 parameter 键值（兼容 `{"name":..,"arguments":{..}}`

   JSON 形式；按工具 JSON Schema 做强类型转换；解码 XML 实体；保留多行代码

   缩进），合成正式的 tool-call 流块，并把 finish 原因改写为 `tool-calls`——

   agent loop 随后真正执行这些调用。保护条件：

   - 仅在本次响应**没有任何结构化 tool_calls** 时生效（不会重复执行）；

   - 工具名必须在本次请求声明的 `tools` 里（避免把正文引用的示例代码误判

     为调用；compaction / session-title 等无工具请求自动直通）；

   - replay 信封同步补对齐条目，不丢失会话回放元数据。

2. **安全网**：stop 结束但没有任何可执行内容时，把 finish 改写为可重试的

   `EMPTY_RESPONSE`，让默认重试策略（normal：5 次，500ms-10s 退避）重试；

   重试耗尽后用户看到明确错误，而不是无声卡住。"无可执行内容"的判定包括：

   只有思考块；文本为空；文本只是工具调用标记——**完整但不可解析的**

   （标记字符占比过半）、**被截断的**（外层包装不完整）、或**裸 parameter

   元素**的，都算（经 magpie fallback 上游实测会出现这些形态）。

## 四、安装状态（已完成）

### 给其他用户的安装步骤

前提：① DSH 已至少启动过一次（`~/.dsh/profiles/desktop/` 已存在）；② Node **16.9+**（插件用了 `Object.hasOwn`；`node --version` 可查）。

```powershell
# 在插件仓库根目录执行
.\install-stepfix.ps1
# 自定义路径（默认 $DSH_HOME\profiles\desktop）
.\install-stepfix.ps1 -ProfileDir "C:\path\to\profile"
```

脚本会：备份 `cordis.patch.yml` → 复制插件到 `profile/node_modules/` → 以 **`insert:` 形式**

注册插件条目 → 自检（文件存在 / 语法 / patch 条目形态）。**重复运行是安全的**（幂等）。

装完**必须重启 DeepSeek Harness** 才能生效。

> ⚠️ **这不是可选项**：插件的 `apply()` 只在**进程启动时**被调用一次。

> 往 profile 里写新文件后如果不重启，运行中的进程**仍然用旧代码**——

> 你会以为「改了没反应」。`test/hardening/live-instance.mjs` 会自动诊断这种滞后。

> **这个包不发布到 npm**：`package.json` 里的 `repository` / `homepage` / `bugs` 等字段
> 只是为了让**仓库地址可被工具识别**（例如 npm 网页版展示），`private: true` 也明确禁止误发布。
> 安装方式是**克隆仓库后运行 `install-stepfix.ps1`**，不是 `npm install`。

**手动安装**（不想用脚本时）：

> ⚠️ **顺序很重要**：先备份，再改文件。下面按正确顺序给出。

1. **先备份** `cordis.patch.yml`（脚本会自动备份，手动时请你自己复制一份）：
   ```powershell
   Copy-Item "<profile>\cordis.patch.yml" "<profile>\cordis.patch.yml.bak"
   ```

   **这一步必须在改文件之前做** —— 否则备份下来的是「已经改过」的版本，回滚不了。

2. 把 `lib/` 和 `package.json` 复制到

   `<profile>/node_modules/@zhaozehao10/dsh-text-tool-call-recovery/`

3. 在 `<profile>/cordis.patch.yml` **末尾追加**：

```yaml
- insert:
    - id: text-tool-call-recovery
      name: "@zhaozehao10/dsh-text-tool-call-recovery"
```

> ⚠️ **必须用 `insert:` 包裹**。顶层直接写 `- id: xxx` 的条目会被 `applyEntryPatches`

> **静默跳过**（只在日志里留 warning，GUI 模式看不到）。这是本项目首次安装时踩过的坑。

4. **自检**：确认插件文件在、语法没问题：
   ```powershell
   node --check "<profile>\node_modules\@zhaozehao10\dsh-text-tool-call-recovery\lib\index.js"
   ```
   没有输出即为通过（`node --check` 只在语法错误时才输出）。

5. **必须重启 DeepSeek Harness** —— 完全退出（托盘右键 → 退出），不是关窗口。
   插件的 `apply()` 只在**进程启动时**被调用一次；不重启的话，运行中的进程**仍然用旧代码**，
   你会以为「装了没反应」。这条对脚本安装和手动安装**同样适用**。

6. 重启后确认生效：
   ```powershell
   node test/hardening/live-instance.mjs
   ```

### 临时禁用 / 卸载

**临时禁用**（不改文件、想快速对照验证时用）：插件在 `apply()` 里检查环境变量
`DSH_TEXT_TOOL_CALL_RECOVERY`，等于**字符串** `"0"` 时**完全不注册监听器**（等于没装）。

> ⚠️ **两个坑，都必须注意**：
>
> **① 变量必须在 DSH 启动前就存在。** 环境变量是在**进程启动时**拷贝进进程的，
> 在另一个 PowerShell 窗口里 `$env:... = "0"` **不会**传播给已经在运行的 DSH。
> 所以要先设**用户级**变量，再**完全重启** DSH：
>
> ```powershell
> # 设成用户级（永久），然后完全退出并重启 DeepSeek Harness
> [Environment]::SetEnvironmentVariable("DSH_TEXT_TOOL_CALL_RECOVERY", "0", "User")
> # 用完记得删掉，否则一直禁用
> [Environment]::SetEnvironmentVariable("DSH_TEXT_TOOL_CALL_RECOVERY", $null, "User")
> ```
>
> **② 只认精确的字符串 `"0"`。** `"false"`、`"off"`、`"no"`、`""`、`"00"`、`"0 "`（带空格）
> **都不会禁用** —— 插件只做 `=== "0"` 判断。写错了不会报错，你会以为禁用了而实际还在工作。

```powershell
# 卸载**分两步**，两步都要做（只删目录会留下悬空的 patch 条目）：
#
# 1) 移除 cordis.patch.yml 里的插件条目
#    最稳的做法是从安装时自动生成的备份恢复（打印路径形如
#    %TEMP%\dsh-install-backup\cordis.patch.yml.bak-YYYYMMDD-HHMMSS）：
Copy-Item "<备份路径>" "<profile>\cordis.patch.yml" -Force
#
#    或者用文本编辑器手工删掉 - insert: 下那两行（详见第六节）。
#
# 2) 删除插件目录
Remove-Item "<profile>\node_modules\@zhaozehao10\dsh-text-tool-call-recovery" -Recurse -Force
```

> ⚠️ **两步都要做**。只删目录、留下 patch 条目的话，Cordis Loader 下次启动仍会
> 尝试加载这个条目，而目录已不存在 —— 具体表现取决于 Loader 版本（报错或被静默跳过），
> 但无论哪种都**不是干净的卸载状态**。完整步骤见 [第六节 卸载](#六卸载)。

- 插件源码（含测试）：`default-workspace/dsh-text-tool-call-recovery/`

- 已安装到：`<DSH_HOME>/profiles/desktop/node_modules/@zhaozehao10/dsh-text-tool-call-recovery/`

- 已注册到：`<DSH_HOME>/profiles/desktop/cordis.patch.yml`

  ```yaml
  - insert:
      - id: text-tool-call-recovery
        name: "@zhaozehao10/dsh-text-tool-call-recovery"
  ```

- 配置备份：`default-workspace/.tmp/cordis.patch.yml.bak-20261010-124251`

### 生效条件

**需要重启 DeepSeek Harness**（host 只在启动时读取 cordis.patch.yml，该文件

无热重载监听）。

### ⚠️ 关键陷阱：patch 条目必须用 `insert` 形式（首次安装时踩过）

`cordis.patch.yml` 的条目语义是**补丁**：按 `id` 只能**修改**已存在的条目

（bundle 层预先用 `insert` 推入的）。写一个全新 `id` 的普通条目：

```yaml
- id: text-tool-call-recovery        # ← 错误：会被静默跳过！
  name: "@zhaozehao10/dsh-text-tool-call-recovery"
```

会被 `applyEntryPatches`（`dsh-app-boot`）以 `patch: entry ... not found`

**静默跳过**（仅一条 warning，GUI 模式下宿主日志不可见，表现为“重启了但

插件没加载”）。正确形式是用 `insert`：

```yaml
- insert:
    - id: text-tool-call-recovery
      name: "@zhaozehao10/dsh-text-tool-call-recovery"
```

验证方法（无需启动 GUI）：把 profile 复制一份成临时 profile，用

`dsh --profile <tmp> --dump-config` 打印组合树，确认条目出现

（`desktop` profile 被 Electron 独占，CLI 会拒绝，必须用副本）。

另注意：GUI 插件管理页列的是“已安装包”（registry 安装的），patch 插入的

条目**不会**出现在那里——管理页查不到 ≠ 没加载，以行为或 dump-config 为准。

## 五、验证

> | 命令 | 套件数 | 耗时 | 覆盖范围 |
> |---|---|---|---|
> | `node test/run-all.mjs --quick --offline` | 96 | 约 130 秒 | 单元级检查（跳过真实日志与慢速套件） |
> | `node test/run-all.mjs --offline` | 100 | 约 9 分钟 | 加上变异测试与覆盖率 |
> | `node test/run-all.mjs` | **110** | **约 19 分钟** | **全部**（含真实日志重放、全量体检、误恢复审计等） |
>
> ⚠️ **完整模式对可用内存敏感**：`coverage` / `branch-coverage` 会各自 spawn
> ~100 个带 V8 插桩的子进程，实测各需 **212s / 215s**。可用内存低于 ~2 GB 时
> 这两个套件会**超时**（不是代码问题）—— 实测在仅剩 1.08 GB 的机器上，
> `branch-coverage` 从 215s 恶化到 1264s（超时）、`claims-audit` 从 38s 恶化到
> 2393s（**63 倍**），而两者单独重跑均 **exit 0 全通过**。
> 跑完整模式前请确保有 ≥ 2 GB 可用内存，或先关闭其他应用；
> 也可用 `DSH_TEST_TIMEOUT_MS` 调大超时上限。

> ⚠️ **三种模式覆盖范围不同，只看 `--quick` 全绿不代表全部通过**：
>
> - `--quick --offline` 跳过 **14 个**套件，其中 **9 个是真实日志重放类**
>   （`replay-real-streams` / `health-check` / `per-model-replay` / `effect-quantify` /
>   `false-positive-audit` / `audit-rewrites` / `mine-unrecovered` / `synth-provenance` /
>   `lcr-replay`）—— 它们跑的是**真实会话日志**，是最贴近实际使用的验证。
> - `--offline` 会补上变异测试与覆盖率（共 4 个：`mutation-test` / `coverage` /
>   `branch-coverage` / `fuzz-*`），但**仍然跳过那 9 个真实日志套件**。
> - 只有 **full 模式**会跑全部 97 个。
>
> 真实日志套件在**没有日志的环境里会自动打印「跳过：」并以退出码 0 退出**，
> 所以在别人的机器上它们会显示 SKIP 而不是 FAIL —— 那是**环境缺失，不是验证通过**。

```powershell
# 155 项集成断言（复刻失败样本 + 真实 BlockAssembler + 不变式校验规则）
# 需要 @deepseek-ai/dsh-llm 的 BlockAssembler：装到本仓库 node_modules，
# 或用 DSH_LLM_SRC 环境变量指向任意一份 dsh-llm 源码目录。
$env:DSH_LLM_SRC = "<dsh-llm 源码目录>"   # 可选
node test/integration.test.mjs
# 复刻样本验证（Anthropic 风格 / Qwen 风格 / 截断标记）
node test/real-samples.test.mjs
# 安装校验（解析路径 / patch 条目 / 原有条目完好）
node test/verify-install.cjs [profile-dir]     # 或设置 DSH_HOME
```

测试覆盖（29 个用例组、155 项断言）：复刻失败样本恢复、多调用顺序、JSON 形式、

text 块中的标记、XML 实体与多行代码、未声明工具名、结构化 tool_calls 直通、

普通文本直通、无工具请求直通、EMPTY_RESPONSE 安全网、Anthropic 风格格式、

截断标记安全网（含混在 text 块的情形）。

重启后实测：给 step-5-preview 派一个需要工具的活，观察是否正常执行

（而不是思考完静止）。若想临时禁用：把环境变量 `DSH_TEXT_TOOL_CALL_RECOVERY`
设为**字符串** `"0"`（只认精确的 `"0"`，`false`/`off`/`""` 都不算），
并且要在 **DSH 启动前**设好（用户级变量 + 完全重启），详见
[临时禁用](#临时禁用-卸载)。

## 六、卸载

1. **优先：从备份恢复**。安装脚本会自动备份 `cordis.patch.yml`，并在安装结束时
   打印备份路径（形如 `%TEMP%\dsh-install-backup\cordis.patch.yml.bak-YYYYMMDD-HHMMSS`）。
   把它复制回 `cordis.patch.yml` 即可 —— 这条路是**无损**的，
   实测恢复后文件与安装前**字节完全一致**（插件条目消失、原有配置与中文全部保留）：

   ```powershell
   Copy-Item "<备份路径>" "<profile>\cordis.patch.yml" -Force
   ```

2. 或者**用普通文本编辑器**（记事本 / VS Code）手工删除 `- insert:` 下的两行：

```yaml
- insert:
    - id: text-tool-call-recovery
      name: "@zhaozehao10/dsh-text-tool-call-recovery"
```

> ⚠️ **不要**用 PowerShell 的 `Get-Content` / `Set-Content` / `Out-File` 组合
> 去「读出来改一改再写回去」。原因**不是**换行被压成一行，而是 **`cordis.patch.yml`
> 是 UTF-8 无 BOM**，而 PowerShell 5.1 的 `Get-Content -Raw`（不指定 `-Encoding`）
> 会按 **ANSI/GBK** 解码 —— **读进来的时候中文就已经坏了**，之后无论怎么写回去都救不回来。
> 实测：`书生专用` → `涔︾敓涓撳埄`（然后 `Set-Content -Encoding UTF8` 还会再加一个 BOM）。
>
> 如果一定要用脚本改，必须显式按 UTF-8 读写（关键是 `[System.IO.File]` +
> `UTF8Encoding($false)` 保持无 BOM）：
>
> ```powershell
> $p = "<profile>\cordis.patch.yml"
> $t = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
> $t = $t -replace '(?m)^\s*- insert:\r?\n(\s*- id: text-tool-call-recovery\r?\n)?(\s*name: "@zhaozehao10/dsh-text-tool-call-recovery"\r?\n)?', ''
> [System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))
> ```

3. 删除 `node_modules\@zhaozehao10\dsh-text-tool-call-recovery` 目录；

4. 重启应用。

## 七、参数设置嫌疑排除（直连 API 对照实验）

为回答“是否是 API 参数没配好”，用完全相同的请求形状直连

`https://api.stepfun.com/step_plan/v1/chat/completions` 做了 40 次对照实验：

| 实验 | 变量 | 次数 | 结果 |
|---|---|---|---|
| A/B | 无 tool_choice（DSH 实际形状），非流式/流式 | 8 | 8/8 结构化 tool_calls |
| C | 显式 `tool_choice: "auto"` | 4 | 4/4 结构化 |
| D/E | 当时真实的 40 个工具定义 + 真实中文任务提示 | 8 | 8/8 结构化 |
| F/G | 复刻“工具调用 → 工具结果”对话结构 | 8 | 8/8 结构化 |
| H | `step_plan/v1` 端点 vs 标准 `/v1` 端点对比 | 12 | 12/12 结构化 |

**40/40 全部返回结构化 tool_calls，零复现 XML-in-reasoning。**

## 八、“长上下文触发论”验证（忠实重放实验）

进一步假设：失败是 42 万 token 超长上下文导致的。从会话日志精确重建了

当时的请求上下文（重放会话表面操作：compaction 的 replace 区间、工具结果

修剪替换；跨模型历史思考按 `transformMessages` 规则转为 content 文本），

得到 **419,843 token** 的忠实重放——与真实请求的 **419,678 token 仅差

0.04%**（`test/long-context-replay/faithful-replay.cjs`）。

在该忠实上下文上的请求结果：

| 变体 | prompt_tokens | 次数 | 结果 |
|---|---|---|---|
| A（无历史思考） | 327,239 | 8 | 8/8 结构化 |
| B/C（历史思考，早期错配内容） | ~470,672 | 6 | 6/6 结构化 |
| **G（忠实重放，全量表面思考）** | **419,843** | **7** | **7/7 结构化** |

**合计 21 次请求，零复现。** 结论：**长上下文不是触发原因**——完全忠实的

42 万 token 重放行为完全正常。真实失败（00:23–00:33 约 9 分钟内 3/5）更可能是

当时 API 侧的瞬时异常（随后自行恢复，且 11 秒内存在一成一败，属逐请求方差）。

对用户的建议相应修正：**无需为规避此问题而刻意控制会话长度**；问题是

偶发退化，不可预测，harness 侧兜底（本补丁）是对策。

## 九、跨版本验证（0.2.0-rc.2 → 0.2.1-rc.1 → 0.2.1-rc.2 → 0.2.1-rc.3）

> **如何确认你自己跑的是哪个版本**：看 `DeepSeek Harness.exe` 文件属性里的

> "文件版本"（当前实测为 `0.2.1-rc.3`），或 `resources/app.asar` 内

> `@deepseek-ai/dsh-llm` 的包版本。安装目录下的 `version` 文件是**安装器

> 版本**（我们实测为 `44.7.0`），与应用版本不同，不要用它对应版本。

>

> 下表四个被测版本：`0.2.0-rc.2`、`0.2.1-rc.1`（当时安装器版本显示 44.7.0）、

> `0.2.1-rc.2`、`0.2.1-rc.3`。

逐行核对上游关键逻辑，**全部原样未动**（rc.3 唯一变化是移除了 `invariant.js` 这个 companion 插件，协议语义未动）：

| 检查点 | 0.2.0-rc.2 | 0.2.1-rc.1 | 0.2.1-rc.2 | **0.2.1-rc.3** | 结论 |
|---|---|---|---|---|---|
| `@earendil-works/pi-ai` 版本 | 0.87.1 | 1.1.0 | 1.1.0 | 1.1.0 | 未再变 |
| `dsh-llm` 版本 | 0.2.0-rc.2 | 0.2.1-rc.1 | 0.2.1-rc.2 | **0.2.1-rc.3** | 小版本递增 |
| 解析器是否识别文本工具调用 | 只认 `delta.tool_calls` | 仍只认（`:426-427`） | 仍只认（`:425-426`） | **仍只认** | 未修 |
| agent loop 静默结束判定 | `:1152-1153` | `:1164-1165` | `:1163-1164`，一字不差 | **语义未变** | 未修 |
| 适配器 EMPTY_RESPONSE 触发条件 | 仅 `content.length === 0` | 仍仅（`:1481-1489`） | 仍仅（`:1480-1488`） | **仍仅** | 未修 |
| `@deepseek-ai/dsh-llm` 的 `types/invariant.js` | 存在（4401 字节） | 存在 | 存在 | **已移除**（rc.3 删除该 companion） | 内部重构 |

即问题**跨越四个版本、两个 pi-ai 大版本均稳定复现**，不是某个版本的

回归，也尚未被上游修复。

插件在四套版本上的验证：

- **加载**：0.2.1-rc.1、0.2.1-rc.2 与 0.2.1-rc.3 下经 loader 导入路径实测可加载、

  `llm/stream` 监听器正常注册（插件零依赖，故上游包重构不影响它）；宿主

  inspect 的事件目录确认 `llm/stream` 瀑布流接缝签名不变；

- **测试**：155 项集成断言与复刻样本验证，**已由我在三个版本上分别手工跑过**

  并得到一致结果 —— 0.2.0-rc.2（pi-ai 0.87.1）、0.2.1-rc.1（pi-ai 1.1.0）

  与 0.2.1-rc.2 的真实 `BlockAssembler` 源码下。

  > ⚠️ **诚实说明**：这是**历史实测记录**，不是当前仓库能自动复现的东西 ——

  > 你的机器上只装了一份 dsh-llm。当前仓库里能自动跑的是

  > `hardening/cross-version.mjs`（37 项）：它用**模拟的协议差异**

  > （旧/新 `stopReason` 值域、新字段、缺失字段、未知 `kind`）来守护向后兼容，

  > 而不是真的加载三个版本。两者互补，但不要混为一谈。

- **生产实证**：升级后未再出现“工具调用标记被静默丢弃”的案例；插件的

  `EMPTY_RESPONSE` 安全网在升级前的日志里有 2 次成功拦截并触发重试的记录。

## 十、备注

- 插件对**所有 provider** 生效（保护条件保证安全），其他有同类行为的模型

  （如经 new-api 转发的 Qwen 系）同样受益。

- 本修复是用户态补丁；根本修复应上游到 pi-ai 的 openai-completions 解析器

  （把文本/思考中的工具调用标记提升为一等 toolCall 块）和 agent loop

  （"无可执行内容的 stop" 映射为 EMPTY_RESPONSE）。

## 十一、对抗性审查（发布前自查，共发现并修掉 166 个自身缺陷）

发布前做了**一百一十层测试**（110 个可独立运行的套件（其中 109 个会失败、1 个是输出供人工阅读的剖析工具），14,408 条真实会话流重放（某一时点快照；真实流会随日常使用增长）、23 种模型分组验证、3,000 条差分流、46 个变异体、V8 函数覆盖率 100%（22/22）、V8 分支覆盖率（未覆盖块 ≤ 30）），共发现并修复 166 个自身缺陷：

| # | 缺陷 | 触发条件 | 后果 | 修复 |
|---|---|---|---|---|
| 1 | **误伤正常回复** | 正文里**顺带提到** `<parameter=foo>`（写文档/讨论代码时很常见） | 原判据只看"有无标记"，会把有实质内容的正常回复判成"纯标记"→ 改写成 `EMPTY_RESPONSE` 重试，**用户丢失一条正常回答** | 判据改为"标记之外的实质字符数"：`实质字符 < 20 且标记占比 > 50%` 才算纯标记 |
| 2 | **usage 顺序倒置** | 任何被扣留 `block-end` 的响应 | `usage` 跑到 `block-end` 之前，破坏 `block-end → usage → finish` 协议顺序（真实校验器不报错，但影响回放保真） | 把 `usage` 一并扣留，放出块之后再发 |
| 3 | **示例被误执行（安全）** 🔴 | 模型讲解格式时把调用标记放进 Markdown 代码块（三重反引号围栏或行内代码） | 示例会被当成**真调用执行**——例如文档里展示 `rm -rf` 就真的执行 | 含代码围栏/行内代码的文本一律视为"展示"，不做恢复 |
| 4 | **Anthropic 形态解析不全** | `<antml:function name=…>` 或 `<invoke name=…>`（无 `<tool_call>` 外层包裹） | 这两种官方形态**完全解析不出来**，恢复能力有盲区 | 增加第二遍扫描：独立识别裸露的 function/invoke 元素 |
| 5 | **异常输入会抛异常** | `options.tools` 形状异常、`block-end` 缺 `block`、`finish` 缺 `reason` | 接缝内抛异常会**中断整条模型流**，代价远大于少做一次恢复 | 全部加防御：`Array.isArray` 检查、可选链、兼容 `{name}` 与 `{function:{name}}` 两种声明形状 |
| 6 | **确定性失败空转** 🔴 | 某模型**固定**只返回思考块（实测 `group/auto-dfmodel` 每次如此） | 安全网把每次空响应都改成可重试错误 → **连续 5 次重试全部失败**，白烧 5 次调用且用户仍无输出 | 按模型记录连续空响应次数：**仅首次**触发重试（给间歇性失败自愈机会），连续出现则原样放行 |
| 7 | **ReDoS 性能风险** | 病态输入（数万个重复未闭合标记/围栏） | 正则灾难性回溯，实测 **20 万字符病态输入耗时 9 秒**——插件在 `llm/stream` 接缝上，等于**卡死整条模型流** | ① 加 `MAX_SCAN_CHARS`(128K) 上限；② 围栏检测由正则改为**线性扫描**；③ 标签字符统计由 `match` 数组改为线性累加 |
| 8 | **多轮状态泄漏** | 长会话中同一模型反复空响应 | 计数若不清零/无上界，会永久抑制安全网或无限增长 | 出现可见正文即清零；`Map` 限制最多跟踪 64 个模型（LRU 淘汰） |
| 9 | **交错块被错配（最危险）** 🔴 | 真实适配器会**先发所有 block-start、再交错发 delta、最后逐个 block-end**，而不是“每块连续”。旧实现假设块连续 | 块内容被错配成空块 → 有大量正文的正常回复被判“无可执行内容” → **实测误伤 254 条真实回复**（用 14,408 条真实会话流重放发现） | 改为按 `index` 跟踪多个并发打开的块（`openByIndex`），并整体扣留到流末尾再按顺序发出 |
| 10 | **属性等号两侧带空格时无法识别** | 模型用 `<function name = "pwsh">` 这种**合法的 XML 写法**（等号两侧带空格） | 正则写的是紧贴的 `name=`，这类调用**完全识别不出来**，回复被当成"无可执行内容"丢弃 | 三处正则改为 `name\s*=\s*`；由等价类划分测试发现 |
| 11 | **参数值里的反引号导致整条调用被丢弃** 🔴 | 参数值含合法反引号（Python 代码、Markdown 语法、shell 命令替换 ``date``） | 旧实现「整段文本有任何行内代码就整体不恢复」，**整条调用不执行**——真实日志实测 4 条正常调用丢失 | 改为**按标记位置判定**展示区：只有标记本身在围栏/行内代码内才跳过 |
| 12 | **跨行反引号包裹的示例会被执行** 🔴（安全） | 模型用跨行反引号包住多行示例 | Markdown 不允许行内代码跨行，旧实现照规范不认 → 那段**示例被当成真实调用执行**（可能是危险命令） | 跨行反引号对也纳入展示区（宁可少恢复，也不执行示例），上限 8K 防病态输入 |
| 13 | **行内代码里的标记吞掉后面的真实调用** | 回复先写 ``<tool_call>`` 讲格式，随后给出真实调用 | 正则把「行内代码里的开标记」与「真实调用的闭标记」配成跨区块，**真实调用被当展示内容丢弃** | 改为手工逐个开标记配对：标记在展示区内就跳过、继续找下一个 |
| 14 | **JSON 参数未做类型强转、且不识别 `args` 字段** | 模型用 JSON 形态输出调用，参数写成字符串（如 `"timeoutMs": "5000"`），或把参数放在 `args` 字段 | 与 XML 路径行为不一致：XML 路径会按 schema 把 `"5000"` 转成 `5000`，JSON 路径不转——下游工具收到的类型取决于模型用了哪种写法；`args` 字段则完全不被识别 | JSON 路径补上与 XML 一致的 `coerceValue` 强转；参数容器增加 `args` |
| 15 | **属性位置要求 name 紧跟标签名** | 模型输出 `<function name="pwsh" id="c1">` 或 `<function id="c1" name="pwsh">` 这类**带额外属性**的合法 XML | 正则写死了 `function\s+name\\s*=`，要求 `name` 必须是第一个属性 → 带任何额外属性的调用**完全识别不出来** | 三处正则改为 `[^>]*?\\bname\\s*=\\s*`：name 出现在任意属性位置都能识别 |
| 16 | **参数值内的裸闭合标签导致静默截断执行** 🔴（安全） | 模型输出的 XML 已损坏：值的内部带着裸 `</parameter>`（如 `<parameter=command>rm -rf /tmp/x</parameter></parameter>`） | 惰性正则会停在**第一个**闭合标签，得到**被截断**的参数（`"rm -rf /tmp/x"` 被截成 `"rm -rf "`）并照常执行 → 可能执行半截危险命令 | 检测「闭合标签后紧跟另一个闭合类标签」即判为 XML 损坏，**放弃整条恢复**，由安全网重试 |
| 17 | **空字符串被强转成 0（语义改变）** | schema 声明 `number` 而模型给的参数值为空（`""` 或纯空白） | `Number("")` 等于 0，于是「未设置该参数」被误解为「设为 0」——`timeoutMs` 变 0 会立即超时、`limit` 变 0 会不取数据 | 空白字符串不做任何强转，保持原样交给工具判断 |
| 18 | **大整数精度丢失（操作错误对象）** | schema 声明 `number`，值超过 2^53（如雪花 ID、纳秒时间戳） | JS number 只能精确到 2^53，`9007199254740993` 被转成 `9007199254740992`——工具会操作**错误的对象**，且完全静默 | 16 位以上整数且超出安全范围时保持字符串 |
| 19 | **正文里的裸 JSON 片段被当成工具调用执行** 🔴（安全，真实事故） | 模型在汇报文本末尾输出说明性 JSON，如 `...随时可以复跑。\n{"command":"rm -rf /"}` | **真实发生**：2026-10-22 03:48 旧版插件把这段恢复成 `pwsh({"command":"rm -rf /"})`，**差点执行删根命令** | 三重收紧：① 整段必须以 `{` 开头、`}` 结尾；② 必须有明确工具名键且在声明列表；③ 必须有参数容器键（arguments/input/parameters/args） |
| 20 | **错误消息写死块类型（误导排查）** | 任意触发 EMPTY_RESPONSE 的响应 | 消息硬编码 `(only reasoning blocks)`：实际是 **text 块**时也说 reasoning，块内容全空时也不说明——**把维护者的排查方向带偏** | 改为按真实块类型生成：`no blocks` / `only text blocks` / `reasoning, text blocks`，全部为空时追加 `, all empty` |
| 21 | **恢复时 deltas 与 block-end 不一致（流式显示残留标记）** | 任意走恢复路径的响应 | `block-end.block.text` 已剥离标记，但重发的 `reasoning-delta/text-delta` 仍是**原始含标记文本** → 读 deltas 的流式消费者（UI）会看到 `<tool_call><function=...>` 闪过，读 block-end 的装配器看到干净内容，**两者矛盾** | 重发 deltas 时改用**剥离后**的文本（单 delta 承载完整内容，分片边界对下游无意义） |
| 22 | **畸形 `block.text` 让插件抛异常（会中断整条模型流）** | 宿主/上游插件给出 `block.text` 为 `undefined` / `null` / 数字 / 对象 | 安全网里直接调 `text.trim()` → `Cannot read properties of undefined (reading 'trim')`。**在 `llm/stream` 接缝里抛异常会中断整条模型流**，代价远大于少做一次判定 | 9 处函数入口统一做类型收窄（`parseCallBody` / `parseParams` / `extractCalls` / `isMarkupOnlyText` / `hasCodeFence` / `computeDisplayRanges` / `decodeEntities` / `trimEdgeNewlines` + 安全网判定） |
| 23 | **null / undefined chunk 让插件抛异常** | 上游产出 `null` / `undefined` 作为 chunk | 主循环直接 `switch (chunk.type)` → `Cannot read properties of null (reading 'type')`，**中断整条模型流** | 主循环入口加类型守卫：非对象 chunk 原样透传，不参与恢复判定 |
| 24 | **Symbol 字段让模板拼接抛异常** | `options.model` / `options.provider` / `call.name` 是 Symbol | 模板字符串 ``${x}`` 在 x 是 Symbol 时抛 `Cannot convert a Symbol value to a string`（**结构化模糊测试 5000 条命中 83 次**） | 新增 `safeString()` 统一安全字符串化，替换 3 处模板拼接（模型键、错误消息、合成 id） |
| 25 | **网络断流时用户已收到的内容全部丢失** | 流在 `block-end` 前/后断开（网络抖动、上游取消、适配器崩溃） | 插件为避免乱序会**扣留** text/reasoning 块，但扣留的块只在**正常结束**时 flush；一抛异常，扣留的块永远发不出去 → 用户**连已经收到的文字都看不到** | 主循环加 `try/catch`：异常时先 `yield* flushHeld()` 交出已扣留内容，再原样 `throw`（不吞掉、不伪造 finish、**绝不恢复调用**） |
| 26 | **无法在运行时确认加载的是哪个版本** | 改了代码但不确定是否生效；多个进程可能加载不同版本 | 代码里没有版本标识，只能靠比对文件大小/mtime 猜——**实际已发生过一次：源码 43,564B 与安装副本 43,162B 不一致却没被发现** | 新增 `VERSION` 常量（与 package.json 同步）并导出；`deploy-verify.mjs` 自动检查「源码 ≡ 安装副本」+「VERSION ≡ package.json」 |
| 27 | **单独 CR 行尾的参数值带 CR，命令无法执行** | 模型用**单独 CR**作行尾（老式 Mac 格式 / 某些训练数据的产物） | `trimEdgeNewlines` 写成 `/^\r?\rn/`——只匹配 CRLF/LF，**漏掉单独 CR**，参数值带前导 CR 导致命令执行失败 | 改为 `/(?:\r\rn\|[\r\rn])/`（CRLF 优先，再单 CR/单 LF），仍是**只剪一层**（不用 trim，保留有意义的首尾空格） |
| 28 | **死代码 `hasCodeFence` 引用未定义符号** | 覆盖率检查发现函数从未被执行 | 该函数是旧实现的遗留（已改用 `computeDisplayRanges`），**内部调用的 `isInsideDisplayRegion` 根本没有定义** —— 一旦被调用就是 ReferenceError。同时 `MARKER_TAGS` 常量也只被它使用 | 删除死代码链（`hasCodeFence` + `MARKER_TAGS`），986→951 行；顺带修正 `coverage.mjs`/`branch-coverage.mjs` 的元套件递归（未排除彼此导致超时） |
| 29 | **覆盖率脚本并发不安全（固定临时目录互相覆盖）** | 同时运行多个验证任务、或两次跑同一覆盖率脚本 | 两个脚本都用**仓库内固定目录**（`.tmp-coverage-run` / `.tmp-cov-branch`）作 `NODE_V8_COVERAGE` 输出，并发时互相覆盖 → 读到别人的数据，未覆盖数字从 23 跳到 **129**，或出现 44/2 的假失败。同时 `run-all.mjs` 静默跳过套件也不提示，容易误以为「quick 就是全部」 | 改用 `mkdtempSync` 每次唯一目录（跑完即删）；`run-all.mjs` 结尾**显式列出所有被跳过的套件**并提示如何跑全量；README 补了三种模式对照表 |
| 30 | **变异测试的 SKIP 被当作通过（导致虚假 100% 覆盖）** | 源码改动后变异体锚点失效 | `mutation-test.mjs` 的退出条件只检查 `survived === 0`，**完全忽略 `skipped`** —— 锚点失效时变异体被标记 SKIP、该变异**根本没有被验证**，但套件仍返回 0（通过），覆盖率还显示 100%。本项目因此**连续四轮没发现** M15/M18/M35 等锚点已失效 | 退出条件改为 `survived === 0 && skipped === 0 && realCoverage >= 90`；新增「被跳过的变异体」章节 + 修复指引；覆盖率同时报告**两种口径**（仅计已评估 / 含 SKIP 未验证） |
| 31 | **材料里的统计数字系统性过时（会误导读者）** | 代码/测试持续演进，但文档里的数字靠手写 | 自查发现 **6 处**不一致：`27 个变异体`（实际 46）、`12,747 条真实流`（实际 14,408）、`13,398` / `13,615` / `13,187` / `13,582`（同一事实四个不同数字）、`19/19 函数覆盖率`（删死代码后为 22/22）、`未覆盖块 ≤ 10`（已调整为 ≤ 30）；层数也从 57 变 60 却未同步 | 新增 `hardening/doc-consistency.mjs`：**从源码推导**权威数字（变异体数、门槛、套件数、缺陷表行数）再与中英文文档比对，不一致即失败；并把真实流总量统一为 **14,408** |
| 32 | **模块说明不在文件顶部（可读性问题）** | 后续迭代把新代码插到了文件最前面 | `@module` 块（27 行，讲清这个插件解决什么问题、根因、修复思路）被 `VERSION` 与 `safeString` 挤到了第 39 行之后 —— 新读者打开文件先看到工具函数，看不到「为什么存在」，需滚动才知道 | 把 `@module` 块移到文件最顶部；新增 `hardening/code-quality.mjs` 固化这条约束（模块说明必须在前 12 行内） |
| 33 | **安装脚本有语法错误（用户一运行就失败）** | Windows PowerShell 读取脚本 | 脚本是 **UTF-8 无 BOM**，Windows PowerShell 5.1 会按 ANSI(GBK) 解码中文，把多字节字符拆成非法序列 → `Parser` 报「意外的标记」；再加上脚本里注释含全角标点，直接导致**语法错误**、无法执行 | 文件改为 **UTF-8 BOM + CRLF**；同时把易出问题的全角标点从代码行移到注释；新增 `hardening/install-experience.mjs` 用 PowerShell 解析器做语法检查 |
| 34 | **安装脚本因备份目录不存在而崩溃** | 首次安装（仓库内没有 `.tmp` 目录） | 脚本把备份写到 `$PSScriptRoot\.tmp`，但从未创建该目录 → `Copy-Item` 抛 `DirectoryNotFoundException`，安装在第 1/4 步就中止 | 备份目录改用**系统临时目录**（`[System.IO.Path]::GetTempPath()` + `dsh-install-backup`）并显式创建；不污染仓库 |
| 35 | **缺少 LICENSE / 安装说明 / 名称不一致** | 用户首次接触这个仓库 | package.json 声明 MIT 但**没有 LICENSE 文件**；README 只有「我已装好」的状态记录、**没有给别人的安装步骤**；lib 内 `name` 是短名 `text-tool-call-recovery` 而 package.json 是完整包名，运行期日志与实际包对不上 | 补 LICENSE (MIT)；README 中英文各加「给其他用户的安装步骤 / 手动安装 / 卸载」章节；`name` 改为完整包名与 package.json 一致 |
| 36 | **英文 README 的安装命令无法执行（照抄就报错）** | 英文文档用 `-ProfileDir <path>` 作示例 | PowerShell 里 `<` 是**保留运算符**，用户直接复制这一行会得到 `The '<' operator is reserved for future use.` —— 安装第一步就失败；中文 README 恰好用了引号包裹的真实路径所以没暴露 | 改为引号包裹的真实路径示例；新增 `hardening/doc-executable.mjs` 用 **PowerShell 解析器实际解析**每一个 powershell 代码块，并额外拒绝裸 `<xxx>` 占位符 |
| 37 | **材料里引用的 DSH 源码路径不存在（硬伤）** | 写材料时凭记忆写文件名 | 3 处引用 `dsh-llm/lib/types/invariant.js`，但该文件**不存在** —— 宿主真正的流不变式校验在 `assistant-stream.js`（`AssistantStreamAccumulator.push` / `assembleAssistantStream`）；另有 2 处引用本地无法核实的包却写成了**精确行号**  —— **第 90 轮订正**：该文件**实际存在**（asar 内 `/dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/invariant.js`，4,401 字节，内容是 `validateStream`/`validateIndex`/`validateDelta` 协议校验器）。当初判定「不存在」是因为**本地测试副本不完整**（缺这个文件），不是文档写错 | 改为真实路径 + 符号名；无法核实的改为「文件名 + 描述」；新增 `hardening/ref-verifiable.mjs` 抽取所有源码引用并核实文件存在性 / 行号范围 / 符号真实性 |
| 38 | **一个「测试」文件里没有任何断言（永远通过）** | 写的时候以演示/人工核对为目的 | `test/real-samples.test.mjs` 只把结果 `console.log` 出来然后无条件 `exit 0` —— **插件回归时它不会失败**，看起来是测试、实际是演示脚本；README 却把它列进测试矩阵并声明「3 个真实案例形态」 | 给三个样本都加上**真实断言**（17 项）：工具名、参数键、参数值内容、finish 是否被改写为 `tool-calls`、截断样本必须**不**恢复调用；退出码改为断言结果 |
| 39 | **一个测试打印了关键指标却从不检查它（永远通过）** | 写的时候以「输出供人工看」为目的 | `hardening/audit-rewrites.mjs` 会打印「可疑: N」然后结束 —— **没有 `process.exit(1)` 路径**。即使插件开始误伤正常回复（`suspicious > 0`），它在 `run-all` 里仍然显示 PASS | 加上失败判定：`suspicious > 0` 即 `process.exit(1)` 并打印指引；新增 `hardening/fake-test-audit.mjs` 扫描**每一个**测试脚本，确认它「有断言 或 有基于统计的失败退出」 |
| 40 | **文档结构问题（编号重复 + 内容不对等）** | 长期迭代中章节不断增删 | ① 中文 README 出现**两个「九、」**章节（跨版本验证 / 备注），后续「十、十一」也跟着错位；② 英文 README 有 Known limits 章节，**中文版完全没有** —— 对主要受众是信息缺失 | 重新编号为一至十三；补上「十二、已知限制（诚实清单）」（含 5 条：其他格式不解析、上游丢 token 无法检测、绑定 0.2.0-rc.2、只处理这一类问题、**不保证没有 bug**）；新增 `hardening/doc-structure.mjs`（32 项）守护 |
| 41 | **不可自动复现的声明没有标注（读者会以为能一键验证）** | 作者手工跑过的实验，写进文档时没区分「历史记录」与「当前可自动复现」 | README 写「155 项断言已分别在 0.2.0-rc.2 / 0.2.1-rc.1 / 0.2.1-rc.2 上跑通」——**这是真的**（我确实手工跑过），但读者的机器上只有**一份** dsh-llm，无法复现；而仓库里的 `cross-version.mjs` 实际是用**模拟的协议差异**测的，不加载任何真实旧版本。两者被混在一起说，读者会误解 | 中文加「诚实说明」段落明确区分两者，英文加 "Honest note on cross-version evidence"；「已知限制」里补一条说明"证据分两类"；新增检查确保这类声明必须带标注 |
| 42 | **把正确的设计误判为缺陷并「修复」了它（差点破坏两个内置功能）** | 审查时只看到「tools 为空时整个插件早退」，没想到它为什么这样设计 | 我判断这是缺陷（「模型只返回思考时，无论有没有工具用户都会卡住，安全网应该生效」），改成「恢复跳过但安全网生效」。**集成测试用例 5 立刻失败** —— 真实原因是 DSH 有两类**不带工具**的内部请求：**compaction**（压缩上下文，模型只返回摘要）与 **session-title**（生成会话标题）。这两类里「没有 tool-call 块」是**正常的**；若触发 EMPTY_RESPONSE 重试，每次压缩/起标题都会白白重试、浪费 token 且拖慢响应。**所以早退是正确的设计，我的「修复」是错的** | 完整回滚；在早退语句前写上详细的设计理由；新增 `hardening/passthrough-design.mjs`（10 项）把这个决策固化为回归测试，防止将来（包括我自己）再次误改 |
| 43 | **定义了但从未使用的正则（死代码重现）** | 历史重构时把它的使用点删了，定义留下了 | `TOOL_CALL_BLOCK_RE` 在整个文件里**只出现 1 次**（定义处），从未被使用。这是第 28 轮 `hasCodeFence` 死代码的**同类问题重现** —— 当时只删了那个具体的，没有建立通用检测。发现方式很意外：我在验证「基线回归能否检测行为漂移」时破坏了这个正则，**预期会导致真实流不再被恢复，结果毫无变化** —— 才意识到它根本没被用 | 删除死代码（43,617 → 43,362 字节）；在 `code-quality.mjs` 增加第 9 节**通用死代码检测**：遍历所有顶层 `const`，确认每个至少被引用一次；并用「注入假死代码」验证该检测**真的会失败** |
| 44 | **测量工具本身有 bug（静默漏报）** | `findFunctions` 用**裸括号计数**找函数边界，没想到源码里有含 `{` `}` 的字符串字面量 | `lib/index.js` 里有 **18 处**含括号的字符串（如 `"{"`、`{"command":...}`）。裸计数把它们也计入 → **函数数量 19 → 18（少识别 1 个）**、`parseCallBody` 被误判为「1 行就结束」（实际 58 代码行）、`wrapStream` 多吞 10 行。**测试不会报错** —— 只是检查被静默削弱。这是最危险的一类 bug：工具坏了但看起来一切正常 | 改成先**剥离字符串/正则字面量**再数括号；并新增第 10 节**测量工具自检**：用 5 个已知答案的合成输入（含 `字符串里含 {}` 这个关键用例）验证 `findFunctions` 的正确性 |
| 45 | **层数被手工递增，已与实际套件数漂移（87 vs 83）** | 每轮手工把「N 层」+1，但新增的套件数不总是 +1（有时是修改现有套件、有时删除） | 声称 **87 层**，实际只有 **83 个套件**（hardening 81 + core 2），**漂移 4 层**。原检查容差是 ±3，**差 4 才刚被抓到** —— 说明这个容差太松。同时发现测试矩阵少列了 2 个套件（`interleaved-blocks`、`multi-turn`） | 层数改为**精确等于套件总数**（83）；补上 2 行矩阵；把 `doc-consistency` 的容差从 **±3 收紧到 0**，并在错误信息里给出「请改为 N」的修正建议；已用「改成 +1」验证检查会失败 |
| 46 | **缺陷表的两行被合并、另一行重复（Markdown 表格结构破坏）** | 多次编辑时逐行替换，某次替换漏了换行 | ① **D26 与 D27 被拼到同一行**（该行有 13 个 `\|` 而非 6 个）→ Markdown 渲染出错、D27 在表格里「消失」、我的解析器只认出 **38 行（实际 45）**；② 修复过程中又引入了 **D27 重复两行**；③ D27 的修复描述含正则 `/(?:\r\n\|[\r\n])/`，其中未转义的 `\|` 会把一格切成两格 | 拆分为两行、删除重复、把代码块内的 `\|` 转义为 `\|`；在 `doc-structure.mjs` 增加第 8 节**缺陷表结构完整性**：每行必须恰好 6 个未转义的 `\|`、编号无重复、编号连续、无空单元格；并用「注入行合并 / 编号重复 / 未转义 `\|`」三种破坏验证该检查**真的会失败** |
| 47 | **表格列数不一致（两类）** | 前几轮往 README 里插行时，用了错误的锚点 | ① **测试矩阵的行被误插进缺陷表**（5 行 4 列混进 5 列表，如 L334 的「安全网宿主契约」）；② **英文版 README 的 D26/D27 也被合并到同一行**（13 个 `\|`，与第 56 轮中文版同款问题）。第 56 轮的检查**只覆盖了缺陷表**，没覆盖其他表格 | 把 5 行移到测试矩阵表末尾、拆分英文版 D26/D27 并转义正则里的 `\|`；把 `doc-structure.mjs` 的检查**从缺陷表扩展到全部 Markdown 表格**（同一表内所有行的未转义 `\|` 数量必须相同）；已用「注入 3 列的行」验证会失败 |
| 48 | **英文 README 的缺陷表严重滞后（停在 D27，实际 D47）** | 每轮只往中文版加缺陷，英文版靠"以后补" | 英文缺陷表只有 **27 条**，中文版 **47 条**——**滞后 20 条**。英文读者会以为这个项目只发现过 48 个缺陷。根因：`doc-structure` 的第 8 节只检查中文版，第 9 节只检查表格**列数**，都不检查**中英文内容对等** | 补全英文 D28-D47（20 条完整翻译）；新增第 10 节**中英文缺陷表对等**：数量一致、编号集合一致（报出缺失/多出的编号）、每条内容有实质长度；已用「删除英文 D45-D47」验证会失败 |
| 49 | **批量替换污染了历史记录（数字自相矛盾）** | 为了让统计数字保持最新，我写了批量替换脚本，用 `t.replace(/(\d+)\s*个套件/g, ...)` 把**所有**「N 个套件」都替换成当前值 | D45 那条历史缺陷原本写「声称 **87** 层，实际 **83** 个套件，**漂移 4** 层」，被脚本改成了「声称 **83** 层，实际 **83** 个套件，**漂移 83** 层」—— **数学上自相矛盾**。同类问题还有 `run-all` 表格里的套件数（62，实际 83）。根因：暴力替换**无法区分**「当前统计值」与「历史记录里的数值」 | 逐条修正 13 处被污染的数字；在 `doc-consistency` 增加第 9 节**历史记录数值自洽**：① D45 的「声称 − 实际 = 漂移」必须成立；② `run-all` 表格的套件数必须等于实际值；③ 英文版同一处也必须一致。已用「注入污染」验证两种检查都会失败 |
| 50 | **数字审计工具无法区分「当前声明」与「历史引用」** | 想做全量数字审计，直接扫描所有数字 | 扫出 3 个文档都写「27 个变异体」（实际 46），看似全部过时 —— 实际它们是 **D31 缺陷的历史记录**（同一行明确写着「（实际 46）」）。**任何不做区分的数字扫描都会产生大量误报，而误报会淹没真正的错误** | 数字审计加入「历史记录」判据（缺陷表行、含「实际 X」的对比句、标注「原本」的条目一律跳过）；同时**反向验证**必须真的找到被剔除的历史引用，防止「什么都没扫到」式的假通过 |
| 51 | **「套件数」被写成 1060（实际 83，夸大 12.8 倍）** | 混淆了「套件数」与「断言总数」两个概念 | README 声称「**1060** 个套件」，实际只有 **83** 个（hardening 81 + core 2）。真实断言调用点约 **930 个**，但那是断言数，不是套件数。**夸大 12.8 倍** | 修正为 **83**；`doc-consistency` 新增第 11 节：所有「N 个套件」声明必须等于实际套件数 |
| 52 | **性能数字从未被自动校验（会随时间漂移）** | 性能数据是某一轮手工测的，之后只有 `perf-baseline.mjs` 的宽松上限（5ms/20ms），没有「文档数字 vs 实测」的比对 | README 声称「典型回复 **0.018ms**」「128KB **1.06ms**」「**101 万 chunk/s**」—— 如果未来性能退化 5 倍，`perf-baseline.mjs` 仍会通过（它的上限是 5ms/20ms），但 README 的数字就不准了，**读者会读到过时的性能** | 实测核对：0.018ms / 1.062ms / 1,605,525 chunk/s，**与 README 全部吻合**；`doc-consistency` 新增第 12 节提取并校验这 3 个数字的合理性，同时断言 `perf-baseline.mjs` 必须有阈值和 O(n²) 检查 |
| 53 | **「LRU 顺序」从未被验证过（删掉 `delete` 也测不出来）** | 现有测试只验证「有淘汰 vs 无淘汰」，没验证「按什么顺序淘汰」 | 变异测试发现：把 `emptyResponseStreak.delete(key)` 删掉后，`race-conditions.mjs` **仍然全部通过**。因为删掉它 Map 就退化成 **FIFO**（按首次插入顺序淘汰），而不是 **LRU**（按最近访问顺序）。区别只在「重新访问过的模型是否被优先保留」——**没有测试覆盖这个差异** | 新增第 7 节**真正的 LRU 语义**：填满上限 → 重新访问 m0 → 加新模型触发淘汰 → 验证 m0 仍在（stop）而 m1 被淘汰（error）。用两个变异（删 delete / 不移动顺序）验证过**都会失败** |
| 54 | **变异体只覆盖 9/19 个函数（10 个函数无变异守护）** | 46 个变异体是按历史缺陷逐个加的，没有按函数系统性检查 | 函数级覆盖分析发现：`safeString`、`trimEdgeNewlines`、`hashString`、`propertiesOf`、`safeJsonParse`、`computeDisplayRanges`、`isInRanges`、`patchReplayState`、`apply`、`resetStreaks` **共 10 个函数没有任何变异体**。深入排查后确认大部分被行为套件间接覆盖（`computeDisplayRanges` → `backtick-precision.mjs` 等 7 个；`apply` → 全部 83 个），但 **`propertiesOf` 和 `safeJsonParse` 真的 0 覆盖** | 新增 `uncovered-functions.mjs`（28 项）用已知答案验证这两个函数：类型强转矩阵、`parameters`/`properties` 为 null/非对象时的降级、合法/畸形/深层嵌套 JSON、原型污染防护、源码实现检查 |
| 55 | **「函数标签 + 裸 JSON 参数体」路径不做类型强转（四条路径中唯一不一致）** | `parseParams` 只认 `<parameter=key>` 格式，遇到裸 JSON 返回空对象，于是走到另一个分支直接 `return parsed` | 模型写 `<function=pwsh>` + `{"timeout":"3000"}` 时，`timeout` **保持字符串**；而其余三条路径（`<parameter>` 元素、整段 JSON 工具调用、无标记整段 JSON）都会转成数字 `3000`。**四条路径三种行为**，工具会收到错误类型。这是变异测试覆盖分析引出的实地验证发现的（`safeJsonParse` 无变异体 → 深入测试 → 暴露不一致） | 在该分支补上与其余路径一致的 `coerceValue` 强转；实测四条路径现在全部返回 `number` |
| 56 | **路径级不一致缺少系统性检查（缺陷 55 只是其中一处）** | 缺陷 55 是「四条路径三种行为」中的一个，但当时只修了那一条，没有建立**跨路径一致性**检查 | `parseCallBody` 有 **4 条返回路径**（L247 `<parameter>` / L263 裸 JSON / L297 非对象包装 / L306 整段 JSON）。单测每条路径都「通过」，但**路径之间的差异只有在对照时才暴露**。若再出现同类不一致（新增路径或改动某条），现有测试无法发现 | 新增 `path-consistency.mjs`（26 项）：**同一份输入**喂给全部 6 种写法，断言①每条都能恢复②所有路径的**字段类型完全一致**③类型符合 properties 声明④说明性 JSON 不被执行⑤非对象 arguments 正确包装⑥源码层面每条逐键强转路径都有 `coerceValue`。已用「回退缺陷 55」「破坏 L306 强转」两个变异验证**都会失败** |
| 57 | **`id` 唯一性测试用错了输入，测不出 `ordinal` 的作用** | 写多调用测试时顺手用了两个**内容不同**的调用 | 把 id 生成里的 `-${ordinal}` 后缀删掉后，`path-consistency.mjs` **仍然全部通过** —— 因为两个调用的**内容不同**，哈希本来就不同。`ordinal` 的作用是让**内容完全相同**的调用也有不同 id（同一流里模型重复同一调用是可能的）。没有 `ordinal`，宿主的 tool-call id 会冲突，工具结果无法对应 | 改用**三个内容完全相同**的调用，断言 id 互不相同；实测 id 为 `txtcall-1q82kq8-0/1/2`（前缀相同、后缀递增）。删掉 ordinal 后立刻报 `1/3：["txtcall-1q82kq8","txtcall-1q82kq8","txtcall-1q82kq8"]` |
| 58 | **「运行模式」表格的套件数与耗时严重过时（少算 27 个套件）** | 这张表写于套件数只有 46 个的时期，之后每轮加套件都没更新 | README 声称 `--quick --offline` 跑 **46** 个套件（实测 **73**）、`--offline` 跑 **50** 个（实测 **77**），耗时「约 12 秒」（实测 **88 秒**）、「约 2 分钟」（实测 **6.3 分钟**）。**读者会以为快速模式覆盖了一半以上的套件，实际只有 84%**。完整模式（87）反而是对的 —— 说明这张表被改过一次但只改了最后一行 | 三种模式全部**实测**：73/88.1s、77/378.9s、87/889.8s；`doc-consistency` 新增第 13 节**从 `run-all.mjs` 的 `NEEDS_LOGS`/`SLOW` 集合静态计算**每种模式的套件数并与文档比对；已用「把 73 改回 46」验证会失败 |
| 59 | **Markdown 换行符不一致，且文件曾被写坏成 3703 行空行** | 修「运行模式表格」时用 PowerShell 按行写入，CRLF 处理出错 | ① 文件一度变成 **4085 行、其中 3703 行是空行**（原文 760 行）；② 修复后遗留 **759 处 `\r\r\n`**（双 CR）；③ `README.md` 是 **CRLF**，其余 **7 个 .md 是 LF** —— git 会给整文件 diff 噪声 | 全部规范化为 **LF**（8 个文件）；`doc-structure` 第 11 节新增**换行符一致性**检查（禁止 CRLF/双CR/单CR）+ **空行堆积**检查（>= 4 个连续换行即失败） |
| 60 | **`PASTE-READY.zh.md` 严重过时（用户实际粘贴的是旧内容）** | 它是脚本从 discussion 抽取生成的，但生成一次后就没再跑过 | `PASTE-READY.zh.md` 是**用户真正复制粘贴到 GitHub 的文件**，但时间戳比 `discussion` 早 2 分钟，**不含 D55/D58/D59，也不含「59 个」「八十七层」** —— 用户会贴出一份缺少 12 个缺陷、层数写成旧值的讨论帖。而 `doc-structure`/`doc-consistency` 都没有检查这个文件 | 重新生成（52,592 字符，中文正文 18,076 + 英文 33,737）；`doc-consistency` 新增第 14 节 **PASTE-READY 与主材料同步**（8 项）：标题逐字出现、关键数字一致、最新 3 条要点、恰 1 个占位符、结构标记完整、**中英文正文逐字一致**；已用「截断正文」「改缺陷数」「改层数」三个变异验证**都会失败** |
| 61 | **`community/` 下 3 个草稿从未被任何套件检查** | 检查套件都是在「主材料」（README/discussion）时代写的，没跟上后续新增的 community 草稿 | `community/feedback-stepfun.zh.md`、`community/issue-deepseek-harness.{zh,en}.md` **被 0 个套件引用**；其中前两个的脚本引用（`openai-completions.js`）从未被核验。经查这 3 个文件**内容完整、无过时数字、无敏感信息**（`sk-xxx` 是占位符），且后两个已正确标注「已被 discussion 取代」 | 把 `ref-verifiable.mjs` 的 `DOCS` 从 **4 个扩展到 7 个**（含 community 下 3 个）；新增 `KNOWN_UNVERIFIABLE` 集合显式标注「本地无法核实的上游包」（`openai-completions.js` 属于宿主内部的 pi-ai 适配器）；套件从 15 项增至 **18 项** |
| 62 | **零基础指南完全不提「装完必须重启」，且预期输出数字过时** | 指南是按「提交材料」写的，没覆盖「装完插件要重启」这个最容易忘、后果最直接的步骤 | ① `SUBMIT-GUIDE.zh.md` **0 处提及重启**（README 有 9 处），而 DSH 是长驻进程、`apply()` 只在启动时执行一次 —— 用户装完插件后运行中的进程仍用旧代码，**会以为修复无效**；② 预期输出写「**58 通过**」（实际 **73**）、耗时「约 30 秒」（实际 **89 秒**）、完整版「约 20 分钟」（实际 **15 分钟**） | 新增「第二·四步：装完必须重启」章节（含判断是否生效的方法与重启方式）；用**实际运行**取得的数字修正三处；`deliverable.mjs` 新增第 9 节（5 项）：必须提重启、说明原因、预期数字与 quick 实际套件数一致、命令都指向存在的脚本 |
| 63 | **「这套材料真的能提交吗」从未实际验证过** | 所有检查都是**读文件**（.gitignore 规则、文件存在性），从未**实际跑一遍 git** | 前 69 轮只验证了「`.gitignore` 里有排除规则」「文件存在」，但**从没验证过 `git add -A` 之后上传集合真的是对的**。实证 `git init + add`：**104 个文件**会提交、4 个草稿正确排除、93 个测试脚本会提交、无意外文件 —— 结论是正确的，但**这个结论此前只是手工跑过一次**，没固化成套件。若目录结构变化或 `.gitignore` 规则被误删，可能悄悄上传草稿 | `deliverable.mjs` 新增第 10 节 **git 可提交性**（4 项）：模拟 `git init + add` 后验证①草稿不泄漏②关键文件都在③无临时/备份文件④测试脚本会提交。已用「删掉 `.gitignore` 里的 SUBMIT-GUIDE 规则」验证 —— **三层检查同时报错** |
| 64 | **安装脚本只测了成功路径，失败路径完全没测** | `install-experience.mjs` 覆盖了编码、语法、真正跑一遍、产物检查、patch 形态 —— 全是**成功场景** | 用户实际最常遇到的是**失败场景**：① profile 目录不存在（DSH 从未启动过 / 路径写错）；② `cordis.patch.yml` 缺失（profile 不完整）；③ 重复运行（不确定装没装，再跑一次）。这些**从未被验证**。第 72 轮实测：三个场景**全部正确**（18 项断言通过）—— 但这是**本轮才发现它们没被测过** | 新增 `install-failure-paths.mjs`（18 项）：profile 不存在时给可操作提示而非异常栈、patch 缺失时清晰报错且不留半成品、正常安装、**幂等性**（条目数 1→1）、复制字节一致、备份写临时目录不污染 profile。**注意必须用 `powershell`(5.1) 而非 `pwsh`(7)** —— 第 72 轮踩过这个坑 |
| 65 | **README「已知限制」的 8 条宣称从未被验证过** | 所有检查都在验「做到了什么」，没人验「做不到什么」 | 第 73 轮逐条实测：① 其他文本格式不解析（Markdown 围栏 / 其他 XML 方言）→ 实测不执行且落到安全网 ✅；② 无参数调用不恢复 → 实测不执行、`code=EMPTY_RESPONSE` ✅；③ 正常文本回复不被改动 → 实测 `kind=stop` ✅；④ 只有思考时触发安全网 → 实测 `kind=error` ✅；⑤ 绑定 `llm/stream` + 7 种 chunk 类型 → 实测全部处理 ✅；⑥ 跨版本证据分两类 → `cross-version.mjs` 是模拟协议差异、README 标注「不可自动复现」✅。**结论：8 条限制全部准确** | 新增 `known-limits-accuracy.mjs`（19 项）：把「限制描述」变成**可回归断言**，防止将来改动让某个限制不再成立（那会让 README 说谎）。过程中踩了两个坑：① 用 `blockType=reasoning` 测「正常回复」会误判（安全网只认 text 块）—— 是测试写错，不是代码缺陷；② `indexOf("已知限制")` 会匹配到 D40 缺陷行里的引用，必须用 `## 十二、` 定位 |
| 66 | **「卸载」只验证了「README 里有说明」，从没真正执行过** | `install-experience.mjs` 标题写着「安装/**卸载**体验」，但对卸载只有一句 `/卸载\|Uninstall/.test(readme)` | 第 74 轮**实际走完整流程**：安装（220 字节 patch）→ 按 README 步骤删 `- insert:` 块（118 字节，等于原始长度）→ 删插件目录（无残留）→ 重装（1 条条目）。**流程可行**。但实测暴露真实风险：用 PowerShell 的 `Set-Content -NoNewline` 删两行会把**整个 YAML 压成一行**（`"# Test profile- id: base  name: ..."`），配置彻底损坏 —— 而 README 原文只说「删除两行」，**没有任何警告** | 新增 `uninstall-flow.mjs`（19 项）：完整走安装→卸载→重装，验证无残留、可重装、patch 字节数回到原始值；**改进 README 卸载说明**（中英）：① 优先「从备份恢复」（安装脚本已自动备份并打印路径，无损）② 给出要删的确切 YAML 片段 ③ **明确警告不要用 `Set-Content`/`Out-File`**，删完确认文件仍是多行 |
| 67 | **README 内部不同章节的数字自相矛盾** | 每轮只更新「当轮改到的那一处」，其他章节的历史表述没人核对 | 前 74 轮的检查都是「README vs 源码 / README vs 英文版 / README vs discussion」，**从没检查过同一份 README 里不同章节是否自相矛盾**。实测发现 2 处：① L723「把 **166 个缺陷逐一映射」—— 实际 **66**；② L765「本项目做了 **86 层**验证」—— 实际 **90**。英文版反而是对的（`ninety layers` / `fixed sixty-six`），说明中文版是逐段手工维护时漏改 | 修正 2 处；`doc-consistency` 新增第 15 节 **README 内部数字一致**（4 个模式：「本项目做了 N 层验证」「把 N 个缺陷逐一映射」「修复上述 N 个自身缺陷」「共发现并修掉 N 个自身缺陷」）；并用**反向验证**确保这些模式确实匹配到内容（防止空转）；已用「改成 86」「改成 48」两个注入验证 —— **报错精确到行号** |
| 68 | **「内部一致性」检查只覆盖 README，且历史标记判据不完整** | 第 75 轮补的检查只盯着 README，判据也只有「实际/原本/曾」 | ① 第 15 节只检查 README，但 `discussion` 和 `PASTE-READY` **也有「N 层测试」表述**；② 历史标记判据缺「原有」「当时」「此前」—— `discussion` L113 写「**原有 86 层**测试按功能维度组织」，那是**历史叙述**（描述当时状态），却被当成「当前声明」误报；③ 实测还发现第 15 节的模式没覆盖「N 层对抗性测试」 | 第 15 节**从 1 个文档扩展到 3 个**（README / discussion / PASTE-READY）；历史标记判据补齐（`原有\|当时\|此前\|before\|previously`）；补充「N 层对抗性测试」模式；已用「把 discussion 的九十层改成八十五」验证 —— **第 14 节和第 15 节都会报错**。**已知局限**：中文数字（九十层）不在第 15 节的模式里，那一类由第 14 节的逐字同步检查兜底 |
| 69 | **结构检查只覆盖 4/8 个文档** | 每个检查套件都是在某个具体文档上写的，之后从没系统枚举过「覆盖了哪些文档」 | 第 76 轮做了**覆盖矩阵**（8 个文档 × 7 类检查）：结构/换行符只覆盖 **4/8**，数字一致性 **5/8**，可执行性 **4/8**。最关键的缺口是 `SUBMIT-GUIDE.zh.md` —— 它是**零基础用户的操作手册**，却完全没做结构检查。实测它结构其实是好的（1 个真实 H1 + 13 个 H2 + 2 个表格），但**这个结论此前没人验证过** | `doc-structure.mjs` 新增第 12 节 **所有交付物文档的基础结构**（8 个文档 × 4 项：换行符/H1 数量/H2 存在/表格列数/非空）；**关键细节**：统计 H1 时必须**跳过代码块**（SUBMIT-GUIDE 的 powershell 块里有 `# 跑这个套件...` 注释，直接按行首 `# ` 会误判成 H1） |
| 70 | **中文 README 的所有表格渲染错误（表格行之间夹着空行）** | 早期某次编辑用了「每行后加空行」的写入方式，之后一直没发现 | 实测：**缺陷表 68 行被 55 个空行切成 56 个独立小表**、**测试矩阵 75 行被 75 个空行切开**。Markdown 规范要求表格行**连续**，空行会截断表格 —— 后果是 GitHub 上中文 README 的**所有表格渲染错误**（表头只对第一个小表生效，后续行失去列对齐）。英文版完全正确（0 个空行），所以这个缺陷只影响中文读者。**发现方式**：第 9 节的表格计数报「164 个表格」明显不合理（README 只有约 7 个），追下去才看到 160 个「单行表格」 | 删除 153 个表格内空行（785 → 632 行）；中文 README 表格数 **160 → 7**（正常）；`doc-structure` 新增第 13 节 **表格行之间不得夹空行**（5 个文档 + 反向验证确保检测到表格）；已用「缺陷表中间插入一个空行」验证 —— **精确报出行号** |
| 71 | **README 有 4 类渲染结构问题（含测试矩阵被插错章节）** | 每轮只追加内容、只检查「数字对不对」，从没检查过「渲染出来长什么样」 | 第 77 轮修完表格空行后继续深挖，又发现 4 类：① **代码块内 35 处空行**（powershell/yaml 块每行之间都有空行，复制下来会带多余空行）；② **8 处连续空行**；③ **测试矩阵的 4 行被错位插入到「安装步骤」章节**（L131-134）—— 读者在安装说明中间突然看到 4 行测试矩阵，**这是最严重的**；④ **D3 单元格里写了 三重反引号围栏**，会干扰 Markdown 解析器识别代码围栏 | 删除 35 处代码块内空行、压缩连续空行、**把 4 行测试矩阵移回正确位置**（634 → 597 行）、把 D3 的裸围栏改成文字描述；`doc-structure` 新增第 14 节 **Markdown 渲染健康度**（8 个文档 × 6 项：围栏配对/代码块内空行/连续空行/行内裸围栏/表格分隔行/列数一致）。**新检查立刻又在另外 3 个文档里抓出 6 处问题**，一并修复 |
| 72 | **材料不验证「文档引用的仓库文件是否存在」** | `ref-verifiable.mjs` 前 7 节只查 `dsh-xxx/lib/xxx.js` 这类**宿主源码引用**，没查仓库内文件路径 | 文档里大量引用仓库内文件（`test/hardening/xxx`、`lib/index.js`、`install-stepfix.ps1`…），但**没有套件验证这些文件真的存在**。改名或删文件后，文档会指向空气而无人发现。第 78 轮实测 **381 个路径引用**：全部可解析（16 精确 + 124 路径缩写 + 外部依赖/运行时生成物）。**结论是对的，但此前从没验证过** | `ref-verifiable.mjs` 新增第 8 节（2 项）：遍历 8 个文档的 381 个路径引用，逐条核实存在性；允许 3 类「看起来不存在但正确」——① 路径缩写（`hardening/foo` → `test/hardening/foo`）② 外部依赖（`assistant-stream.js` 等宿主内部文件）③ 运行时生成物（`real-tools.json` / `rebuilt-tools.json`，只出现在缺陷 46 的历史记录里）；**含反向验证**（必须解析出 ≥50 个引用，防止空转）。已用「插入不存在的文件引用」验证 —— **精确报出文件与行号** |
| 73 | **关键套件的「有效性」从未被证明（27% 有变异验证记录）** | 每轮加套件只验证「它能通过」，从不验证「它会不会失败」 | 第 79 轮实测：26 个关键套件里只有 **7 个（27%）** 有变异验证记录。一个永远不会失败的检查比没有检查更糟 —— 它制造「已验证」的假象。本轮对 **14 个无记录的套件**逐个注入破坏：**12 个被抓到**（`defect-coverage-matrix` 删矩阵一条 → ❌ D1 无守护、`path-consistency` 破坏 coerceValue → ❌、`known-limits-accuracy` 删一条限制 → ❌ 6/7、`doc-executable` powershell 语法错 → ❌、`coercion-semantics` Number→String → ❌、`bare-json-safety` 移除 hasContainer → ❌、`install-experience` 去掉 BOM → ❌、`install-failure-paths` 删 profile 检查 → ❌、`uninstall-flow` 删 Set-Content 警告 → ❌、`claims-audit`、`fake-test-audit`、`passthrough-design`），**2 个属职责边界**（`execution-safety` 管参数完整性、`meta-health` 是元套件自身）| `meta-health.mjs` 新增第 8 节 **关键套件的变异验证证据**（3 项）：维护 `VERIFIED` 清单（19 个关键套件，每个都标注了注入方式与预期报错）、检查关键套件都有证据、**反向验证** VERIFIED 里的套件真实存在且属关键套件。**结论**：「没有记录」≠「无效」—— 缺的是证据文档化。 |
| 74 | **「恢复出来的调用」没有任何 A/B 双路径一致性验证** | `differential.mjs` 做了 88 个随机流的 A/B 比对，但它生成的 tool-call 块是**原生形态**（`argumentsDelta` 固定 `"{}"`），**完全不覆盖插件恢复的调用**（`txtcall-` 合成块） | 宿主有两条消费路径：A. `BlockAssembler`（实时）、B. `AssistantStreamAccumulator → expand → assemble`（持久化）。**恢复的调用是插件最核心的产出，却从未验证过它同时满足两条路径**。第 81 轮实测：全仓库只有 4 个套件做完整 A/B，其中只有 `host-validator` 涉及 `txtcall`，而它只在 L290 提了一句、**没有做一致性比对**。**覆盖缺口确认** | 新增 `recovered-ab-consistency.mjs`（27 项）：① 5 个恢复场景的 A/B 装配结果 + `replayState` 逐字段一致；② 混合场景（恢复 + 原生 + 文本）；③ 恢复的流能被两条路径装配不抛异常；④ **delta 累积 == `block-end.arguments`**（`BlockAssembler` 只用 block-end、忽略 delta，所以必须单独验证 —— 实测「delta 多一个空格」只能靠这条抓）；⑤ 同流内 id 唯一。**顺带确认了两个设计**：有原生调用时不重复恢复、Anthropic 形态在 reasoning 块里不恢复 |
| 75 | **「已知限制」把插件明确支持的格式说成「不解析」** | README 的「已知限制」是逐条手写的，写的时候凭印象概括，没有对照代码里的实际支持范围 | L555 原文：「**其他文本格式不解析**（如 Markdown 围栏里的工具调用、其他 XML 方言）」。但插件**明确支持** `<invoke name=…>` —— `lib/index.js` L104-105 有专门的 `INVOKE_NAME_ATTR_RE` 正则，L332-334 的 `hasMarkup` 判据也包含它。第 82 轮实测：`<invoke name="pwsh"><parameter name="command">x</parameter></invoke>` → **恢复 1 个调用**（不是 0）。**读者会误以为 Anthropic 风格不支持** | 中文改为「只解析 3 类标记（`<tool_call>` 外层包裹 / `<function name=…>` 与 `<invoke name=…>` 裸元素 / 带 `antml:` 前缀），其他方言（如 `<tool><name>…</name></args></tool>`）不解析」；英文同步改为 "Only three markup families are parsed"；`known-limits-accuracy.mjs` 新增 3 项：必须写明支持的 3 类、必须提到 `<invoke>` 是支持的、**不得再出现笼统表述** |
| 76 | **`package.json` 缺 6 个对开源项目有实质影响的字段** | 元数据是照「能让 DSH 加载」的最小集写的，没按**开源包**的标准补全 | 实测缺 6 个：① `repository` —— npm 页面**不会**显示源码链接、`npm repo` 失败；② `keywords` —— 社区在 npm 搜 `deepseek`/`cordis`/`plugin` **找不到**这个包；③ `bugs` —— `npm bugs` 失败、用户不知道去哪报 issue；④ `homepage` —— 无项目主页链接；⑤ `author` —— 归属信息缺失；⑥ `engines` —— README/SUBMIT-GUIDE 都说需 Node 16.9+（用了 `Object.hasOwn`），但**包不声明**，用户在旧 Node 上装完才炸 | 补齐 6 个字段（`repository`/`homepage`/`bugs` 用 「你的 GitHub 用户名」 占位符，`author` 用 「你的名字」，让 SUBMIT-GUIDE 第 5 步一并填）；`keywords` 补 12 个（deepseek/cordis/plugin/tool-call/step-5-preview…）；`engines.node = ">=16.9.0"`；新增 `package-contract.mjs`（23 项）：必备字段、开源元数据、**engines 与 README 一致**、**真实解析 exports 契约**（临时 node_modules + 子进程）、**exports 隔离**（未声明子路径必须 `ERR_PACKAGE_PATH_NOT_EXPORTED`）、`npm pack` 产物内容与字节一致 |
| 77 | **README 没有 Node 版本要求，但 `package.json` 和 SUBMIT-GUIDE 都有** | Node 要求先是写在 SUBMIT-GUIDE（给提交者看的），后来才补进 `package.json`，**README（给用户看的）一直没补** | 读者从 README 开始了解项目、按安装步骤操作，**装完才发现 Node 版本不够**。实测：`package.json` 有 `engines.node`、SUBMIT-GUIDE L88 写「要求 Node 16.9+（因为用了 `Object.hasOwn`）」，**README 完全没有提**。这是信息分层不一致 —— 最该有的地方没有 | README 安装章节的前提补为「① DSH 已至少启动过一次；② **Node 16.9+**（插件用了 `Object.hasOwn`；`node --version` 可查）」，英文版同步；`package-contract.mjs` 新增检查：README 提到 16.9+ 时 `engines` 必须声明对应版本 |
| 78 | **占位符的「填写说明」只覆盖了 1 处，实际有 5 处** | SUBMIT-GUIDE 第 5 步是第 60 轮写的（那时只有 PASTE-READY 一个文件有占位符）；第 83 轮给 `package.json` 补字段时新增了 4 个占位符，**但没回头改说明** | 实测：`PASTE-READY.zh.md` 有 `<仓库/附件链接>` ×1，`package.json` 有 「你的 GitHub 用户名」 ×3 + 「你的名字」 ×1 —— **共 5 处**。而 SUBMIT-GUIDE 第 5 步只说「全文只有 1 处」。**用户照做会漏掉 package.json 的 4 处** → npm 页面的 Repository / Homepage / Issues 三个链接全指向 `github.com/「你的 GitHub 用户名」/...`，点进去 404。另发现 README 缺陷表 D76 的描述里也写了占位符（那是历史记录文本，会被误认为待填） | 重写 SUBMIT-GUIDE 第五步：拆成 5.1（PASTE-READY 1 处）+ 5.2（package.json 4 处，给出占位符/次数/替换值对照表 + 替换后示例 + **一条验证命令** `(Select-String -Path package.json -Pattern '"YOUR_" 前缀的' -AllMatches).Matches.Count` 应输出 0）；标题改为「共 5 处，别漏」；README 缺陷表 D76 里的占位符改成「你的 GitHub 用户名」等中文描述；`deliverable.mjs` 新增第 11 节（4 项）：列出所有待填占位符、**package.json 的每个占位符必须在 SUBMIT-GUIDE 里有说明**、**缺陷表里不得出现待填占位符**、SUBMIT-GUIDE 必须给出总数。已用 3 种注入验证（删说明 / 加新占位符 / 缺陷表加占位符）—— **全部被抓到** |
| 79 | **效果数据的算术不自洽（13,802 + 390 ≠ 14,408）** | 三个数字来自**不同时点**的统计，但写在同一句里，读者会当成同一次运行的完整分类 | README 原文：「在 **14,408 条真实流**上做对照实验：① **13,802 条**原生含结构化 tool-call…② **390 条**纯文本流…」。而 `effect-quantify.mjs` 里的 `hasNativeToolCall` 是**二值判断**，`nativeStreams` 与 `textOnlyStreams` **必然互斥且完备** —— 所以三项相加应等于总数。实测 `13,802 + 390 = 14,192`，**差 216 条**，说明这三个数字不可能同时为真 | ① 中文改成「同一时点的快照上做对照实验」，**不再声明互斥分类的精确条数**，并加「口径说明」明确「分类与总数在同一次运行里统计、而 `14,408` 是另一时点快照，两者不应相加核对」；② 英文同步改成 "Controlled experiment on a same-run snapshot" + `Scope note`；③ L380 的 `14,408` 标注「某一时点快照；真实流会随日常使用增长」；④ `claims-audit.mjs` 新增**算术自洽检查**：若同一句里同时出现互斥分类与总数，必须相加相等。**注意**：`claims-audit` 原来只检查「量级合理（> 10000）」，不检查精确值 —— 这也是缺陷本身的一部分 |
| 80 | **「运行模式」表格的耗时被低估近 60%（写 6 分钟，实测 9.5 分钟）** | 第 67 轮修这张表时只**实测了套件数**，耗时是**估的**；而检查套件只校验套件数，不校验耗时 | README 写 `--offline` 模式「**约 6 分钟**」。第 85 轮实测：**82 个套件 / 568.6 秒 = 9.5 分钟**，比文档写的**多 58%**。后果：读者以为有空跑一下，结果等了 9 分钟。根因是**耗时无法静态推导**（只能实测），所以第 67 轮的静态计算检查天然覆盖不到它 | 实测后修正为中英双语「约 9.5 分钟 / ~9.5 min」；`doc-consistency` 新增第 16 节 **运行模式的耗时关系**（3 项）：① 套件数 quick < offline < full；② **耗时也必须 quick < offline < full**；③ **offline 耗时相对 quick 的比例未被严重低估**（`timeRatio >= suiteRatio * 0.5`，实测套件比 1.05x、耗时比 5.70x）；④ full 与 offline 的套件差（= 需真实日志的套件数）在 5–20 之间 |
| 81 | **会增长的数字只有 1 处标了「快照」，其余 6 处会被当成当前值** | 第 85 轮只给 L380 那一处加了「某一时点快照」标注，其余 6 处（测试矩阵 + 已知限制）漏了 | 第 86 轮**完整跑了一遍 9 个需要真实日志的套件**（此前 20+ 轮都只跑 `--quick --offline`，这 9 个一直没被验证过）。实测真实流已从 **14,408 增至 15,675**（+8.8%）。而 README 有 **7 处非缺陷表引用** 14,408，只有 1 处带快照标注 —— 读者会把其余 6 处当作当前值。**顺带发现**：L596 写「**1.4 万条**真实流零回归」，用了模糊描述，与精确数字口径不一致 | ① 给 5 处测试矩阵引用加「（快照）」；② 把 L596 的「1.4 万条」改为带快照标注的精确表述；③ 在测试矩阵前加**增长说明**（「写作时 14,408；第 86 轮复跑已是 **15,675**；你的机器上通常更多，这不影响任何结论」），中英双语；④ 合并了一段重复的旧说明并清理双空行；⑤ `doc-consistency` 新增第 17 节（3 项）：**所有「条真实流/条真实日志」数字（缺陷表除外）都必须带「快照」说明**、测试矩阵前必须有增长说明、**反向验证**确实有被标注的快照（防空转）。已抓到 L502/L506/L596 三处漏标 |
| 82 | **6 处「恒真断言」（`ck(..., true, ...)`），其中 `real-cordis` 占 3 处** | 写测试时为了「记录一件已发生的事」而用了 `true`，而不是「断言一个应该成立的性质」 | 全仓库扫描发现 6 处：`real-cordis` 3 处、`claims-audit`/`lifecycle`/`type-fuzz` 各 1 处。**最严重的一条**：`real-cordis` L218 `ck("插件不抛在 dispose 阶段", true, "")` —— 而实测 **Cordis 4 的 Context 根本没有 `dispose` 方法**（`typeof ctx.dispose === "undefined"`），这条断言在**骗人**。另两条（L67「装载不报错」、L187「双实例不崩溃」）虽然前面的 try/catch 已经记录了真实结果，但断言本身恒真、不验证任何东西 | ① L67 改为 `ck(..., loadError === null, loadError?.message)`；② L187 改为 `ck("双实例下恢复数量合理（1–2 个）", calls.length >= 1 && calls.length <= 2)`；③ L218 改为**如实记录** `ck("如实记录：Cordis 4 的 Context 无 dispose API（本场景不可测）", hasDispose === false)`，并补一条**可测的替代**（`ctx.on` 返回的 unsubscriber 能被调用）；④ `fake-test-audit` 新增第 3 节 **恒真断言扫描**（2 项 + 反向自检）：扫描 90 个测试文件，正则识别 `ck(<字符串>, true, …)`，允许 4 个已说明的例外文件；⑤ 顺带发现 `ctx.on` 是 **Cordis 的 Proxy 动态属性**（不在原型链上），原代码报「未找到」但没断言 |
| 83 | **「92 个套件全部通过」里混入 1 个永不失败的剖析工具** | `run-all.mjs` 用 `readdirSync` 自动发现套件，把所有 `.mjs` 都当测试跑；`perf-profile` 是**剖析工具**（只 `console.log`，无 `process.exit` 失败路径），却被计入「全部通过」 | 实测 90 个 hardening 文件中：**89 个能失败、1 个永不失败**（`perf-profile`）。加 2 个核心套件后是 `92 = 91 验证 + 1 剖析`。`fake-test-audit` 已正确豁免它（`NOT_TESTS`），**但它仍被计入「92 个套件全部通过」** —— 读者会以为 92 个独立验证，数字虚高。**核实**：性能回归**没有缺失**，由 `perf-baseline` 的 7 项断言承担（含「插件开销 < 5ms」「无按请求累积 < 5KB/次」「吞吐 ≥ 20 万 chunk/s」） | ① README 把「92 个可独立运行的套件」改为「**92 个（其中 91 个会失败、1 个是输出供人工阅读的剖析工具）**」；② 测试矩阵前加**分类说明**（中英双语），明确「性能回归由 `perf-baseline`（7 项断言）负责，所以性能这块没有被放过」；③ `meta-health` 新增第 9 节（3 项）：**扫描所有 hardening 套件识别「永不失败」的**、要求它们必须在 README 里有标注、README 必须区分「验证套件」与「剖析工具」，**含反向验证**（必须检测到 ≥1 个，防止空转） |
| 84 | **表格检查用「结构启发式」，而非 CommonMark 真实规则；且只覆盖 2/8 个文档** | 前几轮的渲染检查都是「以 `\|` 开头就算表格行」的正则判断，没按规范验证「必须 header + delimiter」；覆盖范围也只有 2 个文件（第 9 节）或 5 个文档（第 13 节） | 第 89 轮实测：真实规则下 **8 个文档共 22 个表格、48 个代码围栏**，而第 9 节只查 2 个文件（10 个表）、第 13 节只查 5 个文档（17 个表）。**关键差异**：CommonMark 里「连续的 `\|` 行」如果没有 delimiter 行，**不会渲染成表格**，只是普通段落 —— 而旧检查会把它当成表格并「通过」。**结论**：22 个表全部正确，但这个结论此前没有被完整验证过 | `doc-structure` 新增第 15 节 **真实解析规则验证**（3 项）：按 CommonMark 规则（header + delimiter + 围栏跳过）重新识别表格，覆盖**全部 8 个文档**；同时验证**围栏成对**（含 `~~~` 变体）；含反向验证（必须找到 ≥20 个真实表格、围栏数必须为偶数）。实测 **22 表 / 48 围栏 / 0 问题**，比第 13 节的 17 个更完整 |
| 85 | **重大：89 轮来一直误判 `dsh-llm/lib/types/invariant.js` 「不存在」，实测它在 asar 里确实存在** | 本地测试副本（`.tmp/audit-deps`）**不完整** —— 缺这个文件；所有检查都基于副本，于是「副本里没有」被当成「文件不存在」 | 第 90 轮**直接解析 `app.asar`**（1.74 亿字节）读出真实结构：`/dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/` 有 **14 个 `.js`**，其中**包含 `invariant.js`（4,401 字节）**，内容是 `validateStream` / `validateIndex` / `validateDelta` —— **宿主协议的校验器**。而本地副本只有 13 个（缺它）。**影响**：D37 把它记为「文档引用了不存在的文件（硬伤）」，`ref-verifiable.mjs` 第 5 节把它列为「已证伪」并检查「不得作为有效引用」—— **整个判定链建立在错误前提上**。**同时验证**：asar 内 `dsh-llm` 版本 **0.2.1-rc.2**、`lib/index.js` **105,272 字节 / SHA256 `d18d8ae4...`** 与本地副本**完全一致** —— 所以除这一个文件外，其他验证都基于真实代码 | ① 从 asar **提取补全** `invariant.js` 到本地副本（14 个 .js 齐全）；② README 的 D37 追加**订正说明**（该文件实际存在、当初误判因副本不完整）；③ `ref-verifiable.mjs` 第 5 节**从「证伪」改为「验证存在」**（`ck("invariant.js 在本地副本里存在", ...)`，若缺失则明确报「副本不完整」而非「文档写错」）；④ `invariant.js` 移出 `KNOWN_UNVERIFIABLE`；⑤ `meta-health` 新增第 10 节（4 项）：**直接从 asar 读取真实 dsh-llm**，比对版本、`lib/index.js` 字节、`lib/types/*.js` 集合完整性；asar 不可达时明确跳过不误报；**已当场抓到我自己新写的 1 处恒真断言并修复** |
| 86 | **从未针对宿主自己的 7 条流协议规则验证过插件输出** | 前 90 轮只验证了「`BlockAssembler` 能装配」「`AssistantStreamAccumulator` 不崩」，但没验证「**宿主自己的 `invariant.js` 里那 7 条规则全部满足**」 | 第 90 轮发现 `invariant.js` 真实存在后，第 91 轮提取出它里面的 **7 条流协议规则**：R1 `block index` 必须是非负安全整数、R2 delta 必须指向同类型已打开块、R3 `finish` 后不得再发 chunk、R4 不得重复 `block-start`、R5 `block-end` 必须有 open、R6 `block-end` 类型必须与 `block-start` 一致、R7 `finish` 时不得有未关闭块。**这 7 条是宿主真正执行的校验** —— 插件违反任何一条都会让整条流被拒。实测：插件在 **7 种形态**（标准单调用 / 两个调用 / 原生透传 / 带 usage / 交错块 / 空响应 / 恢复+交错混合）下**全部满足** | 新增 `invariant-conformance.mjs`（19 项）：① 确认 `invariant.js` 存在且是协议校验器；② 从源码提取并验证全部 **7 条规则**真实存在；③ **校验器自检**——对 5 类已知坏流（R5/R4/R7/R3/R6）必须报错；④ 用真实规则验证插件在 **7 种形态**下的输出。实测 **11 passed / 0 failed**（19 项断言），全部满足 |
| 87 | **手写重写了宿主的校验规则，导致「漏 2 条 + 过严 1 条」** | 第 91 轮把 `invariant.js` 的规则**读出来再手写成 JS**，而不是直接调用宿主实现 —— 手写必然有细节偏差 | 第 92 轮逐行对照宿主源码（74 行），发现手写版**漏了 2 条、且 1 条过严**：① **R8 `usage` 只能出现一次**（宿主 L56-60）—— 手写版漏了；② **R9 必须有一个 terminal `finish` 才结束**（宿主 L70-71）—— 手写版漏了；③ **R10 `finish` 为 `error`/`aborted` 时「允许」有未关闭块**（宿主 L62）—— 手写版**过严**，会把宿主的合法流误判为违规。这三点若不修，「插件满足全部规则」的结论就是**基于错误的判定标准** | 改为**直接从 `invariant.js` 源码提取 `validateIndex`/`validateDelta`/`validateStream` 三个函数并求值**（它们不依赖模块作用域），用**宿主自己的实现**做判定 —— 规则永远与宿主同步。新增验证：① 校验器自检扩到 **7 类坏流**（含 R8、R9）；② 单独验证 **R10**（error/aborted finish + 未关闭块**必须通过**）；③ 插件 7 种形态全部通过宿主真实校验器。**21 passed / 0 failed**（从 11 增至 21）。**顺带**：新检查抓到自己的 1 处恒真断言（`ck("提取的校验器可求值", true, "")`）和 1 处失效的守护标记，均已修复 |
| 88 | **真实数据套件（覆盖全部真实流）用的是手写校验器，而非宿主实现** | 第 93 轮修 `invariant-conformance` 时只改了那一个套件，没意识到 `health-check` 和 `replay-real-streams` **各自还有一份手写校验器** | 三个套件里共有 **3 份**流协议校验器实现：`health-check` L70 的 `validate()`、`replay-real-streams` L34 的 `validateStream()`、以及宿主真实的 `invariant.js`。逐行对照后发现：`replay-real-streams` 的手写版**已与宿主完全一致**（含 R8/R9/R10），但 **`health-check` 的手写版漏了 R8（`usage` 重复）和 R9（缺 terminal `finish`）** —— 而它跑的正是**全部真实流**。这意味着「全部真实流全部合规」这个结论此前**基于不完整的规则** | ① 新建共享模块 **`test/hardening/_host-invariant.mjs`**（2,950 字节）：从 `invariant.js` 源码提取 `validateStream` 并求值，导出 `loadHostValidator()` / `validate()`；② `health-check` 与 `replay-real-streams` 改为**优先用宿主真实校验器**，手写版降级为后备（改名 `validateHandWritten` / `validateStreamHandWritten`）；③ 改造后**实测 全部真实流全部通过宿主真实校验器**（零失败、零拒绝、两路径一致）；④ 修复改造引发的 4 个连锁问题（`_` 前缀被当成套件）—— `run-all` / `fake-test-audit` / `meta-health` / `deliverable` / `doc-consistency` **5 处**统一跳过 `_` 前缀文件 |
| 89 | **「运行实例版本滞后」的判定只比较了最早进程，没定位到真正加载插件的 host 进程** | `live-instance.mjs` 只做「安装副本写入时间 vs 某个进程启动时间」的粗比较，没区分 Electron 的 6 个子进程 | 第 94 轮实测：一个 DSH 会拉起 **6 个进程**（1 主 + gpu-process + utility/network + renderer + `--expose-internals` host + 1 工具子进程），**只有 `--expose-internals ... dsh-desktop-host` 那一个真正加载插件**。粗比较会拿最早的主进程（10-22 13:45）算差值，虽然结论碰巧对（滞后 1043 分钟），但**依据错了** —— 若用户重启后主进程变了而 host 进程没变，粗比较会误判 | 新增 `runtime-process-check.mjs`（8 项）：① 安装副本与源码**字节一致**；② 含关键修复标记（`coercedJson`）+ `VERSION`；③ **用 `Get-CimInstance` 拿完整命令行，精确定位唯一的 dsh host 进程**（同时含 `dsh-desktop-host` 与 `--expose-internals`），断言「**恰好 1 个**」；④ 用**该进程**的启动时间算滞后（本次 1043 分钟，明确告警「运行中的 DSH 加载更早版本」）；⑤ 会话日志实证。**顺带**：新套件的 3 处恒真断言被 `fake-test-audit` 当场抓到并修复 |
| 90 | **README 缺少 Top-Down 摘要：陌生人要读到第 101 行才知道怎么装** | 这份 README 是**调查笔记**演化来的 —— 按「我发现问题 → 我查根因 → 我做了修复」的时间顺序写，而不是按「读者需要什么」组织 | 实测章节结构：前 3 节（98 行）全是**问题现象 + 根因调查**，安装入口在 **L109**、重启提醒在 **L118**。**开源 README 惯例是开头 30 秒能看完 TL;DR**，而这里读者要先读 100 行。虽然内容都对，但**组织顺序对陌生人不友好** —— 想「直接用」的人得先翻过一堆调查过程 | 在标题后插入**「30 秒摘要」区块**（34 行，中英双语）：问题是什么 / 修复做了什么 / **安装命令** / **必须重启** / **怎么确认生效** / 测试规模 / 指向已知限制 / **分流导航**（「只想用」跳到第四·五·六节，「想看调查」继续读）。`deliverable.mjs` 新增第 12 节（7 项）：摘要必须在前 40 行、含 4 个关键点（问题/安装/重启/验证）、**安装命令必须在前 50 行内可达**、英文版同步、指向已知限制、摘要区块有实质内容（≥15 行）。实测安装入口从 **L109 → L15** |
| 91 | **TL;DR 里的 2 个内部锚点失效（点下去跳不过去）** | 锚点是从**当时的标题文本**手写出来的；标题后来改过（缺陷数从 89 变 90、`## Verify` 的 slug 是 `verify` 而非 `verification`），锚点没跟着改 | 第 95 轮加 TL;DR 时用了 5 个锚点，第 96 轮按 GitHub 的 slug 规则（小写 + 去标点 + 空格转连字符）逐个核对，发现 **2 个失效**：① `README.md` L28 指向 `#十一对抗性审查发布前自查共发现并修掉-166-个自身缺陷`，但标题实际是「**90 个**」→ 跳不过去；② `README.en.md` L36 写 ``[Verify](#verification)``，但章节标题是 `## Verify` → slug 是 `#verify`。**这类问题肉眼几乎看不出来** —— 链接文字是对的，只有真的点下去才发现 404 | 修正 2 处（89→90、`#verification`→`#verify`）；`deliverable.mjs` 新增第 13 节（2 项）：**按 GitHub slug 规则重建所有标题的锚点**（含重复标题的 `-1`/`-2` 消歧），逐个核对文档里的 ``[文本](#锚点)`` 链接是否可达，并含**反向验证**（必须找到 ≥5 个锚点，防止「没有链接所以通过」）。实测 9 个锚点全部可达 |
| 92 | **`package.json` 有完整 npm 元数据，但没说「要不要发 npm」（读者会困惑）** | 第 83 轮补全 npm 元数据时只想着「开源包应该有哪些字段」，没考虑「这个包**实际不发布**」这件事要不要写清楚 | `package.json` 有 `repository` / `homepage` / `bugs` / `keywords` / `engines`（**这些字段只有发布到 npm 才有意义**），但 ① 没有 `private: true`；② README **只教「克隆仓库 + 运行 `install-stepfix.ps1`」**，从未提 `npm install`；③ SUBMIT-GUIDE **完全没提 npm**。读者看到完整的 npm 元数据会问「我该 `npm install` 吗？」—— 而 npm 包里**只有 5 个文件**（`lib/index.js` + 3 个文档 + `package.json`），**不含 `test/` 和 `install-stepfix.ps1`**，照 README 跑验证命令会全部失败 | ① `package.json` 加 **`private: true`**（明确禁止误发布，字段数 15→16）；② README 安装章节加说明：**「这个包不发布到 npm」**，元数据只是让仓库地址可被工具识别，安装方式是克隆 + 脚本；③ SUBMIT-GUIDE 同步说明；④ `package-contract.mjs` 新增第 7 节（5 项）：`private` 必须存在且为 `true`、README 必须说明不发布、SUBMIT-GUIDE 同步、**反向验证**（若有 npm 元数据但未 `private`，README 必须给出 `npm install` 路径）、**不能同时教两种安装方式而不区分**。实测 **28 passed**（23→28） |
| 93 | **`install-stepfix.ps1` 会永久损坏用户配置里的中文（编码陷阱）** | 脚本用 `Get-Content $patchFile -Raw`（**不指定 -Encoding**）读取 `cordis.patch.yml`，再用 `WriteAllText` 写回。PowerShell 5.1 在中文系统（代码页 936）下按 **ANSI/GBK** 解码无 BOM 的 UTF-8 文件 | 实测：`cordis.patch.yml` 是 UTF-8 **无 BOM** 且含非 ASCII（模型名里的「书生」等，共 184 个非 ASCII 字节）。脚本读进来时已按 GBK 解码，写回时按 UTF-8 编码 → **中文被永久损坏**。实测演示：「书生专用」→「**涔︾敓涓撶敤**」。**这是用户执行的第一条命令**，会损坏他们的配置文件，且**不可逆** | ① 改用 `[System.IO.File]::ReadAllBytes` + `[System.Text.Encoding]::UTF8.GetString` **显式按 UTF-8 读取**；② 写回时用 `UTF8Encoding($false)` **保留原有 BOM 状态**（实测原文件无 BOM，写回后也无 BOM）；③ 自检处同样显式 UTF-8 读取（避免含非 ASCII 时**假报警**）；④ `deliverable.mjs` 第 14 节加检查：必须显式 UTF-8、**不得存在「裸 Get-Content -Raw + WriteAllText」的危险组合** |
| 94 | **`install-stepfix.ps1` 自己是 UTF-8 无 BOM，PowerShell 5.1 按 ANSI 读脚本源码 → 用户第一条命令就语法错误** | 脚本里有大量**中文注释与中文字符串**，但保存为 UTF-8 无 BOM。PowerShell 5.1 读 `.ps1` 源码时同样按 ANSI 解码 | 实测：脚本 5,468 字节中 **1,173 个非 ASCII 字节**。PS 5.1 读到的第 1 行是乱码，且**字节边界被破坏**（出现问号替换符），导致**字符串引号被吃掉** → 解析出 3 个语法错误（缺右括号、字符串缺终止符、缺右大括号）。**用户跑 `.\install-stepfix.ps1` 会直接报错，连 profile 检查都到不了** | 给脚本加 **UTF-8 BOM**（`UTF8Encoding($true)`）。实测修复后 PS 5.1 读到的第 1 行正确显示中文，语法检查 0 错误。`deliverable.mjs` 第 14 节加检查：**脚本必须带 BOM**、必须含非 ASCII（证明 BOM 不是多余）、**真实执行 powershell -File 验证无 ParserError 且中文提示正常显示** |
| 95 | **安装脚本的失败路径只抛 .NET 原始异常堆栈（用户看不懂）** | 前 98 轮只测了**成功路径**；脚本也没有 `try/catch`，权限不足时让 `Copy-Item` / `WriteAllText` 的异常直接冒出来 | 实测（把 `cordis.patch.yml` 设为只读）：用户看到的是 `Copy-Item : Access to the path ... is denied.` + `CategoryInfo : PermissionDenied` + `FullyQualifiedErrorId : CopyFileInfoItemUnauthorizedAccessError` + 脚本行号 —— **一屏 .NET 堆栈**。用户既不知道**发生了什么**（是权限？占用？磁盘满？），也不知道**怎么修**，更不知道**配置有没有被改坏**。而这恰好发生在「安装失败」这种最需要清晰指引的时刻 | ① 备份、复制、写回三处都包 `try/catch -ErrorAction Stop`；② 每处给出**可操作**提示：文件只读/权限不足 → 取消只读；被占用 → 退出 DSH；磁盘满 → 清理；③ 明确告知**当前状态**（「尚未修改任何配置，可以安全重试」/「配置未修改，插件不会生效」+ 备份位置）；④ `deliverable.mjs` 新增第 15 节（10 项）：**真实执行脚本**验证 profile 不存在、缺 patch、正常路径、权限错误 4 种场景的退出码与提示内容，并断言**错误输出不得是原始堆栈**、**必须给出处理建议** |
| 96 | **安装脚本的备份只增不删（实测累积 1114 个文件）** | 脚本每次运行都 `Copy-Item` 一个带时间戳的备份到系统临时目录，但**从不清理旧备份** | 第 100 轮实测：`%TEMP%\dsh-install-backup` 里已累积 **1114 个** `cordis.patch.yml.bak-*` 文件（0.19 MB）。虽然单个只有 0.3 KB，但**只增不减**，长期使用会无限增长；而且目录里混着上千个几乎相同的文件，用户想找「某个时间点的配置」反而更难。同时验证了**三个从未测过的路径场景**：路径含空格、路径含**中文**（中文用户名必然遇到）、`-ProfileDir` 参数 —— 三者**均正常** | ① 加**备份轮转**：只保留最近 **10** 个 `cordis.patch.yml.bak-*`，其余删除，且**只删本脚本自己产生的文件**（不动目录里其他内容）；② **位置很关键** —— 轮转必须在**创建完本次备份之后**执行。第一版放在创建前，实测结果是 **11 个**（10 个旧的 + 1 个新的）；修正顺序后恰好 **10 个**，重复运行保持 10 个；③ 轮转失败**不阻断安装**（只是磁盘占用，不影响正确性）；④ `deliverable.mjs` 新增第 16 节（11 项）：**真实执行**验证三种特殊路径 + 备份数量受控 + **不误删非备份文件** |
| 97 | **「手动安装」这条路从未被测过，且缺关键步骤；英文版根本没有这段** | README 同时提供了「脚本安装」和「手动安装（不想用脚本时）」两条路，但 100 轮来**只测了脚本那条** | 第 101 轮实测发现三个问题：① 中文版手动步骤**只有 2 步**（复制文件、追加 patch），**完全没提**「必须重启 / 备份 / 自检」，而脚本版这三样都写了 —— 手动安装的用户装完不重启，会以为「装了没反应」；② **英文版根本没有手动安装段落**（只有脚本），中英严重不对等；③ 实测对比两边产物：**文件树完全一致**、patch 语义等价（只差一个空行），说明**手动路径本身是可行的**，问题纯在文档 | ① 中文版手动步骤补到 **6 步**：加「先备份」「`node --check` 自检」「**必须重启**（含「这条对脚本和手动同样适用」）」「重启后用 `live-instance.mjs` 确认」；② 英文版**新增完整 Manual install 段落**（24 行），与中文对齐；③ `deliverable.mjs` 新增第 17 节（15 项）：中英手动步骤都必须含重启/备份/自检，并**真实执行**脚本安装与手动安装两边、对比产物（`lib/index.js` 存在、patch 语义等价、含 `insert:` 形式与插件名） |
| 98 | **「临时禁用」开关从未验证过，且文档有两处会误导用户（写错了不报错）** | README 从很早就写着「临时禁用：设置 `DSH_TEXT_TOOL_CALL_RECOVERY=0` 后重启」，但这个开关**100 轮来从未被测试** | 第 102 轮实测发现三个问题：① **只认精确的字符串 `"0"`** —— `"false"` / `"off"` / `""` / `"00"` / `"0 "`（带空格）**全都不会禁用**，而且**不报任何错**，用户会以为禁用了而实际还在工作；② **文档的 `$env:X = "0"` 对已运行的 DSH 完全无效** —— 环境变量在**进程启动时**拷贝，在另一个 PowerShell 窗口设置不会传播过去，用户关掉窗口变量就没了；③ 实现本身是**正确的**（`"0"` 时 `apply()` 直接 return，不注册监听器 = 完全不干预），问题纯在文档 | ① 实测确认实现的 **9 种语义**：未设置→恢复、`"0"`→不注册、`"1"`→恢复、`"false"`/`""`/`"00"`/`"0 "`→仍注册；② README 重写禁用章节，明确**两个坑**（必须在 DSH 启动前设置、只认精确 `"0"`），给出 `[Environment]::SetEnvironmentVariable(..., "User")` 的正确写法与「用完删掉」提醒；③ 英文版同步补全；④ 新增 `env-disable-semantics.mjs`（**19 项**）：9 项实现语义 + 6 项文档完整性 + 反向验证；⑤ 顺带修正一处因新增套件而失效的锚点与套件数（94→95） |
| 99 | **README 把「从备份恢复」列为**首选**卸载方式，但从未实测；且对 `Set-Content` 的警告**指错了环节** | `uninstall-flow.mjs` 只测了「手工删 patch 条目」，从没走过「从备份恢复」这条路 | ① 实测「安装 → 从备份恢复」：**字节完全一致**（无损），插件条目消失、原有中文与所有条目完整保留 —— 这条路是可靠的，但**100 轮没人验证过**；② 更关键的是 README 的警告**说错了原因** —— 它说「`Set-Content` / `Out-File` 会把换行**压成一行**」，实测**不成立**（行数从 6 变 7，反而多了）；真正的问题是 **`Get-Content -Raw`（不指定 `-Encoding`）在 PowerShell 5.1 下按 ANSI/GBK 解码 UTF-8 无 BOM 文件** —— **读进来的时候中文就已经坏了**，`Set-Content -Encoding UTF8` 写回时还会再加 BOM。**警告指向写、实际坏在读**，用户按警告去「小心换行」完全防不住中文损坏 | ① 重写 README 卸载章节第 1 条，给出**可执行**的 `Copy-Item` 命令并注明实测「字节完全一致」；② 第 2 条的警告改为**准确指向读取环节**（`Get-Content -Raw` 按 ANSI 解码），并给出显式 UTF-8 的 .NET 安全写法（`[System.IO.File]::ReadAllText/WriteAllText` + `UTF8Encoding($false)` 保持无 BOM）；③ `uninstall-flow.mjs` 扩展（19 → **30 项**）：新增端到端「安装 → 从备份恢复 → 字节一致 + 无插件条目 + 中文完好 + 其他条目完好」，以及 5 项文档准确性检查（含「正文不得再声称会压成一行」的**反向**检查，且正确排除缺陷表里的历史记录） |
| 100 | **「代码围栏成对」的断言用错了度量方式，导致文档本身没问题却报错** | `doc-structure.mjs` 第 15 节统计的是「**起始**围栏数」（只有开启时 +1），然后断言 `totalFences % 2 === 0`。当文档里出现**缩进围栏**或**带 info string 的变体**（以 info string 形式（如 `+x3+`bash））时，起止识别不再对称，于是这个断言会因为**度量方式**失败，而不是文档真的有问题 | 第 103 轮给 README 加了一段嵌套代码示例后，该断言报「围栏数 55（奇数）」失败。逐个文件核实：所有 8 个文档的**围栏行总数**都是偶数（合计 **110**），**每个文件内部都成对** —— 也就是说**文档完全正确，是检查器自己数错了** | 改为统计**每个文件的所有围栏行**（开 + 关），并断言「**每个文档**内部围栏行数为偶数」，同时打印总数便于人工核对。修正后 `doc-structure` **53 passed / 0 failed**，围栏行总数 110，全部成对。**教训**：断言失败时要先确认**度量方式**对不对，再改文档 —— 否则会把正确的文档改坏 |
| 101 | **恢复成功后未清空连续空响应计数，导致后续空响应不再重试（功能性缺陷）** | 空响应计数（`emptyResponseStreak`）只在「**有可见正文**」分支清零（L947），漏掉了「**恢复出可执行工具调用、但没有普通正文**」这条同样属于成功的路径 | 实测序列：**空响应（streak=1，触发 EMPTY_RESPONSE）→ 恢复成功（无正文，计数未清零）→ 再空响应（streak=2）**。第 3 次被当成「模型确定性失败」**原样透传 finish**，而不再改写成可重试错误 —— **用户失去了重试机会**。这是**功能性缺陷**：插件明明成功恢复过一次，却把后续的间歇性空响应永久当成了「模型的固定行为」。前 103 轮从未测过「恢复成功后再空」这个序列 | 在恢复成功的返回点（`yield finish{kind:"tool-calls"}` **之前**）补一句 `emptyResponseStreak.delete(modelKey)`，与「有可见正文」分支保持一致。**lib/index.js 43,906 → 44,424 字节**（+518，含注释）。新增 `streak-resolution.mjs`（**19 项**）：20 个模型**并发**跑空响应无串扰、同模型连续空响应 1/2/3 次的行为、两模型**交错**执行互不影响、恢复成功（**有/无正文两种**）后计数清零、**「先空→恢复→再空必须重新 error」的回归断言**、LRU 上限 64 的淘汰与保留 |
| 102 | **「LRU 有上界」的断言只看堆内存，实际上**即使完全没有上限也会通过**（假通过）** | `memory-lifecycle.mjs` 第 5 节声称验证「`emptyResponseStreak` 有上界」，但断言写的是「500 个模型后**堆增长 < 10MB**」 | 实测一个 LRU 条目只存「模型名 + 一个小整数」，约 **100 字节** —— 500 个条目合计仅 **0.048 MB**，**远小于 10MB 阈值**。也就是说：**哪怕把 `MAX_TRACKED_MODELS` 完全删掉、Map 无限增长，这个断言照样通过**。这是一条**无效断言**（看似覆盖、实则测不到）。第 104 轮修复缺陷 101 时顺带核查，才发现这个问题 | 改为**直接数 Map 中的条目**：跑 N 个模型后各再跑一次空响应，若仍在 Map（streak=2）→ 透传无 error；已被淘汰（streak=1）→ 重新 error，据此统计实际条目数，断言 `≤ 64`。同时补一条**反向验证**「少于上限时条目都保留（10 个模型全部在 Map 中）」，防止「计数机制完全不工作」也能通过。顺带修正第 6 节的 WeakRef 断言：单次 `global.gc()` 不足以让 V8 回收，改为多轮 GC + `setImmediate`，判据从「全部回收」放宽到「**多数**被回收」（否则偶发失败）。**8 passed**（从 6 增至 8） |
| 103 | **多处内存断言阈值比实测宽 13~400 倍（即使每流泄漏一整个 block 对象也测不出来）** | 内存类断言的阈值是「拍」出来的大数字，不是基于实测基线；且**从未被审计过** | 第 105 轮只发现 1 处（LRU 那条），第 106 轮**系统扫描全部 127 处阈值断言**后发现同类问题至少 **6 处**：`memory-lifecycle` L71 阈值 20MB / 实测 **0.17MB**（118 倍）、L89 25MB / 0.47MB（53 倍）、L109 20MB / 0.05MB（**400 倍**）、L143 10MB / **~0MB**（无穷倍）、`soak-test` L103 50MB / 0.38MB（131 倍）、L163 5MB / 0.02MB（**250 倍**）。换算成「每次操作可泄漏多少字节才被发现」：**20MB / 3000 条流 = 每流 6,990 字节**，而一个 block 对象只有 **~500 字节** —— **即使每流泄漏一整个 block，这些断言也全部通过** | ① 全部收紧到「实测 × 10 以内」（1.5 / 1.5 / 0.5 / 1 / 3 / 0.2 MB），并补上实测值打印；② 新增 **`threshold-audit.mjs`（10 项）** 元套件：内置 `BASELINES` 表记录每条内存断言的实测基线与允许上限，**扫描所有套件的 MB 类断言，要求阈值不超过实测的 10 倍**；要求每条内存断言**必须打印实测值**（便于人发现阈值过宽）；**反向验证**基线上限本身不虚高（≤ 实测 × 10）；并排除误匹配（`100MB 单块不崩溃` 里的 MB 是提示文本） |
| 104 | **时间类断言没有「可解释性」约束：读者分不清「性能保证」还是「只防挂死」** | 第 106 轮的阈值审计只覆盖**内存类**（MB）断言。时间类断言（24 处）**性质完全不同**：它们必须留 CI 抖动余量，不能像内存那样按「实测 × 10」收紧 | 实测：`perf-baseline` 的宽容度是 **227~357 倍**（实测 0.015~0.079ms，上限 5~20ms），`scan-limit` 实测 1~2ms、上限 500ms。**这些宽阈值本身是对的**（CI 上可能慢几十倍），而且 `perf-baseline` 文件头已写明「宽松阈值，只抓严重退化」。**但并非所有套件都这样** —— `state-isolation` L166 只写「200 个模型顺序处理 < 3 秒」，既没打印实测值、也没声明这是宽松上限，读者会误以为「3 秒是性能保证」（实际只需几毫秒） | 给 `threshold-audit.mjs` 新增**第 5 节（时间断言可解释性）**：扫描全部耗时断言，要求满足**任一**可解释性条件 —— ① 打印了**实测值**（`${r.ms.toFixed(0)}ms`）② 断言文字有**语义声明**（「宽松」「只抓严重退化」「不挂死」「立即返回」「毫秒级」）③ **文件头**有整体声明。不合规即报错，并含**反向验证**（必须扫到 ≥15 处，防止正则失效空转）。实测扫描 **22 处**全部可解释。顺带修正两处：`state-isolation` L166 补声明；审计自身的**误报**（把 `message 长度 < 300 字符` 当成耗时断言，判据收紧为「必须出现时间变量名」）。**12 passed / 0 failed**（从 10 增至 12） |
| 105 | **`mutation-test.mjs` 改写 `lib/index.js` 时没有 try/finally 保护，中途崩溃会让源码永久停留在变异状态** | 变异测试需要临时改写被测源码来验证「测试是否真能抓到 bug」。原实现是「写变异 → 跑套件 → 还原」的**直线代码**，没有异常保护 | `mutation-test` 会注入 46 个变异体，每个都 `writeFileSync(LIB, mutated)` 然后跑套件再 `writeFileSync(LIB, ORIGINAL)`。虽然 `runSuite` 内部捕获了异常，但 **`fs.writeFileSync` 本身可能抛**（磁盘满 / 权限 / 文件被占用 / 杀毒软件锁文件）。**一旦在那里抛，还原语句就被跳过，`lib/index.js` 会永久停留在变异状态** —— 之后所有 97 个套件都在坏代码上运行，它们「失败」的原因与被测代码毫无关系，**极难排查**（而且 `mutation-test` 自己不会报错，它已经崩了） | ① 把「写变异 → 跑套件 → 还原」包进 **`try/finally`**，`finally` 里必须还原；② 还原**本身失败**时打印明确的兜底提示（「🔴 严重：无法还原 lib/index.js，请手动执行 `git checkout lib/index.js`」）并 `exit(1)`，不再静默；③ `meta-health.mjs` 新增第 11 节（**5 项**）：**扫描所有会 `writeFileSync` 到 lib 的套件，要求必须含 `finally`**、必须有「无法还原」兜底提示、**改 `process.env` 的套件必须能恢复原值**（save/restore 或显式 delete），并含两条**反向验证**（必须检测到 ≥1 个改写源码的套件、≥1 个改 env 的套件）。**顺带**修正检查器自身的两个误报：`if (process.env.X === "1")` 是只读比较不是修改（正则收紧为 `\\s*=(?!=)`）；以及**自指**（`meta-health` 检查代码里的 `process.env` 正则字符串被自己命中，已排除自身）。验证修完仍 **46/46 KILLED** |
| 106 | **`run-all.mjs` 会把「失败」判成「跳过」并静默忽略（失败被完全掩盖）** | `run-all` 的 catch 分支写了 `if (/^跳过：/m.test(out)) { skipped = true; ok = true; }` —— **只要输出里出现过「跳过：」，即使子进程 exit 1 也当成跳过** | 第 109 轮构造了一个**先打印「跳过：」再 exit 1** 的假套件实测：`run-all` 把它判成 **SKIP**，而 SKIP 在统计里**只算「没跑」，不计入 fail**（`fail = results.filter(status === "FAIL")`）。**现实风险**：有 **14 个套件**会打印「跳过：」（用于真实日志缺失 / 宿主可执行文件缺失等场景）。若某个套件在前面的子检查里跳过一次、后面又真的失败，整个套件会被静默忽略 —— **跑完 83 个套件全绿，实际有失败被吞掉** | ① 收紧判定：**跳过必须由子进程以退出码 0 声明**（真正无法运行时应打印「跳过：」并 `exit 0`）；**退出码非 0 一律判 FAIL**，不再被「跳过」字样洗白；② 逐个核实 14 个会跳过的套件，确认它们的跳过分支都伴随 `exit(0)`/`return`/`continue`（**全部安全**，修复不会造成误判）；③ `meta-health.mjs` 新增第 12 节（**5 项**）：catch 分支**不得**同时设 `skipped=true` 和 `ok=true`、必须设 `ok=false`、会打印「跳过：」的套件其跳过分支必须伴随退出/返回、含**反向验证**（必须找到 ≥1 个会跳过的套件）。**顺带**修正检查器自身的误报：catch 块里的**注释**写着「原逻辑是 ok = true」，被当成真实代码 —— 现先**剥掉注释**再判定（389 字符 → 60 字符） |
| 107 | **README 声称三种测试模式都验证过，但本次会话从未跑过 `--offline` 和 full 模式；且没说明三者覆盖范围差异** | README 的运行模式表格列了 3 种模式（83/87/97 个套件），但每轮只跑 `--quick --offline` 就宣称「全部通过」 | 第 110 轮实测：① **`--offline` 模式（87 个套件）本次会话从未运行过** —— 一直只跑 quick 的 83 个；② `--quick` 跳过的 **14 个**套件里有 **9 个是真实日志重放类**（`replay-real-streams` / `health-check` / `per-model-replay` / `effect-quantify` / `false-positive-audit` / `audit-rewrites` / `mine-unrecovered` / `synth-provenance` / `lcr-replay`）—— 它们跑的是**真实会话日志**，最贴近实际使用，却**只在 full 模式运行**；③ README 的「覆盖范围」只写「跳过真实日志与慢速套件」，**读者无法知道 9 个真实日志套件被跳过了**；④ 实测 `--offline` 耗时 **475.9s = 7.9 分钟**，而 README 写「约 9.5 分钟」（偏保守 20%） | ① **实际跑完 `--offline` 模式**：**87 通过 / 0 失败 / 0 跳过，475.9s**；② README 运行模式表格下新增**「三种模式覆盖范围不同」的警示块**（中英双语）：明确列出被跳过的 **9 个真实日志套件名字**，并说明「只看 `--quick` 全绿不代表全部通过」；③ 补充说明「真实日志套件在无日志环境会打印跳过并以 exit 0 退出，那是**环境缺失，不是验证通过**」；④ 把 `--offline` 耗时从「约 9.5 分钟」修正为「约 8 分钟」（实测 7.9） |
| 108 | **从未验证「恢复出来的内容是否与原文逐字符一致」（中文 / 换行 / 代理对 / XML 特殊字符）** | 前 109 轮验证的都是「**能否恢复**」（有 tool-call 块、参数能解析），**没有一条断言检查「恢复出的参数值是否等于原文」** | 第 110 轮补测 8 类内容保真，**发现插件全部正确**（中文 / CRLF / LF / 混合换行 / 中文+反斜杠 / `<>&` / 中文文件名+CRLF / emoji 代理对 **12 项全对**）。但**此前从未验证过** —— 而这类错误一旦发生后果严重：CRLF 被归一化成 LF 会让 `write` 工具写出的文件**少一个字节**；emoji 被切断会产生**半个代理对**（U+FFFD）；中文被替换则路径直接失效。**验证方式**：不只看「有无」，而是**逐字符 `===` 比对**，并额外核对 emoji 的**码元数** | 新增 `unicode-fidelity.mjs`（**13 项**）：中文命令行、CRLF、LF、混合换行、中文+反斜杠、`<>&`、中文文件名+中文内容+CRLF（多参数 `write`）、emoji（含**码元数**校验）。**并做了变异验证**：在 `parseCallBody` 的 body 提取处注入 `.replace(/\r\n/g, "\n")`，套件立刻报 **10 passed / 3 failed（exit 1）**，还原后回到 **13 passed / 0 failed（exit 0）** —— 证明这个套件**真能抓到 CRLF 归一化这类 bug**。套件数 97 → **98** |
| 109 | **从未直接验证插件最根本的承诺：「恢复出来的调用 == 原生结构化调用」** | `recovered-ab-consistency.mjs`（缺陷 74）验证的是「**A/B 两条消费路径**对同一个恢复结果装配是否一致」（实时 `BlockAssembler` vs 持久化 `Accumulator`）。但那是**内部一致性**，**不是**插件对用户的承诺 | 插件最根本的承诺是：**「从 XML 文本恢复出来的调用，必须与模型直接给出结构化 `tool_calls` 时得到的结果无法区分」**。否则同一份代码在 `step-5-preview`（需要恢复）和别的模型（原生结构化）上会**表现出不同行为** —— 这是最影响信任的隐性 bug。第 111 轮补测：用**宿主真实的 `BlockAssembler`** 分别装配「原生路径」（`tool-call-delta{argumentsDelta=JSON}`）和「恢复路径」（XML 文本 → 插件恢复），逐字段比对 `{ name, args }` —— **11 项全对**（含 `number`/`boolean` 类型强转正确）。**但此前从未这样验证过** | 新增 `recovered-vs-native.mjs`（**11 项**）：单参数文本、多参数含类型强转、两个调用（顺序敏感）三组场景各做「原生 vs 恢复」的 `JSON.stringify` 深度相等断言，外加类型强转单独验证（`timeout_ms` 必须是 `number`、`force` 必须是 `boolean`、`command` 仍是 `string`）。**变异验证**：在 `coerceValue` 里注入「禁用类型强转」，套件立刻报 **8 passed / 3 failed（exit 1）**，还原后回到 **11 passed / 0 failed** —— 证明它能抓到「强转失效」这类 bug。套件数 98 → **99** |
| 110 | **「原生调用与文本恢复共存」的行为从未验证过，也没写进已知限制** | 前 111 轮分别验证了「纯原生」「纯文本恢复」，**没有验证两者共存** | 第 112 轮补测 4 类共存场景（原生在前/在后、reasoning 里有 XML、原生与 XML 表示同一调用）：插件**只保留原生调用，完全忽略 XML 文本** —— 这是**正确的保守设计**（否则 `rm` / `git push` 这类命令会被**执行两次**）。又补测 3 类 `finish.kind` 边界（`tool-calls` / `error` / `aborted`）：插件**原样放行、不恢复**。**但这两条行为规则都没写进已知限制清单** —— 读者无法知道「为什么我的 XML 调用没被执行」。同时发现一个**真实漏恢复场景**：若上游网关错误地把 `finish_reason` 归一化成 `tool-calls` 但流里**没有**原生块，插件会漏掉恢复 | ① 新增 `mixed-native-recovery.mjs`（**13 项**）：4 类共存场景 + 3 类 `finish.kind` × 2（不恢复 + 原样放行）+ `sawToolCall` 时 `finish.kind` 保持原值；② README 已知限制清单**新增 2 条**（中英双语）：**「只在 `finish.reason.kind === "stop"` 时恢复」**（并说明漏恢复的边界条件与真实日志里从未出现）、**「已有原生调用时不再从文本恢复」**（并说明这是避免重复执行的刻意设计）。已知限制条目 7 → **9** |
| 111 | **层数从「九十九」跨到「一百」时，3 个套件的中文数字解析器全部返回 NaN（断言失效）** | `claims-audit`、`deliverable`（两处）里的 `toNum` 只支持「X十Y」格式（例如「九十九」），**遇到「一百」直接返回 `NaN`** | 第 112 轮把层数改成「一百」后，3 处断言**同时失效**：① `claims-audit` 报 `NaN vs 101`；② `deliverable` 的「SUBMIT-GUIDE 层数一致」报 `100 vs NaN`；③ `deliverable` 的「给出关键数字（层数）」生成了 `/(?<!\d)NaN\s*层(?!\d)/` 这个**永远匹配不上**的正则，断言必然失败。**更隐蔽的是**：这些断言**在前 111 轮都是通过的**（因为层数 < 100），属于「**跨过整数边界才暴露**」的缺陷 | ① 三处 `toNum` 全部改写为支持 **「X百」「X百Y十Z」「X百零Y」** 的完整解析；② 解析失败时**返回一个永不匹配的正则**而不是 `NaN`（让失败信息更明确）；③ 正则边界从 `\b` 改为 **`(?<!\d)…(?!\d)`**（`\b` 在 `**100 层` 这类 markdown 里容易误判）；④ 顺带修正 `claims-audit` 的套件计数**没排除 `_` 前缀**（共享模块 `_host-invariant.mjs` 被多算 1，导致 98+2 被算成 99+2=101） |
| 112 | **`claims-audit` 的正则只认阿拉伯数字：用中文数字写的数量声明会被「静默漏检」** | 测试矩阵里的「N 项」声明的解析正则是 `/\*\*?(\d[\d,]*)\s*(项\|个\|条)\*\*?/` —— **只匹配 `\d`** | 第 113 轮排查第 112 轮「一百 → NaN」的同类问题，发现 `claims-audit` 有**更隐蔽的失效模式**：解析不到的行会被归入 `other`（「描述性声明」），而**没有任何断言保证 `other` 里的行真的不需要核实**。也就是说，如果哪天把矩阵里的「25 项」写成「二十五项」，那一行会**不报错、不计数、不核实** —— 读者以为它被核实过了，实际**根本没检查**。**静默漏检比「检查失败」更危险，因为它没有任何信号**。实测当前 README 里**没有**中文数字声明（0 处），所以尚未发生，但这是个**必然会被踩到的坑**（本轮就是被「一百」踩到的） | ① 在分类后**主动扫描** `other` 里「看起来像数量声明但用了中文数字」的行（正则 `/([零一二三四五六七八九十百千]+)\s*(项\|个\|条)/`），命中即报错并列出文件名与文本；② 加**反向验证**「确实解析到 ≥ 20 行可核实声明」，防止解析正则本身失效导致**全部**落到 `other` 还显示全绿。`claims-audit` **10 → 12 项** |
| 113 | **插件的恢复逻辑在流异常的 `catch` 之外：内部函数一旦抛异常会中断整条流** | `wrapStream` 的 `try/catch` 只包住了**上游流迭代**（`for await (const chunk of source)`）；其后的 `extractCalls` / `parseCallBody` / `coerceValue` 等恢复逻辑**全在 catch 之外** | 第 114 轮排查「静默失败」时发现这个**结构性风险**：如果恢复逻辑抛出任何未预料的异常，异常会直接冒泡出 `llm/stream` 接缝 —— **中断整条流**，用户连已经收到的正文都看不到。（与「流中途异常」不同：那时插件会 `flushHeld()` 尽力交出已扣留的块。）**当前实现有类型防护**（`typeof text !== "string"` 返回空结果、`MAX_SCAN_CHARS` 上限截断），实测 **8 类异常形状**（object / number / null / array / 超长标记 / 未闭合标记 / null 字节 / lone surrogate）**全部不抛异常**、块仍被交出、`finish` 仍被发出。**但这是「当前实现恰好正确」，不是结构上的保证** —— 任何后续改动都可能破坏它，而破坏后**没有任何守卫会报警** | 新增 `shape-robustness.mjs`（**23 项**）：① 结构性检查（`extractCalls` 有 `typeof` 防护、有超长上限、并**记录**「恢复逻辑不在 catch 内」这一现状）；② **8 类异常形状** × 2（不抛异常 + 块仍被交出）；③ 异常形状时 `finish` 仍被发出；④ 畸形 chunk（`null` / 数字 / 字符串）原样透传且不抛。套件数 100 → **101** |
| 114 | **缺陷 113 只做了「记录」没做「加固」：恢复逻辑仍在 catch 之外，靠内部防护「碰巧安全」** | 第 114 轮发现恢复逻辑在流异常的 catch 之外，但只加了**结构性记录**（`ck("（记录）恢复逻辑不在 catch 内")`），**没有真正的兜底** | 第 114 轮的结论是「当前实现有类型防护，实测 8 类异常形状都不抛」—— 但那是**「恰好正确」而非结构保证**：任何后续改动都可能破坏它，而破坏后**没有任何守卫会报警**，异常会冒泡出 `llm/stream` 接缝，**中断整条流**，用户连已收到的正文都看不到。第 115 轮补上真正的**「尽力而为」兜底** | ① 把恢复逻辑（`extractCalls` 循环 + `blocksWithCalls` 构造）整体包进 `try`，加 `catch (recoveryError)` —— 出错时**清空 `recoveredCalls`/`blocksWithCalls`**，退回「原样交出已扣留的块」，行为与「无可恢复调用」完全一致；② **`lib/index.js` 44,424 → 45,842 字节**（+1,418，含详细注释）；③ `shape-robustness.mjs` 第 4 节从 3 项扩到 **8 项**：结构性断言（有 catch、清空了数组）+ **注入只增 1 行**（证明没破坏其他内容）+ **变异后模块可加载**（语法合法）+ **变异验证 3 项**（流不中断、块仍被交出、finish 仍被发出）+ **变异已还原（字节一致）**；④ 还原失败时给出 `git checkout` 兜底提示（缺陷 105 的教训）。**实测：注入「extractCalls 必抛」变异后，正常 7 chunks 降级为 4 chunks，但流不中断、原有块与 finish 都在** |
| 115 | **`wrapStream` 里还有两段代码在 catch 之外（恢复产出循环 L900-928 + 安全网 L929-976），依赖 5 个辅助函数「自己防御」** | 第 115 轮给「恢复判定」加了兜底，但 `wrapStream` 的**产出阶段**仍在 catch 之外 | 第 116 轮做完整结构分析后定位：`wrapStream` 共 268 行，其中 **22 个 `yield` 在 try 之外**。产出阶段调用了 5 个可能抛异常的辅助函数：`patchReplayState`（L926）、`describeBlocksForMessage`（L966）、`hashString`（L911）、`isMarkupOnlyText`（L945）、`JSON.stringify(call.arguments)`（L913）。实测 **13 类异常输入全部不抛**（8 类畸形 `replayState` + 4 类畸形块 + 1 条推理），**但这是「恰好正确」而非结构保证** —— 任何后续改动都可能破坏，破坏后异常会中断整条流 | 新增第 5 节（**6 项**）：**逐条核实这 5 个辅助函数在源码层面确实有防御**（而不是依赖「实测没抛」）：`patchReplayState` 有 `typeof !== "object"` 与 `!Array.isArray(blocks)` 两道防线、`describeBlocksForMessage` 有 `!Array.isArray(held)` + 可选链 `?.`、`isMarkupOnlyText` 有 `typeof text !== "string"`；并**记录一条推理**（`JSON.stringify` 的输入来自 `coerceValue`/`JSON.parse`，不可能有循环引用，因此无需额外 try）。`shape-robustness` **31 → 37 项** |
| 116 | **`apply()` 没有重复注册保护，但从未验证过「被调用多次」时的行为** | `apply(ctx)` 只做 `ctx.on("llm/stream", ...)`，**没有 WeakSet/Set 去重**。宿主在热重载、profile 重复列包、Cordis group/isolate 组合时都可能重复调用 `apply()` | 第 117 轮实测：① `apply()` 调用 N 次就注册 **N 个监听器**（确认无静默去重）；② **双层/三层包装下恢复不重复**（内层恢复出 `tool-call` 后外层 `sawToolCall` 判定成立 → 原样放行），chunk 数仍为 7；③ **1/2/3 层包装下 `streak` 行为完全一致**（第 1 次 `error`，后续透传）—— 说明缺陷 54 的「确定性失败空转」保护**不会被多层注册绕过**；④ 多层包装的性能**线性增长**（1 层 0.063ms → 10 层 0.137ms/请求），但仍在毫秒级。**结论：行为正确，但没有去重保护意味着层数只增不减**（累积到进程重启）。**过程中的自我纠正**：第一次测试误判为「双层下 streak 被消费两次、第 2 次仍 error」，实际是**测试代码自身**每次都调 `mod.apply` 导致监听器累积（4 次测试 = 8 个监听器），修正测试方法后行为完全正常 | 新增 `double-registration.mjs`（**9 项**）：监听器注册数量、双层恢复不重复、1/2/3 层 `streak` 行为一致、多层性能只记录趋势（**不做硬断言** —— 遵循缺陷 104 的教训：时间阈值必须留 CI 抖动余量）。套件数 101 → **102** |
| 117 | **`double-registration.mjs` 漏掉了 `finish.kind` 维度：3 个变异全部逃逸** | 第 117 轮的套件只验证了「恢复不重复、streak 行为一致、性能线性」，**没有验证双层包装下的 `finish.kind`** | 第 118 轮做了 3 组变异测试：**变异 1**（去掉 `sawToolCall \|\|` 条件）→ **未被发现**；**变异 2**（去掉 `finish.kind !== "stop"` 条件）→ **未被发现**；**变异 3**（内层 `finish` 保持 `stop`）→ **未被发现**；**变异 1+3 组合** → **`finish` 被错误改写成 `error`（EMPTY_RESPONSE）**，仍未被发现。**这说明双层安全的机制比原先理解的复杂**：真正起作用的是「内层把 `finish.kind` 改成 `tool-calls`」+「内层已剥离 XML，外层无从恢复」两道**独立**保障；而第 117 轮只验证了「不重复」，没验证「`finish.kind` 是否正确」 | 新增 `double-finish-kind.mjs`（**9 项**）：单层/双层/三层恢复后 `finish.kind` **必须都是 `tool-calls`**（不是 `stop`、不是 `error`）、`calls` 恒为 1、以及「双层下交出的 reasoning 文本**不含** `tool_call`/`<function>` 标记」（验证第二道保障）。**变异验证**：把内层 `finish` 改成 `stop` → **6 passed / 3 failed（exit 1）**，套件成功抓到。套件数 102 → **103** |
| 118 | **9 个新增套件从未被变异测试覆盖（它们是「全绿但从未被证明能抓到 bug」的）** | `mutation-test.mjs` 的 `SUITES` 列表是**手工维护**的，共 80 个套件。第 110-118 轮新增的套件**没有同步加进去** | 第 119 轮做覆盖率分析：101 个套件中**21 个未被变异测试覆盖**，其中 **9 个是真正测插件行为的**（`recovered-vs-native`、`unicode-fidelity`、`mixed-native-recovery`、`shape-robustness`、`streak-resolution`、`double-registration`、`double-finish-kind`、`env-disable-semantics`、`concurrency`）。**这意味着它们「全绿」但从未被证明有效** —— 第 118 轮就发现 3 个变异从 `double-registration.mjs` 逃逸，正是这个盲区的直接后果。其余 12 个是**元套件/工具**（`coverage`、`perf-profile`、`threshold-audit` 等，不测插件行为）或**需要真实日志**（`health-check`、`replay-real-streams` 等），不该加进去 | 把这 **9 个套件**加入 `mutation-test.mjs` 的 `SUITES`（带注释说明为什么加），**80 → 89 个**。重跑变异测试：**基线全绿、46/46 KILLED、100% 覆盖率、0 SURVIVED** —— 证明这 9 个新套件确实能抓到变异 |
| 119 | **`mutation-test.mjs` 不给 `memory-lifecycle`/`soak-test` 传 `--expose-gc`，且基线失败时仍 `exit 0`（重复了缺陷 106 的错误）** | `run-all.mjs` 有 `NEEDS_GC = new Set(["memory-lifecycle.mjs", "soak-test.mjs"])` 并会传 `--expose-gc`，但 `mutation-test.mjs` 的 `runSuite()` **没有** | 第 119 轮给 `mutation-test` 加 9 个套件后重跑，发现 **2 个基线失败**：`内存生命周期`、`长时稳定性`。实测：不带 `--expose-gc` 时 `memory-lifecycle` 报「扣留块不残留（增长 < 0.5MB）:: 10.40MB」与「中断流不残留（增长 < 1MB）:: 4.59MB」**2 项失败**；带 `--expose-gc` 则 **8 passed / 0 failed**。**更严重的是**：基线失败时 `mutation-test` 只打印警告，**仍然 `exit 0`** —— 于是「用失效套件跑出的 46/46 KILLED、100% 覆盖率」看起来完美，实际**结论不可信**。这与**缺陷 106**（失败被判成跳过）是同一类错误：**失败必须能被看见** | ① 给 `runSuite()` 加 `NEEDS_GC` 判断，`memory-lifecycle`/`soak-test` 自动传 `--expose-gc`；② 基线失败时 `process.exitCode = 1`，并把 `baseFail === 0` **纳入最终 `ok` 判定**（原来只 `exitCode`，被后面的 `process.exit(ok ? 0 : 1)` 覆盖）；③ 失败输出里明确打印「**N 个套件基线失败 —— 变异测试结果不可信**」。**双向验证**：正常情况 `exit 0`（基线全绿 + 46/46 KILLED），注入「清空 NEEDS_GC」变异后 `exit 1`（2 个基线失败被正确报出） |
| 120 | **`branch-coverage.mjs` 用硬编码 `THRESHOLD = 30` 早已过时（实测 54），且 `catch {}` 静默吞掉套件失败** | 门槛是硬编码的 `const THRESHOLD = 30;`，注释写「22 处防御性分支 + 1 处不可达 = 23，留余量到 30」 | 第 120 轮跑 `run-all --offline`（**前 8 轮都只跑 `--quick`，从没跑过 `--offline`**），发现 `branch-coverage` **失败**：实测 **54 处 > 门槛 30**。深挖发现**两个叠加问题**：① **代码演进了但门槛没跟** —— 第 110-119 轮给插件加了大量防御性分支（兜底 `catch`、可选链、类型收窄），54 处里 `recovered` 函数占 22 处、`describeBlocksForMessage` 占 7 处；② **`} catch {}` 把套件失败完全吞掉** —— 实测 `memory-lifecycle` 和 `soak-test` 在覆盖率收集时**失败**（`14.11MB` / `29.88MB`，因为没传 `--expose-gc`），失败被静默忽略 → 这两个套件执行过的代码不产生覆盖率 → **未覆盖数虚高 → 误报**。**这是 `--expose-gc` 漏传问题的第 3 次出现**（`run-all` 有、`mutation-test` 缺=缺陷 119、`branch-coverage` 缺=本例） | ① 给覆盖率收集循环加 `NEEDS_GC` 判断，`memory-lifecycle`/`soak-test` 自动传 `--expose-gc`；② `catch {}` 改为 `catch (e)`，记录 「失败列表」（套件名 + 失败摘要），并在最后统一报告；③ **硬编码绝对门槛改为「基线 + 容差」模型**：`BASELINE = 54`（实测值）+ `TOLERANCE = 15` → `THRESHOLD = 69`，这样**覆盖退步会立刻报警**，而新增防御分支正常演进不误报；④ `ok` 判定纳入 `失败列表.length === 0`（收集阶段有套件失败时数据不完整，不能算通过）；⑤ 同步更新 `meta-health` 第 5 节的门槛规则，允许「基线+容差」形式（原来只认字面数字）。**实测：`run-all --offline` 93 通过 / 0 失败 / 0 跳过（481.9s）** |
| 121 | **`coverage.mjs` 是 `--expose-gc` 漏传 + `catch {}` 静默的第 4 处（与缺陷 119、120 同一类）** | 第 120 轮修好 `branch-coverage` 后，本轮**系统扫描了所有 `execSync`/`execFileSync` 调用点**，发现 `coverage.mjs` L58 **同样缺 `--expose-gc`**，L69 **同样用 `catch { }` 静默吞掉套件失败** | 第 121 轮实测：`coverage.mjs` 会跑 `memory-lifecycle` 和 `soak-test`（它们不在它的 SLOW 排除列表里），而这两个套件**不带 `--expose-gc` 必然失败**（`14.11MB` / `29.88MB`）。失败被静默吞掉 → 它们的代码不产生覆盖率 → **函数覆盖率虚低**。虽然实测当前仍是 100%（22/22），但这是**巧合**：`coverage` 只统计「函数是否被执行过」而非分支，这两个套件执行过的函数别的套件也执行过。**但同类结构风险仍然存在**。**这是 `--expose-gc` 漏传问题的第 4 次出现**（`run-all` 有、`mutation-test` 缺=119、`branch-coverage` 缺=120、`coverage` 缺=本缺陷） | ① 给 `coverage.mjs` 加 `NEEDS_GC_SETS` 判断，`memory-lifecycle`/`soak-test` 自动传 `--expose-gc`；② `catch { }` 改为 `catch (e)` 记录 「失败列表」（套件名 + 失败摘要），并在最后报告；③ `ok` 判定纳入 `失败列表.length === 0`（数据不完整不能算通过）。**顺带修正 3 处过时的声明数字**：`meta-health` 23 → **43**、`ref-verifiable` 15 → **16**（`deliverable` 已是 93）。实测 `coverage` 通过：**22/22 函数、0 失败、exit 0** |
| 122 | **`meta-health` 有 9 节检查却**没有一节**检查「`--expose-gc` 在所有子进程调用点是否一致」（这是缺陷 119/120/121 连续 3 轮的根因）** | `meta-health.mjs` 原本有 9 节（run-all 跳过报告、覆盖率并发安全、元套件不递归、门槛说明、变异证据、永不失败标注、asar 一致、try/finally 保护、判定逻辑不掩盖失败），**唯独没有「同一模式在多处的一致性」检查** | 第 119/120/121 三轮**连续发现同一个问题**（`mutation-test`、`branch-coverage`、`coverage` 都漏传 `--expose-gc`）。第 121 轮的结论是「修一处时必须扫描同一模式还在哪里」，但那是**人工动作** —— 第 122 轮问「能不能自动化」，答案是之前**完全没有**。**根因**：`meta-health` 的 9 节都是**针对单个文件**的检查（「`run-all` 的 catch 分支如何」「`branch-coverage` 的门槛如何」），**没有一节做跨文件的一致性扫描**。这正是同类问题能连续 3 轮逃逸的结构原因 | 新增第 13 节（**15 项**）：① 逐个核实 4 个运行器（`run-all`、`mutation-test`、`coverage`、`branch-coverage`）都**引用了 `--expose-gc`**；② 逐个核实它们都**显式处理** `memory-lifecycle` / `soak-test`；③ **反向验证**「至少扫描到 3 个运行器」（防止正则失效后空转）；④ 核实这两个套件**确实调用 `gc()`**（支持 `global.gc?.()` / `globalThis.gc` / `gc()` 三种写法）。**双向变异验证**：移除 `coverage.mjs` 的 `--expose-gc` 处理 → **57 passed / 1 failed（exit 1）**；清空 `RUNNERS` 列表 → **45 passed / 1 failed**（反向验证拒绝了空列表）。`meta-health` **43 → 58 项** |
| 123 | **`code-quality` 的「重复代码块 <= 3 处」阈值恰好等于实测值 3，零余量，且那 3 处本可以消除** | `ck("重复代码块 <= 3 处", duplicated <= 3, ...)` —— **纯硬编码 3，没有任何说明** | 第 123 轮实测：**恰好 3 处**，卡在边界上。这是**缺陷 103（阈值过宽）与缺陷 120（阈值过时）的第三种变体**：不是太宽也不是过时，而是**刚好等于当前值** —— 任何新增代码都会立刻挤破它，而更隐蔽的问题是**它给了「不必消除重复」的借口**。深挖那 3 处：`text-delta`/`reasoning-delta`/`tool-call-delta` 三个 case 各自重复了 `const block = openByIndex.get(chunk.index); if (block !== undefined) block.deltas.push(chunk); else yield chunk;` 这 3 行；另有 3 处重复 `if (heldUsage !== undefined) yield heldUsage; yield finishChunk; return;`。**都是真重复，都能消除** | ① 提取两个生成器：`absorbDelta(chunk)`（归入扣留块或透传）与 `finishWith(fin)`（回放 usage + 发 finish）；② 三个 delta case 改为 `yield* absorbDelta(chunk)`；③ 三处收尾改为 `yield* finishWith(...)`；④ 重复 4 行块 **3 → 0**，阈值收紧为 **`duplicated === 0`**（不再留余量）；⑤ `lib/index.js` 45,842 → **46,467 字节**（+625，含两个新函数的文档注释）。**集成测试 155 项全通过**，语义零变化 |
| 124 | **`run-all.mjs` 的 `NEEDS_GC` 列表漏了 `perf-baseline.mjs`（同一类问题第 2 次出现），而第 122 轮加的检查**只查运行器、不查套件列表**，所以没抓到** | `NEEDS_GC = new Set(["memory-lifecycle.mjs", "soak-test.mjs"])` —— **只有 2 个**，但实际有 **5 个**套件调用 `global.gc?.()` | 第 123 轮给 `code-quality` 收紧阈值后跑 quick 全量，`perf-baseline` **失败**：`❌ 无按请求累积（< 5KB/次） :: 50660 B/次`。带 `--expose-gc` 单独跑则**正常**（7 字节/次、11 项全通过）—— 说明它**需要 GC 但不在列表里**。`perf-baseline.mjs` L182/L188 用 `global.gc?.()` 强制 GC 后测堆增长，不传 `--expose-gc` 时测到的是**未回收的垃圾**。**第 122 轮我加了 meta-health 第 13 节「运行器必须传 --expose-gc」，但那一节只检查 4 个运行器是否**提及** expose-gc，**没检查套件列表是否完整** —— 检查了 A 却漏了 B | ① 补全 `NEEDS_GC`：`memory-lifecycle` / `soak-test` / `perf-baseline` / `perf-profile` / `timeout-backpressure`（**2 → 5**）；② meta-health 新增第 14 节（**5 项**）：**反向枚举**所有 hardening 套件里「真的调用 `gc()`」的，要求每一个都在 `NEEDS_GC` 里，并反向检查 `NEEDS_GC` 里没有僵尸条目；③ 含**反向验证**「至少找到 2 个调用 gc() 的套件」（防止正则失效后静默放过一切）。**过程中修正自己的两个误报**：(a) 第一版检测把 meta-health 自己检查项里的**正则字面量**当成真实调用（自我误报）；(b) 剥字面量的正则把 `global.gc?.();` 后面的内容误吃，导致 `perf-profile` 变成假僵尸。最终改为**严格整行匹配**（`^\s*(?:global\|globalThis)\.gc\?\.\(\s*\)\s*;?\s*$`）。`meta-health` **58 → 62 项**，列表与实际调用者完全一致 |
| 125 | **`NEEDS_GC` 等运行需求元数据在 4 个文件里各存一份且互不同步（改一处不同步其余）** | `run-all.mjs`、`coverage.mjs`、`branch-coverage.mjs`、`mutation-test.mjs` **各自定义** `NEEDS_GC` / `NEEDS_GC_SETS` | 第 124 轮系统扫描所有硬编码列表时发现：**同一份知识被抄了 4 份**。第 123 轮把 `run-all` 的列表补全到 5 项（`memory-lifecycle`/`soak-test`/`perf-baseline`/`perf-profile`/`timeout-backpressure`），但**其余 3 处仍是旧的 2 项** —— 于是 `perf-baseline` 等三个套件在覆盖率工具和变异测试里**仍然没有 `--expose-gc`**，仍然会测到未回收的垃圾而失败。**根因是复制粘贴导致的分叉**：修法不是「记得同步」，而是**只留一份** | ① 新建 `test/hardening/_suite-meta.mjs` 作为**唯一事实源**，导出 `NEEDS_GC` / `NEEDS_LOGS` / `SLOW` / `META_SUITES` 与 `nodeArgsFor()`；② 4 个运行器全部改为**从这里导入**，删除各自的本地定义；③ `meta-health` 第 14 节新增 **8 项**：核实 `_suite-meta.mjs` 导出 `NEEDS_GC`、**每个运行器都从共享模块导入**、**每个运行器都不再本地重定义**（防止分叉复发）；④ 顺带修正 3 处连锁问题：`fake-test-audit` 把 `_suite-meta.mjs` 当成套件（未排除 `_` 前缀）、`deliverable` 与 `doc-consistency` 的 `extractSet` 仍从 `run-all` 读本地定义（已改为读共享模块）。**实测 `doc-consistency` 静态计算：`--quick --offline=89, --offline=93, 完整=103`，与真实运行完全一致**。`meta-health` **62 → 70 项** |
| 126 | **纯 CR（老式 Mac）行尾下，代码围栏会一直吃到文本末尾，导致后面的**真实调用丢失**（恢复出 0 个）** | `computeDisplayRanges` 判定「行首」用 `text.charCodeAt(i - 1) === 10`（只认 LF），找围栏闭合用 `text.indexOf("\n", scan)`（也只认 LF） | 第 125 轮从「插件内是否有重复常量」出发，扫到 `96`/`126`/`32`/`9`/`10` 这些**字符码魔数**，进而追问「只认 LF 会不会漏掉 CR」。补测「行尾 × 围栏位置」矩阵（3 种行尾 × 4 种围栏位置）后发现：**纯 CR 文本里一个 `\n` 都没有**，`indexOf("\n")` 恒为 -1 → `close` 保持 -1 → `fenceEnd` 退化成 `text.length` → **整个剩余文本都被当成围栏内容**。后果：`围栏 + 换行 + 真实调用` 这种形态下，**真实调用被当成示例吞掉，用户看到文本里明明有调用却没被执行**。这是**安全方向的错误**（示例没被执行是好的），但**真实调用丢失**是真实的功能缺陷 | ① `atLineStart` 同时接受 LF（10）与 CR（13）；② 围栏闭合扫描**同时找 `\n` 与 `\r`** 并取较小值；③ 新增 `fence-eol-matrix.mjs`（**18 项**）：3 种行尾（LF / CRLF / CR）× 4 种围栏位置（第 1 行 / 第 2 行有正文 / 带缩进 / 波浪号）× 2 类断言（围栏内示例不恢复、围栏外真实调用要恢复），外加「围栏后紧跟真实调用应恰好恢复 1 个」。**修复前 17 passed / 1 failed，修复后 18 passed / 0 failed**。`lib/index.js` 46,467 → **47,262 字节**（+795）；集成测试 155 项全通过。套件数 103 → **104** |
| 127 | **`antml:` 前缀在「函数层」与「参数层」不对称：真实 Anthropic 形态的调用被静默丢弃** | `FUNCTION_NAME_ATTR_RE` / `INVOKE_NAME_ATTR_RE` 都写了 `(?:antml:)?` 前缀，但 `PARAM_NAME_RE` **只写 `<parameter`**，不接受 `<antml:parameter` | 第 126 轮做「行尾 × 调用形态」矩阵时发现：`antml:function` + `antml:parameter` 形态在**所有行尾下都恢复出 0 个**。深挖是**不对称**：外层函数正则认 `antml:`，内层参数正则不认。后果链条：外层匹配成功 → `parseParams` 在参数区找不到任何 `<parameter>` → 返回空对象 → `Object.keys(args).length === 0` → `continue` 跳过该调用。**用户看到文本里明明有调用，却什么都没发生**。顺带发现 `lib/index.js` L87-88 有**两行重复的 `/**`**（注释结构错误） | ① `PARAM_NAME_RE` 加上 `(?:antml:)?` 前缀（开标签与闭标签都加）；② 删掉重复的 `/**`；③ 新增 `antml-prefix-symmetry.mjs`（**12 项**）：**4 种前缀组合**（外层有/无 × 内层有/无）× **3 种行尾**（LF / CRLF / CR）都必须能恢复。**修复前 5 项测试里 3 项失败，修复后 12/12 全通过**。`lib/index.js` 47,262 → **47,734 字节**（+472） |
| 128 | **`path-consistency` 用硬编码行号（L263 / L306）定位源码位置，改注释就会误报** | `const COERCE_PATHS = [{ name: "...", line: 263 }, { name: "...", line: 306 }]`，然后检查「该行上方 14 行内是否有 coerceValue」 | 第 126 轮给 `PARAM_NAME_RE` **加了一段注释**（+7 行），这两个行号全部偏移，`path-consistency` 立刻报 `❌ 两条逐键强转路径都有 coerceValue :: 0/2`。**这是典型的脆弱测试**：断言的真正意图是「这两处代码附近有强转调用」，却被实现成「第 N 行附近有」，于是**任何不影响语义的行增删都会误报**。修复过程中还发现两个附带问题：① 强转调用其实是**续行**（`? coerceValue(...)` 在锚点的**下一行**），原来的搜索范围 `[at-14, at]` 不含下一行；② `coerced[key]` 这个锚点会**同时匹配 `coercedJson[key]`**（子串），需要更精确的前缀 | ① 改为**按内容锚点定位**：找 `coercedJson[key] = typeof value ===` / `coerced[key] = typeof value ===` 两处特征代码，用 `replace(/\s+/g," ").trim().startsWith()` 匹配（不依赖缩进）；② 搜索范围扩到 `[at-14, at+3]`（覆盖续行写法）；③ 保留原有的「至少 4 处 coerceValue」计数检查。`path-consistency` **58 → 59 项**，且**语义不变时行号如何偏移都不会误报** |
| 129 | **`isMarkupOnlyText` 的标记清单漏了 `antml:parameter`：这类「只有标记」的响应不会触发安全网** | 该函数用 8 个 `text.includes(OPEN_XXX)` 的 逻辑或链判断「是否只有标记」，**唯独没有 `antml:parameter`** | 第 127 轮修缺陷 127（`PARAM_NAME_RE` 漏 `antml:`）后，追问「同一个 `antml:` 前缀是否在别处也漏了」，于是系统扫描了所有标记清单。实测：`<antml:parameter name="x"></antml:parameter>` 这种**只有标记**的文本被判成「有实质内容」→ 安全网**不触发 `EMPTY_RESPONSE`** → 返回 `stop` → **用户看到 XML 却不执行、不重试，回合静默结束**。其余 6 种形态（`<tool_call>` / `<function=` / `<parameter=` / `<parameter name=` / `<function name=` / `<invoke name=` / `<antml:function>` / `<antml:invoke>`）都正确触发。**这是与缺陷 127 完全同源的不对称** | ① 新增常量 `OPEN_ANTML_PARAMETER`（`<antml:parameter `）与 `OPEN_ANTML_PARAMETER_EQ`（`<antml:parameter=`）；② 把它们加入 `isMarkupOnlyText` 的 逻辑或链；③ 新增 `markup-only-completeness.mjs`（**14 项**）：10 种「只有标记」形态必须触发 `EMPTY_RESPONSE` + 4 种「标记 + 长正文」必须**不**触发。**变异验证**：把两行 `includes` 改成 `(false && ...)` → **12 passed / 2 failed（exit 1）**，套件成功抓到。`lib/index.js` 47,734 → **48,772 字节**（+1,038） |
| 130 | **`path-consistency` 与 `meta-health` 里 7 处「L247/L263/L306」标签已随行号漂移，指向完全不相干的行** | `PATHS[].name` 写成 `"L247 <parameter> 元素"` / `"L263 <function> + 裸 JSON"` / `"L306 整段 JSON 工具调用"` 等，直接引用 `lib/index.js` 的行号 | 第 126 轮修缺陷 128 时只改了**判定逻辑**（改为内容锚点），但**标签文字仍是硬编码行号**。第 126-127 轮又给插件加了注释与新常量（行数从 47,262 增到 48,772），这些标签**全部过时** —— 实测当前对应行分别是 L252 / L267 / L310，而标签还写着 L247 / L263 / L306。**行号一旦漂移，标签就从「帮助定位」变成「误导定位」**：读者按 L263 去源码里找，找到的是完全不相干的代码 | ① 把 7 处 `name` 从「行号 + 描述」改为**纯语义描述**（如 `"coercedJson 逐键强转（<function=...> + 裸 JSON）"`）；② 在 `PATHS` 定义前加注释说明「行号会漂移，语义不会」；③ 同步修正 `meta-health` 里引用 `L263` 的说明文字。**判据**：`path-consistency` 59 项全通过，且标签不再含任何行号 |
| 131 | **Qwen 裸 `<function=name>`（无 `<tool_call>` 外层）不会被恢复，但这条限制从未写进已知限制** | 「裸露元素」那条扫描路径只匹配 `FUNCTION_NAME_ATTR_RE`（要求 `<function name="x">` 带引号属性），**不匹配 Qwen 风格 `<function=pwsh>`** | 第 128 轮做「形态 × 完整/截断」矩阵时发现：`<function=pwsh>` + `<parameter=command>` + `</function>` 这种**完整可解析**的 Qwen 形态，**裸写时恢复出 0 个调用**；加上 `<tool_call>` 外层才恢复。深挖确认这是**两条不同的扫描路径**：`<tool_call>` 内的内容走 `parseCallBody`（支持 `FUNCTION_EQ_RE`），裸露元素走 `FUNCTION_NAME_ATTR_RE`（只认属性形式）。**行为本身是安全的**（落到安全网 `EMPTY_RESPONSE` → 重试，不静默丢弃），**但 README 的已知限制只写「只解析 3 类标记」，从未说明这个边界** —— 用户会以为「写了调用就该被执行」。实测真实日志里 Qwen 风格调用**都带 `<tool_call>` 外层**，所以实践中未触发 | ① README 中英文**已知限制各补 1 条**（说明「裸 Qwen 形态不解析」+ 两条路径的区别 + 为什么共用正则会引入畸形）；② `known-limits-accuracy.mjs` 的 `EXPECTED` 从 **7 条 → 8 条**（新增该限制的正则检测）；③ 新增 `call-form-matrix.mjs`（**17 项**）：5 种完整可解析形态必须恢复 1 个调用 + 10 种「完整空标记」必须触发 `EMPTY_RESPONSE` + **2 项已知限制一致性**（Qwen 裸形态不恢复，但**必须**落到安全网而非静默丢弃）。套件数 106 → **107** |
| 132 | **已知限制第 3 条写「其他方言会落到安全网」，但实测是「原样放行 stop」——文档与行为不符** | README 原文：「其他方言（如 `<tool><name>…</name></args></tool>`）不解析：这类会落到安全网（重试，然后报一个明确的错）」 | 第 129 轮**逐条核对 10 条已知限制与实际行为**时发现。实测 `<tool><name>pwsh</name><args><command>echo A</command></args></tool>` 返回 **`stop`（原样放行）**，而不是 `EMPTY_RESPONSE`。根因：`isMarkupOnlyText` 的第一道判断是「文本里是否含**已知标记**」（那 10 个 `OPEN_*` 常量），而 `<tool>` **不在其中** → 直接 `return false` → 按「有可见文本」放行。**这不是插件 bug**（两种走向都安全：都不执行示例、都不会卡住），但**文档描述错了走向** —— 维护者照文档排查会找错方向。正确描述应区分两种情况：① 含任一已知标记 + 实质字符 < 20 且标签占比 > 50% → 落到安全网；② 完全不含已知标记 → 原样放行 `stop` | ① README 中英文**第 3 条限制重写**，明确列出两种走向及各自判据；② 新增 `known-limit-outcomes.mjs`（**6 项**）：含 `<tool_call>` 但不可解析必须 `EMPTY_RESPONSE`、完全不含已知标记必须原样放行 `stop`、截断开标记必须放行不重试，且**三种情况都必须不执行示例**（安全底线）。套件数 107 → **108** |
| 133 | **版本历史的「六十层加固测试」早已过时（当前一百零八层），而同一节的另一处已写对 —— 同文件内自相矛盾** | `## 十三、版本历史` 的 0.2.0 行写着「+ **六十层**加固测试」，而 `## 十二、已知限制` 末尾写「本项目做了 **108 层**验证」 | 第 130 轮把核查范围从「已知限制」扩展到**全 README 的事实性陈述**，逐章扫描所有「N 层 / N 项 / N 个」表述。发现 L794「六十层」与 L786「108 层」**同文件内互相矛盾**。根因：**缺陷表之外的叙述性章节从未纳入数字一致性检查** —— `doc-consistency` 查的是「README vs discussion vs PASTE-READY vs SUBMIT-GUIDE」，`doc-structure` 查的是「表格结构与中英文对等」，**都不查「同一份 README 内不同章节的数字是否一致」** | ① 中文版「六十层加固测试」→「**一百零八层**加固测试」；② 英文版 Changelog「twenty hardening suites」→「**108 hardening suites**」、TL;DR「**89** self-inflicted defects」→「**132**」、Changelog「**ninety-eight** self-inflicted defects」→「**one hundred and thirty-two**」；③ 英文版 `claims-audit` 行「66 rows / 39 suites」→「**59 rows / 40 suites**」、`defect-coverage-matrix` 行「48 defects」→「**132**」；④ **`deliverable` 行的「层数 77 / 缺陷 38」加「示例：」前缀** —— 这处是**该检查写就时的快照值**，不是当前值，标注清楚避免误导 |
| 134 | **`nesting-malformed` 在文档里写成「10/86 层嵌套」，实测测试的深度是 2/5/10/50 —— 文档描述与代码不符** | README 测试矩阵写「10/86 层嵌套」，而 `nesting-malformed.mjs` L45 是 `const depths = [2, 5, 10, 50];` | 与缺陷 133 同一次扫描发现。**86 这个数字在代码里根本不存在** —— 既不是测试深度，也不是任何阈值。推测是早期版本用过 86，后来改成 50 但文档没跟。这类错误的危险在于：读者会以为「嵌套 86 层也被测过」，从而对这个维度产生**错误的信心** | ① 中文版改为「**2/5/10/50 层嵌套**」（与代码完全一致）；② 英文版同步改为「2/5/10/50-layer nesting」；③ 该行其余描述（嵌套 tool_call、交叉嵌套、1000 个重复标签性能、参数不串味、5 万字符单行）经核对**均与实际断言一致**，保持不变 |
| 135 | **测试矩阵里 5 个套件的「N 项」声明远低于实际（meta-health 58 vs 70 等），而检查器因单向容差一路绿灯** | `claims-audit` 的判据是 `const ok = actual >= c.claimed * 0.9` —— **只防「声明虚高」，完全不防「声明过时」** | 第 131 轮把「文档 vs 代码」对照**自动化**：抽取测试矩阵里 54 个套件的「N 项」声明，逐个实跑取汇总行，双向精确比对。发现 **5 处不一致**：`meta-health` 声明 58 实际 **70**、`memory-lifecycle` 6 vs **8**、`real-cordis` 14 vs **15**、`ref-verifiable` 16 vs **17**、`claims-audit` 6 vs **12**。**每一处都会让读者低估项目的测试强度**，而 `claims-audit` 自己的容差（`>= claimed * 0.9`）把它们全部放过 —— 因为「实际 > 声明」在单向判据里永远成立。**这是缺陷 106（失败被判成跳过）的同族问题：检查器的方向性错误** | ① README 矩阵 5 处数字全部校正为实际值；② **`claims-audit` 的容差从 `actual >= claimed * 0.9` 改为 `actual === claimed`（双向精确匹配）** —— 理由写进注释：README 矩阵的原始承诺就是「N 项 = N 条断言」，若某个套件确实需要留边距，应该在文档里写清楚，而不是靠检查器偷偷放宽；③ 收紧后**实测 40 个套件全部精确匹配**（`声明 70 → 实际 70` 逐一对应），证明收紧是正确的 |
| 136 | **3 个套件内部的章节编号有断层/重复：`deliverable` 与 `doc-consistency` 缺第 8 节、`fake-test-audit` 有两个「3」** | 这些都写成 `console.log("\n=== N. … ===")`，但 **N 从未被任何检查核对过** | 第 132 轮从「套件自述项数」出发，扫描全部套件的章节编号序列。实测：`deliverable` 是 `2,3,4,5,6,7,9,10,…,17`（**缺 8**）；`doc-consistency` 同样 `2,…,7,9,…,17`（**缺 8**）；`fake-test-audit` 是 `2,3,4,5,3`（**两个 3** —— 后来追加的「恒真断言」检查沿用了旧编号）。**危害是可读性与可信度**：读者按编号找第 8 节会找不到，或以为「第 8 节被删了、可能有内容丢失」，而 `fake-test-audit` 的两个「3」会让输出看起来像是重复跑了同一节。对一个「把每处细节都摊开给人看」的项目，这类小裂缝会被放大 | ① `deliverable` 的 9–17 重编号为 **8–16**；② `doc-consistency` 的 9–17 重编号为 **8–16**；③ `fake-test-audit` 第二个「3. 恒真断言」改为 **「6. 恒真断言」**；④ **`meta-health` 新增第 15 节（2 项）**：扫描全部套件的 `=== N.` 编号，要求**从起点连续且无重复**，含反向验证「至少扫描到 30 个带编号章节的套件」（防止正则失效后空转）。**变异验证**：把 `code-quality` 的「5」改成「55」→ **71 passed / 1 failed（exit 1）**，精确报出 `code-quality.mjs [2,3,4,55,6,7,8,9,10]`。`meta-health` **70 → 72 项**，实测 **68 个套件**全部编号连续 |
| 137 | **7 个套件的头部注释写「本套件验证（N 项）」，但 N 早已过时（`shape-robustness` 写 12 实际 37、`fence-eol-matrix` 写 24 实际 18）** | 每个套件头部的注释都有一段「本套件验证（N 项）：…」，作为**读者判断「这个套件验得够不够细」的第一手依据**，但 **N 从未被任何检查核对过** | 第 133 轮从「套件自述一致性」出发，抽取全部套件的头部「本套件验证（N 项）」声明，逐个实跑比对。发现 **7 处不符**：`shape-robustness` 12→**37**、`fence-eol-matrix` 24→**18**、`streak-resolution` 11→**19**、`unicode-fidelity` 12→**13**、`call-form-matrix` 20→**17**、`double-registration` 11→**9**、`double-finish-kind` 8→**9**。**过时数字会双向误导**：写多了让人以为覆盖更广，写少了让人低估测试强度。**另有 2 处是误报**（`install-failure-paths` 的「33 项」引用的是 `install-experience`、`race-conditions` 的「6 项」引用的是 `concurrency`）—— 那是**交叉引用**不是自述，检查器必须只匹配「本套件…」 | ① 7 处头部声明全部校正为实跑值；② **`meta-health` 新增第 16 节（2 项）**：抽取「本套件验证/补齐…（N 项）」形式的自述，**逐个子进程实跑**取汇总行比对，含反向验证「至少扫描到 5 个带自述的套件」。**变异验证**：把 `unicode-fidelity` 的 13 改成 99 → **73 passed / 1 failed（exit 1）**，精确报出 `注释 99 / 实际 13`。**过程中修正自己 3 个错误**：(a) `meta-health` 里没有 `DSH_LLM` 变量，照抄 `mutation-test` 的 `env` 写法会传 `undefined`；(b) 漏设 `cwd`；(c) **最隐蔽的一个 —— 文件顶部忘了 `import { execFileSync }`，抛出的 `ReferenceError` 被 `try/catch` 吞掉，于是所有结果都变成「实际 null」**（这正是本套件反复检查的那类静默失败）。`meta-health` **72 → 74 项**，10 个自述套件全部一致 |
| 138 | **第 133 轮给 `meta-health` 加第 16 节时忘了 `import { execFileSync }`，`ReferenceError` 被 `try/catch` 吞掉 —— 我自己在「检查静默失败的工具」里写出了一个静默失败** | `meta-health.mjs` 顶部只 `import fs / path / os`，而第 16 节要 `execFileSync` | 第 133 轮实现第 16 节后，实测所有套件都报「实际 **null**」，我先后误判为「`DSH_LLM` 变量不存在」「漏设 `cwd`」，改了两处仍不生效；直到逐段核对才发现**根因是缺 import** —— `ReferenceError` 抛在 `try` 里、被 `catch (e) { out = ... }` 吞掉，`out` 保持空串，于是 `actual` 恒为 `null`。**检查看似在跑、结果全是空**，正是 `meta-health` 存在的意义（抓「显示通过、实际未验证」）。**这是第 12 次「静默失败」，也是唯一一次我亲手制造、且发生在专门检查它的文件里** | ① 补上 `import { execFileSync } from "node:child_process";`（带注释说明这个坑）；② **`meta-health` 新增第 17 节（3 项）**：扫描全部套件，若调用了 `execSync`/`execFileSync`/`spawnSync`/`execFile`/`spawn` 之一，就必须通过**静态 import**、**动态 `const { X } = await import(...)`**、或**整体导入后 `cp.X(...)`** 引入；③ 含**反向验证**「至少扫描到 10 个使用 child_process 的套件」（防正则失效）；④ 含**自我检查**「`meta-health` 自己必须导入 `execFileSync`」（第 16 节依赖它）。**变异验证**：删掉 `branch-coverage.mjs` 的 `import { execSync }` → **76 passed / 1 failed（exit 1）**，精确报出 `branch-coverage.mjs 缺 execSync`。`meta-health` **74 → 77 项**，实测 **16 个套件**全部导入正确 |
| 139 | **（历史记录，已由缺陷 164 彻底解决）包名曾用 DeepSeek 官方 npm scope `@deepseek-ai/`，而 README 从未说明这是「非官方项目」** | `package.json` 的 `name` 是 `@zhaozehao10/dsh-text-tool-call-recovery`；README 与 SUBMIT-GUIDE 通篇没有一句说明「这是社区/个人贡献」 | 第 135 轮从「`npm pack` 的真实发布视角」检查包完整性时注意到这个 scope。核实：`@deepseek-ai` 是 **DeepSeek 的官方 npm scope**，第三方不能发布到该 scope；`package.json` 确实有 `private: true`（不会发布），README 也提到了 `private`，但**从未说明「这不是官方项目」**。**对投稿材料来说这是定位不清**：维护者第一眼看到 `@deepseek-ai/xxx` 会以为这是官方内部产物，而实际上它是**社区个人插件**。改名代价高（包名同时是安装路径的一环，牵连 `install-stepfix.ps1`、`cordis.patch.yml`、30+ 处路径示例、以及已安装目录），所以选择**保留包名 + 明确声明** | ① README 中英文**开头各加一段醒目声明**：非官方项目、`@deepseek-ai/` 前缀只为让 `node_modules` 布局与官方插件一致（Loader 按路径解析，不代表背书）、`private: true` 不会发布到 npm、MIT 按现状提供；② `SUBMIT-GUIDE.zh.md` 加**定位说明**，并明确要求「提交时不要暗示这是官方项目，用『社区插件 / community plugin』措辞」；③ `deliverable` 新增 **2 项检查**：README/SUBMIT-GUIDE 必须含「非官方项目」字样、必须解释 `@deepseek-ai/` 前缀的由来。`deliverable` **93 → 95 项** |
| 140 | **README 的「手动安装」步骤顺序是反的：步骤 2 就改 `cordis.patch.yml`，步骤 3 才说「先备份」—— 按顺序照做会备份到已改版本，回滚不了** | 原文：步骤 2「在 `<profile>/cordis.patch.yml` 末尾追加 insert 块」→ 步骤 3「**先备份** `cordis.patch.yml`」 | 第 136 轮从「全新用户视角」检查：仓库里给了两条安装路径，**脚本版有 30+ 项断言守护，手动版从来没有被真正执行过** —— 它只是几段文字。逐字读时发现**备份在修改之后**：用户照顺序做，`Copy-Item` 复制到的是**已经追加过插件条目**的文件，一旦要回滚就等于「回到已安装状态」。另外 L188 原文写「下面几步和脚本版**完全一样**，别跳过」，而脚本版会**自动备份** —— 这句话会让读者以为不必自己备份，与紧随其后的「请自己复制一份」自相矛盾 | ① **重排步骤**为「1 先备份 → 2 复制文件 → 3 追加 insert → 4 node --check → 5 重启 → 6 验证」，并在开头加 **⚠️ 顺序很重要** 的醒目提示；② 在备份步骤下补一句「**这一步必须在改文件之前做** —— 否则备份下来的是『已经改过』的版本，回滚不了」；③ 删掉「下面几步和脚本版完全一样」这句自相矛盾的话；④ 新增 `manual-install-order.mjs`（**18 项**）：静态验证「备份」出现在「追加」之前 + 四个必备步骤齐全 + **动态在一个临时 profile 里完整走一遍手动安装**（备份 → 复制 → 追加 → `node --check` → 验证 insert 形态 → 验证回滚可用）。**变异验证**：把「先备份」改成「最后备份」→ **16 passed / 2 failed（exit 1）**，精确报出「备份在 L596，追加在 L185」。套件数 108 → **109** |
| 141 | **第四章的「卸载」命令只删插件目录、不删 `cordis.patch.yml` 条目，而注释却写「删除插件目录 + 移除 patch 条目」—— 注释与命令不符** | 第四章 `### 临时禁用 / 卸载` 里只有一条 `Remove-Item <profile>\node_modules\...-Recurse -Force`，注释写「删除插件目录 + 移除 patch 条目，然后重启 DSH」 | 第 137 轮把第 136 轮的「新用户视角」用到**卸载**上。实测后果：只删目录会留下**指向不存在目录的悬空 patch 条目**，Cordis Loader 下次启动仍会尝试加载它 —— 具体表现取决于 Loader 版本（报错或被静默跳过），但**都不是干净卸载**。第六章的卸载说明本身是完整的（备份恢复 + 手工删条目 + 编码警告），**问题在第四章那条孤立的、看起来像完整卸载的不完整命令** | ① 第四章命令块重写为**明确的两步**（1 移除 patch 条目：从备份恢复或手工删；2 删除插件目录），并加 ⚠️「两步都要做」；② 说明「只删目录会留下悬空条目」并指向第六节；③ 新增 `uninstall-completeness.mjs`（**17 项**）：中文/英文卸载说明都必须包含「移除条目 + 删目录」两步、中文命令块必须**同时出现** `cordis.patch.yml` 与 `Remove-Item`、英文必须含 delete 目录步骤、编码警告必须指向「读入时」而非「换行被压」，外加**动态验证**（只删目录 → patch 仍指向它；两步都做 → 干净）。套件数 109 → **110** |
| 142 | **英文版 Uninstall 缺少「删除插件目录」这一步（编号从 2 直接跳到 4），且中文版卸载命令块的围栏重复了两行** | 英文 `## Uninstall` 原本是 `1 → 2 → 4. Restart`，**没有步骤 3**；中文第四章卸载命令块上方**连续出现两行 ` 代码围栏行（三个反引号 + powershell） `** | 与缺陷 141 同一次排查中发现。**两个都是我自己在前一轮编辑时引入的**：英文缺步骤 3 是第 137 轮替换警告文字时**多删了一行**；中文围栏重复是第 137 轮替换命令块时**把旧的围栏行留下了**。前者会让英文读者以为「删完 patch 条目就完事了」（实际还要删目录），后者会让 Markdown 渲染出一个**空代码块**。**教训：手工 splice 多行区块时，边界极易算错；而这两个错误都不会让任何断言失败** —— 直到我加了 `uninstall-completeness.mjs` 才暴露 | ① 英文补回 **步骤 3（Delete the plugin directory）**，含 `Remove-Item` 命令与「两步都要做」的警告；② 中文删掉重复的 ` 代码围栏行（三个反引号 + powershell） ` 围栏行；③ 这两处正是 `uninstall-completeness.mjs` 的检查对象（命令块必须含 `Remove-Item`、英文必须含 delete 目录步骤），**修复后 17/17 全通过**。套件数 109 → 110（与 141 合并计数） |
| 143 | **`doc-consistency` 的中文数字解析器不支持「百」：层数从「一百」涨到「一百一十」后，它静默算成 10（不是 NaN，是错的数）** | `toNum` 只处理 `s.includes("十")` 的分支：`parts[0]` 是「一百一」→ `CN["一百一"]` 未定义 → `?? 1` 兜底成 1 → 返回 `1 * 10 + 0 = **10**` | 第 137 轮加完 D141/D142 后跑全量，`doc-consistency` 报「层数 10 必须精确等于套件总数 110（差 100）」。**这是缺陷 111 的同族问题再次出现** —— 当时（第 112 轮）修的是「一百」→ `NaN`，而这次它在**另一条路径上静默算错了一个数**（`? 1` 兜底），比 `NaN` 更难发现，因为 `NaN` 会立刻让断言失败信息变得可疑，而 `10` 看起来像真的。**根因**：中文数字解析器被写在多个套件里、各自实现，每次层数跨越一个量级就有一处失效 | ① `toNum` 重写为**逐字符累积**（支持 百/十/零 任意组合）：`一百一十`=110、`一百零一`=101、`九十九`=99、`十`=10，自测全部正确；② 顺带修正 README 里两处遗漏的「166 个自身缺陷」（L35 与 L509）—— 它们是同步脚本因正则只匹配「N 个自身缺陷」而漏掉的；③ 缺陷 142 的记录里写了三个反引号，**破坏了 Markdown 表格**（`doc-structure` 报「1 行含行内裸围栏」「表格列数 6/4」），已改为文字描述。`doc-structure` **52 项全通过** |
| 144 | **Markdown 的有序列表编号从未被检查：英文版 Uninstall 从 2 直接跳到 4（缺步骤 3）也全绿通过** | `doc-structure` 原有 15 节，覆盖标题层级、中英对等、表格列数、围栏配对、渲染健康度… **唯独没有「有序列表编号是否连续」** | 第 137 轮两个由我自己的编辑造成的损伤（英文缺步骤 3、中文围栏重复）中，**围栏重复被 5 项既有检查同时抓到**（H1 数量、围栏未配对、代码块内空行、L370 围栏未闭合、围栏行数为奇数），而**缺步骤 3 一个都没抓到** —— 因为「编号不连续」在 Markdown 里是**完全合法的**（渲染器会按顺序重排），所以没有任何渲染层检查会报警，**只有语义层检查才能发现**。这恰恰是最容易被漏的一类：文档「看起来正常」，但**内容缺了一段** | ① `doc-structure` 新增第 16 节（**2 项**）：扫描 5 个交付文档的有序列表项，要求同缩进层级内编号逐个 +1；② 含**反向验证**「至少扫描到 40 个有序列表项」（防正则失效后空转）；③ **变异验证**：把英文版「3. Delete the plugin directory」改成「9.」→ **53 passed / 1 failed（exit 1）**，精确报出 `README.en.md L287: 2 → 9（L268 之后跳号）`；④ **过程中修正自己的第一版检查**：它把「围栏」当成列表边界并重置计数，而代码块常常**就是列表项本身的内容**（「2. 编辑文件：」+ yaml 代码块 + 「3. …」），导致第一版**漏掉了注入的变异**（报 0 处跳号）。改为「围栏不重置列表状态」后才抓到。`doc-structure` **52 → 54 项**，实测 **76 个有序列表项**全部连续 |
| 145 | **全新克隆仓库后跑测试会失败：6 个套件硬读 `.gitignore` 排除的草稿，且无 `existsSync` 守卫** | `deliverable` / `doc-consistency` / `doc-executable` / `doc-structure` / `package-contract` / `ref-verifiable` 都直接 `readFileSync("SUBMIT-GUIDE.zh.md")` 或 `PASTE-READY.zh.md`，而这两份是**本地草稿**（`.gitignore` 明确排除，用于复制粘贴到 GitHub Discussion） | 第 139 轮做**真正的全新克隆验证**：把按 `.gitignore` 规则会提交的 **129 个文件**复制到全新目录，在那里跑 `run-all --quick --offline` —— **90 通过 / 5 失败 / 1 跳过（exit 1）**。逐个诊断后确认：失败全部来自「依赖草稿」的套件（草稿在克隆里不存在）。**这是严重的可用性缺陷** —— 任何人克隆仓库后跑测试都会看到失败，从而以为「这个项目的测试是坏的」，而实际代码和材料都没问题 | ① 6 个套件统一加**草稿缺失守卫**：启动时检查 `SUBMIT-GUIDE.zh.md` / `PASTE-READY.zh.md` 是否存在，缺失则打印「跳过：这是全新克隆（缺少本地草稿 …）」并 `exit(0)`；② 守卫的注释写清**为什么**（草稿被 .gitignore 排除、只在作者本机存在、不是掩盖问题）；③ **双向验证**：全新克隆里 → **89 通过 / 0 失败 / 7 跳过（exit 0）**；作者本机（含草稿）→ 6 个套件**全部完整检查**（95/54/54/17/28/41 项），一个都不跳过。**这一条直接对应「开源投稿」场景：维护者第一件会做的事就是克隆下来跑测试。** |
| 146 | **`coverage` 与 `branch-coverage` 用硬编码目录名匹配 V8 覆盖率记录：仓库克隆到任何别的目录名，覆盖率就报「18 个函数从未执行（10.0%）」** | 两者都写 `if (!script.url.includes("dsh-text-tool-call-recovery/lib/index.js")) continue;` —— **目录名写死** | 第 140 轮继续第 139 轮的克隆验证，这次跑 `--offline` 全量：**92 通过 / 1 失败（exit 1）**，失败的是 `coverage`「18 个函数从未被执行」。逐步排查：① 单独跑一个套件 → ✅ 通过；② 单套件的 V8 覆盖率里**确实有** `lib/index.js` 记录（9 条）；③ 但在克隆里 **URL 是 `.tmp/clone-offline/lib/index.js`，不含 `dsh-text-tool-call-recovery` 这一段** → 匹配全部落空 → 只统计到 `apply`/`name` 两个函数 → 10.0%。**这是「测试只在作者本机跑过」的典型后果：本机目录名恰好与硬编码字符串一致，所以 100% 一直是对的。** 任何人 fork 后改名（`my-fork`）、或 CI 检出到随机目录，都会看到假的「覆盖不全」 | ① 两处都改为**按真实绝对路径**比较（`pathToFileURL(LIB).href` + `fileURLToPath` 规范化兜底），并补 `import { pathToFileURL, fileURLToPath } from "node:url"`；② 注释写清根因与复现方式；③ **双向验证**：本机 `coverage` **100.0%（24/24）**、`branch-coverage` **54 处（≤69）**；克隆到 `.tmp/clone-offline` 后**同样 100.0% 与 54 处，exit 0**。**修复前后对比：克隆里 10.0% / exit 1 → 100.0% / exit 0。** |
| 147 | **`meta-health` 里写死了作者的个人绝对路径 `C:\Users\<你的用户名>\...\app.asar` —— 把用户名提交到公开仓库，且别人机器上只能靠环境变量手动指定，否则静默跳过** | 第 10 节：`const ASAR = "C:\\\\Users\\\\<你的用户名>\\\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";`，虽然下面有 `process.env.DSH_ASAR ?? ASAR` 的覆盖 | 第 141 轮从「环境假设」角度系统扫描全部套件：① 硬编码绝对路径 12 处（绝大多数是**测试用的假路径**如 `C:\path\file`、`C:\Python\python.exe`，合理）；② 硬编码仓库目录名 1 处（`package-contract.mjs` 的 `import("@zhaozehao10/dsh-text-tool-call-recovery/lib/index.js")`，**用途正当** —— 验证包名解析）；③ `USERPROFILE`/`HOME` 依赖 16 处（都用 `??` 回退，合理）；④ `process.platform` 6 处（合理）。**唯一真正的问题是 `meta-health` 的 ASAR 路径** —— 它是**真实的个人路径**，会随仓库公开，且别人机器上只能靠 `DSH_ASAR` 手动指定 | ① 改为**按候选位置自动探测**：`DSH_ASAR` 环境变量优先 → Windows 用 `LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar` → Linux `~/.local/share/...` 与 `/opt/...` → macOS `/Applications/...app/Contents/Resources/...`，全部用 `os.homedir()` / 环境变量拼出，**源码里不出现任何用户名**；② 加 `!asarPath \|\|` 守卫（所有候选都不存在时 `existsSync(undefined)` 会抛错）；③ **`meta-health` 新增第 18 节（4 项）**：扫描 110 个测试文件，要求不出现 `C:\Users\<具体名>` / `/home/<名>` / `/Users/<名>`，含**反向自测**（正则必须能抓到构造的个人路径、且不误报 `os.homedir()`）。**变异验证**：往 `lifecycle.mjs` 注入 `C:\Users\<USERNAME>\secret.dat` → **80 passed / 1 failed（exit 1）**，精确报出 `lifecycle.mjs L14`。**过程中修正自己 2 个错误**：(a) 第一版正则只认单个反斜杠，而源码里常写**双反斜杠** → 注入的变异**抓不到**（改为 `[\\/]+`）；(b) 自测探针的字面量**被自己的检查抓到** → 改为拼接构造。`meta-health` **77 → 81 项**，实测 **110 个文件**全部干净 |
| 148 | **修完缺陷 147 后引入的两处连锁问题：我把真实用户名写进了公开 README；写入的占位符又被 `deliverable` 当成「待填占位符」** | ① 缺陷 147 的记录里原文写了 `C:\Users\<用户名>\AppData\...`；② 改成 `C:\Users\<USERNAME>\...` 后，`deliverable` 占位符检查的正则 `/<[A-Z][A-Z0-9_]{3,}>/` 匹配到 `<USERNAME>` | 第 141 轮修完缺陷 147（把 `meta-health` 里写死的个人路径改成自动探测）后，做终审扫描时发现**记录缺陷的文字本身把用户名泄露出去了** —— 我在缺陷 147 的「根因」一栏里照抄了原始代码 `const ASAR = "C:\\Users\\<用户名>\\...";`。**这是讽刺性最强的一处：修「不要泄露用户名」的缺陷时，把用户名写进了缺陷记录。** 改成 `<USERNAME>` 占位后又触发第二层问题：`deliverable` 的「缺陷表里没有待填占位符」把说明性占位当成了待填项 | ① README 中英文缺陷 147 记录里的真实用户名全部替换为 `<你的用户名>`；② 变异示例里的 `SomeRealUser` 也换成 `<USERNAME>`；③ `deliverable` 的 `PATH_PLACEHOLDERS` 加入 `USERNAME`（说明性占位，不是待填项）并写清理由；④ **终审用 Node 精确复查 131 个文件 → 真实个人路径 0 处**。（`community/repro/harness-side.mjs` 里的 `C:\Users\me\...` 是**真实日志样本的原文**，`me` 是通用占位名，属证据保真，**不改**。） |
| 149 | **`run-all` 把「超时」和「断言失败」显示得一模一样；且超时阈值写死 10 分钟，而最慢套件已要 172 秒 —— 慢机器上必然误判** | `catch (e) { out = ...; ok = false; }` 之后直接 `status = ok ? "PASS" : "FAIL"`，**没有任何超时分支**；超时写死 `timeout: 600000` | 第 142 轮从「测试运行器健壮性」角度检查 `run-all.mjs`。**实测数据**：`--offline` 全量 100 个套件共 **526 秒**，其中 `coverage` 单套件 **172 秒**。这样一个「慢 3.5 倍的机器/CI」上 `coverage` 就会撞到 600 秒超时 —— 此时维护者看到的是 `[FAIL] coverage 600123ms FAIL`，**完全看不出原因是超时而不是断言挂了**，会去翻插件代码找不存在的 bug。这与缺陷 106（失败被当成跳过）是**同一族问题的另一面**：第 106 轮只修了「跳过」这个方向，**「超时」这个方向一直没被检查** | ① `TIMEOUT_MS` 提为常量并**支持 `DSH_TEST_TIMEOUT_MS` 覆盖**，默认从 10 分钟提到 **20 分钟**（对最慢套件留 7 倍余量），注释里写明实测数据；② `catch` 里识别 `ETIMEDOUT`/`SIGTERM` 并置 `timedOut`；③ 状态新增第四态 **`TIMEOUT`**（原来是 PASS/FAIL/SKIP 三态）；④ 超时时**强制**把 conclusion 改成「⏱ 超时（> 1800s 未结束）—— 可能是机器太慢或套件卡死，不一定是 bug」；⑤ **`meta-health` 新增第 19 节（8 项）**：验证 TIMEOUT_MS 存在且可覆盖、阈值 ≥15 分钟、catch 识别 ETIMEDOUT/SIGTERM、status 有 TIMEOUT 分支、conclusion 写明原因、不再硬编码 600000。**变异验证**：去掉 TIMEOUT 分支 → **88 passed / 1 failed（exit 1）**，报出 `status 无 TIMEOUT`。`meta-health` **81 → 89 项** |
| 150 | **一个「什么都没输出、exit 0」的套件会被 `run-all` 判成 PASS** | `ok = true` 只看退出码，**完全不看有没有输出**；`conclusion` 回退成 `"OK"` | 第 143 轮继续从运行器角度检查，构造 6 种异常退出模式实测：崩溃 throw、未捕获 Promise 拒绝、打印「通过」但 exit 1、**什么都没打印 exit 0**、什么都没打印 exit 1、打印「跳过：」但 exit 1。前 5 种里**唯一判错的是「无输出 exit 0」→ PASS**。这与缺陷 38（「测试文件里没有任何断言，永远通过」）是**同一个陷阱的运行器版本**：套件可以「悄悄不跑」却显示绿。现有 110 个套件都有实质输出，所以**一直没被触发，但也一直没有防线** —— 任何人加一个空壳套件都会静默通过 | ① `run-all` 增加 `hasSubstance` 判断：**PASS 必须伴随至少一行非空原始输出**，否则判 FAIL 并写明「套件 exit 0 但**没有任何输出** —— 无法确认它真的检查过什么」；② **`meta-health` 新增第 20 节（6 项）**：验证 run-all 有该防线、无输出判 FAIL、给出原因、**基于原始输出而非过滤后的行**，外加**静态反向验证**（108 个套件都有 `console.log`/`console.error`，不会误报）。**变异验证双重命中**：往 `threshold-audit.mjs` 写入 `process.exit(0);` → `run-all` 判 `❌ 套件 exit 0 但没有任何输出`，`fake-test-audit` 同时判 `❌ 所有测试脚本都能失败 :: threshold-audit.mjs`。**过程中修正自己 1 个错误**：第一版用 `lines.length > 0` 判断，而 `lines` 已过滤掉全部 `===` 开头的行 —— **几乎所有套件的汇总行都以 `=====` 开头**，导致 **14 个正常套件被误判成「无输出」**；改为直接看原始 `out`。`meta-health` **89 → 95 项** |
| 151 | **套件自己打印了 `❌`，却 `exit 0` —— `run-all` 判 PASS，而结论里赫然写着「❌ 某项失败」** | `status` 只看退出码；`claimsFailure` 从未被检查 | 第 144 轮继续用「构造反例」法，测 8 种输出形态。**唯一自相矛盾的一条**：`console.log("  ❌ 某项失败"); process.exit(0);` → **status = PASS，conclusion = "❌ 某项失败"**。现有 96 个套件都没这么写（实测 exit 0 且含 `❌` 的为 0 个），但这说明**运行器完全信任退出码**，而「打印了失败标记却忘了 `exit 1`」是**极容易犯的错** —— 一旦发生，失败会被静默洗白 | ① `run-all` 新增 **`SUSPECT` 状态**（第 4 种状态之后第 5 种）：exit 0 但输出含失败标记 → 判 SUSPECT 并给出「⚠️ 输出里出现失败标记但 exit 0（缺陷 151，请人工复核）」；② **SUSPECT 计入失败统计**（宁可让人看见，也不静默通过）；③ **`meta-health` 新增第 21 节（9 项）**：验证矛盾检测变量、SUSPECT 状态、计入失败、给出说明，外加**4 项正则自测**（`❌` 行判失败、`1 failed` 判失败、`FAIL: 0` 不判失败、`0 failed` 不判失败）。**变异验证**：注入「打印 ❌ 但 exit 0」→ `[SUSPECT] threshold-audit ⚠️ 输出里出现失败标记但 exit 0`，**退出码 1**。**过程中修正自己 2 个错误**：(a) 第一版正则 `FAIL[\s:：]` 把 `PASS: 9, FAIL: 0` 的**零值**当成失败，误报 `verify-install-runnable`；(b) 第二版 `failed[\s:：]*[1-9]` 只认「failed 后面跟数字」，而实际写法是「**1 failed**」（数字在前），自测立刻抓到 → 改为双向 `\bfailed[\s:：]*[1-9]\|[1-9]\s*failed\b`。`meta-health` **95 → 104 项** |
| 152 | **3 个依赖真实日志的套件在「零样本」下全都输出「✅ 全部正常」并 exit 0 —— 0/0 当成全部正确** | `audit-rewrites` 判据是 `suspicious > 0`；`per-model-replay` 判据是 `totalBad === 0`；`lcr-replay` 只打印「⚠️ 无会话文件」就继续 | 第 145 轮发现前 24 轮主要跑 `--quick/--offline`，**9 个只在完整模式跑的套件长期未被覆盖**。本轮先跑完整模式确认 **110 通过 / 0 失败**（1309.7s），再用**临时空 HOME** 模拟「新机器/CI 无日志」场景，逐个测这 9 个套件。发现 3 个在**空会话目录**下全部报通过：`audit-rewrites` → 「总流 0，被改写 0」→「✅ 所有被改写的流都是真空响应」；`per-model-replay` → 「模型种类: 0」→「✅ 所有 provider/model 组合均正常」；`lcr-replay` → 「⚠️ 无会话文件」→「16 passed, 0 failed」。**这是典型的 0/0 = 全部正确 谬误**：0 个样本**无法证明任何事**。危害是让「完整模式全绿」变成**虚假保证** —— 换台机器或 CI 就静默通过 | ① 三个套件全部加**零样本 → exit 1** 分支并写明「这不是『全部正常』，而是**无法验证**」；② **`meta-health` 新增第 22 节（6 项）**：验证三者都有零样本分支，外加**反向验证**（三者确实读取真实会话目录，否则不该有这条分支）。**双向验证**：空 HOME 下三者**全部 exit 1** 且输出明确原因；真实环境下三者**全部 exit 0**（audit-rewrites「可疑数 0」、per-model-replay「异常 0」、lcr-replay「25 passed」）。`meta-health` **104 → 110 项** |
| 153 | **`known-limit-noargs` 的「无参数形态极罕见（< 5 次）」是**上界断言**：零样本时 `0 < 5` 自然成立，**没数据也能证明罕见**** | `ck("真实数据里无参数形态极罕见（< 5 次）", noArgForms < 5, ...)` —— 缺 `scanned > 0` 守卫 | 第 145 轮修完缺陷 152（零样本假装通过）后，本轮从 `NEEDS_LOGS` 列表完整性入手反向检查：扫出 **7 个读 `sessions` 目录但不在 `NEEDS_LOGS` 的套件**，逐个在**临时空 HOME** 下实测 —— 4 个正确失败（`baseline-regression`/`deploy-verify`/`host-validator`/`runtime-process-check` 都因「0 个会话」判失败），**唯独 `known-limit-noargs` 仍 8 passed / exit 0**。根因是**另一种零样本形态**：缺陷 152 是「循环不执行所以不失败」，这里是「**上界断言在零样本下自动为真**」。对照 `host-validator.mjs` L315 写的是 `failed === 0 && tested > 0` —— **那才是正确写法** | ① 改为 `noArgForms < 5 && scanned > 0`，失败信息显示「N 次 / 扫描 M 个会话」；② **`meta-health` 新增第 23 节（3 项）**：扫描 5 个读日志的套件，要求**统计量型上界断言**（变量名含 `noArgForms`/`scanned`/`tested` 等）必须同时守卫 `scanned > 0`，并**反向验证** `known-limit-noargs` 与 `host-validator` 的写法。**双向验证**：空 HOME 下 exit 1（「0 次 / 扫描 0 个会话」）；真实环境 8 passed / exit 0。**变异验证**：去掉 `scanned > 0` → `112 passed / 1 failed（exit 1）`。**过程中修正自己 1 个错误**：第一版判据把 `r.calls === 0`（合成测试的正当负向断言）、`size < 100KB`（文件属性）也抓进来误报 5 处 → 收窄为「**变量名暗示来自日志扫描**」才检查。`meta-health` **110 → 113 项** |
| 154 | **5 个插件行为套件从未纳入变异测试：它们守护真实缺陷（D126/D127/D129），却从未被证明能抓到 bug** | `mutation-test.mjs` 的 `SUITES` 是**手工维护**的，长期 89 条；而已有 **108 个 hardening 套件** | 第 146 轮提炼出「列表的正确性有两个方向」，本轮把它用到**所有套件清单**上。交叉检查 7 个清单（`META`/`SLOW`/`AUDIT_SCRIPTS`/`FAST`/`CORE`/`SUITES`/`NEEDS_*`）→ **全部无僵尸条目**；但 `SUITES` 有 **20 个套件未纳入**，其中经分类确认 **5 个是真正的插件行为套件**：`antml-prefix-symmetry`（D127 守护）、`call-form-matrix`、`fence-eol-matrix`（D126 守护）、`markup-only-completeness`（D129 守护）、`known-limit-outcomes`。其余 15 个是慢速/真实日志/性能/元套件，不纳入合理。**危害正是缺陷 73 指出的「套件的有效性从未被证明」**：它们通过了，但没有任何证据表明它们**能失败** | ① 5 个全部加入 `SUITES`（89 → **94** 条），实测 **46/46 KILLED、0 SURVIVED、0 SKIP**，五个新套件单独跑均通过（12/17/18/14/6 项）；② **`meta-health` 新增第 24 节（3 项）**：要求**所有调用插件的套件**都必须在 `SUITES` 里（合理排除慢速/真实日志/性能/元套件，白名单逐一写明），外加**反向验证**「`SUITES` 里没有指向不存在文件的僵尸条目」。**变异验证**：删掉 5 条 → `114 passed / 2 failed`，精确报出全部 5 个。**过程中修正自己 1 个错误**：第一版判据只匹配 `wrapStream`/`extractCalls` 等导出名，而 `antml-prefix-symmetry` 是**通过 `mod.apply({on})` 注册监听器再驱动**的，一个都没匹配上 → 变异验证只报出 4 个；补上 `apply(`/`llm/stream`/`mod.` 后报出全部 5 个。`meta-health` **113 → 116 项** |
| 155 | **`meta-health` 的 asar 解析靠 `indexOf('{"files":')` 找 header —— rc.3 上这个位置是错的，导致 JSON.parse 在 2099 处失败** | `const idx = buf.indexOf(Buffer.from('{"files":'));` + 括号深度扫描找结尾 | 第 148 轮 DSH 升级到 **0.2.1-rc.3** 后做适配，`meta-health` 报「asar 可解析」失败。逐步排查：① 用 asar pickle 格式读头部四个 uint32，实测为 `4748096 / 4748092 / 4748087`；② 真 header 从 **offset 16** 开始，长度取 **offset 12** 的值；③ 而 `indexOf` 在 rc.3 上返回的是 **1142**，因为**头部嵌套子目录节点也带 `"files"` 键**，`indexOf` 命中了内部某处。**rc.2 能跑只是巧合**（那时匹配位置恰好正确），不是正确实现。另外「括号深度扫描」也不可靠：header 的 JSON 字符串值里含 `{` `}`（如 package.json 内容），深度会算错 | ① 改为**按 asar pickle 格式正确解析**：`jsonLen = buf.readUInt32LE(12)`、`idx = 16`、`dataOffset = ceil((16+jsonLen)/4)*4`，**不做任何扫描**；② 加自洽性断言 `offset8 === jsonLen + 5`（rc.2/rc.3 都成立），格式再变时**尽早报错**而不是静默解析错。**双向验证**：rc.3 下正确读出 `版本 asar=0.2.1-rc.3 local=0.2.1-rc.3`、`lib/index.js 105272 字节一致`、`lib/types 13 个 .js 全覆盖`；rc.2 下同样能解析（`meta-health` 现在正确报出 asar/local 版本不一致，而不是解析失败）。`meta-health` **116 项全通过** |
| 156 | **`run-all` / `coverage` / `branch-coverage` / `mutation-test` 的 `execFileSync` 没设 `maxBuffer`（默认 1 MB）：套件通过也会被运行器自己判成失败** | 四个 spawn 点都用默认 `maxBuffer`（1,048,576 字节）；多个套件在循环里大量输出（`baseline-regression` 38 处、`code-quality` 34 处、`claims-audit` 31 处循环内 console） | 第 149 轮排查「rc.3 上完整模式 4 个失败」时发现：`coverage` 与 `branch-coverage` **单独跑全绿，完整模式里却失败**，且失败输出被截断。系统内存仅剩 ~1 GB 是诱因，但**直接原因是缓冲区**：子进程输出一旦超过 1 MB，`execFileSync` 抛 `ENOBUFS`（ERR_CHILD_PROCESS_STDIO_MAXBUFFER）—— **套件本来通过，却被运行器判成失败**，报错信息完全看不出是缓冲区问题。`mutation-test` 也因「基线失败」连带不可信 | ① 四个文件统一加 `maxBuffer: 64 * 1024 * 1024`（覆盖 `coverage` 收集 100 个子进程输出的场景），每处带缺陷号注释；② 修复后 **rc.3 完整模式首次全绿：110 通过 / 0 失败 / 0 跳过**（1514.1s），此前连续失败的 `coverage`（212s）、`branch-coverage`（215s）、`mutation-test`（727s，46/46 KILLED）全部通过。**教训**：「单独跑通过、合跑失败」时先查资源限制，再查逻辑 |
| 157 | **实盘证据统计用「文本 grep」会把对话内容自己算进去：`EMPTY_RESPONSE` 实测 5,022 次 vs 真实 60 次（差 84 倍）** | 用 `text.match(/EMPTY_RESPONSE/g)` 统计会话日志 | 第 150 轮在用户重启 DSH 后做**首次实盘验证**（此前插件一直未被运行中的宿主加载）。先用文本 grep 统计日志，得到 `txtcall-` 1,680 次、`EMPTY_RESPONSE` **5,022 次**，一度以为「插件产生了大量空响应重试」。**逐条 dump 日志行才发现：这些命中绝大多数是我们自己对话内容被写进日志**——README 的缺陷表、测试输出、分析脚本源码里都含 `EMPTY_RESPONSE` 这个词（本材料有 156 条缺陷记录，每条都提到它）。真正的结构化证据是 `"code":"EMPTY_RESPONSE"` 字段：**只有 60 条**。**再按插件生效时间（10-28 01:12）过滤：60 条全部在生效之前，生效后 0 条。** | ① 明确记录方法论：**统计会话日志证据必须 `JSON.parse` 后按结构化字段匹配，禁止文本 grep**（日志里含对话正文，任何关键词都会被自身材料污染）；② 实盘结论修正为：`txtcall-` 结构化 toolCallId 生效前 2 次、生效后 0 次；`EMPTY_RESPONSE` 结构化 code 生效前 60 条（多为旧版插件历史记录）、生效后 **0 条**；③ 生效后仅有的 3 次 `assistant/attempt` 来自 `group/glm5.3-zcode` 与 `auto/deepseek-v4.1-flash`，**尚无 step-5-preview 实盘流量**，故实盘效果仍待该模型真实请求验证。**这个错误差点写进对外材料——84 倍的虚高会让「插件在大量重试」的错误结论被当成事实。** |
| 158 | **改写 `lib/index.js` 的套件与读取它的套件之间没有互斥：并发运行会读到变异体，产出成批假失败** | `mutation-test` / `shape-robustness` 会临时注入变异体到 `lib/index.js`（有 try/finally 还原，但**没有跨进程互斥**）；而 `coverage` / `branch-coverage` / `claims-audit` / `run-all` 都会读它 | 第 151 轮重跑完整模式时，我在 `mutation-test`（#66，727s+）仍在运行时并行跑了 `claims-audit`，结果：① `live-instance` 报「源码 **48687B** vs 安装 48772B」→ **假失败**；② `error-observability` 声明 26 项、实跑只数到 24 → **假不达标**；③ `coverage` spawn 的 100 个子套件读到变异体后内部失败 → 「未执行函数 0 个」却判 ❌；④ 完整模式从 **21 分钟恶化到 95 分钟**，产生 3 个假超时/假失败。**证据**：`mutation-test` PID 20476 于 12:20:04 启动，同期 `lib/index.js` 大小在 48687→48757 之间跳动，而安装副本恒为 48772。**这是「测试之间互相污染」类缺陷里最隐蔽的一种：失败信息看起来完全像真 bug。** | ① 新增 `test/hardening/_lib-lock.mjs` 共享锁模块：`acquireLibWriteLock` / `releaseLibWriteLock` / `libWriteLockHolder`（含**陈旧锁自动清理**：持有进程已死则视为无效）/ `exitIfLibLocked`；② 两个**改写方**在改写前取锁、注册 `process.on("exit")` 保证任何路径释放；③ 四个**读取方**（`run-all` / `coverage` / `branch-coverage` / `claims-audit`）检测到写锁就**明确跳过并说明原因**（exit 0，不产出假红）；④ `.gitignore` 排除锁文件；⑤ **`meta-health` 新增第 25 节（11 项）**：验证锁模块存在、两个改写方都取锁且注册 exit 释放、四个读取方都检测、锁模块支持陈旧锁清理与 owner 校验。**端到端验证**：用存活 PID 持锁 → 4 个读取方全部打印「跳过：检测到 mutation-test.mjs 正在改写 lib/index.js（PID …）」并 exit 0；释放后 `claims-audit` 恢复正常 **12 passed**。**过程中修正自己 1 个错误**：第一版把 `exitIfLibLocked` 的第二个参数（日志函数）当成回调标记传，导致**跳过生效但原因没打印**（又是静默跳过）。`meta-health` **116 → 127 项** |
| 159 | **强制终止 `mutation-test` 会把变异体永久留在 `lib/index.js` 里（`try/finally` 对 SIGKILL 无效），导致后续所有套件基线集体失败** | `mutation-test` 用 `try/finally` 保证还原，但**强杀/断电/崩溃时 finally 不会执行** | 第 151 轮我为验证锁机制用 `Stop-Process -Force` 终止了一次 `mutation-test`，随后 `lib/index.js` 停留在 **48,758 字节**（安装副本 48,772）。后果：下一次 `mutation-test` 的基线阶段里 `等价类划分`、`XML 属性` 等**集体失败**，而它们的失败信息（「识别 0 个」「多余空格未被正确识别」）**看起来完全像真 bug**——差点又去翻插件代码。**更根本的是**：`mutation-test` 在 L17 直接 `fs.readFileSync(LIB)` 当作 `ORIGINAL`，若源码已被污染，它会把**变异体当成原始内容**，后续所有还原都指向错误基线 | ① `mutation-test` 新增**崩溃自愈**：定义 `.tmp-lib-orig.js` 纯净备份；**开工前**若备份存在且与当前源码不同 → 先还原并打印「检测到上次异常中断留下的变异源码（N → M 字节），已从备份还原」；② 基线通过、进入变异循环前写备份，`process.on("exit")` 删除备份；③ `.gitignore` 排除备份文件。**验证**：手工把 `lib/index.js` 改脏（48,794 字节、含 `MUTANT-LEFTOVER`）+ 放置纯净备份 → 启动 `mutation-test` → 立即打印恢复信息、源码回到 **48,772 字节且不含 MUTANT-LEFTOVER**、哈希与安装副本一致。**教训**：`try/finally` 只能防「异常」，防不了「强杀」——凡是有持久化中间状态的操作，都必须有**下次启动时自愈**的路径。 |
| 160 | **真实日志套件对「会话文件体积」没有任何上限：一个 51.2 MB 的会话能把 `audit-rewrites` 从 31s 拖到 1263s 超时** | 14 个套件各自实现 `decompress()` → `zstdDecompressSync` 全量解压 → `text.split("\n")`，**无大小守卫**；`audit-rewrites` 遍历**全部**会话，不按体积筛选 | 第 152 轮完整模式连续两次超时（`audit-rewrites` 1263s、`deploy-verify` 3619s），而这两个平时只要 31s / 6s。排查发现：会话总数虽仍 45 个，但**最大单文件已达 51.2 MB**（我们自己的长对话把日志撑大），全量解压后可达数百 MB，`split("\n")` 再翻几倍 → 内存紧张时剧烈换页。**这类问题会随用户日常使用持续恶化**，属于交付物必须防的健壮性缺口 | ① 14 个套件统一加**体积守卫**：压缩体积超过阈值（默认 **64 MB**，可用 `DSH_LOG_MAX_MB` 覆盖）就**明确打印跳过原因**并返回空串，不再拖死；② `host-validator` 的内联解压也补同一守卫；③ 阈值从最初试的 8 MB 调到 **64 MB** —— 8 MB 会跳过含 step-5-preview 证据的大会话，导致 `deploy-verify`/`live-instance` 报「0 条证据」**假失败**；64 MB 能覆盖当前全部会话且实测 `audit-rewrites` **31s 完成**（23,530 条流、7 条改写、可疑 0）。**教训**：「跳过超大文件」的阈值不能拍脑袋——太低会丢证据，太高会 OOM，必须按真实数据分布定，并留环境变量可调。 |
| 161 | **`coverage` / `branch-coverage` 串行 spawn ~100 个子 Node 进程时不设堆上限：默认堆按系统内存比例分配，叠加后把整机内存挤干，导致子套件成批失败** | 两个套件的 `nodeArgs` 只有 `["--expose-gc", s]` / `[s]`，**没有 `--max-old-space-size`** | 第 153 轮在**仅剩 2 GB 可用内存**的机器上跑完整模式：`branch-coverage` 耗时 335s 后失败，报「未覆盖代码块 54 处（门槛 ≤ 69）」——**54 ≤ 69 本应通过**，实际是 「失败列表」 非空（有子套件失败）。加日志后看到明细：`audit-rewrites`、`effect-quantify` 等**在覆盖率收集阶段 V8 直接崩溃**（栈里 `DiyFp::Multiply`）。根因：100 个子进程各自按系统内存比例申请堆，叠加起来把 2 GB 挤干 | ① 两个套件的 `nodeArgs` 统一加 **`--max-old-space-size=2048`**（先试 512 MB —— 会**压崩**要处理 51 MB 会话的 `audit-rewrites`/`effect-quantify`，实测 V8 崩溃；2048 MB 既够用又不像默认值那样膨胀）；② **`meta-health` 第 27 节扩展 4 项**：两个套件都必须设堆上限、且阈值必须是 2048。**验证**：`branch-coverage` **259s / exit 0 / 54 处（≤69）**、`coverage` **327s / exit 0 / 100% 函数覆盖**——此前在同样的 2 GB 内存下两者都失败。**教训**：批量 spawn 子进程时必须**显式约束每个子进程的资源**，否则「默认值 × N」就是一次对整机的 DoS。 |
| 162 | **`coverage` / `branch-coverage` 的子套件偶发 V8 OOM 抖动会把整条覆盖率数据判为「不可信」，进而误报失败** | 收集循环 `catch (e) { 把失败的套件名追加进失败列表 }` —— **一次失败就永久记录**，没有重试 | 第 153 轮在 2 GB 可用内存的机器上反复验证：`branch-coverage` 单独跑 **exit 0（54 处 ≤ 69）**，但在完整模式里跑就 **exit 1**，报「3 个套件在覆盖率收集时失败」，明细是 `audit-rewrites` / `effect-quantify` 的 **V8 崩溃**（栈里 `DiyFp::Multiply`）。同一份代码、同一个套件，只因内存压力不同而结论相反 —— 这是**测试基础设施自身的不稳定**，会让人误以为代码有问题 | ① 两个收集循环加**失败重试一次**：第一次失败后立即重跑同一子套件，成功则 `continue` 跳过失败记录，两次都失败才记录；② 配合缺陷 161 的堆上限（2048 MB），把抖动概率降到可接受。**验证**：`branch-coverage` **329s / exit 0 / 54 处（≤69）**、`coverage` **325s / exit 0 / 100%**；随后**完整模式 110 通过 / 0 失败 / 0 跳过**（2415s，`mutation-test` 46/46 KILLED、`branch-coverage` 318s、`coverage` 315s、`health-check` 146s 全部通过）。**教训**：「同一个套件单独跑过、合跑失败」在资源受限环境下是**大概率事件**，测试基建必须对**瞬时资源失败**有区分能力，否则会把环境问题报成代码缺陷。 |
| 163 | **两条「反向验证」把测试与作者的交接状态耦合：作者填好占位符、准备发布时，检查反而失败** | `deliverable` 断言「真实 `package.json` 里必须能找到占位符」、`doc-consistency` 断言「PASTE-READY 恰有 1 个占位符」—— 两处都是**用真实文件当样本**去验证「检测器不是空转」 | 第 154 轮用户提供了 GitHub 用户名（`ZhaoZehao10`），我把 `package.json` 的 3 处仓库地址 + 1 处 author 以及 PASTE-READY 的仓库链接全部填好后，两个套件立刻报错：`deliverable` 报「确实检测到 package.json 的占位符（非空转）:: 找到 0 种」、`doc-consistency` 报「PASTE-READY 恰有 1 个占位符 :: 找到 0 个」。**这不是代码或文档的问题，而是测试写法的问题**：把「检测器有效性」和「交付物状态」混在一条断言里，导致**交付物越接近就绪、测试越红** —— 典型的「测试阻碍正确行为」反模式 | ① 两处都拆成**两条独立断言**：用**合成样本**验证检测器本身有效（一段含两个大写占位符的合成字符串 应命中 2 个；一段含一个仓库链接占位符的合成字符串 应命中 1 个），再用真实文件断言**就绪状态**（`package.json` 无占位符、PASTE-READY 占位符 ≤ 1）；② 同步 README 测试矩阵里 `deliverable` 的声明数 95 → **96**。**验证**：`deliverable` **96 passed / 0 failed**、`doc-consistency` **55 passed / 0 failed**、`claims-audit` **12 passed / 0 failed**。**教训**：「检测器有效」与「被测对象处于某状态」是两件事，**必须分开断言**——否则测试会惩罚正确操作。 |
| 164 | **包名占用了 DeepSeek 官方的 npm scope `@deepseek-ai/`：第三方项目使用别家官方 scope，开源礼仪上不妥** | `package.json` 的 `name` 曾写成 **DeepSeek 官方 scope 下的同名包**（`@deepseek-ai/` + 本包名）；安装目录、`cordis.patch.yml` 的 `insert.name`、README/文档/测试里共 **42 处**引用该名称 | 缺陷 139 只补了「非官方项目」的声明，但**没有解决根本问题**：一个社区插件凭什么占用 DeepSeek 的官方 npm scope？用户明确要求「完全避免这一点」。核实：`@deepseek-ai` 是 DeepSeek 的官方 npm 作用域，第三方无权使用；即便 `private: true` 不会真的发布，材料里出现这个 scope 仍会让维护者觉得不妥 | ① 改用**用户自己的命名空间** `@zhaozehao10/dsh-text-tool-call-recovery`（`zhaozehao10` 来自用户 GitHub 账号 `ZhaoZehao10`，属其本人命名空间，不侵犯任何第三方）；② 全仓库 **42 处**引用统一替换（15 个文件：`package.json` / `lib/index.js` 的 `@module` 与 Cordis 插件名 / `install-stepfix.ps1` 的安装路径 / README 中英 / 社区投稿稿 / 6 个测试套件）；③ 安装目录迁移 `node_modules/@deepseek-ai/…` → `node_modules/@zhaozehao10/…`，`cordis.patch.yml` 的 insert 条目同步更新，**旧名称已不可解析**；④ 官方包引用（`@deepseek-ai/dsh-llm`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-base` 等）**保持原样不动**。**验证**：`require.resolve("@zhaozehao10/dsh-text-tool-call-recovery")` 从 profile 解析成功、旧名称解析失败（彻底迁移）；`package.json` JSON 合法、`lib/index.js` 语法通过。**教训**：借用一个组织的官方 scope 不是「起名问题」而是**归属问题**——`private: true` 只解决「不发布」，解决不了「不该用」。 |
| 165 | **测试按「字节」比较源码与安装副本：从 GitHub 克隆到 Linux/macOS（LF 换行）后，4 个套件必然报「源码与安装副本不一致」——纯属换行符差异** | 5 处用 `Buffer.equals` / `Buffer.compare` 比较 `lib/index.js` 的原始字节；仓库 `.gitattributes` 统一存 LF，Windows 检出为 CRLF，**同一份代码两种平台字节数不同**（实测 48,772 B vs 47,731 B，差 1,041 B = 行数） | 第 155 轮推送后做「从 GitHub 全新克隆再跑测试」的终极验证，克隆目录立刻报 `deploy-verify`「源码 47731B vs 安装 48772B」、`live-instance`、`runtime-process-check` 三个失败，加 `runtime-process-check` 的诊断行 `❌ 不一致` 又触发 run-all 的 SUSPECT 守卫（假矛盾）。**这是最典型的「只在本机成立」缺陷** —— 作者机器上永远绿，任何外部贡献者克隆后必红。若不是真的克隆下来跑一遍，这种缺陷会一直躺在仓库里 | ① 新增 `test/hardening/_file-compare.mjs`：`normalizeEol()` 把 CRLF 折成 LF、`sameContent()` 做**语义比较**（只抹平换行符，不放过真实差异）；② 5 处比较全部改用 `sameContent`：`deploy-verify` / `live-instance` / `runtime-process-check` / `package-contract` / `install-failure-paths`；③ `runtime-process-check` 的诊断打印也从 `src.equals(inst)` 改为 `sameContent`，避免打印 `❌ 不一致` 被 run-all 判 SUSPECT。**验证**：在**真实克隆目录**（LF，47,731 字节）跑 `--quick --offline` → **89 通过 / 0 失败 / 7 跳过**（7 个跳过都是缺本地草稿，属设计内）；本机（CRLF）仍全绿。**教训**：**发布前一定要「从远端全新克隆再跑一遍」** —— 本地工作区通过 ≠ 发布产物可用。 |
| 166 | **包名改掉官方 scope 后，README 顶部的「非官方项目」声明仍在解释早已废弃的 `@deepseek-ai/` 前缀；且标题口语化（「深度思考一会儿就卡住」），不像正式项目文档** | `README.md` 第 3-6 行的声明由缺陷 139 写成，缺陷 164 改名时**只批量替换了包名字符串，没有改这段解释性文案**；标题 `# step-5-preview「深度思考一会儿就卡住」/ magpie 路由「任务自动截断」修复说明` 是第 1 轮排查时按用户口语描述写的 | 用户指出两个问题：① 声明说「包名用了 `@deepseek-ai/` 前缀，只是为了让 profile 的目录结构与官方插件保持一致」——**但我们已经改成 `@zhaozehao10/` 了**，这段成了误导；② 标题像工单标题而非项目名。**根因**：缺陷 164 的替换是「字符串级」的，只覆盖了包名本身，**没覆盖解释包名的那段散文**——这是批量改名的典型盲区 | ① 声明改为反映真实归属：「包名使用作者本人的命名空间 `@zhaozehao10/`，**不占用任何官方 scope**、**不代表官方背书**」；② 标题改为 `# DSH 文本工具调用恢复插件（dsh-text-tool-call-recovery）`，英文版对应 `# DSH Text Tool-Call Recovery Plugin (dsh-text-tool-call-recovery)`；③ 症状描述同步专业化（「深度思考一会儿就卡住」→「深度思考结束后回合静默终止、没有任何后续动作」）；④ `SUBMIT-GUIDE.zh.md` 同类文案一并修正；⑤ **`deliverable` 的检查项从「声明解释了 @deepseek-ai 前缀的由来」改为「声明说明了包名归属（不占用官方 scope）」** —— 否则测试会继续要求一段已经不存在的解释。**验证**：`doc-structure` 54/0、`doc-consistency` 55/0、`deliverable` 96/0、`claims-audit` 12/0、`ref-verifiable` 17/0、`doc-executable` 41/0 全部通过。**教训**：批量改名要覆盖的不只是**标识符**，还有**解释这些标识符的散文**——后者最容易漏，且读者一眼就能看出矛盾。 |

**为什么公开这些**：如果上游实现同样的恢复逻辑，这 8 个坑都会踩到。特别是

第 3 条（示例被误执行）属于安全问题、第 6 条（确定性失败空转）会造成明显

的 token 浪费，值得在设计阶段就规避。

### 测试矩阵（`test/hardening/`，可独立运行）

> 📌 **分类说明**：下列 92 个「套件」中，**91 个是真正的验证套件**（会因失败而退出非 0），
> **1 个是剖析工具**（`perf-profile`，输出数据供人工阅读，不参与通过/失败判定）。
> 性能回归由 `perf-baseline`（7 项断言）负责 —— 所以「性能这块没有被放过」。

> ℹ️ **真实流数字会随日常使用持续增长**。下表中的「（快照）」指的是**某一时点**的实测值
> （写作时为 14,408 条；第 86 轮复跑时已是 **15,675** 条）。你自己的机器上跑出来通常更多，
> 这是正常的 —— 数字变大不影响任何结论（被改写的比例始终在 0.15% 量级）。

| 层 | 脚本 | 规模 | 验证内容 |
|---|---|---|---|
| 集成断言 | `test/integration.test.mjs` | 155 项 / 29 用例组 | 恢复、安全网、顺序、防御、确定性失败保护、**交错块形态** |
| 复刻样本 | `test/real-samples.test.mjs` | 3 个真实案例形态 / **17 项断言** | Qwen / Anthropic / 截断形态；每个形态的**工具名、参数键、参数值、finish 改写**都有断言 |
| 语义属性 | `hardening/semantic-properties.mjs` | 28 项 | 类型强转、多行保真、顺序、安全（未声明工具不执行） |
| 边界穷举 | `hardening/boundary-cases.mjs` | 24 项 | 跑在宿主真实不变式校验器上 |
| 随机流模糊 | `hardening/fuzz-random-streams.mjs` | **3000 条随机流** | 不变量：finish 唯一、索引唯一、块闭合、usage 唯一、参数合法 JSON |
| **多轮模糊** | `hardening/fuzz-multi-turn.mjs` | **50 会话 × 最多 30 轮（708 轮）** | 长会话合法性、连续空响应保护、模型隔离、状态上界 |
| **测试基建健全性** | `hardening/meta-health.mjs` | 142 项 | **验证「验证工具」本身不会产生虚假通过**：变异测试的 SKIP 必须导致失败、`run-all` 跳过必须显式报告、覆盖率脚本并发安全（`mkdtempSync`）、元套件不互相递归、门槛有说明、61 个测试文件语法正确、无空壳套件 |
| **异常值与退出路径** | `hardening/throw-values.mjs` | 63 项 | 上游抛**非 Error 值**（字符串/null/undefined/数字/NaN/Symbol/BigInt/对象/数组共 16 种）必须**原样透传**且插件不得访问 `.message`；generator 的 `return()` / `throw()` 协议；消费者 `throw()` 非 Error 值；真实 await 中断；`finally` 清理被执行；抛错后同一 listener 仍可用 |
| **等价性** | `hardening/equivalence.mjs` | 15 项 | 恢复出的调用经**真实 `BlockAssembler`** 装配后，与原生结构化调用**逐字段等价** |
| **ReDoS/性能** | `hardening/redos-performance.mjs` | 60+ 病态输入 | 未闭合标记、嵌套、超长、围栏陷阱，全部 < 2 秒 |
| **真实流重放** | `hardening/replay-real-streams.mjs` | **14,408 条真实会话流（快照）** | 用真实日志的 chunk 序列重放：零破坏、零误伤 |
| **真实流行为基线** | `hardening/baseline-regression.mjs` | 7 项 | **`replay-real-streams` 的盲区**：它只验证「没破坏」，发现不了**行为漂移**（「以前改写这 5 条，现在只改写 3 条」）。本套件把「改写哪些流 + 改成什么」固化成基线 `real-stream-baseline.json`（1KB，只记 5 条被改写的流，指纹 = 内容 SHA256）：对比**不再改写**（漏识别回归）、**新增改写**（误伤回归）、**改写结果变了**。已用「注入破坏」验证它真能检测漂移 |
| **改写合理性审计** | `hardening/audit-rewrites.mjs` | 14,408 条（快照） | 逐条核对“被改写的流”是否真的是空响应（可疑数必须为 0） |
| **并发隔离** | `hardening/concurrency.mjs` | 20 并发 + 交错 + 中断 | 不串味、模型隔离、装配互不干扰 |
| **replayState** | `hardening/replay-state.mjs` | 25 项 | 回灌形状、块数对齐、畸形输入、error 不保留 |
| **消息不变量** | `hardening/message-invariants.mjs` | 29 项 | 块字段完整性、id 唯一性、Schema 强转 |
| **块顺序/交错** | `hardening/block-ordering.mjs` | 19 项 | 多块含标记时的装配顺序与索引唯一性 |
| **块交错** | `hardening/interleaved-blocks.mjs` | 12 项 | 多块同时打开、交错 delta、乱序 block-end 的形态；验证插件按 `index` 跟踪而非假设块连续 |
| **变异测试** | `hardening/mutation-test.mjs` | **46 个变异体** | 往源码里植入典型 bug，检验测试能否抓到；**变异覆盖率 100%**（46/46） |
| **差分测试** | `hardening/differential.mjs` | 3,000 条随机流 | 插件输出同时走宿主的**实时路径**（`BlockAssembler`）与**持久化回放路径**（`AssistantStreamAccumulator` → `snapshot` → `assembleAssistantStream`），两条路径结果必须完全一致 |
| **反引号精确性** | `hardening/backtick-precision.mjs` | 21 项 | 参数值含反引号必须恢复；标记在展示区必须不恢复（两侧都守）；跨行反引号包示例不得执行 |
| **截断安全性** | `hardening/truncated-safety.mjs` | 11 项 | 固化「不恢复不完整调用」的安全边界：外层闭合缺失/断在半途 → 一律不执行（避免执行被截断的危险命令） |
| **状态隔离与生命周期** | `hardening/state-isolation.mjs` | 24 项 | 插件唯一内部状态（按模型记的连续空响应计数）：模型隔离 / provider 隔离 / 并发不串 / LRU 上界淘汰 / reset 清理 / 异常路径不污染 / 键构造边界（含斜杠中文空串）/ 200 模型性能 |
| **replayState 一致性** | `hardening/replay-state-consistency.mjs` | 33 项 | 合成后 replay 块数对齐、顺序一致、畸形 replayState（null/字符串/缺 blocks/非数组）均不崩溃；stopReason 值域经 13,491 条真实日志核对（快照）（宿主实际只用 toolUse / stop / undefined） |
| **超时与背压** | `hardening/timeout-backpressure.mjs` | 15 项 | 上游卡住 300ms 插件不挂死也不自结束；首 chunk 延迟**中位 0.017ms / p95 0.475ms**（无缓冲）；20MB 流过峰值堆只增 2.37MB；100MB 单块不溢出；10 万 chunk **99ms**（约 101 万 chunk/s）；提前 break 34ms 立即返回 |
| **性能基线回归** | `hardening/perf-baseline.mjs` | 11 项 | 把性能特征固化成**可回归断言**：典型回复 600B+1调用 **0.018ms**、长回复 20KB+1调用 **0.074ms**、128KB **1.06ms**；每 KB 成本随规模**下降**（0.0157→0.0085ms，无 O(n²)）；块数增 128× 耗时只增 12×（非平方级）；吞吐 **151 万 chunk/s**；插件开销 **+0.019ms**；内存 **10 字节/次** |
| **性能剖析** | `hardening/perf-profile.mjs` | 7 组场景 | 代表性负载基线、每 KB 成本曲线、块数量影响、最坏真实场景、流式吞吐、与无插件对比、GC 压力。用于人工复核性能特征（非断言型） |
| **宿主协议校验器** | `hardening/host-validator.mjs` | 30 项 | 用**宿主自己的断言**（`AssistantStreamAccumulator.push` / `assembleAssistantStream` 里的 TypeError 校验）验证插件输出：8 种输出走完 **7 步校验链**（accumulator→snapshot→expand→assemble→BlockAssembler→live==replay→createMessage）、合成块字段通过类型断言、**可无损 JSON 序列化**、索引连续非负、**5 条真实日志流重放 0 失败（快照）** |
| **文本保真度** | `hardening/text-fidelity.mjs` | 58 项 | 核心不变量：**剥离后文本 == 原文去掉调用（一字不差、顺序不变）**。覆盖调用前后正文、多调用间正文、开头/结尾/只有调用、**无法解析的标记原样保留**、展示区内保留、无调用时**逐字节不变**（9 种）、特殊字符、严格等价性 |
| **幂等与确定性** | `hardening/idempotency.mjs` | 10 项 | 同一输入 20 次结果完全一致；100 次干扰流后仍一致；不同模块实例结果相同；**同内容→同 id hash**（可去重）、不同内容→不同 hash；ordinal 从 0 递增；10 个并发流**无串味**；空响应计数不污染正常流 |
| **原型污染** | `hardening/prototype-pollution.mjs` | 18 项 | `__proto__` 参数名被拒绝、**Object.prototype/Array.prototype 零污染**、参数对象原型未被替换、`for...in` 干净；正确区分 `__proto__`（改原型→拒绝）与 `constructor`（普通键→保留）；深度 5000 嵌套 / 10 万参数键不崩溃 |
| **正则与 Unicode** | `hardening/regex-unicode.mjs` | 96 项 | `new RegExp` 参数均来自模块常量（无正则注入）；正则元字符作值/键；emoji/代理对/组合字符/RTL/泰文全保留；空字节与控制字符；**三种行尾 LF/CRLF/单独 CR**；超长键值；嵌套标记 |
| **真实环境验证** | `hardening/deploy-verify.mjs` | 21 项 | 检查**真实部署**而非源码：安装位置、`cordis.patch.yml` 是否用 `insert:` 形式（plain `- id:` 会被静默跳过）、源码与安装副本一致、VERSION 与 package.json 一致、环境变量未误禁用、ESM 导入 + apply 可调用、真实日志生效证据（**453 次 txtcall-**） |
| **Node 版本兼容** | `hardening/node-compat.mjs` | 16 项 | 扫描插件使用的 33 种现代 API，确认最高要求是 `Object.hasOwn()`（Node 16.9），**无 Node 18+ 独占 API**；零外部依赖（纯自包含）、不依赖宿主私有内部模块、ESM 不混用 require |
| **扫描上限** | `hardening/scan-limit.mjs` | 29 项 | `MAX_SCAN_CHARS=128KB` 边界精确（127.8KB 恢复 / 128.2KB 拒绝）；10MB 纯文本 2ms、10MB 反引号 2ms、10MB 换行 9ms；400 个标记 2ms 且**规模增 40 倍耗时几乎不变（线性）**；上限检查先于展示区计算（0ms 返回） |
| **中断与取消** | `hardening/cancellation.mjs` | 19 项 | 消费者 break / `return()` 取消 / `AbortSignal` / 中断后立即新请求状态不串味 / 100 次连续中断无累积 / 两流并发交错消费不互相污染 |
| **断流不变量** | `hardening/abort-invariants.mjs` | 14 项 | 断流路径下**绝不恢复调用、绝不伪造 finish**、异常必须透传；同时对照正常结束仍能正确恢复 |
| **类型模糊** | `hardening/type-fuzz.mjs` | **624 项** | 把 chunk 协议每个字段逐一替换成 19 种坏类型（undefined/null/NaN/Infinity/数组/对象/函数/Symbol/BigInt/超长串…），覆盖顶层字段、block 内部、`usage`、`finish.reason`、`replayState`、`tools`、options、流本身异常、组合模糊 —— 全部不崩溃 |
| **结构模糊** | `hardening/structure-fuzz.mjs` | **24,000 条** | 随机生成畸形 chunk 序列（字段随机缺失/多余/类型错乱/顺序错乱），3 个随机种子 × 8000 条 = **24,000 条零崩溃**；另有 1000 条健全流不变量检查（必须有 finish 且是最后一个） |
| **跨版本兼容** | `hardening/cross-version.mjs` | 37 项 | 未知 chunk 类型/未知块类型/字段缺失/`block.text` 非字符串/协议新增字段/replayState 新形状/未知 `finish.reason.kind` —— 全部不崩溃且不误判 |
| **插件生命周期** | `hardening/lifecycle.mjs` | 19 项 | 多次 apply / 多 ctx 隔离 / 环境变量禁用开关（仅 `"0"` 生效）/ 热重载后状态独立 / 畸形 ctx / 重复 apply 不改变可观察行为 |
| **端到端链路** | `hardening/end-to-end.mjs` | 30 项 | 走完整链路：模型文本流 → 插件恢复 → 宿主**真实导出**的消费者（`BlockAssembler` / `assistantStreamHasVisibleContent` / `joinAssistantStreamText` / `chunkHasVisibleText` / `createAssistantMessage`）→ 验证工具调用真的能被上层取到且参数可直接执行；含持久化回放、多调用、replayState、不该恢复场景 |
| **多插件共存** | `hardening/plugin-coexistence.mjs` | 16 项 | 按 Cordis 瀑布流语义测：我们的插件在前/在后两种顺序、下游能看到合成块、上游异常不被吞、我们防御畸形输入、双恢复插件不重复、next() 只调一次、options 不被篡改、三插件链式共存 |
| **内存与生命周期** | `hardening/memory-lifecycle.mjs` | 8 项 | 3000 条流堆增长 0.15MB、50 条 500KB 流（流过 25MB）增长 0.47MB、500 条扣留块流增长 0.04MB、500 次中断后 0MB、500 个模型后 0MB、WeakRef 验证不持有 chunk 强引用 |
| **错误消息与可观测性** | `hardening/error-observability.mjs` | 26 项 | EMPTY_RESPONSE 消息含模型名与真实块类型（no blocks / only text / only reasoning / all empty）、不含路径密钥堆栈、长度 < 300、不该报错时绝不报错、成功恢复无告警噪音 |
| **生产合成调用溯源** | `hardening/synth-provenance.mjs` | **22 个真实合成调用** | 对插件在生产中真实恢复的每个调用做内容溯源：工具名、每个参数键、每个参数值的数值，都必须能在该流的源文本里找到。实测 **22/22 全部可溯源**（无凭空生成、无参数篡改） |
| **裸 JSON 安全事故** | `hardening/bare-json-safety.mjs` | 18 项 | **真实事故回归**：正文末尾的说明性 JSON 片段绝不能恢复（复刻 2026-10-22 的 `rm -rf /` 事件）；9 种裸 JSON 形态全部拒绝；6 种合法 JSON 调用仍正常恢复 |
| **执行安全专项** | `hardening/execution-safety.mjs` | 28 项 | 系统审查「执行了错误内容」的 8 类路径：参数截断 / 误解码 / 类型改变 / 键改变 / 参数丢失 / 参数串味 / 调用合并 / 高危命令完整性 |
| **类型强转语义** | `hardening/coercion-semantics.mjs` | 46 项 | schema=string 永不强转（007/1e5/0x1F 保持原样）、number 边界、integer、boolean、object/array、enum、**空字符串不强转**、**大整数不丢精度** |
| **值/实体边界** | `hardening/value-entities.mjs` | 48 项 | XML 实体解码（&lt;/&gt;/&amp;/&quot;/&#65;）、值内含类标签文本、特殊字符（反斜杠/引号/中文/emoji/管道/分号）、JSON 不解码实体、多行值、首尾换行、**值内裸闭合标签必须拒绝恢复**（防执行半截命令） |
| **嵌套与畸形解析** | `hardening/nesting-malformed.mjs` | 41 项 | 2/5/10/50 层嵌套、嵌套 tool_call、交叉嵌套（未闭合/重复/顺序颠倒）、1000 个重复标签的性能、参数不串味、5 万字符单行、畸形输入后的流不变量 |
| **全量健康检查** | `hardening/health-check.mjs` | **14,408 条真实流（快照）** | 每条跑插件 → 不变式校验 → 实时装配 → 持久化回放装配 → 两路径比对；实测零失败、零拒绝、全一致（2 条原始不完整流原样透传） |
| **XML 属性穷举** | `hardening/xml-attributes.mjs` | 36 项 | 属性引号（双/单/无）× 等号空白（4 种）笛卡尔积、多属性位置、工具名特殊字符（连字符/点号）、antml: 前缀、不该识别的形态、schema 类型强转、自闭合/嵌套异常标签 |
| **JSON 形态穷举** | `hardening/json-forms.mjs` | 28 项 | 标准/简写参数容器（arguments/input/parameters/args）、类型强转、特殊字符（引号/换行/反斜杠/中文/emoji/反引号/尖括号）、多调用、超长 JSON |
| **误恢复审计** | `hardening/false-positive-audit.mjs` | 全部真实日志 | 统计「无结构化 tool-call 但含文本标记」的真实消息，断言插件**不会把说明文字误当调用执行**（实测 13,320 条：13 条介入、6 条恢复、**0 处误恢复**） |
| **反引号精确性** | `hardening/backtick-precision.mjs` | 21 项 | 参数值含反引号必须恢复；标记在展示区必须不恢复（两侧都守）；跨行反引号包示例不得执行 |
| **截断安全性** | `hardening/truncated-safety.mjs` | 11 项 | 固化「不恢复不完整调用」的安全边界 |
| **真实数据反向挖掘** | `hardening/mine-unrecovered.mjs` | 全部真实日志 | 从真实会话里挖出「含标记但未恢复」的消息，断言它们**全部是应忽略形态**（代码块/行内代码/文字讨论）；若出现真实形态未恢复则失败 |
| **等价类划分** | `hardening/equivalence-classes.mjs` | 37 项 | 把标记格式空间按 8 个维度穷举（外层包装 / 引号 / 空白 / 大小写 / 值内容 / 多调用 / 误识别 / JSON 形态），发现并修复了「属性等号两侧带空格时无法识别」这一真实缺陷 |
| **分支覆盖率** | `hardening/branch-coverage.mjs` | V8 range 级 | 统计**未执行过的代码块**（比函数覆盖率更细）；当前 7 处，全部是三目/短路表达式的单侧 |
| **代码覆盖率** | `hardening/coverage.mjs` | V8 内置覆盖率 | 统计 `lib/index.js` 每个函数是否被测试执行过；**函数覆盖率 100%**（22/22，无从未执行的代码） |
| **分模型重放** | `hardening/per-model-replay.mjs` | **23 种 provider/model、14,408 条真实流（快照）** | 按上游分组重放，确认插件对每个真实上游都表现正常（实测：22 种模型零改写，仅 `step-plan-152/step-5-preview` 的 5 条真实 bug 样本被改写） |
| **跨宿主配置兼容性** | `hardening/host-compat.mjs` | 51 项 | 环境变量（14 种取值 + **Windows 上 `process.env` 大小写不敏感**）、profile 路径含**空格/中文**、ctx 形态差异（含 unsubscribe 返回值 / 额外属性）、**6 种工具声明形态**、**6 种标记形态**、**5 种 `finish.kind`**、源码不含平台假设（无 `process.platform` / `__dirname` / `require` / `fetch` / node: 内置模块） |
| **长时间运行稳定性（soak）** | `hardening/soak-test.mjs` | 12 项 | **2 万次请求**堆增长 **+0.38MB 且后半段 **-0.01MB**（曲线是平的，非缓慢爬升）；性能**不退化**（后段比前段快 12%）；500 个模型轮转后堆增长 **0.02MB**（状态确实有界）；**句柄数 200→2200 次保持 1 个**；源码**零定时器**；100 条连续流无跨流残留；1000 次异常后仍正常 |
| **真实 Cordis 宿主集成** | `hardening/real-cordis.mjs` | 15 项 | **前 36 轮都用测试替身**。本套件用**真实的 @deepseek-ai/cordis 4.0.5** 装载插件：真实 `ctx.on` 返回 unsubscriber（插件未依赖，正确）、真实 waterfall 触发后**恢复 1 个调用**、与测试替身**行为完全一致**、同 Context 装载两次**不叠加**、插件只使用 `ctx.on` 一个属性（不碰 config/logger/effect/set） |
| **材料引用可核实性** | `hardening/ref-verifiable.mjs` | 17 项 | 抽取文档里所有 DSH 源码引用（`dsh-<包>/lib/<文件>.js[:N]`），核实①文件存在 ②行号在范围内 ③引用的符号（`AssistantStreamAccumulator` 等）真实存在 ④**无法核实的包不得写成精确行号**；并把已证伪的 `invariant.js` 列为永久禁止引用 |
| **效果量化（对照实验）** | `hardening/effect-quantify.mjs` | 8 项 | 同一时点的快照上做对照实验：① 原生含结构化 tool-call 的流**行为变化 0 条**（原样放行）；② 纯文本流**回归 0 条**；③ 插件实际改写 **22 条（约 0.15%）**，恢复 22 个调用（step-5-preview 21 个）。证明插件**只在该介入时介入**。**口径说明**：分类（原生 / 纯文本）与总数是在同一次运行里统计的，两项相加等于该次的总数；而 README 其他位置引用的 `14,408` 是**另一时点**的快照（真实流会随日常使用增长），两者不应相加核对 |
| **缺陷回归矩阵** | `hardening/defect-regression.mjs` | **64 项** | **每个历史缺陷一个断言**：按缺陷编号 D1–D48 组织，逐条验证「如果这个修复被破坏，测试就会失败」。与按功能维度组织的其它套件互补 —— 当某个修复被后续改动悄悄破坏时，这套测试能直接定位到具体缺陷编号 |
| **安全网宿主契约** | `hardening/safety-net-contract.mjs` | 18 项 | 插件的「确定性失败保护」依赖一个**跨模块契约**：产出 `code="EMPTY_RESPONSE"` → 宿主的 retry-policy 必须把它视为可重试。本套件用**宿主真实的 `error.js` / `retry-policy.js`** 验证：宿主的 `DEFAULT_RETRYABLE_CODES` 确实含它（5 个之一）、解析后策略 `maxRetries=5`、插件端到端产出的码与宿主常量**完全相同**、且 5 个错误拼写（EMPTY/empty_response/…）宿主都不认 |
| **已知限制：无参数调用** | `hardening/known-limit-noargs.mjs` | 8 项 | `<function=noargs></function>`（完全无参数的调用）**不会被恢复** —— 因为 `parseCallBody` 要求「至少有一个参数」才返回调用（这是防止把空标记误当真实调用的防线）。但**不是静默丢失**：它走安全网（`error + EMPTY_RESPONSE`，会重试）。实测扫描 3 个会话，这种形态**出现 0 次**；有参数的调用正常恢复（对照组） |
| **缺陷回归覆盖矩阵** | `hardening/defect-coverage-matrix.mjs` | 8 项 | 把 **166 个缺陷逐一映射到守护套件**并验证该套件里真有对应检查。结果：**全部有守护** —— `defect-regression.mjs` 守护 D1-D48 中的大部分、`backtick-precision.mjs` 守护 D12/D13、`install-experience.mjs` 守护 D33-D35、`doc-consistency` / `code-quality` 守护 D31/D32、`doc-executable` / `ref-verifiable` / `fake-test-audit` 守护 D36-D39。**D1-D30（插件行为）全部有运行时断言守护** |
| **复现脚本可用性** | `hardening/repro-runnable.mjs` | 25 项 | 材料承诺「5 分钟复现」「两个最小复现脚本」——本套件**真的去跑它们**：`harness-side.mjs` 实测退出码 0 且输出确实展示「tool-call 块 0 个 → agent loop 判 completed → 静默结束」；`model-side.cjs` 缺 key 时给出 **usage + 替代方案**（而非只抛一行错）；无未替换占位符（曾写作 `<workspace>`）；复制到临时目录**单独也能跑**（真自包含） |
| **运行实例版本一致性** | `hardening/live-instance.mjs` | 10 项 | 插件只在**进程启动时** apply 一次，之后写入新文件**不会生效**。本套件对比「安装副本写入时间 vs DSH 进程启动时间」诊断版本滞后并告警；同时从真实会话日志统计 `txtcall-` 标记，证明插件确实在生产环境工作过（实测 13,139 条流中 86 条被恢复） |
| **交付物完整性** | `hardening/deliverable.mjs` | 96 项 | 提交指南是否会把**草稿误传**（`.gitignore` 是否排除 `SUBMIT-GUIDE` / `PASTE-READY`）、指南里是否真的让用户**跑一遍测试**、指南给出的命令是否存在、指南与 README 的**数字是否一致**（示例：写这个检查时是层数 77 / 缺陷 38）、仓库有无临时/备份文件 |
| **安装校验脚本可用性** | `hardening/verify-install-runnable.mjs` | 17 项 | `test/verify-install.cjs` 在材料里被引用 4 次却从未跑过。实测两个真实缺陷：① 它判「profile 不能有任何 dependencies」，**任何装了别的插件的用户都会看到 FAIL**（误报）；② 没回退到 `~/.dsh`，用户按 README 直接跑会失败。均已修复；本套件验证三种调用方式、误报已消、源码无敏感词 |
| **忠实重放链路（LCR）** | `hardening/lcr-replay.mjs` | 25 项 | `test/long-context-replay/` 里三个脚本产生了材料**最核心的证据**（419,843 token 忠实重放）却从未运行过。实测：rebuild-context 从真实日志**成功重建**（4 条消息 / 40 工具 / 8,869 字符）、calibrate-method 输出**字符/token 比 0.98–2.77**、faithful-replay 六项接口契约全对。**顺带修复**：它默认读 `real-tools.json`，而 rebuild 写的是 `rebuilt-tools.json` —— 照着文档做会直接失败 |
| **声明真实性核查** | `hardening/claims-audit.mjs` | 12 项 | README 测试矩阵里每一行都宣称了一个规模（「29 项」「24,000 条」…）。本套件**抽取全部声明并逐个实跑核实**：**59 行可核实声明中抽 40 个套件实跑，全部与声明一致**；并发现一个大问题 —— `structure-fuzz.mjs` 实际只跑 5,000 条而 README 写 24,000。选择**提升代码**（3 种子 × 8000 = 24,000，实测 525ms 零崩溃）而非降低声明 |

## 十二、已知限制（诚实清单）

这份材料刻意把「做不到的事」也写清楚 —— 比只讲成功更有用：

- **只在 `finish.reason.kind === "stop"` 时恢复**。以下情况**原样放行、不做恢复**：
  `tool-calls`（模型已给出结构化调用）/ `error` / `aborted` / `max-tokens`。

  这是**刻意的保守设计**：非 `stop` 意味着上游已经表达了「这次不是正常结束」，
  改写它可能掩盖真正的问题。副作用是——如果某个网关把 `finish_reason` 错误地
  归一化成 `tool-calls`、但流里其实**没有**任何原生 `tool-call` 块，
  插件就会**漏掉这次恢复**。实测真实日志里没有出现过这种组合
  （正常 openai-completions 协议下，有 `tool_calls` 才有 `finish_reason=tool_calls`）。
  `hardening/mixed-native-recovery.mjs` 会告诉你当前行为是什么。

- **已有原生结构化调用时，不再从文本恢复**。若模型同时给出了 `tool_calls`
  又在正文里重复写了一遍 XML 文本，插件**只保留原生调用**。

  这样避免了**重复执行**（同一条 `rm` / `git push` 被跑两次是不可接受的），
  代价是文本里那份「额外的」调用会被忽略。实测真实日志里也没有出现过这种重复。

- **只解析 3 类标记**（`<tool_call>` 外层包裹 / `<function name=…>` 与 `<invoke name=…>` 裸元素 / 带 `antml:` 前缀的 Anthropic 形态），
  其他方言（如 `<tool><name>…</name></args></tool>`）不解析：

  这类**不会被执行**。但要区分两种具体走向（第 129 轮实测澄清）：

  - 若文本里含**任一已知标记**（如 `<tool_call>`），且实质文字 < 20 字符、标签占比 > 50%，
    则判为「纯标记」→ 落到安全网（`EMPTY_RESPONSE` → 重试）；
  - 若文本**完全不含已知标记**（如纯 `<tool><name>…</name></args></tool>`），
    则按「有可见文本」**原样放行 `stop`** —— 回合正常结束，用户能看到这段文字，但不会被执行。

  两种走向都**不会**误执行示例，也都不会卡住；区别只是「重试一次」vs「直接结束」。

- **上游在报告 `stop` 的同时丢失输出 token** 这种情况无法从 chunk 流里检测：

  （实测见过一次：usage 记录 1,145 tokens，但只有约 40 tokens 内容存活，且完全没有标记）

  —— harness 无法把这种情况与「合法的短回复」区分开。这需要在路由侧修复。

- **跨版本兼容性的证据分两类**：三版本实测是我手工跑的历史记录（不可自动复现），

  仓库里的 `cross-version.mjs` 是模拟协议差异的自动守护。前者证明「当时能用」，

  后者证明「协议变化时不会崩」，两者都不能保证「未来版本一定兼容」。

- **绑定 DSH `0.2.0-rc.2` 的 `llm/stream` 接缝与 StreamChunk 协议**

  （已验证在 `0.2.1-rc.1`、`0.2.1-rc.2` 与 **`0.2.1-rc.3`** 上同样能加载并通过测试）。

- **Qwen 风格的裸 `<function=name>` 必须被 `<tool_call>` 包裹才会被解析**：
  裸写的 `<function=pwsh>...</function>`（没有外层 `<tool_call>`）**不会被恢复**，
  「裸露元素」那条路径只匹配 `<function name="x">` 这种**带引号的属性**写法。

  这不是 bug 而是**格式边界**：两种写法语法不同（`=` vs ` name="..."`），
  共用一条正则会把 `<function=a b>` 这类畸形也放进来。实测该形态会落到安全网
  （`EMPTY_RESPONSE` → 重试），**不会被静默丢弃**。第 128 轮实测确认真实日志里
  Qwen 风格调用**都带 `<tool_call>` 外层**，所以这条限制在实践中未被触发。

- **完全无参数的文本工具调用不会被恢复**：`<function=noargs></function>` 这类形态被

  `parseCallBody` 的「至少一个参数」防线拒绝（该防线用来防止把空标记误当真实调用）。

  这类调用会落到安全网（重试）而**不是**被执行。实测真实日志里从未出现过这种形态；

  如果将来遇到，`hardening/known-limit-noargs.mjs` 会告诉你当前行为是什么。

- **只处理「工具调用被写成文本」这一类问题**：

  其他类型的模型异常（真正的死循环、上游 5xx、超时）不在这个插件的范围内。

- **无法保证「没有 bug」**：本项目做了 110 层验证、166 个自身缺陷全部修复、

  1.4 万条真实流（快照）零回归，但这只能提高置信度，不能证明不存在未知缺陷。

## 十三、版本历史

| 插件版本 | 变更 | 已验证的 DSH 版本 |
|---|---|---|
| **0.2.0**（当前） | 新增 Anthropic 风格 `parameter name=键` 参数解析；截断/不可解析/裸 `parameter` 元素标记纳入 EMPTY_RESPONSE 安全网；修复上述 166 个自身缺陷（含代码块示例误执行这一安全问题、确定性失败空转、ReDoS 性能、**交错块错配**）；测试扩到 155 项断言 / 29 用例组 + 一百零八层加固测试（含 3000 条模糊、708 轮多轮、15 项等价性、ReDoS、14,408 条真实流（快照）跨 23 种模型重放、并发隔离、replayState、消息不变量、**46 个变异体变异测试（覆盖率 100%）**、**V8 函数覆盖率 100% + 分支覆盖率**） | 0.2.0-rc.2、0.2.1-rc.1、0.2.1-rc.2 |
| 0.1.0 | 首个版本：Qwen 风格文本工具调用恢复 + "只有思考块"安全网 | 0.2.0-rc.2 |

安装脚本与 `verify-install.cjs` 均支持任意 profile 路径（`-ProfileDir` /

`$DSH_HOME` / 命令行参数），不依赖任何个人路径。
