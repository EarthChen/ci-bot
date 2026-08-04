# G5: 沙箱化与安全边界

> **wayfinder:grilling** · 状态: ✅ closed · 类型: HITL（需用户在线，/grilling）· assignee: 当前 session
>
> **Blocked by**: —
>
> **Resolution**: 沙箱化与安全边界已定。核心约束: G3 定 bot 只改测试/文档, src 禁写(写权限不重 grill); G2 定 GitLab token 注入 worker; G4 定全显式配 R1 四条泄漏通道 + per-worker cwd。
>
> ## 子决策
>
> 1. **沙箱形态**: **目录隔离 + 受限用户，不用容器**(用户选 B 威胁模型)。每项目独立 cwd(G4 已定) + OS 用户/chmod 收窄 FS 访问轻量防线。LLM 测试代码跑在 worker 进程, 能读宿主但目录隔离+权限收窄。
>    - **威胁模型 B**: 内部项目, CI 内容可信, LLM 产出错误而非恶意。用户判定 prompt injection 低威胁。
>    - **演进接缝 1(威胁升级)**: 威胁升级到 A(prompt injection 成实质风险) → 加容器/microVM 做执行隔离(R1 说 layer-7 不够要内核级)。
>    - **演进接缝 2(docker 部署)**: bot 服务 docker 部署时(G7 演进), 受限用户调整为容器内统一非 root 用户(Dockerfile `USER`), 替代宿主 per-worker 用户; 目录隔离(cwd)+chmod 不变; 多一层容器边界(额外收益)。注意: 此处 docker 是 bot 服务打包边界, 非 worker 额外容器化(G5 的"不用容器"=worker 执行隔离不额外套容器, 不冲突)。
> 2. **写权限(G3 已定)**: 只改测试目录 + 文档目录, src/main 禁写。不重 grill。
> 3. **Secret 管理**: **.env 优先 + 环境变量两种方式**(用户选, 偏离推荐)。GitLab token/模型 API key/MCP auth 优先 .env 文件, 备环境变量。**风险标注**: .env 是落盘文件(与"不落盘"相反), 需 chmod 600 + .gitignore + 不提交仓库 + 机器访问控制缓解。轮转: 人工/CI 定期换, bot 读 .env 不持久 secret。
> 4. **LLM 审计**: **全归档 diff + 推理痕迹**。每次修复产出 diff + MR 描述 + LLM 推理痕迹(诊断结论/根因/修复思路) 归档到日志/对象存储。坏修复可事后追溯。与 G2 'MR 带诊断摘要'一致。
> 5. **供应链**: **版本锁 + pnpm audit**。bot 依赖(Claude SDK TS 包 + MCP server) pin 版本 + pnpm-lock + 定期 pnpm audit。MCP server 来源限定官方/可信。
>
> ## 权限矩阵(汇总)
>
> | 对象 | 读 | 写 | 备注 |
> |---|---|---|---|
> | 项目 checkout | ✅ | ✅(测试/文档目录) | G3 禁 src 写 |
> | spec 目录 | ✅ | ✅(类别2行为变更时) | G1 定 |
> | .m2 | ✅ | ❌(仅复用缓存) | 读复用省下载 |
> | ~/.ssh, ~/.aws 等 | ❌ | ❌ | 受限用户+chmod 隔离 |
> | .env (secret) | ✅ | ❌ | chmod 600 + .gitignore |
>
> Resolution 详情存本票; 无单独 brief 文件(安全边界 spec 即产出)。

## Question

bot 执行 LLM 生成的代码、测试、可能改被测代码与文档——安全是硬约束。本 ticket grilling 出沙箱化与权限边界，写入 spec 的安全章节。

1. **代码执行隔离**：跑 LLM 生成的测试/被测代码在什么沙箱（容器、microVM、namespace）？网络/文件系统/secret 访问怎么切。**与本地 .m2 复用的张力**：用户要求本地执行时复用宿主 .m2/依赖（省下载），但沙箱要隔离 FS 防 LLM 代码乱写——grilling 只读挂载 .m2 + 写隔离方案，还是放弃复用全量隔离。
2. **写权限**：bot 对仓库的写权限范围——只能动测试目录、还是允许动 src、允许动文档？按项目可配？
3. **secret 与凭据**：bot 持有的 GitLab token、模型 API key、MCP auth 怎么存、怎么注入 worker、怎么轮转。**触发 security-reviewer**。
4. **LLM 输出审计**：bot 产出的 diff/MR 描述是否记录 LLM 的推理痕迹（便于事后追溯坏修复根因）？
5. **供应链**：bot 装的依赖、MCP server 本身可信度怎么保证。

## 产出

安全边界 spec（沙箱方案、权限矩阵、secret 管理、审计日志要求）。归档 `research/g5-security.md`。
