# Practice-Runner Interaction-Type Coverage Checklist

Issue #50 acceptance artifact. The interaction-type inventory is
**enumerated from the data**, never hand-listed: the #46 pack compiler
seeds every `practice_questions` row from the engine's
`generateTopicPracticeSet(unit, topic, 10)` over each registry topic
(`tools/content-pipeline/src/rows.mjs`), and
`tests/runner-interaction-coverage.test.ts` reproduces exactly that
derivation (registry JSON -> engine generator -> distinct
`interaction_type` values) and FAILS when any type has neither a
renderer in `apps/mobile/src/runner/interactionRegistry.ts` nor an
entry in `TRACKED_FALLBACK_TYPES`. This checklist is the human-readable
mirror of what that test derives; the test also asserts this file lists
exactly the derived inventory, so the two cannot drift.

## Renderer inventory (widget kit v1)

| interaction_type | Renderer | Widget | Concrete stage | Later CPA stages |
|---|---|---|---|---|
| `multiple-choice` | registered | `ChoiceGrid` | choice cards + static visual row | visual fades: static -> flash -> none |
| `tile-builder` | registered | `TileBuilder` | tap-to-place tile bank + answer slots | falls through to `ChoiceGrid` (every seeded row carries full-sequence choices) |
| `interactive-counter` | registered | `CounterFrame` | tap-to-toggle counting frame (5-column) | falls through to `ChoiceGrid` |

Seeded distribution (6,140 rows): `multiple-choice` 5,228,
`tile-builder` 712, `interactive-counter` 200.

## Tracked fallbacks

None at v1 (`TRACKED_FALLBACK_TYPES` is empty). Adding an entry
requires a row here explaining why the type intentionally renders
through a shared widget.

## CPA stage handling (engine-owned)

Stage selection is engine state, never UI heuristics:
`stageForTopicProgress(topic_progress row)` mirrors the engine's
`updateTopicMemoryStability` cpaStage thresholds over the topic's
`stabilityDays` (no progress row -> `CONCRETE_INTERACTIVE`).
`tests/runner-cpa.test.ts` pins the mirror against the engine across a
stability sweep. Rendering: concrete = interactive manipulative;
pictorial = static visual + choices; ghost-flash = 1-second visual peek
then hidden (content timing, not animation); abstract = choices only.

## Notes and decisions

- The 12 SVG manipulative `assets/images/*.svg` anchor the WEB harness
  concrete stage. On native, the widget kit renders the manipulatives
  interactively (the counting frame IS the ten-frame); the visual_aid
  asset stem surfaces as the manipulative-anchor label on the visual
  scaffold. Full native SVG art parity remains deferred to the M4
  archetype renderer packs (#54 and later — issue #53's pack A renderers
  are RN component surfaces over the existing widget kit; see
  `docs/games-coverage.md`).
- Every seeded row carries a non-empty `choices` array (asserted by the
  coverage test), so the choice grid is the universal degraded-stage
  surface and no question can ever be unanswerable.
- Re-queued presentations re-present the SAME question row with a
  "spaced replay" badge (the web-harness-validated pattern); the
  Lag +2/+5/+10 ladder lives in the pure scheduler
  (`apps/mobile/src/runner/requeue.ts`), pinned to the engine's
  `intraSessionExpandingLags` constant by test.
