# FERPA / DPA Posture Notes (issue #70)

DRAFT POSTURE NOTES — NOT LEGAL ADVICE. This document records the
engineering posture of the B2B licensing seam against FERPA and typical
Data Protection Agreement (DPA) obligations so counsel can review and
complete it. It must be reviewed and approved by qualified legal counsel
before being represented to any school or district. Bracketed
[PLACEHOLDERS] must be completed by the operator. (Same banner doctrine
as the #68 legal pack: drafts are honest about being drafts.)

## What this seam is (and is not)

Issue #70 ships a **seam, not a product**: seat-license validation for
school/district accounts, a roster-import validation stub, and these
posture notes. **No school-facing product exists today.** Nothing in
this issue creates a channel through which a school delivers student
data: the roster stub validates submitted rows and creates nothing, and
every B2B endpoint is gated by the activating parent's session token.

The ONLY child-data path in production today is the direct-to-parent
COPPA flow (issues #33-#41): a verified parent creates child profiles
under captured, versioned parental consent, and consent gates all child
data creation. That remains true after this issue.

## FERPA: the "school official" exception, mapped to the actual data model

FERPA (20 U.S.C. § 1232g; 34 CFR Part 99) protects "education records"
of students that a school or district maintains. When a school — not a
parent — provisions learners through a future schools platform, the
applicable consent model changes from COPPA verifiable parental consent
to the school's FERPA authority, typically via the **"school official"
exception** (34 CFR § 99.31(a)(1)(i)(B)): the vendor is a school official
with a legitimate educational interest, under the direct control of the
school, and uses the data only for the authorized educational purpose.

What that will require of the data model when the schools platform is
built (recorded here so the seam does not foreclose it):

1. **School-authority provenance**: child records created via school
   provisioning must carry their provenance (organization/licensing
   context, not only parent consent). Today's tables have no such
   column — correct for today, and the migration to add it is future
   schools-platform work, not this seam.
2. **Direct control**: the school must be able to direct deletion and
   access. The #62 machinery (per-child export and deletion with its
   append-only audit ledger) is the natural substrate; a school-side
   equivalent is future work.
3. **Use limitation**: no reuse of education records for any purpose
   beyond the authorized one. The product has no ads/analytics/tracking
   SDKs (COPPA invariant #2), and telemetry flows are inventoried in
   `docs/data-flow-inventory.md` — the "no secondary use" commitment is
   already the product's operating reality.
4. **No redisclosure**: flows-out are inventoried (SMTP provider for
   transactional/digest mail; app stores for distribution) and nothing is
   sold or shared for advertising. Store Data Safety forms (issue #69)
   already declare this publicly.

**Explicit non-claim**: Balashikshana does NOT claim FERPA compliance
today, and this seam performs no FERPA-regulated processing. The notes
above are the honest engineering posture against which a future
compliance claim would be evaluated.

## DPA-ready posture checklist

Typical district DPAs require the following. Current state, honestly
marked (counsel must verify each before signature):

| DPA commitment | Current state |
|---|---|
| Data minimization | Yes — inventoried data classes only (`docs/data-flow-inventory.md`); the roster stub persists NOTHING (validated and discarded) |
| Purpose limitation | Yes — data used solely to operate the learning product; no secondary use; no ads/tracking SDKs (COPPA invariant) |
| No sale / no ad sharing | Yes — declared on both stores' Data Safety forms (#69 pack) |
| Parent/student data rights (access, deletion) | Partially — full per-child export + deletion exists for the parent flow (#62); a school-side rights surface is future work |
| Retention & deletion schedules | Partially — session/token sweeps and the #62 deletion ledger exist; a published retention schedule is [PLACEHOLDER: counsel to approve] |
| Subprocessors list | Yes, short: [SMTP provider], [app stores], [hosting provider] — [PLACEHOLDER: operator to enumerate with counsel] |
| Breach notification | [PLACEHOLDER: commitments + timeline to be set by counsel; the #66 error/observability stack is the detection substrate] |
| Security measures | Documented in `docs/security-review.md` (SR-1..SR-8): token hashing doctrine, rate limiting, IDOR/ownership guards, secret hygiene; open items are tracked there honestly |
| Data localization / residency | [PLACEHOLDER: current deployment region(s) to be stated by the operator] |
| FERPA school-official terms | Future — required only when a school-provisioned channel exists (see above) |

## Non-goals (pointing at the future schools platform)

Per the issue: no full schools platform (teacher UX, classes,
assignments, school analytics), no billing/admin surfaces (the licensing
repo owns them), no SSO roster integrations (Google Classroom /
OneRoster), and **no formal FERPA certification**. Each of those lands
with its own issue and its own legal review; this document exists so the
seam's posture is written down and reviewable, not asserted as finished.
