# Spec：CI 单测自愈 Bot

> Status: ready-for-agent
> Feature: ci-self-heal-bot
> Source: wayfinder/MAP.md + 9 张决策票（R1–R4, G1–G7）+ 4 份 research brief

## 问题陈述

CI 单元测试失败后，开发者必须手动介入：判断失败根因、修复测试 bug、补全缺失测试、在被测代码变更后更新测试期望、在行为变更时同步文档。这些工作繁琐、重复、跨多项目不可扩展。尤其在大规模 Java/Spring 项目中，一个 pipeline 可能有多个单测 job 同时失败，开发者疲于逐个 triage，而很多失败其实是测试层的简单问题（断言写错、mock 过时、新代码路径没覆盖），不需要动生产代码。

## 解决方案

一个 headless 长驻 bot 服务，监听 GitLab pipeline 失败 webhook，用 AI agent（pi SDK + 已有语言 skill）自动诊断单测失败根因、修复/补全测试（绝不碰生产代码）、在被测代码行为变更时顺带同步文档、开 MR 供人工 review、通过钉钉主动推送结果。v1 只处理单测失败，按"窄→宽"迭代——lint/build/typecheck/integration 是后续扩展。bot 以 pi 为核心 SDK（TypeScript 实现），演进接缝标明切回 Claude SDK 的路径。

## 用户故事

### 触发与接入

1. 作为开发者，我希望 bot 自动检测 GitLab pipeline 的单测失败，这样我就不用逐个手动 triage。
2. 作为项目维护者，我希望配置 bot 监听哪些 GitLab 项目/仓库，这样只有相关项目才触发修复。
3. 作为 DevOps 工程师，我希望 bot 监听 GitLab pipeline 事件 webhook（非 job 级），这样一个 pipeline 只触发一次，多 job 失败自然聚合成一次修复。
4. 作为 DevOps 工程师，我希望 bot 校验 webhook 签名（GitLab `X-Gitlab-Token`），这样伪造请求无法触发修复。
5. 作为 DevOps 工程师，我希望 bot 应用 IP 白名单（GitLab 出口 IP）和限流，这样 webhook 端点不被滥用。
6. 作为 DevOps 工程师，我希望 bot 按 pipeline id 幂等去重，这样 GitLab 的 webhook 重试不会导致重复工作。
7. 作为 DevOps 工程师，我希望 bot 接受 pipeline 终态延迟（失败态），这样触发机制保持简单，即使某些 stage 收尾晚。

### 并发与调度

8. 作为 DevOps 工程师，我希望 bot 按需 spawn worker（事件来 → spawn → 跑 → 退出），这样不消耗空闲资源。
9. 作为 DevOps 工程师，我希望 bot 强制全局并发上限 N + 溢出排队（不丢），这样负载突增时资源不耗尽。
10. 作为 DevOps 工程师，我希望按项目串行队列，这样一个项目的失败不阻塞另一个项目。
11. 作为 DevOps 工程师，我希望 bot 处理跨 pipeline 过期（新推送取代旧），这样不在过期 commit 上白费功夫。
12. 作为开发者，我希望过期 commit 的修复 MR 标注"rebase 或丢弃"，这样 reviewer 不被过时修复困扰。
13. 作为开发者，我希望 bot 在修复被新推送取代时钉钉通知我，这样我知道旧修复已过期。

### 诊断与分类

14. 作为开发者，我希望 bot 按根因分类我的测试失败，这样它只在根因在测试层时才自动修。
15. 作为开发者，我希望 bot 早期跳过编译/依赖错误（class 5），这样它不在非测试失败上浪费预算。
16. 作为开发者，我希望 bot 跳过 flaky/环境失败（class 4），这样它不追非确定性问题。
17. 作为开发者，我希望 bot 补缺失测试（class 3）时读仓库内 spec/PRD，这样新测试断言的是 spec 规定的正确行为（而非当前代码行为，避免固化 bug）。
18. 作为开发者，我希望当代码行为与 spec 不符时 bot 转交给我，这样潜在生产 bug 得到人工关注。
19. 作为开发者，我希望当 spec 不可读或缺失时 bot 转交给我，这样规格符合性测试不是瞎猜。
20. 作为开发者，我希望 bot 用 CI 日志信号和本地执行信号双源分类，这样根因判断比单看日志更准。

### 修复

21. 作为开发者，我希望 bot 修测试 bug（断言/mock/数据错，class 1），这样我不用在琐碎测试修复上花时间。
22. 作为开发者，我希望 bot 在生产代码变更后更新过时测试期望（class 2），这样测试与代码保持同步。
23. 作为开发者，我希望 bot 为未覆盖代码路径补缺失测试（class 3），这样不用手动提升覆盖率。
24. 作为开发者，我希望 bot 只改测试文件和文档，这样生产代码绝不被 bot 碰。
25. 作为开发者，我希望 bot 发现生产代码 bug 时转交给我，这样根因（可能不在本服务）得到人工关注。
26. 作为开发者，我希望 bot 在需要时做轻量测试结构重构（拆分过大方法、修 mock 位置），这样结构性测试 bug 也能修。
27. 作为开发者，我希望 bot 限制重构范围，这样 diff 保持可 review。
28. 作为开发者，我希望 bot 只补失败相关路径的测试（窄→宽），这样 MR 不会膨胀成覆盖率大改。

### 文档同步

29. 作为开发者，我希望 bot 在代码变更引发行为变更（class 2）时同步文档，这样文档与代码保持一致。
30. 作为开发者，我希望文档同步只动直接相关段落（API 描述、参数、返回语义），这样 diff 最小且聚焦。
31. 作为开发者，我希望 bot 诊断阶段读 spec（class 3）、修复后阶段写 spec（class 2 行为变更），这样 spec 同时作为输入和输出，时序在 pipeline 内自然分离。

### 验证

32. 作为开发者，我希望 bot 修复后跑相关测试，这样开 MR 前验证修复。
33. 作为开发者，我希望 bot 跑全量单测作为回归兜底，这样修复不破坏其他测试。
34. 作为开发者，我希望 bot 验证遇 flaky 时标 @Skip/@Disabled，这样 flaky 不阻塞修复 MR。
35. 作为开发者，我希望 bot 钉钉单独通知 flaky，这样不污染修复 MR 的 review。

### MR 与通知

36. 作为开发者，我希望 bot 开带修复摘要的 MR，这样我能 review 和 merge。
37. 作为开发者，我希望 bot 在不完整修复（卡住/达 max-turns）的 MR 上标注，这样我能从 bot 停的地方接手。
38. 作为开发者，我希望转交 MR 带诊断摘要，这样我理解为什么它修不了。
39. 作为开发者，我希望 bot 对修复成功/转交/异常发钉钉通知，这样我不用查 MR 就始终知情。
40. 作为开发者，我希望钉钉通知与 MR 解耦，这样即使没开 MR（如 class 4/5 转交）我也能收到通知。
41. 作为项目维护者，我希望 merge 前强制人工 review，这样 bot 绝不自动 merge。
42. 作为开发者，我希望 bot 修不动时直接转交（不多次重试），这样它不在无望案例上烧预算。

### 安全

43. 作为 DevOps 工程师，我希望 bot 隔离每个 worker 的目录、session、配置（PI_CODING_AGENT_DIR + --session-dir + cwd），这样并发 worker 不泄漏状态。
44. 作为安全工程师，我希望 bot 把 secret 存 .env（chmod 600、gitignore、永不提交），这样凭证不被暴露。
45. 作为安全工程师，我希望 bot 只写测试/文档目录，这样生产源码受保护。
46. 作为安全工程师，我希望 bot 只读复用 .m2，这样 Maven 缓存共享但不被写污染。
47. 作为安全工程师，我希望 bot 归档所有 diff 和 LLM 推理痕迹，这样坏修复可事后追溯。
48. 作为安全工程师，我希望 bot 锁依赖版本 + 跑 pnpm audit，这样供应链攻击被缓解。
49. 作为安全工程师，我希望 bot 在受限 OS 用户（v1）或容器非 root 用户（docker 演进）下跑，这样 FS 访问被收窄。

### 可观测性与运维

50. 作为 DevOps 工程师，我希望结构化 JSON 日志 + 轻量指标（SQLite/文件），这样无外部依赖也能监控。
51. 作为 DevOps 工程师，我希望每次修复的 trace（项目/失败类/turns/tokens/成本/结果/MR 链接），这样我能审计单次修复。
52. 作为 DevOps 工程师，我希望 bot 自故障（webhook 不可达、worker 全死、配额耗尽）发钉钉告警，这样我被主动通知。
53. 作为 DevOps 工程师，我希望有成本估算公式，这样在没实测数据前能做预算。
54. 作为 DevOps 工程师，我希望 bot 部署为单进程 TS 服务 + 按需 spawn worker 子进程（v1 本地，docker 演进），这样部署简单不需要 k8s。

### 演进

55. 作为架构师，我希望 spec 文档化演进接缝（拆 subagent、换 SDK、docker 部署、容器隔离），这样未来增长路径清晰。
56. 作为架构师，我希望 bot 在预算软上限证明不够时从 pi 切到 Claude SDK，这样能拿回硬成本上限。
57. 作为架构师，我希望 bot 在 context 压力或多模块失败超出单 agent 能力时拆 subagent（pi-subagents 扩展），这样诊断/修复质量不随规模退化。
58. 作为架构师，我希望 bot 在 prompt 注入威胁升级时加容器/microVM 隔离，这样 LLM 生成的测试代码逃不出 worker 边界。

## 实现决策

### SDK 与语言

- **核心 SDK**：pi（v1）。TypeScript 实现。pi 提供 `createAgentSession`（Node.js SDK）做 headless agent 调用。理由：pi 的 `/skill:name` 确定性命令加载直接缓解 headless"模型没读 skill"风险（对比 Claude SDK 的 LLM 语义匹配非确定）；pi skill 零迁移（已有 java-coding-standards/springboot-tdd 原样复用）；pi 全原生模型覆盖（DeepSeek/Kimi/OpenRouter→Qwen/Bedrock/Vertex/Ollama/vLLM）无需协议转换代理。
- **SDK 可换性**：spec 写死 pi(TS) 具体设计。演进接缝：若 pi 自建预算软上限超支频发，切回 Claude SDK 拿回原生 `max_budget_usd` 硬上限。切回成本：语言/MCP/通知/pipeline 零成本（均 SDK 无关）；最大成本是 skill 表达范式转换（pi `/skill:name` 确定性 → Claude AgentDefinition prompt + LLM 语义匹配，从确定退化到非确定）；预算控制是增益。
- **MCP 形态**：外部服务（stdio 子进程或 HTTP 远程）。MCP 协议语言无关；bot(TS) 可调任何语言的 MCP server。不用 in-process MCP server。agent 不持钉钉 MCP 工具。
- **语言**：TypeScript。主流 SDK（pi / Claude / Codex）都有 TS 版本；TS 是跨 SDK 最大公约数。Node 依赖管理用 pnpm。

### Agent 编排（v1：单 agent）

- v1 用单主 agent + skills 启用 + `/skill:name` 确定性加载。agent 每次修复跑一个连续 session（诊断 → 修复 → 同步文档 → 输出结构化结果）。诊断结论在 context 内天然传递（无跨模型脱节）。v1 不做 subagent 路由。
- **Skill 加载**：prompt 显式点名语言 skill（"处理 Java 单测失败时先读 java-coding-standards"）+ `/skill:name` 命令强制确定性加载（双重保险）。已有 pi skill（java-coding-standards、springboot-tdd、springboot-patterns、python-patterns）零迁移复用。
- **结构化结果输出**：session 结束时 agent 输出结构化结果（成功/转交/flaky/诊断摘要）。bot 代码读结果执行后续动作（开 MR/通知钉钉）。agent 不直接调钉钉。
- **演进接缝（拆 subagent）**：触发 = context 压力超阈值/失败涉及多模块/诊断与修复能力需求差异大到单模型扣不住。机制：用 pi-subagents 扩展（per-agent model + skills + 独立 context）；诊断/修复/文档三段搬到 subagent；诊断结论结构化输入传给修复 subagent；skill 仍用 `/skill:name` 在 subagent scope 内确定性加载。

### 模型与 Provider

- **v1 模型策略**：单一主模型（多模型路由降级为演进目标）。
- **Provider**：直连，通过 pi 原生 provider 配置（models.json 声明式 + env 插值 + InMemoryCredentialStore）。候选：DeepSeek、Kimi（For Coding）、OpenRouter（路由 Qwen）、Ollama（本地）。无代理层。每个 provider 独立配置，切换改代码非配置。
- **Fallback 链**：主 → 同族备用 → 转人工。不跨族降级（避免行为不一致）。同族备用可能和主端同时挂（同服务商故障），但跨族降级的成本跳升和行为差异风险更大。
- **预算控制**：双层。(1) subagent `max_turns`（防循环，pi-subagents 支持）。(2) 全局预算（防失控，pi 自建）：SDK 监听 `turn_end` 事件 + 累计 token + 超阈值调 `session.abort()` + 钉钉告警。**软上限风险**：abort 在 turn 结束后触发，单 turn 内可能已超支（如大 tool call）。缓解：设激进的单 turn token 阈值 + abort + 钉钉告警。演进接缝：超支频发 → 切 Claude SDK 硬上限。

### 失败分类法（G1）

5 类根因分类法。v1 只自动修 1/2/3；4/5 转人工。

| 类别 | 根因 | v1 动作 |
|------|------|---------|
| 1 | 测试 bug（断言/mock/数据错） | 修测试 |
| 2 | 被测代码变更致测试过时 | 更新测试期望/mock；若行为变更，同步文档 |
| 3 | 测试缺失 | 按 spec/PRD 补规格符合性测试（非"让代码能跑过"） |
| 4 | 环境/flaky | 转交，不修 |
| 5 | 非单测根因（编译/依赖） | 转交，out of scope |

- **原则**：根因可能不在本服务的一律不自动修。
- **判定信号**：CI 日志摘要 + 本地执行（双源，非仅 webhook）。
- **class 5 早筛**：bot 代码在 spawn agent 前用关键词粗筛（编译错/依赖解析），省预算。
- **class 3 规格符合性**：测试断言"spec 规定的正确行为"而非"代码当前行为"（避免固化 bug）。spec 位置：仓库内 spec 目录（如 docs/spec/、specs/、docs/adr/）。代码行为 ≠ spec → 转交。spec 不可读/缺失 → 转交。
- **class 4 vs 5 分离**：class 5 早转交（CI 日志可判定，省预算）；class 4 晚转交（本地复现/历史分析后才识别）。

### 修复策略（G3）

- **权限边界**：只碰测试和文档，绝不碰生产代码（src/main）。发现生产代码 bug → 转交。
- **class 1/2（测试 bug/过时）**：改断言/期望/mock 值 + 轻量测试结构重构（拆过大方法、修 mock 位置）。演进接缝：若重构频发引入新 bug，收回为只改断言。
- **class 3（测试缺失）**：按 spec/PRD 补规格符合性测试，只补失败相关路径（窄→宽）。
- **class 2 文档同步**：只动直接相关段落（API 描述、参数、返回语义）。不全文重写，不碰无关段落。
- **review 强度**：强制人工 review（不自动 merge）。

### Pipeline 编排（G2）

```
GitLab webhook（pipeline 失败）
  → bot：签名校验 + IP 白名单 + 限流 + pipeline-id 幂等去重
  → bot：全局队列（并发上限 N，按项目串行）
  → bot：spawn worker（per-worker PI_CODING_AGENT_DIR + --session-dir + cwd）
  → bot：glab 取 CI 日志 + MR diff + pipeline 状态
  → bot：粗筛 class 5（关键词）？→ 早转交 + 钉钉
  → bot：本地 clone + 受限用户 + .m2 只读挂载
  → bot：起 pi agent session（createAgentSession，预算软上限已设）
  → agent：读 CI 日志 + diff + 源码，分类（G1 1/2/3）
      ├─ class 4 flaky/环境 → 转交不修 + 钉钉
      └─ class 1/2/3 → 读 spec（class 3）+ 修复/补测试
          （/skill:name 加载 java-coding-standards；prompt 点名 skill）
          → 行为变更？→ 同步 spec/文档
  → bot：验证关卡（相关测试快反馈 + 全量兑底）
      ├─ 全绿 → 开 MR 带修复摘要 + 钉钉成功
      ├─ 遇 flaky → 标 @Skip/@Disabled + 独立钉钉（不混入修复 MR）
      └─ 卡住/达 max-turns → 转交，MR 带未完成标记 + 诊断摘要 + 钉钉
```

- **渠道**：混合——glab 取结构化元数据（CI 日志、MR diff、pipeline 状态，快判定），本地 clone+执行做复现/读源码/spec/blame/跑测试（深诊断）。两套认证：GitLab token 经 .env 注入 worker。
- **通知路径**：纯 bot 代码在确定性 pipeline 节点调钉钉（修复成功/转交/验证遇 flaky/bot 自故障）。agent 只输出结构化结果，不持钉钉 MCP 工具。理由：headless 终态通知必须确定（R2 证实 LLM 语义匹配非确定）。

### 并发模型（G4）

- **Worker 供给**：按需 spawn（事件来 → spawn worker 跑 G2 pipeline → 退出）。零空闲成本。
- **触发源**：Pipeline 事件（非 job）。一个 pipeline 只触发一次；同 pipeline 多 job 失败自然聚合成一次修复（无需去重/合并逻辑）。
- **跨 pipeline 过期**：按项目串行队列。worker 跑完当前 pipeline，再取队列最新。过期 commit 的 MR 标"rebase 或丢弃" + 钉钉通知。不中断（不浪费已消耗 turn）。跨 commit 事件不合并（各自独立，串行）。
- **隔离**：per-worker 独立 `PI_CODING_AGENT_DIR` + `--session-dir` + `cwd`（pi 共享状态隔离）。bot 代码层，非 SDK 默认。
- **背压**：全局并发上限 N + 溢出 FIFO 排队（不丢）。队列过长 → 钉钉告警（人工可介入）。N 值依赖部署机资源（实测 TBD）。

### 沙箱与安全（G5）

- **沙箱**：目录隔离 + 受限 OS 用户，不用容器（v1）。威胁模型 B：内部可信项目，LLM 产错非恶意。演进接缝：威胁升级到 A（prompt 注入实质化）→ 加容器/microVM。
- **Secret**：.env 优先 + 环境变量。GitLab token、模型 API key、MCP auth 存 .env（chmod 600、.gitignore、永不提交）。bot 读 .env，不持久化 secret。
- **LLM 审计**：全归档 diff + MR 描述 + LLM 推理痕迹（诊断结论、根因、修复理由）到日志/对象存储。坏修复可事后追溯。
- **供应链**：版本锁 + pnpm-lock + pnpm audit。MCP server 来源限官方/可信。
- **写权限（G3）**：仅测试/文档，src/main 禁写。
- **权限矩阵**：

| 对象 | 读 | 写 | 备注 |
|------|----|----|------|
| 项目 checkout | ✅ | ✅（测试/文档目录） | G3 禁 src 写 |
| spec 目录 | ✅ | ✅（class 2 行为变更） | G1 定 |
| .m2 | ✅ | ❌ | 只读复用 |
| ~/.ssh、~/.aws 等 | ❌ | ❌ | 受限用户 + chmod |
| .env（secret） | ✅ | ❌ | chmod 600 + .gitignore |

- **演进接缝（docker）**：bot 服务 docker 部署。worker = 容器内 fork/exec（非 docker-in-docker/DooD）。G5 受限用户 → 容器非 root 用户（Dockerfile `USER`）。目录隔离 + chmod 不变。.m2 通过 volume 只读挂载。`PI_CODING_AGENT_DIR` 指向容器内配置。进一步演进到 per-worker 容器（DooD）需重开 G5。

### 部署与运维（G7）

- **运行时（v1）**：本地目录部署。单进程 bot（TS）+ 按需 spawn worker 子进程。宿主预装 Node + pnpm + JDK + Maven。无容器，无 k8s。
- **GitLab webhook**：公网 HTTPS 端点 + 签名校验（`X-Gitlab-Token`）+ IP 白名单（GitLab 出口 IP）+ 限流。pipeline-id 幂等去重。GitLab webhook 默认重试 4×；bot 长宕丢失事件（尽力自愈，非关键路径，丢事件 = 不修复，人工可重触发）。
- **可观测性**：结构化 JSON 日志 + 轻量指标（SQLite/文件，无外部依赖）。每次修复 trace：项目/失败类/turns/tokens/成本/结果/MR 链接。指标：成功率/平均修复时长/成本/修复。演进接缝：Prometheus + Grafana。
- **告警**：钉钉统一（扩展 G2 修复结果通道）。bot 自故障（webhook 不可达/worker 全死/配额耗尽）也发钉钉。演进接缝：多通道（钉钉 + 邮件）。
- **成本估算**：公式 + 量级，数值实测 TBD。单次修复：5k–20k token（诊断 + 修复 + 文档，取决于失败复杂度 + diff/源码/日志量）。月峰值：`N × 日均修复数 × token × 单价 × 30`。`max_budget_usd` 软上限按修复 cap（pi 自建）。

### 模块清单

- **Webhook 接收器**——GitLab pipeline 事件接入、签名校验、IP 白名单、限流、pipeline-id 幂等去重。
- **事件队列与调度器**——全局 FIFO 队列、并发上限 N、按项目串行队列、跨 pipeline 过期（取最新）。
- **Worker 管理器**——按需 spawn worker 子进程（TS）、per-worker 隔离配置（PI_CODING_AGENT_DIR + --session-dir + cwd）、worker 生命周期（spawn → 跑 → 退出）、资源限制。
- **GitLab 客户端**——glab CLI 封装：CI 日志、MR diff、pipeline 状态、创建 MR；GitLab token 取自 .env。
- **Agent 运行器**——pi SDK `createAgentSession`、skill 加载（`/skill:name`）、prompt 点名语言 skill、预算控制（turn_end + abort 软上限）、结构化结果输出。
- **诊断分类器**——G1 五类分类法；bot 代码粗筛 class 5（关键词）；agent 深分 1–4。
- **修复执行器**——G3 playbook：class 1/2 测试修复（断言/mock + 轻量重构）、class 3 规格符合性测试、class 2 文档同步（仅相关段落）；绝不碰生产代码。
- **验证关卡**——相关测试快反馈 + 全量回归兜底；flaky → @Skip/@Disabled + 独立钉钉。
- **MR 创建器**——glab 创建 MR，带修复摘要/转交标记 + 诊断摘要。
- **通知服务**——钉钉 SDK，确定性节点（修复成功/转交/flaky/bot 自故障）；agent 不持钉钉工具。
- **可观测性**——结构化 JSON 日志、SQLite 指标存储、每次修复 trace。
- **配置加载器**——项目级配置（GitLab 仓库/token/模型偏好）、.env secret 加载。
- **审计归档**——diff + LLM 推理痕迹持久化。

## 测试决策

### 测试接缝

**单一端到端接缝**：GitLab webhook 端点 → MR 创建/转交/钉钉通知（黑盒）。

这是最高可能接缝——上面是 GitLab（测不了），下面是内部细节（SDK 调用、skill 触发、worker 状态），那些脆弱且不是用户/reviewer 关心的。

### 什么是好测试

- 测**外部行为**（MR diff 正确性、通知送达、转交恰当性），**不测**实现细节（Claude SDK / pi 内部怎么调、skill 是否触发、worker 子进程状态）。
- 测试要编码**为什么这个行为重要**，不只是**发生了什么**。如"class 3 补测试必须断言 spec 行为而非当前代码行为"测的是反 bug 固化意图，不只是"加了个测试"。
- 测试用 **fixture** 代替 agent（pi `createAgentSession` stub 返回 canned 诊断 + fix diff）和 GitLab API（glab 调用被拦截验证参数，不开真 MR）。

### 测试矩阵（fixture 驱动，单一接缝）

| Given（webhook fixture） | Expected（外部行为） |
|---|---|
| class 1（测试 bug） | 开 MR，diff 只碰测试文件，钉钉成功通知 |
| class 2（过时 + 行为变更） | MR 碰测试 + 同步相关 spec 段落 |
| class 3（测试缺失，spec 可读） | MR 补规格符合性测试，针对失败路径 |
| class 3（spec 不可读） | 转交，钉钉通知，不开 MR |
| class 3（代码 ≠ spec） | 转交，钉钉通知 |
| class 4（flaky/环境） | 转交（不修），钉钉通知，不开 MR |
| class 5（编译错） | 早转交（不起 agent），钉钉通知 |
| 同 pipeline 重试 | 只触发一次修复（pipeline-id 幂等） |
| pipeline B 在 A 跑时到达 | A 跑完再取 B；A 的 MR 标过期 |
| 并发达上限 N | 事件排队，不丢 |
| agent 卡住/达 max-turns | 转交 MR 带未完成标记 + 诊断摘要，钉钉 |
| 验证遇 flaky | 标 @Skip/@Disabled + 独立钉钉，不混入修复 MR |
| 无效 webhook 签名 | 拒绝（401/403），不处理 |
| bot 自故障（webhook 不可达） | 恢复后钉钉告警 |

### 此接缝不测什么（实现细节）

- pi SDK 内部 `createAgentSession` 调用机制。
- skill 触发机制（R2 证实非确定；测它脆弱）。
- worker 子进程内部状态。
- prompt 执行（模型是否"读了"skill——由验证关卡 + MR review 兜底）。

### 前序实践

Greenfield 仓库——无既有测试模式可循。选单一接缝以最小化测试面；若实现暴露出某个复杂内部模块（如 G1 分类逻辑）需隔离测试，优先用不同 fixture 在端到端接缝覆盖它，再下沉新接缝。只有当端到端测试太慢或无法触达分支时才下沉新接缝。

## 范围外

- **bot 实现（destination 形态 A）**：本 spec 是设计文档；把它变成跑起来的系统是下一个 effort。
- **非单测 CI 失败**（lint/build/typecheck/integration/e2e）：v1 只处理单测失败；按用户"窄→宽"偏好，这些是后续扩展。
- **自动 merge MR**：用户选强制人工 review。
- **主动覆盖率巡检**：用户选被动（仅 CI 失败时；无覆盖率信号触发）。
- **多 CI 平台抽象**：v1 只 GitLab CI；GitHub Actions 等是后续扩展。
- **主动文档一致性检查/语义 diff**：用户选被动（仅修复中行为变更时）。
- **per-worker 容器隔离（DooD）**：v1 用目录隔离；DooD 需重开 G5。
- **多模型路由**：v1 用单一主模型；多模型 subagent 路由是演进目标。

## 补充说明

### 演进接缝（spec 文档化，非模糊延后）

1. **拆 subagent**：触发 = context 压力/多模块失败/能力差异。机制 = pi-subagents 扩展（per-agent model + skills + 独立 context）。诊断/修复/文档三段搬到 subagent；诊断结论结构化输入传给修复 subagent；skill 仍用 `/skill:name` 在 subagent scope 内。
2. **换 SDK**：触发 = pi 预算软上限超支频发（单 turn 超支不可控）。机制 = 切 Claude SDK（TS 同进程 import）。替代：`/skill:name` → AgentDefinition prompt（确定→非确定，接受退化）；零迁移 skill → 重构为 subagent prompt；MCP 外部服务不变；语言/pipeline 不变；预算控制增益（原生 max_budget_usd 硬上限）。
3. **docker 部署**：触发 = 部署标准化/可移植需求。机制 = bot 服务 docker 化；worker = 容器内 fork/exec（非 DooD）；G5 受限用户 → 容器非 root 用户；.m2 通过 volume 只读挂载。
4. **容器/microVM 隔离**：触发 = prompt 注入威胁升级（威胁模型 A）。机制 = 加 gVisor/Firecracker/独立容器做 worker 执行隔离（R1：layer-7 不够，需内核级）。
5. **重构范围收紧**：触发 = LLM 测试重构频发引入新 bug。机制 = class 1/2 从"轻量重构"收回为"仅断言/期望/mock"。

### 待实测验证项（写入 spec，实现期 TBD）

- pi 自建预算控制（turn_end + abort）在单 turn 超支场景的实际刹车效果。
- pi-subagents 扩展的 per-agent model override + skills 在 headless 并发下的稳定性。
- `/skill:name` 在 RPC/SDK `prompt()` 中是否可靠展开（R4 gap）。
- pi 同进程多 AgentSession 并发事件总线隔离（R4 gap）。
- stdio MCP 通过 env 传 token（pi 无内置 MCP；扩展 OAuth 路径）。
- DeepSeek thinking mode + tool calls 多轮 `reasoning_content` 必须回传（#1378，跨 SDK 通用）。
- glab 取 CI 日志/MR diff 的 API 限流与重试策略。
- 本地 clone 大仓库的 shallow depth 与 git blame 兼容性（blame 需 history）。
