/**
 * Gamification module (issue #55, roadmap D9).
 *
 * - rewardsProjector: the optimistic local ledger's PURE transitions over
 *   the shared engine reward rules (no fork with the server's ledger).
 * - storage / api: the lifecycle-row and ledger-endpoint seams (DI only).
 * - gamificationStore: the pure store behind the kid-facing surfaces.
 * - GamificationHeaderStrip: the journey-home surfacing (level/XP/coins/
 *   streak/badges); display wiring for session summaries and badge blooms
 *   lands with their consumers (#56/#57/#58).
 */
export * from "./types";
export * from "./rewardsProjector";
export * from "./storage";
export * from "./gamificationStore";
export * from "./api";
export { GamificationHeaderStrip } from "./GamificationHeaderStrip";
