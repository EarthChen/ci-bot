# 09 — 一轮介入限制：二次转交终局

**What to build:** resume 执行后 agent 再次 escalated → 终局通知，不生成新决策、不保留现场。防止人机拉锯。

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] run-resume 中 agent 再次 escalated 时：不走 isDecidableEscalation 路径，直接 finishRepair（清理现场 + routed 终局通知）
- [ ] 终局通知消息体标明"人工介入后仍无法修复，请人工接手"
- [ ] audit 记录 chainDepth=1
- [ ] 不产生新 awaiting_decision
- [ ] integration test：resume 后 escalated → 终局通知 + 清理 + store 无新记录
