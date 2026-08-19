# dev 环境部署手册（ci-self-heal-bot）

> 用途：把 master 上的新提交部署到 dev 环境的可重复操作手册。通用 Docker 部署细节（镜像构建、.env 变量清单、数据备份）见 `docker-deployment.md`，本文只覆盖 **dev 专属流程与已知坑**。

## 1. 环境基线

| 项 | 值 |
| --- | --- |
| 主机 | `ssh dev`（172.18.228.71，用户 momo，macOS，Docker Desktop） |
| 部署目录 | `/Users/momo/ci-bot`（git 仓库，remote = `git@github.com:EarthChen/ci-bot.git`） |
| 运行形态 | docker compose 单容器 `ci-self-heal-bot`，宿主端口 **8080** → 容器 8080 |
| webhook 端点 | `POST http://<dev>:8080/webhook/gitlab`（query `?repair=1` 开启自动修复） |
| 关键文件 | `.env`（凭据+compose 插值变量，chmod 600）、`secrets/pi/auth.json`（模型凭据）、`data/`（SQLite + audit + mr-sessions + work）、`config/group-routing.json` |

基线快照（2026-08-19）：macOS 26.4.1 / Docker 29.3.1 / Compose v5.1.1；容器内 Node 22.23.2。

## 2. 红线（违反即丢数据/丢配置）

1. **绝不覆盖远端未提交状态**：`config/group-routing.json` 在 dev 上是手工改过的本地配置（`git status` 显示 `M`）。**禁止** `git reset --hard`、`git checkout .`、`git stash pop` 覆盖它；`git pull --ff-only` 在冲突时会安全失败，出现冲突时手工合并。
2. **绝不整体同步文件**：不要用 rsync/scp 覆盖部署目录（会毁掉 `.env`、`data/`、`secrets/`）。部署只走 **git push + pull**。
3. **`.env` / `secrets/pi/` 不入库**：凭据只在远端手工维护；改凭据直接 ssh 编辑 `.env`（保持 chmod 600）后重建容器。
4. **`data/decisions.db` 有未决 `/heal` 时勿删**：删库 = 丢待人工决策与冻干现场的关联。

## 3. 标准部署流程

前置：本地全量验证通过（`pnpm typecheck` + `pnpm test` 全绿），改动已按 conventional commits 提交。

```bash
# ── 本地 ──────────────────────────────────────────────
git push origin master

# ── dev ───────────────────────────────────────────────
ssh dev
cd /Users/momo/ci-bot

# 1) 拉取（--ff-only：有本地分叉时安全失败，不产生 merge 提交）
git pull --ff-only origin master

# 2) 重建镜像（依赖层有缓存，lockfile 未变通常 1~2 分钟）
/usr/local/bin/docker compose build

# 3) 滚动重启（重新加载 .env 与代码；容器内服务有优雅关闭）
/usr/local/bin/docker compose up -d
```

> 为什么用 `/usr/local/bin/docker`：dev 上非交互 shell（ssh 直连）的 PATH 里没有 docker，直接敲 `docker` 会报 command not found。交互终端里可以用 `docker`。

## 4. 部署后验证（必做，全过才算完成）

```bash
# a. 容器健康（启动 ~10s 后应出现 healthy）
/usr/local/bin/docker compose ps            # ci-self-heal-bot | Up … (healthy)

# b. 启动日志无异常：钉钉 stream 连接 + 监听
/usr/local/bin/docker logs ci-self-heal-bot --tail 10
#    期望看到: "dingtalk stream bot started" 与 "ci-self-heal bot listening"

# c. 端点存活（404 = Fastify 在线；401 = 路由+验签链路正常）
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/
#    期望: 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/webhook/gitlab
#    期望: 401（缺 X-Gitlab-Token）

# d. 确认部署的版本
git log --oneline -1                        # 应等于本地推上来的 HEAD
```

涉及 schema 迁移的版本（如 0009 的 `decisions.oos_paths`）：迁移在 `DecisionStore` 构造时自动执行，启动日志无报错即成功。

## 5. 回滚

```bash
cd /Users/momo/ci-bot
git log --oneline -5                        # 找到上一个已知好的 sha
git checkout <good-sha>                     # detached HEAD，不动 master
/usr/local/bin/docker compose up -d --build
# 验证同 §4；恢复后 git switch master 回到主线
```

注意：回滚代码不回滚数据——新版本写过的 `data/`（新列、新存档）会保留；本文档范围内的迁移均为增量兼容，旧代码读新库不报错。

## 6. GitLab 侧配置（每个接入项目）

| 项 | 值 |
| --- | --- |
| Webhook URL | `http://<dev 地址>:8080/webhook/gitlab?repair=1`（不带 `repair` = 纯失败播报） |
| Secret Token | dev `.env` 中的 `GITLAB_WEBHOOK_SECRET` |
| Trigger | **Pipeline events + Merge request events 都要勾选**（后者驱动 MR 合并/关闭后的 bot 状态清理，ADR-0008） |

## 7. 已知坑

| 症状 | 根因 | 处理 |
| --- | --- | --- |
| ssh 非交互命令里 `docker: command not found` | docker 不在非交互 shell PATH | 用绝对路径 `/usr/local/bin/docker` |
| ssh 执行含 `===XXX===` 的 echo 报 "not found" | zsh 把行首 `=` 当命令路径展开 | 分隔符用 `---XXX---` |
| `git pull` 因 `config/group-routing.json` 失败 | 上游改了同一文件 | 手工合并该文件（保留 dev 本地路由），勿 reset |
| 容器重启后 webhook 404/无响应 | 端口映射或容器未起 | `docker compose ps` + `docker port ci-self-heal-bot` 核对 8080 |
| 升级 Node 后容器启动 SIGSEGV | better-sqlite3 与 Node 22.13.0 回归 | 保持 Dockerfile 锁定 22.23.2（详见 `docker-deployment.md` §7） |

## 8. 日常运维速查

```bash
/usr/local/bin/docker compose logs -f        # 跟踪日志
/usr/local/bin/docker compose restart        # 重启（不重建镜像）
/usr/local/bin/docker compose down           # 停止（数据在宿主，不受影响）
```

数据备份与属主/权限问题：见 `docker-deployment.md` §6。真实链路回归（投递失败 pipeline 观察诊断/MR/钉钉）：见 `docs/real-run-playbook.md`。
