/**
 * Manifest-driven SFX catalog invariants (issue #45 acceptance: "SFX
 * manager plays all 16 manifest WAVs, driven entirely by
 * sounds-manifest.json"). The canonical manifest and the WAV directory
 * are read from the repo root, so the catalog cannot drift from either.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOPIC_SOUNDS,
  manifestItemCount,
  resolveTopicSounds,
  SFX_FILE_STEMS,
  sfxIdForMoment,
  validateSfxRegistry,
} from "../src/audio/manifest";
import { MANIFEST_SOUND_IDS } from "../src/audio/types";

const REPO_ROOT = resolve(__dirname, "../../..");
const SOUNDS_DIR = resolve(REPO_ROOT, "assets/sounds");
const MANIFEST_PATH = resolve(SOUNDS_DIR, "sounds-manifest.json");

interface ManifestFile {
  totalTopics: number;
  items: {
    topicId: string;
    primarySfx: string;
    feedbackSounds: {
      onInteract: string;
      onCorrect: string;
      onGentleRetry: string;
      onStreakCombo: string;
      onSpeedTargetBeat: string;
    };
  }[];
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as ManifestFile;

function diskStems(): string[] {
  return readdirSync(SOUNDS_DIR)
    .filter((file) => file.endsWith(".wav"))
    .map((file) => file.replace(/\.wav$/, ""))
    .sort();
}

describe("catalog completeness", () => {
  it("covers all 614 manifest topics", () => {
    expect(manifestItemCount()).toBe(614);
    expect(manifest.totalTopics).toBe(614);
    expect(manifest.items).toHaveLength(614);
  });

  it("derives exactly the 16 WAV stems on disk", () => {
    expect(SFX_FILE_STEMS).toEqual(diskStems());
    expect(SFX_FILE_STEMS).toHaveLength(16);
  });

  it("is complete against itself: no missing sound, no orphan", () => {
    expect(validateSfxRegistry(SFX_FILE_STEMS)).toEqual({ missing: [], orphan: [] });
  });

  it("flags a registry missing a manifest sound", () => {
    const incomplete = SFX_FILE_STEMS.filter((stem) => stem !== "sfx_chime_correct");
    expect(validateSfxRegistry(incomplete).missing).toEqual(["sfx_chime_correct"]);
  });

  it("flags an orphan registry key not referenced by the manifest", () => {
    expect(validateSfxRegistry([...SFX_FILE_STEMS, "sfx_stale_extra"]).orphan).toEqual([
      "sfx_stale_extra",
    ]);
  });

  it("pins the compile-time ManifestSoundId set to the manifest catalog and disk", () => {
    // Three-way pin: the 16-literal union source (types.ts), the
    // manifest-derived catalog, and the WAVs on disk must be the same
    // set - a manifest change that adds/removes a sound fails here until
    // MANIFEST_SOUND_IDS (and so Record<ManifestSoundId, number>) is
    // updated, so the asset map can never drift into silent no-ops.
    expect(MANIFEST_SOUND_IDS).toHaveLength(16);
    expect([...MANIFEST_SOUND_IDS].sort()).toEqual(SFX_FILE_STEMS);
    expect([...MANIFEST_SOUND_IDS].sort()).toEqual(diskStems());
  });
});

describe("topic resolution", () => {
  it("resolves a known topic's full sound pack", () => {
    const sounds = resolveTopicSounds("PK-M1-A");
    expect(sounds).toEqual({
      primary: "sfx_count_pop",
      onInteract: "sfx_count_pop",
      onCorrect: "sfx_chime_correct",
      onGentleRetry: "sfx_gentle_nudge",
      onStreakCombo: "sfx_star_fanfare",
      onSpeedTargetBeat: "sfx_pacemaker_pulse",
    });
  });

  it("resolves each feedback moment of a topic", () => {
    expect(sfxIdForMoment("PK-M1-A", "onCorrect")).toBe("sfx_chime_correct");
    expect(sfxIdForMoment("PK-M1-A", "onGentleRetry")).toBe("sfx_gentle_nudge");
    expect(sfxIdForMoment("PK-M1-A", "onStreakCombo")).toBe("sfx_star_fanfare");
    expect(sfxIdForMoment("PK-M1-A", "onSpeedTargetBeat")).toBe("sfx_pacemaker_pulse");
    expect(sfxIdForMoment("PK-M1-A", "onInteract")).toBe("sfx_count_pop");
    expect(sfxIdForMoment("PK-M1-A", "primary")).toBe("sfx_count_pop");
  });

  it("falls back to the default pack for unknown topics", () => {
    expect(resolveTopicSounds("NO-SUCH-TOPIC")).toEqual(DEFAULT_TOPIC_SOUNDS);
    expect(sfxIdForMoment(undefined, "onCorrect")).toBe("sfx_chime_correct");
  });

  it("keeps the universal feedback set across every topic", () => {
    for (const item of manifest.items) {
      expect(item.feedbackSounds.onCorrect.endsWith("sfx_chime_correct.wav")).toBe(true);
      expect(item.feedbackSounds.onGentleRetry.endsWith("sfx_gentle_nudge.wav")).toBe(true);
      expect(item.feedbackSounds.onStreakCombo.endsWith("sfx_star_fanfare.wav")).toBe(true);
      expect(item.feedbackSounds.onSpeedTargetBeat.endsWith("sfx_pacemaker_pulse.wav")).toBe(true);
    }
  });
});
