// Per-source goal resolvers (Executive → Goals).
//
// Each resolver turns one goal source into a per-rep, per-product goal set for
// a given month (MRR Added Goal, MRR Churn Goal, MRR Added Minimum, MRR Churn
// Maximum) across the five canonical products. Products/metrics a source does
// not populate resolve to zero (absent from the map). This task builds the
// resolvers only; the main Goals table assembly and final-goal math are later.
//
// The pure transformation pieces (normalization, join-key building, row
// mapping, CSV summing, software split) are exported separately so they can be
// unit-tested without the Databricks / Sheets / DB dependencies.

import { fetchHierarchy, fetchEffectiveHierarchy } from "./sheets-data";
import { compMonthKey } from "./compensation";
import {
  getFinancePpsJoinFields,
  getFinancePpsOutputMapping,
  getGoalCsvJoinFields,
  getGoalCsvOutputMapping,
  getGoalCsvProductColumn,
  getGoalCsvProductValueMapping,
  getRoleGroupMapping,
  getSoftwareGnrRules,
  getSoftwareAcqRules,
} from "./goals-config";
import { getFinancePpsSnapshot } from "./goals-finance-pps";
import { getGoalCsvRows } from "./goals-csv";
import {
  GOAL_METRIC_KEYS,
  SOFTWARE_PRODUCTS,
  emptyGoalMetrics,
  type FinancePpsOutputMapEntry,
  type GoalCsvProductValueEntry,
  type GoalMetricKey,
  type GoalMetrics,
  type GoalProduct,
  type GoalSourceId,
  type HierarchyJoinField,
  type ResolvedGoals,
  type RoleGroupMapEntry,
  type SoftwarePctRules,
} from "./goals-types";
import type { GoalCsvRow } from "@workspace/db/schema";

type Hierarchy = Awaited<ReturnType<typeof fetchHierarchy>>;

const JOIN_SEP = "\u0000";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Normalize a join value: trim, lowercase, and strip leading zeros from
 *  all-digit values so employee ids match regardless of zero-padding. */
export function normalizeJoinValue(v: string | undefined | null): string {
  if (v == null) return "";
  let s = String(v).trim().toLowerCase();
  if (/^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, "");
  return s;
}

/** Parse a possibly-formatted numeric cell ($, %, commas, parens) to a number. */
export function parseGoalNumber(raw: string | number | undefined | null): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (raw == null) return 0;
  const cleaned = String(raw).replace(/[$,%\s]/g, "").trim();
  if (cleaned === "") return 0;
  const neg = /^\((.*)\)$/.exec(cleaned);
  const n = parseFloat(neg ? `-${neg[1]}` : cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** Build a join key from normalized parts; returns null if any part is empty. */
export function buildJoinKey(values: Array<string | undefined | null>): string | null {
  const parts = values.map(normalizeJoinValue);
  if (parts.some((p) => p === "")) return null;
  return parts.join(JOIN_SEP);
}

/** Resolve a hierarchy-side join field value for a person. */
export function hierarchyFieldValue(
  name: string,
  h: Hierarchy,
  roleToGroup: Map<string, string>,
  field: HierarchyJoinField,
): string {
  switch (field) {
    case "Employee Number":
      return h.personToEmployeeId[name] ?? "";
    case "Group": {
      const role = (h.repToSalesRole[name] ?? "").trim().toLowerCase();
      return roleToGroup.get(role) ?? "";
    }
    case "Region":
      return h.repToRegion[name] ?? "";
    case "Segment":
      return h.repToSegment[name] ?? "";
    case "Name":
      return name;
  }
}

export function buildRoleToGroup(mapping: RoleGroupMapEntry[]): Map<string, string> {
  return new Map(mapping.map((e) => [e.salesRole.trim().toLowerCase(), e.group]));
}

/** Read a Goal CSV column value by name. Month/Group/Region/Segment use the
 *  denormalized columns; any other header is read from the raw `data` map
 *  (case-insensitive). Returns "" when the column is absent. */
export function csvJoinValue(row: GoalCsvRow, csvField: string): string {
  switch (csvField.trim().toLowerCase()) {
    case "month":
      return row.month;
    case "group":
      return row.group;
    case "region":
      return row.region;
    case "segment":
      return row.segment;
  }
  const want = csvField.trim().toLowerCase();
  const data = row.data as Record<string, string> | null;
  if (data) {
    for (const [k, v] of Object.entries(data)) {
      if (k.trim().toLowerCase() === want) return v ?? "";
    }
  }
  return "";
}

/** Look up a Goal CSV numeric cell by its column header (used by both the Goal
 *  CSV output mapping and the Software % Rules Goal CSV sub-source). */
export function csvCellByHeader(row: GoalCsvRow, header: string): number {
  return parseGoalNumber(csvJoinValue(row, header));
}

/** Map one finance.pps row to per-product metrics via the output mapping. */
export function mapFinanceRowToProducts(
  row: Record<string, string>,
  outputMapping: FinancePpsOutputMapEntry[],
): Partial<Record<GoalProduct, GoalMetrics>> {
  const products: Partial<Record<GoalProduct, GoalMetrics>> = {};
  for (const m of outputMapping) {
    const metrics = (products[m.product] ??= emptyGoalMetrics());
    metrics[m.metric] = parseGoalNumber(row[m.column]);
  }
  return products;
}

/** Sum the matched Goal CSV rows into per-product metrics via the output
 *  mapping, scoping each row to the single product whose mapped value equals
 *  that row's Product-column value.
 *
 *  The Goal CSV uses one shared set of metric columns; rows are distinguished
 *  by a Product column. A row therefore contributes ONLY to the dashboard
 *  product whose configured value matches the row's Product-column value, and
 *  only through that product's output-mapping entries. When no Product column
 *  is configured we fail safe and attribute nothing (rather than summing every
 *  row into every product). */
export function mapCsvRowsToProducts(
  rows: GoalCsvRow[],
  outputMapping: FinancePpsOutputMapEntry[],
  productColumn: string,
  productValueMapping: GoalCsvProductValueEntry[],
): Partial<Record<GoalProduct, GoalMetrics>> {
  const products: Partial<Record<GoalProduct, GoalMetrics>> = {};
  if (!productColumn || !productColumn.trim()) return products;

  // value (normalized) → dashboard product.
  const valueToProduct = new Map<string, GoalProduct>();
  for (const e of productValueMapping) {
    const v = e.value.trim().toLowerCase();
    if (v) valueToProduct.set(v, e.product);
  }
  if (valueToProduct.size === 0) return products;

  for (const r of rows) {
    const rowValue = csvJoinValue(r, productColumn).trim().toLowerCase();
    const rowProduct = valueToProduct.get(rowValue);
    if (!rowProduct) continue;
    for (const m of outputMapping) {
      if (m.product !== rowProduct) continue;
      const metrics = (products[rowProduct] ??= emptyGoalMetrics());
      metrics[m.metric] += csvCellByHeader(r, m.column);
    }
  }
  return products;
}

function metricsAllZero(m: GoalMetrics): boolean {
  return GOAL_METRIC_KEYS.every((k) => m[k] === 0);
}

/** Split per-rep raw software totals across the software products by percentage. */
export function splitSoftwareTotals(
  raw: Record<GoalMetricKey, number>,
  rules: SoftwarePctRules,
): Partial<Record<GoalProduct, GoalMetrics>> {
  const products: Partial<Record<GoalProduct, GoalMetrics>> = {};
  for (const product of SOFTWARE_PRODUCTS) {
    const pct = (rules.percentages[product] ?? 0) / 100;
    products[product] = {
      mrrAddedGoal: raw.mrrAddedGoal * pct,
      mrrChurnGoal: raw.mrrChurnGoal * pct,
      mrrAddedMinimum: raw.mrrAddedMinimum * pct,
      mrrChurnMaximum: raw.mrrChurnMaximum * pct,
    };
  }
  return products;
}

function monthMatches(rowMonth: string | undefined, targetMonth: string): boolean {
  if (!rowMonth) return false;
  const k = compMonthKey(rowMonth);
  if (k) return k === targetMonth;
  return rowMonth.trim().toLowerCase() === targetMonth.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// finance.pps resolver
// ---------------------------------------------------------------------------

/** Build a per-person lookup of the matching finance.pps row for a month. */
async function buildFinanceLookup(targetMonth: string): Promise<{
  hierarchy: Hierarchy;
  rowFor: (name: string) => Record<string, string> | null;
}> {
  const [hierarchy, snapshot, joinFields, roleMapping] = await Promise.all([
    fetchEffectiveHierarchy(targetMonth),
    getFinancePpsSnapshot(),
    getFinancePpsJoinFields(),
    getRoleGroupMapping(),
  ]);
  const roleToGroup = buildRoleToGroup(roleMapping);

  const rowByKey = new Map<string, Record<string, string>>();
  for (const r of snapshot.rows) {
    if (compMonthKey(r["Performance Period"] ?? "") !== targetMonth) continue;
    const key = buildJoinKey(joinFields.map((f) => r[f.financePps]));
    if (key !== null) rowByKey.set(key, r);
  }

  return {
    hierarchy,
    rowFor: (name: string) => {
      const key = buildJoinKey(
        joinFields.map((f) => hierarchyFieldValue(name, hierarchy, roleToGroup, f.hierarchy)),
      );
      if (key === null) return null;
      return rowByKey.get(key) ?? null;
    },
  };
}

export async function resolveFinancePpsGoals(month: string): Promise<ResolvedGoals> {
  const targetMonth = compMonthKey(month) || month;
  const [{ hierarchy, rowFor }, outputMapping] = await Promise.all([
    buildFinanceLookup(targetMonth),
    getFinancePpsOutputMapping(),
  ]);

  const out: ResolvedGoals = {};
  for (const p of hierarchy.people) {
    const row = rowFor(p.name);
    if (!row) continue;
    const products = mapFinanceRowToProducts(row, outputMapping);
    if (Object.keys(products).length > 0) out[p.name] = products;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Goal CSV resolver
// ---------------------------------------------------------------------------

async function buildCsvLookup(targetMonth: string): Promise<{
  hierarchy: Hierarchy;
  rowsFor: (name: string) => GoalCsvRow[];
}> {
  const [hierarchy, allRows, joinFields, roleMapping] = await Promise.all([
    fetchEffectiveHierarchy(targetMonth),
    getGoalCsvRows(),
    getGoalCsvJoinFields(),
    getRoleGroupMapping(),
  ]);
  const roleToGroup = buildRoleToGroup(roleMapping);

  const rowsByKey = new Map<string, GoalCsvRow[]>();
  for (const r of allRows) {
    if (!monthMatches(r.month, targetMonth)) continue;
    const key = buildJoinKey(joinFields.map((f) => csvJoinValue(r, f.csv)));
    if (key === null) continue;
    const list = rowsByKey.get(key);
    if (list) list.push(r);
    else rowsByKey.set(key, [r]);
  }

  return {
    hierarchy,
    rowsFor: (name: string) => {
      const key = buildJoinKey(
        joinFields.map((f) => hierarchyFieldValue(name, hierarchy, roleToGroup, f.hierarchy)),
      );
      if (key === null) return [];
      return rowsByKey.get(key) ?? [];
    },
  };
}

export async function resolveGoalCsvGoals(month: string): Promise<ResolvedGoals> {
  const targetMonth = compMonthKey(month) || month;
  const [{ hierarchy, rowsFor }, outputMapping, productColumn, productValueMapping] =
    await Promise.all([
      buildCsvLookup(targetMonth),
      getGoalCsvOutputMapping(),
      getGoalCsvProductColumn(),
      getGoalCsvProductValueMapping(),
    ]);

  const out: ResolvedGoals = {};
  for (const p of hierarchy.people) {
    const rows = rowsFor(p.name);
    if (rows.length === 0) continue;
    const products = mapCsvRowsToProducts(rows, outputMapping, productColumn, productValueMapping);
    if (Object.keys(products).length > 0) out[p.name] = products;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Software % Rules resolver
// ---------------------------------------------------------------------------

export async function resolveSoftwarePctGoals(
  rules: SoftwarePctRules,
  month: string,
): Promise<ResolvedGoals> {
  const targetMonth = compMonthKey(month) || month;

  // Per-rep raw software totals per metric, read from the configured sub-source.
  let hierarchy: Hierarchy;
  let rawFor: (name: string) => Record<GoalMetricKey, number>;

  // For the Goal CSV sub-source, the Goal CSV output mapping's directly-mapped
  // (software-product, metric) cells REPLACE the % split for those cells; the
  // split fills the remaining cells with no renormalization. `claimed` is the
  // set of `${product}|${metric}` keys covered by the direct mapping.
  let directFor: (name: string) => Partial<Record<GoalProduct, GoalMetrics>> = () => ({});
  const claimed = new Set<string>();

  if (rules.subSource === "financePps") {
    const { hierarchy: h, rowFor } = await buildFinanceLookup(targetMonth);
    hierarchy = h;
    const map = rules.columnMapping.financePps;
    rawFor = (name) => {
      const row = rowFor(name);
      const out = { mrrAddedGoal: 0, mrrChurnGoal: 0, mrrAddedMinimum: 0, mrrChurnMaximum: 0 };
      if (!row) return out;
      for (const metric of GOAL_METRIC_KEYS) {
        const col = map[metric];
        if (col) out[metric] = parseGoalNumber(row[col]);
      }
      return out;
    };
  } else {
    const [{ hierarchy: h, rowsFor }, outputMapping, productColumn, productValueMapping] =
      await Promise.all([
        buildCsvLookup(targetMonth),
        getGoalCsvOutputMapping(),
        getGoalCsvProductColumn(),
        getGoalCsvProductValueMapping(),
      ]);
    hierarchy = h;
    const map = rules.columnMapping.goalCsv;
    rawFor = (name) => {
      const rows = rowsFor(name);
      const out = { mrrAddedGoal: 0, mrrChurnGoal: 0, mrrAddedMinimum: 0, mrrChurnMaximum: 0 };
      for (const r of rows) {
        for (const metric of GOAL_METRIC_KEYS) {
          const header = map[metric];
          if (header) out[metric] += csvCellByHeader(r, header);
        }
      }
      return out;
    };
    for (const m of outputMapping) {
      if ((SOFTWARE_PRODUCTS as readonly string[]).includes(m.product)) {
        claimed.add(`${m.product}|${m.metric}`);
      }
    }
    directFor = (name) =>
      mapCsvRowsToProducts(rowsFor(name), outputMapping, productColumn, productValueMapping);
  }

  const out: ResolvedGoals = {};
  for (const p of hierarchy.people) {
    const raw = rawFor(p.name);
    const split = splitSoftwareTotals(raw, rules);

    // No claimed software cells → preserve the original split-only behavior
    // (drop reps with no raw software total).
    if (claimed.size === 0) {
      if (GOAL_METRIC_KEYS.every((m) => raw[m] === 0)) continue;
      out[p.name] = split;
      continue;
    }

    // Merge per software product/metric: claimed cells take the direct value,
    // the rest keep the % split. Reps with direct values are kept even when
    // their raw software total is zero.
    const direct = directFor(p.name);
    const merged: Partial<Record<GoalProduct, GoalMetrics>> = {};
    for (const product of SOFTWARE_PRODUCTS) {
      const metrics = emptyGoalMetrics();
      for (const metric of GOAL_METRIC_KEYS) {
        metrics[metric] = claimed.has(`${product}|${metric}`)
          ? direct[product]?.[metric] ?? 0
          : split[product]?.[metric] ?? 0;
      }
      if (!metricsAllZero(metrics)) merged[product] = metrics;
    }
    if (Object.keys(merged).length > 0) out[p.name] = merged;
  }
  return out;
}

export async function resolveGoals(
  source: GoalSourceId,
  month: string,
): Promise<ResolvedGoals> {
  switch (source) {
    case "financePps":
      return resolveFinancePpsGoals(month);
    case "goalCsv":
      return resolveGoalCsvGoals(month);
    case "softwareGnr":
      return resolveSoftwarePctGoals(await getSoftwareGnrRules(), month);
    case "softwareAcq":
      return resolveSoftwarePctGoals(await getSoftwareAcqRules(), month);
  }
}
