# 07 — Invalidation：新 pipeline 作废旧决策

**What to build:** webhook receiver 收到同 projectId 新 pipeline 时，自动 invalidate 旧 awaiting_decision + 清理现场 + 群通知。防止在过时 sha 上修复。

**Blocked by:** 03, 04

**Status:** ready-for-agent

- [ ] DecisionStore 新增 invalidateByProject(projectId)：将该项目所有 awaiting_decision 标记为 invalidated，返回被作废的 decision 列表
- [ ] lifecycle 模块暴露 onNewPipeline(event) hook：调用 invalidateByProject + 对每个被作废决策清理现场 + routed 通知"决策已作废（新 pipeline #N 到达）"
- [ ] webhook receiver 在 enqueue 成功后调用 onNewPipeline
- [ ] 已终态决策（resumed/closed/dropped/expired）不受影响
- [ ] unit test：mock store + notifier，验证 invalidation 触发 + 清理 + 通知
