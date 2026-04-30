# Changelog

All notable changes to `bhasha-js` are documented here.

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
