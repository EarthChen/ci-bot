# 03 — 全 G1 分类（1/2/3 修，4/5 转交）+ spec 读 + 文档同步

**要构建什么：** 把 agent 诊断扩展到全部五类 G1 根因。class 2（被测代码变更致测试过时）：更新期望/mock + 轻量测试重构 + 行为变更时同步相关 spec 段落。class 3（测试缺失）：读仓库内 spec/PRD，按规格补符合性测试，只针对失败路径（窄→宽）；代码行为 ≠ spec 或 spec 不可读 → 转交。class 4（flaky/环境）：转交不修。class 5（非单测根因：编译/依赖）：bot 代码在 spawn agent 前用关键词粗筛，早转交省预算。spec 诊断阶段读（class 3）、修复后阶段写（class 2 行为变更）——时序在 pipeline 内自然分离。

**Blocked by:** 02（真实 pi agent + class 1）

**Status:** ready-for-agent

- [ ] agent 把失败分到全部 5 类 G1（不只 class 1）
- [ ] class 2：改断言/期望/mock + 轻量测试结构重构（拆过大方法、修 mock 位置）；行为变更时只同步直接相关 spec 段落（API 描述/参数/返回语义）
- [ ] class 3：读仓库内 spec 目录（如 docs/spec/），补规格符合性测试，断言 spec 规定的正确行为（非当前代码行为）；只补失败相关路径
- [ ] class 3 边界：代码行为 ≠ spec → 转交；spec 不可读/缺失 → 转交
- [ ] class 4：转交不修，钉钉通知
- [ ] class 5：bot 代码关键词粗筛（编译错/依赖解析）在 spawn agent 前 → 早转交 + 钉钉（省预算）
- [ ] spec 读写时序：诊断阶段读 spec（class 3），修复后阶段写 spec（class 2 行为变更）
- [ ] 权限边界强制：只写测试/文档，src/main 禁；发现生产代码 bug → 转交
- [ ] 端到端 fixture：class 2（过时+行为变更 → 测试+spec 同步）、class 3（spec 可读 → 符合性测试）、class 3（spec 不可读 → 转交）、class 3（代码≠spec → 转交）、class 4（flaky → 转交）、class 5（编译错 → 早转交不起 agent）
