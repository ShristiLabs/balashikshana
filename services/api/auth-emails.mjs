// Parent-auth transactional email templates (issue #69 — the mailer flip).
//
// The #68 security review pinned this as a #69 blocker: the privacy policy
// (sections 2a/7) promises that verification and password-reset mail is
// DELIVERED BY EMAIL, but parent-auth.mjs still handed those tokens out on
// the dev response-body seam — in production a parent could never verify an
// address, which blocks verifiable consent itself. These templates + the
// parent-auth flip close that gap.
//
// Design decision (documented in docs/store/ + docs/legal/README.md): the
// credential stays the full-entropy 256-bit base64url token — NOT a 6-digit
// code. A short code's 10^6 space is brute-forceable against per-IP rate
// buckets from many addresses, and security outranks copy-friendliness in
// this codebase's priorities. The anti-phishing goal is met a different
// way: the email contains NO link at all (consistent with #63 D5's
// no-link posture for the digest) — the parent copies the code into the
// app or portal they already have open (the mobile VerifyEmailStep and the
// portal reset form both take pasted tokens today; zero client change).
//
// Template rules (test-enforced):
// - PLAIN TEXT ONLY. No HTML part, no tracking pixels, no beacons, no
//   link shorteners, no links of any kind.
// - No unresolved placeholders: every [BRACKETED] token the legal pack
//   still carries is forbidden here (store reviewers read these mails).
// - Sober, non-urgent wording: no countdown pressure, no "act now" dark
//   patterns — the same honesty bar as the store listing copy.
// - The code sits on its own line in a copy-friendly block, verbatim.

const PRODUCT_NAME = "Balashikshana";
const SUPPORT_LINE =
  "If you did not expect this email, you can ignore it — nobody can access your account without this code, and Balashikshana will never ask you to reply with a password or payment details.";

function formatExpiry(expiresAt) {
  // ISO-8601 UTC, the one timestamp format that is honest in every locale
  // (no locale-dependent ambiguity a phisher could exploit).
  return new Date(expiresAt).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** The code block the parent copies — token verbatim, fenced, alone. */
function codeBlock(code) {
  return [
    "  ----------------------------------------------------------",
    `  ${code}`,
    "  ----------------------------------------------------------"
  ].join("\n");
}

/**
 * Signup email-verification mail. `code` is the raw one-time verification
 * token (24h TTL); the mail tells the parent where to paste it and when it
 * stops working. Returns a mailer seam envelope (from/to/subject/text).
 */
export function verificationMail({ to, code, expiresAt, from }) {
  return {
    from,
    to,
    subject: `${PRODUCT_NAME}: verify your email address`,
    text: [
      `Welcome to ${PRODUCT_NAME}.`,
      "",
      `Enter this verification code in the ${PRODUCT_NAME} app or parent portal to finish setting up your parent account:`,
      "",
      codeBlock(code),
      "",
      `This code expires at ${formatExpiry(expiresAt)} and can be used once.`,
      "",
      SUPPORT_LINE,
      ""
    ].join("\n")
  };
}

/**
 * Password-reset mail. `code` is the raw one-time reset token (1h TTL).
 * Same no-link posture: the parent pastes the code into the reset screen
 * they opened themselves — an emailed link would train parents to click
 * links in email, exactly the habit a kids-app vendor should not teach.
 */
export function passwordResetMail({ to, code, expiresAt, from }) {
  return {
    from,
    to,
    subject: `${PRODUCT_NAME}: password reset code`,
    text: [
      `A password reset was requested for your ${PRODUCT_NAME} parent account.`,
      "",
      `Enter this code in the ${PRODUCT_NAME} parent portal password-reset screen to choose a new password:`,
      "",
      codeBlock(code),
      "",
      `This code expires at ${formatExpiry(expiresAt)} and can be used once. Using it signs out all other sessions on your account.`,
      "",
      SUPPORT_LINE,
      ""
    ].join("\n")
  };
}
