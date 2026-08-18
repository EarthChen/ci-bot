import { describe, expect, it } from "vitest";
import { GlabGitLabClient } from "../../src/gitlab/glab-client";
import type { Diagnosis, Patch } from "../../src/types";

/** Recording fake runner: canned replies matched against the joined args. */
function recordingRunner(
	responses: ReadonlyArray<{ match: RegExp; reply: string }>,
): { calls: string[][]; run: (args: readonly string[]) => Promise<string> } {
	const calls: string[][] = [];
	const run = async (args: readonly string[]): Promise<string> => {
		calls.push([...args]);
		const joined = args.join(" ");
		for (const r of responses) {
			if (r.match.test(joined)) return r.reply;
		}
		throw new Error(`unexpected glab call: ${joined}`);
	};
	return { calls, run };
}

const projectApiReply = JSON.stringify({
	path_with_namespace: "ultron/ultron-activity-independence",
});

describe("GlabGitLabClient.fetchMrDiff", () => {
	it("resolves the project path and selects the repo via -R", async () => {
		// glab 1.112: `mr diff` rejects --project ("Unknown flag") and -R only
		// accepts OWNER/REPO — a bare numeric project id fails. The client must
		// resolve path_with_namespace first.
		const { calls, run } = recordingRunner([
			{ match: /^api \/projects\/31041$/, reply: projectApiReply },
			{ match: /^mr diff /, reply: "--- a\n+++ b\n" },
		]);
		const client = new GlabGitLabClient(run);

		const diff = await client.fetchMrDiff("31041", 281);

		expect(diff).toBe("--- a\n+++ b\n");
		expect(calls[0]).toEqual(["api", "/projects/31041"]);
		expect(calls[1]).toEqual([
			"mr",
			"diff",
			"281",
			"-R",
			"ultron/ultron-activity-independence",
		]);
	});

	it("caches the resolved path across calls", async () => {
		const { calls, run } = recordingRunner([
			{ match: /^api \/projects\/31041$/, reply: projectApiReply },
			{ match: /^mr diff /, reply: "diff" },
		]);
		const client = new GlabGitLabClient(run);

		await client.fetchMrDiff("31041", 281);
		await client.fetchMrDiff("31041", 282);

		const apiCalls = calls.filter((c) => c[0] === "api");
		expect(apiCalls).toHaveLength(1);
		expect(calls).toHaveLength(3);
	});

	it("fails loudly when the project path cannot be resolved", async () => {
		const { run } = recordingRunner([
			{ match: /^api \/projects\/999$/, reply: "{}" },
		]);
		const client = new GlabGitLabClient(run);

		await expect(client.fetchMrDiff("999", 1)).rejects.toThrow(
			"cannot resolve project path for 999",
		);
	});
});

describe("GlabGitLabClient.createMr", () => {
	const diagnosis: Diagnosis = { failureClass: 1, summary: "stale assertion" };
	const patch: Patch = {
		diff: "--- a\n+++ b\n",
		paths: ["src/test/java/FooTest.java"],
		summary: "updated assertion",
	};

	it("creates the MR against the resolved repo path", async () => {
		const { calls, run } = recordingRunner([
			{ match: /^api \/projects\/31041$/, reply: projectApiReply },
			{
				match: /^mr create /,
				reply: JSON.stringify({
					web_url: "https://git.wemomo.com/x/-/merge_requests/9",
				}),
			},
		]);
		const client = new GlabGitLabClient(run);

		const created = await client.createMr({
			projectId: "31041",
			sourceBranch: "ci-self-heal/fix-1",
			targetBranch: "dev-backend-activity",
			title: "fix: CI self-heal",
			diagnosis,
			patch,
		});

		expect(created.url).toBe("https://git.wemomo.com/x/-/merge_requests/9");
		const createCall = calls.at(-1) as string[];
		expect(createCall.slice(0, 2)).toEqual(["mr", "create"]);
		const repoIdx = createCall.indexOf("-R");
		expect(repoIdx).toBeGreaterThan(0);
		expect(createCall[repoIdx + 1]).toBe(
			"ultron/ultron-activity-independence",
		);
	});

	it("defaults Delete source branch + Squash commits (MR !281 需求)", async () => {
		const { calls, run } = recordingRunner([
			{ match: /^api \/projects\/31041$/, reply: projectApiReply },
			{
				match: /^mr create /,
				reply: JSON.stringify({
					web_url: "https://git.wemomo.com/x/-/merge_requests/9",
				}),
			},
		]);
		const client = new GlabGitLabClient(run);
		await client.createMr({
			projectId: "31041",
			sourceBranch: "ci-self-heal/fix-1",
			targetBranch: "dev-backend-activity",
			title: "fix: CI self-heal",
			diagnosis,
			patch,
		});
		const createCall = calls.at(-1) as string[];
		expect(createCall).toContain("--remove-source-branch=true");
		expect(createCall).toContain("--squash-before-merge=true");
	});
});
