# G2: 诊断与修复的路由/编排设计

> **wayfinder:grilling** · 状态: ✅ closed · 类型: HITL（需用户在线，/grilling）· assignee: 当前 session
>
> **Blocked by**: R1, R2, R3, R4, G1（均已 closed，解锁本票）
>
> **Resolution**: v1 单 agent 诊断-修复编排路径已定。骨架: **bot 代码做前后确定性的事，agent 在中间连续跑**。
>
> ## Pipeline 形状 (v1)
>
> ```mermaid
> flowchart TD
>   A[GitLab webhook 收到单测失败事件] --> B[bot: glab 取 CI 日志+MR diff+pipeline 状态]
>   B --> C{bot: 关键词粗筛类别5?}
>   C -- 编译/依赖错 --> Z1[转交 out of scope, 钉钉通知]
>   C -- 是 test failure --> D[bot: 本地 clone + 起容器 + 注入 .m2]
>   D --> E[bot: 起 ClaudeSDKClient session, max_turns+max_budget_usd 显式设]
>   E --> F[agent: 读 CI 日志+diff+源码, 分类 G1 1/2/3]
>   F -- 类别4 flaky/环境 --> Z2[转交不修, 钉钉通知]
>   F -- 类别1/2/3 --> G[agent: 读 spec(类别3) + 修复/补测试, prompt 点名 java-coding-standards]
>   G --> H{agent: 被测代码行为变更?}
>   H -- 是 --> I[agent: 同步 spec/文档]
>   H -- 否 --> J
>   I --> J[bot: 验证关卡 - 相关测试快反馈+全量兑底]
>   J --> K{验证结果}
>   K -- 全绿 --> L[bot: 开 MR 带修复摘要, 钉钉通知成功]
>   K -- 遇别的 flaky --> M[标记 @Skip/@Disabled + 独立钉钉通知, 不混入本次 MR]
>   K -- 修不动/重试仍失败 --> N[转人工, MR 带未完成标记+诊断摘要, 钉钉通知]
> ```
>
> ## 子决策
>
> 1. **信息获取渠道**: **混合** — glab 取结构化元数据(CI 日志/MR diff/pipeline 状态, 快判定), 本地 clone+执行做复现/读源码/spec/git blame/跑测试(深诊断)。两套认证(GitLab token 注入 worker, G5 处理)。本地复现失败→类别4转交路径。
> 2. **session 形态**: **单连续 session** — bot 调一次 ClaudeSDKClient, agent 在同一 context 完成诊断+修复+文档。诊断结论在 context 内天然传递, 无跨模型脱节风险。演进触发条件: 诊断耗大半预算致修复被截断 / 失败涉及多模块 → 拆 subagent(演进接缝已定于 G6)。
> 3. **skill 触发(v1, G6 已定调)**: 单 agent + skills 启用, prompt 显式点名"处理 Java 单测失败时先读 java-coding-standards"。LLM 匹配+点名兑底。风险: headless 无人接住"模型没读 skill"→靠验证关卡+MR review 兑底。
> 4. **验证关卡**: **双层** — 先跑失败相关测试模块快反馈, 绿了再跑全量单测兑底防回归。flaky 处理: 标记 @Skip/@Disabled + 独立钉钉通知, 不混入本次修复 MR。
> 5. **失败回退**: **修不动直接转人工** — LLM 主动放弃/max_turns 到/重试 1 次仍失败 → 立即转人工, 不多次重试。MR 仍开(带未完成标记+诊断摘要)供人接手。
> 6. **通知机制(新维度, 用户补充)**: **钉钉主动推送**, 与 MR 解耦。转人工/异常/修复成功三类事件都发钉钉。spec 单列"通知机制"章节。
>
> ## spec 读写时序
>
> - 读 spec: 诊断阶段(类别3 按规格补测试时, agent 读仓库内 spec 目录)
> - 写 spec: 修复后阶段(类别2 被测代码行为变更时, agent 同步 spec)
> - spec/PRD 既是输入又是输出, 时序在 pipeline 内自然分离
>
> ## 待实测验证项(接入 spec)
>
> - glab 取 CI 日志/MR diff 的 API 限流与重试策略。
> - 本地 clone 大仓库的 shallow depth 与 git blame 的兼容性(blame 需 history)。
> - 容器内跑 mvn test + .m2 挂载的具体方案(G5/G7 未定, G2 先标依赖)。
>
> Resolution 详情存本票; 无单独 brief 文件(编排流程图即产出)。

## Question

bot 收到一次单测失败事件后，从"事件 → 修好"的**编排路径**怎么走？这是 spec 的中枢章节。

具体要 grilling 出：
1. **pipeline 形状**：取日志/diff → 分类（G1）→ 跑修复（含 prompt 点名语言 skill）→ 验证 → 同步文档（若行为变更）→ 开 MR。v1 单 agent 下每步是 bot 自己的代码调用 SDK（单 `query()`/`ClaudeSDKClient`），不是多 subagent 派发。**演进接缝**：spec 写明何时拆 subagent（context 压力超阈值/失败涉及多模块），拆后 pipeline 形状怎么变。
2. **skill 触发机制（v1）**：单 agent + skills 启用，prompt 显式点名“处理 Java 单测失败时先读 java-coding-standards”。LLM 匹配 + 点名兑底（R2 证实的交互式玩法）。**风险**：headless 无人接住“模型没读 skill”的失败——靠修复后验证关卡 + MR review 兑底。演进到多 subagent 后 skill 迁移到 `AgentDefinition.skills`。
3. **失败/回退**：某步失败（LLM 修不动、skill 不可用、重试 N 次仍失败）的降级策略——是放弃本次、转人工、还是换策略？
4. **验证关卡**：修复后必须本地重跑单测全绿才开 MR？还是只跑相关测试？flaky 怎么处理？

## 产出

编排流程图（Mermaid）+ 每步的输入/输出/可调用组件/失败降级。归档 `research/g2-routing.md`。
