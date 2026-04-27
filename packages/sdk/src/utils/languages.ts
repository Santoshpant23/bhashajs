// FILE: packages/sdk/src/utils/languages.ts
//
// This file is a KEY DIFFERENTIATOR of BhashaJS.
//
// Other i18n libraries like i18next treat every language the same —
// they just swap strings. They don't know that Urdu is right-to-left,
// that Hindi needs a specific font to render conjuncts properly, or
// that Nepali should fall back to Hindi before falling back to English.
//
// BhashaJS ships with this knowledge built in. When a developer adds
// Urdu support, we automatically handle RTL. When they add Bengali,
// we know which font to load and which numbering system to use.
//
// This is what makes us purpose-built for South Asian languages.

import { LangInfo } from "../types";

/**
 * Built-in language database — 14 entries covering 13 languages.
 * (Punjabi has two entries: Gurmukhi for India, Shahmukhi for Pakistan)
 *
 * Every South Asian language we support has:
 * - Its name in its own script (so the switcher shows हिन्दी not "Hindi")
 * - Text direction (RTL for Urdu/Shahmukhi Punjabi)
 * - A recommended Google Font that properly renders the script
 * - Default region, locale, currency, and numbering system for formatting
 */
export const LANGUAGES: Record<string, LangInfo> = {
  en: {
    code: "en",
    name: "English",
    englishName: "English",
    dir: "ltr",
    font: "Inter, sans-serif",
    script: "Latin",
    defaultRegion: "IN",
    intlLocale: "en-IN",
    numberingSystem: "latn",
    defaultCurrency: "INR",
  },
  hi: {
    code: "hi",
    name: "हिन्दी",
    englishName: "Hindi",
    dir: "ltr",
    font: "Noto Sans Devanagari, sans-serif",
    script: "Devanagari",
    defaultRegion: "IN",
    intlLocale: "hi-IN",
    numberingSystem: "deva",
    defaultCurrency: "INR",
  },
  bn: {
    code: "bn",
    name: "বাংলা",
    englishName: "Bengali",
    dir: "ltr",
    font: "Noto Sans Bengali, sans-serif",
    script: "Bengali",
    defaultRegion: "BD",
    intlLocale: "bn-BD",
    numberingSystem: "beng",
    defaultCurrency: "BDT",
  },
  ur: {
    code: "ur",
    name: "اردو",
    englishName: "Urdu",
    dir: "rtl",
    font: "Noto Nastaliq Urdu, serif",
    script: "Nastaliq",
    defaultRegion: "PK",
    intlLocale: "ur-PK",
    numberingSystem: "arabext",
    defaultCurrency: "PKR",
  },
  ta: {
    code: "ta",
    name: "தமிழ்",
    englishName: "Tamil",
    dir: "ltr",
    font: "Noto Sans Tamil, sans-serif",
    script: "Tamil",
    defaultRegion: "IN",
    intlLocale: "ta-IN",
    numberingSystem: "tamldec",
    defaultCurrency: "INR",
  },
  te: {
    code: "te",
    name: "తెలుగు",
    englishName: "Telugu",
    dir: "ltr",
    font: "Noto Sans Telugu, sans-serif",
    script: "Telugu",
    defaultRegion: "IN",
    intlLocale: "te-IN",
    numberingSystem: "telu",
    defaultCurrency: "INR",
  },
  mr: {
    code: "mr",
    name: "मराठी",
    englishName: "Marathi",
    dir: "ltr",
    font: "Noto Sans Devanagari, sans-serif",
    script: "Devanagari",
    defaultRegion: "IN",
    intlLocale: "mr-IN",
    numberingSystem: "deva",
    defaultCurrency: "INR",
  },
  ne: {
    code: "ne",
    name: "नेपाली",
    englishName: "Nepali",
    dir: "ltr",
    font: "Noto Sans Devanagari, sans-serif",
    script: "Devanagari",
    defaultRegion: "NP",
    intlLocale: "ne-NP",
    numberingSystem: "deva",
    defaultCurrency: "NPR",
  },
  pa: {
    code: "pa",
    name: "ਪੰਜਾਬੀ",
    englishName: "Punjabi",
    dir: "ltr",
    font: "Noto Sans Gurmukhi, sans-serif",
    script: "Gurmukhi",
    defaultRegion: "IN",
    intlLocale: "pa-IN",
    numberingSystem: "guru",
    defaultCurrency: "INR",
  },
  "pa-PK": {
    code: "pa-PK",
    name: "پنجابی",
    englishName: "Punjabi (Shahmukhi)",
    dir: "rtl",
    font: "Noto Nastaliq Urdu, serif",
    script: "Shahmukhi",
    defaultRegion: "PK",
    intlLocale: "pa-Arab-PK",
    numberingSystem: "arabext",
    defaultCurrency: "PKR",
  },
  gu: {
    code: "gu",
    name: "ગુજરાતી",
    englishName: "Gujarati",
    dir: "ltr",
    font: "Noto Sans Gujarati, sans-serif",
    script: "Gujarati",
    defaultRegion: "IN",
    intlLocale: "gu-IN",
    numberingSystem: "gujr",
    defaultCurrency: "INR",
  },
  kn: {
    code: "kn",
    name: "ಕನ್ನಡ",
    englishName: "Kannada",
    dir: "ltr",
    font: "Noto Sans Kannada, sans-serif",
    script: "Kannada",
    defaultRegion: "IN",
    intlLocale: "kn-IN",
    numberingSystem: "knda",
    defaultCurrency: "INR",
  },
  ml: {
    code: "ml",
    name: "മലയാളം",
    englishName: "Malayalam",
    dir: "ltr",
    font: "Noto Sans Malayalam, sans-serif",
    script: "Malayalam",
    defaultRegion: "IN",
    intlLocale: "ml-IN",
    numberingSystem: "mlym",
    defaultCurrency: "INR",
  },
  si: {
    code: "si",
    name: "සිංහල",
    englishName: "Sinhala",
    dir: "ltr",
    font: "Noto Sans Sinhala, sans-serif",
    script: "Sinhala",
    defaultRegion: "LK",
    intlLocale: "si-LK",
    numberingSystem: "sinh",
    defaultCurrency: "LKR",
  },

  // ─── Latin-script (Romanized) variants — first-class locales ──────────
  //
  // These are NOT "broken" Hindi/Urdu/etc. — they're how Gen-Z South Asians
  // actually type. WhatsApp, Twitter, Discord, dating apps, casual product
  // copy: Latin script dominates. Treating them as their own locales (with
  // their own translation memory, plural rules, fallback chains) is the
  // unique edge no generic i18n tool offers.
  //
  // Naming follows the BCP 47 convention `<lang>-Latn`. The native `name`
  // uses the colloquial term Gen-Z users recognize ("Hinglish", "Banglish").

  "hi-Latn": {
    code: "hi-Latn",
    name: "Hinglish",
    englishName: "Hindi (Roman)",
    dir: "ltr",
    font: "Inter, sans-serif",
    script: "Latin",
    defaultRegion: "IN",
    intlLocale: "hi-Latn-IN",
    numberingSystem: "latn",
    defaultCurrency: "INR",
  },
  "ne-Latn": {
    code: "ne-Latn",
    name: "Roman Nepali",
    englishName: "Nepali (Roman)",
    dir: "ltr",
    font: "Inter, sans-serif",
    script: "Latin",
    defaultRegion: "NP",
    intlLocale: "ne-Latn-NP",
    numberingSystem: "latn",
    defaultCurrency: "NPR",
  },
  "ur-Latn": {
    code: "ur-Latn",
    name: "Roman Urdu",
    englishName: "Urdu (Roman)",
    dir: "ltr",
    font: "Inter, sans-serif",
    script: "Latin",
    defaultRegion: "PK",
    intlLocale: "ur-Latn-PK",
    numberingSystem: "latn",
    defaultCurrency: "PKR",
  },
  "bn-Latn": {
    code: "bn-Latn",
    name: "Banglish",
    englishName: "Bengali (Roman)",
    dir: "ltr",
    font: "Inter, sans-serif",
    script: "Latin",
    defaultRegion: "BD",
    intlLocale: "bn-Latn-BD",
    numberingSystem: "latn",
    defaultCurrency: "BDT",
  },
  "pa-Latn": {
    code: "pa-Latn",
    name: "Roman Punjabi",
    englishName: "Punjabi (Roman)",
    dir: "ltr",
    font: "Inter, sans-serif",
    script: "Latin",
    defaultRegion: "IN",
    intlLocale: "pa-Latn-IN",
    numberingSystem: "latn",
    defaultCurrency: "INR",
  },
};

/**
 * Culturally-aware fallback chains.
 *
 * WHY THIS MATTERS:
 * If a Bengali translation is missing, what should we show?
 * Most i18n tools fall back to English. But a Bengali speaker
 * is more likely to understand Hindi than English. So we fall
 * back to Hindi first, then English.
 *
 * IMPORTANT: Dravidian languages (Tamil, Telugu, Kannada, Malayalam)
 * do NOT fall back to Hindi. They're from a completely different
 * language family. A Tamil speaker is NOT more likely to understand
 * Hindi than English.
 *
 * Developers can override these in the config if they want.
 */
export const FALLBACK_CHAINS: Record<string, string[]> = {
  en: ["en"],
  hi: ["hi", "en"],
  bn: ["bn", "hi", "en"],        // Bengali → Hindi → English
  ur: ["ur", "hi", "en"],        // Urdu → Hindi → English (mutually intelligible spoken)
  ta: ["ta", "en"],              // Tamil → English (Dravidian — NO Hindi fallback)
  te: ["te", "en"],              // Telugu → English (Dravidian — NO Hindi fallback)
  mr: ["mr", "hi", "en"],        // Marathi → Hindi → English (both Devanagari)
  ne: ["ne", "hi", "en"],        // Nepali → Hindi → English (very close to Hindi)
  pa: ["pa", "hi", "en"],        // Punjabi (India) → Hindi → English
  "pa-PK": ["pa-PK", "ur", "en"],// Punjabi (Pakistan) → Urdu → English
  gu: ["gu", "hi", "en"],        // Gujarati → Hindi → English
  kn: ["kn", "en"],              // Kannada → English (Dravidian — NO Hindi fallback)
  ml: ["ml", "en"],              // Malayalam → English (Dravidian — NO Hindi fallback)
  si: ["si", "en"],              // Sinhala → English

  // Latin-script chains. Key insight: script bridges harder than language
  // family does. A Roman-Hindi reader prefers English over Devanagari Hindi
  // because the script flip is a worse experience than the language gap.
  "hi-Latn": ["hi-Latn", "en"],                    // Hinglish → English
  "ne-Latn": ["ne-Latn", "hi-Latn", "en"],         // Roman Nepali → Hinglish → English (same script + close lang)
  "ur-Latn": ["ur-Latn", "hi-Latn", "en"],         // Roman Urdu → Hinglish → English (mutually intelligible)
  "bn-Latn": ["bn-Latn", "en"],                    // Banglish → English (Bengali doesn't bridge to Hindi well in Latin)
  "pa-Latn": ["pa-Latn", "hi-Latn", "en"],         // Roman Punjabi → Hinglish → English
};

/**
 * Region overrides for languages that span multiple countries.
 *
 * Some languages are spoken across borders with different currencies:
 * - Bengali: Bangladesh (৳ Taka) vs India (₹ Rupee)
 * - Tamil: India (₹ Rupee) vs Sri Lanka (Rs)
 * - Urdu: Pakistan (Rs) vs India (₹ Rupee)
 *
 * Developers pass region="IN" to <I18nProvider> to override defaults.
 * The key format is "{langCode}-{regionCode}".
 */
export const REGION_OVERRIDES: Record<string, { currency: string; intlLocale: string }> = {
  "bn-IN": { currency: "INR", intlLocale: "bn-IN" },
  "ta-LK": { currency: "LKR", intlLocale: "ta-LK" },
  "ur-IN": { currency: "INR", intlLocale: "ur-IN" },
  "si-IN": { currency: "INR", intlLocale: "si-IN" },
  "ne-IN": { currency: "INR", intlLocale: "ne-IN" },
};

/**
 * Get language info. Returns a default for unknown languages
 * so the SDK never crashes on an unrecognized code.
 */
export function getLangInfo(code: string): LangInfo {
  return LANGUAGES[code] || {
    code,
    name: code,
    englishName: code,
    dir: "ltr" as const,
    font: "sans-serif",
    script: "Unknown",
    defaultRegion: "IN",
    intlLocale: code,
    numberingSystem: "latn",
    defaultCurrency: "INR",
  };
}

/**
 * Get the fallback chain for a language.
 * If no custom chain exists, defaults to [lang, "en"].
 */
export function getFallbackChain(lang: string): string[] {
  return FALLBACK_CHAINS[lang] || [lang, "en"];
}

/**
 * Resolve the effective locale and currency for a language + optional region.
 * Checks REGION_OVERRIDES first, then falls back to the language's defaults.
 */
export function resolveRegion(
  lang: string,
  region?: string
): { intlLocale: string; currency: string } {
  const langInfo = getLangInfo(lang);

  if (region) {
    const overrideKey = `${lang}-${region}`;
    const override = REGION_OVERRIDES[overrideKey];
    if (override) {
      return { intlLocale: override.intlLocale, currency: override.currency };
    }
    // If no specific override, just swap the region in the locale
    return {
      intlLocale: `${lang}-${region}`,
      currency: langInfo.defaultCurrency,
    };
  }

  return {
    intlLocale: langInfo.intlLocale,
    currency: langInfo.defaultCurrency,
  };
}

/**
 * Google Fonts CSS URLs for each script.
 * We only load the fonts that are actually needed.
 */
export const FONT_URLS: Record<string, string> = {
  "Noto Sans Devanagari":
    "https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;500;600;700&display=swap",
  "Noto Sans Bengali":
    "https://fonts.googleapis.com/css2?family=Noto+Sans+Bengali:wght@400;500;600;700&display=swap",
  "Noto Nastaliq Urdu":
    "https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu:wght@400;500;600;700&display=swap",
  "Noto Sans Tamil":
    "https://fonts.googleapis.com/css2?family=Noto+Sans+Tamil:wght@400;500;600;700&display=swap",
  "Noto Sans Telugu":
    "https://fonts.googleapis.com/css2?family=Noto+Sans+Telugu:wght@400;500;600;700&display=swap",
  "Noto Sans Gurmukhi":
    "https://fonts.googleapis.com/css2?family=Noto+Sans+Gurmukhi:wght@400;500;600;700&display=swap",
  "Noto Sans Gujarati":
    "https://fonts.googleapis.com/css2?family=Noto+Sans+Gujarati:wght@400;500;600;700&display=swap",
  "Noto Sans Kannada":
    "https://fonts.googleapis.com/css2?family=Noto+Sans+Kannada:wght@400;500;600;700&display=swap",
  "Noto Sans Malayalam":
    "https://fonts.googleapis.com/css2?family=Noto+Sans+Malayalam:wght@400;500;600;700&display=swap",
  "Noto Sans Sinhala":
    "https://fonts.googleapis.com/css2?family=Noto+Sans+Sinhala:wght@400;500;600;700&display=swap",
};
