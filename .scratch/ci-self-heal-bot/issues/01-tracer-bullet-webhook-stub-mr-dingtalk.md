# 01 — Tracer bullet：webhook → stub 修复 → MR + 钉钉

**要构建什么：** 发一个假的 GitLab pipeline 失败 webhook；bot 校验签名、按 pipeline id 幂等去重、spawn 一个 worker（cwd 隔离）、跑一个 stub agent 返回 canned 修复 diff、开带修复摘要的 MR、推钉钉成功通知。整条管道端到端打通，agent 和验证层用 stub。这建立单一端到端测试接缝 + 第一行 fixture。

**Blocked by:** 无 — 可立即开始。

**Status:** ready-for-agent

- [ ] GitLab webhook 接收器接受 pipeline 失败事件，校验 `X-Gitlab-Token` 签名，应用 IP 白名单 + 限流
- [ ] pipeline-id 幂等去重（重试的 webhook 只触发一次修复）
- [ ] 内存队列，全局并发上限 N=1
- [ ] Worker 管理器 spawn 一个 worker 子进程，per-worker cwd 隔离
- [ ] Stub agent runner 返回 canned 诊断 + 修复 diff（暂不接真实 pi SDK）
- [ ] glab CLI 封装创建带修复摘要的 MR（测试中不开真 MR——glab 调用被 fixture 拦截）
- [ ] 修复成功发钉钉通知（确定性节点，bot 代码调钉钉，agent 不持钉钉工具）
- [ ] .env 配置加载器读 GitLab token + 钉钉 webhook + 模型 API key（chmod 600，gitignore）
- [ ] TS 项目骨架提交（pnpm + tsconfig + src 结构）
- [ ] 端到端测试跑通 webhook → MR 创建 → 钉钉（用 stub agent fixture）；测试接缝首行绿灯
