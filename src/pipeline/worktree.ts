/**
 * Worktree manager — shared bare clone + per-pipeline worktree (G2 local clone).
 *
 * Per pipeline:
 *   1. Ensure a project-level shared **bare** clone exists (first time: full
 *      clone; subsequent: incremental fetch). Bare clones share git objects
 *      across worktrees, so N pipelines don't re-clone the repo.
 *   2. `git worktree add` a branch from the pipeline's ref as the agent's
 *      working tree at `<workDir>/repo`. This is the agent's cwd.
 *
 * Concurrency: a per-project lock guards the bare-clone fetch so concurrent
 * pipelines don't race on the same remote (git fetch is not concurrency-safe
 * on a single bare repo without a lock). Worktree creation itself is safe to
 * parallelize (each worktree is a distinct path + branch).
 *
 * Cleanup: worktrees are removed by the worker manager's per-event cwd
 * cleanup. The shared bare clone persists across events (incremental).
 *
 * Sandbox (ticket 06 decision record):
 *   - .m2: v1 uses the host's shared writable .m2 (no read-only mount).
 *     Maven's .m2 is BOTH a read cache AND a write target (downloads +
 *     `mvn install` for multi-module projects write to it). A read-only .m2
 *     breaks `install` and causes spurious verify failures on missing deps.
 *     v1 concurrency=1 (G4) means no .m2 write contention. The agent running
 *     `mvn install`/`mvn test` writes legitimately; cross-pipeline cache reuse
 *     is a natural consequence of the shared host home. Evolution seam:
 *     concurrency>1 or threat model A upgrade → per-project isolated .m2 via
 *     deployment config (user.home override), not bot code.
 *   - Restricted OS user: deployment-level (v1 host restricted user; docker
 *     evolution = non-root container USER). Not asserted in e2e — documented.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logger } from "../util/log.js";
import type { PipelineEvent } from "../types.js";

const exec = promisify(execFile);

/** A bare-clone cache keyed by project id (shared across pipelines). */
interface BareClone {
	/** Absolute path to the bare repo. */
	readonly barePath: string;
	/** Promise of the latest fetch (guards concurrent fetches per project). */
	fetchPromise: Promise<void> | null;
}

const bareClones = new Map<string, BareClone>();
export const bareRoot =
	process.env.CIHEAL_BARE_ROOT ?? join(tmpdir(), "ci-self-heal-bare");

/**
 * Ensure the shared bare clone for a project exists and is up-to-date.
 * Returns the bare repo path. Concurrent calls for the same project share a
 * single fetch (deduped via fetchPromise).
 */
async function ensureBareClone(
	projectId: string,
	projectUrl: string,
): Promise<string> {
	let clone = bareClones.get(projectId);
	const barePath =
		clone?.barePath ?? join(bareRoot, projectId.replace(/[/:]/g, "-"));

	if (!clone) {
		await mkdir(bareRoot, { recursive: true });
		// 复用磁盘上已有的合法 bare clone（跨进程重启 / 手动重跑也能命中），
		// 仅当目录缺失或损坏时才全新 clone；否则残留/不完整的 clone 目录会让
		// 后续每次 clone 都因 "destination already exists" 失败。
		let needClone = !existsSync(barePath);
		if (!needClone && !(await isValidBareRepo(barePath))) {
			await rm(barePath, { recursive: true, force: true });
			needClone = true;
		}
		if (needClone) {
			logger.info({ projectId, barePath }, "bare clone: initial clone");
			await exec("git", ["clone", "--bare", projectUrl, barePath], {
				env: gitEnv(),
			});
		} else {
			logger.info({ projectId, barePath }, "bare clone: reuse existing");
		}
		clone = { barePath, fetchPromise: null };
		bareClones.set(projectId, clone);
	}

	// Incremental fetch, deduped per project (git fetch is not concurrency-safe
	// on a single bare repo without a lock).
	if (!clone.fetchPromise) {
		clone.fetchPromise = (async () => {
			try {
				logger.info({ projectId, barePath }, "bare clone: fetch");
				await exec(
					"git",
					["--git-dir", barePath, "fetch", "--prune", "origin"],
					{
						env: gitEnv(),
					},
				);
			} finally {
				clone!.fetchPromise = null;
			}
		})();
	}
	await clone.fetchPromise;
	return barePath;
}

/**
 * Create a worktree at `<workDir>/repo` checked out from the pipeline's ref.
 *
 * The worktree is the agent's real working tree — agent edits files here,
 * runs tests here, and `git diff` here is authoritative.
 *
 * CIHEAL_WORKTREE_MODE=fake (tests): skip the real clone, `git init` a local
 * repo at <workDir>/repo and seed it with a canned Calculator + failing
 * CalculatorTest so the agent (stub) has a realistic tree to edit.
 *
 * @param workDir  The per-event cwd root (worker isolation dir).
 * @param event    The pipeline event (ref + sha + projectUrl).
 * @returns The absolute path to the worktree (`<workDir>/repo`).
 */
export async function createWorktree(
	workDir: string,
	event: PipelineEvent,
): Promise<string> {
	const mode = process.env.CIHEAL_WORKTREE_MODE ?? "real";
	if (mode === "fake") return fakeWorktree(workDir, event);
	return realWorktree(workDir, event);
}

/** 判断 barePath 是否已是合法的 bare git 仓库（用于复用，避免重复 clone）。 */
async function isValidBareRepo(barePath: string): Promise<boolean> {
	try {
		const { stdout } = await exec(
			"git",
			["--git-dir", barePath, "rev-parse", "--is-bare-repository"],
			{ env: gitEnv() },
		);
		return stdout.trim() === "true";
	} catch {
		return false;
	}
}

async function realWorktree(
	workDir: string,
	event: PipelineEvent,
): Promise<string> {
	const repoPath = join(workDir, "repo");
	const barePath = await ensureBareClone(event.projectId, event.projectUrl);
	const branch = `ci-self-heal/${event.ref}-${event.sha.slice(0, 8)}`;
	logger.info(
		{ projectId: event.projectId, barePath, repoPath, branch, ref: event.ref },
		"worktree: add",
	);
	await exec(
		"git",
		[
			"--git-dir",
			barePath,
			"worktree",
			"add",
			"-b",
			branch,
			repoPath,
			event.sha,
		],
		{ env: gitEnv() },
	);
	return repoPath;
}

/**
 * Fake worktree for e2e tests: `git init` + seed a canned Java repo so the
 * stub agent has a realistic tree to edit + `git diff` against.
 */
async function fakeWorktree(
	workDir: string,
	event: PipelineEvent,
): Promise<string> {
	const repoPath = join(workDir, "repo");
	await mkdir(repoPath, { recursive: true });
	// Init a real git repo so extractPatch's `git add` + `git diff --cached` work.
	await exec("git", ["init", "--quiet"], { cwd: repoPath });
	await exec("git", ["config", "user.email", "ci-self-heal@bot"], {
		cwd: repoPath,
	});
	await exec("git", ["config", "user.name", "ci-self-heal bot"], {
		cwd: repoPath,
	});
	// Seed a canned Calculator (production code) + a failing CalculatorTest.
	await mkdir(join(repoPath, "src/main/java/com/example"), { recursive: true });
	await mkdir(join(repoPath, "src/test/java/com/example"), { recursive: true });
	await writeFileUtf8(
		join(repoPath, "src/main/java/com/example/Calculator.java"),
		"package com.example;\npublic class Calculator { public int add(int a, int b) { return a + b; } }\n",
	);
	await writeFileUtf8(
		join(repoPath, "src/test/java/com/example/CalculatorTest.java"),
		"package com.example;\n// stale test: asserts add(2,3)==4\n",
	);
	await exec("git", ["add", "-A"], { cwd: repoPath });
	await exec(
		"git",
		[
			"commit",
			"--quiet",
			"-m",
			`baseline for ${event.projectId}/${event.pipelineId}`,
		],
		{ cwd: repoPath },
	);
	return repoPath;
}

async function writeFileUtf8(abs: string, content: string): Promise<void> {
	const { writeFile } = await import("node:fs/promises");
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, content, "utf8");
}

/**
 * Remove a worktree (best-effort; worker manager also rm -rf's the workDir).
 */
export async function removeWorktree(workDir: string): Promise<void> {
	const repoPath = join(workDir, "repo");
	// `git worktree remove` needs the bare repo; but the simpler path is to
	// rm -rf the worktree dir (the bare repo's worktree metadata gets stale,
	// pruned on next bare-clone operation). Best-effort.
	await rm(repoPath, { recursive: true, force: true }).catch(() => {});
}

/** Build the git env with the GitLab token for auth (private repos).
 * Injects the token via http.extraHeader (Authorization: Bearer) so the bare
 * clone + fetch authenticate without embedding the token in the remote URL
 * (which would leak into `.git/config`). Ticket 06 hardens with restricted user. */
function gitEnv(): Record<string, string> {
	const token = process.env.GITLAB_TOKEN ?? "";
	const url = process.env.GITLAB_URL ?? "";
	return {
		...process.env,
		GITLAB_HOST: url,
		GIT_TERMINAL_PROMPT: "0",
		// Bearer auth via extraHeader — GitLab accepts personal/acess tokens here.
		...(token
			? { GIT_HTTP_EXTRA_HEADER: `Authorization: Bearer ${token}` }
			: {}),
	};
}

/** Worktree seam — injectable so runRepair is unit-testable without real git. */
export interface Worktree {
	/** Create a worktree at `<workDir>/repo`, returning its absolute path. */
	create(workDir: string, event: PipelineEvent): Promise<string>;
	/** Remove a worktree (best-effort, idempotent). */
	remove(cwd: string): Promise<void>;
}

/** Production worktree impl: real bare-clone + git worktree add/remove. */
export const defaultWorktree: Worktree = {
	create: createWorktree,
	remove: removeWorktree,
};
