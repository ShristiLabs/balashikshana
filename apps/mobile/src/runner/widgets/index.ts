/**
 * Manipulative widget kit v1 barrel (issue #50).
 *
 * THE reusable surface: every interaction-type renderer the practice
 * runner mounts is exported here for the M4 game framework's
 * practice-runner fallback (#52). All widgets are presentational,
 * theme-aware (all 3 themes incl. highContrast), >=48pt targets,
 * shape+color redundant, and animation-free (press feedback honors the
 * reduced-motion motion profile; nothing load-bearing animates).
 */
export { ChoiceGrid } from "./ChoiceGrid";
export type { ChoiceGridProps } from "./ChoiceGrid";
export { CounterFrame } from "./CounterFrame";
export type { CounterFrameProps } from "./CounterFrame";
export { TileBuilder } from "./TileBuilder";
export type { TileBuilderProps } from "./TileBuilder";
export { VisualScaffold } from "./VisualScaffold";
export type { VisualScaffoldProps } from "./VisualScaffold";
