/**
 * Root audio bootstrap (issue #45): initializes the AudioCoordinator once
 * at app start - audio session mode, persisted settings, SFX preload -
 * so screens (#50 practice runner, #51 boss gate, #59 narration) consume
 * a ready service via getAudioService(). Failures degrade to warnings:
 * a child's session must never crash because audio hardware is missing.
 */
import React, { useEffect } from "react";
import { getAudioService } from "./nativeAudio";

export function AudioServiceProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    getAudioService().catch(() => {
      // getAudioService warns per failure path; boot continues silent.
    });
  }, []);

  return <>{children}</>;
}
