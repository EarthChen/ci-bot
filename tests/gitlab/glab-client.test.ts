import { describe, expect, it } from "vitest";
import { GlabGitLabClient } from "../../src/gitlab/glab-client.js";
import type { Diagnosis, Patch } from "../../src/types.js";

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

describe("GlabGitLabClient.findMrBySourceBranch", () => {
	it("returns MR status, iid, and web_url when a repair branch exists", async () => {
		const branch = "ci-self-heal/fix-42";
		const webUrl = "https://gitlab.example.com/g/p/-/merge_requests/17";
		const { calls, run } = recordingRunner([
			{
				match: new RegExp(
					`merge_requests\\?source_branch=${encodeURIComponent(branch).replace("/", "\\/")}`,
				),
				reply: JSON.stringify([
					{ iid: 17, state: "opened", web_url: webUrl },
				]),
			},
		]);
		const client = new GlabGitLabClient(run);

		const mr = await client.findMrBySourceBranch("31041", branch);

		expect(mr).toEqual({
			status: "opened",
			iid: 17,
			url: webUrl,
		});
		expect(calls[0]).toEqual([
			"api",
			`/projects/31041/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all&per_page=1&order_by=updated_at&sort=desc`,
		]);
	});

	it("returns null when no MR matches the source branch", async () => {
		const { run } = recordingRunner([
			{ match: /merge_requests\?source_branch=/, reply: "[]" },
		]);
		const client = new GlabGitLabClient(run);

		const mr = await client.findMrBySourceBranch(
			"31041",
			"ci-self-heal/nonexistent",
		);

		expect(mr).toBeNull();
	});
});

describe("GlabGitLabClient.fetchBranchHeadSha", () => {
	it("returns the latest commit sha for the branch", async () => {
		const branch = "ci-self-heal/fix-42";
		const sha = "abc123def4567890abcdef1234567890abcdef12";
		const { calls, run } = recordingRunner([
			{
				match: new RegExp(
					`repository/branches/${encodeURIComponent(branch).replace("/", "\\/")}$`,
				),
				reply: JSON.stringify({ commit: { id: sha } }),
			},
		]);
		const client = new GlabGitLabClient(run);

		const head = await client.fetchBranchHeadSha("31041", branch);

		expect(head).toBe(sha);
		expect(calls[0]).toEqual([
			"api",
			`/projects/31041/repository/branches/${encodeURIComponent(branch)}`,
		]);
	});

	it("fails loudly when the branch head cannot be resolved", async () => {
		const { run } = recordingRunner([
			{ match: /repository\/branches\//, reply: "{}" },
		]);
		const client = new GlabGitLabClient(run);

		await expect(
			client.fetchBranchHeadSha("31041", "ci-self-heal/missing"),
		).rejects.toThrow(
			"cannot resolve branch head for ci-self-heal/missing in project 31041",
		);
	});
});

describe("GlabGitLabClient.fetchCiLog", () => {
	const jobsReply = (jobs: ReadonlyArray<Record<string, unknown>>) =>
		JSON.stringify(jobs);

	it("只拉取失败 job 的 trace——成功/跳过 job 不进 agent 上下文（MR !281 提速）", async () => {
		const { calls, run } = recordingRunner([
			{
				match: /pipelines\/42\/jobs$/,
				reply: jobsReply([
					{ id: 1, name: "spotless-format", status: "success", stage: "format" },
					{ id: 2, name: "build-and-test", status: "failed", stage: "build" },
					{ id: 3, name: "quality", status: "skipped", stage: "check" },
				]),
			},
			{ match: /jobs\/2\/trace$/, reply: "FAILED TEST TRACE" },
		]);
		const client = new GlabGitLabClient(run);

		const log = await client.fetchCiLog("31041", 42);

		expect(log).toContain("FAILED TEST TRACE");
		expect(log).toContain("# Job 2 build-and-test [failed]");
		// 只发了一次 trace 请求：成功/跳过 job 的 trace 根本不拉
		expect(calls.filter((c) => c.join(" ").includes("/trace"))).toHaveLength(1);
	});

	it("无失败 job 时降级为全量拼接（避免空日志丢失上下文）", async () => {
		const { run } = recordingRunner([
			{
				match: /pipelines\/42\/jobs$/,
				reply: jobsReply([
					{ id: 1, name: "a", status: "success", stage: "s" },
					{ id: 2, name: "b", status: "success", stage: "s" },
				]),
			},
			{ match: /jobs\/1\/trace$/, reply: "TRACE-A" },
			{ match: /jobs\/2\/trace$/, reply: "TRACE-B" },
		]);
		const client = new GlabGitLabClient(run);

		const log = await client.fetchCiLog("31041", 42);

		expect(log).toContain("TRACE-A");
		expect(log).toContain("TRACE-B");
	});
});

describe("GlabGitLabClient.fetchMrState", () => {
	it("returns merged/closed/open from the MR state field", async () => {
		for (const state of ["merged", "closed", "opened"] as const) {
			const { run } = recordingRunner([
				{
					match: /merge_requests\/17$/,
					reply: JSON.stringify({ iid: 17, state }),
				},
			]);
			const client = new GlabGitLabClient(run);

			const result = await client.fetchMrState("31041", 17);

			expect(result).toBe(state === "opened" ? "open" : state);
		}
	});

	it("returns unknown for an unrecognized state value", async () => {
		const { run } = recordingRunner([
			{
				match: /merge_requests\/17$/,
				reply: JSON.stringify({ iid: 17, state: "locked" }),
			},
		]);
		const client = new GlabGitLabClient(run);

		expect(await client.fetchMrState("31041", 17)).toBe("unknown");
	});
});
