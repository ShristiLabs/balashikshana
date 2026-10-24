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

## What this means for D1 retirement

The native screen now covers the harness's core journey behaviors
(unit DAG ordering, unlock gating, gate progression, grade switching)
with STRICTLY better data guarantees (signed packs, offline-first,
server-reconciled keys). Since #50 the practice runner covers
topic-level flow natively (unit node -> topic picker with per-topic
crowns -> full session), so the harness retains two capabilities the
native app does not yet have: the per-unit guidebook modal, and the
gamification crowns ledger (#55). D1 can be retired after #51 lands
the gate surface; until then the harness remains the only place to
demo the boss-gate flow end to end.

Recommendation: revisit D1 retirement when #51 merges. No harness
code changed in #49 or #50.
