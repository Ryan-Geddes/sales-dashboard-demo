import type { Request, Response, NextFunction } from "express";
import { getSessionId } from "../lib/auth";
import { isDemoMode } from "../lib/demo-mode";
import { isSessionScopedDemoUserId } from "../lib/demo-auth";
import { runInDemoSession } from "../lib/demo-session";

/**
 * Demo mode only: run the rest of the request inside the signed-in demo user's
 * private DB context, so every query goes to that session's never-committed
 * transaction (see lib/demo-session.ts). The visitor sees their own edits; no
 * one else does; they vanish at logout.
 *
 * Deliberately skipped for
 *   - live mode (no DEMO_MODE) — a no-op middleware,
 *   - anonymous requests (no session),
 *   - the Owner / GitHub session, whose id lacks the session-scoped prefix, so
 *     its writes run on the pool and persist.
 *
 * Mounted after authMiddleware so req.user is resolved, and before the routers.
 */
export function demoSessionScope(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!isDemoMode()) {
    next();
    return;
  }
  if (!isSessionScopedDemoUserId(req.user?.id)) {
    next();
    return;
  }
  const sid = getSessionId(req);
  if (!sid) {
    next();
    return;
  }
  // Express runs the downstream chain synchronously off next(), so the
  // async-local context propagates through every awaited handler.
  runInDemoSession(sid, () => {
    next();
  });
}
