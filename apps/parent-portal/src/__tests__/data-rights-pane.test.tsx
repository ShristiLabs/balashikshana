// DataRightsPane tests (issue #62) — the COPPA self-serve contract:
// consequence copy renders, the export download carries the bearer token
// and lands as a file, and deletion is double-gated (password REQUIRED
// before the hold even starts; the hold must COMPLETE — releasing early
// cancels with no API call).

import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { DataRightsPane } from "../components/DataRightsPane";

function renderPane(overrides: { onDeleted?: () => void } = {}) {
  const onDeleted = overrides.onDeleted ?? vi.fn();
  render(
    <DataRightsPane
      token="tok"
      studentId="stu-1"
      nickname="Maya"
      onDeleted={onDeleted}
      onUnauthorized={() => {}}
      holdMs={150}
    />
  );
  return { onDeleted };
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const deletionSummary = {
  deleted: true,
  studentId: "stu-1",
  auditId: "del-abc123",
  deletedAt: "2026-10-25T00:00:00.000Z",
  scope: "child-data",
  consentRecordsDetached: 2,
  deletedCounts: { students: 1 }
};

describe("DataRightsPane", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    createObjectURL = vi.fn(() => "blob:mock-url");
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, writable: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("renders the download and delete sections with plain-language consequence copy", () => {
    renderPane();
    expect(screen.getByRole("heading", { name: "Download my child's data" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Delete my child's data" })).toBeInTheDocument();
    expect(screen.getByText(/permanently deletes Maya's profile/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByText(/proof that you, the parent, agreed/i)).toBeInTheDocument();
  });

  test("download carries the bearer token and triggers a file download", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => new Response('{"formatVersion":1}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderPane();
    const btn = screen.getByRole("button", { name: "Download my child's data" });
    // jsdom click on a synthesized anchor is a no-op navigation; the
    // observable contract is the object URL + revoke lifecycle.
    fireEvent.click(btn);
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/portal/children/stu-1/export");
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok" });
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url"));
    expect(screen.getByText(/Downloaded Maya's data/i)).toBeInTheDocument();
  });

  test("the hold gate refuses to start without a password (no API call)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderPane();
    fireEvent.pointerDown(screen.getByRole("button", { name: /Hold for/i }), { button: 0 });
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your account password first");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a completed hold sends the DELETE with the password and reports the audit reference", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => jsonRes(deletionSummary));
    vi.stubGlobal("fetch", fetchMock);
    const { onDeleted } = renderPane();
    fireEvent.change(screen.getByLabelText(/Your account password/), { target: { value: "legitimate-password-1" } });
    const holdBtn = screen.getByRole("button", { name: /Hold for/i });
    fireEvent.pointerDown(holdBtn, { button: 0 });
    await waitFor(() => expect(onDeleted).toHaveBeenCalled(), { timeout: 3000 });
    const delCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "DELETE");
    expect(delCall).toBeDefined();
    const [url, init] = delCall as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4000/api/portal/children/stu-1");
    expect(JSON.parse(String(init.body))).toEqual({ password: "legitimate-password-1" });
    expect(screen.getByText(/del-abc123/)).toBeInTheDocument();
  });

  test("releasing before the hold completes cancels — no DELETE call", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      renderPane();
      fireEvent.change(screen.getByLabelText(/Your account password/), { target: { value: "legitimate-password-1" } });
      const holdBtn = screen.getByRole("button", { name: /Hold for/i });
      fireEvent.pointerDown(holdBtn, { button: 0 });
      act(() => {
        vi.advanceTimersByTime(80);
      });
      fireEvent.pointerUp(holdBtn);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("pointercancel (touch scroll takeover, NO pointerup) cancels the hold — no DELETE call", async () => {
    // The reviewer's HIGH finding: a scroll gesture stealing the pointer
    // fires pointercancel alone; the hold must never run to completion.
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      renderPane();
      fireEvent.change(screen.getByLabelText(/Your account password/), { target: { value: "legitimate-password-1" } });
      const holdBtn = screen.getByRole("button", { name: /Hold for/i });
      fireEvent.pointerDown(holdBtn, { button: 0 });
      act(() => {
        vi.advanceTimersByTime(80);
      });
      fireEvent.pointerCancel(holdBtn);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a non-primary button (right-click) never starts the hold", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      renderPane();
      fireEvent.change(screen.getByLabelText(/Your account password/), { target: { value: "legitimate-password-1" } });
      const holdBtn = screen.getByRole("button", { name: /Hold for/i });
      // RTL's synthetic pointer events drop the button field in this
      // environment, so drive the NATIVE constructor (real browsers always
      // set button on pointerdown).
      const NativePointerEvent = (window as unknown as { PointerEvent?: typeof PointerEvent }).PointerEvent;
      if (NativePointerEvent) {
        holdBtn.dispatchEvent(new NativePointerEvent("pointerdown", { bubbles: true, button: 2 }));
      } else {
        holdBtn.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 2 }));
      }
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a wrong password surfaces the API problem detail as an alert", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) =>
      jsonRes({ type: ".../re-auth-required", title: "Re-authentication failed", detail: "Deleting your child's data requires your account password." }, 401)
    );
    vi.stubGlobal("fetch", fetchMock);
    renderPane();
    fireEvent.change(screen.getByLabelText(/Your account password/), { target: { value: "legitimate-password-1" } });
    const holdBtn = screen.getByRole("button", { name: /Hold for/i });
    fireEvent.pointerDown(holdBtn, { button: 0 });
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByRole("alert")).toHaveTextContent("requires your account password");
  });

  test("keyboard users can run the hold via Space (keydown starts, keyup completes)", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => jsonRes(deletionSummary));
    vi.stubGlobal("fetch", fetchMock);
    renderPane();
    fireEvent.change(screen.getByLabelText(/Your account password/), { target: { value: "legitimate-password-1" } });
    const holdBtn = screen.getByRole("button", { name: /Hold for/i });
    fireEvent.keyDown(holdBtn, { key: " " });
    // The hold completes and the DELETE fires; the progress UI is replaced
    // by the post-deletion state, so await the call + confirmation.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => expect(screen.getByText(/del-abc123/)).toBeInTheDocument());
    const delCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "DELETE");
    expect(delCall).toBeDefined();
  });
});
