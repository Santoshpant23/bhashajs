/**
 * Translation Memory Model
 *
 * Stores human-verified translation pairs so the AI can learn from
 * past corrections and maintain consistency across the project.
 *
 * Each entry represents: "For this English text, the correct {lang}
 * translation is X" — optionally with context.
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
  sourceText: { type: String, required: true },     // English original
  translatedText: { type: String, required: true }, // human-verified translation
  key: { type: String },                            // original translation key (for reference)
  context: { type: String },                        // optional context hint
  createdAt: { type: Date, default: Date.now },
});

// Index for efficient lookup during AI translation
translationMemorySchema.index({ projectId: 1, lang: 1 });

// Prevent exact duplicate entries
translationMemorySchema.index(
  { projectId: 1, lang: 1, sourceText: 1 },
  { unique: true }
);

const TranslationMemory = mongoose.model("TranslationMemory", translationMemorySchema);

export default TranslationMemory;
