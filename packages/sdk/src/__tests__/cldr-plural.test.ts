import { describe, it, expect } from "vitest";
import { getPluralCategory } from "../utils/plurals";

// CLDR GOLDEN TEST.
// getPluralCategory must agree with the platform's Intl.PluralRules for every
// supported language at integer counts — EXCEPT a tiny, explicit allowlist of
// DELIBERATE product divergences. If a NEW divergence appears (e.g. someone
// edits the plural table), this test fails so it can't slip in silently.

const LANGS = [
  "en", "hi", "bn", "mr", "gu", "kn", "si", "pa", "pa-PK", "ur", "ta", "te", "ml", "ne",
];
const COUNTS = [0, 1, 2, 5, 11, 100];

// Keyed "lang:count" -> the SDK's intended category. Marathi 0: ICU/CLDR
// classifies it "other", but BhashaJS deliberately treats 0 as singular for the
// South-Asian "0-as-singular" contract (see plurals.ts). Keep this list TINY
// and reviewed — every entry is a conscious product decision, not a bug.
const DELIBERATE: Record<string, "one" | "other"> = {
  "mr:0": "one",
};

describe("getPluralCategory — CLDR golden (vs Intl.PluralRules)", () => {
  for (const lang of LANGS) {
    for (const count of COUNTS) {
      const key = `${lang}:${count}`;
      it(`${lang} @ ${count} matches CLDR (or is a documented divergence)`, () => {
        const sdk = getPluralCategory(count, lang);
        const intl = new Intl.PluralRules(lang).select(count) === "one" ? "one" : "other";
        if (DELIBERATE[key]) {
          expect(sdk).toBe(DELIBERATE[key]); // intentional
          expect(sdk).not.toBe(intl); // and it genuinely diverges from CLDR
        } else {
          expect(sdk).toBe(intl); // must match CLDR
        }
      });
    }
  }
});

// DECIMAL GOLDEN. The old hand-rolled table classified ANY value in [0, 1] as
// "one" for Group-A languages, which diverges from CLDR at decimals for
// Sinhala/Punjabi/Marathi (Intl: 0.5 → "other"). The v0.4 rewrite defers
// non-zero counts to Intl.PluralRules, so decimals now match CLDR exactly.
// The ONLY surviving divergence is the deliberate 0-as-singular override.
const DECIMALS = [0.5, 1.5, 2.5];

describe("getPluralCategory — decimal CLDR golden (the v0.4 fix)", () => {
  for (const lang of LANGS) {
    for (const count of DECIMALS) {
      it(`${lang} @ ${count} matches Intl.PluralRules`, () => {
        const sdk = getPluralCategory(count, lang);
        const intl = new Intl.PluralRules(lang).select(count) === "one" ? "one" : "other";
        expect(sdk).toBe(intl); // no decimal divergences — all defer to CLDR
      });
    }
  }

  it("si/pa/mr @ 0.5 are now CLDR-correct 'other' (regression — old table said 'one')", () => {
    expect(getPluralCategory(0.5, "si")).toBe("other");
    expect(getPluralCategory(0.5, "pa")).toBe("other");
    expect(getPluralCategory(0.5, "mr")).toBe("other");
  });

  it("hi/bn/gu/kn @ 0.5 stay 'one' — CLDR agrees these are singular", () => {
    expect(getPluralCategory(0.5, "hi")).toBe("one");
    expect(getPluralCategory(0.5, "bn")).toBe("one");
    expect(getPluralCategory(0.5, "gu")).toBe("one");
    expect(getPluralCategory(0.5, "kn")).toBe("one");
  });

  it("the deliberate 0-as-singular override survives the Intl rewrite", () => {
    // Marathi 0 is the one intentional divergence: Intl says "other", we force "one".
    expect(getPluralCategory(0, "mr")).toBe("one");
    expect(new Intl.PluralRules("mr").select(0)).toBe("other");
    // But Marathi non-zero decimals follow CLDR.
    expect(getPluralCategory(0.5, "mr")).toBe("other");
  });
});
