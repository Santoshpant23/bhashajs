/**
 * Auth Middleware
 * 
 * Verifies JWT token from the Authorization header.
 * Attaches userId to the request object for downstream routes.
 * Returns { success: false, message } on failure.
 */

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { sendError } from "../utils/response";
import User from "../models/User";

// Extend Express Request to include userId
export interface AuthRequest extends Request {
  userId?: string;
}

export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  // Extract the "Bearer <token>" from Authorization header
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return sendError(res, 401, "No token provided");
  }

  const token = authHeader.split(" ")[1];

  // Pin the algorithm (defense-in-depth: never honor "none" or an asymmetric
  // alg the attacker could supply) and read the token's version claim. A bad
  // signature/expiry is a genuine 401.
  let decoded: { userId: string; tokenVersion?: number };
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET!, {
      algorithms: ["HS256"],
    }) as { userId: string; tokenVersion?: number };
  } catch (e) {
    return sendError(res, 401, "Invalid or expired token");
  }

  try {
    // Stateful revocation + deleted-user lockout: the token is only valid while
    // its version still matches the user's current tokenVersion. A logout-all
    // (or future password change) bumps the user's version, instantly killing
    // every token issued before it. Lean projection keeps this cheap.
    const user = await User.findById(decoded.userId)
      .select("tokenVersion")
      .lean<{ tokenVersion?: number }>();
    if (!user) return sendError(res, 401, "Invalid or expired token");
    if ((user.tokenVersion ?? 0) !== (decoded.tokenVersion ?? 0)) {
      return sendError(res, 401, "Session expired, please sign in again");
    }

    req.userId = decoded.userId;
    next();
  } catch (e) {
    // The token is valid but we couldn't reach the DB to check revocation —
    // fail with 503 rather than 401, so a transient DB blip doesn't mass-logout
    // every signed-in user.
    return sendError(res, 503, "Service temporarily unavailable, please retry");
  }
}
