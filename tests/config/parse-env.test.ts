import { afterEach, describe, it, expect, vi } from "vitest";
import { loadConfig, parseEnvFile } from "../../src/config/index.js";

const requiredConfig = {
	GITLAB_WEBHOOK_SECRET: "webhook-secret",
	GITLAB_TOKEN: "gitlab-token",
	DINGTALK_CLIENT_ID: "ding-abc",
	DINGTALK_CLIENT_SECRET: "secret-xyz",
	CIHEAL_BOT_ROOT: "/opt/ci-self-heal-bot",
	CIHEAL_PI_BASE_DIR: "/run/secrets/pi-agent",
};

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("parseEnvFile", () => {
	it("parses simple KEY=value pairs", () => {
		expect(parseEnvFile("FOO=bar\nBAZ=qux")).toEqual({
			FOO: "bar",
			BAZ: "qux",
		});
	});

	it("ignores blank lines and # comments", () => {
		expect(parseEnvFile("# header\n\nFOO=bar\n# trailing\n")).toEqual({
			FOO: "bar",
		});
	});

	it("strips matching single or double quotes around values", () => {
		expect(parseEnvFile("A=\"hello\"\nB='world'")).toEqual({
			A: "hello",
			B: "world",
		});
	});

	it("does not strip quotes when unbalanced (opaque blob preserved)", () => {
		expect(parseEnvFile('A="unterminated')).toEqual({ A: '"unterminated' });
	});

	it("supports optional `export ` prefix", () => {
		expect(parseEnvFile("export FOO=bar")).toEqual({ FOO: "bar" });
	});

	it("skips lines without an = sign", () => {
		expect(parseEnvFile("NOEQUALSHERE\nFOO=bar")).toEqual({ FOO: "bar" });
	});
});

describe("loadConfig", () => {
	it("requires and exposes the bot-owned Pi base directory", () => {
		for (const [key, value] of Object.entries(requiredConfig)) {
			vi.stubEnv(key, value);
		}

		expect(loadConfig()).toMatchObject({
			botRoot: requiredConfig.CIHEAL_BOT_ROOT,
			piBaseDir: requiredConfig.CIHEAL_PI_BASE_DIR,
		});
	});

	it("rejects relative Pi configuration directories at startup", () => {
		for (const [key, value] of Object.entries(requiredConfig)) {
			vi.stubEnv(key, value);
		}
		vi.stubEnv("CIHEAL_PI_BASE_DIR", "secrets/pi-agent");

		expect(() => loadConfig()).toThrow(
			"CIHEAL_PI_BASE_DIR must be an absolute path",
		);
	});
});
