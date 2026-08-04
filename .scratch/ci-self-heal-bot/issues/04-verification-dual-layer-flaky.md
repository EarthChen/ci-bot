# 04 — 验证关卡全量（相关 + 全量双层）+ flaky @Skip

**要构建什么：** 把验证关卡从"只跑相关"加厚到双层：先跑失败相关测试模块做快反馈，绿了再跑全量单测做回归兜底。验证遇 flaky 时，标 @Skip/@Disabled 并发独立钉钉通知（不混入本次修复 MR），这样 reviewer 不被无关 flaky 噪音困扰。

**Blocked by:** 02（真实 pi agent——需要真实修复来验证）

**Status:** ready-for-agent

- [ ] 验证关卡先跑相关测试模块（快反馈）
- [ ] 相关绿了再跑全量单测（回归兜底）
- [ ] 验证遇 flaky → 在测试文件标 @Skip/@Disabled
- [ ] flaky 通知通过独立钉钉消息发（与修复 MR 解耦）
- [ ] 修复 MR 不含 flaky @Skip 改动（独立关注点）
- [ ] 端到端 fixture：验证全绿 → MR；验证遇 flaky → @Skip + 独立钉钉，修复 MR 干净
