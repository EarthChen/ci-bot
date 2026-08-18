# 真实端到端运行手册（Real E2E Runbook）

以**全真实链路**在真实 GitLab 失败 pipeline 上跑一次 bot：`webhook（验签）→ scheduler → worker 子进程 → real agent（LLM）→ real glab（可能真实开 MR）`。用于回归验证 bot 主路径、排查真实环境行为。e2e 测试（stub/fake 依赖）不覆盖的真实问题（glab CLI 版本语法、provider 注册、git 鉴权）只有这条链路能暴露。

## 适用场景与代价

- **真实副作用**：真实调用 LLM（token 计费走 `CIHEAL_PI_BASE_DIR` 的凭据）、真实 clone 目标仓库；若修复成功会**真实 push 分支并开 MR**（永不自动 merge）。
- 钉钉推送由 `CIHEAL_DINGTALK_MODE` 控制：`fake` 时 worker 侧只写 sidecar JSON、主进程 webhook 即时群播报只记录不推送，无真实推送；本地演练建议保持 `fake`。
- 一次运行的参考量级（2026-08-14 实测，MR !281 / pipeline 100033121）：agent 19 turns、~1.67M tokens、~7 分钟；bare clone 首次 ~100MB 级、之后复用。

## 1. 运行前检查清单

| 检查项 | 方法 | 通过标准 |
| --- | --- | --- |
| `.env` 必填 | 见 `src/config/index.ts` | `CIHEAL_BOT_ROOT` / `CIHEAL_PI_BASE_DIR`（绝对路径）、`GITLAB_URL`、`GITLAB_TOKEN`、`GITLAB_WEBHOOK_SECRET` 齐备 |
| 模型候选可用 | 对照 `config/model-candidates.json` 与 `$CIHEAL_PI_BASE_DIR/models.json`、`auth.json` | 候选的 provider/model 在 bot 自己的 Pi 配置里有定义与凭据，否则启动选模即 `NoAvailableModelError` |
| glab CLI | `glab version`；glab 读 `GITLAB_TOKEN` + `GITLAB_HOST` env（worker 已注入 `GITLAB_HOST=$GITLAB_URL`） | 版本语法与 `src/gitlab/glab-client.ts` 一致（glab 1.112：`mr diff/create` 只认 `-R OWNER/REPO`，不支持 `--project`，也不接受纯数字 id——client 内 `resolveRepoRef` 先解析 `path_with_namespace`） |
| git clone 鉴权 | `GIT_TERMINAL_PROMPT=0 git ls-remote <repo-url> HEAD` | 能返回 sha（Bearer extraHeader 或 osxkeychain 均可） |
| 端口空闲 | `lsof -nP -i :<PORT>` | 无 LISTEN（默认 `PORT=8080`） |
| 目标 pipeline | 见下一节 | failed 且失败类型在 bot 范围内 |

## 2. 选定目标 pipeline（失败类型判定）

bot v1 只修**单测失败**；依赖错会被 class-5 早筛直接升级转交（不起 agent，省预算）。编译错放行给 agent 判 class 2/5：仅测试编译挂 = class 2 可修（改测试适配新签名），src/main 编译挂 = class 5 转交。

```bash
# .env 已有 GITLAB_URL / GITLAB_TOKEN；MR 的 head pipeline
curl -sf -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_URL/api/v4/projects/<projectId>/merge_requests/<mrIid>" | python3 -c \
  "import json,sys; p=json.load(sys.stdin)['head_pipeline']; print(p['id'], p['status'], p['sha'])"

# jobs 列表 → 失败 job 的 trace
curl -sf -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_URL/api/v4/projects/<projectId>/pipelines/<pipelineId>/jobs"
curl -sf -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_URL/api/v4/projects/<projectId>/jobs/<jobId>/trace"
```

判定：`Could not resolve dependencies` / `Could not find artifact` 等依赖错 → class-5 早筛直接转交；`COMPILATION ERROR` / `cannot find symbol` → 编译错，放行 agent 判 class 2/5（仅 src/test 编译挂 = class 2，进修复）；无以上标记且有 `Tests run: ... Failures: n` / `Failed tests:` → 单测失败，进修复。后两类都会起 agent，可跑。

## 3. 启动服务

```bash
NODE_ENV=production PORT=8091 BOT_WORKER_TIMEOUT_MS=3600000 pnpm dev
```

- **`NODE_ENV=production` 必须**：`development` 会让 dingtalk-stream SDK 开 debug，把 `DINGTALK_CLIENT_SECRET` 明文打进日志（2026-08-14 实际发生过）。
- **`BOT_WORKER_TIMEOUT_MS`**：worker 子进程超时，默认 5 分钟；真实 agent 运行必然超过，给 ≥1h。
- `PORT`：被占用就换；`loadEnvFile` 不覆盖已存在的环境变量，命令行预置即可生效。
- 看到 `"msg":"ci-self-heal bot listening"` 即就绪（钉钉 Stream WS 连不上只 warn，不阻塞）。

## 4. 投递 webhook

MR 触发的 pipeline：`object_attributes.ref` 是合成 ref `refs/merge-requests/<iid>/head`，真实源分支在 `merge_request.source_branch`（**必填**，v1 只处理 MR 触发的 pipeline；修复 MR 的 target 取该分支）。

**修复开关**：只有 URL query 带 `repair=1`（或 `repair=true`，大小写不敏感）才触发自动修复；不带参数的事件只走群播报（响应 `notify-only`），不入队。GitLab 侧按项目 opt-in：webhook URL 配成 `…/webhook?repair=1`。

```bash
curl -s -X POST "http://127.0.0.1:8091/webhook?repair=1" \
  -H "X-Gitlab-Token: $GITLAB_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{
    "object_kind": "pipeline",
    "object_attributes": {
      "id": <pipelineId>,
      "ref": "refs/merge-requests/<mrIid>/head",
      "sha": "<pipeline sha>",
      "status": "failed"
    },
    "project": { "id": <projectId>, "web_url": "<project web_url>" },
    "merge_request": { "iid": <mrIid>, "source_branch": "<source branch>" }
  }'
```

- 预期：HTTP 202 `{"status":"queued"}`（带 `?repair=1`）或 `{"status":"notify-only"}`（不带参数，仅群播报）。
- `{"status":"duplicate"}`：scheduler 按 pipeline-id 内存去重；**同一 pipeline 重投需重启服务**清空去重状态。
- 401/403：token 或 IP allowlist 问题（`GITLAB_IP_ALLOWLIST` 为空 = 跳过 allowlist）。

## 5. 监控

| 观察点 | 位置 |
| --- | --- |
| 主流程日志（pino JSON） | 启动时的 stdout/重定向日志；关键 msg：`spawning worker` → `worker stdout (last 20 lines)` → `repair completed` |
| worker 审计日志 | `$CIHEAL_DATA_ROOT/audit/<pipelineId>/<uuid>-worker-log/worker.log`（阶段：runRepair start → bare clone → worktree: add → … → worker finished） |
| agent 是否在流式 | `lsof -nP -p <worker pid> \| grep ESTABLISHED`。**pid 取真实 node 进程**（`pgrep -f worker/main.ts` 会同时命中 tsx wrapper，wrapper 上看不到 socket） |
| agent 工作区 | `$CIHEAL_DATA_ROOT/work/<projectId>-<pipelineId>-<uuid>/repo`（git worktree；CI log / MR diff 溢出文件在 work 根目录，worktree 之外） |

bare clone 首次全量、之后增量 fetch，跨 pipeline 复用（`$CIHEAL_DATA_ROOT/bare/<projectId>`）。

## 6. 结果解读

worker 结束后看 `$CIHEAL_DATA_ROOT/audit/<pipelineId>/<workId>-audit-trace.json` + `metrics.jsonl`：

| outcome | 含义 |
| --- | --- |
| `mr` | 修复成功：patch 通过 G0 diff 白名单 + G3 路径校验，已开修复 MR（URL 在 trace/钉钉 sidecar），bot 继续监控修复 MR 的 pipeline |
| `escalated` | **正确的转交**：根因在 diff 外 `src/main`、spec 矛盾无测试可依、或改测试会把 bug 固化进断言（class-3 铁律）等；trace 里 `diagnosis`/`reasoning` 带根因定位与给人工的建议。若转交前有部分修复成果，agent 会先开部分修复 MR（普通 MR，描述写明已修/未修/根因），trace 带 `mrUrl`，人工在 MR 上接力（ADR-0006） |
| `failed` | bot 自身环节失败（fetch-ci-log / worktree / agent-run 等，见 `summary`） |

`metrics.jsonl` 记录 turns / tokens / cost / durationMs，供 `pnpm metrics` 汇总。

2026-08-14 实测样例（pipeline 100033121 → escalated）：agent 定位到 MR 内提交把 `calcOnVoiceDuration` 返回值改成 `toMinutes(duration)`，心跳增量 ≤12s 被恒截断为 0，4 个测试失败；因测试断言的是 spec 行为，拒绝改测试，转交人工并给出恢复建议。

## 7. 收尾

- 停服务：`kill` 掉 tsx 子进程（只杀 pnpm wrapper 不会级联）；`lsof -nP -i :<PORT>` 确认释放。
- `$CIHEAL_DATA_ROOT` 下 `bare/` 建议保留（复用）；`work/` 由 worker manager 自动清理；`audit/` 是持久审计记录。

## 已知注意点

- scheduler 去重为内存态：同 pipeline 重投 = 重启服务（见第 4 节）。
- 预算软上限 `BOT_BUDGET_TOKENS` / `BOT_BUDGET_PER_TURN_TOKENS` 在 `turn_end` 结算，单 turn 内可能超支。
- `worktree remove -f <cwd>` 传参是 cwd 而非 `<cwd>/repo`，escalated/failed 路径会打一条 "not a working tree" warn（仅噪音，不影响结果）。
- secret 只走 `.env`（chmod 600）；服务日志以 `NODE_ENV=production` 启动防止 SDK debug 泄漏。
