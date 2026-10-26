// Strict exposition-format validation (issue #66, tester pass): the
// rendered /metrics output is parsed by a STRICT validator — grammar,
// family grouping, escape round-trips, histogram coherence (monotone
// cumulative buckets, +Inf == count), and no duplicate series. A
// scraper must never see malformed text no matter what the registry
// holds.

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { createMetricsRegistry, enumLabel } from "../observability/metrics.mjs";

function unescapeLabelValue(v) {
  return v.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

// Strict parser for Prometheus text format 0.0.4. Throws on any
// grammar or coherence violation; returns families -> samples.
function parseStrict(text) {
  const families = new Map();
  let current = null;
  for (const rawLine of text.split("\n")) {
    if (rawLine === "") continue;
    if (rawLine.startsWith("# HELP ")) {
      const m = /^# HELP ([a-z][a-z0-9_]*) (.+)$/.exec(rawLine);
      assert.ok(m, `bad HELP line: ${rawLine}`);
      const [, name, help] = m;
      assert.ok(!families.has(name) || !families.get(name).help, `duplicate HELP for ${name}`);
      if (!families.has(name)) families.set(name, { name, help, type: null, samples: [] });
      families.get(name).help = help;
      current = name;
      continue;
    }
    if (rawLine.startsWith("# TYPE ")) {
      const m = /^# TYPE ([a-z][a-z0-9_]*) (counter|gauge|histogram)$/.exec(rawLine);
      assert.ok(m, `bad TYPE line: ${rawLine}`);
      const [, name, type] = m;
      const fam = families.get(name);
      assert.ok(fam, `TYPE for unknown family ${name}`);
      assert.equal(fam.type, null, `duplicate TYPE for ${name}`);
      fam.type = type;
      continue;
    }
    if (rawLine.startsWith("#")) assert.fail(`unknown comment line: ${rawLine}`);
    const m = /^([a-z][a-z0-9_]*)(\{(.*)\})? (-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|NaN)$/.exec(rawLine);
    assert.ok(m, `line does not match sample grammar: ${rawLine}`);
    const [, metric, , labelStr] = m;
    const value = Number(m[4]);
    const labels = {};
    if (labelStr !== undefined) {
      const parts = labelStr.split(",");
      for (const part of parts) {
        const lm = /^([a-z][a-z0-9_]*)="((?:[^"\\]|\\.)*)"$/.exec(part);
        assert.ok(lm, `bad label part "${part}" in: ${rawLine}`);
        assert.ok(!(lm[1] in labels), `duplicate label ${lm[1]} in: ${rawLine}`);
        labels[lm[1]] = unescapeLabelValue(lm[2]);
      }
    }
    const base = metric.replace(/_(bucket|sum|count)$/, "");
    const family = families.get(metric.endsWith("_bucket") || metric.endsWith("_sum") || metric.endsWith("_count") ? base : metric);
    assert.ok(family, `sample without preceding TYPE: ${rawLine}`);
    assert.ok(family.type !== null, `sample before TYPE declared: ${rawLine}`);
    family.samples.push({ metric, labels, value });
  }
  for (const fam of families.values()) {
    assert.ok(fam.type, `family ${fam.name} has TYPE`);
    const seen = new Set();
    for (const s of fam.samples) {
      const key = `${s.metric}|${JSON.stringify(s.labels)}`;
      assert.ok(!seen.has(key), `duplicate series: ${key}`);
      seen.add(key);
    }
  }
  return families;
}

describe("strict exposition validation", () => {
  test("grammar, HELP/TYPE grouping, and escapes hold for a populated registry", () => {
    const r = createMetricsRegistry();
    const esc = r.counter("esc_total", 'help with "quotes" and \\ backslash', {
      tag: enumLabel(['weird"value', "back\\slash", "plain"], "plain")
    });
    esc.inc({ tag: 'weird"value' });
    esc.inc({ tag: "back\\slash" }, 2);
    const g = r.gauge("level_gauge", "a level", { zone: enumLabel(["a", "b"], "a") });
    g.set({ zone: "a" }, 7);
    g.set({ zone: "b" }, 0.5);
    const h = r.histogram("dur_seconds", "duration", { side: enumLabel(["x", "y"], "x") }, [0.1, 0.5, 1]);
    h.observe({ side: "x" }, 0.05);
    h.observe({ side: "x" }, 0.3);
    h.observe({ side: "x" }, 2); // +Inf
    h.observe({ side: "y" }, 0.7);
    // Also generate rejections so the rejected-gauge family renders.
    h.observe({ side: "INJECTED-EVIL" }, 1); // invalid enum -> rejected

    const fams = parseStrict(r.render());

    assert.ok(fams.get("esc_total"));
    assert.ok(fams.get("level_gauge"));
    assert.ok(fams.get("dur_seconds"));
    assert.ok(fams.get("metrics_observations_rejected_total"));

    // Escape round-trip: the weird values parse back EXACTLY.
    const escSamples = fams.get("esc_total").samples;
    assert.deepEqual(
      escSamples.map((s) => s.labels.tag).sort(),
      ["back\\slash", 'weird"value']
    );

    // Histogram coherence for side="x".
    const fam = fams.get("dur_seconds");
    const bucketLines = fam.samples
      .filter((s) => s.metric === "dur_seconds_bucket" && s.labels.side === "x")
      .sort((a, b) => Number(a.labels.le === "+Inf" ? Infinity : a.labels.le) - Number(b.labels.le === "+Inf" ? Infinity : b.labels.le));
    assert.equal(bucketLines.length, 4); // 3 finite + +Inf
    let prev = -1;
    for (const s of bucketLines) {
      assert.ok(s.value >= prev, `cumulative bucket decreased: ${JSON.stringify(s)}`);
      prev = s.value;
    }
    const inf = bucketLines.find((s) => s.labels.le === "+Inf");
    const count = fam.samples.find((s) => s.metric === "dur_seconds_count" && s.labels.side === "x");
    assert.equal(inf.value, count.value);
    assert.equal(count.value, 3);
    const sum = fam.samples.find((s) => s.metric === "dur_seconds_sum" && s.labels.side === "x");
    assert.ok(Math.abs(sum.value - 2.35) < 1e-12);
  });

  test("histogram families are never emitted as empty (only unlabeled scalars get the zero-row)", () => {
    const r = createMetricsRegistry();
    r.histogram("never_observed", "h", { k: enumLabel(["a"], "a") }, [1, 2]);
    const fams = parseStrict(r.render());
    assert.equal(fams.get("never_observed").samples.length, 0);
    const scalar = r.gauge("plain_gauge", "g", {});
    scalar.set({}, 0);
    const text = r.render();
    assert.match(text, /^plain_gauge 0$/m);
  });

  test("the rejected-observations gauge renders per-metric rows only for actual rejections", () => {
    const r = createMetricsRegistry();
    const clean = r.counter("clean_total", "h", {});
    clean.inc({}, 1);
    let text = r.render();
    assert.match(text, /^metrics_observations_rejected_total\{metric="none"\} 0$/m);
    const dirty = r.counter("dirty_total", "h", { k: enumLabel(["ok"], "ok") });
    dirty.inc({ k: "nope" });
    dirty.inc({ k: "nope" });
    text = r.render();
    assert.match(text, /^metrics_observations_rejected_total\{metric="dirty_total"\} 2$/m);
    parseStrict(text); // still fully valid
  });
});
