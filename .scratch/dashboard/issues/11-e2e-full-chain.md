# 11 — E2E: full dashboard data flow

**What to build:** 端到端验证完整数据流：webhook → scheduler → worker (IPC) → EventHub → SSE → 验证事件序列。

**Blocked by:** 06

- [ ] 复用现有 e2e 测试范式（真实子进程 + fake deps + sidecar JSON）
- [ ] 新增 e2e 测试：发 webhook → 验证 SSE stream 收到 `pipeline_enqueued` → `worker_started` → `worker_progress`(stage/turn) → `worker_done`
- [ ] 验证 `/api/status` 在 worker 运行中返回 `scheduler.running = 1`
- [ ] 验证 `/api/decisions` 在转交后返回 awaiting_decision 记录
- [ ] 验证 `/api/metrics` 在修复完成后指标更新
- [ ] 不测前端渲染（前端 e2e 超出 v1 scope）
