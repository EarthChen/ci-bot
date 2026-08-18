# 修复详表 — G3 权限边界 + 每类 playbook

本文档是 `ci-self-heal-playbook` 的层 3 详尽参考，按需 Read。

> 本表 playbook 仅在 [范围闸](scope-gate-detail.md) 判定为「可修」后执行。

## 权限边界（铁律）

**允许写的路径**：

- `src/test/`、`src/it/`（测试源码）
- `docs/`、`*.md`（文档，仅 class 2 触发）
- `src/test/resources/`（测试资源）
- **MR diff 内的 `src/main`**（有限放宽，ADR-0006；仅限 class 2/3 且被测代码在 diff 内违背其自带 spec，见下方铁律）

**绝对禁止的路径**：

- diff 外的 `src/main`（生产代码）
- `pom.xml`、`build.gradle`、`settings.gradle`（构建配置）
- 仓库根的 `Dockerfile`、`ci/`、`.gitlab-ci.yml`（CI 配置）

任何 fix 的 file path 命中禁止路径 → **立即转交人工**，不得开 MR。bot 代码有 G3 校验兜底（`validatePatchPaths`），但 agent 应在输出前自检。

**src/main 放宽铁律**：只允许改实现去满足既有失败测试，**严禁改写这些测试的断言语义迎合实现**（编译适配除外）；一切测试语义改动必须在 MR 描述逐条申报。

## class 1 修复 playbook（测试 bug）

1. **读被测代码**确认正确行为。例：`Calculator.add(2,3)` 读源码确认返回 5。
2. **读失败测试**，定位错在哪：
   - 断言期望错（`assertEquals(4, ...)` 但正确值 5）→ 改期望。
   - mock 返回值过时（mock `when(calc.add()).thenReturn(4)` 但应返回 5）→ 改 mock 返回值。
   - 测试数据错（`List.of("a","b")` 但应含 "c"）→ 改测试数据。
3. **改测试**，不改被测代码。
4. **跑相关测试**：只跑失败的那个测试类（`mvn test -Dtest=CalculatorTest`），确认绿。全量回归是 ticket 04，v1 不做。
5. 若改完仍红 → 重新诊断（可能误判 class 1，实为 class 2/4/生产 bug）→ 转交。

**反模式**：

- ❌ 改被测代码让它返回断言的值（把生产代码改成 `return 4`）→ 转交，这是生产 bug。
- ❌ 删除失败的断言/测试（`@Disabled`）→ 转交，不是 class 1 修复。
- ❌ 改断言为 `assertTrue(true)` 绕过 → 转交。

## class 2 修复 playbook（被测代码变更导致测试过时）

1. **读 MR diff**，理解被测代码改了什么（签名/行为）。
2. **意图判定**（行为变更必做，判表见 diagnosis-detail）：机械变更（改名/签名/挪位）→ 直接适配测试；语义变更 → 先找证据判「有意变更 vs 改出 bug」（MR 描述/issue/设计文档 > javadoc/ADR > 测试历史）再选方向；判不定 → 转交，两边都不动。
3. **读失败测试**，定位过时点：
   - 签名变（方法改名/参数增减）→ 改测试调用点。
   - 行为变（返回 Optional、抛新异常）→ 改测试断言。
   - 新增逻辑分支 → 可能兼 class 3（该分支无测试），补测试。
4. **修测试**使其符合新行为（意图判定结论为「有意变更」时）。
5. **跑相关测试**确认绿。
6. **文档同步**（见 doc-sync-detail）。

**src/main 补齐（有限放宽）**：前提——意图判定结论为「实现错/违背 spec」（见上步 2）。失败根因是 **MR diff 内**的被测代码违背其自带 spec（javadoc/ADR/设计文档承诺未实现，如承诺的默认值/参数校验缺失）：先读 spec 原文确认其存在，再改实现使其符合 spec，**不改失败测试的断言**；跑受影响模块全量测试确认绿。spec 互相矛盾且无测试可依 → 转交（可先开部分修复 MR）。

**反模式**：

- ❌ 改被测代码回滚 MR 变更 → 转交（回滚生产变更不在放宽范围；放宽仅限「按 spec 补齐实现」）。
- ❌ 只改编译不改动逻辑（测试编译过但断言还指向旧行为）→ 不算修复。

## class 3 修复 playbook（缺失测试）

1. **读 spec/PRD**，确定期望的正确行为。spec 目录位置：优先查 `docs/spec/`、`specs/`、`docs/adr/`；若无则读仓库根的 `README.md` / `CONTEXT.md`。
2. 写测试断言该行为。**关键**：断言 spec 定义的，不是当前代码的。
3. **spec 不可读/缺失 → 转交**（不得猜规格瞎写测试）。当前代码行为与 spec 不符 → 被测代码在 MR diff 内时可按 class 2 的 src/main 补齐修实现；在 diff 外 → **转交**。两者都不得按 bug 写测试固化它。
4. 跑新测试：
   - 绿 → fixed。
   - 红 → 可能是被测代码实现漏了 spec（生产 bug）→ 转交。也可能误判 class 3 实为 class 2（被测代码改漏了）→ 重新诊断。

**反模式**：

- ❌ 按当前代码反推测试（"代码这么写的所以测试这么断言"）→ 固化 bug，禁止。
- ❌ 写空测试/`@Disabled` 占位 → 转交，不算修复。

## class 4/5（转交，不修复）

输出 `escalated`，reason 写明：

- class 4：`class 4 flaky：<具体信号，如时间相关断言/网络依赖>，转交人工复现`。
- class 5：`class 5 非单测失败：<依赖错，失败 stage=build>，转交人工`（bot 早筛形状，仅依赖错；编译错由 agent 判定后用你自己的 reason）。

## 部分修复 MR（转交但有成果时）

转交时如果已有通过自测的改动（修好一部分）：先 commit + push + `glab mr create`（标题带 `(部分修复)` 前缀，带 `--remove-source-branch=true --squash-before-merge=true`），描述写明：已修好什么、仍失败什么及根因、需要人工做什么；然后输出 `escalated` 且 `mrUrl` 填该 MR。bot 会把 MR 链接带进转交通知与决策上下文；/heal 恢复后在同一分支继续修（更新同一 MR）。完全无成果（纯 class 5、无把握）→ 不开 MR。

## 轻量测试结构重构（class 1/2 允许）

当过时/错的测试因结构问题难修（如 200 行测试方法），允许轻量重构：

- 拆过大方法为多个小测试方法。
- 提取测试数据为 helper/`@ParameterizedTest`。
- 调整 mock 位置（从字段移到 setup）。

**边界**：只重构测试文件，不动被测代码。重构后跑相关测试确认绿。若重构引入新失败 → 回退，转交。

演进接缝：若重构频发引入新 bug，收回为只改断言（spec 已标此演进点）。

## 验证（跑测试）

- **v1 只跑相关测试**：失败的那个测试类。命令参考：**多模块 Maven 必须在仓库根用 `mvn test -pl <模块> -am -Dtest=<TestClassName>`**（`-am` 连带构建被测模块依赖的上游模块，否则兄弟模块依赖不在本地仓库会失败；勿 cd 进模块目录裸跑 mvn）；单模块 `mvn test -Dtest=<TestClassName>`；Gradle `./gradlew :<模块>:test --tests <TestClassName>`。
- 全量回归是 ticket 04，v1 不做。
- 测试绿才算 fixed；仍红 → 重新诊断 → 转交或重修。
- 跑测试用 bash 工具，cwd 是 agent 的工作目录（bot 注入的 worker 隔离 cwd）。
