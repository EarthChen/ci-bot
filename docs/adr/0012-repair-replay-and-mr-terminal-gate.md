# 修复重放与 MR 终局跳过闸门

同 MR 的后续 pipeline 处置语义补全。背景：2026-08-21 生产实查（pipeline 100034349）暴露两个缺口——

1. **源 MR 已合并仍开修**：MR !432 于 10:48:55 合并，其 head pipeline 失败 webhook 10:50 到达，bot 照常 spawn worker 盲修 30+ 分钟。绿灯短路只复查 pipeline 状态，不查 MR 终局状态。
2. **上轮修复被整体重做**：同 MR 未合并的新 pipeline，`realWorktree` 删修复分支重建 worktree，上轮已 push 的修复改动全部丢弃。ADR-0007 的 session 复用只省了「重新诊断」，修复动作本身（40+ turns 的大头）要重来——上轮 100034275 诊断原话即证据：「开发者新提交 226502fb 不含上轮修复，原违规复现」。

## 决策一：MR 终局跳过闸门

出队执行前（绿灯短路同一位置）查源 MR state：`merged|closed` → 跳过修复（不 spawn worker、群通知尾注「源 MR 已合并/关闭，跳过自愈」、审计 `pipeline_mr_terminal_skipped`）。

**查询失败 fail-open**（放行修复）：闸门是省钱优化不是安全边界——误跳过（该修没修）的代价大于误开修。与绿灯短路的失败语义一致。

## 决策二：修复重放（repair replay）

**重放的是 git 层改动，不是 worktree 目录。** worktree 保持 per-pipeline 新建（worker 隔离不变），新 worktree 创建后：

```text
同 MR 新 pipeline（未合并、origin 修复分支有非空修复 commit）
  → 单次 git fetch --refmap= origin +refs/heads/<repairBranch>:refs/replay/<sanitized>
  → git diff <存档meta.sha>..<replayRef> | git apply -3
  → applied / empty：prompt 注入说明；conflict：原子降级；skipped：现状
```

### 取舍记录

- **range-diff + `apply -3`，不用 cherry-pick**：要的是工作区改动不是 commit 历史（`pushRepairBranch` 反正重新 commit）；`apply -3` 自带三方合并；空 diff（新代码已含修复）天然退化为 no-op。
- **worktree 目录不复用**：目录承载 per-event worker 隔离（独立 cwd / `.pi-agent` / 清理语义），复用目录破坏这套模型。
- **来源 = origin 修复分支 tip + 存档 meta.sha 作 base**：两个数据 ADR-0007 时代已存在，零新增存储。
- **fetch 用 `--refmap=` + 私有目标 ref**：bare clone 的 refspec 把 `refs/heads/*` 映射进**本地 heads**（ADR-0011），修复分支正被 worktree 检出——普通 `git fetch origin <branch>` 会因 "refusing to fetch into branch checked out" 被拒。`--refmap=` 禁用配置映射，分支只落私有 ref `refs/replay/*`，用完即删，不污染命名空间。
- **人工 push 照带**：origin 修复分支上的人工 commit 一并重放，G3 白名单/行级校验兜底。不为罕见场景引入「识别 bot commit」逻辑。
- **conflict 原子降级**：apply 非零退出即 `reset --hard` + `clean -fd`（重放发生在 agent 动手前，无 agent 改动可破坏；`checkout --` 清不掉 `apply -3` 留下的 `AA` 未合并索引项），退回全新修复，session 复用照旧兜底。不做「带冲突标记交给 agent」的半重放。
- **prompt 注入只认 applied/empty**：applied →「上轮修复已重放到工作区，先验证再只修增量」；empty →「修复已包含在新代码中，勿重做」；conflict/skipped 不注入（agent 全新诊断，不知晓重放）。
- **G3 交互不新增语义**：重放改动越出新 MR diff hunk ±5 → 整体走现有 `validatePatchLineScope` 转交/决策路径（ADR-0009），不做部分重放——越界说明代码移动幅度大，上轮修复本就该在新位置重审。
- **push 语义维持 force-push**：与现状每次重试的 force-push 一致，approve 重置可接受。

## 审计与指标

- audit trace 增 `replay: { fromPipeline, commitRange, outcome: applied|empty|conflict|skipped }`；metrics.jsonl 增 `replay` outcome 字段。
- e2e 覆盖 skipped 路径编排 + 终局闸门链路；applied/empty/conflict 语义由真 git 单测覆盖（不为 fake worktree 伪造上游仓库）。

## 后果

- 同 MR 增量 pipeline 的修复成本从「全量重做」降为「验证重放改动 + 修增量」。
- 终局 MR 的 pipeline 失败不再消耗预算。
- 新增 `refs/replay/*` 私有 ref 生命周期（用完即删，崩溃残留无害——同名覆盖写）。
- stub session（e2e）现持久化 jsonl 到 `PI_CODING_AGENT_DIR/sessions/`，使 ADR-0007/0012 链路可端到端验证。
