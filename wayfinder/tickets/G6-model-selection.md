# G6: SDK + 模型选型决策

> **wayfinder:grilling** · 状态: ✅ closed · 类型: HITL（需用户在线，/grilling）· assignee: 当前 session
>
> **Blocked by**: R1, R2, R3, R4（均已 closed，解锁本票）
>
> **Resolution**: SDK + 模型选型决策已定(含 session 后两次 amendment)。**v1 核心 SDK = pi**(从 Claude SDK 翻转, 理由见下)。
>
> ## 基础决策
>
> 1. **SDK 骨架**: **pi**(v1 核心)。翻转理由: G6 后续决策让 Claude SDK 主优势(subagent)在 v1 闲置(pi-subagents extension 可补), 而 pi 优势全是 v1 直接要用的——(a) skill 确定性加载(`/skill:name` 显式命令) vs Claude SDK LLM 语义匹配非确定; (b) skill 零迁移(已有 java-coding-standards/springboot-tdd 原样挂载) vs Claude SDK 重构为 AgentDefinition prompt; (c) 全原生模型覆盖(DeepSeek/Kimi/Qwen/Bedrock/Vertex/Ollama/vLLM) vs Claude SDK 必须 Anthropic Messages API + Kimi/Qwen 代理; (d) 本地+.m2 天然契合(无沙箱访问宿主 FS)。**真实代价(接受)**: 无原生 max_budget_usd 硬上限(issue#1898), 须自建软上限(turn_end 监控+session.abort)。**修正 R4 定性**: pi-subagents 非"无内置", 是 pi 标准 extension(MIT, 本 session 已验证可用, 支持 chain/parallel/async/per-agent model/skills)。
> 2. **主模型策略**: v1 **单一主模型**(多模型路由降级为演进目标)。原因: v1 单 agent 无路由点, Q2 选的 B(多模型路由+subagent 编排)暂不落地。演进触发条件见下。
> 3. **Provider 接入**: **直连**(pi 原生 provider 配置)。DeepSeek 官方 API + Kimi(For Coding) + OpenRouter(路由 Qwen) + Ollama 本地。pi models.json 声明式配置 + env 插值 + InMemoryCredentialStore。无需代理层。
> 4. **Fallback 链**: **主→同族备用→转人工**。不跨族降级(避免行为不一致)。同族备用可能和主端同时挂(同服务商故障), 但比跨族降级的成本跳升和行为差异风险小。
> 5. **编排+领域专长表达(v1)**: **单一主 agent + skills 启用 + `/skill:name` 确定性加载**。主 agent 挂载已有 java-coding-standards/springboot-tdd; prompt 显式点名"处理 Java 单测失败时先读 java-coding-standards" + `/skill:name` 强制加载(双重保险)。skill 零迁移复用。**对比 Claude SDK**: pi 的 `/skill:name` 是确定性命令加载, 比 Claude SDK LLM 语义匹配更确定(直接缓解 G2 #1 headless 风险)。
>
> ## Amendment (session 后补充)
>
> 6. **实现语言**: **TypeScript**。理由: 主流 SDK(Claude SDK / pi / Codex)都有 TS 版本, 是跨 SDK 最大公约数; 切 SDK 不换语言(import 替换), 直接对冲用户对 SDK 受限的担忧。AGENTS.md "默认 Python"仅适用脚本场景, 长驻服务不适用(用户澄清)。Node 依赖管理用 pnpm(AGENTS.md 禁 npm/yarn)。pi SDK API: `createAgentSession`(Node.js)。
> 7. **MCP 形态**: **外部服务**(stdio 子进程 或 HTTP 远程), 不用 in-process SDK MCP server。理由(用户决策): MCP 本就是外部服务定位。级联: MCP 协议语言无关, bot(TS) 调 TS/Py/任何语言的 MCP server 均可。代价: 多一层子进程生命周期管理, 但分钟级修复耗时下 IPC 毫秒开销可忽略。pi 无内置 MCP 但 extension 可注册 OAuth/自定义 provider。
> 8. **SDK 可换性**: **写死 pi(TS) 具体设计 + 演进接缝标 Claude SDK 替代**。不抽象到最小公约(会降级失 pi 的确定性 skill/零迁移/全模型覆盖独特能力)。**切回 Claude SDK 成本**: 语言/MCP/通知/pipeline 编排层零成本(都不动); 最大成本=skill 表达范式转换(pi `/skill:name` 确定性→Claude SDK AgentDefinition prompt + LLM 语义匹配, 从确定到非确定); 预算控制是增益(拿回原生 max_budget_usd 硬上限)。
>
> ## 演进接缝(spec 写明, 非本票 detail)
>
> - **拆 subagent 触发**: context 压力超阈值 / 失败涉及多模块 / 诊断与修复能力需求差异大到单模型扣不住时 → 拆 subagent。机制(pi): 用 pi-subagents extension 的 AgentDefinition(per-agent model + skills + 独立 context); 诊断结论结构化输入传给修复 subagent; skill 仍用 `/skill:name` 在 subagent scope 内确定性加载。
> - **换 SDK 触发**: pi 自建预算软上限超支频发(单 turn 内超支不可控) → 切回 Claude SDK 拿回 max_budget_usd 硬上限。替代: `/skill:name`→AgentDefinition prompt(从确定到非确定, 接受退化), 零迁移 skill→重构为 subagent prompt, MCP 外部服务不变, 语言/pipeline 不变。
>
> ## 预算控制
>
> **双层**——subagent `max_turns`(防循环, pi-subagents 支持) + **全局预算(防失控, pi 自建)**。pi 无原生 max_budget_usd, 自建方案: SDK 监听 `turn_end` 事件 + 累计 token 超阈值调 `session.abort()` + 钉钉告警。**软上限风险(标注)**: abort 在 turn 结束后触发, 单 turn 内可能已超支(如大 tool call)。缓解: 设激进的单 turn token 阈值 + 超限即 abort + 钉钉告警。演进接缝: 超支频发→切回 Claude SDK 硬上限。
>
> ## 待实测验证项(写入 spec)
>
> - pi 自建预算控制(turn_end + abort)在单 turn 超支场景的实际刹车效果。
> - pi-subagents extension 的 per-agent model override + skills 在 headless 并发下的稳定性。
> - `/skill:name` 在 RPC/SDK `prompt()` 中是否可靠展开(R4 gap)。
> - pi 同进程多 AgentSession 并发的事件总线隔离(R4 gap)。
> - stdio MCP 通过 env 传 token(pi 无内置 MCP, extension OAuth 路径)。
> - DeepSeek thinking mode + tool calls 多轮 reasoning_content 必须回传(#1378, 跨 SDK 通用)。
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
