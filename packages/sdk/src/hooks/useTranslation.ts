// FILE: packages/sdk/src/hooks/useTranslation.ts
//
// THE MAIN HOOK — Used in every component that needs translated text:
//
//   function HomePage() {
//     const { t } = useTranslation();
//     return <h1>{t('hero.title')}</h1>;
//   }
//
// What it returns:
//   - t(key, params?)  → the translated string
//   - currentLang      → the active language code ("hi", "bn", etc.)
//   - setLang(code)    → switch to a different language
//   - supportedLangs   → list of all available languages
//   - isLoading        → true while translations are being fetched
//   - error            → error message if something went wrong
//
// WHY THIS IS A HOOK:
// React hooks let you "subscribe" to state changes. When the language
// changes (via setLang), React knows to re-render every component
// that calls useTranslation(). This is how the entire UI switches
// language instantly — every component re-reads its t() values.
//
// NAMING CONVENTION:
// We named this useTranslation() to match the industry standard.
// react-i18next uses the same name, so developers migrating to
// BhashaJS will feel right at home.

import { useContext } from "react";
import { I18nContext } from "../core/context";
import { I18nContextValue } from "../types";

export function useTranslation(): I18nContextValue {
  const context = useContext(I18nContext);

  // If someone forgets to wrap their app in <I18nProvider>,
  // give them a clear error instead of a cryptic "cannot read
  // property 't' of null"
  if (!context) {
    throw new Error(
      "[BhashaJS] useTranslation() was called outside of <I18nProvider>.\n" +
      "Make sure your app is wrapped:\n\n" +
      "  <I18nProvider projectId=\"your-project-id\">\n" +
      "    <App />\n" +
      "  </I18nProvider>"
    );
  }

  return context;
}
