// Wire types for the parent-portal API surface (/api/portal/*, issue
// #61). Shapes mirror docs/openapi/baseline.yaml exactly; the API is
// the contract source, this file only types it.

export interface ParentPublic {
  parentId: string;
  email: string;
  emailVerified: boolean;
  emailVerifiedAt: string | null;
}

export interface PortalChildOverview {
  studentId: string;
  nickname: string;
  avatar: string;
  currentGrade: string;
  relation?: string;
  streakDays: number;
  lastActiveAt?: string;
  unitsStarted: number;
  unitsMastered: number;
  silverKeys: number;
  goldKeys: number;
}

export interface PortalChildrenResponse {
  parentId: string;
  children: PortalChildOverview[];
}

export type QuadrantName = "fluent" | "accurate-slow" | "rushing" | "needs-review";

export interface QuadrantPoint {
  topicId: string;
  topicName?: string;
  unitId?: string;
  subject?: string;
  attempts: number;
  correct: number;
  accuracyPct: number | null;
  medianSpeedSec: number | null;
  targetSpeedSec: number | null;
  quadrant: QuadrantName | null;
}

export interface PortalQuadrantResponse {
  studentId: string;
  topics: QuadrantPoint[];
  generatedAt: string;
}

export interface WeeklyWeek {
  weekStartIso: string;
  weekStartMs: number;
  attempts: number;
  correct: number;
  accuracyPct: number | null;
  activeMinutes: number;
  topicsPracticed: number;
  topicsFirstMastered: number;
  cumulativeTopicsMastered: number;
}

export interface PortalWeeklyResponse {
  studentId: string;
  weeks: number;
  series: WeeklyWeek[];
  generatedAt: string;
}

export type SubjectId = "math" | "ela" | "science" | "socialStudies";

export type GradeId = "pre-k" | "kindergarten" | "grade-1" | "grade-2" | "grade-3";

export interface ChildSettings {
  dailyLimitMinutes: number | null;
  restrictedSubjects: SubjectId[];
  gradeCeiling: GradeId | null;
  remindersEnabled: boolean;
  reminderHour: number;
  reminderMinute: number;
}

export interface TimeLimitUsage {
  dailyLimitMinutes: number | null;
  usedMinutesToday: number;
  exceeded: boolean;
}

export interface PortalSettingsResponse {
  studentId: string;
  settings: ChildSettings;
  updatedAt: string | null;
  usage: TimeLimitUsage;
  serverTime: string;
}

export interface PortalSettingsPutResponse {
  settings: ChildSettings;
  updatedAt?: string;
  serverTime: string;
}

export interface DeletionSummary {
  deleted: boolean;
  studentId: string;
  auditId: string;
  deletedAt: string;
  scope: "child-data";
  consentRecordsDetached: number;
  deletedCounts: Record<string, number>;
}

export interface NotificationPreferences {
  weeklyEmailEnabled: boolean;
  serverTime: string;
}
