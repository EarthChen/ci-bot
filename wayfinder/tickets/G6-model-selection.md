# G6: SDK + 模型选型决策

> **wayfinder:grilling** · 状态: ✅ closed · 类型: HITL（需用户在线，/grilling）· assignee: 当前 session
>
> **Blocked by**: R1, R2, R3, R4（均已 closed，解锁本票）
>
> **Resolution**: SDK + 模型选型决策已定。5 个子决策如下——
>
> 1. **SDK 骨架**: **Claude Agents SDK**。接受代价: 模型须走 Anthropic Messages API 格式(DeepSeek/Ollama/vLLM 有兼容端点; Kimi/Qwen 纯 OpenAI 兼容的要代理转换); 已有 pi skill 重构路径(见下 #5); .m2 复用仍需配容器隔离(无原生 FS 优势)。
> 2. **主模型策略**: v1 **单一主模型**(多模型路由降级为演进目标)。原因: v1 单 agent 无路由点, Q2 选的 B(多模型路由+subagent 编排)暂不落地。演进触发条件见下。
> 3. **Provider 接入**: **直连兼容端点**(DeepSeek 官方 anthropic 兼容端点 `https://api.deepseek.com/anthropic` + Ollama v0.14+ 本地兼容端点)。无需代理层。每 provider 独立配置, 切换改代码非配置。
> 4. **Fallback 链**: **主→同族备用→转人工**。不跨族降级(避免行为不一致)。同族备用可能和主端同时挂(同服务商故障), 但比跨族降级的成本跳升和行为差异风险小。
> 5. **编排+领域专长表达(v1)**: **单一主 agent + skills 启用 + prompt 显式点名语言专长**。主 agent 不设 `skills:[]`, 挂载已有 java-coding-standards/springboot-tdd 等 skill; prompt 显式点名“处理 Java 单测失败时先读 java-coding-standards”。R2 证实的交互式玩法(LLM 匹配 + 点名兑底)。风险: headless 无人接住“模型没读 skill”的失败——靠修复后验证关卡 + MR review 兑底。
>
> **演进接缝(spec 写明, 非本票 detail)**:
> - **触发条件**: context 压力超阈值 / 失败涉及多模块 / 诊断与修复能力需求差异大到单模型扣不住时 → 拆 subagent。
> - **机制**: 拆后主 agent prompt 变编排逻辑, 诊断/修复/文档三段分别搬到三个 `AgentDefinition` subagent(各自 per-subagent model + skills); 诊断结论作为结构化输入传给修复 subagent(避免跨模型一致性脱节); skill 迁移到 `AgentDefinition.skills` 作子代理知识源。R2 #14882 未知: subagent 内 skill 是否受全量加载回归影响待实测。
>
> **预算控制**: **双层**——subagent `max_turns`(防循环) + 全局 `max_budget_usd`(防失控)。两者默认均无限制, **必须显式设**。R1 事实: `max_budget_usd` 是 session 级非 per-subagent, subagent 开销累加到全局。
>
> **待实测验证项(写入 spec)**:
> - `allowed_tools`/`tools` bug (#361/#115/#172) 在当前 PyPI 版本修复状态——应使用 `tools` 字段做白名单。
> - `ANTHROPIC_BASE_URL` 在 `options.env` 中传递可靠性 (#677)。
> - DeepSeek thinking mode + tool calls 多轮 `reasoning_content` 必须回传(#1378)。
> - `maxTurns` frontmatter 不生效 (#41143)。
> - subagent 内 `skills` 是否受 #14882 影响。
>
> Resolution 详情存本票; 无单独 brief 文件(决策本身即产出)。

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
