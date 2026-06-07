/**
 * ApiKey Model
 *
 * Scoped, rotatable SDK keys for a project. Replaces the single
 * `Project.apiKey` for new keys while the legacy field keeps working
 * (the SDK auth path falls back to it — see routes/sdk.ts).
 *
 * Each key:
 *   - belongs to exactly one project (projectId, indexed)
 *   - is a unique `bjs_` + random secret (same style as Project.apiKey)
 *   - can be read-only (advisory today — the SDK is read-only anyway —
 *     but stored so a future write-capable SDK can be gated on it)
 *   - can be locked to a hostname allowlist (allowedOrigins). When
 *     non-empty, the SDK only accepts the key from a matching Origin/Referer.
 *   - can be revoked without touching any other key (revoked flag)
 *
 * lastUsedAt is updated best-effort on each successful SDK request so
 * owners can spot stale keys; it is never on the hot path of the response.
 */

import mongoose, { Schema } from "mongoose";
import crypto from "crypto";

/** Generate a fresh secret in the same style as Project.apiKey. */
export function generateApiKey(): string {
  return `bjs_${crypto.randomBytes(24).toString("hex")}`;
}

const apiKeySchema = new Schema({
  projectId: {
    type: Schema.Types.ObjectId,
    ref: "Project",
    required: true,
    index: true,
  },
  key: {
    type: String,
    required: true,
    unique: true,
    index: true,
    default: generateApiKey,
  },
  name: { type: String, required: true },
  // Advisory scope. The public SDK is read-only today, so this defaults true;
  // it's persisted so a future write-capable SDK can enforce it.
  readOnly: { type: Boolean, default: true },
  // Hostname allowlist (e.g. ["app.example.com"]). Empty = allow any origin.
  allowedOrigins: { type: [String], default: [] },
  revoked: { type: Boolean, default: false },
  lastUsedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

const ApiKey = mongoose.model("ApiKey", apiKeySchema);

export default ApiKey;
