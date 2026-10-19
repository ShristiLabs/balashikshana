import { Stack } from "expo-router/stack";

export default function RootLayout() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: "#FFFDF7" }
      }}
    >
      <Stack.Screen name="index" options={{ title: "Balashikshana (Pre-K to Grade 3)" }} />
    </Stack>
  );
}
