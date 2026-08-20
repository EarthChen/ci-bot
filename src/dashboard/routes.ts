import fastifyStatic from "@fastify/static";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DecisionRecord, DecisionStatus } from "../decision/store.js";
import type { MetricsAggregator } from "./metrics-aggregator.js";
import type { EventHub } from "./event-hub.js";
import { MemoryRateLimiter } from "./rate-limit.js";
import { readSessionActivityTail, readWorkerLogTail } from "./log-tail.js";
import { resolveAuditDir } from "../config/paths.js";
import type {
	ApiStatusResponse,
	DecisionSummary,
	MetricsApiResponse,
	QueueDetail,
	SchedulerStats,
	WorkerLogsResponse,
} from "./shared-types.js";

export type {
	ApiStatusResponse,
	DecisionSummary,
	MetricsApiResponse,
	QueueDetail,
	SchedulerStats,
	WorkerLogsResponse,
} from "./shared-types.js";

export interface DecisionStoreReader {
	listByStatus(status: DecisionStatus): DecisionRecord[];
	listAll(): DecisionRecord[];
}

export interface DashboardDeps {
	scheduler: { stats(): SchedulerStats; queueDetails(): QueueDetail[] };
	decisionStore: DecisionStoreReader;
	metricsAggregator?: MetricsAggregator;
	eventHub?: EventHub;
	version: string;
}

export function sanitizeDecision(r: DecisionRecord): DecisionSummary {
	return {
		decision_id: r.decision_id,
		pipeline_id: r.pipeline_id,
		project_id: r.project_id,
		branch: r.branch,
		status: r.status,
		created_at: r.created_at,
		expires_at: r.expires_at,
		decided_by: r.decided_by,
		decision_value: r.decision_value,
		remark: r.remark,
		oos_paths: r.oos_paths,
		decided_at: r.decided_at,
	};
}

const DASHBOARD_RATE_LIMIT = { max: 60, windowMs: 60_000 } as const;

export async function mountDashboardApi(
	app: FastifyInstance,
	deps: DashboardDeps,
): Promise<void> {
	const limiter = new MemoryRateLimiter(DASHBOARD_RATE_LIMIT);
	const rateLimit: (req: FastifyRequest, reply: FastifyReply) => Promise<void> = async (
		req,
		reply,
	) => {
		if (!limiter.check(req.ip)) {
			await reply.code(429).send({ error: "Too Many Requests" });
		}
	};

	await app.register(async (dashboardApp) => {
		dashboardApp.get("/api/status", { preHandler: rateLimit }, async (_req, reply) => {
			const mem = process.memoryUsage();
			const body: ApiStatusResponse = {
				health: {
					uptimeSeconds: Math.floor(process.uptime()),
					memoryMB: Math.round(mem.rss / 1_048_576),
					version: deps.version,
					nodeVersion: process.version,
				},
				scheduler: deps.scheduler.stats(),
				queue: deps.scheduler.queueDetails(),
			};
			return reply.send(body);
		});

		const VALID_STATUSES: readonly string[] = [
			"awaiting_decision", "resumed", "closed", "dropped", "expired", "invalidated",
		];

		dashboardApp.get<{ Querystring: { status?: string } }>(
			"/api/decisions",
			{ preHandler: rateLimit },
			async (req, reply) => {
				const { status } = req.query;
				if (status && !VALID_STATUSES.includes(status)) {
					return reply.code(400).send({ error: `invalid status: ${status}` });
				}
				const records = status
					? deps.decisionStore.listByStatus(status as DecisionStatus)
					: deps.decisionStore.listAll();
				return reply.send(records.map(sanitizeDecision));
			},
		);

		if (deps.eventHub) {
			const hub = deps.eventHub;
			dashboardApp.get("/api/events", async (_req, reply) => {
				reply.raw.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				hub.addClient(reply.raw);
			});
		}

		if (deps.metricsAggregator) {
			const agg = deps.metricsAggregator;
			dashboardApp.get("/api/metrics", { preHandler: rateLimit }, async (_req, reply) => {
				const body: MetricsApiResponse = {
					...agg.snapshot(),
					recent: agg.recentEntries(20),
				};
				return reply.send(body);
			});
			dashboardApp.get("/api/metrics/trend", { preHandler: rateLimit }, async (_req, reply) => {
				return reply.send(agg.trendData());
			});
		}

		if (deps.eventHub) {
			const hub = deps.eventHub;
			// workerId 仅作注册表键，路径全部由注册表/config 派生，不拼用户输入（防穿越）。
			dashboardApp.get("/api/workers/:workerId/logs", { preHandler: rateLimit }, async (req, reply) => {
				const { workerId } = req.params as { workerId: string };
				const worker = hub.getWorker(workerId);
				if (!worker) return reply.code(404).send({ error: "unknown worker" });
				const body: WorkerLogsResponse = {
					workerId,
					workerLog: readWorkerLogTail(resolveAuditDir(), String(worker.pipelineId ?? "")),
					session: worker.cwd ? readSessionActivityTail(worker.cwd) : [],
				};
				return reply.send(body);
			});
		}
	});
}

/**
 * Serve the built dashboard SPA (dist/dashboard) under /dashboard/.
 *
 * The static plugin's default wildcard route (wildcard: true) collides with
 * the SPA fallback's GET /dashboard/* — FST_ERR_DUPLICATED_ROUTE crashed
 * main.ts on startup (observed deploying 1717f52). Register wildcard: false
 * and declare the wildcard route ourselves: serve the real file when it
 * exists inside dashboardDir, else fall back to index.html (React Router
 * client-side routing, e.g. refresh on /dashboard/decisions).
 */
export async function mountDashboardStatic(
	app: FastifyInstance,
	dashboardDir: string,
): Promise<void> {
	// 裸 /dashboard（无尾斜杠）→ /dashboard/：prefix "/dashboard/" 与
	// wildcard "/dashboard/*" 都不匹配裸路径，不重定向会 404。
	app.get("/dashboard", (_req, reply) => reply.redirect("/dashboard/"));
	await app.register(fastifyStatic, {
		root: dashboardDir,
		prefix: "/dashboard/",
		wildcard: false,
	});
	app.get("/dashboard/*", (req, reply) => {
		const rel = (req.params as { "*": string })["*"] ?? "";
		if (rel) {
			const resolved = resolve(dashboardDir, rel);
			if (
				resolved.startsWith(dashboardDir + sep) &&
				existsSync(resolved) &&
				statSync(resolved).isFile()
			) {
				void reply.sendFile(rel);
				return;
			}
		}
		void reply.sendFile("index.html", dashboardDir);
	});
}
