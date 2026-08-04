# 供应链安全（Supply Chain）

> Scope: ticket 06 — G5 供应链约束的可执行落地。
>
> v1 本地部署（G7：无容器无 k8s），供应链风险面较窄；以下约束随部署形态升级而收紧。

## 版本锁

- `pnpm-lock.yaml` 已提交仓库，`pnpm install --frozen-lockfile` 在 CI 强制锁版本。
- 依赖升级走 PR review，不自动合并（与 MR 人工 review 一致）。
- `package.json` 依赖用 caret范围（`^`），lockfile 锁定具体版本；升级即改 lockfile。

## pnpm audit

- `package.json` 提供 `pnpm audit` 脚本：`pnpm run audit`（等价 `pnpm audit --prod`，仅扫生产依赖）。
- CI 步骤（接入 CI 时）：

  ```sh
  pnpm install --frozen-lockfile
  pnpm run audit   # 非零退出 = 有已知漏洞，阻断流水线
  pnpm typecheck
  pnpm test
  ```

- **部署前提**：`pnpm audit` 需 npm 官方 registry（或有 audit 端点的镜像）。私有镜像无 audit 端点时脚本 exit 0 但不扫描——部署需配置 `npm_config_registry` 指向官方源或确认镜像实现了 audit 端点。
- 漏洞处置：HIGH/CRITICAL 升级依赖；LOW 记录待办。不引入 `--ignore` 白名单除非有明确误报理由。

## MCP server 来源

- v1 bot 不内置 MCP server（`@earendil-works/pi-coding-agent` 通过 `ModelRuntime` + 内置工具 `read/grep/find/ls/bash` 满足 agent 能力，无外部 MCP 依赖）。
- 演进接缝（接 MCP 时）：来源限**官方/可信**——
  - 优先 pi 官方 MCP 包或经 review 的开源 MCP server。
  - 第三方 MCP server 需代码审计 + 锁版本，不直接 `npx` 远程拉取。
  - MCP server 的 secret（OAuth token）走 `.env`，同 bot secret 管理规范（chmod 600 + gitignore）。

## 受限 OS 用户（部署级，非 bot 代码）

- v1：worker 跑在宿主受限 OS 用户下（运维配置），屏蔽 `~/.ssh`、`~/.aws`、`~/.config` 等。
- docker 演进：容器内非 root 用户（`Dockerfile USER`），目录隔离 + chmod 不变。
- bot 代码不强制切用户（跨平台脆弱）；隔离由部署配置承载。

## 演进接缝

| 触发 | 机制 |
|---|---|
| pnpm audit 频繁报 HIGH/CRITICAL | 引入 Renovate/Dependabot 自动升级 PR |
| MCP server 接入 | 来源限官方/可信 + 锁版本 + secret 走 .env |
| 威胁模型 A 升级（prompt 注入实质化） | 加容器/microVM（gVisor/Firecracker）做 worker 执行隔离，内核级非 layer-7 |
| 并发>1 | per-project 隔离 .m2（部署配置 user.home 覆写，非 bot 代码） |
