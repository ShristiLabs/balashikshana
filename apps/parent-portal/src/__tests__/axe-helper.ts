// Minimal structural type for jest-axe results in the canary test:
// jest-axe ships jest-typed results; under vitest we only need the
// violations array shape (id + nodes), which is stable across axe-core
// releases. Keeps the canary free of jest type imports.
export interface VitestAxeResults {
  violations: Array<{
    id: string;
    impact: string | null;
    nodes: object[];
  }>;
}
