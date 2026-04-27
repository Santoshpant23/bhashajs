/**
 * Translation Model
 *
 * Each document is one translation key (like "hero.title") for a project.
 *
 * The `translations` field is a nested Map:
 *   lang → register → string
 *
 * Where `register` is one of: "default" | "formal" | "casual".
 *
 *   {
 *     "hi": { "default": "स्वागत", "formal": "स्वागत है", "casual": "Welcome है" },
 *     "bn": { "default": "স্বাগতম" }
 *   }
 *
 * `sources` mirrors the same shape, tracking provenance per (lang, register):
 *   { "hi": { "default": "human", "casual": "ai" } }
 *   "human" | "ai" | "approved" — "approved" = AI then reviewed by a human.
 *
 * Compound unique index on (projectId + key) prevents duplicate keys.
 *
 * Legacy documents (created before registers existed) stored
 * `translations: Map<lang, string>`. The startup migration in index.ts
 * converts them to `{ default: <legacy_string> }` idempotently.
 */

import mongoose, { Schema } from "mongoose";

export const REGISTERS = ["default", "formal", "casual"] as const;
export type Register = (typeof REGISTERS)[number];

export function isValidRegister(r: any): r is Register {
  return typeof r === "string" && (REGISTERS as readonly string[]).includes(r);
}

const translationSchema = new Schema({
  projectId: {
    type: Schema.Types.ObjectId,
    ref: "Project",
    required: true,
  },
  key: { type: String, required: true },
  // Nested Map: lang → register → text
  translations: {
    type: Map,
    of: {
      type: Map,
      of: String,
    },
    default: {},
  },
  context: { type: String },               // optional description for translators
  source: { type: String, default: "human" }, // legacy row-level source
  // Nested Map: lang → register → "human" | "ai" | "approved"
  sources: {
    type: Map,
    of: {
      type: Map,
      of: String,
    },
    default: {},
  },
  updatedAt: { type: Date, default: Date.now },
});

// Prevent duplicate keys within the same project
translationSchema.index({ projectId: 1, key: 1 }, { unique: true });

const Translation = mongoose.model("Translation", translationSchema);

export default Translation;
