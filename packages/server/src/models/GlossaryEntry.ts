/**
 * GlossaryEntry Model
 *
 * Project-level glossary for consistent terminology across translations.
 * - term: the English source term (unique per project)
 * - translations: Map of lang → translated term
 * - notes: optional usage notes for translators
 */

import mongoose, { Schema } from "mongoose";

const glossaryEntrySchema = new Schema({
  projectId: {
    type: Schema.Types.ObjectId,
    ref: "Project",
    required: true,
  },
  // Length-capped: glossary terms + their translations are injected verbatim
  // into every AI prompt, so an uncapped value is an unbounded prompt-cost (and
  // token) vector.
  term: {
    type: String,
    required: true,
    trim: true,
    maxlength: 128,
  },
  translations: {
    type: Map,
    of: { type: String, maxlength: 256 },
    default: {},
  },
  notes: {
    type: String,
    default: "",
    maxlength: 500,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

glossaryEntrySchema.index({ projectId: 1, term: 1 }, { unique: true });

const GlossaryEntry = mongoose.model("GlossaryEntry", glossaryEntrySchema);
export default GlossaryEntry;
