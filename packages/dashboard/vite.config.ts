import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	base: "/dashboard/",
	build: {
		// dist/dashboard 被 tsc 的 src/dashboard 后端模块占用，前端产物必须另
		// 放目录，否则 emptyOutDir 会清掉编译产物（部署实测 ERR_MODULE_NOT_FOUND）
		outDir: "../../dist/dashboard-web",
		emptyOutDir: true,
	},
	server: {
		proxy: {
			"/api": "http://localhost:8080",
		},
	},
});
