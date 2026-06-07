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
  },
});
