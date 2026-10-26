#!/usr/bin/env node
/**
 * Bundle-size measurement + budget gate (issues #67, #71).
 *
 * The performance budget lives in docs/performance-budget.md; this
 * script is its repeatable measurement. After `npx expo export
 * --platform ios --platform android --platform web` (apps/mobile), it
 * reads the Hermes bytecode bundles (ios/android) and the plain-JS web
 * bundle from dist/, prints per-platform sizes, and — with --check —
 * exits 1 when any platform exceeds its budget.
 *
 * Web (#71): the web export ships plain JavaScript (no Hermes), so the
 * web platform sums the emitted .js chunks. The wasm binary
 * (public/vendor/sql-wasm.wasm, copied verbatim into the export) is
 * reported alongside but is NOT counted against the JS budget — it is a
 * static asset like the icons, cached by the service worker as shell.
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
 * Budget: per-platform ceiling. Native platforms measure Hermes
 * bytecode; web measures plain JS. Baselines were MEASURED on this
 * branch (docs/performance-budget.md records the run); the ceiling adds
 * headroom for ordinary feature growth. Content packs are NOT in the JS
 * bundle (they download separately), so JS growth is code only.
 * Changing a ceiling is a budget decision: update the doc in the same
 * commit.
 */
const BUDGET_BYTES = 5_767_168; // 5.5 MiB per platform (shared doctrine ceiling)

if (!existsSync(jsRoot)) {
  console.error(`no export found at ${jsRoot}`);
  console.error("run: cd apps/mobile && npx expo export --platform ios --platform android --platform web");
  process.exit(2);
}

const platforms = readdirSync(jsRoot);
let overBudget = false;
const rows = [];
let wasmNote = "";
for (const platform of platforms.sort()) {
  const dir = join(jsRoot, platform);
  const isWeb = platform === "web";
  // Native exports ship Hermes bytecode (.hbc); the web export ships
  // plain JS chunks (.js, no extension rewriting).
  const bundles = readdirSync(dir).filter((name) =>
    isWeb ? name.endsWith(".js") : name.endsWith(".hbc"),
  );
  if (bundles.length === 0) continue;
  const bytes = bundles.reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
  const mib = (bytes / (1024 * 1024)).toFixed(3);
  const budgetPct = ((bytes / BUDGET_BYTES) * 100).toFixed(1);
  const flag = bytes > BUDGET_BYTES ? "OVER BUDGET" : "within budget";
  rows.push(
    `${platform.padEnd(8)} ${String(bytes).padStart(9)} bytes  ${mib} MiB  ${budgetPct}% of budget  ${flag}` +
      (isWeb ? "  (plain JS chunks)" : "  (Hermes bytecode)"),
  );
  if (bytes > BUDGET_BYTES) overBudget = true;

  if (isWeb) {
    const wasm = join(repoRoot, "apps", "mobile", "dist", "vendor", "sql-wasm.wasm");
    if (existsSync(wasm)) {
      const wb = statSync(wasm).size;
      wasmNote = `  sql-wasm.wasm (static asset, not in JS budget): ${wb} bytes (${(wb / (1024 * 1024)).toFixed(3)} MiB)`;
    }
  }
}

console.log("Bundles (apps/mobile export):");
for (const row of rows) console.log(`  ${row}`);
if (wasmNote !== "") console.log(wasmNote);
console.log(`budget: ${BUDGET_BYTES} bytes (${(BUDGET_BYTES / (1024 * 1024)).toFixed(1)} MiB) per platform`);

if (process.argv.includes("--check") && overBudget) {
  console.error("FAIL: bundle budget exceeded");
  process.exit(1);
}
