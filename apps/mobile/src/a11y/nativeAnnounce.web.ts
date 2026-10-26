/**
 * The web a11y announcement seam (#67 announcements, #71 web): a
 * visually-hidden aria-live region. Screen readers on desktop browsers
 * (ChromeVox on Chromebooks, VoiceOver, NVDA) announce text injected
 * into an aria-live="assertive" region — the web equivalent of
 * AccessibilityInfo.announceForAccessibility.
 *
 * Failures are swallowed on purpose (mirrors the native twin): an
 * announcement is progressive enhancement — a browser quirk must never
 * crash a practice session.
 */

const REGION_ID = "balashikshana-live-region";
const VISUALLY_HIDDEN_STYLE =
  "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;" +
  "clip:rect(0 0 0 0);white-space:nowrap;border:0;";

let region: HTMLElement | null = null;

function ensureRegion(): HTMLElement | null {
  try {
    if (region !== null && region.isConnected) return region;
    const doc = document;
    if (!doc || !doc.body) return null;
    const existing = doc.getElementById(REGION_ID);
    if (existing) {
      region = existing;
      return region;
    }
    const el = doc.createElement("div");
    el.id = REGION_ID;
    el.setAttribute("aria-live", "assertive");
    el.setAttribute("aria-atomic", "true");
    el.setAttribute("role", "status");
    el.setAttribute("style", VISUALLY_HIDDEN_STYLE);
    doc.body.appendChild(el);
    region = el;
    return region;
  } catch {
    return null;
  }
}

/** Speak `message` to the active screen reader (no-op when none). */
export function announceForAccessibility(message: string): void {
  try {
    const el = ensureRegion();
    if (el === null) return;
    // Clear-then-set with a microtask break so consecutive announcements
    // re-trigger the live region in every browser engine.
    el.textContent = "";
    window.setTimeout(() => {
      el.textContent = message;
    }, 30);
  } catch {
    // Progressive enhancement only.
  }
}
