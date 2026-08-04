import type { Request, Response, NextFunction } from "express";
import type { UserRole } from "../lib/user-roles";

/**
 * Returns Express middleware that requires the request to be authenticated
 * AND the user's role to be one of the allowed roles. Pass no roles to only
 * require authentication.
 */
export function requireRole(...allowed: UserRole[]) {
  return function roleGuard(req: Request, res: Response, next: NextFunction) {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (allowed.length === 0) {
      next();
      return;
    }
    const role = req.user?.role as UserRole | null | undefined;
    if (!role || !allowed.includes(role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

/**
 * Blocks mutating requests from view-only sessions. Always pair with
 * requireRole(...) earlier in the chain so this only sees authenticated users.
 */
export function requireWritable() {
  return function writableGuard(req: Request, res: Response, next: NextFunction) {
    if (req.user?.viewOnly === true) {
      // Diagnostic: log enough context to disambiguate "guest view-only
      // session" from "dev impersonation header missed" — both produce
      // the same 403 to the client and are otherwise indistinguishable.
      // Includes whether an impersonation header was sent so we can tell
      // if devImpersonate ran but failed to find the target user.
      console.warn("requireWritable: view-only session blocked write", {
        path: req.path,
        method: req.method,
        userId: req.user?.id,
        role: req.user?.role,
        hierarchyName: req.user?.hierarchyName,
        impersonateHeader: req.header("x-impersonate-user-id") || null,
      });
      res.status(403).json({ error: "View-only session — sign in to make changes." });
      return;
    }
    next();
  };
}

export function isAdmin(req: Request): boolean {
  return req.isAuthenticated() && req.user?.role === "admin";
}

export function isAdminOrSlm(req: Request): boolean {
  return (
    req.isAuthenticated() &&
    (req.user?.role === "admin" ||
      req.user?.role === "slm" ||
      req.user?.role === "exec")
  );
}
