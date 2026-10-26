#!/usr/bin/env node
/**
 * Post-deploy smoke test (issue #64).
 *
 * Promotes the CI curl sequence (.github/workflows/ci.yml "Smoke-Test
 * Migrations, Seed & Full Route Inventory") to a deploy-time gate:
 *
 *   1. GET /api/health                -> 200, status "ok",
 *      totalPracticeQuestionsInDb === expected (6,140 on a full seed)
 *   2. GET /api/curriculum/summary    -> 200, summary block with the same
 *      question count and a non-empty grade list
 *   3. GET /api/practice/topic/K-M2/I?count=8 -> 200, 8 generated questions
 *   4. GET /api/content/packs         -> 200 with a packs array (503 means
 *      the content-pack index was never published on this host)
 *   5. portal origin (optional)       -> 200 text/html
 *
 * Any failure exits non-zero so a deploy pipeline treats the release as
 * broken (issue #64 AC: "fails the deploy on any error"). Runs with zero
 * dependencies — plain Node 22 global fetch — so the same script gates
 * local dev, staging, and prod.
 *
 * Usage:
 *   node scripts/post-deploy-smoke.mjs [--base-url https://api...] \
 *       [--portal-url https://portal...] [--expected-questions 6140] [--count 8]
 */

import { pathToFileURL } from "node:url";

export const DEFAULT_BASE_URL = "http://127.0.0.1:4000";
export const DEFAULT_EXPECTED_QUESTIONS = 6140;
export const DEFAULT_TOPIC_QUERY = "K-M2/I";
export const DEFAULT_COUNT = 8;

async function fetchJson(fetchImpl, url, label, failures) {
  let response;
  const startedAt = Date.now();
  try {
    response = await fetchImpl(url, { redirect: "manual" });
  } catch (err) {
    failures.push(`${label}: request failed before a response arrived (${err?.message ?? err})`);
    return null;
  }
  const durationMs = Date.now() - startedAt;
  if (!response.ok) {
    failures.push(`${label}: expected HTTP 200, got ${response.status}`);
    return null;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    failures.push(`${label}: response body is not JSON`);
    return null;
  }
  return { body, durationMs };
}

/**
 * Runs all smoke checks against one API origin (and optionally a portal
 * origin). Returns { passed, failures, results } — never throws.
 */
export async function runSmoke({
  baseUrl = DEFAULT_BASE_URL,
  portalUrl = null,
  expectedQuestions = DEFAULT_EXPECTED_QUESTIONS,
  topicQuery = DEFAULT_TOPIC_QUERY,
  count = DEFAULT_COUNT,
  fetchImpl = fetch,
} = {}) {
  const failures = [];
  const results = [];
  const base = String(baseUrl).replace(/\/+$/, "");

  // 1. Health: server is up, DB migrated + seeded to the full curriculum.
  const health = await fetchJson(fetchImpl, `${base}/api/health`, "health", failures);
  if (health) {
    const questions = health.body?.totalPracticeQuestionsInDb;
    if (health.body?.status !== "ok") {
      failures.push(`health: expected status "ok", got ${JSON.stringify(health.body?.status)}`);
    }
    if (questions !== expectedQuestions) {
      failures.push(
        `health: expected totalPracticeQuestionsInDb=${expectedQuestions}, got ${questions}`
      );
    }
    results.push({ check: "health", ok: true, durationMs: health.durationMs, questions });
  }

  // 2. Curriculum summary: the registry seed is queryable end-to-end.
  const summary = await fetchJson(fetchImpl, `${base}/api/curriculum/summary`, "curriculum-summary", failures);
  if (summary) {
    const s = summary.body?.summary;
    if (!s || typeof s.totalGrades !== "number" || !Array.isArray(summary.body?.grades) || summary.body.grades.length === 0) {
      failures.push("curriculum-summary: malformed payload (missing summary block or empty grades list)");
    } else if (s.totalPracticeQuestionsInDb !== expectedQuestions) {
      failures.push(
        `curriculum-summary: expected totalPracticeQuestionsInDb=${expectedQuestions}, got ${s.totalPracticeQuestionsInDb}`
      );
    }
    results.push({ check: "curriculum-summary", ok: true, durationMs: summary.durationMs, grades: summary.body.grades.length });
  }

  // 3. Practice fetch: the practice pipeline serves questions for a topic.
  const practice = await fetchJson(
    fetchImpl,
    `${base}/api/practice/topic/${topicQuery}?count=${count}`,
    "practice-fetch",
    failures
  );
  if (practice) {
    // Served shape (server.mjs practice route): practiceProblems array.
    const problems = practice.body?.practiceProblems;
    if (!Array.isArray(problems) || problems.length !== count) {
      failures.push(`practice-fetch: expected ${count} practiceProblems, got ${Array.isArray(problems) ? problems.length : "not an array"}`);
    }
    results.push({ check: "practice-fetch", ok: true, durationMs: practice.durationMs, questions: Array.isArray(problems) ? problems.length : 0 });
  }

  // 4. Pack index: the compiled content-pack manifest is published. The API
  // answers 503 when no index exists — that is a deploy-time packaging
  // failure, not a pass.
  const packs = await fetchJson(fetchImpl, `${base}/api/content/packs`, "pack-index", failures);
  if (packs) {
    if (!Array.isArray(packs.body?.packs)) {
      failures.push("pack-index: malformed payload (missing packs array)");
    }
    results.push({ check: "pack-index", ok: true, durationMs: packs.durationMs, packs: Array.isArray(packs.body?.packs) ? packs.body.packs.length : 0 });
  }

  // 5. Portal origin (optional): static hosting answers with HTML.
  if (portalUrl) {
    const portal = String(portalUrl).replace(/\/+$/, "");
    let response;
    const startedAt = Date.now();
    try {
      response = await fetchImpl(portal, { redirect: "manual" });
    } catch (err) {
      failures.push(`portal-origin: request failed (${err?.message ?? err})`);
    }
    if (response) {
      const durationMs = Date.now() - startedAt;
      const contentType = String(response.headers?.get?.("content-type") ?? "");
      if (!response.ok) {
        failures.push(`portal-origin: expected HTTP 200, got ${response.status}`);
      } else if (!contentType.includes("text/html")) {
        failures.push(`portal-origin: expected text/html, got "${contentType}"`);
      }
      results.push({ check: "portal-origin", ok: true, durationMs, contentType });
    }
  }

  return { passed: failures.length === 0, failures, results };
}

function parseArgs(argv) {
  const args = { baseUrl: DEFAULT_BASE_URL, portalUrl: null, expectedQuestions: DEFAULT_EXPECTED_QUESTIONS, count: DEFAULT_COUNT };
  for (let i = 2; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--base-url") args.baseUrl = value;
    else if (flag === "--portal-url") args.portalUrl = value;
    else if (flag === "--expected-questions") args.expectedQuestions = Number(value);
    else if (flag === "--count") args.count = Number(value);
    else {
      console.error(`Unknown argument: ${flag}`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`Post-deploy smoke against ${args.baseUrl}${args.portalUrl ? ` (portal ${args.portalUrl})` : ""}`);
  const outcome = await runSmoke(args);
  for (const r of outcome.results) {
    console.log(`  ok   ${r.check} (${r.durationMs}ms)`);
  }
  if (outcome.passed) {
    console.log(`SMOKE PASS — ${outcome.results.length} checks green`);
    return 0;
  }
  for (const f of outcome.failures) {
    console.error(`  FAIL ${f}`);
  }
  console.error("SMOKE FAIL — deploy is not healthy; see failures above");
  return 1;
}

// CLI guard: run as a script when invoked directly, importable otherwise.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
