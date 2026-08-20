import type { EventHub } from "./event-hub.js";
import type { MetricsAggregator } from "./metrics-aggregator.js";
import type { WorkerIpcMessage } from "./ipc-types.js";

export interface IpcDispatchContext {
	readonly eventHub: EventHub;
	readonly metricsAggregator: MetricsAggregator;
	readonly workerId: string;
}

type IpcHandler = (ctx: IpcDispatchContext, msg: WorkerIpcMessage) => void;

const IPC_DISPATCH: Record<WorkerIpcMessage["type"], IpcHandler> = {
	stage_enter(ctx, msg) {
		if (msg.type !== "stage_enter") return;
		ctx.eventHub.emit({
			type: "worker_progress",
			data: {
				workerId: ctx.workerId,
				stage: msg.stage,
				pipelineId: msg.pipelineId,
				projectId: msg.projectId,
			},
		});
		ctx.eventHub.workerProgress(ctx.workerId, {
			stage: msg.stage,
			pipelineId: msg.pipelineId,
			projectId: msg.projectId,
		});
	},
	stage_exit(ctx, msg) {
		if (msg.type !== "stage_exit") return;
		ctx.eventHub.emit({
			type: "worker_progress",
			data: { workerId: ctx.workerId, stageExit: msg.stage },
		});
		// 注册表不动：stage 值等下一个 stage_enter 覆盖，stage_exit 只意味当前 stage 收尾。
	},
	turn_start(ctx, msg) {
		if (msg.type !== "turn_start") return;
		ctx.eventHub.emit({
			type: "worker_progress",
			data: { workerId: ctx.workerId, turn: msg.turn },
		});
		ctx.eventHub.workerProgress(ctx.workerId, { turn: msg.turn });
	},
	turn_end(ctx, msg) {
		if (msg.type !== "turn_end") return;
		ctx.eventHub.emit({
			type: "worker_progress",
			data: { workerId: ctx.workerId, turn: msg.turn, tokens: msg.tokens },
		});
		ctx.eventHub.workerProgress(ctx.workerId, { turn: msg.turn, tokens: msg.tokens });
	},
	tool_call(ctx, msg) {
		if (msg.type !== "tool_call") return;
		ctx.eventHub.emit({
			type: "worker_progress",
			data: { workerId: ctx.workerId, toolCall: msg.name },
		});
		ctx.eventHub.workerProgress(ctx.workerId, { toolCall: msg.name });
	},
	metrics_record(ctx, msg) {
		if (msg.type !== "metrics_record") return;
		ctx.metricsAggregator.record({
			projectId: msg.projectId,
			pipelineId: msg.pipelineId,
			outcome: msg.outcome,
			turns: msg.turns,
			tokens: msg.tokens,
			cost: msg.cost,
			durationMs: msg.durationMs,
			createdAt: msg.createdAt,
		});
		const snapshot = ctx.metricsAggregator.snapshot();
		ctx.eventHub.updateSnapshot({ metrics: snapshot });
		ctx.eventHub.emit({ type: "metrics_update", data: snapshot });
	},
};

export function dispatchIpcMessage(
	ctx: IpcDispatchContext,
	msg: WorkerIpcMessage,
): void {
	IPC_DISPATCH[msg.type](ctx, msg);
}
