/**
 * Register helpers
 *
 * Translations are stored as nested Maps:
 *   translations: Map<lang, Map<register, string>>
 *
 * These helpers paper over two concerns:
 *   1. The same data may show up as a real Map (Mongoose document) or a
 *      plain object (toObject / lean / JSON-from-client). We accept both.
 *   2. A `register` parameter that's missing or invalid falls back to
 *      `"default"` so callers don't need to repeat the check.
 */

import { REGISTERS, Register, isValidRegister } from "../models/Translation";

export const DEFAULT_REGISTER: Register = "default";

type AnyMap<V> = Map<string, V> | Record<string, V> | null | undefined;

/** Read a (lang, register) value from a nested map/object. */
export function readValue(
  translations: AnyMap<AnyMap<string>>,
  lang: string,
  register: Register = DEFAULT_REGISTER
): string | undefined {
  const langEntry = readLang(translations, lang);
  if (!langEntry) return undefined;
  if (langEntry instanceof Map) return langEntry.get(register);
  return (langEntry as Record<string, string>)[register];
}

/** Read all registers for a language as a plain object. */
export function readLang(
  translations: AnyMap<AnyMap<string>>,
  lang: string
): AnyMap<string> {
  if (!translations) return undefined;
  if (translations instanceof Map) return translations.get(lang) as AnyMap<string>;
  return (translations as Record<string, AnyMap<string>>)[lang];
}

/**
 * Write a (lang, register) value on a Mongoose-managed Map<string, Map<string, string>>.
 * Creates the inner map if missing and notifies Mongoose so the change persists.
 */
export function writeValue(
  doc: any,
  field: "translations" | "sources",
  lang: string,
  register: Register,
  value: string
): void {
  const outer = doc[field];
  if (!outer) {
    doc[field] = new Map();
  }
  const map = doc[field] as Map<string, Map<string, string>>;
  let inner = map.get(lang);
  if (!inner) {
    inner = new Map<string, string>();
    map.set(lang, inner);
  }
  inner.set(register, value);
  // Map-of-Map mutations sometimes need an explicit nudge for Mongoose
  // to flush nested changes to disk.
  if (typeof doc.markModified === "function") {
    doc.markModified(field);
  }
}

/** Delete a (lang, register) cell. Returns true if the cell existed. */
export function deleteValue(
  doc: any,
  field: "translations" | "sources",
  lang: string,
  register: Register
): boolean {
  const outer = doc[field];
  if (!outer) return false;
  const inner = outer instanceof Map ? outer.get(lang) : outer[lang];
  if (!inner) return false;
  let existed = false;
  if (inner instanceof Map) {
    existed = inner.delete(register);
  } else {
    existed = register in inner;
    delete inner[register];
  }
  if (existed && typeof doc.markModified === "function") {
    doc.markModified(field);
  }
  return existed;
}

/**
 * Coerce a register value coming from request input into a valid Register,
 * falling back to "default". Use this whenever reading req.body.register
 * or req.query.register.
 */
export function coerceRegister(input: unknown): Register {
  return isValidRegister(input) ? input : DEFAULT_REGISTER;
}

/**
 * Iterate every (lang, register, value) triple in a translations field,
 * regardless of whether it's a Map or a plain object. Skips empty/null cells.
 */
export function* iterateCells(
  translations: AnyMap<AnyMap<string>>
): Generator<{ lang: string; register: Register; value: string }> {
  if (!translations) return;
  const langEntries: [string, AnyMap<string>][] =
    translations instanceof Map
      ? Array.from(translations.entries()) as [string, AnyMap<string>][]
      : Object.entries(translations);

  for (const [lang, langMap] of langEntries) {
    if (!langMap) continue;
    const innerEntries: [string, string][] =
      langMap instanceof Map
        ? Array.from(langMap.entries())
        : Object.entries(langMap as Record<string, string>);
    for (const [register, value] of innerEntries) {
      if (typeof value !== "string") continue;
      if (!isValidRegister(register)) continue;
      yield { lang, register, value };
    }
  }
}

export { REGISTERS, type Register };
