// Pure display helpers (unit-tested through the components that use
// them): human labels for grades/subjects and compact week headings.

import type { GradeId, SubjectId, QuadrantName } from "./types";

export const GRADE_LABELS: Record<GradeId, string> = {
  "pre-k": "Pre-K",
  kindergarten: "Kindergarten",
  "grade-1": "Grade 1",
  "grade-2": "Grade 2",
  "grade-3": "Grade 3"
};

export const SUBJECT_LABELS: Record<SubjectId, string> = {
  math: "Math",
  ela: "Reading & Language (ELA)",
  science: "Science",
  socialStudies: "Social Studies"
};

export const QUADRANT_LABELS: Record<QuadrantName, string> = {
  fluent: "Fluent mastery (fast and accurate)",
  "accurate-slow": "Understands, needs speed practice",
  rushing: "Rushing or guessing",
  "needs-review": "Needs concept review"
};

export const QUADRANT_COLORS: Record<QuadrantName, string> = {
  fluent: "var(--color-green)",
  "accurate-slow": "var(--color-gold)",
  rushing: "var(--color-orange)",
  "needs-review": "var(--color-coral)"
};

export function gradeLabel(gradeId: string | null | undefined): string {
  if (!gradeId) return "";
  return GRADE_LABELS[gradeId as GradeId] ?? gradeId;
}

export function subjectLabel(subjectId: string): string {
  return SUBJECT_LABELS[subjectId as SubjectId] ?? subjectId;
}

/** "Week of Oct 19" for a Monday ISO timestamp. */
export function weekLabel(weekStartIso: string): string {
  const d = new Date(weekStartIso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "5:30 PM" for hour/minute (the reminder preview). */
export function timeLabel(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}
