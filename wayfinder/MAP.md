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
- [R4: pi 作为 bot 骨架](tickets/R4-pi-as-bot.md) — 事实: 第三方模型**全覆盖原生**(DeepSeek/Kimi/OpenRouter→Qwen/Bedrock/Vertex/Ollama/vLLM, 三候选最完整); headless 四入口(-p/--mode json/rpc/SDK)但**无原生 max_turns/max_tokens 硬上限**(issue#1898, 须 SDK 自建~50-100行); 无内置 subagent 但多进程隔离干净; skill**零迁移**复用, `/skill:name` 确定性加载, skillsOverride 精确控; 本地+.m2 契合高(无沙箱天然访问宿主FS, 建议容器内跑)。迁移代价最低但非零: 预算控制+并发编排+CI胶水~300-500行。
- [G6: SDK+模型选型决策](tickets/G6-model-selection.md) — 决策: SDK=**Claude Agents SDK**; v1=**单 agent + 单主模型 + skills 启用 + prompt 点名语言专长**(多模型路由降级演进目标); provider=**直连兼容端点**(DeepSeek anthropic/Ollama); fallback=**主→同族备用→转人工**; 预算=**双层(subagent max_turns+全局 max_budget_usd)**。演进接缝: context超阈值/多模块时拆 subagent, skill 迁到 AgentDefinition.skills。待实测: allowed_tools bug/#677/#1378/#41143/#14882-subagent。
- [G1: 单测失败分类法](tickets/G1-failure-taxonomy.md) — 决策: 5 类根因分类, v1 **只自动修 1/2/3** (测试 bug/被测变更致过时/测试缺失), **4 环境 flaky + 5 非单测根因 转交不修**(原则: 根因可能不在本服务一律不碰)。判定信号=CI日志摘要+本地执行双源; 渠道选择归 G2。**类别 3 升级**: 按 spec/PRD 补规格符合性测试(非"补到代码能跑", 避免固化 bug); spec=仓库内 spec 目录; 代码不符 spec 或 spec 不可读→转交人工。类别 2 文档同步=行为变更时触发, 判定留给 G2。
- [G2: 诊断与修复路由/编排](tickets/G2-routing-orchestration.md) — 决策: v1 单连续 session(bot 代码做前后确定性事+agent 中间连续跑)。渠道=**混合**(glab 取元数据+本地 clone 执行)。pipeline: webhook→glab取日志/diff→粗筛类别5早转交→起 ClaudeSDKClient→agent 诊断+修复+文档→验证(相关测试+全量双层)→开 MR。验证遇 flaky=标记 skip+独立钉钉通知。修不动=直接转人工(MR 带诊断摘要)。**新维度**: 钉钉主动推送(转人工/异常/成功三类, 与 MR 解耦)。spec 读写时序: 诊断阶段读/修复后阶段写。
- [G3: 每类失败的修复策略](tickets/G3-repair-strategies.md) — 决策: **权限边界=只改测试和文档，绝不改被测代码**(与 G1 原则一致; 被测代码 bug→转交)。类别1/2: 改断言/期望/mock值+**轻量重构测试结构**(用户选, 风险: LLM 重构引入新 bug, 演进接缝=频发则收回)。类别3: 按 spec 补规格符合性测试, 只补失败相关路径。类别2文档同步: 只动变更相关段落。review 强度=强制人工(G6定)。验证=相关+全量双层(G2定)。

## Not yet specified

<!-- 向 destination 的雾：能感到要来但还钉不精确的问题。随 frontier 推进逐片 graduate 为 ticket -->

- **语言适配层具体设计**：G6 已定调 v1=单 agent + skills 启用 + prompt 点名(挂载已有 java-coding-standards/springboot-tdd); 演进=拆 subagent, skill 迁到 AgentDefinition.skills。具体设计依赖 G2 pipeline 形状, 作为 G2 下游处理。R2 #14882 未知(subagent 内 skill 是否受全量加载回归影响)待实测。
- **本地执行形态的依赖复用**：用户要求本地执行时复用 .m2。pi 无沙箱天然访问宿主 FS(R4 证实),但安全建议容器隔离。具体方案依赖 G5(沙箱)+G7(部署) grilling。
- **成本估算**：依赖模型选型(G6)+ 并发规模(G4)。模型选型已落地(G6: 单主模型+provider配置), 但并发规模未定。G4 落地后 graduate; 单次修复 token 量级 + 并发峰值成本两项可同时算。
- **每类失败的具体修复策略**: G1 分类法 + G2 路由均已落地。具体修复策略(每类的改动边界/验证要求/禁止动作)已 graduate 为 **G3**, 不再是 fog。
- **部署形态细节**（runtime/容器/编排栈）：长驻服务大方向已定，具体栈依赖 G4（worker 供给）+ G6（模型，影响 runtime）落地。G7 会先搭框架。
- **文档不一致检测的精度**：大方向"仅行为变更时顺带",但"行为变更"如何判定（签名 diff? 语义比对?)依赖 G2 路由结论。
- **spec/PRD 格式与可读性判定**: 类别 3 要求按 spec 补测试, spec 位置已定(仓库内 spec 目录), 但格式(结构化 Markdown? OpenSpec? 自由文档?)与"spec 可读"的判定信号未定。依赖 G2 pipeline 设计。

## Out of scope

<!-- destination 之外的工作。闭票后在此留一行 gist + why，不放 Decisions so far -->

- **bot 的实现与部署（目的地形态 A）**：本 map 产出 spec；把 spec 变成跑起来的系统是下一个 effort。
- **非单测类 CI 失败**（lint / build / typecheck / integration / e2e）：v1 只做单测失败，其余按用户"窄→宽"偏好作为后续扩展。
- **自动合并 MR**：用户选人工 review 关卡。
- **主动覆盖率巡检补全单测**：用户选被动（仅 CI 失败时附带补）。
- **多 CI 平台抽象**：v1 只做 GitLab CI；GitHub Actions 等是后续扩展。
