/**
 * Mascot state machine (issue #58): the full transition matrix —
 * every session event type maps to its pose, transient holds follow
 * the registry motion tokens, celebrate locks out react, tick expiry
 * returns to idle, and reduced motion changes NOTHING about the
 * machine (the static frame is the pose's end state). Also pins the
 * motion tokens against the shipped animations manifest (uniform
 * across all 614 topics) and the pose vocabulary 1:1.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  initialMascotState,
  mascotFrameFor,
  mascotTransition,
  moodForPose,
  MASCOT_MOTION_TOKENS,
  POSE_HOLD_MS,
  REACT_POSE_FOR_EVENT,
  type MascotEvent,
  type MascotPose,
} from "../src/mascot/mascotMachine";
import { MASCOT_ART } from "../src/mascot/mascotArt";

const manifest = JSON.parse(
  readFileSync(
    join(
      fileURLToPath(new URL("..", import.meta.url)),
      // tests/ -> apps/mobile -> repo root -> assets/
      "../../assets/animations/animations-manifest.json",
    ),
    "utf8",
  ),
) as {
  items: {
    topicId: string;
    stateMachineStates: {
      state: string;
      durationMs?: number;
      scale?: number;
      springStiffness?: number;
      damping?: number;
      particleBurst?: string;
      loop?: boolean;
    }[];
  }[];
};

describe("mascot machine transitions (every session event -> pose)", () => {
  const T0 = 1_000_000;
  // Distributive Omit: keeps each union member's own fields.
  type EventDraft<T> = T extends unknown ? Omit<T, "nowMs"> : never;
  const now = (event: EventDraft<MascotEvent>, atMs: number): MascotEvent =>
    ({ ...event, nowMs: atMs }) as MascotEvent;

  it("starts idle and classifies the three moods", () => {
    const idle = initialMascotState(T0);
    expect(idle).toMatchObject({ mood: "idle", pose: "idle_breathe", expiresAtMs: null });
    expect(moodForPose("idle_breathe")).toBe("idle");
    expect(moodForPose("touch_pickup_scale")).toBe("react");
    expect(moodForPose("mastery_badge_bloom")).toBe("celebrate");
  });

  it.each([
    ["answer-correct", "snap_target_confirm"],
    ["snap-confirm", "snap_target_confirm"],
    ["answer-gentle-retry", "gentle_bounce_back"],
    ["touch-pickup", "touch_pickup_scale"],
    ["hint-shown", "hint_path_bezier_glow"],
  ] as const)("react event %s enters %s", (type, pose) => {
    expect(REACT_POSE_FOR_EVENT[type]).toBe(pose);
    const next = mascotTransition(initialMascotState(T0), now({ type }, T0 + 50));
    expect(next.pose).toBe(pose);
    expect(next.mood).toBe("react");
    expect(next.moment).toBeNull();
  });

  it.each([
    ["topic-mastered"],
    ["badge-awarded"],
    ["level-up"],
    ["streak-milestone"],
    ["game-goal-met"],
    ["key-ceremony-silver"],
    ["key-ceremony-gold"],
    ["unit-complete"],
  ] as const)("celebrate moment %s enters the bloom pose", (moment) => {
    const next = mascotTransition(
      initialMascotState(T0),
      now({ type: "celebrate", moment }, T0 + 50),
    );
    expect(next).toMatchObject({ mood: "celebrate", pose: "mastery_badge_bloom", moment });
  });

  it("react never interrupts an in-flight celebration; celebrate refreshes it", () => {
    let state = mascotTransition(
      initialMascotState(T0),
      now({ type: "celebrate", moment: "level-up" }, T0),
    );
    state = mascotTransition(state, now({ type: "answer-correct" }, T0 + 100));
    expect(state.pose).toBe("mastery_badge_bloom");
    state = mascotTransition(state, now({ type: "celebrate", moment: "badge-awarded" }, T0 + 900));
    expect(state).toMatchObject({ pose: "mastery_badge_bloom", moment: "badge-awarded" });
    // The refreshed window runs a full bloom from the refresh instant.
    expect(state.expiresAtMs).toBe(T0 + 900 + MASCOT_MOTION_TOKENS.badgeBloomMs);
  });

  it("tick expires transient poses back to idle; idle never expires", () => {
    const react = mascotTransition(initialMascotState(T0), now({ type: "answer-correct" }, T0));
    const hold = POSE_HOLD_MS[react.pose];
    expect(mascotTransition(react, { type: "tick", nowMs: T0 + hold - 1 }).pose).toBe(
      "snap_target_confirm",
    );
    expect(mascotTransition(react, { type: "tick", nowMs: T0 + hold }).pose).toBe("idle_breathe");

    const idle = initialMascotState(T0);
    expect(mascotTransition(idle, { type: "tick", nowMs: T0 + 60_000 })).toBe(idle);
  });

  it("latest react wins while reacting", () => {
    let state = mascotTransition(initialMascotState(T0), now({ type: "answer-correct" }, T0));
    state = mascotTransition(state, now({ type: "hint-shown" }, T0 + 100));
    expect(state.pose).toBe("hint_path_bezier_glow");
    state = mascotTransition(state, now({ type: "answer-gentle-retry" }, T0 + 200));
    expect(state.pose).toBe("gentle_bounce_back");
  });

  it("reduced motion: the machine is unchanged and the frame is the pose end state", () => {
    const celebrate = mascotTransition(
      initialMascotState(T0),
      now({ type: "celebrate", moment: "topic-mastered" }, T0),
    );
    // Same state object semantics for both motion profiles: the static
    // frame carries the same information (pose end state, burst spread).
    expect(mascotFrameFor(celebrate, true)).toBe("mastery_badge_bloom");
    expect(mascotFrameFor(celebrate, false)).toBe("mastery_badge_bloom");
    const retry = mascotTransition(
      initialMascotState(T0),
      now({ type: "answer-gentle-retry" }, T0),
    );
    expect(mascotFrameFor(retry, false)).toBe("gentle_bounce_back");
  });
});

describe("registry vocabulary + motion tokens", () => {
  it("pose vocabulary is exactly the registry stateMachineStates set", () => {
    const registryStates = new Set(
      manifest.items[0]?.stateMachineStates.map((entry) => entry.state) ?? [],
    );
    expect(registryStates.size).toBe(6);
    const poses: MascotPose[] = [
      "idle_breathe",
      "touch_pickup_scale",
      "snap_target_confirm",
      "hint_path_bezier_glow",
      "gentle_bounce_back",
      "mastery_badge_bloom",
    ];
    for (const pose of poses) expect(registryStates.has(pose)).toBe(true);
  });

  it("every shipped topic uses the same token set the mascot pinned", () => {
    expect(manifest.items.length).toBe(614);
    for (const item of manifest.items) {
      const byState = new Map(item.stateMachineStates.map((entry) => [entry.state, entry]));
      const idle = byState.get("idle_breathe");
      expect(idle?.loop).toBe(true);
      expect(idle?.durationMs).toBe(MASCOT_MOTION_TOKENS.idleBreatheLoopMs);
      const pickup = byState.get("touch_pickup_scale");
      expect(pickup?.scale).toBe(MASCOT_MOTION_TOKENS.pickupScale);
      expect(pickup?.springStiffness).toBe(MASCOT_MOTION_TOKENS.pickupSpringStiffness);
      expect(pickup?.damping).toBe(MASCOT_MOTION_TOKENS.pickupSpringDamping);
      const snap = byState.get("snap_target_confirm");
      expect(snap?.durationMs).toBe(MASCOT_MOTION_TOKENS.snapConfirmMs);
      expect(snap?.particleBurst).toBe(`gold_stars_${String(MASCOT_MOTION_TOKENS.snapBurstStars)}`);
      const hint = byState.get("hint_path_bezier_glow");
      expect(hint?.loop).toBe(true);
      expect(hint?.durationMs).toBe(MASCOT_MOTION_TOKENS.hintGlowLoopMs);
      const bounce = byState.get("gentle_bounce_back");
      expect(bounce?.durationMs).toBe(MASCOT_MOTION_TOKENS.bounceBackMs);
      const bloom = byState.get("mastery_badge_bloom");
      expect(bloom?.durationMs).toBe(MASCOT_MOTION_TOKENS.badgeBloomMs);
    }
  });

  it("pose holds follow the registry durations", () => {
    expect(POSE_HOLD_MS.snap_target_confirm).toBe(MASCOT_MOTION_TOKENS.snapConfirmMs);
    expect(POSE_HOLD_MS.hint_path_bezier_glow).toBe(MASCOT_MOTION_TOKENS.hintGlowLoopMs);
    expect(POSE_HOLD_MS.gentle_bounce_back).toBe(MASCOT_MOTION_TOKENS.bounceBackMs);
    expect(POSE_HOLD_MS.mastery_badge_bloom).toBe(MASCOT_MOTION_TOKENS.badgeBloomMs);
    expect(POSE_HOLD_MS.idle_breathe).toBe(Number.POSITIVE_INFINITY);
  });

  it("every pose has complete, unique art (no empty geometry, distinct expressions)", () => {
    const poses = Object.keys(MASCOT_ART) as MascotPose[];
    expect(poses.length).toBe(6);
    const expressions = new Set<string>();
    for (const pose of poses) {
      const art = MASCOT_ART[pose];
      expect(art.body.length).toBeGreaterThan(0);
      expect(art.leaves.length).toBeGreaterThan(0);
      expect(art.eyes.length).toBeGreaterThan(0);
      expect(art.mouth.length).toBeGreaterThan(0);
      expect(art.arms.length).toBeGreaterThan(0);
      expressions.add(`${art.eyes}|${art.mouth}|${art.arms}|${art.extra}`);
    }
    // The six poses are visually distinct.
    expect(expressions.size).toBe(6);
  });
});
