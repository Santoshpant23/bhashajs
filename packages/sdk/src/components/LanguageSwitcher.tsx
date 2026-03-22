// FILE: packages/sdk/src/components/LanguageSwitcher.tsx
//
// A ready-to-use language switcher component.
//
// USAGE:
//   <LanguageSwitcher />                          — simple dropdown
//   <LanguageSwitcher style="floating" />          — floating button
//   <LanguageSwitcher position="top-left" style="floating" /> — floating, top-left
//
// TWO STYLES:
//
// 1. "dropdown" (default) — A simple <select> dropdown.
//    Developers put this in their navbar or header.
//    It's unstyled by default so it inherits the app's CSS.
//
// 2. "floating" — A fixed-position button on the screen.
//    Great for quick integration — add one line and you get
//    a language switcher without touching your layout.
//
// WHY WE SHOW NATIVE SCRIPT NAMES:
// We show "हिन्दी" instead of "Hindi" because:
// - A Hindi speaker can find their language even if the UI is in English
// - It's the industry standard (Google, Facebook, etc. all do this)
// - It looks more professional and inclusive

import { useState, useRef, useEffect } from "react";
import { LanguageSwitcherProps } from "../types";
import { useTranslation } from "../hooks/useTranslation";
import { getLangInfo } from "../utils/languages";

export function LanguageSwitcher({
  position = "top-right",
  style = "dropdown",
  className = "",
}: LanguageSwitcherProps) {
  const { currentLang, setLang, supportedLangs, isLoading } = useTranslation();

  // For the floating style, we need to track open/close state
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the floating menu when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  // ─── Dropdown Style ──────────────────────────────────────────
  if (style === "dropdown") {
    return (
      <select
        value={currentLang}
        onChange={(e) => setLang(e.target.value)}
        disabled={isLoading}
        className={`bhasha-switcher-dropdown ${className}`}
        aria-label="Select language"
        style={{
          cursor: "pointer",
          padding: "6px 12px",
          borderRadius: "6px",
          border: "1px solid #ccc",
          background: "inherit",
          color: "inherit",
          fontSize: "14px",
        }}
      >
        {supportedLangs.map((lang) => {
          const info = getLangInfo(lang);
          return (
            <option key={lang} value={lang}>
              {info.name} ({info.englishName})
            </option>
          );
        })}
      </select>
    );
  }

  // ─── Floating Style ──────────────────────────────────────────

  // Position mapping for fixed positioning
  const positionStyles: Record<string, React.CSSProperties> = {
    "top-right": { top: "16px", right: "16px" },
    "top-left": { top: "16px", left: "16px" },
    "bottom-right": { bottom: "16px", right: "16px" },
    "bottom-left": { bottom: "16px", left: "16px" },
  };

  const currentInfo = getLangInfo(currentLang);

  return (
    <div
      ref={menuRef}
      className={`bhasha-switcher-floating ${className}`}
      style={{
        position: "fixed",
        ...positionStyles[position],
        zIndex: 9999,
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      {/* The toggle button — shows current language */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={isLoading}
        aria-label="Switch language"
        aria-expanded={isOpen}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "8px 14px",
          borderRadius: "24px",
          border: "1px solid rgba(255,255,255,0.15)",
          background: "rgba(0,0,0,0.8)",
          color: "#fff",
          fontSize: "14px",
          fontWeight: 500,
          cursor: "pointer",
          backdropFilter: "blur(8px)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          transition: "all 0.15s ease",
        }}
      >
        {/* Globe icon */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
          <path d="M2 12h20" />
        </svg>
        {currentInfo.name}
      </button>

      {/* The dropdown menu — shows all available languages */}
      {isOpen && (
        <div
          style={{
            position: "absolute",
            [position.includes("bottom") ? "bottom" : "top"]: "100%",
            [position.includes("left") ? "left" : "right"]: "0",
            marginTop: position.includes("top") ? "8px" : undefined,
            marginBottom: position.includes("bottom") ? "8px" : undefined,
            background: "rgba(0,0,0,0.9)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "12px",
            padding: "4px",
            minWidth: "180px",
            backdropFilter: "blur(12px)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}
        >
          {supportedLangs.map((lang) => {
            const info = getLangInfo(lang);
            const isActive = lang === currentLang;

            return (
              <button
                key={lang}
                onClick={() => {
                  setLang(lang);
                  setIsOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  padding: "10px 14px",
                  border: "none",
                  borderRadius: "8px",
                  background: isActive ? "rgba(224, 122, 58, 0.2)" : "transparent",
                  color: isActive ? "#e07a3a" : "#fff",
                  fontSize: "14px",
                  cursor: "pointer",
                  transition: "background 0.1s",
                  textAlign: "left",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    (e.target as HTMLElement).style.background = "rgba(255,255,255,0.08)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    (e.target as HTMLElement).style.background = "transparent";
                  }
                }}
              >
                <span style={{ fontWeight: 500 }}>{info.name}</span>
                <span style={{ fontSize: "12px", opacity: 0.5 }}>{info.englishName}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
