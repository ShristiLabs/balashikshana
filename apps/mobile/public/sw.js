/*
 * Balashikshana service worker (issue #71).
 *
 * POLICY (binding; test-pinned by tests/web-pwa.test.ts):
 * 1. APP SHELL ONLY. The ONLY responses ever stored are same-origin,
 *    GET, static-build assets: the document shell, /_expo/static/**
 *    (hash-named immutable bundles), /assets/** (bundled media),
 *    /vendor/** (sql.js wasm), /icons/** and the manifest.
 * 2. NEVER CACHE API RESPONSES. Anything else — /api/**, the API base
 *    origin, any cross-origin request, any non-GET — bypasses this
 *    worker's storage entirely and goes straight to the network.
 *    Child data must never live in the SW cache (COPPA + correctness:
 *    a cached progress/API response could replay stale state).
 * 3. NO PUSH, NO NOTIFICATIONS. This worker never asks for permissions
 *    and never touches the Notification API (kid-safe doctrine).
 *
 * Strategies: navigations are network-first (fresh shell while online;
 * cached shell when offline). Hash-named static assets are cache-first
 * (immutable by construction). Everything else: network only.
 */
const CACHE_NAME = "balashikshana-shell-v1";

const SHELL_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/vendor/sql-wasm.wasm",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
];

const CACHEABLE_PREFIXES = ["/_expo/static/", "/assets/", "/vendor/", "/icons/"];
const CACHEABLE_EXACT = new Set(["/", "/index.html", "/manifest.webmanifest"]);

function isCacheableStatic(url) {
  if (url.origin !== self.location.origin) return false;
  return CACHEABLE_EXACT.has(url.pathname) || CACHEABLE_PREFIXES.some((p) => url.pathname.startsWith(p));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Best-effort precache: one missing optional asset must not block
      // installation; the fetch handler backfills opportunistically.
      await Promise.allSettled(SHELL_ASSETS.map((path) => cache.add(path)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // network only, never stored

  const url = new URL(request.url);
  if (!isCacheableStatic(url)) return; // API + cross-origin: bypass entirely

  if (request.mode === "navigate") {
    // Network-first for the document: a deploy is picked up on the next
    // online visit; the cached shell serves when offline.
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh && fresh.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put("/", fresh.clone());
          }
          return fresh;
        } catch {
          const cache = await caches.open(CACHE_NAME);
          return (
            (await cache.match(request)) ||
            (await cache.match("/")) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  // Static assets: cache-first (hash-named = immutable).
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response && response.ok && response.type === "basic") {
        await cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
