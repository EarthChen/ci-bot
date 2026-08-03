# G2: 诊断与修复的路由/编排设计

> **wayfinder:grilling** · 状态: open · 类型: HITL（需用户在线，/grilling）· assignee: unclaimed
>
> **Blocked by**: R1, R2, R3, R4（需跨 SDK 对比 + skill/MCP 形态结论定调路由机制）, G1（需失败分类法）

## Question

bot 收到一次单测失败事件后，从"事件 → 修好"的**编排路径**怎么走？这是 spec 的中枢章节。

具体要 grilling 出：
1. **pipeline 形状**：取日志/diff → 分类（G1）→ 选 skill/策略 → 跑修复 → 验证 → 同步文档（若行为变更）→ 开 MR。每步是 SDK subagent、MCP 工具、还是 bot 自己的代码？
2. **skill 选择机制**：headless 下选哪个 skill 处理哪类失败——显式路由规则 vs 让 agent 自主选。各自风险、推荐方案。**依赖 R2**。
3. **失败/回退**：某步失败（LLM 修不动、skill 不可用、重试 N 次仍失败）的降级策略——是放弃本次、转人工、还是换策略？
4. **验证关卡**：修复后必须本地重跑单测全绿才开 MR？还是只跑相关测试？flaky 怎么处理？

## 产出

编排流程图（Mermaid）+ 每步的输入/输出/可调用组件/失败降级。归档 `research/g2-routing.md`。
