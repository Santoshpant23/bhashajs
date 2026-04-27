/**
 * Translation Routes
 *
 * GET    /api/translations/:projectId              — Get all translations (or flat JSON with ?lang=hi)
 * POST   /api/translations/:projectId              — Create a single translation key
 * POST   /api/translations/:projectId/bulk         — Bulk import translations for a language
 * PUT    /api/translations/:id                     — Update a translation (with per-language source tracking)
 * DELETE /api/translations/:id                     — Delete a translation key
 * GET    /api/translations/:projectId/stats        — Get translation completion stats + source breakdown
 * POST   /api/translations/:projectId/ai-translate — AI-powered translation with memory context
 * POST   /api/translations/:id/review              — Approve/reject an AI translation per language
 * GET    /api/translations/:projectId/memory       — Get translation memory entries
 * DELETE /api/translations/memory/:id              — Delete a translation memory entry
 * GET    /api/translations/:translationId/history  — Get change history for a translation key
 * GET    /api/translations/:projectId/history/recent — Get recent changes across the project
 *
 * All routes are protected by authMiddleware.
 * Project-scoped routes use requireProjectRole for authorization.
 * All responses follow { success, data/message } format.
 */

import { Router, Response } from "express";
import mongoose from "mongoose";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { requireProjectRole, ProjectAuthRequest } from "../middleware/projectAuth";
import Translation from "../models/Translation";
import TranslationMemory from "../models/TranslationMemory";
import TranslationHistory from "../models/TranslationHistory";
import ProjectMember from "../models/ProjectMember";
import Notification from "../models/Notification";
import Project from "../models/Project";
import { sendSuccess, sendError } from "../utils/response";
import { validateRequired, validateObjectId } from "../utils/validate";
import { getAIProvider, TranslationInput, MemoryExample, GlossaryTerm, VoiceInput } from "../services/ai-provider";
import GlossaryEntry from "../models/GlossaryEntry";
import {
  coerceRegister,
  readValue,
  writeValue,
  iterateCells,
  DEFAULT_REGISTER,
  Register,
} from "../utils/registers";
import { isValidRegister, REGISTERS } from "../models/Translation";

const router = Router();

// All routes below require authentication
router.use(authMiddleware);

// ─── Helper: record a history entry ─────────────────────────
async function recordHistory(
  translationId: any,
  projectId: any,
  lang: string,
  register: Register,
  key: string,
  oldValue: string,
  newValue: string,
  source: string,
  changedBy: string
) {
  if (oldValue === newValue) return; // no change
  try {
    await TranslationHistory.create({
      translationId,
      projectId,
      lang,
      register,
      key,
      oldValue: oldValue || "",
      newValue,
      source,
      changedBy,
    });
  } catch (e) {
    // History recording is non-critical — don't fail the request
    console.error("[BhashaJS] Failed to record history:", e);
  }
}

/**
 * Normalize a write payload from the client.
 *
 * Old clients send flat-per-language values:
 *   { translations: { hi: "स्वागत" } }
 * New clients send nested per-register values:
 *   { translations: { hi: { default: "स्वागत", casual: "Welcome!" } } }
 *
 * This collapses both into the nested form keyed by the supplied
 * fallback register (typically "default" for plain flat input).
 */
function normalizePayload(
  raw: any,
  fallbackRegister: Register
): Record<string, Record<string, string>> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [lang, val] of Object.entries(raw)) {
    if (typeof val === "string") {
      out[lang] = { [fallbackRegister]: val };
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      const inner: Record<string, string> = {};
      for (const [reg, v] of Object.entries(val as Record<string, unknown>)) {
        if (typeof v !== "string") continue;
        if (!isValidRegister(reg)) continue;
        inner[reg] = v;
      }
      if (Object.keys(inner).length > 0) out[lang] = inner;
    }
  }
  return out;
}

// ─── GET ALL TRANSLATIONS FOR A PROJECT ──────────────────────
router.get(
  "/:projectId",
  requireProjectRole("owner", "translator", "viewer"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const { lang, page, limit: limitParam, search } = req.query;

      const idError = validateObjectId(projectId as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      // Flat lang export (dashboard preview / SDK fallback uses ?lang=hi&register=casual)
      // — no pagination. Falls back to "default" register if the requested one is empty.
      if (lang && typeof lang === "string") {
        const reg = coerceRegister(req.query.register);
        const translations = await Translation.find({ projectId });
        const flat: Record<string, string> = {};
        for (const t of translations) {
          let value = readValue(t.translations as any, lang, reg);
          if (!value && reg !== DEFAULT_REGISTER) {
            value = readValue(t.translations as any, lang, DEFAULT_REGISTER);
          }
          if (value) flat[t.key] = value;
        }
        return sendSuccess(res, 200, flat);
      }

      // Build query with optional search
      const query: any = { projectId };
      if (search && typeof search === "string" && search.trim()) {
        query.key = { $regex: search.trim(), $options: "i" };
      }

      // Pagination
      const pageNum = Math.max(1, Number(page) || 1);
      const rawLimit = limitParam !== undefined ? Number(limitParam) : 50;
      const pageLimit = Math.min(200, Math.max(1, isNaN(rawLimit) ? 50 : rawLimit));
      const skip = (pageNum - 1) * pageLimit;

      const [translations, total] = await Promise.all([
        Translation.find(query).sort({ key: 1 }).skip(skip).limit(pageLimit),
        Translation.countDocuments(query),
      ]);

      return sendSuccess(res, 200, {
        data: translations,
        pagination: {
          page: pageNum,
          limit: pageLimit,
          total,
          totalPages: Math.ceil(total / pageLimit),
        },
      });
    } catch (e) {
      return sendError(res, 500, "Failed to fetch translations");
    }
  }
);

// ─── GET TRANSLATION STATS ───────────────────────────────────
// Returns completion percentage + source breakdown per (language, register).
// Top-level `languages` keeps the legacy shape (default-register stats) so the
// existing dashboard summary doesn't break before Phase 1.5.
// `registers` adds the new breakdown: registers[lang][register] = { ... }.
router.get(
  "/:projectId/stats",
  requireProjectRole("owner", "translator", "viewer"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;

      const idError = validateObjectId(projectId as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      const project = await Project.findById(projectId);
      if (!project) return sendError(res, 404, "Project not found");

      const translations = await Translation.find({ projectId });
      const totalKeys = translations.length;

      type CellStats = {
        translated: number;
        total: number;
        percentage: number;
        sources: { human: number; ai: number; approved: number };
      };

      const empty = (): CellStats => ({
        translated: 0,
        total: totalKeys,
        percentage: 0,
        sources: { human: 0, ai: 0, approved: 0 },
      });

      const registers: Record<string, Record<string, CellStats>> = {};
      const languages: Record<string, CellStats> = {};

      for (const lang of project.supportedLanguages) {
        registers[lang] = {};
        for (const reg of REGISTERS) {
          registers[lang][reg] = empty();
        }
        languages[lang] = empty();
      }

      for (const t of translations) {
        for (const lang of project.supportedLanguages) {
          for (const reg of REGISTERS) {
            const cell = registers[lang][reg];
            const value = readValue(t.translations as any, lang, reg);
            if (value && value.trim()) cell.translated++;
            const src = readValue(t.sources as any, lang, reg);
            if (src === "human") cell.sources.human++;
            else if (src === "ai") cell.sources.ai++;
            else if (src === "approved") cell.sources.approved++;
          }
        }
      }

      // Compute percentages + back-compat top-level summary using "default".
      for (const lang of project.supportedLanguages) {
        for (const reg of REGISTERS) {
          const cell = registers[lang][reg];
          cell.percentage =
            totalKeys > 0 ? Math.round((cell.translated / totalKeys) * 100) : 0;
        }
        languages[lang] = registers[lang][DEFAULT_REGISTER];
      }

      return sendSuccess(res, 200, { totalKeys, languages, registers });
    } catch (e) {
      return sendError(res, 500, "Failed to fetch stats");
    }
  }
);

// ─── GET HISTORY FOR A TRANSLATION KEY ──────────────────────
router.get(
  "/:translationId/history",
  async (req: AuthRequest, res: Response) => {
    try {
      const { translationId } = req.params;
      const { lang, limit } = req.query;

      const idError = validateObjectId(translationId as string, "Translation ID");
      if (idError) return sendError(res, 400, idError);

      // Resolve the translation so we can verify the requester is a member of
      // its project — otherwise any logged-in user could read history for any
      // translation by ID.
      const translation = await Translation.findById(translationId);
      if (!translation) return sendError(res, 404, "Translation not found");

      const member = await ProjectMember.findOne({
        projectId: translation.projectId,
        userId: req.userId,
        status: "active",
      });
      if (!member) return sendError(res, 403, "Not authorized for this project");

      const filter: any = { translationId };
      if (lang && typeof lang === "string") {
        filter.lang = lang;
      }

      const maxLimit = Math.min(Number(limit) || 20, 50);
      const history = await TranslationHistory.find(filter)
        .populate("changedBy", "name email")
        .sort({ createdAt: -1 })
        .limit(maxLimit);

      return sendSuccess(res, 200, history);
    } catch (e) {
      return sendError(res, 500, "Failed to fetch history");
    }
  }
);

// ─── GET RECENT PROJECT HISTORY ─────────────────────────────
router.get(
  "/:projectId/history/recent",
  requireProjectRole("owner", "translator", "viewer"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const { limit } = req.query;

      const idError = validateObjectId(projectId as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      const maxLimit = Math.min(Number(limit) || 50, 100);
      const history = await TranslationHistory.find({ projectId })
        .populate("changedBy", "name email")
        .sort({ createdAt: -1 })
        .limit(maxLimit);

      return sendSuccess(res, 200, history);
    } catch (e) {
      return sendError(res, 500, "Failed to fetch recent history");
    }
  }
);

// ─── CREATE A SINGLE TRANSLATION KEY ─────────────────────────
router.post(
  "/:projectId",
  requireProjectRole("owner", "translator"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const { key, translations, context, source } = req.body;

      const idError = validateObjectId(projectId as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      const keyError = validateRequired(key, "Translation key");
      if (keyError) return sendError(res, 400, keyError);

      const keyRegex = /^[a-z0-9._]+$/;
      if (!keyRegex.test(key.trim())) {
        return sendError(
          res,
          400,
          "Key must only contain lowercase letters, numbers, dots, and underscores (e.g. hero.title, nav_home)"
        );
      }

      // Accept flat-per-language ({hi: "x"}) or nested-per-register
      // ({hi: {default: "x", casual: "y"}}) shapes. Flat values default to
      // the "default" register so old clients keep working unchanged.
      const incomingRegister = coerceRegister(req.body.register);
      const normalized = normalizePayload(translations, incomingRegister);

      // Mirror the same shape into sources, stamping each cell with `source`.
      const sourcesMap: Record<string, Record<string, string>> = {};
      for (const [lang, langMap] of Object.entries(normalized)) {
        sourcesMap[lang] = {};
        for (const reg of Object.keys(langMap)) {
          sourcesMap[lang][reg] = source || "human";
        }
      }

      const translation = await Translation.create({
        projectId: new mongoose.Types.ObjectId(projectId as string),
        key: key.trim(),
        translations: normalized,
        context: context?.trim() || undefined,
        source: source || "human",
        sources: sourcesMap,
      });

      // Record history for each initial (lang, register) cell
      for (const [lang, langMap] of Object.entries(normalized)) {
        for (const [reg, value] of Object.entries(langMap)) {
          if (value.trim()) {
            await recordHistory(
              translation._id, projectId, lang, reg as Register, key.trim(),
              "", value, "human", req.userId!
            );
          }
        }
      }

      return sendSuccess(res, 201, translation);
    } catch (e: any) {
      if (e.code === 11000) {
        return sendError(res, 400, "This key already exists in the project");
      }
      return sendError(res, 500, "Failed to create translation");
    }
  }
);

// ─── BULK IMPORT TRANSLATIONS ────────────────────────────────
router.post(
  "/:projectId/bulk",
  requireProjectRole("owner", "translator"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const { lang, translations } = req.body;

      const idError = validateObjectId(projectId as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      const langError = validateRequired(lang, "Language code");
      if (langError) return sendError(res, 400, langError);

      // Translator language restriction
      if (req.membership?.role === "translator") {
        if (!req.membership.assignedLanguages.includes(lang)) {
          return sendError(res, 403, `You are not assigned to translate "${lang}"`);
        }
      }

      if (!translations || typeof translations !== "object") {
        return sendError(res, 400, "Translations must be an object of key-value pairs");
      }

      // Bulk import targets a single (lang, register) cell. Defaults to
      // "default" so legacy clients that don't know about registers keep working.
      const register = coerceRegister(req.body.register);

      let created = 0;
      let updated = 0;

      for (const [key, value] of Object.entries(translations)) {
        if (typeof value !== "string") continue;

        const existing = await Translation.findOne({ projectId, key });

        if (existing) {
          const oldValue = readValue(existing.translations as any, lang, register) || "";
          writeValue(existing, "translations", lang, register, value);
          writeValue(existing, "sources", lang, register, "human");
          existing.updatedAt = new Date();
          await existing.save();
          await recordHistory(
            existing._id, projectId, lang, register, key,
            oldValue, value, "human", req.userId!
          );
          updated++;
        } else {
          const newT = await Translation.create({
            projectId: new mongoose.Types.ObjectId(projectId as string),
            key,
            translations: { [lang]: { [register]: value } },
            source: "human",
            sources: { [lang]: { [register]: "human" } },
          });
          await recordHistory(
            newT._id, projectId, lang, register, key,
            "", value, "human", req.userId!
          );
          created++;
        }
      }

      return sendSuccess(res, 200, {
        message: `Import complete: ${created} created, ${updated} updated`,
        created,
        updated,
      });
    } catch (e) {
      return sendError(res, 500, "Failed to import translations");
    }
  }
);

// ─── UPDATE A TRANSLATION ────────────────────────────────────
//
// Edit semantics: the client must send `editedLang` and may send
// `editedRegister` (defaults to "default"). The route updates only that one
// (lang, register) cell — never overwrites unrelated cells, even if the
// client's `translations` payload happens to include other languages.
router.put("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { translations, context, source, editedLang } = req.body;
    const editedRegister = coerceRegister(req.body.editedRegister);

    const idError = validateObjectId(id as string, "Translation ID");
    if (idError) return sendError(res, 400, idError);

    const translation = await Translation.findById(id);
    if (!translation) {
      return sendError(res, 404, "Translation not found");
    }

    // Check membership + role
    const member = await ProjectMember.findOne({
      projectId: translation.projectId,
      userId: req.userId,
      status: "active",
    });
    if (!member) return sendError(res, 403, "Not authorized for this project");
    if (member.role === "viewer") return sendError(res, 403, "Viewers cannot edit translations");

    // Translator language restriction
    if (member.role === "translator" && editedLang) {
      if (member.assignedLanguages.length > 0 && !member.assignedLanguages.includes(editedLang)) {
        return sendError(res, 403, `You are not assigned to translate "${editedLang}"`);
      }
    }

    // Pull the new value out of the payload. We accept both the legacy flat
    // shape (`translations[editedLang]` is a string) and the nested shape
    // (`translations[editedLang][editedRegister]` is a string).
    let newValue: string | undefined;
    if (editedLang && translations && typeof translations === "object") {
      const langEntry = translations[editedLang];
      if (typeof langEntry === "string") {
        newValue = langEntry;
      } else if (langEntry && typeof langEntry === "object") {
        newValue = langEntry[editedRegister];
      }
    }

    if (editedLang && typeof newValue === "string") {
      const oldValue = readValue(translation.translations as any, editedLang, editedRegister) || "";
      await recordHistory(
        translation._id, translation.projectId, editedLang, editedRegister,
        translation.key, oldValue, newValue, "human", req.userId!
      );
      writeValue(translation, "translations", editedLang, editedRegister, newValue);
      writeValue(translation, "sources", editedLang, editedRegister, "human");
    }

    if (source) translation.source = source;
    if (context !== undefined) translation.context = context?.trim();
    translation.updatedAt = new Date();

    await translation.save();

    // Notify owner when translator edits
    if (member.role === "translator" && editedLang) {
      try {
        const project = await Project.findById(translation.projectId);
        if (project && String(project.owner) !== String(req.userId)) {
          await Notification.create({
            userId: project.owner,
            type: "translator_edit",
            message: `${member.email} updated "${translation.key}" (${editedLang}/${editedRegister}) in "${project.name}"`,
            projectId: translation.projectId,
          });
        }
      } catch (_) { /* non-critical */ }
    }

    return sendSuccess(res, 200, translation);
  } catch (e) {
    return sendError(res, 500, "Failed to update translation");
  }
});

// ─── DELETE A TRANSLATION ────────────────────────────────────
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const idError = validateObjectId(id as string, "Translation ID");
    if (idError) return sendError(res, 400, idError);

    const translation = await Translation.findById(id);
    if (!translation) {
      return sendError(res, 404, "Translation not found");
    }

    // Only owners can delete translation keys
    const member = await ProjectMember.findOne({
      projectId: translation.projectId,
      userId: req.userId,
      status: "active",
    });
    if (!member || member.role !== "owner") {
      return sendError(res, 403, "Only project owners can delete translations");
    }

    await translation.deleteOne();

    // Clean up history for this translation
    await TranslationHistory.deleteMany({ translationId: id });

    return sendSuccess(res, 200, { message: "Translation deleted" });
  } catch (e) {
    return sendError(res, 500, "Failed to delete translation");
  }
});

// ─── AI-POWERED TRANSLATION ─────────────────────────────────
//
// Translates English source strings (always read from the "default" register —
// English doesn't get formal/casual variants in this product) into the target
// language at the requested register. Defaults to "default" register if the
// caller doesn't specify, preserving old client behavior.
router.post(
  "/:projectId/ai-translate",
  requireProjectRole("owner", "translator"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const { targetLang, keys } = req.body;
      const targetRegister = coerceRegister(req.body.register);

      const idError = validateObjectId(projectId as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      const langError = validateRequired(targetLang, "Target language");
      if (langError) return sendError(res, 400, langError);

      if (targetLang === "en") {
        return sendError(res, 400, "Cannot AI-translate to English — English is the source language");
      }

      // Translator language restriction
      if (req.membership?.role === "translator") {
        if (!req.membership.assignedLanguages.includes(targetLang)) {
          return sendError(res, 403, `You are not assigned to translate "${targetLang}"`);
        }
      }

      const project = await Project.findById(projectId);
      if (!project) return sendError(res, 404, "Project not found");

      if (!project.supportedLanguages.includes(targetLang)) {
        return sendError(res, 400, `"${targetLang}" is not a supported language for this project`);
      }

      const allTranslations = await Translation.find({ projectId });

      let toTranslate = allTranslations.filter((t) => {
        const englishSource = readValue(t.translations as any, "en", DEFAULT_REGISTER);
        const existing = readValue(t.translations as any, targetLang, targetRegister);
        return englishSource && englishSource.trim() && !(existing && existing.trim());
      });

      if (keys && Array.isArray(keys) && keys.length > 0) {
        const keySet = new Set(keys);
        toTranslate = toTranslate.filter((t) => keySet.has(t.key));
      }

      if (toTranslate.length === 0) {
        return sendSuccess(res, 200, {
          message: "No keys need translation — all are already translated",
          translated: 0,
          keys: [],
        });
      }

      const langNames: Record<string, string> = {
        hi: "Hindi", bn: "Bengali", ur: "Urdu", ta: "Tamil", te: "Telugu",
        mr: "Marathi", ne: "Nepali", pa: "Punjabi (Gurmukhi)", "pa-PK": "Punjabi (Shahmukhi)",
        gu: "Gujarati", kn: "Kannada", ml: "Malayalam", si: "Sinhala",
        // Latin-script variants — output stays in Latin script, not native script.
        // The AI prompt is explicit about this so Gemini doesn't "helpfully" produce
        // Devanagari instead of Romanized Hindi.
        "hi-Latn": "Hindi in Latin script (Hinglish)",
        "ne-Latn": "Nepali in Latin script (Roman Nepali)",
        "ur-Latn": "Urdu in Latin script (Roman Urdu)",
        "bn-Latn": "Bengali in Latin script (Banglish)",
        "pa-Latn": "Punjabi in Latin script (Roman Punjabi)",
      };

      const inputs: TranslationInput[] = toTranslate.map((t) => ({
        key: t.key,
        text: readValue(t.translations as any, "en", DEFAULT_REGISTER)!,
        context: t.context || undefined,
      }));

      // Memory is stratified by register so a "casual" request only sees
      // casual examples — keeps the model from accidentally borrowing
      // formal phrasing into a casual translation.
      const memoryEntries = await TranslationMemory.find({
        projectId,
        lang: targetLang,
        register: targetRegister,
      }).limit(20);

      const memory = memoryEntries.map((m) => ({
        sourceText: m.sourceText,
        translatedText: m.translatedText,
      }));

      // Fetch glossary entries for target language
      const glossaryEntries = await GlossaryEntry.find({ projectId });
      const glossary: GlossaryTerm[] = glossaryEntries
        .filter((g) => g.translations?.get(targetLang))
        .map((g) => ({
          term: g.term,
          translation: g.translations.get(targetLang)!,
        }));

      const aiProvider = getAIProvider();
      const targetLangName = langNames[targetLang] || targetLang;
      const aiResults = await aiProvider.translate(
        inputs,
        targetLang,
        targetLangName,
        memory,
        glossary,
        targetRegister,
        (project as any).vertical || null
      );

      const translatedKeys: string[] = [];

      for (const t of toTranslate) {
        if (aiResults[t.key]) {
          const oldValue = readValue(t.translations as any, targetLang, targetRegister) || "";
          writeValue(t, "translations", targetLang, targetRegister, aiResults[t.key]);
          writeValue(t, "sources", targetLang, targetRegister, "ai");
          t.source = "ai";
          t.updatedAt = new Date();
          await t.save();
          await recordHistory(
            t._id, projectId, targetLang, targetRegister, t.key,
            oldValue, aiResults[t.key], "ai", req.userId!
          );
          translatedKeys.push(t.key);
        }
      }

      // Notify translators assigned to this language
      if (translatedKeys.length > 0) {
        try {
          const members = await ProjectMember.find({
            projectId,
            status: "active",
            role: "translator",
            assignedLanguages: targetLang,
          });
          for (const m of members) {
            if (m.userId && String(m.userId) !== String(req.userId)) {
              await Notification.create({
                userId: m.userId,
                type: "ai_translations_ready",
                message: `${translatedKeys.length} AI translations ready for ${targetLangName} (${targetRegister}) review in "${project.name}"`,
                projectId: projectId as string,
              });
            }
          }
        } catch (_) { /* non-critical */ }
      }

      return sendSuccess(res, 200, {
        message: `AI translated ${translatedKeys.length} keys to ${targetLangName} (${targetRegister})`,
        translated: translatedKeys.length,
        register: targetRegister,
        keys: translatedKeys,
      });
    } catch (e: any) {
      console.error("[BhashaJS] AI translation error:", e.message);
      return sendError(res, 500, e.message || "AI translation failed");
    }
  }
);

// ─── APPROVE / REJECT AN AI TRANSLATION ─────────────────────
router.post("/:id/review", async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { lang, action } = req.body;
    const register = coerceRegister(req.body.register);

    const idError = validateObjectId(id as string, "Translation ID");
    if (idError) return sendError(res, 400, idError);

    if (!lang || typeof lang !== "string") {
      return sendError(res, 400, "Language code is required");
    }
    if (!["approve", "reject"].includes(action)) {
      return sendError(res, 400, "Action must be 'approve' or 'reject'");
    }

    const translation = await Translation.findById(id);
    if (!translation) return sendError(res, 404, "Translation not found");

    // Check membership (owner and translator can review)
    const member = await ProjectMember.findOne({
      projectId: translation.projectId,
      userId: req.userId,
      status: "active",
    });
    if (!member) return sendError(res, 403, "Not authorized for this project");
    if (member.role === "viewer") return sendError(res, 403, "Viewers cannot review translations");
    if (member.role === "translator" && member.assignedLanguages.length > 0 && !member.assignedLanguages.includes(lang)) {
      return sendError(res, 403, `You are not assigned to translate "${lang}"`);
    }

    const translatedValue = readValue(translation.translations as any, lang, register);
    if (!translatedValue) {
      return sendError(res, 400, `No translation exists for "${lang}" at register "${register}"`);
    }

    if (action === "approve") {
      writeValue(translation, "sources", lang, register, "approved");

      // Record history
      await recordHistory(
        translation._id, translation.projectId, lang, register, translation.key,
        translatedValue, translatedValue, "approved", req.userId!
      );

      // Memory is stratified by register so an approved "casual" pair
      // doesn't leak into "formal" suggestions.
      const englishText = readValue(translation.translations as any, "en", DEFAULT_REGISTER);
      if (englishText) {
        await TranslationMemory.findOneAndUpdate(
          { projectId: translation.projectId, lang, register, sourceText: englishText },
          {
            translatedText: translatedValue,
            key: translation.key,
            context: translation.context || undefined,
            createdAt: new Date(),
          },
          { upsert: true, new: true }
        );
      }
    } else {
      // Reject: record history then remove only this (lang, register) cell
      await recordHistory(
        translation._id, translation.projectId, lang, register, translation.key,
        translatedValue, "", "rejected", req.userId!
      );
      // Surgical delete from the nested map
      const trMap = translation.translations as any;
      const srMap = translation.sources as any;
      if (trMap instanceof Map) {
        const inner = trMap.get(lang);
        if (inner instanceof Map) inner.delete(register);
      }
      if (srMap instanceof Map) {
        const inner = srMap.get(lang);
        if (inner instanceof Map) inner.delete(register);
      }
      translation.markModified("translations");
      translation.markModified("sources");
    }

    translation.updatedAt = new Date();
    await translation.save();

    return sendSuccess(res, 200, {
      message: `Translation ${action === "approve" ? "approved" : "rejected"} for ${lang} (${register})`,
      translation,
    });
  } catch (e) {
    return sendError(res, 500, "Failed to review translation");
  }
});

// ─── GET TRANSLATION MEMORY ─────────────────────────────────
router.get(
  "/:projectId/memory",
  requireProjectRole("owner", "translator", "viewer"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const { lang } = req.query;

      const idError = validateObjectId(projectId as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      const filter: any = { projectId };
      if (lang && typeof lang === "string") {
        filter.lang = lang;
      }

      const memories = await TranslationMemory.find(filter).sort({ createdAt: -1 });
      return sendSuccess(res, 200, memories);
    } catch (e) {
      return sendError(res, 500, "Failed to fetch translation memory");
    }
  }
);

// ─── DELETE A TRANSLATION MEMORY ENTRY ──────────────────────
router.delete("/memory/:id", async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const idError = validateObjectId(id as string, "Memory ID");
    if (idError) return sendError(res, 400, idError);

    const entry = await TranslationMemory.findById(id);
    if (!entry) return sendError(res, 404, "Memory entry not found");

    // Only members of the entry's project can delete it (and viewers cannot).
    const member = await ProjectMember.findOne({
      projectId: entry.projectId,
      userId: req.userId,
      status: "active",
    });
    if (!member) return sendError(res, 403, "Not authorized for this project");
    if (member.role === "viewer") {
      return sendError(res, 403, "Viewers cannot delete memory entries");
    }

    await entry.deleteOne();

    return sendSuccess(res, 200, { message: "Memory entry deleted" });
  } catch (e) {
    return sendError(res, 500, "Failed to delete memory entry");
  }
});

// ─── GENERATE VOICE-READY OUTPUTS (IPA + SSML) ───────────────
//
// For each translation in the project at (lang, register), produce IPA
// phonetic transcription + SSML markup. Skips cells that already have voice
// data unless `overwrite: true` is passed. Skips cells with no translation
// (nothing to transcribe).
//
// Reading the SDK voice bundle is via GET /api/sdk/voice (no JWT, API key).
router.post(
  "/:projectId/generate-voice",
  requireProjectRole("owner", "translator"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const { lang, keys, overwrite } = req.body;
      const register = coerceRegister(req.body.register);

      const idError = validateObjectId(projectId as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      const langError = validateRequired(lang, "Language code");
      if (langError) return sendError(res, 400, langError);

      // Translator language restriction
      if (req.membership?.role === "translator") {
        if (!req.membership.assignedLanguages.includes(lang)) {
          return sendError(res, 403, `You are not assigned to translate "${lang}"`);
        }
      }

      const project = await Project.findById(projectId);
      if (!project) return sendError(res, 404, "Project not found");
      if (!project.supportedLanguages.includes(lang)) {
        return sendError(res, 400, `"${lang}" is not a supported language for this project`);
      }

      const allTranslations = await Translation.find({ projectId });

      // Pick rows that have a translation in (lang, register) and are missing
      // voice data (unless overwrite is set). If `keys` is supplied, restrict
      // to that subset so the dashboard can fire targeted re-generations.
      let candidates = allTranslations.filter((t) => {
        const text = readValue(t.translations as any, lang, register);
        if (!text || !text.trim()) return false;
        if (overwrite) return true;
        const voiceMap = (t as any).voice;
        const langMap = voiceMap instanceof Map ? voiceMap.get(lang) : voiceMap?.[lang];
        const cell = langMap instanceof Map ? langMap.get(register) : langMap?.[register];
        return !cell || !cell.ipa;
      });

      if (keys && Array.isArray(keys) && keys.length > 0) {
        const keySet = new Set(keys);
        candidates = candidates.filter((t) => keySet.has(t.key));
      }

      if (candidates.length === 0) {
        return sendSuccess(res, 200, {
          message: "No keys need voice data — all are already generated",
          generated: 0,
          keys: [],
        });
      }

      const langNames: Record<string, string> = {
        hi: "Hindi", bn: "Bengali", ur: "Urdu", ta: "Tamil", te: "Telugu",
        mr: "Marathi", ne: "Nepali", pa: "Punjabi (Gurmukhi)", "pa-PK": "Punjabi (Shahmukhi)",
        gu: "Gujarati", kn: "Kannada", ml: "Malayalam", si: "Sinhala", en: "English",
        "hi-Latn": "Hindi (Latin script)", "ne-Latn": "Nepali (Latin script)",
        "ur-Latn": "Urdu (Latin script)", "bn-Latn": "Bengali (Latin script)",
        "pa-Latn": "Punjabi (Latin script)",
      };

      const inputs: VoiceInput[] = candidates.map((t) => ({
        key: t.key,
        text: readValue(t.translations as any, lang, register)!,
      }));

      const aiProvider = getAIProvider();
      const langName = langNames[lang] || lang;
      const aiResults = await aiProvider.generateVoice(inputs, lang, langName, register);

      const generatedKeys: string[] = [];
      for (const t of candidates) {
        const result = aiResults[t.key];
        if (!result) continue;

        // Write into the nested voice Map: voice[lang][register] = { ipa, ssml }
        const voiceField = (t as any).voice as Map<string, Map<string, any>>;
        let langMap = voiceField.get(lang);
        if (!langMap) {
          langMap = new Map();
          voiceField.set(lang, langMap);
        }
        langMap.set(register, { ipa: result.ipa, ssml: result.ssml });
        t.markModified("voice");
        t.updatedAt = new Date();
        await t.save();
        generatedKeys.push(t.key);
      }

      return sendSuccess(res, 200, {
        message: `Generated voice data for ${generatedKeys.length} key(s) in ${langName} (${register})`,
        generated: generatedKeys.length,
        register,
        keys: generatedKeys,
      });
    } catch (e: any) {
      console.error("[BhashaJS] Voice generation error:", e?.message);
      return sendError(res, 500, e?.message || "Voice generation failed");
    }
  }
);

export default router;
