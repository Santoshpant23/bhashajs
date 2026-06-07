// FILE: packages/dashboard/src/pages/DemoPage.tsx
//
// A demo page that uses the BhashaJS SDK to prove it works.
// This simulates what a REAL developer would do in THEIR app.

import {
  I18nProvider,
  useTranslation,
  LanguageSwitcher,
  Trans,
  useLangInfo,
} from "bhasha-js";

// Drive the demo via the PUBLIC project key path (x-api-key) — the same path
// every doc tells real developers to use. NOT the projectId+JWT path, which
// requires a logged-in admin token and would hang/404 here.
//
// Set VITE_DEMO_PROJECT_KEY to a PUBLIC project API key (starts with "bjs_")
// to light up the live demo. If it's unset we render a friendly "not
// configured" card instead of an infinite "Loading…".
const DEMO_KEY = import.meta.env.VITE_DEMO_PROJECT_KEY as string | undefined;

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

// Shown when no demo key is configured — so the page is never dead-on-arrival
// with an infinite "Loading…".
function DemoNotConfigured() {
  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#0f0f12",
      color: "#e8e4df",
      padding: "2rem",
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <div style={{
        maxWidth: "520px",
        background: "#1e1e28",
        border: "1px solid #2a2a36",
        borderRadius: "12px",
        padding: "2rem",
      }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "0.75rem" }}>
          Live demo isn’t configured yet
        </h1>
        <p style={{ color: "#9a968f", marginBottom: "1rem", lineHeight: 1.6 }}>
          This page drives the BhashaJS SDK with a <strong>public project key</strong>{" "}
          (the <code style={{ color: "#e07a3a" }}>x-api-key</code> path every developer uses).
          To turn it on, set the environment variable{" "}
          <code style={{ color: "#e07a3a" }}>VITE_DEMO_PROJECT_KEY</code> to a public
          project key (it starts with <code style={{ color: "#e07a3a" }}>bjs_</code>) and rebuild.
        </p>
        <pre style={{
          background: "#0f0f12",
          border: "1px solid #2a2a36",
          borderRadius: "8px",
          padding: "1rem",
          color: "#9a968f",
          fontSize: "0.85rem",
          overflowX: "auto",
        }}>
{`# .env
VITE_DEMO_PROJECT_KEY=bjs_your_public_project_key`}
        </pre>
      </div>
    </div>
  );
}

// The outer wrapper — sets up the I18nProvider via the public projectKey path.
export default function DemoPage() {
  // No demo key → render a clear card instead of hanging on "Loading…".
  if (!DEMO_KEY) {
    return <DemoNotConfigured />;
  }

  const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:5000/api";
  return (
    <I18nProvider
      projectKey={DEMO_KEY}
      apiUrl={apiUrl}
      defaultLang="en"
      onLanguageChange={(lang: string) => console.log("Language changed to:", lang)}
    >
      <DemoContent />
    </I18nProvider>
  );
}