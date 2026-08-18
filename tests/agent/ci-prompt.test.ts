import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCiRepairDefinition } from "../../src/agent/ci-repair-definition.js";
import type { AgentRunInput } from "../../src/agent/runner.js";

function makeInput(mrDiff: string): AgentRunInput {
	return {
		projectId: "31041",
		pipelineId: 100033426,
		ref: "refs/merge-requests/281/head",
		sha: "95fd03b89086827e5b343f18728484ec25af6762",
		ciLog: "test failure log",
		mrDiff,
		cwd: "",
		sourceBranch: "ci-self-heal/refs/merge-requests/281/head-95fd03b8",
		targetBranch: "dev-backend-activity",
	};
}

describe("buildCiPrompt — MR diff 索引（MR !281 提速）", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "ci-prompt-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("有 mrDiff → 落盘 mr-diff-index.txt，prompt 指引用索引定位", () => {
		const mrDiff = [
			"--- src/main/java/A.java",
			"+++ src/main/java/A.java",
			"@@ -1 +1 @@",
			"+changed",
		].join("\n");
		const prompt = createCiRepairDefinition(cwd).buildPrompt(makeInput(mrDiff));

		const indexPath = join(cwd, "mr-diff-index.txt");
		expect(existsSync(indexPath)).toBe(true);
		expect(readFileSync(indexPath, "utf8")).toContain("src/main/java/A.java  +1 -0");
		expect(prompt).toContain(indexPath);
		expect(prompt).toContain("mr-diff.patch");
	});

	it("无 mrDiff → 不写索引文件，prompt 不出现索引行", () => {
		const prompt = createCiRepairDefinition(cwd).buildPrompt(makeInput(""));

		expect(existsSync(join(cwd, "mr-diff-index.txt"))).toBe(false);
		expect(prompt).not.toContain("mr-diff-index.txt");
	});
});
