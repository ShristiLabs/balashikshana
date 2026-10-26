# Whole-System Security Review — issue #68 (M6 compliance)

External-style review of the accumulated M1–M5 surfaces with fresh eyes,
conducted 2026-10-26 on `main @ ba7b920` (delivered on
`feat/68-security-review-coppa-pack`). Method: every security-bearing
module read end-to-end (`server.mjs`, `parent-auth.mjs`, `children.mjs`,
`consent.mjs`, `sync.mjs`, `enforcement.mjs`, `portal.mjs`,
`data-rights.mjs`, `retention.mjs`, `observability/redact.mjs`, the Dwara
edge configuration, `infra/` Terraform, every workspace manifest), then a
deliberately adversarial pass hunting CROSS-CUTTING failures the per-issue
reviews could miss: token-kind confusion on routes added after the
original auth seams, rate-limit gaps on newer endpoints, CORS + edge
interplay, schema openness on M1-era bodies, infrastructure drift, and
dependency posture. This is not a rehash of the per-issue review verdicts
(they are cited only where this review re-verified them).

Severity scale: P1 (launch blocker, exploit reachable by an external
party) · P2 (fix before launch) · P3 (recorded debt, fix when touched) ·
P4 (informational/accepted). Security > correctness > performance >
maintainability.

## Findings summary

| ID | Severity | Surface | Finding | Status |
|---|---|---|---|---|
| SR-1 | P2 | authn/data-min | `GET /api/students` served an unauthenticated directory of every child's nickname, avatar, age, and grade to anyone, in every environment | FIXED in this issue |
| SR-2 | P2 | consent integrity | The ACTIVE consent policy text was still the migration-004 placeholder explicitly marked NON-LEGAL ("must replace before public deployment") | FIXED in this issue (migration 014 seeds the production statement v2) |
| SR-3 | P3 | authn at rest | `student_sessions` tokens are stored RAW (M1 scheme) while parent and child-device tokens are SHA-256 digests at rest | DEBT |
| SR-4 | P3 | edge | Dwara stage-1 routes run `auth_required: false` (staged rollout waiting on client releases that present class keys) | DEBT (carried from #65) |
| SR-5 | P3 | input hygiene | M1-era write bodies (`/api/practice/topic/complete`, `/api/gate/evaluate`, `/api/students/:id/calibrate`) are open objects (no `additionalProperties: false`), unlike every post-M2 schema | DEBT |
| SR-6 | P3 | schema truth | `/api/gate/evaluate` handler consumes `responses[].audioDurationSec`, which the route schema does not declare — it arrives only because SR-5 leaves the body open | DEBT (paired with SR-5) |
| SR-7 | P4 | info disclosure | `/api/health` publishes aggregate counts (students, attempts) publicly | ACCEPTED (operational liveness; no per-child signal) |
| SR-8 | P4 | CORS | `methods` allowlist includes PUT — verified used (portal settings/notification-preferences) | ACCEPTED |

Zero P1s found. Two P2s, both fixed in this issue with tests.

## Fixed findings (detail)

### SR-1 — unauthenticated child directory on `GET /api/students` (P2, FIXED)

The M1 contract served the full profile-card listing (nickname, avatar,
age, grade, username, studentId — child personal information under COPPA)
to anonymous callers; authenticated child sessions received the full
listing too. The dev harness login screen needed it; nothing in the
SHIPPED product does — verified that no shipped client calls the route
anonymously: the RN app authenticates via parent onboarding / device
tokens (the only in-repo consumer of the anonymous listing is the dev
harness `apps/mobile/public/index.html`). An unauthenticated directory of
children is data collection disclosure no product need justifies, and a
store-review embarrassment at minimum.

Fix (minimal, dev contract preserved): when `NODE_ENV=production` the
route requires a student or child-device session (anonymous → 401,
parent tokens → 403 wrong-token-type; parents have
`/api/parent/children`), and a student/child-device caller receives ONLY
its own card plus its own summary. Dev mode is byte-for-byte unchanged
(harness + 692-test suite). The ECS task definition sets
`NODE_ENV=production` (`infra/modules/api_service/main.tf`), so the gate
is live in every deployed environment. Tests:
`services/api/test/legal.test.mjs` ("SR-1" describe block) boots a second
server in production mode against the same database and proves all three
outcomes + the dev-mode non-regression. OpenAPI baseline updated
(additive).

### SR-2 — NON-LEGAL consent policy was ACTIVE (P2, FIXED as the issue's core deliverable)

Migration 004 seeded a placeholder consent text that itself says "The
production privacy-policy text arrives with the M6 compliance pack and
must replace this placeholder before any public deployment." Until this
issue, parents were accepting placeholder text — a consent-integrity
failure in the making. Migration 014 replaces it with the production
consent statement (v2) and ships the legal pack (see
`docs/legal/README.md`). Every development-stage consent at v1 is now
stale by design: those parents re-consent at v2 before further
child-data creation (one-time, correct — the machinery exists for
exactly this).

## Debt findings (detail)

### SR-3 — raw student session tokens at rest (P3)

`resolveBearerAuth` looks up `student_sessions WHERE token = $1` (raw,
M1) vs SHA-256 digests for parent and child-device tokens (migrations
003/005 doctrine). Exploit requires database read access (SQL injection,
backup leak, insider); impact is session replay for the child's own data
within the 30-day TTL, not privilege escalation (student sessions are
the lowest-privilege kind). Fix shape when taken: new `token_hash`
column + migration backfill (impossible — raw values can be hashed
in-place: `UPDATE ... SET token_hash = encode(sha256(token::bytea),...)`
is feasible), resolver change, drop raw column. Not done in-flow: it
touches the hottest auth path and every student-auth test for a
defense-in-depth gain; scheduled as debt for the next auth-surface issue.

### SR-4 — edge stage-1 `auth_required: false` (P3, carried)

Documented staged rollout (#65): the origin keeps full auth, the edge
adds volumetric limits, and flipping to `auth_required: true` waits on
client releases that present the class API keys (edge keys are classified
traffic markers, not secrets — ADR in `docs/gateway.md`). Re-verified:
every route still strips `X-Consumer-*` toward the origin, the admin
listener is mTLS-only, and the origin's own auth is untouched. Carries
forward unchanged.

### SR-5 + SR-6 — open M1-era schemas and the audioDurationSec gap (P3, paired)

`practiceCompleteSchema`, `gateEvaluateSchema`, and `calibrateSchema`
lack `additionalProperties: false` (every post-M2 body schema has it).
Unknown fields are accepted and ignored — hygiene, not directly
exploitable. But closing them naively BREAKS the product: the
`/api/gate/evaluate` handler reads `responses[].audioDurationSec`
(`computeCognitiveTimeSec(rawTimeSec, motorSec, r.audioDurationSec || 0)`)
which the schema never declared (SR-6) — it only works because the body
is open. A proper fix must first add the missing property declarations
(including `audioDurationSec` on gate responses, mirroring the sync
schema which has it), then close the objects, then prove the harness and
mobile payloads pass. Recorded as one debt unit; the schema drift note
also goes to the OpenAPI baseline when fixed.

## Verified-good surfaces (re-verified with fresh eyes, evidence cited)

**Token-kind separation (authn/authz).** One resolver
(`resolveBearerAuth`) distinguishes parent (hashed), child-device
(hashed), and student (raw) kinds; every route family enforces the right
kind: student routes reject parent tokens with 403 wrong-token-type
(`requireStudentAccess`), parent routes reject student/child-device
tokens (`requireParentAuth`), sync accepts child-device ONLY
(`sync.mjs`: `auth.kind !== "child-device"` → 403). Session binding to
the student comes from the TOKEN, never the body — the sync idempotency
key's device component cannot be spoofed. Archived children fail every
student-scoped route and PIN-login identically to unknown students (no
archive-state oracle). Rotation is atomic revoke-then-insert (concurrent
refresh loses, no replay); password reset revokes every session and
supersedes sibling tokens in one transaction.

**IDOR denial.** Portal and data-rights routes resolve ownership through
`requireOwnedChild` (parent_children binding); sync/progress through
token-bound student identity; the public listing issue was SR-1 (fixed).
No route accepts a client-supplied identity for authorization decisions.
Cross-checked the later-added routes specifically (gamification ledger
read, placement record, portal analytics/settings, export/delete): all
sit behind the shared guards — the "new routes forget the old doctrine"
attack found no instance.

**Consent integrity.** `consent_records` append-only (no update/delete
route exists); timestamps server-side only; capture method derived from
evidence state; policy catalog append-only with a partial unique index
enforcing one active row; the gate-to-commit TOCTOU window closed by
`assertActivePolicyUnchanged` inside every creation transaction. The
suite-end invariant (no student/progress row without consent lineage,
`audit_students_without_consent` empty) re-verified post-M3–M5 on this
branch's run (consent.test.mjs, green).

**Sync integrity.** Idempotency is database-enforced
(`uq_attempts_client_seq` + `ON CONFLICT DO NOTHING`): replayed batches
insert nothing and return identical snapshots. Whole-session contract
with convergent replay over the batch-union (documented residual: SR
stability takes one growth step per session — accepted #48 behavior).
Clock policy: past accepted (offline reality), future beyond 5 minutes
clamped to server receive time; the 14-hour Gold window evaluates at the
session's adopted timestamp. Batch caps (200 attempts / 50 outcomes) +
per-token bucket (30/min) bound abuse.

**Rate limiting + CORS + edge interplay.** Layers: global per-IP
(Fastify) → per-token in-memory buckets → route-level buckets on every
credential surface (login 10/min, signup 5/min, reset 5/min, claim
10/min, delete 5/min) → edge per-class/per-IP/hour-scale buckets sized
above origin limits. The specifically cross-cutting questions this
review asked: (a) do NEWER endpoints lack buckets? — every post-M2 route
presents a bearer (global per-token applies); the public additions
(policy/latest, legal/latest, packs) are read-only static-ish content
behind per-IP; no gap found. (b) Does edge XFF handling let a client
spoof the per-IP key? — `TRUST_PROXY_CIDRS` is peer-checked (XFF honored
only when the socket peer is inside the listed range), empty by default;
a direct-origin client cannot spoof. (c) CORS: explicit allowlist only,
wildcards rejected at boot in production, preflights from disallowed
origins rejected, `credentials: false`; the OPTIONS short-circuit runs
before @fastify/cors (both verified in tests). Edge consumer keys are
public-by-design traffic classifiers, stripped toward the origin.

**Data protection.** TLS: edge terminates TLS, edge→origin over TLS
(deploy/dwara envs); passwords/PINs scrypt (OWASP floor params, shared
helpers, rehash-on-login for legacy rows); parent/child-device tokens
SHA-256 at rest (SR-3 records the student-token exception); deletion
requires password re-auth + lands in an append-only audit ledger; export
excludes credential columns by selection; telemetry redacts at capture
(no bodies ever, IP truncated to network prefix, route-class labels,
token/email/phone scrubbers, flood-capped error store, 30-day error
retention); metrics on a separate internal listener, never edge-routed.

**Supply chain.** Runtime dependency inventory (now allowlist-enforced
by `apps/mobile/tests/coppa-invariants.test.ts`): API 8 (fastify, three
@fastify plugins, pg, node-pg-migrate, nodemailer, pino), mobile 24
(expo/RN/react + noble crypto + netinfo), portal 2 (react, react-dom),
core-engine 0, content-pipeline 0. No ad/analytics/tracking SDK anywhere
(vendor blocklist scan over every manifest, runtime and dev). npm audit
0 across workspaces (standing @expo/cli devDep upstream flags excepted).
Content packs Ed25519-signed; the device verifies signatures before use.

**Infrastructure posture.** Terraform validate-only in CI (no
unreviewed applies), secrets in SSM Parameter Store with the
infra-secrets test refusing key material in-repo (edge keys referenced
via `${...}` env indirection), security groups per-module (metrics
scrape-source-only), `NODE_ENV=production` set by the ECS task def
(which is what activates SR-1's fix). Drift risks reviewed: staging/prod
edge envs are byte-identical except the origin triple (enforced by
`dwara-config.test.mjs` env-parity check).

## Parental-gate audit

The hold-to-confirm gate (the COPPA "are you a grown-up" barrier) was
audited for bypass resistance; the full matrix (tap-spam, keyboard,
gesture-cancel, timing, accessibility bypass) with per-vector evidence
lives in `docs/families-kids-self-check.md` (audit layer 3). Headline:
the timing model is a pure module (`gateTimer.ts`) where completion
requires one continuous 3-second press — every release resets, ticks
without a press never complete, there is no tap-to-pass accessibility
action, and setInterval (not an animation API) makes OS reduced-motion
irrelevant to gate behavior. #62's gesture-cancel fix is in place
(system-interruption cancel delivers press-out → reset). Automated
coverage: `onboarding-gate-timer.test.ts` (timing model) +
`coppa-invariants.test.ts` (gate placement: every parent-content render
sits after the gate branch; parent-surface modules do not leak into
child-facing routes).

## Retest instructions

- Full API suite (includes the SR-1 production-mode boot and the legal
  pack): `npm test --workspace @balashikshana/api` (692 tests).
- COPPA invariant scans + legal shipping pins:
  `npm test --workspaces=false --prefix apps/mobile` (1069 tests).
- Store-submission consumption: `docs/data-flow-inventory.md` is the
  source of truth for #69's Data Safety forms.
