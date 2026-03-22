/**
 * ProjectMember Model
 *
 * Tracks team membership and invite status for each project.
 * Every project has at least one member with role "owner" (the creator).
 *
 * Roles:
 * - "owner"      — full access: CRUD keys, manage team, delete project
 * - "translator"  — can edit translations for assigned languages only
 * - "viewer"      — read-only access to translations and stats
 *
 * Invite flow:
 *   1. Owner creates invite → ProjectMember with status:"pending", inviteToken set
 *   2. Owner shares the invite link (contains token)
 *   3. Invited user visits link, calls accept-invite → status:"active", userId set
 */

import mongoose, { Schema } from "mongoose";

const projectMemberSchema = new Schema({
  projectId: {
    type: Schema.Types.ObjectId,
    ref: "Project",
    required: true,
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    default: null, // null when invite is pending
  },
  email: { type: String, required: true },
  role: {
    type: String,
    enum: ["owner", "translator", "viewer"],
    default: "translator",
  },
  assignedLanguages: { type: [String], default: [] }, // for translators
  inviteToken: { type: String, default: null },
  status: {
    type: String,
    enum: ["pending", "active"],
    default: "pending",
  },
  invitedBy: { type: Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now },
});

// One membership per email per project
projectMemberSchema.index({ projectId: 1, email: 1 }, { unique: true });
// Fast lookup: all projects for a user
projectMemberSchema.index({ userId: 1, status: 1 });
// Fast lookup by invite token
projectMemberSchema.index({ inviteToken: 1 }, { sparse: true });

const ProjectMember = mongoose.model("ProjectMember", projectMemberSchema);

export default ProjectMember;
