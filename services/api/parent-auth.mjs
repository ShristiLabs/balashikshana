// Parent authentication API (issue #40, roadmap D4): signup, email
// verification, login, session refresh/rotation, logout(+all), and password
// reset — plus the token-kind-aware bearer resolution that the M1 student
// middleware shares (dual-token doctrine: parent session tokens vs student
// session tokens, plus the child device tokens added by issue #42 on the
// same seam).
//
// Security doctrine (mirrors the M1 patterns in server.mjs):
// - Passwords: scrypt via the SHARED db.mjs helpers (hashPinScrypt /
//   verifyPin / SCRYPT_PARAMS — issue #40 AC forbids forked parameters;
//   N=16384, r=8, p=1 is the OWASP interactive-login floor, per-row salt,
//   timing-safe compare). A future parameter bump should arrive as
//   rehash-on-login, not as a second format in this codebase.
// - Tokens: 256-bit random base64url values. Unlike student_sessions (raw
//   storage, M1), every parent token — session, verification, reset — is
//   stored as its SHA-256 hex digest (migration 003); the raw value is
//   returned to the client exactly once and never persisted or logged in
//   production. A fast hash is correct here: the input is high-entropy, so
//   there is nothing to harden against (unlike passwords).
// - Anti-enumeration: login returns a byte-identical 401 for unknown email
//   and wrong password, with a dummy scrypt verification equalizing the
//   unknown-account path; password-reset/request always returns the same
//   202 whether or not the email exists; verify-email and reset/confirm
//   failures are a uniform invalid-or-expired problem (no oracle about
//   which condition failed).
// - Rate limiting: route-level config.rateLimit buckets on the
//   token-guessing surfaces (signup, login, verify-email, reset confirm)
//   and the email-harvesting surface (reset request), following the M1
//   login-bucket pattern. refresh/logout sit behind the global per-IP and
//   per-token buckets (they present a bearer token by definition).

import crypto from "node:crypto";
import { hashPinScrypt, verifyPin, createSessionToken } from "./db.mjs";
import { sendProblem, PROBLEM_BASE } from "./problem.mjs";
import { verificationMail, passwordResetMail } from "./auth-emails.mjs";

// Session/token lifetimes (constants, not env — same convention as the M1
// SESSION_TTL_MS; rate limits are the env-tunable knob, lifetimes are
// doctrine):
// - A session token is valid for 7 days; while a session is still valid and
//   unrevoked it may be rotated (POST /api/parents/refresh) inside a
//   30-day refresh window. Rotation revokes the old row and issues a new
//   token with a fresh 7-day TTL and a fresh 30-day window (sliding per
//   lineage). #42/#61 can tighten this without a schema change.
// - Email-verification tokens live 24 hours; password-reset tokens 1 hour.
const PARENT_SESSION_TTL_MS = 7 * 86400000;
const PARENT_REFRESH_WINDOW_MS = 30 * 86400000;
const VERIFY_TOKEN_TTL_MS = 24 * 3600000;
const RESET_TOKEN_TTL_MS = 3600000;

// Equalizes login timing between unknown-email and wrong-password paths so
// the uniform 401 cannot become an account oracle by response time (same
// pattern as DUMMY_PIN_HASH for student login; a distinct constant so the
// two surfaces can evolve independently).
const DUMMY_PARENT_PASSWORD_HASH = hashPinScrypt("parent-timing-equalizer");

const EMAIL_MAX_LENGTH = 254;
// Pragmatic RFC-shaped email pattern (issue #40 owns real validation; the
// 002 CHECK is a shape guard only): anchored, one @, local part <= 64
// chars from the atext set plus dot, and a dotted-quad-style domain of
// >= 2 labels of [A-Za-z0-9-] labels that start and end alphanumerically.
const EMAIL_PATTERN =
  "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$";

const TOKEN_PATTERN = "^[A-Za-z0-9_-]+$";

// Exported since #42: the children module (children.mjs) hashes child
// device-session tokens with the same at-rest transform as parent tokens.
export function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

// Emails are trimmed (preValidation hook, PIN convention) and lowercased
// before storage and lookup, matching the functional unique index on
// LOWER(email) from migration 002.
function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

// Passwords are ALSO trimmed here, deliberately: the shared db.mjs scrypt
// helpers trim before hashing (scryptKey), so a pre-validation trim keeps
// the schema floor and the hash layer in agreement — without it, a
// whitespace-only string of 12+ characters would pass minLength and then
// hash as scrypt(""). Interior spaces are unaffected and remain legitimate
// password characters; only leading/trailing whitespace is dropped.
function trimAuthFieldsPreValidation(req, _reply, done) {
  if (req.body && typeof req.body === "object") {
    for (const field of ["email", "password", "newPassword"]) {
      if (typeof req.body[field] === "string") {
        req.body[field] = req.body[field].trim();
      }
    }
  }
  done();
}

// --- Token-kind-aware bearer resolution --------------------------------------
// Resolves the Authorization header to a token kind: 'parent' (hashed
// lookup in parent_sessions), 'child-device' (hashed lookup in
// child_device_sessions, issue #42), or 'student' (raw lookup in
// student_sessions, the M1 scheme). Error strings match the M1 middleware
// verbatim so 401 bodies are unchanged across all three kinds.

export async function resolveBearerAuth(db, authorizationHeader) {
  const [scheme, token] = String(authorizationHeader || "").split(" ");
  if (scheme !== "Bearer" || !token || /[^A-Za-z0-9_-]/.test(token)) {
    return { error: "Missing or malformed bearer token" };
  }
  const parentRow = await db.get("SELECT * FROM parent_sessions WHERE token_hash = $1", [sha256Hex(token)]);
  if (parentRow) {
    if (parentRow.revoked_at) {
      return { error: "Session token is invalid or has been revoked" };
    }
    if (new Date(parentRow.expires_at).getTime() <= Date.now()) {
      await db.run("DELETE FROM parent_sessions WHERE token_hash = $1", [parentRow.token_hash]);
      return { error: "Session token has expired" };
    }
    return { kind: "parent", token, parentSession: parentRow };
  }
  // Child device tokens (#42): hashed lookup, soft revoke (revoked rows
  // are kept as lifecycle evidence and fail 401 immediately), lazy delete
  // of expired rows — the parent_sessions semantics, scoped to exactly one
  // student + one device by the row itself.
  const childRow = await db.get("SELECT * FROM child_device_sessions WHERE token_hash = $1", [sha256Hex(token)]);
  if (childRow) {
    if (childRow.revoked_at) {
      return { error: "Session token is invalid or has been revoked" };
    }
    if (new Date(childRow.expires_at).getTime() <= Date.now()) {
      await db.run("DELETE FROM child_device_sessions WHERE session_id = $1", [childRow.session_id]);
      return { error: "Session token has expired" };
    }
    return { kind: "child-device", token, childSession: childRow };
  }
  const studentRow = await db.get("SELECT * FROM student_sessions WHERE token = $1", [token]);
  if (studentRow) {
    if (new Date(studentRow.expires_at).getTime() <= Date.now()) {
      await db.run("DELETE FROM student_sessions WHERE token = $1", [token]);
      return { error: "Session token has expired" };
    }
    return { kind: "student", token, session: studentRow };
  }
  return { error: "Session token is invalid or has been revoked" };
}

// Exported since #41: the consent module (consent.mjs) layers the
// email-verified and consent-required checks on top of this guard.
export async function requireParentAuth(db, req, reply) {
  const auth = await resolveBearerAuth(db, req.headers.authorization);
  if (auth.error) {
    sendProblem(reply, 401, { type: `${PROBLEM_BASE}/unauthorized`, detail: auth.error });
    return null;
  }
  if (auth.kind !== "parent") {
    sendProblem(reply, 403, {
      type: `${PROBLEM_BASE}/wrong-token-type`,
      detail: "Student and child device tokens cannot access parent routes."
    });
    return null;
  }
  req._balashiParentId = auth.parentSession.parent_id;
  return auth.parentSession;
}

// --- Shared pieces -------------------------------------------------------------

function parentPublic(row) {
  return {
    parentId: row.parent_id,
    email: row.email,
    emailVerified: Boolean(row.email_verified_at),
    emailVerifiedAt: row.email_verified_at || null
  };
}

// Email delivery (issue #69 — the #68-pinned mailer flip): verification
// and password-reset tokens are DELIVERED BY MAIL through the #63 mailer
// seam (mailer.mjs), exactly as the privacy policy (sections 2a/7)
// promises. In production the response body NEVER carries the token —
// the parent receives it at their verified address as a plain-text,
// link-free code (auth-emails.mjs documents the no-link decision) and
// pastes it into the app/portal they already have open. In dev and test
// the response-body seam below REMAINS (NODE_ENV-gated) so local flows
// and the test harness keep working without a mailbox; dev boots ALSO
// dispatch the mail when a transport is configured (MAIL_CAPTURE_FILE /
// SMTP_HOST), so the delivery path itself is exercised everywhere.
//
// A failed send is logged (parentId-keyed, never the address — the #62
// PII-minimal logging doctrine) and does not fail the request: signup
// still records the account and the response stays shape-stable. The
// honest null transport (no SMTP_HOST) makes the failure observable in
// ops logs; server.mjs logs a loud boot warning in that production case.
//
// TIMING DOCTRINE (review finding, fixed in-flow): the send is scheduled
// with setImmediate and NEVER awaited in the handler. Password-reset
// request is an anti-enumeration surface (uniform 202, byte-identical
// body); awaiting an SMTP round trip ONLY on the known-email path would
// leak account existence through response LATENCY (50-500ms of relay
// time vs ~5ms of DB) even with identical bodies. Scheduling after the
// response keeps both paths DB-latency-only; tests poll the capture
// file instead of assuming the line landed before the response.
async function deliverTokenMail(mailer, logger, { kind, to, parentId, token, expiresAt }) {
  if (!mailer) return;
  const from = process.env.SMTP_FROM || "Balashikshana <no-reply@balashikshana.local>";
  const envelope =
    kind === "verification"
      ? verificationMail({ to, code: token, expiresAt, from })
      : passwordResetMail({ to, code: token, expiresAt, from });
  const result = await mailer.send(envelope);
  if (!result?.ok) {
    logger?.warn?.({ parentId, kind, subject: envelope.subject, error: result?.error }, "parent auth token mail FAILED (account created; parent cannot verify until mail flows — check SMTP_HOST)");
  } else {
    logger?.info?.({ parentId, kind, subject: envelope.subject }, "parent auth token mail dispatched");
  }
}

// Fire-and-forget wrapper: schedules the send off the request path and
// guarantees no unhandled rejection can take the process down (a send
// that throws is logged defensively; deliverTokenMail itself resolves
// for all transport results).
function scheduleTokenMail(mailer, logger, payload) {
  setImmediate(() => {
    deliverTokenMail(mailer, logger, payload).catch((err) => {
      logger?.warn?.({ kind: payload?.kind }, "parent auth token mail scheduling failed unexpectedly");
      void err;
    });
  });
}

// Development/test response seam (the documented non-production
// exception): dev and test boots additionally return the token in the
// response body and log it parent-id-keyed. Production returns {} — the
// byte-level production suppression is pinned by test (NODE_ENV=
// production server + MAIL_CAPTURE_FILE transport), the SR-1 pattern.
function devDeliveryFields(logger, isProduction, label, parentId, token, expiresAt) {
  if (isProduction) return {};
  logger?.info?.({ parentId, kind: label, expiresAt, devDeliveryToken: token }, "parent auth token issued (dev seam; mail dispatch runs in parallel)");
  return { [`${label}Token`]: token, [`${label}TokenExpiresAt`]: expiresAt };
}

// --- Fastify plugin ------------------------------------------------------------

export const parentAuthPlugin = async function parentAuthPlugin(app, opts) {
  const { db, rateLimits, isProduction, logger, mailer } = opts;

  const emailField = { type: "string", minLength: 3, maxLength: EMAIL_MAX_LENGTH, pattern: EMAIL_PATTERN };
  const passwordField = {
    type: "string",
    // 12-char floor for parent accounts (students use 4-digit PINs).
    // Leading/trailing whitespace is trimmed in preValidation, so these
    // bounds apply to the trimmed value — exactly what the shared db.mjs
    // scrypt helpers hash (they trim; see trimAuthFieldsPreValidation).
    // Interior spaces remain legitimate password characters.
    minLength: 12,
    maxLength: 128
  };
  const tokenField = { type: "string", minLength: 20, maxLength: 128, pattern: TOKEN_PATTERN };

  const signupSchema = {
    body: { type: "object", additionalProperties: false, required: ["email", "password"], properties: { email: emailField, password: passwordField } }
  };
  const verifyEmailSchema = {
    body: { type: "object", additionalProperties: false, required: ["token"], properties: { token: tokenField } }
  };
  const loginSchema = {
    body: { type: "object", additionalProperties: false, required: ["email", "password"], properties: { email: emailField, password: passwordField } }
  };
  const resetRequestSchema = {
    body: { type: "object", additionalProperties: false, required: ["email"], properties: { email: emailField } }
  };
  const resetConfirmSchema = {
    body: { type: "object", additionalProperties: false, required: ["token", "newPassword"], properties: { token: tokenField, newPassword: passwordField } }
  };

  // POST /api/parents/signup -> create the parent (email unverified) and
  // issue a single-use verification token. A duplicate (case-insensitive)
  // email is a 409: signup is an account-creation surface, not an
  // enumeration-guarded one (login and reset are; see those handlers).
  app.post(
    "/api/parents/signup",
    { schema: signupSchema, preValidation: trimAuthFieldsPreValidation, config: { rateLimit: rateLimits.signup } },
    async (req, reply) => {
      const email = normalizeEmail(req.body.email);
      const existing = await db.get("SELECT parent_id FROM parents WHERE LOWER(email) = $1", [email]);
      if (existing) {
        return sendProblem(reply, 409, {
          type: `${PROBLEM_BASE}/email-already-registered`,
          detail: "An account with this email already exists."
        });
      }
      const parentId = `par-${crypto.randomBytes(10).toString("hex")}`;
      const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString();
      try {
        const issued = await db.withTransaction(async (client) => {
          await client.query(
            "INSERT INTO parents (parent_id, email, password_hash) VALUES ($1, $2, $3)",
            [parentId, email, hashPinScrypt(req.body.password)]
          );
          const token = createSessionToken();
          await client.query(
            "INSERT INTO parent_tokens (token_hash, parent_id, kind, expires_at) VALUES ($1, $2, 'email_verification', $3)",
            [sha256Hex(token), parentId, expiresAt]
          );
          return token;
        });
        const dev = devDeliveryFields(logger, isProduction, "verification", parentId, issued, expiresAt);
        // The #69 flip: the token ALWAYS goes to the mail seam (production
        // parents verify via email; dev boots also dispatch so the delivery
        // path is exercised). Scheduled, never awaited (timing doctrine in
        // deliverTokenMail's header); failures never fail signup.
        scheduleTokenMail(mailer, logger, { kind: "verification", to: email, parentId, token: issued, expiresAt });
        return reply.code(201).send({ parentId, email, emailVerified: false, ...dev });
      } catch (err) {
        // Concurrent signup race on the LOWER(email) unique index.
        if (err.code === "23505") {
          return sendProblem(reply, 409, {
            type: `${PROBLEM_BASE}/email-already-registered`,
            detail: "An account with this email already exists."
          });
        }
        throw err;
      }
    }
  );

  // POST /api/parents/verify-email -> consume the verification token
  // exactly once (atomic UPDATE) and stamp email_verified_at. The consume
  // and the follow-up writes run in ONE transaction so a crash between
  // statements cannot burn the token without verifying the email (there is
  // no re-issue route until #44). Every failure (unknown, replayed,
  // expired, wrong kind) is the same problem — no oracle. Sibling
  // outstanding verification tokens are consumed too.
  app.post(
    "/api/parents/verify-email",
    { schema: verifyEmailSchema, config: { rateLimit: rateLimits.token } },
    async (req, reply) => {
      const consumed = await db.withTransaction(async (client) => {
        const res = await client.query(
          `UPDATE parent_tokens SET consumed_at = now()
           WHERE token_hash = $1 AND kind = 'email_verification'
             AND consumed_at IS NULL AND expires_at > now()
           RETURNING parent_id`,
          [sha256Hex(req.body.token)]
        );
        if (res.rowCount === 0) return null;
        const parentId = res.rows[0].parent_id;
        await client.query(
          "UPDATE parents SET email_verified_at = now(), updated_at = now() WHERE parent_id = $1 AND email_verified_at IS NULL",
          [parentId]
        );
        await client.query(
          "UPDATE parent_tokens SET consumed_at = now() WHERE parent_id = $1 AND kind = 'email_verification' AND consumed_at IS NULL",
          [parentId]
        );
        return parentId;
      });
      if (!consumed) {
        return sendProblem(reply, 400, {
          type: `${PROBLEM_BASE}/invalid-token`,
          detail: "Email verification token is invalid or expired."
        });
      }
      return { ok: true, emailVerified: true };
    }
  );

  // POST /api/parents/login -> uniform 401 problem for unknown email and
  // wrong password (byte-identical bodies; dummy scrypt verification on the
  // unknown path equalizes timing). Login is allowed before email
  // verification — the response carries emailVerified so #41's
  // consent-required surfaces (and the client) can gate on it.
  app.post(
    "/api/parents/login",
    { schema: loginSchema, preValidation: trimAuthFieldsPreValidation, config: { rateLimit: rateLimits.login } },
    async (req, reply) => {
      const email = normalizeEmail(req.body.email);
      const row = await db.get("SELECT * FROM parents WHERE LOWER(email) = $1", [email]);
      if (!row) {
        verifyPin(req.body.password, DUMMY_PARENT_PASSWORD_HASH);
        return sendProblem(reply, 401, { type: `${PROBLEM_BASE}/unauthorized`, detail: "Incorrect email or password." });
      }
      if (!verifyPin(req.body.password, row.password_hash)) {
        return sendProblem(reply, 401, { type: `${PROBLEM_BASE}/unauthorized`, detail: "Incorrect email or password." });
      }
      const issuedAt = Date.now();
      const token = createSessionToken();
      await db.run(
        `INSERT INTO parent_sessions (token_hash, parent_id, expires_at, refreshable_until)
         VALUES ($1, $2, $3, $4)`,
        [sha256Hex(token), row.parent_id, new Date(issuedAt + PARENT_SESSION_TTL_MS).toISOString(), new Date(issuedAt + PARENT_REFRESH_WINDOW_MS).toISOString()]
      );
      req._balashiParentId = row.parent_id;
      return reply.code(200).send({ token, parent: parentPublic(row) });
    }
  );

  // POST /api/parents/refresh -> rotate the session token inside the
  // refresh window. The atomic revoke-then-insert below makes concurrent
  // refreshes safe: the second rotation attempt finds the row already
  // revoked and fails 401 (no token replay).
  app.post("/api/parents/refresh", async (req, reply) => {
    const session = await requireParentAuth(db, req, reply);
    if (!session) return reply;
    if (new Date(session.refreshable_until).getTime() <= Date.now()) {
      return sendProblem(reply, 401, {
        type: `${PROBLEM_BASE}/refresh-expired`,
        detail: "Session refresh window has expired; please log in again."
      });
    }
    const rotated = await db.run(
      `UPDATE parent_sessions SET revoked_at = now(), revocation_reason = 'rotated'
       WHERE token_hash = $1 AND revoked_at IS NULL RETURNING parent_id`,
      [session.token_hash]
    );
    if (rotated.rowCount === 0) {
      return sendProblem(reply, 401, { type: `${PROBLEM_BASE}/unauthorized`, detail: "Session token is invalid or has been revoked" });
    }
    const token = createSessionToken();
    const issuedAt = Date.now();
    await db.run(
      `INSERT INTO parent_sessions (token_hash, parent_id, expires_at, refreshable_until)
       VALUES ($1, $2, $3, $4)`,
      [sha256Hex(token), session.parent_id, new Date(issuedAt + PARENT_SESSION_TTL_MS).toISOString(), new Date(issuedAt + PARENT_REFRESH_WINDOW_MS).toISOString()]
    );
    return reply.code(200).send({ token });
  });

  // POST /api/parents/logout -> revoke the caller's session token
  // (soft revoke: revoked_at is set, keeping lifecycle evidence until the
  // row is cleaned up; unlike student logout which deletes the row).
  app.post("/api/parents/logout", async (req, reply) => {
    const session = await requireParentAuth(db, req, reply);
    if (!session) return reply;
    await db.run(
      "UPDATE parent_sessions SET revoked_at = now(), revocation_reason = 'logout' WHERE token_hash = $1 AND revoked_at IS NULL",
      [session.token_hash]
    );
    return { ok: true };
  });

  // POST /api/parents/logout-all -> revoke every active session for the parent
  app.post("/api/parents/logout-all", async (req, reply) => {
    const session = await requireParentAuth(db, req, reply);
    if (!session) return reply;
    const revoked = await db.run(
      `UPDATE parent_sessions SET revoked_at = now(), revocation_reason = 'logout-all'
       WHERE parent_id = $1 AND revoked_at IS NULL RETURNING token_hash`,
      [session.parent_id]
    );
    return { ok: true, revokedSessions: revoked.rowCount };
  });

  // POST /api/parents/password-reset/request -> always the same 202,
  // whether or not the email exists (no enumeration). When the account
  // exists, any outstanding reset token is superseded (one live reset
  // token per parent) and a new 1-hour single-use token is minted.
  app.post(
    "/api/parents/password-reset/request",
    { schema: resetRequestSchema, preValidation: trimAuthFieldsPreValidation, config: { rateLimit: rateLimits.reset } },
    async (req, reply) => {
      const email = normalizeEmail(req.body.email);
      const row = await db.get("SELECT parent_id FROM parents WHERE LOWER(email) = $1", [email]);
      let dev = {};
      let resetMail = null;
      if (row) {
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
        const issued = await db.withTransaction(async (client) => {
          await client.query(
            "UPDATE parent_tokens SET consumed_at = now() WHERE parent_id = $1 AND kind = 'password_reset' AND consumed_at IS NULL",
            [row.parent_id]
          );
          const token = createSessionToken();
          await client.query(
            "INSERT INTO parent_tokens (token_hash, parent_id, kind, expires_at) VALUES ($1, $2, 'password_reset', $3)",
            [sha256Hex(token), row.parent_id, expiresAt]
          );
          return token;
        });
        dev = devDeliveryFields(logger, isProduction, "reset", row.parent_id, issued, expiresAt);
        // The #69 flip: reset codes go to the mail seam for the account's
        // address — SCHEDULED after the response (never awaited), so the
        // known-email path carries no extra SMTP latency: the uniform 202
        // is uniform in TIME as well as bytes.
        resetMail = { kind: "reset", to: email, parentId: row.parent_id, token: issued, expiresAt };
      }
      const response = reply.code(202).send({ ok: true, message: "If an account exists for this email, a password reset has been sent.", ...dev });

      if (resetMail) scheduleTokenMail(mailer, logger, resetMail);
      return response;
    }
  );

  // POST /api/parents/password-reset/confirm -> consume the reset token
  // exactly once, set the new scrypt password hash, revoke every active
  // session for the parent, and supersede remaining reset tokens — all in
  // ONE transaction (consume first) so a crash between statements cannot
  // burn the token without applying the reset.
  app.post(
    "/api/parents/password-reset/confirm",
    { schema: resetConfirmSchema, preValidation: trimAuthFieldsPreValidation, config: { rateLimit: rateLimits.token } },
    async (req, reply) => {
      const consumed = await db.withTransaction(async (client) => {
        const res = await client.query(
          `UPDATE parent_tokens SET consumed_at = now()
           WHERE token_hash = $1 AND kind = 'password_reset'
             AND consumed_at IS NULL AND expires_at > now()
           RETURNING parent_id`,
          [sha256Hex(req.body.token)]
        );
        if (res.rowCount === 0) return null;
        const parentId = res.rows[0].parent_id;
        await client.query("UPDATE parents SET password_hash = $1, updated_at = now() WHERE parent_id = $2", [
          hashPinScrypt(req.body.newPassword),
          parentId
        ]);
        await client.query(
          "UPDATE parent_sessions SET revoked_at = now(), revocation_reason = 'password-reset' WHERE parent_id = $1 AND revoked_at IS NULL",
          [parentId]
        );
        await client.query(
          "UPDATE parent_tokens SET consumed_at = now() WHERE parent_id = $1 AND kind = 'password_reset' AND consumed_at IS NULL",
          [parentId]
        );
        return parentId;
      });
      if (!consumed) {
        return sendProblem(reply, 400, {
          type: `${PROBLEM_BASE}/invalid-token`,
          detail: "Password reset token is invalid or expired."
        });
      }
      return { ok: true };
    }
  );
};
