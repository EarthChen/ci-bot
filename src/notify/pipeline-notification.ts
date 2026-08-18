/**
 * DingTalk markdown template for CI pipeline failure notifications.
 *
 * Ported from code-review-bot's `build_pipeline_notification`
 * (src/notifications/templates.py) — same field set, same caps, same links.
 * The webhook receiver fan-out builds this message for every accepted
 * failed pipeline event and routes it to a group via ProjectRouter.
 */

import type { DingTalkMessage } from "./dingtalk.js";
import type { ProjectRouter } from "./project-router.js";
import { logger } from "../util/log.js";

/** Rendered notification: title is the DingTalk preview line, text the body. */
export interface PipelineNotification {
	readonly title: string;
	readonly text: string;
}

/** Icon per pipeline status (code-review-bot parity). */
const STATUS_ICONS: Readonly<Record<string, string>> = {
	failed: "❌",
	canceled: "🚫",
	timeout: "⏰",
};

/** Max failed jobs listed inline; the rest are summarized. */
const MAX_LISTED_JOBS = 5;

/** Max commit message chars rendered. */
const MAX_COMMIT_MESSAGE_CHARS = 120;

/**
 * Build the group notification from a raw GitLab pipeline webhook payload.
 * Returns null when the payload is not an object (nothing renderable).
 */
export function buildPipelineNotification(
	payload: unknown,
): PipelineNotification | null {
	if (typeof payload !== "object" || payload === null) return null;
	const obj = payload as Record<string, unknown>;

	const project = asRecord(obj.project);
	const attrs = asRecord(obj.object_attributes);
	const commit = asRecord(obj.commit);

	const pipelineId = attrs.id ?? "";
	const status = typeof attrs.status === "string" ? attrs.status : "failed";
	const projectPath = stringOr(project.path_with_namespace, "unknown");
	const projectWebUrl = stringOr(project.web_url, "");
	const pipelineUrl = `${projectWebUrl}/pipelines/${pipelineId}`;
	const icon = STATUS_ICONS[status] ?? "⚠️";
	const statusTitle = capitalize(status);

	let text =
		`### ${icon} CI Pipeline ${statusTitle}\n\n` +
		`- **项目**: ${projectPath}\n` +
		`- **分支**: \`${attrs.ref ?? ""}\`\n` +
		`- **Pipeline**: [#${pipelineId}](${pipelineUrl})\n`;

	if (typeof obj.merge_request === "object" && obj.merge_request !== null) {
		const mr = obj.merge_request as Record<string, unknown>;
		text += `- **MR**: [!${mr.iid ?? ""} ${mr.title ?? ""}](${mr.url ?? ""})\n`;
	}

	const author = asRecord(commit.author);
	text += `- **提交人**: ${stringOr(author.name, "unknown")}\n`;

	const commitMessage = stringOr(commit.message, "").slice(
		0,
		MAX_COMMIT_MESSAGE_CHARS,
	);
	if (commitMessage) {
		text += `- **提交**: ${commitMessage}\n`;
	}

	const failedJobs = extractFailedJobs(obj.builds);
	if (failedJobs.length > 0) {
		text += `\n**失败 Job (${failedJobs.length}个)**:\n`;
		for (const job of failedJobs.slice(0, MAX_LISTED_JOBS)) {
			const jobUrl = `${projectWebUrl}/-/jobs/${job.id ?? ""}`;
			text += `- \`${stringOr(job.stage, "")}/${stringOr(job.name, "unknown")}\` → [查看日志](${jobUrl})\n`;
		}
		if (failedJobs.length > MAX_LISTED_JOBS) {
			text += `- ...(另有 ${failedJobs.length - MAX_LISTED_JOBS} 个失败 job)\n`;
		}
	}

	const titleIcon = status === "failed" ? "❌" : "⚠️";
	return { title: `${titleIcon} CI ${statusTitle}: ${projectPath}`, text };
}

/** Failed builds only (status === "failed"), in payload order. */
function extractFailedJobs(
	builds: unknown,
): ReadonlyArray<Record<string, unknown>> {
	if (!Array.isArray(builds)) return [];
	return builds.filter(
		(job): job is Record<string, unknown> =>
			typeof job === "object" &&
			job !== null &&
			(job as Record<string, unknown>).status === "failed",
	);
}

/** Non-object values degrade to an empty record (missing-field tolerance). */
function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

/** Python `str.title()` parity for single-word statuses ("failed" → "Failed"). */
function capitalize(value: string): string {
	return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** Sends markdown to an explicit group conversation (StreamDingTalkNotifier.sendTo). */
export interface GroupMessageSender {
	sendTo(conversationId: string, message: DingTalkMessage): Promise<void>;
}

/** Repair-state footer for the failure broadcast (receiver knows the state). */
export type RepairBroadcastHint = "repair-started" | "stage-skipped";

const REPAIR_FOOTERS: Readonly<Record<RepairBroadcastHint, string>> = {
	"repair-started": "\n\n---\n🔧 CI 自愈 bot 已开始修复，完成后将推送结果",
	"stage-skipped":
		"\n\n---\nℹ️ 该失败 stage 不在自愈范围（CIHEAL_SKIP_STAGES），不自动修复",
};

/** Webhook receiver seam: notify the routed group about an accepted failure event. */
export interface PipelineFailureNotifier {
	notify(rawPayload: unknown, hint?: RepairBroadcastHint): Promise<void>;
}

export interface PipelineFailureNotifierDeps {
	readonly router: ProjectRouter;
	readonly sender: GroupMessageSender;
}

/**
 * Wire the CI-failure group notification (ported from code-review-bot's
 * PipelineHandler): build the markdown, resolve the target group by project
 * path, send. Unrenderable payloads and unrouted projects are skipped (logged),
 * transport errors propagate to the caller (the receiver logs and continues).
 */
export function createPipelineFailureNotifier(
	deps: PipelineFailureNotifierDeps,
): PipelineFailureNotifier {
	return {
		async notify(rawPayload: unknown, hint?: RepairBroadcastHint): Promise<void> {
			const notification = buildPipelineNotification(rawPayload);
			if (!notification) return;

			const project = (rawPayload as Record<string, unknown>).project;
			const projectPath =
				typeof project === "object" &&
				project !== null &&
				typeof (project as Record<string, unknown>).path_with_namespace ===
					"string"
					? ((project as Record<string, unknown>).path_with_namespace as string)
					: "";

			const conversationId = deps.router.resolve(projectPath);
			if (!conversationId) {
				logger.warn(
					{ projectPath },
					"pipeline failure notification skipped: no group route",
				);
				return;
			}
			const message = hint
				? { ...notification, text: notification.text + REPAIR_FOOTERS[hint] }
				: notification;
			await deps.sender.sendTo(conversationId, message);
		},
	};
}
