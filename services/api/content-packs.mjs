/**
 * Content-pack manifest + artifact hosting (issue #46).
 *
 * Serves the compiler output (services/api/content-packs by default;
 * BALASHIKSHANA_CONTENT_PACKS_DIR overrides) as two read-only routes:
 *
 *   GET /api/content/packs            manifest index (index.json document)
 *   GET /api/content/packs/:gradeId   signed pack artifact (octet-stream)
 *
 * The server deliberately does NOT verify signatures — verification is the
 * DEVICE's fail-closed job (apps/mobile/src/content). The server only
 * guards its own consistency: an index entry whose artifact name is not
 * canonically formed, whose artifact is missing, or whose on-disk size
 * drifted from the manifest is a build/publish error and yields 503
 * problem+json rather than serving suspect bytes.
 *
 * #61 parent grade ceiling — OPTIONAL child bearer: when the caller
 * presents a valid student/child-device token, the parent's grade
 * ceiling is enforced (index filtered; an above-ceiling artifact is a
 * 403 problem). Anonymous callers are byte-identical to before: packs
 * are public artifacts (the device verifies signatures), and parental
 * controls gate the child's authenticated experience — subject
 * restrictions live INSIDE signed packs and cannot be carved out
 * server-side; they gate question-serving instead (server.mjs).
 */
import fs from "node:fs";
import path from "node:path";
import fp from "fastify-plugin";
import { resolveOptionalStudentId, loadChildSettings, filterPackIndexForChild, GRADE_ORDER } from "./enforcement.mjs";

const GRADE_ID_RE = /^[a-z0-9-]+$/;
const CONTENT_VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Canonical artifact-name guard (defense against a hand-edited or corrupt
 * server-side index.json).
 *
 * tools/content-pipeline/src/constants.mjs `packArtifactName(gradeId,
 * contentVersion)` is the single source of truth for the naming contract
 * `pack-<gradeId>-v<contentVersion>.sqlite`. The exact-equality check
 * below mirrors that contract instead of importing the dev-toolchain
 * workspace into the API's runtime dependency graph. Exact equality —
 * rather than a permissive regex on the artifact string alone — rejects
 * path traversal (`../`), absolute paths, nested directories, and index
 * self-inconsistency (a filename disagreeing with the entry's own
 * gradeId/contentVersion) in a single fail-closed check.
 */
function canonicalArtifactName(entry) {
  return (
    typeof entry.gradeId === "string" &&
    typeof entry.contentVersion === "string" &&
    typeof entry.artifact === "string" &&
    GRADE_ID_RE.test(entry.gradeId) &&
    CONTENT_VERSION_RE.test(entry.contentVersion) &&
    entry.artifact === `pack-${entry.gradeId}-v${entry.contentVersion}.sqlite`
  );
}

export const contentPacksPlugin = fp(async (app, options) => {
  const packsDir = path.resolve(String(options.packsDir));
  const logger = options.logger ?? app.log;
  const db = options.db; // optional (tests may register without it)

  function readIndex() {
    const indexPath = path.join(packsDir, "index.json");
    if (!fs.existsSync(indexPath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      if (!parsed || !Array.isArray(parsed.packs)) return null;
      return parsed;
    } catch (err) {
      logger.warn({ err: err?.message }, "content-pack index unreadable");
      return null;
    }
  }

  function findEntry(index, gradeId) {
    return index.packs.find((p) => p && p.gradeId === gradeId) ?? null;
  }

  app.get("/api/content/packs", async (req, reply) => {
    const index = readIndex();
    if (!index) {
      return reply.code(503).send({
        title: "Content packs unavailable",
        status: 503,
        detail:
          "No compiled content-pack index is published on this server. Run the content-pipeline build (tools/content-pipeline) and restart.",
        type: `${options.problemTypeBase ?? "https://balashikshana.dev/problems"}/content-packs-unavailable`,
      });
    }
    let packs = index.packs;
    if (db) {
      const studentId = await resolveOptionalStudentId(db, req.headers.authorization);
      if (studentId) {
        const settings = await loadChildSettings(db, studentId);
        packs = filterPackIndexForChild(packs, settings);
      }
    }
    return reply
      .header("cache-control", "public, max-age=300")
      .send({ formatVersion: index.formatVersion, registryVersion: index.registryVersion, packs });
  });

  app.get("/api/content/packs/:gradeId", async (req, reply) => {
    const { gradeId } = req.params;
    if (typeof gradeId !== "string" || !GRADE_ID_RE.test(gradeId)) {
      return reply.code(404).send({
        title: "Not Found",
        status: 404,
        detail: `Unknown grade "${String(gradeId)}".`,
      });
    }
    const index = readIndex();
    if (!index) {
      return reply.code(503).send({
        title: "Content packs unavailable",
        status: 503,
        detail: "No compiled content-pack index is published on this server.",
        type: `${options.problemTypeBase ?? "https://balashikshana.dev/problems"}/content-packs-unavailable`,
      });
    }
    const entry = findEntry(index, gradeId);
    if (!entry) {
      return reply.code(404).send({
        title: "Not Found",
        status: 404,
        detail: `No content pack is published for grade "${gradeId}".`,
      });
    }
    // #61 grade ceiling for child callers (optional bearer; anonymous
    // behavior unchanged).
    if (db) {
      const studentId = await resolveOptionalStudentId(db, req.headers.authorization);
      if (studentId) {
        const settings = await loadChildSettings(db, studentId);
        if (
          settings.gradeCeiling != null &&
          GRADE_ORDER.indexOf(settings.gradeCeiling) >= 0 &&
          GRADE_ORDER.indexOf(gradeId) > GRADE_ORDER.indexOf(settings.gradeCeiling)
        ) {
          return reply.code(403).send({
            title: "Content restricted",
            status: 403,
            detail: `Grade "${gradeId}" is above the parent-configured grade ceiling for this child.`,
            type: `${options.problemTypeBase ?? "https://balashikshana.dev/problems"}/content-restricted`,
          });
        }
      }
    }
    if (!canonicalArtifactName(entry)) {
      return reply.code(503).send({
        title: "Content pack index invalid",
        status: 503,
        detail: `The published index references artifact "${String(entry.artifact).slice(0, 100)}" for grade "${gradeId}", which does not match the compiler's canonical artifact naming. Rebuild content packs.`,
        type: `${options.problemTypeBase ?? "https://balashikshana.dev/problems"}/content-pack-artifact-invalid`,
      });
    }
    const packsRoot = path.resolve(packsDir);
    const artifactPath = path.resolve(packsRoot, entry.artifact);
    // Canonical names contain no path separators, so resolution stays
    // inside packsDir by construction; this containment assertion is
    // defense-in-depth in case the naming contract ever changes.
    if (!artifactPath.startsWith(packsRoot + path.sep)) {
      return reply.code(503).send({
        title: "Content pack index invalid",
        status: 503,
        detail: `The published index references artifact "${String(entry.artifact).slice(0, 100)}" outside the packs directory. Rebuild content packs.`,
        type: `${options.problemTypeBase ?? "https://balashikshana.dev/problems"}/content-pack-artifact-invalid`,
      });
    }
    let stat;
    try {
      stat = fs.statSync(artifactPath);
    } catch {
      return reply.code(503).send({
        title: "Content pack artifact missing",
        status: 503,
        detail: `The published index references "${entry.artifact}" but the file is absent. Rebuild content packs.`,
        type: `${options.problemTypeBase ?? "https://balashikshana.dev/problems"}/content-pack-artifact-missing`,
      });
    }
    if (!stat.isFile() || stat.size !== entry.sizeBytes) {
      return reply.code(503).send({
        title: "Content pack artifact inconsistent",
        status: 503,
        detail: `Artifact "${entry.artifact}" size ${stat.size} does not match the manifest (${entry.sizeBytes}). Rebuild content packs.`,
        type: `${options.problemTypeBase ?? "https://balashikshana.dev/problems"}/content-pack-artifact-inconsistent`,
      });
    }
    const stream = fs.createReadStream(artifactPath);
    return reply
      .code(200)
      .header("content-type", "application/octet-stream")
      .header("content-length", String(stat.size))
      .header("etag", `"${entry.sha256}"`)
      .header("cache-control", "public, max-age=3600, immutable")
      .send(stream);
  });
});
