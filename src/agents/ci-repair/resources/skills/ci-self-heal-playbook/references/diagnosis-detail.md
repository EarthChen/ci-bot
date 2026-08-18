# 诊断详表 — G1 五类分类法

本文档是 `ci-self-heal-playbook` 的层 3 详尽参考，按需 Read。

> 先经 [范围闸](scope-gate-detail.md) 定 stage + 路径分流；本表只在「可修」分支内做五类归类。

## 判定总原则

诊断顺序：**先读 CI 日志确认失败现象 → 读 MR diff 找被测代码变更 → 读失败测试源码 + 被测源码定位根因 → 归类**。不读完这三者不归类，不猜。

## class 1 — 测试 bug（断言/mock/数据错）

**定义**：测试本身写错了。被测代码行为正确，测试断言/mock/数据有误。

**信号**：

- 断言期望值与被测代码实际返回不符，且被测代码逻辑正确（读源码确认）。
  - 例：`assertEquals(4, new Calculator().add(2, 3))` — add 返回 5 是正确的，断言 4 错。
- mock 返回值过时（被测代码已改逻辑，mock 还返回旧值，但被测代码本身改对了）。
- 测试数据硬编码错（如期望列表 `[a, b]` 但实际应是 `[a, b, c]`，且 c 的加入是被测代码正确行为）。

**反例（不要误判为 class 1）**：

- 被测代码返回错误值 → 那是 class 2（被测代码变更）或生产 bug（转交），不是测试 bug。
- 断言期望改了但被测代码没动过 → 可能是 class 1，但要确认是被测代码历史 bug 还是真的测试笔误。读 git history 辅助判断。

**关键**：class 1 的被测代码必须是**正确的**。改测试前务必读被测源码确认其行为正确。

## class 2 — 被测代码变更导致测试过时

**定义**：MR diff 改了被测代码（签名/行为），测试没跟上。

**信号**：

- MR diff 含 `src/main/` 改动，且失败测试的调用点/断言与旧签名/旧行为匹配。
- 编译失败指向被测代码新签名（如方法改名/参数变）→ 偏 class 5，但若仅测试编译挂而生产编译通过，则 class 2。
- 被测代码行为变更（如返回值从单值变 Optional）→ 测试断言未更新。

**与 class 1 区分**：class 1 被测代码没变（或变对了），测试错；class 2 被测代码变了（变对变错都要看），测试没跟上。读 MR diff 是关键——有 `src/main/` 改动优先怀疑 class 2。

**修复后必做**：文档同步（见 doc-sync-detail）。

## class 3 — 缺失测试

**定义**：spec/PRD 要求某行为，但无测试覆盖，或新代码路径无测试。

**信号**：

- CI 日志/覆盖率报告显示某路径未覆盖。
- spec 明确要求某行为，搜索测试无对应断言。
- 新增被测代码（MR diff 加了新分支/方法）但无对应测试。

**铁律**：按 **spec/PRD 定义的正确行为** 断言，不按当前代码行为断言。若发现当前代码行为与 spec 不符 → 转交（不得改生产代码，也不得按 bug 行为写测试固化它）。

**与 class 2 区分**：class 2 是测试存在但过时；class 3 是测试根本不存在。

## class 4 — flaky / 环境问题

**定义**：非确定性失败，本地通过 CI 失败，或偶发。

**信号**：

- 时间相关断言（`new Date()`、`Instant.now()`、依赖时区）。
- 网络/外部依赖（数据库、HTTP、文件系统时序）。
- 并发/线程相关（偶发死锁、竞态）。
- CI 日志含 "connection refused"、"timeout"、"read-only filesystem"。
- 同一测试历史时而绿时而红。

**处理**：转交人工。v1 不处理 flaky。

## class 5 — 非单测失败（编译/依赖）

**定义**：失败不在 test phase，或编译/依赖解析阶段就挂了。

**信号**：

- `BUILD FAILURE` + `compilation error`。
- `cannot resolve dependencies` / `dependency resolution failed`。
- 失败 stage 不是 `test`（是 `build`/`compile`/`package`）。
- `Could not find artifact`。

**处理**：bot 代码只早筛依赖错；编译错一律交你判定。判断：生产代码编译挂 = class 5；仅测试编译挂且生产编译通过 = class 2（典型：被测签名变更，改测试适配）。

## 混淆与优先级

- class 4 vs 5：class 5 早转交（日志可判定）；class 4 晚转交（需本地复现/历史分析）。不确定时按 class 4 转（给人工复现的机会）。
- class 1 vs 2：有 MR diff 改 `src/main/` → 优先 class 2；无 → 优先 class 1（但要读 git history 排除历史 bug）。
- class 2 vs 3：测试存在但过时 = 2；测试不存在 = 3。
- 多 class 叠加：按**最严重可处理**归类（class 1+2 叠加按 2，因 2 需文档同步）。
