/**
 * #71 web-export static server (server.mjs) — behavioral tests against
 * the REAL server process, the way the profile gate runs it
 * (`npm run web`). Covers the behaviors the harness-to-web-export
 * repurpose introduced: SPA fallback for expo-router paths, the
 * cache-header split scoped to content-hashed filenames (immutable
 * only where the hash lives in the name; shell, sw.js, manifest,
 * icons, and vendor wasm revalidate), PWA-surface MIME types, the
 * path-traversal guard (incl. the planted sibling-directory probe),
 * and request-parse survival as a CLASS (malformed percent-encoding
 * AND malformed Host header both answer 4xx without killing the
 * 0.0.0.0-bound process).
 *
 * Requires apps/mobile/dist (the web export; gitignored) — the suite
 * SKIPS with a notice when absent so plain `vitest run` (CI) stays
 * green; the local regression gate runs after `npx expo export
 * --platform web` and gets full coverage (web-export-scan precedent).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const mobileRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = join(mobileRoot, "dist");
const hasDist = existsSync(join(distRoot, "index.html"));

/**
 * Depth-first search for the first file under `dir` (recursively) whose
 * name satisfies `match` — returns the URL path relative to dist/, or
 * null. Used to pin cache headers against REAL export output without
 * hard-coding build hashes.
 */
function firstFileUnder(dir: string, match: (name: string) => boolean): string | null {
  if (!existsSync(dir)) {
    return null;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = firstFileUnder(full, match);
      if (found) {
        return found;
      }
    } else if (match(entry.name)) {
      return "/" + relative(distRoot, full).split(sep).join("/");
    }
  }
  return null;
}

/** Reserve a free TCP port (bind :0, read the port, release). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    // node's http client does NOT normalize dot-segments (fetch does),
    // so this reaches the server with the raw path — a real traversal
    // probe. An explicit `headers.host` overrides the computed Host
    // header, which is how the malformed-Host probe reaches the server.
    const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe.skipIf(!hasDist)("#71 web-export static server (server.mjs)", () => {
  let port = 0;
  let child: ReturnType<typeof spawn>;
  // Planted sibling of dist/ sharing its name prefix — the probe payload
  // for the traversal-guard test (a bare startsWith(DIST_DIR) would
  // serve it; the sep-aware guard must 403 it).
  const siblingDir = join(mobileRoot, "dist-sibling-probe");
  const siblingFile = join(siblingDir, "secret.txt");

  beforeAll(async () => {
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(siblingFile, "sibling secret\n");
    port = await freePort();
    child = spawn(process.execPath, [join(mobileRoot, "server.mjs")], {
      env: { ...process.env, PORT: String(port) },
      stdio: "ignore",
    });
    // Wait for the listener (bounded retries, no arbitrary sleep).
    for (let i = 0; i < 50; i += 1) {
      try {
        await rawRequest(port, "/");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("server.mjs did not start listening");
  }, 15_000);

  afterAll(() => {
    child?.kill();
    rmSync(siblingDir, { recursive: true, force: true });
  });

  it("serves the document shell at / with no-cache (deploys are picked up)", async () => {
    const res = await rawRequest(port, "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body.toString("utf8")).toContain("<!doctype html>");
  });

  it("falls back to the shell for expo-router SPA paths", async () => {
    const res = await rawRequest(port, "/journey");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body.toString("utf8")).toContain("<!doctype html>");
  });

  it("serves content-hashed build assets immutable with correct MIME", async () => {
    // Immutable caching is scoped to CONTENT-HASHED filenames (the hash
    // lives in the name, so new bytes always mean a new URL). Real
    // export files are enumerated at test time so the pins survive
    // rebuilds that change the hashes.
    const jsPath = firstFileUnder(join(distRoot, "_expo", "static", "js", "web"), (n) =>
      n.endsWith(".js"),
    );
    expect(jsPath).toBeTruthy();
    const js = await rawRequest(port, jsPath!);
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toContain("application/javascript");
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const pngPath = firstFileUnder(join(distRoot, "assets"), (n) => n.endsWith(".png"));
    expect(pngPath).toBeTruthy();
    const png = await rawRequest(port, pngPath!);
    expect(png.status).toBe(200);
    expect(png.headers["content-type"]).toContain("image/png");
    expect(png.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("revalidates mutable-named files: sw.js, manifest, icons, vendor wasm", async () => {
    // Stable filenames can carry new bytes on a deploy (manifest edits,
    // regenerated icons, updated sql-wasm). An immutable year-long
    // cache on them would pin stale content (review loop 2, LOW).
    const sw = await rawRequest(port, "/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers["content-type"]).toContain("application/javascript");
    // An immutable sw.js would pin the installed worker for a year and
    // delay every update; it MUST revalidate like the shell.
    expect(sw.headers["cache-control"]).toBe("no-cache");

    const manifest = await rawRequest(port, "/manifest.webmanifest");
    expect(manifest.status).toBe(200);
    expect(manifest.headers["content-type"]).toContain("application/manifest+json");
    expect(manifest.headers["cache-control"]).toBe("no-cache");

    const icon = await rawRequest(port, "/icons/icon-192.png");
    expect(icon.status).toBe(200);
    expect(icon.headers["content-type"]).toBe("image/png");
    expect(icon.headers["cache-control"]).toBe("no-cache");

    const wasm = await rawRequest(port, "/vendor/sql-wasm.wasm");
    expect(wasm.status).toBe(200);
    expect(wasm.headers["content-type"]).toBe("application/wasm");
    expect(wasm.headers["cache-control"]).toBe("no-cache");
  });

  it("refuses to serve files outside dist/ (path traversal guard)", async () => {
    const res = await rawRequest(port, "/../package.json");
    // The guard 403s before the SPA fallback can masquerade as success:
    // package.json exists one level above dist, so a 200 here would be
    // the file itself leaking (its body would contain "expo-doctor"-free
    // app config, not the HTML shell).
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      // SPA fallback is acceptable ONLY if it served the shell, never
      // the outside file's contents.
      expect(res.body.toString("utf8")).toContain("<!doctype html>");
    }
  });

  it("never serves sibling-directory files that share the dist prefix", async () => {
    // dist-sibling-probe/ was planted NEXT TO dist with a real file.
    // The WHATWG URL parser folds literal (and %2e-encoded) dot
    // segments, so this request normalizes to an in-dist path and lands
    // on the SPA fallback — the behavioral property under test is that
    // the sibling file's CONTENTS are never served; the guard's
    // sep-aware semantics are unit-pinned below (isInsideDist).
    const res = await rawRequest(port, "/../dist-sibling-probe/secret.txt");
    expect([200, 403]).toContain(res.status);
    expect(res.body.toString("utf8")).not.toContain("sibling secret");
    if (res.status === 200) {
      expect(res.body.toString("utf8")).toContain("<!doctype html>");
    }
  });

  it("survives malformed percent-encoding: 400, and the server keeps serving", async () => {
    // GET /% makes decodeURIComponent throw URIError; an unguarded
    // decode kills the 0.0.0.0-bound process (review finding). The
    // answer must be a 4xx AND the listener must stay alive.
    const bad = await rawRequest(port, "/%");
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    const next = await rawRequest(port, "/");
    expect(next.status).toBe(200);
    expect(next.body.toString("utf8")).toContain("<!doctype html>");
  });

  it("survives a malformed Host header: 400, and the server keeps serving", async () => {
    // `Host: %` makes the URL constructor throw ERR_INVALID_URL — before
    // the fix the constructor sat OUTSIDE the try/catch, so the throw
    // escaped the listener and the process DIED (one-shot remote crash
    // on a 0.0.0.0-bound server; review loop 2, HIGH). Any request-parse
    // failure must be a 4xx, never a process death.
    const bad = await rawRequest(port, "/", { host: "%" });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    const next = await rawRequest(port, "/");
    expect(next.status).toBe(200);
    expect(next.body.toString("utf8")).toContain("<!doctype html>");
  });

  it("pins the malformed-request CLASS: bad path AND bad Host both 4xx, listener alive", async () => {
    // The class, not one input: EVERY parse failure on the request line
    // (bad percent-encoding, bad Host, ...) is answered 4xx in sequence
    // and the same listener keeps serving afterwards.
    const badPath = await rawRequest(port, "/%");
    expect(badPath.status).toBeGreaterThanOrEqual(400);
    expect(badPath.status).toBeLessThan(500);
    const badHost = await rawRequest(port, "/journey", { host: "%" });
    expect(badHost.status).toBeGreaterThanOrEqual(400);
    expect(badHost.status).toBeLessThan(500);
    const fine = await rawRequest(port, "/journey");
    expect(fine.status).toBe(200);
    expect(fine.body.toString("utf8")).toContain("<!doctype html>");
  });
});

if (!hasDist) {
  console.warn(
    "[web-server] dist/ absent — run `npx expo export --platform web` to enable the static-server tests",
  );
}

// Guard unit tests run regardless of dist/ presence (importing
// server.mjs is side-effect-free: the listener only starts when the
// file is run as main).
describe("#71 isInsideDist path-containment guard (server.mjs)", () => {
  it("accepts dist itself and real children via path.sep", async () => {
    const { isInsideDist } = await import("../server.mjs");
    expect(isInsideDist(join(mobileRoot, "dist"))).toBe(true);
    expect(isInsideDist(join(mobileRoot, "dist", "sw.js"))).toBe(true);
    expect(isInsideDist(join(mobileRoot, "dist", "_expo", "static", "chunk.js"))).toBe(true);
  });

  it("rejects siblings that merely share the dist name prefix", async () => {
    const { isInsideDist } = await import("../server.mjs");
    // The exact counterexample a bare startsWith(DIST_DIR) accepts:
    expect(isInsideDist(join(mobileRoot, "dist-sibling-probe", "secret.txt"))).toBe(false);
    expect(isInsideDist(join(mobileRoot, "dist-server"))).toBe(false);
    // Outside entirely:
    expect(isInsideDist(join(mobileRoot, "package.json"))).toBe(false);
    expect(isInsideDist(join(mobileRoot))).toBe(false);
  });
});

// Cache-scoping guard unit tests run regardless of dist/ presence
// (importing server.mjs is side-effect-free). These pin the CLASS of
// content-hashed names, not one filename.
describe("#71 isContentHashedAsset cache-scoping guard (server.mjs)", () => {
  it("accepts Expo static output and metro hash-embedded asset names", async () => {
    const { isContentHashedAsset } = await import("../server.mjs");
    // _expo/static/** is hashed by construction (Expo build output):
    expect(
      isContentHashedAsset(
        join(
          mobileRoot,
          "dist",
          "_expo",
          "static",
          "js",
          "web",
          "entry-91f6372e7fa3e77af6f65613eb719b8c.js",
        ),
      ),
    ).toBe(true);
    // Metro-copied assets embed the content hash in the filename:
    expect(
      isContentHashedAsset(
        join(
          mobileRoot,
          "dist",
          "assets",
          "node_modules",
          "x",
          "close-icon.808e1b1b9b53114ec2838071a7e6daa7@4x.png",
        ),
      ),
    ).toBe(true);
    expect(
      isContentHashedAsset(
        join(
          mobileRoot,
          "dist",
          "assets",
          "__assets",
          "sounds",
          "sfx_star_fanfare.6ca6e1b5c90ece9df4edbf30eb44fd58.wav",
        ),
      ),
    ).toBe(true);
  });

  it("rejects stable filenames — mutable-named files must revalidate", async () => {
    const { isContentHashedAsset } = await import("../server.mjs");
    // Short numeric suffixes are sizes, not hashes:
    expect(isContentHashedAsset(join(mobileRoot, "dist", "icons", "icon-192.png"))).toBe(false);
    expect(isContentHashedAsset(join(mobileRoot, "dist", "icons", "icon-maskable-512.png"))).toBe(
      false,
    );
    // Deployable stable names (review loop 2, LOW):
    expect(isContentHashedAsset(join(mobileRoot, "dist", "manifest.webmanifest"))).toBe(false);
    expect(isContentHashedAsset(join(mobileRoot, "dist", "vendor", "sql-wasm.wasm"))).toBe(false);
    expect(isContentHashedAsset(join(mobileRoot, "dist", "favicon.ico"))).toBe(false);
    expect(isContentHashedAsset(join(mobileRoot, "dist", "metadata.json"))).toBe(false);
    // The shell and worker always revalidate:
    expect(isContentHashedAsset(join(mobileRoot, "dist", "index.html"))).toBe(false);
    expect(isContentHashedAsset(join(mobileRoot, "dist", "sw.js"))).toBe(false);
  });
});
