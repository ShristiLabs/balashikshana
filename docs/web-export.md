# Web Edition (Chromebook/PWA reach) — issue #71

The SAME Expo app, exported for the browser (`npx expo export
--platform web`, react-native-web rendering) and served as a static
bundle behind the #65 Dwara edge. One codebase, one issue tracker, one
consent regime: no web fork exists (roadmap D1 rejects a separate web
codebase) — platform differences live exclusively inside the seam
modules below.

This document is the adapter matrix, the keyboard/mouse parity matrix,
the offline/degradation capability matrix, and the hosting/origin
record for the web edition. Enforcement is test-pinned
(`apps/mobile/tests/web-*.test.ts`, `keyboard-parity-pins.test.ts`).

## 1. Build, serve, and where it runs

```sh
# build (apps/mobile):
npx expo export --platform web          # -> dist/ (SPA, "web.output": "single")
# dev/staging serve on the SAME origin the harness used (:4200):
npm run web                             # server.mjs serves dist/, SPA fallback
# budget (same doctrine + gate as native):
node scripts/measure-bundle-sizes.mjs --check
```

- The web export is a LOCAL-REGRESSION gate (CI stays cheap by
  doctrine; no expo export in ci.yml).
- `server.mjs` serves `dist/` on :4200 with an SPA fallback for
  expo-router paths — the origin API CORS allowlists already carry
  (dev default + docker-compose), so the repurposed server keeps
  origin continuity with the retired dev harness.
- HTTP cache policy (review-hardened): `immutable, max-age=1y` is
  scoped to CONTENT-HASHED filenames only (`isContentHashedAsset`:
  `_expo/static/**` or a hash run embedded in the basename); every
  stable-named deployable file — the shell, `sw.js`,
  `manifest.webmanifest`, `icons/*`, `vendor/sql-wasm.wasm`,
  `favicon.ico`, `metadata.json` — revalidates `no-cache`, so new
  bytes under a stable name are never pinned stale for a year. The
  listener never throws: request parsing (URL construction incl. a
  malformed Host, percent-decoding) answers 400 and stream errors
  answer 500 — a malformed request can never kill the 0.0.0.0-bound
  process (behavior-pinned for the whole class in
  `tests/web-server.test.ts`).
- Content trust: dev/staging deployments serve dev-signed packs, but a
  web export is a production bundle (`__DEV__ === false`). Export with
  `EXPO_PUBLIC_CONTENT_TRUST_DEV=true` ONLY for dev/staging serving
  surfaces (packs there are dev-signed by construction); production
  exports never set it and keep the full doctrine (release key only,
  empty trust list installs nothing). `contentTrustIsDev()` in
  `src/content/keys.ts` is the single switch, test-pinned.
  PRODUCTION-EXPORT VERIFICATION (launch-blocking, see the deploy
  runbook's web-edition section): the flag is BAKED at export time, so
  after building a production bundle run
  `grep -r "EXPO_PUBLIC_CONTENT_TRUST_DEV" apps/mobile/dist/` — it must
  find NOTHING. A hit means the bundle trusts dev-signed packs; rebuild
  without the env var.

## 2. Adapter matrix — every native seam and its web twin (Decision 2)

Platform selection happens ONLY inside seam modules: metro resolves
`.web.ts` twins for web exports; nothing above the seams branches on
`Platform.OS` except the two documented UI honesty spots (storage
notice, reminders section).

| Seam (single import surface) | Native twin | Web twin | Notes / honest limits |
|---|---|---|---|
| `src/platform/sqlite` | `expo-sqlite` (base module) | `sqlite.web.ts` — sql.js (SQLite-to-wasm) | expo-sqlite's web build requires a wa-sqlite wasm WORKER a static export cannot bundle (verified empirically on SDK 58); sql.js is the same SQLite engine in wasm. DB images persist to browser storage (debounced writes + pagehide flush, best-effort), packs open read-only with `PRAGMA query_only` honored. |
| `src/platform/securekv` | `expo-secure-store` (Keychain/Keystore) | `securekv.web.ts` — IndexedDB strings | HONEST WEAKENING (web platform limit): browsers expose no hardware-backed store; tokens are plain strings in the app's origin-partitioned IndexedDB — device-local, wiped with site data, never transmitted except to the API's own authenticated calls. data-flow-inventory row 26. |
| `src/platform/packdb` | pack file from `Paths.document/content-packs` | `packdb.web.ts` — pack bytes from the browser pack store | Byte-identical .sqlite artifacts; same `query_only` read doctrine. |
| `src/content/nativeContent` (getContentPackService) | expo-file-system download/stream + native SHA-256 | `webContent.ts` — fetch-buffered download + @noble SHA-256 | Same ContentPackService logic, same signed-pack Ed25519/@noble verification (pure JS), same lifecycle DB schema (sharedContent.ts). Limit: no streaming download (multi-MB buffered in JS — fine within budget). "Atomic rename" = store-key swap (meta only ever points at fully verified bytes). |
| `src/onboarding/nativeStores` | SecureStore + expo-sqlite snapshot | same seam code, platform twins resolve | No fork: the module imports the seam, metro picks the twin. |
| `src/audio/nativeAudio` | expo-audio/expo-speech/expo-haptics | first-party web implementations of the same Expo modules | Web Speech API / HTMLAudio where available; haptics documented no-op. |
| `src/a11y/nativeAnnounce` | AccessibilityInfo.announceForAccessibility | `nativeAnnounce.web.ts` — visually-hidden aria-live region | Chosen over RNW's AccessibilityInfo bridge for cross-engine reliability (clear-then-set with microtask break). |
| `src/sync/nativeSync` | NetInfo + AppState | navigator.onLine + visibilitychange (first-party web path of the same libs) | Same sync engine; browser-edition offline convergence mirrors the M3 airplane-mode tests. |
| `src/notifications/localReminders` | expo-notifications local scheduling | `localReminders.web.ts` — honest no-ops | Notifications are UNAVAILABLE on web: browser push is out of doctrine and a kid-safe build never triggers browser permission prompts. The twin keeps ALL notification code (incl. the push-endpoint strings) out of the web bundle. The parent settings section explains instead of toggling. |

## 3. Keyboard/mouse parity matrix (Decision 8)

Every interaction type is completable keyboard-only AND mouse-only.
Evidence: `tests/keyboard-parity-pins.test.ts` (source pins; the repo's
standing doctrine — no component harness on mobile) + the visible-focus
ring in the exported shell (`:focus-visible` pin in web-pwa.test.ts).

| Interaction type | Surface | Mouse | Keyboard |
|---|---|---|---|
| Choice selection | ChoiceGrid | click | Tab + Enter/Space (Pressable role=button — RNW activates on Enter/Space) |
| Counter taps | CounterFrame | click | Tab + Enter/Space |
| Sequence building | TileBuilder | click-to-select / click-to-place (tap-to-place by design, never drag) | Tab + Enter/Space per tile |
| Block building | BlockBuilderGame | click-to-place bank (drag-free) | Tab + Enter/Space |
| Bubble popping | BubblePopBlitzGame | click | Tab + Enter/Space |
| Paying | MarketCashierGame | click coin keys (drag-free) | Tab + Enter/Space |
| Feeding | MonsterPhonemeFeederGame | click | Tab + Enter/Space |
| Hold-to-confirm gate | ParentalGate | press-and-hold the button | hold Enter or Space (native DOM keydown starts, keyup releases; auto-repeat filtered; Space scroll suppressed) — the ONE interaction with explicit web code, in the single shared gate component |
| Focus visibility | all of the above | n/a | 3px high-contrast focus ring via `:focus-visible` in the shell template |

There are NO drag, pan, or hover-only interactions anywhere in the app
(whole-tree pin) — the 3-9 age band design (tap-only) is what makes
full parity achievable without interaction forks.

## 4. Offline + degradation capability matrix (Decision 9)

| Capability | Native | Web (storage available) | Web (storage blocked) |
|---|---|---|---|
| Mid-session offline play | yes (installed packs) | yes — shell cached by the service worker, packs + attempt queue in IndexedDB, sync converges on reconnect | yes WHILE THE PAGE STAYS OPEN (in-memory session) |
| Progress persistence | on-device SQLite | IndexedDB sql.js images + attempt queue | NOT persisted (session only) — honest notice shown |
| Pack installs | signed pack files | signed pack bytes in the pack store | none (cannot persist) |
| Tokens | Keychain/Keystore | IndexedDB (see seam matrix, row 2) | in-memory only |
| Reminders | local notifications | not available (doctrinal) | not available |
| User-facing honesty | n/a | none needed | "Storage unavailable" alert banner at startup (WebStorageNotice) |

- Storage detection is a REAL IndexedDB round-trip probe
  (`detectWebStorage`), not an API-presence check; any failure degrades
  to the in-memory backend — the app never breaks, it tells the truth.
- The service worker NEVER caches API responses or any child data
  (COPPA): app-shell static assets only, enumerated by prefix/exact
  allowlist; API origin/paths, cross-origin, and non-GET requests
  bypass the worker entirely (`public/sw.js`, policy-pinned).
- No push, no Notification permission requests, ever (kid-safe).

## 5. Hosting + origins (Decision 10)

- Static bundle behind the #65 Dwara edge: `deploy/dwara/envs/*.yaml`
  carry a `web-static` route (prefix `/` — longest-prefix-wins keeps
  every `/api/*` path on the API routes) proxied to a
  `web-static-host` upstream. dev = loopback :4200 (`server.mjs`
  serving the export); staging/prod = the environment's static hosting
  endpoint (zone placeholder follows the tfvars convention). Env
  parity remains test-enforced (dwara-config.test.mjs, extended
  allowlist for the second upstream triple).
- API CORS: `ALLOWED_ORIGINS` must include the web client origin per
  environment (infra variable descriptions say so; docker-compose dev
  default already carries `http://localhost:4200`).
- Single endpoint seam: `EXPO_PUBLIC_API_BASE` (dev default
  `http://localhost:4000`), exactly as native. The dist/ bundle is
  scan-enforced: only allowlisted first-party endpoints, zero
  non-triaged external origins, no `/api/b2b/*` (tests/
  web-export-scan.test.ts).

## 6. PWA surface (Decision 5 — basic, per issue scope)

`manifest.webmanifest` (standalone, brand colors, 192/512 any+maskable
icons), committed PNG icons generated by `scripts/gen-pwa-icons.mjs`
(zero-dependency deterministic rasterizer — rerunnable, no image deps),
and the app-shell service worker (`public/sw.js`). Installable-PWA
polish beyond basic offline is explicitly out of scope (#71).

## 7. Budget

See docs/performance-budget.md — the web JS bundle shares the 5.5 MiB
doctrine ceiling, measured + `--check`-enforced by
`scripts/measure-bundle-sizes.mjs` (plain-JS chunks, distinct from
native Hermes bytecode).

## 8. Known limits (honest)

- OFFLINE DEEP LINKS (review finding, within basic-offline scope):
  navigation requests are network-first, so an offline RELOAD of a deep
  link (e.g. `/journey`) waits for the fetch to fail before the worker
  falls back to the cached shell — and on a first visit (worker not yet
  installed/active) there is no fallback at all and the load fails.
  Only the app shell at `/` is precached (basic offline per #71);
  full offline navigation would need runtime route caching, which is
  out of scope.
- IndexedDB persistence of sql.js images is best-effort against sudden
  tab close (debounce + pagehide flush); the sync engine reconciles
  from the server on next visit — same convergence doctrine as native.
- `expo-sqlite`'s official web backend cannot ship in a static export
  (worker/wasm constraint above); sql.js is the documented alternative.
- Component-level jsdom rendering tests do not exist (repo-wide
  standing debt: no component harness); web policy is enforced by
  source pins + pure adapter tests instead.
