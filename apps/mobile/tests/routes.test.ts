/**
 * Navigation-skeleton invariants: the expo-router route tree keeps the
 * five M3 destinations reachable, every placeholder screen uses the
 * shared no-dead-end component, and the parent seam is marked for the
 * onboarding milestone's parental gate.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appDir = fileURLToPath(new URL("../app", import.meta.url));

function read(route: string): string {
  const path = join(appDir, route);
  expect(existsSync(path), `missing route file ${route}`).toBe(true);
  return readFileSync(path, "utf8");
}

const PLACEHOLDER_ROUTES = [
  "onboarding/index.tsx",
  "journey/index.tsx",
  "practice/index.tsx",
  "gate/index.tsx",
  "parent/index.tsx",
];

describe("route tree", () => {
  it("has a root layout and a launcher", () => {
    expect(read("_layout.tsx")).toContain("export default");
    expect(read("index.tsx")).toContain("export default");
  });

  it("renders all five M3 destinations as expo-router screens", () => {
    const layout = read("_layout.tsx");
    for (const screen of [
      "onboarding/index",
      "journey/index",
      "practice/index",
      "gate/index",
      "parent/index",
    ]) {
      expect(layout, `layout must register ${screen}`).toContain(screen);
    }
  });

  it("every placeholder screen uses the shared no-dead-end component", () => {
    for (const route of PLACEHOLDER_ROUTES) {
      const source = read(route);
      expect(source, `${route} must use PlaceholderScreen`).toContain("PlaceholderScreen");
      expect(source, `${route} must default-export a screen`).toContain("export default");
    }
  });

  it("launcher offers onboarding and journey with no dead ends", () => {
    const source = read("index.tsx");
    expect(source).toContain('"/onboarding"');
    expect(source).toContain('"/journey"');
  });

  it("placeholder tour links forward through the M3 flow", () => {
    expect(read("onboarding/index.tsx")).toContain('"/journey"');
    expect(read("journey/index.tsx")).toContain('"/practice"');
    expect(read("practice/index.tsx")).toContain('"/gate"');
    expect(read("gate/index.tsx")).toContain('"/journey"');
  });

  it("marks the parent area with the #44 parental-gate seam", () => {
    expect(read("parent/index.tsx")).toContain("#44");
    expect(read("parent/index.tsx")).toContain("parental gate");
  });

  it("root layout wires theme and reduced-motion providers", () => {
    const source = read("_layout.tsx");
    expect(source).toContain("ThemeProvider");
    expect(source).toContain("MotionProvider");
    expect(source).toContain("SafeAreaProvider");
  });

  it("PlaceholderScreen itself guarantees the Home escape action", () => {
    const source = readFileSync(
      join(appDir, "..", "src", "shell", "PlaceholderScreen.tsx"),
      "utf8",
    );
    expect(source).toContain('label="Home"');
    expect(source).toContain("router.dismissAll()");
  });

  it("no screen under app/ is navigationally inert (dead-end guard)", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
    const screens = walk(appDir).filter((f) => f.endsWith(".tsx") && !f.endsWith("_layout.tsx"));
    expect(screens.length).toBeGreaterThanOrEqual(6);
    for (const screen of screens) {
      const source = readFileSync(screen, "utf8");
      expect(
        /router\.(push|dismissAll|replace|back)|PlaceholderScreen/.test(source),
        `${screen} must navigate or delegate to PlaceholderScreen`,
      ).toBe(true);
    }
  });
});
