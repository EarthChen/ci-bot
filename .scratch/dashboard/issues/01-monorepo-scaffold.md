# 01 — Monorepo scaffold + dashboard skeleton

**What to build:** 将项目改造为 pnpm workspace monorepo，创建 `packages/dashboard` 子包（React + Vite），Fastify 挂 `@fastify/static` 托管构建产物。Tracer bullet：浏览器访问 `/dashboard` 看到空白 React 页面。

**Blocked by:** None — can start immediately

- [ ] 根目录添加 `pnpm-workspace.yaml`（`packages: ["packages/*"]`）
- [ ] 创建 `packages/dashboard/`：`package.json`（react, react-dom, react-router-dom, vite, @vitejs/plugin-react, typescript）
- [ ] `packages/dashboard/vite.config.ts`：base = `/dashboard/`，outDir 指向 `../../dist/dashboard`
- [ ] `packages/dashboard/tsconfig.json`：独立于根 `tsconfig.json`
- [ ] `packages/dashboard/src/main.tsx` + `App.tsx`：最小 React Router 骨架（三个 route placeholder）
- [ ] `packages/dashboard/index.html`：Vite 入口
- [ ] 根 `package.json` 添加 `build:dashboard` 脚本；`build` 脚本串联 `tsc && pnpm --filter dashboard build`
- [ ] `src/main.ts` 添加 `@fastify/static`：serve `dist/dashboard/` at `/dashboard`
- [ ] 验证 `pnpm install` + `pnpm build` + `pnpm dev` 不受 monorepo 改造影响
- [ ] 验证原有 `pnpm test` + `pnpm typecheck` 不受影响
