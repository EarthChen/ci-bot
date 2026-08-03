# Research: OpenAI Codex 体系作为 headless CI 自愈 bot 骨架的能力边界

> 本 brief 覆盖任务指定的输出路径。另有一份镜像写入 `research/r3-codex-sdk.md` 的要求——由于该路径在 base prompt 的输出路径之外，且权威路径为上方 `.pi-subagents` 路径，此处以权威路径为准。

## Summary

"Codex SDK" 并非单一产品，而是三个独立可组合的层次：**(A) Codex CLI / App Server**（codex-rs，终端 agent + JSON-RPC 服务）、**(B) OpenAI Agents SDK**（`openai-agents-python`，独立的多 agent 编排框架）、**(C) Responses API + function calling**（底层 API 契约）。三者模型绑定度、headless 形态、并发隔离机制、可复用专长表达方式差异极大，不可混为一谈。对 CI 自愈 bot 场景：Agents SDK 的 headless + 预算控制 + 并发能力最强但并发有已知 ContextVar bug；Codex CLI 的 `codex exec` 适合单任务 CI 但第三方模型支持因 `chat/completions` 弃用而严重收窄。

---

## 范围界定：三个独立层次

### A. Codex CLI / App Server / TypeScript SDK（codex-rs 体系）

- **[事实]** Codex CLI 是开源终端 agent（`openai/codex`，Apache-2.0，Rust 实现 `codex-rs/core`）。[Source](https://github.com/openai/codex)
- **[事实]** Codex **App Server** 是 JSON-RPC 2.0 over JSONL/stdio（本地）或 WebSocket（远程）的长驻进程，封装 `codex-rs/core` 的 agent loop，暴露 thread/turn/item 三层原语，支持双向通信（服务端可发起 approval 请求）。这是 OpenAI 推荐的"一等公民"集成方式。[Source](https://openai.com/index/unlocking-the-codex-harness/)
- **[事实]** `@openai/codex-sdk`（TypeScript SDK）封装 codex CLI 子进程，通过 stdin/stdout 交换 JSONL 事件。提供 `Codex.startThread()` → `thread.run()` / `thread.runStreamed()` 程序化 API，支持 `outputSchema`（结构化 JSON 输出）、`config` 覆盖、`env` 控制、`workingDirectory` 隔离。Node.js 18+。[Source](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- **[事实]** `codex exec` 是非交互 CLI 模式，跳过 TUI，适合 CI/CD 和脚本化流水线，输出结构化事件流。[Source](https://learn.chatgpt.com/docs/non-interactive-mode)（注：该域名 fetch 被本地网络阻断，依据搜索摘要）
- **[推论]** App Server 的 TypeScript SDK 目前"supports fewer languages and a smaller surface area"（官方原话），相比 App Server 协议本身覆盖面更小；未来可能增加更多语言 SDK 封装。[Source](https://openai.com/index/unlocking-the-codex-harness/)

### B. OpenAI Agents SDK（`openai-agents-python` / `openai-agents-js`）

- **[事实]** `openai-agents-python` 是独立的多 agent 编排框架（MIT，Python），前身是 Swarm 实验项目。核心抽象是 `Agent` + `Runner` + tools/handoffs/guardrails。[Source](https://openai.github.io/openai-agents-python/)
- **[事实]** Agents SDK **默认使用 Responses API**（`OpenAIResponsesModel`），但也保留 `OpenAIChatCompletionsModel` 适配器。它**不绑定** codex CLI——是平行的产品线。[Source](https://openai.github.io/openai-agents-python/models/)
- **[事实]** Agents SDK 与 Codex 可组合：Codex 可作为 MCP server（`codex mcp-server`）被 Agents SDK 调用，或用 App Server 协议编排。[Source](https://openai.com/index/unlocking-the-codex-harness/)

### C. Responses API + function calling

- **[事实]** Responses API 是 OpenAI 推出的替代 `chat/completions` 的 API，专为 reasoning 模型、多轮对话、tool-rich 工作流设计。Codex CLI 已全面迁移到此 API。[Source](https://github.com/openai/codex/discussions/7782)
- **[事实]** Agents SDK 原生支持 Responses API 的高级功能：`ToolSearchTool`、`tool_namespace()`、deferred-loading tools、`ProgrammaticToolCallingTool`、`context_management`（compaction）、`prompt_cache_options`、websocket transport 等。这些功能在 Chat Completions 模式和非 Responses 后端上被拒绝。[Source](https://openai.github.io/openai-agents-python/models/)

---

## 维度 1：第三方模型支持

### Codex CLI / App Server

- **[事实]** Codex CLI 通过 `config.toml` 的 `[model_providers.<id>]` 块定义自定义 provider，字段含 `name`、`base_url`、`wire_api`、`env_key`、`http_headers`、`env_http_headers`。内置保留 ID：`openai`、`ollama`、`lmstudio`，其余为自定义。`--provider` 标志或 `model_provider` 配置项选择 provider。[Source](https://www.morphllm.com/codex-provider-configuration)（注：官方 `developers.openai.com/codex/config-reference` fetch 被阻断，此为二级源）
- **[事实｜关键风险]** Codex CLI **正在弃用 `wire_api = "chat"`（chat/completions）**，2026 年 2 月起硬错误。未来**仅支持 `wire_api = "responses"`**。这意味着：任何不实现 Responses API 端点的第三方 provider 将**无法被 Codex CLI 使用**。[Source](https://github.com/openai/codex/discussions/7782)
- **[事实]** 弃用后本地模型路径：LM Studio 支持 `responses` API（`oss_provider = "lmstudio"`）；Ollama 计划支持但尚未实现。DeepSeek/OpenRouter 等 OpenAI 兼容网关若仅暴露 chat/completions，需通过自建 API Bridge 将 `/v1/responses` 映射到上游 chat/completions。[Source](https://github.com/openai/codex/discussions/7782)
- **[推论]** 对 CI 自愈 bot 的直接影响：若要接 DeepSeek/Qwen/Kimi 等国产/开源模型（多数仅支持 chat/completions），Codex CLI 在 2026.02 后将**不可用**，除非自建 responses-bridge 代理。这是 Codex CLI 路径的最大限制。

### OpenAI Agents SDK

- **[事实]** Agents SDK 支持**非 OpenAI 模型**，通过三种内置路径：
  1. `set_default_openai_client(AsyncOpenAI(base_url=..., api_key=...))` — 全局默认 OpenAI 兼容端点
  2. `ModelProvider` — per-run 自定义 provider
  3. `Agent.model` — per-agent 具体 `Model` 对象（可混合不同 provider）[Source](https://openai.github.io/openai-agents-python/models/)
- **[事实]** Agents SDK **仍然支持 chat completions** 适配器（`OpenAIChatCompletionsModel`、`set_default_openai_api("chat_completions")`），与 Codex CLI 的弃用方向**不同步**。对 DeepSeek/Qwen/vLLM/Ollama 等仅支持 chat/completions 的 provider，Agents SDK 可直接用 `OpenAIChatCompletionsModel` 接入。[Source](https://openai.github.io/openai-agents-python/models/)
- **[事实]** `MultiProvider` 支持基于前缀的模型路由（如 `openai/gpt-4.1` vs `any-llm/...`），可在一个工作流中混合多个 provider。`openai_prefix_mode="model_id"` 允许透传字面命名空间 ID。[Source](https://openai.github.io/openai-agents-python/models/)
- **[事实]** 第三方适配器（beta）：`openai-agents[litellm]`（LiteLLM 路由）和 `openai-agents[any-llm]`（Any-LLM 路由），best-effort，provider 能力差异由上游定义。[Source](https://openai.github.io/openai-agents-python/models/)
- **[事实]** Anthropic/Bedrock/Vertex **无原生支持**，需通过 LiteLLM/Any-LLM 适配器或自建 `Model` 接口实现。
- **[事实]** 非 OpenAI provider 的 tracing 会上传到 OpenAI 服务器导致 401——需 `set_tracing_disabled(True)` 或 `set_tracing_export_api_key()`。[Source](https://openai.github.io/openai-agents-python/models/)

### 对比小结（维度 1）

| 能力 | Codex CLI/App Server | OpenAI Agents SDK |
|---|---|---|
| OpenAI 兼容 API（chat/completions） | ❌ 2026.02 弃用 | ✅ 原生支持 |
| OpenAI 兼容 API（responses） | ✅ 唯一支持 | ✅ 默认路径 |
| 本地 vLLM/Ollama | ⚠️ Ollama 未支持 responses | ✅ via chat completions |
| LM Studio | ✅ responses 支持 | ✅ |
| DeepSeek/Qwen/Kimi | ⚠️ 需自建 bridge | ✅ via chat completions |
| Anthropic/Bedrock/Vertex | ❌ 无原生 | ❌ 无原生（需适配器） |
| per-agent/per-run provider | ❌ 全局 config.toml | ✅ 三层粒度 |

---

## 维度 2：Headless 运行形态

### Codex CLI / App Server

- **[事实]** `codex exec` 是非交互模式：单命令运行至完成，流式输出结构化日志，以明确的成功/失败信号退出。适合 CI/CD pipeline。[Source](https://openai.com/index/unlocking-the-codex-harness/)（官方描述"lightweight, scriptable CLI mode for one-off tasks and CI runs"）
- **[事实]** `--approval-mode` 控制自主执行级别：`suggest`（默认，写操作需审批）、`auto-edit`（自动写文件）、`full-auto`（全自动，适合 headless）。headless 场景需 `--full-auto`。[Source](https://medium.com/data-science-in-your-pocket/openai-codex-cli-coding-agent-for-terminal-74a7f0b45abe)
- **[事实]** TypeScript SDK 提供程序化 API：`thread.run()` 阻塞至 turn 完成；`thread.runStreamed()` 返回 async generator 逐事件流式；`outputSchema` 强制结构化 JSON 输出；`config` 覆盖可程序化注入 TOML 配置。可 `resumeThread()` 恢复持久化会话。[Source](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- **[事实]** App Server 协议**支持服务端发起 approval 请求**（server-to-client request），agent 需要执行操作时暂停 turn 等待客户端回复 allow/deny。headless 下需客户端自动回复，否则 agent 挂起。[Source](https://openai.com/index/unlocking-the-codex-harness/)
- **[未知]** Codex CLI 的 token/turn/工具调用预算硬上限机制：搜索到 `max_turns`/`max_tokens` 配置的提及但未找到官方文档明确确认 Codex CLI 层级的硬上限配置字段。Codex 的 context window 管理（GPT-5.5: 400K in Codex, 1M in API；GPT-5.6 variants: 272K）是模型层面的，非 agent loop 预算。[Source](https://blakecrosley.com/guides/codex)（二级源，非官方）
- **[推论]** App Server 的 thread/turn 原语使程序化驱动 loop 可行：客户端可创建 thread → 提交 turn → 接收 item/started→delta→completed 事件 → turn/completed 结束 → 循环提交下一 turn。这是确定性的程序化循环，非交互 REPL。

### OpenAI Agents SDK

- **[事实]** `Runner.run()`（async）、`Runner.run_sync()`（sync 包装）、`Runner.run_streamed()`（流式）三种运行模式。agent loop 自动循环 model↔tool 调用直到完成或超限。[Source](https://openai.github.io/openai-agents-python/running_agents/)
- **[事实]** `max_turns` 是**硬上限**：超过则抛 `MaxTurnsExceeded` 异常。默认 `DEFAULT_MAX_TURNS`（具体值未在文档显式标注，issue #551 提及存在默认值）。可 per-run 通过 `RunConfig` 或 per-agent 设置。[Source](https://openai.github.io/openai-agents-python/ref/result/)
- **[事实]** **Guardrails** 提供工具执行前后的校验/阻断：input guardrails（昂贵模型运行前快速验证）、output guardrails（输出后验证）、tool guardrails（function tool 调用前后验证）。阻断即抛 `GuardrailTripwireTriggered`。[Source](https://openai.github.io/openai-agents-python/guardrails/)
- **[事实]** **Runner-managed retries**（opt-in）：`ModelRetrySettings(max_retries, backoff, policy)`。策略可组合：`provider_suggested()`、`network_error()`、`http_status([...])`、`retry_after()`、`any(...)` / `all(...)`。安全边界：abort 错误、provider 标记不可重放的、已开始输出的流式请求**永不自动重试**。[Source](https://openai.github.io/openai-agents-python/models/)
- **[事实]** Headless 下无人在环确定性触发：`Runner.run()` 是纯函数式调用，无 UI、无审批中断。`needs_approval` 在 hosted multi-agent 模式下非 `False` 的 tool 会被**拒绝发送**（因为 SDK approval interruption 不支持 hosted 模式）。普通模式下 `needs_approval` 可设为 `False` 实现全自动。[Source](https://openai.github.io/openai-agents-python/models/)
- **[事实]** 结构化输出：通过 `output_type`（Pydantic 模型）或 Responses API 的 `response_format` 强制 JSON schema。[Source](https://openai.github.io/openai-agents-python/)

### 对比小结（维度 2）

| 能力 | Codex CLI/App Server | OpenAI Agents SDK |
|---|---|---|
| 非交互程序化驱动 | ✅ exec / App Server / TS SDK | ✅ Runner.run/run_sync/run_streamed |
| max_turns 硬上限 | ⚠️ 未明确文档化 | ✅ MaxTurnsExceeded |
| token 预算 | ⚠️ 模型层 context window | ⚠️ 模型层 + `truncation="auto"` |
| 工具调用预算 | ⚠️ 未明确 | ⚠️ `max_tool_calls`（hosted 模式拒绝） |
| guardrails（前后校验） | ❌ 无原生 | ✅ input/output/tool guardrails |
| 重试策略 | ⚠️ 未明确 | ✅ 可组合 retry policy |
| headless approval 处理 | ⚠️ 需客户端自动回复 | ✅ `needs_approval=False` |
| 结构化输出 | ✅ outputSchema | ✅ output_type / response_format |

---

## 维度 3：多并发隔离

### Codex CLI / App Server

- **[事实]** TypeScript SDK 每个 `Codex()` 实例 spawn 独立 CLI 子进程，**进程级隔离**是默认形态。每个 `Thread` 可指定 `workingDirectory`（必须是 git repo，或 `skipGitRepoCheck`）。[Source](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- **[事实]** App Server 的 thread manager 为每个 thread 启动一个 core session。一个 App Server 进程可托管多个 thread（多个 agent 实例）。[Source](https://openai.com/index/unlocking-the-codex-harness/)
- **[事实]** Thread 会话持久化在 `~/.codex/sessions`。`resumeThread()` 可恢复。[Source](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- **[推论｜风险]** 共享 `CODEX_HOME`（`~/.codex/`）是多 worker 并发的潜在争用点：sessions、skills、config 全局共享。多项目并发时需 per-worker `CODEX_HOME` 隔离（通过 `env` 参数覆盖），否则配置和会话文件会交叉污染。
- **[未知]** App Server 单进程多 thread 是否有共享状态陷阱（如全局 config 加载顺序、auth 状态泄漏）——文档未明确。推论：每个 core session 有独立 thread 状态，但 config/auth 由 App Server 进程层加载，可能共享。
- **[未知]** per-agent 工具白名单/预算独立配置：Codex 的 tool 权限通过 `config.toml` 全局或 per-profile 配置，未见 per-thread/per-turn 工具白名单 API。

### OpenAI Agents SDK

- **[事实]** 并发模式：`asyncio.gather(*[Runner.run(agent, input) for ...])` 并发运行多个 agent。官方 cookbook 有 parallel agents 示例。[Source](https://developers.openai.com/cookbook/examples/agents_sdk/parallel_agents)
- **[事实｜关键 bug]** **Issue #2246**：并发 `Runner.run()` 调用（`asyncio.gather`）触发 `ValueError: ContextVar token "was created in a different Context"`，根因是 tracing 的 `current_trace` ContextVar 在并发 task 间 token 管理冲突。**workaround**：`RunConfig(tracing_disabled=True)`，但丢失 tracing。版本 0.6.x，截至 issue 创建时未修复。[Source](https://github.com/openai/openai-agents-python/issues/2246)
- **[事实]** PR #3843 "isolate provider instances across concurrent runs" 已合并（2026-07），修复 computer tool 的 provider 实例跨并发隔离问题。说明并发隔离是活跃维护领域。[Source](https://github.com/openai/openai-agents-python/pull/3843)
- **[事实]** per-agent 配置隔离：每个 `Agent` 实例有独立的 `model`、`instructions`、`tools`、`model_settings`、`handoffs`、`output_type`、`guardrails`。per-run 通过 `RunConfig` 可设独立 `model_provider`、`tracing`、`max_turns` 等。[Source](https://openai.github.io/openai-agents-python/models/)
- **[推论]** 多 worker 隔离策略：每个项目创建独立 `Agent` 实例（独立 tools/model/budget）+ 独立 `RunConfig`（独立 provider/max_turns）+ `tracing_disabled=True`（规避 ContextVar bug）或 `copy_context()` per-task。这可实现同进程内并发隔离，但需绕过 tracing bug。

### 对比小结（维度 3）

| 能力 | Codex CLI/App Server | OpenAI Agents SDK |
|---|---|---|
| 多 agent 并发 | ✅ 进程级（多 CLI 子进程） | ✅ asyncio.gather（同进程） |
| 进程级隔离 | ✅ 默认 | ⚠️ 需自建多进程 |
| 同进程并发 | ⚠️ App Server 多 thread | ✅ 但有 ContextVar bug |
| per-agent 工具白名单 | ⚠️ 全局 config | ✅ Agent.tools |
| per-agent 预算 | ⚠️ 未明确 | ✅ RunConfig + ModelSettings |
| 共享状态陷阱 | ⚠️ CODEX_HOME 争用 | ⚠️ tracing ContextVar |
| 已知并发 bug | ⚠️ 未明确 | ✅ #2246 已知，workaround 存在 |

---

## 维度 4：可复用领域专长（Skills）

### Codex CLI

- **[事实]** Codex 支持 **Skills** 机制（目前 feature-flagged：`codex --enable skills`）。Skill = 目录含 `SKILL.md`（YAML frontmatter: name + description，后跟自然语言指令）。可选子目录：`scripts/`（确定性脚本）、`references/`（长上下文）、`assets/`、`templates/`。[Source](https://blog.fsck.com/2025/12/19/codex-skills/)（社区实测）
- **[事实]** Skill 发现位置：全局 `~/.codex/skills/`（含系统 skill `.system/`：plan、skill-creator）；项目级 `.agents/skills/` 提交到 repo 即团队共享。内置 "Discovery" meta-skill 列举可用 skill。[Source](https://blog.fsck.com/2025/12/19/codex-skills/)
- **[事实]** Skill 触发机制（**非确定性**）：(a) 用户显式命名 `$SkillName` 或纯文本提及；(b) 任务描述匹配 skill 的 YAML `description`（模型判断）。触发后渐进式披露：读 `SKILL.md` → 按需加载 `references/` → 优先运行 `scripts/` 而非重写代码 → 复用 `assets/templates`。[Source](https://blog.fsck.com/2025/12/19/codex-skills/)
- **[事实]** **AGENTS.md** 是项目级指令文件（类似 Claude 的 CLAUDE.md），自动加载，确定性生效。用于编码规范、架构决策、部署规则。Skills 补充 AGENTS.md，不替代。[Source](https://blakecrosley.com/guides/codex)
- **[推论｜headless 确定性]** Headless 下 Skill 的确定性调用路径：在 prompt 中显式 `$SkillName` 命名（trigger rule: "If the user names a skill...you must use that skill for that turn"）。但这依赖模型遵守指令，**非编译期确定性**。`scripts/` 子目录的脚本执行是确定性的（代码级），但 skill 是否被激活仍依赖模型判断。

### OpenAI Agents SDK

- **[事实]** Agents SDK **无原生 "skill" 概念**。可复用专长通过以下机制表达：
  1. **`Agent(instructions=...)`** — prompt 模板，per-agent 独立指令
  2. **`agent.as_tool()`** — 将 agent 包装为 function tool，可被其他 agent 确定性调用（`tool_name`/`tool_description`）
  3. **`@function_tool`** — 自定义工具函数，确定性调用
  4. **Handoffs** — agent 间委托转移[Source](https://openai.github.io/openai-agents-python/)
- **[事实]** 确定性调用：`as_tool()` 和 `@function_tool` 在代码层确定性注册和调用。`asyncio.gather` + `as_tool()` 是确定性 fan-out 路径（非模型动态规划）。[Source](https://developers.openai.com/cookbook/examples/agents_sdk/parallel_agents)
- **[事实]** **无渐进式披露 / 文件系统 skill 加载机制**——没有读取 `SKILL.md` → 按需加载 `references/` 的原生抽象。需自建。
- **[未知]** Agents SDK 是否有社区 skill-loading 扩展：搜索未发现官方或主流社区方案。

### 迁移代价评估：pi skills → Codex/Agents SDK

用户在 pi 下积累的 `java-coding-standards` / `springboot-tdd` 等 skill：

| 迁移目标 | 格式转换 | 触发机制确定性 | 渐进式披露保留 | 重写量 | 评估 |
|---|---|---|---|---|---|
| **Codex Skills** | pi skill → `SKILL.md`（YAML frontmatter + markdown body，结构相近） | ⚠️ 依赖模型匹配 description；headless 需 `$SkillName` 显式命名 | ✅ `references/`/`scripts/` 子目录原生支持 | 中 | **中度重写**：格式转换 + description 调优；触发确定性需 prompt 工程 |
| **Agents SDK** | pi skill → `Agent(instructions=...)` 或 `@function_tool` | ✅ 代码层确定性（`as_tool()`/直接调用） | ❌ 无原生，需自建文件加载器 | 中-高 | **中高度重写**：拆解为 Agent/tool；渐进式披露逻辑需自建 |
| **Codex AGENTS.md** | pi skill → AGENTS.md 指令段落 | ✅ 自动加载确定性 | ❌ 无（单一文件） | 低 | **低度重写**但**功能降级**：丢失 skill 边界、渐进披露 |

**[推论]** 最务实路径：若选 Codex CLI 作骨架，将 pi skills 转 `SKILL.md` 格式（结构兼容性高），headless 下在 prompt 中显式 `$java-coding-standards` 命名以确保激活；若选 Agents SDK，将 skills 重构为 `Agent` + `@function_tool` 组合，牺牲渐进披露但获确定性。`scripts/` 目录的确定性脚本（如 TDD 骨架生成器）在两者中均可直接复用。

---

## 横向对比小结（一行）

> Codex CLI：第三方模型支持因 responses-only 收窄、headless 有 exec/App Server 但预算控制弱、并发靠进程隔离但 CODEX_HOME 有争用、Skills 格式兼容 pi 但触发非确定；Agents SDK：模型支持最广（含 chat/completions）、headless+guardrails+retry+max_turns 最完善、并发有 ContextVar bug 但可 workaround、无原生 skill 故迁移代价中高。

---

## Sources

### Kept（核心证据源）

- **openai/codex GitHub** (https://github.com/openai/codex) — 仓库本体，SDK README、App Server 源码路径权威源
- **Codex SDK TypeScript README** (https://github.com/openai/codex/blob/main/sdk/typescript/README.md) — 程序化 API 接口契约（Thread/run/runStreamed/outputSchema/config）
- **Unlocking the Codex harness: App Server** (https://openai.com/index/unlocking-the-codex-harness/) — App Server 架构、JSON-RPC 协议、thread/turn/item 原语、集成模式对比
- **Deprecating chat/completions in Codex #7782** (https://github.com/openai/codex/discussions/7782) — 第三方模型支持收窄的关键事实源
- **OpenAI Agents SDK models 文档** (https://openai.github.io/openai-agents-python/models/) — 非 OpenAI provider 集成路径、Chat Completions 适配、retry policy、guardrails、Responses-only 功能
- **Issue #2246: ContextVar concurrent bug** (https://github.com/openai/openai-agents-python/issues/2246) — 并发隔离的已知 bug + workaround
- **Parallel Agents cookbook** (https://developers.openai.com/cookbook/examples/agents_sdk/parallel_agents) — 官方并发模式 + agents-as-tools 确定性 vs 动态规划对比
- **Skills in OpenAI Codex (blog.fsck.com)** (https://blog.fsck.com/2025/12/19/codex-skills/) — Skill 机制实测、触发规则、渐进披露、文件布局
- **Codex CLI Guide 2026 (blakecrosley.com)** (https://blakecrosley.com/guides/codex) — AGENTS.md、sandbox、context window、skills 生态综合（二级源）

### Dropped（排除源）

- **DeployHQ / Medium / callsphere.ai 博客** — SEO-heavy 二级教程，无增量信息
- **Reddit r/GithubCopilot Codex wrapper** — 与本任务无关（Codex→OpenAI endpoint 反向封装）
- **Stanford AI API Gateway 指南** — 特定网关配置，非通用能力边界

---

## Gaps

1. **Codex CLI 的 agent loop 预算硬上限**：`max_turns`/`max_tokens`/`max_tool_calls` 在 Codex CLI 层级是否有配置字段——官方 `developers.openai.com/codex/config-reference` 被 fetch 阻断，仅从二级源（blakecrosley、morphllm）推断模型层 context window 存在但 agent loop 预算未明确。**需实测 `config.toml` 全字段或读 codex-rs 源码确认。**
2. **App Server 单进程多 thread 的共享状态边界**：config/auth 是否进程级共享导致跨 thread 泄漏——文档描述"thread manager spins up one core session per thread"但未说明 config 加载粒度。**需读 `codex-rs/app-server` 源码。**
3. **Codex Skills 的 feature flag 状态**：社区源（2025.12）称 skill 仍 feature-gated（`codex --enable skills`），当前（研究时点）是否已 GA 未知。**需查最新 codex 版本。**
4. **Agents SDK ContextVar bug #2246 修复状态**：issue 创建于 2025-12，PR #3843（2026-07）修复了 computer tool 的 provider 隔离，但是否同时修复 tracing ContextVar 未明确。**需跟踪 issue 状态。**
5. **官方 Codex 文档（developers.openai.com/codex/*）全程被本地网络阻断**：config-reference、config-advanced、sdk、subagents、skills 页面均无法直接 fetch，相关结论依赖二级源（morphllm/ofox/blakecrosley/blog.fsck）+ 搜索摘要。**建议在可访问官方域名的环境复验。**

### 建议下一步

- 在可访问 `developers.openai.com/codex` 的环境，拉取 config-reference + config-advanced + sdk + subagents + skills 官方页，补全维度 2 预算机制和维度 4 skill GA 状态的 [事实] 标注。
- 读 `codex-rs/core` 源码中的 agent loop 实现确认 turn/tool 预算字段。
- 读 `codex-rs/app-server` 源码确认多 thread config/auth 共享边界。
- 实测 `asyncio.gather` + `RunConfig(tracing_disabled=True)` 的并发稳定性，验证 #2246 workaround 在 CI bot 负载下的可靠性。