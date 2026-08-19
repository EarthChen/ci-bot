# 05 — EventHub + SSE endpoint

**What to build:** 主进程 EventHub 组件：接收内部状态变化事件，维护系统快照，通过 SSE 推送到浏览器。Tracer bullet：浏览器 `EventSource('/api/events')` 收到 `snapshot` 事件 + 后续 `pipeline_enqueued` 事件。

**Blocked by:** 02（需要 status 数据结构）

- [ ] `src/dashboard/event-hub.ts`：`EventHub` 类
- [ ] `addClient(res)`：注册 SSE 客户端，立即推 `snapshot` 事件
- [ ] `removeClient(res)`：客户端断开时移除
- [ ] `emit(event)`：向所有客户端推送增量事件
- [ ] `updateSnapshot(partial)`：更新内部快照状态
- [ ] SSE 格式：`event: <type>\ndata: <json>\n\n`
- [ ] `src/dashboard/routes.ts`：`GET /api/events` 路由，设置 SSE headers（`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`），调用 `eventHub.addClient(reply.raw)`
- [ ] 心跳：每 30s 发 `:keepalive\n\n` 防止代理/负载均衡器超时断连
- [ ] 客户端 `close` 事件清理
- [ ] 在 scheduler 的 enqueue/complete/crash 钩子处 `eventHub.emit()`
- [ ] 在 decision lifecycle 的 create/resolve/invalidate 处 `eventHub.emit()`
- [ ] integration test：Fastify inject SSE → 验证收到 snapshot + 模拟事件后收到增量
