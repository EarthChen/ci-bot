import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Scheduler } from "../../src/agent-runtime/scheduler.js";
import type { PipelineFailureNotifier } from "../../src/notify/pipeline-notification.js";
import {
	mountWebhook,
	parsePipelinePayload,
	type WebhookConfig,
} from "../../src/webhook/receiver.js";
import type { PipelineEvent } from "../../src/types.js";


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

	it("extracts failed stages from the builds array", () => {
		const payload = {
			...(failedPipeline(12345) as Record<string, unknown>),
			builds: [
				{ id: 1, stage: "format", name: "idea-format", status: "failed" },
				{ id: 2, stage: "test", name: "unit", status: "skipped" },
			],
		};
		expect(parsePipelinePayload(payload)).toMatchObject({
			failedStages: ["format"],
		});
	});

	it("dedupes stages and keeps order across multiple failed jobs", () => {
		const payload = {
			...(failedPipeline(12345) as Record<string, unknown>),
			builds: [
				{ id: 1, stage: "format", name: "a", status: "failed" },
				{ id: 2, stage: "test", name: "b", status: "failed" },
				{ id: 3, stage: "format", name: "c", status: "failed" },
			],
		};
		expect(parsePipelinePayload(payload)).toMatchObject({
			failedStages: ["format", "test"],
		});
	});

	it("ignores malformed build entries (non-string stage)", () => {
		const payload = {
			...(failedPipeline(12345) as Record<string, unknown>),
			builds: [
				{ id: 1, stage: 42, name: "a", status: "failed" },
				{ id: 2, stage: "format", name: "b", status: "failed" },
			],
		};
		expect(parsePipelinePayload(payload)).toMatchObject({
			failedStages: ["format"],
		});
	});

	it("leaves failedStages undefined when the payload has no builds array", () => {
		const event = parsePipelinePayload(failedPipeline(12345));
		expect(event).not.toBeNull();
		expect(event?.failedStages).toBeUndefined();
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
		enqueue: "queued" | "duplicate" | "skipped";
		notifier?: PipelineFailureNotifier;
		/** Query string appended to /webhook (defaults to the repair opt-in). */
		query?: string;
		onNewPipeline?: (event: PipelineEvent) => Promise<void>;
		/** Override the default failedPipeline payload. */
		payload?: unknown;
	}) {
		const app = Fastify();
		const scheduler = {
			enqueue: vi.fn().mockReturnValue(opts.enqueue),
		} as unknown as Scheduler;
		await mountWebhook(app, {
			scheduler,
			config: webhookConfig,
			...(opts.notifier ? { pipelineNotifier: opts.notifier } : {}),
			...(opts.onNewPipeline ? { onNewPipeline: opts.onNewPipeline } : {}),
		});
		const payload = (opts.payload ?? failedPipeline(12345)) as Record<string, unknown>;
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

	it("fires onNewPipeline with the parsed event when enqueued", async () => {
		const onNewPipeline = vi.fn().mockResolvedValue(undefined);
		const { res } = await injectWebhook({ enqueue: "queued", onNewPipeline });

		expect(res.json()).toEqual({ status: "queued" });
		expect(onNewPipeline).toHaveBeenCalledOnce();
		expect(onNewPipeline).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "12345", pipelineId: 101 }),
		);
	});

	it("does not fire onNewPipeline on duplicate events", async () => {
		const onNewPipeline = vi.fn().mockResolvedValue(undefined);
		const { res } = await injectWebhook({
			enqueue: "duplicate",
			onNewPipeline,
		});

		expect(res.json()).toEqual({ status: "duplicate" });
		expect(onNewPipeline).not.toHaveBeenCalled();
	});

	it("does not fire onNewPipeline on the notify-only path", async () => {
		const onNewPipeline = vi.fn().mockResolvedValue(undefined);
		const { res } = await injectWebhook({
			enqueue: "queued",
			query: "",
			onNewPipeline,
		});

		expect(res.json()).toEqual({ status: "notify-only" });
		expect(onNewPipeline).not.toHaveBeenCalled();
	});

	it("still responds queued when onNewPipeline throws", async () => {
		const onNewPipeline = vi
			.fn()
			.mockRejectedValue(new Error("invalidation blew up"));
		const { res } = await injectWebhook({ enqueue: "queued", onNewPipeline });

		expect(res.statusCode).toBe(202);
		expect(res.json()).toEqual({ status: "queued" });
	});

	it("stage-skipped pipeline: fires onNewPipeline + broadcast, responds skipped", async () => {
		const onNewPipeline = vi.fn().mockResolvedValue(undefined);
		const notify = vi.fn().mockResolvedValue(undefined);
		const { res, payload } = await injectWebhook({
			enqueue: "skipped",
			notifier: { notify },
			onNewPipeline,
		});

		expect(res.statusCode).toBe(202);
		expect(res.json()).toEqual({ status: "skipped" });
		// (ii): a new pipeline arrived → stale decisions must be invalidated
		expect(onNewPipeline).toHaveBeenCalledOnce();
		expect(onNewPipeline).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "12345", pipelineId: 101 }),
		);
		// Q5(a): the immediate failure broadcast survives the repair skip
		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(payload);
	});

	it("still responds skipped when onNewPipeline throws", async () => {
		const onNewPipeline = vi
			.fn()
			.mockRejectedValue(new Error("invalidation blew up"));
		const { res } = await injectWebhook({ enqueue: "skipped", onNewPipeline });

		expect(res.statusCode).toBe(202);
		expect(res.json()).toEqual({ status: "skipped" });
	});
});

/** Pipeline event fired by the bot's own repair MR (source branch
 *  ci-self-heal/*) — must never broadcast or re-enter the repair queue. */
function botOwnedPipeline(): unknown {
	return {
		object_kind: "pipeline",
		object_attributes: {
			id: 999,
			ref: "refs/merge-requests/287/head",
			sha: "5e0b01c7872e5477",
			status: "failed",
		},
		merge_request: {
			source_branch: "ci-self-heal/refs/merge-requests/281/head-95fd03b8",
			iid: 287,
		},
		project: {
			id: 31041,
			web_url: "https://gitlab.example.com/example/project",
		},
	};
}

describe("webhook bot-owned pipeline guard", () => {
	const webhookConfig: WebhookConfig = {
		webhookSecret: "secret",
		ipAllowlist: [],
		rateLimitMax: 100,
		rateLimitWindowMs: 60_000,
	};

	async function injectBotPipeline(opts: {
		query?: string;
		notifier?: PipelineFailureNotifier;
		onNewPipeline?: (event: PipelineEvent) => Promise<void>;
	}) {
		const app = Fastify();
		const scheduler = {
			enqueue: vi.fn().mockReturnValue("queued"),
		} as unknown as Scheduler;
		await mountWebhook(app, {
			scheduler,
			config: webhookConfig,
			...(opts.notifier ? { pipelineNotifier: opts.notifier } : {}),
			...(opts.onNewPipeline ? { onNewPipeline: opts.onNewPipeline } : {}),
		});
		const res = await app.inject({
			method: "POST",
			url: `/webhook${opts.query ?? "?repair=1"}`,
			headers: { "x-gitlab-token": "secret" },
			payload: botOwnedPipeline() as Record<string, unknown>,
		});
		await app.close();
		return { res, scheduler };
	}

	it("bot 修复 MR 的 pipeline（repair=1）→ 不入队、不播报、不作废决策", async () => {
		const notify = vi.fn().mockResolvedValue(undefined);
		const onNewPipeline = vi.fn().mockResolvedValue(undefined);
		const { res, scheduler } = await injectBotPipeline({
			notifier: { notify },
			onNewPipeline,
		});

		expect(res.statusCode).toBe(202);
		expect(res.json()).toEqual({ status: "ignored-bot-pipeline" });
		expect(scheduler.enqueue).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		// 关键：不能因 bot 自己的 pipeline 作废原 MR 的待决策
		expect(onNewPipeline).not.toHaveBeenCalled();
	});

	it("notify-only 路径（无 repair 参数）同样静默跳过", async () => {
		const notify = vi.fn().mockResolvedValue(undefined);
		const { res } = await injectBotPipeline({ query: "", notifier: { notify } });

		expect(res.statusCode).toBe(202);
		expect(res.json()).toEqual({ status: "ignored-bot-pipeline" });
		expect(notify).not.toHaveBeenCalled();
	});
});
