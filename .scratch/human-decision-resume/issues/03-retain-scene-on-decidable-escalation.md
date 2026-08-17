# 03 — 现场保留：可决策 escalated 跳过清理

**What to build:** agent 主动 escalated 时 worktree/cwd/branch 不被删除，决策注册到 DecisionStore；非可决策 escalated 保持原有清理行为。端到端可验证：escalated 后 cwd 仍存在、decision store 有记录。

**Blocked by:** 01, 02

**Status:** ready-for-agent

- [ ] finishRepair 接收 `decidable` 标志；为 true 时跳过 removeWorktree + 保留 cwd
- [ ] runRepair 在 isDecidableEscalation 为 true 时：生成 decision_id（D-<pipelineId>-<rand4>），写入 DecisionStore（status=awaiting_decision, expires_at=now+TTL），跳过 finishRepair 的 notifyEscalation
- [ ] 非可决策 escalated 保持原有 finishRepair 行为（清理 + worker 自通知）
- [ ] worker manager 的 finally 清理逻辑感知 decidable 标志：decidable 时跳过 cwd 删除和 branch 删除
- [ ] integration test：可决策 escalated → cwd/worktree/branch 保留 + store 有记录；非可决策 → 原有清理不变
