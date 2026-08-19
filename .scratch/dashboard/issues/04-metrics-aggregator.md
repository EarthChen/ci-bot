# 04 — MetricsAggregator: startup preload + incremental update

**What to build:** 启动时扫描 `audit/*/metrics.jsonl` 构建内存聚合结构，运行时增量更新。提供 `/api/metrics` 端点。Tracer bullet：bot 启动后 `curl /api/metrics` 返回聚合指标 JSON。

**Blocked by:** None

- [ ] `src/dashboard/metrics-aggregator.ts`：`MetricsAggregator` 类
- [ ] `load(auditDir)`：启动时全量扫描 metrics.jsonl，复用 `scripts/metrics-summary.mjs` 聚合逻辑（TS 重写）
- [ ] `record(entry)`：单条增量追加（finishRepair 后调用）
- [ ] `snapshot()`：返回当前聚合快照（成功率、转交率、失败率、平均修复时长 ms、总 token、总成本、各 outcome 计数、按日期分组的趋势数据）
- [ ] `src/dashboard/routes.ts`：注册 `/api/metrics` GET 路由，调用 `aggregator.snapshot()`
- [ ] `src/pipeline/repair-outcome.ts`：`finishRepair` 后调用 `aggregator.record()`
- [ ] unit test：构造 metrics.jsonl fixture → load → 验证聚合结果 → record 增量 → 验证更新
