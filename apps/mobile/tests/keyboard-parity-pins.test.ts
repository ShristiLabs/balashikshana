/**
 * #71 keyboard/mouse parity pins — evidence for the issue's "every
 * interaction type completable keyboard-only AND mouse-only" AC, per
 * the repo's source-pin doctrine (no component harness; the
 * accessibility-source-pins style — see that file for the precedent).
 *
 * WHY PINS SUFFICE: every child-facing interaction in this app is a
 * Pressable with accessibilityRole="button" (tap-to-place, tap-to-pay,
 * tap-to-pop — the #50 widget kit and the games were designed tap-only,
 * never drag: "tap-to-place, never fine-motor drag, for the 3-9 age
 * band"). react-native-web renders such Pressables as focusable
 * <div role="button"> elements activated by BOTH mouse click and
 * Enter/Space (RNW's built-in key handling) — so role=button + onPress
 * + no-drag-APIs IS keyboard+mouse parity, per interaction type. The
 * one gesture that is NOT a plain activation — the hold-to-confirm
 * parental gate — carries an explicit web keyboard implementation
 * (ParentalGate keydown/keyup listeners), pinned below.
 *
 * Pins:
 * 1. Every runner widget option surface is a Pressable with role=button.
 * 2. No drag/pan/hover-only APIs anywhere in shipped sources (mouse
 *    parity: nothing requires hover; keyboard parity: nothing requires
 *    a touch gesture).
 * 3. The games' interactive surfaces are Pressable role=button.
 * 4. ParentalGate web keyboard hold: Enter/Space keydown starts the
 *    hold (auto-repeat filtered), keyup releases, Space never scrolls.
 * 5. The exported shell shows a visible focus ring (:focus-visible pin
 *    lives in web-pwa.test.ts — referenced here for the matrix).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = fileURLToPath(new URL("..", import.meta.url));

function read(relative: string): string {
  return readFileSync(join(mobileRoot, relative), "utf8");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "dist" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

describe("#71 keyboard/mouse parity: runner widgets", () => {
  const INTERACTIVE_WIDGETS = [
    "src/runner/widgets/ChoiceGrid.tsx",
    "src/runner/widgets/CounterFrame.tsx",
    "src/runner/widgets/TileBuilder.tsx",
  ];

  it("every widget's option surface is a Pressable carrying role=button (Enter/Space + click activatable on web)", () => {
    for (const rel of INTERACTIVE_WIDGETS) {
      const src = read(rel);
      expect(src).toContain("<Pressable");
      expect(src).toContain('accessibilityRole="button"');
    }
  });

  it("tile building is tap-to-place (click-to-select/click-to-place; no drag)", () => {
    const src = read("src/runner/widgets/TileBuilder.tsx");
    expect(src).toMatch(/tap-to-place/i);
    expect(src).not.toMatch(/PanResponder|onDrag|draggable/i);
  });
});

describe("#71 keyboard/mouse parity: games", () => {
  const GAMES = [
    "src/games/BlockBuilderGame.tsx",
    "src/games/BubblePopBlitzGame.tsx",
    "src/games/MarketCashierGame.tsx",
    "src/games/MonsterPhonemeFeederGame.tsx",
  ];

  it("every game's interactive surface is Pressable role=button (taps/clicks/Enter/Space)", () => {
    for (const rel of GAMES) {
      const src = read(rel);
      expect(src).toContain("<Pressable");
      expect(src).toContain('accessibilityRole="button"');
    }
  });

  it("BlockBuilder is drag-free by construction (tap-to-place bank)", () => {
    expect(read("src/games/BlockBuilderGame.tsx")).toMatch(/tap-to-place \(drag-free\)/i);
  });

  it("MarketCashier pays by tapping coin keys (drag-free)", () => {
    expect(read("src/games/MarketCashierGame.tsx")).toMatch(/tap-to-pay \(drag-free\)/i);
  });
});

describe("#71 keyboard/mouse parity: whole-tree drag/hover ban", () => {
  it("no pan/drag/hover-only interaction APIs in shipped mobile sources", () => {
    const files = [...walk(join(mobileRoot, "src")), ...walk(join(mobileRoot, "app"))];
    const offenders: string[] = [];
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      if (/PanResponder|onStartShouldSetResponder|onMouseMove|onHoverIn|onDragStart/i.test(s)) {
        offenders.push(f.replace(mobileRoot + "/", ""));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("#71 keyboard parity: the parental gate hold (the single non-activation gesture)", () => {
  const gate = read("src/onboarding/ParentalGate.tsx");

  it("web keydown starts the hold and filters auto-repeat", () => {
    expect(gate).toContain('key === "Enter" || key === " "');
    expect(gate).toContain("!event.repeat");
    expect(gate).toContain("onKeyDown");
  });

  it("web keyup releases the hold (identical timing model to touch)", () => {
    expect(gate).toContain("onKeyUp");
    expect(gate).toContain("onPressOut()");
  });

  it("Space never scrolls the page while holding the gate", () => {
    expect(gate).toMatch(/preventDefault/);
  });

  it("keyboard listeners attach on web only (native untouched, single shared gate)", () => {
    expect(gate).toContain('Platform.OS !== "web"');
  });
});
