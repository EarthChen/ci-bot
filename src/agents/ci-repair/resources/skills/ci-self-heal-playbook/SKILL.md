---
name: ci-self-heal-playbook
description: CI 失败自愈 playbook。当 GitLab pipeline 在 单元测试 / 静态分析(SpotBugs,PMD) / Checkstyle 风格检查 任一阶段失败时加载；单测失败可改测试/文档与 MR diff 内的 src/main（铁律约束），静态分析/Checkstyle 失败可在 MR diff **行范围内**（±5 行容忍度）修生产代码(src/main)，bot 用 validatePatchLineScope 行级校验兜底。任何超出 diff 行范围的改动一律转交人工。覆盖 范围闸(G0) → 诊断(G1 五类) → 修复(G3 边界+每类步骤) → 文档同步(G2) → 自测 → 提交 MR 六段（bot 另负责复用 session 重试）。
---

# CI 自愈 Playbook

处理 GitLab pipeline 失败的修复：以**测试 + 文档**为主，单测失败在铁律约束下也可修 **MR diff 内**的 `src/main`；static-analysis/Checkstyle 失败可修 **MR diff 行范围内**（±5 行容忍度）的文件（含 `src/main`），bot 用 `validatePatchLineScope` 行级校验兜底；修不了的（diff 行范围外生产代码、flaky、依赖错）转交人工（转交前如有部分修复成果，先开部分修复 MR）。

**铁律（违反任一即转交，不开 MR）：**

1. **改动范围（G3）**：
   - **单测失败**：可改 `src/test|it`/`docs` 与 **MR diff 内**的 `src/main`（有限放宽，ADR-0006）。铁律：改 `src/main` 只为让既有失败测试通过——优先改实现满足测试，严禁改写既有失败测试的断言语义来迎合实现（编译适配除外）；测试语义改动在 MR 描述逐条申报。diff 外 `src/main` → 转交。
   - **static-analysis/checkstyle 失败**：可改 **MR diff 行范围内**（±5 行容忍度）的文件（含 `src/main`，bot 用 `validatePatchLineScope` 行级校验兜底——**只允许修改 MR diff hunk 覆盖的行及其上下各 5 行**，超出行范围的生产代码改动会被 bot 拒绝）。铁律：改动必须绑定 CI 报告的 `file:line:rule`，只在违规行 ±5 行内修改；**禁止为修 MethodLength/ParameterNumber 做整文件重构或新增跨 hunk 的 helper 方法/参数对象**——若违规行上的局部最小改法无法满足规则，该项转交（可先开部分修复 MR）。超出行范围 → 转交。**此路径下禁止顺带文档同步**：`docs/`、`*.md` 仅 class 2（单测路径）可写；quality 修复中认为文档需要更新 → 写进 MR 描述，不改文件（实测：quality 修复顺带改 diff 外 `docs/api/API-INTERFACES.md` → G3 拒绝整个 patch，50 分钟/84 turns/$2.18 整轮作废）。
   - **唯一例外**：diff 外文件是你自建的过程产物（spotbugs/checkstyle 过滤器 xml、临时脚本、日志——本应写 /tmp）→ 从工作区与暂存区删除后照常继续，不转交（实测：一个误入 patch 的过滤器文件曾废弃 36 分钟/123 turn/$20 的整轮修复）。
2. **class 3 按 spec/PRD 断言正确行为**，不按当前代码行为（否则把 bug 固化成测试）。
3. **不猜修复**。诊断未达 class 1/2/3 确信 → 转交，不反复重试烧预算。
4. **开完 MR 即返回，绝不等待或合并 CI**。MR 自动触发 CI，由 bot 监控其状态并通知（钉钉）；你**严禁 `glab mr merge`**——所有 MR 必须人工 review 后合并。
5. **结构化输出**。末条消息必须是 JSON：`fixed`（含 `diagnosis`+`summary`+`mrUrl`）或 `escalated`（含 `diagnosis`+`reason`）。

---

## 流程总览

按序执行，每步有完成判据；任一步判为不可修 → 跳到「提交 MR + 输出」输出 `escalated`。

| 步 | 动作 | 完成判据 |
| --- | --- | --- |
| 0 范围闸(G0) | 定失败 stage + 路径闸分流 | stage 已定、报错文件已列出、已在 test/doc 与 main 间分流 |
| 1 诊断(G1) | 归五类之一 | 读 CI 日志+MR diff+源码后归类，不猜 |
| 2 修复(G3) | 按类 playbook 改测试/文档（或 diff 内 src/main） | 改动在 G3 边界内 |
| 3 文档同步(G2) | 仅 class 2 同步相关段落 | 只动与变更行为直接相关的文档段落 |
| 4 自测绿 | 跑所改测试类（static-analysis/checkstyle 复跑同版本规则） | test 退出码 0 / 修改行 0 阻断违规；不因无关失败 revert 本次改动 |
| 5 提交 MR + 输出 | git push + glab mr create + JSON | MR URL 填入 `mrUrl`；未输出合法 JSON = 失败 |

## 0 范围闸（G0）——先决定「能不能修」

从 CI 日志定失败 stage，并用**路径闸**决定修还是转交。这一步先于诊断：**test 阶段**且违规根因在 **diff 外 `src/main`** → 直接转交；**static-analysis/checkstyle 阶段** → 按 CI 报告的 `file:line` 对照 MR diff hunk ±5 行分流（行范围内可修含 `src/main`，越界项转交或开部分修复 MR）。stage 不在 playbook 范围则 bot 已排除，不进入 agent。

**读 MR diff 的姿势**：先读 bot 提供的文件索引（`mr-diff-index.txt`，逐文件 +/- 行数）掌握改动面，再只对相关文件从 `mr-diff.patch` 精确截取（grep/sed 定位）；**勿通读全量 diff**——大 MR 的 diff 可达数万行，通读烧光上下文。

- **test**（Surefire/Gradle test 红）→ 进入诊断 G1（class 1/2/3 可修）；可改测试/文档与 **MR diff 内**的 `src/main`（有限放宽，见铁律 1）；diff 外 `src/main` 一律转交。
- **static-analysis**（SpotBugs/PMD 报告）→ 违规文件在 **MR diff 行范围内**（±5 行容忍度）即可修（含 `src/main`）：只在 MR diff hunk 覆盖行及其上下各 5 行内修改；超出行范围 → 转交。
- **checkstyle**（风格检查红）→ 同上：diff 行范围内的文件（含 `src/main`）可修，**只允许改 MR diff hunk 覆盖的行 ±5 行**；超出行范围 → 转交。
- **build**（编译/依赖）→ 依赖错 bot 已早筛转交；编译错由你分类：生产代码（src/main）编译挂 = class 5 转交；仅测试编译挂（生产编译过）= class 2 可修。

**路径闸（按 diff 白名单）**：可修文件必须落在 **MR diff 文件集**（本次 pipeline 的 MR 改动文件）内。test 失败允许 `src/test|it`/`docs` 与 diff 内的 `src/main`（有限放宽）；static-analysis/checkstyle 失败允许 diff **行范围内**（±5 行容忍度）的任意文件（含 `src/main`），即只能改 MR diff hunk 覆盖的行及其上下各 5 行。任何 patch 文件不在 diff 内 → 转交；static-analysis/checkstyle 修改超出 diff 行范围 → 转交（bot 行级校验兜底）。

**护栏（static-analysis/checkstyle 改 diff 行范围内 `src/main` 时）**：

- 禁压制式修复：不得用 `@SuppressWarnings` / Checkstyle suppression / 删规则让 gate 绿，必须真修。
- 改动绑定违规的 `file:line:rule`：只在被报告处附近改（**必须在 MR diff hunk 行 ±5 行内**），不在同文件顺手重构无关代码或修改 diff hunk 外的行。
- 修复需改 diff 行范围外的行 → 该项转交；行范围内项照常修并在转交前开部分修复 MR（见「部分修复也要开 MR」节），不得丢弃已通过自测的成果。
- 单测失败改 diff 内 `src/main` 时同样禁压制式修复，且**严禁靠改写失败测试断言凑绿**——那是 G3 防的「非法让测试通过」陷阱；测试语义改动必须在 MR 描述逐条申报。

**注意**：一个 static-analysis/checkstyle stage 的违规常跨多个文件。只要其中**任一需修文件不在 diff 内**，该 stage 绿不了 → 转交，但**必须先把 diff 内的违规全部修完并开部分修复 MR**（见「部分修复也要开 MR」节），MR 描述写明剩余项与人工处理建议；严禁只转交而丢弃已通过自测的修复成果（MR !288 实测：20/21 项经部分 MR 保留）。

完成判据：stage 已定 + 报错文件路径已列出 + 已分流（修 / 转交）。
信号详表见 [scope-gate-detail](references/scope-gate-detail.md)。

## 1 诊断（G1 五类分类法）

读 CI 日志 + MR diff + 失败测试/被测源码定位根因，归入五类。判定信号速查：

| class | 含义 | 处理 |
| --- | --- | --- |
| 1 | 测试 bug（断言/mock/数据错） | 修测试 |
| 2 | 被测代码变更导致测试过时 | 先意图判定：有意变更→修测试；改出 bug→修 diff 内 src/main；判不定→转交 |
| 3 | 缺失测试（新路径无覆盖） | 按 spec 补测试（实现违 spec 时可修 diff 内 src/main） |
| 4 | flaky/环境问题 | 转交 |
| 5 | 非单测失败（编译/依赖，**不含** checkstyle/spotbugs） | 转交 |

- class 1：断言期望与被测代码实际行为不符；mock 返回值过时；测试数据硬编码错。
- class 2：MR diff 改了 `src/main/`，测试没跟上（签名/行为变）。行为变必须先做意图判定（有意变更 vs 改出 bug），不得默认更新断言。
- class 3：CI 显示某路径未覆盖，或 spec 要求的行为无测试。
- class 4：本地通过、CI 失败；时间/网络/并发相关。
- class 5：生产代码（`src/main`）编译失败；`cannot resolve` 依赖错；非 test phase。仅测试编译挂归 class 2。**注意**：checkstyle/spotbugs 阶段失败不是 class 5——它们走 G0 static-analysis/checkstyle 分支，failureClass 仅在真正的 compile/dependency 失败时才用 5。

详表（含混淆优先级）见 [diagnosis-detail](references/diagnosis-detail.md)。

## 2 修复（G3 边界 + 每类步骤）

**权限边界**：默认可写 `src/test/`、`src/it/`（含 `src/test/resources/`）、`docs/`、`*.md`；**单测失败另可写 MR diff 内的 `src/main`**（有限放宽，受铁律 1 约束）；**static-analysis/checkstyle 失败**按 G0 范围闸可改 diff **行范围内**（±5 行容忍度）的 `src/main`（bot 用 `validatePatchLineScope` 行级校验兜底——只允许改 MR diff hunk 覆盖的行及其上下各 5 行）；任何**超出 diff 行范围**的路径（含其他 `src/main`、构建/CI 配置 `pom.xml`/`build.gradle`/`.gitlab-ci.yml`/`Dockerfile`）→ 转交。

**class 1（测试 bug）**

1. 读被测源码确认正确行为（不猜）。
2. 读失败测试，定位错在断言/mock/数据哪处。
3. 改测试，不改被测代码。
4. 跑所改测试类确认绿。

**class 2（测试过时）**

1. 读 MR diff，理解被测代码改了什么。
2. 过时判定：签名变 → 改调用；行为变 → **先做意图判定**（见 diagnosis-detail：证据 = MR 描述/issue/设计文档 > javadoc/ADR > 测试历史；有意变更 → 改测试，改出 bug → 修 diff 内 src/main，判不定 → 转交）。
3. 修测试 + **文档同步（步 3）**。
4. 跑所改测试类确认绿：多模块 Maven 在仓库根用 `mvn test -pl <模块> -am -Dtest=<类>`（`-am` 连带构建上游依赖模块；勿 cd 进模块目录裸跑 mvn）。

**class 2/3 的 src/main 补齐（有限放宽）**：当失败根因是 **MR diff 内**的被测代码违背其自带 spec（javadoc/ADR/设计文档/同 MR 测试承诺，如承诺的默认值未实现、承诺的参数校验缺失）：

1. 先确认 spec 出处真实存在（读原文，不凭测试注释臆断）且文件在 MR diff 内。
2. 修 src/main 使实现符合 spec，**不改对应失败测试的断言**；若 spec 本身互相矛盾、无测试可依 → 不猜，转交（可先开部分修复 MR）。
3. 全量跑受影响模块测试确认绿（不只跑所改类）。

**class 3（缺失测试）**

1. 读 spec/PRD 定**期望正确行为**（非当前代码行为）。
2. 写测试断言该行为。发现被测代码与 spec 不符 → 转交。
3. 跑新测试确认绿（红了且 spec 明确，可能 class 2 被测代码改漏）。

**static-analysis/checkstyle 批量修复（默认走批量，必读）**：

1. 先拿到**结构化违规清单**（`file:line:rule`）：CI 日志只有摘要时，按 repair-detail「本地复现配方」在本地复现检查并解析报告 XML，得到全量 `file:line:rule` 后对照 MR diff hunk ±5 行分流，再按规则分组（Imports / OperatorWrap / LineLength / MethodLength / SpotBugs-*）。**先清单后修复，禁止边改边猜**。
2. **机械项**（UnusedImports、OperatorWrap、LineLength、final、NoWhitespaceBefore 等）→ **同 turn 并行 edit 或一条 python/sed 脚本**批量改完，**禁止逐文件串行**（实测：72 项逐文件修 = 94 turns/$15；聚合后几分钟）。
3. **结构性规则**（MethodLength、ParameterNumber、AvoidNestedBlocks）→ 仅在违规行 **hunk ±5 行内**做最小改动（删 dead code、合并单行）；**禁止**抽取 helper 方法/参数对象到 hunk 外、改方法签名波及其他文件——做不到 → 该项转交。
4. 验证：checkstyle 用独立 CLI 秒级复跑改动文件（见 repair-detail「checkstyle 快路径」）；SpotBugs 批次末 `mvn -o -pl <mod> -am compile` 后再跑。全模块 mvn 每批最多 1 次。
5. **UnusedImports / StarImport**：禁止将 `import foo.*` 展开为 20+ 行显式 import（易误加注释中出现的类名制造新 UnusedImports，实测制造级联事故）；首选直接删除未使用 import。删除前 `grep -n 'SimpleName' <file>` 确认非注释/字符串中的真实引用。

**static-analysis / checkstyle 落在 test/doc 的违规** → 按 class 1 思路改对应测试/文档文件使其满足规则（如修正命名、补注解、调格式）；仍受 G3 约束，不得触碰 `src/main`。**落在 `src/main` 的违规** → 仅可改 MR diff hunk 行范围（±5 行容忍度）内的行，超出行范围的违规转交。

**class 4/5 与 G3 拦截的 src/main 发现** → 输出 `escalated`，reason 写明 class/信号/文件路径。

每类完整 playbook（含反模式）见 [repair-detail](references/repair-detail.md)。

## 3 文档同步（G2）——仅 class 2

只改与变更行为**直接相关**的文档段落（API 描述、参数语义、返回值、行为示例）。不重写、不改格式、不动无关段落；无相关文档则跳过。
详表见 [doc-sync-detail](references/doc-sync-detail.md)。

## 4 自测绿

- 只跑所改测试类。**多模块 Maven 必须在仓库根用 `-pl <模块> -am`**：`mvn test -pl <模块> -am -Dtest=<类>`（`-am` 连带构建同仓库上游依赖模块；cd 进模块目录裸跑 mvn 会因兄弟模块依赖缺失而失败，MR !281 实测）。Gradle `./gradlew :<模块>:test --tests <类>`；pnpm / pytest 在所属模块目录。
- static-analysis/checkstyle 失败不跑 `mvn test` 验收：用与 CI 同版本/规则集复跑对应工具，修改行上 0 阻断违规才算绿（见 repair-detail「验证」节）。
- 退出码 0 = 绿。仍红 → 重新诊断（可能误判）→ 转交或重修。
- 勿因其他无关测试失败 revert 本次改动；仅所改测试本身仍红才回退。

## 5 提交 MR + 输出

**提交 MR（你自己完成，bot 不会代劳）**：

1. `git add <逐个列明改动文件>` → `git commit -m 'fix: ...'`。**严禁 `git add -A`/`git add .`**；提交前 `git status` 自检无意外文件（过程产物一律写 /tmp；patch 中出现 diff 外文件先判断是否自建产物，是则删除继续，见铁律 1）。
2. `git push origin <源分支>`（分支名由 prompt 给出）。
3. `glab mr create --source-branch <源分支> --target-branch <目标分支> --title '<标题>' --description '<正文>' --remove-source-branch=true --squash-before-merge=true --yes`（后两个勾选项为 bot 强制默认，勿省略）。
4. 从 `glab mr create` 输出取 web_url 填入 `fixed.mrUrl`。glab 在 worktree 内自动识别 remote，**勿传 `--project`**（无效）。
5. **必须自己 push + create，不得引用他人 MR URL 跳过提交**——每个 pipeline 的 MR 独立 review；引用他人 URL 会被 bot 判为未提交。

**结构化输出**（末条 assistant 消息，代码块包裹）：

```json
{
  "kind": "fixed",
  "diagnosis": { "failureClass": 1, "summary": "CalculatorTest 断言期望 4，实际应为 5（2+3）。修正断言。" },
  "summary": "修正断言期望值为 5",
  "mrUrl": "https://git.example.com/group/repo/-/merge_requests/123"
}
```

或：

```json
{
  "kind": "escalated",
  "diagnosis": { "failureClass": 4, "summary": "flaky：本地通过 CI 失败，含时间相关断言" },
  "reason": "class 4 flaky，转交人工复现",
  "mrUrl": "https://git.example.com/group/repo/-/merge_requests/124"
}
```

**部分修复也要开 MR**：转交时如果已有通过自测的改动（哪怕只修好一部分），**先按上面 1-4 步 push + 建 MR**（标题带「(部分修复)」前缀），描述必须写明：已修好什么、仍失败什么及根因、需要人工做什么；然后输出 `escalated` 并附该 MR 的 `mrUrl`。bot 会把 MR 链接带进转交通知与决策上下文；人工 /heal 恢复后你在同一分支继续修（更新同一 MR，勿新建）。完全无有效改动（纯 class 5、无把握）则不建 MR，直接转交。

**注意**：`fixed` 必含 `diagnosis`+`summary`+`mrUrl`，无 `mrUrl` → bot 视为未建 MR → 转交。`escalated` 含 `diagnosis`+`reason`，`mrUrl` 可选（部分修复 MR）。未输出合法 JSON → bot 视为失败。MR 自动触发 CI，由 bot 监控状态并通知（部分修复 MR 除外——它本就带未修项，bot 不监控）；你不开合并。

**重试（bot 复用 session）**：若 MR 的 CI 仍红，bot 会**复用本次 session**、注入新 CI 日志，并指令你 **`git push` 到同一 source 分支更新已有 MR**（勿开新 MR）。重试时必须先做增量对齐：

1. `git diff origin/<source-branch> --stat` 查看当前 worktree 与已有 MR 的差异。
2. 只修 **本次 CI 仍报的** `file:line:rule`；上轮已绿项不得重改。
3. **禁止**重新生成全量 patch 覆盖已有修复——在原有基础上追加小 commit。

仍受上述 G0 护栏与权限边界约束；重试有次数上限，用尽则转交人工。

## 通用语言 skill

处理 Java 单测先读 `java-coding-standards`（全局 skill）了解命名/断言/mock 规范。本 playbook 只管 CI 自愈流程。
