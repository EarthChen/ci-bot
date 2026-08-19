# 03 — API: /api/decisions (decision list)

**What to build:** Fastify `GET /api/decisions` 只读端点，返回 decisions.db 中的决策记录。支持按 status 过滤。Tracer bullet：`curl /api/decisions?status=awaiting_decision` 返回 JSON 数组。

**Blocked by:** None

- [ ] `src/dashboard/routes.ts`：注册 `/api/decisions` GET 路由
- [ ] query param `status`（可选，默认返回全部）
- [ ] 响应 schema：`DecisionSummary[]`（decision_id, pipeline_id, project_id, status, created_at, expires_at, decided_by, decision_value, oos_paths）
- [ ] 调用现有 `decisionStore.listByStatus()` 或新增 `listAll()` 方法
- [ ] 不暴露 event_json / cwd_path / session_path（内部路径不应推到前端）
- [ ] integration test：写入测试决策 → inject 查询 → 验证响应
