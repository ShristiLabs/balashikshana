/**
 * Pure gap-checking helpers for the #59 narration coverage gate.
 *
 * Shared between tests/narration-coverage.test.ts (runs them against
 * the REAL registry / manifest / compact asset and asserts zero gaps)
 * and tests/narration-gate-mutation.test.ts (feeds mutated fixtures
 * and asserts each failure class is caught). Because the real-file
 * suite consumes THESE functions, a mutation fixture tripping here is
 * proof the shipped gate trips — not a copy of it.
 *
 * Pure data-in/data-out: no fs, no clock, no randomness.
 */

export interface RegistryNarration {
  narrationId?: unknown;
  voicePersona?: unknown;
  speakingRateWpm?: unknown;
  introPromptSsml?: unknown;
  guidedHintSsml?: unknown;
  remediationSsml?: unknown;
  celebrationPrompts?: unknown;
}

export interface RegistryTopic {
  code: string;
  name: string;
  assets?: { voiceNarration?: RegistryNarration };
}

export interface RegistryShape {
  grades: {
    gradeId: string;
    subjects: Record<string, { units: { unitId: string; skillTopics: RegistryTopic[] }[] }>;
  }[];
}

export interface RegistryTopicEntry {
  gradeId: string;
  topicId: string;
  topic: RegistryTopic;
}

export interface ManifestItem {
  topicId: string;
  grade: string;
  speakingRateWpm: number;
  introPromptSsml: string;
  guidedHintSsml: string;
  remediationSsml: string;
  celebrationPrompts: string[];
}

export interface ManifestShape {
  totalTopics: number;
  items: ManifestItem[];
}

/** Grade-calibrated WPM (architecture: PK 110, K 120, G1 130, G2 140, G3 150). */
export const GRADE_WPM: Record<string, number> = {
  "pre-k": 110,
  kindergarten: 120,
  "grade-1": 130,
  "grade-2": 140,
  "grade-3": 150,
};

/**
 * Registry enumeration: grades -> subjects -> units -> skillTopics.
 * The canonical topic id is `${unitId}-${code}` (the composition the
 * API seed, the content packs, and the narration manifest all use —
 * unitIds carry the grade prefix, e.g. PK-M1 + A = PK-M1-A).
 * Deterministic: output sorted by topicId.
 */
export function enumerateRegistryTopics(registry: RegistryShape): RegistryTopicEntry[] {
  const out: RegistryTopicEntry[] = [];
  for (const grade of registry.grades) {
    for (const subject of Object.values(grade.subjects ?? {})) {
      for (const unit of subject.units ?? []) {
        for (const topic of unit.skillTopics ?? []) {
          out.push({ gradeId: grade.gradeId, topicId: `${unit.unitId}-${topic.code}`, topic });
        }
      }
    }
  }
  out.sort((a, b) => (a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0));
  return out;
}

export interface RegistryNarrationGaps {
  noBlock: string[];
  emptyIntro: string[];
  emptyHint: string[];
  emptyRemediation: string[];
  emptyCelebration: string[];
  wpmOutside: string[];
  wpmUncalibrated: string[];
}

/**
 * Layer-1 checks: every registry topic must carry a voiceNarration
 * block whose four line kinds are non-empty and whose WPM sits in the
 * 110-150 band at the grade's calibrated value.
 */
export function registryNarrationGaps(entries: RegistryTopicEntry[]): RegistryNarrationGaps {
  const gaps: RegistryNarrationGaps = {
    noBlock: [],
    emptyIntro: [],
    emptyHint: [],
    emptyRemediation: [],
    emptyCelebration: [],
    wpmOutside: [],
    wpmUncalibrated: [],
  };
  for (const { gradeId, topicId, topic } of entries) {
    const vn = topic.assets?.voiceNarration;
    if (!vn || typeof vn !== "object") {
      gaps.noBlock.push(topicId);
      continue;
    }
    if (typeof vn.introPromptSsml !== "string" || vn.introPromptSsml.length === 0) {
      gaps.emptyIntro.push(topicId);
    }
    if (typeof vn.guidedHintSsml !== "string" || vn.guidedHintSsml.length === 0) {
      gaps.emptyHint.push(topicId);
    }
    if (typeof vn.remediationSsml !== "string" || vn.remediationSsml.length === 0) {
      gaps.emptyRemediation.push(topicId);
    }
    const celebration = vn.celebrationPrompts;
    if (
      !Array.isArray(celebration) ||
      celebration.length === 0 ||
      celebration.some((line) => typeof line !== "string" || line.length === 0)
    ) {
      gaps.emptyCelebration.push(topicId);
    }
    const wpm = vn.speakingRateWpm;
    if (typeof wpm !== "number" || wpm < 110 || wpm > 150) {
      gaps.wpmOutside.push(`${topicId}=${String(wpm)}`);
      continue;
    }
    const expected = GRADE_WPM[gradeId];
    if (expected !== undefined && wpm !== expected) {
      gaps.wpmUncalibrated.push(`${topicId}(${gradeId})=${wpm}!${expected}`);
    }
  }
  return gaps;
}

export interface ManifestSetGaps {
  /** Registry topics with no manifest narration binding. */
  missing: string[];
  /** Manifest topics the registry does not know (stale entries). */
  orphans: string[];
}

/** Layer-2 set check: manifest coverage must equal the registry exactly. */
export function manifestSetGaps(registryIds: string[], manifestIds: string[]): ManifestSetGaps {
  const registry = new Set(registryIds);
  const manifest = new Set(manifestIds);
  const missing = [...registry].filter((id) => !manifest.has(id)).sort();
  const orphans = [...manifest].filter((id) => !registry.has(id)).sort();
  return { missing, orphans };
}

/**
 * Layer-2 field check: every manifest item must reproduce its registry
 * topic's narration verbatim (SSML kinds, celebration list, WPM).
 */
export function manifestFieldMismatches(
  entries: RegistryTopicEntry[],
  items: ManifestItem[],
): string[] {
  const byId = new Map(entries.map((entry) => [entry.topicId, entry.topic]));
  const mismatches: string[] = [];
  for (const item of items) {
    const topic = byId.get(item.topicId);
    if (!topic) continue;
    const vn = topic.assets?.voiceNarration;
    if (!vn) {
      mismatches.push(`${item.topicId}:no-voiceNarration`);
      continue;
    }
    if (
      item.introPromptSsml !== vn.introPromptSsml ||
      item.guidedHintSsml !== vn.guidedHintSsml ||
      item.remediationSsml !== vn.remediationSsml
    ) {
      mismatches.push(`${item.topicId}:ssml`);
    }
    const celebration = Array.isArray(vn.celebrationPrompts)
      ? (vn.celebrationPrompts as string[])
      : [];
    if (JSON.stringify(item.celebrationPrompts) !== JSON.stringify(celebration)) {
      mismatches.push(`${item.topicId}:celebration`);
    }
    if (item.speakingRateWpm !== vn.speakingRateWpm) {
      mismatches.push(`${item.topicId}:wpm`);
    }
  }
  return mismatches.sort();
}

/**
 * Layer-3 derivation: exactly what scripts/build-narration-lines.mjs
 * writes (minified, items sorted by topicId, fixed key order, trailing
 * newline, non-string/empty celebration lines filtered). Byte-compare
 * against the asset on disk to pin both content and determinism.
 */
export function deriveCompactAssetText(items: ManifestItem[]): string {
  const derived = items
    .map((item) => ({
      topicId: item.topicId,
      grade: item.grade,
      intro: item.introPromptSsml,
      hint: item.guidedHintSsml,
      remediation: item.remediationSsml,
      celebration: item.celebrationPrompts.filter(
        (line) => typeof line === "string" && line.length > 0,
      ),
    }))
    .sort((a, b) => (a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0));
  return `${JSON.stringify({ totalTopics: derived.length, items: derived })}\n`;
}
