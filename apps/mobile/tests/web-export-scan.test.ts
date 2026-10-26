/**
 * #71 WEB-BUNDLE ENDPOINT SCAN (Decision 11, COPPA-binding): the
 * exported web bundle (apps/mobile/dist) may talk to exactly ONE
 * origin — the API base — and call exactly the allowlisted first-party
 * endpoints. This extends the src-level endpoint doctrine (single seam
 * EXPO_PUBLIC_API_BASE; /api/b2b/* never wired by clients) to the
 * artifact that actually ships to browsers, where a minifier could in
 * principle hide a stray URL a src grep would catch.
 *
 * Runs ONLY when dist/ exists (after `npx expo export --platform web`):
 * the export is a local-regression gate, not CI (ci.yml stays cheap by
 * doctrine); without an export present the suite SKIPS with a notice so
 * the plain `vitest run` baseline stays green.
 *
 * Scans every .js and .html file in dist/ for:
 * 1. ABSOLUTE URLS: every http(s) literal must be the API base origin
 *    (EXPO_PUBLIC_API_BASE at export time, dev default localhost:4000)
 *    or a same-origin/relative reference. Zero third-party origins —
 *    no CDN, no analytics, nothing.
 * 2. /api/ PATHS: every literal endpoint must be in the client seam
 *    allowlist (the exact set src/ calls today). Anything new fails
 *    here until it is added deliberately.
 * 3. /api/b2b/: must be ABSENT entirely (the B2B seam is server-side;
 *    no client ever wires it).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = join(mobileRoot, "dist");

const API_BASE = (process.env.EXPO_PUBLIC_API_BASE ?? "http://localhost:4000").replace(/\/+$/, "");
const API_BASE_ORIGIN = new URL(API_BASE).origin;

/**
 * INERT string origins — URL literals baked into vendored first-party
 * runtime code that are NEVER fetched: XML/SVG namespace identifiers
 * (w3.org — required by the DOM/SVG specs, not network addresses),
 * error-message documentation links (react.dev/errors, github.com issue
 * links, expo.fyi), and package metadata homepages from bundled libs.
 * Every origin here was triaged against the bundle source; a NEW origin
 * failing this scan must be triaged before allowlisting — that is the
 * point of the net.
 */
const INERT_ORIGIN_ALLOWLIST = new Set([
  "http://www.w3.org",
  "https://react.dev",
  "https://github.com",
  "https://expo.fyi",
  "https://expo.dev",
  // Vendored-runtime documentation links (error-message "see X" text in
  // expo-file-system / reanimated / sensors code): inert strings, never
  // fetched by the app.
  "https://docs.expo.dev",
  "https://docs.swmansion.com",
  "https://developers.google.com",
  "https://dev.to",
  // expo-asset's CLASSIC asset-registry base constant — a fallback for
  // remotely-hosted assets that this app never uses (every asset is
  // bundled locally; the dist scan of asset paths confirms same-origin
  // /assets/** only). Inert constant, never fetched in this build.
  "https://classic-assets.eascdn.net",
]);

/** Client seam endpoint allowlist — the exact set src/ calls (#71 audit). */
const API_ENDPOINT_ALLOWLIST = [
  "/api/parents/login",
  "/api/parents/signup",
  "/api/parents/verify-email",
  "/api/parents/refresh",
  "/api/parents/logout",
  "/api/parents/logout-all",
  "/api/parent/children",
  "/api/consent/policy/latest",
  "/api/consent/records",
  "/api/consent/status",
  "/api/content/packs",
  "/api/sync/attempts",
  "/api/sync/progress",
];

/** Dynamic (template-literal) endpoint prefixes that are legal. */
const API_ENDPOINT_PREFIXES = [
  "/api/legal/",
  "/api/parent/children/", // .../{id}/device-sessions
  "/api/content/packs/", // .../{gradeId}
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(entry)) out.push(p);
  }
  return out;
}

const hasDist = existsSync(distRoot);
const bundleFiles = hasDist ? walk(distRoot) : [];
const bundleText = bundleFiles.map((p) => ({ p, s: readFileSync(p, "utf8") }));

describe("#71 web-bundle endpoint + origin scan (dist/)", () => {
  it.skipIf(!hasDist || bundleFiles.length === 0)(
    "scan target present: " + bundleFiles.length + " js/html files under dist/",
    () => {
      expect(bundleFiles.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!hasDist || bundleFiles.length === 0)(
    "zero third-party origins — every absolute URL is the API base or a triaged inert string",
    () => {
      // Require a real hostname (dot + TLD, or localhost) after the
      // scheme, and stop the match at quote/paren boundaries: minified
      // code contains scheme fragments and adjacent code that are NOT
      // URL literals (e.g. 'https://' + host expressions).
      const urlRe =
        /https?:\/\/(?:[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}|localhost)(?::\d+)?[A-Za-z0-9._~:/?#@!$&*+,;=%-]*/g;
      for (const { p, s } of bundleText) {
        for (const match of s.matchAll(urlRe)) {
          const url = match[0];
          let origin: string;
          try {
            origin = new URL(url).origin;
          } catch {
            continue;
          }
          expect(
            origin === API_BASE_ORIGIN || INERT_ORIGIN_ALLOWLIST.has(origin),
            `${p}: non-API, non-triaged origin in bundle: ${url}`,
          ).toBe(true);
        }
      }
    },
  );

  it.skipIf(!hasDist || bundleFiles.length === 0)(
    "only allowlisted first-party API endpoints",
    () => {
      const apiRe = /["'`](\/api\/[A-Za-z0-9._/-]+)["'`]/g;
      for (const { p, s } of bundleText) {
        for (const match of s.matchAll(apiRe)) {
          const endpoint = match[1] ?? "";
          const allowed =
            API_ENDPOINT_ALLOWLIST.includes(endpoint) ||
            API_ENDPOINT_PREFIXES.some((prefix) => endpoint.startsWith(prefix));
          expect(allowed, `${p}: unlisted API endpoint in bundle: ${endpoint}`).toBe(true);
        }
      }
    },
  );

  it.skipIf(!hasDist || bundleFiles.length === 0)(
    "/api/b2b/* is absent from the web bundle",
    () => {
      for (const { p, s } of bundleText) {
        expect(s.includes("/api/b2b"), `${p}: B2B endpoint leaked into the web bundle`).toBe(false);
      }
    },
  );
});

if (!hasDist) {
  // Notice, not silence: the scan is part of the #71 local regression
  // gate (export first, then vitest run picks it up).
  console.warn(
    "[web-export-scan] dist/ absent — run `npx expo export --platform web` to enable the web-bundle scan",
  );
}
