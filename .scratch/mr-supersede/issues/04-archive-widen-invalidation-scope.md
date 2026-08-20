# 04 — Session 存档放宽 + 决策作废收窄

**What to build:** session 的知识寿命对齐 MR 寿命：所有终局（开出 MR / 转交 / 失败）与决策作废时刻都存档 session；待决策现场被同 MR 新 pipeline 作废时先存档再清现场。决策作废范围从按 project 收窄为按 MR，跨 MR 不再误伤。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 存档触发条件放宽为所有终局 + 决策作废时；存档键、LRU 上限、latest-wins 语义不变
- [ ] awaiting decision 现场作废时先存档 session 再清现场；存档失败不阻塞作废流程（降级记录日志）
- [ ] 决策作废收窄到 MR：MR-B 的新 pipeline 不作废 MR-A 的待决策；同 MR 新 pipeline 仍作废其待决策
- [ ] e2e：失败终局后同 MR 下一 pipeline 的审计出现 session 复用记录；跨 MR 作废不再发生
