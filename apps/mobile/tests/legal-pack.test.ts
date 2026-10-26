/**
 * Legal-pack shipping invariants (issue #68): the versioned Privacy Policy
 * and Terms of Service are reachable in-app BEFORE consent is captured,
 * render from the /api/legal catalog (no external links), and are also
 * reachable from the gated parent area.
 *
 * Source-pin style (the repo's standing convention while no RN component
 * harness exists): the pins assert structure on the component sources; the
 * api-client behavior is unit-tested against a mocked fetch in
 * onboarding-api.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(mobileRoot, rel), "utf8");

describe("pre-consent legal accessibility (#68 AC: linked BEFORE consent capture)", () => {
  it("ConsentStep renders the LegalDocuments section", () => {
    const source = read("src/onboarding/steps/ConsentStep.tsx");
    expect(source).toContain("<LegalDocuments");
    expect(source).toContain('testID="onboarding.consent.legal"');
  });

  it("the legal section renders BEFORE the accept button (reading precedes agreeing)", () => {
    const source = read("src/onboarding/steps/ConsentStep.tsx");
    const legalAt = source.indexOf("<LegalDocuments");
    const acceptAt = source.indexOf('testID="onboarding.consent.accept"');
    expect(legalAt).toBeGreaterThan(-1);
    expect(acceptAt).toBeGreaterThan(-1);
    expect(legalAt, "legal documents must be reachable before the I-agree button").toBeLessThan(
      acceptAt,
    );
  });

  it("the legal section renders when the policy is shown (same branch as the accept button)", () => {
    const source = read("src/onboarding/steps/ConsentStep.tsx");
    const policyBranch = source.indexOf("{policy ? (");
    const branchEnd = source.indexOf(") : loadError ? (");
    const branch = source.slice(policyBranch, branchEnd);
    expect(branch).toContain("<LegalDocuments");
    expect(branch).toContain('testID="onboarding.consent.accept"');
  });
});

describe("parent-area legal reachability (gated surface)", () => {
  it("the parent area renders LegalDocuments inside the post-gate content", () => {
    const source = read("app/parent/index.tsx");
    expect(source).toContain("<LegalDocuments");
    // Gated: the legal section must sit inside the content that renders
    // only after gatePassed (the ParentalGate branch returns early).
    const gateBranchAt = source.indexOf("if (!gatePassed)");
    const legalAt = source.indexOf("<LegalDocuments");
    expect(gateBranchAt).toBeGreaterThan(-1);
    expect(legalAt, "legal documents render only behind the parental gate").toBeGreaterThan(
      gateBranchAt,
    );
  });
});

describe("no external links on legal surfaces (Families/Kids policy)", () => {
  it("LegalDocuments renders text in-app only — no Linking/openURL/anchors", () => {
    const source = read("src/onboarding/LegalDocuments.tsx");
    expect(source).not.toMatch(/Linking|openURL|Anchor|href/i);
  });

  it("the legal texts arrive from the versioned /api/legal catalog", () => {
    const source = read("src/onboarding/api.ts");
    expect(source).toContain("legalLatest");
    expect(source).toContain("/api/legal/");
    expect(source).toContain("privacy-policy");
    expect(source).toContain("terms-of-service");
  });
});

describe("legal documents are versioned like the consent policy", () => {
  it("the rendered section titles carry the document version", () => {
    const source = read("src/onboarding/LegalDocuments.tsx");
    expect(source).toContain("v${state.doc.version}");
    expect(source).toContain("KIND_TITLES");
  });

  it("a fetch failure never blocks the consent flow (companion, not gate)", () => {
    const source = read("src/onboarding/LegalDocuments.tsx");
    expect(source).toMatch(/never block the consent FLOW|never block the flow/);
    // Error state is explicit and retryable, not silent.
    expect(source).toContain("Could not load");
    expect(source).toContain("Try again");
  });
});
