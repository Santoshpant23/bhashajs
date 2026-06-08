/**
 * Project Routes
 *
 * GET    /api/projects          — List all projects the user is a member of
 * POST   /api/projects          — Create a new project (auto-creates owner membership)
 * GET    /api/projects/:id      — Get one project (any role)
 * PUT    /api/projects/:id      — Update project settings (owner only)
 * DELETE /api/projects/:id      — Delete project and all related data (owner only)
 *
 * All routes are protected by authMiddleware.
 * GET/PUT/DELETE /:id also use requireProjectRole for authorization.
 * All responses follow { success, data/message } format.
 */

import { Router, Response } from "express";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { requireProjectRole, ProjectAuthRequest } from "../middleware/projectAuth";
import crypto from "crypto";
import Project from "../models/Project";
import ProjectMember from "../models/ProjectMember";
import Translation from "../models/Translation";
import TranslationMemory from "../models/TranslationMemory";
import TranslationHistory from "../models/TranslationHistory";
import Comment from "../models/Comment";
import GlossaryEntry from "../models/GlossaryEntry";
import Notification from "../models/Notification";
import ApiKey from "../models/ApiKey";
import AiUsage from "../models/AiUsage";
import User from "../models/User";
import { sendSuccess, sendError } from "../utils/response";
import { withTransactionOrFallback } from "../utils/transaction";
import { getUsage, currentPeriod } from "../utils/usage";
import {
  validateRequired,
  validateObjectId,
  validateArrayNotEmpty,
} from "../utils/validate";

const router = Router();

// All routes below require authentication
router.use(authMiddleware);

// ─── LIST ALL PROJECTS ───────────────────────────────────────
// Returns projects the user is a member of (any role), with their role
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const memberships = await ProjectMember.find({
      userId: req.userId,
      status: "active",
    });

    const projectIds = memberships.map((m) => m.projectId);
    const projects = await Project.find({ _id: { $in: projectIds } }).sort({
      createdAt: -1,
    });

    // Merge role info so the dashboard knows what to show.
    // Strip apiKey for non-owners — translators/viewers should never see the
    // project's secret SDK key, even though the UI already hides it.
    const memberMap = new Map(
      memberships.map((m) => [m.projectId.toString(), m])
    );
    const enriched = projects.map((p) => {
      const obj: any = p.toObject();
      const m = memberMap.get(p._id.toString());
      if (m?.role !== "owner") delete obj.apiKey;
      obj.myRole = m?.role;
      // Owner-only languages aren't a thing — owners implicitly get all.
      // For translators/viewers we surface the explicit assignment list so
      // the dashboard can disable cells they can't edit (UI-side mirror of
      // the server's per-language gate).
      obj.myAssignedLanguages = m?.assignedLanguages || [];
      return obj;
    });

    return sendSuccess(res, 200, enriched);
  } catch (e) {
    return sendError(res, 500, "Failed to fetch projects");
  }
});

// ─── CREATE PROJECT ──────────────────────────────────────────
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const { name, defaultLanguage, supportedLanguages } = req.body;

    // Validate inputs
    const nameError = validateRequired(name, "Project name");
    if (nameError) return sendError(res, 400, nameError);

    const langsError = validateArrayNotEmpty(
      supportedLanguages,
      "Supported languages"
    );
    if (langsError) return sendError(res, 400, langsError);

    // Make sure English is always included
    const langs = Array.from(new Set(["en", ...supportedLanguages]));

    // Cap projects per account so one user can't spam thousands of projects
    // (each otherwise carries its own AI allowance). Env-tunable; 0 disables.
    //
    // The quota reservation (conditional `$inc` on projectCount while it's `< cap`
    // — atomic, so N concurrent requests can't all pass), the Project, and the
    // owner ProjectMember ALL commit in ONE transaction. So a membership failure
    // rolls back BOTH the project AND the counter increment — no orphan project,
    // no counter drift (the round-10 audit bug: a failed membership refunded the
    // counter but left the project, undercounting).
    const maxProjects = parseInt(process.env.MAX_PROJECTS_PER_USER || "50", 10);
    const quotaEnabled = Number.isFinite(maxProjects) && maxProjects > 0;
    let project: any;
    try {
      await withTransactionOrFallback(async (session) => {
        if (quotaEnabled) {
          const reserved = await User.findOneAndUpdate(
            { _id: req.userId, projectCount: { $lt: maxProjects } },
            { $inc: { projectCount: 1 } },
            { new: true, session }
          );
          if (!reserved) {
            const e: any = new Error("PROJECT_LIMIT");
            e.projectLimit = true;
            throw e; // aborts the txn (no project, no counter bump) → 403 below
          }
        }
        const [created] = await Project.create(
          [{ name: name.trim(), owner: req.userId, defaultLanguage: defaultLanguage || "en", supportedLanguages: langs }],
          { session }
        );
        project = created;
        const user = await User.findById(req.userId).session(session ?? null);
        await ProjectMember.create(
          [{ projectId: created._id, userId: req.userId, email: user?.email || "", role: "owner", status: "active" }],
          { session }
        );
      });
    } catch (txErr: any) {
      if (txErr?.projectLimit) {
        return sendError(
          res,
          403,
          `Project limit reached (${maxProjects} per account). Delete an unused project, or self-host for unlimited.`
        );
      }
      throw txErr; // real failure → outer catch → 500
    }

    return sendSuccess(res, 201, project);
  } catch (e) {
    return sendError(res, 500, "Failed to create project");
  }
});

// ─── GET ONE PROJECT ─────────────────────────────────────────
router.get(
  "/:id",
  requireProjectRole("owner", "translator", "viewer"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { id } = req.params;

      const idError = validateObjectId(id as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      const project = await Project.findById(id);
      if (!project) return sendError(res, 404, "Project not found");

      const obj: any = project.toObject();
      if (req.membership?.role !== "owner") delete obj.apiKey;
      obj.myRole = req.membership?.role;
      obj.myAssignedLanguages = req.membership?.assignedLanguages || [];
      return sendSuccess(res, 200, obj);
    } catch (e) {
      return sendError(res, 500, "Failed to fetch project");
    }
  }
);

// ─── GET AI USAGE FOR THE CURRENT PERIOD ─────────────────────
// Any member can read this — it's how the dashboard shows "AI usage this
// month: X / cap". Returns the live counters for the current "YYYY-MM" bucket
// plus the project's monthly cap so the UI can render a progress bar.
router.get(
  "/:projectId/usage",
  requireProjectRole("owner", "translator", "viewer"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;

      const idError = validateObjectId(projectId as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      const project = await Project.findById(projectId);
      if (!project) return sendError(res, 404, "Project not found");

      const usage = await getUsage(projectId as string);
      const cap = (project as any).aiMonthlyCap as number;

      return sendSuccess(res, 200, {
        period: currentPeriod(),
        cap,
        keysTranslated: usage.keysTranslated,
        voiceCalls: usage.voiceCalls,
        aiCalls: usage.aiCalls,
        // Convenience for the UI — clamped 0..100.
        percentUsed:
          cap > 0 ? Math.min(100, Math.round((usage.keysTranslated / cap) * 100)) : 0,
      });
    } catch (e) {
      return sendError(res, 500, "Failed to fetch AI usage");
    }
  }
);

// ─── UPDATE PROJECT SETTINGS ─────────────────────────────────
router.put(
  "/:id",
  requireProjectRole("owner"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { name, defaultLanguage, supportedLanguages, vertical } = req.body;

      const idError = validateObjectId(id as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      const updateFields: any = {};

      if (name !== undefined) {
        const nameError = validateRequired(name, "Project name");
        if (nameError) return sendError(res, 400, nameError);
        updateFields.name = name.trim();
      }

      if (supportedLanguages !== undefined) {
        const langsError = validateArrayNotEmpty(
          supportedLanguages,
          "Supported languages"
        );
        if (langsError) return sendError(res, 400, langsError);
        updateFields.supportedLanguages = Array.from(
          new Set(["en", ...supportedLanguages])
        );
      }

      if (defaultLanguage !== undefined) {
        updateFields.defaultLanguage = defaultLanguage;
      }

      // `vertical` is optional and free-form. Empty string or null clears it.
      if (vertical !== undefined) {
        updateFields.vertical =
          typeof vertical === "string" && vertical.trim() ? vertical.trim() : null;
      }

      const project = await Project.findByIdAndUpdate(id, updateFields, {
        new: true,
      });

      if (!project) return sendError(res, 404, "Project not found");

      return sendSuccess(res, 200, project);
    } catch (e) {
      return sendError(res, 500, "Failed to update project");
    }
  }
);

// ─── REGENERATE API KEY ──────────────────────────────────────
router.post(
  "/:id/regenerate-key",
  requireProjectRole("owner"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { id } = req.params;

      const idError = validateObjectId(id as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      const newKey = `bjs_${crypto.randomBytes(24).toString("hex")}`;
      const project = await Project.findByIdAndUpdate(
        id,
        { apiKey: newKey },
        { new: true }
      );

      if (!project) return sendError(res, 404, "Project not found");

      return sendSuccess(res, 200, { apiKey: project.apiKey });
    } catch (e) {
      return sendError(res, 500, "Failed to regenerate API key");
    }
  }
);

// ─── DELETE PROJECT ──────────────────────────────────────────
router.delete(
  "/:id",
  requireProjectRole("owner"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { id } = req.params;

      const idError = validateObjectId(id as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      const project = await Project.findById(id);
      if (!project) return sendError(res, 404, "Project not found");

      // Capture the owner BEFORE the delete — we need it to release the owner's
      // atomic project-quota slot once the project is gone. (Sandbox projects
      // are ownerless; the guarded decrement below simply no-ops for them.)
      const ownerId = (project as any).owner;

      // Cascade-delete ALL related data atomically (or, on a standalone Mongo,
      // dependents-before-parent). The previous version deleted the project
      // FIRST and missed Comment/GlossaryEntry/Notification, orphaning them.
      await withTransactionOrFallback(async (session) => {
        await Translation.deleteMany({ projectId: id }, { session });
        await TranslationMemory.deleteMany({ projectId: id }, { session });
        await TranslationHistory.deleteMany({ projectId: id }, { session });
        await Comment.deleteMany({ projectId: id }, { session });
        await GlossaryEntry.deleteMany({ projectId: id }, { session });
        await Notification.deleteMany({ projectId: id }, { session });
        await ProjectMember.deleteMany({ projectId: id }, { session });
        // The scoped API keys and the AI-usage meters for this project are
        // dependents too — without these they'd orphan forever (no TTL).
        await ApiKey.deleteMany({ projectId: id }, { session });
        await AiUsage.deleteMany({ projectId: id }, { session });
        await Project.deleteOne({ _id: id }, { session });
      });

      // Release the owner's reserved quota slot now that the project is gone.
      // Guarded against going below 0 (a floored counter is harmless, but this
      // keeps it tidy if a slot was already reconciled by a backfill). Done
      // AFTER the cascade succeeds; ownerless sandbox projects skip it.
      if (ownerId) {
        await User.updateOne(
          { _id: ownerId, projectCount: { $gt: 0 } },
          { $inc: { projectCount: -1 } }
        );
      }

      return sendSuccess(res, 200, {
        message: "Project and all related data deleted",
      });
    } catch (e) {
      return sendError(res, 500, "Failed to delete project");
    }
  }
);

export default router;
