/**
 * Static asset registry for the 16 manifest WAVs (issue #45).
 *
 * Metro can only bundle statically analyzable require() calls, so the
 * file map lives here with one literal require per sound. The KEYS are
 * the manifest file stems - nothing else in the app hardcodes a path -
 * and tests assert the key set is exactly the manifest's referenced file
 * set (no missing sound, no orphan asset) via manifest.validateSfxRegistry.
 *
 * The files are the canonical repo assets (assets/sounds/ at the monorepo
 * root) - the same bytes the curriculum validator and the dev harness
 * use; no copies exist inside apps/mobile.
 */

import type { ManifestSoundId, SfxSoundId } from "./types";

/**
 * Record<ManifestSoundId, number> pins the key set at compile time: a
 * missing stem, an extra stem, or a typo is a type error here (and the
 * pinning test catches drift against sounds-manifest.json itself).
 */
export const SFX_ASSETS: Record<ManifestSoundId, number> = {
  sfx_block_snap: require("../../../../assets/sounds/sfx_block_snap.wav"),
  sfx_bridge_lock: require("../../../../assets/sounds/sfx_bridge_lock.wav"),
  sfx_chime_correct: require("../../../../assets/sounds/sfx_chime_correct.wav"),
  sfx_clock_tick: require("../../../../assets/sounds/sfx_clock_tick.wav"),
  sfx_coin_clink: require("../../../../assets/sounds/sfx_coin_clink.wav"),
  sfx_compass_chime: require("../../../../assets/sounds/sfx_compass_chime.wav"),
  sfx_count_pop: require("../../../../assets/sounds/sfx_count_pop.wav"),
  sfx_gentle_nudge: require("../../../../assets/sounds/sfx_gentle_nudge.wav"),
  sfx_laser_zap: require("../../../../assets/sounds/sfx_laser_zap.wav"),
  sfx_pacemaker_pulse: require("../../../../assets/sounds/sfx_pacemaker_pulse.wav"),
  sfx_page_turn: require("../../../../assets/sounds/sfx_page_turn.wav"),
  sfx_phoneme_slide: require("../../../../assets/sounds/sfx_phoneme_slide.wav"),
  sfx_science_bubble: require("../../../../assets/sounds/sfx_science_bubble.wav"),
  sfx_slice_whoosh: require("../../../../assets/sounds/sfx_slice_whoosh.wav"),
  sfx_star_fanfare: require("../../../../assets/sounds/sfx_star_fanfare.wav"),
  sfx_tile_snap: require("../../../../assets/sounds/sfx_tile_snap.wav"),
};

export const SFX_ASSET_KEYS: readonly SfxSoundId[] = Object.keys(SFX_ASSETS).sort();
