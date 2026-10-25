// SettingsForm component tests — the parent-controls contract: defaults
// render, client-side validation mirrors the API schema (0-minute and
// 500-minute caps rejected locally), and the save payload carries the
// documented shapes (null cap when unlimited, 17:00 shape when
// reminders are disabled).

import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsForm } from "../components/SettingsForm";
import type { PortalSettingsResponse } from "../types";

const base: PortalSettingsResponse = {
  studentId: "stu-1",
  settings: {
    dailyLimitMinutes: null,
    restrictedSubjects: [],
    gradeCeiling: null,
    remindersEnabled: false,
    reminderHour: 17,
    reminderMinute: 0
  },
  updatedAt: null,
  usage: { dailyLimitMinutes: null, usedMinutesToday: 0, exceeded: false },
  serverTime: "2026-10-19T00:00:00.000Z"
};

function renderForm(overrides: Partial<PortalSettingsResponse> = {}, onSaved = vi.fn()) {
  const props = { ...base, ...overrides, settings: { ...base.settings, ...(overrides.settings ?? {}) } };
  render(
    <SettingsForm token="tok" studentId="stu-1" initial={props} onSaved={onSaved} onUnauthorized={() => {}} />
  );
  return { onSaved };
}

describe("SettingsForm", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  test("defaults render: unlimited checked, reminders off, COPPA note present", () => {
    renderForm();
    expect(screen.getByLabelText("No daily limit (unlimited)")).toBeChecked();
    expect(screen.getByLabelText("Enable the daily practice reminder")).not.toBeChecked();
    expect(screen.getByText(/scheduled locally on your child's device/)).toBeInTheDocument();
  });

  test("a 0-minute cap is rejected client-side with an alert, no API call", () => {
    const { onSaved } = renderForm();
    fireEvent.click(screen.getByLabelText("No daily limit (unlimited)")); // uncheck -> limited
    fireEvent.change(screen.getByLabelText(/Daily limit/), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.getByRole("alert")).toHaveTextContent("between 5 and 480 minutes");
    expect(onSaved).not.toHaveBeenCalled();
  });

  test("a 500-minute cap is rejected client-side", () => {
    renderForm();
    fireEvent.click(screen.getByLabelText("No daily limit (unlimited)"));
    fireEvent.change(screen.getByLabelText(/Daily limit/), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.getByRole("alert")).toHaveTextContent("between 5 and 480 minutes");
  });

  test("saving submits the documented payload shape (null cap, subject list, reminder defaults)", async () => {
    const saved = {
      settings: { dailyLimitMinutes: 30, restrictedSubjects: ["math"], gradeCeiling: null, remindersEnabled: true, reminderHour: 18, reminderMinute: 30 },
      updatedAt: "2026-10-19T01:00:00.000Z",
      serverTime: "2026-10-19T01:00:00.000Z"
    };
    // Both calls (PUT + the usage re-read GET) return the full settings
    // shape — the component only consumes the GET's payload.
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) =>
      new Response(
        JSON.stringify({
          studentId: "stu-1",
          ...saved,
          usage: { dailyLimitMinutes: 30, usedMinutesToday: 0, exceeded: false }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    renderForm(
      {
        settings: { dailyLimitMinutes: 30, restrictedSubjects: ["math"], gradeCeiling: null, remindersEnabled: true, reminderHour: 18, reminderMinute: 30 }
      },
      onSaved
    );
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
    const putCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    const [url, init] = putCall as unknown as [string, RequestInit];
    expect(String(url)).toContain("/api/portal/children/stu-1/settings");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      dailyLimitMinutes: 30,
      restrictedSubjects: ["math"],
      gradeCeiling: null,
      remindersEnabled: true,
      reminderHour: 18,
      reminderMinute: 30
    });
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  test("saving with reminders disabled sends the 17:00 default shape", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) =>
      new Response(
        JSON.stringify({
          studentId: "stu-1",
          settings: base.settings,
          updatedAt: null,
          usage: { dailyLimitMinutes: null, usedMinutesToday: 0, exceeded: false },
          serverTime: "2026-10-19T01:00:00.000Z"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    renderForm({}, onSaved);
    // Keep unlimited checked; reminders off.
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
    const putCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PUT");
    const [ , init] = putCall as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      dailyLimitMinutes: null,
      restrictedSubjects: [],
      gradeCeiling: null,
      remindersEnabled: false,
      reminderHour: 17,
      reminderMinute: 0
    });
  });

  test("live usage renders when a cap is configured", () => {
    renderForm({ usage: { dailyLimitMinutes: 30, usedMinutesToday: 12.5, exceeded: false } });
    expect(screen.getByText(/Used today: 12.5 of 30 minutes/)).toBeInTheDocument();
  });
});
