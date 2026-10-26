# Performance Budget

Issue #67 (M6 audit gate). This document is the binding budget for the
kid app's JS payload and the protocol for the 60fps low-end device
matrix. All numbers below are MEASURED on the delivery branch — never
asserted. The repeatable measurement is `scripts/measure-bundle-sizes.mjs`
(report + `--check` enforcement); rerun it after every export.

## 1. Hermes bundle budget (enforced)

Measured after `npx expo export --platform ios --platform android`
(apps/mobile, this branch, 2026-10-26):

| Platform | Bundle (bytes) | MiB | % of budget |
|---|---|---|---|
| android | 5,237,927 | 4.995 | 90.8% |
| ios | 5,248,165 | 5.005 | 91.0% |

**Budget: 5,767,168 bytes (5.5 MiB) per platform.**

Rationale: the measured baseline plus ~10% headroom. Content packs are
NOT part of the JS bundle (they download per grade through the #46 pack
lifecycle), so JS growth is code only; 10% bounds ordinary feature
growth while catching accidental dependency or asset regressions.

Delta from this audit's own fix (+ ~3.9 KB per platform, the
screen-reader announcement seam): well within headroom.

Enforcement (repeatable):

```sh
cd apps/mobile && npx expo export --platform ios --platform android
node scripts/measure-bundle-sizes.mjs --check   # exit 1 when over budget
```

The export step runs in every delivery regression; the `--check` flag
is the gate. Changing the ceiling is a budget decision — update this
document in the same commit that moves it.

## 2. Export asset weight (enforced, pre-existing)

- `scripts/check-animation-assets.mjs` (CI): all SVG/Rive animation
  assets < 50 KB each, zero raster media anywhere in shipped assets.
- Measured export assets (apps/mobile/dist/assets): 312 KB total.
- Curriculum visual aids (root `assets/images/`) are all SVG — no raster
  blobs; the video manifest is pipeline metadata, not app-shipped media.

## 3. Frame budget: 60/120 fps (AGENTS.md rule)

Static-audit findings (this issue) — the runtime matrix below is the
user-side verification step:

- **Animation surfaces are few and transform-only.** Exactly four
  components animate: MascotView + BadgeBloomView + KeyCeremony (RN
  `Animated`, transform-only) and JourneyPath/JourneyScreen
  (react-native-reanimated scroll-linked reveal; `onScroll` handler is
  detached entirely under reduced motion). Transform/opacity animation
  stays on the compositor — no JS-frame layout animation exists in the
  app. Pinned by `apps/mobile/tests/accessibility-source-pins.test.ts`
  (any NEW `Animated.*` site outside the audited set fails the suite,
  which forces a conscious perf + reduced-motion decision).
- **List virtualization: not needed at current scale.** The journey map
  renders one grade's units (~26-30 nodes, 130 units / 5 grades) in a
  ScrollView; a FlatList at that count adds complexity for no measured
  win. Decision threshold: revisit virtualization if a grade map
  exceeds ~60 interactive nodes.
- **Re-render discipline.** Hot-path screens hoist callbacks and derive
  per-render data via useMemo/useCallback (practice runner and gate
  each carry 12 memoization sites; games carry 4-6). No React.memo on
  widget components — deliberate: interactive widgets render at most
  one question's worth of children (<= 8 choices/tiles), so a memo
  layer costs more than the re-render. Revisit if a widget grows past
  ~20 children.
- **Timers.** The gate clock ticks at 1 Hz (500 ms interval driving
  second-granularity display); a 1 Hz re-render of a text node is
  negligible.

## 4. Low-end device matrix (user-side run, protocol fixed here)

Run BEFORE store submission (#69), on each device below. Record device
model + OS version + numbers in the audit report addendum so results
are reproducible.

| Matrix slot | Example device class | What to measure |
|---|---|---|
| Low-end Android (2-3 GB RAM, ~2019 chipset) | Moto G-series / Galaxy A1x | Practice session, one game archetype, one gate run: frames via RN Dev Menu Perf Monitor (target: no sustained drops below 55 fps during interaction); cold start to journey map (target < 4 s); pack download + first open |
| Older iOS | iPhone SE (2nd gen) / iPhone 8 | Same measurements as above |
| Chromebook (Android app container) | Low-end Chromebook, Play Store container | Same measurements + keyboard focus traversal |

Memory: record JS heap before/after one full unit session (React
DevTools Profiler); no monotonically growing heap across 3 sessions
(leak check).

## 5. TTS variance spot-check (roadmap risk #5)

On each matrix device, run one practice topic with narration on and
verify: (a) narration speaks with the calibrated rate (no device voice
garbling), (b) when the OS TTS engine is unavailable or throws, the
coordinator falls back to bundled Pre-K audio (logic verified by
`apps/mobile/tests/audio-*.test.ts`; the coordinator's
`fallBackToBundled` path is unit-tested). Record the observed engine
per device in the matrix addendum.

## 6. Bundle composition (measured, informational)

The ~5.0 MiB bytecode is dominated by the Expo 58 / React Native 0.88
runtime + react-native-svg + reanimated. First-party screen/logic code
is a small fraction; there are no dynamic-import code-splitting seams
in Expo exports today. If the budget ever tightens, the lever is
dependency reduction, not first-party code.
