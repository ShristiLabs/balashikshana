// Mailer seam (issue #63, M5 — the shipperdog SMTP seam pattern; #69 adds
// the file-capture transport and routes parent-auth mail through it).
//
// ONE transport interface, FOUR implementations, zero provider lock-in:
//
//   send({ from, to, subject, text, html }) -> Promise<{ ok, messageId?, error? }>
//
// - createCaptureTransport() — records every send in .sends and always
//   succeeds. Dev tooling and EVERY test run on this transport: zero
//   network I/O, deterministic assertions (the issue's AC1).
// - createNullTransport(logger) — accepts and drops. The default when no
//   SMTP configuration is present, so a boot with missing env never
//   crashes and never queues mail silently into a void that looks like
//   delivery.
// - createSmtpTransport(config) (smtp-transport.mjs) — real SMTP via
//   nodemailer. The nodemailer import lives ONLY inside that module and
//   that module is loaded lazily (dynamic import) solely when SMTP_HOST
//   is configured — the unconfigured default path never even parses the
//   dependency (AC1: "no provider SDK import outside the transport
//   module"; nodemailer is the SMTP protocol client, not an ESP SDK, and
//   is the OSS standard — added as a regular dependency for deterministic
//   installs + an explicit audit surface rather than an optional/dynamic
//   package dependency).
//
// Result contract: transports RESOLVE, never reject — a failed send is
// { ok: false, error } (callers such as the weekly digest never need a
// try/catch to isolate failures, though it still wraps defensively).
// messageId is transport-specific and may be null (capture/null).
//
// D5 (COPPA first-party-only) applies to the mail path: this seam sends
// first-party content to verified parent addresses only; there is no
// tracking pixel, beacon, or third-party analytics anywhere in the
// pipeline, and no CC/BCC support in the interface by design (one
// explicit recipient per send — the digest job's one-email-per-parent).

/**
 * In-memory capture transport: records the exact envelope handed to
 * send() and resolves ok. Tests assert against .sends; nothing here
 * can touch the network.
 */
export function createCaptureTransport() {
  return {
    sends: [],
    async send(envelope) {
      this.sends.push({ ...envelope, sentAt: new Date().toISOString() });
      return { ok: true, messageId: null };
    }
  };
}

/**
 * No-op transport: accepts the send, delivers nothing, and reports
 * HONESTLY — { ok: false, error } — because nothing was delivered. The
 * boot default when SMTP is not configured: the process stays healthy,
 * and a caller that treats ok as "delivered" (the digest ledger's
 * claim-on-success) never records a week as sent that no one received;
 * the failure is retried on the next run instead. (A transport that
 * reported ok while dropping mail would silently claim every digest
 * week — the exact bug this result shape exists to prevent.)
 */
export function createNullTransport(logger) {
  let dropped = 0;
  return {
    async send(envelope) {
      dropped += 1;
      // The recipient address never enters the log (PII-minimal logging,
      // the #62 doctrine); operators learn a mail was dropped, not to whom.
      logger?.warn?.({ dropped, subject: envelope?.subject }, "Mail dropped: no SMTP transport configured (null transport)");
      return { ok: false, messageId: null, error: "No SMTP transport configured; mail dropped" };
    },
    get droppedCount() {
      return dropped;
    }
  };
}

/** True when the environment carries an SMTP host (the one required knob). */
export function smtpConfigured(env = process.env) {
  return Boolean(String(env.SMTP_HOST || "").trim());
}

// File-capture transport (issue #69): records every envelope as a JSON
// line in a file, cross-process observable — the transport the
// verification/reset mail tests boot the real server against (tests spawn
// server.mjs as a child process, so an in-memory capture transport in the
// test process sees nothing). TEST/DEBUG ONLY: a capture file contains
// the delivered codes (credentials-in-mail by definition), so NO
// deployment environment may ever set MAIL_CAPTURE_FILE — the deployment
// env templates never mention it and the store review pack documents it
// as forbidden in production. Selected with the highest precedence so a
// test boot never needs SMTP knobs at all.
export function createFileCaptureTransport(filePath) {
  return {
    async send(envelope) {
      // Appends are line-atomic for our sizes on POSIX; tests read after
      // the response arrives, which is after the awaited send() resolves.
      const { appendFileSync } = await import("node:fs");
      appendFileSync(filePath, `${JSON.stringify({ ...envelope, sentAt: new Date().toISOString() })}\n`);
      return { ok: true, messageId: null };
    }
  };
}

/**
 * The transport the server boots with: file-capture when
 * MAIL_CAPTURE_FILE is set (tests/debug only — see that transport),
 * SMTP when SMTP_HOST is set (the nodemailer module loads lazily right
 * here — the only place that can), null otherwise. Tests and callers
 * that need determinism inject their own transport explicitly and never
 * call this.
 */
export async function defaultTransport(logger, env = process.env) {
  if (String(env.MAIL_CAPTURE_FILE || "").trim()) return createFileCaptureTransport(String(env.MAIL_CAPTURE_FILE).trim());
  if (!smtpConfigured(env)) return createNullTransport(logger);
  const { createSmtpTransport } = await import("./smtp-transport.mjs");
  return createSmtpTransport({
    host: String(env.SMTP_HOST),
    port: Number(env.SMTP_PORT || 587),
    secure: String(env.SMTP_SECURE || "") === "true" || String(env.SMTP_SECURE || "") === "1",
    user: env.SMTP_USER || undefined,
    pass: env.SMTP_PASS || undefined,
    from: env.SMTP_FROM || "Balashikshana <no-reply@balashikshana.local>"
  });
}
