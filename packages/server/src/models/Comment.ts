/**
 * Comment Model
 *
 * Per-key or per-language discussion threads on translations.
 * - translationId: which translation key this comment belongs to
 * - projectId: for efficient project-level queries
 * - lang: optional — null means key-level comment, string means language-specific
 * - content: the comment text (max 2000 chars)
 * - userId: who posted it
 */

import mongoose, { Schema } from "mongoose";

const commentSchema = new Schema({
  translationId: {
    type: Schema.Types.ObjectId,
    ref: "Translation",
    required: true,
  },
  projectId: {
    type: Schema.Types.ObjectId,
    ref: "Project",
    required: true,
  },
  lang: {
    type: String,
    default: null,
  },
  content: {
    type: String,
    required: true,
    maxlength: 2000,
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
});

commentSchema.index({ translationId: 1, createdAt: 1 });
commentSchema.index({ projectId: 1, createdAt: -1 });

const Comment = mongoose.model("Comment", commentSchema);
export default Comment;
