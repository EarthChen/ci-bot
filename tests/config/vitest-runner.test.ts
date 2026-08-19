import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function readJson(relativePath: string): unknown {
	return JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8"));
}

describe("vitest runner config (OOM guard)", () => {
	it("uses singleFork to avoid e2e subprocess races", async () => {
		const { default: config } = await import("../../vitest.config.js");
		expect(config.test?.pool).toBe("forks");
		expect(config.test?.poolOptions?.forks?.singleFork).toBe(true);
	});

	it("raises Node heap limit for full-suite single-fork runs", async () => {
		const pkg = readJson("package.json") as { scripts: { test: string } };
		const { default: config } = await import("../../vitest.config.js");

		const testScript = pkg.scripts.test;
		const execArgv = config.test?.poolOptions?.forks?.execArgv ?? [];

		const scriptHasHeap = /--max-old-space-size=\d+/.test(testScript);
		const execArgvHasHeap = execArgv.some((arg) =>
			/^--max-old-space-size=\d+$/.test(arg),
		);

		expect(scriptHasHeap || execArgvHasHeap).toBe(true);
	});
});
