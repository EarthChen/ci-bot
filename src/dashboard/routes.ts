import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DecisionRecord, DecisionStatus } from "../decision/store.js";
import type { MetricsAggregator } from "./metrics-aggregator.js";
import type { EventHub } from "./event-hub.js";
import { MemoryRateLimiter } from "./rate-limit.js";
import type {
	ApiStatusResponse,
	DecisionSummary,
	MetricsApiResponse,
	QueueDetail,
	SchedulerStats,
} from "./shared-types.js";

export type {
	ApiStatusResponse,
	DecisionSummary,
	MetricsApiResponse,
	QueueDetail,
	SchedulerStats,
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
	});
}
