# R3: Codex SDK 作为 bot 骨架的能力边界研究

> **wayfinder:research** · 状态: open · 类型: AFK（researcher subagent）· assignee: unclaimed
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
