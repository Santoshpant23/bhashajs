// FILE: packages/sdk/src/utils/formatting.ts
//
// South Asian number, currency, and date formatting.
//
// WHY THIS EXISTS:
// South Asia uses a different number grouping system than the West:
//   Western:     1,234,567     (groups of 3)
//   South Asian: 12,34,567     (first group of 3, then groups of 2)
//
// This is called the lakh/crore system:
//   1,00,000 = 1 lakh (100 thousand)
//   1,00,00,000 = 1 crore (10 million)
//
// Additionally, many South Asian scripts have their own digit glyphs:
//   Hindi: ०१२३४५६७८९  Bengali: ০১২৩৪৫৬৭৮৯  Tamil: ௦௧௨௩௪௫௬௭௮௯
//
// The Intl.NumberFormat API supports both lakh/crore grouping and
// native digits via locale extensions (-u-nu-deva for Devanagari).
// We wrap it with a clean API that auto-detects the right settings.

import { NumberFormatOptions, CurrencyFormatOptions, DateFormatOptions } from "../types";
import { getLangInfo, resolveRegion } from "./languages";

/**
 * Format a number using South Asian conventions.
 *
 * Uses lakh/crore grouping automatically for South Asian locales.
 * Supports native digit rendering and compact notation.
 *
 * @param value   - The number to format
 * @param lang    - Language code (e.g. "hi", "bn")
 * @param region  - Optional region override (e.g. "IN", "BD")
 * @param options - Formatting options
 *
 * @example
 * formatNumber(1234567, "hi")                          // → "12,34,567"
 * formatNumber(1234567, "hi", undefined, { useNativeDigits: true })  // → "१२,३४,५६७"
 * formatNumber(1234567, "en")                          // → "12,34,567" (en-IN uses lakh/crore)
 * formatNumber(1500000, "hi", undefined, { compact: true })          // → "15 लाख"
 */
export function formatNumber(
  value: number,
  lang: string,
  region?: string,
  options?: NumberFormatOptions
): string {
  const langInfo = getLangInfo(lang);
  const { intlLocale } = resolveRegion(lang, region);

  // Build the locale string. Force Latin digits unless the caller explicitly
  // opts in via useNativeDigits — otherwise some locales (bn-BD, ta-IN) silently
  // emit native digits even when the developer passed nothing about digits.
  let locale = intlLocale;
  if (options?.useNativeDigits && langInfo.numberingSystem !== "latn") {
    locale = `${intlLocale}-u-nu-${langInfo.numberingSystem}`;
  } else {
    locale = `${intlLocale}-u-nu-latn`;
  }

  const intlOptions: Intl.NumberFormatOptions = {};

  if (options?.compact) {
    intlOptions.notation = "compact";
    intlOptions.compactDisplay = "long";
  }

  try {
    return new Intl.NumberFormat(locale, intlOptions).format(value);
  } catch {
    // Fallback to basic formatting if Intl doesn't support the locale
    return value.toLocaleString();
  }
}

/**
 * Format a currency value with region-aware symbol and lakh/crore grouping.
 *
 * Auto-detects the correct currency from the language and region:
 * - Hindi (IN) → ₹   Bengali (BD) → ৳   Urdu (PK) → Rs
 * - Bengali (IN) → ₹  (with region override)
 *
 * @param value   - The amount to format
 * @param lang    - Language code (e.g. "hi", "bn")
 * @param region  - Optional region override
 * @param options - Formatting options
 *
 * @example
 * formatCurrency(1234567, "hi")                           // → "₹12,34,567.00"
 * formatCurrency(1234567, "bn")                           // → "৳12,34,567.00" (Bangladesh default)
 * formatCurrency(1234567, "bn", "IN")                     // → "₹12,34,567.00" (India override)
 * formatCurrency(1234567, "hi", undefined, { display: "code" })  // → "INR 12,34,567.00"
 */
export function formatCurrency(
  value: number,
  lang: string,
  region?: string,
  options?: CurrencyFormatOptions
): string {
  const langInfo = getLangInfo(lang);
  const resolved = resolveRegion(lang, region);

  // Use explicit currency or auto-detect from language + region
  const currencyCode = options?.currency || resolved.currency;

  // Build locale with optional native digits (default to latn for consistency).
  let locale = resolved.intlLocale;
  if (options?.useNativeDigits && langInfo.numberingSystem !== "latn") {
    locale = `${resolved.intlLocale}-u-nu-${langInfo.numberingSystem}`;
  } else {
    locale = `${resolved.intlLocale}-u-nu-latn`;
  }

  const intlOptions: Intl.NumberFormatOptions = {
    style: "currency",
    currency: currencyCode,
    currencyDisplay: options?.display || "symbol",
  };

  try {
    return new Intl.NumberFormat(locale, intlOptions).format(value);
  } catch {
    // Fallback: basic format with currency code
    return `${currencyCode} ${value.toLocaleString()}`;
  }
}

/**
 * Format a date using South Asian conventions.
 *
 * Defaults to DD/MM/YYYY (not the American MM/DD/YYYY).
 * Supports four presets and native digit rendering.
 *
 * @param date    - Date to format (Date object, ISO string, or timestamp)
 * @param lang    - Language code
 * @param region  - Optional region override
 * @param options - Formatting options
 *
 * @example
 * formatDate(new Date("2026-03-19"), "hi")                        // → "19 मार्च 2026"
 * formatDate(new Date("2026-03-19"), "hi", undefined, { preset: "short" })  // → "19/3/26"
 * formatDate(new Date("2026-03-19"), "hi", undefined, { preset: "full" })   // → "गुरुवार, 19 मार्च 2026"
 * formatDate(new Date("2026-03-19"), "hi", undefined, { useNativeDigits: true }) // → "१९ मार्च २०२६"
 */
export function formatDate(
  date: Date | string | number,
  lang: string,
  region?: string,
  options?: DateFormatOptions
): string {
  const langInfo = getLangInfo(lang);
  const { intlLocale } = resolveRegion(lang, region);

  // Normalize the date input
  const dateObj = date instanceof Date ? date : new Date(date);

  // Build locale with optional native digits (default to latn for consistency).
  let locale = intlLocale;
  if (options?.useNativeDigits && langInfo.numberingSystem !== "latn") {
    locale = `${intlLocale}-u-nu-${langInfo.numberingSystem}`;
  } else {
    locale = `${intlLocale}-u-nu-latn`;
  }

  // Map presets to Intl.DateTimeFormat options
  const preset = options?.preset || "medium";
  const intlOptions = DATE_PRESETS[preset];

  try {
    return new Intl.DateTimeFormat(locale, intlOptions).format(dateObj);
  } catch {
    // Fallback to ISO date
    return dateObj.toLocaleDateString();
  }
}

/**
 * Date format presets mapped to Intl.DateTimeFormat options.
 *
 * short:  19/03/26
 * medium: 19 Mar 2026
 * long:   19 March 2026
 * full:   Thursday, 19 March 2026
 */
const DATE_PRESETS: Record<string, Intl.DateTimeFormatOptions> = {
  short: {
    day: "numeric",
    month: "numeric",
    year: "2-digit",
  },
  medium: {
    day: "numeric",
    month: "short",
    year: "numeric",
  },
  long: {
    day: "numeric",
    month: "long",
    year: "numeric",
  },
  full: {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  },
};
