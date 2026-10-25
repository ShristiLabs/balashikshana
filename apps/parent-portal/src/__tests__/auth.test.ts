// Token storage tests — pin the security decision: sessionStorage only,
// never localStorage, with graceful degradation when storage throws.

import { describe, expect, test, beforeEach, vi } from "vitest";
import { clearSessionToken, loadSessionToken, saveSessionToken } from "../auth";

describe("session token storage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    clearSessionToken();
  });

  test("save then load round-trips the token", () => {
    saveSessionToken("tok-abc");
    expect(loadSessionToken()).toBe("tok-abc");
    expect(window.sessionStorage.getItem("balashi.portal.session")).toBe("tok-abc");
  });

  test("the token is NEVER written to localStorage", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem");
    saveSessionToken("tok-xyz");
    const localCalls = spy.mock.calls.filter((c) => String(c[0]).includes("balashi"));
    expect(localCalls.length).toBe(1); // exactly one write — the sessionStorage mirror
    spy.mockRestore();
  });

  test("clear removes the durable copy", () => {
    saveSessionToken("tok-abc");
    clearSessionToken();
    expect(loadSessionToken()).toBe(null);
    expect(window.sessionStorage.getItem("balashi.portal.session")).toBe(null);
  });

  test("missing token loads null", () => {
    expect(loadSessionToken()).toBe(null);
  });

  test("storage failures degrade to in-memory only (no throw)", () => {
    const orig = window.sessionStorage.setItem;
    window.sessionStorage.setItem = () => {
      throw new Error("quota");
    };
    expect(() => saveSessionToken("tok-mem")).not.toThrow();
    window.sessionStorage.setItem = orig;
    clearSessionToken();
    expect(loadSessionToken()).toBe(null);
  });
});
