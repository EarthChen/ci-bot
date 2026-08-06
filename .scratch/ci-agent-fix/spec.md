# CI 自愈 Bot 修复与优化方案

> 由 `/grill-with-docs` + `/domain-modeling` 流程整理。基于 pipeline 100031437 真实 e2e 诊断。

## 背景（已诊断的三类问题）

1. **worker.log 未出现在审计目录**：改代码后未重启旧进程 + `CIHEAL_BOT_ROOT` 被 shell 残留污染为 `/Users/earthchen/.Trash`。→ 已通过重启 + 正确 env 验证修复。
2. **worktree 分支 cleanup bug（P0-2）**：`manager.run()` 把 `runChild` + `if(code!==0) throw` 放在 `try/finally` 的 `try` 之外，worker 失败时 `finally` 不执行 → 分支残留 → 下次 `worktree add` 撞 "already exists"。代码已修（移入 try），但残留边角：escalated 后 git 注册显示 `prunable`（目录删了但分支还在），`git worktree prune` 未真正清注册致 `branch -D` 被静默吞。
3. **agent 未修复（空 patch，P1）**：`outcome=escalated`，`empty patch after agent reported fixed`。bot 的 `extractPatch` 自做 `git add -A`，故空 patch = **agent 最终没在工作区留改动**。根因：class-2 测试过时场景，agent 改测试后自验证未过 → revert → 工作区干净；且 playbook 对 class 2 语义自相矛盾（第12行"转交" vs 第26行"自动修"），agent session 输出未被持久化（空 patch 成黑盒）。

## 决策（grilling 确认）

- **class 2 语义**：自动修测试（改 `src/test/`，同步文档），**非转交**。class 5（生产真 bug）才转交。
- **落地范围**：P0-2 残留 + P1（P1-1/P1-2/P1-3）。
- **文档落点**：`.scratch/ci-agent-fix/`（spec + ADR）。

## 完整方案

### P0-2 残留：加固 worktree cleanup

- 文件：`src/worker/manager.ts`（`run()` 的 `finally` cleanup 块）
- 改动：在 `git worktree prune` 前先 `git worktree forget <cwd>` 释放分支引用，再 `branch -D`。消除 "prunable 残留导致下次 worktree add 冲突"。
- 验证：故意让 worker 失败 → 重发同 pipeline 不再撞 "branch already exists"。

### P1-1：修 SKILL.md class-2 矛盾

- 文件：`src/agents/ci-repair/resources/skills/ci-self-heal-playbook/SKILL.md` 铁律 1
- 改动：第12行 "class 2/5 → 转交" 改为 "class 5 转交人工（class 2 是测试过时，应自动修测试，不转交）"。

### P1-2：收紧 agent 验证策略

- 文件：同上，class 2 修复步骤 4
- 改动："跑相关测试确认绿" → "跑**所改测试类**确认绿（如 `mvn test -Dtest=GuildDomainServicePolicyRedDotTest`）；**勿因其他无关测试失败而 revert 本次改动**；仅当所改测试本身仍红才回退"。

### P1-3：agent session 日志持久化

- 文件：`src/agent/real-runner.ts`（`createDefaultSession`）
- 改动：session 创建后 `session.subscribe` 把每 turn 的 assistant 文本 + tool 调用 append 到 `CIHEAL_WORKER_LOG_DIR/agent-session.log`（审计目录，不被 `rm(cwd)` 删）。best-effort，失败不阻塞。
- 价值：空 patch / escalate 时可复盘 agent 行为（是否改文件、跑了什么、为何 revert）。

### P2（留作后续，本次不做）

- P2-1：cleanup 可靠性（已含于 P0-2）。
- P2-2：`manager.ts`/`log.ts` 多处 `catch {}` 静默吞错改 `logger.warn`（fail loud）。
- P2-3：启动 env 防护（显式 export `CIHEAL_BOT_ROOT` 或 config 优先于真实 env）。

## 验证总览

| 项 | 验证 |
| --- | --- |
| P0-2 | 失败后重发同 pipeline 不再撞 "branch already exists" |
| P1-1/1-2 | 重跑 100031437 → agent 改测试并通过所改测试类 → 非空 patch → 建 MR |
| P1-3 | 失败后审计目录可见 `agent-session.log`，能复盘 agent 行为 |
