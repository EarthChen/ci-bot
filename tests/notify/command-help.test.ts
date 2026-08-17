import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildCommandHelp,
	buildHelpIndex,
	buildUsageText,
	loadCommandHelp,
	type CommandHelpConfig,
} from "../../src/notify/command-help.js";

const CONFIG: CommandHelpConfig = {
	commands: {
		"/route": {
			summary: "管理群路由",
			usage: ["`/route add <pattern>` 绑定当前群", "`/route list` 列出路由"],
		},
		"/help": { summary: "显示本帮助", usage: ["`/help` 列出所有命令"] },
	},
};

describe("loadCommandHelp", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "command-help-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("parses a valid config", () => {
		const file = join(dir, "help.json");
		writeFileSync(file, JSON.stringify(CONFIG));
		expect(loadCommandHelp(file)).toEqual(CONFIG);
	});

	it("throws when the file is missing (help text is the feature itself)", () => {
		expect(() => loadCommandHelp(join(dir, "absent.json"))).toThrow(/not found/);
	});

	it("throws on malformed JSON (fail loud)", () => {
		const file = join(dir, "bad.json");
		writeFileSync(file, "{oops");
		expect(() => loadCommandHelp(file)).toThrow();
	});

	it("throws when an entry lacks summary or usage", () => {
		const file = join(dir, "bad-shape.json");
		writeFileSync(file, JSON.stringify({ commands: { "/x": { summary: "s" } } }));
		expect(() => loadCommandHelp(file)).toThrow(/usage/);
	});

	it("accepts the shipped config/command-help.json with a /heal entry", () => {
		const shipped = fileURLToPath(
			new URL("../../config/command-help.json", import.meta.url),
		);
		const config = loadCommandHelp(shipped);
		const heal = config.commands["/heal"];
		expect(heal).toBeDefined();
		expect(heal!.summary).toBeTruthy();
		expect(heal!.usage.length).toBeGreaterThan(0);
	});
});

describe("buildHelpIndex", () => {
	it("lists every command with its summary", () => {
		const { text } = buildHelpIndex(CONFIG);
		expect(text).toContain("/route");
		expect(text).toContain("管理群路由");
		expect(text).toContain("/help");
	});

	it("handles an empty command set", () => {
		const { title } = buildHelpIndex({ commands: {} });
		expect(title).toContain("为空");
	});
});

describe("buildCommandHelp", () => {
	it("renders one command's detail", () => {
		const detail = buildCommandHelp(CONFIG, "/route");
		expect(detail?.text).toContain("管理群路由");
		expect(detail?.text).toContain("`/route add <pattern>` 绑定当前群");
	});

	it("accepts the bare name without leading slash", () => {
		expect(buildCommandHelp(CONFIG, "route")?.title).toBe("/route");
	});

	it("returns null for unknown commands", () => {
		expect(buildCommandHelp(CONFIG, "/nope")).toBeNull();
	});
});

describe("buildUsageText", () => {
	it("renders the usage lines as a bulleted block", () => {
		const text = buildUsageText(CONFIG, "/route");
		expect(text).toContain("- `/route add <pattern>` 绑定当前群");
		expect(text).toContain("- `/route list` 列出路由");
	});

	it("falls back to a generic line for unknown commands", () => {
		expect(buildUsageText(CONFIG, "/nope")).toContain("/nope");
	});
});
