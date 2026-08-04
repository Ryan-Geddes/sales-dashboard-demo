import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { isDemoMode } from "../lib/demo-mode";

const IMPERSONATE_HEADER = "x-impersonate-user-id";

/**
 * DEV-ONLY middleware. When the client sends an `x-impersonate-user-id`
 * header, this looks the target user up in the users table and overrides
 * `req.user`'s role / hierarchyName / viewOnly so all subsequent auth
 * checks (requireRole, requireWritable, userCanEditOppProbability, etc.)
 * behave as if the impersonated user were signed in.
 *
 * Mounted only when NODE_ENV !== "production". A no-op in production
 * regardless of the header — and also a no-op in DEMO_MODE, where the public
 * demo picks its identity through the demo login instead and must never let a
 * client header swap roles.
 */
export async function devImpersonate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  if (process.env.NODE_ENV === "production" || isDemoMode()) {
    next();
    return;
  }
  const headerVal = req.header(IMPERSONATE_HEADER);
  if (!headerVal || !req.user) {
    next();
    return;
  }
  try {
    const rows = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        profileImageUrl: usersTable.profileImageUrl,
        role: usersTable.role,
        hierarchyName: usersTable.hierarchyName,
      })
      .from(usersTable)
      .where(eq(usersTable.id, headerVal))
      .limit(1);
    const target = rows[0];
    if (target) {
      req.user = {
        ...req.user,
        id: target.id,
        email: target.email,
        firstName: target.firstName,
        lastName: target.lastName,
        profileImageUrl: target.profileImageUrl,
        role: target.role as any,
        hierarchyName: target.hierarchyName,
        viewOnly: false as any,
      };
    } else {
      // Header was sent but no matching user — log so the 403 that will
      // follow on any write is traceable instead of a silent mystery.
      console.warn("devImpersonate: no user matched header", {
        impersonateHeader: headerVal,
      });
    }
  } catch (e) {
    // Swallow — failing to impersonate should never break the request.
    // The original req.user remains in place.
  }
  next();
}
