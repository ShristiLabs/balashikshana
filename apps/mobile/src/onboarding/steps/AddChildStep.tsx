/**
 * Step 5 - add child: avatar picker, nickname, and 4-digit PIN creation.
 * Nothing is submitted here: the draft (nickname + avatar) goes into the
 * snapshot, the PIN into the SECURE store only, and grade selection
 * (next step) completes the payload before the consent-gated create call.
 */
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button } from "../../design/primitives";
import { useTheme } from "../../design/theme";
import { MIN_TOUCH_TARGET, radius, spacing, typeRamp } from "../../design/tokens";
import { Field, StepHeading, StepScroll } from "./shared";

/** Curated emoji avatar set (server avatar field caps at 8 chars). */
export const AVATAR_CHOICES = [
  "\u{1F43C}",
  "\u{1F98A}",
  "\u{1F430}",
  "\u{1F42F}",
  "\u{1F989}",
  "\u{1F984}",
] as const;

export interface AddChildStepProps {
  initialNickname?: string;
  initialAvatar?: string;
  /** Draft accepted: PIN stashed in the secure store by the flow. */
  onDrafted: (nickname: string, avatar: string, pin: string) => void;
}

export function AddChildStep({
  initialNickname = "",
  initialAvatar = AVATAR_CHOICES[0],
  onDrafted,
}: AddChildStepProps) {
  const { colors } = useTheme();
  const [nickname, setNickname] = useState(initialNickname);
  const [avatar, setAvatar] = useState<string>(initialAvatar);
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const name = nickname.trim();
    if (name.length === 0) {
      setError("Please give your learner a name or nickname.");
      return;
    }
    if (!/^[0-9]{4}$/.test(pin)) {
      setError("The PIN is exactly 4 digits.");
      return;
    }
    if (pin !== pinConfirm) {
      setError("The PINs do not match.");
      return;
    }
    if (/^(\d)\1{3}$/.test(pin)) {
      setError("Please choose a less predictable PIN (not four of the same digit).");
      return;
    }
    setError(null);
    onDrafted(name, avatar, pin);
  };

  return (
    <StepScroll testID="onboarding.step.addChild">
      <StepHeading
        title="Add your learner"
        subtitle="Pick an avatar, choose a name your learner will see, and set a 4-digit PIN they will use to sign in on this device."
      />

      {error ? (
        <Text
          style={{ ...typeRamp.caption, color: colors.statusInk.danger }}
          accessibilityRole="alert"
        >
          {error}
        </Text>
      ) : null}

      <View style={{ gap: spacing.sm }}>
        <Text style={{ ...typeRamp.label, color: colors.text }}>Avatar</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
          {AVATAR_CHOICES.map((choice) => {
            const selected = choice === avatar;
            return (
              <Pressable
                key={choice}
                accessibilityRole="button"
                accessibilityLabel={`Avatar ${choice}`}
                accessibilityState={{ selected }}
                onPress={() => setAvatar(choice)}
                testID={`onboarding.addChild.avatar.${choice}`}
                style={{
                  minWidth: MIN_TOUCH_TARGET + 8,
                  minHeight: MIN_TOUCH_TARGET + 8,
                  borderRadius: radius.md,
                  borderCurve: "continuous",
                  borderWidth: selected ? 3 : 2,
                  borderColor: selected ? colors.primary.fillBottom : colors.border,
                  backgroundColor: selected ? colors.surfaceTinted : colors.surface,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ fontSize: 32 }}>{choice}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Field
        label="Name"
        value={nickname}
        onChangeText={setNickname}
        maxLength={32}
        autoCapitalize="words"
        testID="onboarding.addChild.nickname"
      />
      <Field
        label="Learner PIN (4 digits)"
        value={pin}
        onChangeText={setPin}
        keyboardType="number-pad"
        maxLength={4}
        secureTextEntry
        testID="onboarding.addChild.pin"
      />
      <Field
        label="Repeat PIN"
        value={pinConfirm}
        onChangeText={setPinConfirm}
        keyboardType="number-pad"
        maxLength={4}
        secureTextEntry
        testID="onboarding.addChild.pinConfirm"
      />

      <Button
        label="Continue"
        onPress={submit}
        accessibilityHint="Save the draft learner profile and choose a grade"
        testID="onboarding.addChild.submit"
      />
    </StepScroll>
  );
}
