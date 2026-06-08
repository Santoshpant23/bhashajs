/**
 * User Model
 * 
 * Stores registered users. Password is bcrypt-hashed before storage.
 * Email has a unique index to prevent duplicate accounts.
 */

import mongoose, { Schema } from "mongoose";

const userSchema = new Schema({
  email: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  password: { type: String, required: true }, // bcrypt hash, never plain text
  // Bumped to invalidate every previously-issued JWT for this user (logout-all,
  // future password change). The token carries the version it was signed with;
  // authMiddleware rejects any token whose version is behind the user's.
  tokenVersion: { type: Number, default: 0 },
  // Atomic per-user project quota counter. POST /api/projects reserves a slot
  // with a single conditional `findOneAndUpdate({ projectCount: { $lt: cap } },
  // { $inc: { projectCount: 1 } })` so a burst of concurrent creates can't
  // race past MAX_PROJECTS_PER_USER (the old countDocuments-then-create check
  // was TOCTOU-racey). Decremented on project delete (and refunded if the
  // create fails). Backfilled for pre-existing users by migrateProjectCounts().
  projectCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model("User", userSchema);

export default User;
