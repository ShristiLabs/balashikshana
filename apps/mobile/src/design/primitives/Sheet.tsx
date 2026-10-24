/**
 * Bottom sheet primitive. The slide-up transition reads its duration
 * from the motion profile: when the OS reduced-motion setting is on the
 * duration is 0 and the sheet renders at rest instantly - no animation
 * in this shell is load-bearing. Uses RN Animated (no native-driver
 * requirement inside a Modal) so behavior is identical on both platforms.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Animated, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme";
import { useReducedMotion } from "../useMotion";
import { radius, spacing, typeRamp } from "../tokens";

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  testID?: string;
}

export function Sheet({ visible, onClose, title, children, testID }: SheetProps) {
  const { colors } = useTheme();
  const { motion } = useReducedMotion();
  // Animated.Value is stable instance state, held in useState (not a ref)
  // so it is never read from a ref during render.
  const [slide] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (visible) {
      Animated.timing(slide, {
        toValue: 1,
        duration: motion.durationMs,
        useNativeDriver: false,
      }).start();
    } else {
      slide.setValue(0);
    }
  }, [visible, slide, motion.durationMs]);

  const closeSheet = useCallback(() => onClose(), [onClose]);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={closeSheet}>
      <View style={styles.root} testID={testID}>
        <Pressable
          accessibilityLabel="Close sheet"
          accessibilityRole="button"
          onPress={closeSheet}
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]}
        />
        <Animated.View
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            borderTopWidth: 2,
            borderColor: colors.border,
            paddingTop: spacing.sm,
            paddingHorizontal: spacing.xxl,
            paddingBottom: spacing.xxxl,
            transform: [
              {
                translateY: slide.interpolate({
                  inputRange: [0, 1],
                  outputRange: [320, 0],
                }),
              },
            ],
          }}
        >
          <View style={[styles.handle, { backgroundColor: colors.border }]} />
          <Text style={{ ...typeRamp.h3, color: colors.text, marginBottom: spacing.lg }}>
            {title}
          </Text>
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "flex-end",
  },
  handle: {
    alignSelf: "center",
    width: 44,
    height: 5,
    borderRadius: 999,
    marginBottom: 12,
  },
});
