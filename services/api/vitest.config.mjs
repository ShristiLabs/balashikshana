// Vitest configuration for the API integration suites. Each test file
// boots the real Fastify server as a child process against its own
// throwaway PostgreSQL database (see test/helpers.mjs), so the cold-start
// path (migrations + seed of 6140 questions) needs generous timeouts.
// Suites target distinct ports and databases and run in parallel.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/*.test.mjs"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    teardownTimeout: 20_000
  }
});
