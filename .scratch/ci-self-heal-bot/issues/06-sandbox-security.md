# 06 — 沙箱与安全（审计归档、供应链、.m2 决策修正、演进接缝）

**要构建什么：** 按 G5 硬化 worker 执行环境。目录隔离（ticket 01 已有）加固；**.m2 决策修正**（原"只读挂载"在 Maven 写语义下不成立 → v1 共享可写，见 G5 amendment）；worker 跑在受限 OS 用户下（部署级，非 bot 代码）；全量归档 diff 和 LLM 推理痕迹（诊断结论、根因、修复理由）供事后追溯；依赖版本锁 + pnpm-lock + pnpm audit；MCP server 来源限官方/可信。写权限强制：仅测试/文档，src/main 禁（G3，ticket 01 已落地）。威胁模型 B；文档化演进接缝（威胁升级到 A → 加容器/microVM）。

**Blocked by:** 01（tracer bullet——需要 worker 来硬化）

**Status:** done

- [x] ~~.m2 只读挂载进 worker（复用 Maven 缓存，无写污染）~~ → **修正**：v1 用宿主共享可写 .m2（Maven .m2 既是读缓存也是写目标；只读会致 install/缺依赖验证假红；并发=1 无竞态；防污染靠威胁模型 B + G3 + 审计归档，非只读）。决策修正见 spec.md G5 amendment + worktree.ts 注释 + G5 ticket amendment。
- [x] 受限 OS 用户跑 worker → **文档化为部署级决策**（v1 宿主受限用户；docker 演进 = 非 root 容器 USER），非 bot 代码（跨平台脆弱，e2e 不可靠断言）。见 docs/security/supply-chain.md。
- [x] LLM 审计归档：diff + MR 描述 + 推理痕迹持久化 → **落地为 worker cwd sidecar `audit-trace.json`**（event/outcome/diagnosis/diff/reasoning/mrUrl/createdAt）。e2e 测试覆盖 fixed→MR、escalated、class5 早筛三条出口。生产 ship 到日志/对象存储 = ticket 07 演进接缝。
- [x] 供应链：版本锁 + pnpm-lock 提交 + pnpm audit 脚本 + CI 文档；MCP server 来源限官方/可信。见 docs/security/supply-chain.md + package.json `audit` script。
- [x] 写权限程序化强制：测试/文档目录可写，src/main 拒绝 → ticket 01 已落地（`validatePatchPaths`），tracer-bullet/G1 测试覆盖。
- [x] ~~权限矩阵实现：.m2 只读~~ → **修正**：.m2 共享可写（见上）；secret 只读（chmod 600 + .gitignore，ticket 01/02 已落地）；checkout 测试/文档读写、spec 读写（G1 定）。
- [x] 演进接缝文档化：威胁模型 A → 容器/microVM（gVisor/Firecracker，内核级）；并发>1 → per-project 隔离 .m2（部署配置）。见 docs/security/supply-chain.md + spec.md G5 amendment。
- [x] ~~测试断言：src 写被拒；.m2 写被拒；worker 读不到 .env 外的 secret 文件~~ → **修正**：src 写被拒（ticket 01 G3 测试已覆盖）；.m2 写被拒**不再断言**（v1 共享可写）；secret 文件不可达 = 部署级受限用户，e2e 不断言。
