/**
 * Manifest-driven SFX catalog (issue #45) - PURE module.
 *
 * The single source of truth is the canonical repo manifest
 * assets/sounds/sounds-manifest.json (614 topics, 16 synthesized WAVs):
 * the manager never hardcodes file paths. Sound ids are the manifest's
 * file stems ("sfx_chime_correct"); the native asset registry in
 * assetModules.ts is keyed by exactly those stems and is validated
 * against this catalog by unit tests (completeness: every manifest file
 * registered, no orphans).
 *
 * The topic->sound mapping is content data: #46 (content packs) owns its
 * on-device delivery; until then this module reads the bundled manifest.
 */

import type { SfxMoment, SfxSoundId } from "./types";

import rawManifest from "../../../../assets/sounds/sounds-manifest.json";

export interface ManifestFeedbackSounds {
  onInteract: string;
  onCorrect: string;
  onGentleRetry: string;
  onStreakCombo: string;
  onSpeedTargetBeat: string;
}

export interface ManifestItem {
  topicId: string;
  grade: string;
  primarySfx: string;
  feedbackSounds: ManifestFeedbackSounds;
}

interface SoundsManifest {
  totalTopics: number;
  items: ManifestItem[];
}

const manifest = rawManifest as unknown as SoundsManifest;

const MOMENT_KEYS: Record<Exclude<SfxMoment, "primary">, keyof ManifestFeedbackSounds> = {
  onInteract: "onInteract",
  onCorrect: "onCorrect",
  onGentleRetry: "onGentleRetry",
  onStreakCombo: "onStreakCombo",
  onSpeedTargetBeat: "onSpeedTargetBeat",
};

function stemOf(path: string): SfxSoundId {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.wav$/i, "");
}

function collectStems(): SfxSoundId[] {
  const stems = new Set<SfxSoundId>();
  for (const item of manifest.items) {
    stems.add(stemOf(item.primarySfx));
    for (const file of Object.values(item.feedbackSounds)) {
      stems.add(stemOf(file));
    }
  }
  return [...stems].sort();
}

/** Every distinct sound file the manifest references (the 16 WAVs). */
export const SFX_FILE_STEMS: readonly SfxSoundId[] = collectStems();

export function manifestItemCount(): number {
  return manifest.items.length;
}

export interface TopicSounds {
  primary: SfxSoundId;
  onInteract: SfxSoundId;
  onCorrect: SfxSoundId;
  onGentleRetry: SfxSoundId;
  onStreakCombo: SfxSoundId;
  onSpeedTargetBeat: SfxSoundId;
}

function topicSoundsOf(item: ManifestItem): TopicSounds {
  return {
    primary: stemOf(item.primarySfx),
    onInteract: stemOf(item.feedbackSounds.onInteract),
    onCorrect: stemOf(item.feedbackSounds.onCorrect),
    onGentleRetry: stemOf(item.feedbackSounds.onGentleRetry),
    onStreakCombo: stemOf(item.feedbackSounds.onStreakCombo),
    onSpeedTargetBeat: stemOf(item.feedbackSounds.onSpeedTargetBeat),
  };
}

const TOPIC_INDEX = new Map<string, TopicSounds>(
  manifest.items.map((item) => [item.topicId, topicSoundsOf(item)]),
);

/**
 * Fallback pack for unknown topics (content packs not yet downloaded):
 * the manifest's most-referenced pack, derived at load time - the
 * feedback set is universal across all 614 topics, so only the primary
 * differs between packs.
 */
export const DEFAULT_TOPIC_SOUNDS: TopicSounds = (() => {
  const counts = new Map<SfxSoundId, number>();
  for (const sounds of TOPIC_INDEX.values()) {
    counts.set(sounds.primary, (counts.get(sounds.primary) ?? 0) + 1);
  }
  let best: SfxSoundId = SFX_FILE_STEMS[0] ?? "sfx_count_pop";
  let bestCount = -1;
  for (const [stem, count] of counts) {
    if (count > bestCount) {
      best = stem;
      bestCount = count;
    }
  }
  const template = TOPIC_INDEX.values().next().value;
  if (!template) throw new Error("sounds-manifest.json has no items");
  return { ...template, primary: best };
})();

/** Resolve a topic's sound pack; unknown topics get the default pack. */
export function resolveTopicSounds(topicId: string | undefined): TopicSounds {
  if (topicId !== undefined) {
    const sounds = TOPIC_INDEX.get(topicId);
    if (sounds) return sounds;
  }
  return DEFAULT_TOPIC_SOUNDS;
}

/** Sound id for a feedback moment of a topic (primary = primarySfx). */
export function sfxIdForMoment(topicId: string | undefined, moment: SfxMoment): SfxSoundId {
  const sounds = resolveTopicSounds(topicId);
  return moment === "primary" ? sounds.primary : sounds[MOMENT_KEYS[moment]];
}

export interface SfxRegistryCheck {
  missing: SfxSoundId[];
  orphan: SfxSoundId[];
}

/**
 * Completeness check between the manifest catalog and an asset registry
 * (the native require() map). Tests assert both directions: no manifest
 * sound may be unregistered (would silently no-op at runtime), and no
 * registered asset may be unreferenced (dead bundle weight).
 */
export function validateSfxRegistry(registryKeys: readonly SfxSoundId[]): SfxRegistryCheck {
  const registered = new Set(registryKeys);
  return {
    missing: SFX_FILE_STEMS.filter((stem) => !registered.has(stem)),
    orphan: registryKeys.filter((stem) => !SFX_FILE_STEMS.includes(stem)),
  };
}
