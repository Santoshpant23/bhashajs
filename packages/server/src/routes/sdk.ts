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
    const translations = await Translation.find({ projectId: project._id });
    const flat: Record<string, string> = {};

    for (const t of translations) {
      // Try the requested register, fall back to "default" so a partially
      // localized casual register still produces a usable bundle.
      let value = readValue(t.translations as any, lang, reg);
      if (!value && reg !== DEFAULT_REGISTER) {
        value = readValue(t.translations as any, lang, DEFAULT_REGISTER);
      }
      if (value) flat[t.key] = value;
    }

    return sendSuccess(res, 200, flat);
  } catch (e) {
    return sendError(res, 500, "Failed to fetch translations");
  }
});

// ─── GET VOICE BUNDLE ─────────────────────────────────────────
// Returns Record<key, { ipa, ssml }> for one (lang, register).
// Same as /sdk/translations in shape — the client can decide whether to
// fetch this lazily (only when entering voice mode) or eagerly.
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
    const translations = await Translation.find({ projectId: project._id });
    const flat: Record<string, { ipa: string; ssml: string }> = {};

    for (const t of translations) {
      const voiceField = (t as any).voice;
      const langMap = voiceField instanceof Map ? voiceField.get(lang) : voiceField?.[lang];
      let cell = langMap instanceof Map ? langMap.get(reg) : langMap?.[reg];
      // Fall back to default register's voice data if requested register is empty.
      if ((!cell || !cell.ipa) && reg !== DEFAULT_REGISTER) {
        cell = langMap instanceof Map
          ? langMap.get(DEFAULT_REGISTER)
          : langMap?.[DEFAULT_REGISTER];
      }
      if (cell && (cell.ipa || cell.ssml)) {
        flat[t.key] = { ipa: cell.ipa || "", ssml: cell.ssml || "" };
      }
    }

    return sendSuccess(res, 200, flat);
  } catch (e) {
    return sendError(res, 500, "Failed to fetch voice bundle");
  }
});

export default router;
