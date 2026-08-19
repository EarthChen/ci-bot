export interface DashboardEvent {
	type: string;
	data: unknown;
}

interface SseWritable {
	write(chunk: string): boolean;
	on(event: string, handler: () => void): void;
}

export class EventHub {
	private readonly clients = new Set<SseWritable>();
	private snapshot: Record<string, unknown> = {};
	private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

	updateSnapshot(partial: Record<string, unknown>): void {
		this.snapshot = { ...this.snapshot, ...partial };
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
