# 07 — Dashboard: Overview page

**What to build:** Dashboard 全景概览页面，展示健康状态、队列/worker 全景、活跃 worker 实时进度。通过 SSE 实时更新。

**Blocked by:** 01, 05

- [ ] `packages/dashboard/src/pages/Overview.tsx`
- [ ] 健康状态卡片：uptime（人类可读格式）、内存使用、版本号、在线指示灯
- [ ] 队列全景卡片：运行中 worker 数、排队数、inflight 数
- [ ] 活跃 worker 列表：每个 worker 显示 projectId、pipelineId、当前阶段、turn 数、token 用量、工具调用名称（最近一次）、运行时长
- [ ] `packages/dashboard/src/hooks/useEventSource.ts`：封装 `EventSource` 连接 + 自动重连 + 状态管理（React state）
- [ ] SSE `snapshot` 事件初始化状态；`worker_started` / `worker_progress` / `worker_done` 增量更新 worker 列表
- [ ] 连接状态指示器：connected / reconnecting / disconnected
- [ ] 基础样式：现代深色主题（运维看板风格）
