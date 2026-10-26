/**
 * Web storage-degradation notice (issue #71, Decision 9).
 *
 * Feature-detected honesty: when browser storage is blocked (managed
 * Chromebook profiles can do this), the web edition degrades to an
 * in-memory session — everything works ONLINE, nothing persists, and
 * offline play is unavailable. This banner states exactly that; the app
 * never breaks silently. Rendered from the root layout on web only.
 *
 * The notice fires for backend "memory" AFTER detection completes
 * (detection is lazy on first storage use; the banner triggers it at
 * startup). The copy itself lives in webStorage.ts (pure,
 * test-pinned); this component only renders it.
 */
import React, { useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import { detectWebStorage, webStorageNoticeCopy, type WebStorageBackend } from "./webStorage";
import { useTheme } from "../design/theme";
import { radius, spacing, typeRamp } from "../design/tokens";

export function WebStorageNotice(): React.JSX.Element | null {
  const { colors } = useTheme();
  const [backend, setBackend] = useState<WebStorageBackend>("undetected");

  useEffect(() => {
    if (Platform.OS !== "web") return;
    void detectWebStorage().then(setBackend, () => setBackend("memory"));
  }, []);

  const copy = webStorageNoticeCopy(backend);
  if (copy === "") return null;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel="Storage blocked notice"
      testID="web-storage-notice"
      style={{
        margin: spacing.md,
        padding: spacing.md,
        borderRadius: radius.md,
        borderCurve: "continuous",
        borderWidth: 2,
        borderColor: colors.warning,
        backgroundColor: colors.surfaceTinted,
        gap: spacing.xs,
      }}
    >
      <Text style={{ ...typeRamp.label, color: colors.statusInk.warning }}>
        Storage unavailable
      </Text>
      <Text style={{ ...typeRamp.body, color: colors.text }}>{copy}</Text>
    </View>
  );
}
