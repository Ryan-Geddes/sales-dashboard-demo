// GitHub OAuth (authorization code flow) for the demo's Owner login.
//
// The public demo runs outside Replit, so the Owner (the repo author) signs in
// with GitHub instead of Replit OIDC. Only the allow-listed GitHub login may
// complete; anyone else gets a friendly "this demo's owner sign-in is
// restricted" error and stays signed out.
//
// Plain `fetch` against GitHub's two documented endpoints — no extra
// dependency, and openid-client is not usable here because GitHub is OAuth2
// only (no OIDC discovery document).
//
// Every function degrades gracefully when GITHUB_CLIENT_ID /
// GITHUB_CLIENT_SECRET are unset: `githubOauthConfigured()` is false and the
// routes answer 503 with an explanatory message instead of throwing.

import crypto from "node:crypto";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

/** GitHub login (username) allowed to complete the Owner sign-in. */
export function allowedGithubLogin(): string {
  return (process.env.GITHUB_ALLOWED_LOGIN || "Ryan-Geddes").trim();
}

export function githubOauthConfigured(): boolean {
  return (
    !!process.env.GITHUB_CLIENT_ID?.trim() &&
    !!process.env.GITHUB_CLIENT_SECRET?.trim()
  );
}

export function githubRandomState(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function githubAuthorizeUrl(redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID!.trim());
  url.searchParams.set("redirect_uri", redirectUri);
  // `read:user` is enough to read the login; we never touch repos.
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

export interface GithubProfile {
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID!.trim(),
      client_secret: process.env.GITHUB_CLIENT_SECRET!.trim(),
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`GitHub token exchange failed (${res.status})`);
  const body = (await res.json()) as {
    access_token?: string;
    error_description?: string;
    error?: string;
  };
  if (!body.access_token) {
    throw new Error(
      body.error_description || body.error || "No access token returned",
    );
  }
  return body.access_token;
}

/** Exchange the code and fetch the authenticated user's public profile. */
export async function githubProfileFromCode(
  code: string,
  redirectUri: string,
): Promise<GithubProfile> {
  const token = await exchangeCode(code, redirectUri);
  const res = await fetch(USER_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "frontline-dashboard-demo",
    },
  });
  if (!res.ok) throw new Error(`GitHub user fetch failed (${res.status})`);
  const u = (await res.json()) as {
    login?: string;
    name?: string | null;
    email?: string | null;
    avatar_url?: string | null;
  };
  if (!u.login) throw new Error("GitHub profile has no login");
  return {
    login: u.login,
    name: u.name ?? null,
    email: u.email ?? null,
    avatarUrl: u.avatar_url ?? null,
  };
}
