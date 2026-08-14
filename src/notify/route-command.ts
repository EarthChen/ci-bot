/**
 * /route group command — manages dynamic webhook routes from DingTalk chats.
 *
 * Ported from code-review-bot's /route chat command, adapted to ci-bot's
 * group-only reply seam:
 *   /route add <pattern>   bind <pattern> to the CURRENT group
 *   /route rm <pattern>    remove a route
 *   /route list            list all dynamic routes
 *
 * Group-only: `add` needs the current group's openConversationId, and the
 * bot's push seam only covers group messages (no private oToMessages in v1),
 * so private-chat commands are logged and dropped.
 */

import type { DingTalkMessage } from "./dingtalk.js";
import type { WebhookRouteStore } from "./route-store.js";
import type { DingTalkIncomingMessage } from "./stream-bot.js";
import { logger } from "../util/log.js";

export interface RouteCommandDeps {
	readonly store: WebhookRouteStore;
	/** Send the reply back into the group the command came from. */
	reply(conversationId: string, message: DingTalkMessage): Promise<void>;
	/**
	 * Bulleted usage text for bad-input replies — injected from
	 * config/command-help.json (single source of truth with /help).
	 */
	readonly usageText: string;
}

/**
 * Handle a /route command. Returns true when the message was a /route
 * command (handled, whether it succeeded or not); false for other text.
 */
export async function handleRouteCommand(
	deps: RouteCommandDeps,
	message: DingTalkIncomingMessage,
): Promise<boolean> {
	if (!message.text.trim().startsWith("/route")) return false;

	if (message.conversationType !== "group") {
		// `add` binds to the current group's openConversationId — private
		// chats have no group to bind and no reply seam in v1.
		logger.info(
			{ sender: message.senderStaffId },
			"route command ignored in private chat",
		);
		return true;
	}

	const args = message.text.trim().split(/\s+/).slice(1);
	const sub = args[0] ?? "";
	const pattern = args[1];

	switch (sub) {
		case "add": {
			if (!pattern) {
				await sendReply(deps, message, "缺少 pattern。", deps.usageText);
				return true;
			}
			deps.store.add(
				pattern,
				message.conversationId,
				message.senderStaffId || message.senderNick,
			);
			await sendReply(
				deps,
				message,
				`✅ 已绑定 \`${pattern}\` → 本群`,
				"该项目的 CI 失败通知将发送到本群。",
			);
			return true;
		}
		case "rm": {
			if (!pattern) {
				await sendReply(deps, message, "缺少 pattern。", deps.usageText);
				return true;
			}
			const removed = deps.store.remove(pattern);
			await sendReply(
				deps,
				message,
				removed ? `✅ 已删除路由 \`${pattern}\`` : `⚠️ 未找到路由 \`${pattern}\``,
			);
			return true;
		}
		case "list": {
			const routes = deps.store.list();
			if (routes.length === 0) {
				await sendReply(
					deps,
					message,
					"动态路由为空",
					"暂无通过 /route 添加的路由；静态路由见 config/group-routing.json。",
				);
				return true;
			}
			const lines = routes.map(
				(route) =>
					`- \`${route.pattern}\` → ${route.conversationId}（by ${route.createdBy || "unknown"}，${route.createdAt}）`,
			);
			await sendReply(deps, message, `动态路由（${routes.length} 条）`, lines.join("\n"));
			return true;
		}
		default: {
			await sendReply(deps, message, "未知子命令。", deps.usageText);
			return true;
		}
	}
}

async function sendReply(
	deps: RouteCommandDeps,
	message: DingTalkIncomingMessage,
	title: string,
	body?: string,
): Promise<void> {
	await deps.reply(message.conversationId, {
		title,
		text: `### ${title}\n\n${body ?? ""}`,
	});
}
