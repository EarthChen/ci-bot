# 12 — ADR-0010 + CONTEXT.md + AGENTS.md update

**What to build:** 记录 Dashboard 架构决策为 ADR-0010，更新领域词汇表和项目元信息。

**Blocked by:** 01（或可与 01 并行）

- [ ] `docs/adr/0010-real-time-dashboard.md`：记录同进程部署、IPC + SSE 推送、monorepo 前端、无认证等关键决策及 rationale
- [ ] `CONTEXT.md` 新增词汇：Dashboard、EventHub、IPC event、SSE、SystemSnapshot、MetricsAggregator
- [ ] `AGENTS.md` Architecture 部分新增 `src/dashboard/` + `packages/dashboard/` 说明
- [ ] `AGENTS.md` Commands 部分更新 `pnpm build` 说明（含 dashboard）
