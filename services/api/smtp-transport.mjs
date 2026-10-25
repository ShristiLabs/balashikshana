// SMTP transport (issue #63) — the ONE module in the codebase that
// imports nodemailer (AC1: no mail-provider client import outside the
// transport module). Loaded lazily by mailer.mjs's defaultTransport()
// only when SMTP_HOST is configured; tests and the unconfigured default
// path never load this file, so the suite has zero network I/O and a
// dependency-light boot.
//
// The interface contract (mailer.mjs): send() resolves { ok, messageId,
// error } and never rejects — nodemailer's callback error becomes
// ok:false instead of an exception, which is what lets the digest batch
// isolate one parent's failure with a plain result check.

import nodemailer from "nodemailer";

/**
 * Real SMTP transport over nodemailer. Config comes from env via
 * mailer.defaultTransport (SMTP_HOST/PORT/SECURE/USER/PASS/FROM —
 * credentials never appear in code or logs).
 */
export function createSmtpTransport(config) {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // STARTTLS-on-587 vs implicit-TLS-465; explicit flag, no guessing.
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined
  });
  return {
    async send(envelope) {
      try {
        const info = await transporter.sendMail({
          from: envelope.from,
          to: envelope.to,
          subject: envelope.subject,
          text: envelope.text,
          html: envelope.html
          // Deliberately NO cc/bcc — one explicit recipient per send.
        });
        return { ok: true, messageId: info?.messageId ?? null };
      } catch (err) {
        return { ok: false, messageId: null, error: err?.message || "SMTP send failed" };
      }
    }
  };
}
