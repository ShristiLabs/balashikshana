/**
 * Canonical (deterministic) JSON serialization for pack metadata.
 *
 * Same data -> same bytes, always: object keys sorted lexicographically, no
 * insignificant whitespace, UTF-8. Used for every JSON column inside packs,
 * for the manifest index served by the API, and for fixture parity between
 * the compiler and the device verifier. JSON.stringify alone only preserves
 * insertion order, which would tie artifact bytes to input-file key order.
 */

export function stableStringify(value) {
  if (value === undefined) {
    // JSON semantics: undefined is not representable. Serializing it as
    // the literal string would produce invalid JSON documents (a build
    // bug must fail loudly downstream, not corrupt the manifest).
    throw new Error("stableStringify: undefined value in canonical document");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

/** Stable JSON for a whole document (trailing newline for text files). */
export function stableDocument(value) {
  return `${stableStringify(value)}\n`;
}
