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
 *     v1 shipped concurrency=1 (G4), hence no .m2 write contention. In 2026-08
 *     concurrency was raised to 2 with an explicit decision to KEEP the shared
 *     writable .m2 (cache-reuse benefit outweighs the low write-contention risk).
 *     The agent running `mvn install`/`mvn test` writes legitimately;
 *     cross-pipeline cache reuse is a natural consequence of the shared host
 *     home. Evolution seam: observed contention or threat model A upgrade →
 *     per-project isolated .m2 via deployment config (user.home override), not
 *     bot code.
 *   - Restricted OS user: deployment-level (v1 host restricted user; docker
 *     evolution = non-root container USER). Not asserted in e2e — documented.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, rm, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { logger } from "../util/log.js";
import { resolveBareRoot, resolveDataRoot } from "../config/paths.js";
import { resolveRetentionPolicy } from "../config/retention.js";
import type { PipelineEvent } from "../types.js";
import { repairBranchName } from "./repair-branch.js";

const exec = promisify(execFile);

/**
 * Fetch refspec for the shared bare clone: all branch heads. `git clone
 * --bare` does NOT write a fetch refspec (only remote.origin.url), and
 * without one `git fetch origin` fetches only the remote HEAD — branch tips
 * never update (see ensureBareClone).
 */
const HEADS_REFSPEC = "+refs/heads/*:refs/heads/*";

/**
 * The bot's own repair-branch prefix (single source of truth: also used by
 * the webhook receiver to ignore pipelines triggered by the bot's own MRs).
 */
export const REPAIR_BRANCH_PREFIX = "ci-self-heal/";

/**
 * Negative refspec: never map the bot's own repair branches back into the
 * shared bare. The agent pushes `ci-self-heal/*` to origin; re-importing
 * them collides with the fresh worktree branch of a redelivery (MR !281
 * pipeline 100033426 incident). Requires git >= 2.29.
 */
const EXCLUDE_REPAIR_REFSPEC = `^refs/heads/${REPAIR_BRANCH_PREFIX}*`;

/** A bare-clone cache keyed by project id (shared across pipelines). */
interface BareClone {
	/** Absolute path to the bare repo. */
	readonly barePath: string;
	/** Promise of the latest fetch (guards concurrent fetches per project). */
	fetchPromise: Promise<void> | null;
}

const bareClones = new Map<string, BareClone>();

/** 项目级异步锁：同项目多 MR 并发修复时，共享 bare 上的 git 操作
 *  （初始 clone / refspec 配置 / fetch / worktree add）不得竞态。
 *  Promise-chain mutex：只锁秒级 git 操作，agent 运行（分钟级）完全并行；
 *  持锁者失败不死锁队列。 */
const projectLocks = new Map<string, Promise<void>>();

export async function withProjectLock<T>(
	projectId: string,
	fn: () => Promise<T>,
): Promise<T> {
	const prev = projectLocks.get(projectId) ?? Promise.resolve();
	const result = prev.catch(() => {}).then(fn);
	projectLocks.set(projectId, result.then(() => undefined, () => undefined));
	return result;
}

/**
 * Resolve the shared bare-clone cache root, derived from CIHEAL_DATA_ROOT.
 * Kept as a function (not a const) so it reads env lazily — the module is
 * imported by the main process before .env is loaded.
 */
export function bareRoot(): string {
	return resolveBareRoot();
}

/**
 * Passive bare-cache cleanup, run opportunistically inside ensureBareClone:
 * evict clones whose last write is older than retention.bare.maxAgeDays, and
 * cap the total entry count at retention.bare.maxEntries (LRU by mtime).
 * Best-effort — never throws into the clone path.
 */
async function pruneBareCache(): Promise<void> {
	try {
		const root = bareRoot();
		const { maxAgeDays, maxEntries } = resolveRetentionPolicy().bare;
		const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		let entries = await readdir(root, { withFileTypes: true });
		entries = entries.filter(
			(e) => e.isDirectory() && !e.name.startsWith("."),
		);
		// Pass 1: drop anything older than maxAgeDays.
		for (const e of entries) {
			try {
				const s = await stat(join(root, e.name));
				if (s.mtimeMs < cutoff)
					await rm(join(root, e.name), { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
		// Pass 2: if still over maxEntries, evict oldest by mtime (LRU).
		if (maxEntries > 0) {
			entries = (await readdir(root, { withFileTypes: true })).filter(
				(e) => e.isDirectory() && !e.name.startsWith("."),
			);
			if (entries.length > maxEntries) {
				const withMtime = await Promise.all(
					entries.map(async (e) => {
						try {
							return {
								name: e.name,
								mtimeMs: (await stat(join(root, e.name))).mtimeMs,
							};
						} catch {
							return { name: e.name, mtimeMs: Number.MAX_SAFE_INTEGER };
						}
					}),
				);
				withMtime.sort((a, b) => a.mtimeMs - b.mtimeMs);
				const evict = withMtime.slice(0, withMtime.length - maxEntries);
				for (const { name } of evict) {
					await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
				}
			}
		}
	} catch {
		// retention policy unreadable or dir missing — skip cleanup this pass.
	}
}

/**
 * Configure the bare clone's fetch refspec idempotently: map all branch
 * heads, excluding the bot's own ci-self-heal/* repair branches. Heals
 * clones created before the refspec existed (`git clone --bare` writes no
 * fetch refspec at all).
 */
async function ensureFetchRefspec(barePath: string): Promise<void> {
	await exec(
		"git",
		["--git-dir", barePath, "config", "--unset-all", "remote.origin.fetch"],
		{ env: gitEnv() },
	).catch(() => {});
	await exec(
		"git",
		[
			"--git-dir",
			barePath,
			"config",
			"--add",
			"remote.origin.fetch",
			HEADS_REFSPEC,
		],
		{ env: gitEnv() },
	);
	await exec(
		"git",
		[
			"--git-dir",
			barePath,
			"config",
			"--add",
			"remote.origin.fetch",
			EXCLUDE_REPAIR_REFSPEC,
		],
		{ env: gitEnv() },
	);
}

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
		clone?.barePath ?? join(bareRoot(), projectId.replace(/[/:]/g, "-"));

	if (!clone) {
		await mkdir(bareRoot(), { recursive: true });
		// Passive cleanup: evict expired / over-capacity clones opportunistically.
		await pruneBareCache();
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
				// `git clone --bare` writes remote.origin.url but NO fetch refspec,
				// so a bare `fetch origin` only fetches the remote HEAD — branch
				// tips never update and newer pipeline shas fail "invalid
				// reference" (MR !281 pipeline 100033426). Ensure the heads
				// refspec on every pass: heals pre-fix clones, idempotent
				// otherwise.
				await ensureFetchRefspec(barePath);
				logger.info({ projectId, barePath }, "bare clone: fetch");
				// No --prune: with the heads refspec it would delete local
				// ci-self-heal/* branches that live worktrees still use.
				await exec("git", ["--git-dir", barePath, "fetch", "origin"], {
					env: gitEnv(),
				});
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
	// 项目锁：并发 MR 的 bare clone/worktree 管道串行，agent 运行不受影响
	return withProjectLock(event.projectId, () => realWorktree(workDir, event));
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
	await ensureShaPresent(barePath, event);
	const branch = repairBranchName(event);
	// Self-heal residue from a crashed/uncleaned prior run:
	// - LIVE worktree still checked out on the branch (deploy restart / OOM
	//   killed the worker mid-repair): prune keeps live dirs, branch -D refuses
	//   checked-out branches → removeWorktreesOnBranch force-removes the holder.
	// - stale metadata of a deleted dir shields the branch from deletion, and
	//   `worktree add -b` dies on "a branch named ... already exists".
	await exec("git", ["--git-dir", barePath, "worktree", "prune"], {
		env: gitEnv(),
	}).catch(() => {});
	await removeWorktreesOnBranch(barePath, branch);
	await exec("git", ["--git-dir", barePath, "branch", "-D", branch], {
		env: gitEnv(),
	}).catch(() => {});
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
 * Force-remove LIVE worktrees checked out on `branch` — residue of a killed
 * run (deploy restart / crash / OOM). `worktree prune` only reaps entries
 * whose directory is gone and `branch -D` refuses a checked-out branch, so
 * without this the converged repair branch (ci-self-heal/<sourceBranch>,
 * ADR-0011) stays blocked by a single leftover worktree forever. Safe under
 * the scheduler's per-MR serialization: when a new run creates this branch,
 * no other live run may legitimately hold it (dev incident: pipelines
 * 100034231/100034233).
 */
async function removeWorktreesOnBranch(
	barePath: string,
	branch: string,
): Promise<void> {
	const { stdout } = await exec(
		"git",
		["--git-dir", barePath, "worktree", "list", "--porcelain"],
		{ env: gitEnv() },
	).catch((): { stdout: string; stderr: string } => ({ stdout: "", stderr: "" }));
	const target = `refs/heads/${branch}`;
	const holders: string[] = [];
	let path: string | undefined;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			path = line.slice("worktree ".length).trim();
		} else if (
			path !== undefined &&
			line.startsWith("branch ") &&
			line.slice("branch ".length).trim() === target
		) {
			holders.push(path);
			path = undefined;
		}
	}
	for (const holder of holders) {
		await exec(
			"git",
			["--git-dir", barePath, "worktree", "remove", "--force", holder],
			{ env: gitEnv() },
		).catch((err) => {
			logger.warn({ err, holder, branch }, "stale live worktree removal failed");
		});
	}
}

/**
 * Ensure the pipeline's sha exists in the bare clone before the worktree is
 * created. The heads-refspec fetch covers the normal case (sha reachable
 * from a branch). If the sha is unreachable from any branch (force-push /
 * rebase after the pipeline ran), fall back to the MR's head ref, which
 * GitLab keeps at the pipeline's sha until the MR's next push. Fail loud if
 * still missing — a worktree cannot be created at a nonexistent commit.
 */
async function ensureShaPresent(
	barePath: string,
	event: PipelineEvent,
): Promise<void> {
	if (await shaPresent(barePath, event.sha)) return;
	if (event.mrIid != null) {
		logger.info(
			{ projectId: event.projectId, sha: event.sha, mrIid: event.mrIid },
			"worktree: sha missing after fetch, fetching MR head ref",
		);
		await exec(
			"git",
			[
				"--git-dir",
				barePath,
				"fetch",
				"origin",
				`refs/merge-requests/${event.mrIid}/head`,
			],
			{ env: gitEnv() },
		);
		if (await shaPresent(barePath, event.sha)) return;
	}
	throw new Error(
		`pipeline sha ${event.sha} not found in bare clone` +
			(event.mrIid == null
				? " (no MR ref fallback for non-MR pipelines)"
				: ` (fetched MR ${event.mrIid} head ref but sha still absent — MR head moved on)`),
	);
}

async function shaPresent(barePath: string, sha: string): Promise<boolean> {
	try {
		await exec(
			"git",
			["--git-dir", barePath, "cat-file", "-e", `${sha}^{commit}`],
			{ env: gitEnv() },
		);
		return true;
	} catch {
		return false;
	}
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
	// The webhook pipeline sha (event.sha) does not exist in this canned repo,
	// yet the worker's extractPatch runs `git diff <sha>`. Seed a tag named after
	// the sha so the diff resolves against the baseline commit. Test-only
	// (CIHEAL_WORKTREE_MODE=fake); real worktrees carry the actual failed sha.
	if (/^[A-Za-z0-9._-]+$/.test(event.sha)) {
		await exec("git", ["tag", event.sha, "HEAD"], { cwd: repoPath });
	}
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
/**
 * GIT_ASKPASS helper: answers GitLab's basic-auth prompts with the standard
 * `oauth2` user and the PAT from the process env. The token never lands in
 * the script file nor in the remote URL, so it cannot leak into `.git/config`.
 * 
 * Why askpass instead of Bearer extraHeader: the target GitLab instance
 * rejects `Authorization: Bearer <PAT>` (the host dev env smuggled around it
 * via the macOS keychain, so it never surfaced), while the docker image has
 * no keychain at all — clone/fetch died on "could not read Username".
 */
const ASKPASS_SCRIPT = [
	"#!/bin/sh",
	'case "$1" in',
	'  *[Uu]sername*) echo "oauth2" ;;',
	'  *[Pp]assword*) echo "$GITLAB_TOKEN" ;;',
	"  *) exit 1 ;;",
	"esac",
	"",
].join("\n");

/** Ensure the askpass helper exists under the data root; returns its path. */
function ensureAskPassScript(): string {
	const script = join(resolveDataRoot(), ".home", "git-askpass.sh");
	mkdirSync(dirname(script), { recursive: true });
	writeFileSync(script, ASKPASS_SCRIPT, { encoding: "utf8", mode: 0o700 });
	return script;
}

/** Build the git env with the GitLab token for auth (private repos).
 * Provides `oauth2:<token>` basic auth via GIT_ASKPASS (GitLab's accepted
 * git-over-http scheme); Bearer extraHeader is rejected by this instance and
 * was previously papered over by the host keychain.
 * Ticket 06 hardens with restricted user. */
export function gitEnv(): Record<string, string> {
	const token = process.env.GITLAB_TOKEN ?? "";
	const url = process.env.GITLAB_URL ?? "";
	return {
		...process.env,
		GITLAB_HOST: url,
		GIT_TERMINAL_PROMPT: "0",
		// oauth2:<token> basic auth via askpass — works in docker (no keychain)
		// and on the host alike. Token stays in env, never in the script file.
		...(token ? { GIT_ASKPASS: ensureAskPassScript() } : {}),
	};
}

/** Worktree seam — injectable so runRepair is unit-testable without real git. */
export interface Worktree {
	/** Create a worktree at `<workDir>/repo`, returning its absolute path. */
	create(workDir: string, event: PipelineEvent): Promise<string>;
	/** Remove a worktree (best-effort, idempotent). */
	remove(cwd: string): Promise<void>;
	/** Push repair branch to origin (force push, bot-owned branch). */
	pushBranch(repoCwd: string, branch: string): Promise<void>;
}

/** Spill files the bot writes into the worktree (CI log / MR diff / diff
 *  index / 预解析违规清单)——永远不得进入修复 patch 或推送的修复分支。 */
const SPILL_RE =
	/(^|\/)(ci-log.*\.txt|mr-diff\.patch|mr-diff-index\.txt|violations\.json)$/;

/** 构建工具状态（Maven 本地仓库）：agent 在 worktree 内跑 mvn 可能写出
 *  仓库内 .m2（MR !281 e2e：.lastUpdated 混入 patch 触发 G3 误杀）。
 *  构建态永远不是修复产物。 */
const BUILD_NOISE_RE = /(^|\/)\.m2\//;

/** patch 提取与修复分支推送共同排除的非修复噪声。 */
export function isPatchNoise(path: string): boolean {
	return SPILL_RE.test(path) || BUILD_NOISE_RE.test(path);
}

/**
 * Commit staged/unstaged agent edits (if any) and force-push the repair
 * branch to origin. GitLab MR diff updates automatically on push.
 *
 * Bot noise（spill 文件 / .m2）先从索引剔除，使推送的 commit 与通过 G3
 * 校验的 patch 完全一致（MR !442：extractPatch 只清洗记录用 patch，
 * 未清洗 commit，spill 文件漏进 MR）。
 */
export async function pushRepairBranch(
	repoCwd: string,
	branch: string,
): Promise<void> {
	if (process.env.CIHEAL_WORKTREE_MODE === "fake") return;
	const { stdout } = await exec("git", ["status", "--porcelain"], {
		cwd: repoCwd,
	});
	if (stdout.trim()) {
		await exec("git", ["add", "-A"], { cwd: repoCwd, env: gitEnv() });
		// extractPatch 的 `git add -A`（或 agent）可能已暂存 bot 噪声；
		// 提交前移出索引，保证 commit == 校验过的 patch。
		const { stdout: stagedOut } = await exec(
			"git",
			["diff", "--cached", "--name-only"],
			{ cwd: repoCwd, env: gitEnv() },
		);
		const noise = stagedOut
			.split("\n")
			.map((s) => s.trim())
			.filter((s) => s.length > 0 && isPatchNoise(s));
		if (noise.length > 0) {
			await exec(
				"git",
				["rm", "--cached", "-r", "--ignore-unmatch", "--", ...noise],
				{ cwd: repoCwd, env: gitEnv() },
			);
		}
		// 只剩噪声 → 不产生空修复 commit（--quiet 有 diff 时退 1）。
		let hasStaged = true;
		try {
			await exec("git", ["diff", "--cached", "--quiet"], {
				cwd: repoCwd,
				env: gitEnv(),
			});
			hasStaged = false;
		} catch {
			hasStaged = true;
		}
		if (hasStaged) {
			await exec(
				"git",
				["commit", "-m", "ci-self-heal: apply fix"],
				{ cwd: repoCwd, env: gitEnv() },
			);
		}
	}
	await exec(
		"git",
		["push", "--force", "origin", `HEAD:refs/heads/${branch}`],
		{ cwd: repoCwd, env: gitEnv() },
	);
}

/** Production worktree impl: real bare-clone + git worktree add/remove/push. */
export const defaultWorktree: Worktree = {
	create: createWorktree,
	remove: removeWorktree,
	pushBranch: pushRepairBranch,
};
