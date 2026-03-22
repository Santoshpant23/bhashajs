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
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model("User", userSchema);

export default User;
