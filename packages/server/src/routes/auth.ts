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
import crypto from "crypto";
import User from "../models/User";
import ProjectMember from "../models/ProjectMember";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { sendSuccess, sendError } from "../utils/response";
import { sendPasswordResetEmail } from "../services/email";
import {
  validateAll,
  validateRequired,
  validateEmail,
  validatePassword,
} from "../utils/validate";

const router = Router();
const RESET_SUCCESS_MESSAGE = "If that account exists, a reset link has been sent.";

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function validatePasswordForAuth(password: unknown): string | null {
  if (typeof password !== "string") {
    return "Password must be a string";
  }
  const passwordError = validatePassword(password);
  if (passwordError) return passwordError;
  if (Buffer.byteLength(password, "utf8") > 72) {
    return "Password must be 72 bytes or fewer";
  }
  return null;
}

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
    if (typeof email !== "string" || email.trim().length > 254) {
      return sendError(res, 400, "Email must be 254 characters or fewer");
    }
    if (typeof password !== "string") {
      return sendError(res, 400, "Password must be a string");
    }
    if (Buffer.byteLength(password, "utf8") > 72) {
      return sendError(res, 400, "Password must be 72 bytes or fewer");
    }

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

    // Auto-claim any pending invites that were sent to this email before signup.
    // Without this, a user clicking an invite link, signing up, and then losing
    // the redirect (browser history, ad-blocker, etc.) would never become an
    // active member — the dashboard would show empty and the owner would still
    // see them as "pending".
    try {
      // Keep `inviteToken` populated even after auto-claim. It stops being a
      // "consume me" credential the moment status flips to "active" (because
      // accept-invite below verifies the requester owns the membership), and
      // keeping it around lets accept-invite respond idempotently when the
      // user clicks the email link AFTER signup auto-claimed the membership.
      // Clearing it used to leave the route with no way to look up the
      // membership and forced a dangerous "any active membership" fallback.
      const now = new Date();
      await ProjectMember.updateMany(
        {
          email: user.email,
          status: "pending",
          userId: null,
          $or: [{ inviteExpiresAt: null }, { inviteExpiresAt: { $gte: now } }],
        },
        {
          $set: { userId: user._id, status: "active" },
        }
      );
    } catch (_) {
      // Non-critical — registration still succeeds even if claim fails.
    }

    // Generate JWT with userId as payload
    const token = jwt.sign(
      { userId: user._id, tokenVersion: (user as any).tokenVersion ?? 0 },
      process.env.JWT_SECRET!,
      { expiresIn: (process.env.JWT_EXPIRY || "7d") as any }
    );

    return sendSuccess(res, 201, {
      token,
      userId: user._id,
      name: user.name,
    });
  } catch (e: any) {
    if (e?.code === 11000) {
      return sendError(res, 400, "Email already registered");
    }
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
      { userId: user._id, tokenVersion: (user as any).tokenVersion ?? 0 },
      process.env.JWT_SECRET!,
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

// ─── LOGOUT (revoke all sessions) ────────────────────────────
// FORGOT PASSWORD
router.post("/forgot-password", async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    const normalized = typeof email === "string" ? email.toLowerCase().trim() : "";
    if (normalized) {
      const user = await User.findOne({ email: normalized });
      if (user) {
        const token = crypto.randomBytes(32).toString("hex");
        (user as any).resetTokenHash = sha256(token);
        (user as any).resetTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
        await user.save();

        const appUrl = process.env.APP_URL || "https://app.bhashajs.com";
        const resetLink = `${appUrl}/reset-password?token=${token}`;
        sendPasswordResetEmail({ to: user.email, resetLink }).catch((e) => {
          console.error("[email] Failed to queue password reset:", e);
        });
      }
    }

    return sendSuccess(res, 200, { message: RESET_SUCCESS_MESSAGE });
  } catch (e) {
    return sendError(res, 500, "Something went wrong during password reset");
  }
});

// RESET PASSWORD
router.post("/reset-password", async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body;
    if (typeof token !== "string" || !token.trim()) {
      return sendError(res, 400, "Invalid or expired reset link");
    }

    const passwordError = validatePasswordForAuth(password);
    if (passwordError) return sendError(res, 400, passwordError);

    const user = await User.findOne({
      resetTokenHash: sha256(token),
      resetTokenExpiresAt: { $gte: new Date() },
    });
    if (!user) {
      return sendError(res, 400, "Invalid or expired reset link");
    }

    user.password = await bcrypt.hash(password, 10);
    (user as any).resetTokenHash = null;
    (user as any).resetTokenExpiresAt = null;
    (user as any).tokenVersion = ((user as any).tokenVersion ?? 0) + 1;
    await user.save();

    return sendSuccess(res, 200, { message: "Password has been reset." });
  } catch (e) {
    return sendError(res, 500, "Something went wrong during password reset");
  }
});

router.post("/logout", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    await User.updateOne({ _id: req.userId }, { $inc: { tokenVersion: 1 } });
    return sendSuccess(res, 200, { message: "Signed out of all sessions" });
  } catch (e) {
    return sendError(res, 500, "Something went wrong during logout");
  }
});

export default router;
