# R3: Codex SDK 作为 bot 骨架的能力边界研究

> **wayfinder:research** · 状态: ✅ closed · 类型: AFK（researcher subagent）· assignee: charting session
>
> **Resolution**: Codex 体系作为 bot 骨架的能力边界已查清。核心结论——
> - **[事实]** "Codex SDK" 非单一产品，是三层：Codex CLI/App Server (codex-rs) / OpenAI Agents SDK (openai-agents-python) / Responses API + function calling。三者能力差异极大，不可混谈。
> - **[事实｜最大限制]** Codex CLI **2026.02 弃用 chat/completions，仅留 responses API**。DeepSeek/Qwen/Kimi 等仅支持 chat/completions 的国产/开源模型将**无法直连**，除非自建 responses-bridge 代理。这是 Codex CLI 路径对目标模型生态的硬伤。
> - **[事实]** OpenAI Agents SDK 模型支持最广：原生支持 chat/completions 适配器（与 Codex CLI 弃用方向不同步），三层粒度（set_default_openai_client / ModelProvider / per-agent model）可混多 provider；Anthropic/Bedrock/Vertex 无原生需适配器。
> - **[事实]** headless：Agents SDK 有 `max_turns` 硬上限 + guardrails(前/后/工具校验) + 可组合 retry policy + `needs_approval=False` 全自动；Codex CLI `codex exec` + App Server 程序化可行但 turn/token/tool 预算**未明确文档化**。
> - **[事实｜bug]** Agents SDK 并发有 **ContextVar bug (#2246)**：`asyncio.gather` 多 `Runner.run()` 触发 tracing ContextVar token 冲突，workaround `tracing_disabled=True` 但丢 tracing。PR #3843 (2026-07) 部分修复。
> - **[事实]** 可复用专长：Codex 有 **Skills 机制（feature-flagged）**，SKILL.md 格式与 pi 兼容，但触发仍靠模型匹配 description（非确定）；Agents SDK **无原生 skill**，专长用 `Agent(instructions)` + `@function_tool` + `as_tool()` 确定性表达，但无渐进披露。
> - **[推论]** 迁移代价：pi skills → Codex Skills 中度重写（格式兼容+description 调优+prompt 显式 `$SkillName`）；→ Agents SDK 中高度重写（拆解为 Agent/tool，渐进披露需自建）。
>
> Brief: [`research/r3-codex-sdk.md`](../research/r3-codex-sdk.md)（213 行）。
>
> **Blocked by**: —（与 R1/R2/R4 并行，各覆盖一个候选 SDK）

## Question

研究 OpenAI Codex（codex-cli / codex agent SDK / Responses API + tools 体系）作为 headless CI 自愈 bot 骨架的能力边界。与 R1（Claude SDK）、R4（pi）合成跨 SDK 对比矩阵供 G6 选型。

> **注意**："Codex SDK"的确切所指需先厘清——是 codex-cli 的 agent 能力、OpenAI 官方发布的 agent SDK、还是 Responses API + function calling。研究第一步先界定范围。

四维度（与 R1/R4 对齐，便于横向比较）：
1. **第三方模型支持**：Codex 是否绑定 OpenAI 模型？能接 OpenAI 兼容 API（DeepSeek/Kimi/Qwen）、本地 vLLM/Ollama、Anthropic、Bedrock/Vertex 吗？接法与限制。
2. **headless 运行形态**：支持无人值守、程序化驱动 loop 吗？subagent/agent 派发与 tool 调用能否无人在环确定性触发？token/turn/工具预算硬上限？错误/重试？
3. **多并发隔离**：同进程多 agent 实例（每项目一 worker）受支持否？共享状态陷阱？per-agent context/工具白名单/预算独立配置？
4. **可复用领域专长**：Codex 怎么表达可复用领域专长（对应 pi 的 skill / Claude 的 skill）？是 prompt 模板、subagent、tool 包、还是无原生机制？headless 下确定性调用？**特别评估迁移代价**：用户在 pi 下积累的 java-coding-standards / springboot-tdd 等 skill 要迁移到 Codex 需多少重写。

## 如何验证

- OpenAI 官方文档（Codex / Responses API / Agents 相关）。
- codex-cli 源码/类型定义。
- 社区 headless bot 实例与坑。

## 产出

研究 brief，写入 `/Users/earthchen/ai-work/ci-bot/research/r3-codex-sdk.md`（目录不存在则建）。区分 **[事实]** / **[未知]** / **[推论]**。末尾给一行对比小结（便于 G6 横向比）。
