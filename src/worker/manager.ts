/**
 * Worker manager — spawns an isolated subprocess per pipeline event (G4).
 *
 * Per-worker isolation:
 *   - cwd: a fresh per-event directory (so worker state never crosses events)
 *   - env: PI_CODING_AGENT_DIR + CIHEAL_* switches per worker
 *   - node entry: src/worker/main.ts (compiled to dist/ in prod, tsx in dev)
 *
 * The spawned worker writes its RepairOutcome JSON to a result file; this
 * manager reads it back. Worker structured logs are written to a per-event
 * file in the audit directory (CIHEAL_WORKER_LOG_DIR) for durable
 * traceability instead of mixing into the bot log.
 *
 * Ticket 01: concurrency is driven by the scheduler (this manager spawns one
 * at a time when called). Ticket 05 lifts concurrency above 1.
 */

import { spawn, execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../util/log.js";
import type { PipelineEvent, RepairOutcome } from "../types.js";
import { bareRoot } from "../pipeline/worktree.js";
import { resolveAuditDir } from "../pipeline/repair-outcome.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface WorkerManager {
	/** Spawn a worker for the given event + cwd, return its outcome. */
	run(event: PipelineEvent, cwd: string): Promise<RepairOutcome>;
}

export interface WorkerSpawnOptions {
	/** Override the node binary (tests use the harness's node). */
	nodeBin?: string;
	/** Override the entry script path (tests use a tsx-launched main). */
	entryScript?: string;
	/** Extra env to pass into the worker. */
	env?: Record<string, string>;
	/** Timeout ms before the worker is killed. */
	timeoutMs?: number;
	/** Keep the per-event cwd after the run (tests inspect sidecars). */
	keepWork?: boolean;
}

/**
 * Subprocess-backed worker manager.
 *
 * In production this runs `node dist/worker/main.js`. In dev/tests it runs
 * `tsx src/worker/main.ts` so the tracer bullet executes real TS without a
 * build step. Both modes pass CIHEAL_WORKER_TASK + CIHEAL_RESULT_FILE via env.
 */
export class SubprocessWorkerManager implements WorkerManager {
	constructor(private readonly opts: WorkerSpawnOptions = {}) {}

	async run(event: PipelineEvent, cwd: string): Promise<RepairOutcome> {
		await mkdir(cwd, { recursive: true });
		const resultFile = join(cwd, "result.json");

		// Per-event worker audit log dir — durable, survives cwd cleanup.
		// Placed inside CIHEAL_AUDIT_DIR (default <botRoot>/.audit) so
		// worker logs are easy to trace alongside audit traces.
		// The directory is named <auditDir>/<pipelineId>/<uuid>-worker-log.
		const auditDir = resolveAuditDir();
		const workerLogDir = join(
			auditDir,
			String(event.pipelineId),
			`${randomUUID()}-worker-log`,
		);
		try {
			await mkdir(workerLogDir, { recursive: true });
		} catch {
			// best-effort — worker will fall back to stdout logging
		}

		const task = { event, cwd };

		const nodeBin = this.opts.nodeBin ?? process.execPath;
		const entryScript = this.opts.entryScript ?? defaultEntryScript();

		const agentDir = join(cwd, ".pi-agent");
		const childEnv: Record<string, string> = {
			...process.env,
			...this.opts.env,
			CIHEAL_WORKER_TASK: JSON.stringify(task),
			CIHEAL_RESULT_FILE: resultFile,
			// Per-worker Pi isolation (G4): distinct dir so shared state can't leak.
			PI_CODING_AGENT_DIR: agentDir,
			// Bot-owned settings and skills must never be inferred from the target worktree.
			CIHEAL_BOT_ROOT:
				this.opts.env?.CIHEAL_BOT_ROOT ?? process.env.CIHEAL_BOT_ROOT ?? "",
			// Worker audit log dir — worker logs write here instead of
			// stdout (so they don't mix into the bot log).
			...(workerLogDir ? { CIHEAL_WORKER_LOG_DIR: workerLogDir } : {}),
			// glab self-managed host: agent runs `glab mr create` inside the
			// worktree and inherits this env. Without GITLAB_HOST, glab
			// defaults to gitlab.com → 401. Mirror realGlabRunner (entry.ts).
			...(process.env.GITLAB_URL
				? { GITLAB_HOST: process.env.GITLAB_URL }
				: {}),
		};

		logger.info(
			{ projectId: event.projectId, pipelineId: event.pipelineId, cwd, workerLogDir },
			"spawning worker",
		);
		if (childEnv.CIHEAL_PI_BASE_DIR) {
			try {
				await initializeWorkerPiConfig(
					childEnv.CIHEAL_PI_BASE_DIR,
					agentDir,
					cwd,
				);
			} catch (error) {
				if (!this.opts.keepWork) {
					await rm(cwd, { recursive: true, force: true }).catch(() => {});
				}
				throw error;
			}
		}



		let stdout = "";
		let stderr = "";
		try {
			const child = await runChild(nodeBin, [entryScript], {
				cwd,
				env: childEnv,
				timeoutMs: this.opts.timeoutMs,
			});
			const { code, signal } = child;
			stdout = child.stdout;
			stderr = child.stderr;

			if (code !== 0) {
				logger.error(
					{ code, signal, stderr: stderr.slice(0, 2000) },
					"worker exited non-zero",
				);
				throw new Error(
					`worker exited code=${code} signal=${signal}: ${stderr.slice(0, 500)}`,
				);
			}

			const raw = await readFile(resultFile, "utf8");
			const result = JSON.parse(raw) as RepairOutcome;
			// 无论 outcome 如何，始终打印 worker stdout（agent 会话输出），
			// 让 agent 的诊断/修复过程对开发者可见。
			if (stdout.trim()) {
				const lines = stdout.trim().split("\n");
				const tail = lines.slice(-20).join("\n");
				logger.info(
					{ projectId: event.projectId, pipelineId: event.pipelineId, outcome: result.kind, stdoutTail: tail },
					"worker stdout (last 20 lines)",
				);
			}
			return result;
		} catch {
			throw new Error(
				`worker produced no result file at ${resultFile}` +
					(stderr ? `; stderr: ${stderr.slice(0, 500)}` : ""),
			);
		} finally {
			// Clean up the per-event cwd so disk doesn't grow. Keep if a test wants
			// to inspect via keepWork.
			if (!this.opts.keepWork) {
				// Clean up the bare repo worktree registration and branch
				// so re-running the same pipeline does not hit "branch already exists".
				//
				// Ordering matters: git holds locks briefly after a worker exits,
				// so `worktree remove` / `prune` can fail silently (swallowed by
				// runGit's warn). `branch -D` then fails because the stale worktree
				// registration still references the branch. `update-ref -d` bypasses
				// that reference check and deletes the ref directly — the reliable
				// last resort that prevents residue across re-runs.
				try {
					const barePath = join(bareRoot, event.projectId.replace(/[/:]/g, "-"));
					const branch = `ci-self-heal/${event.ref}-${event.sha.slice(0, 8)}`;
					const runGit = (args: string[]) =>
						new Promise<void>((resolve) => {
							execFile("git", args, (err) => {
								if (err) logger.warn({ err, args }, "worktree cleanup failed");
								resolve();
							});
						});
					// 1. remove worktree（cwd 仍存在时原子删目录+注册+解除分支引用）。
					//    -f 丢弃未提交改动。必须在 rm(cwd) 之前：cwd 已删时 remove 行为
					//    不稳定（实测自动 cleanup 下残留 prunable 注册）。git 无 forget 子命令。
					await runGit(["--git-dir", barePath, "worktree", "remove", "-f", cwd]);
					// 2. 兜底删目录（remove 已删则幂等）
					await rm(cwd, { recursive: true, force: true }).catch(() => {});
					// 3. prune 清理可能残留的注册
					await runGit(["--git-dir", barePath, "worktree", "prune", "--expire", "now"]);
					// 4. 删分支（若 remove 未解除引用）
					await runGit(["--git-dir", barePath, "branch", "-D", branch]);
					// 5. 兜底：update-ref -d 直接删 ref，绕过 worktree 引用检查。
					//    branch -D 会因 stale worktree 注册拒绝删分支；update-ref 不检查
					//    引用，是防止残留的最后手段（branch 含斜杠，refs/heads/<branch> 合法）。
					await runGit(["--git-dir", barePath, "update-ref", "-d", `refs/heads/${branch}`]);
				} catch {
					// best-effort: bare repo may not exist yet (class-5 early
					// escalation) or git may not be available; never let
					// cleanup fail the run.
				}
			}
		}
	}
}

/**
 * Copy Pi's standard configuration files into an isolated worker runtime.
 * The base directory is deployment-owned; it is never resolved from a target
 * worktree, and the copied files cannot mutate the shared source directory.
 */
async function initializeWorkerPiConfig(
	baseDir: string,
	agentDir: string,
	workerDir: string,
): Promise<void> {
	if (!isAbsolute(baseDir)) {
		throw new Error("CIHEAL_PI_BASE_DIR must be an absolute path");
	}
	const resolvedBaseDir = resolve(baseDir);
	if (isWithin(workerDir, resolvedBaseDir)) {
		throw new Error("CIHEAL_PI_BASE_DIR must not be inside a worker directory");
	}
	let baseStats: Stats;
	try {
		baseStats = await stat(resolvedBaseDir);
	} catch (error) {
		throw new Error("CIHEAL_PI_BASE_DIR does not exist", { cause: error });
	}
	if (!baseStats.isDirectory()) {
		throw new Error("CIHEAL_PI_BASE_DIR must be a directory");
	}

	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	let copied = 0;
	for (const name of ["auth.json", "models.json"] as const) {
		try {
			await copyFile(join(resolvedBaseDir, name), join(agentDir, name));
			await chmod(join(agentDir, name), 0o600);
			copied++;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (copied === 0) {
		throw new Error("CIHEAL_PI_BASE_DIR must contain auth.json or models.json");
	}
}

function isWithin(parent: string, candidate: string): boolean {
	const path = relative(resolve(parent), candidate);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function defaultEntryScript(): string {
	// Dev: run TS directly via tsx (resolved relative to this compiled file).
	// The tracer bullet runs under tsx; production builds dist/ first.
	return join(__dirname, "..", "worker", "main.ts");
}

interface ChildResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

function runChild(
	cmd: string,
	args: string[],
	opts: { cwd: string; env: Record<string, string>; timeoutMs?: number },
): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		// Use tsx to run TS when the entry ends in .ts; otherwise plain node.
		const isTs = args[0]?.endsWith(".ts");
		// For TS entries, use the repo's tsx binary directly so ESM resolution
		// for the worker's TS imports finds the repo's node_modules (the worker's
		// task.cwd is a temp dir with no node_modules). The worker's OWN file
		// operations still target task.cwd (passed via env), preserving G4
		// state isolation.
		const repoRoot = process.cwd();
		let realCmd: string;
		let realArgs: string[];
		let childCwd: string;
		if (isTs) {
			const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
			realCmd = tsxBin;
			realArgs = args;
			childCwd = repoRoot;
		} else {
			realCmd = cmd;
			realArgs = args;
			childCwd = opts.cwd;
		}
		const child = spawn(realCmd, realArgs, {
			cwd: childCwd,
			env: opts.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		const timer = opts.timeoutMs
			? setTimeout(() => {
					child.kill("SIGTERM");
				}, opts.timeoutMs)
			: null;
		child.on("error", (err) => {
			timer && clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code, signal) => {
			timer && clearTimeout(timer);
			resolve({ code, signal, stdout, stderr });
		});
	});
}
