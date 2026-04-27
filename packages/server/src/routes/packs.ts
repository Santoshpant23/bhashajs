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
import { sendSuccess, sendError } from "../utils/response";
import { validateRequired } from "../utils/validate";
import { coerceRegister, readValue, writeValue } from "../utils/registers";
import { isValidRegister } from "../models/Translation";

const router = Router();
router.use(authMiddleware);

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
      const skippedLangs = new Set<string>();

      for (const item of pack.items as any[]) {
        const itemTranslations = item.translations as Map<string, Map<string, string>> | Record<string, Record<string, string>>;
        const langEntries =
          itemTranslations instanceof Map
            ? Array.from(itemTranslations.entries())
            : Object.entries(itemTranslations);

        const projectObjectId = new mongoose.Types.ObjectId(projectId as string);
        let existing = await Translation.findOne({ projectId: projectObjectId, key: item.key });
        const isNew = !existing;
        if (!existing) {
          existing = await Translation.create({
            projectId: projectObjectId,
            key: item.key,
            translations: {},
            sources: {},
            context: item.context || undefined,
            source: "human",
          });
        } else if (item.context && !existing.context) {
          // Backfill context if the existing translation didn't have one
          existing.context = item.context;
        }

        let touched = false;

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
            writeValue(existing, "translations", lang, coerceRegister(register), value);
            // Mark provenance as "approved" — these are pre-vetted by the pack
            // author, not raw AI output.
            writeValue(existing, "sources", lang, coerceRegister(register), "approved");
            touched = true;
          }
        }

        if (touched) {
          existing.updatedAt = new Date();
          await existing.save();
          if (isNew) created++; else updated++;
        }
      }

      return sendSuccess(res, 200, {
        message: `Imported "${pack.name}" — ${created} new keys, ${updated} keys updated`,
        created,
        updated,
        skippedExisting,
        skippedLangs: Array.from(skippedLangs),
      });
    } catch (e: any) {
      console.error("[BhashaJS] Pack import failed:", e?.message);
      return sendError(res, 500, "Failed to import pack");
    }
  }
);

export default router;
