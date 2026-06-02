// FILE: packages/sdk/src/server.ts
//
// ╔══════════════════════════════════════════════════════════════╗
// ║  BhashaJS SDK — Server-safe entry  ("bhasha-js/server")        ║
// ║                                                                ║
// ║  These are the PURE, React-free utilities. Import them here    ║
// ║  inside a React Server Component, a Next.js App Router server   ║
// ║  file, Astro frontmatter, or plain Node — anywhere the React   ║
// ║  provider/hooks can't run.                                     ║
// ║                                                                ║
// ║    import { formatCurrency } from "bhasha-js/server";          ║
// ║                                                                ║
// ║  The main "bhasha-js" entry is a Client Component boundary      ║
// ║  (carries a "use client" directive) and also re-exports these  ║
// ║  same utilities for use inside Client Components.              ║
// ╚══════════════════════════════════════════════════════════════╝

export {
  getLangInfo,
  getFallbackChain,
  resolveRegion,
  LANGUAGES,
  REGION_OVERRIDES,
} from "./utils/languages";
export { formatNumber, formatCurrency, formatDate } from "./utils/formatting";
export { getPluralCategory } from "./utils/plurals";

export type {
  LangInfo,
  NumberFormatOptions,
  CurrencyFormatOptions,
  DateFormatOptions,
  Register,
} from "./types";
