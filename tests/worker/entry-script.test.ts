import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEntryScript } from "../../src/worker/manager.js";

/**
 * Worker entry script resolution — dev runs the TS source via tsx, while the
 * docker/production image only ships the compiled dist/*.js bundle. If the
 * manager always resolved to main.ts, prod worker spawns would fail with a
 * missing file (ENOENT) and crash before any worker.log is written.
 */
describe("resolveEntryScript — dev(tsx) vs prod(dist) branch", () => {
	const tmpDirs: string[] = [];

	function makeDir(files: string[]): string {
		const dir = mkdtempSync(join(tmpdir(), "entry-script-"));
		tmpDirs.push(dir);
		for (const f of files) writeFileSync(join(dir, f), "export{}", "utf8");
		return dir;
	}

	it("prefers the TS source when it exists (dev: tsx runs src/worker/main.ts)", () => {
		const dir = makeDir(["main.ts", "main.js"]);
		expect(resolveEntryScript(dir)).toBe(join(dir, "main.ts"));
	});

	it("falls back to the compiled .js when only the bundle exists (docker/prod)", () => {
		const dir = makeDir(["main.js"]);
		expect(resolveEntryScript(dir)).toBe(join(dir, "main.js"));
	});

	it("falls back to .js even when the TS source is the only file present", () => {
		const dir = makeDir(["main.ts"]);
		expect(resolveEntryScript(dir)).toBe(join(dir, "main.ts"));
	});

	it("never returns main.ts when it is absent (empty dir → .js fallback)", () => {
		const dir = makeDir([]);
		expect(resolveEntryScript(dir)).toBe(join(dir, "main.js"));
	});

	it("returns an absolute path usable directly by runChild", () => {
		const dir = makeDir(["main.js"]);
		expect(resolveEntryScript(dir)).toMatch(/^[/\\]/);
	});

	afterEach(() => {
		for (const dir of tmpDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});