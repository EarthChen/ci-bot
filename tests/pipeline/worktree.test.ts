import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createWorktree, withProjectLock, pushRepairBranch } from "../../src/pipeline/worktree.js";
import type { PipelineEvent } from "../../src/types.js";

const exec = promisify(execFile);

/**
 * Real-git integration tests for the bare-clone + worktree path.
 *
 * Regression background (MR !281 pipeline 100033426): `git clone --bare`
 * does NOT write a remote.origin.fetch refspec, so the incremental
 * `git fetch origin` fetched only the default HEAD and never updated branch
 * tips — a pipeline whose sha landed after the initial clone failed with
 * "invalid reference". These tests run against a local file:// remote.
 */

let root: string;
/** Unique per test: the worktree module caches bare clones per projectId
 *  in-process, so tests must not share project ids. */
let projectId: string;
let savedEnv: Record<string, string | undefined>;

/** A local "remote" repo (non-bare) standing in for GitLab. */
interface RemoteRepo {
	readonly path: string;
	commit(branch: string, message: string): Promise<string>;
	orphanMove(branch: string, message: string): Promise<string>;
	setMrHead(mrIid: number, sha: string): Promise<void>;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await exec("git", args, { cwd });
	return stdout.trim();
}

async function initRemote(): Promise<RemoteRepo> {
	const path = join(root, "remote-src");
	await exec("git", ["init", "--quiet", "-b", "master", path]);
	await git(path, "config", "user.email", "test@ci-bot");
	await git(path, "config", "user.name", "ci-bot test");
	let counter = 0;
	const seedFile = async (tag: string): Promise<void> => {
		counter += 1;
		await writeFile(join(path, `f-${counter}.txt`), `${tag}-${Date.now()}-${Math.random()}\n`);
	};
	// HEAD stays pinned to master: the bare clone's default HEAD must NOT be
	// the branch under test (mirrors GitLab, where the default branch differs
	// from MR source branches). Otherwise a refspec-less `fetch origin`
	// (HEAD-only) would drag the test branch's objects in and mask the bug.
	const pinHeadToMaster = async (): Promise<void> => {
		await git(path, "symbolic-ref", "HEAD", "refs/heads/master");
	};
	await seedFile("master-init");
	await git(path, "add", "-A");
	await git(path, "commit", "--quiet", "-m", "master-init");
	return {
		path,
		async commit(branch, message) {
			await git(path, "checkout", "--quiet", "-B", branch);
			await seedFile(message);
			await git(path, "add", "-A");
			await git(path, "commit", "--quiet", "-m", message);
			await pinHeadToMaster();
			return git(path, "rev-parse", branch);
		},
		async orphanMove(branch, message) {
			// Commit with NO parents, then point the branch at it — the old
			// tip becomes unreachable from any branch head.
			await git(path, "checkout", "--quiet", "--orphan", `${branch}-orphan`);
			await seedFile(message);
			await git(path, "add", "-A");
			await git(path, "commit", "--quiet", "-m", message);
			await git(path, "branch", "-f", branch, "HEAD");
			await git(path, "checkout", "--quiet", branch);
			await pinHeadToMaster();
			return git(path, "rev-parse", branch);
		},
		async setMrHead(mrIid, sha) {
			await git(path, "update-ref", `refs/merge-requests/${mrIid}/head`, sha);
		},
	};
}

function event(sha: string, ref: string, projectUrl: string, mrIid?: number): PipelineEvent {
	return {
		projectId,
		pipelineId: 1,
		ref,
		sha,
		projectUrl,
		...(mrIid == null ? {} : { mrIid }),
	};
}

describe("createWorktree (real git, local file:// remote)", () => {
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "worktree-real-"));
		projectId = `proj-${basename(root)}`;
		savedEnv = {
			CIHEAL_DATA_ROOT: process.env.CIHEAL_DATA_ROOT,
			CIHEAL_WORKTREE_MODE: process.env.CIHEAL_WORKTREE_MODE,
		};
		process.env.CIHEAL_DATA_ROOT = join(root, "data");
		process.env.CIHEAL_WORKTREE_MODE = "real";
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(savedEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("initial clone + worktree at the pipeline sha", async () => {
		const remote = await initRemote();
		const sha = await remote.commit("dev", "first");
		const repoPath = await createWorktree(join(root, "w1"), event(sha, "dev", remote.path));
		expect(await git(repoPath, "rev-parse", "HEAD")).toBe(sha);
	});

	it("branch advances after the initial clone → incremental fetch picks up the new sha", async () => {
		const remote = await initRemote();
		const sha1 = await remote.commit("dev", "first");
		await createWorktree(join(root, "w1"), event(sha1, "dev", remote.path));

		// The developer pushes again; the next pipeline's sha only exists on
		// the updated branch tip. Without a fetch refspec this fails with
		// "invalid reference" (the MR !281 incident).
		const sha2 = await remote.commit("dev", "second");
		const repoPath = await createWorktree(join(root, "w2"), event(sha2, "dev", remote.path));
		expect(await git(repoPath, "rev-parse", "HEAD")).toBe(sha2);
	});

	it("pipeline sha unreachable from any branch → falls back to the MR head ref", async () => {
		const remote = await initRemote();
		const sha1 = await remote.commit("dev", "first");
		await remote.setMrHead(7, sha1);
		await createWorktree(join(root, "w1"), event(sha1, "dev", remote.path, 7));

		// Force-move the branch so sha1 is no longer reachable from heads
		// (e.g. rebase/amend after the pipeline ran); the MR head ref still
		// points at the pipeline sha.
		const sha2 = await remote.orphanMove("dev", "diverged");
		expect(sha2).not.toBe(sha1);
		// Simulate the worker's post-event branch cleanup so w2's worktree add
		// at the same sha doesn't collide on the ci-self-heal branch name.
		const bare = join(root, "data", "bare", projectId);
		await git(bare, "worktree", "remove", "--force", join(root, "w1", "repo"));
		await git(bare, "branch", "-D", `ci-self-heal/dev-${sha1.slice(0, 8)}`);
		const repoPath = await createWorktree(join(root, "w2"), event(sha1, "dev", remote.path, 7));
		expect(await git(repoPath, "rev-parse", "HEAD")).toBe(sha1);
	});

	it("sha missing with no MR fallback → fails loud with a clear error", async () => {
		const remote = await initRemote();
		const sha1 = await remote.commit("dev", "first");
		await createWorktree(join(root, "w1"), event(sha1, "dev", remote.path));

		await expect(
			createWorktree(join(root, "w2"), event("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "dev", remote.path)),
		).rejects.toThrow(/deadbeef/);
	});

	it("self-heals leftover branch + stale worktree metadata from an uncleaned prior run", async () => {
		// Production incident (MR !281 redelivery): a crashed run's cleanup
		// aborted halfway, leaving the ci-self-heal branch + stale worktree
		// metadata behind; the next worktree add at the same sha died with
		// "a branch named ... already exists".
		const remote = await initRemote();
		const sha = await remote.commit("dev", "first");
		await createWorktree(join(root, "w1"), event(sha, "dev", remote.path));
		// Simulate the unclean end: worktree dir gone, metadata + branch left.
		rmSync(join(root, "w1"), { recursive: true, force: true });
		const repoPath = await createWorktree(join(root, "w2"), event(sha, "dev", remote.path));
		expect(await git(repoPath, "rev-parse", "HEAD")).toBe(sha);
	});

	it("self-heals a LIVE leftover worktree holding the converged MR branch (killed run)", async () => {
		// Production incident (dev pipelines 100034231/100034233): a deploy
		// restart killed a mid-repair worker, leaving a LIVE worktree checked
		// out on the converged branch ci-self-heal/<sourceBranch>. prune does
		// not touch live dirs and branch -D refuses a checked-out branch, so
		// every later pipeline of the same MR died at `worktree add -b`.
		const remote = await initRemote();
		const sha1 = await remote.commit("dev", "first");
		await createWorktree(join(root, "w1"), {
			...event(sha1, "dev", remote.path, 9),
			mrSourceBranch: "dev",
		});

		// Hard-kill simulation: nothing cleaned — dir, metadata and branch all
		// remain. The next pipeline of the same MR (new sha) must self-heal.
		const sha2 = await remote.commit("dev", "second");
		const repoPath = await createWorktree(join(root, "w2"), {
			...event(sha2, "dev", remote.path, 9),
			mrSourceBranch: "dev",
		});

		expect(await git(repoPath, "rev-parse", "HEAD")).toBe(sha2);
		expect(existsSync(join(root, "w1", "repo"))).toBe(false);
	});

	it("agent 推到远端的 ci-self-heal/* 分支不会被 fetch 重新导入", async () => {
		const remote = await initRemote();
		const sha1 = await remote.commit("dev", "first");
		await createWorktree(join(root, "w1"), event(sha1, "dev", remote.path));
		// agent 把修复分支 push 到 origin 后，后续事件的 fetch 不得把它映射回
		// 共享 bare——否则与新建 worktree 的同名分支冲突（MR !281 重投事故）。
		const sha2 = await remote.commit("dev", "second");
		await git(remote.path, "update-ref", `refs/heads/ci-self-heal/dev-${sha2.slice(0, 8)}`, sha1);
		const repoPath = await createWorktree(join(root, "w2"), event(sha2, "dev", remote.path));
		expect(await git(repoPath, "rev-parse", "HEAD")).toBe(sha2);
	});
});

describe("withProjectLock — 同项目 bare clone 操作串行化（多 MR 并发防竞态）", () => {
	it("同 key 并发调用不重叠", async () => {
		let live = 0;
		let maxLive = 0;
		const task = () =>
			withProjectLock("p1", async () => {
				live++;
				maxLive = Math.max(maxLive, live);
				await new Promise((r) => setTimeout(r, 10));
				live--;
			});
		await Promise.all([task(), task(), task()]);
		expect(maxLive).toBe(1);
	});

	it("不同 key 可重叠", async () => {
		let live = 0;
		let maxLive = 0;
		const task = (key: string) =>
			withProjectLock(key, async () => {
				live++;
				maxLive = Math.max(maxLive, live);
				await new Promise((r) => setTimeout(r, 10));
				live--;
			});
		await Promise.all([task("p1"), task("p2")]);
		expect(maxLive).toBe(2);
	});

	it("前一个失败不死锁后续调用", async () => {
		const first = withProjectLock("p1", async () => {
			throw new Error("git exploded");
		});
		await expect(first).rejects.toThrow("git exploded");
		await expect(withProjectLock("p1", async () => 42)).resolves.toBe(42);
	});
});

/**
 * MR !442（pipeline 100034275）：bot 的 spill 文件（ci-log.txt /
 * mr-diff.patch / mr-diff-index.txt）混进了修复 MR。extractPatch 的
 * isPatchNoise 只清洗「记录用」patch，pushRepairBranch 却把整个索引
 * （含 extractPatch `git add -A` 暂存的噪声）提交并推送——校验面与
 * 提交面脱节。不变量：推送的 commit 只含修复产物。
 */
describe("pushRepairBranch — bot 噪声不入修复分支（MR !442）", () => {
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "worktree-noise-"));
		projectId = `proj-${basename(root)}`;
		savedEnv = {
			CIHEAL_DATA_ROOT: process.env.CIHEAL_DATA_ROOT,
			CIHEAL_WORKTREE_MODE: process.env.CIHEAL_WORKTREE_MODE,
		};
		process.env.CIHEAL_DATA_ROOT = join(root, "data");
		process.env.CIHEAL_WORKTREE_MODE = "real";
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(savedEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(root, { recursive: true, force: true });
	});

	async function seedWorktree(branch: string): Promise<string> {
		const remote = await initRemote();
		const sha = await remote.commit(branch, "base");
		const repoCwd = await createWorktree(join(root, "w1"), event(sha, branch, remote.path));
		// Repo-local identity：不依赖环境全局 gitconfig（CI runner 没有，
		// MR !442 测试曾在 CI 因 empty ident 失败）。生产由 Dockerfile
		// system-level config 提供。
		await git(repoCwd, "config", "user.email", "ci-self-heal@bot");
		await git(repoCwd, "config", "user.name", "ci-self-heal bot");
		return repoCwd;
	}

	it("commit 只含修复改动：spill/violations/.m2 一律不进分支", async () => {
		const repoCwd = await seedWorktree("feature/noise");
		// agent 的合法修复
		await writeFile(join(repoCwd, "Fix.java"), "// fix\n");
		// bot 写入 repoCwd 的 spill 文件 + 构建噪声
		await writeFile(join(repoCwd, "ci-log.txt"), "log");
		await writeFile(join(repoCwd, "ci-log-retry.txt"), "log");
		await writeFile(join(repoCwd, "mr-diff.patch"), "diff");
		await writeFile(join(repoCwd, "mr-diff-index.txt"), "idx");
		await writeFile(join(repoCwd, "violations.json"), "[]");
		await mkdir(join(repoCwd, ".m2", "repository"), { recursive: true });
		await writeFile(join(repoCwd, ".m2", "repository", "x.lastUpdated"), "");
		// extractPatch 的 `git add -A` 已把一切暂存
		await git(repoCwd, "add", "-A");

		await pushRepairBranch(repoCwd, "ci-self-heal/feature/noise");

		const committed = (
			await git(repoCwd, "show", "--name-only", "--format=", "HEAD")
		).split("\n").filter(Boolean);
		expect(committed).toEqual(["Fix.java"]);
	});

	it("只剩噪声 → 不产生空修复 commit", async () => {
		const repoCwd = await seedWorktree("feature/noise-only");
		await writeFile(join(repoCwd, "ci-log.txt"), "log");
		await writeFile(join(repoCwd, "mr-diff.patch"), "diff");
		await git(repoCwd, "add", "-A");
		const before = await git(repoCwd, "rev-parse", "HEAD");

		await pushRepairBranch(repoCwd, "ci-self-heal/feature/noise-only");

		expect(await git(repoCwd, "rev-parse", "HEAD")).toBe(before);
	});
});
