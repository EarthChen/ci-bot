# 09 — Dashboard: Metrics page

**What to build:** Dashboard 指标趋势页面，展示聚合指标概要 + 按日期的趋势图表。

**Blocked by:** 01, 04

- [ ] `packages/dashboard/src/pages/Metrics.tsx`
- [ ] 概要卡片区：总修复数、成功率、转交率、失败率、平均修复时长、总 token、总成本
- [ ] 趋势图表：按日聚合的 outcome 分布（堆叠柱状图或面积图）
- [ ] 趋势图表：修复时长趋势（折线图）
- [ ] 趋势图表：token / 成本趋势（折线图）
- [ ] 图表库选型：`recharts`（React 生态最成熟的轻量图表库）
- [ ] 页面加载时 fetch `/api/metrics`
- [ ] SSE `metrics_updated` 事件增量更新（可选：如果实现复杂可降级为定时 refetch）
- [ ] 时间范围选择器：7d / 30d / 90d / all
