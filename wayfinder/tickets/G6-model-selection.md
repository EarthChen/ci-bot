# G6: SDK + 模型选型决策

> **wayfinder:grilling** · 状态: open · 类型: HITL（需用户在线，/grilling）· assignee: unclaimed
>
> **Blocked by**: R1, R2, R3, R4（需四份研究合成跨 SDK 对比矩阵：Claude Agents SDK / Codex SDK / pi 的能力 + 第三方模型支持 + headless 并发 + skill/MCP 消费 + 领域专长迁移代价）

## Question

根据 R1–R4 合成的跨 SDK 对比矩阵，决定 bot 用哪个 SDK 骨架 + 什么模型（或模型组合）。这是 spec 里最影响成本、质量、且最难回退的决策之一。

grilling 出：
1. **主模型**：单一大模型 vs 按任务路由多模型（诊断用强推理模型、改测试用快模型）？
2. **provider 选型**：若 R1 证实 SDK 支持多 provider，选哪些（OpenAI 兼容 API / Anthropic / Bedrock/Vertex / 本地）？按什么维度选（成本、延迟、对 Java/Spring 代码的理解力、中文/英文）。
3. **skill 依赖约束**：若 R2 显示某些 skill 只在特定模型下生效（如 Claude 原生 skill），模型选型受不受约束？
4. **失败回退**：主 provider 不可用时的 fallback 链。
5. **成本预估维度**：单次失败修复的预期 token 量级、并发下的峰值成本。

## 产出

模型选型决策（含 ADR 候选——若 hard-to-reverse + 真实权衡 + 令人意外，则立 ADR）。归档 `research/g6-models.md`。
