# भाषाJS

**The first i18n developer tool purpose-built for South Asian languages.**

BhashaJS handles the hard parts of South Asian localization that other i18n libraries ignore: RTL/LTR auto-switching for Urdu, correct fonts for every script, culturally-aware fallback chains, and the lakh/crore number system.

## Quick Start

```bash
npm install bhashajs
```

### 1. Wrap your app

```jsx
import { I18nProvider, LanguageSwitcher } from 'bhashajs';

function App() {
  return (
    <I18nProvider
      projectId="your-project-id"
      apiToken="your-token"
      defaultLang="en"
    >
      <LanguageSwitcher style="floating" position="top-right" />
      <YourApp />
    </I18nProvider>
  );
}
```

### 2. Translate your text

```jsx
import { useTranslation } from 'bhashajs';

function HomePage() {
  const { t } = useTranslation();

  return (
    <div>
      <h1>{t('hero.title')}</h1>
      <p>{t('hero.subtitle')}</p>
      <p>{t('greeting', { name: 'Rohan' })}</p>
    </div>
  );
}
```

That's it. Your app now supports multiple languages.

## Features

### Automatic RTL Support
When a user switches to Urdu, BhashaJS automatically sets `dir="rtl"` on the document, flipping your entire layout. Switch back to Hindi and it reverts to LTR. Zero config needed.

### Smart Font Loading
Each South Asian script needs a specific font to render correctly. BhashaJS automatically loads the right Google Font when a language is selected:
- Hindi/Marathi/Nepali → Noto Sans Devanagari
- Bengali → Noto Sans Bengali
- Urdu → Noto Nastaliq Urdu
- Tamil → Noto Sans Tamil
- Telugu → Noto Sans Telugu
- Punjabi → Noto Sans Gurmukhi

### Culturally-Aware Fallbacks
If a Bengali translation is missing, BhashaJS falls back to Hindi before English — because a Bengali speaker is more likely to understand Hindi. This is configurable per language.

### Interpolation
```jsx
// In your dashboard: "greeting" → "नमस्ते {name}, आपके पास {count} आइटम हैं"
t('greeting', { name: 'Rohan', count: 5 })
// → "नमस्ते Rohan, आपके पास 5 आइटम हैं"
```

## API Reference

### `<I18nProvider>`
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| projectId | string | required | Your BhashaJS project ID |
| defaultLang | string | "en" | Initial language |
| apiUrl | string | localhost:5000 | BhashaJS API URL |
| apiToken | string | — | Your API auth token |
| preloadedTranslations | object | — | Skip API, use bundled translations |
| onLanguageChange | function | — | Callback when language changes |

### `useTranslation()`
```jsx
const { t, currentLang, setLang, supportedLangs, isLoading, error } = useTranslation();
```

### `<LanguageSwitcher>`
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| style | "dropdown" \| "floating" | "dropdown" | Visual style |
| position | "top-right" \| "top-left" \| "bottom-right" \| "bottom-left" | "top-right" | Floating position |
| className | string | — | Custom CSS class |

### `<Trans>` Component
```jsx
<Trans id="hero.title" />
<Trans id="greeting" params={{ name: 'Rohan' }} as="h1" />
```

### `useLangInfo()`
```jsx
const { dir, font, name, englishName } = useLangInfo();
```

## Supported Languages

| Code | Language | Script | Direction |
|------|----------|--------|-----------|
| en | English | Latin | LTR |
| hi | हिन्दी (Hindi) | Devanagari | LTR |
| bn | বাংলা (Bengali) | Bengali | LTR |
| ur | اردو (Urdu) | Nastaliq | RTL |
| ta | தமிழ் (Tamil) | Tamil | LTR |
| te | తెలుగు (Telugu) | Telugu | LTR |
| mr | मराठी (Marathi) | Devanagari | LTR |
| ne | नेपाली (Nepali) | Devanagari | LTR |
| pa | ਪੰਜਾਬੀ (Punjabi) | Gurmukhi | LTR |

## License
MIT
