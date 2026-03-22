/**
 * Project Authorization Middleware
 *
 * Checks that the authenticated user has the required role
 * for the project specified in the route params.
 *
 * Usage:
 *   router.get("/:projectId", requireProjectRole("owner", "translator", "viewer"), handler)
 *
 * Attaches `req.membership` with the user's role and assigned languages.
 * Expects :projectId in req.params (falls back to :id).
 */

import { Response, NextFunction } from "express";
import { AuthRequest } from "./auth";
import ProjectMember from "../models/ProjectMember";
import { sendError } from "../utils/response";

export interface ProjectAuthRequest extends AuthRequest {
  membership?: {
    role: "owner" | "translator" | "viewer";
    assignedLanguages: string[];
  };
}

export function requireProjectRole(...allowedRoles: string[]) {
  return async (req: ProjectAuthRequest, res: Response, next: NextFunction) => {
    const projectId = req.params.projectId || req.params.id;
    if (!projectId) return sendError(res, 400, "Project ID is required");

    try {
      const member = await ProjectMember.findOne({
        projectId,
        userId: req.userId,
        status: "active",
      });

      if (!member || !allowedRoles.includes(member.role)) {
        return sendError(res, 403, "Not authorized for this project");
      }

      req.membership = {
        role: member.role as "owner" | "translator" | "viewer",
        assignedLanguages: member.assignedLanguages,
      };

      next();
    } catch (e) {
      return sendError(res, 500, "Authorization check failed");
    }
  };
}
