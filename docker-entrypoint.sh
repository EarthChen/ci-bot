#!/bin/sh
# 运行入口：确保非 root 运行时 HOME 可写 + Java user.home 正确。
# 基础镜像 HOME=/root 仅 root 可写；以 HOST_UID 运行时 glab/git 需要可写的
# $HOME（glab 写 $HOME/.config）。此处把 HOME 指到数据卷（宿主属主、可写）下
# 的 .home 子目录；root 运行时 /root 可写，保持原样。
set -e
if [ -z "${HOME:-}" ] || [ ! -w "${HOME:-/nonexistent}" ]; then
	HOME="${CIHEAL_DATA_ROOT:-/var/lib/ci-self-heal}/.home"
	mkdir -p "$HOME" 2>/dev/null || true
	export HOME
fi

# 非 root 时注册 /etc/passwd 条目：JDK 8 通过 getpwuid 解析 user.home，
# UID 不在 passwd 则回退为 "?" → Maven 无法定位 local repository。
# Dockerfile 已 chmod 666 /etc/passwd 使非 root 可写。
CUR_UID=$(id -u)
if [ "$CUR_UID" != "0" ] && ! getent passwd "$CUR_UID" > /dev/null 2>&1; then
	echo "cibot:x:${CUR_UID}:$(id -g):cibot:${HOME}:/bin/sh" >> /etc/passwd 2>/dev/null || true
fi

# MAVEN_CONFIG 对齐 HOME（基础镜像默认 /root/.m2，非 root 时不可达）
export MAVEN_CONFIG="${HOME}/.m2"

# Git author 对齐 GITLAB_TOKEN owner：MR commit 显示 token 所属用户身份
# （Dockerfile --system 配置的 "ci-self-heal-bot" 仅作兜底）。
# --global 优先级高于 --system；best-effort——API 不通则沿用 --system 默认值。
if [ -n "${GITLAB_TOKEN:-}" ] && [ -n "${GITLAB_URL:-}" ]; then
	_user_json=$(curl -sf -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" \
		"${GITLAB_URL}/api/v4/user" 2>/dev/null || true)
	if [ -n "$_user_json" ]; then
		_name=$(printf '%s' "$_user_json" | sed -n 's/.*"name" *: *"\([^"]*\)".*/\1/p' | head -1)
		_email=$(printf '%s' "$_user_json" | sed -n 's/.*"email" *: *"\([^"]*\)".*/\1/p' | head -1)
		[ -n "$_name" ] && git config --global user.name "$_name"
		[ -n "$_email" ] && git config --global user.email "$_email"
	fi
fi

# exec 让 node 直接接收 SIGTERM（main.ts 已做优雅关闭），不经过 shell 中转
exec node --enable-source-maps dist/main.js
