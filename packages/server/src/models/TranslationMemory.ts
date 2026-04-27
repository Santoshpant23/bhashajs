/**
 * Translation Memory Model
 *
 * Stores human-verified translation pairs so the AI can learn from
 * past corrections and maintain consistency across the project.
 *
 * Each entry represents: "For this English text, the correct {lang}/{register}
 * translation is X" — optionally with context.
 *
 * Memory is stratified by register so a "casual" AI request only sees
 * "casual" examples — otherwise the model mixes formal and casual tones.
 *
 * Entries are created automatically when:
 *   - A user approves an AI translation (source: "approved")
 *   - A user manually corrects an AI translation
 *
 * The AI translate endpoint queries this collection to include
 * relevant examples in the prompt, improving accuracy over time.
 */

import mongoose, { Schema } from "mongoose";

const translationMemorySchema = new Schema({
  projectId: {
    type: Schema.Types.ObjectId,
    ref: "Project",
    required: true,
  },
  lang: { type: String, required: true },          // target language code
  // Register the translation belongs to. Defaults to "default" so legacy
  // entries (pre-register-migration) keep working without rewriting.
  register: { type: String, default: "default" },
  sourceText: { type: String, required: true },     // English original
  translatedText: { type: String, required: true }, // human-verified translation
  key: { type: String },                            // original translation key (for reference)
  context: { type: String },                        // optional context hint
  createdAt: { type: Date, default: Date.now },
});

// Index for efficient lookup during AI translation
translationMemorySchema.index({ projectId: 1, lang: 1, register: 1 });

// Prevent exact duplicate entries — same source text in same (lang, register)
// can have only one canonical translation.
translationMemorySchema.index(
  { projectId: 1, lang: 1, register: 1, sourceText: 1 },
  { unique: true }
);

const TranslationMemory = mongoose.model("TranslationMemory", translationMemorySchema);

export default TranslationMemory;
