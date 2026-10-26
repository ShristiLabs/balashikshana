/**
 * #71 web PWA surface pins — the enforcement net for the web edition's
 * service worker, manifest, and shell. The app has no component harness
 * (standing debt, #67), so web policy is enforced the way this repo
 * always has: derived-from-source expectations that FAIL when a future
 * edit regresses a covered property (the accessibility-source-pins
 * style). Deterministic by construction: pure fs reads + regex; no RN
 * import, no browser needed.
 *
 * Pins:
 * 1. SERVICE WORKER POLICY (COPPA-binding, Decision 4): app-shell
 *    static caching ONLY — the cacheable set is a fixed prefix/exact
 *    allowlist; /api/** is never cacheable; cross-origin is never
 *    cacheable; non-GET is never stored; the worker never touches the
 *    Notification API or push (kid-safe doctrine: no permission
 *    prompts, ever).
 * 2. REGISTRATION (#71): the SW registers from the root layout on web
 *    in PRODUCTION builds only (never the dev server), best-effort.
 * 3. MANIFEST (#71, Decision 5): basic PWA manifest — standalone
 *    display, brand colors, icons 192/512 + maskable, and the icon
 *    files actually exist in public/ (the export copies public/
 *    verbatim).
 * 4. SHELL TEMPLATE: the exported index.html links the manifest,
 *    declares the theme color, and carries the :focus-visible keyboard
 *    parity ring (Decision 8 — visible focus on every focusable).
 * 5. VENDOR: the sql.js wasm ships same-origin from public/vendor (no
 *    CDN/third-party origin in the locateFile pin or the file layout).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = fileURLToPath(new URL("..", import.meta.url));

function read(relative: string): string {
  return readFileSync(join(mobileRoot, relative), "utf8");
}

describe("#71 service worker policy (COPPA-binding)", () => {
  const sw = read("public/sw.js");

  it("scopes caching to same-origin static shell assets", () => {
    expect(sw).toContain("url.origin !== self.location.origin");
    expect(sw).toContain(
      'CACHEABLE_PREFIXES = ["/_expo/static/", "/assets/", "/vendor/", "/icons/"]',
    );
    expect(sw).toContain(
      'CACHEABLE_EXACT = new Set(["/", "/index.html", "/manifest.webmanifest"])',
    );
  });

  it("NEVER stores /api/** responses (child data must not live in the SW cache)", () => {
    // The allowlists above are the ONLY paths that can be stored; /api/
    // appears in none of them. Pin the exact allowlists (previous test)
    // AND pin that no cacheable prefix/exact entry starts with /api.
    const prefixes = ["/_expo/static/", "/assets/", "/vendor/", "/icons/"];
    const exact = ["/", "/index.html", "/manifest.webmanifest"];
    for (const p of [...prefixes, ...exact]) {
      expect(p.startsWith("/api")).toBe(false);
    }
  });

  it("bypasses non-GET requests entirely (network only, never stored)", () => {
    expect(sw).toContain('request.method !== "GET"');
  });

  it("never touches Notification or push APIs (kid-safe: no permission prompts)", () => {
    // Code-level ban: no Notification API access, no permission prompt,
    // no push subscription surface anywhere in the worker. (The policy
    // header comment says as much; this pin enforces the code.)
    expect(
      /Notification\s*\.|requestPermission|showNotification|pushManager|pushSubscription/.test(sw),
    ).toBe(false);
  });

  it("precache list is static shell only (no API path, no cross-origin URL)", () => {
    const precache = [
      "/",
      "/manifest.webmanifest",
      "/vendor/sql-wasm.wasm",
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/icon-maskable-192.png",
      "/icons/icon-maskable-512.png",
    ];
    for (const path of precache) {
      expect(sw).toContain(`"${path}"`);
      expect(path.startsWith("/api")).toBe(false);
      expect(path.startsWith("http")).toBe(false);
    }
  });
});

describe("#71 service worker registration", () => {
  it("registers on web, production builds only, best-effort", () => {
    const layout = read("app/_layout.tsx");
    expect(layout).toContain('Platform.OS !== "web"');
    expect(layout).toContain("__DEV__");
    expect(layout).toContain('register("/sw.js")');
  });
});

describe("#71 PWA manifest + icons (basic per issue scope)", () => {
  const manifest = JSON.parse(read("public/manifest.webmanifest")) as {
    display: string;
    background_color: string;
    theme_color: string;
    icons: { src: string; sizes: string; purpose?: string }[];
  };

  it("declares standalone display and brand colors", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toBe("#58cc02");
    expect(manifest.background_color).toMatch(/^#/);
  });

  it("declares 192/512 icons, any + maskable", () => {
    const purposes = manifest.icons.map((i) => `${i.sizes}:${i.purpose ?? "any"}`).sort();
    expect(purposes).toEqual([
      "192x192:any",
      "192x192:maskable",
      "512x512:any",
      "512x512:maskable",
    ]);
  });

  it("ships every manifest icon file in public/ (export copies public/ verbatim)", () => {
    for (const icon of manifest.icons) {
      const p = join(mobileRoot, "public", icon.src.replace(/^\//, ""));
      expect(existsSync(p), `missing icon ${icon.src}`).toBe(true);
    }
  });
});

describe("#71 web shell template", () => {
  const html = read("public/index.html");

  it("links the manifest and declares the theme color", () => {
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('name="theme-color"');
  });

  it("carries the visible keyboard focus ring (keyboard parity, Decision 8)", () => {
    expect(html).toContain(":focus-visible");
  });

  it("records the dev-harness retirement (Decision 6)", () => {
    expect(html).toContain("RETIR");
  });
});

describe("#71 sql.js wasm vendor pin", () => {
  it("ships the wasm same-origin from public/vendor", () => {
    expect(existsSync(join(mobileRoot, "public", "vendor", "sql-wasm.wasm"))).toBe(true);
    const seam = read("src/platform/sqlite.web.ts");
    expect(seam).toContain("/vendor/");
    expect(seam).not.toMatch(/locateFile[^}]*https?:\/\//);
  });
});
