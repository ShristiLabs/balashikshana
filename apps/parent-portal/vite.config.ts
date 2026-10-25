import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Dev server pins port 4300 — the origin the API's CORS dev allowlist
// carries for the portal (server.mjs ALLOWED_ORIGINS default). In
// production the built dist/ is served from whatever origin the
// deployment fronts (the production ALLOWED_ORIGINS env lists it).
export default defineConfig({
  plugins: [react()],
  server: { port: 4300, strictPort: true },
  preview: { port: 4300, strictPort: true },
  build: { sourcemap: false, target: "es2022" },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"]
  }
});
