// FILE: packages/sdk/src/core/store.ts
//
// BhashaStore — the framework-agnostic engine.
//
// The TranslationClient already has zero React dependency; BhashaStore adds the
// small amount of *state* a UI needs (current language + register, loading,
// supported languages) plus a subscribe/emit API. Any framework — vanilla JS,
// Vue, Svelte, Solid, Angular, React Native — can drive its UI from this:
//
//   const store = new BhashaStore({ projectKey: "bjs_..." });
//   await store.init();
//   store.subscribe(() => render(store.t("hero.title")));
//   store.setLang("hi");
//
// The React <I18nProvider> is one binding over this idea; this class makes the
// same engine usable everywhere else. It is intentionally synchronous for reads
// (t(), formatters) and async only for the network-touching switches.

import { TranslationClient } from "./client";
import { getLangInfo } from "../utils/languages";
import { loadFontForLang, preloadFonts } from "../utils/fonts";
import {
  formatNumber as formatNumberUtil,
  formatCurrency as formatCurrencyUtil,
  formatDate as formatDateUtil,
} from "../utils/formatting";
import type {
  BhashaConfig,
  Register,
  BhashaKey,
  NumberFormatOptions,
  CurrencyFormatOptions,
  DateFormatOptions,
} from "../types";

const DEFAULT_API_URL = "https://api.bhashajs.com/api";
const DEFAULT_REGISTER: Register = "default";

export interface BhashaState {
  /** Active language code (e.g. "hi", "bn", "ne-Latn"). */
  lang: string;
  /** Active register ("default" | "formal" | "casual"). */
  register: Register;
  /** Languages this project supports. */
  supportedLangs: string[];
  /** True while a (lang, register) bundle is being fetched. */
  isLoading: boolean;
  /** Error message from the last failed init/switch, or null. */
  error: string | null;
  /** Active user segment label, if set. */
  segment?: string;
}

export type Unsubscribe = () => void;
type Listener = (state: BhashaState) => void;

function resolveInitialRegister(config: BhashaConfig): Register {
  const { userSegment, segmentRules, register } = config;
  if (userSegment && segmentRules && segmentRules[userSegment]) {
    return segmentRules[userSegment];
  }
  return register || DEFAULT_REGISTER;
}

/** Apply lang/dir/font to the document. SSR-safe (no-op without a document). */
function applyLangToDocument(lang: string): void {
  if (typeof document === "undefined") return;
  const info = getLangInfo(lang);
  const html = document.documentElement;
  html.setAttribute("lang", lang);
  html.setAttribute("dir", info.dir);
  html.style.setProperty("--bhasha-font", info.font);
}

export class BhashaStore {
  private client: TranslationClient;
  private state: BhashaState;
  private listeners = new Set<Listener>();
  private region?: string;
  private voiceEnabled: boolean;
  private segmentRules?: Record<string, Register>;
  private applyDocument: boolean;
  private onLanguageChange?: (lang: string) => void;

  // Per-dimension request ids so a slow earlier fetch can't overwrite a newer
  // switch (last-requested wins) — the same guard the React provider uses.
  private langReq = 0;
  private registerReq = 0;

  constructor(config: BhashaConfig & { applyDocument?: boolean } = {}) {
    const {
      projectId = "",
      projectKey = "",
      apiUrl = DEFAULT_API_URL,
      apiToken = "",
      region,
      voice = false,
      defaultLang = "en",
      segmentRules,
      userSegment,
      preloadedTranslations,
      onLanguageChange,
      applyDocument = true,
    } = config;

    this.client = new TranslationClient(projectId, apiUrl, apiToken, projectKey);
    if (preloadedTranslations) this.client.preload(preloadedTranslations);

    this.region = region;
    this.voiceEnabled = voice;
    this.segmentRules = segmentRules;
    this.applyDocument = applyDocument;
    this.onLanguageChange = onLanguageChange;

    this.state = {
      lang: defaultLang,
      register: resolveInitialRegister(config),
      supportedLangs: preloadedTranslations ? Object.keys(preloadedTranslations) : [],
      isLoading: true,
      error: null,
      segment: userSegment,
    };

    if (preloadedTranslations) {
      this.client.setSupportedLangs(this.state.supportedLangs);
    }
  }

  /** Current state snapshot. Returns a shallow copy so a consumer (or a
   *  framework adapter) mutating it can't poison canonical state — all real
   *  changes must go through `emit`. */
  getState(): BhashaState {
    return { ...this.state };
  }

  /** Escape hatch to the underlying client (cache, voice, preload). */
  getClient(): TranslationClient {
    return this.client;
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(fn: Listener): Unsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(patch: Partial<BhashaState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) {
      // Isolate subscribers: one throwing listener must not starve the rest or
      // abort the emit (which would desync a multi-framework UI).
      try {
        fn(this.state);
      } catch (e) {
        console.error("[BhashaJS] a subscriber threw during emit:", e);
      }
    }
  }

  /**
   * Fetch project info (unless preloaded) and the initial (lang, register)
   * bundle. Call this exactly once, before any setLang/setRegister — init() is
   * not request-guarded, so a switch racing the initial load is undefined.
   */
  async init(): Promise<void> {
    this.emit({ isLoading: true, error: null });
    try {
      if (this.state.supportedLangs.length === 0) {
        const langs = await this.client.fetchProjectInfo();
        this.emit({ supportedLangs: langs });
      }

      const { lang, register } = this.state;
      await this.client.fetchTranslations(lang, register);
      if (lang !== "en") await this.client.fetchTranslations("en", DEFAULT_REGISTER);
      if (register !== DEFAULT_REGISTER) {
        await this.client.fetchTranslations(lang, DEFAULT_REGISTER);
      }
      if (this.voiceEnabled) {
        await this.client.fetchVoice(lang, register);
        if (register !== DEFAULT_REGISTER) await this.client.fetchVoice(lang, DEFAULT_REGISTER);
      }

      preloadFonts(this.client.getSupportedLangs());
      if (this.applyDocument) applyLangToDocument(lang);

      this.emit({ isLoading: false });
    } catch (e: any) {
      this.emit({ isLoading: false, error: e?.message || "Failed to initialize BhashaJS" });
    }
  }

  /** Translate a key in the current (lang, register). */
  t(key: BhashaKey, params?: Record<string, string | number>): string {
    return this.client.translate(key as string, this.state.lang, this.state.register, params);
  }

  /** Switch language. Fetches the bundle, then commits if still the latest. */
  async setLang(newLang: string): Promise<void> {
    if (newLang === this.state.lang) return;
    const reqId = ++this.langReq;
    this.emit({ isLoading: true, error: null });

    try {
      await this.client.fetchTranslations(newLang, this.state.register);
      if (this.state.register !== DEFAULT_REGISTER) {
        await this.client.fetchTranslations(newLang, DEFAULT_REGISTER);
      }
      if (this.voiceEnabled) {
        await this.client.fetchVoice(newLang, this.state.register);
        if (this.state.register !== DEFAULT_REGISTER) {
          await this.client.fetchVoice(newLang, DEFAULT_REGISTER);
        }
      }
    } catch (e: any) {
      // A failed switch must surface an error and clear loading instead of
      // wedging isLoading:true forever (and it must not reject — these are
      // commonly called un-awaited). If a newer switch superseded us, let it
      // own the final state.
      if (reqId !== this.langReq) return;
      this.emit({ isLoading: false, error: e?.message || `Failed to load language "${newLang}"` });
      return;
    }

    if (reqId !== this.langReq) return; // superseded by a newer setLang
    if (this.applyDocument) {
      loadFontForLang(newLang);
      applyLangToDocument(newLang);
    }
    this.emit({ lang: newLang, isLoading: false, error: null });
    this.onLanguageChange?.(newLang);
  }

  /** Switch register. */
  async setRegister(newRegister: Register): Promise<void> {
    if (newRegister === this.state.register) return;
    const reqId = ++this.registerReq;
    this.emit({ isLoading: true, error: null });

    try {
      await this.client.fetchTranslations(this.state.lang, newRegister);
      if (this.voiceEnabled) await this.client.fetchVoice(this.state.lang, newRegister);
    } catch (e: any) {
      if (reqId !== this.registerReq) return;
      this.emit({ isLoading: false, error: e?.message || `Failed to load register "${newRegister}"` });
      return;
    }

    if (reqId !== this.registerReq) return;
    this.emit({ register: newRegister, isLoading: false, error: null });
  }

  /** Set the user segment; flips register if a segmentRule matches. */
  async setSegment(newSegment: string): Promise<void> {
    this.emit({ segment: newSegment });
    const mapped = this.segmentRules?.[newSegment];
    if (mapped && mapped !== this.state.register) {
      await this.setRegister(mapped);
    }
  }

  // ─── Formatters (pure, synchronous) ────────────────────────────
  formatNumber(value: number, options?: NumberFormatOptions): string {
    return formatNumberUtil(value, this.state.lang, this.region, options);
  }
  formatCurrency(value: number, options?: CurrencyFormatOptions): string {
    return formatCurrencyUtil(value, this.state.lang, this.region, options);
  }
  formatDate(date: Date | string | number, options?: DateFormatOptions): string {
    return formatDateUtil(date, this.state.lang, this.region, options);
  }

  // ─── Voice (synchronous reads of the lazily-fetched voice cache) ─
  formatPhonetic(key: string): string {
    return this.client.getVoice(key, this.state.lang, this.state.register)?.ipa || "";
  }
  formatSSML(key: string): string {
    return this.client.getVoice(key, this.state.lang, this.state.register)?.ssml || "";
  }
}

/** Convenience: construct a store and run init() before resolving. */
export async function createBhashaStore(
  config: BhashaConfig & { applyDocument?: boolean } = {}
): Promise<BhashaStore> {
  const store = new BhashaStore(config);
  await store.init();
  return store;
}
