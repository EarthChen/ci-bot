# Real-Time Dashboard

> Triage: `ready-for-agent`

## Problem Statement

ci-bot 当前是完全的黑盒——从 webhook 接收到修复完成，人类无法观测 bot 和 agent 的工作过程。可观测性仅靠 pino 结构化日志（需 SSH 到服务器看文件）、审计 JSON 文件（事后分析）、钉钉通知（仅关键节点推送、无过程信息）和离线 `pnpm metrics` 脚本。缺乏实时运维看板意味着：bot 进程挂了只能被动发现、队列堆积无从感知、worker 崩溃循环需翻日志才能确认、agent 修复进度完全不可见。

## Solution

在现有 Fastify 主进程上增加只读 Dashboard：React SPA 前端（monorepo 子包 `packages/dashboard`，Vite 构建）+ 后端 API 路由 + SSE 实时推送。Worker 子进程通过 Node IPC 上报阶段/turn/工具调用级事件到主进程 EventHub，EventHub 聚合后通过 SSE 推送到浏览器。首次连接推全量快照，后续推增量事件。第一版面向运维视图（健康 + 队列/worker 全景 + 待决策列表 + 历史聚合指标），无认证（内网部署）、纯只读。

## User Stories

1. As a 运维人员, I want 打开 Dashboard 看到 bot 进程健康状态（存活、uptime、内存、版本）, so that 我能秒级判断 bot 是否正常工作
2. As a 运维人员, I want 看到当前队列全景（排队数、运行中 worker 数、各 serialKey 占用情况）, so that 我能判断是否有队列堆积或死锁
3. As a 运维人员, I want 看到每个运行中 worker 的实时进度（当前阶段、turn 数、token 用量、工具调用名称）, so that 我不再对修复过程一无所知
4. As a 运维人员, I want 看到待决策列表（awaiting_decision 记录：id、项目、pipeline、创建时间、过期倒计时）, so that 我能及时发现并处理待决策
5. As a 运维人员, I want 看到历史聚合指标（成功率、转交率、失败率、平均修复时长、总 token、总成本）以及趋势图, so that 我能评估 bot 的整体效能
6. As a 开发者, I want 在 Dashboard 上看到我的 pipeline 的修复进度, so that 我不需要等钉钉通知就能知道修复状态
7. As a 团队 Lead, I want 查看按时间段聚合的指标趋势, so that 我能向管理层汇报 bot 的 ROI
8. As a 运维人员, I want Dashboard 在 SSE 连接断开后自动重连并恢复最新状态, so that 我不需要手动刷新页面
9. As a 运维人员, I want Dashboard 页面分为全景概览、决策详情、指标趋势三个视图, so that 信息分层不混杂

## Implementation Decisions

### 部署模型：同进程

在现有 Fastify 实例上挂新路由，复用 scheduler/store 的内存引用。零额外部署成本。Scheduler 状态全在内存里，跨进程无法直接获取。

### Worker → 主进程通信：Node IPC

将 `SubprocessWorkerManager` 的 `spawn` stdio 从 `["ignore", "pipe", "pipe"]` 改为 `["ignore", "pipe", "pipe", "ipc"]`。Worker 侧用 `process.send()` 发送结构化事件消息，manager 侧用 `child.on('message')` 接收。

IPC 事件粒度为**阶段 + turn + 工具调用**三级：
- `stage_enter` / `stage_exit`：早筛、agent 运行、G3 校验、MR 创建、完成
- `turn_start` / `turn_end`：agent 每个 turn 的开始/结束 + token 用量
- `tool_call`：每个工具调用的名称和摘要（不含完整参数/结果以控制数据量）

### 前端 → 服务端通信：SSE

单向推送，浏览器原生 `EventSource` API 自带断线重连。Fastify `reply.raw.write()` 直接支持，无需额外依赖。与纯只读交互模式匹配。

SSE 事件 schema 采用**自定义精简协议**（面向 ci-bot 领域）：
- `system_snapshot`：初始全量状态快照
- `pipeline_enqueued`：新 pipeline 入队
- `worker_started` / `worker_progress` / `worker_done`：worker 生命周期
- `tool_call`：agent 工具调用
- `decision_created` / `decision_resolved`：决策状态变化
- `metrics_updated`：指标增量更新

初次 SSE 连接推全量快照，后续推增量事件（混合模式）。

### 前端技术：React + Vite（monorepo 子包）

项目全栈 TypeScript，React TSX 类型推断最强。`packages/dashboard` 为 pnpm workspace 子包，Vite 独立构建，产物到 `dist/dashboard/`。Fastify 挂 `@fastify/static` 托管静态资源。

前后端构建隔离——Vite 不干扰 `tsc` 直出逻辑，`tsconfig.json` 不互相污染。

### 页面结构：多页分区

- `/dashboard` — 全景概览（健康 + 队列/worker + 活跃任务摘要）
- `/dashboard/decisions` — 待决策列表 + 历史决策
- `/dashboard/metrics` — 聚合指标 + 趋势图表

使用 React Router 实现客户端路由。

### 历史指标聚合：启动预加载 + 增量

bot 启动时全量扫描 `audit/*/metrics.jsonl` 缓存到内存聚合结构（复用 `metrics-summary.mjs` 逻辑），运行时每次 `finishRepair()` 写审计后增量更新。API 请求直接读内存聚合结果。

### 认证：无

内网部署，信任网络边界。**注意风险**：工具调用级事件可能包含代码路径、bash 命令等内部信息——如果部署在有外网可达的环境，需额外增加认证。

### EventHub 设计

主进程新增 `EventHub` 组件，职责：
- 接收 IPC 事件（from workers）+ 内部事件（from scheduler/decision lifecycle）
- 维护当前系统状态快照
- 管理 SSE 客户端连接池
- 新客户端连接时推快照；状态变化时向所有客户端推增量事件

EventHub 是内存-only 结构，不持久化事件流。

### CI 变更

CI 新增 `pnpm --filter dashboard build` 步骤，保证 dashboard 构建不因类型错误在部署时才暴露。

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ 主进程 (Fastify)                                      │
│                                                       │
│  ┌──────────┐   IPC    ┌──────────────┐               │
│  │ Worker 1 │ ──────→  │ EventHub     │               │
│  │ (子进程)  │  events  │ (聚合+广播)   │               │
│  └──────────┘          │              │  SSE          │
│  ┌──────────┐   IPC    │  snapshot +  │ ────→ Browser │
│  │ Worker 2 │ ──────→  │  events      │               │
│  │ (子进程)  │          └──────────────┘               │
│  └──────────┘                                         │
│                                                       │
│  Data Sources:                                        │
│  · scheduler.stats()          (内存)                  │
│  · decisionStore.listByStatus() (SQLite)              │
│  · metricsAggregator            (启动加载+增量)       │
│  · process.uptime/memoryUsage   (内建)                │
│                                                       │
│  Routes:                                              │
│  POST /webhook/gitlab        (已有)                   │
│  GET  /api/status            (新, JSON)               │
│  GET  /api/events            (新, SSE stream)         │
│  GET  /api/decisions         (新, JSON)               │
│  GET  /api/metrics           (新, JSON)               │
│  GET  /dashboard/*           (新, @fastify/static)    │
└─────────────────────────────────────────────────────┘

┌───────────────────────────────────────┐
│ packages/dashboard (React + Vite)     │
│                                       │
│  Pages:                               │
│  /dashboard          全景概览          │
│  /dashboard/decisions  决策详情        │
│  /dashboard/metrics    指标趋势        │
│                                       │
│  Data flow:                           │
│  EventSource(/api/events) → state     │
│  fetch(/api/status) → fallback        │
│  fetch(/api/decisions) → table        │
│  fetch(/api/metrics) → charts         │
└───────────────────────────────────────┘
```

### IPC 事件协议

Worker → 主进程 IPC 消息格式：

```typescript
type WorkerIpcMessage =
  | { type: "stage_enter"; stage: string; pipelineId: number; projectId: string }
  | { type: "stage_exit"; stage: string }
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number; tokens: number; cost: number }
  | { type: "tool_call"; name: string; summary: string }
```

### SSE 事件协议

Server → Browser SSE 事件格式（`event:` field + JSON `data:`）：

```typescript
type SseEvent =
  | { event: "snapshot"; data: SystemSnapshot }
  | { event: "pipeline_enqueued"; data: { pipelineId: number; projectId: string; ref: string } }
  | { event: "worker_started"; data: { pipelineId: number; projectId: string; workerId: string } }
  | { event: "worker_progress"; data: { workerId: string; stage: string; turn?: number; tokens?: number; toolCall?: string } }
  | { event: "worker_done"; data: { workerId: string; outcome: string; durationMs: number } }
  | { event: "decision_created"; data: { decisionId: string; projectId: string; pipelineId: number } }
  | { event: "decision_resolved"; data: { decisionId: string; status: string } }
  | { event: "metrics_updated"; data: MetricsSnapshot }

interface SystemSnapshot {
  health: { uptime: number; memoryMB: number; version: string };
  scheduler: { running: number; queued: number; inflight: number };
  workers: WorkerState[];
  decisions: DecisionSummary[];
  metrics: MetricsSnapshot;
}
```

## Module Breakdown

### 后端新增模块

- `src/dashboard/event-hub.ts` — EventHub：IPC 聚合 + SSE 广播 + 状态快照管理
- `src/dashboard/routes.ts` — Fastify 路由：`/api/status`、`/api/events`（SSE）、`/api/decisions`、`/api/metrics`、`/dashboard/*`（静态）
- `src/dashboard/metrics-aggregator.ts` — 启动预加载 + 增量聚合指标
- `src/dashboard/types.ts` — IPC / SSE 事件类型定义

### 后端变更模块

- `src/worker/manager.ts` — spawn stdio 加 `'ipc'`；`child.on('message')` 转发到 EventHub
- `src/pipeline/run-repair.ts` — 阶段入口/出口 emit IPC 事件
- `src/pipeline/run-resume.ts` — 同上
- `src/agent-runtime/runtime.ts` — turn_end 回调 emit IPC turn 事件
- `src/agent/real-runner.ts` — 工具调用 emit IPC tool_call 事件（需 Pi SDK hook 支持探索）
- `src/main.ts` — wire EventHub + dashboard routes

### 前端新增

- `packages/dashboard/` — React + Vite SPA
  - `src/App.tsx` — React Router 布局
  - `src/pages/Overview.tsx` — 全景概览
  - `src/pages/Decisions.tsx` — 决策列表
  - `src/pages/Metrics.tsx` — 指标图表
  - `src/hooks/useEventSource.ts` — SSE 连接 + 状态管理
  - `src/components/` — 健康卡片、队列表、worker 进度、决策表、指标图表

### 基础设施变更

- `pnpm-workspace.yaml` — 新增 `packages/dashboard`
- `.github/workflows/ci.yml` — 新增 dashboard build step
- `package.json` — 根 package build script 串联 dashboard

## Testing Decisions

### 后端测试

- **EventHub**：unit test，模拟 IPC 消息输入 → 验证 SSE 事件输出 + 快照更新
- **routes**：integration test，Fastify inject → 验证 JSON 响应格式 + SSE stream 格式
- **metrics-aggregator**：unit test，构造 metrics.jsonl → 验证聚合结果 + 增量更新
- **IPC 集成**：integration test，spawn 子进程发 IPC → 主进程收到并转发

### 前端测试

第一版不加前端单测（纯只读展示，逻辑简单）。CI 只验证构建成功。

### Prior art

- `tests/webhook/receiver.test.ts` — Fastify inject 测试范式
- `tests/agent-runtime/scheduler.test.ts` — 内存状态测试
- `tests/notify/route-store.test.ts` — SQLite store 测试范式

## SDK 不确定性：工具调用事件

Q13=C（工具调用级事件）依赖从 Pi SDK 执行循环中提取 per-tool-call 事件。当前 `SharedAgentRuntime` 只在 `turn_end` 回调中获取 token 统计，**不暴露 per-tool-call 事件**。

可能的实现路径：
1. Pi SDK 的 session 对象可能支持更细粒度的事件回调——需查阅 `@earendil-works/pi-coding-agent` API
2. 从 session jsonl 文件实时 tail（Pi 落盘后 worker parse 再 IPC）
3. 降级为 turn 级（如果 SDK 不支持工具级 hook）

**风险**：如果 Pi SDK 不暴露工具调用钩子，Q13 需从 C 降级到 B。这不影响整体架构，只影响前端展示粒度。

## Out of Scope

- 认证 / 权限控制
- 可操作功能（`/heal` 等操作仍走钉钉）
- 开发者个人视图（按用户过滤"我的 pipeline"）
- 管理层视图（按部门/团队聚合）
- 告警规则配置
- Agent session 回放（完整工具调用历史重放）
- 移动端适配
- 国际化
- Prometheus / Grafana 集成
- 日志查看器（worker.log 在线查看）

## Risks

1. **Pi SDK 工具调用 hook**：SDK 可能不暴露 per-tool-call 事件，需降级粒度或用 jsonl tail 替代
2. **IPC 对 tsx 的兼容性**：开发模式下 worker 通过 tsx 启动，spawn + ipc stdio 与 tsx 的兼容性需验证
3. **SSE 连接数上限**：长连接占 fd，需评估 Fastify 在多客户端 SSE 下的表现（运维看板通常 < 10 并发，风险低）
4. **无认证 + 工具调用信息泄露**：部署在非纯内网环境时存在信息泄露风险
5. **Monorepo 改造**：引入 pnpm workspace 可能影响现有 `pnpm install` / CI 行为，需验证兼容性
