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
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model("User", userSchema);

export default User;
