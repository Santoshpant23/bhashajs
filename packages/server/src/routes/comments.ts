/**
 * Comment Routes
 *
 * GET    /api/translations/:translationId/comments  — List comments for a translation key
 * POST   /api/translations/:translationId/comments  — Add a comment
 * DELETE /api/translations/comments/:commentId       — Delete a comment
 *
 * All routes require authentication.
 * Any project member can read. Owner + translator can post. Author + owner can delete.
 */

import { Router, Response } from "express";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import Comment from "../models/Comment";
import Translation from "../models/Translation";
import ProjectMember from "../models/ProjectMember";
import { sendSuccess, sendError } from "../utils/response";
import { validateObjectId, validateRequired } from "../utils/validate";

const router = Router();
router.use(authMiddleware);

// ─── LIST COMMENTS ──────────────────────────────────────────
router.get(
  "/:translationId/comments",
  async (req: AuthRequest, res: Response) => {
    try {
      const { translationId } = req.params;
      const { lang } = req.query;

      const idError = validateObjectId(translationId as string, "Translation ID");
      if (idError) return sendError(res, 400, idError);

      const translation = await Translation.findById(translationId);
      if (!translation) return sendError(res, 404, "Translation not found");

      // Check membership
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

      const comments = await Comment.find(filter)
        .populate("userId", "name email")
        .sort({ createdAt: 1 });

      return sendSuccess(res, 200, comments);
    } catch (e) {
      return sendError(res, 500, "Failed to fetch comments");
    }
  }
);

// ─── ADD COMMENT ────────────────────────────────────────────
router.post(
  "/:translationId/comments",
  async (req: AuthRequest, res: Response) => {
    try {
      const { translationId } = req.params;
      const { content, lang } = req.body;

      const idError = validateObjectId(translationId as string, "Translation ID");
      if (idError) return sendError(res, 400, idError);

      const contentError = validateRequired(content, "Comment content");
      if (contentError) return sendError(res, 400, contentError);

      if (typeof content !== "string" || content.trim().length === 0) {
        return sendError(res, 400, "Comment content cannot be empty");
      }
      if (content.length > 2000) {
        return sendError(res, 400, "Comment cannot exceed 2000 characters");
      }

      const translation = await Translation.findById(translationId);
      if (!translation) return sendError(res, 404, "Translation not found");

      // Check membership — owner + translator can post
      const member = await ProjectMember.findOne({
        projectId: translation.projectId,
        userId: req.userId,
        status: "active",
      });
      if (!member) return sendError(res, 403, "Not authorized for this project");
      if (member.role === "viewer") {
        return sendError(res, 403, "Viewers cannot post comments");
      }

      const comment = await Comment.create({
        translationId: translationId as string,
        projectId: translation.projectId,
        lang: lang || null,
        content: content.trim(),
        userId: req.userId as string,
      });

      const populated = await Comment.findById((comment as any)._id).populate(
        "userId",
        "name email"
      );

      return sendSuccess(res, 201, populated);
    } catch (e) {
      return sendError(res, 500, "Failed to add comment");
    }
  }
);

// ─── DELETE COMMENT ─────────────────────────────────────────
router.delete(
  "/comments/:commentId",
  async (req: AuthRequest, res: Response) => {
    try {
      const { commentId } = req.params;

      const idError = validateObjectId(commentId as string, "Comment ID");
      if (idError) return sendError(res, 400, idError);

      const comment = await Comment.findById(commentId);
      if (!comment) return sendError(res, 404, "Comment not found");

      // Author or project owner can delete
      const member = await ProjectMember.findOne({
        projectId: comment.projectId,
        userId: req.userId,
        status: "active",
      });
      if (!member) return sendError(res, 403, "Not authorized for this project");

      const isAuthor = String(comment.userId) === String(req.userId);
      const isOwner = member.role === "owner";
      if (!isAuthor && !isOwner) {
        return sendError(res, 403, "Only the comment author or project owner can delete comments");
      }

      await comment.deleteOne();
      return sendSuccess(res, 200, { message: "Comment deleted" });
    } catch (e) {
      return sendError(res, 500, "Failed to delete comment");
    }
  }
);

export default router;
