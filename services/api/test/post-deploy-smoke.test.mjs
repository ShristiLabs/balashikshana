// Post-deploy smoke script tests (issue #64) — pure in-process checks: the
// smoke runner is exercised against a local mock server (node:http), no
// database, no network beyond loopback. Proves the deploy gate FAILS on the
// failure modes that matter (wrong seed count, unpublished pack index,
// portal down) and passes against faithful payload shapes.

import { test, describe, afterAll } from "vitest";
import assert from "node:assert/strict";
import http from "node:http";
import { runSmoke, DEFAULT_EXPECTED_QUESTIONS } from "../../../scripts/post-deploy-smoke.mjs";

let apiServer;
let portalServer;
let apiPort;
let portalPort;

const healthyFixtures = {
  "/api/health": {
    status: "ok",
    databaseEngine: "PostgreSQL (16.4)",
    totalGrades: 5,
    totalUnits: 130,
    totalSkillTopics: 614,
    totalPracticeQuestionsInDb: DEFAULT_EXPECTED_QUESTIONS,
    totalStudentsInDb: 0,
    totalQuestionAttemptsInDb: 0,
  },
  "/api/curriculum/summary": {
    summary: {
      totalGrades: 5,
      totalUnits: 130,
      totalSkillTopics: 614,
      totalPracticeQuestionsInDb: DEFAULT_EXPECTED_QUESTIONS,
    },
    grades: [{ gradeId: "pre-k", subjects: [] }],
  },
  "/api/practice/topic/K-M2/I": {
    // Served shape (verified live): unitId/unitTitle/topic/practiceProblems.
    unitId: "K-M2",
    unitTitle: "Numbers, Counting Forward/Back & Comparing up to 10",
    targetSpeedSec: 4.5,
    minAccuracyPercent: 80,
    topic: { topicId: "K-M2/I" },
    practiceProblems: Array.from({ length: 8 }, (_, i) => ({ questionId: `q-${i}` })),
  },
  "/api/content/packs": {
    formatVersion: 1,
    registryVersion: "test",
    packs: [{ gradeId: "pre-k", contentVersion: 1 }],
  },
};

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function fixtureHandler(overrides = {}) {
  return (req, res) => {
    const path = req.url.split("?")[0];
    const override = overrides[path];
    if (override) {
      res.writeHead(override.status, override.body ? { "content-type": "application/json" } : {});
      res.end(override.body ? JSON.stringify(override.body) : "");
      return;
    }
    const fixture = healthyFixtures[path];
    if (!fixture) {
      res.writeHead(404, { "content-type": "application/problem+json" });
      res.end(JSON.stringify({ title: "Not Found", status: 404 }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(fixture));
  };
}

afterAll(async () => {
  await Promise.allSettled([
    new Promise((r) => apiServer?.close(r)),
    new Promise((r) => portalServer?.close(r)),
  ]);
});

describe("post-deploy smoke gate", () => {
  test("all checks pass against faithful payload shapes (portal included)", async () => {
    apiServer = await startServer(fixtureHandler());
    portalServer = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><body>portal</body></html>");
    });
    const outcome = await runSmoke({
      baseUrl: `http://127.0.0.1:${apiServer.address().port}`,
      portalUrl: `http://127.0.0.1:${portalServer.address().port}`,
    });
    assert.deepEqual(outcome.failures, []);
    assert.equal(outcome.passed, true);
    assert.deepEqual(
      outcome.results.map((r) => r.check),
      ["health", "curriculum-summary", "practice-fetch", "pack-index", "portal-origin"]
    );
  });

  test("fails when the seeded question count drifts (partial migration/seed)", async () => {
    const server = await startServer(
      fixtureHandler({
        "/api/health": {
          status: 200,
          body: { ...healthyFixtures["/api/health"], totalPracticeQuestionsInDb: 42 },
        },
      })
    );
    const outcome = await runSmoke({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.equal(outcome.passed, false);
    assert.ok(
      outcome.failures.some((f) => f.includes("totalPracticeQuestionsInDb=6140")),
      "the seed-count drift must be reported"
    );
    await new Promise((r) => server.close(r));
  });

  test("fails when the content-pack index is unpublished (503)", async () => {
    const server = await startServer(
      fixtureHandler({
        "/api/content/packs": { status: 503, body: { title: "Content packs unavailable", status: 503 } },
      })
    );
    const outcome = await runSmoke({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.equal(outcome.passed, false);
    assert.ok(outcome.failures.some((f) => f.startsWith("pack-index:")));
    await new Promise((r) => server.close(r));
  });

  test("fails when the practice pipeline serves fewer questions than requested", async () => {
    const server = await startServer(
      fixtureHandler({
        "/api/practice/topic/K-M2/I": {
          status: 200,
          body: { unitId: "K-M2", practiceProblems: [{ questionId: "only-one" }] },
        },
      })
    );
    const outcome = await runSmoke({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.equal(outcome.passed, false);
    assert.ok(outcome.failures.some((f) => f.startsWith("practice-fetch:")));
    await new Promise((r) => server.close(r));
  });

  test("fails when the portal origin errors", async () => {
    const api = await startServer(fixtureHandler());
    const brokenPortal = await startServer((req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    });
    const outcome = await runSmoke({
      baseUrl: `http://127.0.0.1:${api.address().port}`,
      portalUrl: `http://127.0.0.1:${brokenPortal.address().port}`,
    });
    assert.equal(outcome.passed, false);
    assert.ok(outcome.failures.some((f) => f.startsWith("portal-origin:")));
    await Promise.all([new Promise((r) => api.close(r)), new Promise((r) => brokenPortal.close(r))]);
  });

  test("fails (never throws) when the API origin is unreachable", async () => {
    const outcome = await runSmoke({ baseUrl: "http://127.0.0.1:1" });
    assert.equal(outcome.passed, false);
    assert.ok(outcome.failures.some((f) => f.startsWith("health:")));
  });
});
