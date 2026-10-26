// Dwara edge-gateway configuration gates (issue #65) — pure filesystem +
// schema validation, no database, no network, no gateway binary needed
// (CI cannot see the ShristiLabs/dwara repo; the schema is vendored and
// provenance-pinned below). These enforce the issue's acceptance criteria
// structurally:
//
//   1. Every deploy/dwara/envs/*.yaml validates against the vendored
//      Dwara JSON Schema (config-reference.json) — schema-driven parity
//      with the real gateway's own config validation.
//   2. The vendored schema IS the pinned upstream artifact (sha256).
//   3. Consumers cover the three audiences with DISTINCT api-key
//      credentials, and no credential value is a literal (SSM/ENV refs).
//   4. The mTLS admin surface is isolated: admin.tls requires a client
//      CA; the admin port is not a listener port; no PUBLIC listener
//      ever carries client_ca_file (mTLS is admin-only).
//   5. Every OpenAPI baseline path is routed through the gateway.
//   6. Every referenced policy is defined; every defined policy is used.
//   7. Every proxy route strips the gateway-injected X-Consumer-* headers
//      (D10: the origin must never see edge identity).
//   8. TLS posture: public listener terminates TLS; upstream to the
//      origin is HTTPS in staging/prod (loopback http1 in dev only).
//   9. Env parity: staging == prod byte-identical; dev differs ONLY by
//      the origin upstream triple (address/port/protocol) — DRY.
//  10. Routes are auth_required: false TODAY (staged rollout — deployed
//      clients do not yet send edge class keys; flipping this is the
//      deliberate stage-2 change and must update this test + docs).
//  11. Secret-scan parity over deploy/ (no PEM blocks, no literal
//      secret-ish assignments outside the documented placeholder idiom).
//  12. Rate-limit layering: the docs/gateway.md budget table matches the
//      config exactly (no doc drift), and every user-facing edge limit
//      sits strictly ABOVE the origin's governing semantic limit parsed
//      from server.mjs/sync.mjs source (no inversion — legit users always
//      trip the origin first). /api/health is the one deliberate,
//      documented exception (probe endpoint, edge-tight by design) and is
//      pinned as such so loosening it re-decides in review.
//  13. gen-dev-certs.sh, executed in a sandbox: private keys land 0600,
//      certificates 0644, CSR/serial artifacts cleaned up (no 0600
//      violation, no stray material).
//  14. Docker entrypoint + Dockerfile.gateway structural safety: the SSM
//      env->PEM bridge fails closed on missing env, chmods 600, execs the
//      gateway; the image runs non-root, bakes exactly one env config,
//      and never COPYies key material.
//  15. Cert-path isolation: staging/prod TLS file paths are container
//      paths (/etc/dwara/certs) — dev-generated material can never be
//      referenced by a deployed config.

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import yaml from "yaml";

const require = createRequire(import.meta.url);
const { default: Ajv2020 } = require("ajv/dist/2020");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEPLOY_DIR = path.join(REPO_ROOT, "deploy", "dwara");
const ENV_FILES = ["dev", "staging", "prod"].map((e) => ({
  env: e,
  file: path.join(DEPLOY_DIR, "envs", `${e}.yaml`),
}));
const SCHEMA_FILE = path.join(DEPLOY_DIR, "schema", "config-reference.json");

// Vendored from ShristiLabs/dwara config-reference.json @ commit
// 68f6c69c4675f44b3430bda89f04d2e51d50821d (2026-09-16). If the schema
// changes upstream, vendor the new file and update BOTH this sha and the
// README provenance note — never edit the vendored file by hand.
const SCHEMA_SHA256 =
  "a7cca27c445f022abf3825a2cfef124773380e3c3f9b06145972fd4741848a21";

function loadEnv(env) {
  return yaml.parse(fs.readFileSync(path.join(DEPLOY_DIR, "envs", `${env}.yaml`), "utf8"));
}

const CONFIGS = Object.fromEntries(ENV_FILES.map(({ env }) => [env, loadEnv(env)]));
const BASELINE = yaml.parse(fs.readFileSync(path.join(REPO_ROOT, "docs", "openapi", "baseline.yaml"), "utf8"));

// ---------------------------------------------------------------------------
// 1 + 2: schema validation + provenance pin
// ---------------------------------------------------------------------------

describe("dwara config: schema validation (vendored Dwara JSON Schema)", () => {
  test("vendored schema is the pinned upstream artifact (sha256)", () => {
    const sha = crypto.createHash("sha256").update(fs.readFileSync(SCHEMA_FILE)).digest("hex");
    assert.equal(sha, SCHEMA_SHA256, "deploy/dwara/schema/config-reference.json drifted from the pinned upstream copy — re-vendor deliberately");
  });

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8")));

  for (const { env } of ENV_FILES) {
    test(`env ${env} validates against the Dwara config schema`, () => {
      const ok = validate(CONFIGS[env]);
      const issues = (validate.errors || [])
        .map((e) => `${e.instancePath || "<root>"} ${e.message}`)
        .join("; ");
      assert.ok(ok, `${env}.yaml schema violations: ${issues}`);
    });
  }
});

// ---------------------------------------------------------------------------
// 3: consumers + credentials (distinct, ref-only)
// ---------------------------------------------------------------------------

describe("dwara config: consumers and credentials (issue AC)", () => {
  const AUDIENCES = ["parent-app", "child-device", "portal"];

  for (const { env } of ENV_FILES) {
    test(`env ${env}: three audience consumers with distinct api-key credentials`, () => {
      const names = CONFIGS[env].consumers.map((c) => c.name);
      for (const a of AUDIENCES) assert.ok(names.includes(a), `${env}: consumer ${a} missing`);
      const creds = CONFIGS[env].consumers.flatMap((c) =>
        c.credentials.filter((cr) => cr.type === "api_key").map((cr) => cr.key)
      );
      assert.equal(creds.length, AUDIENCES.length, `${env}: expected exactly one api_key per audience`);
      assert.equal(new Set(creds).size, creds.length, `${env}: credential refs must be distinct`);
    });

    test(`env ${env}: credential values are ENV references, never literals`, () => {
      for (const c of CONFIGS[env].consumers) {
        for (const cr of c.credentials || []) {
          if (cr.type === "api_key") {
            assert.match(
              cr.key,
              /^\$\{[A-Z0-9_]+\}$/,
              `${env}: consumer ${c.name} api_key must be a $ {ENV} reference (SSM-injected), got a literal`
            );
          }
        }
      }
    });

    test(`env ${env}: every consumer carries a daily quota (budget table is real)`, () => {
      for (const c of CONFIGS[env].consumers) {
        assert.ok(c.quotas?.daily_requests > 0, `${env}: consumer ${c.name} missing daily quota`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4: mTLS admin isolation (issue AC "admin mTLS-only, never public")
// ---------------------------------------------------------------------------

describe("dwara config: admin mTLS isolation", () => {
  for (const { env } of ENV_FILES) {
    test(`env ${env}: admin block requires full mTLS material`, () => {
      const admin = CONFIGS[env].admin;
      assert.ok(admin, `${env}: admin block missing`);
      for (const f of ["cert_file", "key_file", "client_ca_file"]) {
        assert.ok(admin.tls?.[f], `${env}: admin.tls.${f} missing (client_ca_file is what makes it mTLS)`);
      }
    });

    test(`env ${env}: admin port is not a listener port (separate surface)`, () => {
      const adminPort = Number(/:(\d+)$/.exec(CONFIGS[env].admin.bind)[1]);
      for (const l of CONFIGS[env].listeners) {
        assert.notEqual(l.port, adminPort, `${env}: listener ${l.name} must not bind the admin port`);
      }
    });

    test(`env ${env}: no public listener carries client_ca_file (mTLS is admin-only)`, () => {
      for (const l of CONFIGS[env].listeners) {
        assert.ok(
          !l.tls?.client_ca_file,
          `${env}: public listener ${l.name} must not require client certificates`
        );
      }
    });

    test(`env ${env}: admin port is the documented 2019 ops port`, () => {
      assert.equal(CONFIGS[env].admin.bind, "0.0.0.0:2019");
    });
  }
});

// ---------------------------------------------------------------------------
// 5: route coverage of the OpenAPI baseline
// ---------------------------------------------------------------------------

describe("dwara config: route map covers the API", () => {
  function routeMatches(route, apiPath) {
    const p = route.match.path;
    if (p.type === "prefix") return apiPath.startsWith(p.value);
    if (p.type === "regex") {
      // Dwara regexes are unanchored Rust regex; our configs anchor
      // explicitly (^...$). Match the OpenAPI template path with
      // {param} segments as non-empty segments.
      const expanded = apiPath.replace(/\{[^}]+\}/g, "[^/]+");
      return new RegExp(p.value).test(expanded);
    }
    if (p.type === "exact") return apiPath === p.value;
    return false;
  }

  for (const { env } of ENV_FILES) {
    test(`env ${env}: every OpenAPI baseline path is routed`, () => {
      const unrouted = Object.keys(BASELINE.paths).filter(
        (apiPath) => !CONFIGS[env].routes.some((r) => routeMatches(r, apiPath))
      );
      assert.deepEqual(unrouted, [], `${env}: paths not covered by any gateway route`);
    });

    test(`env ${env}: health, auth-sensitive, and sync have dedicated tighter policies`, () => {
      const byName = Object.fromEntries(CONFIGS[env].routes.map((r) => [r.name, r]));
      assert.deepEqual(byName["api-health"].policies, ["edge-health"]);
      assert.ok(byName["api-auth-sensitive"].policies.includes("edge-auth-sensitive"));
      assert.ok(byName["api-sync"].policies.includes("edge-sync"));
    });
  }
});

// ---------------------------------------------------------------------------
// 6: policy registry consistency
// ---------------------------------------------------------------------------

describe("dwara config: policy registry consistency", () => {
  for (const { env } of ENV_FILES) {
    test(`env ${env}: referenced policies all defined; defined policies all used`, () => {
      const defined = new Set(CONFIGS[env].policies.map((p) => p.name));
      const referenced = new Set(
        [
          ...(CONFIGS[env].global_policies || []),
          ...CONFIGS[env].listeners.flatMap((l) => l.policies || []),
          ...CONFIGS[env].routes.flatMap((r) => r.policies || []),
          ...CONFIGS[env].consumers.flatMap((c) => c.policies || []),
        ].filter(Boolean)
      );
      for (const ref of referenced) {
        assert.ok(defined.has(ref), `${env}: policy ${ref} referenced but not defined`);
      }
      for (const def of defined) {
        assert.ok(referenced.has(def), `${env}: policy ${def} defined but never attached (dead config)`);
      }
    });

    test(`env ${env}: rate-limit rules use valid selectors and windows`, () => {
      const allowed = new Set(["ip", "credential", "route"]);
      for (const p of CONFIGS[env].policies) {
        for (const rule of p.rate_limits || []) {
          assert.ok(rule.selector.length >= 1, `${env}: ${p.name} rule needs a selector`);
          for (const s of rule.selector) assert.ok(allowed.has(s), `${env}: ${p.name} bad selector ${s}`);
          assert.ok(
            rule.requests_per.s || rule.requests_per.minute || rule.requests_per.hour,
            `${env}: ${p.name} rule needs at least one window`
          );
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 7: D10 header isolation toward the origin
// ---------------------------------------------------------------------------

describe("dwara config: D10 — origin never sees edge identity", () => {
  for (const { env } of ENV_FILES) {
    test(`env ${env}: every proxy route strips X-Consumer-* headers`, () => {
      for (const r of CONFIGS[env].routes) {
        const removed = r.transforms?.request?.headers?.remove || [];
        assert.ok(
          removed.includes("X-Consumer-Name") && removed.includes("X-Consumer-Type"),
          `${env}: route ${r.name} must strip X-Consumer-Name/Type toward the origin`
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 8: TLS posture
// ---------------------------------------------------------------------------

describe("dwara config: TLS termination and upstream posture", () => {
  for (const { env } of ENV_FILES) {
    test(`env ${env}: public listener is TLS terminate with cert material`, () => {
      const l = CONFIGS[env].listeners.find((x) => x.name === "public-https");
      assert.equal(l.protocol, "https");
      assert.equal(l.tls.mode, "terminate");
      assert.ok(l.tls.cert_file && l.tls.key_file);
    });

    test(`env ${env}: upstream protocol is encrypted off-loopback`, () => {
      const up = CONFIGS[env].upstreams.find((u) => u.name === "origin-alb");
      if (env === "dev") {
        assert.equal(up.protocol, "http1");
        assert.equal(up.endpoints[0].address, "127.0.0.1");
      } else {
        assert.equal(up.protocol, "https", `${env}: edge->origin must be TLS`);
        assert.equal(up.endpoints[0].port, 443);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 9: env parity DRY
// ---------------------------------------------------------------------------

describe("dwara config: environment parity (DRY)", () => {
  test("staging and prod are byte-identical", () => {
    assert.equal(
      fs.readFileSync(path.join(DEPLOY_DIR, "envs", "staging.yaml"), "utf8"),
      fs.readFileSync(path.join(DEPLOY_DIR, "envs", "prod.yaml"), "utf8"),
      "staging/prod gateway configs must not drift; differences belong in deploy-time values"
    );
  });

  // The ONLY sanctioned per-env deltas: the two upstream triples — the
  // origin API (upstreams.0) and the #71 web-client static host
  // (upstreams.1; dev serves the export from loopback :4200, staged
  // envs point at the static-hosting endpoint). Everything else must
  // stay byte-identical across environments.
  const ALLOWED_DELTA_PATHS = new Set([
    "upstreams",
    "upstreams.0",
    "upstreams.0.protocol",
    "upstreams.0.endpoints",
    "upstreams.0.endpoints.0",
    "upstreams.0.endpoints.0.address",
    "upstreams.0.endpoints.0.port",
    "upstreams.1",
    "upstreams.1.protocol",
    "upstreams.1.endpoints",
    "upstreams.1.endpoints.0",
    "upstreams.1.endpoints.0.address",
    "upstreams.1.endpoints.0.port",
  ]);

  function diffKeys(a, b, prefix = "", out = []) {
    if (a === b) return out;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
      out.push(prefix);
      return out;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      diffKeys(a[k], b[k], prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }

  test("dev differs from staging ONLY by the origin upstream triple", () => {
    const deltas = diffKeys(CONFIGS.staging, CONFIGS.dev);
    const illegal = deltas.filter((d) => !ALLOWED_DELTA_PATHS.has(d));
    assert.deepEqual(illegal, [], `dev/staging drifted outside the upstream allowlist: ${illegal}`);
  });
});

// ---------------------------------------------------------------------------
// 10: staged rollout marker (auth_required)
// ---------------------------------------------------------------------------

describe("dwara config: staged credential rollout", () => {
  for (const { env } of ENV_FILES) {
    test(`env ${env}: routes are auth_required:false (stage 1 — clients ship keys first, then flip)`, () => {
      for (const r of CONFIGS[env].routes) {
        assert.equal(
          r.auth_required,
          false,
          `${env}: route ${r.name} flipped to auth_required — that is the stage-2 change; update docs/gateway.md and this test together`
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 11: secret-scan parity over deploy/
// ---------------------------------------------------------------------------

describe("deploy/ secret scan (no key material in the repo, ever)", () => {
  function walk(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "certs" || entry.name === "node_modules") continue;
        walk(full, acc);
      } else if (/\.(ya?ml|json|sh|mjs|md|Dockerfile.*)$/.test(entry.name) || entry.name.startsWith("Dockerfile")) {
        acc.push(full);
      }
    }
    return acc;
  }

  test("no PEM blocks or literal secret assignments anywhere under deploy/", () => {
    const files = walk(DEPLOY_DIR);
    assert.ok(files.length >= 8, `expected the deploy tree to be scanned, found ${files.length}`);
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        assert.ok(
          !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line),
          `${path.relative(REPO_ROOT, file)}:${i + 1} contains PEM key material`
        );
        // Generic secret-shaped names AND the dwara credential field name
        // itself (`key:` — under deploy/dwara any literal key value is
        // credential material; only ${...} references are sanctioned).
        const m =
          /["']?(?:secret|password|token|api_?key)["']?\s*[:=]\s*["']([^"']{6,})["']/i.exec(line) ||
          /^(\s*key:\s*["'][^"']{6,}["'])/.exec(line);
        if (m && !m[0].includes("${") && !m[1].includes("${")) {
          // allow the documented public-by-design placeholder idiom and
          // shell variable indirection only
          assert.fail(
            `${path.relative(REPO_ROOT, file)}:${i + 1} literal secret-shaped assignment: ${m[0].slice(0, 60)}`
          );
        }
      });
    }
  });

  test("generated dev certs are gitignored", () => {
    const gi = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
    assert.ok(gi.includes("deploy/dwara/certs/"), ".gitignore must cover deploy/dwara/certs/");
  });
});

// ---------------------------------------------------------------------------
// 12: rate-limit layering (docs table <-> config <-> origin source)
// ---------------------------------------------------------------------------

describe("dwara config: rate-limit layering (no doc drift, no origin inversion)", () => {
  // Origin semantic limits are parsed FROM SOURCE (the `|| default`
  // literals), so this suite drifts with the origin instead of trusting
  // a copied constant.
  const serverSrc = fs.readFileSync(path.join(REPO_ROOT, "services", "api", "server.mjs"), "utf8");
  const syncSrc = fs.readFileSync(path.join(REPO_ROOT, "services", "api", "sync.mjs"), "utf8");
  function envDefault(src, name) {
    const m = new RegExp(`${name}\\s*\\|\\|\\s*(\\d+)`).exec(src);
    assert.ok(m, `origin default for ${name} not found in source — was it renamed?`);
    return Number(m[1]);
  }
  const ORIGIN = {
    generalPerIp: envDefault(serverSrc, "RATE_LIMIT_PER_IP_MIN"), // 120
    perToken: envDefault(serverSrc, "RATE_LIMIT_PER_TOKEN_MIN"), // 60
    login: envDefault(serverSrc, "RATE_LIMIT_LOGIN_PER_IP_MIN"), // 10
    parentSignup: envDefault(serverSrc, "RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN"), // 5
    parentLogin: envDefault(serverSrc, "RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN"), // 10
    parentToken: envDefault(serverSrc, "RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN"), // 10
    parentReset: envDefault(serverSrc, "RATE_LIMIT_PARENT_RESET_PER_IP_MIN"), // 5
    syncPerToken: envDefault(syncSrc, "RATE_LIMIT_SYNC_PER_TOKEN_MIN"), // 30
  };
  // Tightest-vs-loosest: for origin-first governance the edge per-IP bound
  // on the auth surface must exceed the LOOSEST origin semantic on those
  // same paths (i.e. max), so no auth path can trip the edge first.
  const authOriginMax = Math.max(
    ORIGIN.login,
    ORIGIN.parentSignup,
    ORIGIN.parentLogin,
    ORIGIN.parentToken,
    ORIGIN.parentReset
  );

  function policy(env, name) {
    return CONFIGS[env].policies.find((p) => p.name === name);
  }
  function rule(env, policyName, ruleName) {
    return policy(env, policyName).rate_limits.find((r) => r.name === ruleName);
  }

  test("docs/gateway.md budget table matches the config exactly (no doc drift)", () => {
    const runbook = fs.readFileSync(path.join(REPO_ROOT, "docs", "gateway.md"), "utf8");
    const tableRows = runbook
      .split("\n")
      .filter((l) => l.startsWith("|") && /`edge-[a-z-]+`/.test(l));
    assert.ok(tableRows.length >= 6, "expected the edge policy table in the runbook");

    const norm = (arr) => arr.map((x) => String(x)).sort().join(" | ");
    // doc side: policy -> minute/hour pairs + bursts, parsed from the
    // LIMIT column (cells[3]) only, so rationale prose cannot skew it.
    const docPolicies = new Map();
    for (const row of tableRows) {
      const cells = row.split("|").map((c) => c.trim());
      const name = /`(?:edge-[a-z-]+)`/.exec(cells[1])?.[0].slice(1, -1);
      if (!name || !cells[3]) continue;
      const m = /(\d+)k?\/min/.exec(cells[3]);
      const h = /(\d+)k?\/hour/.exec(cells[3]);
      const b = /burst (\d+)/.exec(cells[3]);
      if (!m || !h) continue;
      const entry = docPolicies.get(name) || { pairs: [], bursts: [] };
      entry.pairs.push([
        Number(m[1]) * (m[0].includes("k") ? 1000 : 1),
        Number(h[1]) * (h[0].includes("k") ? 1000 : 1),
      ]);
      if (b) entry.bursts.push(Number(b[1]));
      docPolicies.set(name, entry);
    }
    assert.ok(docPolicies.size >= 5, `runbook table parsed ${docPolicies.size} policies — parser broken?`);

    for (const [name, { pairs, bursts }] of docPolicies) {
      const p = policy("staging", name);
      assert.ok(p, `runbook documents policy ${name} but the config does not define it`);
      const cfgPairs = p.rate_limits.map((r) => [r.requests_per.minute, r.requests_per.hour]);
      const cfgBursts = p.rate_limits.filter((r) => r.burst != null).map((r) => r.burst);
      assert.equal(
        norm(pairs),
        norm(cfgPairs),
        `${name}: runbook table and config minute/hour windows disagree`
      );
      assert.equal(
        norm(bursts),
        norm(cfgBursts),
        `${name}: runbook table and config burst values disagree`
      );
    }
  });

  test("user-facing edge limits sit strictly ABOVE origin semantic limits (no inversion)", () => {
    // staging is byte-identical to prod and dev differs only by the
    // upstream triple, so asserting on staging covers every env.
    const floor = rule("staging", "edge-default", "floor-per-ip");
    assert.ok(
      floor.requests_per.minute > ORIGIN.generalPerIp,
      `edge floor ${floor.requests_per.minute}/min must exceed the origin general ${ORIGIN.generalPerIp}/min`
    );
    assert.ok(
      floor.requests_per.hour > ORIGIN.generalPerIp * 60,
      "edge floor hour window must exceed the origin general minute extrapolated"
    );

    const authIp = rule("staging", "edge-auth-sensitive", "auth-per-ip");
    assert.ok(
      authIp.requests_per.minute > authOriginMax,
      `edge auth ${authIp.requests_per.minute}/min must exceed the loosest origin auth semantic ${authOriginMax}/min`
    );
    const authCred = rule("staging", "edge-auth-sensitive", "auth-per-credential");
    assert.ok(
      authCred.requests_per.minute >= authIp.requests_per.minute,
      "class-level auth bound must not be tighter than the per-IP bound"
    );

    const syncIp = rule("staging", "edge-sync", "sync-per-ip");
    const syncClass = rule("staging", "edge-sync", "sync-per-class");
    assert.ok(
      syncIp.requests_per.minute > ORIGIN.syncPerToken,
      `edge sync ${syncIp.requests_per.minute}/min/IP must exceed the origin per-device ${ORIGIN.syncPerToken}/min`
    );
    assert.ok(
      syncClass.requests_per.minute > syncIp.requests_per.minute,
      "the class budget must be looser than the per-IP budget (many IPs share a class)"
    );

    const general = rule("staging", "edge-general", "general-per-class");
    assert.ok(
      general.requests_per.minute > Math.max(ORIGIN.generalPerIp, ORIGIN.perToken),
      "edge general class budget must exceed both origin per-IP and per-token semantics"
    );
  });

  test("/api/health stays edge-tight BY DESIGN (the one documented inversion)", () => {
    // Health is an ops probe, not a user path: the runbook deliberately
    // caps it BELOW the origin's general semantic so scrapers die at the
    // edge. Pin both directions so any change re-decides in review.
    const health = rule("staging", "edge-health", "health-per-ip");
    assert.ok(
      health.requests_per.minute < ORIGIN.generalPerIp,
      "health probe budget was loosened past the origin general semantic — deliberate?"
    );
    assert.ok(
      health.requests_per.minute <= rule("staging", "edge-auth-sensitive", "auth-per-ip").requests_per.minute,
      "health must never be looser than the credential-attack surface"
    );
  });
});

// ---------------------------------------------------------------------------
// 13: gen-dev-certs.sh behavioral safety (sandboxed execution)
// ---------------------------------------------------------------------------

describe("gen-dev-certs.sh: key hygiene under execution", () => {
  test("sandbox run: private keys 0600, certs 0644, no leftover CSR/serial artifacts", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "balashi-certs-"));
    try {
      fs.copyFileSync(path.join(DEPLOY_DIR, "gen-dev-certs.sh"), path.join(tmp, "gen-dev-certs.sh"));
      execFileSync("sh", ["gen-dev-certs.sh"], { cwd: tmp, stdio: "pipe" });
      const certsDir = path.join(tmp, "certs");
      for (const key of ["server.key", "client.key", "client-ca.key"]) {
        const mode = fs.statSync(path.join(certsDir, key)).mode & 0o777;
        assert.equal(mode, 0o600, `${key} must be 0600, got ${mode.toString(8)}`);
        assert.match(fs.readFileSync(path.join(certsDir, key), "utf8"), /PRIVATE KEY/);
      }
      for (const crt of ["server.crt", "client.crt", "client-ca.crt"]) {
        const mode = fs.statSync(path.join(certsDir, crt)).mode & 0o777;
        assert.equal(mode, 0o644, `${crt} must be 0644, got ${mode.toString(8)}`);
        assert.match(fs.readFileSync(path.join(certsDir, crt), "utf8"), /-----BEGIN CERTIFICATE-----/);
      }
      assert.ok(!fs.existsSync(path.join(certsDir, "client.csr")), "CSR must be cleaned up");
      assert.ok(!fs.existsSync(path.join(certsDir, "client-ca.srl")), "serial file must be cleaned up");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 14: docker entrypoint + image structural safety
// ---------------------------------------------------------------------------

describe("gateway image: SSM env->PEM bridge and image posture", () => {
  const ENTRYPOINT = fs.readFileSync(path.join(DEPLOY_DIR, "docker", "entrypoint.sh"), "utf8");
  const DOCKERFILE = fs.readFileSync(path.join(DEPLOY_DIR, "docker", "Dockerfile.gateway"), "utf8");

  test("entrypoint fails closed on missing env, locks permissions, never prints values, execs dwara", () => {
    assert.match(ENTRYPOINT, /set -eu/);
    assert.match(ENTRYPOINT, /missing required env/);
    assert.match(ENTRYPOINT, /exit 1/);
    assert.match(ENTRYPOINT, /write_pem server\.crt EDGE_TLS_CERT/);
    assert.match(ENTRYPOINT, /write_pem server\.key EDGE_TLS_KEY/);
    assert.match(ENTRYPOINT, /write_pem client-ca\.crt EDGE_TLS_CLIENT_CA/);
    assert.match(ENTRYPOINT, /chmod 600/);
    assert.match(ENTRYPOINT, /DWARA_STATE_DB/);
    assert.match(ENTRYPOINT, /exec \/usr\/local\/bin\/dwara/);
    // Secret VALUES never reach stdout/stderr — only variable NAMES may.
    assert.doesNotMatch(ENTRYPOINT, /echo[^|]*\$\{?(EDGE_TLS_CERT|EDGE_TLS_KEY|EDGE_TLS_CLIENT_CA|BALASHIKSHANA_EDGE_KEY)/);
  });

  test("Dockerfile: non-root, single-env config baked, no key material in image layers", () => {
    assert.match(DOCKERFILE, /USER 65532:65532/);
    assert.match(DOCKERFILE, /ENTRYPOINT \["\/entrypoint\.sh"\]/);
    assert.match(DOCKERFILE, /COPY deploy\/dwara\/envs\/\$\{DWARA_ENV\}\.yaml \/etc\/dwara\/dwara\.yaml/);
    assert.ok(!/COPY\s+deploy\/dwara\/certs/.test(DOCKERFILE), "image must never COPY dev cert material");
    assert.ok(!/^ENV\s+EDGE_TLS/m.test(DOCKERFILE), "TLS material must never be an image ENV default");
  });
});

// ---------------------------------------------------------------------------
// 15: cert-path isolation (dev material can never reach a deployed config)
// ---------------------------------------------------------------------------

describe("dwara config: cert-path isolation", () => {
  for (const env of ["staging", "prod"]) {
    test(`env ${env}: every TLS file path is a container path under /etc/dwara/certs`, () => {
      const c = CONFIGS[env];
      const paths = [
        ...c.listeners.flatMap((l) => [l.tls?.cert_file, l.tls?.key_file, l.tls?.client_ca_file]),
        c.admin?.tls?.cert_file,
        c.admin?.tls?.key_file,
        c.admin?.tls?.client_ca_file,
      ].filter(Boolean);
      assert.ok(paths.length >= 5, `expected TLS material paths, found ${paths.length}`);
      for (const p of paths) {
        assert.match(p, /^\/etc\/dwara\/certs\//, `${env}: ${p} must be a container path`);
      }
    });
  }

  test("no env config references the dev certs directory", () => {
    // Values, not comments: dev.yaml's header legitimately MENTIONS the
    // dev certs dir in prose, but no TLS *_file value may point there —
    // and staging/prod must not mention it at all.
    function filePaths(node, acc = []) {
      if (typeof node === "string") {
        if (/\.(crt|key|pem)$/.test(node)) acc.push(node);
      } else if (node && typeof node === "object") {
        for (const v of Object.values(node)) filePaths(v, acc);
      }
      return acc;
    }
    for (const { env } of ENV_FILES) {
      for (const p of filePaths(CONFIGS[env])) {
        assert.ok(
          !p.includes("deploy/dwara"),
          `${env}.yaml TLS file value ${p} points at in-repo dev material`
        );
      }
    }
    for (const env of ["staging", "prod"]) {
      const raw = fs.readFileSync(path.join(DEPLOY_DIR, "envs", `${env}.yaml`), "utf8");
      assert.ok(
        !raw.includes("deploy/dwara/certs"),
        `${env}.yaml references dev cert material — dev CA must never front a deployed environment`
      );
    }
  });
});
