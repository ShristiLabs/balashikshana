// Legal footer coverage (issue #68): the versioned Privacy Policy and
// Terms of Service are reachable on every portal view (including the
// login screen — public documents, no token), render in-app from the
// /api/legal catalog (never an external link), and the dialog stays
// axe-clean.

import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import type { VitestAxeResults } from "./axe-helper";
import { api } from "../api";
import { App } from "../App";
import { LegalFooter } from "../components/LegalFooter";
import type { LegalDocument } from "../api";

const privacy: LegalDocument = {
  kind: "privacy-policy",
  version: "1",
  locale: "en-US",
  body: "DRAFT privacy policy body [COMPANY_LEGAL_NAME]",
  createdAt: "2026-10-26T00:00:00Z",
  active: true,
};

const terms: LegalDocument = {
  kind: "terms-of-service",
  version: "1",
  locale: "en-US",
  body: "DRAFT terms of service body [JURISDICTION_PLACEHOLDER]",
  createdAt: "2026-10-26T00:00:00Z",
  active: true,
};

async function expectNoViolations(container: HTMLElement): Promise<void> {
  const results = (await axe(container)) as unknown as VitestAxeResults;
  expect(
    results.violations.map((v) => ({ id: v.id, impact: v.impact })),
    JSON.stringify(results.violations, null, 2),
  ).toEqual([]);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("LegalFooter (#68)", () => {
  test("renders both legal entries without fetching (lazy on click)", () => {
    const spy = vi.spyOn(api, "legalDocument");
    render(<LegalFooter />);
    expect(screen.getByRole("button", { name: "Privacy Policy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Terms of Service" })).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  test("clicking an entry opens the fetched, versioned document in-app", async () => {
    vi.spyOn(api, "legalDocument").mockImplementation(async (kind) =>
      kind === "privacy-policy" ? privacy : terms,
    );
    const { container } = render(<LegalFooter />);
    fireEvent.click(screen.getByRole("button", { name: "Privacy Policy" }));

    const dialog = await waitFor(() => screen.getByTestId("legal-dialog-privacy-policy"));
    await waitFor(() => expect(screen.getByText(/DRAFT privacy policy body/)).toBeTruthy());
    expect(dialog.querySelector("h2")?.textContent).toBe("Privacy Policy");
    // In-app rendering: the body is text in the dialog, never a link out.
    expect(screen.queryByRole("link")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("legal-dialog-privacy-policy")).toBeNull();
    await expectNoViolations(container);
  });

  test("the terms dialog fetches its own kind", async () => {
    vi.spyOn(api, "legalDocument").mockImplementation(async (kind) =>
      kind === "privacy-policy" ? privacy : terms,
    );
    render(<LegalFooter />);
    fireEvent.click(screen.getByRole("button", { name: "Terms of Service" }));
    await waitFor(() => expect(screen.getByText(/DRAFT terms of service body/)).toBeTruthy());
    expect(api.legalDocument).toHaveBeenCalledWith("terms-of-service");
  });

  test("a failed fetch shows a retryable error, never silently hiding the footer", async () => {
    const spy = vi
      .spyOn(api, "legalDocument")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(privacy);
    render(<LegalFooter />);
    fireEvent.click(screen.getByRole("button", { name: "Privacy Policy" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    // The footer entries remain reachable for retry.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText(/DRAFT privacy policy body/)).toBeTruthy());
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("open dialog is axe-clean", async () => {
    vi.spyOn(api, "legalDocument").mockResolvedValue(privacy);
    const { container } = render(<LegalFooter />);
    fireEvent.click(screen.getByRole("button", { name: "Privacy Policy" }));
    await waitFor(() => expect(screen.getByText(/DRAFT privacy policy body/)).toBeTruthy());
    await expectNoViolations(container);
  });

  test("the real App renders the legal footer on the LOGIN view (pre-auth reachability)", () => {
    const spy = vi.spyOn(api, "legalDocument");
    const { container } = render(<App />);
    // Login view (no stored token): the footer entries must already be
    // present — the legal texts are public and reachable before sign-in.
    expect(screen.getByRole("button", { name: "Privacy Policy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Terms of Service" })).toBeTruthy();
    expect(container.querySelector("footer.app-footer")).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });
});
