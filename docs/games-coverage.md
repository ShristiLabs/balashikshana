# Game-Archetype Coverage Checklist

Issue #52 acceptance artifact. The archetype inventory is **enumerated
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

| archetype id | Status | Renderer | Lands with |
|---|---|---|---|
| `block-builder` | installed (stub) | `StubArchetypeGame` — proves the framework pipeline end-to-end on real registry data; the most common guided archetype | real renderer replaces the stub in #53 |
| `market-cashier` | not installed | practice fallback | #53 (archetype pack A) |
| `bubble-pop-blitz` | not installed | practice fallback | #54 (archetype pack B) |
| `monster-phoneme-feeder` | not installed | practice fallback | #54 (archetype pack B) |
| `tactile-sorter` | not installed | practice fallback | later packs |
| `trace-draw-studio` | not installed | practice fallback | later packs (unit-level registry binding) |
| `lilypad-jumper` | not installed | practice fallback | later packs |
| `bridge-builder` | not installed | practice fallback | later packs |
| `array-grid-architect` | not installed | practice fallback | later packs |
| `slice-share-kitchen` | not installed | practice fallback | later packs |
| `story-detective` | not installed | practice fallback | later packs |

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

## Notes and decisions

- This checklist is the human mirror of the data-derived inventory. The
  registry side is test-enforced (`games-registry-catalog.test.ts`
  re-enumerates and pins `ARCHETYPE_IDS`, both-stages-per-topic, and the
  single 70/20/10 mix); the installed-renderer column above is NOT
  test-pinned to this file (unlike `docs/runner-interaction-coverage.md`,
  whose checklist its test asserts) — keep it in sync when a pack
  registers renderers.
- The stub renderer is a framework proof, not a shipped game: #53
  replaces the `block-builder` entry; the `GameRendererProps` contract
  stays the same (architecture detail: `docs/architecture.md` section 2.10).
