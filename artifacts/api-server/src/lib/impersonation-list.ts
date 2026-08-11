import type { SheetPerson } from "./sheets-data";

export interface DbUserLite {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
  role: string | null;
  hierarchyName: string | null;
}

export type ImpersonationSource = "db+sheet" | "sheet-only" | "db-only";

export interface ImpersonationListEntry {
  // For db-backed entries this is the real DB user id (used for impersonation).
  // For sheet-only entries it's a virtual id of the form `org:<email>` or
  // `org:eid:<employeeId>` so the menu still has a stable key.
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
  // Role for menu display. For matched/sheet-only rows this is the sheet
  // role (slm > flm > rep). For db-only rows it's whatever the DB has.
  role: string | null;
  // Canonical hierarchy name. From the sheet for matched/sheet-only rows;
  // from the DB for db-only rows.
  hierarchyName: string | null;
  slm: string | null;
  flm: string | null;
  source: ImpersonationSource;
}

const ROLE_RANK: Record<string, number> = { slm: 0, flm: 1, rep: 2 };

function splitName(fullName: string): { firstName: string | null; lastName: string | null } {
  const trimmed = (fullName || "").trim();
  if (!trimmed) return { firstName: null, lastName: null };
  const idx = trimmed.indexOf(" ");
  if (idx < 0) return { firstName: trimmed, lastName: null };
  return {
    firstName: trimmed.slice(0, idx),
    lastName: trimmed.slice(idx + 1).trim() || null,
  };
}

function lower(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  return t || null;
}

function virtualId(person: SheetPerson): string {
  if (person.email) return `org:${person.email}`;
  if (person.employeeId) return `org:eid:${person.employeeId}`;
  // Last-resort fallback so the menu still has a stable React key.
  return `org:name:${person.name}`;
}

function compareEntries(a: ImpersonationListEntry, b: ImpersonationListEntry): number {
  const ra = ROLE_RANK[a.role ?? ""] ?? 99;
  const rb = ROLE_RANK[b.role ?? ""] ?? 99;
  if (ra !== rb) return ra - rb;
  const an = (a.hierarchyName ?? `${a.firstName ?? ""} ${a.lastName ?? ""}`).trim().toLowerCase();
  const bn = (b.hierarchyName ?? `${b.firstName ?? ""} ${b.lastName ?? ""}`).trim().toLowerCase();
  return an.localeCompare(bn);
}

/**
 * Merge the sheet identity index with the DB users into a single deduped
 * impersonation list.
 *
 * Rules:
 * - Match a DB user to a sheet person by lowercased email.
 * - When matched: use the DB id, name, and photo (so impersonation targets
 *   the real account) but the sheet's role and hierarchyName (so a stale
 *   `users.role` or `users.hierarchy_name` doesn't split the row in two).
 * - Sheet-only people (no DB account) get a virtual id `org:<email>` or
 *   `org:eid:<id>` so they're still listed.
 * - DB users with no sheet match (e.g. a signed-in user who isn't in the
 *   org sheet yet) land in a final "Unmatched" group at the bottom.
 *
 * Sort: SLM → FLM → Rep then alphabetical, with the Unmatched group at the
 * end (also alphabetical).
 */
export function buildImpersonationList(
  people: SheetPerson[],
  dbUsers: DbUserLite[],
): ImpersonationListEntry[] {
  const dbByEmail = new Map<string, DbUserLite>();
  for (const u of dbUsers) {
    const key = lower(u.email);
    if (key && !dbByEmail.has(key)) dbByEmail.set(key, u);
  }

  const matchedDbIds = new Set<string>();
  const matchedAndSheetOnly: ImpersonationListEntry[] = [];

  for (const person of people) {
    // Normalize at lookup time too — sheet emails are already lowercased
    // upstream, but defending in-layer keeps the merge correct even if a
    // future caller passes raw sheet input.
    const personEmailKey = lower(person.email);
    const dbUser = personEmailKey ? dbByEmail.get(personEmailKey) : undefined;
    if (dbUser) {
      matchedDbIds.add(dbUser.id);
      matchedAndSheetOnly.push({
        id: dbUser.id,
        email: dbUser.email ?? person.email,
        firstName: dbUser.firstName,
        lastName: dbUser.lastName,
        profileImageUrl: dbUser.profileImageUrl,
        role: person.role,
        hierarchyName: person.name,
        slm: person.slm,
        flm: person.flm,
        source: "db+sheet",
      });
    } else {
      const { firstName, lastName } = splitName(person.name);
      matchedAndSheetOnly.push({
        id: virtualId(person),
        email: person.email,
        firstName,
        lastName,
        profileImageUrl: null,
        role: person.role,
        hierarchyName: person.name,
        slm: person.slm,
        flm: person.flm,
        source: "sheet-only",
      });
    }
  }

  matchedAndSheetOnly.sort(compareEntries);

  const unmatched: ImpersonationListEntry[] = [];
  for (const u of dbUsers) {
    if (matchedDbIds.has(u.id)) continue;
    unmatched.push({
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      profileImageUrl: u.profileImageUrl,
      role: u.role,
      hierarchyName: u.hierarchyName,
      slm: null,
      flm: null,
      source: "db-only",
    });
  }
  const sortKey = (e: ImpersonationListEntry): string => {
    const fallback = `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim();
    return (e.hierarchyName || fallback || e.email || "").toLowerCase();
  };
  unmatched.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  return [...matchedAndSheetOnly, ...unmatched];
}
