import { describe, it, expect, vi, afterEach } from "vitest";
import { loadFontForLang, preloadFonts } from "../utils/fonts";
import { formatNumber, formatCurrency, formatDate } from "../utils/formatting";

// Regression: the SDK must not crash when rendered on a server (Next.js App
// Router, Astro SSR, RSC) where `document` is undefined. Font injection and
// formatters are exercised with `document` stubbed out.

describe("SSR safety", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loadFontForLang / preloadFonts are no-ops (no throw) when document is undefined", () => {
    vi.stubGlobal("document", undefined);
    expect(() => loadFontForLang("hi")).not.toThrow();
    expect(() => loadFontForLang("ur")).not.toThrow();
    expect(() => preloadFonts(["hi", "bn", "ur", "ta"])).not.toThrow();
  });

  it("formatters run with no document present", () => {
    vi.stubGlobal("document", undefined);
    expect(() => formatNumber(1234567, "hi")).not.toThrow();
    expect(() => formatCurrency(1234567, "ur")).not.toThrow();
    expect(() => formatDate("2026-03-19", "hi")).not.toThrow();
    expect(formatNumber(1234567, "hi")).toBe("12,34,567");
  });
});
