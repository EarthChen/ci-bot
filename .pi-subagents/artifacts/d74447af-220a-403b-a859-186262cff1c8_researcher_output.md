# Research: Claude Agents SDK 中 Skill 与 MCP 在 Headless / 无人值守 / 多项目并发场景下的消费方式

## Summary

[事实] Claude Agent SDK 的 Skill 与交互式 Claude Code **是同款机制**——Skill 仍是文件系统上的 `SKILL.md`，通过 `setting_sources` + `skills` 选项发现与过滤，由模型自主调用 `Skill` 工具加载正文。但 SDK 另有**程序化可定义的对应物**：`subagents`（`AgentDefinition`，独立 context + 专属 system prompt + 工具白名单）和 **in-process SDK MCP server**（Python 函数即工具），二者无需文件制品、可确定性注入、更适合无人值守。MCP 在 headless 下对交互式 OAuth 支持薄弱且存在已确认 bug，需预置静态凭据。多 skill 选择是 LLM 语义匹配（非确定性），headless 下推荐改用 bot 代码做显式路由 + subagent 隔离。

---

## 研究范围映射

| 关注点 | 结论标签 | 关键证据来源 |
|---|---|---|
| ① Skill 在 SDK 里的形态 | [事实]+[未知] | 官方 skills/subagents 文档、Python README、Promptfoo provider 文档 |
| ② 多 skill 选择机制 | [事实]+[推论] | 官方文档、controllability 社区分析、issue #17327 |
| ③ Context 预算 | [事实]+[未知] | 官方 progressive disclosure 描述、issue #14882（回归 bug） |
| ④ MCP headless 适配 | [事实]+[未知] | issue #64894（headersHelper bug）、issue #69620（文档缺口）、v2.1.183 changelog |

---

## ① Skill 在 SDK 里的形态

### [事实] Skill 是 Claude Code 同款机制，文件系统制品 + 模型自主调用

SDK 中的 Skill 与交互式 Claude Code **共享同一机制**，不是 SDK 自有原语：

- **形态**：一个目录，内含 `SKILL.md`（YAML frontmatter `name` + `description` 必填，正文是 Markdown 指令），可选 bundled scripts / reference docs。 [Agent Skills 官方文档](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- **发现**：SDK 默认加载 user + project sources，扫描 `~/.claude/skills/`、`<repo>/.claude/skills/` 及父目录链。可通过 `setting_sources: ['project', 'local', 'user']` 控制来源。 [Agent Skills in the SDK](https://code.claude.com/docs/en/agent-sdk/skills)
- **过滤**：`skills` 选项（SDK ≥0.2.120）传 `'all'` 或 skill 名数组，自动 allow `Skill` 工具。**它是 context 过滤器而非沙箱**——未列出的 skill 对模型隐藏并被 `Skill` 工具拒绝，但其文件仍可被 `Read`/`Bash` 访问。 [Promptfoo Claude Agent SDK provider](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/) — Testing Skills 节
- **调用 API 形式**：Claude 通过内置 `Skill` 工具调用，工具名为 `Skill`，参数为 skill 名。程序侧通过 `query()` 的 async iterator 接收 `tool_use` / `tool_result` 消息流，可在 `metadata.toolCalls` / `metadata.skillCalls` 中断言。 [Promptfoo provider — Tool Call Tracking](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/)

### [事实] 确定性调用的真相：能限制"选哪个"，但不能强制"选不选"

`skills: ['code-review']` 可**确定性限定**只暴露某个 skill 子集（白名单），这是 bot 代码可控的。但**是否触发**仍由 LLM 基于语义匹配决定——文档原文："Claude automatically invokes the relevant skill when a task matches the skill's description in its frontmatter." [Promptfoo — How Skills Are Discovered](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/)

这意味着：headless 程序可以**保证 skill 池是确定的**，但**不能保证某次运行一定会调用某个 skill**。

### [事实] SDK 里的程序化"可复用领域专长"对应物——subagent 与 in-process MCP server

如果"skill"在 headless 下不够确定性，SDK 提供两个**程序化原语**作为替代/补充：

1. **Subagents（`AgentDefinition`）** — 在 `ClaudeAgentOptions.agents` 中程序化定义，每个 subagent 有：
   - 独立的 fresh context window（不继承父对话历史）
   - 专属 system prompt（`prompt` 字段）
   - 工具白名单（`tools` 字段）
   - 可指定 `model`、`max_turns`、`permission_mode`、`skills`
   
   父 agent 通过 `Agent` 工具调用，subagent 跑完只把**最终消息**返回父 context。**这是隔离 context、注入专长指令、并行执行的标准原语**，无需文件制品。 [Growth Engineer — How to Build Subagents](https://growthengineer.ai/blog/claude-agent-sdk-subagents) + [Subagents in the SDK 官方文档](https://code.claude.com/docs/en/agent-sdk/subagents)

   ```python
   agents={
       "code-reviewer": AgentDefinition(
           description="Reviews code for bugs and style issues",
           prompt="You are a code reviewer...",
           tools=["Read", "Grep", "Glob"],
           model="sonnet",
           max_turns=15,
       )
   }
   ```

2. **In-process SDK MCP server** — Python 函数即工具，用 `@tool` 装饰器 + `create_sdk_mcp_server()` 创建，**无子进程、无 IPC 开销**、可直接类型安全调用。这是确定性最强的"工具注入"方式。 [claude-agent-sdk-python README](https://github.com/anthropics/claude-agent-sdk-python/blob/70bff63d26432dbd50a848b59008b475124c149f/README.md)

   ```python
   @tool("greet", "Greet a user", {"name": str})
   async def greet_user(args):
       return {"content": [{"type": "text", "text": f"Hello, {args['name']}!"}]}
   server = create_sdk_mcp_server(name="my-tools", version="1.0.0", tools=[greet_user])
   options = ClaudeAgentOptions(mcp_servers={"tools": server}, allowed_tools=["mcp__tools__greet"])
   ```

### [未知] Skill 正文加载时机在 headless 与交互式是否完全一致

文档描述 progressive disclosure（见 ③），但 issue #14882 报告了 skill 全文在启动时全量加载的回归。该 issue 在交互式 `/context` 下观察到，**headless/SDK 模式是否同样受影响未在 issue 中明确**，需实测确认。

---

## ② 多 Skill 选择机制

### [事实] 默认是 LLM 自主选择，基于 frontmatter description 语义匹配

官方机制：启动时只加载每个 skill 的 `name` + `description`（元数据），Claude 根据任务语义匹配 description 决定是否调用 `Skill` 工具加载全文。**无算法匹配、无规则路由，是 LLM 推理判断**。 [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) + [Controllability Problem](https://paddo.dev/blog/claude-skills-controllability-problem/)

### [推论] 三种路由策略及其风险

| 策略 | 机制 | 误选/不选风险 | Context 风险 |
|---|---|---|---|
| A. LLM 自主选（默认 skill 机制） | Claude 语义匹配 description | **高**：无法强制触发、无法阻止误触发；issue #17327 指出"proactive invocation 只定义正向匹配，未定义何时不选" | 中：每个 skill 元数据 ~50-100 tokens，触发后全文进 context |
| B. Bot 代码显式路由 + subagent | 程序根据失败类型/信号决定调哪个 `AgentDefinition`，prompt 里点名 | **低**：路由规则确定性，subagent description 锐化匹配 | 低：中间工作留在 subagent 隔离 context，只回传摘要 |
| C. 混合：skill 白名单 + subagent 持有 skill | `skills: ['x']` 限定池 + `AgentDefinition.skills` 给 subagent 注入 | 中：池确定，但 subagent 内仍 LLM 选 | 低 |

### [事实] 无人值守下的推荐范式：用 subagent 做"确定路由 + context 隔离"

社区与官方工程博客一致建议：**把研究/探索/大文件任务路由到 subagent，只回传结构化摘要**。subagent 的 `description` 决定"何时被父 agent 调用"（仍是 LLM 匹配，但父 agent 层匹配通常比 skill description 匹配更可控，因为父 prompt 可点名）。 [Growth Engineer](https://growthengineer.ai/blog/claude-agent-sdk-subagents) 报告此模式可降 parent context 40-70%。

### [事实] subagent 不能嵌套，编排树只有一层

官方明确："Subagents cannot spawn their own subagents. Don't include `Agent` in a subagent's `tools` array." [Subagents docs](https://code.claude.com/docs/en/agent-sdk/subagents)。这对多项目并发的拓扑设计是硬约束——不能做递归 fan-out。

---

## ③ Context 预算

### [事实] Progressive Disclosure 三层加载设计

Skill 采用 progressive disclosure，设计上三层加载以避免 context 爆炸： [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) + [biggo 分析](https://finance.biggo.com/news/5c2707f1-a242-4f7d-bb45-46731b860c08)

1. **第一层（启动时常驻）**：每个 skill 的 `name` + `description` 元数据，~50-100 tokens/skill
2. **第二层（触发时加载）**：`SKILL.md` 正文（<5k words 目标）
3. **第三层（按需）**：bundled scripts / reference docs

设计意图：8 个 skill 启动只花 ~500 tokens，全量加载会花 ~70,000 tokens（140x 差距）。 [dotzlaw](https://dotzlaw.com/insights/claude-skills/)

### [事实] 已确认的回归 bug：skill 全文在启动时全量加载

**issue #14882**（claude-code）报告：`/context` 显示 official `plugin-dev` 插件的多个 skill 在启动时即显示完整 token 数（如 "Skill Development: 5.5k tokens"、"Command Development: 4.6k tokens"），而非仅 frontmatter。多个插件安装后，skills 单独在对话开始前就消耗 50k+ tokens。 [issue #14882](https://github.com/anthropics/claude-code/issues/14882)

**影响**：这直接威胁 headless 多项目并发的 context 预算——如果每个 session 启动即吃 50k tokens 的 skill 元数据，200k 窗口实际可用空间被严重压缩。

### [未知] 该回归在 SDK `query()` 路径下是否复现

issue #14882 在交互式 `/context` 下观察到。**SDK 的 `query()` 是否走同一加载路径、`skills` 过滤选项是否规避此问题**，issue 未明确，需实测。

### [事实] SDK 的 context 管理原语

- **compaction**：Claude Code 在 context 接近内部阈值时触发，让模型生成对话摘要替换全历史。**这是 Claude Code/SDK runtime 内置行为**，不是 `query()` 选项。 [DeepWiki — Context Window & Compaction](https://deepwiki.com/anthropics/claude-code/3.3-context-window-and-compaction)
- **subagent 隔离**：最有效的 context 预算管理——中间工作留在 subagent 独立窗口，父 context 只收最终摘要。 [Growth Engineer](https://growthengineer.ai/blog/claude-agent-sdk-subagents)
- **`max_turns` / `max_budget_usd`**：限制 agent 循环深度与成本，但不直接管理 context token 数。 [How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- **`task_budget: {total: N}`**：token 预算用于让模型"自己 pacing"工具使用，**但 API 响应不返回 remaining-budget**，无法服务端追踪。 [Task budgets 官方文档](https://platform.claude.com/docs/en/build-with-claude/task-budgets)
- **`exclude_dynamic_sections: true`**：剥离 per-user 动态 section（工作目录、auto-memory、git status）使 system prompt 可缓存，动态部分作为首条 user message 重注入。 [Promptfoo — System Prompt](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/)
- **`context-1m-2025-08-07` beta**：1M token 窗口（仅 Sonnet 4/4.5）。 [Promptfoo — Beta Features](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/)

### [事实] 无 SDK 级 RAG/检索原语

SDK 不提供对 skill 文档的 RAG/向量检索。progressive disclosure 是唯一的"检索"——靠 description 匹配决定加载哪个 skill 全文。如需 RAG，须在 bot 代码层自建（如用 in-process MCP server 封装检索工具）。

### [推论] 多 skill 叠加在 headless 下的实际风险

若 issue #14882 的回归在 SDK 路径复现，则多项目并发时：每个并发 session 独立加载各自 skill 池 → N 个 session × 50k tokens = 显著放大。缓解手段：`skills` 白名单只暴露当次任务所需 skill；或改用 subagent 在隔离窗口内持有 skill。

---

## ④ MCP 工具的 Headless 适配

### [事实] SDK 的 MCP client 支持三种服务器类型

1. **stdio（子进程）**：`{type: "stdio", command, args}`
2. **HTTP/SSE（远程）**：`{type: "http", url, headers, headersHelper}`
3. **In-process SDK MCP server**（Python 函数即工具，无子进程） [claude-agent-sdk-python README](https://github.com/anthropics/claude-agent-sdk-python/blob/70bff63d26432dbd50a848b59008b475124c149f/README.md)

程序化注入：`ClaudeAgentOptions(mcp_servers={...})` 或 CLI `--mcp-config path`。 [renezander](https://renezander.com/blog/claude-code-sdk-agents/)

### [事实] 交互式 OAuth 是 MCP 远程服务器的主要 auth 路径

官方 MCP 文档教的是交互式 `/mcp` → `Authenticate` → 浏览器登录流程。 [issue #69620](https://github.com/anthropics/claude-code/issues/69620) 指出这**没有 cross-reference headless/SDK 限制**。

### [事实] SDK 不自动处理 OAuth，需程序侧完成 OAuth 后传 token

Agent SDK MCP 指南原文："The SDK doesn't handle OAuth flows automatically, but you can pass access tokens via headers after completing the OAuth flow in your application." [issue #69620 引述](https://github.com/anthropics/claude-code/issues/69620)

### [事实] v2.1.183 changelog：headless/SDK 下未认证服务器暴露 auth-stub 工具的 bug 已修

`Fixed MCP servers requiring authentication exposing auth-stub tools to the model in headless/SDK mode`。即：此前未认证的远程 MCP 服务器会把"auth-stub 工具"暴露给模型，模型可能误以为可用。修复后，**未认证服务器在 headless/SDK 下应被视为不可用，直到程序侧提供凭据**。 [issue #69620](https://github.com/anthropics/claude-code/issues/69620)

### [事实] headersHelper（预置 Bearer/API key）存在已确认 bug

**issue #64894**（claude-code）：配置了 `headersHelper` 脚本（返回 `Authorization: Bearer ...` + `X-Api-Key`），脚本成功执行返回有效 JSON，但**这些 header 从未被应用到任何出站 HTTP 请求**。SDK 无视 headersHelper 输出，直接走完整 MCP OAuth 2.1 Authorization Code 流程（`POST /v1/mcp` → 401 → `/.well-known/oauth-*` → `/register` 全失败）。mitmproxy 确认 6 个请求无一携带 Authorization。 [issue #64894](https://github.com/anthropics/claude-code/issues/64894)

**影响**：使用 Bearer token / API key auth 的 HTTP MCP 服务器（占现有 API 多数）**当前无法在 SDK 下可靠连接**。这是 headless 确定性处理 MCP auth 的核心障碍。

### [事实] headless MCP auth 的确定性处理路径

| 凭据类型 | headless 可行性 | 机制 |
|---|---|---|
| 环境变量 / 静态 API key | ✅ 可行（绕过 headersHelper bug） | 程序侧在 `headers` 字段直接注入，或 MCP server 端读 env |
| 预获取 Bearer token（client_credentials） | ⚠️ 受 #64894 bug 阻塞 | 需程序侧先完成 OAuth，token 注入 `headers`；但 headersHelper 路径有 bug |
| 交互式 OAuth（browser） | ❌ headless 不可行 | 需先在交互式 session 完成 `/mcp` Authenticate，凭据存 keychain；或 bare 模式跳过 |
| In-process SDK MCP server | ✅ 完全可行 | Python 函数直接调用，无网络 auth |

### [事实] bare 模式跳过 OAuth 与 keychain

`--bare`（CLI）/ bare 配置跳过 OAuth 与 keychain 读取，Anthropic 认证必须来自 `ANTHROPIC_API_KEY` 或 `apiKeyHelper`。 [issue #69620 引述 headless 文档](https://github.com/anthropics/claude-code/issues/69620)

### [事实] 失败重试：SDK 不自动重试 subagent/MCP 失败

subagent 失败时，父 agent 收到含错误信息的 `Agent` 工具结果，**SDK 不自动重试**，由程序侧决定重试/降级/上报。 [Growth Engineer](https://growthengineer.ai/blog/claude-agent-sdk-subagents)。MCP 工具调用的重试同理——须在 bot 代码的 `can_use_tool` / hooks / 外层循环中实现。

### [未知] headersHelper bug 在最新 SDK 版本的修复状态

issue #64894 标记为 closed，但需确认修复是否已进入 PyPI 发布的 bundled CLI 版本。**多项目并发下，若依赖远程 HTTP MCP + 预置 token，必须先实测当前 bundled CLI 版本是否已修**。

---

## 跨点综合：Headless / 无人值守 / 多项目并发的推荐架构

### [推论] 分层消费模型

```
┌─ Bot 代码层（确定性路由）──────────────────────────┐
│  失败信号 → 路由规则 → 选择 AgentDefinition          │
│  （不依赖 LLM 选 skill，由代码决定调哪个 subagent）   │
└──────────────────────────────────────────────────────┘
        │ query(options=ClaudeAgentOptions(agents={...}))
        ▼
┌─ 主 Agent（父 context，轻量）────────────────────────┐
│  system_prompt: 全局职责                              │
│  allowed_tools: [Read, Grep, Agent, ...]             │
│  skills: []  ← 默认不加载 skill，避免 #14882 回归     │
│  mcp_servers: { in-process SDK MCP server }          │
│  permission_mode: default + can_use_tool 回调         │
│  max_turns / max_budget_usd: 硬上限                   │
└──────────────────────────────────────────────────────┘
        │ Agent 工具调用
        ▼
┌─ Subagent（隔离 context，持有专长）──────────────────┐
│  AgentDefinition:                                     │
│    prompt: 专长指令（等价于 skill 正文，但程序化注入）  │
│    tools: 白名单                                      │
│    model: 按任务选 haiku/sonnet/opus                  │
│    max_turns: 硬上限                                  │
│    skills: ['specific-skill']  ← 如需 skill，限定于此 │
│  中间工具调用/结果留在 subagent 内，只回传最终摘要      │
└──────────────────────────────────────────────────────┘
```

### [推论] 各能力的 headless 适用性矩阵

| 能力 | Headless 确定性 | 并发安全 | 推荐用法 |
|---|---|---|---|
| Skill（SKILL.md） | ⚠️ LLM 自主触发，非确定 | ⚠️ #14882 回归风险 | 仅在 subagent 内限定使用；主 agent 默认 `skills: []` |
| Subagent（AgentDefinition） | ✅ 程序化定义、确定路由 | ✅ 独立 context 天然隔离 | **主推**——专长指令 + context 隔离 + 并行 |
| In-process SDK MCP server | ✅ Python 函数，完全确定 | ✅ 同进程 | 封装确定性工具（检索、状态查询） |
| 远程 HTTP MCP | ⚠️ auth bug #64894 | ⚠️ rate limit / 状态 | 预置静态凭据 + 实测当前 CLI 是否已修 |
| can_use_tool 回调 | ✅ 程序化 allow/deny/改写 | ✅ | 权限沙箱 + 审计日志 + 失败重试拦截点 |
| hooks（Pre/PostToolUse） | ✅ 确定性 | ✅ | 审计 + 工具输出改写 + 上下文注入 |

---

## 特别标注：SDK "Skill" 与交互式 Claude Code 的关系

### [事实] 同款，但有程序化替代

SDK 的 skill **就是交互式 Claude Code 的 skill**（同 `SKILL.md` 格式、同 `setting_sources` 发现、同 `Skill` 工具调用、同 progressive disclosure）。用户断言"SDK 支持 skill"在形态上成立。

**但**：headless 无人值守下，skill 的 LLM 自主触发特性使其**不适合作为确定性能力消费的主路径**。SDK 提供的**可复用领域专长对应物**是：

1. **Subagent（`AgentDefinition`）** — 把"专长指令"从文件 skill 正文搬到程序化 `prompt` 字段，加独立 context + 工具白名单 + 模型选择。**这是 headless 下注入领域专长的首选原语**。
2. **In-process SDK MCP server** — 把"确定性工具能力"写成 Python 函数，无子进程、无 auth 问题。**这是确定性工具注入的首选**。
3. **`can_use_tool` 回调 + hooks** — 把"路由/拦截/审计"逻辑写成确定性代码，不交给 LLM 判断。

**定调建议**：后续设计应将"领域专长"建模为 `AgentDefinition`（subagent）而非 `SKILL.md`（skill），除非该专长必须跨交互式/headless 共享且可接受非确定性触发。skill 可作为 subagent 内部的按需知识源（`AgentDefinition.skills`），但不应作为主路由机制。

---

## Sources

### Kept（关键证据）

- **Agent Skills in the SDK** (https://code.claude.com/docs/en/agent-sdk/skills) — 官方 skill 在 SDK 中的发现/过滤机制，`skills` 选项语义
- **Subagents in the SDK** (https://code.claude.com/docs/en/agent-sdk/subagents) — 官方 subagent 定义、context 隔离、不可嵌套约束
- **claude-agent-sdk-python README** (https://github.com/anthropics/claude-agent-sdk-python/blob/70bff63d26432dbd50a848b59008b475124c149f/README.md) — `query()`/`ClaudeSDKClient` API、in-process SDK MCP server、hooks 程序化定义
- **Promptfoo Claude Agent SDK provider** (https://www.promptfoo.dev/docs/providers/claude-agent-sdk/) — 最完整的选项参数表（skills/setting_sources/mcp/permission/agents/hooks/budget），含 `skills` 是 context filter 非 sandbox 的明确说明
- **issue #64894** (https://github.com/anthropics/claude-code/issues/64894) — headersHelper bug 的 mitmproxy 级证据，headless MCP auth 核心障碍
- **issue #69620** (https://github.com/anthropics/claude-code/issues/69620) — headless/SDK MCP 未认证服务器行为文档缺口 + v2.1.183 修复
- **issue #14882** (https://github.com/anthropics/claude-code/issues/14882) — skill 全文启动时全量加载回归，context 预算核心风险
- **issue #17327** (https://github.com/anthropics/claude-code/issues/17327) — skill proactive invocation 只定义正向匹配
- **Growth Engineer — Subagents** (https://growthengineer.ai/blog/claude-agent-sdk-subagents) — `AgentDefinition` 完整字段、token 节省数据、失败处理
- **renezander — SDK Agents** (https://renezander.com/blog/claude-code-sdk-agents/) — 三层 surface 区分（raw API / `claude -p` / SDK）、MCP 程序化注入、budget/permission 实践
- **Claude Code from Source — Ch8 Subagents** (https://claude-code-from-source.com/ch08-sub-agents/) — skill 作为 prepended user message 加载、并发 `Promise.all()` 加载
- **Agent Skills overview** (https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) — progressive disclosure 三层设计
- **Controllability Problem** (https://paddo.dev/blog/claude-skills-controllability-problem/) — skill LLM 自主触发的非确定性分析（含 2.1 已部分修复的更新说明）
- **tool_permission_callback.py** (https://github.com/anthropics/claude-agent-sdk-python/blob/a0fbd14354e319939a5a5ff834cdf83a63100d48/examples/tool_permission_callback.py) — `can_use_tool` 回调的官方示例
- **Permissions guide (hexdocs)** (https://claude-agent-sdk.hexdocs.pm/permissions.html) — permission modes 完整表、`can_use_tool` shadowing 行为
- **dotzlaw — Skills token math** (https://dotzlaw.com/insights/claude-skills/) — 8 skills = 500 tokens 启动 vs 70k 全量的 140x 数据

### Dropped（排除）

- **Vellum "Headless Claude Code Skill"** — 营销页，非技术证据
- **mindstudio.ai 多篇** — 二手转述，无一手 API/源码证据
- **aiskillcerts.com** — 教程性质，无 headless 特异性
- **amux.io / buildthisnow.com** — 指南类，与官方文档重叠
- **claudefa.st** — 计费政策，与研究范围无关
- **MCP connector (platform.claude.com)** — 指 Messages API 的 MCP connector，非 Agent SDK 的 MCP client，scope 不同

---

## Gaps（需实测确认）

1. **[未知] issue #14882 的 skill 全量加载回归是否影响 SDK `query()` 路径**：交互式 `/context` 已确认，SDK headless 路径未在 issue 中验证。**建议**：用 `skills: ['x']` + `exclude_dynamic_sections` 在 `query()` 下跑 `/context` 等价检查，对比 frontmatter-only vs 全量 token 数。
2. **[未知] headersHelper bug（#64894）在当前 PyPI bundled CLI 版本的修复状态**：issue closed，但 PyPI 包捆绑的 CLI 版本可能滞后。**建议**：实测当前 `claude-agent-sdk` PyPI 版本的 bundled CLI 是否已修，用 mitmproxy 验证 headersHelper 输出是否应用到出站请求。
3. **[未知] `skills` 过滤选项是否能规避 #14882**：`skills: ['specific-skill']` 是否只加载该 skill 的 frontmatter、还是仍全量加载所有 discovered skill。文档说"unlisted skills hidden from model's listing"，但加载行为未明确。
4. **[未知] 多项目并发下 session 隔离的 resource 开销**：每个 `query()` 是独立 CLI 子进程（Python SDK 通过 subprocess 调 bundled CLI），N 个并发项目的进程/CPU/memory 开销需实测。`spawn_claude_code_process` 可自定义 spawn（如容器化），但默认开销未量化。
5. **[未知] subagent 内 `skills` 字段加载的 skill 是否受 #14882 影响**：`AgentDefinition.skills: ['x']` 加载的 skill 是否 progressive disclosure 正常工作。

### 建议的下一步实测

- 最小可行验证脚本：`query()` + `skills: ['test-skill']` + 大 SKILL.md（>5k tokens），对比 `result.usage.input_tokens` 首轮是否含 skill 全文。
- MCP auth 验证：配置一个 Bearer-token HTTP MCP server + `headersHelper`，在 `query()` 下跑，mitmproxy 抓包确认 header 是否应用。
- 并发开销：同时启动 5 个 `query()`（不同 `cwd`），测峰值进程数与 memory。

---

## Supervisor coordination

本研究无阻塞性决策需求，返回完整 brief。核心发现（skill 非确定性 + #14882 回归 + MCP headersHelper bug）可能影响后续架构定调，但属于"信息供决策"而非"需 supervisor 裁决"。如需就"skill vs subagent 定调"做架构决策，可基于本 brief 的特别标注节启动 architect agent。