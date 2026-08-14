/**
 * Command help text — externalized to `config/command-help.json` so wording
 * can be adjusted without a code change. Loaded once at startup.
 *
 * Unlike loadGroupRouting (missing file = "no custom routes" is a valid
 * state), help text IS the /help feature — a missing or malformed file is a
 * deploy error and throws at boot (fail loud).
 */

import { readFileSync } from "node:fs";

export interface CommandHelp {
	readonly summary: string;
	readonly usage: readonly string[];
}

export interface CommandHelpConfig {
	readonly commands: Readonly<Record<string, CommandHelp>>;
}

export function loadCommandHelp(path: string): CommandHelpConfig {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		throw new Error(`command help config not found: ${path}`);
	}
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`command help config must be an object: ${path}`);
	}
	const obj = parsed as Record<string, unknown>;
	const rawCommands = obj.commands;
	if (typeof rawCommands !== "object" || rawCommands === null) {
		throw new Error(`command help config "commands" must be an object: ${path}`);
	}

	const commands: Record<string, CommandHelp> = {};
	for (const [name, entry] of Object.entries(
		rawCommands as Record<string, unknown>,
	)) {
		if (typeof entry !== "object" || entry === null) {
			throw new Error(`command help entry "${name}" must be an object: ${path}`);
		}
		const cmd = entry as Record<string, unknown>;
		if (typeof cmd.summary !== "string") {
			throw new Error(`command help entry "${name}" needs a string summary: ${path}`);
		}
		if (
			!Array.isArray(cmd.usage) ||
			!cmd.usage.every((line) => typeof line === "string")
		) {
			throw new Error(
				`command help entry "${name}" needs a string-array usage: ${path}`,
			);
		}
		commands[name] = { summary: cmd.summary, usage: cmd.usage };
	}
	return { commands };
}

/** Markdown index of all commands — the `/help` reply. */
export function buildHelpIndex(config: CommandHelpConfig): {
	title: string;
	text: string;
} {
	const names = Object.keys(config.commands);
	if (names.length === 0) {
		return { title: "命令列表为空", text: "未注册任何命令。" };
	}
	const lines = names.map(
		(name) => `- \`${name}\` — ${config.commands[name].summary}`,
	);
	return {
		title: "CI 自愈 Bot 命令列表",
		text:
			`### CI 自愈 Bot 命令列表\n\n${lines.join("\n")}\n\n` +
			"发送 `/help <命令>` 查看详细用法。",
	};
}

/** Markdown detail for one command — the `/help <name>` reply, or null. */
export function buildCommandHelp(
	config: CommandHelpConfig,
	name: string,
): { title: string; text: string } | null {
	const key = normalizeName(name);
	const cmd = config.commands[key];
	if (!cmd) return null;
	const usage = cmd.usage.map((line) => `- ${line}`).join("\n");
	return {
		title: key,
		text: `### ${key}\n\n${cmd.summary}\n\n用法：\n${usage}`,
	};
}

/** Bulleted usage block for a command (used in bad-input replies). */
export function buildUsageText(config: CommandHelpConfig, name: string): string {
	const key = normalizeName(name);
	const cmd = config.commands[key];
	if (!cmd) return `未知命令 ${key}。`;
	return `用法：\n${cmd.usage.map((line) => `- ${line}`).join("\n")}`;
}

/** Accept both `route` and `/route`. */
function normalizeName(name: string): string {
	return name.startsWith("/") ? name : `/${name}`;
}
