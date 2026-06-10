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
import { validateRequired, validateObjectId, validateEmail } from "../utils/validate";
import { sendInviteEmail } from "../services/email";

const router = Router();

router.use(authMiddleware);

function validateAssignedLanguagesInput(input: unknown): string | null {
  if (input === undefined) return null;
  if (!Array.isArray(input)) return "Assigned languages must be an array";
  if (input.length > 50) return "Assigned languages cannot exceed 50 entries";
  const langRegex = /^[A-Za-z0-9-]{1,20}$/;
  for (const lang of input) {
    if (typeof lang !== "string" || !langRegex.test(lang)) {
      return "Assigned languages must contain valid language codes";
    }
  }
  return null;
}

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
      if (typeof email !== "string") return sendError(res, 400, "Invalid email format");
      const emailFormatError = validateEmail(email);
      if (emailFormatError) return sendError(res, 400, emailFormatError);
      const assignedError = validateAssignedLanguagesInput(assignedLanguages);
      if (assignedError) return sendError(res, 400, assignedError);

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
      // Invites expire so a leaked/old link can't be claimed forever.
      const INVITE_TTL_DAYS = 7;
      const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

      const member = await ProjectMember.create({
        projectId: projectId as string,
        email: email.trim().toLowerCase(),
        role: role || "translator",
        assignedLanguages: assignedLanguages || [],
        inviteToken,
        inviteExpiresAt,
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
      const { projectId, memberId } = req.params;
      const { role, assignedLanguages } = req.body;

      const idError = validateObjectId(memberId as string, "Member ID");
      if (idError) return sendError(res, 400, idError);

      // Scope by both _id AND projectId so an owner of project A can't mutate
      // a member of project B even if they discover the member's _id.
      const member = await ProjectMember.findOne({ _id: memberId, projectId });
      if (!member) return sendError(res, 404, "Member not found");

      // Cannot change owner's role
      if (member.role === "owner") {
        return sendError(res, 400, "Cannot modify the project owner");
      }

      if (role && !["translator", "viewer"].includes(role)) {
        return sendError(res, 400, "Role must be 'translator' or 'viewer'");
      }
      const assignedError = validateAssignedLanguagesInput(assignedLanguages);
      if (assignedError) return sendError(res, 400, assignedError);

      if (role) member.role = role;
      if (assignedLanguages !== undefined) member.assignedLanguages = assignedLanguages;
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
      const { projectId, memberId } = req.params;

      const idError = validateObjectId(memberId as string, "Member ID");
      if (idError) return sendError(res, 400, idError);

      // Same projectId scoping as the PUT route — prevents cross-tenant deletes.
      const member = await ProjectMember.findOne({ _id: memberId, projectId });
      if (!member) return sendError(res, 404, "Member not found");

      // Cannot remove the owner
      if (member.role === "owner") {
        return sendError(res, 400, "Cannot remove the project owner");
      }

      await member.deleteOne();

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

    // The token is the durable invite ID — we keep it on the membership even
    // after activation so this lookup works idempotently for re-clicks.
    const member = await ProjectMember.findOne({ inviteToken: token });
    if (!member) {
      return sendError(res, 404, "Invalid or expired invite link");
    }

    if (member.status !== "active") {
      // Reject an expired pending invite — a leaked or stale link must not be
      // claimable forever. (Null inviteExpiresAt = legacy invite, never expires.)
      if (member.inviteExpiresAt && member.inviteExpiresAt.getTime() < Date.now()) {
        return sendError(
          res,
          410,
          "This invite has expired. Ask the project owner to send you a new one."
        );
      }
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
      // inviteToken stays — see auth.ts for the rationale.
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
