# G2: 诊断与修复的路由/编排设计

> **wayfinder:grilling** · 状态: open · 类型: HITL（需用户在线，/grilling）· assignee: unclaimed
>
> **Blocked by**: R1, R2, R3, R4（需跨 SDK 对比 + skill/MCP 形态结论定调路由机制）, G1（需失败分类法）

## Question

bot 收到一次单测失败事件后，从"事件 → 修好"的**编排路径**怎么走？这是 spec 的中枢章节。

具体要 grilling 出：
1. **pipeline 形状**：取日志/diff → 分类（G1）→ 跑修复（含 prompt 点名语言 skill）→ 验证 → 同步文档（若行为变更）→ 开 MR。v1 单 agent 下每步是 bot 自己的代码调用 SDK（单 `query()`/`ClaudeSDKClient`），不是多 subagent 派发。**演进接缝**：spec 写明何时拆 subagent（context 压力超阈值/失败涉及多模块），拆后 pipeline 形状怎么变。
2. **skill 触发机制（v1）**：单 agent + skills 启用，prompt 显式点名“处理 Java 单测失败时先读 java-coding-standards”。LLM 匹配 + 点名兑底（R2 证实的交互式玩法）。**风险**：headless 无人接住“模型没读 skill”的失败——靠修复后验证关卡 + MR review 兑底。演进到多 subagent 后 skill 迁移到 `AgentDefinition.skills`。
3. **失败/回退**：某步失败（LLM 修不动、skill 不可用、重试 N 次仍失败）的降级策略——是放弃本次、转人工、还是换策略？
4. **验证关卡**：修复后必须本地重跑单测全绿才开 MR？还是只跑相关测试？flaky 怎么处理？

## 产出

编排流程图（Mermaid）+ 每步的输入/输出/可调用组件/失败降级。归档 `research/g2-routing.md`。
