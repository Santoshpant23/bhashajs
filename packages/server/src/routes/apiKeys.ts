/**
 * API Key Routes
 *
 * Scoped, rotatable SDK keys for a project. Mounted at
 * /api/projects/:projectId/keys behind authMiddleware + owner role.
 *
 * POST   /api/projects/:projectId/keys             — Create a key (returns the FULL secret ONCE)
 * GET    /api/projects/:projectId/keys             — List keys, MASKED (never the full secret)
 * POST   /api/projects/:projectId/keys/:keyId/revoke — Revoke a key (belongs-to-project enforced)
 *
 * Only owners manage keys — translators/viewers must never see or mint a
 * project's SDK secret. Responses follow the { success, data } contract.
 */

import { Router, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireProjectRole, ProjectAuthRequest } from "../middleware/projectAuth";
import ApiKey, { generateApiKey } from "../models/ApiKey";
import { sendSuccess, sendError } from "../utils/response";
import { validateObjectId, validateRequired } from "../utils/validate";

const router = Router({ mergeParams: true });
router.use(authMiddleware);

/**
 * Mask a secret for list responses: keep the `bjs_` prefix + a few leading
 * chars and the last four, hide the rest. The full secret is only ever
 * returned once, at creation time.
 *   bjs_1a2b3c…f9e8
 */
export function maskKey(key: string): string {
  if (!key) return "";
  const body = key.startsWith("bjs_") ? key.slice(4) : key;
  if (body.length <= 8) return `bjs_${body}`;
  return `bjs_${body.slice(0, 4)}…${body.slice(-4)}`;
}

/** Shape returned to the dashboard — NEVER includes the raw `key`. */
function toMasked(k: any) {
  return {
    id: k._id,
    name: k.name,
    maskedKey: maskKey(k.key),
    readOnly: k.readOnly,
    allowedOrigins: k.allowedOrigins,
    revoked: k.revoked,
    lastUsedAt: k.lastUsedAt,
    createdAt: k.createdAt,
  };
}

/**
 * Normalize an allowedOrigins input to a clean list of bare hostnames.
 * Accepts either bare hosts ("app.example.com") or full origins
 * ("https://app.example.com") and stores just the hostname, lowercased —
 * which is exactly what the SDK auth path compares against. Drops blanks
 * and de-duplicates. Returns [] for non-arrays.
 */
export function normalizeOrigins(input: any): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let host = trimmed;
    // Strip scheme + path if the owner pasted a full URL.
    try {
      if (/^[a-z]+:\/\//i.test(trimmed)) {
        host = new URL(trimmed).hostname;
      } else {
        // Bare "host" or "host:port" — drop any port.
        host = trimmed.split("/")[0].split(":")[0];
      }
    } catch {
      host = trimmed.split("/")[0].split(":")[0];
    }
    host = host.toLowerCase();
    if (host) out.add(host);
  }
  return Array.from(out);
}

// ─── CREATE KEY ─────────────────────────────────────────────
// Returns the FULL secret exactly once. The owner must copy it now.
router.post(
  "/",
  requireProjectRole("owner"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const { name, allowedOrigins, readOnly } = req.body;

      const nameError = validateRequired(name, "Key name");
      if (nameError) return sendError(res, 400, nameError);

      const activeCount = await ApiKey.countDocuments({ projectId, revoked: { $ne: true } });
      if (activeCount >= 50) {
        return sendError(res, 400, "A project can have at most 50 active API keys");
      }

      const apiKey = await ApiKey.create({
        projectId: projectId as string,
        key: generateApiKey(),
        name: name.trim(),
        allowedOrigins: normalizeOrigins(allowedOrigins),
        // Default read-only; only an explicit `false` flips it.
        readOnly: readOnly === false ? false : true,
      });

      // The ONLY response that contains the raw secret.
      return sendSuccess(res, 201, {
        id: apiKey._id,
        name: apiKey.name,
        key: apiKey.key,
        readOnly: apiKey.readOnly,
        allowedOrigins: apiKey.allowedOrigins,
        revoked: apiKey.revoked,
        createdAt: apiKey.createdAt,
        note: "Copy this key now — it will not be shown again.",
      });
    } catch (e) {
      return sendError(res, 500, "Failed to create API key");
    }
  }
);

// ─── LIST KEYS (MASKED) ─────────────────────────────────────
router.get(
  "/",
  requireProjectRole("owner"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const keys = await ApiKey.find({ projectId }).sort({ createdAt: -1 }).lean();
      return sendSuccess(res, 200, keys.map(toMasked));
    } catch (e) {
      return sendError(res, 500, "Failed to fetch API keys");
    }
  }
);

// ─── REVOKE KEY ─────────────────────────────────────────────
// Scoped to the project in the path: a key from another project (even a
// valid keyId) is treated as not found, so an owner can't revoke across
// project boundaries.
router.post(
  "/:keyId/revoke",
  requireProjectRole("owner"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId, keyId } = req.params;

      const idError = validateObjectId(keyId as string, "Key ID");
      if (idError) return sendError(res, 400, idError);

      const updated = await ApiKey.findOneAndUpdate(
        { _id: keyId, projectId },
        { revoked: true },
        { returnDocument: "after" }
      );

      if (!updated) return sendError(res, 404, "API key not found");

      return sendSuccess(res, 200, toMasked(updated));
    } catch (e) {
      return sendError(res, 500, "Failed to revoke API key");
    }
  }
);

export default router;
