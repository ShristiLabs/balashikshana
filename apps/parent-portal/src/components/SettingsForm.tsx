// Settings form — the parent's controls for one child: daily time cap,
// subject restrictions, grade ceiling, and the reminder defaults that
// mirror #57's device-local contract (local-only notifications, default
// off, 17:00 shape when enabled). Client-side validation mirrors the
// API schema (5..480-minute caps, fixed subject vocabulary, registry
// grades, 0..23 / 0..59 times) so the parent gets instant feedback; the
// server re-validates authoritatively.

import { useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError, isUnauthorizedError } from "../api";
import { errorText } from "../App";
import { GRADE_LABELS, SUBJECT_LABELS, timeLabel } from "../format";
import type { ChildSettings, GradeId, PortalSettingsResponse, SubjectId } from "../types";

const GRADES: GradeId[] = ["pre-k", "kindergarten", "grade-1", "grade-2", "grade-3"];
const SUBJECTS: SubjectId[] = ["math", "ela", "science", "socialStudies"];
const CAP_MIN = 5;
const CAP_MAX = 480;

export function SettingsForm({
  token,
  studentId,
  initial,
  onSaved,
  onUnauthorized
}: {
  token: string;
  studentId: string;
  initial: PortalSettingsResponse;
  onSaved: (saved: PortalSettingsResponse) => void;
  onUnauthorized: () => void;
}) {
  const [settings, setSettings] = useState<ChildSettings>(initial.settings);
  const [noLimit, setNoLimit] = useState(initial.settings.dailyLimitMinutes === null);
  const [cap, setCap] = useState<string>(initial.settings.dailyLimitMinutes === null ? "30" : String(initial.settings.dailyLimitMinutes));
  const [remindTime, setRemindTime] = useState(
    `${String(initial.settings.reminderHour).padStart(2, "0")}:${String(initial.settings.reminderMinute).padStart(2, "0")}`
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggleSubject(subject: SubjectId) {
    setSettings((prev) => ({
      ...prev,
      restrictedSubjects: prev.restrictedSubjects.includes(subject)
        ? prev.restrictedSubjects.filter((s) => s !== subject)
        : [...prev.restrictedSubjects, subject]
    }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(null);
    const capNum = noLimit ? null : Number(cap);
    if (capNum !== null && (!Number.isInteger(capNum) || capNum < CAP_MIN || capNum > CAP_MAX)) {
      setError(`Daily limit must be between ${CAP_MIN} and ${CAP_MAX} minutes, or left unlimited.`);
      return;
    }
    const [hourRaw, minuteRaw] = remindTime.split(":");
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    if (settings.remindersEnabled && (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59)) {
      setError("Reminder time must be a valid time of day.");
      return;
    }
    setBusy(true);
    try {
      await api.putSettings(token, studentId, {
        dailyLimitMinutes: capNum,
        restrictedSubjects: settings.restrictedSubjects,
        gradeCeiling: settings.gradeCeiling,
        remindersEnabled: settings.remindersEnabled,
        reminderHour: settings.remindersEnabled ? hour : 17,
        reminderMinute: settings.remindersEnabled ? minute : 0
      });
      // The PUT response carries the stored settings but NOT live usage;
      // re-read so the "used today" line reflects the new cap immediately.
      const fresh = await api.settings(token, studentId);
      setSaved("Settings saved.");
      onSaved(fresh);
    } catch (err) {
      if (isUnauthorizedError(err)) return onUnauthorized();
      setError(err instanceof ApiError ? err.message : errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const usage = initial.usage;

  return (
    <form onSubmit={onSubmit} noValidate>
      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}
      {saved ? (
        <div className="notice-banner" role="status">
          {saved}
        </div>
      ) : null}

      <fieldset>
        <legend>Daily practice time limit</legend>
        {usage.dailyLimitMinutes !== null ? (
          <p className="quad-note" role="status">
            Used today: {usage.usedMinutesToday} of {usage.dailyLimitMinutes} minutes
            {usage.exceeded ? " — limit reached; new practice is paused until the daily reset." : "."}
          </p>
        ) : null}
        <div className="checkbox-row">
          <input
            id="no-limit"
            type="checkbox"
            checked={noLimit}
            onChange={(e) => setNoLimit(e.target.checked)}
          />
          <label htmlFor="no-limit">No daily limit (unlimited)</label>
        </div>
        <label className="field" htmlFor="cap-input" style={{ maxWidth: "16rem" }}>
          <span>Daily limit (minutes)</span>
          <input
            id="cap-input"
            className="input"
            type="number"
            min={CAP_MIN}
            max={CAP_MAX}
            step={1}
            disabled={noLimit}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </label>
        <p className="quad-note">
          When the limit is reached, the app pauses new practice for the day and gently tells your child.
        </p>
      </fieldset>

      <fieldset>
        <legend>Content controls — subjects to hide</legend>
        {SUBJECTS.map((subject) => (
          <div className="checkbox-row" key={subject}>
            <input
              id={`restrict-${subject}`}
              type="checkbox"
              checked={settings.restrictedSubjects.includes(subject)}
              onChange={() => toggleSubject(subject)}
            />
            <label htmlFor={`restrict-${subject}`}>Hide {SUBJECT_LABELS[subject]}</label>
          </div>
        ))}
      </fieldset>

      <fieldset>
        <legend>Grade ceiling</legend>
        <label className="field" htmlFor="ceiling-select" style={{ maxWidth: "16rem" }}>
          <span>Highest grade this child can open</span>
          <select
            id="ceiling-select"
            className="input"
            value={settings.gradeCeiling ?? ""}
            onChange={(e) => setSettings((prev) => ({ ...prev, gradeCeiling: (e.target.value || null) as GradeId | null }))}
          >
            <option value="">No ceiling (follow the curriculum path)</option>
            {GRADES.map((g) => (
              <option key={g} value={g}>
                {GRADE_LABELS[g]}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>Daily practice reminder</legend>
        <div className="checkbox-row">
          <input
            id="reminders-enabled"
            type="checkbox"
            checked={settings.remindersEnabled}
            onChange={(e) => setSettings((prev) => ({ ...prev, remindersEnabled: e.target.checked }))}
          />
          <label htmlFor="reminders-enabled">Enable the daily practice reminder</label>
        </div>
        <label className="field" htmlFor="remind-time" style={{ maxWidth: "16rem" }}>
          <span>Reminder time (your child's device local time)</span>
          <input
            id="remind-time"
            className="input"
            type="time"
            disabled={!settings.remindersEnabled}
            value={remindTime}
            onChange={(e) => setRemindTime(e.target.value)}
          />
        </label>
        <p className="quad-note">
          Reminders are COPPA-safe: they are scheduled locally on your child's device, default off, and nothing is ever
          sent to any third party.
          {settings.remindersEnabled ? ` Reminder set for ${timeLabel(Number(remindTime.split(":")[0]) || 17, Number(remindTime.split(":")[1]) || 0)}.` : ""}
        </p>
      </fieldset>

      <button className="btn" type="submit" disabled={busy}>
        {busy ? "Saving..." : "Save settings"}
      </button>
    </form>
  );
}
