/**
 * The ONLY module in the a11y tree that touches the react-native
 * seam: AccessibilityInfo.announceForAccessibility for screen-reader
 * announcements (issue #67). Everything above stays node-testable —
 * the message text lives in announceMessages.ts and the screens'
 * wiring is pinned by tests/accessibility-source-pins.test.ts.
 *
 * Failures are swallowed on purpose: an announcement is progressive
 * enhancement — a TalkBack quirk must never crash a practice session.
 */
import { AccessibilityInfo } from "react-native";
import { warnOnce } from "../audio/coordinator";

/** Speak `message` to the active screen reader (no-op when none). */
export function announceForAccessibility(message: string): void {
  try {
    AccessibilityInfo.announceForAccessibility(message);
  } catch (error) {
    warnOnce(`announce-throw`, `announceForAccessibility threw: ${String(error)}`);
  }
}
