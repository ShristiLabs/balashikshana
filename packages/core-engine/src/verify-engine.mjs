import fs from "node:fs";
import assert from "node:assert";
import {
  computeMotorBaselineSec,
  computeCognitiveTimeSec,
  evaluateMasteryGateAttempt,
  computeFluencyGrade,
  updateTopicMemoryStability,
  computeRetrievabilityPct,
  propagateImplicitDagCredit,
  generateProceduralQuestion,
  REMEDIATION_MODES
} from "./index.mjs";

const registry = JSON.parse(fs.readFileSync(new URL("../../../docs/us-curriculum-registry.json", import.meta.url), "utf8"));

// 1. Verify Motor Baseline & Cognitive Speed
const motor = computeMotorBaselineSec([0.42, 0.45, 0.40]);
assert(motor === 0.42, "Motor baseline should be median of 3 taps");
const cog = computeCognitiveTimeSec(3.42, motor, 0);
assert(cog === 3.0, "Cognitive time should subtract motor baseline");

// 2. Verify 5-Condition Mastery Gate Engine across a sample unit (PK-M1)
const sampleUnit = registry.grades[0].subjects.math.units[0];
const passingResponses = sampleUnit.skillTopics.flatMap((t) => [
  { topicCode: t.code, isCorrect: true, rawTimeSec: 3.5 },
  { topicCode: t.code, isCorrect: true, rawTimeSec: 3.8 },
  { topicCode: t.code, isCorrect: true, rawTimeSec: 4.0 }
]);
const passResult = evaluateMasteryGateAttempt({ unit: sampleUnit, responses: passingResponses, motorBaselineSec: motor });
assert(passResult.passed === true && passResult.keyAwarded === "SILVER_KEY", "Should pass when all 5 conditions hold");

// 3. Verify Low Automaticity Detection (High Accuracy, Slow Speed)
const slowResponses = sampleUnit.skillTopics.flatMap((t) => [
  { topicCode: t.code, isCorrect: true, rawTimeSec: 12.0 },
  { topicCode: t.code, isCorrect: true, rawTimeSec: 14.0 }
]);
const slowResult = evaluateMasteryGateAttempt({ unit: sampleUnit, responses: slowResponses, motorBaselineSec: motor });
assert(slowResult.passed === false && slowResult.remediationMode === REMEDIATION_MODES.LOW_AUTOMATICITY, "Should flag LOW_AUTOMATICITY when accurate but slow");

// 4. Verify Spaced Repetition FSRS & Procedural Question Generation across all 614 topics
let generatedCount = 0;
const unitMap = {};
for (const g of registry.grades) {
  for (const s of Object.values(g.subjects)) {
    for (const u of s.units) {
      unitMap[u.unitId] = u;
      for (const t of u.skillTopics) {
        const q = generateProceduralQuestion(u, t, generatedCount + 1);
        assert(q.prompt && q.choices.length >= 3 && q.correctAnswer, `Invalid question for ${u.unitId}-${t.code}`);
        generatedCount += 1;
      }
    }
  }
}

const srUpdate = updateTopicMemoryStability({ currentStabilityDays: 1.0, fluencyGrade: computeFluencyGrade(true, 2.5, 4.0), gradeGrowthFactor: 2.0, maxIntervalCapDays: 45 });
assert(srUpdate.stabilityDays > 1.0, "Stability should grow on fluent recall");
const fireCredits = propagateImplicitDagCredit("PK-M2", 2.0, unitMap, 0.4);
assert(fireCredits.length === 1 && fireCredits[0].prerequisiteUnitId === "PK-M1", "Should propagate FIRe implicit credit to PK-M1");
assert(computeRetrievabilityPct(srUpdate.stabilityDays, srUpdate.stabilityDays) === 80.0, "Retrievability at stability half-life should be 80%");

console.log(`[OK] Verified @balashikshana/core-engine across ${Object.keys(unitMap).length} units and ${generatedCount} skill topics!`);
