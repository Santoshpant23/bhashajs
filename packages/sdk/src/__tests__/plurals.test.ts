import { describe, it, expect } from "vitest";
import { getPluralCategory } from "../utils/plurals";

describe("getPluralCategory", () => {
  // ─── Group A: 0 AND 1 are singular ────────────────────────
  // Hindi, Bengali, Marathi, Gujarati, Kannada, Sinhala, Punjabi

  const groupA = ["hi", "bn", "mr", "gu", "kn", "si", "pa", "pa-PK"];

  describe("Group A — 0 and 1 are singular", () => {
    for (const lang of groupA) {
      it(`${lang}: 0 → "one"`, () => {
        expect(getPluralCategory(0, lang)).toBe("one");
      });

      it(`${lang}: 1 → "one"`, () => {
        expect(getPluralCategory(1, lang)).toBe("one");
      });

      it(`${lang}: 2 → "other"`, () => {
        expect(getPluralCategory(2, lang)).toBe("other");
      });

      it(`${lang}: 5 → "other"`, () => {
        expect(getPluralCategory(5, lang)).toBe("other");
      });

      it(`${lang}: 100 → "other"`, () => {
        expect(getPluralCategory(100, lang)).toBe("other");
      });
    }
  });

  // ─── Group B: Only 1 is singular ──────────────────────────
  // English, Urdu, Tamil, Telugu, Malayalam, Nepali

  const groupB = ["en", "ur", "ta", "te", "ml", "ne"];

  describe("Group B — only 1 is singular", () => {
    for (const lang of groupB) {
      it(`${lang}: 0 → "other"`, () => {
        expect(getPluralCategory(0, lang)).toBe("other");
      });

      it(`${lang}: 1 → "one"`, () => {
        expect(getPluralCategory(1, lang)).toBe("one");
      });

      it(`${lang}: 2 → "other"`, () => {
        expect(getPluralCategory(2, lang)).toBe("other");
      });

      it(`${lang}: 5 → "other"`, () => {
        expect(getPluralCategory(5, lang)).toBe("other");
      });
    }
  });

  // ─── Edge cases ───────────────────────────────────────────

  describe("edge cases", () => {
    it("negative numbers use absolute value", () => {
      expect(getPluralCategory(-1, "en")).toBe("one");
      expect(getPluralCategory(-1, "hi")).toBe("one");
      expect(getPluralCategory(-5, "en")).toBe("other");
    });

    it("unknown language defaults to Group B (only 1 is singular)", () => {
      expect(getPluralCategory(0, "xx")).toBe("other");
      expect(getPluralCategory(1, "xx")).toBe("one");
      expect(getPluralCategory(2, "xx")).toBe("other");
    });

    it("fractional numbers — 0.5 is singular in Group A", () => {
      expect(getPluralCategory(0.5, "hi")).toBe("one");
      expect(getPluralCategory(0.5, "en")).toBe("other");
    });

    it("large numbers are always plural", () => {
      expect(getPluralCategory(1000000, "hi")).toBe("other");
      expect(getPluralCategory(1000000, "en")).toBe("other");
    });
  });

  // ─── The critical difference ──────────────────────────────

  describe("the critical Hindi vs English difference", () => {
    it('Hindi: "0 आइटम" (singular) — 0 is "one"', () => {
      expect(getPluralCategory(0, "hi")).toBe("one");
    });

    it('English: "0 items" (plural) — 0 is "other"', () => {
      expect(getPluralCategory(0, "en")).toBe("other");
    });
  });

  // ─── Latin-script variants inherit base-language rules ────

  describe("Latin-script variants delegate to their base language", () => {
    it("hi-Latn (Hinglish): 0 is singular — same as Hindi", () => {
      // "0 item Hinglish mein bhi singular hi hota hai" — script doesn't change grammar.
      expect(getPluralCategory(0, "hi-Latn")).toBe("one");
      expect(getPluralCategory(1, "hi-Latn")).toBe("one");
      expect(getPluralCategory(5, "hi-Latn")).toBe("other");
    });

    it("bn-Latn (Banglish): 0 is singular — same as Bengali", () => {
      expect(getPluralCategory(0, "bn-Latn")).toBe("one");
    });

    it("pa-Latn (Roman Punjabi): 0 is singular — same as Punjabi", () => {
      expect(getPluralCategory(0, "pa-Latn")).toBe("one");
    });

    it("ne-Latn (Roman Nepali): 0 is plural — Nepali is Group B", () => {
      // Nepali itself treats 0 as plural even though it's Indo-Aryan.
      expect(getPluralCategory(0, "ne-Latn")).toBe("other");
    });

    it("ur-Latn (Roman Urdu): 0 is plural — Urdu is Group B", () => {
      expect(getPluralCategory(0, "ur-Latn")).toBe("other");
    });
  });
});
