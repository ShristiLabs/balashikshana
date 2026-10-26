<!-- MIRROR of the migration-014 seed (canonical source: the legal_documents / consent_policy_versions DB rows served at /api/legal/:kind/latest and /api/consent/policy/latest). Regenerate rather than edit: see docs/legal/README.md. -->

# Privacy Policy (kind=privacy-policy, version 1, en-US)

DRAFT - NOT FINAL LEGAL TEXT. This privacy policy draft requires review
and approval by qualified legal counsel before deployment. Bracketed
[PLACEHOLDERS] must be completed by the operator.

Privacy Policy for the Balashikshana learning app
Version 1 (draft) - effective [EFFECTIVE_DATE]
Operated by [COMPANY_LEGAL_NAME], [JURISDICTION]. Contact:
[CONTACT_EMAIL], [POSTAL_ADDRESS].

1. Who this policy covers
This policy explains what information the Balashikshana app and its
parent web portal collect, why, and the choices parents have. Balashikshana
is a learning app for children in pre-kindergarten through grade 3. It is
designed for a parent or legal guardian to set up and supervise. We do not
knowingly collect personal information from a child without verifiable
parental consent.

2. What we collect and why
(a) Parent account information. Email address and a password. Used to
create and secure the parent account, verify the address (a verification
link), send password-reset links, and send the optional weekly learning
summary. Passwords are stored only as salted cryptographic hashes; we
cannot read them.
(b) Parental consent records. When you accept the consent policy, we store
which policy version you accepted, the date and time, and which child
profile it covers. This is our legal record of your permission.
(c) Child learner profile. A display name (nickname), a username, an
avatar, an age band, and a school grade level, plus a 4-digit PIN chosen
by the parent that unlocks the child's profile on the device. Used to
operate the learner's journey. The PIN is stored only as a salted
cryptographic hash.
(d) Learning activity records. As your child practices: which questions
they answered, whether answers were correct, how long responses took,
learning-misconception tags the teaching engine assigns, mastery-gate and
placement results, rewards the app grants (such as stars and badges), and
streak information. Used to teach your child at the right level, compute
progress, and power the parent dashboard. These records are the "learning
data" your consent covers.
(e) Content settings. Time limits, subject restrictions, grade ceilings,
and reminder preferences a parent sets in the portal. Used to enforce the
parent's choices on every device.
(f) Device and session information. A random device identifier, the
platform (iOS/Android), and secure session tokens that keep each device
signed in. Used to bind a child's device to the profile the parent
authorized and to revoke access when the parent chooses.
(g) Technical logs and error reports. When something fails we record the
request's route, timing, a truncated network identifier, and a scrubbed
error description. Personal identifiers such as email addresses, exact IP
addresses, and tokens are removed automatically before anything is stored.
Used to keep the service reliable and secure.

3. What we do NOT do
- No advertising of any kind, and no behavioral or targeted advertising.
- No third-party analytics or tracking SDKs. Usage measurement is
  first-party and aggregate only.
- No selling, renting, or sharing of personal information with third
  parties for their own purposes.
- No push notifications to children. Reminders are local to the device and
  controlled by the parent.
- No open external links inside child-facing screens.

4. Children's privacy (COPPA)
The app is built for children under 13. Before any child learning data is
created, the app requires verifiable parental consent: a parent account
with a verified email address must accept the current consent policy. When
the policy changes materially, the app asks the parent to accept the new
version before more learning data is collected. Parents can withdraw
consent at any time by deleting the child's data (section 5). Data
minimization is a design rule: we collect only the categories in section 2,
each tied to a documented product need.

5. Parent data rights
From the parent portal you can:
(a) Export. Download a complete copy of your child's data as a readable
JSON file, covering every learning-data category.
(b) Delete. Permanently delete a child's profile and learning data. For
safety this requires re-entering your parent password. Deletions are
recorded in an internal audit ledger (the ledger stores only identifiers
and timestamps, not learning data).
(c) Refuse / withdraw. Delete the child profile or your whole account to
withdraw consent. Account deletion removes parent information.
(d) Review and correct. Nickname, avatar, grade, and settings can be
changed at any time.

6. Where data lives and how it is protected
Data is stored in a managed database in [DATA_REGION] within the United
States. In transit, connections use TLS. At rest, passwords and PINs are
stored only as salted scrypt hashes; parent and child-device session
tokens are stored only as cryptographic digests. Access to production
systems is restricted, infrastructure secrets live in a managed secret
store, and content delivered to devices is cryptographically signed.

7. Who else is involved
- Email delivery provider: sends verification, password-reset, and the
  optional weekly summary emails to parents. The provider receives the
  minimum needed to deliver email (the parent's address and message).
- App stores (Apple App Store / Google Play): distribution and billing
  relationship is between you and the store under the store's own policy.
Other than these, there are no third parties receiving personal
information. We do not use ad networks, data brokers, or analytics
vendors.

8. Retention
Learning data is retained while the child profile exists and is deleted
with it (section 5b). Parent accounts are retained until deleted. Session
tokens expire on fixed schedules and are purged by an automated sweep.
Scrubbed error records are automatically deleted after 30 days. Backup
retention: [BACKUP_RETENTION_PLACEHOLDER].

9. Changes to this policy
This policy is versioned. When we publish a new version we update the
version number and effective date, show the change to parents in the app,
and (when the change is material to consent) require re-acceptance of the
consent policy before further collection.

10. Contact
Questions or requests: [CONTACT_EMAIL], [POSTAL_ADDRESS]. You may also
contact us to exercise any right in section 5.
