# G7: 部署与运维设计

> **wayfinder:grilling** · 状态: open · 类型: HITL（需用户在线，/grilling）· assignee: unclaimed
>
> **Blocked by**: G4（worker 供给影响部署形态）, G6（模型层影响 runtime 需求）

## Question

用户要 spec 含部署运维。本 ticket grilling 出 bot 长驻服务的部署形态、监控、告警、成本。

1. **runtime 形态**：单进程多 worker、多进程、容器化、还是编排（k8s）？**依赖 G4 worker 供给方案**。模型层（G6）是否要求特定 runtime（如 GPU 节点、Bedrock 凭据）。
2. **GitLab webhook 接入**：服务暴露方式（公网 webhook + 签名校验、还是 GitLab sidecar/queue）、事件去重、重放保护。
3. **可观测性**：每次修复的 trace（哪个项目、哪类失败、花了多少 token、修没修成、MR 链接）、指标（成功率、平均修复时长、成本/修复）、日志聚合。
4. **告警**：bot 自身故障（webhook 收不到、worker 全死、配额耗尽）怎么告警。
5. **成本**：预估并发规模下的月成本量级（依赖 G6）。

## 产出

部署运维章节 spec（拓扑图 + 资源需求 + 监控/告警/成本）。归档 `research/g7-deployment.md`。
**注意**：先建框架，具体栈随 G4/G6 落地填充。
