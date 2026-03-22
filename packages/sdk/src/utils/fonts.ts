// FILE: packages/sdk/src/utils/fonts.ts
//
// Dynamic font loading for South Asian scripts.
//
// WHY THIS EXISTS:
// Hindi, Bengali, Tamil, etc. all use different scripts that need
// different fonts. If you just render Hindi text with a standard
// font like Arial, the conjunct characters (like क्ष or त्र) will
// look broken or ugly.
//
// Most i18n tools leave this problem to the developer. BhashaJS
// handles it automatically — when you switch to Hindi, we load
// the right font in the background.
//
// HOW IT WORKS:
// We inject a <link> tag into the <head> that loads the Google Font.
// We track which fonts are already loaded so we never load the same
// font twice. The fonts load async, so there's a brief flash of
// unstyled text on first load, but after that it's cached by the browser.

import { FONT_URLS, getLangInfo } from "./languages";

// Track which fonts have already been loaded
const loadedFonts = new Set<string>();

/**
 * Load the appropriate Google Font for a language.
 * Does nothing if the font is already loaded.
 *
 * @param lang - Language code (e.g. "hi", "bn", "ur")
 */
export function loadFontForLang(lang: string): void {
  const langInfo = getLangInfo(lang);
  const fontFamily = langInfo.font.split(",")[0].trim();

  // Skip if already loaded or if it's a generic system font
  if (loadedFonts.has(fontFamily) || !FONT_URLS[fontFamily]) {
    return;
  }

  // Create a <link> element and inject it into <head>
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = FONT_URLS[fontFamily];
  link.crossOrigin = "anonymous";
  document.head.appendChild(link);

  // Mark as loaded so we don't do it again
  loadedFonts.add(fontFamily);
}

/**
 * Preload fonts for multiple languages at once.
 * Call this at app startup if you know which languages you'll need.
 */
export function preloadFonts(langs: string[]): void {
  for (const lang of langs) {
    loadFontForLang(lang);
  }
}
