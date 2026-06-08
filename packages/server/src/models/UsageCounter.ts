/**
 * UsageCounter — generic monthly AI-usage bucket keyed by an arbitrary SCOPE.
 *
 * The per-PROJECT meter lives in AiUsage. This model holds the WIDER scopes that
 * bound the maintainer's AI bill on the forever-free hosted service:
 *   - "acct:<ownerId>"  per-account monthly allowance, summed across ALL of an
 *                       owner's projects — so one account can't multiply free AI
 *                       by spinning up many projects.
 *   - "global"          instance-wide monthly ceiling: the hard kill-switch that
 *                       bounds total Vertex/Gemini spend no matter how many
 *                       users/projects exist.
 *
 * Same atomic $inc-upsert pattern as AiUsage (see utils/usage.ts): the unique
 * { scope, period } index makes concurrent reservations collapse onto a single
 * bucket instead of creating duplicates. `period` is a "YYYY-MM" UTC string, so
 * buckets reset implicitly at the month boundary.
 */

import mongoose, { Schema } from "mongoose";

const usageCounterSchema = new Schema({
  // e.g. "global" or "acct:<ObjectId>". One bucket per (scope, period).
  scope: { type: String, required: true },
  // "YYYY-MM" (UTC).
  period: { type: String, required: true },
  // Keys reserved against this scope's cap this month (translate + voice share
  // the same budget, since both bill the model).
  keysTranslated: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now },
});

usageCounterSchema.index({ scope: 1, period: 1 }, { unique: true });

const UsageCounter = mongoose.model("UsageCounter", usageCounterSchema);

export default UsageCounter;
