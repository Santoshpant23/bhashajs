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

// Default API URL — points at the hosted BhashaJS service. The `/api` suffix
// matches the server's mount point (sdk routes live at `/api/sdk/*`).
// Override with `apiUrl` prop if you self-host (e.g. "https://my.host/api").
const DEFAULT_API_URL = "https://api.bhashajs.com/api";

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
  userSegment,
  segmentRules,
  children,
}: I18nProviderProps) {
  // ─── State ───────────────────────────────────────────────────

  // Resolve initial register from the segment if a matching rule exists,
  // otherwise fall back to the explicit `register` prop. This lets apps
  // declare `userSegment="genz"` and skip wiring `register="casual"` separately.
  const initialResolvedRegister = resolveRegisterFromSegment(
    userSegment,
    segmentRules,
    initialRegister
  );

  const [currentLang, setCurrentLang] = useState(defaultLang);
  const [currentRegister, setCurrentRegister] = useState<Register>(initialResolvedRegister);
  const [currentSegment, setCurrentSegment] = useState<string | undefined>(userSegment);
  const [supportedLangs, setSupportedLangs] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Force re-render when translations load (since they're in the client cache,
  // not React state — we use a counter to trigger re-renders)
  const [, setRenderTrigger] = useState(0);

  // useRef to hold the client so it persists across renders
  const clientRef = useRef<TranslationClient | null>(null);
  // The config identity the current client was built for — so we recreate it
  // when projectId/projectKey/apiUrl/apiToken change (the init effect re-runs on
  // projectId, but without this it would keep using the OLD client).
  const clientConfigRef = useRef<string>("");

  // A (lang, register) pair is ONE atomic locale target. Tracking the two
  // dimensions with separate request counters let an interleaved
  // setLang("hi") + setRegister("formal") commit the final "hi/formal" state
  // while each call only fetched the pair it could *see* at call time
  // ("hi/default" and "en/formal") — so the committed "hi/formal" bundle was
  // never loaded. We keep a single shared counter plus a pending target that
  // every switch writes BEFORE fetching; applyLocale() fetches the CURRENT
  // pending pair and, if still the latest request, commits both dimensions
  // together. Last-requested wins. Pending lives in refs (not state) so a
  // switch reads the latest target synchronously, without a re-render.
  const localeReqRef = useRef(0);
  const pendingLangRef = useRef(defaultLang);
  const pendingRegisterRef = useRef<Register>(initialResolvedRegister);

  // Create the client on mount — and RECREATE it if the identifying config
  // changes, so a changed projectId/projectKey doesn't keep serving the old
  // project's data.
  const clientConfig = `${projectId}|${projectKey}|${apiUrl}|${apiToken}`;
  if (!clientRef.current || clientConfigRef.current !== clientConfig) {
    clientRef.current = new TranslationClient(projectId, apiUrl, apiToken, projectKey);
    clientConfigRef.current = clientConfig;

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
  }, [projectId, projectKey, apiUrl, apiToken]); // Re-init when the project identity changes

  // ─── Atomic locale switching ─────────────────────────────────
  // (lang, register) is ONE locale target. Every switch updates the pending
  // refs first, then applyLocale() snapshots the CURRENT pending pair, fetches
  // THAT exact bundle (+ English / default-register fallbacks + voice), and —
  // guarded by the single shared counter — commits BOTH dimensions together.
  // Snapshotting the pending target (not currentLang/currentRegister) is what
  // makes an interleaved setLang+setRegister fetch the real final pair instead
  // of a stale half-state. Mirrors BhashaStore.applyLocale exactly.

  const applyLocale = useCallback(async () => {
    const reqId = ++localeReqRef.current;
    const targetLang = pendingLangRef.current;
    const targetRegister = pendingRegisterRef.current;

    setIsLoading(true);
    setError(null);
    try {
      await client.fetchTranslations(targetLang, targetRegister);
      // English fallback (default register only — English has no formal/casual).
      if (targetLang !== "en") {
        await client.fetchTranslations("en", DEFAULT_REGISTER);
      }
      // Pre-warm default register for register-fallback if needed.
      if (targetRegister !== DEFAULT_REGISTER) {
        await client.fetchTranslations(targetLang, DEFAULT_REGISTER);
      }
      // Voice mode: keep the IPA/SSML bundle in sync with the active locale.
      // Without this, formatPhonetic/formatSSML return empty strings for every
      // key after a switch until the next remount.
      if (voiceEnabled) {
        await client.fetchVoice(targetLang, targetRegister);
        if (targetRegister !== DEFAULT_REGISTER) {
          await client.fetchVoice(targetLang, DEFAULT_REGISTER);
        }
      }
    } catch (e: any) {
      // A failed switch must surface an error and clear loading rather than
      // wedge isLoading:true forever. If a newer switch superseded us, let it
      // own the final state.
      if (reqId !== localeReqRef.current) return;
      // Roll the pending target back to the committed locale so an identical
      // retry isn't short-circuited by the equality guard in the setters.
      pendingLangRef.current = currentLang;
      pendingRegisterRef.current = currentRegister;
      setIsLoading(false);
      setError(e?.message || `Failed to load locale "${targetLang}/${targetRegister}"`);
      console.error("[BhashaJS] setLocale error:", e);
      return;
    }

    // A newer switch superseded this one while we were fetching — let it own
    // the loading state and the committed locale. Bailing here is what stops a
    // slow earlier fetch from clobbering a newer selection.
    if (reqId !== localeReqRef.current) return;

    setIsLoading(false);

    const langChanged = targetLang !== currentLang;
    if (langChanged) {
      loadFontForLang(targetLang);
      applyLangToDocument(targetLang);
    }
    setCurrentLang(targetLang);
    setCurrentRegister(targetRegister);

    if (langChanged) onLanguageChange?.(targetLang);
  }, [currentLang, currentRegister, client, voiceEnabled, onLanguageChange]);

  // ─── Language Switching ──────────────────────────────────────

  const setLang = useCallback(
    async (newLang: string) => {
      if (newLang === pendingLangRef.current) return;
      pendingLangRef.current = newLang;
      await applyLocale();
    },
    [applyLocale]
  );

  // ─── Register Switching ──────────────────────────────────────

  const setRegister = useCallback(
    async (newRegister: Register) => {
      if (newRegister === pendingRegisterRef.current) return;
      pendingRegisterRef.current = newRegister;
      await applyLocale();
    },
    [applyLocale]
  );

  // ─── Segment Switching ───────────────────────────────────────
  // Setting a segment that maps to a register (via segmentRules) flips both
  // the segment and the register (through the same atomic locale path) and
  // pre-fetches the new bundle. Setting a segment that ISN'T in the rules just
  // records the segment label — the register stays as it was. This lets apps
  // record analytics-only segments without forcing a register change.

  const setSegment = useCallback(
    async (newSegment: string) => {
      setCurrentSegment(newSegment);
      const mapped = segmentRules?.[newSegment];
      if (mapped && mapped !== pendingRegisterRef.current) {
        pendingRegisterRef.current = mapped;
        await applyLocale();
      }
    },
    [segmentRules, applyLocale]
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
    currentSegment,
    setSegment,
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
 * Pick the active register given a (possibly undefined) user segment, a
 * (possibly undefined) segment→register rule map, and a fallback register.
 *
 * Pulled out of the provider body so it's easy to unit-test without React.
 * Exported for the same reason — the test imports it directly.
 */
export function resolveRegisterFromSegment(
  segment: string | undefined,
  rules: Record<string, Register> | undefined,
  fallback: Register
): Register {
  if (segment && rules && rules[segment]) return rules[segment];
  return fallback;
}

/**
 * Apply language settings to the HTML document.
 *
 * 1. Sets <html lang="hi"> — important for SEO and screen readers
 * 2. Sets <html dir="rtl"> — flips the entire layout for RTL languages
 * 3. Sets a CSS variable --bhasha-font — developers can use this in their CSS
 */
function applyLangToDocument(lang: string) {
  // No-op during SSR — there's no document. The provider re-applies on the
  // client after hydration via the same call path.
  if (typeof document === "undefined") return;

  const langInfo = getLangInfo(lang);
  const html = document.documentElement;

  html.setAttribute("lang", lang);
  html.setAttribute("dir", langInfo.dir);
  html.style.setProperty("--bhasha-font", langInfo.font);
}
