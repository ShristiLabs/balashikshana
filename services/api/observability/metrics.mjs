// First-party metrics registry (issue #66, D5: observability is
// first-party only — no third-party telemetry SDK anywhere).
//
// Zero-dependency by design: counter/gauge/histogram primitives with a
// Prometheus text-exposition renderer, hand-rolled (~this file) instead
// of pulling prom-client or the OpenTelemetry SDK. The origin API is
// otherwise dependency-light (node:http -> Fastify + pino); the full
// OTel SDK would add a large transitive surface to buy what ~200 lines
// of pure code provide for this metric set (see docs/observability.md
// for the recorded decision and the upgrade path).
//
// CARDINALITY IS A SECURITY PROPERTY here (DoS via label explosion is
// the classic unbounded-metrics attack): every label declares a
// validator (enum or regex + length cap), every metric a hard max-series
// cap. An observation whose label values fail validation — or that
// would create a series past the cap — is REJECTED, never recorded, and
// counted on the exported `metrics_observations_rejected_total` gauge.
// The registry never throws at observe time: telemetry must never take
// the request path down.

const MAX_LABEL_VALUE_LENGTH = 64;
// 512 series per metric: the HTTP vocabulary is ~41 route classes x
// ~2 methods x ~4 observed status classes (~330 realistic worst case)
// — the cap leaves headroom for route growth while keeping a hostile
// or buggy label explosion memory-bounded (overflow is REJECTED and
// counted on metrics_observations_rejected_total, never allocated).
const DEFAULT_MAX_SERIES = 512;

// Prometheus text format float rendering: keep it deterministic and
// round-trip safe without exponent noise. 12 significant digits is far
// beyond counter/latency precision needs and avoids the
// 0.30000000000000004 artifact class in exposition output.
function formatValue(value) {
  if (!Number.isFinite(value)) return "NaN";
  if (Number.isInteger(value)) return String(value);
  const trimmed = Number(value.toPrecision(12));
  return String(trimmed);
}

function escapeLabelValue(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function escapeHelp(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function canonicalKey(labelValues) {
  // Deterministic series identity: label names in declared order.
  return Object.keys(labelValues)
    .map((k) => `${k}=${labelValues[k]}`)
    .join("|");
}

export function enumLabel(values, fallback) {
  const set = new Set(values);
  return {
    validate: (v) => set.has(v),
    fallback
  };
}

export function regexLabel(pattern, fallback) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  return {
    validate: (v) =>
      typeof v === "string" &&
      v.length <= MAX_LABEL_VALUE_LENGTH &&
      re.test(v) &&
      !/[\\"\n\r]/.test(v),
    fallback
  };
}

function validateLabels(spec, labelValues) {
  const out = {};
  for (const [name, def] of Object.entries(spec)) {
    const value = labelValues[name];
    if (value === undefined) {
      if (!def.fallback) return null;
      out[name] = def.fallback;
    } else if (!def.validate(value)) {
      return null;
    } else {
      out[name] = value;
    }
  }
  return out;
}

function validateObservationValue(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function createMetricsRegistry({ maxSeries = DEFAULT_MAX_SERIES } = {}) {
  // name -> { type, help, labels: spec, series: Map(key -> data), buckets? }
  const metrics = new Map();
  // Rejected observations per metric name (the cardinality-guard signal
  // exposed as its own gauge — bounded by metric count, not series).
  const rejected = new Map();
  const rejectedGaugeName = "metrics_observations_rejected_total";

  function countRejection(name) {
    rejected.set(name, (rejected.get(name) || 0) + 1);
  }

  function declare({ name, type, help, labels = {}, buckets = null }) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw new Error(`invalid metric name: ${name}`);
    }
    if (metrics.has(name)) {
      throw new Error(`metric already declared: ${name}`);
    }
    if (type === "histogram") {
      if (!Array.isArray(buckets) || buckets.length === 0) {
        throw new Error(`histogram ${name} requires explicit finite buckets`);
      }
      const finite = [...buckets].sort((a, b) => a - b);
      if (finite.some((b) => !Number.isFinite(b) || b <= 0)) {
        throw new Error(`histogram ${name} buckets must be positive finite numbers`);
      }
      buckets = finite;
    }
    const metric = { name, type, help, labels, buckets, series: new Map() };
    metrics.set(name, metric);
    return metric;
  }

  function seriesFor(metric, labelValues) {
    const validated = validateLabels(metric.labels, labelValues || {});
    if (!validated) {
      countRejection(metric.name);
      return null;
    }
    const key = canonicalKey(validated);
    let series = metric.series.get(key);
    if (!series) {
      if (metric.series.size >= maxSeries) {
        // Hard memory bound: no series past the cap, ever.
        countRejection(metric.name);
        return null;
      }
      series = freshSeries(metric);
      series.labelValues = validated;
      metric.series.set(key, series);
    }
    return series;
  }

  function freshSeries(metric) {
    if (metric.type === "histogram") {
      return {
        bucketCounts: new Array(metric.buckets.length + 1).fill(0), // +Inf last
        sum: 0,
        count: 0
      };
    }
    return { value: 0 };
  }

  function counter(name, help, labels = {}) {
    const metric = declare({ name, type: "counter", help, labels });
    return {
      name,
      inc(labelValues = {}, delta = 1) {
        if (!validateObservationValue(delta)) {
          countRejection(name);
          return false;
        }
        const series = seriesFor(metric, labelValues);
        if (!series) return false;
        series.value += delta;
        return true;
      }
    };
  }

  function gauge(name, help, labels = {}) {
    const metric = declare({ name, type: "gauge", help, labels });
    return {
      name,
      set(labelValues = {}, value) {
        if (!validateObservationValue(value)) {
          countRejection(name);
          return false;
        }
        const series = seriesFor(metric, labelValues);
        if (!series) return false;
        series.value = value;
        return true;
      }
    };
  }

  function histogram(name, help, labels = {}, buckets) {
    const metric = declare({ name, type: "histogram", help, labels, buckets });
    return {
      name,
      buckets: metric.buckets,
      observe(labelValues = {}, value) {
        if (!validateObservationValue(value)) {
          countRejection(name);
          return false;
        }
        const series = seriesFor(metric, labelValues);
        if (!series) return false;
        let placed = false;
        for (let i = 0; i < metric.buckets.length; i += 1) {
          if (value <= metric.buckets[i]) {
            series.bucketCounts[i] += 1;
            placed = true;
            break;
          }
        }
        if (!placed) series.bucketCounts[metric.buckets.length] += 1; // +Inf
        series.sum += value;
        series.count += 1;
        return true;
      }
    };
  }

  function snapshot() {
    const out = {};
    for (const metric of metrics.values()) {
      out[metric.name] = {
        type: metric.type,
        help: metric.help,
        buckets: metric.buckets,
        series: [...metric.series.values()].map((s) => ({
          labels: { ...s.labelValues },
          value: s.value,
          sum: s.sum,
          count: s.count,
          bucketCounts: s.bucketCounts ? [...s.bucketCounts] : undefined
        }))
      };
    }
    out[rejectedGaugeName] = {
      type: "gauge",
      help: "Observations rejected by the cardinality/label guards, per metric",
      buckets: null,
      series: [...rejected.entries()].map(([name, value]) => ({
        labels: { metric: name },
        value
      }))
    };
    return out;
  }

  function metricNames() {
    return [...metrics.keys(), rejectedGaugeName];
  }

  function labelString(labelValues, extra = {}) {
    const merged = { ...labelValues, ...extra };
    const parts = Object.keys(merged)
      .sort()
      .map((k) => `${k}="${escapeLabelValue(merged[k])}"`);
    return parts.length > 0 ? `{${parts.join(",")}}` : "";
  }

  function renderFamily(name, type, help, rows) {
    const block = [`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} ${type}`, ...rows];
    return block;
  }

  function render() {
    const blocks = [];

    for (const metric of [...metrics.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const rows = [];
      const seriesList = [...metric.series.entries()]
        .map(([key, s]) => ({ key, s }))
        .sort((a, b) => a.key.localeCompare(b.key));
      for (const { s } of seriesList) {
        if (metric.type === "histogram") {
          let cumulative = 0;
          for (let i = 0; i < metric.buckets.length; i += 1) {
            cumulative += s.bucketCounts[i];
            rows.push(
              `${metric.name}_bucket${labelString(s.labelValues, { le: formatValue(metric.buckets[i]) })} ${formatValue(cumulative)}`
            );
          }
          cumulative += s.bucketCounts[metric.buckets.length];
          rows.push(
            `${metric.name}_bucket${labelString(s.labelValues, { le: "+Inf" })} ${formatValue(cumulative)}`
          );
          rows.push(`${metric.name}_sum${labelString(s.labelValues)} ${formatValue(s.sum)}`);
          rows.push(`${metric.name}_count${labelString(s.labelValues)} ${formatValue(s.count)}`);
        } else {
          rows.push(`${metric.name}${labelString(s.labelValues)} ${formatValue(s.value)}`);
        }
      }
      if (seriesList.length === 0 && Object.keys(metric.labels).length === 0 && metric.type !== "histogram") {
        // Unlabeled metrics still render their single zero series so
        // scrapers see the family after boot before first observation.
        rows.push(`${metric.name} 0`);
      }
      blocks.push(renderFamily(metric.name, metric.type, metric.help, rows));
    }

    const rejRows = [];
    for (const [name, value] of [...rejected.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      rejRows.push(`${rejectedGaugeName}{metric="${escapeLabelValue(name)}"} ${formatValue(value)}`);
    }
    if (rejected.size === 0) {
      rejRows.push(`${rejectedGaugeName}{metric="none"} 0`);
    }
    blocks.push(
      renderFamily(
        rejectedGaugeName,
        "gauge",
        "Observations rejected by the cardinality/label guards, per metric",
        rejRows
      )
    );

    return blocks.flat().join("\n") + "\n";
  }

  return { counter, gauge, histogram, snapshot, render, metricNames, maxSeries };
}

// histogramQuantile — the Prometheus histogram_quantile() algorithm for
// a SINGLE series given PER-BUCKET counts (the registry's internal
// form; length = finite bounds + 1, last entry the +Inf slot): linear
// interpolation within the bucket that first reaches the target rank.
// Documented method (the runbook pins this as the p95 definition so
// test-side snapshots and scrape-side PromQL agree):
//   rank  = q * count
//   find  smallest bucket i with cumulative[i] >= rank
//   lower = (i == 0) ? 0 : bounds[i-1]   (latency floor is 0)
//   upper = bounds[i] (or the last finite bound when i is the +Inf slot)
//   value = lower + (rank - cumulative[i-1]) / bucketWidth[i] * (upper - lower)
//   Empty series -> null (no observation, no quantile).
export function histogramQuantile(q, perBucketCounts, bounds) {
  const total = perBucketCounts.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(q) || q < 0 || q > 1) return null;
  if (!total) return null;
  const rank = q * total;
  const cumulative = [];
  let running = 0;
  for (const c of perBucketCounts) {
    running += c;
    cumulative.push(running);
  }
  for (let i = 0; i < perBucketCounts.length; i += 1) {
    if (cumulative[i] >= rank) {
      const prevCum = i === 0 ? 0 : cumulative[i - 1];
      const lower = i === 0 ? 0 : bounds[i - 1];
      const upper = i < bounds.length ? bounds[i] : bounds[bounds.length - 1];
      const inBucket = perBucketCounts[i];
      if (inBucket === 0) return i === 0 ? 0 : lower;
      return lower + ((rank - prevCum) / inBucket) * (upper - lower);
    }
  }
  return bounds[bounds.length - 1];
}
