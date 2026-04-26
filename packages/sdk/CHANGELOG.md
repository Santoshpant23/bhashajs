# Changelog

All notable changes to `bhasha-js` are documented here.

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
