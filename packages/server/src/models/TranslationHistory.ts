/**
 * TranslationHistory Model
 *
 * Tracks per-cell changes to translations. Each entry records
 * one language value changing for one translation key.
 *
 * Created automatically when translations are modified via:
 * - Manual edit (PUT)
 * - Bulk import
 * - AI translation
 * - Review (approve/reject)
 */

import mongoose, { Schema } from "mongoose";

const translationHistorySchema = new Schema({
  translationId: {
    type: Schema.Types.ObjectId,
    ref: "Translation",
    required: true,
  },
  projectId: {
    type: Schema.Types.ObjectId,
    ref: "Project",
    required: true,
  },
  lang: { type: String, required: true },
  register: { type: String, default: "default" }, // "default" | "formal" | "casual"
  key: { type: String, required: true }, // denormalized for display
  oldValue: { type: String, default: "" },
  newValue: { type: String, required: true },
  source: { type: String }, // "human", "ai", "approved"
  changedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
});

// Per-key history sorted by time
translationHistorySchema.index({ translationId: 1, lang: 1, register: 1, createdAt: -1 });
// Project activity feed
translationHistorySchema.index({ projectId: 1, createdAt: -1 });

const TranslationHistory = mongoose.model("TranslationHistory", translationHistorySchema);

export default TranslationHistory;
