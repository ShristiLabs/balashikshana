/**
 * React-native runner bindings (issue #50).
 *
 * The ONLY module in the runner tree that touches native seams: the
 * practice engine singleton (expo-sqlite underneath), the audio
 * coordinator (expo-speech/expo-audio/expo-haptics underneath), and the
 * child-device identity (onboarding stores). Everything above stays
 * node-testable.
 */
import { getAudioService } from "../audio/nativeAudio";
import type { AudioCoordinator } from "../audio/coordinator";
import { loadJourneyIdentity } from "../journey/nativeJourney";
import { getPracticeEngine } from "../practice/PracticeWarmup";
import type { PracticeSessionEngine } from "../practice/practiceEngine";
import type { GradeId } from "../onboarding/types";

export interface RunnerIdentity {
  studentId: string | null;
  gradeId: string | null;
}

/** The child-device session's student + the snapshot's active grade. */
export async function resolveRunnerIdentity(): Promise<RunnerIdentity> {
  const identity = await loadJourneyIdentity();
  return { studentId: identity.studentId, gradeId: identity.gradeId };
}

/** The app-wide practice engine singleton (#47 doctrine). */
export function getRunnerEngine(): PracticeSessionEngine {
  return getPracticeEngine();
}

/** The app-wide audio coordinator singleton (#45 doctrine). */
export async function getRunnerAudio(): Promise<AudioCoordinator> {
  return getAudioService();
}

/** Narrow the runtime grade string to the onboarding union when valid. */
export function asGradeId(grade: string | null): GradeId | undefined {
  if (
    grade === "pre-k" ||
    grade === "kindergarten" ||
    grade === "grade-1" ||
    grade === "grade-2" ||
    grade === "grade-3"
  ) {
    return grade;
  }
  return undefined;
}
