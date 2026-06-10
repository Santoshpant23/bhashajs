# Changelog

All notable changes to `bhasha-js` are documented here.

## 0.4.0 — 2026-06-07

A hardening release: correctness fixes across the engine, the CLI, and pluralization, plus stronger error handling. Backward compatible except for the plural-fallback correction noted below.

### Added
- **Offline/first-paint bundle cache.** Text bundles now persist to `localStorage` by default and load stale-while-revalidate; `persistCache: false` disables it. React and vanilla stores repaint when a background refresh changes copy.
- **`bhasha push`.** The CLI can push flat or nested locale JSON to the hosted/self-hosted dashboard using a write-capable scoped API key, and reports regulated keys that require human dashboard edits.
- **Nested locale JSON support.** `bhasha pull`, `bhasha scan`, and `bhasha push` flatten nested locale files with dot-joined keys.

### Fixed
- **Language/register switches could wedge the loading spinner forever and throw an unhandled rejection.** v0.3 guarded `init()`, but `setLang`/`setRegister`/`setSegment` did not — a failed fetch during a switch left `isLoading: true` with no error and rejected un-awaited. They now surface the error, clear loading, and never reject.
- **Interleaved language + register switches could commit a `(lang, register)` pair whose bundle was never fetched.** The two dimensions used separate request counters, so e.g. `setLang("hi")` + `setRegister("formal")` fired together could settle on `hi/formal` while only fetching `hi/default` and `en/formal`. The locale is now a single atomic target — an interleaved switch always fetches and commits the final pair (last-requested wins).
- **Pluralization is now CLDR-accurate, and the cross-fallback bug is fixed.** Two issues: (a) the plural category was computed for the *requested* language, then the key was resolved from a *fallback* language with different rules — so a Hindi `count: 0` that fell back to English rendered English's **singular** ("0 item") instead of its plural ("0 items") — now computed per resolved language; (b) the hand-rolled rules diverged from CLDR at decimals for Marathi/Sinhala/Punjabi. Plural categories now defer to the platform's `Intl.PluralRules` (CLDR-correct, including decimals) for every language **except** the deliberate South-Asian rule that **0 is singular** (e.g. Hindi/Marathi "0 आइटम"), which is preserved. *(Behavior change: decimal counts and cross-language fallbacks may now render the correct form where they previously didn't.)*
- **`bhasha pull` silently generated types from the 2-key local stub** for hosted-project users. With a `projectKey` configured it now defaults to the hosted API (use `--local` to force local), and it **auto-wires the generated `.d.ts` into your `tsconfig.json`** (or prints the exact line) so the type-safe keys actually take effect.
- **Unknown RTL language variants rendered left-to-right.** Codes outside the built-in table (e.g. `ur-IN`, `pa-Arab`) now infer `dir="rtl"` from the script instead of defaulting to LTR; `-Latn` variants stay LTR.
- **Engine robustness (`bhasha-js/vanilla`):** a throwing subscriber no longer starves other subscribers (`emit` isolates each), and `getState()` returns a copy so a consumer can't mutate internal state.
- The "used outside `<I18nProvider>`" error now points to `projectKey` (matching the docs), not the legacy `projectId`.

## 0.3.0 — 2026-06-01

### Added
- **`bhasha` CLI + type-safe keys.** Run `npx bhasha pull` to generate a declaration file that makes `t()` and `<Trans>` autocomplete your keys and raise a compile error on a typo. Commands: `init`, `pull` (local JSON or hosted API via `projectKey`), `scan`. Zero config needed — with no generated file, keys stay typed as `string` (fully backward compatible).
- **Server-safe entry `bhasha-js/server`.** The pure, React-free formatters (`formatNumber`/`formatCurrency`/`formatDate`, `getPluralCategory`, language helpers) importable inside a React Server Component / Next.js App Router server file / Node, with no `"use client"` boundary.
- **Framework-agnostic engine `bhasha-js/vanilla`.** A new `BhashaStore` (subscribe/emit) drives any UI — vanilla JS, Vue, Svelte, Solid, Angular, React Native — from the same engine the React components use. See the docs for Vue/Svelte/vanilla bindings.
- **Next.js App Router support.** The main `bhasha-js` entry now ships a `"use client"` directive, so the provider/hooks import cleanly into an App Router app. (The FAQ previously documented this wrong.)

### Fixed
- **`t()` interpolation could crash or silently corrupt copy.** A param key containing a regex metacharacter (e.g. `"a(b"`) threw and white-screened the render; a value containing `$&`/`$1`/`$$` was reinterpreted as a replacement pattern and garbled the output. Interpolation now uses literal replacement — both are fixed, and arbitrary param keys are supported.
- **`formatDate` rendered the literal English "Invalid Date"** into every locale on bad input. It now returns an empty string.
- **Lakh/crore grouping was wrong for Pakistan (PKR) and Sri Lanka (LKR)** — they fell back to Western 3-digit grouping. All supported South Asian currencies now group as `12,34,567`.
- **SSR crash.** Font injection and `<html>` lang/dir updates now no-op when there's no `document`, so the SDK renders on the server (Next.js, Astro, RSC) without throwing.
- **Rapid language/register switches** could let a slow earlier fetch overwrite a newer selection, or leave the loading spinner stuck. Switches are now request-guarded (last-requested wins).

## 0.2.1 — 2026-04-29

### Fixed
- **Default `apiUrl` was missing the `/api` prefix.** The hosted server mounts SDK routes at `/api/sdk/*`, so the previous default (`https://api.bhashajs.com`) produced 404s for every call. The default is now `https://api.bhashajs.com/api`. If you were already overriding `apiUrl` you don't need to change anything; if you were relying on the default, upgrade to 0.2.1 and remove the workaround.

## 0.2.0 — 2026-04-27

### Added
- **Register-aware translations** — every key supports `default`, `formal`, and `casual` variants per language. The casual register leans into code-mixing; the formal register sticks to native vocabulary. Pass `register` on `<I18nProvider>` or switch at runtime via `setRegister()`.
- **Code-mixed locales as first-class** — `hi-Latn` (Hinglish), `ne-Latn` (Roman Nepali), `ur-Latn` (Roman Urdu), `bn-Latn` (Banglish), `pa-Latn` (Roman Punjabi). Real locales with their own translation memory, plural rules (inheriting from base language), fallback chains (script affinity beats language affinity — Hinglish does NOT fall back to Devanagari Hindi), and currency.
- **Segment-aware register switching** — pass `userSegment` + `segmentRules` props. The SDK picks the active register at render time based on the user segment. Same `t("hero.cta")` returns "Add करो" for `genz` and "जोड़ें" for `enterprise`. Switch at runtime via `setSegment()` from `useTranslation()`.
- **Voice-ready outputs** — `formatPhonetic(key)` returns IPA, `formatSSML(key)` returns SSML 1.0 markup. Pass `voice: true` on the provider to pre-fetch voice bundles. Designed for AWS Polly, Google Cloud TTS, ElevenLabs.
- **Compliance lock awareness** — when the server has a key marked `regulated`, the SDK transparently skips AI-source values and falls back to default register or the key itself. AI drafts on regulated keys never reach end users until human-approved — no app-side change required.
- **Translation Memory flywheel exposure** — the dashboard surfaces TM coverage as a counter; the SDK is unchanged but customers can see their corpus growing toward the fine-tunable threshold.

### Changed
- `useTranslation()` returns now include `register`, `setRegister`, `currentSegment`, `setSegment`, `formatPhonetic`, `formatSSML`. All additive — existing apps keep working unchanged.
- The SDK now caches translations per `(lang, register)`; the API accepts `?register=` as an optional query param. The server falls back to `default` register so old SDKs (≤ 0.1.x) keep working against the new backend.

### Fixed
- `repository.url` and `bugs.url` corrected to `github.com/santoshpant23/bhashajs`.
- README links to the GitHub repo all fixed.

### Removed
- The `0.2.0-beta.0` tag is dropped — this is the stable 0.2.0 release.

## 0.1.0-beta.2 — 2026-04-26

### Added
- `projectKey` / `x-api-key` auth flow — the recommended client-side path. Works against the hosted `https://api.bhashajs.com` or any self-hosted backend. (Was in source previously but missing from the published bundle.)
- `region` prop on `<I18nProvider>` for region overrides (e.g. Bengali in IN vs BD).
- `formatNumber`, `formatCurrency`, `formatDate` utilities exposed via `useTranslation()` and as standalone exports.
- Native digit rendering (`useNativeDigits` option) for all 14 languages.
- Compact lakh/crore notation (`compact: true` → "1.5 लाख", "2 करोड़").
- CLDR-compliant pluralization helper `getPluralCategory()` and built-in plural resolution in `t()`.
- Culturally-aware fallback chains — Bengali → Hindi → English; Dravidian languages → English direct.
- 5 new languages: Punjabi-Shahmukhi (pa-PK), Gujarati (gu), Kannada (kn), Malayalam (ml), Sinhala (si). 14 total.
- `LANGUAGES` and `REGION_OVERRIDES` exports for advanced use cases.
- `useLangInfo()` hook returns full language metadata (script, font, dir, default region, locale, currency).

### Changed
- **Default `apiUrl` is now `https://api.bhashajs.com`** (was hardcoded to `localhost:5000` in 0.1.0-beta.1).
- Numbers and currency now consistently use Latin digits unless `useNativeDigits: true` is passed. Previously Bengali / Tamil / Sinhala silently used native digits because of locale defaults.
- `fetchProjectInfo` and `fetchTranslations` now throw on auth/network failure. The provider's `error` state populates with the actual HTTP status + body, so apps can surface meaningful errors instead of failing silently.
- Package keywords expanded for npm/Google search discoverability.

### Fixed
- README install command and import paths corrected from `bhashajs` to `bhasha-js`.
- Inconsistent default URLs across `client.ts`, `types.ts` JSDoc, and the published bundle — all now point at `https://api.bhashajs.com`.

## 0.1.0-beta.1 — 2026-03-22

Initial public beta. Known issues addressed in 0.1.0-beta.2.
