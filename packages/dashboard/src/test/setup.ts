// Vitest setup for jsdom component tests.
// - Adds @testing-library/jest-dom matchers (toBeInTheDocument, etc.).
// - Auto-cleans the rendered DOM between tests so renders don't leak.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
