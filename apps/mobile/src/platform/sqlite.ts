/**
 * SQL seam (issue #71). This base module IS expo-sqlite: metro uses it
 * on ios/android, and picks the sql.js web twin (sqlite.web.ts) for web
 * exports. Seam modules import "../platform/sqlite" and get the right
 * engine per platform with no code forks — TypeScript types every
 * caller against these (expo-sqlite) types, and the web twin's returned
 * objects cast to the same shape.
 */
export * from "expo-sqlite";
