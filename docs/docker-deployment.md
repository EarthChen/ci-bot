# Docker 部署手册

以 Docker 容器运行 ci-self-heal-bot：`Dockerfile`（多阶段构建）+ `docker-compose.yml`（生产编排）。镜像自带完整修复链路运行时——Node 22（bot 本体）、glab CLI（GitLab API）、JDK 8 + Maven 3.9（agent 在 worktree 内跑 `mvn test` 验证修复，匹配目标项目主流版本）、git（bare clone + worktree）。

## 1. 镜像与容器布局

| 项 | 值 | 说明 |
| --- | --- | --- |
| 基础镜像 | `maven:3.9-eclipse-temurin-8` | Temurin JDK 1.8.0_492 + Maven 3.9.16 |
| Node / pnpm | 22.23.2 / 11 | 版本锁定原因见 §7 故障排查 |
| glab | 1.113.0（`ARG GLAB_VERSION` 可调） | 与 `src/gitlab/glab-client.ts` 的 1.112+ 语法要求一致 |
| 镜像体积 | ~850MB | JDK + Maven 是修复验证的硬需求 |
| `CIHEAL_BOT_ROOT` | `/app` | bot 资源（`.pi/`、`config/`、`src/agents/`）已烘入镜像，只读 |
| `CIHEAL_PI_BASE_DIR` | `/run/secrets/ci-self-heal-pi` | 部署时挂载 `./secrets/pi`（只读），放 `auth.json` / `models.json` |
| `CIHEAL_DATA_ROOT` | `/var/lib/ci-self-heal` | bind mount 到宿主 `${CIHEAL_HOST_DATA_DIR:-./data}`：work/bare/audit/logs + 两个 SQLite 直接落宿主文件系统 |
| 运行身份 | `HOST_UID:HOST_GID`（compose `user:`） | 容器以宿主用户运行，写 bind mount 的文件直接属宿主用户；必填（见 §6），设 0 回到 root |
| Maven 本地仓库 | `/root/.m2` | 默认挂宿主 `~/.m2` 复用缓存（v1 共享可写设计）；`CIHEAL_HOST_M2_DIR` 可切隔离目录 |
| 监听端口 | 容器内固定 `8080` | 宿主端口由 `HOST_PORT` 控制（默认 8080） |

compose 的 `environment` 优先级高于 `env_file: .env`，下表变量被固化为容器内值——**`.env` 里填什么都不生效**（静默覆盖：不改不报错，改了也不起作用）：

| 被覆盖的变量 | Docker 固化为 | 想真正改，应该改 |
| --- | --- | --- |
| `CIHEAL_BOT_ROOT` | `/app` | 改不了（资源已烘入镜像） |
| `CIHEAL_PI_BASE_DIR` | `/run/secrets/ci-self-heal-pi` | 换 `./secrets/pi` 挂载内容 |
| `CIHEAL_DATA_ROOT` | `/var/lib/ci-self-heal` | 改宿主挂载点 `CIHEAL_HOST_DATA_DIR` |
| `PORT` | `8080` | 改宿主映射端口 `HOST_PORT` |
| `NODE_ENV` | `production` | — |

其余 `.env` 变量仍生效：必填凭据（`GITLAB_WEBHOOK_SECRET`/`GITLAB_TOKEN`/`DINGTALK_CLIENT_ID`/`DINGTALK_CLIENT_SECRET`）与可选行为（`GITLAB_URL`/`BOT_CONCURRENCY`/`GITLAB_IP_ALLOWLIST`/`CIHEAL_SKIP_STAGES` 等）。`HOST_UID`/`HOST_GID`/`HOST_PORT`/`CIHEAL_HOST_DATA_DIR`/`CIHEAL_HOST_M2_DIR` 是 compose 插值专用变量，bot 本体不读取。

## 2. 前置条件

1. Docker Engine / Docker Desktop（含 compose v2）。
2. **基础镜像预拉取**（国内网络必做）：BuildKit 不走 daemon 的 `registry-mirrors`，直连 docker.io 会被限速到几十 KB/s。经加速器预拉并 retag 为本地 tag 后，构建直接命中本地缓存：

   ```bash
   docker pull docker.m.daocloud.io/library/node:22-slim \
     && docker tag docker.m.daocloud.io/library/node:22-slim node:22-slim
   docker pull docker.m.daocloud.io/library/maven:3.9-eclipse-temurin-8 \
     && docker tag docker.m.daocloud.io/library/maven:3.9-eclipse-temurin-8 maven:3.9-eclipse-temurin-8
   ```

   加速器失效时换其他可用镜像源（`hub.rat.dev`、`dockerproxy.net` 等，以 `curl -s <mirror>/v2/` 返回 200/401 判断可达）。
3. 构建期其余下载均走国内可达源：npm 依赖与 Node tarball 走 npmmirror，glab `.deb` 从 gitlab.com releases 直下（~200KB/s，约 2 分钟）。

## 3. 快速部署（compose）

```bash
# 1) 凭据：复制模板填真实值（绝不入库，.gitignore 已排除）
cp .env.example .env && chmod 600 .env
#    运行身份（必填，compose 所有子命令都会插值）：容器以宿主用户运行
printf '\nHOST_UID=%s\nHOST_GID=%s\n' "$(id -u)" "$(id -g)" >> .env

# 2) Pi 认证：secrets/pi/ 放 auth.json（provider 凭据），自定义网关再加 models.json
#    模板见 secrets/pi/auth.json.example / models.json.example
cp secrets/pi/auth.json.example secrets/pi/auth.json   # 然后填入真实 key

# 3) 数据目录：work/日志/SQLite 持久化到宿主 ./data（可用 CIHEAL_HOST_DATA_DIR 改位置）
mkdir -p data

# 4) 构建 + 启动（Maven 缓存默认复用宿主 ~/.m2，无需预热）
docker compose up -d --build

# 5) 验证
docker compose ps                          # STATUS 应出现 (healthy)
docker compose logs -f                     # 看到 "ci-self-heal bot listening"
```

宿主端口被占用时用 `HOST_PORT` 改映射（容器内始终 8080）：

```bash
HOST_PORT=18080 docker compose up -d
```

最后在 GitLab 项目设置里把 pipeline webhook 指向 `http://<宿主机地址>:<HOST_PORT>/webhook/gitlab?repair=1`，Secret Token 填 `.env` 的 `GITLAB_WEBHOOK_SECRET`（不带 `repair` 参数 = 纯失败播报）。

## 4. 裸 docker run（不用 compose）

```bash
docker build -t ci-self-heal-bot .

docker run -d --name ci-self-heal-bot \
  --user "$(id -u):$(id -g)" \
  --env-file .env \
  -e CIHEAL_BOT_ROOT=/app \
  -e CIHEAL_PI_BASE_DIR=/run/secrets/ci-self-heal-pi \
  -e CIHEAL_DATA_ROOT=/var/lib/ci-self-heal \
  -e PORT=8080 \
  -p 8080:8080 \
  -v ./secrets/pi:/run/secrets/ci-self-heal-pi:ro \
  -v ./data:/var/lib/ci-self-heal \
  -v ~/.m2:/root/.m2 \
  ci-self-heal-bot
```

注意：`.env` 里的 `CIHEAL_BOT_ROOT` / `CIHEAL_PI_BASE_DIR` / `CIHEAL_DATA_ROOT` 是主机路径，容器内必须用上面 `-e` 覆盖为容器路径，否则启动即报路径不存在。

## 5. 部署后验证

| 检查 | 命令 | 通过标准 |
| --- | --- | --- |
| 服务监听 | `curl -s -o /dev/null -w '%{http_code}' http://localhost:<HOST_PORT>/` | `404`（Fastify 无根路由，404 = 服务在线） |
| webhook 验签 | `curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:<HOST_PORT>/webhook/gitlab` | `401`（缺 `X-Gitlab-Token`） |
| 容器内工具链 | `docker compose exec ci-self-heal-bot sh -c 'node -v; pnpm -v; glab --version; java -version; mvn -v'` | node v22.23.2 / pnpm 11.x / glab 1.113.0 / JDK 1.8 / Maven 3.9 |
| healthcheck | `docker compose ps` | `Up ... (healthy)`（启动 ~10s 后，30s 间隔探活） |

真实链路回归（投递失败 pipeline → 观察诊断/MR/钉钉）见 `docs/real-run-playbook.md`。

## 6. 日常运维

```bash
docker compose logs -f                     # 跟踪日志（容器内 pino 写 stdout）
docker compose restart                     # 重启
docker compose down                        # 停止；数据在宿主目录，不受容器生命周期影响
```

**升级 bot**：

```bash
git pull
docker compose up -d --build               # 重建镜像并滚动重启
```

依赖层有缓存（lockfile 未变不重装），通常 1~2 分钟完成。

**数据备份**（都在宿主 `./data` 下，直接备份宿主目录即可）：

| 数据 | 重要性 | 说明 |
| --- | --- | --- |
| `group-routing.db` / `decisions.db` | 高 | 动态群路由 + 待人工决策状态，丢了丢路由与未决 `/heal` |
| `audit/` | 高 | 审计轨迹（含 decisionId/chainDepth） |
| `logs/` | 中 | bot.log（pino-roll 轮转）+ worker 日志，排障依据 |
| `bare/` | 低 | git bare 缓存，删后自动重 clone |
| `work/` | 低 | 事件临时工作区；含**冻干现场**（待决策场景），清掉则对应 `/heal` 无法恢复 |

```bash
tar czf backup/ci-self-heal-data-$(date +%F).tar.gz -C data .
```

**属主与权限**：容器以 `HOST_UID:HOST_GID`（compose `user:`）运行，`./data` 与 `~/.m2` 内新写的文件属主直接就是宿主用户，无 root 污染、宿主侧清理/备份无需 sudo。`HOST_UID`/`HOST_GID` **必填**——compose 的 up/down/ps/logs 都会插值 `user:`，缺失即报错；写入 `.env`：`HOST_UID=$(id -u)`、`HOST_GID=$(id -g)`。确需 root 设为 0（回到旧行为：Linux 上文件属主为 root）。macOS Docker Desktop 有属主映射，root 运行也显示为宿主属主，但仍建议对齐 UID 以保持与 Linux 一致。非 root 运行需可写 HOME（glab 写 `$HOME/.config`），entrypoint 已自动把 HOME 指到 `<CIHEAL_DATA_ROOT>/.home`。不能接受共享 `~/.m2` 时，`.env` 设 `CIHEAL_HOST_M2_DIR=/绝对路径` 切隔离仓库。

## 7. 故障排查

| 症状 | 根因 | 处理 |
| --- | --- | --- |
| `docker build` 拉基础镜像极慢/卡住 | BuildKit 不走 daemon registry-mirrors，docker.io 直连被限速 | 按 §2 经加速器预拉 + retag |
| 容器启动即退出（exit 139，无日志） | Node 22.13.0 原生模块段错误回归（`require('better-sqlite3')` 即 SIGSEGV） | Dockerfile 已锁定 `NODE_VERSION=22.23.2`；不要降回 22.13.0 |
| `corepack prepare pnpm` 签名错误 | Node 自带 corepack 的内嵌 key 与 registry 返回的 pnpm 签名不匹配 | 已绕过：Dockerfile 用 `npm install -g pnpm`（npmmirror） |
| dpkg 报 `architecture does not match` | glab `.deb` 架构与目标平台不符 | 已用 `TARGETARCH` 自动选 amd64/arm64；跨架构构建走 `docker buildx --platform` |
| 端口映射不通但容器健康 | `.env` 的 `PORT` 非 8080 时旧版 compose 映射断裂 | compose 已固化容器内 `PORT=8080`，宿主侧用 `HOST_PORT` |
| worker 报模型凭据缺失 | `secrets/pi/auth.json` 未挂载或无对应 provider 凭据 | 对照 `config/model-candidates.json` 补齐凭据，参考 `docs/pi-agent-configuration.md` |
| glab 安装 404 | 官方 `install.sh` 脚本路径已失效 | Dockerfile 已改为固定版本 `.deb` 直下；升级 glab 改 `GLAB_VERSION` build-arg |
| compose 命令报 `HOST_UID 必填` | `user:` 字段必填但未设 HOST_UID/HOST_GID | `.env` 写入 `HOST_UID=$(id -u)`、`HOST_GID=$(id -g)` |
| 宿主 `mvn` 报 permission denied（Linux） | 历史以 root 运行写脏了 `~/.m2` 属主 | UID 对齐后不再产生；历史残留 `sudo chown -R $(id -u):$(id -g) ~/.m2` |

**版本升级注意**：升级 `NODE_VERSION` 前先在容器内验证 `node -e "require('better-sqlite3')"` 不段错误；升级 `GLAB_VERSION` 前对照 `src/gitlab/glab-client.ts` 注释中的语法约束（`-R OWNER/REPO`、不接受纯数字 id）。
