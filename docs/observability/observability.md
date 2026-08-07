# 可观测性（Observability）

> Scope: ticket 07 — G7 可观测性章节的代码落地。
>
> v1 无外部依赖（无 Prometheus/Grafana）；演进接缝标明升级路径。

## 结构化日志

- pino 结构化 JSON 日志（`src/util/log.ts`），全操作记录：webhook 接收、队列、spawn、agent 跑、验证、MR、通知。
- 日志是人类运维 + 下游指标（metrics.jsonl）的源。e2e 测试不断言日志行（耦合实现细节，违反测试约定）。

## per-fix trace（audit-trace.json）

- 每次修复在 worker cwd 写 `audit-trace.json`，含 ticket 06 安全字段（event/outcome/diagnosis/diff/reasoning/mrUrl/createdAt）+ ticket 07 指标字段（turns/tokens/cost/durationMs）。
- cost = `tokens × BOT_TOKEN_UNIT_COST_PER_1K / 1000`（env 可调，默认 0.001 USD/1k tokens，实测 TBD）。
- durationMs = `agent.run` 前后的 wall-clock 差。class5 早筛无 agent → 全 0。
- 生产 ship 到日志/对象存储 = ticket 07 演进接缝（sidecar 是 worker cwd 临时文件，生产需采集）。

## 聚合指标（metrics.jsonl）

- 每次修复 append 一行 JSONL 到 worker cwd `metrics.jsonl`（projectId/pipelineId/outcome/tokens/cost/durationMs/createdAt）。
- 聚合脚本 `scripts/metrics-summary.mjs` 读 work root 下所有 metrics.jsonl，算：成功率、转交率、失败率、平均修复时长、总 token、总成本、平均成本/修复。
- 用法：`pnpm run metrics [auditRoot]`（默认 `$CIHEAL_DATA_ROOT/audit`）。
- v1 文件存储，无外部依赖。演进接缝：append 点不变，换 sink（Prometheus pushgateway）是 write-only 改动。

## 自故障告警

| 故障类型 | 检测方式 | 告警 |
| --- | --- | --- |
| worker 全死 | scheduler 连续 crash 计数 ≥ `BOT_WORKER_CRASH_THRESHOLD`（默认 3） | 钉钉"自故障"告警，计数重置防刷屏 |
| 配额耗尽 | RealAgentRunner turn_end token 累计超 `BOT_BUDGET_TOKENS`/`BOT_BUDGET_PER_TURN_TOKENS` → `session.abort()` | 钉钉"预算告警"（ticket 02 已落地） |
| webhook 不可达 | **部署级**，bot 代码不检测（进程挂了没法自己告警） | 外部探活（uptime monitor）→ 钉钉，文档化为演进接缝 |

- 成功修复重置 crash 计数，避免瞬时崩溃累积成误告警。

## 成本估算公式

- **单次修复 token 量级**：5k–20k（诊断 + 修复 + 文档，取决于失败复杂度 + diff/源码/日志量）。实测 TBD。
- **月峰值成本**：`N(并发) × 日均修复数 × 单次 token × 单 token 价格 × 30`
- **单 token 价格**：`BOT_TOKEN_UNIT_COST_PER_1K / 1000`（env，实测 TBD per provider）。
- 公式已代码化（`repairCost()` in run-repair.ts），数值依赖实测。

## 演进接缝

| 触发 | 机制 |
| --- | --- |
| 需要查询聚合指标 / 历史趋势 | metrics.jsonl → Prometheus pushgateway + Grafana dashboard |
| 多通道告警 | 钉钉 → 钉钉 + 邮件 / PagerDuty |
| webhook 不可达主动告警 | 外部 uptime monitor（不在 bot 代码，部署运维域） |
| per-fix trace 长期归档 | worker cwd sidecar → 日志聚合 / 对象存储（S3） |
