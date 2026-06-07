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
import Project from "../models/Project";
import Translation from "../models/Translation";
import { sendSuccess, sendError } from "../utils/response";
import { coerceRegister, readValue, DEFAULT_REGISTER } from "../utils/registers";
import { canServe } from "../utils/compliance";

const router = Router();

/**
 * Middleware: extract project from API key.
 * Expects the key in the `x-api-key` header.
 */
async function authenticateApiKey(req: Request, res: Response, next: Function) {
  const apiKey = req.headers["x-api-key"] as string;

  if (!apiKey) {
    return sendError(res, 401, "Missing API key. Set the x-api-key header.");
  }

  try {
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
    const flat: Record<string, string> = {};

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
    const flat: Record<string, { ipa: string; ssml: string }> = {};

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
