import { defineConfig } from "vitest/config";

// Lean harness: node env, plain .ts tests only (no jsdom/component rendering
// yet). This establishes the runner + a CI gate for the dashboard's testable
// logic; richer testing-library coverage of the editor flows is a follow-up.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
