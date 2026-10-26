# Journey map: native app vs. dev harness (D1 parity notes)

Issue #49 acceptance criterion: a side-by-side behavior comparison with
the dev harness (`apps/mobile/public/index.html`, roadmap decision D1)
to drive the D1 retirement decision. Written from the shipped #49
implementation (mobile src/journey) against the harness's
`renderJourneyPath()` behavior.

## Data source parity (the core of the decision)

| Behavior | Dev harness (D1) | Native app (#49) |
|---|---|---|
| Unit list | Live API `/api/curriculum/summary` (network-required) | Installed #46 pack, query_only reader, offline-first |
| Progress | Server session only (`loggedInStudent`) | Local #47 projection + #48 server-authoritative snapshot on mount |
| Key states | Not rendered (gate badge text only) | Silver/Gold badges with provisional distinction + 14 h countdown |
| Unit unlock | Prereq units all MASTERED (same rule) | Same rule, derived in `src/journey/model.ts` (tested DAG matrix) |
| Unit states | completed / current / locked (3 visual states) | All 7 engine UNIT_STATES, shape+color redundant |
| Garden health | None | Computed aggregate (mastered fraction + gate health), no hardcoded values |
| Grade switcher | Dropdown, refetches catalog | Chips over installed packs; download/stale states; per-grade progress preserved |
| Winding path | CSS translateX offsets per topic stone | SVG sine path through unit nodes; scroll-linked reveal (reduced-motion safe) |
| Topic stones | One node per topic + boss gate node per unit | Unit-level nodes with topic completion fraction (#50 drills in) |
| Crowns | Crown emoji strips per topic | Not surfaced (gamification ledger is #55, out of scope) |
| Sounds / mascot | SFX + speech on node taps | Not ported (#45 audio infra exists; celebration moments are #58) |
| Guidebook modal | Per-unit guidebook modal | Not ported (study materials ride the pack; #50/#51 surfaces consume them) |
| A11y | Web-only basics | Spoken labels per node, >=48pt targets, reduced-motion, highContrast theme |

## Boss gate flow (#51 update)

| Behavior | Dev harness (D1) | Native app (#51) |
|---|---|---|
| Session composition | `/api/curriculum/unit` stratified round-robin, current unit only | 70/20/10 interleaved spiral mix (AGENTS.md Stage-4 rule): current unit + prerequisite contrast + due spaced review, deterministic |
| Evaluation | `POST /api/gate/evaluate` (network-required) | Same `evaluateMasteryGateAttempt` engine call on-device; identical verdicts for identical attempts (D3, test-pinned incl. foreign-topic attribution) |
| Results | Simple pass/fail + remediation text | All five conditions with metrics and thresholds, per-topic 75% floor table, remediation routing into focused practice |
| Two-key flow | Day-1 Silver via the server's #48 machine; no Gold verification UI (the check exists only in the native runner and the sync replay) | Silver on pass (provisional); 14 h countdown; 60 s / 5-item / >= 4 Gold check; forward-only keys, #48-server-reconciled |
| Ceremony | None | Silver/Gold key ceremony (fanfare + narration + haptics), reduced-motion instant reveal |

The composition difference is INTENTIONAL, not debt: AGENTS.md binds
Stage 4 gates to the 70/20/10 spiral mix, and the native runner
implements it; the harness's round-robin builder remains the reference
for the server's ONLINE question-serving path
(`/api/curriculum/unit`), which the native app does not use (it
evaluates locally and syncs attempts per #48).

## What this means for D1 retirement

The native screen now covers the harness's core journey behaviors
(unit DAG ordering, unlock gating, gate progression, grade switching)
with STRICTLY better data guarantees (signed packs, offline-first,
server-reconciled keys). Since #50 the practice runner covers
topic-level flow natively (unit node -> topic picker with per-topic
crowns -> full session), and #51 lands the boss gate end to end
(spiral session, five-condition results, key ceremony, Gold
verification check — all offline with sync convergence). The harness
retains two capabilities the native app does not yet have: the
per-unit guidebook modal, and the gamification crowns ledger (#55).

Recommendation: the D1 retirement preconditions named in #49/#50 are
now met; the decision itself belongs to the user (it gates the web
fallback story for D1). No harness code changed in #49, #50, or #51.

## RETIRED (#71, 2026-10-26) — the web export supersedes the harness

Decision executed in #71 (final M6 issue): the dev harness is RETIRED.

- WHAT WAS REMOVED: `apps/mobile/public/index.html` (the single-HTML
  harness). Retirement was a BUILD REQUIREMENT, not just cleanup: the
  web export copies `public/` verbatim into `dist/`, so the harness
  index.html collided with the export's generated document shell.
- WHAT REPLACES IT: the Expo web export of the REAL app
  (`npx expo export --platform web`), served on the SAME origin+port
  (:4200) by the repurposed `apps/mobile/server.mjs` — the harness's
  one remaining unique value (browser dev interaction) is now the
  actual product in a browser, with strictly better guarantees (signed
  packs, offline storage, sync convergence — see docs/web-export.md).
- The parity tables above are retained as the historical D1 record.
