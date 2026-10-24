/**
 * Runner test fixtures (issue #50): PracticeQuestion builders for the
 * three seeded interaction types plus the four CPA stages, mirroring
 * the row shapes the engine generator emits.
 */
import type { PracticeQuestion } from "../../src/practice/types";

export function fixtureQuestion(overrides: Partial<PracticeQuestion>): PracticeQuestion {
  return {
    questionId: "U-T-Q1",
    topicId: "U-T",
    unitId: "U",
    topicCode: "T",
    topicName: "Topic",
    difficultyLevel: 1,
    interactionType: "multiple-choice",
    prompt: "Pick one",
    visualAid: "assets/images/ten_frame_and_number_line.svg",
    choices: ["3", "2", "4", "5"],
    correctAnswer: "3",
    misconceptionTags: [],
    explanation: "Because",
    ...overrides,
  };
}

export function counterQuestion(overrides: Partial<PracticeQuestion> = {}): PracticeQuestion {
  return fixtureQuestion({
    questionId: "U-T-Q2",
    interactionType: "interactive-counter",
    targetCount: 4,
    maxCounterCells: 10,
    counterEmoji: "X",
    prompt: "Place exactly 4",
    ...overrides,
  });
}

export function tileQuestion(overrides: Partial<PracticeQuestion> = {}): PracticeQuestion {
  return fixtureQuestion({
    questionId: "U-T-Q3",
    interactionType: "tile-builder",
    tileBank: ["5", "3", "4", "7"],
    correctAnswer: "3 4 5",
    choices: ["3 4 5", "5 4 3", "3 5 4", "4 3 5"],
    prompt: "Put 3, 4, 5 in order",
    ...overrides,
  });
}
