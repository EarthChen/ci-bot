import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Worker subprocess tests spawn real processes; keep them from racing CI.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
