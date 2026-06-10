/**
 * Public SDK Routes
 *
 * These endpoints are designed for client-side SDK usage.
 * They authenticate via project API key (x-api-key header),
 * NOT via JWT — so end-users' apps never need a user token.
 *
 * GET /api/sdk/project      — Project info (name, supported languages)
 * GET /api/sdk/translations  — Flat translations for a language (?lang=hi)
 */

import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import Project from "../models/Project";
import ApiKey from "../models/ApiKey";
import Translation from "../models/Translation";
import TranslationHistory from "../models/TranslationHistory";
import { sendSuccess, sendError } from "../utils/response";
import { coerceRegister, readValue, writeValue, deleteVoiceCell, DEFAULT_REGISTER, Register } from "../utils/registers";
import { canServe } from "../utils/compliance";
import { flattenTranslations } from "../utils/flatten";
import { withTransactionOrFallback } from "../utils/transaction";
import { maxKeysPerProject, keyCapMessage } from "../utils/limits";

const router = Router();
const KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RESERVED_KEY_MESSAGE = "Key cannot be __proto__, constructor, or prototype";

function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.has(key);
}

/**
 * Derive the request's origin hostname for the allowlist check. Browsers send
 * `Origin` on cross-origin requests; we fall back to the `Referer` host. Both
 * are absent on server-to-server calls (curl, SSR) — those return "" and are
 * rejected by a non-empty allowlist (a scoped key is meant for the browser).
 */
function requestHostname(req: Request): string {
  const candidates = [req.headers["origin"], req.headers["referer"]];
  for (const raw of candidates) {
    if (typeof raw !== "string" || !raw) continue;
    try {
      return new URL(raw).hostname.toLowerCase();
    } catch {
      // Not a parseable URL — ignore and try the next candidate.
    }
  }
  return "";
}

/**
 * Middleware: extract project from API key.
 * Expects the key in the `x-api-key` header.
 *
 * Resolution order:
 *  1) A NON-revoked scoped ApiKey matching the header. If it carries an
 *     allowedOrigins allowlist, the request's Origin/Referer hostname must be
 *     in it (else 403). lastUsedAt is bumped best-effort (fire-and-forget — it
 *     never blocks or fails the request).
 *  2) FALLBACK to the legacy single `Project.apiKey`, so every existing
 *     project keeps working unchanged. Legacy keys carry no origin scope.
 */
async function authenticateApiKey(req: Request, res: Response, next: Function) {
  const apiKey = req.headers["x-api-key"] as string;

  if (!apiKey) {
    return sendError(res, 401, "Missing API key. Set the x-api-key header.");
  }

  try {
    // 1) Scoped key path. Only non-revoked keys resolve.
    const scoped = await ApiKey.findOne({ key: apiKey, revoked: false });
    if (scoped) {
      // Origin allowlist: only enforced when the key has one. An empty list
      // means "any origin", preserving the legacy no-restriction behavior.
      if (Array.isArray(scoped.allowedOrigins) && scoped.allowedOrigins.length > 0) {
        const host = requestHostname(req);
        if (!host || !scoped.allowedOrigins.includes(host)) {
          return sendError(res, 403, "Origin not allowed for this API key");
        }
      }

      const project = await Project.findById(scoped.projectId);
      if (!project) {
        // Key points at a deleted project — treat as invalid.
        return sendError(res, 401, "Invalid API key");
      }

      // Best-effort usage timestamp — fire-and-forget so it never delays or
      // fails the hot path. Errors are swallowed (it's telemetry, not auth).
      ApiKey.updateOne({ _id: scoped._id }, { lastUsedAt: new Date() }).catch(() => {});

      (req as any).project = project;
      (req as any).apiKeyDoc = scoped;
      return next();
    }

    // 2) Legacy fallback — the project's own single apiKey field.
    const project = await Project.findOne({ apiKey });
    if (!project) {
      return sendError(res, 401, "Invalid API key");
    }

    // Attach project to request for downstream handlers
    (req as any).project = project;
    next();
  } catch (e) {
    return sendError(res, 500, "Authentication failed");
  }
}

// All SDK routes require a valid API key
router.use(authenticateApiKey);

async function recordPushHistory(
  translationId: any,
  projectId: any,
  lang: string,
  register: Register,
  key: string,
  oldValue: string,
  newValue: string,
  changedBy: any,
  session?: any
) {
  if (oldValue === newValue) return;
  try {
    await TranslationHistory.create(
      [{
        translationId,
        projectId,
        lang,
        register,
        key,
        oldValue: oldValue || "",
        newValue,
        source: "human",
        changedBy,
      }],
      { session }
    );
  } catch (e) {
    if (session) throw e;
  }
}

// PUSH TRANSLATIONS (WRITE-CAPABLE SDK KEY)
router.post("/push", async (req: Request, res: Response) => {
  try {
    const project = (req as any).project;
    const apiKeyDoc = (req as any).apiKeyDoc;

    if (!apiKeyDoc || apiKeyDoc.readOnly !== false) {
      return sendError(res, 403, "This key cannot write. Create a scoped API key with read-only OFF.");
    }
    if (!project.owner) {
      return sendError(res, 403, "Sandbox projects cannot accept SDK pushes");
    }

    const { lang, translations } = req.body;
    if (!lang || typeof lang !== "string") {
      return sendError(res, 400, "Language code is required");
    }
    if (!project.supportedLanguages.includes(lang)) {
      return sendError(res, 400, `"${lang}" is not a supported language for this project`);
    }
    if (!translations || typeof translations !== "object" || Array.isArray(translations)) {
      return sendError(res, 400, "Translations must be an object of key-value pairs");
    }

    const register = coerceRegister(req.body.register);
    let flatResult: { flat: Record<string, string>; skipped: string[] };
    try {
      flatResult = flattenTranslations(translations);
    } catch (e: any) {
      if (e?.message === "Too many keys in one import") {
        return sendError(res, 400, "Too many keys in one import");
      }
      throw e;
    }

    for (const rawKey of Object.keys(flatResult.flat)) {
      const key = rawKey.trim();
      if (isReservedKey(key)) {
        return sendError(res, 400, RESERVED_KEY_MESSAGE);
      }
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const skippedKeys: string[] = [];
    const skippedRegulated = new Set<string>();
    const addSkippedKey = (key: string) => {
      skipped++;
      if (skippedKeys.length < 100) skippedKeys.push(key);
    };
    const addSkippedRegulated = (key: string) => {
      if (skippedRegulated.has(key)) return;
      skippedRegulated.add(key);
      addSkippedKey(key);
    };

    for (const key of flatResult.skipped) addSkippedKey(key);

    // Per-project key ceiling (abuse hardening). SOFT cap: a single push may
    // overshoot by its own batch size; growth stays bounded.
    const keyCap = maxKeysPerProject();
    if (keyCap > 0) {
      const totalKeys = await Translation.countDocuments({ projectId: project._id });
      if (totalKeys >= keyCap) return sendError(res, 400, keyCapMessage(keyCap));
    }

    for (const [rawKey, value] of Object.entries(flatResult.flat)) {
      const key = rawKey.trim();
      if (!key || !KEY_REGEX.test(key)) {
        addSkippedKey(rawKey);
        continue;
      }

      let existing = await Translation.findOne({ projectId: project._id, key });
      if (!existing) {
        // A concurrent push/import racing this create loses to the unique
        // {projectId, key} index — fall through to the update path with the
        // winner's doc instead of 500ing the whole push.
        try {
          const newT = await Translation.create({
            projectId: new mongoose.Types.ObjectId(String(project._id)),
            key,
            translations: { [lang]: { [register]: value } },
            source: "human",
            sources: { [lang]: { [register]: "human" } },
          });
          await recordPushHistory(
            newT._id,
            newT.projectId,
            lang,
            register,
            key,
            "",
            value,
            project.owner
          );
          created++;
          continue;
        } catch (e: any) {
          if (e?.code !== 11000) throw e;
          existing = await Translation.findOne({ projectId: project._id, key });
          if (!existing) throw e;
        }
      }

      {
        let didUpdate = false;
        await withTransactionOrFallback(async (session) => {
          const fresh = await Translation.findById(existing._id).session(session ?? null);
          if (!fresh) return;
          if ((fresh as any).regulated === true || (fresh as any).everRegulated === true) {
            addSkippedRegulated(key);
            return;
          }
          const oldValue = readValue(fresh.translations as any, lang, register) || "";
          if (oldValue !== value) deleteVoiceCell(fresh, lang, register);
          writeValue(fresh, "translations", lang, register, value);
          writeValue(fresh, "sources", lang, register, "human");
          fresh.updatedAt = new Date();
          await fresh.save({ session });
          await recordPushHistory(
            fresh._id,
            fresh.projectId,
            lang,
            register,
            key,
            oldValue,
            value,
            project.owner,
            session
          );
          didUpdate = true;
        });
        if (didUpdate) updated++;
      }
    }

    return sendSuccess(res, 200, {
      message: `Push complete: ${created} created, ${updated} updated${skipped ? `, ${skipped} skipped` : ""}`,
      created,
      updated,
      skipped,
      skippedKeys,
      skippedRegulated: Array.from(skippedRegulated),
    });
  } catch (e) {
    return sendError(res, 500, "Failed to push translations");
  }
});

// ─── GET PROJECT INFO ─────────────────────────────────────────
router.get("/project", (req: Request, res: Response) => {
  const project = (req as any).project;

  return sendSuccess(res, 200, {
    id: project._id,
    name: project.name,
    defaultLanguage: project.defaultLanguage,
    supportedLanguages: project.supportedLanguages,
  });
});

// ─── GET TRANSLATIONS ─────────────────────────────────────────
// Returns a flat Record<key, string> for one language at one register.
// Backwards-compatible: callers that don't pass `register` get "default",
// which is the same shape old SDKs (<= 0.1.x) expect.
//
// COMPLIANCE LOCK: For any translation row marked `regulated: true`, we only
// serve cells whose source provenance is "human" or "approved". An AI draft
// on a regulated key never reaches end users — the SDK falls back to the
// default register (also gated) or to the key itself. Project owners must
// explicitly approve regulated drafts in the dashboard before they go live.
router.get("/translations", async (req: Request, res: Response) => {
  try {
    const project = (req as any).project;
    const { lang, register } = req.query;

    if (!lang || typeof lang !== "string") {
      return sendError(res, 400, "Query parameter 'lang' is required (e.g. ?lang=hi)");
    }

    if (!project.supportedLanguages.includes(lang)) {
      return sendError(res, 400, `Language "${lang}" is not supported by this project`);
    }

    const reg = coerceRegister(register);
    // Project only the fields the bundle + compliance gate need, as lean plain
    // objects — avoids hydrating full Mongoose docs (including the voice Map) on
    // every end-user cold-start. The register helpers read plain objects fine.
    const translations = await Translation.find(
      { projectId: project._id },
      "key translations sources regulated"
    ).lean();
    const flat: Record<string, string> = Object.create(null);

    for (const t of translations) {
      // Try the requested register, fall back to "default" so a partially
      // localized casual register still produces a usable bundle. For
      // regulated rows, gate each candidate cell on its source provenance.
      let value = pickSafe(t, lang, reg);
      if (!value && reg !== DEFAULT_REGISTER) {
        value = pickSafe(t, lang, DEFAULT_REGISTER);
      }
      if (value) flat[t.key] = value;
    }

    // Cache for 5 minutes — but PRIVATE only. The project is selected by the
    // x-api-key HEADER, not the URL, so a SHARED cache (CDN/proxy) keyed on the
    // URL could serve one project's bundle to another. "private" restricts
    // caching to the end-user's own browser. Express still adds a weak ETag for
    // 304 revalidation.
    res.set("Cache-Control", "private, max-age=300");
    return sendSuccess(res, 200, flat);
  } catch (e) {
    return sendError(res, 500, "Failed to fetch translations");
  }
});

/**
 * Read a (lang, register) value from a translation, applying the compliance
 * lock: regulated rows only serve human or approved cells. Returns undefined
 * (i.e. "no servable value") for ai-source cells on regulated rows so the
 * caller falls back to the next candidate or to the key itself.
 */
function pickSafe(t: any, lang: string, register: any): string | undefined {
  const value = readValue(t.translations as any, lang, register);
  if (!value) return undefined;
  const source = readValue(t.sources as any, lang, register);
  return canServe(!!t.regulated, source) ? value : undefined;
}

// ─── GET VOICE BUNDLE ─────────────────────────────────────────
// Returns Record<key, { ipa, ssml }> for one (lang, register).
// Same as /sdk/translations in shape — the client can decide whether to
// fetch this lazily (only when entering voice mode) or eagerly.
//
// COMPLIANCE LOCK: applies the same human/approved gate as /translations.
// Voice for a regulated key is only returned if the underlying text cell's
// source is `human` or `approved`. AI-drafted regulated text never reaches
// users via either path.
router.get("/voice", async (req: Request, res: Response) => {
  try {
    const project = (req as any).project;
    const { lang, register } = req.query;

    if (!lang || typeof lang !== "string") {
      return sendError(res, 400, "Query parameter 'lang' is required");
    }

    if (!project.supportedLanguages.includes(lang)) {
      return sendError(res, 400, `Language "${lang}" is not supported by this project`);
    }

    const reg = coerceRegister(register);
    const translations = await Translation.find(
      { projectId: project._id },
      "key sources regulated voice"
    ).lean();
    const flat: Record<string, { ipa: string; ssml: string }> = Object.create(null);

    for (const t of translations) {
      let cell = pickSafeVoice(t, lang, reg);
      if ((!cell || !cell.ipa) && reg !== DEFAULT_REGISTER) {
        cell = pickSafeVoice(t, lang, DEFAULT_REGISTER);
      }
      if (cell && (cell.ipa || cell.ssml)) {
        flat[t.key] = { ipa: cell.ipa || "", ssml: cell.ssml || "" };
      }
    }

    // Cache for 5 minutes — but PRIVATE only. The project is selected by the
    // x-api-key HEADER, not the URL, so a SHARED cache (CDN/proxy) keyed on the
    // URL could serve one project's bundle to another. "private" restricts
    // caching to the end-user's own browser. Express still adds a weak ETag for
    // 304 revalidation.
    res.set("Cache-Control", "private, max-age=300");
    return sendSuccess(res, 200, flat);
  } catch (e) {
    return sendError(res, 500, "Failed to fetch voice bundle");
  }
});

/**
 * Read a (lang, register) voice cell, applying the compliance lock against
 * the underlying text cell's source. Returns undefined for regulated rows
 * whose text source is not human/approved — voice should never leak past
 * the same gate the text bundle enforces.
 */
function pickSafeVoice(
  t: any,
  lang: string,
  register: any
): { ipa: string; ssml: string } | undefined {
  const voiceField = (t as any).voice;
  const langMap = voiceField instanceof Map ? voiceField.get(lang) : voiceField?.[lang];
  const cell = langMap instanceof Map ? langMap.get(register) : langMap?.[register];
  if (!cell) return undefined;
  const source = readValue(t.sources as any, lang, register);
  return canServe(!!t.regulated, source) ? cell : undefined;
}

export default router;
