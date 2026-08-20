# 03 — 队列合并 + 绿灯短路

**What to build:** 用户对同一 MR 连推多次时，排队事件只保留最新一个（被挤掉的入审计并群内留痕）；事件出队执行前复查该 MR 最新 pipeline 状态，用户已自修跑绿则跳过修复。过期修复不再串行烧预算，也不再对已绿的 MR 起 agent。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 同 serial key 排队事件只保留最新；被挤掉事件写审计 + 群通知注明「已被更新的 pipeline 取代」
- [ ] 出队执行前复查该 MR 最新 pipeline：已绿则跳过修复，审计 + 群通知尾注，不起 agent
- [ ] pipeline-id 幂等与 serial key 跨 MR 并发语义无回归（现有 scheduler 测试全绿）
- [ ] e2e：同 MR 三连 webhook 最终只起一个 worker 且针对最新 sha；绿灯事件被跳过
