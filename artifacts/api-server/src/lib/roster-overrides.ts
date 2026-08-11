// Per-month roster overrides (Executive → Roster).
//
// One row per (month, person identity). Rows are keyed by a DURABLE identity
// (email -> employee ID -> canonical name; see sheets-data `personIdentityKey`)
// so an override survives feeder name variations. The `person` column holds the
// last-known display name only. Each editable field is nullable: NULL means "no
// override for this field" and the effective hierarchy (see sheets-data
// `fetchEffectiveHierarchy`) falls back to the base sheet value for that month.
// `active` is tri-state (NULL = use the sheet's Active flag, TRUE/FALSE force
// the person in/out). Overrides are strictly month-scoped and never carry
// forward across months.

import { db } from "@workspace/db";
import { rosterOverridesTable, type RosterOverride } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { compMonthKey } from "./compensation";

/** Canonicalize a month input to its `YYYY-MM` key, or `null` if invalid. */
export function canonicalRosterMonth(month: string): string | null {
  const key = compMonthKey(month);
  return key === "" ? null : key;
}

/** The override fields a single roster row can carry. `null` = no override. */
export interface RosterOverrideValues {
  active: boolean | null;
  flm: string | null;
  slm: string | null;
  region: string | null;
  segment: string | null;
  salesRole: string | null;
}

/** A patch from the API: only the present keys are written. */
export interface RosterOverridePatch {
  active?: boolean | null;
  flm?: string | null;
  slm?: string | null;
  region?: string | null;
  segment?: string | null;
  salesRole?: string | null;
}

/** All override rows for a month, keyed by durable person identity key. */
export async function getRosterOverridesForMonth(
  month: string,
): Promise<Map<string, RosterOverride>> {
  const key = canonicalRosterMonth(month);
  const out = new Map<string, RosterOverride>();
  if (!key) return out;
  const rows = await db
    .select()
    .from(rosterOverridesTable)
    .where(eq(rosterOverridesTable.monthYyyymm, key));
  for (const r of rows) out.set(r.identityKey, r);
  return out;
}

/**
 * Upsert a single (month, person-identity) roster override. `identityKey` is the
 * durable storage key (email/employeeId/name fallback); `person` is the display
 * name carried alongside for readability. Only the fields present in `patch` are
 * changed; omitted fields keep their stored value (or stay NULL). Trims string
 * fields and collapses empty strings to NULL so "clear this override"
 * round-trips cleanly.
 */
export async function upsertRosterOverride(
  month: string,
  identityKey: string,
  person: string,
  patch: RosterOverridePatch,
  updatedByName: string | null,
  updatedByRole: string | null,
): Promise<RosterOverride> {
  const key = canonicalRosterMonth(month) ?? month;
  const norm = (v: string | null | undefined): string | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const t = v.trim();
    return t === "" ? null : t;
  };

  const insertValues: typeof rosterOverridesTable.$inferInsert = {
    monthYyyymm: key,
    identityKey,
    person,
    active: patch.active ?? null,
    flm: norm(patch.flm) ?? null,
    slm: norm(patch.slm) ?? null,
    region: norm(patch.region) ?? null,
    segment: norm(patch.segment) ?? null,
    salesRole: norm(patch.salesRole) ?? null,
    updatedByName,
    updatedByRole,
  };

  const setOnConflict: Record<string, unknown> = {
    // Keep the display name fresh if the feeder renamed the same identity.
    person,
    updatedAt: sql`now()`,
    updatedByName,
    updatedByRole,
  };
  if ("active" in patch) setOnConflict.active = patch.active ?? null;
  if ("flm" in patch) setOnConflict.flm = norm(patch.flm) ?? null;
  if ("slm" in patch) setOnConflict.slm = norm(patch.slm) ?? null;
  if ("region" in patch) setOnConflict.region = norm(patch.region) ?? null;
  if ("segment" in patch) setOnConflict.segment = norm(patch.segment) ?? null;
  if ("salesRole" in patch) setOnConflict.salesRole = norm(patch.salesRole) ?? null;

  const [row] = await db
    .insert(rosterOverridesTable)
    .values(insertValues)
    .onConflictDoUpdate({
      target: [rosterOverridesTable.monthYyyymm, rosterOverridesTable.identityKey],
      set: setOnConflict,
    })
    .returning();
  return row;
}

/** Delete a single (month, person-identity) override row (full reset to base). */
export async function deleteRosterOverride(
  month: string,
  identityKey: string,
): Promise<void> {
  const key = canonicalRosterMonth(month) ?? month;
  await db
    .delete(rosterOverridesTable)
    .where(
      and(
        eq(rosterOverridesTable.monthYyyymm, key),
        eq(rosterOverridesTable.identityKey, identityKey),
      ),
    );
}
