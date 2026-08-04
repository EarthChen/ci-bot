import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
	await Promise.all(
		cleanupPaths
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("worker Pi configuration bootstrap", () => {
	it("copies deployment-owned Pi auth and model files into an isolated worker directory", async () => {
		const baseConfigDir = await temporaryDirectory("ciheal-pi-base-");
		const workerDir = await temporaryDirectory("ciheal-pi-worker-");
		const auth = '{"providers":{"deepseek":{"type":"api_key"}}}\n';
		const models =
			'{"providers":{"deepseek":{"baseUrl":"https://api.deepseek.com"}}}\n';
		await writeFile(join(baseConfigDir, "auth.json"), auth);
		await writeFile(join(baseConfigDir, "models.json"), models);

		const manager = new SubprocessWorkerManager({
			keepWork: true,
			timeoutMs: 60_000,
			env: {
				CIHEAL_PI_BASE_DIR: baseConfigDir,
				CIHEAL_WORKTREE_MODE: "fake",
			},
		});
		await manager.run(
			{
				projectId: "pi-config-project",
				pipelineId: 101,
				ref: "main",
				sha: "0123456789abcdef",
				projectUrl: "https://gitlab.example.com/pi-config-project",
			},
			workerDir,
		);

		const workerAgentDir = join(workerDir, ".pi-agent");
		await expect(
			readFile(join(workerAgentDir, "auth.json"), "utf8"),
		).resolves.toBe(auth);
		await expect(
			readFile(join(workerAgentDir, "models.json"), "utf8"),
		).resolves.toBe(models);

		await writeFile(join(workerAgentDir, "auth.json"), "changed\n");
		expect(await readFile(join(baseConfigDir, "auth.json"), "utf8")).toBe(auth);
	});
});

async function temporaryDirectory(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	cleanupPaths.push(path);
	return path;
}
