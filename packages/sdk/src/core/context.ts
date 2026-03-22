// FILE: packages/sdk/src/core/context.ts
//
// React Context for internationalization state.
//
// WHY A SEPARATE FILE:
// The context is just the "container" — it holds the value shape
// but doesn't have any logic. The actual logic lives in I18nProvider
// (which fills this context) and useTranslation (which reads from it).
//
// This separation keeps things clean and avoids circular imports.

import { createContext } from "react";
import { I18nContextValue } from "../types";

/**
 * The React Context that holds all i18n state.
 * 
 * null means no provider was found — useTranslation will
 * throw a helpful error if someone forgets to add <I18nProvider>.
 */
export const I18nContext = createContext<I18nContextValue | null>(null);
