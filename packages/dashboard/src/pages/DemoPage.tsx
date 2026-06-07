// FILE: packages/dashboard/src/pages/DemoPage.tsx
//
// A demo page that uses the BhashaJS SDK to prove it works.
// This simulates what a REAL developer would do in THEIR app.

import { useEffect, useState, type ReactNode } from "react";
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
// Two ways the page gets a key:
//   1. VITE_DEMO_PROJECT_KEY — a pinned PUBLIC project key (starts with "bjs_").
//      When set, we use it (a curated, never-expiring demo project).
//   2. Otherwise we mint a LIVE SANDBOX via POST /api/sandbox (no signup) and
//      cache it in sessionStorage, so the demo is ALWAYS live with zero config.
const DEMO_KEY = import.meta.env.VITE_DEMO_PROJECT_KEY as string | undefined;
const API_URL = (import.meta.env.VITE_API_URL as string) || "http://localhost:5000/api";

// sessionStorage cache so a refresh reuses the same sandbox key (and the same
// 24h window) instead of minting a fresh project on every reload.
const SANDBOX_CACHE_KEY = "bhasha_demo_sandbox";

type SandboxSession = { projectKey: string; expiresAt: string };

function readCachedSandbox(): SandboxSession | null {
  try {
    const raw = sessionStorage.getItem(SANDBOX_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SandboxSession;
    // Drop a cached key whose 24h window already lapsed — mint a fresh one.
    if (!parsed.projectKey || new Date(parsed.expiresAt).getTime() <= Date.now()) {
      sessionStorage.removeItem(SANDBOX_CACHE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// A small "this is a live sandbox" banner shown when the page minted its own
// ephemeral key (vs. running on a pinned VITE_DEMO_PROJECT_KEY).
function SandboxBanner({ expiresAt }: { expiresAt: string }) {
  const hoursLeft = Math.max(
    0,
    Math.round((new Date(expiresAt).getTime() - Date.now()) / (60 * 60 * 1000))
  );
  return (
    <div style={{
      padding: "0.6rem 2rem",
      background: "#1a2b1a",
      borderBottom: "1px solid #2a3a2a",
      color: "#8fce8f",
      fontSize: "0.85rem",
      display: "flex",
      alignItems: "center",
      gap: "0.5rem",
    }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#4caf50", display: "inline-block" }} />
      Live sandbox — expires in {hoursLeft}h. No signup needed; this key is
      driving the SDK right now.
    </div>
  );
}

// This is the "inner" app that uses translations
function DemoContent({ sandboxExpiresAt }: { sandboxExpiresAt?: string }) {
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
      {sandboxExpiresAt && <SandboxBanner expiresAt={sandboxExpiresAt} />}
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

// A centered status card — used for the brief "minting your sandbox…" wait and
// for the rare case where the sandbox mint fails (e.g. API down). The page is
// never dead-on-arrival with an infinite "Loading…".
function StatusCard({ title, children }: { title: string; children: ReactNode }) {
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
        <h1 style={{ fontSize: "1.5rem", marginBottom: "0.75rem" }}>{title}</h1>
        <div style={{ color: "#9a968f", lineHeight: 1.6 }}>{children}</div>
      </div>
    </div>
  );
}

// The outer wrapper — sets up the I18nProvider via the public projectKey path.
// When VITE_DEMO_PROJECT_KEY is set we use it directly; otherwise we mint a
// live sandbox (no signup) so the demo is ALWAYS live.
export default function DemoPage() {
  // A pinned demo key short-circuits all sandbox logic.
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
  return <SandboxDemo />;
}

// No pinned key → mint (or reuse a cached) live sandbox, then drive the SDK.
function SandboxDemo() {
  const [session, setSession] = useState<SandboxSession | null>(() => readCachedSandbox());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Already have a valid cached sandbox — nothing to mint.
    if (session) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`${API_URL}/sandbox`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const body = await res.json();
        if (!res.ok || !body?.success) {
          throw new Error(body?.message || `Sandbox request failed (${res.status})`);
        }
        const next: SandboxSession = {
          projectKey: body.data.projectKey,
          expiresAt: body.data.expiresAt,
        };
        try {
          sessionStorage.setItem(SANDBOX_CACHE_KEY, JSON.stringify(next));
        } catch {
          /* private mode / storage full — the in-memory session still works */
        }
        if (!cancelled) setSession(next);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Could not start the live sandbox.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session]);

  if (error) {
    return (
      <StatusCard title="Couldn’t start the live sandbox">
        <p style={{ marginBottom: "1rem" }}>{error}</p>
        <p>
          The demo normally mints a temporary public key automatically. You can
          also pin one by setting{" "}
          <code style={{ color: "#e07a3a" }}>VITE_DEMO_PROJECT_KEY</code> to a{" "}
          <code style={{ color: "#e07a3a" }}>bjs_</code> key and rebuilding.
        </p>
      </StatusCard>
    );
  }

  if (!session) {
    return (
      <StatusCard title="Spinning up your live sandbox…">
        <p>Minting a temporary project key and sample translations — no signup needed.</p>
      </StatusCard>
    );
  }

  return (
    <I18nProvider
      projectKey={session.projectKey}
      apiUrl={API_URL}
      defaultLang="en"
      onLanguageChange={(lang: string) => console.log("Language changed to:", lang)}
    >
      <DemoContent sandboxExpiresAt={session.expiresAt} />
    </I18nProvider>
  );
}