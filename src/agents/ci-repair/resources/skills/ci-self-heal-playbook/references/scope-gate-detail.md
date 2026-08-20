# 范围闸详表 — G0 失败 stage 识别 + 路径闸

本文档是 `ci-self-heal-playbook` 层 3 详尽参考，按需 Read。范围闸先于诊断：先定失败 stage、再用路径闸分流「修 / 转交」，避免为生产代码问题烧预算。

## 一、失败 stage 识别（从 CI 日志信号）

按信号归类到四个 stage。信号大小写不敏感，取日志前 8KB 足够。

### test（单元测试阶段）

- Maven Surefire：`There are test failures`、`BUILD FAILURE` + `Failed tests:`、`<<< FAILURE!`
- Gradle：`test FAILED`、`> Task :<module>:test FAILED`、`<class> > <method> FAILED`
- 一般：`Tests run: N, Failures: M`、`FAILED`、`AssertionError`

### static-analysis（静态分析：SpotBugs / PMD）

- SpotBugs：`SpotBugs`、`Bug:`、`Priority: High/Medium`、`spotbugsXml.xml`、`BUG`
- PMD：`PMD`、`Violation`、`PMD rule`、`/target/pmd.xml`
- 报告常列 `file: <path>` + `line: <n>` + `bug type / rule`

### checkstyle（风格检查）

- `Checkstyle`、`checkstyle`、`violation`、`[WARN]`、`[ERROR]`、`CheckstyleViolationException`
- 报告常列 `src/.../<File>.java:<line>:`

### build（编译 / 依赖）

- 编译：`COMPILATION ERROR`、`compilation failed`、`cannot find symbol`、`error:`
- 依赖：`could not resolve`、`cannot resolve dependencies`、`Could not find artifact`、`dependency resolution failed`

## 二、路径闸（按 diff 白名单决定修 / 转交）

可修文件必须落在 **MR diff 文件集**内（本次 pipeline 对应 MR 的改动文件）。bot 用此白名单兜底校验 patch，与 stage 无关。**static-analysis/checkstyle 失败额外受行级约束**：bot 用 `validatePatchLineScope` 校验 agent patch 是否落在 MR diff hunk 覆盖的行范围（±5 行容忍度）内。

| 失败 stage | diff 内可修文件 | diff 外文件 |
| --- | --- | --- |
| test | `src/test/`、`src/it/`（含 resources）、`docs/`、`.md`、**diff 内 `src/main`**（有限放宽，见铁律） | 一律**转交**（含 diff 外 `src/main`） |
| static-analysis / checkstyle | diff **行范围内**（±5 行容忍度）**任意文件**（含 `src/main`），只允许改 MR diff hunk 覆盖的行及其上下各 5 行 | 一律**转交**；diff 内但 hunk 行范围外也**转交** |
| build | 编译错进入，由 agent 分类（class 2 按 test 行规则修测试 / class 5 转交）；依赖错 bot 早筛转交，不进入 | — |

要点：

- test 失败可改 **diff 内** `src/main`（有限放宽，ADR-0006）。铁律：优先改实现满足既有失败测试，**严禁改写这些测试的断言语义迎合实现**（编译适配除外），测试语义改动在 MR 描述逐条申报——否则就是「非法让测试通过」陷阱。
- static-analysis/checkstyle 失败允许改 diff **行范围内**（±5 行容忍度）的 `src/main`；**超出 diff hunk 行范围即转交**，即使文件在 diff 内。bot 用 `validatePatchLineScope` 行级校验兜底。
- `pom.xml`/`build.gradle`/`settings.gradle`/`Dockerfile`/`.gitlab-ci.yml` 永不许改（即使 diff 内也转交——属构建/CI 配置）。

**从严原则**：文件归属拿不准 → 转交。

## 三、static-analysis / checkstyle 护栏

- **禁压制式修复**：不得用 `@SuppressWarnings` / Checkstyle suppression / 删规则让 gate 绿，必须真修。压制只是把噪声转给人审。
- **改动绑定违规 `file:line:rule`**：只在被报告处附近改（**必须落在 MR diff hunk 行 ±5 行内**），不在同文件顺手重构无关代码或修改 diff hunk 外的行。
- **跨文件**：收集该 stage 所有违规文件，逐个过路径闸。**任一需修文件不在 diff 内** → 转交 diff 外项；**违规行不在 diff hunk 行范围内** → 同样转交该项。diff 行范围内违规照常修并在转交前开部分修复 MR（见 SKILL.md「部分修复也要开 MR」节）。`escalated.reason` 写明 `G0: <file>:<line> 的 <rule> 不在 diff 行范围内，需人工`。
- diff 行范围内文件（含 `src/main`）按对应规则真修（修正命名、补注解、调格式、修类型），套用 class 1 playbook。

## 四、转交输出示例

diff 外文件转交（文件级）：

```json
{
  "kind": "escalated",
  "diagnosis": { "failureClass": 5, "summary": "SpotBugs 在 src/main/java/com/example/Order.java 报告 NP_NULL_ON_SOME_PATH，该文件不在 MR diff 内" },
  "reason": "G0: src/main/java/com/example/Order.java 不在 MR diff 文件集内，需人工"
}
```

diff 内但 hunk 行范围外转交（行级，static-analysis/checkstyle）：

```json
{
  "kind": "escalated",
  "diagnosis": { "summary": "SpotBugs 在 src/main/java/com/example/Order.java:128 报告 NP_NULL_ON_SOME_PATH，该行不在 MR diff hunk ±5 行范围内" },
  "reason": "G0: src/main/java/com/example/Order.java:128 的 NP_NULL_ON_SOME_PATH 不在 diff 行范围内，需人工"
}
```

> **注意**：checkstyle/spotbugs 阶段的转交不用 `failureClass: 5`（class 5 仅限 compile/dependency 失败）。`diagnosis` 中可省略 `failureClass` 或按实际情况填写。
