# R2: Claude Agents SDK 中 skill/MCP 在 headless 并发下的消费方式研究

> **wayfinder:research** · 状态: ✅ closed · 类型: AFK（researcher subagent）· assignee: charting session
>
> **Resolution**: Claude Agents SDK 的 skill/MCP 在 headless 下的消费方式已查清。核心结论——
> - **[事实]** SDK 的 skill 与交互式 Claude Code **同款**（同 SKILL.md 格式、同 setting_sources 发现、同 Skill 工具调用）。但触发由 LLM 语义匹配 description 决定，**非确定性**。
> - **[事实]** headless 下"可复用领域专长"的**首选原语是 subagent（AgentDefinition）**，不是 skill——程序化定义 prompt + 工具白名单 + 独立 context，确定路由。subagent 不可嵌套（硬约束）。
> - **[事实]** 确定性工具注入首选 **in-process SDK MCP server**（Python 函数即工具，无子进程无 auth）。
> - **[事实]** MCP headless 的核心障碍：**headersHelper bug (#64894)** — 配置的 Bearer/API key header 从未应用到出站请求；交互式 OAuth 不可行；预置静态凭据或 in-process MCP server 是可行路径。
> - **[事实]** **skill 全量加载回归 (#14882)** — 多 skill 在启动时全量加载而非 frontmatter，威胁 context 预算；SDK query() 路径是否复现需实测。
> - **[推论]** 推荐架构：主 agent `skills:[]` + 显式路由到 subagent + in-process MCP，skill 只在 subagent 内限定使用。
>
> Brief: [`research/r2-skill-mcp-headless.md`](../research/r2-skill-mcp-headless.md)（357 行）。
>
> **Blocked by**: —（与 R1 并行，同为 SDK 调查的两个面）

## Question

> **范围注（charting 修正）**：与 R1 同理，本 ticket 只覆盖 **Claude Agents SDK** 的 skill/MCP headless 消费；R3/R4 覆盖 Codex SDK / pi 的同类问题。四份合成跨 SDK 对比供 G6 选型。

用户已断言"Claude Code Agents SDK 支持 skill、MCP 等能力"——交互式形态下成立。本 ticket 研究 **headless、无人值守、多项目并发** 下能否消费这些能力，以及怎么消费。结论决定语言适配层（G2 路由的 skill 调用机制）、模型选型（G6 是否因 skill 依赖受限）。

1. **skill 在 SDK 里的形态**：SDK 暴露给自建程序的"skill"接口长什么样？是 Claude Code 的同款机制、还是 SDK 自有原语（如可配置 system prompt + tool 集）？能否被 headless 程序**确定性**调用（非靠人在 REPL 里加载）？
2. **多 skill 选择机制**：无人值守时怎么选哪个 skill 处理哪类失败？是显式路由规则（bot 代码决定）、还是让 agent 自主选（LLM 决定）？各自的风险？
3. **context 预算**：skill 是"把 markdown 灌进 context"——多 skill 叠加 / 大 skill 文本会不会撑爆 token 预算？SDK 有无压缩/检索（如 RAG/摘要）原语？
4. **MCP 工具的 headless 适配**：MCP 工具可能需交互式 auth、有 rate limit、有状态——headless 批跑下怎么确定性处理（预置 token、自动续期、失败重试策略）？

## 如何验证

- 官方文档关于 Agent Skills、MCP、tool authorization、headless 模式的章节。
- SDK 类型定义中 skill/MCP 相关接口。
- 已有用 SDK 自建 headless bot 的实例（含失败案例）。

## 产出

研究 brief，归档 `research/r2-skill-mcp-headless.md`；ticket 留 context pointer。区分 **[事实]** / **[未知]** / **[推论]**。特别标注：若 SDK 的"skill"与交互式 Claude Code 不同款，给出 SDK 里**可复用领域专长**的对应物是什么（system prompt 模板？subagent？MCP tool 包？），供 G2/G6 据此重新定调。
