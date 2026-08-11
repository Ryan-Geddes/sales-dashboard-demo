// Client-side view of the server's demo mode.
//
// The server answers GET /api/auth/mode with `{ demo, today, ... }` in BOTH
// modes; live returns `{ demo: false, today: null }`, which leaves every branch
// below inert, so live behavior is unchanged.
//
// The flag is fetched ONCE before the app renders (see main.tsx) and cached in
// a module-level variable, so synchronous consumers — most importantly
// getTodayPST() in lib/utils.ts, which is called from render paths all over the
// dashboard — can read it without becoming async.

const API_BASE = import.meta.env.BASE_URL || "/";

export interface AuthMode {
  demo: boolean;
  /** Frozen `YYYY-MM-DD` the demo is pinned to; null in live mode. */
  today: string | null;
  /** GitHub login allowed to complete the Owner sign-in; null in live mode. */
  githubOwnerLogin: string | null;
  /** False when the demo host has no GitHub OAuth credentials configured. */
  githubConfigured: boolean;
}

const LIVE_MODE: AuthMode = {
  demo: false,
  today: null,
  githubOwnerLogin: null,
  githubConfigured: false,
};

let mode: AuthMode = LIVE_MODE;

export function getAuthMode(): AuthMode {
  return mode;
}

export function isDemoMode(): boolean {
  return mode.demo;
}

/**
 * Frozen demo date as `YYYY-MM-DD`, or null when not in demo mode. Consumed by
 * getTodayPST().
 */
export function demoToday(): string | null {
  return mode.demo ? mode.today : null;
}

/**
 * Load the flag. Called once from main.tsx before render; any failure falls
 * back to live behavior so a hiccup can never blank the live dashboard.
 */
export async function loadAuthMode(): Promise<AuthMode> {
  try {
    const res = await fetch(`${API_BASE}api/auth/mode`, {
      credentials: "include",
    });
    if (!res.ok) return mode;
    const data = (await res.json()) as Partial<AuthMode>;
    mode = {
      demo: data.demo === true,
      today: typeof data.today === "string" ? data.today : null,
      githubOwnerLogin:
        typeof data.githubOwnerLogin === "string" ? data.githubOwnerLogin : null,
      githubConfigured: data.githubConfigured === true,
    };
  } catch {
    // Network/parse failure: stay live.
  }
  return mode;
}
