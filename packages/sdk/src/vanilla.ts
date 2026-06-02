// FILE: packages/sdk/src/vanilla.ts
//
// ╔══════════════════════════════════════════════════════════════╗
// ║  BhashaJS SDK — Framework-agnostic entry  ("bhasha-js/vanilla")║
// ║                                                                ║
// ║  The BhashaStore engine (subscribe/emit) + all pure utilities, ║
// ║  with NO React. Drive any UI from it — vanilla JS, Vue,        ║
// ║  Svelte, Solid, Angular, React Native:                         ║
// ║                                                                ║
// ║    import { createBhashaStore } from "bhasha-js/vanilla";      ║
// ║    const store = await createBhashaStore({ projectKey });      ║
// ║    store.subscribe(() => paint(store.t("hero.title")));        ║
// ║    store.setLang("hi");                                        ║
// ╚══════════════════════════════════════════════════════════════╝

export { BhashaStore, createBhashaStore } from "./core/store";
export type { BhashaState, Unsubscribe } from "./core/store";
export { TranslationClient } from "./core/client";

export {
  getLangInfo,
  getFallbackChain,
  resolveRegion,
  LANGUAGES,
  REGION_OVERRIDES,
} from "./utils/languages";
export { loadFontForLang, preloadFonts } from "./utils/fonts";
export { formatNumber, formatCurrency, formatDate } from "./utils/formatting";
export { getPluralCategory } from "./utils/plurals";

export type {
  BhashaConfig,
  Register,
  LangInfo,
  NumberFormatOptions,
  CurrencyFormatOptions,
  DateFormatOptions,
  BhashaKey,
  BhashaKeyRegistry,
} from "./types";
