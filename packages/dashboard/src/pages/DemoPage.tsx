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
} from "bhashajs";

// Replace with your actual project ID from the dashboard
const PROJECT_ID = "YOUR_PROJECT_ID";

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

// The outer wrapper — sets up the I18nProvider
export default function DemoPage() {
  return (
    <I18nProvider
      projectId={PROJECT_ID}
      apiUrl="http://localhost:5000/api"
      apiToken={localStorage.getItem("bhashajs_token") || ""}
      defaultLang="en"
      onLanguageChange={(lang) => console.log("Language changed to:", lang)}
    >
      <DemoContent />
    </I18nProvider>
  );
}