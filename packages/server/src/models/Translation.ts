/**
 * Translation Model
 *
 * Each document is one translation key (like "hero.title") for a project.
 * The `translations` field is a Map where keys are language codes
 * and values are the translated strings:
 *   { "en": "Welcome", "hi": "स्वागत", "bn": "স্বাগতম" }
 *
 * Compound unique index on (projectId + key) prevents duplicate keys.
 *
 * Source tracking:
 * - `source` (legacy): overall source for the row — "human" or "ai"
 * - `sources`: per-language source tracking — "human", "ai", or "approved"
 *   Example: { "en": "human", "hi": "ai", "bn": "approved" }
 *   "approved" means it was AI-generated and then reviewed/accepted by a human
 */

import mongoose, { Schema } from "mongoose";

const translationSchema = new Schema({
  projectId: {
    type: Schema.Types.ObjectId,
    ref: "Project",
    required: true,
  },
  key: { type: String, required: true },
  translations: { type: Map, of: String },
  context: { type: String },               // optional description for translators
  source: { type: String, default: "human" }, // legacy: "human" or "ai"
  sources: { type: Map, of: String, default: {} }, // per-language: "human" | "ai" | "approved"
  updatedAt: { type: Date, default: Date.now },
});

// Prevent duplicate keys within the same project
translationSchema.index({ projectId: 1, key: 1 }, { unique: true });

const Translation = mongoose.model("Translation", translationSchema);

export default Translation;
