/**
 * @balashikshana/core-engine
 * Implements:
 * - Issue #2: Curriculum DAG Resolver & 5-Condition Mastery Gate Engine (Accuracy + Speed + Motor Calibration)
 * - Issue #3: Scientific Child-Calibrated Spaced Repetition Engine (FSRS, Lag +2/+5/+10, Two-Key Sleep Consolidation, FIRe DAG Credit, CPA Fading)
 * - Issue #7: Procedural Question & Smart Misconception Distractor Generator across all 614 Skill Topics
 * - Issue #55 (roadmap D9): Gamification reward rules — XP accrual, level curve, coin/crown derivation, streak days, badge catalog + evaluation (pure functions + data, shared offline/online)
 * - Issue #56 (roadmap D6): Grade-tiered hearts policy — the G2–G3 fluency-sprint mount predicate, bounded counts, loss/refill transitions, and session-outcome telemetry validation (pure functions + data, shared offline/online)
 * - Issue #57 (roadmap D5): Daily practice-reminder rules — parent-controlled local-notification scheduling policy (settings validation, next-occurrence time, schedule/cancel/hold plan; pure functions + data, default OFF)
 */

export * from "./rewards.mjs";
export * from "./hearts.mjs";
export * from "./reminders.mjs";

export const UNIT_STATES = {
  LOCKED: "LOCKED",
  STUDY_REQUIRED: "STUDY_REQUIRED",
  GUIDED_PRACTICE: "GUIDED_PRACTICE",
  FLUENCY_READY: "FLUENCY_READY",
  GATE_UNLOCKED: "GATE_UNLOCKED",
  MASTERED: "MASTERED",
  REMEDIATION_REQUIRED: "REMEDIATION_REQUIRED"
};

export const REMEDIATION_MODES = {
  NONE: "NONE",
  CONCEPT_GAP: "MODE_1_CONCEPT_GAP",
  IMPULSIVE_RUSHING: "MODE_2_IMPULSIVE_RUSHING",
  LOW_AUTOMATICITY: "MODE_3_LOW_AUTOMATICITY",
  SINGLE_TOPIC_BLINDSPOT: "MODE_4_SINGLE_TOPIC_BLINDSPOT"
};

export const CPA_STAGES = {
  CONCRETE: "CONCRETE_INTERACTIVE",
  PICTORIAL: "PICTORIAL_STATIC",
  GHOST_FLASH: "PICTORIAL_GHOST_FLASH_1S",
  ABSTRACT: "PURE_ABSTRACT_SYMBOLIC"
};

export function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values, p) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function computeMotorBaselineSec(warmupTapTimesSec = [0.45, 0.42, 0.48]) {
  const med = median(warmupTapTimesSec);
  return Math.max(0.15, Math.min(1.5, Number(med.toFixed(3))));
}

export function computeCognitiveTimeSec(rawTimeSec, motorBaselineSec = 0.45, audioPromptDurationSec = 0) {
  return Number(Math.max(0.5, rawTimeSec - motorBaselineSec - audioPromptDurationSec).toFixed(2));
}

export function evaluateMasteryGateAttempt({
  unit,
  responses,
  motorBaselineSec = 0.45,
  antiGuessingMinRawSec = 1.2
}) {
  const gate = unit.masteryGate;
  const totalItems = responses.length;
  if (totalItems === 0) {
    return { passed: false, reason: "No responses recorded", remediationMode: REMEDIATION_MODES.CONCEPT_GAP };
  }

  let correctCount = 0;
  let rapidGuessViolations = 0;
  const correctCogTimes = [];
  const allCogTimes = [];
  const byTopic = {};

  for (const t of unit.skillTopics) {
    byTopic[t.code] = { code: t.code, name: t.name, total: 0, correct: 0, cogTimes: [] };
  }

  for (const r of responses) {
    const cogSec = computeCognitiveTimeSec(r.rawTimeSec, motorBaselineSec, r.audioDurationSec || 0);
    allCogTimes.push(cogSec);
    if (!byTopic[r.topicCode]) {
      byTopic[r.topicCode] = { code: r.topicCode, name: r.topicCode, total: 0, correct: 0, cogTimes: [] };
    }
    byTopic[r.topicCode].total += 1;
    byTopic[r.topicCode].cogTimes.push(cogSec);

    if (r.isCorrect) {
      correctCount += 1;
      correctCogTimes.push(cogSec);
      byTopic[r.topicCode].correct += 1;
    } else if (r.rawTimeSec < antiGuessingMinRawSec) {
      rapidGuessViolations += 1;
    }
  }

  const overallAccuracyPct = Number(((correctCount / totalItems) * 100).toFixed(1));
  const medianCogSpeedSec = correctCogTimes.length > 0 ? Number(median(correctCogTimes).toFixed(2)) : Number(median(allCogTimes).toFixed(2));
  const p80CogSpeedSec = correctCogTimes.length > 0 ? Number(percentile(correctCogTimes, 80).toFixed(2)) : Number(percentile(allCogTimes, 80).toFixed(2));
  const maxTailAllowedSec = Number((gate.maxMedianResponseTimeSec * 1.3).toFixed(2));

  const failedTopics = [];
  const topicBreakdown = Object.values(byTopic).filter((b) => b.total > 0).map((b) => {
    const acc = Number(((b.correct / b.total) * 100).toFixed(1));
    const medSpeed = Number(median(b.cogTimes).toFixed(2));
    if (acc < 75) failedTopics.push(b.code);
    return { ...b, accuracyPct: acc, medianSpeedSec: medSpeed };
  });

  const streakReq = gate.challengeZoneStreak || 4;
  const tailSlice = responses.slice(-streakReq);
  const finalStreakPassed = tailSlice.length >= streakReq && tailSlice.every((r) => r.isCorrect);

  const conditions = {
    overallAccuracyPassed: overallAccuracyPct >= gate.minAccuracyPercent,
    perTopicFloorPassed: failedTopics.length === 0,
    medianSpeedPassed: medianCogSpeedSec <= gate.maxMedianResponseTimeSec && correctCount > 0,
    tailLatencyP80Passed: p80CogSpeedSec <= maxTailAllowedSec && correctCount > 0,
    challengeStreakAndNoGuessingPassed: finalStreakPassed && rapidGuessViolations === 0
  };

  const passed = Object.values(conditions).every(Boolean);

  let remediationMode = REMEDIATION_MODES.NONE;
  let remediationPrescription = "Mastery Achieved! Silver Key awarded & Next Unit unlocked.";

  if (!passed) {
    if (!conditions.overallAccuracyPassed && (rapidGuessViolations > 0 || median(allCogTimes) < gate.maxMedianResponseTimeSec * 0.5)) {
      remediationMode = REMEDIATION_MODES.IMPULSIVE_RUSHING;
      remediationPrescription = "Enable Think-First Turtle Mode (1.5s prompt reflection delay) in Guided Practice.";
    } else if (!conditions.overallAccuracyPassed) {
      remediationMode = REMEDIATION_MODES.CONCEPT_GAP;
      remediationPrescription = `Review Interactive Guidebook & Manipulative for topics: ${failedTopics.join(", ") || "core unit skills"}.`;
    } else if (conditions.overallAccuracyPassed && !conditions.perTopicFloorPassed) {
      remediationMode = REMEDIATION_MODES.SINGLE_TOPIC_BLINDSPOT;
      remediationPrescription = `Complete a focused Topic Practice session on sub-skill topic(s): ${failedTopics.join(", ")}.`;
    } else {
      remediationMode = REMEDIATION_MODES.LOW_AUTOMATICITY;
      remediationPrescription = `Accuracy is high (${overallAccuracyPct}%), but median speed (${medianCogSpeedSec}s) exceeded target (${gate.maxMedianResponseTimeSec}s). Practice again to build faster recall!`;
    }
  }

  return {
    passed,
    keyAwarded: passed ? "SILVER_KEY" : null,
    overallAccuracyPct,
    requiredAccuracyPct: gate.minAccuracyPercent,
    medianCogSpeedSec,
    targetSpeedSec: gate.maxMedianResponseTimeSec,
    p80CogSpeedSec,
    maxTailAllowedSec,
    rapidGuessViolations,
    finalStreakPassed,
    failedTopics,
    topicBreakdown,
    conditions,
    remediationMode,
    remediationPrescription
  };
}

export function computeFluencyGrade(isCorrect, cogTimeSec, targetSpeedSec) {
  if (!isCorrect) return 1;
  const ratio = cogTimeSec / targetSpeedSec;
  if (ratio > 1.25) return 2;
  if (ratio <= 0.75) return 4;
  return 3;
}

export function updateTopicMemoryStability({
  currentStabilityDays = 0.5,
  fluencyGrade,
  gradeGrowthFactor = 2.0,
  maxIntervalCapDays = 45
}) {
  let nextStability = currentStabilityDays;
  if (fluencyGrade === 1) {
    nextStability = Math.max(0.5, currentStabilityDays * 0.25);
  } else if (fluencyGrade === 2) {
    nextStability = Math.min(maxIntervalCapDays, Math.max(1.0, currentStabilityDays * 1.2));
  } else if (fluencyGrade === 3) {
    nextStability = Math.min(maxIntervalCapDays, Math.max(1.0, currentStabilityDays * gradeGrowthFactor));
  } else if (fluencyGrade === 4) {
    nextStability = Math.min(maxIntervalCapDays, Math.max(1.5, currentStabilityDays * (gradeGrowthFactor + 0.35)));
  }
  nextStability = Number(nextStability.toFixed(2));

  let cpaStage = CPA_STAGES.CONCRETE;
  if (nextStability >= 10) cpaStage = CPA_STAGES.ABSTRACT;
  else if (nextStability >= 4) cpaStage = CPA_STAGES.GHOST_FLASH;
  else if (nextStability >= 1) cpaStage = CPA_STAGES.PICTORIAL;

  return {
    stabilityDays: nextStability,
    cpaStage,
    intraSessionExpandingLags: fluencyGrade <= 2 ? [2, 5, 10] : []
  };
}

export function computeRetrievabilityPct(elapsedDays, stabilityDays = 1.0) {
  if (stabilityDays <= 0) return 0;
  const r = Math.pow(0.8, elapsedDays / stabilityDays);
  return Number(Math.max(0, Math.min(100, r * 100)).toFixed(1));
}

export function propagateImplicitDagCredit(unitId, deltaStabilityDays, unitMap, creditWeight = 0.4) {
  const unit = unitMap[unitId];
  if (!unit || !unit.prerequisiteUnitIds) return [];
  const credited = [];
  for (const prereqId of unit.prerequisiteUnitIds) {
    credited.push({
      prerequisiteUnitId: prereqId,
      implicitStabilityBoostDays: Number((deltaStabilityDays * creditWeight).toFixed(2))
    });
  }
  return credited;
}

function uniqueChoices(correct, candidates) {
  const set = new Set([String(correct)]);
  for (const c of candidates) {
    if (set.size >= 4) break;
    if (c !== undefined && c !== null && String(c) !== "") {
      set.add(String(c));
    }
  }
  let fallback = 1;
  while (set.size < 4) {
    set.add(`${correct} (${fallback++})`);
  }
  return Array.from(set).slice(0, 4);
}

/**
 * Rich, multi-format Duolingo-style Procedural Practice Problem Generator
 * Generates distinct problems for any (unit, topic, variantIndex) across all 614 Skill Topics.
 */
export function generateProceduralQuestion(unit, topic, seed = 0) {
  const variant = Math.abs(Number(seed)) % 12;
  const titleL = `${unit.title} ${topic.name}`.toLowerCase();
  const numMatches = `${topic.name} ${unit.title}`.match(/\b\d[\d,]*\b/g);
  const parsedNums = numMatches ? numMatches.map((s) => Number(s.replace(/,/g, ""))).filter((n) => n > 0) : [];
  const bound = parsedNums.length > 0 ? parsedNums[0] : (unit.unitId.startsWith("PK") ? 5 : unit.unitId.startsWith("K") ? 10 : unit.unitId.startsWith("G1") ? 20 : unit.unitId.startsWith("G2") ? 100 : 1000);
  const visualSvg = topic.assets?.images?.primaryIllustrationSvg || "assets/images/ten_frame_and_number_line.svg";
  const emojis = ["🍎", "🌟", "🍓", "🦋", "🐢", "🎈", "🍪", "🐠"];
  const emoji = emojis[variant % emojis.length];

  // 1. Always include the topic's curated sample bank items for variants 0, 1, 2 if they are domain-rich
  const sampleBank = topic.assets?.quizzes?.sampleQuestions || [];

  // MATH TRACK PROCEDURAL GENERATORS
  if (unit.unitId.includes("-M")) {
    // A. Counting & Numbers up to bound (3, 5, 7, 9, 10, 20, 30, 100, 120)
    if (titleL.includes("count") || titleL.includes("numbers to") || titleL.includes("identify numbers") || titleL.includes("teen")) {
      const cap = Math.min(20, Math.max(3, bound));
      const n = ((variant * 3 + 1) % cap) + 1;
      if (variant % 3 === 0) {
        return {
          questionId: `q_${unit.unitId}_${topic.code}_${variant}`,
          unitId: unit.unitId,
          topicCode: topic.code,
          topicName: topic.name,
          interactionType: "interactive-counter",
          targetCount: n,
          maxCounterCells: cap <= 5 ? 5 : cap <= 10 ? 10 : 20,
          counterEmoji: emoji,
          prompt: `Tap the frame to place exactly ${n} ${emoji} counters!`,
          visualAid: visualSvg,
          choices: uniqueChoices(n, [n + 1, Math.max(1, n - 1), n + 2]),
          correctAnswer: `${n}`,
          misconceptionTags: ["one_to_one_counting_slip"],
          explanation: `Count each ${emoji} one by one up to ${n}. The last number you say (${n}) is the total!`
        };
      } else if (variant % 3 === 1) {
        const displayRow = Array.from({ length: n }, () => emoji).join(" ");
        return {
          questionId: `q_${unit.unitId}_${topic.code}_${variant}`,
          unitId: unit.unitId,
          topicCode: topic.code,
          topicName: topic.name,
          interactionType: "multiple-choice",
          visualObjects: displayRow,
          prompt: `How many ${emoji} are there in total?`,
          visualAid: visualSvg,
          choices: uniqueChoices(n, [n + 1, Math.max(0, n - 1), n + 2]),
          correctAnswer: `${n}`,
          misconceptionTags: ["cardinality_count_slip"],
          explanation: `Point and count in order: 1 to ${n}. There are ${n} ${emoji}.`
        };
      } else {
        const start = Math.max(1, n - 1);
        const seq = [String(start), String(start + 1), String(start + 2)];
        return {
          questionId: `q_${unit.unitId}_${topic.code}_${variant}`,
          unitId: unit.unitId,
          topicCode: topic.code,
          topicName: topic.name,
          interactionType: "tile-builder",
          tileBank: [String(start + 2), String(start), String(start + 1), String(start + 4)],
          prompt: `Tap the number tiles to put ${start}, ${start + 1}, and ${start + 2} in counting order:`,
          visualAid: visualSvg,
          choices: uniqueChoices(seq.join(" "), [`${start + 2} ${start + 1} ${start}`, `${start} ${start + 2} ${start + 1}`, `${start + 1} ${start} ${start + 2}`]),
          correctAnswer: seq.join(" "),
          misconceptionTags: ["number_order_reversal"],
          explanation: `Counting forward goes ${start} -> ${start + 1} -> ${start + 2}.`
        };
      }
    }

    // B. One More / One Less & Comparing
    if (titleL.includes("one more") || titleL.includes("one less") || titleL.includes("compar") || titleL.includes("more") || titleL.includes("fewer")) {
      const cap = Math.min(100, Math.max(5, bound));
      const a = ((variant * 5 + 2) % cap) + 1;
      const b = ((variant * 3 + 4) % cap) + 1 === a ? a + 2 : ((variant * 3 + 4) % cap) + 1;
      if (titleL.includes("one more") || (variant % 3 === 0 && titleL.includes("one less"))) {
        const isMore = variant % 2 === 0;
        const ans = isMore ? a + 1 : Math.max(0, a - 1);
        return {
          questionId: `q_${unit.unitId}_${topic.code}_${variant}`,
          unitId: unit.unitId,
          topicCode: topic.code,
          topicName: topic.name,
          interactionType: "multiple-choice",
          visualObjects: Array.from({ length: Math.min(12, a) }, () => emoji).join(" "),
          prompt: `What number is 1 ${isMore ? "MORE" : "LESS"} than ${a}?`,
          visualAid: visualSvg,
          choices: uniqueChoices(ans, [isMore ? Math.max(0, a - 1) : a + 1, a, a + 2]),
          correctAnswer: `${ans}`,
          misconceptionTags: ["confused_one_more_and_one_less"],
          explanation: `1 ${isMore ? "more" : "less"} than ${a} is ${a} ${isMore ? "+ 1" : "- 1"} = ${ans}.`
        };
      }
      const sym = a > b ? ">" : "<";
      const wrongSym = a > b ? "<" : ">";
      return {
        questionId: `q_${unit.unitId}_${topic.code}_${variant}`,
        unitId: unit.unitId,
        topicCode: topic.code,
        topicName: topic.name,
        interactionType: "multiple-choice",
        prompt: `Compare the two numbers: ${a} ___ ${b}`,
        visualAid: visualSvg,
        choices: uniqueChoices(`${a} ${sym} ${b}`, [`${a} ${wrongSym} ${b}`, `${a} = ${b}`, `Both are equal`]),
        correctAnswer: `${a} ${sym} ${b}`,
        misconceptionTags: ["alligator_symbol_direction_reversal"],
        explanation: `${a} is ${a > b ? "greater" : "less"} than ${b}, so the symbol points to the smaller number: ${a} ${sym} ${b}.`
      };
    }

    // C. Addition & Subtraction (up to 5, 10, 20, 100, 1000)
    if (titleL.includes("add") || titleL.includes("subtract") || titleL.includes("take apart") || titleL.includes("mixed operation") || titleL.includes("equation")) {
      const isSub = titleL.includes("subtract") || (titleL.includes("mixed") && variant % 2 === 1);
      const maxVal = bound <= 5 ? 5 : bound <= 10 ? 10 : bound <= 20 ? 20 : bound <= 100 ? 90 : 500;
      const a = isSub
        ? Math.min(maxVal, ((variant * 7 + 5) % Math.max(4, maxVal - 2)) + 3)
        : Math.min(Math.floor(maxVal / 2), ((variant * 4 + 1) % Math.max(3, Math.floor(maxVal / 2))) + 1);
      const b = isSub
        ? ((variant * 3 + 1) % Math.max(2, a - 1)) + 1
        : ((variant * 5 + 2) % Math.max(3, maxVal - a)) + 1;
      const ans = isSub ? a - b : a + b;
      const op = isSub ? "-" : "+";

      if (variant % 3 === 2) {
        return {
          questionId: `q_${unit.unitId}_${topic.code}_${variant}`,
          unitId: unit.unitId,
          topicCode: topic.code,
          topicName: topic.name,
          interactionType: "tile-builder",
          tileBank: [`${a}`, `${op}`, `${b}`, `=`, `${ans}`, `${ans + 2}`],
          prompt: `Build the complete ${isSub ? "subtraction" : "addition"} equation for ${a} ${op} ${b}:`,
          visualAid: visualSvg,
          choices: uniqueChoices(`${a} ${op} ${b} = ${ans}`, [`${a} ${op} ${b} = ${ans + 1}`, `${b} ${op} ${a} = ${ans + 2}`, `${a} = ${b}`]),
          correctAnswer: `${a} ${op} ${b} = ${ans}`,
          misconceptionTags: ["equation_structure_error"],
          explanation: `${a} ${op} ${b} equals ${ans}.`
        };
      }

      return {
        questionId: `q_${unit.unitId}_${topic.code}_${variant}`,
        unitId: unit.unitId,
        topicCode: topic.code,
        topicName: topic.name,
        interactionType: "multiple-choice",
        visualObjects: maxVal <= 10 ? `${Array.from({ length: a }, () => "🟦").join("")} ${op} ${Array.from({ length: b }, () => "🟧").join("")}` : undefined,
        prompt: variant % 2 === 0
          ? `Solve: ${a} ${op} ${b} = ?`
          : `Find the missing number: ${a} ${op} ? = ${ans}`,
        visualAid: visualSvg,
        choices: variant % 2 === 0
          ? uniqueChoices(ans, [ans + 1, Math.max(0, ans - 1), isSub ? a + b : Math.abs(a - b), ans + 10])
          : uniqueChoices(b, [b + 1, Math.max(0, b - 1), ans, a]),
        correctAnswer: variant % 2 === 0 ? `${ans}` : `${b}`,
        misconceptionTags: ["off_by_one_computation", "wrong_operation_direction"],
        explanation: `${a} ${op} ${b} = ${ans}.`
      };
    }

    // D. Multiplication & Division
    if (titleL.includes("multipl") || titleL.includes("divi") || titleL.includes("array") || titleL.includes("factor")) {
      const isDiv = titleL.includes("divi") && !titleL.includes("multipl") ? true : (titleL.includes("mixed") && variant % 2 === 1);
      const f1 = (variant % 9) + 2;
      const f2 = ((variant * 3 + 1) % 9) + 2;
      const prod = f1 * f2;
      if (isDiv) {
        return {
          questionId: `q_${unit.unitId}_${topic.code}_${variant}`,
          unitId: unit.unitId,
          topicCode: topic.code,
          topicName: topic.name,
          interactionType: "multiple-choice",
          prompt: variant % 2 === 0
            ? `Divide ${prod} objects equally into ${f1} groups: ${prod} ÷ ${f1} = ?`
            : `Unknown factor: ${f1} × ? = ${prod}  (so ${prod} ÷ ${f1} = ?)`,
          visualAid: "assets/images/multiplication_array_slicer.svg",
          choices: uniqueChoices(f2, [f2 + 1, Math.max(1, f2 - 1), f1 + f2, prod - f1]),
          correctAnswer: `${f2}`,
          misconceptionTags: ["inverse_multiplication_slip"],
          explanation: `Since ${f1} × ${f2} = ${prod}, ${prod} ÷ ${f1} = ${f2}.`
        };
      }
      return {
        questionId: `q_${unit.unitId}_${topic.code}_${variant}`,
        unitId: unit.unitId,
        topicCode: topic.code,
        topicName: topic.name,
        interactionType: "multiple-choice",
        prompt: variant % 2 === 0
          ? `Multiply ${f1} rows of ${f2}: ${f1} × ${f2} = ?`
          : `Break apart ${f1} × ${f2} using Distributive Property: (${f1} × ${f2 - 1}) + (${f1} × 1) = ?`,
        visualAid: "assets/images/multiplication_array_slicer.svg",
        choices: uniqueChoices(prod, [prod + f1, Math.max(1, prod - f2), f1 + f2, prod + 2]),
        correctAnswer: `${prod}`,
        misconceptionTags: ["added_factors_instead_of_multiplying", "table_recall_slip"],
        explanation: `${f1} groups of ${f2} equals ${prod}.`
      };
    }
  }

  // ELA TRACK PROCEDURAL GENERATORS
  if (unit.unitId.includes("-E")) {
    const letterMatch = topic.name.match(/letter\s+([A-Z])/i);
    if (letterMatch || titleL.includes("letter") || titleL.includes("alphabet") || titleL.includes("uppercase") || titleL.includes("lowercase")) {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const targetUpper = letterMatch ? letterMatch[1].toUpperCase() : alphabet[(variant * 3 + topic.code.charCodeAt(0)) % 26];
      const targetLower = targetUpper.toLowerCase();
      const wordsByLetter = {
        A: "Apple 🍎", B: "Bear 🐻", C: "Cat 🐱", D: "Dog 🐶", E: "Elephant 🐘", F: "Fish 🐟",
        G: "Goat 🐐", H: "Hat 🎩", I: "Igloo 🧊", J: "Jam 🍓", K: "Kite 🪁", L: "Lion 🦁",
        M: "Moon 🌙", N: "Nest 🪺", O: "Octopus 🐙", P: "Pig 🐷", Q: "Queen 👑", R: "Rabbit 🐰",
        S: "Sun ☀️", T: "Turtle 🐢", U: "Umbrella ☂️", V: "Van 🚐", W: "Whale 🐋", X: "X-ray 🩻",
        Y: "Yo-yo 🪀", Z: "Zebra 🦓"
      };
      if (variant % 3 === 0) {
        return {
          questionId: `q_${unit.unitId}_${topic.code}_${variant}`,
          unitId: unit.unitId,
          topicCode: topic.code,
          topicName: topic.name,
          interactionType: "multiple-choice",
          prompt: `Match the uppercase letter "${targetUpper}" to its lowercase partner:`,
          visualAid: visualSvg,
          choices: uniqueChoices(targetLower, [
            alphabet[(alphabet.indexOf(targetUpper) + 1) % 26].toLowerCase(),
            alphabet[(alphabet.indexOf(targetUpper) + 3) % 26].toLowerCase(),
            alphabet[(alphabet.indexOf(targetUpper) + 5) % 26].toLowerCase()
          ]),
          correctAnswer: targetLower,
          misconceptionTags: ["case_matching_confusion"],
          explanation: `Uppercase "${targetUpper}" and lowercase "${targetLower}" are the same letter!`
        };
      } else if (variant % 3 === 1) {
        const word = wordsByLetter[targetUpper];
        return {
          questionId: `q_${unit.unitId}_${topic.code}_${variant}`,
          unitId: unit.unitId,
          topicCode: topic.code,
          topicName: topic.name,
          interactionType: "multiple-choice",
          prompt: `Which word starts with the letter "${targetUpper}" (${targetLower}) sound?`,
          visualAid: visualSvg,
          choices: uniqueChoices(word, [
            wordsByLetter[alphabet[(alphabet.indexOf(targetUpper) + 2) % 26]],
            wordsByLetter[alphabet[(alphabet.indexOf(targetUpper) + 4) % 26]],
            wordsByLetter[alphabet[(alphabet.indexOf(targetUpper) + 7) % 26]]
          ]),
          correctAnswer: word,
          misconceptionTags: ["initial_phoneme_confusion"],
          explanation: `${word} begins with the letter ${targetUpper} (${targetLower}).`
        };
      }
    }

    if (titleL.includes("short ") || titleL.includes("vowel") || titleL.includes("phoneme") || titleL.includes("blend") || titleL.includes("digraph") || titleL.includes("rhyme")) {
      const cvcBank = [
        { word: "cat", sounds: ["c", "a", "t"], vowel: "short a", rhyme: "hat", pic: "🐱" },
        { word: "fan", sounds: ["f", "a", "n"], vowel: "short a", rhyme: "pan", pic: "🪭" },
        { word: "bed", sounds: ["b", "e", "d"], vowel: "short e", rhyme: "red", pic: "🛏️" },
        { word: "hen", sounds: ["h", "e", "n"], vowel: "short e", rhyme: "pen", pic: "🐔" },
        { word: "pig", sounds: ["p", "i", "g"], vowel: "short i", rhyme: "wig", pic: "🐷" },
        { word: "fin", sounds: ["f", "i", "n"], vowel: "short i", rhyme: "pin", pic: "🦈" },
        { word: "dog", sounds: ["d", "o", "g"], vowel: "short o", rhyme: "log", pic: "🐶" },
        { word: "pot", sounds: ["p", "o", "t"], vowel: "short o", rhyme: "hot", pic: "🍲" },
        { word: "sun", sounds: ["s", "u", "n"], vowel: "short u", rhyme: "run", pic: "☀️" },
        { word: "bug", sounds: ["b", "u", "g"], vowel: "short u", rhyme: "rug", pic: "🐞" },
        { word: "ship", sounds: ["sh", "i", "p"], vowel: "short i", rhyme: "chip", pic: "🚢" },
        { word: "frog", sounds: ["f", "r", "o", "g"], vowel: "short o", rhyme: "dog", pic: "🐸" }
      ];
      const item = cvcBank[(variant + topic.code.charCodeAt(0)) % cvcBank.length];
      if (variant % 2 === 0) {
        return {
          questionId: `q_${unit.unitId}_${topic.code}_${variant}`,
          unitId: unit.unitId,
          topicCode: topic.code,
          topicName: topic.name,
          interactionType: "tile-builder",
          tileBank: [...item.sounds, "z", "m"],
          prompt: `Tap the sound tiles in order to blend the word for ${item.pic} ("${item.word.toUpperCase()}"):`,
          visualAid: visualSvg,
          choices: uniqueChoices(item.sounds.join(" "), [
            [...item.sounds].reverse().join(" "),
            `${item.sounds[0]} u ${item.sounds[item.sounds.length - 1]}`,
            `m ${item.sounds[1]} p`
          ]),
          correctAnswer: item.sounds.join(" "),
          misconceptionTags: ["phoneme_order_inversion"],
          explanation: `Blend the sounds smoothly from left to right: /${item.sounds.join("/ - /")}/ -> "${item.word}"!`
        };
      } else {
        return {
          questionId: `q_${unit.unitId}_${topic.code}_${variant}`,
          unitId: unit.unitId,
          topicCode: topic.code,
          topicName: topic.name,
          interactionType: "multiple-choice",
          prompt: `Which word rhymes with "${item.word.toUpperCase()}" ${item.pic} and has the same ending sound?`,
          visualAid: visualSvg,
          choices: uniqueChoices(item.rhyme, ["cup", "tree", "book", "star"]),
          correctAnswer: item.rhyme,
          misconceptionTags: ["rime_ending_mismatch"],
          explanation: `"${item.word}" and "${item.rhyme}" share the exact same ending rime sound!`
        };
      }
    }
  }

  // Fallback to cycling through the curated sample bank + variant transformations
  if (sampleBank.length > 0) {
    const picked = sampleBank[variant % sampleBank.length];
    return {
      questionId: `bank_${unit.unitId}_${topic.code}_${variant}`,
      unitId: unit.unitId,
      topicCode: topic.code,
      topicName: topic.name,
      interactionType: "multiple-choice",
      prompt: picked.prompt.replace(/^\[.*?\]\s*/, ""),
      visualAid: `assets/images/${picked.visualAid}`.replace("assets/images/assets/images/", "assets/images/"),
      choices: picked.choices,
      correctAnswer: picked.correctAnswer,
      misconceptionTags: picked.misconceptionTags,
      explanation: picked.explanation
    };
  }

  return {
    questionId: `default_${unit.unitId}_${topic.code}_${variant}`,
    unitId: unit.unitId,
    topicCode: topic.code,
    topicName: topic.name,
    interactionType: "multiple-choice",
    prompt: `Practice ${topic.name} in ${unit.title}`,
    visualAid: visualSvg,
    choices: ["Correct Model", "Distractor A", "Distractor B", "Distractor C"],
    correctAnswer: "Correct Model",
    misconceptionTags: ["concept_review"],
    explanation: `Review ${topic.name} using the interactive manipulative.`
  };
}

export function generateTopicPracticeSet(unit, topic, count = 8) {
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push(generateProceduralQuestion(unit, topic, i));
  }
  return items;
}
