// Demo-mode authentication routes.
//
// This router is mounted ONLY when DEMO_MODE is on (see routes/index.ts), so in
// live mode none of these paths exist — a request to /api/auth/demo/users there
// falls through to the normal 404 exactly as before.
//
// Three ways in:
//   1. GET  /auth/demo/users  → the role buckets + selectable names.
//   2. POST /auth/demo/login  → { role, name } creates a session-scoped login.
//   3. GET  /auth/demo/github → Owner sign-in via GitHub OAuth (persistent).
//
// Sessions use the exact same shape the OIDC callback creates (SessionData with
// a `user` matching AuthUser), so authMiddleware, requireRole, requireWritable
// and every downstream role check work unchanged.

import { Router, type IRouter, type Request, type Response } from "express";
// `dbDirect` bypasses the demo per-session transaction routing: an identity row
// must persist (user_preferences FKs onto it) even though the session's data
// edits do not.
import { dbDirect as db, usersTable } from "@workspace/db";
import {
  clearSession,
  createSession,
  getSessionId,
  SESSION_COOKIE,
  SESSION_TTL,
  type SessionData,
} from "../lib/auth";
import {
  listDemoLoginOptions,
  resolveDemoIdentity,
  DEMO_OWNER_ID_PREFIX,
  slugify,
} from "../lib/demo-auth";
import {
  allowedGithubLogin,
  githubAuthorizeUrl,
  githubOauthConfigured,
  githubProfileFromCode,
  githubRandomState,
} from "../lib/demo-github";
import { endDemoSession } from "../lib/demo-session";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const IS_PROD = process.env.NODE_ENV === "production";
const GITHUB_STATE_COOKIE = "gh_state";
const GITHUB_STATE_TTL = 10 * 60 * 1000;

function isSecureRequest(req: Request): boolean {
  if (IS_PROD) return true;
  const fwdProto = req.headers["x-forwarded-proto"];
  if (typeof fwdProto === "string" && fwdProto.split(",")[0].trim() === "https")
    return true;
  return req.secure === true;
}

function getOrigin(req: Request): string {
  const fwdProto = req.headers["x-forwarded-proto"];
  const proto =
    (typeof fwdProto === "string" ? fwdProto.split(",")[0].trim() : null) ||
    (req.secure ? "https" : null) ||
    (IS_PROD ? "https" : "http");
  const host =
    req.headers["x-forwarded-host"] || req.headers["host"] || "localhost";
  return `${proto}://${host}`;
}

function setSessionCookie(res: Response, sid: string, req: Request) {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

/**
 * Upsert the `users` row for a demo identity, on the unrouted handle so the row
 * commits. Ids are deterministic (role + name slug), so repeat logins reuse the
 * same row rather than accumulating. Role checks all read `req.user` from the
 * session; the row exists for the things that join on `users` (preferences FK,
 * impersonation list).
 */
async function upsertDemoUser(user: {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  profileImageUrl: string | null;
  role: string;
  hierarchyName: string | null;
}): Promise<void> {
  try {
    await db
      .insert(usersTable)
      .values(user)
      .onConflictDoUpdate({
        target: usersTable.id,
        set: { ...user, updatedAt: new Date() },
      });
  } catch (err) {
    // A demo login must never fail because the users table rejected the row.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), id: user.id },
      "[Demo auth] users upsert failed (continuing)",
    );
  }
}

// ---------------------------------------------------------------------------
// 1. Selectable identities
// ---------------------------------------------------------------------------

router.get("/auth/demo/users", async (_req: Request, res: Response) => {
  try {
    const roles = await listDemoLoginOptions();
    res.json({
      roles: roles.map((r) => ({
        id: r.id,
        label: r.label,
        kind: r.kind,
        description: r.description,
        users: r.users,
      })),
      githubConfigured: githubOauthConfigured(),
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[Demo auth] Failed to build demo user list",
    );
    res.status(500).json({ error: "Failed to load demo users" });
  }
});

// ---------------------------------------------------------------------------
// 2. Role + name login
// ---------------------------------------------------------------------------

router.post("/auth/demo/login", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { role?: unknown; name?: unknown };
  const role = typeof body.role === "string" ? body.role : "";
  const name = typeof body.name === "string" ? body.name : "";
  if (!role || !name) {
    res.status(400).json({ error: "role and name are required" });
    return;
  }

  let identity;
  try {
    identity = await resolveDemoIdentity(role, name);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[Demo auth] Failed to resolve demo identity",
    );
    res.status(500).json({ error: "Failed to sign in" });
    return;
  }
  if (!identity) {
    res.status(400).json({ error: "Unknown demo user for that role" });
    return;
  }

  const user = {
    id: identity.id,
    email: identity.email,
    firstName: identity.firstName,
    lastName: identity.lastName,
    profileImageUrl: null,
    role: identity.role,
    hierarchyName: identity.hierarchyName,
  };
  await upsertDemoUser(user);

  const sessionData: SessionData = {
    user,
    access_token: null,
    refresh_token: null,
    expires_at: Math.floor((Date.now() + SESSION_TTL) / 1000),
  };
  const sid = await createSession(sessionData);
  setSessionCookie(res, sid, req);
  res.json({ ok: true, user });
});

// ---------------------------------------------------------------------------
// 3. Owner sign-in with GitHub
// ---------------------------------------------------------------------------

function githubCallbackUrl(req: Request): string {
  return `${getOrigin(req)}/api/auth/demo/github/callback`;
}

/** Small self-contained HTML page for the OAuth failure cases. */
function ownerErrorPage(res: Response, status: number, message: string): void {
  res
    .status(status)
    .type("html")
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Owner sign-in</title>` +
        `<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0a1628;color:#e2e8f0;` +
        `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}` +
        `.card{background:#fff;color:#0a1628;border-radius:8px;padding:32px;max-width:420px;text-align:center;` +
        `box-shadow:0 10px 30px rgba(0,0,0,.35)}h1{font-size:18px;margin:0 0 8px}p{font-size:13px;color:#475569;margin:0 0 20px}` +
        `a{display:inline-block;background:#006AFF;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px}` +
        `</style></head><body><div class="card"><h1>Owner sign-in unavailable</h1>` +
        `<p>${message.replace(/[<>&]/g, "")}</p><a href="/">Back to the demo</a></div></body></html>`,
    );
}

router.get("/auth/demo/github", (req: Request, res: Response) => {
  if (!githubOauthConfigured()) {
    ownerErrorPage(
      res,
      503,
      "GitHub sign-in isn't configured on this deployment. Pick a demo role instead.",
    );
    return;
  }
  const state = githubRandomState();
  res.cookie(GITHUB_STATE_COOKIE, state, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "lax",
    path: "/",
    maxAge: GITHUB_STATE_TTL,
  });
  res.redirect(githubAuthorizeUrl(githubCallbackUrl(req), state));
});

router.get("/auth/demo/github/callback", async (req: Request, res: Response) => {
  if (!githubOauthConfigured()) {
    ownerErrorPage(res, 503, "GitHub sign-in isn't configured on this deployment.");
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const expectedState = req.cookies?.[GITHUB_STATE_COOKIE];
  res.clearCookie(GITHUB_STATE_COOKIE, { path: "/" });

  if (!code || !state || !expectedState || state !== expectedState) {
    ownerErrorPage(res, 400, "The sign-in link expired or was tampered with. Try again.");
    return;
  }

  let profile;
  try {
    profile = await githubProfileFromCode(code, githubCallbackUrl(req));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[Demo auth] GitHub OAuth exchange failed",
    );
    ownerErrorPage(res, 502, "GitHub sign-in failed. Please try again.");
    return;
  }

  const allowed = allowedGithubLogin();
  if (profile.login.toLowerCase() !== allowed.toLowerCase()) {
    ownerErrorPage(
      res,
      403,
      `Owner sign-in is limited to @${allowed}. You're signed in to GitHub as @${profile.login}. ` +
        `Pick one of the demo roles instead — they have full read access.`,
    );
    return;
  }

  const displayName = profile.name?.trim() || profile.login;
  const [firstName, ...rest] = displayName.split(/\s+/);
  const user = {
    // Owner ids intentionally do NOT carry the session-scoped prefix, so the
    // request context never enters a demo transaction — Owner writes commit.
    id: `${DEMO_OWNER_ID_PREFIX}${slugify(profile.login)}`,
    email: profile.email || `${slugify(profile.login)}@users.noreply.github.com`,
    firstName,
    lastName: rest.length > 0 ? rest.join(" ") : null,
    profileImageUrl: profile.avatarUrl,
    // Admin is what grants full access today (see requireRole / isAdmin).
    role: "admin" as const,
    hierarchyName: null,
  };
  await upsertDemoUser(user);

  const sessionData: SessionData = {
    user,
    access_token: null,
    refresh_token: null,
    expires_at: Math.floor((Date.now() + SESSION_TTL) / 1000),
  };
  const sid = await createSession(sessionData);
  setSessionCookie(res, sid, req);
  res.redirect("/");
});

// ---------------------------------------------------------------------------
// Logout (demo). The live GET /api/logout redirects through the OIDC end-session
// endpoint, which does not exist here, so demo mode overrides both verbs.
// ---------------------------------------------------------------------------

async function demoLogout(req: Request, res: Response): Promise<void> {
  const sid = getSessionId(req);
  // Roll back and release this session's transactional client first, so its
  // edits are gone before the session row disappears.
  await endDemoSession(sid);
  await clearSession(res, sid);
  if (req.method === "GET") {
    res.redirect("/");
    return;
  }
  res.json({ ok: true });
}

router.post("/auth/logout", demoLogout);
router.get("/logout", demoLogout);
router.post("/logout", demoLogout);

// There is no Replit OIDC in the demo. Anything that still points at the live
// login (a bookmark, an older client bundle) lands back on the demo login
// screen instead of throwing on OIDC discovery.
router.get("/login", (_req: Request, res: Response) => {
  res.redirect("/");
});
router.get("/callback", (_req: Request, res: Response) => {
  res.redirect("/");
});

// Drop the current user's session-scoped edits without signing out: rolls the
// transaction back and lets the next request open a fresh one.
router.post("/auth/demo/reset", async (req: Request, res: Response) => {
  await endDemoSession(getSessionId(req));
  res.json({ ok: true });
});

export default router;
