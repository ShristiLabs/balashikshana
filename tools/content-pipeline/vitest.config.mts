// Vitest configuration for the content-pipeline compiler suites.
//
// node:sqlite (the pack writer) is experimental on Node 22: the test
// script runs `NODE_OPTIONS=--experimental-sqlite vitest run` so both the
// main process and the workers can import it (see package.json).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/*.test.mjs"],
    // Full-registry builds run twice inside suites for determinism proofs.
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
