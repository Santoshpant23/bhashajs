// FILE: packages/sdk/src/index.ts
//
// ╔════════════════════════════════════════════╗
// ║           BhashaJS SDK — Entry Point       ║
// ║                                            ║
// ║  Everything exported here is the PUBLIC    ║
// ║  API of the package. If it's not exported  ║
// ║  here, developers can't import it.         ║
// ╚════════════════════════════════════════════╝
//
// Developer usage:
//   import {
//     I18nProvider,
//     useTranslation,
//     LanguageSwitcher,
//     Trans,
//     useLangInfo,
//     formatNumber,
//     formatCurrency,
//     formatDate,
//     getPluralCategory,
//   } from 'bhasha-js';
//
// We organize exports into categories so it's clear what's available.

// ─── Components ────────────────────────────────────────────────
// React components developers add to their JSX

export { I18nProvider } from "./components/I18nProvider";
export { LanguageSwitcher } from "./components/LanguageSwitcher";
export { Trans } from "./components/Trans";

// ─── Hooks ─────────────────────────────────────────────────────
// React hooks developers call inside their components

export { useTranslation } from "./hooks/useTranslation";
export { useLangInfo } from "./hooks/useLangInfo";

// ─── Utilities ─────────────────────────────────────────────────
// Helper functions that can be used outside of React components

export { getLangInfo, getFallbackChain, resolveRegion, LANGUAGES, REGION_OVERRIDES } from "./utils/languages";
export { loadFontForLang, preloadFonts } from "./utils/fonts";
export { formatNumber, formatCurrency, formatDate } from "./utils/formatting";
export { getPluralCategory } from "./utils/plurals";

// ─── Types ─────────────────────────────────────────────────────
// TypeScript interfaces for developers who want type safety

export type {
  BhashaConfig,
  I18nContextValue,
  LanguageSwitcherProps,
  LangInfo,
  NumberFormatOptions,
  CurrencyFormatOptions,
  DateFormatOptions,
  Register,
} from "./types";
