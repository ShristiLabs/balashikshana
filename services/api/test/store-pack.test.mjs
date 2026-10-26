// Store-pack traceability structural test (issue #69): the chain of
// custody "form answer -> inventory claim -> code evidence" is enforced,
// not aspirational. If docs/store/data-safety-traceability.md references
// a data class that does not exist in docs/data-flow-inventory.md, drops
// a required section, or files a Play "collected" data-type row without
// inventory + code evidence, CI fails — the forms cannot silently drift
// from reality (the #69 core risk).

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(__dirname, "../../../docs");

const matrix = readFileSync(path.join(DOCS, "store/data-safety-traceability.md"), "utf8");
const inventory = readFileSync(path.join(DOCS, "data-flow-inventory.md"), "utf8");
const storeReadme = readFileSync(path.join(DOCS, "store/README.md"), "utf8");

// Inventory table rows look like "| 12 | Parent-child bindings | ...".
const inventoryRows = new Set(
  (inventory.match(/^\| (\d+) \|/gm) || []).map((line) => Number(line.match(/^\| (\d+) \|/)[1]))
);

describe("data-flow inventory sanity", () => {
  test("the inventory carries its 21 classes (the #68 baseline)", () => {
    assert.equal(inventoryRows.size >= 21, true, `expected >= 21 inventory rows, found ${[...inventoryRows].join(",")}`);
  });
});

describe("store traceability matrix structure", () => {
  const REQUIRED_SECTIONS = [
    "## Google Play Data Safety — Data collected",
    "## Google Play Data Safety — Data shared",
    "## Google Play Data Safety — Security practices",
    "## Apple Privacy Nutrition Labels (Kids Category)"
  ];

  for (const section of REQUIRED_SECTIONS) {
    test(`section present: ${section}`, () => {
      assert.ok(matrix.includes(section), "required matrix section missing");
    });
  }

  test("every INV:n reference points at a real inventory row", () => {
    const refs = [...matrix.matchAll(/INV:(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(refs.length >= 10, `expected the matrix to cite the inventory, found ${refs.length} refs`);
    const dangling = [...new Set(refs)].filter((n) => !inventoryRows.has(n));
    assert.deepEqual(dangling, [], "matrix cites nonexistent inventory rows");
  });

  test("every Play collected-type table row carries inventory + code evidence", () => {
    const section = matrix.split("## Google Play Data Safety — Data collected")[1].split("## Google Play")[0];
    const dataRows = section
      .split("\n")
      .filter((l) => l.startsWith("|"))
      // header + separator rows
      .filter((l) => !/^\|\s*(Play data type|---)/.test(l));
    assert.ok(dataRows.length >= 6, "expected the collected-type table to have rows");
    for (const row of dataRows) {
      const cells = row.split("|").map((c) => c.trim());
      // cells: ['', type, answer, inventory, evidence, '']
      const [type, answer, invCell, evidence] = [cells[1], cells[2], cells[3], cells[4]];
      if (/NOT collected|not collected/i.test(answer)) {
        // negative rows must still cite the absence basis
        assert.ok(invCell.length > 0 || evidence.length > 0, `row "${type}" (not collected) must cite its basis`);
        continue;
      }
      assert.match(invCell, /INV:\d+/, `row "${type}" must cite inventory rows`);
      assert.ok(evidence.length > 5, `row "${type}" must cite code evidence`);
    }
  });

  test("the sharing section keeps its service-provider analysis + user-side re-verification note", () => {
    const section = matrix.split("## Google Play Data Safety — Data shared")[1].split("## Google Play")[0];
    assert.match(section, /service provider/i, "SMTP service-provider basis documented");
    assert.match(section, /User-side verification/i, "console-definition re-verification pinned");
  });
});

describe("store pack presence", () => {
  const FILES = [
    "store/README.md",
    "store/apple-app-store.md",
    "store/google-play.md",
    "store/age-ratings.md",
    "store/review-notes.md",
    "store/data-safety-traceability.md"
  ];
  for (const f of FILES) {
    test(`${f} exists`, () => {
      readFileSync(path.join(DOCS, f));
    });
  }

  test("the pack marks console filing + screenshots + accounts as user-side", () => {
    assert.match(storeReadme, /USER-SIDE/);
    assert.match(storeReadme, /checklist/i);
  });
});

describe("MAIL_CAPTURE_FILE deployment hygiene", () => {
  // The capture transport writes delivered auth codes to disk — it exists
  // for tests/debug only. Guard the guard: no deployment environment file
  // may ever reference it (the loud-boot-warning + store checklist cover
  // the operational side).
  test("no infra/deploy file mentions MAIL_CAPTURE_FILE", () => {
    const roots = [path.join(DOCS, "..", "infra"), path.join(DOCS, "..", "deploy")];
    for (const root of roots) {
      walk(root, (file, text) => {
        assert.equal(
          text.includes("MAIL_CAPTURE_FILE"),
          false,
          `${file} references the test-only mail capture transport`
        );
      });
    }
  });
});

function walk(dir, visit, filterExt = /\.(tf|tfvars|ya?ml|env|sh|json|md)$/) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, visit, filterExt);
    } else if (filterExt.test(entry)) {
      visit(full, readFileSync(full, "utf8"));
    }
  }
}
