// FILE: packages/sdk/src/types.ts
//
// Central type definitions for the entire SDK.
// Every interface the SDK uses lives here — components, hooks,
// and core logic all import from this one file.
//
// WHY: Having types in one place means if you change a type,
// you see all the places it affects. It also makes the SDK
// easier for other developers to understand — they look here
// to see what options are available.

/**
 * Configuration passed to <I18nProvider>.
 * This is the main setup developers do when integrating BhashaJS.
 */
export interface BhashaConfig {
  /**
   * Your project ID from the BhashaJS dashboard.
   * Required when using apiToken (JWT) auth.
   * Not needed when using projectKey.
   */
  projectId?: string;

  /**
   * Your project API key (starts with "bjs_").
   * Get this from Project Settings → API Key in the dashboard.
   * This is the recommended auth method for client-side apps.
   * Uses public /api/sdk/* endpoints — no JWT needed.
   */
  projectKey?: string;

  /**
   * The language to show by default when the app loads.
   * Should be one of your project's supported languages.
   * @default "en"
   */
  defaultLang?: string;

  /**
   * The base URL of your BhashaJS API.
   * Only change this if you self-host the backend.
   * @default "https://api.bhashajs.com"
   */
  apiUrl?: string;

  /**
   * Your API authentication token.
   * Get this from the BhashaJS dashboard under project settings.
   */
  apiToken?: string;

  /**
   * Preloaded translations — skip the API call entirely.
   * Useful for SSR or if you bundle translations with your app.
   * Format: { "en": { "hero.title": "Welcome" }, "hi": { "hero.title": "स्वागत" } }
   */
  preloadedTranslations?: Record<string, Record<string, string>>;

  /**
   * Called whenever the language changes.
   * Useful for analytics, saving preference to localStorage, etc.
   */
  onLanguageChange?: (lang: string) => void;

  /**
   * Region override (e.g. "IN", "BD", "PK", "LK", "NP").
   * Overrides the default region for the current language.
   * This affects currency formatting and Intl locale selection.
   *
   * Example: Bengali in Bangladesh uses ৳ (Taka), but Bengali in India uses ₹ (Rupee).
   * Set region="IN" to use Indian formatting for Bengali speakers in India.
   */
  region?: string;

  /**
   * The register (formality / style) to render translations at.
   *
   *   - "default" (default) — neutral conversational tone
   *   - "formal"            — high-formality, honorific, native-vocabulary
   *                           preferred. Good for legal, banking, gov, insurance.
   *   - "casual"            — Gen-Z friendly, code-mixing with English encouraged
   *                           where natural. Good for consumer, marketing, chat.
   *
   * If a string is missing in the requested register, the SDK falls back to
   * "default" before falling back through language chains.
   */
  register?: Register;

  /**
   * If true, also fetch the voice bundle (IPA + SSML) on init so
   * `formatPhonetic()` and `formatSSML()` return non-empty strings.
   *
   * Default: false. Most apps don't need voice data, so we don't pay the
   * extra round-trip unless explicitly requested.
   */
  voice?: boolean;
}

/**
 * Register = formality / style of a translation.
 */
export type Register = "default" | "formal" | "casual";

/**
 * The value provided by I18nContext to all child components.
 * This is what useTranslation() returns internally.
 */
export interface I18nContextValue {
  /** The currently active language code (e.g. "hi", "bn") */
  currentLang: string;

  /** Switch to a different language */
  setLang: (lang: string) => void;

  /** List of all languages this project supports */
  supportedLangs: string[];

  /** The currently active register ("default" | "formal" | "casual") */
  register: Register;

  /** Switch to a different register at runtime. */
  setRegister: (register: Register) => void;

  /**
   * The translation function — the most important thing in the SDK.
   * t("hero.title") returns the translated string for the current language and register.
   * t("greeting", { name: "Rohan" }) does interpolation.
   * t("items_count", { count: 5 }) does pluralization (looks up items_count_one or items_count_other).
   */
  t: (key: string, params?: Record<string, string | number>) => string;

  /** Whether translations are still being fetched from the API */
  isLoading: boolean;

  /** Error message if the API call failed */
  error: string | null;

  /**
   * Format a number using South Asian conventions.
   * Uses lakh/crore grouping (12,34,567 not 1,234,567).
   * Supports native digits (१२,३४,५६७) when useNativeDigits is true.
   */
  formatNumber: (value: number, options?: NumberFormatOptions) => string;

  /**
   * Format a currency value with the correct symbol for the current language/region.
   * Auto-detects currency (₹ for India, ৳ for Bangladesh, Rs for Pakistan).
   */
  formatCurrency: (value: number, options?: CurrencyFormatOptions) => string;

  /**
   * Format a date using South Asian conventions.
   * Defaults to DD/MM/YYYY format. Supports native digits.
   */
  formatDate: (date: Date | string | number, options?: DateFormatOptions) => string;

  /**
   * Get the IPA phonetic transcription for a key in the current (lang, register).
   * Returns an empty string if voice data hasn't been generated for this cell.
   * Useful for piping into custom TTS engines that prefer phonemic input.
   */
  formatPhonetic: (key: string) => string;

  /**
   * Get the SSML markup for a key in the current (lang, register).
   * SSML 1.0 with `<speak xml:lang="...">` wrapper, suitable for AWS Polly,
   * Google Cloud TTS, Azure Cognitive Services, ElevenLabs, etc.
   * Returns an empty string if voice data hasn't been generated.
   */
  formatSSML: (key: string) => string;
}

/**
 * Props for the <LanguageSwitcher> component.
 */
export interface LanguageSwitcherProps {
  /**
   * Where to position the switcher on the page.
   * Only applies when using the floating style.
   * @default "top-right"
   */
  position?: "top-right" | "top-left" | "bottom-right" | "bottom-left";

  /**
   * Visual style of the switcher.
   * "dropdown" = a select/dropdown menu (good for navbars)
   * "floating" = a fixed-position floating button (good for quick integration)
   * @default "dropdown"
   */
  style?: "dropdown" | "floating";

  /** Additional CSS class name for custom styling */
  className?: string;
}

/**
 * Information about a supported language.
 * Used internally for display names, fonts, direction, formatting, etc.
 */
export interface LangInfo {
  /** Language code (e.g. "hi") */
  code: string;
  /** Display name in the language's own script (e.g. "हिन्दी") */
  name: string;
  /** Display name in English (e.g. "Hindi") */
  englishName: string;
  /** Text direction */
  dir: "ltr" | "rtl";
  /** Recommended Google Font for this script */
  font: string;
  /** Script name (e.g. "Devanagari", "Bengali", "Nastaliq") */
  script: string;
  /** Default region/country code (e.g. "IN", "BD", "PK") */
  defaultRegion: string;
  /** Intl locale string for formatting (e.g. "hi-IN", "bn-BD") */
  intlLocale: string;
  /** Unicode numbering system for native digits (e.g. "deva", "beng", "tamldec") */
  numberingSystem: string;
  /** Default currency code (e.g. "INR", "BDT", "PKR") */
  defaultCurrency: string;
}

/**
 * Options for formatNumber().
 */
export interface NumberFormatOptions {
  /** Render digits in the native script (e.g. १२३ instead of 123) */
  useNativeDigits?: boolean;
  /** Use compact notation (e.g. "1.5L", "2Cr") */
  compact?: boolean;
}

/**
 * Options for formatCurrency().
 */
export interface CurrencyFormatOptions {
  /** Override the auto-detected currency code (e.g. "INR", "BDT", "PKR") */
  currency?: string;
  /** How to display the currency: symbol (₹), code (INR), or name (Indian rupees) */
  display?: "symbol" | "code" | "name";
  /** Render digits in the native script */
  useNativeDigits?: boolean;
}

/**
 * Options for formatDate().
 */
export interface DateFormatOptions {
  /**
   * Formatting preset:
   * - "short":  19/03/26
   * - "medium": 19 Mar 2026
   * - "long":   19 March 2026
   * - "full":   Thursday, 19 March 2026
   * @default "medium"
   */
  preset?: "short" | "medium" | "long" | "full";
  /** Render digits in the native script */
  useNativeDigits?: boolean;
}
