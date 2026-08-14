import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Scheduler } from "../../src/agent-runtime/scheduler.js";
import type { PipelineFailureNotifier } from "../../src/notify/pipeline-notification.js";
import {
	mountWebhook,
	parsePipelinePayload,
	type WebhookConfig,
} from "../../src/webhook/receiver.js";

function failedPipeline(projectId: string | number): unknown {
	return {
		object_kind: "pipeline",
		object_attributes: {
			id: 101,
			ref: "main",
			sha: "0123456789abcdef",
			status: "failed",
		},
		merge_request: { source_branch: "main", iid: 101 },
		project: {
			id: projectId,
			web_url: "https://gitlab.example.com/example/project",
		},
	};
}

describe("parsePipelinePayload", () => {
	it("rejects a project id that could escape the worker root", () => {
		expect(
			parsePipelinePayload(failedPipeline("../../../sensitive")),
		).toBeNull();
	});

	it("accepts GitLab numeric project ids", () => {
		expect(parsePipelinePayload(failedPipeline(12345))).toMatchObject({
			projectId: "12345",
		});
	});
});

describe("webhook pipeline-failure notification fan-out", () => {
	const webhookConfig: WebhookConfig = {
		webhookSecret: "secret",
		ipAllowlist: [],
		rateLimitMax: 100,
		rateLimitWindowMs: 60_000,
	};

	async function injectWebhook(opts: {
		enqueue: "queued" | "duplicate";
		notifier?: PipelineFailureNotifier;
		/** Query string appended to /webhook (defaults to the repair opt-in). */
		query?: string;
	}) {
		const app = Fastify();
		const scheduler = {
			enqueue: vi.fn().mockReturnValue(opts.enqueue),
		} as unknown as Scheduler;
		await mountWebhook(app, {
			scheduler,
			config: webhookConfig,
			...(opts.notifier ? { pipelineNotifier: opts.notifier } : {}),
		});
		const payload = failedPipeline(12345) as Record<string, unknown>;
		const res = await app.inject({
			method: "POST",
			url: `/webhook${opts.query ?? "?repair=1"}`,
			headers: { "x-gitlab-token": "secret" },
			payload,
		});
		await app.close();
		return { res, payload, scheduler };
	}

	it("notifies once with the raw payload when the event is queued", async () => {
		const notify = vi.fn().mockResolvedValue(undefined);
		const { res, payload } = await injectWebhook({
			enqueue: "queued",
			notifier: { notify },
		});

		expect(res.statusCode).toBe(202);
		expect(res.json()).toEqual({ status: "queued" });
		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(payload);
	});

	it("does not notify on duplicate events", async () => {
		const notify = vi.fn().mockResolvedValue(undefined);
		const { res } = await injectWebhook({
			enqueue: "duplicate",
			notifier: { notify },
		});

		expect(res.json()).toEqual({ status: "duplicate" });
		expect(notify).not.toHaveBeenCalled();
	});

	it("still responds queued when the notifier throws", async () => {
		const notify = vi.fn().mockRejectedValue(new Error("dingtalk down"));
		const { res } = await injectWebhook({
			enqueue: "queued",
			notifier: { notify },
		});

		expect(res.statusCode).toBe(202);
		expect(res.json()).toEqual({ status: "queued" });
	});

	it("does not enqueue without the repair param (notify-only)", async () => {
		const notify = vi.fn().mockResolvedValue(undefined);
		const { res, payload, scheduler } = await injectWebhook({
			enqueue: "queued",
			notifier: { notify },
			query: "",
		});

		expect(res.statusCode).toBe(202);
		expect(res.json()).toEqual({ status: "notify-only" });
		expect(scheduler.enqueue).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(payload);
	});

	it("treats repair=0 and repair=false as absent", async () => {
		for (const query of ["?repair=0", "?repair=false"]) {
			const { res, scheduler } = await injectWebhook({
				enqueue: "queued",
				query,
			});

			expect(res.json()).toEqual({ status: "notify-only" });
			expect(scheduler.enqueue).not.toHaveBeenCalled();
		}
	});

	it("accepts repair=TRUE (case-insensitive) as opt-in", async () => {
		const { res, scheduler } = await injectWebhook({
			enqueue: "queued",
			query: "?repair=TRUE",
		});

		expect(res.json()).toEqual({ status: "queued" });
		expect(scheduler.enqueue).toHaveBeenCalledOnce();
	});
});
