#!/usr/bin/env bash
# UID 对齐冒烟测试：验证容器以 HOST_UID 运行（首要判据），写入数据卷/.m2 的文件属主为宿主用户。
#
# 用法：scripts/docker-uid-smoke.sh
# 前置：镜像已构建（docker build -t ci-self-heal-bot .）；docker daemon 运行中。
# 退出码：0=通过；1=断言失败；2=前置不满足（SKIP）。
#
# 说明：macOS Docker Desktop 的 virtiofs 会把 root 写入映射成宿主属主，
# 因此「文件属主」判据在本机被掩盖、仅 Linux 显形；「进程 UID」判据可移植，是主判据。
set -eo pipefail

HOST_UID=$(id -u)
HOST_GID=$(id -g)
# export 使所有 compose 子命令（up/down/ps）都能插值 user: 字段
export HOST_UID HOST_GID
TMP=$(mktemp -d "${TMPDIR:-/tmp}/uid-smoke.XXXXXX")
RESULT=0
cleanup() {
	local code=$?
	( cd "$TMP" && docker compose down >/dev/null 2>&1 ) || true
	rm -rf "$TMP"
	exit "${RESULT:-$code}"
}
trap cleanup EXIT

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

# ---- 组装最小部署目录（隔离：不碰真实 .env / ~/.m2） ----
cp "$REPO_ROOT/docker-compose.yml" "$TMP/"
mkdir -p "$TMP/secrets/pi" "$TMP/data" "$TMP/m2"
echo '{}' > "$TMP/secrets/pi/auth.json"
cat > "$TMP/.env" <<'EOF'
GITLAB_WEBHOOK_SECRET=dummy
GITLAB_TOKEN=dummy
DINGTALK_CLIENT_ID=dummy
DINGTALK_CLIENT_SECRET=dummy
CIHEAL_DINGTALK_MODE=fake
EOF

if ! docker image ls ci-self-heal-bot:latest --format '{{.ID}}' | grep -q .; then
	echo "SKIP: 镜像 ci-self-heal-bot:latest 未构建（先 docker build -t ci-self-heal-bot .）"
	exit 2
fi

cd "$TMP"
HOST_UID="$HOST_UID" HOST_GID="$HOST_GID" HOST_PORT=18099 \
CIHEAL_HOST_DATA_DIR="$TMP/data" CIHEAL_HOST_M2_DIR="$TMP/m2" \
	docker compose up -d >/dev/null 2>&1 || { echo "FAIL: compose up 失败"; RESULT=1; exit 1; }

# 等容器健康（最多 60s；超时仍继续跑断言，便于定位失败点）
st="starting"
for _ in $(seq 1 30); do
	st=$(docker inspect --format '{{.State.Health.Status}}' ci-self-heal-bot 2>/dev/null || echo starting)
	if [ "$st" = "healthy" ]; then break; fi
	sleep 2
done
echo "health: $st"

file_owner() { stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1"; }

# 断言 1（主判据，可移植）：容器主进程 UID == 宿主用户
uid=$(docker exec ci-self-heal-bot id -u 2>/dev/null || echo "EXEC_FAIL")
if [ "$uid" = "$HOST_UID" ]; then
	echo "OK:   进程 UID=$uid（== 宿主 $HOST_UID）"
else
	echo "FAIL: 进程 UID=$uid，期望 $HOST_UID（容器未以宿主身份运行）"
	RESULT=1
fi

# 断言 2（参考，macOS 被 virtiofs 掩盖）：数据卷新写文件属主 == 宿主用户
if docker exec ci-self-heal-bot sh -c 'echo canary > /var/lib/ci-self-heal/uid-canary' 2>/dev/null; then
	own=$(file_owner "$TMP/data/uid-canary" 2>/dev/null || echo "?")
	echo "INFO: data canary 属主=$own（宿主 $HOST_UID）"
fi

# 断言 3（参考，macOS 被 virtiofs 掩盖）：.m2 卷新写文件属主 == 宿主用户
if docker exec ci-self-heal-bot sh -c 'echo canary > /var/lib/ci-self-heal/.home/.m2/uid-canary' 2>/dev/null; then
	own=$(file_owner "$TMP/m2/uid-canary" 2>/dev/null || echo "?")
	echo "INFO: m2 canary 属主=$own（宿主 $HOST_UID）"
fi

if [ "$RESULT" -eq 0 ]; then
	echo "PASS: UID 对齐"
else
	echo "FAIL: UID 未对齐"
fi
exit "$RESULT"
