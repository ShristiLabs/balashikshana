/**
 * Signing + fail-closed verification tests (issue #46):
 * - flip one byte -> reject (checksum + signature both catch it)
 * - wrong signature -> reject; truncated pack -> reject
 * - size mismatch -> reject; unknown keyId -> reject
 * - @noble/ed25519 (the on-device verifier) accepts node:crypto signatures
 *   over a real compiled artifact — the interop proof for the device chain
 * - canonical JSON is order-stable
 */
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  buildAllPacks,
  generateSigningKeyPair,
  sha256Hex,
  stableStringify,
  verifyPackBytes,
} from "../src/index.mjs";

// The device-side verifier (apps/mobile/src/content/verify.ts) configures
// @noble/ed25519 exactly like this (both sync + async hash injection).
function mergeMessages(messages) {
  const total = messages.reduce((n, m) => n + m.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const m of messages) {
    merged.set(m, offset);
    offset += m.length;
  }
  return merged;
}
ed.etc.sha512Async = async (...messages) => sha512(mergeMessages(messages));
ed.etc.sha512Sync = (...messages) => sha512(mergeMessages(messages));

function flipByte(bytes, index) {
  const copy = Buffer.from(bytes);
  copy[index] ^= 0x01;
  return copy;
}

describe("pack signing + verification", () => {
  const signer = generateSigningKeyPair();
  const otherKey = generateSigningKeyPair();
  const trusted = new Map([
    ["trusted-key", signer.publicKeyHex],
  ]);

  // A minimal but REAL pack: synthetic registry through the full pipeline.
  const syntheticRegistry = {
    version: "9.9.9",
    grades: [
      {
        gradeId: "pre-k",
        gradeName: "Pre-K",
        targetAgeYears: "4-5",
        spacedRepetitionPolicy: { stabilityGrowthFactor: 1.2, maxIntervalCapDays: 60, baseScheduleDays: [1, 3, 7] },
        subjects: {
          math: {
            units: [
              {
                unitId: "PK-X1",
                sequenceOrder: 1,
                title: "Numbers to 3",
                prerequisiteUnitIds: [],
                studyMaterials: [],
                games: [],
                masteryGate: { questionCount: 12, minAccuracyPercent: 85, maxMedianResponseTimeSec: 5.5, challengeZoneStreak: 4 },
                skillTopics: [
                  {
                    code: "A",
                    name: "Numbers to 3",
                    assets: {
                      sounds: {
                        soundPackId: "snd_PK-X1-A",
                        primarySfx: "assets/sounds/sfx_count_pop.wav",
                        feedbackSounds: {
                          onInteract: "assets/sounds/sfx_count_pop.wav",
                          onCorrect: "assets/sounds/sfx_chime_correct.wav",
                          onGentleRetry: "assets/sounds/sfx_gentle_nudge.wav",
                          onStreakCombo: "assets/sounds/sfx_star_fanfare.wav",
                          onSpeedTargetBeat: "assets/sounds/sfx_pacemaker_pulse.wav",
                        },
                      },
                      voiceNarration: { narrationId: "vox_PK-X1-A", speakingRateWpm: 110, introPromptSsml: "<speak>Hello</speak>" },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    ],
  };

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "packs-sign-"));
  const { entries } = buildAllPacks({
    registry: syntheticRegistry,
    outDir,
    privateKeyPem: signer.privateKeyPem,
    keyId: "trusted-key",
    gradeIds: ["pre-k"],
    tempDir: path.join(outDir, ".staging"),
  });
  const entry = entries[0];
  const packBytes = () => fs.readFileSync(path.join(outDir, entry.artifact));

  it("accepts the untampered artifact", () => {
    expect(verifyPackBytes({ bytes: packBytes(), entry, trustedKeys: trusted })).toEqual({ ok: true, reason: null });
  });

  it("rejects a single flipped byte anywhere in the pack", () => {
    const bytes = packBytes();
    // Header, middle, and last byte: every region must fail closed.
    for (const index of [0, 16, Math.floor(bytes.length / 2), bytes.length - 1]) {
      const verdict = verifyPackBytes({ bytes: flipByte(bytes, index), entry, trustedKeys: trusted });
      expect(verdict.ok).toBe(false);
    }
  });

  it("rejects a truncated pack (size mismatch)", () => {
    const bytes = packBytes();
    const truncated = bytes.subarray(0, bytes.length - 512);
    expect(verifyPackBytes({ bytes: truncated, entry, trustedKeys: trusted }).reason).toBe("size-mismatch");
  });

  it("rejects a pack appended with junk bytes", () => {
    const bytes = packBytes();
    const padded = Buffer.concat([bytes, Buffer.alloc(16, 0x41)]);
    expect(verifyPackBytes({ bytes: padded, entry, trustedKeys: trusted }).reason).toBe("size-mismatch");
  });

  it("rejects a signature made by a different key (wrong signature)", () => {
    const forged = {
      ...entry,
      signature: crypto.sign(null, packBytes(), crypto.createPrivateKey(otherKey.privateKeyPem)).toString("base64"),
    };
    expect(verifyPackBytes({ bytes: packBytes(), entry: forged, trustedKeys: trusted }).reason).toBe("signature-mismatch");
  });

  it("rejects an unknown keyId even with a perfectly valid signature", () => {
    const unknownKey = { ...entry, keyId: "attacker-key" };
    expect(verifyPackBytes({ bytes: packBytes(), entry: unknownKey, trustedKeys: trusted }).reason).toBe("key-not-trusted");
  });

  it("rejects a checksum field that does not match the bytes", () => {
    const tampered = { ...entry, sha256: `0${entry.sha256.slice(1)}` };
    expect(verifyPackBytes({ bytes: packBytes(), entry: tampered, trustedKeys: trusted }).reason).toBe("checksum-mismatch");
  });

  it("rejects unknown format versions (forward-compat guard)", () => {
    const future = { ...entry, formatVersion: 99 };
    expect(verifyPackBytes({ bytes: packBytes(), entry: future, trustedKeys: trusted }).reason).toBe("format-version-unsupported");
  });

  it("rejects malformed entries (bad base64, short signature, bad grade id)", () => {
    const badB64 = { ...entry, signature: "!!!not-base64!!!" };
    const b64Verdict = verifyPackBytes({ bytes: packBytes(), entry: badB64, trustedKeys: trusted });
    expect(b64Verdict.ok).toBe(false);
    expect(["signature-malformed", "signature-mismatch"]).toContain(b64Verdict.reason);
    const shortSig = { ...entry, signature: Buffer.alloc(32).toString("base64") };
    expect(verifyPackBytes({ bytes: packBytes(), entry: shortSig, trustedKeys: trusted }).reason).toBe("signature-malformed");
    const badGrade = { ...entry, gradeId: "../etc/passwd" };
    expect(verifyPackBytes({ bytes: packBytes(), entry: badGrade, trustedKeys: trusted }).reason).toBe("grade-id-invalid");
    expect(verifyPackBytes({ bytes: packBytes(), entry: null, trustedKeys: trusted }).reason).toBe("manifest-entry-missing");
  });

  it("device-side @noble/ed25519 verifies compiler (node:crypto) signatures over a real artifact", async () => {
    const bytes = packBytes();
    const ok = await ed.verify(
      Buffer.from(entry.signature, "base64"),
      bytes,
      Buffer.from(signer.publicKeyHex, "hex"),
    );
    expect(ok).toBe(true);

    // ...and still fails closed on tampered bytes with the device verifier.
    const bad = await ed.verify(
      Buffer.from(entry.signature, "base64"),
      flipByte(bytes, Math.floor(bytes.length / 2)),
      Buffer.from(signer.publicKeyHex, "hex"),
    );
    expect(bad).toBe(false);
  });

  it("canonical JSON is key-order stable", () => {
    const a = { z: 1, a: { y: [3, { b: 1, a: 2 }], x: null }, m: "s" };
    const b = { m: "s", a: { x: null, y: [3, { a: 2, b: 1 }] }, z: 1 };
    expect(stableStringify(b)).toBe(stableStringify(a));
    expect(stableStringify(a)).not.toBe(JSON.stringify(a));
  });

  it("pack sha256 is stable across rebuilds of the synthetic registry", () => {
    const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), "packs-sign2-"));
    const { entries: secondEntries } = buildAllPacks({
      registry: syntheticRegistry,
      outDir: secondDir,
      privateKeyPem: signer.privateKeyPem,
      keyId: "trusted-key",
      gradeIds: ["pre-k"],
      tempDir: path.join(secondDir, ".staging"),
    });
    expect(sha256Hex(fs.readFileSync(path.join(secondDir, secondEntries[0].artifact)))).toBe(
      sha256Hex(packBytes()),
    );
  });
});
