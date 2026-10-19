import React, { useState } from "react";
import { ScrollView, View, Text, Pressable } from "react-native";

export default function HomeScreen() {
  const [selectedGrade, setSelectedGrade] = useState("kindergarten");

  const grades = [
    { id: "pre-k", label: "Pre-K (3–4 yrs)" },
    { id: "kindergarten", label: "Kindergarten (5–6 yrs)" },
    { id: "grade-1", label: "Grade 1 (6–7 yrs)" },
    { id: "grade-2", label: "Grade 2 (7–8 yrs)" },
    { id: "grade-3", label: "Grade 3 (8–9 yrs)" }
  ];

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, gap: 18 }}
    >
      <View
        style={{
          padding: 20,
          borderRadius: 20,
          borderCurve: "continuous",
          backgroundColor: "#FFF4D6",
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.06)",
          gap: 8
        }}
      >
        <Text selectable style={{ fontSize: 22, fontWeight: "800", color: "#1E293B" }}>
          Mastery-Gated US Curriculum Adventure
        </Text>
        <Text selectable style={{ fontSize: 15, color: "#475569" }}>
          130 Sequential Units • 614 Skill Topics • Accuracy + Speed Boss Gates • Scientific Spaced Repetition
        </Text>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {grades.map((g) => (
          <Pressable
            key={g.id}
            onPress={() => setSelectedGrade(g.id)}
            style={{
              paddingVertical: 10,
              paddingHorizontal: 16,
              borderRadius: 14,
              borderCurve: "continuous",
              backgroundColor: selectedGrade === g.id ? "#0D9488" : "#F1F5F9"
            }}
          >
            <Text
              style={{
                fontWeight: "700",
                color: selectedGrade === g.id ? "#FFFFFF" : "#334155"
              }}
            >
              {g.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}
