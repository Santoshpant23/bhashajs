/**
 * Glossary Routes
 *
 * GET    /api/projects/:projectId/glossary      — List glossary entries
 * POST   /api/projects/:projectId/glossary      — Add a glossary entry
 * PUT    /api/projects/:projectId/glossary/:id  — Update a glossary entry
 * DELETE /api/projects/:projectId/glossary/:id  — Delete a glossary entry
 *
 * All routes require authentication + project membership.
 * Owner can do everything. Translator can create/edit. Viewer can read.
 */

import { Router, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireProjectRole, ProjectAuthRequest } from "../middleware/projectAuth";
import GlossaryEntry from "../models/GlossaryEntry";
import { sendSuccess, sendError } from "../utils/response";
import { validateObjectId, validateRequired } from "../utils/validate";

const router = Router({ mergeParams: true });
router.use(authMiddleware);

// ─── LIST GLOSSARY ──────────────────────────────────────────
router.get(
  "/",
  requireProjectRole("owner", "translator", "viewer"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const entries = await GlossaryEntry.find({ projectId }).sort({ term: 1 });
      return sendSuccess(res, 200, entries);
    } catch (e) {
      return sendError(res, 500, "Failed to fetch glossary");
    }
  }
);

// ─── ADD GLOSSARY ENTRY ─────────────────────────────────────
router.post(
  "/",
  requireProjectRole("owner", "translator"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const { term, translations, notes } = req.body;

      const termError = validateRequired(term, "Term");
      if (termError) return sendError(res, 400, termError);

      const entry = await GlossaryEntry.create({
        projectId: projectId as string,
        term: term.trim(),
        translations: translations || {},
        notes: notes?.trim() || "",
      });

      return sendSuccess(res, 201, entry);
    } catch (e: any) {
      if (e.code === 11000) {
        return sendError(res, 400, "This term already exists in the glossary");
      }
      return sendError(res, 500, "Failed to add glossary entry");
    }
  }
);

// ─── UPDATE GLOSSARY ENTRY ──────────────────────────────────
router.put(
  "/:id",
  requireProjectRole("owner", "translator"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { term, translations, notes } = req.body;

      const idError = validateObjectId(id as string, "Glossary ID");
      if (idError) return sendError(res, 400, idError);

      const entry = await GlossaryEntry.findById(id);
      if (!entry) return sendError(res, 404, "Glossary entry not found");

      if (term !== undefined) entry.term = term.trim();
      if (translations !== undefined) {
        for (const [lang, val] of Object.entries(translations)) {
          entry.translations.set(lang, val as string);
        }
      }
      if (notes !== undefined) entry.notes = notes.trim();
      entry.updatedAt = new Date();

      await entry.save();
      return sendSuccess(res, 200, entry);
    } catch (e: any) {
      if (e.code === 11000) {
        return sendError(res, 400, "This term already exists in the glossary");
      }
      return sendError(res, 500, "Failed to update glossary entry");
    }
  }
);

// ─── DELETE GLOSSARY ENTRY ──────────────────────────────────
router.delete(
  "/:id",
  requireProjectRole("owner"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { id } = req.params;

      const idError = validateObjectId(id as string, "Glossary ID");
      if (idError) return sendError(res, 400, idError);

      const entry = await GlossaryEntry.findByIdAndDelete(id);
      if (!entry) return sendError(res, 404, "Glossary entry not found");

      return sendSuccess(res, 200, { message: "Glossary entry deleted" });
    } catch (e) {
      return sendError(res, 500, "Failed to delete glossary entry");
    }
  }
);

export default router;
