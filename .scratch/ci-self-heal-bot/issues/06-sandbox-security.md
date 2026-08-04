# 06 — 沙箱与安全（.m2 只读、受限用户、审计归档、供应链）

**要构建什么：** 按 G5 硬化 worker 执行环境。目录隔离（ticket 01 已有）加固；.m2 只读挂载复用（无写污染）；worker 跑在受限 OS 用户下，屏蔽 ~/.ssh、~/.aws 等；全量归档 diff 和 LLM 推理痕迹（诊断结论、根因、修复理由）供事后追溯；依赖版本锁 + pnpm-lock + pnpm audit；MCP server 来源限官方/可信。写权限强制：仅测试/文档，src/main 禁（G3）。威胁模型 B（内部可信，LLM 产错非恶意）；文档化演进接缝（威胁升级到 A → 加容器/microVM）。

**Blocked by:** 01（tracer bullet——需要 worker 来硬化）

**Status:** ready-for-agent

- [ ] .m2 只读挂载进 worker（复用 Maven 缓存，无写污染）
- [ ] 受限 OS 用户跑 worker；屏蔽 ~/.ssh、~/.aws、~/.config 等（chmod + 受限用户）
- [ ] LLM 审计归档：diff + MR 描述 + 推理痕迹（诊断/根因/修复理由）持久化到日志/对象存储
- [ ] 供应链：版本锁 + pnpm-lock 提交 + CI 跑 pnpm audit；MCP server 来源限官方/可信
- [ ] 写权限程序化强制：测试/文档目录可写，src/main 拒绝
- [ ] 权限矩阵实现：checkout 读写（测试/文档）、spec 读写（行为变更）、.m2 只读、secret 只读（chmod 600）
- [ ] 演进接缝文档化：威胁模型 A（prompt 注入）→ 加容器/microVM（gVisor/Firecracker）；内核级非 layer-7
- [ ] 测试断言：src 写被拒；.m2 写被拒；worker 读不到 .env 外的 secret 文件
