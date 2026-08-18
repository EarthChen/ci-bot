---
name: ci-self-heal-playbook
description: CI 失败自愈 playbook。当 GitLab pipeline 在 单元测试 / 静态分析(SpotBugs,PMD) / Checkstyle 风格检查 任一阶段失败时加载；单测失败只修测试/文档，静态分析/Checkstyle 失败可在 MR diff 文件集内修生产代码(src/main)。任何超出 diff 的改动一律转交人工。覆盖 范围闸(G0) → 诊断(G1 五类) → 修复(G3 边界+每类步骤) → 文档同步(G2) → 自测 → 提交 MR 六段（bot 另负责复用 session 重试）。
---

# CI 自愈 Playbook

处理 GitLab pipeline 失败的修复：**只改测试 + 文档**，修不了的（生产代码、flaky、编译/依赖）转交人工。

**铁律（违反任一即转交，不开 MR）：**

1. **改动默认只限测试/文档；静态检查可改 diff 内 `src/main`**。单测失败只改 `src/test|it`/`docs`，不得碰 `src/main`（G3 不变）；SpotBugs/Checkstyle 失败可改 **MR diff 文件集内** 的 `src/main`（bot 按 diff 白名单校验）。任何超出 diff 的文件（含其他 `src/main`）→ 转交，不开 MR。
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
| 2 修复(G3) | 按类 playbook 改测试/文档 | 改动只在 test/doc 路径 |
| 3 文档同步(G2) | 仅 class 2 同步相关段落 | 只动与变更行为直接相关的文档段落 |
| 4 自测绿 | 跑所改测试类 | 退出码 0；不因无关失败 revert 本次改动 |
| 5 提交 MR + 输出 | git push + glab mr create + JSON | MR URL 填入 `mrUrl`；未输出合法 JSON = 失败 |

## 0 范围闸（G0）——先决定「能不能修」

从 CI 日志定失败 stage，并用**路径闸**决定修还是转交。这一步先于诊断：stage 不在范围或报错文件在 `src/main`，直接转交，不烧预算。

- **test**（Surefire/Gradle test 红）→ 进入诊断 G1（class 1/2/3 可修）；**只改测试/文档**，不得碰 `src/main`（G3 不变）。
- **static-analysis**（SpotBugs/PMD 报告）→ 违规文件在 **MR diff 文件集内** 即可修（含 `src/main`）：改对应文件使其满足规则；超出 diff → 转交。
- **checkstyle**（风格检查红）→ 同上：diff 内的文件（含 `src/main`）可修；超出 diff → 转交。
- **build**（编译/依赖）→ 依赖错 bot 已早筛转交；编译错由你分类：生产代码（src/main）编译挂 = class 5 转交；仅测试编译挂（生产编译过）= class 2 可修。

**路径闸（按 diff 白名单）**：可修文件必须落在 **MR diff 文件集**（本次 pipeline 的 MR 改动文件）内。test 失败只允许 `src/test|it`/`docs`；static-analysis/checkstyle 失败允许 diff 内的任意文件（含 `src/main`）。任何 patch 文件不在 diff 内 → 转交（bot 白名单校验兜底）。

**护栏（static-analysis/checkstyle 改 diff 内 `src/main` 时）**：

- 禁压制式修复：不得用 `@SuppressWarnings` / Checkstyle suppression / 删规则让 gate 绿，必须真修。
- 改动绑定违规的 `file:line:rule`：只在被报告处附近改，不在同文件顺手重构无关代码。
- 修复需改 diff 外文件 → 转交（别半修）。
- 单测失败（test stage）仍严禁碰 `src/main`——那是 G3 防的「非法让测试通过」陷阱。

**注意**：一个 static-analysis/checkstyle stage 的违规常跨多个文件。只要其中**任一需修文件不在 diff 内**，该 stage 绿不了 → 整体**转交**（不要只修 diff 内部分就开 MR）。

完成判据：stage 已定 + 报错文件路径已列出 + 已分流（修 / 转交）。
信号详表见 [scope-gate-detail](references/scope-gate-detail.md)。

## 1 诊断（G1 五类分类法）

读 CI 日志 + MR diff + 失败测试/被测源码定位根因，归入五类。判定信号速查：

| class | 含义 | 处理 |
| --- | --- | --- |
| 1 | 测试 bug（断言/mock/数据错） | 修测试 |
| 2 | 被测代码变更导致测试过时 | 修测试 + 文档同步 |
| 3 | 缺失测试（新路径无覆盖） | 按 spec 补测试 |
| 4 | flaky/环境问题 | 转交 |
| 5 | 非单测失败（编译/依赖） | 转交 |

- class 1：断言期望与被测代码实际行为不符；mock 返回值过时；测试数据硬编码错。
- class 2：MR diff 改了 `src/main/`，测试没跟上（签名/行为变）。
- class 3：CI 显示某路径未覆盖，或 spec 要求的行为无测试。
- class 4：本地通过、CI 失败；时间/网络/并发相关。
- class 5：生产代码（`src/main`）编译失败；`cannot resolve` 依赖错；非 test phase。仅测试编译挂归 class 2。

详表（含混淆优先级）见 [diagnosis-detail](references/diagnosis-detail.md)。

## 2 修复（G3 边界 + 每类步骤）

**权限边界**：默认只写 `src/test/`、`src/it/`（含 `src/test/resources/`）、`docs/`、`*.md`。但 **static-analysis/checkstyle 失败**按 G0 范围闸可改 diff 内的 `src/main`（bot 白名单校验兜底）；任何**超出 diff** 的路径（含其他 `src/main`、构建/CI 配置 `pom.xml`/`build.gradle`/`.gitlab-ci.yml`/`Dockerfile`）→ 转交。

**class 1（测试 bug）**

1. 读被测源码确认正确行为（不猜）。
2. 读失败测试，定位错在断言/mock/数据哪处。
3. 改测试，不改被测代码。
4. 跑所改测试类确认绿。

**class 2（测试过时）**

1. 读 MR diff，理解被测代码改了什么。
2. 过时判定：签名变 → 改调用；行为变 → 改断言。
3. 修测试 + **文档同步（步 3）**。
4. 跑所改测试类确认绿（用项目构建工具；多模块在所属模块目录跑，勿在 reactor 根跑）。

**class 3（缺失测试）**

1. 读 spec/PRD 定**期望正确行为**（非当前代码行为）。
2. 写测试断言该行为。发现被测代码与 spec 不符 → 转交。
3. 跑新测试确认绿（红了且 spec 明确，可能 class 2 被测代码改漏）。

**static-analysis / checkstyle 落在 test/doc 的违规** → 按 class 1 思路改对应测试/文档文件使其满足规则（如修正命名、补注解、调格式）；仍受 G3 约束，不得触碰 `src/main`。

**class 4/5 与 G3 拦截的 src/main 发现** → 输出 `escalated`，reason 写明 class/信号/文件路径。

每类完整 playbook（含反模式）见 [repair-detail](references/repair-detail.md)。

## 3 文档同步（G2）——仅 class 2

只改与变更行为**直接相关**的文档段落（API 描述、参数语义、返回值、行为示例）。不重写、不改格式、不动无关段落；无相关文档则跳过。
详表见 [doc-sync-detail](references/doc-sync-detail.md)。

## 4 自测绿

- 只跑所改测试类（Maven `mvn test -Dtest=<类>` / Gradle `./gradlew test --tests <类>` / pnpm / pytest；多模块在所属模块目录）。
- 退出码 0 = 绿。仍红 → 重新诊断（可能误判）→ 转交或重修。
- 勿因其他无关测试失败 revert 本次改动；仅所改测试本身仍红才回退。

## 5 提交 MR + 输出

**提交 MR（你自己完成，bot 不会代劳）**：

1. `git add` 改动文件 → `git commit -m 'fix: ...'`。
2. `git push origin <源分支>`（分支名由 prompt 给出）。
3. `glab mr create --source-branch <源分支> --target-branch <目标分支> --title '<标题>' --description '<正文>' --yes`。
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
  "reason": "class 4 flaky，转交人工复现"
}
```

**注意**：`fixed` 必含 `diagnosis`+`summary`+`mrUrl`，无 `mrUrl` → bot 视为未建 MR → 转交。`escalated` 含 `diagnosis`+`reason`。未输出合法 JSON → bot 视为失败。MR 自动触发 CI，由 bot 监控状态并通知；你不开合并。

**重试（bot 复用 session）**：若 MR 的 CI 仍红，bot 会**复用本次 session**、注入新 CI 日志，并指令你 **`git push` 到同一 source 分支更新已有 MR**（勿开新 MR）。你继续在同一 worktree 内修复即可，仍受上述 G0 护栏与权限边界约束；重试有次数上限，用尽则转交人工。

## 通用语言 skill

处理 Java 单测先读 `java-coding-standards`（全局 skill）了解命名/断言/mock 规范。本 playbook 只管 CI 自愈流程。
