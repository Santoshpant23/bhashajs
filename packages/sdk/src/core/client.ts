// FILE: packages/sdk/src/core/client.ts
//
// The TranslationClient is the engine of the SDK.
// It handles:
//   1. Fetching translations from the BhashaJS API per (lang, register)
//   2. Caching them in memory so we don't re-fetch
//   3. Looking up a key with register + language fallback chain support
//   4. String interpolation (replacing {name} with actual values)
//
// IMPORTANT: This class has ZERO React dependency.
// It's pure TypeScript. This means in the future, you could
// create a Vue or Svelte wrapper around the same client.
// The React-specific stuff lives in the hooks and components.
//
// REGISTER FALLBACK:
// A request for "casual" Hindi falls back to "default" Hindi if the casual
// translation is missing — so a partially-localized casual register still
// produces a usable bundle. Then the language fallback chain kicks in
// (e.g. casual Bengali → default Bengali → default Hindi → English).

import { getFallbackChain } from "../utils/languages";
import { getPluralCategory } from "../utils/plurals";
import type { Register } from "../types";

const DEFAULT_REGISTER: Register = "default";

/** Compose the cache key. We flatten (lang, register) so the inner cache
 *  stays a simple Record<key, string>. */
function bundleKey(lang: string, register: Register): string {
  return `${lang}:${register}`;
}

export class TranslationClient {
  private projectId: string;
  private apiUrl: string;
  private apiToken: string;
  private projectKey: string;

  /**
   * Cache structure: keyed by `${lang}:${register}`, mapping to a flat
   * Record<key, translation>. So:
   *   cache["hi:default"] = { "hero.title": "स्वागत" }
   *   cache["hi:casual"]  = { "hero.title": "Welcome है" }
   * Once a (lang, register) bundle is fetched, it stays in the cache for the
   * lifetime of the app.
   */
  private cache: Record<string, Record<string, string>> = {};

  /**
   * Tracks which (lang, register) bundles are currently being fetched.
   * Prevents duplicate API calls if a component renders twice
   * before the first fetch completes (React Strict Mode does this).
   */
  private fetchPromises: Record<string, Promise<Record<string, string>>> = {};

  /** List of supported languages, fetched from the project endpoint */
  private supportedLangs: string[] = [];

  constructor(projectId: string, apiUrl: string, apiToken: string, projectKey: string = "") {
    this.projectId = projectId;
    this.apiUrl = apiUrl;
    this.apiToken = apiToken;
    this.projectKey = projectKey;
  }

  /** Whether this client uses the public SDK endpoints (API key auth) */
  private get usePublicEndpoints(): boolean {
    return !!this.projectKey;
  }

  /**
   * Load preloaded translations into the cache.
   * Accepts both shapes for backwards compat:
   *   1. Flat (legacy):   { "hi": { "hero.title": "स्वागत" } }
   *      → loaded into the "default" register.
   *   2. Nested:          { "hi": { "default": { "hero.title": "स्वागत" },
   *                                  "casual":  { "hero.title": "Welcome है" } } }
   */
  preload(
    translations: Record<
      string,
      Record<string, string> | Partial<Record<Register, Record<string, string>>>
    >
  ): void {
    for (const [lang, body] of Object.entries(translations)) {
      // Heuristic: a register bundle is a "register" key whose value is itself
      // a Record<string, string>. If we see strings as direct values, this is
      // the legacy flat shape and we lift it to "default".
      const looksLikeRegisterMap = Object.values(body).every(
        (v) => typeof v === "object" && v !== null && !Array.isArray(v)
      );

      if (looksLikeRegisterMap) {
        for (const [reg, strings] of Object.entries(body)) {
          if (reg !== "default" && reg !== "formal" && reg !== "casual") continue;
          this.cache[bundleKey(lang, reg as Register)] = strings as Record<string, string>;
        }
      } else {
        this.cache[bundleKey(lang, DEFAULT_REGISTER)] = body as Record<string, string>;
      }
    }
  }

  /**
   * Set the list of supported languages.
   * Called by the provider after fetching project info.
   */
  setSupportedLangs(langs: string[]) {
    this.supportedLangs = langs;
  }

  getSupportedLangs(): string[] {
    return this.supportedLangs;
  }

  /**
   * Fetch translations for a specific (language, register) bundle from the API.
   *
   * HOW IT WORKS:
   * 1. Check if the bundle is already in cache → return immediately
   * 2. Check if a fetch is already in progress → wait for that one
   * 3. Otherwise, make the API call, cache the result, return it
   *
   * The API endpoint GET /api/sdk/translations?lang=hi&register=casual
   * returns flat JSON: { "hero.title": "Welcome है" } — already collapsed
   * server-side with default-register fallback baked in.
   */
  async fetchTranslations(
    lang: string,
    register: Register = DEFAULT_REGISTER
  ): Promise<Record<string, string>> {
    const cacheKey = bundleKey(lang, register);

    // Already cached? Return immediately (instant language switching!)
    if (this.cache[cacheKey]) {
      return this.cache[cacheKey];
    }

    // Already fetching? Wait for the existing promise
    // This prevents duplicate API calls in React Strict Mode
    if (cacheKey in this.fetchPromises) {
      return this.fetchPromises[cacheKey];
    }

    // Build the fetch promise. Errors propagate so the I18nProvider can expose
    // them via its `error` state — silent failure made auth bugs invisible.
    const fetchPromise = (async () => {
      try {
        const params = `lang=${encodeURIComponent(lang)}&register=${encodeURIComponent(register)}`;
        const url = this.usePublicEndpoints
          ? `${this.apiUrl}/sdk/translations?${params}`
          : `${this.apiUrl}/translations/${this.projectId}?${params}`;

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        if (this.usePublicEndpoints) {
          headers["x-api-key"] = this.projectKey;
        } else if (this.apiToken) {
          headers["Authorization"] = `Bearer ${this.apiToken}`;
        }

        const response = await fetch(url, { headers });

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(
            `BhashaJS: failed to load translations for "${lang}/${register}" (HTTP ${response.status})${detail ? ": " + detail : ""}`
          );
        }

        const json = await response.json();
        const translations = json.data || json;

        this.cache[cacheKey] = translations;
        return translations;
      } finally {
        delete this.fetchPromises[cacheKey];
      }
    })();

    // Store the promise so concurrent calls can wait for it
    this.fetchPromises[cacheKey] = fetchPromise;

    return fetchPromise;
  }

  /**
   * Fetch project info to get the list of supported languages.
   * Throws on auth/network failure so the provider can surface the error.
   */
  async fetchProjectInfo(): Promise<string[]> {
    const url = this.usePublicEndpoints
      ? `${this.apiUrl}/sdk/project`
      : `${this.apiUrl}/projects/${this.projectId}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.usePublicEndpoints) {
      headers["x-api-key"] = this.projectKey;
    } else if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `BhashaJS: failed to fetch project info (HTTP ${response.status})${detail ? ": " + detail : ""}`
      );
    }

    const json = await response.json();
    const project = json.data || json;

    this.supportedLangs = project.supportedLanguages || [];
    return this.supportedLangs;
  }

  /**
   * THE CORE FUNCTION — Translate a key.
   *
   * How fallback works:
   *   1. Try the requested (lang, register) bundle.
   *   2. If empty, try the same lang at "default" register.
   *   3. If still empty, walk the language fallback chain at "default".
   * First match wins.
   *
   * PLURALIZATION:
   * If params contains a "count" key, we automatically resolve the
   * correct plural form using CLDR rules for the language.
   *
   * @param key - The translation key (e.g. "hero.title")
   * @param lang - The current language code (e.g. "bn")
   * @param register - The current register ("default" | "formal" | "casual")
   * @param params - Optional interpolation values (e.g. { name: "Rohan" })
   */
  translate(
    key: string,
    lang: string,
    register: Register = DEFAULT_REGISTER,
    params?: Record<string, string | number>
  ): string {
    const chain = getFallbackChain(lang);
    const resolvedKey = this.resolveKey(key, lang, register, chain, params);

    let result: string | undefined;

    // Walk: each fallback lang × [requested register, "default"].
    // We try the same register across all langs first? No — if the user wants
    // casual Hindi but only formal Hindi exists, falling back to formal Hindi
    // is better than falling back to casual English. So per-lang we try
    // [register, default], then move on.
    outer: for (const fallbackLang of chain) {
      for (const reg of registerFallback(register)) {
        const langCache = this.cache[bundleKey(fallbackLang, reg)];
        if (langCache && langCache[resolvedKey]) {
          result = langCache[resolvedKey];
          break outer;
        }
      }
    }

    // If nothing found in any fallback, return the key itself
    if (!result) {
      return key;
    }

    // Handle interpolation: replace {name} with actual values
    if (params) {
      for (const [paramKey, paramValue] of Object.entries(params)) {
        result = result.replace(
          new RegExp(`\\{${paramKey}\\}`, "g"),
          String(paramValue)
        );
      }
    }

    return result;
  }

  /**
   * Resolve the actual translation key, handling pluralization.
   */
  private resolveKey(
    key: string,
    lang: string,
    register: Register,
    chain: string[],
    params?: Record<string, string | number>
  ): string {
    // Only do pluralization if there's a count parameter
    if (!params || params.count === undefined) {
      return key;
    }

    const count = Number(params.count);
    const category = getPluralCategory(count, lang);

    const pluralKey = `${key}_${category}`;
    if (this.keyExistsInChain(pluralKey, chain, register)) {
      return pluralKey;
    }

    if (category !== "other") {
      const otherKey = `${key}_other`;
      if (this.keyExistsInChain(otherKey, chain, register)) {
        return otherKey;
      }
    }

    return key;
  }

  /**
   * Check if a key exists in any (language, register) in the chain.
   */
  private keyExistsInChain(key: string, chain: string[], register: Register): boolean {
    for (const lang of chain) {
      for (const reg of registerFallback(register)) {
        const cache = this.cache[bundleKey(lang, reg)];
        if (cache && cache[key]) return true;
      }
    }
    return false;
  }
}

/** Within a single language, prefer the requested register but fall back to default. */
function registerFallback(register: Register): Register[] {
  return register === DEFAULT_REGISTER ? [DEFAULT_REGISTER] : [register, DEFAULT_REGISTER];
}
