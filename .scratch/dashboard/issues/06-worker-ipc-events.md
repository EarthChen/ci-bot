# 06 — Worker IPC: stage/turn/tool_call events

**What to build:** Worker 子进程通过 Node IPC 向主进程上报阶段/turn/工具调用事件。主进程 SubprocessWorkerManager 接收并转发到 EventHub。Tracer bullet：worker 修复过程中 Dashboard SSE 收到 `worker_progress` 事件流。

**Blocked by:** 05

- [ ] `src/worker/manager.ts`：`spawn` stdio 改为 `["ignore", "pipe", "pipe", "ipc"]`
- [ ] `child.on('message', msg => ...)` 接收 WorkerIpcMessage，转发到 EventHub
- [ ] workerId = `${event.projectId}:${event.pipelineId}`（唯一标识活跃 worker）
- [ ] `src/dashboard/types.ts`：`WorkerIpcMessage` 类型定义
- [ ] `src/pipeline/run-repair.ts`：各阶段入口/出口 `process.send?.({ type: "stage_enter", stage: "..." })`（`process.send` 可能不存在，需 optional call）
- [ ] `src/pipeline/run-resume.ts`：同上
- [ ] `src/agent-runtime/runtime.ts`：`turn_end` 回调内 `process.send?.({ type: "turn_end", turn, tokens, cost })`
- [ ] 工具调用事件探索：查阅 Pi SDK `@earendil-works/pi-coding-agent` API，确认是否支持 tool_call 级回调。如不支持则此 ticket 内降级为 turn 级
- [ ] 验证 tsx 开发模式下 IPC 正常工作（tsx spawn 的子进程 stdio ipc 兼容性）
- [ ] integration test：spawn 带 IPC 的子进程 → 子进程 `process.send()` → 主进程收到 → EventHub 收到
