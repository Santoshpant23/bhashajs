// FILE: packages/dashboard/src/pages/DemoPage.tsx
//
// A demo page that uses the BhashaJS SDK to prove it works.
// This simulates what a REAL developer would do in THEIR app.
//
// The demo is ENTIRELY BUNDLED and instant: every string it renders ships in
// the `DEMO_TRANSLATIONS` object below and is handed to the SDK via
// `<I18nProvider preloadedTranslations={...}>`. There is NO network call, NO
// "spinning up a sandbox", and NO database write — the demo never mints a
// project just to show off the SDK. The `/api/sandbox` endpoint still exists on
// the server (it's a separate "try it without signup" feature), but /demo does
// not call it.
//
// OPTIONAL LIVE MODE: set VITE_DEMO_PROJECT_KEY to a PUBLIC project key (starts
// with "bjs_") and the page drives the SDK against the live API instead. This is
// strictly opt-in; the DEFAULT is the bundled, always-correct demo.

import {
  I18nProvider,
  useTranslation,
  LanguageSwitcher,
  Trans,
  useLangInfo,
} from "bhasha-js";

// Optional pinned PUBLIC project key for a "live" demo. When unset (the
// default), the page runs entirely on the bundled translations below.
const DEMO_KEY = import.meta.env.VITE_DEMO_PROJECT_KEY as string | undefined;
const API_URL = (import.meta.env.VITE_API_URL as string) || "http://localhost:5000/api";

// ─── Bundled demo translations ───────────────────────────────
// Every key DemoContent renders, filled for the languages the switcher offers:
// en + hi + bn + ur (RTL) + ta. Shape is what the SDK expects:
//   { lang: { key: value } }  →  preloadedTranslations
//
// The values mirror the server's sandbox seed (packages/server/src/routes/
// sandbox.ts) for the shared keys (hero.title, greeting, nav.home), and add the
// few keys the seed doesn't cover (nav.about, nav.contact, hero.subtitle,
// footer.copyright) in the same voice. Keeping the keys exhaustive is what stops
// the demo from rendering raw keys like "footer.copyright".
//
// `{name}` / `{count}` are interpolation placeholders the SDK fills at runtime.
const DEMO_TRANSLATIONS: Record<string, Record<string, string>> = {
  en: {
    "nav.home": "Home",
    "nav.about": "About",
    "nav.contact": "Contact",
    "hero.title": "Ship in every language",
    "hero.subtitle": "One SDK for register-aware, voice-ready South Asian localization.",
    greeting: "Welcome back, {name}! You have {count} new messages.",
    "footer.copyright": "© 2026 BhashaJS. Localization for the next billion users.",
  },
  hi: {
    "nav.home": "होम",
    "nav.about": "हमारे बारे में",
    "nav.contact": "संपर्क करें",
    "hero.title": "हर भाषा में लॉन्च करें",
    "hero.subtitle": "दक्षिण एशियाई स्थानीयकरण के लिए एक ही SDK — रजिस्टर-सजग और वॉइस-तैयार।",
    greeting: "वापसी पर स्वागत है, {name}! आपके पास {count} नए संदेश हैं।",
    "footer.copyright": "© 2026 BhashaJS. अगले अरब उपयोगकर्ताओं के लिए स्थानीयकरण।",
  },
  bn: {
    "nav.home": "হোম",
    "nav.about": "আমাদের সম্পর্কে",
    "nav.contact": "যোগাযোগ",
    "hero.title": "প্রতিটি ভাষায় চালু করুন",
    "hero.subtitle": "দক্ষিণ এশীয় স্থানীয়করণের জন্য একটি SDK — রেজিস্টার-সচেতন ও ভয়েস-প্রস্তুত।",
    greeting: "আবার স্বাগতম, {name}! আপনার {count}টি নতুন বার্তা রয়েছে।",
    "footer.copyright": "© ২০২৬ BhashaJS. পরবর্তী বিলিয়ন ব্যবহারকারীর জন্য স্থানীয়করণ।",
  },
  ur: {
    "nav.home": "ہوم",
    "nav.about": "ہمارے بارے میں",
    "nav.contact": "رابطہ کریں",
    "hero.title": "ہر زبان میں لانچ کریں",
    "hero.subtitle": "جنوبی ایشیائی لوکلائزیشن کے لیے ایک ہی SDK — رجسٹر سے آگاہ اور وائس کے لیے تیار۔",
    greeting: "واپسی پر خوش آمدید، {name}! آپ کے پاس {count} نئے پیغامات ہیں۔",
    "footer.copyright": "© 2026 BhashaJS۔ اگلے ایک ارب صارفین کے لیے لوکلائزیشن۔",
  },
  ta: {
    "nav.home": "முகப்பு",
    "nav.about": "எங்களைப் பற்றி",
    "nav.contact": "தொடர்பு",
    "hero.title": "ஒவ்வொரு மொழியிலும் வெளியிடுங்கள்",
    "hero.subtitle": "தென்னாசிய உள்ளூராக்கத்திற்கான ஒரே SDK — பதிவு-விழிப்புணர்வு மற்றும் குரல்-தயார்.",
    greeting: "மீண்டும் வரவேற்கிறோம், {name}! உங்களுக்கு {count} புதிய செய்திகள் உள்ளன.",
    "footer.copyright": "© 2026 BhashaJS. அடுத்த பில்லியன் பயனர்களுக்கான உள்ளூராக்கம்.",
  },
};

// This is the "inner" app that uses translations
function DemoContent() {
  const { t, currentLang, isLoading } = useTranslation();
  const { dir, font, name } = useLangInfo();

  if (isLoading) {
    return <div style={{ padding: "2rem", color: "#999" }}>Loading translations...</div>;
  }

  return (
    <div style={{
      fontFamily: font,
      direction: dir,
      minHeight: "100vh",
      background: "#0f0f12",
      color: "#e8e4df",
    }}>
      {/* Navbar */}
      <nav style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "1rem 2rem",
        borderBottom: "1px solid #2a2a36",
      }}>
        <div style={{ display: "flex", gap: "1.5rem" }}>
          <a href="#" style={{ color: "#e07a3a", textDecoration: "none" }}>{t("nav.home")}</a>
          <a href="#" style={{ color: "#9a968f", textDecoration: "none" }}>{t("nav.about")}</a>
          <a href="#" style={{ color: "#9a968f", textDecoration: "none" }}>{t("nav.contact")}</a>
        </div>
        {/* The SDK's built-in language switcher */}
        <LanguageSwitcher style="dropdown" />
      </nav>

      {/* Hero section */}
      <div style={{ padding: "4rem 2rem", textAlign: dir === "rtl" ? "right" : "left" }}>
        <h1 style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>
          {t("hero.title")}
        </h1>
        <p style={{ fontSize: "1.2rem", color: "#9a968f" }}>
          {t("hero.subtitle")}
        </p>
        {/* Interpolation demo */}
        <p style={{ marginTop: "2rem", padding: "1rem", background: "#1e1e28", borderRadius: "8px" }}>
          {t("greeting", { name: "Rohan", count: 5 })}
        </p>
      </div>

      {/* Debug info */}
      <div style={{
        padding: "1.5rem 2rem",
        background: "#1e1e28",
        margin: "2rem",
        borderRadius: "8px",
        fontFamily: "monospace",
        fontSize: "0.85rem",
        color: "#9a968f",
      }}>
        <p>Current language: <strong style={{ color: "#e07a3a" }}>{currentLang}</strong></p>
        <p>Language name: <strong style={{ color: "#e07a3a" }}>{name}</strong></p>
        <p>Direction: <strong style={{ color: "#e07a3a" }}>{dir}</strong></p>
        <p>Font: <strong style={{ color: "#e07a3a" }}>{font}</strong></p>
      </div>

      {/* Footer using Trans component */}
      <footer style={{ padding: "2rem", borderTop: "1px solid #2a2a36", color: "#6b675f" }}>
        <Trans id="footer.copyright" />
      </footer>
    </div>
  );
}

// The outer wrapper — sets up the I18nProvider.
//
// DEFAULT (no env var): bundled, instant demo. `preloadedTranslations` makes the
// SDK serve everything from memory — no fetch, no sandbox, no DB writes.
//
// OPTIONAL: when VITE_DEMO_PROJECT_KEY is set, drive the SDK against the live API
// using that public key instead.
export default function DemoPage() {
  if (DEMO_KEY) {
    return (
      <I18nProvider
        projectKey={DEMO_KEY}
        apiUrl={API_URL}
        defaultLang="en"
        onLanguageChange={(lang: string) => console.log("Language changed to:", lang)}
      >
        <DemoContent />
      </I18nProvider>
    );
  }

  return (
    <I18nProvider
      preloadedTranslations={DEMO_TRANSLATIONS}
      defaultLang="en"
      onLanguageChange={(lang: string) => console.log("Language changed to:", lang)}
    >
      <DemoContent />
    </I18nProvider>
  );
}
