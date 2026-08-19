# 08 — Dashboard: Decisions page

**What to build:** Dashboard 决策详情页面，展示待决策 + 历史决策列表。通过 API 轮询 + SSE 实时更新。

**Blocked by:** 01, 03, 05

- [ ] `packages/dashboard/src/pages/Decisions.tsx`
- [ ] 待决策区域（醒目）：decision_id、项目名、pipeline ID、创建时间、过期倒计时（实时递减）、`/heal` 命令模板（可复制）
- [ ] 历史决策表格：所有终态决策（resumed/closed/dropped/expired/invalidated），显示 decision_value、decided_by、decided_at
- [ ] 页面加载时 fetch `/api/decisions` 初始化
- [ ] SSE `decision_created` / `decision_resolved` 事件增量更新列表
- [ ] 过期倒计时用 `setInterval` 客户端计算（不依赖服务端推送）
- [ ] 空状态提示："当前无待决策事项"
