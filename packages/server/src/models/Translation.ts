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

// Voice data cell — one per (lang, register). IPA is the phonetic
// transcription; SSML is full-fidelity markup including prosody/pause hints
// suitable for piping into a TTS engine.
const voiceCellSchema = new Schema(
  {
    ipa: { type: String, default: "" },
    ssml: { type: String, default: "" },
  },
  { _id: false }
);

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
  // Voice-ready outputs — IPA phonetic transcription + SSML markup per
  // (lang, register). Missing entries are generated lazily via the
  // generate-voice endpoint; the SDK falls back to the plain translation
  // when voice data isn't present.
  voice: {
    type: Map,
    of: {
      type: Map,
      of: voiceCellSchema,
    },
    default: {},
  },
  updatedAt: { type: Date, default: Date.now },
});

// Prevent duplicate keys within the same project
translationSchema.index({ projectId: 1, key: 1 }, { unique: true });

const Translation = mongoose.model("Translation", translationSchema);

export default Translation;
