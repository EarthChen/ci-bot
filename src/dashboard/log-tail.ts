/**
 * Dashboard 日志尾读：worker.log（bot 编排层 pino 日志）+ session jsonl
 * （agent 对话/工具调用活动流）。只读文件系统、无状态；路径全部来自
 * EventHub 注册表与 config/paths，不从 URL 参数拼路径（防穿越）。
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { SessionActivityItem, WorkerLogLine } from "./shared-types.js";

const PINO_LEVELS: Record<number, string> = {
	10: "trace",
	20: "debug",
	30: "info",
	40: "warn",
	50: "error",
	60: "fatal",
};

/** 尾读窗口：日志文件可能增长到数 MB，只读末尾窗口避免整文件加载。 */
const TAIL_BYTES = 256 * 1024;

function readTailChunk(path: string): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
	} catch {
		return "";
	}
	try {
		const size = fstatSync(fd).size;
		if (size === 0) return "";
		const start = Math.max(0, size - TAIL_BYTES);
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		let text = buf.toString("utf8");
		if (start > 0) {
			// 截断点在行中间时丢弃首个不完整行
			const nl = text.indexOf("\n");
			if (nl >= 0) text = text.slice(nl + 1);
		}
		return text;
	} finally {
		closeSync(fd);
	}
}

/**
 * 读 pipeline 最新一次运行的 worker.log 尾部。同一 pipeline 多次运行会
 * 产生多个 <uuid>-worker-log 目录，取 mtime 最新。非 JSON 行丢弃。
 */
export function readWorkerLogTail(auditDir: string, pipelineId: string, maxLines = 200): WorkerLogLine[] {
	const pipelineDir = join(auditDir, pipelineId);
	let candidates: string[];
	try {
		candidates = readdirSync(pipelineDir)
			.filter((name) => name.endsWith("-worker-log"))
			.map((name) => join(pipelineDir, name, "worker.log"))
			.filter((p) => existsSync(p));
	} catch {
		return [];
	}
	if (candidates.length === 0) return [];
	candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

	const out: WorkerLogLine[] = [];
	for (const line of readTailChunk(candidates[0]).split("\n").filter(Boolean).slice(-maxLines)) {
		if (!line) continue;
		let rec: { time?: unknown; level?: unknown; msg?: unknown };
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		out.push({
			time: typeof rec.time === "string" ? rec.time : "",
			level: typeof rec.level === "number" ? PINO_LEVELS[rec.level] ?? String(rec.level) : "info",
			msg: typeof rec.msg === "string" ? rec.msg : "",
		});
	}
	return out;
}

function collectJsonl(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(full);
		}
	};
	walk(root);
	return found;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** 工具参数摘要：取常见目标字段，压空白、截断（dashboard 展示用）。 */
function summarizeToolArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	const candidate = record.command ?? record.path ?? record.pattern ?? record.query ?? "";
	const text = typeof candidate === "string" ? candidate : JSON.stringify(candidate) ?? "";
	return truncate(text.replace(/\s+/g, " ").trim(), 80);
}

function firstText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") return text;
		}
	}
	return "";
}

/**
 * 读活跃 session jsonl 尾部，映射为活动条目。取 sessions 目录下 mtime
 * 最新的 jsonl（运行中即当前 session 文件）。thinking 条目跳过（内部推理，
 * 体量大、信号低）。
 */
export function readSessionActivityTail(cwd: string, maxItems = 60): SessionActivityItem[] {
	const files = collectJsonl(join(cwd, ".pi-agent", "sessions"));
	if (files.length === 0) return [];
	files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

	const items: SessionActivityItem[] = [];
	for (const line of readTailChunk(files[0]).split("\n")) {
		if (!line) continue;
		let entry: { type?: unknown; timestamp?: unknown; message?: unknown };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message as { role?: unknown; content?: unknown; toolName?: unknown } | undefined;
		if (!msg || typeof msg !== "object") continue;
		const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (!part || typeof part !== "object") continue;
				const p = part as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
				if (p.type === "text" && typeof p.text === "string") {
					items.push({ timestamp, kind: "text", summary: truncate(p.text, 300) });
				} else if (p.type === "toolCall" && typeof p.name === "string") {
					const argSummary = summarizeToolArgs(p.arguments);
					items.push({
						timestamp,
						kind: "tool_call",
						summary: truncate(argSummary ? `${p.name} ${argSummary}` : p.name, 200),
					});
				}
				// thinking：跳过
			}
		} else if (msg.role === "toolResult") {
			const name = typeof msg.toolName === "string" ? msg.toolName : "tool";
			items.push({ timestamp, kind: "tool_result", summary: truncate(`${name}: ${firstText(msg.content)}`, 300) });
		} else if (msg.role === "user") {
			const text = firstText(msg.content);
			if (text) items.push({ timestamp, kind: "user", summary: truncate(text, 300) });
		}
	}
	return items.slice(-maxItems);
}
