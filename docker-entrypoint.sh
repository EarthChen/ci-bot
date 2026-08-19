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

# glab git 协议强制 HTTPS：MR 创建/git push 必须走 GITLAB_TOKEN 认证，
# 而非 SSH（容器内无 SSH key，且 MR author 需关联 token owner）。
# glab auth login 默认写 git_protocol: ssh，此处每次启动覆盖为 https。
_glab_cfg="${HOME}/.config/glab-cli/config.yml"
if [ -f "$_glab_cfg" ]; then
	sed -i 's/git_protocol: ssh/git_protocol: https/' "$_glab_cfg" 2>/dev/null || true
fi

# exec 让 node 直接接收 SIGTERM（main.ts 已做优雅关闭），不经过 shell 中转
exec node --enable-source-maps dist/main.js
