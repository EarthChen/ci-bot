import { describe, expect, it, vi } from "vitest";
import { EventHub, type DashboardEvent } from "../../src/dashboard/event-hub.js";

describe("EventHub", () => {
	it("sends snapshot to new client immediately", () => {
		const hub = new EventHub();
		hub.updateSnapshot({ scheduler: { running: 1, queued: 0, inflight: 1 } });

		const messages: string[] = [];
		const fakeRes = {
			write: (chunk: string) => { messages.push(chunk); return true; },
			on: vi.fn(),
		};
		hub.addClient(fakeRes as any);

		expect(messages.length).toBeGreaterThanOrEqual(1);
		const snapshotMsg = messages.find((m) => m.includes("event: snapshot"));
		expect(snapshotMsg).toBeDefined();
	});

	it("broadcasts events to all connected clients", () => {
		const hub = new EventHub();

		const msgs1: string[] = [];
		const msgs2: string[] = [];
		const fakeRes1 = {
			write: (chunk: string) => { msgs1.push(chunk); return true; },
			on: vi.fn(),
		};
		const fakeRes2 = {
			write: (chunk: string) => { msgs2.push(chunk); return true; },
			on: vi.fn(),
		};
		hub.addClient(fakeRes1 as any);
		hub.addClient(fakeRes2 as any);

		const event: DashboardEvent = {
			type: "pipeline_enqueued",
			data: { pipelineId: 42, projectId: "proj", ref: "main" },
		};
		hub.emit(event);

		const hasEvent = (msgs: string[]) =>
			msgs.some((m) => m.includes("pipeline_enqueued"));
		expect(hasEvent(msgs1)).toBe(true);
		expect(hasEvent(msgs2)).toBe(true);
	});

	it("removes client on close", () => {
		const hub = new EventHub();

		const msgs: string[] = [];
		let closeHandler: (() => void) | undefined;
		const fakeRes = {
			write: (chunk: string) => { msgs.push(chunk); return true; },
			on: (event: string, handler: () => void) => {
				if (event === "close") closeHandler = handler;
			},
		};
		hub.addClient(fakeRes as any);

		closeHandler!();

		const beforeCount = msgs.length;
		hub.emit({ type: "worker_done", data: { workerId: "x", outcome: "mr", durationMs: 1000 } });
		expect(msgs.length).toBe(beforeCount);
	});

	it("worker 注册表：迟到客户端从 snapshot 看到活跃 worker", () => {
		const hub = new EventHub();
		hub.workerStarted("proj-1-42", { pipelineId: 42, projectId: "proj-1" });
		hub.workerProgress("proj-1-42", { stage: "agent-run", turn: 2 });

		const messages: string[] = [];
		const fakeRes = {
			write: (chunk: string) => { messages.push(chunk); return true; },
			on: vi.fn(),
		};
		hub.addClient(fakeRes as any);

		const snapshotMsg = messages.find((m) => m.includes("event: snapshot"));
		expect(snapshotMsg).toBeDefined();
		const data = JSON.parse(snapshotMsg!.slice(snapshotMsg!.indexOf("data: ") + 6));
		expect(data.workers).toEqual([
			expect.objectContaining({
				workerId: "proj-1-42",
				pipelineId: 42,
				projectId: "proj-1",
				stage: "agent-run",
				turn: 2,
			}),
		]);
	});

	it("worker 注册表：workerDone 后 snapshot 不再包含该 worker", () => {
		const hub = new EventHub();
		hub.workerStarted("w1", { pipelineId: 1, projectId: "p" });
		hub.workerDone("w1");

		const messages: string[] = [];
		const fakeRes = {
			write: (chunk: string) => { messages.push(chunk); return true; },
			on: vi.fn(),
		};
		hub.addClient(fakeRes as any);

		const snapshotMsg = messages.find((m) => m.includes("event: snapshot"));
		const data = JSON.parse(snapshotMsg!.slice(snapshotMsg!.indexOf("data: ") + 6));
		expect(data.workers).toEqual([]);
	});

	it("workerProgress 对未知 worker upsert——进度早于 worker_started 也不丢", () => {
		const hub = new EventHub();
		hub.workerProgress("w-late", { stage: "agent-run", turn: 1 });

		const messages: string[] = [];
		const fakeRes = {
			write: (chunk: string) => { messages.push(chunk); return true; },
			on: vi.fn(),
		};
		hub.addClient(fakeRes as any);

		const snapshotMsg = messages.find((m) => m.includes("event: snapshot"));
		const data = JSON.parse(snapshotMsg!.slice(snapshotMsg!.indexOf("data: ") + 6));
		expect(data.workers).toEqual([
			expect.objectContaining({ workerId: "w-late", stage: "agent-run", turn: 1 }),
		]);
	});
});
