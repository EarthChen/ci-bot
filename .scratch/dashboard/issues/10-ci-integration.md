# 10 — CI: add dashboard build step

**What to build:** GitHub Actions CI 流程中新增 dashboard 构建步骤，确保 dashboard 类型错误和构建失败在 CI 中被捕获。

**Blocked by:** 01

- [ ] `.github/workflows/ci.yml`：在 typecheck + test 之后新增 step `pnpm --filter dashboard build`
- [ ] 验证 CI 在 dashboard 存在类型错误时失败
- [ ] 验证 CI 在 dashboard 构建成功时通过
- [ ] 确认 pnpm workspace 不影响 `pnpm install --frozen-lockfile`
- [ ] 确认 fixture submodule checkout 不受影响
