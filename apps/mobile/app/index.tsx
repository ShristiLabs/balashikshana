import React, { useState } from "react";
import { ScrollView, View, Text, Pressable } from "react-native";

const WINDING_OFFSETS = [0, -42, -68, -36, 18, 56, 32, -14];

export default function DuolingoJourneyScreen() {
  const [loggedIn, setLoggedIn] = useState(true);
  const [selectedSubject, setSelectedSubject] = useState("math");

  const sampleUnits = [
    {
      unitId: "K-M1",
      title: "Numbers, Counting & Comparing to 5",
      color: "#58CC02",
      topics: [
        { code: "A", name: "Numbers to 3", status: "completed", crowns: 3 },
        { code: "B", name: "Counting to 3", status: "completed", crowns: 3 },
        { code: "C", name: "Numbers to 5", status: "completed", crowns: 3 },
        { code: "D", name: "Counting to 5", status: "completed", crowns: 3 }
      ]
    },
    {
      unitId: "K-M2",
      title: "Numbers, Cardinality & Comparing to 10",
      color: "#1CB0F6",
      topics: [
        { code: "G", name: "Numbers & counting to 7", status: "completed", crowns: 3 },
        { code: "H", name: "Numbers & counting to 9", status: "completed", crowns: 2 },
        { code: "I", name: "Numbers to 10", status: "current", crowns: 0 },
        { code: "J", name: "Counting to 10", status: "locked", crowns: 0 }
      ]
    }
  ];

  if (!loggedIn) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 24, gap: 16 }}>
        <Text style={{ fontSize: 28, fontWeight: "900", textAlign: "center" }}>Balashikshana</Text>
        <Pressable
          onPress={() => setLoggedIn(true)}
          style={{ backgroundColor: "#58CC02", padding: 16, borderRadius: 16, borderCurve: "continuous" }}
        >
          <Text style={{ color: "#FFF", fontWeight: "800", textAlign: "center" }}>LOG IN AS AARAV (KINDERGARTEN)</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, gap: 24, alignItems: "center" }}
    >
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        {["math", "ela", "science", "socialStudies"].map((subj) => (
          <Pressable
            key={subj}
            onPress={() => setSelectedSubject(subj)}
            style={{
              paddingVertical: 8,
              paddingHorizontal: 16,
              borderRadius: 14,
              borderCurve: "continuous",
              backgroundColor: selectedSubject === subj ? "#1CB0F6" : "#E5E5E5"
            }}
          >
            <Text style={{ fontWeight: "800", color: selectedSubject === subj ? "#FFF" : "#3C3C3C" }}>
              {subj.toUpperCase()}
            </Text>
          </Pressable>
        ))}
      </View>

      {sampleUnits.map((unit) => (
        <View key={unit.unitId} style={{ width: "100%", maxWidth: 540, gap: 20, alignItems: "center" }}>
          <View
            style={{
              width: "100%",
              padding: 18,
              borderRadius: 20,
              borderCurve: "continuous",
              backgroundColor: unit.color
            }}
          >
            <Text selectable style={{ color: "#FFF", fontWeight: "900", fontSize: 18 }}>
              {unit.unitId}: {unit.title}
            </Text>
          </View>

          {unit.topics.map((t, idx) => (
            <View
              key={t.code}
              style={{
                alignItems: "center",
                transform: [{ translateX: WINDING_OFFSETS[idx % WINDING_OFFSETS.length] }]
              }}
            >
              <Pressable
                style={{
                  width: 72,
                  height: 66,
                  borderRadius: 36,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor:
                    t.status === "completed" ? "#FFC800" : t.status === "current" ? "#58CC02" : "#E5E5E5"
                }}
              >
                <Text style={{ fontSize: 24, fontWeight: "900", color: t.status === "locked" ? "#999" : "#FFF" }}>
                  {t.status === "completed" ? "✓" : t.status === "current" ? "★" : "🔒"}
                </Text>
              </Pressable>
              <Text style={{ marginTop: 6, fontWeight: "800", fontSize: 13 }}>
                {t.code}. {t.name}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}
