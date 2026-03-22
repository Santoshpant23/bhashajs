# भाषाJS — BhashaJS

The first i18n developer tool purpose-built for South Asian languages.

BhashaJS is an open-source internationalization platform that provides AI-powered translations, a management dashboard, and a React SDK — all designed specifically for Hindi, Bengali, Urdu, Tamil, Telugu, Marathi, Nepali, Punjabi, Gujarati, Kannada, Malayalam, and Sinhala.

## Features

- **React SDK** (`bhasha-js`) — `<I18nProvider>`, `useTranslation()` hook, `<LanguageSwitcher>`, `<Trans>` component
- **South Asian formatting** — lakh/crore number grouping, native digits, regional currency symbols
- **RTL support** — automatic layout flipping for Urdu
- **Script-aware fonts** — auto-loads the right Google Font per language
- **Fallback chains** — Bengali falls back to Hindi before English
- **CLDR pluralization** — correct plural rules for every supported language
- **AI translations** — Google Gemini-powered with translation memory and glossary enforcement
- **Dashboard** — manage keys, invite translators, review AI translations, export to CSV/Android XML/iOS .strings
- **Team collaboration** — owner/translator/viewer roles with per-language assignments
- **Version history** — full audit trail of every translation change
- **API key auth** — developers get a project API key, no JWT needed in client apps

## Architecture

```
packages/
  sdk/         — React SDK (npm: bhasha-js)
  server/      — Express + MongoDB API
  dashboard/   — React + Vite admin UI
```

## Quick Start (Development)

```bash
# Prerequisites: Node 20+, MongoDB running locally (or use Docker)

# 1. Clone
git clone https://github.com/user/bhashajs.git
cd bhashajs

# 2. Install dependencies
npm install
cd packages/server && npm install && cd ../..
cd packages/dashboard && npm install && cd ../..
cd packages/sdk && npm install && cd ../..

# 3. Configure
cp .env.example .env
# Edit .env — add your JWT_SECRET and GEMINI_API_KEY

# 4. Start MongoDB (if not using Docker)
# Option A: Docker
docker run -d -p 27017:27017 mongo:7
# Option B: local install
mongod

# 5. Run
npm run dev:server    # API on :5000
npm run dev:dashboard # Dashboard on :5173
```

## Quick Start (Docker — Production)

```bash
cp .env.example .env
# Fill in .env with real values

docker compose up --build -d
# Dashboard: http://localhost
# API: http://localhost/api
```

## SDK Usage

```bash
npm install bhasha-js
```

```tsx
import { I18nProvider, useTranslation, LanguageSwitcher } from "bhasha-js";

function App() {
  return (
    <I18nProvider
      projectKey="bjs_your_api_key_here"
      defaultLang="en"
    >
      <LanguageSwitcher />
      <Content />
    </I18nProvider>
  );
}

function Content() {
  const { t, formatCurrency } = useTranslation();

  return (
    <div>
      <h1>{t("hero.title")}</h1>
      <p>{t("greeting", { name: "Rohan" })}</p>
      <p>{formatCurrency(1500)}</p>
    </div>
  );
}
```

## Supported Languages

| Code | Language | Script | Direction |
|------|----------|--------|-----------|
| en | English | Latin | LTR |
| hi | Hindi | Devanagari | LTR |
| bn | Bengali | Bengali | LTR |
| ur | Urdu | Nastaliq | RTL |
| ta | Tamil | Tamil | LTR |
| te | Telugu | Telugu | LTR |
| mr | Marathi | Devanagari | LTR |
| ne | Nepali | Devanagari | LTR |
| pa | Punjabi | Gurmukhi | LTR |
| pa-PK | Punjabi | Shahmukhi | RTL |
| gu | Gujarati | Gujarati | LTR |
| kn | Kannada | Kannada | LTR |
| ml | Malayalam | Malayalam | LTR |
| si | Sinhala | Sinhala | LTR |

## Self-Hosting

See the deployment steps in the repo. You need:
- A server/VM with Docker installed
- A domain name pointing to it
- A [Gemini API key](https://aistudio.google.com/apikey) for AI translations

```bash
# On your server:
git clone <repo> bhashajs && cd bhashajs
cp .env.example .env && nano .env
chmod +x deploy.sh
./deploy.sh your-email@example.com
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes | — | Secret for signing JWT tokens. Generate with `openssl rand -hex 32` |
| `MONGO_CONNECTION_URL` | Yes | — | MongoDB connection string (set automatically in Docker) |
| `GEMINI_API_KEY` | Yes | — | Google Gemini API key for AI translations |
| `JWT_EXPIRY` | No | `7d` | JWT token expiry duration |
| `CORS_ORIGIN` | No | `*` | Allowed CORS origins |
| `MONGO_ROOT_PASSWORD` | No | `changeme` | MongoDB root password (Docker only) |
| `AI_PROVIDER` | No | `gemini` | AI translation provider |

## License

MIT
