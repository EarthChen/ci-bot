# G7: 部署与运维设计

> **wayfinder:grilling** · 状态: ✅ closed · 类型: HITL（需用户在线，/grilling）· assignee: 当前 session
>
> **Blocked by**: G4, G6（均已 closed，解锁本票）
>
> **Resolution**: 部署运维设计已定。上游已定事实直接用: G4 按需 spawn + 全局并发 N; G6 TS+Claude SDK+单主模型+.env; G5 不用容器(目录隔离+受限用户)。
>
> ## 子决策
>
> 1. **runtime 形态(G4/G5 已收敛)**: **单进程 bot 主进程(TS) + 按需 spawn worker 子进程**。不用容器(G5), 不用 k8s 编排(G5 无容器)。worker=TS 子进程跑 Claude SDK `ClaudeSDKClient`(每 worker 独立 cwd + R1 四条隔离配置, G4 已定)。
> 2. **GitLab webhook 接入**: **公网 webhook + 签名校验**(GitLab `X-Gitlab-Token` header) + IP 白名单(GitLab 出口 IP) + 限流。**幂等去重**: pipeline id 去重(G4 已定 pipeline 级触发, 天然防 job 重发; 跨重发靠 pipeline id 幂等)。GitLab webhook 默认重试 4 次, bot 长挂会丢事件(best-effort 自愈, 非关键路径, 丢事件=不修人可手补)。
> 3. **可观测性**: **结构化 JSON 日志 + 轻量指标**(SQLite/文件, 无外部依赖)。每修复一个 trace: 项目/失败类/turn数/token/成本/结果/MR链接。指标: 成功率/平均修复时长/成本/修复。反例: 查询聚合不如专业栈, v1 够用, 留演进到 Prometheus+Grafana。
> 4. **告警**: **钉钉统一**(扩展现有 G2 修复结果钉钉)。bot 自身故障(webhook 收不到/worker 全死/配额耗尽) 也发钉钉。单一通道, 简单。演进接缝: 多通道(钉钉+邮件)留后续。
> 5. **成本估算**: **公式 + 量级, 数值待实测**。
>    - **单次修复 token 量级**: 诊断+修复+文档 约 5k-20k token(取决于失败复杂度 + git diff/源码/日志量)
>    - **月峰值成本公式**: `N(并发) × 日均修复次数 × 单次 token × 单 token 价格 × 30`
>    - **数值依赖实测**: G6 max_budget_usd 设单次上限 + 单次诊断/修复 turn 量实测后填具体数值
>    - **并发 N 具体值**: 依赖部署机器资源(CPU/内存), G7 先定机制
>
> ## 部署拓扑
>
> ```mermaid
> flowchart TD
>   GL[GitLab CI] -->|pipeline failed webhook| WH[bot: 公网 HTTPS endpoint]
>   WH -->|签名校验+IP白+限流| BOT[bot 主进程 TS]
>   BOT -->|pipeline id 幂等| Q[全局内存队列]
>   Q -->|并发 < N| W1[worker 子进程 1]
>   Q -->|并发 < N| W2[worker 子进程 2]
>   Q -->|并发 >= N, 等待| Q
>   W1 -->|跑 G2 pipeline| SDK1[ClaudeSDKClient]
>   W2 -->|跑 G2 pipeline| SDK2[ClaudeSDKClient]
>   SDK1 -->|开 MR/转人工+钉钉| GL
>   SDK2 -->|开 MR/转人工+钉钉| GL
>   BOT -->|结构化日志+SQLite| LOG[可观测性存储]
>   BOT -->|故障告警| DD[钉钉]
> ```
>
> ## 待实测/待定
>
> - 并发 N 具体值: 依赖部署机器资源。
> - 成本数值: 依赖 max_budget_usd 单次上限 + 单次诊断/修复 turn 量实测。
> - webhook 重试/丢失事件的补偿机制(如人工补触发)。
>
> Resolution 详情存本票; 无单独 brief 文件(部署运维 spec 即产出)。

## Question

用户要 spec 含部署运维。本 ticket grilling 出 bot 长驻服务的部署形态、监控、告警、成本。

1. **runtime 形态**：单进程多 worker、多进程、容器化、还是编排（k8s）？**本地执行形态作为选项**（复用宿主 .m2/依赖、省下载，与 G5 沙箱张力需协调）。**依赖 G4 worker 供给方案**。模型层（G6）是否要求特定 runtime（如 GPU 节点、Bedrock 凭据）。
2. **GitLab webhook 接入**：服务暴露方式（公网 webhook + 签名校验、还是 GitLab sidecar/queue）、事件去重、重放保护。
3. **可观测性**：每次修复的 trace（哪个项目、哪类失败、花了多少 token、修没修成、MR 链接）、指标（成功率、平均修复时长、成本/修复）、日志聚合。
4. **告警**：bot 自身故障（webhook 收不到、worker 全死、配额耗尽）怎么告警。
5. **成本**：预估并发规模下的月成本量级（依赖 G6）。

## 产出

部署运维章节 spec（拓扑图 + 资源需求 + 监控/告警/成本）。归档 `research/g7-deployment.md`。
**注意**：先建框架，具体栈随 G4/G6 落地填充。
