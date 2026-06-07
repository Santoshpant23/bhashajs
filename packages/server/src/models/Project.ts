/**
 * Project Model
 * 
 * Each project belongs to one user (owner) and tracks which
 * languages are supported. The defaultLanguage is the fallback
 * when a translation is missing.
 */

import mongoose, { Schema } from "mongoose";
import crypto from "crypto";

const projectSchema = new Schema({
  name: { type: String, required: true },
  owner: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  defaultLanguage: { type: String, default: "en" },
  supportedLanguages: { type: [String], default: ["en", "hi"] },
  apiKey: {
    type: String,
    unique: true,
    default: () => `bjs_${crypto.randomBytes(24).toString("hex")}`,
  },
  // Optional vertical tag — when set, the AI translator picks up
  // vertical-specific terminology (e.g. "fintech" → use RBI/SEBI phrasing).
  // Allowed values are advisory; the field is a free-form string so we can
  // add new verticals without a schema migration.
  vertical: { type: String, default: null },
  // Monthly AI translation cap (keys/month). When the project's keysTranslated
  // for the current period would exceed this, /ai-translate and /generate-voice
  // refuse with 429 so a single project can't run up the model bill. The
  // default comes from AI_MONTHLY_CAP_DEFAULT (parsed as int) or 5000.
  aiMonthlyCap: {
    type: Number,
    default: () => {
      const parsed = parseInt(process.env.AI_MONTHLY_CAP_DEFAULT || "", 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
    },
  },
  createdAt: { type: Date, default: Date.now },
});

const Project = mongoose.model("Project", projectSchema);

export default Project;
