export interface DashboardEvent {
	type: string;
	data: unknown;
}

/** 活跃 worker 的快照条目——进 SSE snapshot，迟到客户端也能看到在跑的 worker。 */
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

interface SseWritable {
	write(chunk: string): boolean;
	on(event: string, handler: () => void): void;
}

export class EventHub {
	private readonly clients = new Set<SseWritable>();
	private readonly workers = new Map<string, WorkerSnapshot>();
	private snapshot: Record<string, unknown> = {};
	private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

	updateSnapshot(partial: Record<string, unknown>): void {
		this.snapshot = { ...this.snapshot, ...partial };
	}

	/**
	 * 权威 worker 注册表：SSE 事件是 fire-and-forget，客户端断线/迟到就
	 * 丢事件；注册表进 snapshot，保证任何时刻连上的客户端都能看到当前
	 * 活跃 worker。workerProgress 对未知 workerId 做 upsert，进度早于
	 * worker_started 到达也不丢。
	 */
	workerStarted(workerId: string, info: { pipelineId: number; projectId: string }): void {
		this.workers.set(workerId, { workerId, ...info, startedAt: new Date().toISOString() });
		this.updateSnapshot({ workers: this.workerList() });
	}

	workerProgress(workerId: string, partial: Partial<WorkerSnapshot>): void {
		const existing = this.workers.get(workerId);
		this.workers.set(workerId, {
			workerId,
			startedAt: new Date().toISOString(),
			...existing,
			...partial,
		});
		this.updateSnapshot({ workers: this.workerList() });
	}

	workerDone(workerId: string): void {
		if (this.workers.delete(workerId)) {
			this.updateSnapshot({ workers: this.workerList() });
		}
	}

	private workerList(): WorkerSnapshot[] {
		return [...this.workers.values()];
	}

	addClient(res: SseWritable): void {
		this.clients.add(res);
		res.on("close", () => this.removeClient(res));
		this.sendTo(res, { type: "snapshot", data: this.snapshot });
		this.ensureKeepalive();
	}

	removeClient(res: SseWritable): void {
		this.clients.delete(res);
		if (this.clients.size === 0 && this.keepaliveTimer) {
			clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = null;
		}
	}

	emit(event: DashboardEvent): void {
		for (const client of this.clients) {
			this.sendTo(client, event);
		}
	}

	get clientCount(): number {
		return this.clients.size;
	}

	stop(): void {
		if (this.keepaliveTimer) {
			clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = null;
		}
	}

	private sendTo(res: SseWritable, event: DashboardEvent): void {
		res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
	}

	private ensureKeepalive(): void {
		if (this.keepaliveTimer) return;
		this.keepaliveTimer = setInterval(() => {
			for (const client of this.clients) {
				client.write(":keepalive\n\n");
			}
		}, 30_000);
		this.keepaliveTimer.unref();
	}
}
