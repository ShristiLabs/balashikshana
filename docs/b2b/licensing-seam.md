# B2B Licensing Seam (issue #70, roadmap D10)

A **seam, not a product**: this documents the school/district seat-license
validation infrastructure — license activation, seat validation, and the
teacher roster-import **stub** — that the future schools platform will
stand on. The full schools platform (teacher UX, classes, assignments,
school analytics, SSO roster integrations) is explicitly future work. The
ShristiLabs licensing platform owns issuance and billing; nothing here
talks to it at runtime.

## What shipped

| Surface | What it is |
|---|---|
| `services/api/license-verifier.mjs` | Offline verifier for licensing-core license files (Ed25519 over canonical claims) |
| `services/api/b2b.mjs` | The four `/api/b2b/*` routes (activation, seat status, seat claim, roster dry-run) |
| Migration `015_b2b_licensing` | `organizations`, `organization_licenses`, `organization_seats` |
| `docs/legal/ferpa-dpa-posture.md` | The FERPA/DPA posture notes (with the counsel banner) |
| This document | The seam architecture + the licensing-core integration path |

## Claim verification path

The license wire format is ShristiLabs **licensing-core claims v2** (the
shared Rust crate at `ShristiLabs/licensing`): a flat JSON object of the
claims plus a `signature` field — a base64-encoded, detached **Ed25519**
signature over the claims serialized as **canonical JSON** (every
object's keys sorted recursively by Unicode code point — UTF-8 byte
order, matching serde_json's BTreeMap — compact, array order preserved).

The API cannot import the Rust crate, so `license-verifier.mjs` implements
licensing-core's exact verification semantics in JS via the audited
`@noble/ed25519` (the same library the mobile app already uses to verify
signed content packs — `apps/mobile/src/content/verify.ts`). Ed25519 is
deterministic per RFC 8032: a signature produced over canonical claims by
any compliant implementation is byte-identical to ed25519-dalek's
(licensing-core) for the same key and message. The API test suite pins a
**golden vector** — canonical bytes + signature over the public dev seed
— proving format compatibility without a Rust toolchain.

Verification order (mirrors `LicenseVerifier::verify_claims`):

1. Parse + validate claims v2 types (unknown extra fields are ignored —
   serde's tolerant default, pinned by a parity test).
2. Strict base64 decode of the signature; must be exactly 64 bytes.
3. Ed25519 verify over the canonical claims JSON.
4. `expires_at` check (`now > expires_at` => expired).
5. Product pin: `product_id` must be `balashikshana` (defense in depth on
   top of the per-product key — a license issued for another ShristiLabs
   product is rejected even under improbable key reuse).

There is **no runtime licensing-server dependency**: verification is
fully offline, as the issue requires. Revocation is therefore **local**
— an offline license cannot be remotely revoked. The mitigations are
bounded `expires_at` windows and the local `revoked` status
(`organization_licenses.status`), which is an operator action recorded in
the database. This is an honest property of offline licensing, not a gap
in this implementation.

## Key management (the issue's AC)

Products embed **only their public key** (licensing `KEY_MANAGEMENT.md`):

- Production: `BALASHIKSHANA_LICENSE_PUBLIC_KEY` (base64 32-byte Ed25519
  public key), mirroring the `MADHYAMAS_LICENSE_PUBLIC_KEY` pattern.
- Absent + production: **loud boot error**, no throw (the SMTP-flip
  precedent — dev/staging ECS tasks run `NODE_ENV=production` with empty
  config and must stay up; the dev-key fallback cannot verify real
  licenses anyway).
- Absent + dev/test: licensing-core's **public** development keypair,
  derived at runtime from the public `DEV_KEY_SEED` constant (it is
  public by design, on the licensing side; nothing was copied from the
  licensing repo's gitignored `keys/` directory).
- Set but **invalid**: verification is **disabled** (fail closed — every
  activation returns 503 `b2b-license-verifier-unavailable`); a
  misconfigured deployment must never silently fall back to the dev key.

No signing material exists in this repo — the verifier can only verify.

## Seat model

- One **organization** per parent account (`uq_organizations_owner`): the
  activating parent IS the org's administrative surface for the seam's
  lifetime. No teacher token kind was added (the issue ships no teacher
  UX); every `/api/b2b/*` route takes the existing parent session token
  (403 `wrong-token-type` for student/child-device tokens, 401
  anonymous — tested). The org `name` freezes at FIRST activation
  (claims `customer`); a renewal under a renamed customer keeps the
  original name — cosmetic, deliberate (stable identity beats chasing
  issuer copy; reviewer advisory).
- `license_id` (from the claims) is **globally unique** across orgs: a
  re-activation attempt by anyone gets 409.
- At most one **active** license per org (partial unique index); renewal
  supersedes the old row only once it has expired (`status='superseded'`,
  append-only audit: license rows and their signatures are never edited
  or deleted).
- **Seats** are opaque subject labels (a teacher/staff identifier at the
  school's discretion), unique per org. Seat claims **re-validate the
  active license's expiry at write time**; accounting counts only seats
  on the active license. `GET /api/b2b/licenses/current` reports
  licensed/assigned/remaining and `licenseState: active-expired` when the
  clock has passed expiry.

## Roster-import stub

`POST /api/b2b/roster/validate` is a **validation-only dry run**. Intake:

- CSV (`Content-Type: text/csv`): header row of exactly
  `student_name,grade,guardian_email` in any order, RFC 4180 quoting,
  max 500 rows; or
- JSON: `{ "rows": [{ "student_name", "grade", "guardian_email" }, ...] }`.

Per-row validation: name 1–100 chars (trimmed); grade one of the five
registry ids (`pre-k`, `kindergarten`, `grade-1`, `grade-2`, `grade-3` —
the same `GRADE_IDS` vocabulary as child profiles, imported, not forked);
guardian email the repo's pragmatic RFC shape (the same `EMAIL_PATTERN`
as parent signup, imported, not forked). The response enumerates every
row as accepted/rejected with reasons, plus a seat projection
(`seatsNeeded` vs `seatsRemaining`, `seatsSufficient`) — and states
plainly that **nothing was created, stored, or invited**. The zero-writes
guarantee is enforced by tests (row-count deltas over every B2B table
before/after calls), and the route logs counts only — roster
names/emails never reach the logs.

## Licensing-core integration path (how this becomes "real")

The seam is deliberately consumable today and replaceable tomorrow:

1. **Now (dev/test)**: licenses are signed by licensing-core's public dev
   keypair; the API derives the dev public key from the public seed and
   verifies offline. Test fixtures sign in-test against the same seed.
2. **Production keying**: register the `balashikshana` product on the
   ShristiLabs licensing server (`POST /api/admin/products` or
   `generate-keys --product balashikshana`), then set
   `BALASHIKSHANA_LICENSE_PUBLIC_KEY` to the printed base64 public key.
   Issuance/billing/renewal happen on the licensing platform; the school
   receives a license file and activates it here.
3. **Adapter path**: verification sits behind the injectable
   `createLicenseVerifier` port (`license-verifier.mjs`). If licensing
   later ships a WASM build of licensing-core, or the product wants
   server-side activation (an HTTP call to the licensing server at
   activation time for revocation checking), the implementation swaps
   without touching `b2b.mjs` or any caller. No schema change would be
   needed for a revocation-aware adapter (the `status` column already
   exists).

## Non-goals (the seam stays a seam)

- No school admin UI, no billing, no licensing portal here.
- No teacher accounts, invites, or token kind.
- No roster ingestion: the stub validates and reports; student creation
  remains parent-consent-gated exactly as today (issue #41 machinery
  untouched).
- No SSO roster integrations (Google Classroom / OneRoster) and no formal
  FERPA certification — see `docs/legal/ferpa-dpa-posture.md`.
