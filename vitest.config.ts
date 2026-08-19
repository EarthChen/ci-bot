import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		testTimeout: 60_000,
		hookTimeout: 60_000,
		// Worker subprocess tests spawn real child processes. singleFork keeps
		// one vitest worker for the whole suite (no cross-file parallelism) to
		// avoid e2e subprocess races; execArgv raises heap for that long-lived fork.
		pool: "forks",
		fileParallelism: false,
		poolOptions: {
			forks: {
				singleFork: true,
				execArgv: ["--max-old-space-size=8192"],
			},
		},
	},
});
