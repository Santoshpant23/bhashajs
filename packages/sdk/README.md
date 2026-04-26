# bhasha-js · भाषाJS

**React i18n built for South Asian languages** — Hindi, Bengali, Urdu, Tamil, Telugu, Marathi, Punjabi, Gujarati, Kannada, Malayalam, Nepali, Sinhala. RTL switching for Urdu, native script fonts, lakh/crore numbers (₹12,34,567), region-aware currency, and CLDR plurals — all out of the box.

[![npm version](https://img.shields.io/npm/v/bhasha-js.svg)](https://www.npmjs.com/package/bhasha-js)
[![license](https://img.shields.io/npm/l/bhasha-js.svg)](https://github.com/santoshpant613/bhashajs/blob/master/LICENSE)
[![bundle size](https://img.shields.io/bundlephobia/minzip/bhasha-js)](https://bundlephobia.com/package/bhasha-js)

```bash
npm install bhasha-js
```

```jsx
import { I18nProvider, useTranslation, LanguageSwitcher } from "bhasha-js";

const translations = {
  en: { "hero.title": "Welcome", "items": "{count} items" },
  hi: { "hero.title": "स्वागत है", "items": "{count} आइटम" },
  ur: { "hero.title": "خوش آمدید" },
};

export default function App() {
  return (
    <I18nProvider preloadedTranslations={translations} defaultLang="en">
      <LanguageSwitcher />
      <Page />
    </I18nProvider>
  );
}

function Page() {
  const { t, formatCurrency } = useTranslation();
  return (
    <>
      <h1>{t("hero.title")}</h1>
      <p>{t("items", { count: 5 })}</p>
      <p>{formatCurrency(1234567)}  {/* → ₹12,34,567.00 */}</p>
    </>
  );
}
```

That's the entire setup. Switch to Urdu and the layout flips RTL automatically. Switch to Bengali and the right Bengali font loads. Pass `count: 0` and Hindi correctly treats it as singular while English treats it as plural.

---

## Why bhasha-js

Generic i18n libraries (`i18next`, `react-intl`, `next-intl`) are technically language-agnostic — they support Hindi the same way they support German. That isn't enough for South Asian apps. **bhasha-js solves the things they ignore:**

| | i18next / react-intl | bhasha-js |
|---|---|---|
| Auto RTL/LTR switch | manual setup | automatic — sets `dir`, `lang`, CSS vars |
| Script-aware fonts | your problem | auto-loads Noto Sans Devanagari, Bengali, Tamil, Nastaliq Urdu, etc. |
| Lakh/crore grouping | generic `Intl` | `12,34,567` not `1,234,567` |
| Native digits | manual | `useNativeDigits` → १२,३४,५६७ / ১২,৩৪,৫৬৭ / ௧௨,௩௪,௫௬௭ |
| Plural rules | configure each language | built-in CLDR for 14 languages (Hindi 0=singular!) |
| Fallback chains | language → English | culturally-aware (Bengali → Hindi → English; Tamil → English direct) |
| Currency | your problem | region-aware (₹ for India, ৳ for Bangladesh, Rs for Pakistan, රු for Sri Lanka) |
| Bundle size | 10–30 kB | small, tree-shakeable |
| **Languages supported** | depends on your config | **14 South Asian languages pre-configured** |

---

## 3 ways to use bhasha-js

Pick whichever fits your project. You can switch modes later — the API is the same.

### Mode 1 · Bundled translations (no backend, 30 seconds)

The simplest path. Your translations live in your repo as JSON. Best for static sites, marketing pages, or apps with a small fixed string set.

```jsx
import { I18nProvider } from "bhasha-js";
import en from "./locales/en.json";
import hi from "./locales/hi.json";
import ur from "./locales/ur.json";

<I18nProvider
  preloadedTranslations={{ en, hi, ur }}
  defaultLang="en"
>
  <App />
</I18nProvider>
```

No API call. No backend. You ship the JSON in your bundle.

### Mode 2 · Hosted dashboard (recommended for production)

Sign up at **[bhashajs.com](https://bhashajs.com)**, create a project, get an API key, and translations are managed in a UI (with AI translation, team review, glossary, history).

```jsx
<I18nProvider
  projectKey="bjs_your_project_api_key_here"
  defaultLang="en"
>
  <App />
</I18nProvider>
```

The SDK fetches translations from `https://api.bhashajs.com` using the `x-api-key` header. Cached in memory after first load — language switching is instant.

### Mode 3 · Self-hosted

The whole stack is open source. `docker compose up` and you own it. Point the SDK at your URL:

```jsx
<I18nProvider
  projectKey="bjs_..."
  apiUrl="https://i18n.your-company.com/api"
  defaultLang="en"
>
  <App />
</I18nProvider>
```

See the [main repo](https://github.com/santoshpant613/bhashajs) for self-hosting docs.

---

## Features

### Auto RTL switching for Urdu

```jsx
const { setLang } = useTranslation();
setLang("ur");
// → <html lang="ur" dir="rtl">  — entire layout flips
setLang("hi");
// → <html lang="hi" dir="ltr">  — flips back
```

### Smart font loading

Each script needs the right font to render conjuncts correctly. bhasha-js loads them automatically:

| Script | Font |
|---|---|
| Devanagari (Hindi, Marathi, Nepali) | Noto Sans Devanagari |
| Bengali | Noto Sans Bengali |
| Urdu | Noto Nastaliq Urdu |
| Tamil | Noto Sans Tamil |
| Telugu | Noto Sans Telugu |
| Gurmukhi (Punjabi) | Noto Sans Gurmukhi |
| Gujarati | Noto Sans Gujarati |
| Kannada | Noto Sans Kannada |
| Malayalam | Noto Sans Malayalam |
| Sinhala | Noto Sans Sinhala |

The active font is exposed as the CSS variable `--bhasha-font` so you can use it in your own styles:

```css
body { font-family: var(--bhasha-font); }
```

### Lakh/crore numbers

```js
import { formatNumber } from "bhasha-js";

formatNumber(1234567, "hi");                           // → "12,34,567"
formatNumber(1234567, "hi", undefined, { useNativeDigits: true });  // → "१२,३४,५६७"
formatNumber(1500000, "hi", undefined, { compact: true });          // → "15 लाख"
formatNumber(20000000, "hi", undefined, { compact: true });         // → "2 करोड़"
```

> Note: `en` defaults to the `en-IN` locale — it uses lakh grouping and ₹. Pass `region="US"` (or the corresponding option to `formatNumber`) if you want Western formatting for English.

### Region-aware currency

```js
import { formatCurrency } from "bhasha-js";

formatCurrency(1500, "hi");          // → "₹1,500.00"  (Hindi defaults to India)
formatCurrency(1500, "bn");          // → "৳1,500.00"  (Bengali defaults to Bangladesh)
formatCurrency(1500, "bn", "IN");    // → "₹1,500.00"  (Bengali in India)
formatCurrency(1500, "ta", "LK");    // → "Rs. 1,500.00"  (Tamil in Sri Lanka)
formatCurrency(1500, "ur");          // → "Rs 1,500.00"  (Urdu defaults to Pakistan)
```

Currencies are auto-detected from language + region. Override with the `currency` option (`{ currency: "USD" }`).

### CLDR pluralization (Hindi 0 = singular!)

This is one of the most-broken things in other libraries. In Hindi (and most Indo-Aryan languages), **0 is treated as singular**, not plural.

```js
// In your translations file:
{
  "items_count_one": "{count} आइटम",
  "items_count_other": "{count} आइटम"
}

// In your component:
t("items_count", { count: 0 })   // Hindi → "0 आइटम"   (uses _one)
t("items_count", { count: 0 })   // English → "0 items"  (uses _other)
```

The SDK reads `count`, picks the correct CLDR category for the active language, and looks up the suffixed key (`_one` or `_other`).

### Culturally-aware fallback chains

If a translation is missing in the active language, the SDK walks a chain that makes linguistic sense:

| Language | Fallback |
|---|---|
| Hindi (hi) | hi → en |
| Bengali (bn) | bn → hi → en |
| Urdu (ur) | ur → hi → en |
| Marathi (mr) | mr → hi → en |
| Gujarati (gu) | gu → hi → en |
| Punjabi-Gurmukhi (pa) | pa → hi → en |
| Punjabi-Shahmukhi (pa-PK) | pa-PK → ur → en |
| Nepali (ne) | ne → hi → en |
| Tamil (ta) | ta → en *(no Hindi — different language family)* |
| Telugu (te) | te → en *(Dravidian)* |
| Kannada (kn) | kn → en *(Dravidian)* |
| Malayalam (ml) | ml → en *(Dravidian)* |
| Sinhala (si) | si → en |

Dravidian languages skip Hindi because they're from a completely different language family — falling back to a related language doesn't apply.

### String interpolation

```js
t("greeting", { name: "Rohan", count: 5 })
// "Hello {name}, you have {count} items" → "Hello Rohan, you have 5 items"
```

### Date formatting (DD/MM/YYYY)

```js
import { formatDate } from "bhasha-js";

formatDate(new Date(), "hi", undefined, { preset: "short" });  // "25/4/26"
formatDate(new Date(), "hi", undefined, { preset: "medium" }); // "25 अप्रैल 2026"
formatDate(new Date(), "hi", undefined, { preset: "long" });   // "25 अप्रैल 2026"
formatDate(new Date(), "hi", undefined, { preset: "full" });   // "शनिवार, 25 अप्रैल 2026"
formatDate(new Date(), "hi", undefined, { preset: "long", useNativeDigits: true });
// → "२५ अप्रैल २०२६"
```

---

## API reference

### `<I18nProvider>`

| Prop | Type | Default | Description |
|---|---|---|---|
| `projectKey` | `string` | — | Project API key (Mode 2/3). Recommended for production. |
| `projectId` + `apiToken` | `string` + `string` | — | JWT auth (advanced). |
| `preloadedTranslations` | `Record<string, Record<string, string>>` | — | Mode 1 — bundle translations into your app. |
| `defaultLang` | `string` | `"en"` | Initial language code. |
| `apiUrl` | `string` | `"https://api.bhashajs.com"` | Override for self-hosting. |
| `region` | `string` | — | Override default region (e.g. `"IN"`, `"BD"`, `"PK"`, `"LK"`, `"NP"`). Affects currency + locale. |
| `onLanguageChange` | `(lang: string) => void` | — | Callback fired whenever the language changes. |

### `useTranslation()`

```ts
const {
  t,                  // (key, params?) => string
  currentLang,        // "hi"
  setLang,            // (lang: string) => void
  supportedLangs,     // string[]
  isLoading,          // boolean
  error,              // string | null  ← surfaces auth/network errors
  formatNumber,       // (value, options?) => string
  formatCurrency,     // (value, options?) => string
  formatDate,         // (date, options?) => string
} = useTranslation();
```

### `useLangInfo()`

```ts
const { code, name, englishName, dir, font, script, defaultRegion, intlLocale, defaultCurrency } = useLangInfo();
```

### `<LanguageSwitcher>`

| Prop | Type | Default |
|---|---|---|
| `style` | `"dropdown" \| "floating"` | `"dropdown"` |
| `position` | `"top-right" \| "top-left" \| "bottom-right" \| "bottom-left"` | `"top-right"` |
| `className` | `string` | — |

### `<Trans>`

```jsx
<Trans id="hero.title" />
<Trans id="greeting" params={{ name: "Rohan" }} as="h1" />
```

### Standalone utilities (no React required)

```js
import {
  formatNumber, formatCurrency, formatDate,
  getPluralCategory, getFallbackChain, getLangInfo,
  LANGUAGES, REGION_OVERRIDES,
} from "bhasha-js";
```

---

## Supported languages (14 total · ~1.8 billion speakers)

| Code | Language | Native | Script | Direction | Default region | Default currency |
|---|---|---|---|---|---|---|
| `en` | English | English | Latin | LTR | IN | INR |
| `hi` | Hindi | हिन्दी | Devanagari | LTR | IN | INR |
| `bn` | Bengali | বাংলা | Bengali | LTR | BD | BDT |
| `ur` | Urdu | اردو | Nastaliq | RTL | PK | PKR |
| `ta` | Tamil | தமிழ் | Tamil | LTR | IN | INR |
| `te` | Telugu | తెలుగు | Telugu | LTR | IN | INR |
| `mr` | Marathi | मराठी | Devanagari | LTR | IN | INR |
| `ne` | Nepali | नेपाली | Devanagari | LTR | NP | NPR |
| `pa` | Punjabi (Gurmukhi) | ਪੰਜਾਬੀ | Gurmukhi | LTR | IN | INR |
| `pa-PK` | Punjabi (Shahmukhi) | پنجابی | Arabic-derived | RTL | PK | PKR |
| `gu` | Gujarati | ગુજરાતી | Gujarati | LTR | IN | INR |
| `kn` | Kannada | ಕನ್ನಡ | Kannada | LTR | IN | INR |
| `ml` | Malayalam | മലയാളം | Malayalam | LTR | IN | INR |
| `si` | Sinhala | සිංහල | Sinhala | LTR | LK | LKR |

---

## FAQ

**Does this work with Next.js?**
Yes. Wrap your `app/layout.tsx` with `<I18nProvider>`. For SSR, use `preloadedTranslations` and pass the user's language via cookies/headers.

**Does this work without React?**
The core utilities (`formatNumber`, `formatCurrency`, `formatDate`, `getPluralCategory`, etc.) are framework-agnostic. The components/hooks need React 17+.

**How do I integrate AI translation?**
Use Mode 2 (hosted dashboard) — there's a "Translate with AI" button per language. Or use the `/api/translations/:projectId/ai-translate` endpoint if self-hosted.

**Bundle size?**
Tree-shakeable ESM. If you only use `formatCurrency` and `formatNumber`, that's what ships. Components and hooks are imported separately.

**Does it work with React Native?**
The utilities work. The components rely on `document` for RTL switching and Google Fonts loading, so you'd need a thin RN wrapper. Open an issue if this is interesting to you.

---

## Links

- 🌐 Website + dashboard: https://bhashajs.com
- 📚 Docs: https://bhashajs.com/docs
- 🔧 Source: https://github.com/santoshpant613/bhashajs
- 🐛 Issues: https://github.com/santoshpant613/bhashajs/issues

## License

MIT © Santosh Pant
