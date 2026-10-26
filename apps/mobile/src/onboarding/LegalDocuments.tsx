/**
 * Versioned legal documents, rendered in-app (issue #68, COPPA legal
 * pack): the Privacy Policy and Terms of Service fetched from the public
 * /api/legal/:kind/latest endpoints and displayed as expandable sections.
 *
 * Placement contract (tested by tests/coppa-legal.test.ts source-pins):
 * on the onboarding consent screen this component renders BEFORE the
 * "I agree" button — the parent can read the legal texts before consent
 * is captured (COPPA good practice). The same component serves the gated
 * parent area. No external links: the text is rendered in-app only.
 *
 * Failure doctrine: a failed fetch must never block consent FLOW — the
 * sections render a retry affordance instead (the consent policy itself
 * is the gating text; the legal docs are reachability companions). A
 * failed fetch also never silently hides the reachability surface: the
 * section headers stay visible with an explicit error state.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../design/theme";
import { radius, spacing, typeRamp } from "../design/tokens";
import { type ApiClient, type LegalDocumentResult } from "./api";

export interface LegalDocumentsProps {
  api: ApiClient;
  testID?: string;
}

type DocState =
  { status: "loading" } | { status: "error" } | { status: "ready"; doc: LegalDocumentResult };

const KIND_TITLES: Record<LegalDocumentResult["kind"], string> = {
  "privacy-policy": "Privacy Policy",
  "terms-of-service": "Terms of Service",
};

function LegalDocumentSection({
  kind,
  state,
  onRetry,
  testID,
}: {
  kind: LegalDocumentResult["kind"];
  state: DocState;
  onRetry: () => void;
  testID: string;
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);

  const title =
    state.status === "ready" ? `${KIND_TITLES[kind]} (v${state.doc.version})` : KIND_TITLES[kind];

  return (
    <View style={{ gap: spacing.sm }} testID={`${testID}.${kind}.section`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Read the ${KIND_TITLES[kind]}`}
        accessibilityHint={expanded ? "Collapse the document" : "Expand to read the full document"}
        onPress={() => setExpanded((v) => !v)}
        testID={`${testID}.${kind}.toggle`}
        style={({ pressed }) => ({
          minHeight: 44,
          justifyContent: "center",
          paddingHorizontal: spacing.lg,
          borderRadius: radius.md,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: pressed ? colors.primary.fill : colors.border,
          backgroundColor: colors.surface,
        })}
      >
        <Text style={{ ...typeRamp.label, color: colors.primary.label }}>{title}</Text>
      </Pressable>
      {expanded ? (
        <View
          style={{
            borderWidth: 1,
            borderRadius: radius.md,
            borderCurve: "continuous",
            borderColor: colors.border,
            backgroundColor: colors.surface,
            padding: spacing.lg,
          }}
          testID={`${testID}.${kind}.body`}
        >
          {state.status === "ready" ? (
            <Text style={{ ...typeRamp.bodyMuted, color: colors.text }}>{state.doc.body}</Text>
          ) : state.status === "loading" ? (
            <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
              Loading the {KIND_TITLES[kind]}...
            </Text>
          ) : (
            <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
              Could not load the {KIND_TITLES[kind]}.
            </Text>
          )}
        </View>
      ) : null}
      {expanded && state.status === "error" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Retry loading the ${KIND_TITLES[kind]}`}
          onPress={onRetry}
          testID={`${testID}.${kind}.retry`}
          style={{
            alignSelf: "flex-start",
            paddingHorizontal: spacing.md,
            minHeight: 44,
            justifyContent: "center",
          }}
        >
          <Text style={{ ...typeRamp.label, color: colors.primary.label }}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function LegalDocuments({ api, testID = "legal.documents" }: LegalDocumentsProps) {
  const { colors } = useTheme();
  const [docs, setDocs] = useState<Record<LegalDocumentResult["kind"], DocState>>({
    "privacy-policy": { status: "loading" },
    "terms-of-service": { status: "loading" },
  });

  const loadKind = useCallback(
    (kind: LegalDocumentResult["kind"]) => {
      setDocs((prev) => ({ ...prev, [kind]: { status: "loading" } }));
      api
        .legalLatest(kind)
        .then((doc) => {
          setDocs((prev) => ({ ...prev, [kind]: { status: "ready", doc } }));
        })
        .catch(() => {
          // Offline/unreachable legal docs never block the flow (see the
          // doctrine comment); the section shows its explicit error state.
          setDocs((prev) => ({ ...prev, [kind]: { status: "error" } }));
        });
    },
    [api],
  );

  useEffect(() => {
    // Cancellable macrotask start (the retry buttons call loadKind
    // directly); keeps state updates out of the effect body.
    const id = setTimeout(() => {
      loadKind("privacy-policy");
      loadKind("terms-of-service");
    }, 0);
    return () => clearTimeout(id);
  }, [loadKind]);

  return (
    <View style={{ gap: spacing.md }} testID={testID}>
      <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
        Read these documents before you agree:
      </Text>
      {(["privacy-policy", "terms-of-service"] as const).map((kind) => (
        <LegalDocumentSection
          key={kind}
          kind={kind}
          state={docs[kind]}
          onRetry={() => loadKind(kind)}
          testID={testID}
        />
      ))}
    </View>
  );
}
