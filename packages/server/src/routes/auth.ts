/**
 * Auth Routes
 * 
 * POST /api/auth/register — Create a new account, returns JWT
 * POST /api/auth/login    — Sign in, returns JWT
 * 
 * All responses follow { success, data/message } format.
 */

import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User";
import { sendSuccess, sendError } from "../utils/response";
import {
  validateAll,
  validateRequired,
  validateEmail,
  validatePassword,
} from "../utils/validate";

const router = Router();

// ─── REGISTER ────────────────────────────────────────────────
router.post("/register", async (req: Request, res: Response) => {
  try {
    const { name, email, password } = req.body;

    // Validate all inputs before touching the database
    const error = validateAll(
      () => validateRequired(name, "Name"),
      () => validateRequired(email, "Email"),
      () => validateEmail(email),
      () => validatePassword(password),
    );
    if (error) return sendError(res, 400, error);

    // Check if email is already taken
    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return sendError(res, 400, "Email already registered");
    }

    // Hash password — 10 salt rounds is the standard balance of speed vs security
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create the user
    const user = await User.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: hashedPassword,
    });

    // Generate JWT with userId as payload
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || "fallback-secret",
      { expiresIn: (process.env.JWT_EXPIRY || "7d") as any }
    );

    return sendSuccess(res, 201, {
      token,
      userId: user._id,
      name: user.name,
    });
  } catch (e) {
    return sendError(res, 500, "Something went wrong during registration");
  }
});

// ─── LOGIN ───────────────────────────────────────────────────
router.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    // Validate inputs
    const error = validateAll(
      () => validateRequired(email, "Email"),
      () => validateRequired(password, "Password"),
    );
    if (error) return sendError(res, 400, error);

    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      // Vague error message so attackers can't tell if email exists
      return sendError(res, 401, "Invalid email or password");
    }

    // Compare plain password with stored bcrypt hash
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return sendError(res, 401, "Invalid email or password");
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || "fallback-secret",
      { expiresIn: (process.env.JWT_EXPIRY || "7d") as any }
    );

    return sendSuccess(res, 200, {
      token,
      userId: user._id,
      name: user.name,
    });
  } catch (e) {
    return sendError(res, 500, "Something went wrong during login");
  }
});

export default router;
