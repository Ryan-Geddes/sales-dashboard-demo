import * as oidc from "openid-client";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetCurrentAuthUserResponse,
  ExchangeMobileAuthorizationCodeBody,
  ExchangeMobileAuthorizationCodeResponse,
  LogoutMobileSessionResponse,
} from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import {
  clearSession,
  getOidcConfig,
  getSessionId,
  createSession,
  deleteSession,
  SESSION_COOKIE,
  SESSION_TTL,
  ISSUER_URL,
  type SessionData,
} from "../lib/auth";
import {
  extractEmailFromClaims,
  resolveUserRole,
  INTERNAL_EMAIL_DOMAIN,
} from "../lib/user-roles";
import { requireRole } from "../middlewares/requireRole";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { fetchHierarchy } from "../lib/sheets-data";
import {
  buildImpersonationList,
  type DbUserLite,
} from "../lib/impersonation-list";
import { isDemoMode, DEMO_TODAY } from "../lib/demo-mode";
import { allowedGithubLogin, githubOauthConfigured } from "../lib/demo-github";

const OIDC_COOKIE_TTL = 10 * 60 * 1000;
const IS_PROD = process.env.NODE_ENV === "production";

const router: IRouter = Router();

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

function isSecureRequest(req: Request | undefined): boolean {
  if (IS_PROD) return true;
  if (!req) return false;
  const fwdProto = req.headers["x-forwarded-proto"];
  if (typeof fwdProto === "string" && fwdProto.split(",")[0].trim() === "https")
    return true;
  return req.secure === true;
}

function setSessionCookie(res: Response, sid: string, req?: Request) {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

function setOidcCookie(
  res: Response,
  name: string,
  value: string,
  req?: Request,
) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "lax",
    path: "/",
    maxAge: OIDC_COOKIE_TTL,
  });
}

function getSafeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

async function upsertUser(claims: Record<string, unknown>) {
  const email = extractEmailFromClaims(claims);
  const { role, hierarchyName } = await resolveUserRole(email);

  const userData = {
    id: claims.sub as string,
    email,
    firstName: (claims.first_name as string) || null,
    lastName: (claims.last_name as string) || null,
    profileImageUrl: (claims.profile_image_url || claims.picture) as
      | string
      | null,
    role,
    hierarchyName,
  };

  const [user] = await db
    .insert(usersTable)
    .values(userData)
    .onConflictDoUpdate({
      target: usersTable.id,
      set: {
        ...userData,
        updatedAt: new Date(),
      },
    })
    .returning();
  return user;
}

router.get("/auth/user", (req: Request, res: Response) => {
  res.json(
    GetCurrentAuthUserResponse.parse({
      user: req.isAuthenticated() ? req.user : null,
    }),
  );
});

/**
 * Runtime auth/config flags the client needs BEFORE it renders: which login UI
 * to show, and (in demo mode) the frozen "today" the whole dashboard is pinned
 * to. Always present, in both modes; `demo` is false on the live server, which
 * makes every client-side demo branch inert there.
 */
router.get("/auth/mode", (_req: Request, res: Response) => {
  const demo = isDemoMode();
  res.json({
    demo,
    // Only meaningful in demo mode; null live so getTodayPST() keeps using the
    // real clock.
    today: demo ? DEMO_TODAY : null,
    githubOwnerLogin: demo ? allowedGithubLogin() : null,
    githubConfigured: demo ? githubOauthConfigured() : false,
  });
});

router.get("/login", async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin(req)}/api/callback`;

  const returnTo = getSafeReturnTo(req.query.returnTo);

  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  const redirectTo = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl,
    scope: "openid email profile offline_access",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login consent",
    state,
    nonce,
  });

  setOidcCookie(res, "code_verifier", codeVerifier, req);
  setOidcCookie(res, "nonce", nonce, req);
  setOidcCookie(res, "state", state, req);
  setOidcCookie(res, "return_to", returnTo, req);

  res.redirect(redirectTo.href);
});

// Query params are not validated because the OIDC provider may include
// parameters not expressed in the schema.
router.get("/callback", async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin(req)}/api/callback`;

  const codeVerifier = req.cookies?.code_verifier;
  const nonce = req.cookies?.nonce;
  const expectedState = req.cookies?.state;

  if (!codeVerifier || !expectedState) {
    res.redirect("/api/login");
    return;
  }

  const currentUrl = new URL(
    `${callbackUrl}?${new URL(req.url, `http://${req.headers.host}`).searchParams}`,
  );

  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState,
      idTokenExpected: true,
    });
  } catch {
    res.redirect("/api/login");
    return;
  }

  const returnTo = getSafeReturnTo(req.cookies?.return_to);

  res.clearCookie("code_verifier", { path: "/" });
  res.clearCookie("nonce", { path: "/" });
  res.clearCookie("state", { path: "/" });
  res.clearCookie("return_to", { path: "/" });

  const claims = tokens.claims();
  if (!claims) {
    res.redirect("/api/login");
    return;
  }

  const dbUser = await upsertUser(
    claims as unknown as Record<string, unknown>,
  );

  const now = Math.floor(Date.now() / 1000);
  const sessionData: SessionData = {
    user: {
      id: dbUser.id,
      email: dbUser.email,
      firstName: dbUser.firstName,
      lastName: dbUser.lastName,
      profileImageUrl: dbUser.profileImageUrl,
      role: dbUser.role,
      hierarchyName: dbUser.hierarchyName,
    },
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expiresIn() ? now + tokens.expiresIn()! : claims.exp,
  };

  const sid = await createSession(sessionData);
  setSessionCookie(res, sid, req);
  res.redirect(returnTo);
});

router.post("/guest-login", async (req: Request, res: Response) => {
  const viewOnlyUser = {
    id: "view-only",
    email: null,
    firstName: "View-only",
    lastName: "Visitor",
    profileImageUrl: null,
    role: "rep" as const,
    hierarchyName: null,
    viewOnly: true as const,
  };

  const sessionData: SessionData = {
    user: viewOnlyUser,
    access_token: null,
    refresh_token: null,
    expires_at: Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000),
  };

  const sid = await createSession(sessionData);
  setSessionCookie(res, sid, req);
  res.json({ ok: true });
});

router.get("/logout", async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const origin = getOrigin(req);

  const sid = getSessionId(req);
  await clearSession(res, sid);

  const endSessionUrl = oidc.buildEndSessionUrl(config, {
    client_id: process.env.REPL_ID!,
    post_logout_redirect_uri: origin,
  });

  res.redirect(endSessionUrl.href);
});

router.post(
  "/mobile-auth/token-exchange",
  async (req: Request, res: Response) => {
    const parsed = ExchangeMobileAuthorizationCodeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid required parameters" });
      return;
    }

    const { code, code_verifier, redirect_uri, state, nonce } = parsed.data;

    try {
      const config = await getOidcConfig();

      const callbackUrl = new URL(redirect_uri);
      callbackUrl.searchParams.set("code", code);
      callbackUrl.searchParams.set("state", state);
      callbackUrl.searchParams.set("iss", ISSUER_URL);

      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: code_verifier,
        expectedNonce: nonce ?? undefined,
        expectedState: state,
        idTokenExpected: true,
      });

      const claims = tokens.claims();
      if (!claims) {
        res.status(401).json({ error: "No claims in ID token" });
        return;
      }

      const dbUser = await upsertUser(
        claims as unknown as Record<string, unknown>,
      );

      const now = Math.floor(Date.now() / 1000);
      const sessionData: SessionData = {
        user: {
          id: dbUser.id,
          email: dbUser.email,
          firstName: dbUser.firstName,
          lastName: dbUser.lastName,
          profileImageUrl: dbUser.profileImageUrl,
          role: dbUser.role,
          hierarchyName: dbUser.hierarchyName,
        },
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expiresIn() ? now + tokens.expiresIn()! : claims.exp,
      };

      const sid = await createSession(sessionData);
      res.json(ExchangeMobileAuthorizationCodeResponse.parse({ token: sid }));
    } catch (err) {
      req.log.error({ err }, "Mobile token exchange error");
      res.status(500).json({ error: "Token exchange failed" });
    }
  },
);

router.post("/mobile-auth/logout", async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  if (sid) {
    await deleteSession(sid);
  }
  res.json(LogoutMobileSessionResponse.parse({ success: true }));
});

/**
 * One-shot backfill: find every user with a NULL role and an email on the
 * configured INTERNAL_EMAIL_DOMAIN, re-resolve their role with the current
 * `resolveUserRole`, and write the result back. Lets us unstick internal
 * employees who logged in before the viewer fallback was deployed without
 * making them sign in again.
 *
 * Safe by construction:
 * - WHERE clause only selects role IS NULL AND an internal-domain email.
 * - Only writes when the resolver returns a non-null role.
 * - Never touches users whose role is already set, and never promotes
 *   external accounts.
 * - No-op (scanned: 0) when INTERNAL_EMAIL_DOMAIN is unset.
 */
router.post(
  "/admin/backfill-internal-viewers",
  requireRole("admin"),
  async (req: Request, res: Response) => {
    try {
      if (!INTERNAL_EMAIL_DOMAIN) {
        res.json({
          scanned: 0,
          updated: 0,
          results: [],
          note: "INTERNAL_EMAIL_DOMAIN is not configured — nothing to backfill",
        });
        return;
      }

      const candidates = await db
        .select({
          id: usersTable.id,
          email: usersTable.email,
          role: usersTable.role,
          hierarchyName: usersTable.hierarchyName,
        })
        .from(usersTable)
        .where(
          and(
            isNull(usersTable.role),
            sql`lower(${usersTable.email}) like ${'%' + INTERNAL_EMAIL_DOMAIN}`,
          ),
        );

      const results: Array<{
        id: string;
        email: string | null;
        resolvedRole: string | null;
        hierarchyName: string | null;
        updated: boolean;
      }> = [];
      let updatedCount = 0;

      for (const row of candidates) {
        const { role, hierarchyName } = await resolveUserRole(row.email);
        if (role) {
          await db
            .update(usersTable)
            .set({
              role,
              hierarchyName,
              updatedAt: new Date(),
            })
            .where(and(eq(usersTable.id, row.id), isNull(usersTable.role)));
          updatedCount++;
          results.push({
            id: row.id,
            email: row.email,
            resolvedRole: role,
            hierarchyName,
            updated: true,
          });
        } else {
          results.push({
            id: row.id,
            email: row.email,
            resolvedRole: null,
            hierarchyName: null,
            updated: false,
          });
        }
      }

      req.log?.info?.(
        { scanned: candidates.length, updated: updatedCount },
        "backfill-internal-viewers complete",
      );
      res.json({ scanned: candidates.length, updated: updatedCount, results });
    } catch (err) {
      req.log?.error?.({ err }, "backfill-internal-viewers failed");
      res.status(500).json({ error: "Backfill failed" });
    }
  },
);

router.get("/admin/users", requireRole("admin"), async (_req: Request, res: Response) => {
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
    .where(ne(usersTable.role, "admin"));
  res.json({ users: rows });
});

if (process.env.NODE_ENV !== "production") {
  router.get("/admin/users-dev", async (_req: Request, res: Response) => {
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
      .where(ne(usersTable.role, "admin"));
    res.json({ users: rows });
  });
}

async function loadImpersonationList() {
  const [hierarchy, dbRows] = await Promise.all([
    fetchHierarchy(),
    db
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
      .where(ne(usersTable.role, "admin")),
  ]);
  const dbUsers: DbUserLite[] = dbRows.map((r) => ({
    id: r.id,
    email: r.email,
    firstName: r.firstName,
    lastName: r.lastName,
    profileImageUrl: r.profileImageUrl,
    role: r.role,
    hierarchyName: r.hierarchyName,
  }));
  return buildImpersonationList(hierarchy.people, dbUsers);
}

router.get(
  "/admin/impersonation-list",
  requireRole("admin"),
  async (_req: Request, res: Response) => {
    try {
      const users = await loadImpersonationList();
      res.json({ users });
    } catch (err) {
      _req.log?.error?.({ err }, "impersonation-list failed");
      res.status(500).json({ error: "Failed to build impersonation list" });
    }
  },
);

router.get(
  "/admin/impersonation-list/unmatched",
  requireRole("admin"),
  async (_req: Request, res: Response) => {
    try {
      const users = await loadImpersonationList();
      res.json({ users: users.filter((u) => u.source === "db-only") });
    } catch (err) {
      _req.log?.error?.({ err }, "impersonation-list/unmatched failed");
      res.status(500).json({ error: "Failed to build unmatched list" });
    }
  },
);

if (process.env.NODE_ENV !== "production") {
  router.get(
    "/admin/impersonation-list-dev",
    async (_req: Request, res: Response) => {
      try {
        const users = await loadImpersonationList();
        res.json({ users });
      } catch (err) {
        _req.log?.error?.({ err }, "impersonation-list-dev failed");
        res.status(500).json({ error: "Failed to build impersonation list" });
      }
    },
  );
}

export default router;
