/**
 * Migration: Translation registers
 *
 * Converts legacy Translation documents from
 *   translations: Map<lang, string>
 * to
 *   translations: Map<lang, Map<register, string>>
 *
 * Same for the `sources` field. Same for legacy TranslationMemory entries
 * (adds a `register: "default"` field where missing).
 *
 * Idempotent: a doc whose nested values are already objects/Maps is skipped.
 * Safe to run on every server start.
 */

import mongoose from "mongoose";

const DEFAULT_REGISTER = "default";

/** Mongo stores Maps as plain objects when deserialized via `.lean()` */
function isPlainObject(v: any): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

/** A doc has been migrated if every value in `translations` is itself an object. */
function alreadyMigrated(translations: any): boolean {
  if (!isPlainObject(translations)) return true; // empty / nullish — nothing to do
  for (const v of Object.values(translations)) {
    if (typeof v === "string") return false;
  }
  return true;
}

/** Convert `{ hi: "स्वागत" }` → `{ hi: { default: "स्वागत" } }`. Skips keys whose value is already an object. */
function liftToRegisterMap(obj: any): Record<string, Record<string, string>> {
  if (!isPlainObject(obj)) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [lang, val] of Object.entries(obj)) {
    if (typeof val === "string") {
      out[lang] = { [DEFAULT_REGISTER]: val };
    } else if (isPlainObject(val)) {
      out[lang] = val as Record<string, string>;
    }
    // skip null/undefined/array values
  }
  return out;
}

export async function migrateRegisters(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) {
    console.warn("[Migration] DB not connected — skipping register migration");
    return;
  }

  const translations = db.collection("translations");
  const memory = db.collection("translationmemories");
  const history = db.collection("translationhistories");

  // ─── Translations ────────────────────────────────────────────
  // Use the raw collection (not the Mongoose model) so we can touch the
  // underlying BSON without triggering the new schema's validation.
  const cursor = translations.find({});
  let migrated = 0;
  let skipped = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) break;

    const translationsField = doc.translations;
    const sourcesField = doc.sources;

    const translationsNeedsMigration = !alreadyMigrated(translationsField);
    const sourcesNeedsMigration = !alreadyMigrated(sourcesField);

    if (!translationsNeedsMigration && !sourcesNeedsMigration) {
      skipped++;
      continue;
    }

    const update: any = {};
    if (translationsNeedsMigration) {
      update.translations = liftToRegisterMap(translationsField);
    }
    if (sourcesNeedsMigration) {
      update.sources = liftToRegisterMap(sourcesField);
    }

    await translations.updateOne({ _id: doc._id }, { $set: update });
    migrated++;
  }

  if (migrated > 0) {
    console.log(`[Migration] Lifted ${migrated} translation doc(s) to register-aware shape (${skipped} already current)`);
  }

  // ─── Translation memory ─────────────────────────────────────
  // Add `register: "default"` to entries that don't have one.
  const memResult = await memory.updateMany(
    { register: { $exists: false } },
    { $set: { register: DEFAULT_REGISTER } }
  );
  if (memResult.modifiedCount > 0) {
    console.log(`[Migration] Stamped ${memResult.modifiedCount} memory entr(ies) with register="default"`);
  }

  // Drop the pre-register unique index if it still exists. Mongoose will
  // recreate the new (projectId, lang, register, sourceText) index on its own.
  await dropIndexIfExists(memory, "projectId_1_lang_1_sourceText_1");
  await dropIndexIfExists(memory, "projectId_1_lang_1");

  // ─── Translation history ────────────────────────────────────
  const histResult = await history.updateMany(
    { register: { $exists: false } },
    { $set: { register: DEFAULT_REGISTER } }
  );
  if (histResult.modifiedCount > 0) {
    console.log(`[Migration] Stamped ${histResult.modifiedCount} history entr(ies) with register="default"`);
  }
  await dropIndexIfExists(history, "translationId_1_lang_1_createdAt_-1");
}

async function dropIndexIfExists(collection: any, indexName: string): Promise<void> {
  try {
    const indexes = await collection.indexes();
    if (indexes.some((idx: any) => idx.name === indexName)) {
      await collection.dropIndex(indexName);
      console.log(`[Migration] Dropped obsolete index: ${indexName}`);
    }
  } catch (e: any) {
    // Index may not exist or already dropped — non-fatal.
    if (e.codeName !== "IndexNotFound") {
      console.warn(`[Migration] Could not drop index ${indexName}:`, e.message);
    }
  }
}
