#!/usr/bin/env bash
# 本地 e2e：向运行中的 ci-bot 发送一个 GitLab pipeline-failed webhook。
#
# 用法：
#   GITLAB_WEBHOOK_SECRET=testsecret bash scripts/send-webhook.sh
#   GITLAB_WEBHOOK_SECRET=testsecret bash scripts/send-webhook.sh deploy/webhook-example.json
#
# 前置（与 .env 一致）：
#   - 必须与启动时 GITLAB_WEBHOOK_SECRET 相同，否则 401
#   - 本地跑建议 GITLAB_IP_ALLOWLIST 留空（receiver 会跳过 allowlist 校验）
set -euo pipefail

SECRET="${GITLAB_WEBHOOK_SECRET:-testsecret}"
PORT="${CI_BOT_PORT:-8080}"
PAYLOAD="${1:-deploy/webhook-example.json}"

echo "POST http://localhost:${PORT}/webhook  (payload: ${PAYLOAD})"
curl -i -X POST "http://localhost:${PORT}/webhook" \
	-H "Content-Type: application/json" \
	-H "X-Gitlab-Token: ${SECRET}" \
	--data-binary "@${PAYLOAD}"
echo
