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
  term: {
    type: String,
    required: true,
    trim: true,
  },
  translations: {
    type: Map,
    of: String,
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
