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

// Extend Express Request to include userId
export interface AuthRequest extends Request {
  userId?: string;
}

export function authMiddleware(
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

  try {
    // Verify token and extract the userId payload
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "fallback-secret"
    ) as { userId: string };

    req.userId = decoded.userId;
    next();
  } catch (e) {
    return sendError(res, 401, "Invalid or expired token");
  }
}
