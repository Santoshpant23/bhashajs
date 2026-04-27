// FILE: packages/sdk/src/utils/plurals.ts
//
// CLDR-compliant pluralization for South Asian languages.
//
// WHY THIS IS CRITICAL:
// Hindi treats 0 as singular: "0 आइटम" (not "0 आइटमें")
// English treats 0 as plural: "0 items" (not "0 item")
//
// Most i18n tools apply English rules globally. This means Hindi
// pluralization is WRONG in every app using i18next without custom
// configuration. BhashaJS handles this correctly out of the box.
//
// CLDR PLURAL RULES (simplified for South Asian languages):
// We only need "one" and "other" categories. More complex languages
// (like Arabic with dual/few) are not in our scope.
//
// Group A — 0 AND 1 are "one" (singular):
//   Hindi, Bengali, Marathi, Gujarati, Kannada, Sinhala, Punjabi
//   Rule: n is 0 or n is 1 → "one"
//
// Group B — Only 1 is "one" (singular):
//   English, Urdu, Tamil, Telugu, Malayalam, Nepali
//   Rule: n is 1 → "one"
//
// Source: Unicode CLDR plural rules
// https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html

/**
 * Languages where BOTH 0 and 1 are treated as singular ("one").
 * This is the South Asian plural rule that most tools get wrong.
 *
 * Latin-script variants (hi-Latn, bn-Latn, pa-Latn) inherit from their base
 * language — switching scripts doesn't change grammatical number rules. The
 * `getPluralCategory` function strips the `-Latn` suffix before lookup.
 */
const ZERO_AND_ONE_SINGULAR = new Set([
  "hi",     // Hindi
  "bn",     // Bengali
  "mr",     // Marathi
  "gu",     // Gujarati
  "kn",     // Kannada
  "si",     // Sinhala
  "pa",     // Punjabi (Gurmukhi)
  "pa-PK",  // Punjabi (Shahmukhi)
]);

/**
 * Map a locale code to its base language for plural-rule lookup.
 * `hi-Latn` → `hi`. `pa-PK` is intentionally NOT stripped because it's a
 * full locale (different script), not a romanization.
 */
function baseLangForPlurals(lang: string): string {
  return lang.endsWith("-Latn") ? lang.slice(0, -5) : lang;
}

/**
 * Get the CLDR plural category for a number in a given language.
 *
 * @param count - The number to pluralize (e.g. 0, 1, 5)
 * @param lang  - The language code (e.g. "hi", "en")
 * @returns "one" (singular) or "other" (plural)
 *
 * @example
 * getPluralCategory(0, "en")  // → "other"  (English: "0 items")
 * getPluralCategory(0, "hi")  // → "one"    (Hindi: "0 आइटम")
 * getPluralCategory(1, "en")  // → "one"    (English: "1 item")
 * getPluralCategory(1, "hi")  // → "one"    (Hindi: "1 आइटम")
 * getPluralCategory(5, "en")  // → "other"  (English: "5 items")
 * getPluralCategory(5, "hi")  // → "other"  (Hindi: "5 आइटमें")
 */
export function getPluralCategory(
  count: number,
  lang: string
): "one" | "other" {
  // Use the absolute value for negative numbers
  const n = Math.abs(count);
  const base = baseLangForPlurals(lang);

  if (ZERO_AND_ONE_SINGULAR.has(base)) {
    // Group A: 0 and 1 are singular
    return n >= 0 && n <= 1 ? "one" : "other";
  }

  // Group B (English, Urdu, Tamil, Telugu, Malayalam, Nepali, and any unknown):
  // Only 1 is singular
  return n === 1 ? "one" : "other";
}
