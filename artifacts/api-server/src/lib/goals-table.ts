// Main Goals table model (Executive → Goals).
//
// Assembles the main Goals table: one row per non-SLM/FLM sales rep × month ×
// product across the five canonical products. Each row draws its base goals
// (MRR Added Goal, MRR Churn Goal, MRR Added Minimum, MRR Churn Maximum) from a
// chosen Source (finance.pps / Goal CSV / Software % Rules; default finance.pps)
// by delegating to the per-source resolvers (see goals-resolvers.ts). Per-row
// overrides (Source, manual multipliers, LOA status, eRep multiplier) are
// persisted in goal_row_overrides and merged onto the computed rows; the four
// Final goal columns are computed at read time.
//
// Out of scope (later tasks): the frontend, the live-dashboard cutover, and
// computing eRep/LOA from real inputs (defaults only here).

import { db } from "@workspace/db";
import {
  goalRowOverridesTable,
  GOAL_ROW_SOURCE_DEFAULT,
  GOAL_ROW_LOA_STATUS_DEFAULT,
  type GoalRowOverride,
} from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { fetchHierarchy, fetchEffectiveHierarchy } from "./sheets-data";
import { compMonthKey } from "./compensation";
import { getRoleGroupMapping, getSoftwareGnrRules, getSoftwareAcqRules } from "./goals-config";
import {
  buildRoleToGroup,
  hierarchyFieldValue,
  normalizeJoinValue,
  resolveGoals,
} from "./goals-resolvers";
import { getErepSnapshot, erepMultipliersForMonth } from "./goals-erep";
import {
  GOAL_PRODUCTS,
  emptyGoalMetrics,
  type GoalMetrics,
  type GoalProduct,
  type GoalSourceId,
  type ResolvedGoals,
} from "./goals-types";

type Hierarchy = Awaited<ReturnType<typeof fetchHierarchy>>;

export const GOAL_SOURCE_IDS: readonly GoalSourceId[] = [
  "financePps",
  "goalCsv",
  "softwareGnr",
  "softwareAcq",
] as const;

export function isGoalSourceId(v: unknown): v is GoalSourceId {
  return typeof v === "string" && (GOAL_SOURCE_IDS as readonly string[]).includes(v);
}

/**
 * Canonicalize a month input to its `YYYY-MM` key, or `null` if it is not a
 * valid month. Every read and write keys overrides by this exact value so a
 * non-canonical input (e.g. `2026-06-15`, `2026/06`) can never persist under a
 * key the table reader won't find.
 */
export function canonicalMonth(month: string): string | null {
  const key = compMonthKey(month);
  return key === "" ? null : key;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** The dashboard filter set the Goals table is scoped by. `month` is required
 *  (resolved to a YYYY-MM key); the rest are optional narrowing filters. */
export interface GoalTableFilter {
  month: string;
  slm?: string;
  flm?: string;
  reps?: string[];
  regions?: string[];
  /** Canonical product names to scope to. Honored only by bulk-source target
   *  enumeration; the read path (enumerateReps) ignores it and the client
   *  narrows products in displayRows. Empty/undefined means all products. */
  products?: string[];
  /** Task #484: when true, force every row's effective eRep multiplier to 1,
   *  bypassing both the manual override and the Databricks-sourced value. Used
   *  only by the dashboard/pipeline "eReps Override" toggle — the Executive
   *  Goals tab read path never sets this, so it keeps standard eRep logic. */
  eRepOverride?: boolean;
}

function eqi(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

function includesi(list: string[] | undefined, value: string): boolean {
  if (!list || list.length === 0) return true;
  const v = value.trim().toLowerCase();
  return list.some((x) => x.trim().toLowerCase() === v);
}

/**
 * Whether a rep passes the (non-month) dashboard filters. Pure: takes the
 * rep's already-resolved slm/flm/region so it is testable without a hierarchy.
 */
export function repPassesFilter(
  rep: { slm: string | null; flm: string | null; name: string; region: string },
  filter: GoalTableFilter,
): boolean {
  if (filter.slm && filter.slm.trim() !== "" && !eqi(rep.slm, filter.slm)) return false;
  if (filter.flm && filter.flm.trim() !== "" && !eqi(rep.flm, filter.flm)) return false;
  if (!includesi(filter.reps, rep.name)) return false;
  if (!includesi(filter.regions, rep.region)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Per-row override values + defaults
// ---------------------------------------------------------------------------

export interface GoalRowOverrideValues {
  source: GoalSourceId;
  mrrAddedManualMultiplier: number;
  mrrChurnManualMultiplier: number;
  loaStatus: string;
  /** Per-row MANUAL eRep override. NULL means "use the Databricks-sourced eRep
   *  value" (see resolveEffectiveERep). */
  eRepManualMultiplier: number | null;
}

export function defaultOverrideValues(): GoalRowOverrideValues {
  return {
    source: GOAL_ROW_SOURCE_DEFAULT,
    mrrAddedManualMultiplier: 1,
    mrrChurnManualMultiplier: 1,
    loaStatus: GOAL_ROW_LOA_STATUS_DEFAULT,
    eRepManualMultiplier: null,
  };
}

/** Merge a persisted override row (if any) onto the code defaults. */
export function mergeOverrideValues(row: GoalRowOverride | undefined): GoalRowOverrideValues {
  const d = defaultOverrideValues();
  if (!row) return d;
  return {
    source: isGoalSourceId(row.source) ? row.source : d.source,
    mrrAddedManualMultiplier: row.mrrAddedManualMultiplier,
    mrrChurnManualMultiplier: row.mrrChurnManualMultiplier,
    loaStatus: row.loaStatus,
    eRepManualMultiplier: row.eRepMultiplier,
  };
}

/**
 * The effective eRep multiplier applied to a row's goals: the manual override
 * wins, else the Databricks-sourced value, else the neutral 1.0. Both inputs
 * may be null (no manual override / no Databricks value for this rep+month).
 */
export function resolveEffectiveERep(
  manual: number | null,
  databricks: number | null,
): number {
  return manual ?? databricks ?? 1;
}

// ---------------------------------------------------------------------------
// Final math
// ---------------------------------------------------------------------------

export interface FinalGoals {
  finalMrrAddedGoal: number;
  finalChurnGoal: number;
  finalMrrMinGoal: number;
  finalChurnMaxGoal: number;
}

/**
 * The four Final goal columns:
 *   Final MRR Added Goal = AddedManual × eRep × MRR Added Goal
 *   Final Churn Goal     = ChurnManual × eRep × MRR Churn Goal
 *   Final MRR Min Goal   = eRep × MRR Added Minimum
 *   Final Churn Max Goal = eRep × MRR Churn Maximum
 */
export function computeFinalGoals(
  base: GoalMetrics,
  ov: { mrrAddedManualMultiplier: number; mrrChurnManualMultiplier: number; eRepMultiplier: number },
): FinalGoals {
  return {
    finalMrrAddedGoal: ov.mrrAddedManualMultiplier * ov.eRepMultiplier * base.mrrAddedGoal,
    finalChurnGoal: ov.mrrChurnManualMultiplier * ov.eRepMultiplier * base.mrrChurnGoal,
    finalMrrMinGoal: ov.eRepMultiplier * base.mrrAddedMinimum,
    finalChurnMaxGoal: ov.eRepMultiplier * base.mrrChurnMaximum,
  };
}

// ---------------------------------------------------------------------------
// Team-size split (team-level goal sources)
// ---------------------------------------------------------------------------

/**
 * Team key for the goal-team split: Channel (group) + Region + Segment,
 * case-insensitively normalized. Product is intentionally NOT part of the key —
 * a rep belongs to exactly one team regardless of how many products they carry.
 */
export function teamKeyFor(group: string, region: string, segment: string): string {
  return [group, region, segment].map((s) => (s ?? "").trim().toLowerCase()).join("\u0000");
}

/**
 * Count the distinct reps in each (group, region, segment) team. Must be fed the
 * FULL rep set (unfiltered) so the divisor is the real team size — dividing by a
 * dashboard-filtered count would inflate each rep's share.
 */
export function computeTeamSizes(
  reps: Array<{ name: string; group: string; region: string; segment: string }>,
): Map<string, number> {
  const members = new Map<string, Set<string>>();
  for (const r of reps) {
    const key = teamKeyFor(r.group, r.region, r.segment);
    let set = members.get(key);
    if (!set) {
      set = new Set();
      members.set(key, set);
    }
    set.add(r.name.trim().toLowerCase());
  }
  const sizes = new Map<string, number>();
  for (const [key, set] of members) sizes.set(key, set.size);
  return sizes;
}

/**
 * Whether a row's source states goals at the team level (so they must be split
 * across the team). The Goal CSV is always team-level; each Software % rule set
 * (GNR / ACQ) is team-level only when its own sub-source is the Goal CSV.
 * finance.pps is already mapped per individual rep and is never divided.
 */
export function sourceDividesByTeam(
  source: GoalSourceId,
  softwareSubSources: Partial<Record<GoalSourceId, "financePps" | "goalCsv" | null>>,
): boolean {
  if (source === "goalCsv") return true;
  if (source === "softwareGnr" || source === "softwareAcq") {
    return softwareSubSources[source] === "goalCsv";
  }
  return false;
}

/**
 * Divide each base goal metric evenly across the team. Guards divide-by-zero:
 * a team size of 0 or 1 leaves the base untouched.
 */
export function applyTeamSplit(base: GoalMetrics, teamSize: number): GoalMetrics {
  if (teamSize <= 1) return base;
  return {
    mrrAddedGoal: base.mrrAddedGoal / teamSize,
    mrrChurnGoal: base.mrrChurnGoal / teamSize,
    mrrAddedMinimum: base.mrrAddedMinimum / teamSize,
    mrrChurnMaximum: base.mrrChurnMaximum / teamSize,
  };
}

// ---------------------------------------------------------------------------
// Assembled row shape
// ---------------------------------------------------------------------------

export interface GoalTableRow {
  // Hierarchy attributes
  month: string;
  group: string;
  rep: string;
  employeeId: string;
  salesRole: string;
  slm: string;
  flm: string;
  region: string;
  segment: string;
  /** Distinct reps sharing this rep's Channel (group) + Region + Segment.
   *  Team-level goal sources are divided by this so each rep gets a fair share. */
  teamSize: number;
  product: GoalProduct;
  // Source + base goals (already divided by teamSize for team-level sources)
  source: GoalSourceId;
  mrrAddedGoal: number;
  mrrChurnGoal: number;
  mrrAddedMinimum: number;
  mrrChurnMaximum: number;
  // Per-row overrides
  mrrAddedManualMultiplier: number;
  mrrChurnManualMultiplier: number;
  loaStatus: string;
  /** Per-row MANUAL eRep override, or null when none is set. */
  eRepManualMultiplier: number | null;
  /** Databricks-sourced eRep value for this rep+month, or null when none. */
  eRepDatabricksMultiplier: number | null;
  /** Effective eRep used in the Final columns = manual ?? databricks ?? 1.0. */
  eRepMultiplier: number;
  // Final columns
  finalMrrAddedGoal: number;
  finalChurnGoal: number;
  finalMrrMinGoal: number;
  finalChurnMaxGoal: number;
}

// ---------------------------------------------------------------------------
// Override store
// ---------------------------------------------------------------------------

export async function getOverridesForMonth(month: string): Promise<GoalRowOverride[]> {
  return db.select().from(goalRowOverridesTable).where(eq(goalRowOverridesTable.monthYyyymm, month));
}

export function overrideKey(month: string, rep: string, product: string): string {
  return `${month}\u0000${rep}\u0000${product}`;
}

export interface UpsertOverrideInput {
  month: string;
  rep: string;
  product: GoalProduct;
  source?: GoalSourceId;
  mrrAddedManualMultiplier?: number;
  mrrChurnManualMultiplier?: number;
  loaStatus?: string;
  /** Manual eRep override. `undefined` = leave unchanged; `null` = clear back to
   *  the Databricks-sourced value; a number = set the manual override. */
  eRepMultiplier?: number | null;
}

/**
 * Upsert a single per-row override. Only the provided fields are changed; the
 * rest fall back to the existing row or the code defaults on insert.
 */
export async function upsertRowOverride(
  input: UpsertOverrideInput,
  updatedByName: string | null,
  updatedByRole: string | null,
): Promise<GoalRowOverride> {
  const d = defaultOverrideValues();
  const insertValues = {
    monthYyyymm: canonicalMonth(input.month) ?? input.month,
    rep: input.rep,
    product: input.product,
    source: input.source ?? d.source,
    mrrAddedManualMultiplier: input.mrrAddedManualMultiplier ?? d.mrrAddedManualMultiplier,
    mrrChurnManualMultiplier: input.mrrChurnManualMultiplier ?? d.mrrChurnManualMultiplier,
    loaStatus: input.loaStatus ?? d.loaStatus,
    // Manual override is nullable: `undefined` (not provided) inserts NULL so the
    // Databricks value drives the row; an explicit number/null is stored as-is.
    eRepMultiplier: input.eRepMultiplier === undefined ? null : input.eRepMultiplier,
    updatedByName,
    updatedByRole,
  };

  // Only overwrite columns that were explicitly provided so a partial edit
  // never clobbers another column back to its default.
  const setOnConflict: Record<string, unknown> = { updatedAt: sql`now()`, updatedByName, updatedByRole };
  if (input.source !== undefined) setOnConflict.source = input.source;
  if (input.mrrAddedManualMultiplier !== undefined) setOnConflict.mrrAddedManualMultiplier = input.mrrAddedManualMultiplier;
  if (input.mrrChurnManualMultiplier !== undefined) setOnConflict.mrrChurnManualMultiplier = input.mrrChurnManualMultiplier;
  if (input.loaStatus !== undefined) setOnConflict.loaStatus = input.loaStatus;
  if (input.eRepMultiplier !== undefined) setOnConflict.eRepMultiplier = input.eRepMultiplier;

  const [row] = await db
    .insert(goalRowOverridesTable)
    .values(insertValues)
    .onConflictDoUpdate({
      target: [goalRowOverridesTable.monthYyyymm, goalRowOverridesTable.rep, goalRowOverridesTable.product],
      set: setOnConflict,
    })
    .returning();
  return row;
}

/**
 * Bulk-set the Source for every (rep, product) in `targets` for a month,
 * preserving any other per-row override values already stored.
 */
export async function bulkSetRowSource(
  month: string,
  targets: Array<{ rep: string; product: GoalProduct }>,
  source: GoalSourceId,
  updatedByName: string | null,
  updatedByRole: string | null,
): Promise<number> {
  if (targets.length === 0) return 0;
  const monthKey = canonicalMonth(month) ?? month;
  const d = defaultOverrideValues();
  const values = targets.map((t) => ({
    monthYyyymm: monthKey,
    rep: t.rep,
    product: t.product,
    source,
    mrrAddedManualMultiplier: d.mrrAddedManualMultiplier,
    mrrChurnManualMultiplier: d.mrrChurnManualMultiplier,
    loaStatus: d.loaStatus,
    eRepMultiplier: null,
    updatedByName,
    updatedByRole,
  }));
  await db
    .insert(goalRowOverridesTable)
    .values(values)
    .onConflictDoUpdate({
      target: [goalRowOverridesTable.monthYyyymm, goalRowOverridesTable.rep, goalRowOverridesTable.product],
      set: { source, updatedAt: sql`now()`, updatedByName, updatedByRole },
    });
  return targets.length;
}

// ---------------------------------------------------------------------------
// Row enumeration + assembly
// ---------------------------------------------------------------------------

interface EnumeratedRep {
  name: string;
  employeeId: string;
  salesRole: string;
  slm: string;
  flm: string;
  region: string;
  segment: string;
  group: string;
}

/** Enumerate the non-SLM/FLM reps that pass the filter, with their attrs. */
function enumerateReps(
  hierarchy: Hierarchy,
  roleToGroup: Map<string, string>,
  filter: GoalTableFilter,
): EnumeratedRep[] {
  const out: EnumeratedRep[] = [];
  for (const p of hierarchy.people) {
    if (p.role !== "rep") continue;
    const region = hierarchy.repToRegion[p.name] ?? "";
    if (!repPassesFilter({ slm: p.slm, flm: p.flm, name: p.name, region }, filter)) continue;
    out.push({
      name: p.name,
      employeeId: hierarchy.personToEmployeeId[p.name] ?? "",
      salesRole: hierarchy.repToSalesRole[p.name] ?? "",
      slm: p.slm ?? "",
      flm: p.flm ?? "",
      region,
      segment: hierarchy.repToSegment[p.name] ?? "",
      group: hierarchyFieldValue(p.name, hierarchy, roleToGroup, "Group"),
    });
  }
  return out;
}

/** The (rep, product) targets in the current filter set — used by bulk source. */
export async function enumerateGoalRowTargets(
  filter: GoalTableFilter,
): Promise<Array<{ rep: string; product: GoalProduct }>> {
  const month = canonicalMonth(filter.month) ?? filter.month;
  const [hierarchy, roleMapping] = await Promise.all([
    fetchEffectiveHierarchy(month),
    getRoleGroupMapping(),
  ]);
  const roleToGroup = buildRoleToGroup(roleMapping);
  const reps = enumerateReps(hierarchy, roleToGroup, { ...filter, month });
  const productFilter =
    filter.products && filter.products.length
      ? new Set(filter.products.map((p) => p.trim().toLowerCase()))
      : null;
  const products = productFilter
    ? GOAL_PRODUCTS.filter((p) => productFilter.has(p.toLowerCase()))
    : GOAL_PRODUCTS;
  const targets: Array<{ rep: string; product: GoalProduct }> = [];
  for (const r of reps) for (const product of products) targets.push({ rep: r.name, product });
  return targets;
}

/** Build the full main Goals table for the filter set. */
export async function buildGoalTable(filter: GoalTableFilter): Promise<{
  month: string;
  rows: GoalTableRow[];
}> {
  const month = canonicalMonth(filter.month) ?? filter.month;
  const scoped: GoalTableFilter = { ...filter, month };

  const [hierarchy, roleMapping, overrideRows, erepSnapshot] = await Promise.all([
    fetchEffectiveHierarchy(month),
    getRoleGroupMapping(),
    getOverridesForMonth(month),
    // Databricks-sourced eRep values; falls back to its persisted snapshot on
    // failure and never blocks the table (an empty map → effective eRep 1.0).
    getErepSnapshot().catch(() => null),
  ]);
  const roleToGroup = buildRoleToGroup(roleMapping);
  const erepByEmployee = erepSnapshot
    ? erepMultipliersForMonth(erepSnapshot, month)
    : new Map<string, number>();
  // Team sizes must come from the FULL rep set so a filtered view never shrinks
  // the divisor; the visible reps are then a subset of that full enumeration.
  const allReps = enumerateReps(hierarchy, roleToGroup, { month });
  const teamSizeByKey = computeTeamSizes(allReps);
  const reps = allReps.filter((r) =>
    repPassesFilter({ slm: r.slm, flm: r.flm, name: r.name, region: r.region }, scoped),
  );

  const overrideByKey = new Map<string, GoalRowOverride>();
  for (const o of overrideRows) overrideByKey.set(overrideKey(month, o.rep, o.product), o);

  // Determine which sources are actually referenced, then resolve each once.
  const neededSources = new Set<GoalSourceId>();
  for (const r of reps) {
    for (const product of GOAL_PRODUCTS) {
      const ov = overrideByKey.get(overrideKey(month, r.name, product));
      neededSources.add(ov && isGoalSourceId(ov.source) ? ov.source : GOAL_ROW_SOURCE_DEFAULT);
    }
  }
  const resolvedBySource = new Map<GoalSourceId, ResolvedGoals>();
  await Promise.all(
    [...neededSources].map(async (s) => {
      resolvedBySource.set(s, await resolveGoals(s, month));
    }),
  );

  // Each Software % rule set (GNR / ACQ) may state goals at the team level
  // (sub-source goalCsv) or per individual rep (sub-source financePps). Fetch
  // each needed sub-source once so the row build knows whether its rows need
  // the team-size split.
  const softwareSubSources: Partial<
    Record<GoalSourceId, "financePps" | "goalCsv" | null>
  > = {};
  if (neededSources.has("softwareGnr")) {
    softwareSubSources.softwareGnr = (await getSoftwareGnrRules()).subSource;
  }
  if (neededSources.has("softwareAcq")) {
    softwareSubSources.softwareAcq = (await getSoftwareAcqRules()).subSource;
  }

  const rows: GoalTableRow[] = [];
  for (const r of reps) {
    const teamSize = teamSizeByKey.get(teamKeyFor(r.group, r.region, r.segment)) ?? 0;
    for (const product of GOAL_PRODUCTS) {
      const ov = mergeOverrideValues(overrideByKey.get(overrideKey(month, r.name, product)));
      const resolved = resolvedBySource.get(ov.source);
      const rawBase = resolved?.[r.name]?.[product] ?? emptyGoalMetrics();
      // Divide team-level base goals evenly across the team BEFORE the multipliers.
      const base = sourceDividesByTeam(ov.source, softwareSubSources)
        ? applyTeamSplit(rawBase, teamSize)
        : rawBase;
      const eRepDatabricksMultiplier =
        erepByEmployee.get(normalizeJoinValue(r.employeeId)) ?? null;
      // Task #484: the "eReps Override" toggle forces the effective multiplier
      // to a neutral 1, ignoring both the manual override and the Databricks
      // value. The raw eRepManualMultiplier / eRepDatabricksMultiplier columns
      // are still surfaced unchanged for display; only the Final math changes.
      const eRepMultiplier = scoped.eRepOverride
        ? 1
        : resolveEffectiveERep(ov.eRepManualMultiplier, eRepDatabricksMultiplier);
      const final = computeFinalGoals(base, { ...ov, eRepMultiplier });
      rows.push({
        month,
        group: r.group,
        rep: r.name,
        employeeId: r.employeeId,
        salesRole: r.salesRole,
        slm: r.slm,
        flm: r.flm,
        region: r.region,
        segment: r.segment,
        teamSize,
        product,
        source: ov.source,
        mrrAddedGoal: base.mrrAddedGoal,
        mrrChurnGoal: base.mrrChurnGoal,
        mrrAddedMinimum: base.mrrAddedMinimum,
        mrrChurnMaximum: base.mrrChurnMaximum,
        mrrAddedManualMultiplier: ov.mrrAddedManualMultiplier,
        mrrChurnManualMultiplier: ov.mrrChurnManualMultiplier,
        loaStatus: ov.loaStatus,
        eRepManualMultiplier: ov.eRepManualMultiplier,
        eRepDatabricksMultiplier,
        eRepMultiplier,
        ...final,
      });
    }
  }

  return { month, rows };
}
