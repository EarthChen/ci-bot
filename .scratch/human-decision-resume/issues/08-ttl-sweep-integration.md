# 08 — TTL sweep 集成 + 超时通知

**What to build:** 主进程定时驱动 TTL sweep，过期决策自动 expired + 清理现场 + 群通知"已超时关闭"。

**Blocked by:** 01, 04

**Status:** ready-for-agent

- [ ] lifecycle 模块暴露 startTtlSweep(intervalMs)：定时器调用 DecisionStore.sweepExpired()，对每个被清扫决策清理现场 + routed 通知
- [ ] CIHEAL_DECISION_TTL_MS 环境变量可配（默认 24h）
- [ ] main.ts wire：启动时 startTtlSweep
- [ ] sweep 频率建议每分钟一次（与现有 retention sweep 对齐）
- [ ] unit test：mock clock + store + notifier，验证 TTL 到期触发 + 清理 + 通知
