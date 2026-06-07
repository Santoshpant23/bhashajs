import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The integration suite boots mongodb-memory-server (binary download on
    // first run + standalone mongod start), which easily exceeds vitest's
    // default 5s. Bump both the per-test and the beforeAll/afterAll hook
    // timeouts so the boot has room. Unit tests are unaffected — they finish
    // in milliseconds.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
