# Map: CI 单测自愈 Bot 设计 spec

> **wayfinder:map** — 本 effort 的 canonical artifact。这是一个 **index**，不是 store：决策只活在它的 ticket 里，这里只 gist + 链接。
>
> Tracker = local-markdown。ticket 在 `wayfinder/tickets/`，阻塞关系写在 ticket body 的 `Blocked by` 字段（无原生依赖 UI）。frontier = open + unblocked + unclaimed 的 ticket。

## Destination

一份**完整的 spec / 设计文档**，覆盖：GitLab webhook 触发 → 单测失败诊断 →（经 skill/MCP 的）修复/补全单测 → 行为变更时顺带同步文档 → 开 MR（人工 review）的全闭环；含 agent SDK 层（候选：Claude Agents SDK / Codex SDK / pi 本身——选型开放，待 R1–R4 对比矩阵后于 G6 决策）+ 第三方模型层、每项目独立 worker 并发模型、部署与运维、安全边界。实现（跑起来的 bot）是**后续 effort**，不在本 map 范围。

## Notes

- **领域**：CI 自愈 / 自动作单测修复 / 文档同步。
- **迭代偏好（用户明确）**：窄→宽。v1 先单测失败，lint/build/typecheck/integration 是后续扩展；先 spec(B) 再实现(A)。
- **每个 session 应consult的 skill**：`/grilling`（HITL 决策）、`/domain-modeling`（术语与 ADR）、`/research`（research ticket）。语言专长经 **pi skill + MCP** 注入，相关：java-coding-standards / springboot-tdd / springboot-patterns / python-patterns / python-testing（按目标语言）。
- **关键技术约束**：bot 跑在 **agent SDK** 上（候选：Claude Agents SDK / Codex SDK / pi 本身——选型开放，待 R1–R4 对比）；headless、无人值守、多项目并发；模型走第三方 OpenAI 兼容协议方向（各候选 SDK 支持度待研究）；本地执行形态须能复用宿主 .m2/依赖（与沙箱隔离有张力，G5 grilling）。
- **反例提醒**：交互式 pi session 的 skill 是"人按需加载 markdown 进 context"；headless 并发 bot 要确定性选 skill、控 context 预算、处理 MCP 的 auth/rate-limit/状态——这是工程问题，R1 专门研究。
- **安全前提**：bot 执行 LLM 生成的代码/测试，须沙箱化（G5）。

## Decisions so far

<!-- index: 一行 gist + 链接到 ticket 的 detail。决策只活在 ticket 里 -->

- [R1: Claude Agents SDK 能力边界](tickets/R1-sdk-capabilities.md) — 事实: 第三方模型靠 env 重定向(非原生 provider); headless via `query()`+`max_turns`/`max_budget_usd`(无内置重试, 默认无限制须显式设); 多并发隔离有四条泄漏通道须显式配; `allowed_tools` 有 bug 用 `tools` 字段。未知: 多个 bug 在当前 PyPI 版本修复状态待实测。
- [R2: Claude SDK skill/MCP headless 消费](tickets/R2-skill-mcp-headless.md) — 事实: SDK skill 与交互式同款但 LLM 自主触发非确定; headless 领域专长首选 **subagent(AgentDefinition)** 非 skill; 确定性工具首选 **in-process MCP server**; MCP headersHelper bug(#64894) 阻塞预置 token 路径; skill 全量加载回归(#14882) 威胁 context。推荐: 主 agent `skills:[]`+显式路由 subagent+in-process MCP。
- [R3: Codex SDK 能力边界](tickets/R3-codex-sdk.md) — 事实: Codex 三层(CLI/App Server / Agents SDK / Responses API)差异大; Codex CLI **2026.02 弃用 chat/completions 仅留 responses** → DeepSeek/Qwen/Kimi 无法直连(硬伤); Agents SDK 模型支持最广(原生 chat/completions 适配器)但并发有 ContextVar bug(#2246); Codex 有 Skills(feature-flagged) 与 pi 兼容但触发非确定; Agents SDK 无原生 skill。迁移: →Codex Skills 中度, →Agents SDK 中高。

## Not yet specified

<!-- 向 destination 的雾：能感到要来但还钉不精确的问题。随 frontier 推进逐片 graduate 为 ticket -->

- **语言适配层具体设计**：内核语言无关、语言专长经 skill/MCP 注入——但 headless 下"怎么选/怎么调/调失败怎么办"的具体机制依赖 R1–R4 的跨 SDK 对比结论。R1–R4 落地后 graduate。
- **本地执行形态的依赖复用**：用户要求本地执行时复用 .m2。本地 vs 容器部署、.m2 只读挂载 vs 隔离的具体方案，依赖 G5（沙箱）+ G7（部署）grilling。
- **成本估算**：依赖模型选型（G6）+ 并发规模（G4）。两者落地后 graduate。
- **每类失败的具体修复策略**：依赖 G1（分类法）+ G2（路由）落地后逐类 graduate。
- **部署形态细节**（runtime/容器/编排栈）：长驻服务大方向已定，具体栈依赖 G4（worker 供给）+ G6（模型，影响 runtime）落地。G7 会先搭框架。
- **文档不一致检测的精度**：大方向"仅行为变更时顺带"，但"行为变更"如何判定（签名 diff? 语义比对?）依赖 G2 路由结论。

## Out of scope

<!-- destination 之外的工作。闭票后在此留一行 gist + why，不放 Decisions so far -->

- **bot 的实现与部署（目的地形态 A）**：本 map 产出 spec；把 spec 变成跑起来的系统是下一个 effort。
- **非单测类 CI 失败**（lint / build / typecheck / integration / e2e）：v1 只做单测失败，其余按用户"窄→宽"偏好作为后续扩展。
- **自动合并 MR**：用户选人工 review 关卡。
- **主动覆盖率巡检补全单测**：用户选被动（仅 CI 失败时附带补）。
- **多 CI 平台抽象**：v1 只做 GitLab CI；GitHub Actions 等是后续扩展。
