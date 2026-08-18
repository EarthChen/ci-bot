# 修复详表 — G3 权限边界 + 每类 playbook

本文档是 `ci-self-heal-playbook` 的层 3 详尽参考，按需 Read。

> 本表 playbook 仅在 [范围闸](scope-gate-detail.md) 判定为「可修」后执行。

## 权限边界（铁律）

**允许写的路径**：

- `src/test/`、`src/it/`（测试源码）
- `docs/`、`*.md`（文档，仅 class 2 触发）
- `src/test/resources/`（测试资源）

**绝对禁止的路径**：

- `src/main/java/`、`src/main/kotlin/`、`src/main/resources/`（生产代码）
- `pom.xml`、`build.gradle`、`settings.gradle`（构建配置）
- 仓库根的 `Dockerfile`、`ci/`、`.gitlab-ci.yml`（CI 配置）

任何 fix 的 file path 命中禁止路径 → **立即转交人工**，不得开 MR。bot 代码有 G3 校验兜底（`validatePatchPaths`），但 agent 应在输出前自检。

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
2. **读失败测试**，定位过时点：
   - 签名变（方法改名/参数增减）→ 改测试调用点。
   - 行为变（返回 Optional、抛新异常）→ 改测试断言。
   - 新增逻辑分支 → 可能兼 class 3（该分支无测试），补测试。
3. **修测试**使其符合新行为。
4. **跑相关测试**确认绿。
5. **文档同步**（见 doc-sync-detail）。

**反模式**：

- ❌ 改被测代码回滚变更 → 转交，生产变更不是 agent 该碰的。
- ❌ 只改编译不改动逻辑（测试编译过但断言还指向旧行为）→ 不算修复。

## class 3 修复 playbook（缺失测试）

1. **读 spec/PRD**，确定期望的正确行为。spec 目录位置：优先查 `docs/spec/`、`specs/`、`docs/adr/`；若无则读仓库根的 `README.md` / `CONTEXT.md`。
2. 写测试断言该行为。**关键**：断言 spec 定义的，不是当前代码的。
3. **spec 不可读/缺失 → 转交**（不得猜规格瞎写测试）。当前代码行为与 spec 不符 → **转交**（不得改生产代码，也不得按 bug 写测试固化它）。
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

## 轻量测试结构重构（class 1/2 允许）

当过时/错的测试因结构问题难修（如 200 行测试方法），允许轻量重构：

- 拆过大方法为多个小测试方法。
- 提取测试数据为 helper/`@ParameterizedTest`。
- 调整 mock 位置（从字段移到 setup）。

**边界**：只重构测试文件，不动被测代码。重构后跑相关测试确认绿。若重构引入新失败 → 回退，转交。

演进接缝：若重构频发引入新 bug，收回为只改断言（spec 已标此演进点）。

## 验证（跑测试）

- **v1 只跑相关测试**：失败的那个测试类。命令参考：`mvn test -Dtest=<TestClassName>`（Java/Maven）、`gradle test --tests <TestClassName>`（Java/Gradle）。
- 全量回归是 ticket 04，v1 不做。
- 测试绿才算 fixed；仍红 → 重新诊断 → 转交或重修。
- 跑测试用 bash 工具，cwd 是 agent 的工作目录（bot 注入的 worker 隔离 cwd）。
