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
const DATA_DIR = path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "students-store.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));

// Build fast lookup maps for all 130 units and 614 topics
const unitMap = {};
const gradeMap = {};
const entryUnitsByGrade = {};

for (const g of registry.grades) {
  gradeMap[g.gradeId] = g;
  entryUnitsByGrade[g.gradeId] = [];
  for (const [subjKey, subj] of Object.entries(g.subjects)) {
    for (const u of subj.units) {
      unitMap[u.unitId] = {
        ...u,
        gradeId: g.gradeId,
        subject: subjKey,
        spacedRepetitionPolicy: g.spacedRepetitionPolicy
      };
      if (u.sequenceOrder === 1) {
        entryUnitsByGrade[g.gradeId].push(u.unitId);
      }
    }
  }
}

function createDefaultStore() {
  return {
    activeStudentId: "stu-aarav-k",
    students: {
      "stu-maya-pk": {
        studentId: "stu-maya-pk",
        nickname: "Maya",
        avatar: "🦊",
        ageYears: 4,
        currentGrade: "pre-k",
        motorBaselineSec: 0.55,
        streakDays: 4,
        starCoins: 140,
        createdAt: "2026-10-01T10:00:00Z",
        unitProgress: {
          "PK-M1": { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 91.7, bestMedianSpeedSec: 4.2, attemptsCount: 2, stabilityDays: 7.0, lastReviewedDaysAgo: 1, cpaStage: "PICTORIAL_GHOST_FLASH_1S" },
          "PK-M2": { status: "MASTERED", keyState: "SILVER_KEY", bestAccuracyPct: 86.0, bestMedianSpeedSec: 5.1, attemptsCount: 1, stabilityDays: 2.0, lastReviewedDaysAgo: 1, cpaStage: "PICTORIAL_STATIC" },
          "PK-M3": { status: "GATE_UNLOCKED", keyState: null, bestAccuracyPct: 78.0, bestMedianSpeedSec: 6.2, attemptsCount: 1, stabilityDays: 0.5, lastReviewedDaysAgo: 0, cpaStage: "CONCRETE_INTERACTIVE" },
          "PK-E1": { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 92.9, bestMedianSpeedSec: 3.9, attemptsCount: 1, stabilityDays: 12.0, lastReviewedDaysAgo: 2, cpaStage: "PURE_ABSTRACT_SYMBOLIC" }
        },
        topicMastery: {
          "PK-M1-A": { masteryScore: 100, accuracyPct: 100, medianSpeedSec: 3.8, fluencyGrade: 4, stabilityDays: 7.0 },
          "PK-M1-B": { masteryScore: 92, accuracyPct: 90, medianSpeedSec: 4.2, fluencyGrade: 3, stabilityDays: 7.0 },
          "PK-M2-E": { masteryScore: 88, accuracyPct: 86, medianSpeedSec: 5.1, fluencyGrade: 3, stabilityDays: 2.0 }
        },
        misconceptionCounts: {
          "one_to_one_correspondence_slip": 2,
          "alligator_symbol_direction_reversal": 1
        },
        gateHistory: [
          { timestamp: "2026-10-16T14:20:00Z", unitId: "PK-M1", passed: true, overallAccuracyPct: 91.7, medianCogSpeedSec: 4.2, keyAwarded: "GOLD_KEY" },
          { timestamp: "2026-10-17T15:10:00Z", unitId: "PK-M2", passed: true, overallAccuracyPct: 86.0, medianCogSpeedSec: 5.1, keyAwarded: "SILVER_KEY" }
        ]
      },
      "stu-aarav-k": {
        studentId: "stu-aarav-k",
        nickname: "Aarav",
        avatar: "🦁",
        ageYears: 5,
        currentGrade: "kindergarten",
        motorBaselineSec: 0.42,
        streakDays: 7,
        starCoins: 320,
        createdAt: "2026-09-20T10:00:00Z",
        unitProgress: {
          "PK-M7": { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 93.0, bestMedianSpeedSec: 4.5, attemptsCount: 1, stabilityDays: 21.0, lastReviewedDaysAgo: 5, cpaStage: "PURE_ABSTRACT_SYMBOLIC" },
          "K-M1": { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 93.3, bestMedianSpeedSec: 3.4, attemptsCount: 2, stabilityDays: 8.0, lastReviewedDaysAgo: 3, cpaStage: "PICTORIAL_GHOST_FLASH_1S" },
          "K-M2": { status: "MASTERED", keyState: "SILVER_KEY", bestAccuracyPct: 91.0, bestMedianSpeedSec: 4.1, attemptsCount: 1, stabilityDays: 2.0, lastReviewedDaysAgo: 2, cpaStage: "PICTORIAL_STATIC" },
          "K-M3": { status: "FLUENCY_READY", keyState: null, bestAccuracyPct: 92.0, bestMedianSpeedSec: 4.8, attemptsCount: 1, stabilityDays: 1.5, lastReviewedDaysAgo: 0, cpaStage: "PICTORIAL_STATIC" },
          "K-E1": { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 94.0, bestMedianSpeedSec: 3.5, attemptsCount: 1, stabilityDays: 15.0, lastReviewedDaysAgo: 2, cpaStage: "PURE_ABSTRACT_SYMBOLIC" },
          "K-S1": { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 90.0, bestMedianSpeedSec: 4.8, attemptsCount: 1, stabilityDays: 8.0, lastReviewedDaysAgo: 1, cpaStage: "PICTORIAL_GHOST_FLASH_1S" }
        },
        topicMastery: {
          "K-M1-A": { masteryScore: 100, accuracyPct: 100, medianSpeedSec: 3.1, fluencyGrade: 4, stabilityDays: 8.0 },
          "K-M2-G": { masteryScore: 90, accuracyPct: 91, medianSpeedSec: 4.1, fluencyGrade: 3, stabilityDays: 2.0 },
          "K-M3-O": { masteryScore: 85, accuracyPct: 92, medianSpeedSec: 4.8, fluencyGrade: 2, stabilityDays: 1.5 }
        },
        misconceptionCounts: {
          "forgot_to_reduce_second_addend_after_making_10": 3,
          "confused_sh_and_ch_digraphs": 1
        },
        gateHistory: [
          { timestamp: "2026-10-15T16:00:00Z", unitId: "K-M1", passed: true, overallAccuracyPct: 93.3, medianCogSpeedSec: 3.4, keyAwarded: "GOLD_KEY" },
          { timestamp: "2026-10-17T17:30:00Z", unitId: "K-M2", passed: true, overallAccuracyPct: 91.0, medianCogSpeedSec: 4.1, keyAwarded: "SILVER_KEY" }
        ]
      },
      "stu-liam-g2": {
        studentId: "stu-liam-g2",
        nickname: "Liam",
        avatar: "🚀",
        ageYears: 8,
        currentGrade: "grade-2",
        motorBaselineSec: 0.31,
        streakDays: 12,
        starCoins: 590,
        createdAt: "2026-09-10T10:00:00Z",
        unitProgress: {
          "G1-M9": { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 95.0, bestMedianSpeedSec: 4.0, attemptsCount: 1, stabilityDays: 30.0, lastReviewedDaysAgo: 4, cpaStage: "PURE_ABSTRACT_SYMBOLIC" },
          "G2-M1": { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 94.4, bestMedianSpeedSec: 4.2, attemptsCount: 1, stabilityDays: 15.0, lastReviewedDaysAgo: 2, cpaStage: "PURE_ABSTRACT_SYMBOLIC" },
          "G2-M2": { status: "MASTERED", keyState: "SILVER_KEY", bestAccuracyPct: 90.0, bestMedianSpeedSec: 3.2, attemptsCount: 2, stabilityDays: 3.0, lastReviewedDaysAgo: 1, cpaStage: "PICTORIAL_STATIC" },
          "G2-M3": { status: "REMEDIATION_REQUIRED", keyState: null, bestAccuracyPct: 93.8, bestMedianSpeedSec: 12.4, attemptsCount: 1, stabilityDays: 1.0, lastReviewedDaysAgo: 0, cpaStage: "CONCRETE_INTERACTIVE" },
          "G2-E1": { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 94.4, bestMedianSpeedSec: 3.9, attemptsCount: 1, stabilityDays: 15.0, lastReviewedDaysAgo: 3, cpaStage: "PURE_ABSTRACT_SYMBOLIC" }
        },
        topicMastery: {
          "G2-M1-L": { masteryScore: 96, accuracyPct: 95, medianSpeedSec: 4.0, fluencyGrade: 4, stabilityDays: 15.0 },
          "G2-M2-G": { masteryScore: 90, accuracyPct: 90, medianSpeedSec: 3.2, fluencyGrade: 3, stabilityDays: 3.0 },
          "G2-M3-N": { masteryScore: 78, accuracyPct: 93.8, medianSpeedSec: 12.4, fluencyGrade: 2, stabilityDays: 1.0 }
        },
        misconceptionCounts: {
          "subtracted_smaller_from_larger_0_minus_7_equals_7": 2,
          "swapped_hour_and_minute_hands": 2
        },
        gateHistory: [
          { timestamp: "2026-10-14T18:00:00Z", unitId: "G2-M1", passed: true, overallAccuracyPct: 94.4, medianCogSpeedSec: 4.2, keyAwarded: "GOLD_KEY" },
          { timestamp: "2026-10-17T18:20:00Z", unitId: "G2-M2", passed: true, overallAccuracyPct: 90.0, medianCogSpeedSec: 3.2, keyAwarded: "SILVER_KEY" },
          { timestamp: "2026-10-18T11:00:00Z", unitId: "G2-M3", passed: false, overallAccuracyPct: 93.8, medianCogSpeedSec: 12.4, keyAwarded: null }
        ]
      }
    }
  };
}

function loadStore() {
  if (fs.existsSync(STORE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    } catch (e) {}
  }
  const initial = createDefaultStore();
  saveStore(initial);
  return initial;
}

function saveStore(storeData) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(storeData, null, 2), "utf8");
}

const store = loadStore();

function summarizeStudent(stu) {
  const progs = Object.entries(stu.unitProgress || {});
  const masteredCount = progs.filter(([, p]) => p.status === "MASTERED").length;
  const goldKeys = progs.filter(([, p]) => p.keyState === "GOLD_KEY").length;
  const silverKeys = progs.filter(([, p]) => p.keyState === "SILVER_KEY").length;
  const accuracies = progs.map(([, p]) => p.bestAccuracyPct).filter((v) => typeof v === "number");
  const avgAccuracyPct = accuracies.length > 0
    ? Number((accuracies.reduce((a, b) => a + b, 0) / accuracies.length).toFixed(1))
    : 0;

  let dueReviews = 0;
  let totalRetrievability = 0;
  for (const [, p] of progs) {
    const r = computeRetrievabilityPct(p.lastReviewedDaysAgo || 0, p.stabilityDays || 1);
    totalRetrievability += r;
    if (r < 80 || p.keyState === "SILVER_KEY") dueReviews += 1;
  }
  const gardenHealthPct = progs.length > 0 ? Math.round(totalRetrievability / progs.length) : 100;

  return {
    studentId: stu.studentId,
    nickname: stu.nickname,
    avatar: stu.avatar,
    ageYears: stu.ageYears,
    currentGrade: stu.currentGrade,
    motorBaselineSec: stu.motorBaselineSec,
    streakDays: stu.streakDays,
    starCoins: stu.starCoins,
    masteredUnitsCount: masteredCount,
    totalUnitsTracked: progs.length,
    goldKeysCount: goldKeys,
    silverKeysCount: silverKeys,
    avgAccuracyPct,
    dueSpacedReviewsCount: dueReviews,
    gardenHealthPct
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
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
      totalSkillTopics: registry.summary.totalSkillTopics,
      totalStudents: Object.keys(store.students).length
    });
  }

  // GET /api/students -> List all student profiles + active student
  if (req.method === "GET" && pathname === "/api/students") {
    const list = Object.values(store.students).map(summarizeStudent);
    return sendJson(res, 200, {
      activeStudentId: store.activeStudentId,
      students: list
    });
  }

  // POST /api/students -> Create a new student profile
  if (req.method === "POST" && pathname === "/api/students") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const nickname = (payload.nickname || "New Explorer").trim();
        const gradeId = gradeMap[payload.currentGrade] ? payload.currentGrade : "kindergarten";
        const ageYears = Number(payload.ageYears) || (gradeId === "pre-k" ? 4 : gradeId === "kindergarten" ? 5 : gradeId === "grade-1" ? 6 : gradeId === "grade-2" ? 7 : 8);
        const avatar = payload.avatar || "🐼";
        const studentId = `stu-${nickname.toLowerCase().replace(/[^a-z0-9]/g, "")}-${Date.now().toString().slice(-4)}`;

        // Seed entry prerequisite units if starting above Pre-K so the student's grade entry units are unlocked
        const seededProgress = {};
        if (gradeId === "kindergarten") {
          seededProgress["PK-M7"] = { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 90, bestMedianSpeedSec: 5.0, attemptsCount: 1, stabilityDays: 14, lastReviewedDaysAgo: 1, cpaStage: "PURE_ABSTRACT_SYMBOLIC" };
          seededProgress["PK-E7"] = { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 90, bestMedianSpeedSec: 5.0, attemptsCount: 1, stabilityDays: 14, lastReviewedDaysAgo: 1, cpaStage: "PURE_ABSTRACT_SYMBOLIC" };
        } else if (gradeId === "grade-1") {
          for (const pid of ["K-M10", "K-E9", "K-S5", "K-SS4"]) {
            seededProgress[pid] = { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 90, bestMedianSpeedSec: 5.0, attemptsCount: 1, stabilityDays: 21, lastReviewedDaysAgo: 1, cpaStage: "PURE_ABSTRACT_SYMBOLIC" };
          }
        } else if (gradeId === "grade-2") {
          for (const pid of ["G1-M9", "G1-E10", "G1-S5", "G1-SS4"]) {
            seededProgress[pid] = { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 90, bestMedianSpeedSec: 5.0, attemptsCount: 1, stabilityDays: 30, lastReviewedDaysAgo: 1, cpaStage: "PURE_ABSTRACT_SYMBOLIC" };
          }
        } else if (gradeId === "grade-3") {
          for (const pid of ["G2-M9", "G2-E10", "G2-S6", "G2-SS4"]) {
            seededProgress[pid] = { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 90, bestMedianSpeedSec: 5.0, attemptsCount: 1, stabilityDays: 45, lastReviewedDaysAgo: 1, cpaStage: "PURE_ABSTRACT_SYMBOLIC" };
          }
        }

        const newStu = {
          studentId,
          nickname,
          avatar,
          ageYears,
          currentGrade: gradeId,
          motorBaselineSec: ageYears <= 4 ? 0.55 : ageYears <= 6 ? 0.44 : 0.34,
          streakDays: 1,
          starCoins: 50,
          createdAt: new Date().toISOString(),
          unitProgress: seededProgress,
          topicMastery: {},
          misconceptionCounts: {},
          gateHistory: []
        };

        store.students[studentId] = newStu;
        store.activeStudentId = studentId;
        saveStore(store);

        return sendJson(res, 201, {
          student: newStu,
          summary: summarizeStudent(newStu)
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  // GET /api/students/:studentId -> Get full student state & set active
  if (req.method === "GET" && pathname.startsWith("/api/students/")) {
    const studentId = pathname.replace("/api/students/", "");
    const stu = store.students[studentId];
    if (!stu) return sendJson(res, 404, { error: `Student ${studentId} not found` });
    store.activeStudentId = studentId;
    saveStore(store);
    return sendJson(res, 200, {
      student: stu,
      summary: summarizeStudent(stu)
    });
  }

  // POST /api/students/:studentId/calibrate -> Update student motor baseline
  if (req.method === "POST" && pathname.endsWith("/calibrate") && pathname.startsWith("/api/students/")) {
    const studentId = pathname.replace("/api/students/", "").replace("/calibrate", "");
    const stu = store.students[studentId];
    if (!stu) return sendJson(res, 404, { error: "Student not found" });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        if (Array.isArray(payload.warmupTapTimesSec)) {
          stu.motorBaselineSec = computeMotorBaselineSec(payload.warmupTapTimesSec);
        } else if (typeof payload.motorBaselineSec === "number") {
          stu.motorBaselineSec = payload.motorBaselineSec;
        }
        saveStore(store);
        return sendJson(res, 200, { student: stu, summary: summarizeStudent(stu) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    });
    return;
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
    const studentId = url.searchParams.get("studentId") || store.activeStudentId;
    const stu = store.students[studentId] || Object.values(store.students)[0];

    const quadrants = Object.entries(stu.unitProgress || {}).map(([uid, prog]) => {
      const u = unitMap[uid];
      const targetSpeed = u ? u.masteryGate.maxMedianResponseTimeSec : 5.0;
      const minAcc = u ? u.masteryGate.minAccuracyPercent : 90;
      const accOk = prog.bestAccuracyPct >= minAcc;
      const speedOk = prog.bestMedianSpeedSec <= targetSpeed;
      let quadrant = "FLUENT_MASTERY";
      if (accOk && !speedOk) quadrant = "ACCURATE_BUT_SLOW_NEEDS_FLUENCY";
      else if (!accOk && speedOk) quadrant = "IMPULSIVE_RUSHING";
      else if (!accOk && !speedOk) quadrant = "CONCEPTUAL_GAP";

      const retrievabilityPct = computeRetrievabilityPct(prog.lastReviewedDaysAgo || 0, prog.stabilityDays || 1);
      return {
        unitId: uid,
        unitTitle: u ? u.title : uid,
        status: prog.status,
        keyState: prog.keyState,
        bestAccuracyPct: prog.bestAccuracyPct,
        bestMedianSpeedSec: prog.bestMedianSpeedSec,
        targetSpeedSec: targetSpeed,
        attemptsCount: prog.attemptsCount || 1,
        cpaStage: prog.cpaStage || "CONCRETE_INTERACTIVE",
        quadrant,
        stabilityDays: prog.stabilityDays,
        retrievabilityPct,
        needsGardenWatering: retrievabilityPct < 80
      };
    });

    return sendJson(res, 200, {
      profile: summarizeStudent(stu),
      allStudentsComparison: Object.values(store.students).map(summarizeStudent),
      quadrants,
      topicMastery: stu.topicMastery || {},
      misconceptionCounts: stu.misconceptionCounts || {},
      gateHistory: (stu.gateHistory || []).slice(-15)
    });
  }

  if (req.method === "POST" && pathname === "/api/gate/evaluate") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const studentId = payload.studentId || store.activeStudentId;
        const stu = store.students[studentId] || Object.values(store.students)[0];
        const unit = unitMap[payload.unitId];
        if (!unit) return sendJson(res, 404, { error: "Unit not found" });

        const motorSec = payload.motorBaselineSec || stu.motorBaselineSec;
        const evalResult = evaluateMasteryGateAttempt({
          unit,
          responses: payload.responses || [],
          motorBaselineSec: motorSec
        });

        const srPolicy = unit.spacedRepetitionPolicy || { stabilityGrowthFactor: 2.0, maxIntervalCapDays: 45 };
        const fg = computeFluencyGrade(evalResult.passed, evalResult.medianCogSpeedSec, unit.masteryGate.maxMedianResponseTimeSec);
        const prevProg = stu.unitProgress[unit.unitId] || { stabilityDays: 1.0, attemptsCount: 0, keyState: null };
        const srUpdate = updateTopicMemoryStability({
          currentStabilityDays: prevProg.stabilityDays,
          fluencyGrade: fg,
          gradeGrowthFactor: srPolicy.stabilityGrowthFactor,
          maxIntervalCapDays: srPolicy.maxIntervalCapDays
        });

        // Upgrade SILVER_KEY -> GOLD_KEY if already held SILVER_KEY and passed verification
        const nextKeyState = evalResult.passed
          ? (prevProg.keyState === "SILVER_KEY" || prevProg.keyState === "GOLD_KEY" ? "GOLD_KEY" : "SILVER_KEY")
          : prevProg.keyState;

        const implicitCredits = evalResult.passed
          ? propagateImplicitDagCredit(unit.unitId, srUpdate.stabilityDays - prevProg.stabilityDays, unitMap, 0.4)
          : [];

        // Apply FIRe implicit credit to prerequisite units in this student's profile
        for (const cred of implicitCredits) {
          if (stu.unitProgress[cred.prerequisiteUnitId]) {
            stu.unitProgress[cred.prerequisiteUnitId].stabilityDays = Number(
              Math.min(srPolicy.maxIntervalCapDays, (stu.unitProgress[cred.prerequisiteUnitId].stabilityDays || 1) + Math.max(0.5, cred.implicitStabilityBoostDays)).toFixed(2)
            );
          }
        }

        // Update per-topic mastery breakdown for this student
        for (const tb of evalResult.topicBreakdown || []) {
          const fullTopicKey = `${unit.unitId}-${tb.code}`;
          stu.topicMastery[fullTopicKey] = {
            masteryScore: Math.round(tb.accuracyPct),
            accuracyPct: tb.accuracyPct,
            medianSpeedSec: tb.medianSpeedSec,
            fluencyGrade: computeFluencyGrade(tb.accuracyPct >= 75, tb.medianSpeedSec, unit.masteryGate.maxMedianResponseTimeSec),
            stabilityDays: srUpdate.stabilityDays
          };
        }

        // Track misconceptions if any errors occurred
        for (const r of payload.responses || []) {
          if (!r.isCorrect && Array.isArray(r.misconceptionTags)) {
            for (const tag of r.misconceptionTags) {
              stu.misconceptionCounts[tag] = (stu.misconceptionCounts[tag] || 0) + 1;
            }
          }
        }

        stu.unitProgress[unit.unitId] = {
          status: evalResult.passed ? "MASTERED" : "REMEDIATION_REQUIRED",
          keyState: nextKeyState,
          bestAccuracyPct: Math.max(prevProg.bestAccuracyPct || 0, evalResult.overallAccuracyPct),
          bestMedianSpeedSec: prevProg.bestMedianSpeedSec
            ? Math.min(prevProg.bestMedianSpeedSec, evalResult.medianCogSpeedSec)
            : evalResult.medianCogSpeedSec,
          attemptsCount: (prevProg.attemptsCount || 0) + 1,
          stabilityDays: srUpdate.stabilityDays,
          lastReviewedDaysAgo: 0,
          cpaStage: srUpdate.cpaStage
        };

        if (evalResult.passed) {
          stu.starCoins = (stu.starCoins || 0) + (nextKeyState === "GOLD_KEY" ? 50 : 30);
        }

        stu.gateHistory.push({
          timestamp: new Date().toISOString(),
          unitId: unit.unitId,
          ...evalResult,
          keyAwarded: nextKeyState
        });

        saveStore(store);

        return sendJson(res, 200, {
          studentSummary: summarizeStudent(stu),
          studentProgress: stu.unitProgress,
          evaluation: { ...evalResult, keyAwarded: nextKeyState },
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
