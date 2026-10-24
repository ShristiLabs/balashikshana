// V3 — parent authentication token storage (issue #40, roadmap D4).
//
// Two tables backing the parent auth API and the dual-token doctrine:
// - parent_sessions: long-lived, refreshable, revocable parent session
//   tokens. Distinct from student_sessions (M1) in that tokens are stored
//   HASHED (SHA-256 hex of the 32-byte base64url token) and rows carry a
//   refresh window plus an explicit revocation timestamp/reason instead of
//   logout = row delete. The bearer-auth layer resolves the token kind
//   (student | parent); #42 extends the union with child-device tokens.
// - parent_tokens: single-use, expiring tokens for email verification and
//   password reset (the `kind` column distinguishes them). Single use is
//   enforced atomically at consume time (UPDATE ... WHERE consumed_at IS
//   NULL AND expires_at > now()).
//
// FK delete rules: both tables cascade from parents. Unlike consent_records
// (RESTRICT, 002 — consent is evidence), sessions and auth tokens are live
// credential state: when a parent row is deleted (#62 data rights), its
// credentials must not survive. #62 handles retention explicitly first.
//
// Token hashing note: passwords are stored as scrypt hashes (db.mjs
// helpers); these tokens are 256-bit random values, so a plain SHA-256
// digest is the correct at-rest transform (there is no low-entropy secret
// to harden against, and lookup stays a single indexed equality probe).

exports.up = (pgm) => {
  pgm.createTable("parent_sessions", {
    // SHA-256 hex of the base64url session token; the raw token is shown to
    // the client exactly once and never stored.
    token_hash: { type: "text", notNull: true, primaryKey: true },
    parent_id: { type: "text", notNull: true, references: "parents(parent_id)", onDelete: "cascade" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    // Absolute token validity; expired rows fail auth and are lazily deleted.
    expires_at: { type: "timestamptz", notNull: true },
    // Refresh doctrine (#40): a valid, non-revoked session may rotate its
    // token while now() < refreshable_until. Rotation revokes the old row
    // and issues a fresh one with a new window (sliding per lineage).
    refreshable_until: { type: "timestamptz", notNull: true },
    // NULL = active; set by logout, logout-all, refresh rotation, and
    // password-reset (reset revokes every session for the parent).
    revoked_at: { type: "timestamptz" },
    revocation_reason: { type: "text" }
  }, { ifNotExists: true });
  pgm.createIndex("parent_sessions", ["parent_id"], { ifNotExists: true, name: "idx_parent_sessions_parent" });

  pgm.createTable("parent_tokens", {
    // SHA-256 hex of the single-use base64url token (email verification /
    // password reset); the raw token is returned once, never stored.
    token_hash: { type: "text", notNull: true, primaryKey: true },
    parent_id: { type: "text", notNull: true, references: "parents(parent_id)", onDelete: "cascade" },
    kind: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    expires_at: { type: "timestamptz", notNull: true },
    // NULL = outstanding; consume sets it exactly once (atomic UPDATE).
    consumed_at: { type: "timestamptz" }
  }, { ifNotExists: true });
  pgm.addConstraint("parent_tokens", "parent_tokens_kind_ck", `CHECK (kind IN ('email_verification', 'password_reset'))`);
  // Serves "revoke outstanding tokens of a kind for this parent" lookups.
  pgm.createIndex("parent_tokens", ["parent_id", "kind"], { ifNotExists: true, name: "idx_parent_tokens_parent_kind" });
};

exports.down = (pgm) => {
  pgm.dropTable("parent_tokens", { ifExists: true });
  pgm.dropTable("parent_sessions", { ifExists: true });
};
