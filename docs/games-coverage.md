# Game-Archetype Coverage Checklist

Issues #52/#53/#54 acceptance artifact. The archetype inventory is **enumerated
from the data**, never hand-listed: `docs/us-curriculum-registry.json`
references exactly 11 archetype ids across unit-level `games` blocks and
the per-topic `assets.games` bindings (all 614 topics carry BOTH a
`guidedPracticeGame` and a `fluencySprintGame` — 1,228 game bindings),
and `apps/mobile/tests/games-registry-catalog.test.ts` re-derives that
inventory from the registry, failing if `ARCHETYPE_IDS`
(`apps/mobile/src/games/archetypes.ts`) ever drifts from the data.

"Installed" is a RUNTIME property — which renderers are registered in
`ARCHETYPE_RENDERERS` (`apps/mobile/src/games/archetypeRegistry.ts`) —
never a property of the inventory: an id with no renderer routes to the
practice fallback with reason `archetype-not-installed`, never to an
error screen.

## Renderer inventory

| archetype id | Status | Renderer | Stage variants | Lands with |
|---|---|---|---|---|
| `block-builder` | installed | `BlockBuilderGame` (issue #53, pack A) — bundled build rail, item-data-driven surfaces | guided + fluency | shipped in #53 |
| `market-cashier` | installed | `MarketCashierGame` (issue #53, pack A) — checkout coin pad, price/paid/change | guided + fluency | shipped in #53 |
| `bubble-pop-blitz` | installed | `BubblePopBlitzGame` (issue #54, pack B) — seeded bubble-per-choice reflex field, tap-to-answer via the reflex submit seam, D6-tiered pressure chip | fluency (guided surface implemented) | shipped in #54 |
| `monster-phoneme-feeder` | installed | `MonsterPhonemeFeederGame` (issue #54, pack B) — audio-first replay affordance + ordered phoneme tile feeding over the shared TileBuilder | guided (fluency surface implemented) | shipped in #54 |
| `tactile-sorter` | not installed | practice fallback | - | later packs |
| `trace-draw-studio` | not installed | practice fallback | - | later packs (unit-level registry binding) |
| `lilypad-jumper` | not installed | practice fallback | - | later packs |
| `bridge-builder` | not installed | practice fallback | - | later packs |
| `array-grid-architect` | not installed | practice fallback | - | later packs |
| `slice-share-kitchen` | not installed | practice fallback | - | later packs |
| `story-detective` | not installed | practice fallback | - | later packs |

History: `block-builder` was carried by the #52 proof-of-pipeline
`StubArchetypeGame` until #53 shipped the real renderer. With four real
renderers installed (#53 pack A + #54 pack B), the stub was DELETED in
#54 — the real renderers are the authoring templates now (pure module
+ thin RN component over the widget kit).

Note: `docs/games-and-study-materials.md` section 2 catalogues "10
archetypes" — it presents `bubble-pop-blitz` and `story-detective` in
one row, and `trace-draw-studio` appears at unit level only. The
registry (and therefore `ARCHETYPE_IDS`) is the source of truth: 11 ids.

## Fallback semantics (never a dead end)

`resolveGameRoute` decides BEFORE any session opens, in order:

1. no games block at all -> `no-games-block`
2. stage not offered by the topic -> `stage-missing`
3. archetype has no installed renderer -> `archetype-not-installed`

Every miss mounts the SAME topic in the #50 practice runner
(`PracticeRunnerScreen`) — identical item sourcing to a plain practice
session, transparent to the child — with a fallback marker riding every
attempt row (`game_fallback = 1`, plus the intended archetype and the
stage's speed target) so fallback reach is measurable in local
telemetry. The stage picker previews the state per stage ("This one
plays in practice mode for now").

## Stage model

- `guided` — untimed explorer; composes current-topic items only
  (the registry carries `spiralMix` on the fluency config alone).
- `fluency` — timed sprint; composes the topic's own `spiralMix`
  (70/20/10 across today's registry, carried per topic as data) through
  the #51 allocator (`allocateSpiral`, parameterized once — the boss
  gate keeps the registry default, so #51 behavior is unchanged).
- Session length for BOTH stages is `guidedPracticeGame.minQuestionsToComplete`
  (8 across today's registry) — the registry's single length knob.
- Both installed packs implement the two variants off the SAME contract
  props (`gameStage` + `targetResponseSpeedSec`): guided surfaces the
  step-by-step hint chain and the full scaffold; fluency suppresses
  renderer hints and paces off the registry's `targetResponseSpeedSec`.
  No PURE module carries a clock — the framework screen owns timing and
  grading. The one deliberate exception at the component layer: pack B's
  blitz renderer samples the pure module's quantized pressure phase on a
  presentational 250 ms tick (`PRESSURE_TICK_MS`) so the fluency sprint
  can show pacing state; the tick never feeds grading or timing math
  (drift bound is test-pinned in `tests/bubble-pop-blitz.test.ts`).

## Pack A coverage footprint (issue #53, data-derived)

The registry binds these two archetypes at topic level on the GUIDED
side only — their topics' Stage 3 fluency sprint is
`bubble-pop-blitz` (120 of the 168, flipped by #54) or `bridge-builder`
(48, still fallback until its pack lands):

- `block-builder` — 136 topics' `guidedPracticeGame` (counting and
  place-value strands across PK–G3).
- `market-cashier` — 32 topics' `guidedPracticeGame` (money,
  measurement, and the social-studies cashier units).

`tests/games-registry-catalog.test.ts` route-flip pins this: EVERY
guided block-builder/market-cashier topic resolves to `kind: "game"`
against the installed renderer set (never fallback).

## Pack B coverage footprint (issue #54, data-derived)

The reflex/ELA pack flips the FLUENCY side of every blitz topic and the
GUIDED side of every feeder topic:

- `bubble-pop-blitz` — 250 topics' `fluencySprintGame` across ALL five
  grades (PK 47, K 64, G1 55, G2 41, G3 43), per-topic
  `targetResponseSpeedSec` 3.0–14.0 driving the pacing. Presentation is
  D6 age-tiered off the structural topic prefix: Pre-K/K/G1 (and any
  unrecognized grade) get the gentle tier that can structurally never
  show the urgent phase; only G2–G3 get sprint copy. Pressure paces —
  there is no per-item deadline anywhere (the win rule is median-based).
- `monster-phoneme-feeder` — 102 topics' `guidedPracticeGame` across 22
  ELA units (`PK-E1`…`K-E5`, `G1-E1`…`G1-E5`, `G2-E1/E2/E3/E4/E8`,
  `G3-E1/E8`); the first ELA surface on the game framework. Every one of
  those topics' fluency sprint IS a `bubble-pop-blitz`, so all 102 ELA
  topics flip BOTH stages with #54.

`tests/games-registry-catalog.test.ts` pins all three route flips
(250 fluency + 102 guided + 102 both-stage) AND enumerates the six
archetypes still on the practice fallback after #54 (guided
bridge-builder/array-grid-architect/tactile-sorter/story-detective/
slice-share-kitchen; fluency adds lilypad-jumper).

## Notes and decisions

- This checklist is the human mirror of the data-derived inventory. The
  registry side is test-enforced (`games-registry-catalog.test.ts`
  re-enumerates and pins `ARCHETYPE_IDS`, both-stages-per-topic, the
  single 70/20/10 mix, and the pack A + pack B route flips with the
  remaining-fallback enumeration); the
  installed-renderer column above is NOT test-pinned to this file
  (unlike `docs/runner-interaction-coverage.md`, whose checklist its
  test asserts) — keep it in sync when a pack registers renderers.
- The #52 stub renderer was a framework proof, not a shipped game; #53
  replaced its registration with the real `BlockBuilderGame` and #54
  deleted the retired stub file outright. #54 also added the one
  conscious `GameRendererProps` extension — the OPTIONAL reflex submit
  seam `onSubmitAnswer` (tap-to-answer archetypes submit on the tap;
  build-then-check renderers ignore it) — see
  `docs/architecture.md` section 2.10.
