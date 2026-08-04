# 07 — 可观测性（结构化日志、指标存储、per-fix trace、自故障钉钉）

**要构建什么：** 按 G7 给 bot 加仪表。全操作结构化 JSON 日志；轻量指标存文件（v1 无外部依赖如 Prometheus/Grafana）。每次修复 trace 记录项目/失败类/turns/tokens/成本/结果/MR 链接供单次修复审计。聚合指标：成功率、平均修复时长、成本/修复。bot 自故障（worker 全死、配额耗尽）触发钉钉告警。成本估算公式接好（单次修复 5k–20k token；月峰值 = N × 日均修复数 × token × 单价 × 30）。

**Blocked by:** 01（tracer bullet——需要管道来加仪表）

**Status:** done

- [x] 全 bot 操作结构化 JSON 日志（pino，ticket 01 已落地；webhook/队列/spawn/agent/验证/MR/通知全覆盖）
- [x] 文件指标存储（metrics.jsonl，无外部依赖）；SQLite 降级为演进接缝（v1 文件够用，避免 better-sqlite3 原生依赖）
- [x] 每次修复 trace：扩展 audit-trace.json 加 turns/tokens/cost/durationMs（复用 ticket 06 sidecar，不新增文件）
- [x] 聚合指标：成功率/平均时长/成本/修复（scripts/metrics-summary.mjs + `pnpm run metrics`）
- [x] bot 自故障钉钉告警：worker 全死（scheduler 连续 crash ≥ 阈值）+ 配额耗尽（ticket 02 已落地）；webhook 不可达=部署级外部探活，文档化
- [x] 成本估算公式接好（`repairCost()` = tokens × BOT_TOKEN_UNIT_COST_PER_1K/1000；月峰值公式在 spec + observability 文档）；数值实测 TBD
- [x] 演进接缝文档化：Prometheus + Grafana、多通道告警、外部 uptime monitor、trace 长期归档（docs/observability/observability.md）
- [x] 测试断言：per-fix trace（trace-metrics.test.ts 3 用例）、metrics.jsonl（metrics-store.test.ts 3 用例）、自故障钉钉（crash-alert.test.ts 3 用例，含阈值/低于阈值/计数重置）
