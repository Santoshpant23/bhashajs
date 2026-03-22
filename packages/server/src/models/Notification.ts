/**
 * Notification Model
 *
 * In-app notifications for team events:
 * - project_invite: someone invited you to a project
 * - ai_translations_ready: AI translations are ready for your review
 * - translator_edit: a translator edited a translation (notifies owner)
 */

import mongoose, { Schema } from "mongoose";

const notificationSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  type: {
    type: String,
    enum: ["project_invite", "ai_translations_ready", "translator_edit"],
    required: true,
  },
  message: { type: String, required: true },
  projectId: {
    type: Schema.Types.ObjectId,
    ref: "Project",
    default: null,
  },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

const Notification = mongoose.model("Notification", notificationSchema);
export default Notification;
