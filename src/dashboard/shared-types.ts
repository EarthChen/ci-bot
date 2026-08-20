/** Dashboard API types shared between backend routes and frontend mirror (packages/dashboard/src/types.ts). */

export interface HealthInfo {
	uptimeSeconds: number;
	memoryMB: number;
	version: string;
	nodeVersion: string;
}

export interface SchedulerStats {
	running: number;
	queued: number;
	inflight: number;
	serialKeys: string[];
}

export interface QueueDetail {
	serialKey: string;
	pipelineId: number;
	status: "running" | "queued";
}

export interface ApiStatusResponse {
	health: HealthInfo;
	scheduler: SchedulerStats;
	queue: QueueDetail[];
}

/** 活跃 worker 快照条目——进 SSE snapshot，迟到客户端也能看到在跑的 worker。 */
export interface WorkerSnapshot {
	workerId: string;
	pipelineId?: number;
	projectId?: string;
	stage?: string;
	turn?: number;
	tokens?: number;
	toolCall?: string;
	startedAt: string;
}

export interface SystemSnapshot {
	health?: HealthInfo;
	scheduler?: SchedulerStats;
	workers?: WorkerSnapshot[];
}

export interface MetricsEntry {
	projectId: string;
	pipelineId: number;
	outcome: string;
	turns: number;
	tokens: number;
	cost: number;
	durationMs: number;
	createdAt: string;
}

export interface MetricsSnapshot {
	count: number;
	successCount: number;
	escalationCount: number;
	failureCount: number;
	successRate: number;
	escalationRate: number;
	failureRate: number;
	avgDurationMs: number;
	totalTokens: number;
	totalCost: number;
}

export interface MetricsApiResponse extends MetricsSnapshot {
	recent: MetricsEntry[];
}

export interface TrendDay {
	date: string;
	success: number;
	escalation: number;
	failure: number;
}

export type DecisionStatus =
	| "awaiting_decision"
	| "resumed"
	| "closed"
	| "dropped"
	| "expired"
	| "invalidated";

export interface DecisionSummary {
	decision_id: string;
	pipeline_id: string;
	project_id: string;
	branch: string;
	status: DecisionStatus;
	created_at: string;
	expires_at: string;
	decided_by: string | null;
	decision_value: string | null;
	remark: string | null;
	oos_paths: string | null;
	decided_at: string | null;
}

/** worker.log 单行（pino JSONL 解析后）。 */
export interface WorkerLogLine {
	time: string;
	level: string;
	msg: string;
}

/** session jsonl 活动条目。 */
export type SessionActivityKind = "text" | "tool_call" | "tool_result" | "user";

export interface SessionActivityItem {
	timestamp: string;
	kind: SessionActivityKind;
	summary: string;
}

/** GET /api/workers/:workerId/logs 响应。 */
export interface WorkerLogsResponse {
	workerId: string;
	workerLog: WorkerLogLine[];
	session: SessionActivityItem[];
}
