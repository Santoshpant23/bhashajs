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
  persistCache = true,
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

  // A SEPARATE counter for the PROJECT-init guard. supportedLangs is project
  // metadata that must ALWAYS load for the active project — a concurrent
  // setLang/setRegister (a legitimate LOCALE change within the SAME project)
  // must not cancel it. So the init effect guards its project-metadata commits
  // (setSupportedLangs / setError / the finally setIsLoading(false)) on THIS
  // counter, which only a genuine project switch bumps — never a plain
  // setLang. The locale BUNDLE part of init still cooperates with
  // `localeReqRef` so a concurrent setLang wins the visible language.
  //
  // Bumped ONLY when the init effect runs (a project-identity change — see the
  // effect deps) and in resetLocaleForProjectSwitch (to invalidate an old
  // in-flight init the instant a switch is observed). setLang/setRegister do
  // NOT touch it.
  const initReqRef = useRef(0);
  const didSyncSegmentPropRef = useRef(false);
  const lastSegmentRulesRef = useRef(segmentRules);
  const lastUserSegmentPropRef = useRef(userSegment);

  // Create the client on mount — and RECREATE it if the identifying config
  // changes, so a changed projectId/projectKey doesn't keep serving the old
  // project's data.
  const clientConfig = `${projectId}|${projectKey}|${apiUrl}|${apiToken}|${persistCache}`;
  if (!clientRef.current || clientConfigRef.current !== clientConfig) {
    // Distinguish a genuine PROJECT SWITCH (the client already existed for a
    // different config) from the FIRST mount. Only a switch needs the locale
    // reset below — on first mount state already holds the right defaults.
    const isProjectSwitch = clientRef.current !== null;

    clientRef.current = new TranslationClient(projectId, apiUrl, apiToken, projectKey, { persistCache });
    clientConfigRef.current = clientConfig;

    // If preloaded translations were provided, load them into cache immediately
    if (preloadedTranslations) {
      clientRef.current.preload(preloadedTranslations);
    }

    if (isProjectSwitch) {
      // ── PROJECT SWITCH: atomically reset locale state + invalidate in-flight ──
      // This runs in the render phase, synchronously, the instant a new project
      // identity is observed — strictly before the init effect (and before any
      // commit from a still-pending applyLocale/setLang/init of the OLD project).
      // The reset is factored into a pure helper so it can be unit-tested.
      resetLocaleForProjectSwitch(
        { localeReqRef, initReqRef, pendingLangRef, pendingRegisterRef },
        { defaultLang, register: initialResolvedRegister },
        {
          setCurrentLang,
          setCurrentRegister,
          setError,
          setIsLoading,
          setSupportedLangs,
        }
      );
    }
  }

  const client = clientRef.current;
  client.setOnBundleUpdate(() => setRenderTrigger((p) => p + 1));

  // ─── Initialization ──────────────────────────────────────────

  useEffect(() => {
    // TWO request claims, guarding two DIFFERENT concerns:
    //
    //  • initReqId (project-init guard) — claimed under `initReqRef`, which is
    //    bumped ONLY here and in resetLocaleForProjectSwitch. It supersedes
    //    only on a genuine PROJECT SWITCH (a new init runs, or a switch resets).
    //    A concurrent setLang/setRegister does NOT bump it, so the init's
    //    project-metadata commits (setSupportedLangs / setError / the finally
    //    setIsLoading(false)) always settle for the active project. THIS is the
    //    fix for the audit blocker: a setLang mid-init can no longer cancel
    //    supportedLangs loading, which used to strand the LanguageSwitcher empty.
    //
    //  • localeReqId (locale guard) — claimed under the SHARED `localeReqRef`,
    //    exactly like applyLocale. The user's concurrent setLang bumps this, so
    //    init's *visible-locale* commit (default lang to the document + the
    //    render trigger) defers to the user's selection: last-writer wins on the
    //    locale, while supportedLangs/isLoading still settle from init above.
    // The whole init body lives in an exported pure-ish helper so the
    // load-bearing two-counter race-fix can be unit-tested without a DOM render
    // harness (mirrors resetLocaleForProjectSwitch). The effect just wires the
    // current refs/setters/client into it.
    runProjectInit(
      { localeReqRef, initReqRef, pendingRegisterRef },
      { defaultLang, voiceEnabled, preloadedTranslations },
      client,
      { setIsLoading, setError, setSupportedLangs, bumpRenderTrigger: () => setRenderTrigger((p) => p + 1) }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, projectKey, apiUrl, apiToken, persistCache]); // Re-init when the project identity changes

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

  useEffect(() => {
    if (!didSyncSegmentPropRef.current) {
      didSyncSegmentPropRef.current = true;
      lastSegmentRulesRef.current = segmentRules;
      lastUserSegmentPropRef.current = userSegment;
      return;
    }
    // React ONLY to PROP changes (userSegment / segmentRules identity), never to
    // currentSegment — otherwise a manual runtime setSegment() would be reverted
    // back to the prop value the moment this effect re-fires.
    const rulesChanged = lastSegmentRulesRef.current !== segmentRules;
    const propChanged = lastUserSegmentPropRef.current !== userSegment;
    lastSegmentRulesRef.current = segmentRules;
    lastUserSegmentPropRef.current = userSegment;
    if (userSegment !== undefined && (rulesChanged || propChanged)) {
      void setSegment(userSegment);
    }
  }, [userSegment, segmentRules, setSegment]);

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

/** Minimal shape of a React ref cell — `{ current }` — so the reset helper can
 *  be driven in a test without importing React's `MutableRefObject`. */
interface RefCell<T> {
  current: T;
}

/** The slice of TranslationClient the init helper touches. Narrowed to an
 *  interface so a test can drive `runProjectInit` with a hand-rolled stub —
 *  no real network, no full client construction. */
interface InitClientSurface {
  setSupportedLangs(langs: string[]): void;
  getSupportedLangs(): string[];
  fetchProjectInfo(): Promise<string[]>;
  fetchTranslations(lang: string, register: Register): Promise<unknown>;
  fetchVoice(lang: string, register: Register): Promise<unknown>;
}

/**
 * Run the provider's project initialization: load supportedLangs (project
 * metadata) and pre-warm the default (lang, register) bundle + fallbacks, then
 * commit the visible locale.
 *
 * Extracted from the init effect — like resetLocaleForProjectSwitch — so the
 * load-bearing TWO-COUNTER race-fix is unit-testable without a DOM render
 * harness (the SDK's vitest setup is node-environment, no jsdom).
 *
 * The two counters guard two DIFFERENT concerns:
 *
 *  • initReqRef (PROJECT-init guard) — bumped here at claim time and in
 *    resetLocaleForProjectSwitch; a plain setLang/setRegister does NOT touch it.
 *    The PROJECT-METADATA commits (setSupportedLangs / setError / the finally
 *    setIsLoading(false)) are guarded on it, so a concurrent setLang in flight
 *    during init can no longer cancel supportedLangs loading. Only a genuine
 *    project switch (new init / reset) supersedes them. THIS is the audit fix.
 *
 *  • localeReqRef (LOCALE guard) — the SHARED counter that setLang/setRegister/
 *    applyLocale also bump. The VISIBLE-LOCALE commit (apply default lang to the
 *    document + render trigger) is guarded on it, so a user's concurrent setLang
 *    wins the visible language: last-writer wins on the locale, while
 *    supportedLangs/isLoading still settle from init under initReqRef.
 *
 * Exported for tests.
 */
export async function runProjectInit(
  refs: {
    localeReqRef: RefCell<number>;
    initReqRef: RefCell<number>;
    pendingRegisterRef: RefCell<Register>;
  },
  config: {
    defaultLang: string;
    voiceEnabled: boolean;
    preloadedTranslations?: Record<string, Record<string, string>>;
  },
  client: InitClientSurface,
  setters: {
    setIsLoading: (loading: boolean) => void;
    setError: (error: string | null) => void;
    setSupportedLangs: (langs: string[]) => void;
    bumpRenderTrigger: () => void;
  }
): Promise<void> {
  // Claim BOTH counters up front. initReqId guards the project-metadata commits;
  // localeReqId guards only the visible-locale commit (and so defers to a
  // concurrent setLang). A switch reset bumps both, invalidating this init.
  const initReqId = ++refs.initReqRef.current;
  const localeReqId = ++refs.localeReqRef.current;
  const { defaultLang, voiceEnabled, preloadedTranslations } = config;

  setters.setIsLoading(true);
  setters.setError(null);

  try {
    const targetRegister = refs.pendingRegisterRef.current;

    if (preloadedTranslations) {
      const langs = Object.keys(preloadedTranslations);
      client.setSupportedLangs(langs);
      if (initReqId !== refs.initReqRef.current) return; // superseded by a project switch
      setters.setSupportedLangs(langs);
    } else {
      const langs = await client.fetchProjectInfo();
      if (initReqId !== refs.initReqRef.current) return; // superseded by a project switch
      setters.setSupportedLangs(langs);
    }

    // Always fetch the requested register for the default language.
    await client.fetchTranslations(defaultLang, targetRegister);

    // Also fetch English as a fallback (default register only — English
    // doesn't get formal/casual splits in this product).
    if (defaultLang !== "en") {
      await client.fetchTranslations("en", DEFAULT_REGISTER);
    }

    // If the requested register isn't "default", also pre-warm "default"
    // for the current lang so register-fallback is instant.
    if (targetRegister !== DEFAULT_REGISTER) {
      await client.fetchTranslations(defaultLang, DEFAULT_REGISTER);
    }

    // Voice mode: also fetch the IPA/SSML bundle so formatPhonetic and
    // formatSSML can return non-empty strings synchronously.
    if (voiceEnabled) {
      await client.fetchVoice(defaultLang, targetRegister);
      if (targetRegister !== DEFAULT_REGISTER) {
        await client.fetchVoice(defaultLang, DEFAULT_REGISTER);
      }
    }

    // The VISIBLE-LOCALE commit defers to the LOCALE guard: if a concurrent
    // setLang (or a project switch) superseded us, don't apply the default lang
    // to the document — the user's chosen lang (or the new project) owns the
    // visible locale. supportedLangs/isLoading already settled under the init
    // guard above, independently of this.
    if (localeReqId !== refs.localeReqRef.current) return;

    preloadFonts(client.getSupportedLangs());
    applyLangToDocument(defaultLang);

    setters.bumpRenderTrigger();
  } catch (e: any) {
    // Don't surface the old project's init error over the new project's load.
    // Guarded on the PROJECT-init counter, not the locale one — a concurrent
    // setLang must not swallow a genuine init failure for this project.
    if (initReqId !== refs.initReqRef.current) return;
    setters.setError(e?.message || "Failed to initialize BhashaJS");
    console.error("[BhashaJS] Initialization error:", e);
  } finally {
    // isLoading is project-load state: only a newer init (project switch) may
    // keep the spinner up. A concurrent setLang has its OWN isLoading lifecycle
    // in applyLocale, so init still settles the spinner here under the init
    // guard — no stuck spinner after a mid-init setLang.
    if (initReqId === refs.initReqRef.current) setters.setIsLoading(false);
  }
}

/**
 * Atomically reset the locale machinery on a PROJECT SWITCH (projectId /
 * projectKey / apiUrl / apiToken changed, so the TranslationClient was
 * recreated). This is pulled out of the provider body so the load-bearing
 * race-fix can be unit-tested without a DOM render harness.
 *
 * It does two things, in this order, synchronously:
 *
 *  1. INVALIDATE IN-FLIGHT WORK from the previous project. `applyLocale` and the
 *     init effect's visible-locale commit capture `reqId = ++localeReq.current`
 *     up front and bail with `if (reqId !== localeReq.current) return` before
 *     committing lang/register/translations; the init effect's PROJECT-METADATA
 *     commits (supportedLangs/error/isLoading) capture `initReqRef` instead, so
 *     a plain setLang can't cancel them. Bumping BOTH counters here makes every
 *     reqId issued by the OLD project stale — neither a slow old locale fetch
 *     nor a slow old init can resolve and clobber the NEW client/state.
 *
 *  2. RESET both the pending locale target (refs) and the committed React state
 *     to the new project's defaults — clearing the old project's
 *     lang/register/error and emptying `supportedLangs` so the new project's
 *     languages reload. Resetting the pending refs keeps the atomic-locale
 *     setters diffing against the right baseline.
 *
 * Exported for tests.
 */
export function resetLocaleForProjectSwitch(
  refs: {
    localeReqRef: RefCell<number>;
    initReqRef: RefCell<number>;
    pendingLangRef: RefCell<string>;
    pendingRegisterRef: RefCell<Register>;
  },
  defaults: { defaultLang: string; register: Register },
  setters: {
    setCurrentLang: (lang: string) => void;
    setCurrentRegister: (register: Register) => void;
    setError: (error: string | null) => void;
    setIsLoading: (loading: boolean) => void;
    setSupportedLangs: (langs: string[]) => void;
  }
): void {
  // 1. Invalidate every reqId the previous project already issued — both the
  //    locale counter (in-flight applyLocale / init visible-locale commit) and
  //    the init counter (in-flight init's supportedLangs/error/isLoading commit).
  refs.localeReqRef.current++;
  refs.initReqRef.current++;

  // 2a. Reset the pending locale target to the new project's defaults.
  refs.pendingLangRef.current = defaults.defaultLang;
  refs.pendingRegisterRef.current = defaults.register;

  // 2b. Reset committed state: drop the old project's lang/register/error and
  //     reload the new project's supported languages from scratch.
  setters.setCurrentLang(defaults.defaultLang);
  setters.setCurrentRegister(defaults.register);
  setters.setError(null);
  setters.setIsLoading(true);
  setters.setSupportedLangs([]);
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
