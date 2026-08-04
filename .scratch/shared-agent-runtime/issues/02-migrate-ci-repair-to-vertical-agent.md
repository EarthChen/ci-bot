# 02 — 将 CI 自愈迁移为第一个 Vertical Agent

**What to build:** 让 CI 自愈作为静态注册的 Vertical Agent 使用共享 runtime，同时继续由 CI 工作流负责 pipeline 输入、worktree、G3、测试、flaky、MR 与钉钉等业务行为。

**Blocked by:** 01 — 建立共享 Pi Agent Runtime.

**Status:** ready-for-agent

- [ ] CI 自愈的 prompt、追加 system instruction、skill 和业务输入映射由其 Vertical Agent definition 提供。
- [ ] CI 自愈继续使用现有同族模型候选、认证、私有 worker、预算和 bot-owned 资源边界。
- [ ] CI 结构化结果解析及独立 G3/测试/MR gate 保留在 CI 域，而不是进入共享 runtime。
- [ ] 既有 webhook 到 MR 到钉钉的端到端行为、预算升级和外部错误脱敏回归保持通过。
