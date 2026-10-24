/**
 * Device identity helpers (issue #44): platform mapping for the API enum
 * and client-device-id generation (injectable randomness).
 */
import { describe, expect, it } from "vitest";
import { mapPlatform, newClientDeviceId } from "../src/onboarding/device";

describe("mapPlatform", () => {
  it("maps react-native Platform.OS values onto the server enum", () => {
    expect(mapPlatform("ios")).toBe("ios");
    expect(mapPlatform("android")).toBe("android");
    expect(mapPlatform("web")).toBe("web");
  });

  it("unknown OS values fail safe to web (the widest posture)", () => {
    expect(mapPlatform("windows")).toBe("web");
    expect(mapPlatform("macos")).toBe("web");
    expect(mapPlatform("")).toBe("web");
  });
});

describe("newClientDeviceId", () => {
  it("produces server-schema-valid ids (>= 8 chars, prefix shape)", () => {
    const id = newClientDeviceId();
    expect(id.startsWith("dev-app-")).toBe(true);
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is deterministic under an injected rng and varies across rng values", () => {
    const seq = () => 0.5;
    expect(newClientDeviceId(seq)).toBe(newClientDeviceId(seq));
    expect(newClientDeviceId(seq)).not.toBe(newClientDeviceId(() => 0.9));
  });
});
