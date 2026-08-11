// Demo-mode login identities.
//
// The public demo has no Replit OIDC (and no Google/Slack/Databricks), so it
// ships its own tiny login: pick a role, pick a person, you're in. The
// selectable people come from the SAME hierarchy pipeline the app itself uses
// (fetchHierarchy(), which in demo mode is fed by the bundled anonymized sheet
// fixture `demo-sheet-hierarchy:428237012`), so every name in the dropdown is a
// real node of the demo org tree and role scoping behaves exactly as it does
// for a live user with that hierarchy position.
//
// Two synthetic identities exist because they have no hierarchy node: the
// Executive (org-wide, SLM-mirroring privileges) and the Admin.
//
// A third login — Owner — is GitHub OAuth (see routes/auth-demo.ts) and is the
// only one whose writes persist; see demo-session.ts.
//
// Nothing here is reachable outside DEMO_MODE: the routes that use it are only
// mounted when isDemoMode() is true.

import { fetchHierarchy } from "./sheets-data";

export type DemoRoleId = "owner" | "admin" | "exec" | "slm" | "flm" | "rep";

export interface DemoRoleOption {
  id: DemoRoleId;
  label: string;
  /** How the user is chosen: a name dropdown, a fixed identity, or GitHub. */
  kind: "people" | "fixed" | "github";
  description: string;
  users: string[];
}

/** Ids of the two synthetic (non-hierarchy) demo identities. */
export const DEMO_EXEC_NAME = "Demo Executive";
export const DEMO_ADMIN_NAME = "Demo Admin";

/** Prefix of every session-scoped (non-persistent) demo user id. */
export const DEMO_SCOPED_ID_PREFIX = "demo-user-";
/** Prefix of the Owner (GitHub) user id — persistent, never session scoped. */
export const DEMO_OWNER_ID_PREFIX = "demo-owner-";

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "user"
  );
}

/** Synthetic, obviously-fake email for a demo identity. */
export function demoEmail(role: DemoRoleId, name: string): string {
  return `demo-${role}+${slugify(name)}@demo.example`;
}

/** Deterministic user id so re-logins reuse the same `users` row. */
export function demoUserId(role: DemoRoleId, name: string): string {
  return `${DEMO_SCOPED_ID_PREFIX}${role}-${slugify(name)}`;
}

function splitName(name: string): { firstName: string; lastName: string | null } {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return { firstName: name.trim(), lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export interface DemoIdentity {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  role: "rep" | "flm" | "slm" | "exec" | "admin";
  hierarchyName: string | null;
}

/**
 * Role buckets for the login screen, derived from the same OrgHierarchy the
 * dashboard is built from: `slms` (direct reports of the VP), the keys of
 * `flmToReps`, and the reps under each FLM. Inactive people (the sheet's
 * `Active` column) are excluded because the month-aware effective hierarchy
 * drops them, so signing in as one would show an empty dashboard.
 */
export async function listDemoLoginOptions(): Promise<DemoRoleOption[]> {
  const h = await fetchHierarchy();
  // `people` is the hierarchy's own deduped identity index (built by walking
  // SLM → FLM → Rep with slm > flm > rep precedence, so player-coach FLMs
  // appear once as `flm`). It also excludes the synthetic "On Demand" pseudo
  // branch, which must never be a login identity.
  const namesFor = (role: "slm" | "flm" | "rep") =>
    [
      ...new Set(
        h.people
          .filter((p) => p.role === role && h.personToActive[p.name] !== false)
          .map((p) => p.name),
      ),
    ].sort((a, b) => a.localeCompare(b));

  const slms = namesFor("slm");
  const flms = namesFor("flm");
  const reps = namesFor("rep");

  return [
    {
      id: "owner",
      label: "Owner",
      kind: "github",
      description: "Sign in with GitHub. Full access; changes persist.",
      users: [],
    },
    {
      id: "admin",
      label: "Admin",
      kind: "fixed",
      description: "Full access to every tab, including Admin and Product Logic.",
      users: [DEMO_ADMIN_NAME],
    },
    {
      id: "exec",
      label: "Executive",
      kind: "fixed",
      description: "Org-wide leadership view.",
      users: [DEMO_EXEC_NAME],
    },
    {
      id: "slm",
      label: "SLM",
      kind: "people",
      description: "Second-line manager — their FLMs and all of their reps.",
      users: slms,
    },
    {
      id: "flm",
      label: "FLM",
      kind: "people",
      description: "Front-line manager — their own team of reps.",
      users: flms,
    },
    {
      id: "rep",
      label: "Rep",
      kind: "people",
      description: "Individual contributor — their own book of business.",
      users: reps,
    },
  ];
}

/**
 * Validate a { role, name } login request against the derived options and
 * return the identity to put in the session. Returns null when the pair is not
 * offered (unknown role, name not in that bucket, inactive person).
 */
export async function resolveDemoIdentity(
  role: string,
  name: string,
): Promise<DemoIdentity | null> {
  const options = await listDemoLoginOptions();
  const option = options.find((o) => o.id === role);
  if (!option || option.kind === "github") return null;

  const wanted = name.trim();
  const matched = option.users.find(
    (u) => u.toLowerCase() === wanted.toLowerCase(),
  );
  if (!matched) return null;

  const roleId = option.id as DemoIdentity["role"];
  const { firstName, lastName } = splitName(matched);
  return {
    id: demoUserId(roleId, matched),
    email: demoEmail(roleId, matched),
    firstName,
    lastName,
    role: roleId,
    // Exec and Admin are not hierarchy nodes: a null hierarchyName is exactly
    // what the live app gives an ADMIN_EMAILS / EXEC_EMAILS override user who
    // isn't in the sheet, and the role checks treat that as org-wide scope.
    hierarchyName: roleId === "exec" || roleId === "admin" ? null : matched,
  };
}

/** True for a demo identity whose DB writes must be session-scoped. */
export function isSessionScopedDemoUserId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(DEMO_SCOPED_ID_PREFIX);
}
