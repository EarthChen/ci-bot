import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountDashboardStatic } from "../../src/dashboard/routes.js";

/**
 * Regression: @fastify/static 的默认 wildcard 路由与显式 SPA fallback
 * GET /dashboard/* 冲突，FST_ERR_DUPLICATED_ROUTE 让 main.ts 启动即崩
 * （部署 1717f52 实测）。mountDashboardStatic 必须干净启动，且：
 * 真实文件按原样提供；未知路径回落 index.html（React Router 刷新）。
 */

const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeDashboardDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dashboard-static-"));
	tmpDirs.push(dir);
	writeFileSync(join(dir, "index.html"), "<html>SPA-INDEX</html>", "utf8");
	mkdirSync(join(dir, "assets"));
	writeFileSync(join(dir, "assets", "app.js"), "/*SPA-ASSET*/", "utf8");
	return dir;
}

describe("mountDashboardStatic", () => {
	it("启动无路由重复，资产按原样提供、未知路径回落 index.html", async () => {
		const app = Fastify();
		await mountDashboardStatic(app, makeDashboardDir());
		await app.ready();

		const asset = await app.inject({ method: "GET", url: "/dashboard/assets/app.js" });
		expect(asset.statusCode).toBe(200);
		expect(asset.body).toContain("SPA-ASSET");

		const index = await app.inject({ method: "GET", url: "/dashboard/index.html" });
		expect(index.statusCode).toBe(200);
		expect(index.body).toContain("SPA-INDEX");

		// React Router 客户端路由：未知路径 → index.html（页面刷新场景）
		const spa = await app.inject({ method: "GET", url: "/dashboard/decisions" });
		expect(spa.statusCode).toBe(200);
		expect(spa.body).toContain("SPA-INDEX");

		await app.close();
	});

	it("/dashboard 无尾斜杠重定向到 /dashboard/（裸路径曾 404）", async () => {
		const app = Fastify();
		await mountDashboardStatic(app, makeDashboardDir());
		await app.ready();

		const res = await app.inject({ method: "GET", url: "/dashboard" });
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe("/dashboard/");

		await app.close();
	});
});
