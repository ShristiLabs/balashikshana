import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  median,
  computeMotorBaselineSec,
  computeCognitiveTimeSec,
  evaluateMasteryGateAttempt,
  computeFluencyGrade,
  updateTopicMemoryStability,
  computeRetrievabilityPct,
  propagateImplicitDagCredit,
  generateProceduralQuestion,
  generateTopicPracticeSet
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

const unitMap = {};
const gradeMap = {};

for (const g of registry.grades) {
  gradeMap[g.gradeId] = g;
  for (const [subjKey, subj] of Object.entries(g.subjects)) {
    for (const u of subj.units) {
      unitMap[u.unitId] = {
        ...u,
        gradeId: g.gradeId,
        subject: subjKey,
        spacedRepetitionPolicy: g.spacedRepetitionPolicy
      };
    }
  }
}

function createDefaultStore() {
  return {
    activeStudentId: "stu-aarav-k",
    students: {
      "stu-aarav-k": {
        studentId: "stu-aarav-k",
        username: "aarav",
        pin: "1234",
        nickname: "Aarav",
        avatar: "🦁",
        ageYears: 5,
        currentGrade: "kindergarten",
        motorBaselineSec: 0.42,
        streakDays: 7,
        starCoins: 340,
        hearts: 5,
        createdAt: "2026-09-20T10:00:00Z",
        unitProgress: {
          "PK-M7": { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 93.0, bestMedianSpeedSec: 4.5, attemptsCount: 1, stabilityDays: 21.0, lastReviewedDaysAgo: 2, cpaStage: "PURE_ABSTRACT_SYMBOLIC" },
          "K-M1": { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 93.3, bestMedianSpeedSec: 3.4, attemptsCount: 2, stabilityDays: 8.0, lastReviewedDaysAgo: 2, cpaStage: "PICTORIAL_GHOST_FLASH_1S" },
          "K-M2": { status: "IN_PROGRESS", keyState: null, bestAccuracyPct: 90.0, bestMedianSpeedSec: 4.1, attemptsCount: 1, stabilityDays: 2.0, lastReviewedDaysAgo: 1, cpaStage: "PICTORIAL_STATIC" }
        },
        topicMastery: {
          "K-M1-A": { completed: true, crowns: 3, masteryScore: 100, accuracyPct: 100, medianSpeedSec: 3.0, fluencyGrade: 4, stabilityDays: 8.0, lastReviewedDaysAgo: 2 },
          "K-M1-B": { completed: true, crowns: 3, masteryScore: 95, accuracyPct: 95, medianSpeedSec: 3.2, fluencyGrade: 4, stabilityDays: 8.0, lastReviewedDaysAgo: 2 },
          "K-M1-C": { completed: true, crowns: 3, masteryScore: 92, accuracyPct: 92, medianSpeedSec: 3.5, fluencyGrade: 3, stabilityDays: 8.0, lastReviewedDaysAgo: 2 },
          "K-M1-D": { completed: true, crowns: 3, masteryScore: 90, accuracyPct: 90, medianSpeedSec: 3.6, fluencyGrade: 3, stabilityDays: 8.0, lastReviewedDaysAgo: 2 },
          "K-M1-E": { completed: true, crowns: 3, masteryScore: 94, accuracyPct: 94, medianSpeedSec: 3.4, fluencyGrade: 3, stabilityDays: 8.0, lastReviewedDaysAgo: 2 },
          "K-M1-F": { completed: true, crowns: 3, masteryScore: 91, accuracyPct: 91, medianSpeedSec: 3.7, fluencyGrade: 3, stabilityDays: 8.0, lastReviewedDaysAgo: 2 },
          "K-M1-AAA": { completed: true, crowns: 3, masteryScore: 96, accuracyPct: 96, medianSpeedSec: 3.3, fluencyGrade: 4, stabilityDays: 8.0, lastReviewedDaysAgo: 2 },
          "K-M2-G": { completed: true, crowns: 3, masteryScore: 92, accuracyPct: 92, medianSpeedSec: 3.8, fluencyGrade: 3, stabilityDays: 4.0, lastReviewedDaysAgo: 1 },
          "K-M2-H": { completed: true, crowns: 2, masteryScore: 88, accuracyPct: 88, medianSpeedSec: 4.2, fluencyGrade: 3, stabilityDays: 3.0, lastReviewedDaysAgo: 1 }
        },
        misconceptionCounts: {
          "forgot_to_reduce_second_addend_after_making_10": 2
        },
        gateHistory: [
          { timestamp: "2026-10-15T16:00:00Z", unitId: "K-M1", passed: true, overallAccuracyPct: 93.3, medianCogSpeedSec: 3.4, keyAwarded: "GOLD_KEY" }
        ]
      },
      "stu-maya-pk": {
        studentId: "stu-maya-pk",
        username: "maya",
        pin: "1234",
        nickname: "Maya",
        avatar: "🦊",
        ageYears: 4,
        currentGrade: "pre-k",
        motorBaselineSec: 0.55,
        streakDays: 4,
        starCoins: 140,
        hearts: 5,
        createdAt: "2026-10-01T10:00:00Z",
        unitProgress: {
          "PK-M1": { status: "IN_PROGRESS", keyState: null, bestAccuracyPct: 90.0, bestMedianSpeedSec: 4.2, attemptsCount: 1, stabilityDays: 4.0, lastReviewedDaysAgo: 1, cpaStage: "PICTORIAL_STATIC" }
        },
        topicMastery: {
          "PK-M1-A": { completed: true, crowns: 3, masteryScore: 100, accuracyPct: 100, medianSpeedSec: 3.8, fluencyGrade: 4, stabilityDays: 4.0, lastReviewedDaysAgo: 1 },
          "PK-M1-B": { completed: true, crowns: 3, masteryScore: 90, accuracyPct: 90, medianSpeedSec: 4.2, fluencyGrade: 3, stabilityDays: 4.0, lastReviewedDaysAgo: 1 }
        },
        misconceptionCounts: {},
        gateHistory: []
      },
      "stu-liam-g2": {
        studentId: "stu-liam-g2",
        username: "liam",
        pin: "1234",
        nickname: "Liam",
        avatar: "🚀",
        ageYears: 8,
        currentGrade: "grade-2",
        motorBaselineSec: 0.31,
        streakDays: 12,
        starCoins: 590,
        hearts: 5,
        createdAt: "2026-09-10T10:00:00Z",
        unitProgress: {
          "G1-M9": { status: "MASTERED", keyState: "GOLD_KEY", bestAccuracyPct: 95.0, bestMedianSpeedSec: 4.0, attemptsCount: 1, stabilityDays: 30.0, lastReviewedDaysAgo: 4, cpaStage: "PURE_ABSTRACT_SYMBOLIC" },
          "G2-M1": { status: "IN_PROGRESS", keyState: null, bestAccuracyPct: 94.0, bestMedianSpeedSec: 4.1, attemptsCount: 1, stabilityDays: 7.0, lastReviewedDaysAgo: 1, cpaStage: "PICTORIAL_GHOST_FLASH_1S" }
        },
        topicMastery: {
          "G2-M1-A": { completed: true, crowns: 3, masteryScore: 95, accuracyPct: 95, medianSpeedSec: 3.5, fluencyGrade: 4, stabilityDays: 7.0, lastReviewedDaysAgo: 1 },
          "G2-M1-B": { completed: true, crowns: 3, masteryScore: 92, accuracyPct: 92, medianSpeedSec: 3.9, fluencyGrade: 3, stabilityDays: 7.0, lastReviewedDaysAgo: 1 }
        },
        misconceptionCounts: {},
        gateHistory: []
      }
    }
  };
}

function loadStore() {
  const initial = createDefaultStore();
  if (fs.existsSync(STORE_PATH)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
      if (loaded && loaded.students && loaded.students["stu-aarav-k"]?.topicMastery?.["K-M1-C"]) {
        return loaded;
      }
    } catch (e) {}
  }
  saveStore(initial);
  return initial;
}

function saveStore(storeData) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(storeData, null, 2), "utf8");
}

const store = loadStore();

function summarizeStudent(stu) {
  const progs = Object.entries(stu.unitProgress || {});
  const topics = Object.values(stu.topicMastery || {});
  const completedTopicsCount = topics.filter((t) => t.completed).length;
  const masteredCount = progs.filter(([, p]) => p.status === "MASTERED").length;
  const goldKeys = progs.filter(([, p]) => p.keyState === "GOLD_KEY").length;
  const silverKeys = progs.filter(([, p]) => p.keyState === "SILVER_KEY").length;

  let dueReviews = 0;
  let totalRetrievability = 0;
  for (const t of topics) {
    const r = computeRetrievabilityPct(t.lastReviewedDaysAgo || 0, t.stabilityDays || 2);
    totalRetrievability += r;
    if (r < 80) dueReviews += 1;
  }
  const gardenHealthPct = topics.length > 0 ? Math.round(totalRetrievability / topics.length) : 100;

  return {
    studentId: stu.studentId,
    username: stu.username || stu.nickname.toLowerCase(),
    nickname: stu.nickname,
    avatar: stu.avatar,
    ageYears: stu.ageYears,
    currentGrade: stu.currentGrade,
    motorBaselineSec: stu.motorBaselineSec,
    streakDays: stu.streakDays || 1,
    starCoins: stu.starCoins || 100,
    hearts: stu.hearts || 5,
    completedTopicsCount,
    masteredUnitsCount: masteredCount,
    goldKeysCount: goldKeys,
    silverKeysCount: silverKeys,
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

  // POST /api/auth/login -> Single student login by studentId or username
  if (req.method === "POST" && pathname === "/api/auth/login") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        let found = null;
        if (payload.studentId && store.students[payload.studentId]) {
          found = store.students[payload.studentId];
        } else if (payload.username) {
          const uname = payload.username.trim().toLowerCase();
          found = Object.values(store.students).find(
            (s) => (s.username || "").toLowerCase() === uname || s.nickname.toLowerCase() === uname
          );
        }
        if (!found) return sendJson(res, 404, { error: "Student account not found" });
        store.activeStudentId = found.studentId;
        saveStore(store);
        return sendJson(res, 200, {
          student: found,
          summary: summarizeStudent(found)
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  // GET /api/students -> List available student accounts for login screen
  if (req.method === "GET" && pathname === "/api/students") {
    return sendJson(res, 200, {
      activeStudentId: store.activeStudentId,
      students: Object.values(store.students).map(summarizeStudent)
    });
  }

  // POST /api/students -> Sign up a new student account
  if (req.method === "POST" && pathname === "/api/students") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const nickname = (payload.nickname || "Explorer").trim();
        const username = (payload.username || nickname).toLowerCase().replace(/[^a-z0-9]/g, "");
        const gradeId = gradeMap[payload.currentGrade] ? payload.currentGrade : "kindergarten";
        const ageYears = Number(payload.ageYears) || 5;
        const avatar = payload.avatar || "🐼";
        const studentId = `stu-${username}-${Date.now().toString().slice(-4)}`;

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
          username,
          pin: payload.pin || "1234",
          nickname,
          avatar,
          ageYears,
          currentGrade: gradeId,
          motorBaselineSec: ageYears <= 4 ? 0.55 : ageYears <= 6 ? 0.44 : 0.34,
          streakDays: 1,
          starCoins: 50,
          hearts: 5,
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

  // GET /api/students/:studentId -> Get full student state
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

  // GET /api/practice/topic/:unitId/:topicCode -> Generate 8 Duolingo-style interactive practice problems for a specific topic
  if (req.method === "GET" && pathname.startsWith("/api/practice/topic/")) {
    const parts = pathname.replace("/api/practice/topic/", "").split("/");
    const unitId = parts[0];
    const topicCode = parts[1];
    const unit = unitMap[unitId];
    if (!unit) return sendJson(res, 404, { error: `Unit ${unitId} not found` });
    const topic = unit.skillTopics.find((t) => t.code === topicCode) || unit.skillTopics[0];
    const count = Number(url.searchParams.get("count") || 8);
    const problems = generateTopicPracticeSet(unit, topic, count);
    return sendJson(res, 200, {
      unitId: unit.unitId,
      unitTitle: unit.title,
      targetSpeedSec: unit.masteryGate.maxMedianResponseTimeSec,
      minAccuracyPercent: 80,
      topic: {
        code: topic.code,
        name: topic.name,
        assets: topic.assets
      },
      practiceProblems: problems
    });
  }

  // POST /api/practice/topic/complete -> Complete a topic practice node on the journey path
  if (req.method === "POST" && pathname === "/api/practice/topic/complete") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const studentId = payload.studentId || store.activeStudentId;
        const stu = store.students[studentId] || Object.values(store.students)[0];
        const unit = unitMap[payload.unitId];
        if (!unit) return sendJson(res, 404, { error: "Unit not found" });

        const topicCode = payload.topicCode;
        const responses = payload.responses || [];
        const motorSec = payload.motorBaselineSec || stu.motorBaselineSec || 0.42;
        const total = Math.max(1, responses.length);
        const correct = responses.filter((r) => r.isCorrect).length;
        const accPct = Number(((correct / total) * 100).toFixed(1));
        const cogTimes = responses.map((r) => computeCognitiveTimeSec(r.rawTimeSec || 3.0, motorSec, 0));
        const medSpeed = Number(median(cogTimes).toFixed(2));
        const targetSpeed = unit.masteryGate.maxMedianResponseTimeSec;

        const passedTopic = accPct >= 80;
        const crowns = accPct >= 95 && medSpeed <= targetSpeed ? 3 : accPct >= 85 ? 2 : passedTopic ? 1 : 0;

        const srPolicy = unit.spacedRepetitionPolicy || { stabilityGrowthFactor: 2.0, maxIntervalCapDays: 45 };
        const fullKey = `${unit.unitId}-${topicCode}`;
        const prevTopic = stu.topicMastery[fullKey] || { stabilityDays: 1.0, crowns: 0 };
        const fg = computeFluencyGrade(passedTopic, medSpeed, targetSpeed);
        const srUpdate = updateTopicMemoryStability({
          currentStabilityDays: prevTopic.stabilityDays,
          fluencyGrade: fg,
          gradeGrowthFactor: srPolicy.stabilityGrowthFactor,
          maxIntervalCapDays: srPolicy.maxIntervalCapDays
        });

        if (passedTopic) {
          stu.topicMastery[fullKey] = {
            completed: true,
            crowns: Math.max(prevTopic.crowns || 0, crowns),
            masteryScore: Math.round(accPct),
            accuracyPct: accPct,
            medianSpeedSec: medSpeed,
            fluencyGrade: fg,
            stabilityDays: srUpdate.stabilityDays,
            lastReviewedDaysAgo: 0
          };
          stu.starCoins = (stu.starCoins || 0) + 15 + crowns * 5;
        }

        // Check if all topics in this unit are now completed -> unlock Boss Gate
        const allTopicsDone = unit.skillTopics.every((t) => stu.topicMastery[`${unit.unitId}-${t.code}`]?.completed);
        if (!stu.unitProgress[unit.unitId]) {
          stu.unitProgress[unit.unitId] = {
            status: allTopicsDone ? "GATE_UNLOCKED" : "IN_PROGRESS",
            keyState: null,
            bestAccuracyPct: accPct,
            bestMedianSpeedSec: medSpeed,
            attemptsCount: 1,
            stabilityDays: srUpdate.stabilityDays,
            lastReviewedDaysAgo: 0,
            cpaStage: srUpdate.cpaStage
          };
        } else if (stu.unitProgress[unit.unitId].status !== "MASTERED" && allTopicsDone) {
          stu.unitProgress[unit.unitId].status = "GATE_UNLOCKED";
        }

        saveStore(store);

        return sendJson(res, 200, {
          passedTopic,
          crownsAwarded: crowns,
          accuracyPct: accPct,
          medianCogSpeedSec: medSpeed,
          targetSpeedSec: targetSpeed,
          bossGateUnlocked: allTopicsDone,
          spacedRepetition: srUpdate,
          student: stu,
          summary: summarizeStudent(stu)
        });
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
      questions.push(generateProceduralQuestion(unit, topic, i));
    }
    return sendJson(res, 200, { unit, generatedQuestions: questions });
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

        const nextKeyState = evalResult.passed
          ? (prevProg.keyState === "SILVER_KEY" || prevProg.keyState === "GOLD_KEY" ? "GOLD_KEY" : "SILVER_KEY")
          : prevProg.keyState;

        if (evalResult.passed) {
          for (const t of unit.skillTopics) {
            const fullKey = `${unit.unitId}-${t.code}`;
            stu.topicMastery[fullKey] = {
              completed: true,
              crowns: 3,
              masteryScore: 100,
              accuracyPct: evalResult.overallAccuracyPct,
              medianSpeedSec: evalResult.medianCogSpeedSec,
              fluencyGrade: fg,
              stabilityDays: srUpdate.stabilityDays,
              lastReviewedDaysAgo: 0
            };
          }
          stu.starCoins = (stu.starCoins || 0) + 50;
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

        saveStore(store);

        return sendJson(res, 200, {
          student: stu,
          summary: summarizeStudent(stu),
          evaluation: { ...evalResult, keyAwarded: nextKeyState },
          spacedRepetition: srUpdate
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
