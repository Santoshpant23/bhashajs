// FILE: packages/sdk/src/components/I18nProvider.tsx
//
// THE MAIN COMPONENT — This is what developers add to their app:
//
//   <I18nProvider projectId="abc123" apiToken="...">
//     <App />
//   </I18nProvider>
//
// What it does behind the scenes:
//   1. Creates a TranslationClient instance
//   2. Fetches the project info (to know which languages are supported)
//   3. Fetches translations for the current language
//   4. Provides the t() function, current language, and setLang() to all children
//   5. When language changes, fetches new translations and updates the DOM direction
//   6. Provides formatNumber(), formatCurrency(), formatDate() for South Asian formatting
//
// HOW REACT CONTEXT WORKS (in case you need a refresher):
// Context is like a "global variable" scoped to a component tree.
// <I18nProvider> puts data INTO the context.
// useTranslation() reads data FROM the context.
// Any component inside <I18nProvider> can call useTranslation()
// and get the translation function, current language, etc.

import { useState, useEffect, useCallback, useRef, ReactNode } from "react";
import { BhashaConfig, NumberFormatOptions, CurrencyFormatOptions, DateFormatOptions } from "../types";
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

// Default API URL — developers override this if they self-host
const DEFAULT_API_URL = "http://localhost:5000/api";

export function I18nProvider({
  projectId,
  defaultLang = "en",
  apiUrl = DEFAULT_API_URL,
  apiToken = "",
  preloadedTranslations,
  onLanguageChange,
  region,
  children,
}: I18nProviderProps) {
  // ─── State ───────────────────────────────────────────────────

  const [currentLang, setCurrentLang] = useState(defaultLang);
  const [supportedLangs, setSupportedLangs] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Force re-render when translations load (since they're in the client cache,
  // not React state — we use a counter to trigger re-renders)
  const [, setRenderTrigger] = useState(0);

  // useRef to hold the client so it persists across renders
  // without causing re-renders itself (unlike useState)
  const clientRef = useRef<TranslationClient | null>(null);

  // Create the client once on mount
  if (!clientRef.current) {
    clientRef.current = new TranslationClient(projectId, apiUrl, apiToken);

    // If preloaded translations were provided, load them into cache immediately
    if (preloadedTranslations) {
      clientRef.current.preload(preloadedTranslations);
    }
  }

  const client = clientRef.current;

  // ─── Initialization ──────────────────────────────────────────
  // On mount: fetch project info and initial translations

  useEffect(() => {
    async function init() {
      setIsLoading(true);
      setError(null);

      try {
        // Step 1: If we have preloaded translations, extract supported langs from them
        if (preloadedTranslations) {
          const langs = Object.keys(preloadedTranslations);
          client.setSupportedLangs(langs);
          setSupportedLangs(langs);
        } else {
          // Step 1: Fetch project info to know which languages are supported
          const langs = await client.fetchProjectInfo();
          setSupportedLangs(langs);
        }

        // Step 2: Fetch translations for the default language
        if (!preloadedTranslations || !preloadedTranslations[defaultLang]) {
          await client.fetchTranslations(defaultLang);
        }

        // Step 3: Also fetch English as a fallback (if not the default)
        if (defaultLang !== "en") {
          if (!preloadedTranslations || !preloadedTranslations["en"]) {
            await client.fetchTranslations("en");
          }
        }

        // Step 4: Preload fonts for all supported languages
        preloadFonts(client.getSupportedLangs());

        // Step 5: Apply the initial language direction to the document
        applyLangToDocument(defaultLang);

        // Trigger a re-render now that translations are loaded
        setRenderTrigger((prev) => prev + 1);
      } catch (e: any) {
        setError(e.message || "Failed to initialize BhashaJS");
        console.error("[BhashaJS] Initialization error:", e);
      } finally {
        setIsLoading(false);
      }
    }

    init();
  }, [projectId]); // Re-init if projectId changes

  // ─── Language Switching ──────────────────────────────────────

  const setLang = useCallback(
    async (newLang: string) => {
      // Don't do anything if it's already the current language
      if (newLang === currentLang) return;

      // Fetch translations for the new language (will use cache if available)
      setIsLoading(true);
      await client.fetchTranslations(newLang);
      setIsLoading(false);

      // Load the correct font for this language
      loadFontForLang(newLang);

      // Update the document's direction and lang attribute
      applyLangToDocument(newLang);

      // Update state (this re-renders all components using useTranslation)
      setCurrentLang(newLang);

      // Call the developer's callback if provided
      onLanguageChange?.(newLang);
    },
    [currentLang, client, onLanguageChange]
  );

  // ─── The t() function ────────────────────────────────────────
  // This is what developers use most: t("hero.title")

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      return client.translate(key, currentLang, params);
    },
    [currentLang, client]
  );

  // ─── Formatting functions ────────────────────────────────────
  // South Asian-specific number, currency, and date formatting

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

  // ─── Provide everything to children ──────────────────────────

  const contextValue = {
    currentLang,
    setLang,
    supportedLangs,
    t,
    isLoading,
    error,
    formatNumber,
    formatCurrency,
    formatDate,
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
 * This does three things:
 * 1. Sets <html lang="hi"> — important for SEO and screen readers
 * 2. Sets <html dir="rtl"> — flips the entire layout for RTL languages
 * 3. Sets a CSS variable --bhasha-font — developers can use this in their CSS
 *
 * For Urdu, this automatically flips the page layout to right-to-left.
 * For Hindi/Bengali/etc, it ensures left-to-right.
 */
function applyLangToDocument(lang: string) {
  const langInfo = getLangInfo(lang);
  const html = document.documentElement;

  // Set the lang attribute — screen readers use this to pick the right voice
  html.setAttribute("lang", lang);

  // Set text direction — RTL for Urdu, LTR for everything else
  html.setAttribute("dir", langInfo.dir);

  // Set a CSS custom property so developers can use the font in their own CSS:
  //   body { font-family: var(--bhasha-font); }
  html.style.setProperty("--bhasha-font", langInfo.font);
}
