# Balashikshana Parent Portal (apps/parent-portal)

The parent-facing web app (issue #61, milestone M5): children overview,
the accuracy-vs-speed quadrant per child, weekly time/progress, and the
parent controls (daily time limits, content controls, reminder
defaults). A SEPARATE lightweight React SPA — deliberately not a screen
inside the Expo app, and nothing in any child surface links here (D5 /
AGENTS.md child-safety invariant).

## Stack decisions (documented)

- **Vite + React 19 + TypeScript SPA** (evaluated vs Next.js): the
  portal is a thin authenticated client of the existing Fastify API —
  no SSR, no SEO (behind login), no server runtime of its own. An
  SSR framework would add a second Node service and framework weight
  for nothing this surface needs; the SPA is the right size.
- **Zero UI/chart dependencies.** The quadrant chart and the weekly
  bars are hand-rolled SVG/markup with design tokens
  (`src/tokens.css`) mirroring the mobile app's token philosophy
  (`apps/mobile/src/design/tokens.ts`), with standard-web contrast
  (this surface is adult-facing). A quadrant is positioned dots in a
  box; a charting library would add ~100KB for nothing.
- **No router dependency.** Three views behind one login are plain
  state; every navigation is a real button and the main heading
  receives focus on view change.
- **Token storage: in-memory + sessionStorage mirror** (see
  `src/auth.ts` for the full rationale): the bearer doctrine of the
  #40 parent auth is unchanged; the token never touches localStorage
  and no cookies are invented. One silent refresh rotation on boot;
  a 401 during use returns to the login screen.
- **No third-party analytics/SDKs ever** (D5). The bundle contains no
  telemetry of any kind; observability stays first-party at the API.

## Running

```bash
# from the repo root (the API must be running on :4000)
npm ci --workspaces=false --prefix apps/parent-portal
npm run dev --workspaces=false --prefix apps/parent-portal   # http://localhost:4300
```

The dev origin `http://localhost:4300` is part of the API's CORS dev
allowlist (`ALLOWED_ORIGINS` in `services/api/server.mjs`); production
sets the env to the portal's real origin. The API base URL defaults to
`http://localhost:4000` and is overridable via `VITE_API_BASE_URL` at
build time.

## Gates

```bash
npm run lint --workspaces=false --prefix apps/parent-portal
npm run typecheck --workspaces=false --prefix apps/parent-portal
npm test --workspaces=false --prefix apps/parent-portal     # vitest + testing-library (jsdom)
npm run build --workspaces=false --prefix apps/parent-portal
```

All four run in the single CI job (`.github/workflows/ci.yml`).
