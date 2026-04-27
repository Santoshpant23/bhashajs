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
import User from "../models/User";
import { sendSuccess, sendError } from "../utils/response";
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
    const roleMap = new Map(
      memberships.map((m) => [m.projectId.toString(), m.role])
    );
    const enriched = projects.map((p) => {
      const obj: any = p.toObject();
      const role = roleMap.get(p._id.toString());
      if (role !== "owner") delete obj.apiKey;
      obj.myRole = role;
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

    const project = await Project.create({
      name: name.trim(),
      owner: req.userId,
      defaultLanguage: defaultLanguage || "en",
      supportedLanguages: langs,
    });

    // Auto-create owner membership
    const user = await User.findById(req.userId);
    await ProjectMember.create({
      projectId: project._id,
      userId: req.userId,
      email: user?.email || "",
      role: "owner",
      status: "active",
    });

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
      return sendSuccess(res, 200, obj);
    } catch (e) {
      return sendError(res, 500, "Failed to fetch project");
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
      const { name, defaultLanguage, supportedLanguages } = req.body;

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

      const project = await Project.findByIdAndDelete(id);
      if (!project) return sendError(res, 404, "Project not found");

      // Cascade delete all related data
      await Promise.all([
        Translation.deleteMany({ projectId: id }),
        TranslationMemory.deleteMany({ projectId: id }),
        TranslationHistory.deleteMany({ projectId: id }),
        ProjectMember.deleteMany({ projectId: id }),
      ]);

      return sendSuccess(res, 200, {
        message: "Project and all related data deleted",
      });
    } catch (e) {
      return sendError(res, 500, "Failed to delete project");
    }
  }
);

export default router;
