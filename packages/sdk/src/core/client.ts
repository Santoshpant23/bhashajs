// FILE: packages/sdk/src/core/client.ts
//
// The TranslationClient is the engine of the SDK.
// It handles:
//   1. Fetching translations from the BhashaJS API
//   2. Caching them in memory so we don't re-fetch
//   3. Looking up a key with fallback chain support
//   4. String interpolation (replacing {name} with actual values)
//
// IMPORTANT: This class has ZERO React dependency.
// It's pure TypeScript. This means in the future, you could
// create a Vue or Svelte wrapper around the same client.
// The React-specific stuff lives in the hooks and components.

import { getFallbackChain } from "../utils/languages";
import { getPluralCategory } from "../utils/plurals";

export class TranslationClient {
  private projectId: string;
  private apiUrl: string;
  private apiToken: string;

  /**
   * Cache structure: { "hi": { "hero.title": "स्वागत" }, "bn": { ... } }
   * Once a language is fetched, it stays in this cache for the
   * lifetime of the app. No re-fetching unless the user refreshes.
   */
  private cache: Record<string, Record<string, string>> = {};

  /**
   * Tracks which languages are currently being fetched.
   * Prevents duplicate API calls if a component renders twice
   * before the first fetch completes (React Strict Mode does this).
   */
  private fetchPromises: Record<string, Promise<Record<string, string>>> = {};

  /** List of supported languages, fetched from the project endpoint */
  private supportedLangs: string[] = [];

  constructor(projectId: string, apiUrl: string, apiToken: string) {
    this.projectId = projectId;
    this.apiUrl = apiUrl;
    this.apiToken = apiToken;
  }

  /**
   * Load preloaded translations into the cache.
   * Used when developers bundle translations with their app
   * instead of fetching from the API.
   */
  preload(translations: Record<string, Record<string, string>>) {
    for (const [lang, strings] of Object.entries(translations)) {
      this.cache[lang] = strings;
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
   * Fetch translations for a specific language from the API.
   *
   * HOW IT WORKS:
   * 1. Check if translations are already in cache → return immediately
   * 2. Check if a fetch is already in progress → wait for that one
   * 3. Otherwise, make the API call, cache the result, return it
   *
   * The API endpoint GET /api/translations/:projectId?lang=hi
   * returns flat JSON: { "hero.title": "स्वागत", "nav.home": "होम" }
   */
  async fetchTranslations(lang: string): Promise<Record<string, string>> {
    // Already cached? Return immediately (instant language switching!)
    if (this.cache[lang]) {
      return this.cache[lang];
    }

    // Already fetching? Wait for the existing promise
    // This prevents duplicate API calls in React Strict Mode
    if (this.fetchPromises[lang]) {
      return this.fetchPromises[lang];
    }

    // Build the fetch promise
    const fetchPromise = (async () => {
      try {
        const url = `${this.apiUrl}/translations/${this.projectId}?lang=${lang}`;

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        // Attach auth token if provided
        if (this.apiToken) {
          headers["Authorization"] = `Bearer ${this.apiToken}`;
        }

        const response = await fetch(url, { headers });

        if (!response.ok) {
          throw new Error(`Failed to fetch translations: ${response.status}`);
        }

        const json = await response.json();

        // Our API returns { success: true, data: { ... } }
        const translations = json.data || json;

        // Cache the result
        this.cache[lang] = translations;

        return translations;
      } catch (error) {
        console.error(`[BhashaJS] Failed to load translations for "${lang}":`, error);
        // Return empty object so the app doesn't crash
        return {};
      } finally {
        // Clean up the promise tracker
        delete this.fetchPromises[lang];
      }
    })();

    // Store the promise so concurrent calls can wait for it
    this.fetchPromises[lang] = fetchPromise;

    return fetchPromise;
  }

  /**
   * Fetch project info to get the list of supported languages.
   */
  async fetchProjectInfo(): Promise<string[]> {
    try {
      const url = `${this.apiUrl}/projects/${this.projectId}`;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (this.apiToken) {
        headers["Authorization"] = `Bearer ${this.apiToken}`;
      }

      const response = await fetch(url, { headers });

      if (!response.ok) {
        throw new Error(`Failed to fetch project info: ${response.status}`);
      }

      const json = await response.json();
      const project = json.data || json;

      this.supportedLangs = project.supportedLanguages || [];
      return this.supportedLangs;
    } catch (error) {
      console.error("[BhashaJS] Failed to fetch project info:", error);
      return [];
    }
  }

  /**
   * THE CORE FUNCTION — Translate a key.
   *
   * How fallback works:
   * If we're in Bengali ("bn") and the key "hero.title" is missing,
   * the fallback chain is ["bn", "hi", "en"].
   * We check Bengali first, then Hindi, then English.
   * First match wins.
   *
   * PLURALIZATION:
   * If params contains a "count" key, we automatically resolve the
   * correct plural form using CLDR rules for the language.
   *
   * Example: t("items_count", { count: 0 })
   *   Hindi (0 is singular) → looks up "items_count_one"
   *   English (0 is plural) → looks up "items_count_other"
   *
   * Developers store plural keys as:
   *   "items_count_one":   "{count} आइटम"
   *   "items_count_other": "{count} आइटमें"
   *
   * If nothing is found anywhere, we return the key itself
   * (e.g. "hero.title") so the developer sees what's missing.
   *
   * @param key - The translation key (e.g. "hero.title")
   * @param lang - The current language code (e.g. "bn")
   * @param params - Optional interpolation values (e.g. { name: "Rohan" })
   */
  translate(
    key: string,
    lang: string,
    params?: Record<string, string | number>
  ): string {
    // Get the fallback chain for this language
    const chain = getFallbackChain(lang);

    // Determine the actual key to look up (handles pluralization)
    const resolvedKey = this.resolveKey(key, lang, chain, params);

    // Walk through the chain until we find a translation
    let result: string | undefined;

    for (const fallbackLang of chain) {
      const langCache = this.cache[fallbackLang];
      if (langCache && langCache[resolvedKey]) {
        result = langCache[resolvedKey];
        break;
      }
    }

    // If nothing found in any fallback, return the key itself
    if (!result) {
      return key;
    }

    // Handle interpolation: replace {name} with actual values
    // "Hello {name}, you have {count} items"
    // + { name: "Rohan", count: 5 }
    // = "Hello Rohan, you have 5 items"
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
   *
   * If params has a "count" key:
   *   1. Determine plural category ("one" or "other") for the language
   *   2. Try key + "_" + category (e.g. "items_count_one")
   *   3. Fall back to key + "_other"
   *   4. Fall back to the original key
   */
  private resolveKey(
    key: string,
    lang: string,
    chain: string[],
    params?: Record<string, string | number>
  ): string {
    // Only do pluralization if there's a count parameter
    if (!params || params.count === undefined) {
      return key;
    }

    const count = Number(params.count);
    const category = getPluralCategory(count, lang);

    // Try the pluralized key (e.g. "items_count_one")
    const pluralKey = `${key}_${category}`;
    if (this.keyExistsInChain(pluralKey, chain)) {
      return pluralKey;
    }

    // Fall back to _other if the specific category isn't found
    if (category !== "other") {
      const otherKey = `${key}_other`;
      if (this.keyExistsInChain(otherKey, chain)) {
        return otherKey;
      }
    }

    // Fall back to the original key (no pluralization)
    return key;
  }

  /**
   * Check if a key exists in any language in the fallback chain.
   */
  private keyExistsInChain(key: string, chain: string[]): boolean {
    for (const lang of chain) {
      if (this.cache[lang] && this.cache[lang][key]) {
        return true;
      }
    }
    return false;
  }
}
