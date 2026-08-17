# 06 — Resume worker：session 恢复 + pipeline 后半段

**What to build:** 新 worker 以 resume 模式 spawn，SessionManager.open 恢复原 session，注入决策+备注，走 extractPatch → G3 → verify → createMR → notify 完整后半段。预算独立 200k。

**Blocked by:** 05

**Status:** done (commit d1d88e3)

- [ ] CIHEAL_WORKER_TASK schema 扩展：新增 mode: "repair" | "resume"，resume 时携带 decision_id/session_path/cwd/decision_value/remark
- [ ] worker entry.ts 新增 resume 分支：SessionManager.open(session_path) 重建会话，构造决策 prompt 注入
- [ ] run-resume 编排：跳过 CI log fetch + agent.run，直接从 agent.continue(decision_prompt) 开始，然后走 extractPatch → G3 validate → verifyTestsGreen → createMR → finishRepair
- [ ] 预算独立 200k（不继承首轮）
- [ ] audit-trace 新增 cumulativeTokens / chainDepth 字段
- [ ] integration test：StubAgentRunner resume 模式 + fake glab/dingtalk，验证 session 恢复 + MR 产出
