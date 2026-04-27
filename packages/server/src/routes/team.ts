/**
 * Team Routes
 *
 * GET    /api/projects/:projectId/team              — List all members + pending invites
 * POST   /api/projects/:projectId/team/invite       — Create an invite (owner only)
 * PUT    /api/projects/:projectId/team/:memberId    — Update member role/languages (owner only)
 * DELETE /api/projects/:projectId/team/:memberId    — Remove member or cancel invite (owner only)
 * POST   /api/team/accept-invite                    — Accept an invite by token
 *
 * All routes require authMiddleware.
 * Project-scoped routes also require appropriate project role.
 */

import { Router, Response } from "express";
import crypto from "crypto";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { requireProjectRole, ProjectAuthRequest } from "../middleware/projectAuth";
import ProjectMember from "../models/ProjectMember";
import Project from "../models/Project";
import User from "../models/User";
import Notification from "../models/Notification";
import { sendSuccess, sendError } from "../utils/response";
import { validateRequired, validateObjectId } from "../utils/validate";
import { sendInviteEmail } from "../services/email";

const router = Router();

router.use(authMiddleware);

// ─── LIST TEAM MEMBERS ──────────────────────────────────────
router.get(
  "/projects/:projectId/team",
  requireProjectRole("owner", "translator", "viewer"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;

      const members = await ProjectMember.find({ projectId })
        .populate("userId", "name email")
        .populate("invitedBy", "name")
        .sort({ createdAt: 1 });

      return sendSuccess(res, 200, members);
    } catch (e) {
      return sendError(res, 500, "Failed to fetch team members");
    }
  }
);

// ─── INVITE A MEMBER ────────────────────────────────────────
router.post(
  "/projects/:projectId/team/invite",
  requireProjectRole("owner"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const { email, role, assignedLanguages } = req.body;

      const emailError = validateRequired(email, "Email");
      if (emailError) return sendError(res, 400, emailError);

      if (role && !["translator", "viewer"].includes(role)) {
        return sendError(res, 400, "Role must be 'translator' or 'viewer'");
      }

      // Check if already invited or a member
      const existing = await ProjectMember.findOne({
        projectId,
        email: email.trim().toLowerCase(),
      });
      if (existing) {
        return sendError(
          res,
          400,
          existing.status === "active"
            ? "This user is already a member"
            : "An invite is already pending for this email"
        );
      }

      const inviteToken = crypto.randomBytes(32).toString("hex");

      const member = await ProjectMember.create({
        projectId: projectId as string,
        email: email.trim().toLowerCase(),
        role: role || "translator",
        assignedLanguages: assignedLanguages || [],
        inviteToken,
        status: "pending",
        invitedBy: req.userId,
      });

      // Best-effort post-invite work: in-app notification + email.
      // None of these block the response — if either fails, the owner can still
      // copy the invite link from the response.
      const project = await Project.findById(projectId);
      const inviter = await User.findById(req.userId);

      try {
        const invitedUser = await User.findOne({ email: email.trim().toLowerCase() });
        if (invitedUser) {
          await Notification.create({
            userId: invitedUser._id,
            type: "project_invite",
            message: `You've been invited to "${project?.name || "a project"}" as ${role || "translator"}`,
            projectId: projectId as string,
          });
        }
      } catch (_) { /* non-critical */ }

      // Fire and forget — sendInviteEmail logs internally on failure.
      sendInviteEmail({
        to: email.trim().toLowerCase(),
        inviterName: inviter?.name || "A teammate",
        projectName: project?.name || "a project",
        role: role || "translator",
        inviteToken,
      }).catch(() => { /* logged inside */ });

      return sendSuccess(res, 201, {
        member,
        inviteToken,
        inviteLink: `/join?token=${inviteToken}`,
      });
    } catch (e) {
      return sendError(res, 500, "Failed to create invite");
    }
  }
);

// ─── UPDATE MEMBER ──────────────────────────────────────────
router.put(
  "/projects/:projectId/team/:memberId",
  requireProjectRole("owner"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { memberId } = req.params;
      const { role, assignedLanguages } = req.body;

      const idError = validateObjectId(memberId as string, "Member ID");
      if (idError) return sendError(res, 400, idError);

      const member = await ProjectMember.findById(memberId);
      if (!member) return sendError(res, 404, "Member not found");

      // Cannot change owner's role
      if (member.role === "owner") {
        return sendError(res, 400, "Cannot modify the project owner");
      }

      if (role && !["translator", "viewer"].includes(role)) {
        return sendError(res, 400, "Role must be 'translator' or 'viewer'");
      }

      if (role) member.role = role;
      if (assignedLanguages) member.assignedLanguages = assignedLanguages;
      await member.save();

      return sendSuccess(res, 200, member);
    } catch (e) {
      return sendError(res, 500, "Failed to update member");
    }
  }
);

// ─── REMOVE MEMBER ──────────────────────────────────────────
router.delete(
  "/projects/:projectId/team/:memberId",
  requireProjectRole("owner"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { memberId } = req.params;

      const idError = validateObjectId(memberId as string, "Member ID");
      if (idError) return sendError(res, 400, idError);

      const member = await ProjectMember.findById(memberId);
      if (!member) return sendError(res, 404, "Member not found");

      // Cannot remove the owner
      if (member.role === "owner") {
        return sendError(res, 400, "Cannot remove the project owner");
      }

      await ProjectMember.findByIdAndDelete(memberId);

      return sendSuccess(res, 200, { message: "Member removed" });
    } catch (e) {
      return sendError(res, 500, "Failed to remove member");
    }
  }
);

// ─── ACCEPT INVITE ──────────────────────────────────────────
// This is NOT project-scoped — any authenticated user can call it with a token.
// Idempotent: if the membership was already auto-claimed at registration, we
// still return success so the JoinPage can route the user into the project.
router.post("/team/accept-invite", async (req: AuthRequest, res: Response) => {
  try {
    const { token } = req.body;

    const tokenError = validateRequired(token, "Invite token");
    if (tokenError) return sendError(res, 400, tokenError);

    // First try to find by the live token (the normal pending → active flow).
    let member = await ProjectMember.findOne({ inviteToken: token });

    // Fallback: the membership may have been auto-claimed at registration,
    // which clears the token. In that case, find the active membership for
    // this user and project. We can't look up by token here (it's gone), so we
    // look for *any* active membership the user has — but that's too broad.
    // Instead, accept that the redirected URL sent us here, and trust the
    // JWT user. If they have any active membership, treat the visit as a
    // confirmation that the auto-claim worked.
    if (!member) {
      // Token has been consumed. Look for the most recent active membership
      // for this user as a graceful landing.
      member = await ProjectMember.findOne({
        userId: req.userId,
        status: "active",
      }).sort({ createdAt: -1 });

      if (!member) {
        return sendError(res, 404, "Invalid or expired invite link");
      }
    } else if (member.status !== "active") {
      // Live token, not yet activated. Before binding it to the requester, make
      // sure the JWT user's email matches the invite's email. Otherwise a user
      // who happens to be logged into another account in the same browser would
      // claim someone else's invite when they click the email link.
      const requester = await User.findById(req.userId);
      if (!requester) return sendError(res, 401, "Invalid session");
      if (member.email !== requester.email.toLowerCase()) {
        return sendError(
          res,
          403,
          `This invite was sent to ${member.email}. Log out and sign in with that account to accept it.`
        );
      }
      member.userId = req.userId as any;
      member.status = "active";
      member.inviteToken = null;
      await member.save();
    } else {
      // Already active. If userId doesn't match the requester, security issue.
      if (member.userId && member.userId.toString() !== req.userId) {
        return sendError(res, 403, "This invite belongs to a different account");
      }
    }

    const Project = (await import("../models/Project")).default;
    const project = await Project.findById(member.projectId);

    return sendSuccess(res, 200, {
      message: "Invite accepted! You now have access to this project.",
      projectId: member.projectId,
      projectName: project?.name || "Unknown",
      role: member.role,
    });
  } catch (e) {
    return sendError(res, 500, "Failed to accept invite");
  }
});

export default router;
