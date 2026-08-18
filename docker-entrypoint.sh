#!/bin/sh
# 运行入口：确保非 root 运行时 HOME 可写。
# 基础镜像 HOME=/root 仅 root 可写；以 HOST_UID 运行时 glab/git 需要可写的
# $HOME（glab 写 $HOME/.config）。此处把 HOME 指到数据卷（宿主属主、可写）下
# 的 .home 子目录；root 运行时 /root 可写，保持原样。
set -e
if [ -z "${HOME:-}" ] || [ ! -w "${HOME:-/nonexistent}" ]; then
	HOME="${CIHEAL_DATA_ROOT:-/var/lib/ci-self-heal}/.home"
	mkdir -p "$HOME" 2>/dev/null || true
	export HOME
fi
# exec 让 node 直接接收 SIGTERM（main.ts 已做优雅关闭），不经过 shell 中转
exec node --enable-source-maps dist/main.js
