# Research: pi 作为 Headless CI 自愈 Bot 骨架的可行性

> 对象：`@earendil-works/pi-coding-agent` v0.83.0（当前 harness）
> 场景：GitLab CI 单测失败自愈 bot，headless、无人值守、多项目并发
> 四维度对齐候选：Claude Agents SDK / Codex SDK / pi 本身（本 brief 只覆盖 pi）

## Summary

pi 在四维度中表现极不均衡：第三方模型支持（维度1）和可复用领域专长（维度4）是其最强项，近乎完美契合 CI bot 需求；headless 运行形态（维度2）有三种非交互入口（`-p`/`--mode json`/`--mode rpc`/SDK）且文档明确支持，但**缺乏原生的 turn/token 硬上限**，必须自行实现预算控制；多并发隔离（维度3）可通过多进程 + 独立 `PI_CODING_AGENT_DIR`/`--session-dir` 实现，但 pi 无内置 subagent 并发机制，需自行编排。综合来看，pi 这条路的迁移代价确实最低，但"最低"不等于"零"——需补齐预算控制和并发编排两块自建代码。

---

## 维度 1：第三方模型支持

### 1.1 内置 Provider 覆盖

**[事实]** pi 内置支持以下 provider（README "Providers & Models" 节）：
- **Anthropic**（Claude 全系）
- **OpenAI** / **Azure OpenAI**
- **DeepSeek**（原生 API key 支持）
- **Google Gemini** / **Google Vertex**
- **Amazon Bedrock**
- **Kimi For Coding**
- **OpenRouter**（可路由到 Qwen/DeepSeek 等）
- **xAI**、**Mistral**、**Groq**、**Cerebras**、**Together AI**、**Fireworks**、**MiniMax**、**小米 MiMo** 等 30+ provider

这直接覆盖了用户要求的 DeepSeek/Kimi/Qwen/Anthropic/Bedrock/Vertex 全部候选。

### 1.2 本地模型（vLLM/Ollama）

**[事实]** `docs/models.md` 明确给出 Ollama/vLLM/LM Studio 的配置方式：
```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [{ "id": "llama3.1:8b" }]
    }
  }
}
```
vLLM 等任何 OpenAI 兼容端点同理，用 `openai-completions` API 类型即可。`compat` 字段处理 `developer` role、`reasoning_effort`、`max_tokens` 字段名等兼容性差异。

### 1.3 配置机制

**[事实]** 三层配置叠加：
1. `~/.pi/agent/models.json`：声明式 JSON 配置，支持 env 插值（`$ENV_VAR`）、shell 命令（`!command`）、字面量
2. Extension 动态注册：`pi.registerProvider()` / `pi.registerProvider(name, config)`，可在 async factory 中 fetch 远程 model 列表
3. `--provider`/`--model`/`--api-key` CLI flag 覆盖

**[事实]** API key 解析优先级（`docs/sdk.md` "API Keys and OAuth"）：
1. Runtime override（`modelRuntime.setRuntimeApiKey()`，不持久化）
2. `auth.json` 存储
3. 环境变量（`ANTHROPIC_API_KEY` 等）
4. Fallback resolver（自定义 provider key）

**[事实]** `InMemoryCredentialStore` 可注入，用于完全无磁盘 I/O 的凭据管理——对 CI bot 的 secret 注入非常契合。

### 1.4 限制

**[事实]** pi 官方文档明确声明 "No MCP"（README Philosophy 节），但可通过 extension 自建 MCP 集成。社区已有 `pi-mcp-bridge`、`pi-mcp-adapter`、`pi-mcp-extension` 等第三方包。若用户的 skill 体系依赖 MCP server，需评估这些桥接方案。

---

## 维度 2：Headless 运行形态

### 2.1 非交互入口（确认存在）

**[事实]** pi 有四种运行模式（README "Modes" 节）：

| 模式 | 入口 | 适用场景 |
|------|------|---------|
| Interactive | `pi` (default) | TUI，不适用 |
| Print | `pi -p` / `--print` | 单次 prompt → 输出 → 退出 |
| JSON | `pi --mode json` | 全事件流为 JSON lines |
| RPC | `pi --mode rpc` | stdin/stdout JSONL 协议，长驻进程 |
| SDK | `createAgentSession()` | 嵌入 Node.js 应用 |

**[事实]** Print 模式行为（`src/modes/print-mode.ts`）：
- 接受 `initialMessage` + `messages` 数组
- 处理完所有 prompt 后自动退出（`finally` 块 dispose runtime）
- text 模式：取最后一条 assistant 消息，遇 `stopReason === "error"/"aborted"` 设 `exitCode = 1`
- json 模式：流式输出事件
- 支持管道 stdin：`cat README.md | pi -p "Summarize"`

**[事实]** RPC 模式是**长驻 headless 进程**，适合 webhook 拉起后保持运行、接收多条 prompt。协议为 strict LF-delimited JSONL，有 `prompt`/`steer`/`follow_up`/`abort`/`new_session`/`set_model`/`compact` 等命令，以及 `agent_start`/`agent_end`/`agent_settled`/`turn_end` 等事件。

**[事实]** SDK 模式提供 `runPrintMode(runtime, options)` 和 `runRpcMode(runtime)` 工厂函数，可直接在 Node.js 中调用，无需 spawn 子进程。`SessionManager.inMemory()` 提供无磁盘持久化的 session 管理。

### 2.2 Webhook 拉起 → 跑修复 loop → 退出

**[推论]** 基于 print 模式的"处理完即退出"语义，CI bot 可用以下形态：
1. Webhook 触发 → 启动 `pi -p "修复失败的测试：<测试日志>"` 子进程
2. pi 跑完修复 loop（模型自主调用 bash/edit/test 工具）
3. 进程退出，CI 检查 exit code + diff

**[事实]** 社区已有 `pi-review-loop` 扩展，实现了"反复 review 直到无 issue"的循环模式，证实 loop 模式在 pi 中可行（虽然该扩展主要面向交互式）。

### 2.3 Token/Turn/工具预算硬上限 ⚠️ 关键缺口

**[事实]** pi **没有原生的 `--max-turns` 或 `--max-tokens` flag**。GitHub issue #1898 请求添加这些 flag，但截至 v0.83.0 仍未实现。issue 描述："目前唯一的选择是对子进程设 wall-clock timeout，这是更粗糙的工具。"

**[事实]** print-mode.ts 源码不含 turn 计数或 token 预算逻辑。

**[事实]** `thinkingBudgets` 设置（`docs/settings.md`）可配置 per-level thinking token 预算：
```json
{ "thinkingBudgets": { "minimal": 1024, "low": 4096, "medium": 10240, "high": 32768 } }
```
但这只控制 thinking token，不控制总 turn 数或总 token。

**[事实]** 存在硬编码的 32K per-turn output cap（discussion #1606）：`buildBaseOptions` 中 `maxTokens = Math.min(model.maxTokens, 32000)`。对复杂推理任务可能导致 turn 内输出截断。

**[事实]** `retry` 设置可控制 transient error 重试：`retry.maxRetries`（默认 3）、`retry.baseDelayMs`（默认 2000）、`retry.provider.timeoutMs`、`retry.provider.maxRetryDelayMs`（默认 60000）。

**[推论]** SDK 层面可实现**自建预算控制**：
```typescript
let turnCount = 0;
const MAX_TURNS = 20;
session.subscribe((event) => {
  if (event.type === "turn_end") {
    turnCount++;
    if (turnCount >= MAX_TURNS) session.abort();
  }
});
```
`session.abort()` 是文档化的 API（`AgentSession.abort(): Promise<void>`）。结合 `agent_settled` 事件可确认完全停止。这是目前唯一可行的 turn 限制方案。

**[推论]** Token 预算可通过 `get_session_stats`（RPC）或 `ctx.getContextUsage()`（extension）监控，超阈值时调 `abort()`。但需自行实现，非开箱即用。

### 2.4 Project Trust 在 headless 下的处理

**[事实]** 非交互模式（`-p`/`--mode json`/`--mode rpc`）**不显示 trust prompt**（`docs/settings.md` "Project Trust"）。行为由 `defaultProjectTrust` 控制：
- `"ask"`（默认）：忽略需 trust 的资源
- `"always"`：信任
- `"never"`：忽略

**[事实]** `--approve`/`-a` 或 `--no-approve`/`-na` 可单次覆盖。CI 中应设 `defaultProjectTrust: "always"` 或用 `--approve`。

---

## 维度 3：多并发隔离

### 3.1 pi 无内置 subagent/并发机制

**[事实]** README Philosophy 明确声明 "No sub-agents"——pi 不内置 subagent，需通过 extension 自建或 spawn 多个 pi 实例。社区有 `pi-fast-subagent`、`pi-subagents` 等第三方包提供 in-process subagent 委派，但这些非官方。

### 3.2 多进程方案（推荐）

**[推论]** 每个项目一个 pi 子进程是最干净的隔离方式：
- 每个 worker 独立 `PI_CODING_AGENT_DIR` 环境变量指向独立 config 目录
- 每个 worker 独立 `--session-dir` 或 `PI_CODING_AGENT_SESSION_DIR`
- 每个 worker 独立 cwd（项目 checkout 目录）
- 进程级隔离天然提供 context/skill/预算独立性

**[事实]** `PI_CODING_AGENT_DIR` 覆盖 config 目录（默认 `~/.pi/agent`），`PI_CODING_AGENT_SESSION_DIR` 覆盖 session 存储。`--session-dir` 优先级最高。

### 3.3 SDK 同进程多 session

**[事实]** SDK 支持创建多个独立 `AgentSession`，每个用 `SessionManager.inMemory(cwd)` 或 `SessionManager.create(cwd)`：
```typescript
const { session: s1 } = await createAgentSession({ cwd: "/proj-a", sessionManager: SessionManager.inMemory("/proj-a") });
const { session: s2 } = await createAgentSession({ cwd: "/proj-b", sessionManager: SessionManager.inMemory("/proj-b") });
```
每个 session 有独立的 model、thinking level、tools、messages。

**[事实]** `createAgentSessionRuntime()` 和 `AgentSessionRuntime` 提供运行时替换 API（`newSession`/`switchSession`/`fork`），但这是**单活跃 session 替换**，非并发多 session。并发需自行管理多个 `AgentSession` 实例。

**[未知]** 同进程多 `AgentSession` 并发运行时的资源消耗、事件总线隔离、tool 执行队列竞争等行为，文档未明确。`withFileMutationQueue()` 提供同 session 内的 per-file 写队列，但跨 session 的文件竞争需调用方自行避免（如确保不同 worker 操作不同文件或不同 cwd）。

### 3.4 per-instance 配置独立

**[事实]** SDK 的 `createAgentSession()` 接受完整独立配置：
- `model` / `thinkingLevel` / `scopedModels`
- `tools` / `excludeTools` / `customTools`
- `resourceLoader`（控制 extensions/skills/prompts/themes/context files 发现）
- `sessionManager` / `settingsManager`
- `modelRuntime`（可注入独立 `authPath`/`modelsPath`/`InMemoryCredentialStore`）

这意味着每个 worker 可有完全独立的 model、skill 集、凭据、预算设置。

---

## 维度 4：可复用领域专长（最大优势面）

### 4.1 Skill 机制在 headless 下的确定性调用

**[事实]** Skill 遵循 [Agent Skills standard](https://agentskills.io)，工作机制（`docs/skills.md` "How Skills Work"）：
1. 启动时扫描 skill locations，提取 name + description
2. **系统 prompt 中以 XML 格式包含可用 skill 的描述**（progressive disclosure：只描述在 context，完整指令按需加载）
3. 任务匹配时，agent 用 `read` 工具加载完整 `SKILL.md`
4. agent 按指令执行，用相对路径引用脚本/assets

**[事实]** Skill 可通过两种方式确定性调用：
- **`/skill:name` 命令**：在 prompt 中直接调用，等价于强制加载该 skill。RPC 的 `prompt` 命令支持 skill 命令扩展（"Input expansion: Skill commands (`/skill:name`) and prompt templates (`/template`) are expanded before sending/queueing"）。
- **自动加载**：依赖模型根据 description 自主判断——文档承认 "models don't always do this; use prompting or `/skill:name` to force it"。

**[推论]** 对 CI bot，应在 prompt 中显式用 `/skill:java-coding-standards` 等命令强制加载，而非依赖模型自主判断，以确保确定性。

### 4.2 Skill 在 SDK 中的控制

**[事实]** SDK 的 `DefaultResourceLoader` 提供 `skillsOverride` 回调，可精确控制加载哪些 skill：
```typescript
const loader = new DefaultResourceLoader({
  skillsOverride: (current) => ({
    skills: [...current.skills, customSkill],
    diagnostics: current.diagnostics,
  }),
});
```
也可用 `--skill <path>` CLI flag 或 `--no-skills` + 显式指定实现精确控制。

### 4.3 Context 预算

**[事实]** Progressive disclosure 机制确保只有 skill 的 name + description 常驻 context（每条约几十 token），完整指令按需 `read` 加载。这天然控制了 context 预算——多个 skill 同时描述在系统 prompt 中的开销很小。

**[事实]** `compaction` 设置可控制 context 溢出时的自动压缩：`compaction.enabled`（默认 true）、`compaction.reserveTokens`（默认 16384）、`compaction.keepRecentTokens`（默认 20000）。可在 SDK 中用 `SettingsManager.inMemory({ compaction: { enabled: false } })` 禁用。

### 4.4 MCP auth 的 headless 处理

**[事实]** pi 无内置 MCP，但 extension 可注册 OAuth provider（`pi.registerProvider()` with `oauth` 配置）。OAuth 流程通过 `OAuthLoginCallbacks` 提供 UI-neutral 交互（`onAuth`/`onDeviceCode`/`onPrompt`/`onSelect`），在 RPC 模式下通过 `extension_ui_request`/`extension_ui_response` 子协议处理。

**[推论]** 对 CI bot，MCP auth 应避免交互式 OAuth，优先用 API key（`$ENV_VAR` 或 `InMemoryCredentialStore` 注入）。若必须用 OAuth，需自行实现 `extension_ui_response` 的自动应答逻辑。

### 4.5 迁移代价评估（核心结论）

**[事实]** 用户已有的 skill 体系（java-coding-standards / springboot-tdd / springboot-patterns / python-patterns 等）存放于 `~/.pi/agent/skills/` 或 `.pi/skills/`，pi 原生发现，**零迁移成本**即可在 headless 下复用。

**[事实]** 这些 skill 本质是 Markdown 文件 + 可选脚本，遵循 Agent Skills 标准，不依赖 TUI——skill 内容是给模型的指令，通过 `read` 工具加载，与运行模式无关。

**[推论]** pi 这条路的迁移代价确实最低，但需补齐：
1. **预算控制**（turn/token 上限）：需自建，约 50-100 行 SDK 代码
2. **并发编排**（多项目 worker 调度）：需自建，可用 `child_process.spawn` 或 SDK 多 session
3. **CI 集成胶水**（webhook → pi 调用 → diff/PR 提交）：需自建

对比 Claude Agents SDK / Codex SDK：那些候选的 skill 体系需从零迁移或转换格式，而 pi 的 skill 原生兼容。这是 pi 的决定性优势。

---

## 额外：pi 与"本地执行 + .m2 复用"的契合度

### 沙箱张力

**[事实]** `docs/security.md` 明确：pi **无内置沙箱**，这是 intentional 设计——"partial in-process sandbox would be misleading while still depending on the host shell, filesystem, package managers, credentials, and extension code." bash 工具直接以用户权限运行命令。

**[事实]** 对 CI bot 的"本地执行 + .m2 复用"形态，这反而是**优势**：
- pi 天然访问宿主 FS，可直接读写 `.m2` 缓存
- bash 工具可运行 `mvn test`/`gradle test` 等构建命令
- 无需额外配置即可复用宿主 Java/Maven/Gradle 环境

**[事实]** 但安全文档建议 CI 中应运行在容器/VM 内：
- Mount 只需 workspace 路径
- 避免挂载宿主 `~/.pi/agent`（除非容器需访问宿主 sessions/settings/credentials）
- 传最小 API key 或用 short-lived credentials
- 不需要时限制网络

**[推论]** 对 GitLab CI bot，推荐形态：GitLab Runner 内的 Docker 容器，挂载项目 checkout + `.m2` 目录，设 `PI_CODING_AGENT_DIR` 指向容器内独立配置，API key 通过 env 注入。这样既复用 .m2，又有容器级隔离。

---

## 对比小结 + 迁移代价评估

**pi 这条路：迁移代价最低（已证实），但非零。**

| 维度 | pi 表现 | 需自建 |
|------|---------|--------|
| 第三方模型 | ⭐⭐⭐⭐⭐ 全覆盖，原生 DeepSeek/Kimi/Qwen/vLLM/Bedrock/Vertex | 无 |
| Headless 运行 | ⭐⭐⭐⭐ 四种入口，文档明确 | turn/token 预算控制（~50-100 行） |
| 多并发隔离 | ⭐⭐⭐ 多进程天然隔离，SDK 多 session 可行 | worker 调度编排 |
| 可复用专长 | ⭐⭐⭐⭐⭐ skill 原生复用，零迁移 | 确定性调用需显式 `/skill:name` |
| 本地执行+.m2 | ⭐⭐⭐⭐ 天然访问宿主 FS | 容器隔离需自行配置 |

**核心结论**：pi 在模型支持和 skill 复用上是三候选中决定性最强项；headless 入口完备但缺预算硬上限是最大风险点；并发隔离无原生 subagent 但多进程方案干净。迁移代价确实最低——用户已有 skill 零成本复用，只需补齐预算控制 + 并发编排 + CI 胶水三块自建代码（估计 300-500 行 TypeScript）。

---

## Sources

- Kept: pi README.md (本地 v0.83.0) — 四种运行模式、provider 列表、CLI reference、Philosophy "No MCP/No sub-agents"
- Kept: docs/sdk.md (本地) — `createAgentSession()` API、`AgentSession` 接口、`runPrintMode`/`runRpcMode`、`SessionManager.inMemory()`、`InMemoryCredentialStore`、event 类型
- Kept: docs/custom-provider.md (本地) — `pi.registerProvider()`、`ProviderConfig`/`ProviderModelConfig` 完整接口、`openAICompletionsApi`、OAuth、custom streaming
- Kept: docs/models.md (本地) — Ollama/vLLM 配置、`compat` 字段、`thinkingLevelMap`、`modelOverrides`
- Kept: docs/skills.md (本地) — Agent Skills 标准、progressive disclosure、`/skill:name` 命令、`skillsOverride`
- Kept: docs/extensions.md (本地) — 事件系统（`turn_end`/`agent_settled`/`tool_call`）、`ExtensionAPI` 方法、`ctx.ui`/`ctx.hasUI`/`ctx.mode`
- Kept: docs/rpc.md (本地) — RPC 协议、command/event 类型、extension UI 子协议
- Kept: docs/settings.md (本地) — `thinkingBudgets`、`retry`、`compaction`、`defaultProjectTrust`、project trust
- Kept: docs/json.md (本地) — JSON event stream 模式、`AgentSessionEvent` 类型
- Kept: docs/environment-variables.md (本地) — `PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR`/`PI_OFFLINE`、bash tool session env
- Kept: docs/packages.md (本地) — pi package 机制、npm/git/local 源
- Kept: docs/security.md (GitHub) — 无内置沙箱、CI 隔离建议、project trust 非 sandbox
- Kept: GitHub issue #1898 — `--max-turns`/`--max-tokens` feature request，未实现
- Kept: GitHub discussion #1606 — 32K per-turn output cap 硬编码
- Kept: GitHub PR #3197 — `interrupt()` PR 已关闭未合并，不可用
- Kept: examples/sdk/ (本地，01-13) — SDK 示例确认存在
- Dropped: pi-review-loop README — 证实 loop 模式可行，但主要面向交互式，非直接证据
- Dropped: agent-safehouse.dev sandbox 分析 — 第三方分析，security.md 已覆盖

## Gaps

1. **同进程多 `AgentSession` 并发行为未验证**：文档未说明多个 session 并发运行时的事件总线隔离、tool 执行竞争、内存消耗。需实测 SDK 创建 N 个 in-memory session 并发 prompt 的表现。
2. **print 模式 exit 行为历史问题**：issue #161 报告 v0.18.0 时 `pi -p` 不退出。v0.83.0 的 print-mode.ts 源码显示有 `finally { dispose }` 块，理论应正常退出，但需实测确认。
3. **32K output cap 当前状态**：discussion #1606 报告 v0.53.0 的硬编码 cap。v0.83.0 是否仍存在该 cap 需查源码 `buildBaseOptions` 确认。
4. **skill 自主加载的确定性**：文档承认模型不一定主动 `read` skill。CI bot 需确定性，需实测 `/skill:name` 在 RPC/SDK `prompt()` 中是否可靠展开。
5. **`agent_settled` 事件的可靠性**：作为预算控制的停止信号，需确认它在 auto-retry/auto-compaction 后是否可靠触发。

### 建议的实测验证步骤

1. `pi -p "列出当前目录文件"` 确认退出行为和 exit code
2. `pi --mode rpc --no-session` + Python 客户端，发 `prompt` + 收 `agent_settled`，确认 loop 完成后可继续或退出
3. SDK 创建 2 个 `SessionManager.inMemory()` session 并发 `prompt()`，观察隔离性
4. 配置 Ollama provider，`pi --model ollama/llama3.1:8b -p "hello"` 确认本地模型
5. `pi --skill /path/to/skill -p "/skill:my-skill 执行任务"` 确认 skill 强制加载
