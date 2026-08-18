import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../../src/pipeline/worktree.js";

const ORIG = {
	TOKEN: process.env.GITLAB_TOKEN,
	URL: process.env.GITLAB_URL,
	ROOT: process.env.CIHEAL_DATA_ROOT,
};

/**
 * gitEnv auth: the target GitLab instance rejects `Authorization: Bearer`
 * (the host dev env smuggled around that via the macOS keychain, so it never
 * surfaced), while the docker image has no keychain at all. The fix drives
 * GitLab's standard `oauth2:<token>` basic auth through GIT_ASKPASS — the
 * token stays in the process env, never in the askpass file or the repo URL.
 */
describe("gitEnv — GIT_ASKPASS basic auth (oauth2:<token>)", () => {
	const token = "glpat-test-token-123456";
	let dataRoot: string;

	beforeEach(() => {
		dataRoot = mkdtempSync(join(tmpdir(), "git-env-"));
		process.env.GITLAB_TOKEN = token;
		process.env.GITLAB_URL = "https://git.wemomo.com";
		process.env.CIHEAL_DATA_ROOT = dataRoot;
	});

	afterEach(() => {
		if (ORIG.TOKEN === undefined) delete process.env.GITLAB_TOKEN;
		else process.env.GITLAB_TOKEN = ORIG.TOKEN;
		if (ORIG.URL === undefined) delete process.env.GITLAB_URL;
		else process.env.GITLAB_URL = ORIG.URL;
		if (ORIG.ROOT === undefined) delete process.env.CIHEAL_DATA_ROOT;
		else process.env.CIHEAL_DATA_ROOT = ORIG.ROOT;
		rmSync(dataRoot, { recursive: true, force: true });
	});

	it("points GIT_ASKPASS at an executable script under the data root", () => {
		const env = gitEnv();
		const script = env.GIT_ASKPASS;
		expect(script).toBeDefined();
		expect(script).toContain(join(".home", "git-askpass.sh"));
		expect(existsSync(script!)).toBe(true);
		expect(statSync(script!).mode & 0o100).toBe(0o100); // executable
	});

	it("answers username with GitLab's oauth2 user", () => {
		const out = execFileSync("sh", [gitEnv().GIT_ASKPASS!, "Username for 'https://git.wemomo.com': "], {
			env: { GITLAB_TOKEN: token },
			encoding: "utf8",
		});
		expect(out.trim()).toBe("oauth2");
	});

	it("answers password with the token from env (not embedded in the script)", () => {
		const out = execFileSync("sh", [gitEnv().GIT_ASKPASS!, "Password for 'https://oauth2@git.wemomo.com': "], {
			env: { GITLAB_TOKEN: token },
			encoding: "utf8",
		});
		expect(out.trim()).toBe(token);
		const scriptBody = readFileSync(gitEnv().GIT_ASKPASS!, "utf8");
		expect(scriptBody).not.toContain(token); // 凭据绝不落盘
	});

	it("keeps terminal prompt disabled and drops the dead Bearer header", () => {
		const env = gitEnv();
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
		expect(env.GIT_HTTP_EXTRA_HEADER).toBeUndefined();
		expect(env.GITLAB_HOST).toBe("https://git.wemomo.com");
	});

	it("does not configure askpass when no token is set", () => {
		delete process.env.GITLAB_TOKEN;
		const env = gitEnv();
		expect(env.GIT_ASKPASS).toBeUndefined();
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
	});
});