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
  // Owner is required for a normal project (created by a logged-in user). It is
  // intentionally OPTIONAL so a public sandbox project (POST /api/sandbox, no
  // auth) can be ownerless — there's no user to attach. Normal creation always
  // sets it; the sandbox route is the only path that leaves it null.
  owner: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: false,
    default: null,
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
  // refuse with 429 so a single project can't run up the model bill. The default
  // comes from AI_MONTHLY_CAP_DEFAULT (parsed as int) or 5000. An EXPLICIT 0 is
  // preserved and means "no per-project cap" (unlimited — the reserve logic
  // treats cap<=0 as no cap), so self-hosters can set AI_MONTHLY_CAP_DEFAULT=0
  // for truly unlimited AI on their own key. Only an unset/negative/invalid
  // value falls back to 5000.
  aiMonthlyCap: {
    type: Number,
    default: () => {
      const raw = process.env.AI_MONTHLY_CAP_DEFAULT;
      if (raw === undefined || raw === "") return 5000;
      const parsed = parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5000;
    },
  },
  // Sandbox flags — set only by POST /api/sandbox (the public, no-signup
  // "try it instantly" project). A sandbox is ownerless, short-lived, and
  // swept by cleanupExpiredSandboxes() once `expiresAt` passes. Normal
  // projects leave these at their defaults (not a sandbox, never expires).
  isSandbox: { type: Boolean, default: false },
  expiresAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

const Project = mongoose.model("Project", projectSchema);

export default Project;
