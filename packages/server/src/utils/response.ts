/**
 * Response Helper Utility
 * 
 * Ensures every API response follows the same format:
 *   Success: { success: true, data: ... }
 *   Error:   { success: false, message: "..." }
 * 
 * Usage in routes:
 *   return sendSuccess(res, 201, { project });
 *   return sendError(res, 400, "Name is required");
 */

import { Response } from "express";

export function sendSuccess(res: Response, statusCode: number, data: any) {
  return res.status(statusCode).json({
    success: true,
    data,
  });
}

export function sendError(res: Response, statusCode: number, message: string) {
  return res.status(statusCode).json({
    success: false,
    message,
  });
}
