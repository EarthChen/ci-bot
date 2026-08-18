# CI Self-Heal Bot — Docker 镜像
# 多阶段构建：build 阶段用 pnpm 编译 TS → runtime 阶段最小化
#
# 构建：
#   docker build -t ci-self-heal-bot .
#
# 运行（需要 .env + secrets 目录；--user 以宿主身份运行，避免写脏 ./data 与 ~/.m2 属主）：
#   docker run -d --env-file .env -p 8080:8080 \
#     --user "$(id -u):$(id -g)" \
#     -v ./secrets/pi:/run/secrets/ci-self-heal-pi:ro \
#     -v ./data:/var/lib/ci-self-heal \
#     -v ~/.m2:/root/.m2 \
#     ci-self-heal-bot

# ==================== Stage 1: Build ====================
FROM node:22-slim AS build

# build-essential + python3：better-sqlite3 原生模块编译（无预编译二进制时回退）
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# pnpm 用 npm -g 安装（node:22-slim 自带 npm）：corepack prepare 的签名校验在当前 registry 下失败
ARG PNPM_VERSION=11
RUN npm install -g pnpm@${PNPM_VERSION} --registry=https://registry.npmmirror.com --no-audit --no-fund

WORKDIR /app

# 依赖层缓存：先复制 lockfile + package.json
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm install --frozen-lockfile

# 源码 + 编译
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm build

# 剔除 devDependencies（typescript/vitest/tsx/@types/*）
RUN pnpm prune --prod

# ==================== Stage 2: Runtime ====================
# maven:3.9-eclipse-temurin-8：官方镜像自带 Maven 3.9 + Temurin JDK 8；
# 目标项目大部分为 JDK 8，agent 在 worktree 内跑 mvn/gradlew 验证修复（G3）
FROM maven:3.9-eclipse-temurin-8

# git：bare clone + worktree 操作
# ca-certificates：HTTPS 调用 GitLab API
# glab CLI：GitLab API 封装（fetchCiLog / fetchMrDiff / createMr）
# 注：install.sh 已失效（404）；固定版本从 gitlab.com 直下 .deb + dpkg 安装
# TARGETARCH 由 BuildKit 注入（amd64/arm64），按目标平台选 .deb，避免硬编码架构
ARG GLAB_VERSION=1.113.0
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl xz-utils \
    && curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${TARGETARCH}.deb" -o /tmp/glab.deb \
    && dpkg -i /tmp/glab.deb \
    && rm /tmp/glab.deb \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Node 22 + pnpm（bot 本体运行环境）：从 npmmirror 拉官方 tarball，
# 不依赖 apt/Docker Hub（国内直连可达，见 Dockerfile 顶部说明）
# TARGETARCH → node 平台名：amd64=x64 / arm64=arm64
# pnpm 用 npm -g 安装（走 npmmirror）：Node 自带 corepack 的 prepare 签名校验失败，绕过
# Node 版本锁定说明：22.13.0 存在原生模块段错误回归（require better-sqlite3 即 SIGSEGV，
# 实测 22.23.2 正常）；与 build 阶段 node:22-slim 保持一致
ARG NODE_VERSION=22.23.2
ARG TARGETARCH
ARG PNPM_VERSION=11
RUN NODE_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64) \
    && curl -fsSL "https://npmmirror.com/mirrors/node/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && npm install -g pnpm@${PNPM_VERSION} --registry=https://registry.npmmirror.com --no-audit --no-fund

# Agent 在 worktree 内 git commit 需要 user 配置；bot 自身的 bare clone 不需要
RUN git config --system user.email "ci-self-heal-bot@local" \
    && git config --system user.name "ci-self-heal-bot"

WORKDIR /app

# 从 build 阶段复制产物
COPY --from=build /app/dist/ ./dist/
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/package.json ./

# Bot-owned 资源（CIHEAL_BOT_ROOT 指向 /app，worker 从此加载 playbook 与配置）
COPY .pi/ .pi/
COPY config/ config/
COPY src/agents/ src/agents/
COPY --chmod=755 docker-entrypoint.sh /app/docker-entrypoint.sh

# 预建数据目录（CIHEAL_DATA_ROOT=/var/lib/ci-self-heal）
# CIHEAL_PI_BASE_DIR 由 operator 通过 volume/secret 挂载，此处仅创建占位
RUN mkdir -p /var/lib/ci-self-heal /run/secrets/ci-self-heal-pi

ENV CIHEAL_BOT_ROOT=/app
ENV CIHEAL_PI_BASE_DIR=/run/secrets/ci-self-heal-pi
ENV CIHEAL_DATA_ROOT=/var/lib/ci-self-heal
ENV NODE_ENV=production
ENV PORT=8080
# maven:3.9-eclipse-temurin-8 已自带 JAVA_HOME（/opt/java/openjdk），无需覆盖

EXPOSE 8080

# 生产入口：不使用 pnpm start（避免 prestart 重复构建）；entrypoint 保证非 root 时 HOME 可写
ENTRYPOINT ["/app/docker-entrypoint.sh"]