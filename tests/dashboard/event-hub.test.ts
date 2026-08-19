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
});
