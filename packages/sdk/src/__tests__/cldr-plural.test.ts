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
