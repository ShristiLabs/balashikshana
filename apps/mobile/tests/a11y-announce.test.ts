/**
 * #67 announcement message builders: the spoken counterparts of the
 * feedback bars and countdown labels. Pinned contract — speech must
 * mirror the visible UI (never diverge), rapid-guess wording must stay
 * blame-free, and the timer crossover must speak ONLY at 30/10 second
 * thresholds (per-second speech would drown the question).
 */
import { describe, expect, it } from "vitest";
import {
  gateFeedbackMessage,
  practiceFeedbackMessage,
  questionTransitionMessage,
  timerCrossoverMessage,
  TIMER_ANNOUNCE_SECONDS,
} from "../src/a11y/announceMessages";

describe("practiceFeedbackMessage", () => {
  it("speaks correctness plus thinking time and target on correct answers", () => {
    expect(practiceFeedbackMessage({ isCorrect: true, cognitiveTimeSec: 4 }, 8)).toBe(
      "Correct! Thinking time 4 seconds, target 8.",
    );
  });

  it("omits the target clause when the topic has no speed target", () => {
    expect(practiceFeedbackMessage({ isCorrect: true, cognitiveTimeSec: 4 }, 0)).toBe(
      "Correct! Thinking time 4 seconds.",
    );
  });

  it("reveals the correct answer on a miss", () => {
    expect(
      practiceFeedbackMessage({ isCorrect: false, correctAnswer: "7", cognitiveTimeSec: 9 }, 0),
    ).toBe("Almost. Let's look again. The answer is 7.");
  });

  it("never speaks an empty answer clause when the miss carries no answer", () => {
    expect(practiceFeedbackMessage({ isCorrect: false, cognitiveTimeSec: 3 }, 0)).toBe(
      "Almost. Let's look again.",
    );
  });

  it("speaks unicode answers verbatim (fraction and half-star answers)", () => {
    expect(
      practiceFeedbackMessage(
        { isCorrect: false, correctAnswer: "3/4 cup", cognitiveTimeSec: 6 },
        0,
      ),
    ).toBe("Almost. Let's look again. The answer is 3/4 cup.");
    expect(
      gateFeedbackMessage({ isCorrect: false, correctAnswer: "3 1/2", cognitiveTimeSec: 4 }),
    ).toBe("Almost. Let's look again. The answer is 3 1/2.");
  });
});

describe("gateFeedbackMessage", () => {
  it("speaks the rapid-guess reframe instead of plain incorrect wording", () => {
    expect(
      gateFeedbackMessage({
        isCorrect: false,
        correctAnswer: "12",
        cognitiveTimeSec: 1,
        wasRapidGuess: true,
      }),
    ).toBe("Take a breath. Quick taps need a second look. The answer is 12.");
  });

  it("speaks correctness only when right (the ceremony carries the rest)", () => {
    expect(gateFeedbackMessage({ isCorrect: true, cognitiveTimeSec: 5 })).toBe("Correct!");
  });
});

describe("questionTransitionMessage", () => {
  it("is one-based to match the visible progress label", () => {
    expect(questionTransitionMessage(0, 8)).toBe("Question 1 of 8.");
    expect(questionTransitionMessage(7, 8)).toBe("Question 8 of 8.");
  });

  it("handles the single-question session (boundary: total = 1)", () => {
    expect(questionTransitionMessage(0, 1)).toBe("Question 1 of 1.");
  });
});

describe("timerCrossoverMessage", () => {
  it("announces exactly the 30- and 10-second downward crossings", () => {
    expect(timerCrossoverMessage(31, 30)).toBe("30 seconds left.");
    expect(timerCrossoverMessage(11, 10)).toBe("10 seconds left.");
  });

  it("stays silent on every other tick (per-second speech would drown the question)", () => {
    expect(timerCrossoverMessage(45, 44)).toBeNull();
    expect(timerCrossoverMessage(30, 29)).toBeNull();
    expect(timerCrossoverMessage(10, 9)).toBeNull();
    expect(timerCrossoverMessage(29, 28)).toBeNull();
  });

  it("is silent when the reading sits exactly AT a threshold (no crossing)", () => {
    expect(timerCrossoverMessage(30, 30)).toBeNull();
    expect(timerCrossoverMessage(10, 10)).toBeNull();
    expect(timerCrossoverMessage(0, 0)).toBeNull();
  });

  it("announces once when a tick skips straight past a threshold (frozen main thread)", () => {
    expect(timerCrossoverMessage(45, 25)).toBe("30 seconds left.");
    expect(timerCrossoverMessage(31, 5)).toBe("30 seconds left.");
  });

  it("treats a null baseline as above every threshold (fresh arming is not a crossing)", () => {
    expect(timerCrossoverMessage(null, 60)).toBeNull();
    expect(timerCrossoverMessage(null, 31)).toBeNull();
    expect(timerCrossoverMessage(null, 30)).toBe("30 seconds left.");
    expect(timerCrossoverMessage(null, 10)).toBe("10 seconds left.");
  });

  it("does not announce when both readings sit below every threshold", () => {
    expect(timerCrossoverMessage(20, 15)).toBeNull();
    expect(timerCrossoverMessage(5, 4)).toBeNull();
  });

  it("pins the threshold set itself (changing it is an audible UX decision)", () => {
    expect([...TIMER_ANNOUNCE_SECONDS]).toEqual([30, 10]);
  });
});
