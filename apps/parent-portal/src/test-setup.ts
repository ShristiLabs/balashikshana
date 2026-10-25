// Test setup: jest-dom matchers + explicit cleanup. RTL's auto-cleanup
// hooks the GLOBAL afterEach, which this suite does not enable
// (vitest runs with explicit imports), so cleanup is wired manually.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
