/**
 * Meta — a tiny key/value store for server-internal bookkeeping.
 *
 * First use: record which one-time data migrations have already run, so the
 * full-collection scans (owner memberships, register backfill) don't re-run on
 * every boot. Idempotent migrations are still safe to re-run; this just avoids
 * paying for a full scan on each restart once they've completed.
 */

import mongoose, { Schema } from "mongoose";

const metaSchema = new Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Schema.Types.Mixed },
  updatedAt: { type: Date, default: Date.now },
});

const Meta = mongoose.model("Meta", metaSchema);

export default Meta;
