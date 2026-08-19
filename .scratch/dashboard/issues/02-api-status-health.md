# 02 — API: /api/status (health + scheduler stats)

**What to build:** Fastify `GET /api/status` 只读端点，返回 bot 进程健康信息 + scheduler 队列状态。Tracer bullet：`curl /api/status` 返回 JSON。

**Blocked by:** None

- [ ] `src/dashboard/routes.ts`：注册 `/api/status` GET 路由
- [ ] 响应 schema：`{ health: { uptime, memoryMB, version, nodeVersion }, scheduler: { running, queued, inflight } }`
- [ ] `uptime`：`process.uptime()`；`memoryMB`：`process.memoryUsage().rss / 1e6`；`version`：读 `package.json`
- [ ] `scheduler`：调用现有 `scheduler.stats()`（需在 main.ts 将 scheduler 引用传入 routes）
- [ ] `src/dashboard/types.ts`：类型定义
- [ ] integration test：Fastify inject `/api/status`，验证 JSON 格式 + 字段存在
