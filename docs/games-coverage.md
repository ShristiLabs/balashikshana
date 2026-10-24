# Game-Archetype Coverage Checklist

Issues #52/#53 acceptance artifact. The archetype inventory is **enumerated
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
| `bubble-pop-blitz` | not installed | practice fallback | - | #54 (archetype pack B) |
| `monster-phoneme-feeder` | not installed | practice fallback | - | #54 (archetype pack B) |
| `tactile-sorter` | not installed | practice fallback | - | later packs |
| `trace-draw-studio` | not installed | practice fallback | - | later packs (unit-level registry binding) |
| `lilypad-jumper` | not installed | practice fallback | - | later packs |
| `bridge-builder` | not installed | practice fallback | - | later packs |
| `array-grid-architect` | not installed | practice fallback | - | later packs |
| `slice-share-kitchen` | not installed | practice fallback | - | later packs |
| `story-detective` | not installed | practice fallback | - | later packs |

History: `block-builder` was carried by the #52 proof-of-pipeline
`StubArchetypeGame` until #53 shipped the real renderer; the stub is
now UNREGISTERED and stays in the tree as the authoring template for
the #54 pack.

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
- Both installed renderers implement the two variants off the SAME
  contract props (`gameStage` + `targetResponseSpeedSec`): guided
  surfaces the step-by-step hint chain and the full scaffold; fluency
  suppresses renderer hints and paces off the framework header's speed
  target. No renderer carries a clock.

## Pack A coverage footprint (issue #53, data-derived)

The registry binds these two archetypes at topic level on the GUIDED
side only — their topics' Stage 3 fluency sprint is
`bubble-pop-blitz`/`bridge-builder` and stays on the practice fallback
until #54+ register those renderers:

- `block-builder` — 136 topics' `guidedPracticeGame` (counting and
  place-value strands across PK–G3).
- `market-cashier` — 32 topics' `guidedPracticeGame` (money,
  measurement, and the social-studies cashier units).

`tests/games-registry-catalog.test.ts` route-flip pins this: EVERY
guided block-builder/market-cashier topic resolves to `kind: "game"`
against the installed renderer set (never fallback).

## Notes and decisions

- This checklist is the human mirror of the data-derived inventory. The
  registry side is test-enforced (`games-registry-catalog.test.ts`
  re-enumerates and pins `ARCHETYPE_IDS`, both-stages-per-topic, the
  single 70/20/10 mix, and the pack A route flip); the
  installed-renderer column above is NOT test-pinned to this file
  (unlike `docs/runner-interaction-coverage.md`, whose checklist its
  test asserts) — keep it in sync when a pack registers renderers.
- The #52 stub renderer was a framework proof, not a shipped game; #53
  replaced its registration with the real `BlockBuilderGame`
  (`GameRendererProps` contract unchanged — architecture detail:
  `docs/architecture.md` section 2.10).
