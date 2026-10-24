/**
 * Token-driven theming. Screens and primitives consume semantic colors
 * through this context - never hardcoded hex values. Light/dark follow
 * the OS preference by default; the highContrast variant is the
 * accessibility escape hatch (see tokens.ts for the contrast policy).
 */
import React, { createContext, useContext, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import { themes, type ThemeColors, type ThemeMode } from "./tokens";

interface ThemeContextValue {
  mode: ThemeMode;
  colors: ThemeColors;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: "light",
  colors: themes.light,
  setMode: () => {},
});

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** Overrides the OS-derived initial mode (used by the shell demo). */
  initialMode?: ThemeMode;
}

export function ThemeProvider({ children, initialMode }: ThemeProviderProps) {
  const scheme = useColorScheme();
  const defaultMode: ThemeMode = initialMode ?? (scheme === "dark" ? "dark" : "light");
  const [mode, setMode] = useState<ThemeMode>(defaultMode);
  const value = useMemo<ThemeContextValue>(() => ({ mode, colors: themes[mode], setMode }), [mode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
