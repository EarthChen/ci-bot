# 01 — 建立共享 Pi Agent Runtime

**What to build:** 让当前项目能够通过一个共享执行 seam 运行静态注册的 Vertical Agent definition，使业务 Agent 可提供资源、命名策略和业务输入到 prompt 的映射，而不重复构建 Pi session、模型认证、worker、预算或资源加载。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 共享 runtime 可运行一个静态、类型检查的 Vertical Agent definition，并保留 Pi 默认 system prompt。
- [ ] Vertical Agent 可通过其 definition 请求已发布的 model policy、capability profile、追加 instruction、skills 和业务 prompt，而不能获得未批准的执行权限。
- [ ] runtime 仅返回运行事实，不要求跨 Agent 的结构化输出或业务验证。
- [ ] 通过可注入的 session seam 验证非 CI 的测试 Vertical Agent 能复用 runtime，而无需真实模型网络调用。
- [ ] 现有模型、认证、worker 隔离、预算和可信资源加载行为保持可验证。
