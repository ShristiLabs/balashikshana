#!/usr/bin/env node
/**
 * Bundle-size measurement + budget gate (issue #67).
 *
 * The performance budget lives in docs/performance-budget.md; this
 * script is its repeatable measurement: after `npx expo export
 * --platform ios --platform android` (apps/mobile), it reads the
 * Hermes bytecode bundles from dist/, prints per-platform sizes, and
 * — with --check — exits 1 when any platform exceeds the budget.
 *
 * Exit codes: 0 within budget (or report-only), 1 over budget,
 * 2 no bundles found (run the export first).
 *
 * Usage:
 *   node scripts/measure-bundle-sizes.mjs            # report
 *   node scripts/measure-bundle-sizes.mjs --check    # enforce
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const jsRoot = join(repoRoot, "apps", "mobile", "dist", "_expo", "static", "js");

/**
 * Budget: per-platform Hermes bytecode ceiling. Baselines were MEASURED
 * on this branch (docs/performance-budget.md records the run); the
 * ceiling adds headroom for ordinary feature growth. Content packs are
 * NOT in the JS bundle (they download separately), so JS growth is code
 * only. Changing the ceiling is a budget decision: update the doc in
 * the same commit.
 */
const BUDGET_BYTES = 5_767_168; // 5.5 MiB per platform

if (!existsSync(jsRoot)) {
  console.error(`no export found at ${jsRoot}`);
  console.error("run: cd apps/mobile && npx expo export --platform ios --platform android");
  process.exit(2);
}

const platforms = readdirSync(jsRoot);
let overBudget = false;
const rows = [];
for (const platform of platforms.sort()) {
  const dir = join(jsRoot, platform);
  const bundles = readdirSync(dir).filter((name) => name.endsWith(".hbc"));
  if (bundles.length === 0) continue;
  const bytes = bundles.reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
  const mib = (bytes / (1024 * 1024)).toFixed(3);
  const budgetPct = ((bytes / BUDGET_BYTES) * 100).toFixed(1);
  const flag = bytes > BUDGET_BYTES ? "OVER BUDGET" : "within budget";
  rows.push(`${platform.padEnd(8)} ${String(bytes).padStart(9)} bytes  ${mib} MiB  ${budgetPct}% of budget  ${flag}`);
  if (bytes > BUDGET_BYTES) overBudget = true;
}

console.log("Hermes bytecode bundles (apps/mobile export):");
for (const row of rows) console.log(`  ${row}`);
console.log(`budget: ${BUDGET_BYTES} bytes (${(BUDGET_BYTES / (1024 * 1024)).toFixed(1)} MiB) per platform`);

if (process.argv.includes("--check") && overBudget) {
  console.error("FAIL: bundle budget exceeded");
  process.exit(1);
}
