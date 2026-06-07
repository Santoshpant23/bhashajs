import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// jsdom harness so we can render real React components (the editor's
// keyboard/save flow) with @testing-library, alongside the existing plain
// logic tests. The React plugin lets vitest transform .tsx/JSX. The setup
// file wires @testing-library/jest-dom matchers + auto-cleanup.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // jsdom component tests render the real editor and drive it with
    // user-event. Under parallel CI load a single render+interaction can take
    // noticeably longer than vitest's 5s default and time out spuriously (the
    // editor's escape test flaked once this way). Give every test and hook a
    // generous ceiling so a slow-but-correct run never reads as a failure.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
