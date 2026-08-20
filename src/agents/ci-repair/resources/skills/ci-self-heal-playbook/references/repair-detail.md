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
- **仓库工作区内的自建过程产物**（spotbugs/checkstyle include 过滤器、临时脚本、日志）——一律写 `/tmp`（如 `-Dspotbugs.includeFilterFile=/tmp/sb-include.xml`）；误写入仓库的必须在 commit 前删除

任何 fix 的 file path 命中禁止路径 → **立即转交人工**，不得开 MR。bot 代码有 G3 校验兜底（`validatePatchPaths`），但 agent 应在输出前自检。**唯一例外**：diff 外文件是自建过程产物（见上）→ `git restore`/`rm` 移出工作区与暂存区后照常继续，不转交；若仍有 diff 内的部分成果，按「部分修复 MR」节处理。

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

### static-analysis / checkstyle 失败的验证

失败 stage 是 static-analysis/checkstyle 时，验收标准不是 `mvn test`，而是**用与 CI 相同版本/规则集复跑对应工具，确认 diff 修改行上 0 阻断违规**：

1. 从 CI 日志提取工具版本与规则集（如 `spotbugs:4.8.6.8:check`、checkstyle 版本 + 规则文件）；规则集在仓库内（checkstyle.xml / exclude filter）直接用，CI 从外部拉取时按日志定位同源规则。
2. 在仓库根用 `-pl <模块>` 复跑（同「跑测试」的多模块姿势）；先 `mvn -o -pl <模块> -am compile -DskipTests` 保编译过，再跑规则检查。
3. 只计**本次修改行**上的阻断违规；未修改行的历史遗留不算失败（对齐 CI 行级闸；CI 若是全量闸，以 CI 日志实际判定为准）。

**修复与验证节奏（默认批量，小步是例外）**：

1. 违规按规则/类别分组，机械项（导入、命名、格式、补注解、加 final 等）**批量修完再验证**——每处修完都跑一遍 mvn 是主要时间黑洞（全模块 compile 每次 2-3 分钟）。**编辑本身也必须批量**：同一规则/模式的修改写成一个脚本（sed/python）一次扫完全部命中文件，禁止逐文件起一条命令——逐文件编辑时每处都要付一次模型 turn 推理时间（20-60s），是仅次于 mvn 的第二大时间黑洞（实测：几十处机械违规逐文件修耗时 30+ 分钟，聚合脚本可压到几分钟）。
2. 按批次验证：每修完一类或一组文件做一次 compile + 规则复跑；全部修完再一次 compile + 复跑终验。
3. 批次失败归因：Java 编译/规则报错自带精确 `file:line`，直接定位引入问题的修复点单独改；定位不出再 `git checkout -- <本批次涉及文件>` 回退该批次小步重做。
4. **例外——语义类修复小步验证**：SpotBugs 行为类 bug（补空判断、改逻辑、改资源释放/并发）每处都改行为，逐个验证；compile 本来也抓不住语义错。
5. **checkstyle 快路径**：只为风格验证时不必跑 Maven——用本地仓库里的 checkstyle 独立 CLI：`java -jar <本地仓库中的 checkstyle jar> -c <规则文件> <改动文件>`，秒级反馈（版本取 CI 日志所示）。SpotBugs 需要编译产物，仍走 compile。

### 本地环境约束与依赖取证

- Maven 优先 `-o`（本地仓库已预热）；`-o` 报缺 artifact 时可去掉 `-o` 重试单点拉取，仍失败 = 网络不可达 → 放弃该路径改走取证，勿循环重试。
- 镜像内置双 JDK：JDK 8（`/opt/java/openjdk`，默认 JAVA_HOME）与 JDK 21（`/opt/java/openjdk21`）。复跑静态检查按 CI job 的 JDK 版本对齐：日志见 temurin-21 则用 `JAVA_HOME=/opt/java/openjdk21 PATH=/opt/java/openjdk21/bin:$PATH mvn ...`。**严禁运行时下载 JDK 或任何工具**——镜像缺什么就绕开或在转交理由中说明，不得自行联网获取。
- 需要知道**某类属于哪个 jar / 方法签名 / 内部实现**（内部库无源码；如改配置 Bean 字段名前确认反序列化库）时按序：① 定位 jar：`mvn org.apache.maven.plugins:maven-dependency-plugin:3.8.1:build-classpath -o -pl <模块> -Dmdep.outputFile=/tmp/cp.txt`（带全限定版本，offline 下裸 `dependency:` 前缀可能因缺 metadata 失败）或直接按 groupId 路径 grep 本地仓库；② 列内容：`jar tf <jar>`（JDK 自带，一定存在）；③ 看字节码：`javap -c -classpath <jar> <全限定类名>`。
- **改反序列化 Bean（@MomoConfig / Jackson / fastjson 配置类）字段名必须先保留外部键**：先取证确认序列化库，加 `@JsonProperty("<原键>")`（Jackson）或 `@JSONField(name="<原键>")`（fastjson）再改名；裸改名会破坏外部配置绑定，且编译与测试都发现不了。
- **禁止静默失败循环**：批量扫描（遍历 jar/文件）前先在单个样本上验证命令可用、stderr 可见；循环内不得用 `2>/dev/null` 吞工具错误——工具缺失时「全部未命中」会伪装成结论（实测：unzip 缺失导致 9520 个 jar 白扫，浪费 7 分钟）。
