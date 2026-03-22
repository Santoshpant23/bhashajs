// FILE: packages/sdk/src/hooks/useLangInfo.ts
//
// Utility hook that gives developers info about the current language.
//
// EXAMPLE USE CASE:
// A developer wants to adjust padding based on text direction:
//
//   function Sidebar() {
//     const { dir, font } = useLangInfo();
//     return (
//       <aside style={{
//         [dir === 'rtl' ? 'paddingRight' : 'paddingLeft']: '2rem',
//         fontFamily: font,
//       }}>
//         ...
//       </aside>
//     );
//   }
//
// Most developers won't need this — the SDK handles direction
// automatically. But it's there for fine-grained control.

import { useMemo } from "react";
import { useTranslation } from "./useTranslation";
import { getLangInfo } from "../utils/languages";
import { LangInfo } from "../types";

export function useLangInfo(): LangInfo {
  const { currentLang } = useTranslation();

  // useMemo prevents recreating the object on every render
  // It only recalculates when currentLang changes
  return useMemo(() => getLangInfo(currentLang), [currentLang]);
}
