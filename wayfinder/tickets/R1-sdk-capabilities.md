# R1: Claude Agents SDK 能力边界与第三方模型支持研究

> **wayfinder:research** · 状态: ✅ closed · 类型: AFK（researcher subagent）· assignee: charting session
>
> **Resolution**: Claude Agents SDK 的能力边界已查清。核心结论——
> - **[事实]** 第三方模型靠环境变量重定向（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL`），非原生 provider 抽象；端点必须是 Anthropic Messages API 格式（原生 OpenAI API 端点需代理转换）。
> - **[事实]** headless 由 `query()` / `ClaudeSDKClient` 程序化驱动，支持 `max_turns` + `max_budget_usd` 硬上限，但**无内置重试**，默认 turn/budget 无限制（必须显式设置）。
> - **[事实]** 多并发隔离可行但**四条泄漏通道**（settingSources / ~/.claude.json / auto-memory / cwd），须显式配 `settingSources:[]` + `CLAUDE_CONFIG_DIR` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` + per-instance cwd。
> - **[事实]** `allowed_tools` 存在已知 bug（#361/#115/#172），应用 `tools` 字段做白名单。
> - **[未知]** `allowed_tools`/`tools` bug、`maxTurns` frontmatter (#41143)、`ANTHROPIC_BASE_URL` 传递可靠性 (#677) 在当前 PyPI 版本的修复状态需实测确认。
>
> Brief: [`research/r1-sdk-capabilities.md`](../research/r1-sdk-capabilities.md)（339 行）。
>
> **Blocked by**: —

## Question

> **范围注（charting 修正）**：原聚焦 Claude Agents SDK；用户补充后 SDK 选型开放为多候选（Claude Agents SDK / Codex SDK / pi）。本 ticket 产出 **Claude Agents SDK 这一行的详细调查**，与 R3（Codex SDK）、R4（pi）合成对比矩阵供 G6 选型。不重复调查另两候选。

Claude Agents SDK 在以下三点的确切能力边界是什么？结论直接决定 spec 的 SDK 章节、模型选型（G6）、路由/编排（G2）、并发模型（G4）三张 ticket 能否动笔。

1. **第三方模型协议支持**：SDK 能否接 OpenAI 兼容 API（DeepSeek/Kimi/Qwen）、Anthropic 路由网关、本地 vLLM/Ollama、云托管（Bedrock/Vertex）？接法是 SDK 原生 provider 适配、还是要求 model 字符串配置、还是要自定义 transport？
2. **headless 运行形态**：SDK 是否支持无人值守、可程序化驱动的 loop（非交互式 REPL）？subagent 派发与 tool 调用能否在无人在环时确定性触发？有无 token/turn/工具调用预算的硬上限机制？
3. **多并发隔离**：同一进程内跑多个 SDK agent 实例（每项目一个 worker）是否受支持、有无共享状态陷阱、per-agent context/工具白名单/预算能否独立配置。

## 如何验证

- 官方文档（Anthropic Claude Agents SDK / Claude Code SDK）关于 custom provider、third-party model、headless mode、subagent、tool/turn budget 的章节。
- SDK 源码/类型定义（如 npm 包）的 provider 接口与 transport 抽象。
- 社区/issue 中第三方模型接入实例与坑。

## 产出

研究 brief（Markdown），归档到 `research/r1-sdk-capabilities.md`；ticket 留 context pointer。结论须区分 **[事实]**（SDK 明确支持的）、**[未知]**（文档未提需实测的）、**[推论]**（基于源码结构的合理推断）。
