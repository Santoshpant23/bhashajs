/**
 * Notification Routes
 *
 * GET  /api/notifications          — List notifications for current user
 * PUT  /api/notifications/:id/read — Mark one notification as read
 * PUT  /api/notifications/read-all — Mark all notifications as read
 *
 * All routes require authentication.
 */

import { Router, Response } from "express";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import Notification from "../models/Notification";
import { sendSuccess, sendError } from "../utils/response";
import { validateObjectId } from "../utils/validate";

const router = Router();
router.use(authMiddleware);

// ─── LIST NOTIFICATIONS ─────────────────────────────────────
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const { unread } = req.query;
    const filter: any = { userId: req.userId };
    if (unread === "true") filter.read = false;

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .limit(50);

    const unreadCount = await Notification.countDocuments({
      userId: req.userId,
      read: false,
    });

    return sendSuccess(res, 200, { notifications, unreadCount });
  } catch (e) {
    return sendError(res, 500, "Failed to fetch notifications");
  }
});

// ─── MARK ALL AS READ ───────────────────────────────────────
// Must be before /:id/read to avoid route conflict
router.put("/read-all", async (req: AuthRequest, res: Response) => {
  try {
    await Notification.updateMany(
      { userId: req.userId, read: false },
      { read: true }
    );
    return sendSuccess(res, 200, { message: "All notifications marked as read" });
  } catch (e) {
    return sendError(res, 500, "Failed to mark notifications as read");
  }
});

// ─── MARK ONE AS READ ───────────────────────────────────────
router.put("/:id/read", async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const idError = validateObjectId(id as string, "Notification ID");
    if (idError) return sendError(res, 400, idError);

    const notification = await Notification.findOneAndUpdate(
      { _id: id, userId: req.userId },
      { read: true },
      { new: true }
    );
    if (!notification) return sendError(res, 404, "Notification not found");

    return sendSuccess(res, 200, notification);
  } catch (e) {
    return sendError(res, 500, "Failed to mark notification as read");
  }
});

export default router;
