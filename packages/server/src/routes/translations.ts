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
import Comment from "../models/Comment";
import {
  coerceRegister,
  readValue,
  writeValue,
  writeVoiceCell,
  iterateCells,
  DEFAULT_REGISTER,
  Register,
} from "../utils/registers";
import { isValidRegister, REGISTERS } from "../models/Translation";
import { resolveWriteSource } from "../utils/compliance";
import { withTransactionOrFallback } from "../utils/transaction";
import { reserveUsage, refundUsage, getUsage, currentPeriod } from "../utils/usage";

// Escape user input destined for a Mongo $regex so it's matched as a literal
// substring. Without this, a crafted pattern like "(a+)+$" forces catastrophic
// backtracking (ReDoS) over the whole collection.
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
  changedBy: string,
  session?: any,
  isRegulated?: boolean
) {
  // Skip no-op edits — EXCEPT approval/rejection events, which are provenance
  // changes worth recording in the audit trail even when the text is unchanged
  // (an owner approving a pending regulated string is an auditable action).
  const provenanceEvent = source === "approved" || source === "rejected";
  if (oldValue === newValue && !provenanceEvent) return;
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
        source,
        changedBy,
      }],
      { session }
    );
  } catch (e) {
    console.error("[BhashaJS] Failed to record history:", e);
    // The audit event MUST NOT be silently dropped when it is load-bearing:
    //   - Inside a transaction (session present): propagate so the whole change
    //     rolls back together — no missing or phantom audit row.
    //   - On a REGULATED key: propagate EVEN without a session. A misconfigured
    //     standalone deployment (where withTransactionOrFallback ran the
    //     fallback path with no session) must FAIL the request rather than leave
    //     a regulated edit live with no audit trail — the compliance guarantee
    //     ("guaranteed audit trail") has to literally hold even there.
    // Non-regulated history outside a transaction stays best-effort and never
    // fails the request.
    if (session || isRegulated) throw e;
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

      // Build query with optional search. The input is escaped + length-capped
      // so it's a literal case-insensitive SUBSTRING match on the key — never a
      // user-controlled regex that could ReDoS the shared DB. (Escaping makes
      // the pattern linear, which is what removes the catastrophic-backtracking
      // risk; matching stays substring so "checkout" still finds "cart.checkout".)
      const query: any = { projectId };
      if (search && typeof search === "string" && search.trim()) {
        const term = search.trim().slice(0, 100);
        query.key = { $regex: escapeRegex(term), $options: "i" };
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
        sources: { human: number; ai: number; approved: number; pending: number };
      };

      const empty = (): CellStats => ({
        translated: 0,
        total: totalKeys,
        percentage: 0,
        sources: { human: 0, ai: 0, approved: 0, pending: 0 },
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
            else if (src === "pending") cell.sources.pending++;
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
      const { key, translations, context } = req.body;

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

      // Translator language restriction: a translator can only create a key
      // whose payload languages are all in their assignedLanguages. Empty
      // assignment = no languages allowed (consistent with bulk/AI routes).
      if (req.membership?.role === "translator") {
        const assigned = new Set(req.membership.assignedLanguages || []);
        for (const lang of Object.keys(normalized)) {
          if (!assigned.has(lang)) {
            return sendError(res, 403, `You are not assigned to translate "${lang}"`);
          }
        }
      }

      // `source` is route-determined, never client-provided. The manual create
      // path always means a human typed it; AI drafts go through ai-translate
      // and approvals through review.
      const sourcesMap: Record<string, Record<string, string>> = {};
      for (const [lang, langMap] of Object.entries(normalized)) {
        sourcesMap[lang] = {};
        for (const reg of Object.keys(langMap)) {
          sourcesMap[lang][reg] = "human";
        }
      }

      // Compliance lock fields — only the owner can flip `regulated`. Translators
      // can attach a `mandatedBy` citation but it doesn't lock the key on its own.
      const isOwner = req.membership?.role === "owner";
      const incomingRegulated =
        isOwner && typeof req.body.regulated === "boolean" ? req.body.regulated : false;
      const incomingMandatedBy =
        typeof req.body.mandatedBy === "string" ? req.body.mandatedBy.trim() : "";

      const translation = await Translation.create({
        projectId: new mongoose.Types.ObjectId(projectId as string),
        key: key.trim(),
        translations: normalized,
        context: context?.trim() || undefined,
        source: "human",
        sources: sourcesMap,
        regulated: incomingRegulated,
        mandatedBy: incomingMandatedBy,
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
      let skipped = 0;
      const keyRegex = /^[a-z0-9._]+$/;

      // Compliance lock on write also applies to bulk import: a non-owner may
      // not publish a cell on a regulated key. Their bulk write is held as
      // "pending" until an owner approves it (see PUT /:id and /review).
      const bulkIsOwner = req.membership?.role === "owner";

      for (const [rawKey, value] of Object.entries(translations)) {
        if (typeof value !== "string") { skipped++; continue; }
        const key = rawKey.trim();
        // Same key shape rule as single create — silently skip malformed keys
        // rather than aborting the whole import (typical CSV/JSON dumps will
        // have a few stray entries that shouldn't kill a 5,000-row import).
        if (!key || !keyRegex.test(key)) { skipped++; continue; }

        const existing = await Translation.findOne({ projectId, key });

        if (existing) {
          const writeSource = resolveWriteSource((existing as any).regulated === true, bulkIsOwner);
          const oldValue = readValue(existing.translations as any, lang, register) || "";
          writeValue(existing, "translations", lang, register, value);
          writeValue(existing, "sources", lang, register, writeSource);
          existing.updatedAt = new Date();
          await existing.save();
          await recordHistory(
            existing._id, projectId, lang, register, key,
            oldValue, value, writeSource, req.userId!
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
        message: `Import complete: ${created} created, ${updated} updated${skipped ? `, ${skipped} skipped` : ""}`,
        created,
        updated,
        skipped,
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
    const { translations, context, editedLang } = req.body;
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

    // Translator language restriction. Empty assignedLanguages = no languages
    // allowed (a translator with nothing assigned shouldn't be able to write
    // anything). Owners must assign languages explicitly when promoting a
    // member to "translator".
    if (member.role === "translator" && editedLang) {
      if (!member.assignedLanguages.includes(editedLang)) {
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

    // Captured inside the edit block, then written atomically with the save
    // below (history AFTER persistence, both in one transaction).
    let historyOldValue = "";
    let historyWriteSource = "";
    let didEditCell = false;
    if (editedLang && typeof newValue === "string") {
      const oldValue = readValue(translation.translations as any, editedLang, editedRegister) || "";

      // ─── Compliance lock on WRITE ───────────────────────────────────────
      // On a regulated key, only an owner (the approval authority) may publish
      // a cell directly. A non-owner's edit is still written, but stamped
      // "pending" so the SDK's compliance gate (pickSafe in routes/sdk.ts,
      // which serves only "human"/"approved") holds it back until an owner
      // approves it via /review. Previously every edit was stamped "human"
      // with no `regulated` check, so a translator's save went live instantly
      // — silently defeating the entire compliance-lock guarantee.
      const isRegulated = (translation as any).regulated === true;
      const writeSource = resolveWriteSource(isRegulated, member.role === "owner");

      // Defer the audit event until AFTER the translation is persisted, and make
      // the two atomic (the save+history transaction below). Recording it here,
      // before the save, risked a PHANTOM audit event if the save then failed.
      historyOldValue = oldValue;
      historyWriteSource = writeSource;
      didEditCell = true;
      writeValue(translation, "translations", editedLang, editedRegister, newValue);
      writeValue(translation, "sources", editedLang, editedRegister, writeSource);

      // Translation-memory flywheel: capture every human-verified CORRECTION
      // (previously TM was only written on /review approval, missing the most
      // common signal — a human editing a cell). Source language is the
      // project's default (not hardcoded "en"), so non-English-source projects
      // also feed the corpus. Held (pending) regulated edits and source-language
      // edits are skipped; TM capture must never fail the edit.
      if (writeSource === "human" && newValue.trim()) {
        try {
          const proj = await Project.findById(translation.projectId);
          const sourceLang = proj?.defaultLanguage || "en";
          if (editedLang !== sourceLang) {
            const sourceText = readValue(
              translation.translations as any,
              sourceLang,
              DEFAULT_REGISTER
            );
            if (sourceText && sourceText.trim()) {
              await TranslationMemory.findOneAndUpdate(
                { projectId: translation.projectId, lang: editedLang, register: editedRegister, sourceText },
                {
                  translatedText: newValue,
                  key: translation.key,
                  context: translation.context || undefined,
                  createdAt: new Date(),
                },
                { upsert: true }
              );
            }
          }
        } catch (_) {
          /* non-critical */
        }
      }
    }

    // Row-level `source` is no longer client-controllable. Per-cell sources
    // are stamped above ("human" for the edited cell). The legacy row-level
    // field stays whatever the create/import path set it to. AI drafts go
    // through /ai-translate, approvals through /review.
    if (context !== undefined) translation.context = context?.trim();

    // Compliance lock — owner-only flip. mandatedBy citation can be edited by
    // any non-viewer (translators may want to add the regulator clause they
    // found while translating), but only owners can lock/unlock a key.
    if (typeof req.body.mandatedBy === "string") {
      (translation as any).mandatedBy = req.body.mandatedBy.trim();
    }
    if (typeof req.body.regulated === "boolean" && member.role === "owner") {
      (translation as any).regulated = req.body.regulated;
    }

    translation.updatedAt = new Date();

    // Persist the translation and its audit event ATOMICALLY. On a replica set /
    // Atlas they commit together (no missing or phantom audit event); on a
    // standalone Mongo the fallback saves then records in order, and a regulated
    // history failure propagates (it isn't silently swallowed) via the
    // isRegulated flag below.
    const keyIsRegulated = (translation as any).regulated === true;
    await withTransactionOrFallback(async (session) => {
      await translation.save({ session });
      if (didEditCell) {
        await recordHistory(
          translation._id, translation.projectId, editedLang, editedRegister,
          translation.key, historyOldValue, newValue as string, historyWriteSource, req.userId!,
          session, keyIsRegulated
        );
      }
    });

    // Notify owner when translator edits
    if (member.role === "translator" && editedLang) {
      try {
        const project = await Project.findById(translation.projectId);
        // `owner` is nullable in the schema (sandboxes are ownerless), but a
        // member-edited project always has one — guard so we never notify a
        // null user and so this typechecks against the nullable owner type.
        if (project && project.owner && String(project.owner) !== String(req.userId)) {
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

    // Delete the key and ALL its dependents atomically (or, on a standalone
    // Mongo, children-before-parent). Previously only history was cleaned up,
    // leaving comments orphaned.
    await withTransactionOrFallback(async (session) => {
      await Comment.deleteMany({ translationId: id }, { session });
      await TranslationHistory.deleteMany({ translationId: id }, { session });
      await Translation.deleteOne({ _id: id }, { session });
    });

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

      // ─── Monthly AI cap (BEFORE any AI call) ──────────────────────────────
      // Atomically RESERVE the candidate keys against the per-project credit cap
      // so a single project can't run up the model bill — and so two concurrent
      // requests can't both pass a check-then-record gate. Must run before
      // getAIProvider().translate() (the test suite relies on a 429 with NO AI
      // call). Keys that ultimately fail are refunded below.
      const cap = (project as any).aiMonthlyCap as number;
      // Capture the period at reserve time so a request that crosses the UTC
      // month boundary refunds the SAME bucket it reserved.
      const meterPeriod = currentPeriod();
      if (!(await reserveUsage(projectId as string, cap, toTranslate.length, false, meterPeriod))) {
        const { keysTranslated } = await getUsage(projectId as string);
        return sendError(
          res,
          429,
          `Monthly AI translation cap reached (${keysTranslated}/${cap}). Resets next month.`
        );
      }

      // ─── Bulletproof settlement (every exit path: success/abort/exception) ──
      // We reserved `reservedCount` keys above. Below we record `writtenCount` =
      // the ACTUAL cells persisted. The `finally` runs on EVERY way out of the
      // post-reservation block (normal return, client abort, or a throw that
      // propagates to the outer catch) and refunds exactly the difference. So:
      //   - abort/throw BEFORE persistence  → writtenCount 0 → refund all;
      //   - abort/throw AFTER some saves     → refund only the unwritten cells
      //                                        (written work stays counted);
      //   - success with partial AI failures → refund the failed/dropped keys.
      // Refunding `reserved - written` (never the written work) makes a
      // double-refund impossible — the arithmetic is settled exactly once.
      const reservedCount = toTranslate.length;
      let writtenCount = 0;

      // Cancel in-flight AI work only if the CLIENT actually disconnects.
      // NOTE: `req.on("close")` also fires on normal request-body completion, so
      // using it would abort every request. The reliable signal is the RESPONSE
      // stream closing before we've finished writing it (res.writableEnded).
      // @google/genai v2.7 honors config.abortSignal → aborts the upstream fetch.
      const controller = new AbortController();
      let aborted = false;
      const onClose = () => {
        if (res.writableEnded) return; // normal completion, not a disconnect
        aborted = true;
        controller.abort();
      };
      res.on("close", onClose);

      try {
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
        (project as any).vertical || null,
        controller.signal
      );

      // Client went away mid-flight (before we persisted anything) — stop here
      // without persisting. The abort signal already cancelled the upstream
      // call; writtenCount stays 0 so the finally refunds the whole reservation.
      if (aborted) {
        return; // connection is already closed; nothing to send (finally settles)
      }

      const translatedKeys: string[] = [];

      for (const t of toTranslate) {
        // Stop persisting if the client disconnected mid-loop — respect the
        // cancel; the finally refunds whatever wasn't written.
        if (aborted) break;
        if (aiResults[t.key]) {
          const oldValue = readValue(t.translations as any, targetLang, targetRegister) || "";
          writeValue(t, "translations", targetLang, targetRegister, aiResults[t.key]);
          writeValue(t, "sources", targetLang, targetRegister, "ai");
          t.source = "ai";
          t.updatedAt = new Date();
          await t.save();
          // Count the cell the instant it's durably saved. If the client
          // disconnects mid-loop, everything written so far stays metered
          // (the finally only refunds reserved - writtenCount).
          writtenCount++;
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

      // Keys the model didn't return (truncation, script-guard drop, batch
      // error) are reported back instead of being silently lost.
      const failedKeys = toTranslate
        .filter((t) => !aiResults[t.key])
        .map((t) => t.key);

      return sendSuccess(res, 200, {
        message:
          `AI translated ${translatedKeys.length} key(s) to ${targetLangName} (${targetRegister})` +
          (failedKeys.length ? `, ${failedKeys.length} failed` : ""),
        translated: translatedKeys.length,
        failed: failedKeys.length,
        register: targetRegister,
        keys: translatedKeys,
        failedKeys,
      });
      } finally {
        // SINGLE settlement point — runs on success, client abort, AND any throw
        // that propagates to the outer catch (the finally executes before the
        // catch). Refund exactly the reserved keys that weren't persisted; never
        // refund written work, so this can't double-refund.
        res.off("close", onClose);
        const refund = reservedCount - writtenCount;
        if (refund > 0) await refundUsage(projectId as string, refund, false, meterPeriod);
      }
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
    if (member.role === "translator" && !member.assignedLanguages.includes(lang)) {
      return sendError(res, 403, `You are not assigned to translate "${lang}"`);
    }

    // Compliance lock: only an owner may approve/reject a regulated key.
    // Otherwise a translator could self-approve their own "pending" edit to a
    // regulated cell ("pending" -> "approved") and the SDK would serve it —
    // defeating the lock. Owner is the sole approval authority for regulated keys.
    if ((translation as any).regulated && member.role !== "owner") {
      return sendError(res, 403, "Only project owners can review (approve/reject) regulated keys");
    }

    const translatedValue = readValue(translation.translations as any, lang, register);
    if (!translatedValue) {
      return sendError(res, 400, `No translation exists for "${lang}" at register "${register}"`);
    }

    const keyIsRegulated = (translation as any).regulated === true;

    // Mutate the in-memory document for the chosen action. The audit-history
    // write is DEFERRED until after the save below so the two are atomic — no
    // pre-save history event (which would be a PHANTOM approval if the save then
    // failed) and no out-of-transaction approval audit (which could leave an
    // approved-but-unaudited, servable cell).
    if (action === "approve") {
      writeValue(translation, "sources", lang, register, "approved");
    } else {
      // Reject: remove only this (lang, register) cell.
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

    // Persist the source/cell change and its audit event ATOMICALLY — mirrors
    // the PUT path. On a replica set / Atlas they commit together; on a
    // standalone Mongo the fallback saves then records in order, and because the
    // review action is itself the regulated approval/rejection, a history
    // failure propagates (isRegulated flag) rather than leaving an approved cell
    // with no audit trail.
    const historyOld = translatedValue;
    const historyNew = action === "approve" ? translatedValue : "";
    const historySource = action === "approve" ? "approved" : "rejected";
    await withTransactionOrFallback(async (session) => {
      await translation.save({ session });
      await recordHistory(
        translation._id, translation.projectId, lang, register, translation.key,
        historyOld, historyNew, historySource, req.userId!,
        session, keyIsRegulated
      );
    });

    // Translation-memory flywheel: an approved pair feeds the corpus. This is a
    // SEPARATE-document write kept OUTSIDE the audit transaction and best-effort
    // (like the PUT path's TM capture) — a TM hiccup must never roll back or fail
    // a successful approval. Memory is stratified by register so an approved
    // "casual" pair doesn't leak into "formal" suggestions; source language is
    // the project's default (not hardcoded "en") so non-English-source projects
    // build a corpus too.
    if (action === "approve") {
      try {
        const proj = await Project.findById(translation.projectId);
        const sourceLang = proj?.defaultLanguage || "en";
        const sourceText = readValue(translation.translations as any, sourceLang, DEFAULT_REGISTER);
        if (sourceText && lang !== sourceLang) {
          await TranslationMemory.findOneAndUpdate(
            { projectId: translation.projectId, lang, register, sourceText },
            {
              translatedText: translatedValue,
              key: translation.key,
              context: translation.context || undefined,
              createdAt: new Date(),
            },
            { upsert: true, new: true }
          );
        }
      } catch (_) {
        /* non-critical — approval already committed */
      }
    }

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

// ─── TRANSLATION MEMORY COVERAGE ────────────────────────────
// Per-(lang, register) count of human-verified pairs collected so far.
// This is the visible artifact of the TM flywheel — every approved AI
// translation becomes a corpus row, and the dashboard shows progress
// toward the threshold where this corpus becomes useful for fine-tuning
// (~5,000 pairs per (lang, register) is a reasonable starting line).
//
// Returns:
//   {
//     total: 1247,
//     byCell: [{ lang: "hi", register: "default", count: 412 }, ...],
//     fineTunableThreshold: 5000  // advisory; cells above this are flagged
//   }
router.get(
  "/:projectId/memory/coverage",
  requireProjectRole("owner", "translator", "viewer"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const idError = validateObjectId(projectId as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      // Group by (lang, register). For an early-stage product the project's
      // memory is small enough that we don't bother with $facet — a single
      // aggregation is fine and stays in one round trip.
      const grouped = await TranslationMemory.aggregate([
        { $match: { projectId: new mongoose.Types.ObjectId(projectId as string) } },
        {
          $group: {
            _id: { lang: "$lang", register: "$register" },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
      ]);

      const byCell = grouped.map((row: any) => ({
        lang: row._id.lang,
        register: row._id.register || DEFAULT_REGISTER,
        count: row.count,
      }));
      const total = byCell.reduce((sum: number, row: any) => sum + row.count, 0);

      return sendSuccess(res, 200, {
        total,
        byCell,
        // Advisory only — the real fine-tune threshold depends on language pair
        // and downstream model, but ~5k is the rough lower-bound for getting
        // measurable wins out of LoRA on a 7B model.
        fineTunableThreshold: 5000,
      });
    } catch (e) {
      return sendError(res, 500, "Failed to fetch memory coverage");
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

      // ─── Monthly AI cap (BEFORE any AI call) ──────────────────────────────
      // Voice hits the same model bill, so it RESERVES against the same monthly
      // keysTranslated budget (atomically) — repeated voice generation now
      // actually consumes the cap it's checked against.
      const voiceCap = (project as any).aiMonthlyCap as number;
      // Capture the period at reserve time so a month-boundary-crossing request
      // refunds the SAME bucket it reserved.
      const meterPeriod = currentPeriod();
      if (!(await reserveUsage(projectId as string, voiceCap, candidates.length, true, meterPeriod))) {
        const { keysTranslated } = await getUsage(projectId as string);
        return sendError(
          res,
          429,
          `Monthly AI translation cap reached (${keysTranslated}/${voiceCap}). Resets next month.`
        );
      }

      // ─── Bulletproof settlement (every exit path: success/abort/exception) ──
      // Same contract as /ai-translate: reservedCount voice cells reserved above,
      // writtenCount = cells actually persisted. The finally refunds exactly
      // reservedCount - writtenCount on EVERY exit (success, client abort, or a
      // throw bubbling to the outer catch), so written work is never refunded and
      // a leaked/double refund is impossible.
      const reservedCount = candidates.length;
      let writtenCount = 0;

      // Cancel in-flight AI work on a real client disconnect (see /ai-translate
      // for why this is res.on("close") + writableEnded, not req.on("close")).
      const controller = new AbortController();
      let aborted = false;
      const onClose = () => {
        if (res.writableEnded) return; // normal completion, not a disconnect
        aborted = true;
        controller.abort();
      };
      res.on("close", onClose);

      try {
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
      const aiResults = await aiProvider.generateVoice(
        inputs,
        lang,
        langName,
        register,
        controller.signal
      );

      // Client disconnected mid-flight (before we persisted anything) — skip
      // persistence. The abort signal already cancelled the upstream call;
      // writtenCount stays 0 so the finally refunds the whole reservation.
      if (aborted) {
        return; // connection is already closed; nothing to send (finally settles)
      }

      const generatedKeys: string[] = [];
      for (const t of candidates) {
        if (aborted) break; // client disconnected mid-loop — stop; finally refunds the rest
        const result = aiResults[t.key];
        if (!result) continue;

        // Write voice[lang][register] = { ipa, ssml } through the shared helper.
        // The previous hand-rolled write set a fresh inner Map then mutated the
        // LOCAL reference — but Mongoose stores its own cast copy, so the inner
        // write landed on a detached object and nothing persisted (the route
        // reported success while saving an empty voice map).
        writeVoiceCell(t, lang, register, { ipa: result.ipa, ssml: result.ssml });
        t.updatedAt = new Date();
        await t.save();
        // Count the cell the instant it's durably saved — a mid-loop disconnect
        // keeps everything written so far metered (finally refunds the rest).
        writtenCount++;
        generatedKeys.push(t.key);
      }

      return sendSuccess(res, 200, {
        message: `Generated voice data for ${generatedKeys.length} key(s) in ${langName} (${register})`,
        generated: generatedKeys.length,
        register,
        keys: generatedKeys,
      });
      } finally {
        // SINGLE settlement point — runs on success, client abort, AND any throw
        // bubbling to the outer catch. Refund exactly the reserved voice cells
        // that weren't persisted; never refund written work (no double-refund).
        res.off("close", onClose);
        const refund = reservedCount - writtenCount;
        if (refund > 0) await refundUsage(projectId as string, refund, true, meterPeriod);
      }
    } catch (e: any) {
      console.error("[BhashaJS] Voice generation error:", e?.message);
      return sendError(res, 500, e?.message || "Voice generation failed");
    }
  }
);

export default router;
