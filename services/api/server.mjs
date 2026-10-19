import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeMotorBaselineSec,
  evaluateMasteryGateAttempt,
  computeFluencyGrade,
  updateTopicMemoryStability,
  computeRetrievabilityPct,
  propagateImplicitDagCredit,
  generateProceduralQuestion
} from "../../packages/core-engine/src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const REGISTRY_PATH = path.join(ROOT_DIR, "docs/us-curriculum-registry.json");

const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));

// Build fast lookup maps for all 130 units and 614 topics
const unitMap = {};
const gradeMap = {};
for (const g of registry.grades) {
  gradeMap[g.gradeId] = g;
  for (const [subjKey, subj] of Object.entries(g.subjects)) {
    for (const u of subj.units) {
      unitMap[u.unitId] = { ...u, gradeId: g.gradeId, subject: subjKey, spacedRepetitionPolicy: g.spacedRepetitionPolicy };
    }
  }
}

// In-memory + file-backed learner telemetry state for demo & parent analytics
const learnerState = {
  profile: {
    learnerId: "child-demo-01",
    nickname: "Aarav",
    currentGrade: "kindergarten",
    motorBaselineSec: 0.42,
    streakDays: 5,
    starCoins: 240
  },
  unitProgress: {
    "PK-M1": { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 92.0, bestMedianSpeedSec: 3.8, stabilityDays: 12.0, lastReviewedDaysAgo: 2 },
    "PK-M2": { status: "MASTERED", keyState: "SILVER_KEY", bestAccuracyPct: 91.7, bestMedianSpeedSec: 4.4, stabilityDays: 2.0, lastReviewedDaysAgo: 1 },
    "PK-M3": { status: "GATE_UNLOCKED", keyState: null, bestAccuracyPct: 83.3, bestMedianSpeedSec: 5.1, stabilityDays: 1.0, lastReviewedDaysAgo: 0 },
    "K-M1": { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 93.3, bestMedianSpeedSec: 3.4, stabilityDays: 8.0, lastReviewedDaysAgo: 3 },
    "K-M2": { status: "FLUENCY_READY", keyState: null, bestAccuracyPct: 88.0, bestMedianSpeedSec: 5.4, stabilityDays: 1.5, lastReviewedDaysAgo: 1 },
    "G1-M1": { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 94.0, bestMedianSpeedSec: 3.6, stabilityDays: 12.0, lastReviewedDaysAgo: 4 },
    "G2-M1": { status: "MASTERED", keyState: "SILVER_KEY", bestAccuracyPct: 90.0, bestMedianSpeedSec: 4.1, stabilityDays: 3.0, lastReviewedDaysAgo: 1 },
    "G3-M3": { status: "FLUENCY_READY", keyState: null, bestAccuracyPct: 95.0, bestMedianSpeedSec: 4.2, stabilityDays: 2.0, lastReviewedDaysAgo: 0 }
  },
  misconceptionCounts: {
    "forgot_to_reduce_second_addend_after_making_10": 3,
    "swapped_hour_and_minute_hands": 2,
    "subtracted_smaller_from_larger_0_minus_7_equals_7": 2,
    "confused_sh_and_ch_digraphs": 1
  },
  gateHistory: []
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname === "/api/health") {
    return sendJson(res, 200, {
      status: "ok",
      service: "balashikshana-api",
      totalGrades: registry.summary.totalGrades,
      totalUnits: registry.summary.totalUnits,
      totalSkillTopics: registry.summary.totalSkillTopics
    });
  }

  if (pathname === "/api/curriculum/summary") {
    return sendJson(res, 200, {
      summary: registry.summary,
      globalMasteryRules: registry.globalMasteryRules,
      grades: registry.grades.map((g) => ({
        gradeId: g.gradeId,
        gradeName: g.gradeName,
        targetAgeYears: g.targetAgeYears,
        spacedRepetitionPolicy: g.spacedRepetitionPolicy,
        subjects: Object.fromEntries(
          Object.entries(g.subjects).map(([k, v]) => [
            k,
            {
              totalUnits: v.units.length,
              totalSkillTopics: v.totalSkillTopics,
              units: v.units.map((u) => ({
                unitId: u.unitId,
                sequenceOrder: u.sequenceOrder,
                title: u.title,
                prerequisiteUnitIds: u.prerequisiteUnitIds,
                masteryGate: u.masteryGate,
                skillTopics: u.skillTopics.map((t) => ({ code: t.code, name: t.name }))
              }))
            }
          ])
        )
      }))
    });
  }

  if (pathname.startsWith("/api/curriculum/unit/")) {
    const unitId = pathname.replace("/api/curriculum/unit/", "");
    const unit = unitMap[unitId];
    if (!unit) return sendJson(res, 404, { error: `Unit ${unitId} not found` });
    const count = Number(url.searchParams.get("count") || unit.masteryGate.questionCount || 12);
    const questions = [];
    for (let i = 0; i < count; i++) {
      const topic = unit.skillTopics[i % unit.skillTopics.length];
      questions.push(generateProceduralQuestion(unit, topic, Date.now() + i * 17));
    }
    return sendJson(res, 200, { unit, generatedQuestions: questions });
  }

  if (pathname === "/api/parent/analytics") {
    const quadrants = Object.entries(learnerState.unitProgress).map(([uid, prog]) => {
      const u = unitMap[uid];
      const targetSpeed = u ? u.masteryGate.maxMedianResponseTimeSec : 5.0;
      const minAcc = u ? u.masteryGate.minAccuracyPercent : 90;
      const accOk = prog.bestAccuracyPct >= minAcc;
      const speedOk = prog.bestMedianSpeedSec <= targetSpeed;
      let quadrant = "FLUENT_MASTERY";
      if (accOk && !speedOk) quadrant = "ACCURATE_BUT_SLOW_NEEDS_FLUENCY";
      else if (!accOk && speedOk) quadrant = "IMPULSIVE_RUSHING";
      else if (!accOk && !speedOk) quadrant = "CONCEPTUAL_GAP";

      const retrievabilityPct = computeRetrievabilityPct(prog.lastReviewedDaysAgo, prog.stabilityDays);
      return {
        unitId: uid,
        unitTitle: u ? u.title : uid,
        status: prog.status,
        keyState: prog.keyState,
        bestAccuracyPct: prog.bestAccuracyPct,
        bestMedianSpeedSec: prog.bestMedianSpeedSec,
        targetSpeedSec: targetSpeed,
        quadrant,
        stabilityDays: prog.stabilityDays,
        retrievabilityPct,
        needsGardenWatering: retrievabilityPct < 80
      };
    });

    return sendJson(res, 200, {
      profile: learnerState.profile,
      quadrants,
      misconceptionCounts: learnerState.misconceptionCounts,
      gateHistory: learnerState.gateHistory.slice(-10)
    });
  }

  if (req.method === "POST" && pathname === "/api/gate/evaluate") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const unit = unitMap[payload.unitId];
        if (!unit) return sendJson(res, 404, { error: "Unit not found" });

        const motorSec = payload.motorBaselineSec || learnerState.profile.motorBaselineSec;
        const evalResult = evaluateMasteryGateAttempt({
          unit,
          responses: payload.responses || [],
          motorBaselineSec: motorSec
        });

        const srPolicy = unit.spacedRepetitionPolicy || { stabilityGrowthFactor: 2.0, maxIntervalCapDays: 45 };
        const fg = computeFluencyGrade(evalResult.passed, evalResult.medianCogSpeedSec, unit.masteryGate.maxMedianResponseTimeSec);
        const prevProg = learnerState.unitProgress[unit.unitId] || { stabilityDays: 1.0 };
        const srUpdate = updateTopicMemoryStability({
          currentStabilityDays: prevProg.stabilityDays,
          fluencyGrade: fg,
          gradeGrowthFactor: srPolicy.stabilityGrowthFactor,
          maxIntervalCapDays: srPolicy.maxIntervalCapDays
        });

        const implicitCredits = evalResult.passed
          ? propagateImplicitDagCredit(unit.unitId, srUpdate.stabilityDays - prevProg.stabilityDays, unitMap, 0.4)
          : [];

        learnerState.unitProgress[unit.unitId] = {
          status: evalResult.passed ? "MASTERED" : "REMEDIATION_REQUIRED",
          keyState: evalResult.passed ? "SILVER_KEY" : null,
          bestAccuracyPct: evalResult.overallAccuracyPct,
          bestMedianSpeedSec: evalResult.medianCogSpeedSec,
          stabilityDays: srUpdate.stabilityDays,
          lastReviewedDaysAgo: 0
        };
        learnerState.gateHistory.push({
          timestamp: new Date().toISOString(),
          unitId: unit.unitId,
          ...evalResult
        });

        return sendJson(res, 200, {
          evaluation: evalResult,
          spacedRepetition: srUpdate,
          implicitDagCredits: implicitCredits
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  return sendJson(res, 404, { error: "Route not found" });
});

const PORT = Number(process.env.PORT || 4000);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Balashikshana API] Listening on http://localhost:${PORT}`);
});
