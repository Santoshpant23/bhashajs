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
import { reserveAiBudget, refundAiBudget, aiCapMessage, currentPeriod } from "../utils/usage";

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
  // Skip no-op edits — EXCEPT provenance events (approve/reject and the
  // append-only compliance events lock/unlock/delete), which are auditable
  // actions worth recording even when the cell text is unchanged.
  const provenanceEvent = ["approved", "rejected", "locked", "unlocked", "deleted"].includes(source);
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

      const docFields = {
        projectId: new mongoose.Types.ObjectId(projectId as string),
        key: key.trim(),
        translations: normalized,
        context: context?.trim() || undefined,
        source: "human",
        sources: sourcesMap,
        regulated: incomingRegulated,
        mandatedBy: incomingMandatedBy,
      };

      // Record history for each initial (lang, register) cell.
      const recordInitialCells = async (docId: any, session?: any) => {
        for (const [lang, langMap] of Object.entries(normalized)) {
          for (const [reg, value] of Object.entries(langMap)) {
            if (value.trim()) {
              await recordHistory(
                docId, projectId, lang, reg as Register, key.trim(),
                "", value, "human", req.userId!, session, incomingRegulated
              );
            }
          }
        }
      };

      let translation: any;
      if (incomingRegulated) {
        // Regulated key: the create AND its audit history must be ATOMIC, so a
        // regulated cell can never persist without its guaranteed trail (this was
        // the audit gap — create wrote history out-of-transaction, swallowing
        // failures). On a replica set both commit/roll back together; on a
        // standalone fallback a regulated history failure propagates.
        await withTransactionOrFallback(async (session) => {
          const [doc] = await Translation.create([docFields], { session });
          translation = doc;
          await recordInitialCells(doc._id, session);
        }, { requireTransaction: true });
      } else {
        // Non-regulated: history stays best-effort — a transient glitch never
        // fails the create.
        translation = await Translation.create(docFields);
        await recordInitialCells(translation._id);
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
          const ex = existing;
          const exRegulated = (ex as any).regulated === true;
          const writeSource = resolveWriteSource(exRegulated, bulkIsOwner);
          const oldValue = readValue(ex.translations as any, lang, register) || "";
          if (exRegulated) {
            // Regulated cell: value + audit row ATOMIC, and audit-critical so it
            // never falls back to a non-transactional path. Re-fetch INSIDE the
            // transaction so oldValue is the real committed predecessor (correct
            // chain under concurrency); a history failure rolls the cell back.
            await withTransactionOrFallback(
              async (session) => {
                const fresh = await Translation.findById(ex._id).session(session ?? null);
                if (!fresh) return;
                const freshOld = readValue(fresh.translations as any, lang, register) || "";
                writeValue(fresh, "translations", lang, register, value);
                writeValue(fresh, "sources", lang, register, writeSource);
                fresh.updatedAt = new Date();
                await fresh.save({ session });
                await recordHistory(
                  fresh._id, projectId, lang, register, key,
                  freshOld, value, writeSource, req.userId!, session, true
                );
              },
              { requireTransaction: true }
            );
          } else {
            writeValue(ex, "translations", lang, register, value);
            writeValue(ex, "sources", lang, register, writeSource);
            ex.updatedAt = new Date();
            await ex.save();
            await recordHistory(
              ex._id, projectId, lang, register, key,
              oldValue, value, writeSource, req.userId!
            );
          }
          updated++;
        } else {
          // New bulk keys are never regulated (bulk doesn't set the lock), so
          // history stays best-effort here.
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

    // The edit's INTENTS, captured outside; the read-modify-write happens INSIDE
    // the transaction (re-fetching with the session) so concurrent edits to the
    // same cell form a REAL audit chain — each attempt (incl. a WriteConflict
    // retry) reads the actually-committed predecessor, not a value captured
    // before the transaction (the round-10 audit bug: 10 concurrent edits all
    // chained off the same stale oldValue).
    const contextIntent = context !== undefined ? (context?.trim() ?? "") : undefined;
    const mandatedByIntent =
      typeof req.body.mandatedBy === "string" ? req.body.mandatedBy.trim() : undefined;
    const regulatedIntent =
      typeof req.body.regulated === "boolean" && member.role === "owner"
        ? req.body.regulated
        : undefined;
    const editorIsOwner = member.role === "owner";

    // Audit-critical when the key is (or was ever) regulated, or is being locked:
    // such a write must NEVER fall back to a non-transactional path that could
    // persist the value without its audit row.
    const auditCritical =
      (translation as any).regulated === true ||
      (translation as any).everRegulated === true ||
      regulatedIntent === true;

    let resultDoc: any = translation;
    let tmCapture: { sourceText: string; newValue: string } | null = null;

    await withTransactionOrFallback(
      async (session) => {
        const fresh = await Translation.findById(id).session(session ?? null);
        if (!fresh) throw new Error("Translation vanished mid-edit");
        const wasRegulated = (fresh as any).regulated === true;

        // Scalar field changes.
        if (contextIntent !== undefined) fresh.context = contextIntent;
        if (mandatedByIntent !== undefined) (fresh as any).mandatedBy = mandatedByIntent;
        let lockEvent: "locked" | "unlocked" | null = null;
        if (regulatedIntent !== undefined) {
          if (regulatedIntent !== wasRegulated) lockEvent = regulatedIntent ? "locked" : "unlocked";
          (fresh as any).regulated = regulatedIntent;
          if (regulatedIntent) (fresh as any).everRegulated = true; // append-only marker
        }

        // Cell edit — oldValue read from the FRESH (committed) doc.
        let cellOld = "";
        let cellSource = "";
        const editing = !!editedLang && typeof newValue === "string";
        if (editing) {
          // On a regulated key only an owner publishes directly; a non-owner's
          // edit is stamped "pending" so the SDK gate holds it for review.
          const effRegulated = (fresh as any).regulated === true;
          cellSource = resolveWriteSource(effRegulated, editorIsOwner);
          cellOld = readValue(fresh.translations as any, editedLang, editedRegister) || "";
          writeValue(fresh, "translations", editedLang, editedRegister, newValue as string);
          writeValue(fresh, "sources", editedLang, editedRegister, cellSource);
        }

        fresh.updatedAt = new Date();
        const isRegNow =
          (fresh as any).regulated === true || (fresh as any).everRegulated === true;

        await fresh.save({ session });

        if (editing) {
          await recordHistory(
            fresh._id, fresh.projectId, editedLang, editedRegister, fresh.key,
            cellOld, newValue as string, cellSource, req.userId!, session, isRegNow
          );
          // Stage the TM-flywheel write for AFTER commit (best-effort; must never
          // roll back the edit). Only human-verified, non-source-lang cells feed it.
          if (cellSource === "human" && (newValue as string).trim()) {
            const proj = await Project.findById(translation.projectId).session(session ?? null);
            const sourceLang = proj?.defaultLanguage || "en";
            if (editedLang !== sourceLang) {
              const sourceText = readValue(fresh.translations as any, sourceLang, DEFAULT_REGISTER);
              if (sourceText && sourceText.trim()) {
                tmCapture = { sourceText, newValue: newValue as string };
              }
            }
          }
        }

        // Append-only lock/unlock evidence event (recorded even with no cell
        // edit). lang "*" denotes a KEY-LEVEL event (not a specific cell).
        if (lockEvent) {
          await recordHistory(
            fresh._id, fresh.projectId, editedLang || "*", editedRegister, fresh.key,
            "", lockEvent === "locked" ? `locked: ${(fresh as any).mandatedBy || ""}`.trim() : "unlocked",
            lockEvent, req.userId!, session, true
          );
        }

        resultDoc = fresh;
      },
      { requireTransaction: auditCritical }
    );

    // Translation-memory flywheel — best-effort, POST-commit.
    if (tmCapture) {
      try {
        const cap = tmCapture as { sourceText: string; newValue: string };
        await TranslationMemory.findOneAndUpdate(
          { projectId: translation.projectId, lang: editedLang, register: editedRegister, sourceText: cap.sourceText },
          { translatedText: cap.newValue, key: resultDoc.key, context: resultDoc.context || undefined, createdAt: new Date() },
          { upsert: true }
        );
      } catch (_) { /* non-critical */ }
    }

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

    return sendSuccess(res, 200, resultDoc);
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

    // Delete the key and its dependents atomically. For an EVER-regulated key the
    // history is COMPLIANCE EVIDENCE: it's retained as a tombstone (not deleted)
    // and a "deleted" event is recorded, so the audit trail can't be destroyed by
    // unlocking-then-deleting. Non-regulated keys keep the full cascade.
    const everReg =
      (translation as any).everRegulated === true || (translation as any).regulated === true;
    await withTransactionOrFallback(
      async (session) => {
        await Comment.deleteMany({ translationId: id }, { session });
        if (everReg) {
          // lang "*" = a KEY-LEVEL event (the whole key was deleted).
          await recordHistory(
            translation._id, translation.projectId, "*", DEFAULT_REGISTER, translation.key,
            "", "deleted", "deleted", req.userId!, session, true
          );
        } else {
          await TranslationHistory.deleteMany({ translationId: id }, { session });
        }
        await Translation.deleteOne({ _id: id }, { session });
      },
      { requireTransaction: everReg }
    );

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
      // Reserve against ALL THREE scopes (project → account → global). The
      // account + global caps are what keep the forever-free service from
      // bleeding money: one owner can't multiply free AI across many projects,
      // and the global ceiling bounds the total bill. Keys that fail are refunded.
      const reservation = await reserveAiBudget(
        projectId as string, project.owner, cap, toTranslate.length, false, meterPeriod
      );
      if (!reservation.ok) {
        return sendError(res, 429, aiCapMessage(reservation.blockedScope, cap));
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

      // Glossary terms + translations are injected verbatim into EVERY AI prompt,
      // so bound both the count AND the cumulative size — otherwise a project with
      // thousands of (now length-capped) entries still balloons the prompt cost.
      const GLOSSARY_MAX_ENTRIES = 200;
      const GLOSSARY_MAX_CHARS = 20000;
      const glossaryEntries = await GlossaryEntry.find({ projectId }).limit(GLOSSARY_MAX_ENTRIES);
      const glossary: GlossaryTerm[] = [];
      let glossaryChars = 0;
      for (const g of glossaryEntries) {
        const tr = g.translations?.get(targetLang);
        if (!tr) continue;
        glossaryChars += g.term.length + tr.length;
        if (glossaryChars > GLOSSARY_MAX_CHARS) break;
        glossary.push({ term: g.term, translation: tr });
      }

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
      const writeFailedKeys: string[] = [];

      for (const t of toTranslate) {
        // Stop persisting if the client disconnected mid-loop — respect the
        // cancel; the finally refunds whatever wasn't written.
        if (aborted) break;
        if (!aiResults[t.key]) continue;
        const oldValue = readValue(t.translations as any, targetLang, targetRegister) || "";
        const tRegulated = (t as any).regulated === true;
        try {
          if (tRegulated) {
            // Regulated key: the AI draft cell + its audit row commit ATOMICALLY
            // and audit-critically (never falls back). Re-fetch INSIDE the txn so
            // oldValue is the real committed predecessor (correct chain).
            await withTransactionOrFallback(
              async (session) => {
                const fresh = await Translation.findById(t._id).session(session ?? null);
                if (!fresh) throw new Error("key vanished mid-translate");
                const freshOld = readValue(fresh.translations as any, targetLang, targetRegister) || "";
                writeValue(fresh, "translations", targetLang, targetRegister, aiResults[t.key]);
                writeValue(fresh, "sources", targetLang, targetRegister, "ai");
                fresh.source = "ai";
                fresh.updatedAt = new Date();
                await fresh.save({ session });
                await recordHistory(
                  fresh._id, projectId, targetLang, targetRegister, fresh.key,
                  freshOld, aiResults[t.key], "ai", req.userId!, session, true
                );
              },
              { requireTransaction: true }
            );
          } else {
            writeValue(t, "translations", targetLang, targetRegister, aiResults[t.key]);
            writeValue(t, "sources", targetLang, targetRegister, "ai");
            t.source = "ai";
            t.updatedAt = new Date();
            await t.save();
            await recordHistory(
              t._id, projectId, targetLang, targetRegister, t.key,
              oldValue, aiResults[t.key], "ai", req.userId!
            );
          }
          // Count the cell the instant it's durably saved (+ audited, if
          // regulated). A mid-loop disconnect keeps everything written so far
          // metered (the finally refunds reserved - writtenCount).
          writtenCount++;
          translatedKeys.push(t.key);
        } catch (keyErr) {
          // A regulated key whose atomic audit write failed rolled back — DON'T
          // count it (so the finally refunds it) and report it as failed rather
          // than leave an unaudited regulated draft.
          console.error(`[BhashaJS] AI write failed for "${t.key}":`, (keyErr as any)?.message || keyErr);
          writeFailedKeys.push(t.key);
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
      // error) PLUS regulated keys whose atomic audit write failed — reported
      // back instead of being silently lost.
      const failedKeys = [
        ...toTranslate.filter((t) => !aiResults[t.key]).map((t) => t.key),
        ...writeFailedKeys,
      ];

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
        if (refund > 0) await refundAiBudget(projectId as string, project.owner, refund, false, meterPeriod);
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

    const historySource = action === "approve" ? "approved" : "rejected";

    // Read-modify-write INSIDE one transaction: re-fetch with the session so a
    // concurrent review reads the actually-committed state, the source flip +
    // its audit row commit atomically, and a review (a provenance action) never
    // falls back to a non-transactional path that could leave an approved-but-
    // unaudited servable cell.
    let reviewResult: any = translation;
    await withTransactionOrFallback(
      async (session) => {
        const fresh = await Translation.findById(translation._id).session(session ?? null);
        if (!fresh) throw new Error("Translation vanished mid-review");
        const before = readValue(fresh.translations as any, lang, register) || "";
        if (action === "approve") {
          writeValue(fresh, "sources", lang, register, "approved");
        } else {
          // Reject: remove only this (lang, register) cell.
          const trMap = fresh.translations as any;
          const srMap = fresh.sources as any;
          if (trMap instanceof Map) {
            const inner = trMap.get(lang);
            if (inner instanceof Map) inner.delete(register);
          }
          if (srMap instanceof Map) {
            const inner = srMap.get(lang);
            if (inner instanceof Map) inner.delete(register);
          }
          fresh.markModified("translations");
          fresh.markModified("sources");
        }
        fresh.updatedAt = new Date();
        await fresh.save({ session });
        await recordHistory(
          fresh._id, fresh.projectId, lang, register, fresh.key,
          before, action === "approve" ? before : "", historySource, req.userId!, session, true
        );
        reviewResult = fresh;
      },
      { requireTransaction: true }
    );

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
      translation: reviewResult,
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
      // Voice shares the same model bill, so it reserves against all three
      // scopes (project → account → global) too.
      const reservation = await reserveAiBudget(
        projectId as string, project.owner, voiceCap, candidates.length, true, meterPeriod
      );
      if (!reservation.ok) {
        return sendError(res, 429, aiCapMessage(reservation.blockedScope, voiceCap));
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
        if (refund > 0) await refundAiBudget(projectId as string, project.owner, refund, true, meterPeriod);
      }
    } catch (e: any) {
      console.error("[BhashaJS] Voice generation error:", e?.message);
      return sendError(res, 500, e?.message || "Voice generation failed");
    }
  }
);

export default router;
