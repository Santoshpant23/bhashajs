// FILE: packages/sdk/src/components/I18nProvider.tsx
//
// THE MAIN COMPONENT — This is what developers add to their app:
//
//   <I18nProvider projectKey="bjs_..." register="casual">
//     <App />
//   </I18nProvider>
//
// What it does behind the scenes:
//   1. Creates a TranslationClient instance
//   2. Fetches the project info (to know which languages are supported)
//   3. Fetches the (currentLang, currentRegister) bundle
//   4. Provides t(), currentLang/setLang, register/setRegister, formatters to children
//   5. When language or register changes, fetches the right bundle and updates the DOM
//
// HOW REGISTER WORKS:
// `register` is the formality / style of the translation:
//   - "default" (neutral)
//   - "formal"  (legal, banking, government, insurance)
//   - "casual"  (Gen-Z, code-mixing with English encouraged)
// Set it once on the provider for the whole app, or call setRegister() at runtime
// (e.g. switch to "formal" when the user enters a compliance/KYC flow).

import { useState, useEffect, useCallback, useRef, ReactNode } from "react";
import { BhashaConfig, NumberFormatOptions, CurrencyFormatOptions, DateFormatOptions, Register } from "../types";
import { I18nContext } from "../core/context";
import { TranslationClient } from "../core/client";
import { getLangInfo } from "../utils/languages";
import { loadFontForLang, preloadFonts } from "../utils/fonts";
import {
  formatNumber as formatNumberUtil,
  formatCurrency as formatCurrencyUtil,
  formatDate as formatDateUtil,
} from "../utils/formatting";

interface I18nProviderProps extends BhashaConfig {
  children: ReactNode;
}

// Default API URL — points at the hosted BhashaJS service.
// Override with `apiUrl` prop if you self-host.
const DEFAULT_API_URL = "https://api.bhashajs.com";

const DEFAULT_REGISTER: Register = "default";

export function I18nProvider({
  projectId = "",
  projectKey = "",
  defaultLang = "en",
  apiUrl = DEFAULT_API_URL,
  apiToken = "",
  preloadedTranslations,
  onLanguageChange,
  region,
  register: initialRegister = DEFAULT_REGISTER,
  voice: voiceEnabled = false,
  children,
}: I18nProviderProps) {
  // ─── State ───────────────────────────────────────────────────

  const [currentLang, setCurrentLang] = useState(defaultLang);
  const [currentRegister, setCurrentRegister] = useState<Register>(initialRegister);
  const [supportedLangs, setSupportedLangs] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Force re-render when translations load (since they're in the client cache,
  // not React state — we use a counter to trigger re-renders)
  const [, setRenderTrigger] = useState(0);

  // useRef to hold the client so it persists across renders
  const clientRef = useRef<TranslationClient | null>(null);

  // Create the client once on mount
  if (!clientRef.current) {
    clientRef.current = new TranslationClient(projectId, apiUrl, apiToken, projectKey);

    // If preloaded translations were provided, load them into cache immediately
    if (preloadedTranslations) {
      clientRef.current.preload(preloadedTranslations);
    }
  }

  const client = clientRef.current;

  // ─── Initialization ──────────────────────────────────────────

  useEffect(() => {
    async function init() {
      setIsLoading(true);
      setError(null);

      try {
        if (preloadedTranslations) {
          const langs = Object.keys(preloadedTranslations);
          client.setSupportedLangs(langs);
          setSupportedLangs(langs);
        } else {
          const langs = await client.fetchProjectInfo();
          setSupportedLangs(langs);
        }

        // Always fetch the requested register for the default language.
        await client.fetchTranslations(defaultLang, currentRegister);

        // Also fetch English as a fallback (default register only — English
        // doesn't get formal/casual splits in this product).
        if (defaultLang !== "en") {
          await client.fetchTranslations("en", DEFAULT_REGISTER);
        }

        // If the requested register isn't "default", also pre-warm "default"
        // for the current lang so register-fallback is instant.
        if (currentRegister !== DEFAULT_REGISTER) {
          await client.fetchTranslations(defaultLang, DEFAULT_REGISTER);
        }

        // Voice mode: also fetch the IPA/SSML bundle so formatPhonetic and
        // formatSSML can return non-empty strings synchronously.
        if (voiceEnabled) {
          await client.fetchVoice(defaultLang, currentRegister);
          if (currentRegister !== DEFAULT_REGISTER) {
            await client.fetchVoice(defaultLang, DEFAULT_REGISTER);
          }
        }

        preloadFonts(client.getSupportedLangs());
        applyLangToDocument(defaultLang);

        setRenderTrigger((prev) => prev + 1);
      } catch (e: any) {
        setError(e.message || "Failed to initialize BhashaJS");
        console.error("[BhashaJS] Initialization error:", e);
      } finally {
        setIsLoading(false);
      }
    }

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]); // Re-init only if projectId changes

  // ─── Language Switching ──────────────────────────────────────

  const setLang = useCallback(
    async (newLang: string) => {
      if (newLang === currentLang) return;

      setIsLoading(true);
      await client.fetchTranslations(newLang, currentRegister);
      // Pre-warm default register for register-fallback if needed.
      if (currentRegister !== DEFAULT_REGISTER) {
        await client.fetchTranslations(newLang, DEFAULT_REGISTER);
      }
      setIsLoading(false);

      loadFontForLang(newLang);
      applyLangToDocument(newLang);
      setCurrentLang(newLang);

      onLanguageChange?.(newLang);
    },
    [currentLang, currentRegister, client, onLanguageChange]
  );

  // ─── Register Switching ──────────────────────────────────────

  const setRegister = useCallback(
    async (newRegister: Register) => {
      if (newRegister === currentRegister) return;

      // Fetch the new register bundle for the current lang (and English
      // fallback) so the switch is instant once the network round-trips.
      setIsLoading(true);
      await client.fetchTranslations(currentLang, newRegister);
      setIsLoading(false);

      setCurrentRegister(newRegister);
    },
    [currentLang, currentRegister, client]
  );

  // ─── The t() function ────────────────────────────────────────

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      return client.translate(key, currentLang, currentRegister, params);
    },
    [currentLang, currentRegister, client]
  );

  // ─── Formatting functions ────────────────────────────────────

  const formatNumber = useCallback(
    (value: number, options?: NumberFormatOptions): string => {
      return formatNumberUtil(value, currentLang, region, options);
    },
    [currentLang, region]
  );

  const formatCurrency = useCallback(
    (value: number, options?: CurrencyFormatOptions): string => {
      return formatCurrencyUtil(value, currentLang, region, options);
    },
    [currentLang, region]
  );

  const formatDate = useCallback(
    (date: Date | string | number, options?: DateFormatOptions): string => {
      return formatDateUtil(date, currentLang, region, options);
    },
    [currentLang, region]
  );

  // ─── Voice helpers ───────────────────────────────────────────
  // Walk the same fallback chain as t() — register-then-language. Return
  // empty strings if the bundle hasn't been loaded; the developer can
  // enable voice mode by passing `voice` on the provider.

  const formatPhonetic = useCallback(
    (key: string): string => {
      return client.getVoice(key, currentLang, currentRegister)?.ipa || "";
    },
    [currentLang, currentRegister, client]
  );

  const formatSSML = useCallback(
    (key: string): string => {
      return client.getVoice(key, currentLang, currentRegister)?.ssml || "";
    },
    [currentLang, currentRegister, client]
  );

  // ─── Provide everything to children ──────────────────────────

  const contextValue = {
    currentLang,
    setLang,
    supportedLangs,
    register: currentRegister,
    setRegister,
    t,
    isLoading,
    error,
    formatNumber,
    formatCurrency,
    formatDate,
    formatPhonetic,
    formatSSML,
  };

  return (
    <I18nContext.Provider value={contextValue}>
      {children}
    </I18nContext.Provider>
  );
}

/**
 * Apply language settings to the HTML document.
 *
 * 1. Sets <html lang="hi"> — important for SEO and screen readers
 * 2. Sets <html dir="rtl"> — flips the entire layout for RTL languages
 * 3. Sets a CSS variable --bhasha-font — developers can use this in their CSS
 */
function applyLangToDocument(lang: string) {
  const langInfo = getLangInfo(lang);
  const html = document.documentElement;

  html.setAttribute("lang", lang);
  html.setAttribute("dir", langInfo.dir);
  html.style.setProperty("--bhasha-font", langInfo.font);
}
