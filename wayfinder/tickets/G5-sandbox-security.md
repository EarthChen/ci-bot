# G5: 沙箱化与安全边界

> **wayfinder:grilling** · 状态: open · 类型: HITL（需用户在线，/grilling）· assignee: unclaimed
>
> **Blocked by**: —

## Question

bot 执行 LLM 生成的代码、测试、可能改被测代码与文档——安全是硬约束。本 ticket grilling 出沙箱化与权限边界，写入 spec 的安全章节。

1. **代码执行隔离**：跑 LLM 生成的测试/被测代码在什么沙箱（容器、microVM、namespace）？网络/文件系统/secret 访问怎么切。
2. **写权限**：bot 对仓库的写权限范围——只能动测试目录、还是允许动 src、允许动文档？按项目可配？
3. **secret 与凭据**：bot 持有的 GitLab token、模型 API key、MCP auth 怎么存、怎么注入 worker、怎么轮转。**触发 security-reviewer**。
4. **LLM 输出审计**：bot 产出的 diff/MR 描述是否记录 LLM 的推理痕迹（便于事后追溯坏修复根因）？
5. **供应链**：bot 装的依赖、MCP server 本身可信度怎么保证。

## 产出

安全边界 spec（沙箱方案、权限矩阵、secret 管理、审计日志要求）。归档 `research/g5-security.md`。
