# 07 — 可观测性（结构化日志、SQLite 指标、per-fix trace、bot 自故障钉钉）

**要构建什么：** 按 G7 给 bot 加仪表。全操作结构化 JSON 日志；轻量指标存 SQLite/文件（v1 无外部依赖如 Prometheus/Grafana）。每次修复 trace 记录项目/失败类/turns/tokens/成本/结果/MR 链接供单次修复审计。聚合指标：成功率、平均修复时长、成本/修复。bot 自故障（webhook 端点不可达、worker 全死、模型配额耗尽）触发钉钉告警（扩展 G2 修复结果钉钉通道）。成本估算公式接好（单次修复 5k–20k token；月峰值 = N × 日均修复数 × token × 单价 × 30）。

**Blocked by:** 01（tracer bullet——需要管道来加仪表）

**Status:** ready-for-agent

- [ ] 全 bot 操作结构化 JSON 日志（webhook 接收、队列、spawn、agent 跑、验证、MR、通知）
- [ ] SQLite（或文件）指标存储，无外部依赖
- [ ] 每次修复 trace：项目/失败类/turns/tokens/成本/结果/MR 链接
- [ ] 聚合指标：成功率、平均修复时长、成本/修复
- [ ] bot 自故障钉钉告警：webhook 不可达、worker 全死、配额耗尽
- [ ] 成本估算公式接好（单次修复 token 范围 + 月峰值公式）；数值实测 TBD
- [ ] 演进接缝文档化：后续 Prometheus + Grafana
- [ ] 测试断言：fixture 修复写了 per-fix trace；模拟 bot 宕机触发自故障钉钉
