/**
 * Vertical Pack Routes
 *
 * GET    /api/packs                                  — List available packs
 * GET    /api/packs/:code                            — Get one pack with full items
 * POST   /api/projects/:projectId/import-pack        — Import a pack into a project
 *
 * All routes require authentication.
 * Import is owner-only.
 */

import { Router, Response } from "express";
import mongoose from "mongoose";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { requireProjectRole, ProjectAuthRequest } from "../middleware/projectAuth";
import VerticalPack from "../models/VerticalPack";
import Project from "../models/Project";
import Translation from "../models/Translation";
import TranslationHistory from "../models/TranslationHistory";
import { sendSuccess, sendError } from "../utils/response";
import { validateRequired } from "../utils/validate";
import { coerceRegister, readValue, writeValue, deleteVoiceCell, Register } from "../utils/registers";
import { isValidRegister } from "../models/Translation";
import { withTransactionOrFallback } from "../utils/transaction";

const router = Router();
router.use(authMiddleware);

// ─── Helper: record a history entry ─────────────────────────
// A local twin of routes/translations.ts:recordHistory so a pack import stamps
// the SAME immutable audit rows every other write path does. Kept self-contained
// (translations.ts does not export its copy) and deliberately identical in its
// failure contract:
//   - Inside a transaction (session present): a failed insert propagates so the
//     value write rolls back with it — no value-without-audit and no phantom row.
//   - On a REGULATED key WITHOUT a session (standalone-fallback self-host): still
//     propagate, so the request FAILS LOUDLY rather than leaving a regulated pack
//     cell live with no audit trail (the compliance "guaranteed audit trail").
//   - Non-regulated, session-less: best-effort — a history hiccup never fails the
//     import.
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
  // Pack imports only ever write a real new value into a cell (never a no-op
  // approval event), so the simple no-op guard is enough.
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
        source,
        changedBy,
      }],
      { session }
    );
  } catch (e) {
    console.error("[BhashaJS] Failed to record pack-import history:", e);
    if (session || isRegulated) throw e;
  }
}

// ─── LIST PACKS ─────────────────────────────────────────────
// Browseable catalog. Returns metadata only — items are fetched on demand
// to keep this endpoint cheap.
router.get("/packs", async (req: AuthRequest, res: Response) => {
  try {
    const { vertical } = req.query;
    const filter: any = {};
    if (vertical && typeof vertical === "string") filter.vertical = vertical;

    const packs = await VerticalPack.find(filter, {
      // Project the metadata fields only — skip `items` for the list view.
      items: 0,
    }).sort({ vertical: 1, name: 1 });

    return sendSuccess(res, 200, packs);
  } catch (e) {
    return sendError(res, 500, "Failed to fetch packs");
  }
});

// ─── GET ONE PACK (full content) ────────────────────────────
router.get("/packs/:code", async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.params;
    const pack = await VerticalPack.findOne({ code });
    if (!pack) return sendError(res, 404, "Pack not found");
    return sendSuccess(res, 200, pack);
  } catch (e) {
    return sendError(res, 500, "Failed to fetch pack");
  }
});

// ─── IMPORT PACK INTO PROJECT ───────────────────────────────
//
// Non-destructive by default: only fills in (lang, register) cells that are
// currently empty. Pass { overwrite: true } in the body to force-replace
// existing translations.
router.post(
  "/projects/:projectId/import-pack",
  requireProjectRole("owner"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const { code, overwrite } = req.body;

      const codeError = validateRequired(code, "Pack code");
      if (codeError) return sendError(res, 400, codeError);

      const pack = await VerticalPack.findOne({ code });
      if (!pack) return sendError(res, 404, "Pack not found");

      const project = await Project.findById(projectId);
      if (!project) return sendError(res, 404, "Project not found");

      // Skip pack langs the project doesn't support — the user has to add
      // them via project settings first. Surface this as a per-lang count in
      // the response so the UI can flag it.
      const supportedSet = new Set(project.supportedLanguages);

      let created = 0;
      let updated = 0;
      let skippedExisting = 0;
      // A REGULATED item whose value persisted but whose audit row could not be
      // written is NOT silently imported: its transaction rolls back (or, on a
      // standalone self-host with no transaction, recordHistory propagates) and
      // we count it here as a failed item and CONTINUE — one bad item must not
      // abort an otherwise-good multi-item import. The count is surfaced in the
      // response so the caller can see (and retry) the shortfall.
      let failed = 0;
      const skippedLangs = new Set<string>();

      for (const item of pack.items as any[]) {
        const itemTranslations = item.translations as Map<string, Map<string, string>> | Record<string, Record<string, string>>;
        const langEntries =
          itemTranslations instanceof Map
            ? Array.from(itemTranslations.entries())
            : Object.entries(itemTranslations);

        const projectObjectId = new mongoose.Types.ObjectId(projectId as string);
        let existing = await Translation.findOne({ projectId: projectObjectId, key: item.key });
        let isNew = !existing;
        const itemMandate = typeof item.mandatedBy === "string" ? item.mandatedBy.trim() : "";
        // Scalar-field INTENTS from the pack, re-applied to the freshly re-fetched
        // doc INSIDE the transaction (the in-memory mutation here is for the
        // overwrite/skip + cellSource decisions only; the txn re-fetch is what
        // actually persists). `promoteRegulated` is append-only — never demotes.
        const promoteRegulated = !!itemMandate;
        const contextIntent = item.context ? String(item.context) : "";
        if (!existing) {
          try {
            existing = await Translation.create({
              projectId: projectObjectId,
              key: item.key,
              translations: {},
              sources: {},
              context: item.context || undefined,
              source: "human",
              // Pack items with a regulator citation lock the key automatically.
              // Owners can untick this in the dashboard if they really mean to.
              regulated: !!itemMandate,
              mandatedBy: itemMandate,
            });
          } catch (e: any) {
            if (e?.code !== 11000) throw e;
            existing = await Translation.findOne({ projectId: projectObjectId, key: item.key });
            if (!existing) throw e;
            isNew = false;
          }
        }
        if (!isNew) {
          if (item.context && !existing.context) {
            existing.context = item.context;
          }
          // Promote to regulated if the pack says so. Never silently demote —
          // an owner who marked a key regulated shouldn't lose that on re-import.
          if (itemMandate) {
            existing.regulated = true;
            if (!existing.mandatedBy) existing.mandatedBy = itemMandate;
          }
        }

        // Plan the cell writes WITHOUT mutating the doc yet. We apply them
        // inside the transaction callback below so a transient transaction retry
        // re-persists them: connection.transaction() RESETS the document's
        // modified state between retries, so a write applied before the callback
        // would be lost on the second attempt (and recordHistory would still log
        // it → a phantom audit row).
        //
        // The `oldValue` captured HERE is provisional — used only for the
        // overwrite/skip decision below. The AUTHORITATIVE oldValue is re-read
        // from the freshly-fetched doc INSIDE the transaction (see B2 below), so a
        // concurrent regulated overwrite chains off the truly-committed predecessor
        // rather than this pre-transaction snapshot.
        const cellWrites: {
          lang: string;
          register: Register;
          oldValue: string;
          newValue: string;
          cellSource: string;
        }[] = [];

        for (const [lang, registerMap] of langEntries) {
          if (!supportedSet.has(lang)) {
            skippedLangs.add(lang);
            continue;
          }
          const innerEntries =
            registerMap instanceof Map
              ? Array.from(registerMap.entries())
              : Object.entries(registerMap as Record<string, string>);
          for (const [register, value] of innerEntries) {
            if (typeof value !== "string") continue;
            if (!isValidRegister(register)) continue;

            const current = readValue(existing.translations as any, lang, register);
            if (current && current.trim() && !overwrite) {
              skippedExisting++;
              continue;
            }
            // Non-regulated pack strings are pre-vetted by the pack author →
            // "approved". But a REGULATED key legally requires the project's own
            // compliance review: stamp it "pending" so the owner must approve it
            // in-app before the SDK will serve it (the pack author is not the
            // project's compliance authority).
            const cellSource = existing.regulated ? "pending" : "approved";
            cellWrites.push({
              lang,
              register: coerceRegister(register),
              oldValue: (current as string) || "",
              newValue: value,
              cellSource,
            });
          }
        }

        if (cellWrites.length === 0) continue;

        const isRegulated = existing.regulated === true;
        const targetId = existing._id; // re-fetched fresh inside the txn below
        // The save and EVERY history row for this item commit (or roll back)
        // together. For a regulated item, a history failure either rolls back the
        // transaction (replica set) or — on a standalone self-host with no
        // transaction — propagates out of recordHistory (isRegulated=true), so we
        // never end up with a live regulated cell that has no audit trail.
        //
        // (B2) STALE-CHAIN FIX: we RE-FETCH the translation WITH the session
        // inside the callback and read each cell's oldValue from that FRESH doc —
        // never from the copy read before the transaction. connection.transaction()
        // retries the callback on a WriteConflict, and each retry re-reads the
        // actually-committed state, so two concurrent regulated overwrites form a
        // real chain (v0→A then A→B) instead of both chaining off the same stale v0.
        // Mirrors the re-fetch-inside-txn pattern in routes/translations.ts
        // (PUT/bulk/ai-translate/review). The cell writes live INSIDE the callback
        // so a retry re-applies them after connection.transaction() resets the doc.
        //
        // (B3) STANDALONE SAFETY: regulated items pass { requireTransaction: true }
        // so on a true standalone Mongo (no transactions) the write FAILS rather
        // than falling back and persisting a regulated pack cell with NO history.
        try {
          await withTransactionOrFallback(
            async (session) => {
              const fresh = await Translation.findById(targetId).session(session ?? null);
              if (!fresh) throw new Error("translation vanished mid-pack-import");
              // Re-apply the pack's scalar-field intents to the FRESH doc (the
              // pre-txn copy's in-memory mutations don't survive the re-fetch).
              // Append-only: promote to regulated, fill context/mandatedBy only if
              // empty — never demote or overwrite an owner's existing value.
              if (contextIntent && !fresh.context) fresh.context = contextIntent;
              if (promoteRegulated) {
                (fresh as any).regulated = true;
                if (!(fresh as any).mandatedBy) (fresh as any).mandatedBy = itemMandate;
              }
              const freshRegulated = (fresh as any).regulated === true;
              if (freshRegulated && !session) {
                throw new Error("Cannot import a regulated pack item without transaction support");
              }
              for (const w of cellWrites) {
                // oldValue from the FRESH (committed) doc — the real predecessor,
                // so a concurrent overwrite chains off the right value.
                const freshOld = (readValue(fresh.translations as any, w.lang, w.register) as string) || "";
                w.cellSource = freshRegulated ? "pending" : "approved";
                // Voice was generated from the OLD text — invalidate on change.
                if (freshOld !== w.newValue) deleteVoiceCell(fresh, w.lang, w.register);
                writeValue(fresh, "translations", w.lang, w.register, w.newValue);
                writeValue(fresh, "sources", w.lang, w.register, w.cellSource);
                w.oldValue = freshOld;
              }
              fresh.updatedAt = new Date();
              await fresh.save({ session });
              // children-before-parent ordering is moot here (save then history),
              // but the session couples them — both land or neither does.
              for (const w of cellWrites) {
                await recordHistory(
                  fresh._id,
                  fresh.projectId,
                  w.lang,
                  w.register,
                  fresh.key,
                  w.oldValue,
                  w.newValue,
                  "human",
                  req.userId!,
                  session,
                  freshRegulated
                );
              }
            },
            // Regulated items must never fall back to a session-less write that
            // could persist the cell without its atomic audit row.
            isRegulated ? { requireTransaction: true } : {}
          );
          if (isNew) created++; else updated++;
        } catch (itemErr: any) {
          // One item's atomic failure (a regulated item whose audit write could
          // not commit) must NOT abort the whole import. Count it and move on;
          // its value did not persist (RS rollback) or its request half-failed
          // loudly (standalone) — either way it's not a silent unaudited cell.
          console.error(
            `[BhashaJS] Pack import: failed to persist item "${item.key}" atomically:`,
            itemErr?.message
          );
          failed++;
          // A brand-new doc was created above before any cell write; if its only
          // write attempt failed, leave it empty (no cells, no history) — it is
          // an inert placeholder, never a populated-but-unaudited regulated key.
        }
      }

      return sendSuccess(res, 200, {
        message:
          `Imported "${pack.name}" — ${created} new keys, ${updated} keys updated` +
          (failed ? `, ${failed} failed` : ""),
        created,
        updated,
        skippedExisting,
        failed,
        skippedLangs: Array.from(skippedLangs),
      });
    } catch (e: any) {
      console.error("[BhashaJS] Pack import failed:", e?.message);
      return sendError(res, 500, "Failed to import pack");
    }
  }
);

export default router;
