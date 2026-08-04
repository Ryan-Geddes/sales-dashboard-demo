import { fetchHierarchy as defaultFetchHierarchy } from "./sheets-data";
import { logger } from "./logger";

/**
 * Parse a comma-separated env var into a lower-cased, trimmed set. Unknown /
 * empty env vars produce an empty set (no overrides) — never a hard-coded
 * fallback, so a public build of this repo carries no real addresses.
 */
function emailSetFromEnv(envVar: string): Set<string> {
  return new Set(
    (process.env[envVar] || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

// Admin overrides — emails that should always resolve to the `admin` role,
// independent of whether they appear in the Sheets hierarchy. Configured with
// the comma-separated ADMIN_EMAILS env var. Lower-cased.
export const ADMIN_EMAILS: Set<string> = emailSetFromEnv("ADMIN_EMAILS");

// Exec overrides — leadership emails that live OUTSIDE the Sales Hierarchy but
// should resolve to the `exec` role. Exec mirrors SLM-level privileges; because
// an exec has no hierarchy subtree, they get org-wide scope (see resolveUserRole
// and the role checks in routes/sales.ts). Configured with the comma-separated
// EXEC_EMAILS env var. Lower-cased.
export const EXEC_EMAILS: Set<string> = emailSetFromEnv("EXEC_EMAILS");

export type UserRole = "guest" | "rep" | "flm" | "slm" | "exec" | "admin" | "viewer";

export interface ResolvedRole {
  role: UserRole | null;
  hierarchyName: string | null;
}

// Email domain that gets the read-only `viewer` fallback role when a logged-in
// user isn't in the Sales Hierarchy and isn't on the admin list. Configured
// with the INTERNAL_EMAIL_DOMAIN env var (e.g. "@example.com"). Empty/unset
// disables the viewer-domain fallback entirely. Lower-cased.
export const INTERNAL_EMAIL_DOMAIN: string = (
  process.env.INTERNAL_EMAIL_DOMAIN || ""
)
  .trim()
  .toLowerCase();

function isInternalEmail(lowerEmail: string): boolean {
  if (!INTERNAL_EMAIL_DOMAIN) return false;
  return lowerEmail.endsWith(INTERNAL_EMAIL_DOMAIN);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function looksLikeEmail(value: unknown): value is string {
  return typeof value === "string" && EMAIL_RE.test(value.trim());
}

/**
 * Best-effort email extraction from an OIDC claims set.
 *
 * Replit OIDC tokens usually carry the user's email on `email`, but some
 * accounts surface it on `email_address`, `preferred_username`, or `upn`
 * instead. We accept any of those provided they look like a real email,
 * falling back to `null` only as a last resort. This keeps the viewer
 * fallback in `resolveUserRole` reachable for users whose `email` claim
 * happens to be missing.
 */
export function extractEmailFromClaims(
  claims: Record<string, unknown> | null | undefined,
): string | null {
  if (!claims) return null;
  const candidates: unknown[] = [
    claims.email,
    claims.email_address,
    claims.preferred_username,
    claims.upn,
  ];
  for (const c of candidates) {
    if (looksLikeEmail(c)) return (c as string).trim();
  }
  return null;
}

type FetchHierarchyFn = typeof defaultFetchHierarchy;

/**
 * Look the user up in the Sheets sales hierarchy by email and return their
 * role + canonical hierarchy name.
 *
 * - Admin emails always get `admin` (with hierarchyName when present).
 * - Otherwise, classifies as `slm`, `flm`, or `rep` based on the hierarchy.
 * - Falls back to `viewer` (read-only) when the email is on the configured
 *   INTERNAL_EMAIL_DOMAIN but not present in the hierarchy or admin list —
 *   letting any internal employee with an SSO account view the dashboard.
 * - Returns `{ role: null }` for external emails not in the hierarchy/admin
 *   list — meaning "signed in but not provisioned".
 *
 * This runs on every login, so a Viewer who later appears in the hierarchy
 * (or the admin list) is auto-promoted on their next sign-in.
 *
 * Defensive contract: this function will never return `{ role: null }` for an
 * email on INTERNAL_EMAIL_DOMAIN. If the resolution path somehow arrives
 * there, we log a WARN and force `viewer` so a future refactor can't
 * accidentally re-block internal employees on first login.
 */
export async function resolveUserRole(
  email: string | null | undefined,
  opts: { fetchHierarchy?: FetchHierarchyFn } = {},
): Promise<ResolvedRole> {
  const fetchHierarchy = opts.fetchHierarchy ?? defaultFetchHierarchy;
  const lower = typeof email === "string" ? email.toLowerCase().trim() : "";

  const decision: {
    inputEmail: string;
    hierarchyFetchOk: boolean;
    foundInHierarchy: boolean;
    resolvedRole: UserRole | null;
    reason: string;
  } = {
    inputEmail: lower || "(none)",
    hierarchyFetchOk: false,
    foundInHierarchy: false,
    resolvedRole: null,
    reason: "",
  };

  const finalize = (
    role: UserRole | null,
    hierarchyName: string | null,
    reason: string,
  ): ResolvedRole => {
    decision.resolvedRole = role;
    decision.reason = reason;

    // Defensive: never block an internal email. If we somehow ended up at
    // null for an INTERNAL_EMAIL_DOMAIN address, force the viewer fallback
    // and warn so we notice the gap.
    if (!role && lower && isInternalEmail(lower)) {
      decision.resolvedRole = "viewer";
      decision.reason = `${reason} -> forced viewer (internal email guard)`;
      logger.warn(
        decision,
        "resolveUserRole: would have returned null for internal email; forcing viewer",
      );
      return { role: "viewer", hierarchyName };
    }

    logger.info(decision, "resolveUserRole decision");
    return { role, hierarchyName };
  };

  if (!lower) {
    return finalize(null, null, "no usable email on claims");
  }

  let hierarchy;
  try {
    hierarchy = await fetchHierarchy();
    decision.hierarchyFetchOk = true;
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "resolveUserRole: hierarchy fetch failed",
    );
    if (ADMIN_EMAILS.has(lower)) {
      return finalize("admin", null, "admin override (hierarchy unavailable)");
    }
    if (EXEC_EMAILS.has(lower)) {
      return finalize("exec", null, "exec override (hierarchy unavailable)");
    }
    if (isInternalEmail(lower)) {
      return finalize("viewer", null, "internal-domain fallback (hierarchy unavailable)");
    }
    return finalize(null, null, "external email, hierarchy unavailable");
  }

  // Find the canonical hierarchy name (full name) for this email.
  const hierarchyName =
    Object.entries(hierarchy.personToEmail).find(
      ([, e]) => (e || "").toLowerCase() === lower,
    )?.[0] ?? null;
  decision.foundInHierarchy = !!hierarchyName;

  if (ADMIN_EMAILS.has(lower)) {
    return finalize("admin", hierarchyName, "admin override");
  }

  // Exec override: leadership outside the sales hierarchy. Takes precedence
  // over any hierarchy-derived role so an exec is never demoted to rep/flm/slm.
  if (EXEC_EMAILS.has(lower)) {
    return finalize("exec", hierarchyName, "exec override");
  }

  if (hierarchyName) {
    if (hierarchy.slms.includes(hierarchyName)) {
      return finalize("slm", hierarchyName, "matched slm in hierarchy");
    }
    // FLM = key in flmToReps (i.e. someone with reports)
    if (Object.prototype.hasOwnProperty.call(hierarchy.flmToReps, hierarchyName)) {
      return finalize("flm", hierarchyName, "matched flm in hierarchy");
    }
    if (hierarchy.allReps.has(hierarchyName)) {
      return finalize("rep", hierarchyName, "matched rep in hierarchy");
    }
    // Found by email but not located in the rep/flm/slm tree (e.g. exec).
    // If they are on the internal domain, give them the viewer fallback so
    // they still get into the dashboard.
    if (isInternalEmail(lower)) {
      return finalize(
        "viewer",
        hierarchyName,
        "in hierarchy but no rep/flm/slm role; internal viewer fallback",
      );
    }
    return finalize(
      null,
      hierarchyName,
      "in hierarchy but no rep/flm/slm role; external email",
    );
  }

  // Not in the hierarchy and not an admin: any INTERNAL_EMAIL_DOMAIN
  // employee gets read-only viewer access; everyone else hits the
  // "not provisioned" wall.
  if (isInternalEmail(lower)) {
    return finalize("viewer", null, "internal viewer fallback (not in hierarchy)");
  }
  return finalize(null, null, "external email, not in hierarchy");
}

/**
 * Dev-only override: read DEV_ADMIN_EMAILS env var (comma-separated) and add
 * those addresses to the admin set. Useful for granting yourself admin access
 * locally without editing the Sheets hierarchy.
 */
const devAdmins = (process.env.DEV_ADMIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
for (const e of devAdmins) ADMIN_EMAILS.add(e);
