/**
 * /help command — lists registered commands and per-command usage.
 *
 * Help text is externalized to config/command-help.json (loaded by main);
 * this module only dispatches and renders via command-help.ts helpers.
 * Group-only like /route: the bot's reply seam is groupMessages/send
 * (no private oToMessages in v1), so private-chat help is logged and dropped.
 */

import type { DingTalkMessage } from "./dingtalk.js";
import {
	buildCommandHelp,
	buildHelpIndex,
	type CommandHelpConfig,
} from "./command-help.js";
import type { DingTalkIncomingMessage } from "./stream-bot.js";
import { logger } from "../util/log.js";

export interface HelpCommandDeps {
	readonly help: CommandHelpConfig;
	/** Send the reply back into the group the command came from. */
	reply(conversationId: string, message: DingTalkMessage): Promise<void>;
}

/**
 * Handle a /help command. Returns true when the message was a /help command
 * (handled, whether it succeeded or not); false for other text.
 */
export async function handleHelpCommand(
	deps: HelpCommandDeps,
	message: DingTalkIncomingMessage,
): Promise<boolean> {
	if (!message.text.trim().startsWith("/help")) return false;

	if (message.conversationType !== "group") {
		// No private-chat reply seam in v1 (groupMessages/send only).
		logger.info(
			{ sender: message.senderStaffId },
			"help command ignored in private chat",
		);
		return true;
	}

	const args = message.text.trim().split(/\s+/).slice(1);
	const target = args[0];

	if (!target) {
		await deps.reply(message.conversationId, buildHelpIndex(deps.help));
		return true;
	}

	const detail = buildCommandHelp(deps.help, target);
	if (detail) {
		await deps.reply(message.conversationId, detail);
		return true;
	}

	const index = buildHelpIndex(deps.help);
	await deps.reply(message.conversationId, {
		title: `未知命令 ${target}`,
		text: `### 未知命令 \`${target}\`\n\n${index.text}`,
	});
	return true;
}
