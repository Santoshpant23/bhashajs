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
type ClientOptions = {
  persistCache?: boolean;
};

/** Compose the cache key. We flatten (lang, register) so the inner cache
 *  stays a simple Record<key, string>. */
function bundleKey(lang: string, register: Register): string {
  return `${lang}:${register}`;
}

function ownString(obj: Record<string, string>, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function ownVoice(
  obj: Record<string, { ipa: string; ssml: string }>,
  key: string
): { ipa: string; ssml: string } | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  const value = obj[key];
  if (!value || typeof value !== "object") return undefined;
  return value;
}

export class TranslationClient {
  private projectId: string;
  private apiUrl: string;
  private apiToken: string;
  private projectKey: string;
  private persistCache: boolean;
  private onBundleUpdate?: () => void;

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
   * Voice cache, parallel to `cache` but per-(lang, register, key) holding
   * { ipa, ssml }. Populated lazily by `fetchVoice` — populated only when
   * the developer enables voice mode or calls `formatPhonetic` / `formatSSML`
   * before the first paint.
   */
  private voiceCache: Record<string, Record<string, { ipa: string; ssml: string }>> = {};

  /**
   * Tracks which (lang, register) bundles are currently being fetched.
   * Prevents duplicate API calls if a component renders twice
   * before the first fetch completes (React Strict Mode does this).
   */
  private fetchPromises: Record<string, Promise<Record<string, string>>> = {};

  /** In-flight voice-bundle fetches, indexed the same way as fetchPromises. */
  private voiceFetchPromises: Record<string, Promise<Record<string, { ipa: string; ssml: string }>>> = {};

  /** List of supported languages, fetched from the project endpoint */
  private supportedLangs: string[] = [];

  constructor(
    projectId: string,
    apiUrl: string,
    apiToken: string,
    projectKey: string = "",
    options: ClientOptions = {}
  ) {
    this.projectId = projectId;
    this.apiUrl = apiUrl;
    this.apiToken = apiToken;
    this.projectKey = projectKey;
    this.persistCache = options.persistCache !== false;
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

  setOnBundleUpdate(fn?: (() => void) | null): void {
    this.onBundleUpdate = fn || undefined;
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

    const persisted = this.readPersistedBundle(lang, register);
    if (persisted) {
      this.cache[cacheKey] = persisted;
      this.refreshTranslationsInBackground(lang, register, cacheKey, persisted);
      return persisted;
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
        this.writePersistedBundle(lang, register, translations);
        return translations;
      } finally {
        delete this.fetchPromises[cacheKey];
      }
    })();

    // Store the promise so concurrent calls can wait for it
    this.fetchPromises[cacheKey] = fetchPromise;

    return fetchPromise;
  }

  private refreshTranslationsInBackground(
    lang: string,
    register: Register,
    cacheKey: string,
    current: Record<string, string>
  ): void {
    if (cacheKey in this.fetchPromises) return;
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
        if (!response.ok) return current;

        const json = await response.json();
        const fresh = json.data || json;
        if (JSON.stringify(fresh) !== JSON.stringify(current)) {
          this.cache[cacheKey] = fresh;
          this.writePersistedBundle(lang, register, fresh);
          this.onBundleUpdate?.();
        }
        return fresh;
      } catch {
        return current;
      } finally {
        delete this.fetchPromises[cacheKey];
      }
    })();
    this.fetchPromises[cacheKey] = fetchPromise;
  }

  private persistedStorageKey(lang: string, register: Register): string {
    return `bhashajs:b1:${this.projectKey || this.projectId}:${lang}:${register}`;
  }

  private persistedLangsKey(): string {
    return `bhashajs:p1:${this.projectKey || this.projectId}`;
  }

  private readPersistedLangs(): string[] | null {
    if (!this.persistCache || typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(this.persistedLangsKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.langs)) return null;
      return parsed.langs.filter((l: unknown) => typeof l === "string");
    } catch {
      return null;
    }
  }

  private writePersistedLangs(langs: string[]): void {
    if (!this.persistCache || typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(
        this.persistedLangsKey(),
        JSON.stringify({ v: 1, t: Date.now(), langs })
      );
    } catch {
      // Storage is best-effort: quota/privacy-mode errors must not break i18n.
    }
  }

  private readPersistedBundle(lang: string, register: Register): Record<string, string> | null {
    if (!this.persistCache || typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(this.persistedStorageKey(lang, register));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== 1 || !parsed.data || typeof parsed.data !== "object") {
        return null;
      }
      return parsed.data;
    } catch {
      return null;
    }
  }

  private writePersistedBundle(
    lang: string,
    register: Register,
    data: Record<string, string>
  ): void {
    if (!this.persistCache || typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(
        this.persistedStorageKey(lang, register),
        JSON.stringify({ v: 1, t: Date.now(), data })
      );
    } catch {
      // Storage is best-effort: quota/privacy-mode errors must not break i18n.
    }
  }

  /**
   * Fetch the voice bundle for a (lang, register). Same auth model as
   * `fetchTranslations`, separate endpoint. Cached so future calls are
   * instant. Errors propagate so the provider can expose them.
   */
  async fetchVoice(
    lang: string,
    register: Register = DEFAULT_REGISTER
  ): Promise<Record<string, { ipa: string; ssml: string }>> {
    const cacheKey = bundleKey(lang, register);
    if (this.voiceCache[cacheKey]) return this.voiceCache[cacheKey];
    if (cacheKey in this.voiceFetchPromises) return this.voiceFetchPromises[cacheKey];

    const fetchPromise = (async () => {
      try {
        const params = `lang=${encodeURIComponent(lang)}&register=${encodeURIComponent(register)}`;
        const url = this.usePublicEndpoints
          ? `${this.apiUrl}/sdk/voice?${params}`
          : `${this.apiUrl}/translations/${this.projectId}?${params}`; // JWT path doesn't have voice yet — return empty

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (this.usePublicEndpoints) headers["x-api-key"] = this.projectKey;
        else if (this.apiToken) headers["Authorization"] = `Bearer ${this.apiToken}`;

        const response = await fetch(url, { headers });
        if (!response.ok) {
          // Soft-fail: voice data is optional, never block the app.
          this.voiceCache[cacheKey] = {};
          return this.voiceCache[cacheKey];
        }
        const json = await response.json();
        // The /translations endpoint doesn't return a voice bundle; only /sdk/voice does.
        // If the response shape doesn't match { ipa, ssml }, fall back to empty.
        const data = json.data || json;
        const looksLikeVoice =
          data && typeof data === "object" &&
          Object.values(data).every((v: any) => v && typeof v === "object" && "ipa" in v && "ssml" in v);
        const bundle: Record<string, { ipa: string; ssml: string }> = looksLikeVoice ? data : {};
        this.voiceCache[cacheKey] = bundle;
        return bundle;
      } finally {
        delete this.voiceFetchPromises[cacheKey];
      }
    })();

    this.voiceFetchPromises[cacheKey] = fetchPromise;
    return fetchPromise;
  }

  /**
   * Look up voice data for a key, walking the same fallback chain as
   * `translate()` — register-then-language. Returns undefined if no voice
   * bundle has been loaded for any matching (lang, register).
   */
  getVoice(
    key: string,
    lang: string,
    register: Register = DEFAULT_REGISTER
  ): { ipa: string; ssml: string } | undefined {
    const chain = getFallbackChain(lang);
    for (const fallbackLang of chain) {
      for (const reg of registerFallback(register)) {
        const bundle = this.voiceCache[bundleKey(fallbackLang, reg)];
        if (bundle) {
          const cell = ownVoice(bundle, key);
          if (cell) return cell;
        }
      }
    }
    return undefined;
  }

  /**
   * Preload voice data into the cache. Useful for SSR or bundling voice with
   * the app. Accepts the same shape as the API response.
   */
  preloadVoice(
    voice: Record<
      string,
      Partial<Record<Register, Record<string, { ipa: string; ssml: string }>>>
    >
  ): void {
    for (const [lang, byRegister] of Object.entries(voice)) {
      for (const [reg, bundle] of Object.entries(byRegister)) {
        if (reg !== "default" && reg !== "formal" && reg !== "casual") continue;
        if (!bundle) continue;
        this.voiceCache[bundleKey(lang, reg as Register)] = bundle;
      }
    }
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

    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (networkError) {
      // OFFLINE / network failure (not an HTTP error): fall back to the
      // persisted language list so a cold start can still serve cached
      // bundles. An HTTP-level rejection (e.g. a revoked key → 401) is a real
      // error and still throws below — never masked by the cache.
      const cached = this.readPersistedLangs();
      if (cached && cached.length > 0) {
        this.supportedLangs = cached;
        return this.supportedLangs;
      }
      throw networkError;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `BhashaJS: failed to fetch project info (HTTP ${response.status})${detail ? ": " + detail : ""}`
      );
    }

    const json = await response.json();
    const project = json.data || json;

    this.supportedLangs = project.supportedLanguages || [];
    this.writePersistedLangs(this.supportedLangs);
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
    const hasCount = params != null && params.count !== undefined;
    const count = hasCount ? Number(params.count) : 0;

    let result: string | undefined;

    // Walk: each fallback lang × [requested register, "default"].
    // We try the same register across all langs first? No — if the user wants
    // casual Hindi but only formal Hindi exists, falling back to formal Hindi
    // is better than falling back to casual English. So per-lang we try
    // [register, default], then move on.
    //
    // PLURALIZATION happens PER CELL, using each fallback language's OWN rule —
    // not the requested language's. Otherwise a Hindi count=0 (category "one")
    // that falls back to English would pick English's "_one" cell and render
    // English's singular ("0 item") instead of its correct plural ("0 items").
    // A language's own base key also wins over a fallback language's plural form.
    outer: for (const fallbackLang of chain) {
      for (const reg of registerFallback(register)) {
        const langCache = this.cache[bundleKey(fallbackLang, reg)];
        if (!langCache) continue;

        if (hasCount) {
          const category = getPluralCategory(count, fallbackLang);
          const categoryValue = ownString(langCache, `${key}_${category}`);
          if (categoryValue) {
            result = categoryValue;
            break outer;
          }
          const otherValue = category !== "other" ? ownString(langCache, `${key}_other`) : undefined;
          if (otherValue) {
            result = otherValue;
            break outer;
          }
        }

        const value = ownString(langCache, key);
        if (value) {
          result = value;
          break outer;
        }
      }
    }

    // If nothing found in any fallback, return the key itself
    if (!result) {
      return key;
    }

    // Handle interpolation: replace {name} with actual values.
    //
    // We use a literal split/join rather than `String.replace(RegExp, value)`
    // on purpose. The RegExp approach had two real bugs:
    //   1. The param KEY was spliced raw into a RegExp source, so a key
    //      containing a metacharacter (e.g. "a(b") threw a SyntaxError and
    //      crashed the render; a key like "a.b" silently failed to match.
    //   2. The param VALUE was used as the replacement string, so values
    //      containing `$&`, `$1`, `` $` ``, `$$` were reinterpreted as
    //      replacement patterns and silently corrupted the output.
    // split(literal).join(literal) treats both key and value as plain text,
    // fixing both at once and supporting arbitrary param keys.
    if (params) {
      for (const [paramKey, paramValue] of Object.entries(params)) {
        result = result.split(`{${paramKey}}`).join(String(paramValue));
      }
    }

    return result;
  }

}

/** Within a single language, prefer the requested register but fall back to default. */
function registerFallback(register: Register): Register[] {
  return register === DEFAULT_REGISTER ? [DEFAULT_REGISTER] : [register, DEFAULT_REGISTER];
}
