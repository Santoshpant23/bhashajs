/**
 * Project Model
 * 
 * Each project belongs to one user (owner) and tracks which
 * languages are supported. The defaultLanguage is the fallback
 * when a translation is missing.
 */

import mongoose, { Schema } from "mongoose";

const projectSchema = new Schema({
  name: { type: String, required: true },
  owner: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  defaultLanguage: { type: String, default: "en" },
  supportedLanguages: { type: [String], default: ["en", "hi"] },
  createdAt: { type: Date, default: Date.now },
});

const Project = mongoose.model("Project", projectSchema);

export default Project;
