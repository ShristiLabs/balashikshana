import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Web-edition static server (issue #71).
 *
 * HISTORY: through M5 this served the single-HTML dev harness
 * (public/index.html) on :4200 as the D1 interaction reference. The
 * harness was RETIRED when the Expo web export reached parity (the real
 * app now runs in the browser); this server now serves the exported
 * web bundle from dist/ on the SAME ORIGIN+PORT, so CORS allowlists
 * (API dev default + docker-compose) keep working unchanged.
 *
 * Run: cd apps/mobile && npx expo export --platform web && npm run web
 * Serves: http://localhost:4200 (SPA fallback for expo-router paths)
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "dist");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function sendFile(res, filePath, status = 200) {
  const ext = path.extname(filePath).toLowerCase();
  // Immutable caching is scoped to CONTENT-HASHED filenames: new bytes
  // always ship under a new URL, so a year-long cache is safe. Every
  // STABLE filename (document shell, sw.js, manifest.webmanifest,
  // icons/, vendor/, favicon, metadata.json) MUST revalidate or a
  // deploy would leave clients cache-stale for a year (review loop 2).
  const immutable = isContentHashedAsset(filePath);
  res.writeHead(status, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  // Belt and braces for the never-throw listener: a stream error (file
  // unlinked between stat and open) with no 'error' listener would THROW
  // and kill the process like any other unhandled error — same class as
  // the parse guard above.
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

/**
 * Path-containment guard for dist/: the resolved path must BE dist or a
 * real child via path.sep. A bare startsWith(DIST_DIR) string prefix
 * would also accept SIBLING directories that share the name prefix
 * (e.g. dist-evil/) — the exact-match-OR-sep form rejects them.
 * Exported for unit tests (the listener below only starts when run as
 * main, so importing this module is side-effect-free).
 */
export function isInsideDist(resolvedPath) {
  return resolvedPath === DIST_DIR || resolvedPath.startsWith(DIST_DIR + path.sep);
}

/**
 * Cache immutability test: TRUE only for content-hashed build output.
 * Two accepted shapes (belt and braces):
 *  - `_expo/static/**` — Expo emits exclusively content-hashed names there
 *    (`entry-<hash>.js`, `index-<hash>.js`, ...).
 *  - a basename carrying a hash run: metro-copied assets embed the
 *    content hash in the filename (`name.<hash>.png`,
 *    `close-icon.<hash>@4x.png`, `sfx.<hash>.wav`).
 * Stable filenames (manifest.webmanifest, icons/*.png,
 * vendor/sql-wasm.wasm, favicon.ico, metadata.json, index.html, sw.js)
 * match neither shape and revalidate.
 * Exported for unit tests (side-effect-free import; see isInsideDist).
 */
const HASHED_BASENAME = /(?:^|[.\-_@])[0-9a-f]{16,}(?:[.@]|$)/;

export function isContentHashedAsset(filePath) {
  const rel = path.relative(DIST_DIR, filePath);
  const segments = rel.split(path.sep);
  if (segments[0] === "_expo" && segments[1] === "static") {
    return true;
  }
  return HASHED_BASENAME.test(path.basename(filePath));
}

const server = http.createServer((req, res) => {
  // Request parsing must be defensive END TO END: the URL constructor
  // throws on a malformed Host header (`Host: %` -> ERR_INVALID_URL)
  // just as decodeURIComponent throws on bad percent-encoding — either
  // throw would escape the listener and kill the 0.0.0.0-bound process
  // (one-shot remote crash; review loops 1+2). Any parse failure is a
  // 400, and the server keeps serving.
  let pathname;
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request");
    return;
  }

  // Never serve outside dist/.
  const resolved = path.resolve(DIST_DIR, `.${pathname}`);
  if (!isInsideDist(resolved)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  if (pathname !== "/" && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    sendFile(res, resolved);
    return;
  }

  // SPA fallback: expo-router owns the path space client-side.
  const shell = path.join(DIST_DIR, "index.html");
  if (fs.existsSync(shell)) {
    sendFile(res, shell);
    return;
  }

  res.writeHead(503, { "Content-Type": "text/plain" });
  res.end("Web export not built. Run: npx expo export --platform web");
});

const PORT = Number(process.env.PORT || 4200);
const runAsMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (runAsMain) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[Balashikshana web] serving ${DIST_DIR} on http://localhost:${PORT}`);
  });
}
