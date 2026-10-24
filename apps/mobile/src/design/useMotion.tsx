/**
 * Global reduced-motion provider. Reads the OS accessibility setting via
 * AccessibilityInfo once at the root layout and re-broadcasts changes,
 * so every animated primitive consumes a single source of truth instead
 * of attaching its own listener. The decision logic itself is the pure
 * motionProfileFor() in motion.ts (unit-tested without RN).
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { AccessibilityInfo, Platform } from "react-native";
import { motionProfileFor, type MotionProfile } from "./motion";

interface MotionContextValue {
  /** Current OS reduce-motion setting. */
  reduceMotion: boolean;
  /** Resolved profile: animated primitives must honor animationsEnabled. */
  motion: MotionProfile;
}

const MotionContext = createContext<MotionContextValue>({
  reduceMotion: false,
  motion: motionProfileFor(false),
});

export function MotionProvider({ children }: { children: React.ReactNode }) {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (enabled) => {
      setReduceMotion(enabled);
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  const value = useMemo<MotionContextValue>(
    () => ({ reduceMotion, motion: motionProfileFor(reduceMotion) }),
    [reduceMotion],
  );
  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

/**
 * Reduced-motion hook for animated primitives. On web (Expo web export
 * is out of scope until #65) this additionally consults the CSS media
 * query; on native the AccessibilityInfo provider is authoritative.
 */
export function useReducedMotion(): MotionContextValue {
  const context = useContext(MotionContext);
  if (Platform.OS === "web" && typeof window !== "undefined" && window.matchMedia) {
    // The provider already mirrors the OS setting on native; the media
    // query check keeps web builds honest when they exist.
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced && !context.reduceMotion) {
      return { reduceMotion: true, motion: motionProfileFor(true) };
    }
  }
  return context;
}
