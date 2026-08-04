# 02 — 接入真实 pi agent + class 1（测试 bug）修复

**要构建什么：** 把 stub agent runner 换成真实 pi SDK `createAgentSession`。agent 通过 `/skill:name` 确定性加载 java-coding-standards skill（prompt 也显式点名，双重保险），诊断 G1 class 1 失败（断言/mock/数据错——测试层 bug）、改测试文件、跑相关测试、输出结构化结果（成功/转交）。MR 带真实 diff。预算软上限（turn_end + session.abort）接好。无 class 2/3/4/5、无文档同步、无全量回归、无 flaky 处理、无并发。

**Blocked by:** 01（tracer bullet 管道）

**Status:** ready-for-agent

- [ ] pi SDK `createAgentSession` 接入 agent runner（TS 同进程 import）
- [ ] 项目内 `.agents/skills/ci-self-heal-playbook/SKILL.md` 落地：把 G1 五类分类法 + G3 每类修复策略与权限边界 + G2 文档同步时机与段落规则写成单个 skill 的三段（诊断/修复/文档同步）
- [ ] `/skill:ci-self-heal-playbook` 确定性加载；prompt 也点名（双重保险）；通用 java-coding-standards 仍走全局发现
- [ ] 预算软上限：turn_end 事件监听 + token 累加 + 超阈值 session.abort() + 钉钉告警
- [ ] agent 从 CI 日志 + diff + 源码诊断 class 1（测试 bug），只改测试文件（src/main 写禁）
- [ ] agent session 结束输出结构化结果（成功/转交/诊断摘要）；bot 代码读结果
- [ ] 验证只跑相关测试（全量兜底是 ticket 04）
- [ ] 开带真实修复 diff + 摘要的 MR；全绿钉钉成功，卡住转交
- [ ] 端到端测试 fixture：class 1 webhook → MR 只碰测试 diff → 钉钉成功
