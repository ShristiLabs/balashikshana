// EmailPreferences component tests (issue #63) — the parent-level
// weekly-summary toggle: loads the server state, saves IMMEDIATELY on
// change with the documented payload, confirms the new state, and
// reverts the checkbox to the server's truth when a save fails.

import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EmailPreferences } from "../components/EmailPreferences";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(handlers: Array<(url: string, init?: RequestInit) => Response | undefined>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const h of handlers) {
      const res = h(url, init);
      if (res) return res;
    }
    return jsonResponse({ title: "Error", detail: "unhandled", type: "x" }, 500);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("EmailPreferences", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders the loaded state (on by default from the server)", async () => {
    stubFetch([
      (url) => (url.endsWith("/api/portal/notification-preferences") ? jsonResponse({ weeklyEmailEnabled: true, serverTime: "t" }) : undefined)
    ]);
    render(<EmailPreferences token="tok" onUnauthorized={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText(/Weekly summary email on/)).toBeChecked());
  });

  test("toggling off saves immediately with { weeklyEmailEnabled: false } and confirms", async () => {
    let current = true;
    const mock = stubFetch([
      (url, init) => {
        if (url.endsWith("/api/portal/notification-preferences") && (!init || init.method === undefined || init.method === "GET")) {
          return jsonResponse({ weeklyEmailEnabled: current, serverTime: "t" });
        }
        return undefined;
      },
      (url, init) => {
        if (url.endsWith("/api/portal/notification-preferences") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as { weeklyEmailEnabled: boolean };
          current = body.weeklyEmailEnabled;
          return jsonResponse({ weeklyEmailEnabled: current, serverTime: "t" });
        }
        return undefined;
      }
    ]);
    render(<EmailPreferences token="tok" onUnauthorized={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText(/Weekly summary email on/)).toBeChecked());

    fireEvent.click(screen.getByLabelText(/Weekly summary email on/));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/will not receive the next one/i));
    const putCall = mock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    expect(JSON.parse(String((putCall![1] as RequestInit).body))).toEqual({ weeklyEmailEnabled: false });
    await waitFor(() => expect(screen.getByLabelText(/Weekly summary email off/)).not.toBeChecked());
  });

  test("a failed save surfaces the error and reverts the checkbox to the server's truth", async () => {
    const mock = stubFetch([
      (url, init) => {
        if (url.endsWith("/api/portal/notification-preferences") && init?.method === "PUT") {
          return jsonResponse({ title: "Validation failed", detail: "The request did not match the required schema.", type: "x" }, 400);
        }
        return undefined;
      },
      (url) => (url.endsWith("/api/portal/notification-preferences") ? jsonResponse({ weeklyEmailEnabled: true, serverTime: "t" }) : undefined)
    ]);
    render(<EmailPreferences token="tok" onUnauthorized={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText(/Weekly summary email on/)).toBeChecked());

    fireEvent.click(screen.getByLabelText(/Weekly summary email on/));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not match the required schema/i));
    // The optimistic flip is reverted by the re-read.
    await waitFor(() => expect(screen.getByLabelText(/Weekly summary email on/)).toBeChecked());
    expect(mock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(true);
  });
});
