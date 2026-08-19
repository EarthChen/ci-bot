# Real-Time Dashboard

The CI self-heal bot is a black box at runtime: between webhook arrival and repair completion, humans have zero visibility into what the bot and agent are doing. Observability relies on post-hoc artifacts (pino log files, audit JSON, offline `pnpm metrics`) and asynchronous DingTalk notifications at coarse lifecycle points. When the bot hangs, queues pile up, or workers crash-loop, operators only discover the problem by SSH-ing into the server and tailing logs — an unacceptable feedback delay for a production service.

A real-time web dashboard closes this gap by surfacing bot health, scheduler state, worker progress, pending decisions, and aggregate metrics through a browser UI backed by SSE push. The dashboard is read-only; all mutations (e.g. `/heal`) remain in DingTalk.

## Key decisions

### Same-process deployment

The dashboard API and SSE endpoint run inside the existing Fastify process. The scheduler's queue/inflight state and the EventHub's connection pool live in main-process memory — a separate service would need an IPC or polling bridge to access them, adding complexity for no isolation benefit (the bot is a single-instance headless service with `BOT_CONCURRENCY` defaulting to 1).

Trade-off: a dashboard bug (e.g. SSE backpressure) could theoretically affect webhook processing. Mitigated by keeping dashboard routes read-only and rate-limiting SSE connections.

### Worker → main process: Node IPC

Worker subprocesses report stage/turn/tool-call events via the Node IPC channel (`spawn` stdio extended with `'ipc'`; `process.send()` in the worker, `child.on('message')` in the manager). This is zero-dependency, low-latency, and type-safe. The alternative — parsing structured JSON from stdout — conflicts with pino log output on the same stream.

The IPC event granularity is **stage + turn + tool call** (the finest level). Tool-call events include the tool name and a short summary but not full arguments/results, balancing visibility against data volume. If the Pi SDK does not expose per-tool-call hooks, the granularity degrades to stage + turn without blocking the overall architecture.

### Browser push: Server-Sent Events

SSE (`GET /api/events`) is a natural fit for a read-only dashboard: unidirectional, HTTP-native (no upgrade handshake), and supported by the browser's `EventSource` API with automatic reconnection. WebSocket's bidirectionality is unnecessary when Q6 = read-only. Fastify supports SSE without additional libraries via `reply.raw.write()`.

### Hybrid push model

The first SSE message is a full `system_snapshot` (health, scheduler, active workers, pending decisions, metrics). Subsequent messages are incremental domain events (`pipeline_enqueued`, `worker_progress`, `decision_created`, etc.). This avoids both the stale-on-connect problem of pure-event streams and the bandwidth waste of pure-snapshot polling.

### React + Vite in a monorepo sub-package

The frontend lives in `packages/dashboard` under a pnpm workspace. Vite builds independently into `dist/dashboard/`; Fastify serves the artifacts via `@fastify/static`. The root `tsc` compilation and the dashboard `vite build` are isolated — different `tsconfig.json` files, no shared `node_modules` pollution. CI gains one additional step (`pnpm --filter dashboard build`).

Trade-off: a React SPA introduces a second build pipeline and frontend dependency surface into a backend-only project. Accepted because the dashboard will grow to multiple views (ops, decisions, metrics) and an interactive time-range selector, where server-rendered templates would become painful.

### No authentication (v1)

The dashboard is deployed on an internal network; network-boundary trust is sufficient for a read-only ops view. If the deployment environment becomes externally reachable, a shared-token guard (`CIHEAL_DASHBOARD_TOKEN` env var + Fastify hook) is the minimal next step.

Risk: tool-call events may contain code paths and bash commands from target projects. On a trusted internal network this is acceptable; on a public network it is an information leak.

### Metrics aggregation: startup preload + incremental

`MetricsAggregator` scans `audit/*/metrics.jsonl` once at boot (reusing the logic from `scripts/metrics-summary.mjs`), then receives incremental entries from `finishRepair()`. The `/api/metrics` endpoint reads from the in-memory aggregate. This avoids per-request file scanning (which would degrade as the audit directory grows) and avoids a new SQLite database (overkill for append-only counters).

## Consequences

- The Fastify process gains four new routes (`/api/status`, `/api/events`, `/api/decisions`, `/api/metrics`) and a static file handler (`/dashboard/*`). All are read-only.
- `SubprocessWorkerManager.spawn` stdio changes from `["ignore","pipe","pipe"]` to `["ignore","pipe","pipe","ipc"]`. Worker code must guard `process.send?.()` calls since IPC may be absent in test harnesses.
- The project becomes a pnpm workspace monorepo (`pnpm-workspace.yaml`). Existing `pnpm install` / `pnpm test` / `pnpm typecheck` behavior must be verified unaffected.
- A new `EventHub` in-memory component becomes the central fan-out point for real-time state; scheduler, decision lifecycle, and worker manager all feed into it.
- See spec: `.scratch/dashboard/spec.md`.
