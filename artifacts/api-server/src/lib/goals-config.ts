// Goals tab config store (Executive → Goals).
//
// A generic key/value store over the `goal_config` table backs every editable
// config section. Seeded defaults live here in code (mirroring the compensation
// reference-config pattern) and are returned for any section that has not been
// customized yet, so the feature is usable before the editing UI ships and
// before any row exists.

import { db } from "@workspace/db";
import { goalConfigTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { bumpDataVersion } from "./cache-version";
import { logger } from "./logger";
import { dbScopeKey } from "./demo-session";
import {
  GOAL_METRIC_KEYS,
  GOAL_PRODUCTS,
  HIERARCHY_JOIN_FIELDS,
  SOFTWARE_PRODUCTS,
  type GoalCsvJoinField,
  type GoalCsvProductValueEntry,
  type GoalMetricKey,
  type GoalProduct,
  type GoalsConfig,
  type FinancePpsJoinField,
  type FinancePpsOutputMapEntry,
  type HierarchyJoinField,
  type RoleGroupMapEntry,
  type SoftwareColumnMap,
  type SoftwarePctRules,
  type SoftwareProduct,
} from "./goals-types";

// ---------------------------------------------------------------------------
// Config keys + seeded defaults
// ---------------------------------------------------------------------------

export const GOAL_CONFIG_KEYS = {
  roleGroupMapping: "roleGroupMapping",
  goalCsvJoinFields: "goalCsvJoinFields",
  goalCsvOutputMapping: "goalCsvOutputMapping",
  goalCsvInspectColumns: "goalCsvInspectColumns",
  goalCsvProductColumn: "goalCsvProductColumn",
  goalCsvProductValueMapping: "goalCsvProductValueMapping",
  financePpsJoinFields: "financePpsJoinFields",
  financePpsOutputMapping: "financePpsOutputMapping",
  financePpsInspectColumns: "financePpsInspectColumns",
  softwareGnrRules: "softwareGnrRules",
  softwareAcqRules: "softwareAcqRules",
} as const;

export type GoalConfigKey = (typeof GOAL_CONFIG_KEYS)[keyof typeof GOAL_CONFIG_KEYS];

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// Group is not present in the hierarchy sheet — it is derived from the sales
// role. These seeds match today's hard-coded derivation; the labels (ACQ/G&R)
// are what the Goal CSV's Group column is expected to use for joining.
export const DEFAULT_ROLE_GROUP_MAPPING: RoleGroupMapEntry[] = [
  { salesRole: "ASA Acquisition Sales", group: "ACQ" },
  { salesRole: "Advisor", group: "G&R" },
  { salesRole: "Senior Advisor", group: "G&R" },
  { salesRole: "Strategic Advisor", group: "G&R" },
];

export const DEFAULT_GOAL_CSV_JOIN_FIELDS: GoalCsvJoinField[] = [
  { csv: "Group", hierarchy: "Group" },
  { csv: "Region", hierarchy: "Region" },
  { csv: "Segment", hierarchy: "Segment" },
];

// Default Goal CSV output mapping reproduces the previous hard-coded behavior:
// Sales SC columns → Showcase add/churn, Sales MBP columns → MBP add/churn.
// The remaining (product, metric) cells are filled by the Software % split.
export const DEFAULT_GOAL_CSV_OUTPUT_MAPPING: FinancePpsOutputMapEntry[] = [
  { column: "Sales SC MRR Added Goal", metric: "mrrAddedGoal", product: "Showcase" },
  { column: "Sales SC MRR Lost Goal", metric: "mrrChurnGoal", product: "Showcase" },
  { column: "Sales MBP MRR Added Goal", metric: "mrrAddedGoal", product: "MBP" },
  { column: "Sales MBP MRR Lost Goal", metric: "mrrChurnGoal", product: "MBP" },
];

export const DEFAULT_GOAL_CSV_INSPECT_COLUMNS: string[] = [
  "Month",
  "Group",
  "Region",
  "Segment",
  "Sales MBP MRR Added Goal",
  "Sales MBP MRR Lost Goal",
  "Sales SC MRR Added Goal",
  "Sales SC MRR Lost Goal",
  "Software MRR Added Goal",
  "Software MRR Lost Goal",
  "Minimum Software Goal",
];

// No product column / value mapping is configured by default. Until an admin
// picks the Product column and maps each product to its value, the Goal CSV
// resolver fails safe and attributes nothing.
export const DEFAULT_GOAL_CSV_PRODUCT_COLUMN = "";
export const DEFAULT_GOAL_CSV_PRODUCT_VALUE_MAPPING: GoalCsvProductValueEntry[] = [];

export const DEFAULT_FINANCE_PPS_JOIN_FIELDS: FinancePpsJoinField[] = [
  { financePps: "Employee ID", hierarchy: "Employee Number" },
];

export const DEFAULT_FINANCE_PPS_OUTPUT_MAPPING: FinancePpsOutputMapEntry[] = [
  { column: "Showcase Current Month Single Month Goal", metric: "mrrAddedGoal", product: "Showcase" },
  { column: "MBP Current Month Single Month Goal", metric: "mrrAddedGoal", product: "MBP" },
];

export const DEFAULT_FINANCE_PPS_INSPECT_COLUMNS: string[] = [
  "Performance Period",
  "Employee For Lookup",
  "Employee ID",
  "Group",
  "Showcase Current Month Single Month Goal",
  "MBP Current Month Single Month Goal",
];

function emptySoftwareColumnMap(): SoftwareColumnMap {
  return { mrrAddedGoal: "", mrrChurnGoal: "", mrrAddedMinimum: "", mrrChurnMaximum: "" };
}

export const DEFAULT_SOFTWARE_PCT_RULES: SoftwarePctRules = {
  subSource: "financePps",
  columnMapping: {
    financePps: emptySoftwareColumnMap(),
    goalCsv: {
      mrrAddedGoal: "Software MRR Added Goal",
      mrrChurnGoal: "Software MRR Lost Goal",
      mrrAddedMinimum: "Minimum Software Goal",
      mrrChurnMaximum: "",
    },
  },
  percentages: { Showcase: 25, "Zillow Pro": 25, "Follow Up Boss": 25, ZMX: 25 },
};

function defaultFor(key: GoalConfigKey): unknown {
  switch (key) {
    case "roleGroupMapping":
      return clone(DEFAULT_ROLE_GROUP_MAPPING);
    case "goalCsvJoinFields":
      return clone(DEFAULT_GOAL_CSV_JOIN_FIELDS);
    case "goalCsvOutputMapping":
      return clone(DEFAULT_GOAL_CSV_OUTPUT_MAPPING);
    case "goalCsvInspectColumns":
      return clone(DEFAULT_GOAL_CSV_INSPECT_COLUMNS);
    case "goalCsvProductColumn":
      return DEFAULT_GOAL_CSV_PRODUCT_COLUMN;
    case "goalCsvProductValueMapping":
      return clone(DEFAULT_GOAL_CSV_PRODUCT_VALUE_MAPPING);
    case "financePpsJoinFields":
      return clone(DEFAULT_FINANCE_PPS_JOIN_FIELDS);
    case "financePpsOutputMapping":
      return clone(DEFAULT_FINANCE_PPS_OUTPUT_MAPPING);
    case "financePpsInspectColumns":
      return clone(DEFAULT_FINANCE_PPS_INSPECT_COLUMNS);
    case "softwareGnrRules":
      return clone(DEFAULT_SOFTWARE_PCT_RULES);
    case "softwareAcqRules":
      return clone(DEFAULT_SOFTWARE_PCT_RULES);
  }
}

// ---------------------------------------------------------------------------
// Cached read / write
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: unknown; at: number }>();

export function invalidateGoalsConfigCache(key?: GoalConfigKey): void {
  if (key) {
    // Cache keys are `<db scope>|<section key>` (scope is "" in live mode);
    // drop the section across every scope.
    const suffix = `|${key}`;
    for (const k of [...cache.keys()]) {
      if (k.endsWith(suffix)) cache.delete(k);
    }
  } else cache.clear();
  bumpDataVersion();
}

async function readSection<T>(key: GoalConfigKey): Promise<T> {
  const cacheKey = `${dbScopeKey()}|${key}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value as T;

  let value: unknown;
  try {
    const rows = await db
      .select()
      .from(goalConfigTable)
      .where(eq(goalConfigTable.key, key))
      .limit(1);
    value = rows.length === 0 ? defaultFor(key) : rows[0].value;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), key },
      "[Goals] readSection failed; using seeded default",
    );
    value = defaultFor(key);
  }

  cache.set(cacheKey, { value, at: Date.now() });
  return value as T;
}

async function writeSection<T>(
  key: GoalConfigKey,
  value: T,
  updatedByName: string | null,
  updatedByRole: string | null,
): Promise<T> {
  await db
    .insert(goalConfigTable)
    .values({ key, value: value as object, updatedByName, updatedByRole })
    .onConflictDoUpdate({
      target: goalConfigTable.key,
      set: { value: value as object, updatedByName, updatedByRole, updatedAt: sql`now()` },
    });
  invalidateGoalsConfigCache(key);
  return value;
}

// ---------------------------------------------------------------------------
// Typed section getters
// ---------------------------------------------------------------------------

export function getRoleGroupMapping(): Promise<RoleGroupMapEntry[]> {
  return readSection<RoleGroupMapEntry[]>("roleGroupMapping");
}
export function getGoalCsvJoinFields(): Promise<GoalCsvJoinField[]> {
  return readSection<GoalCsvJoinField[]>("goalCsvJoinFields");
}
export function getGoalCsvOutputMapping(): Promise<FinancePpsOutputMapEntry[]> {
  return readSection<FinancePpsOutputMapEntry[]>("goalCsvOutputMapping");
}
export function getGoalCsvInspectColumns(): Promise<string[]> {
  return readSection<string[]>("goalCsvInspectColumns");
}
export function getGoalCsvProductColumn(): Promise<string> {
  return readSection<string>("goalCsvProductColumn");
}
export function getGoalCsvProductValueMapping(): Promise<GoalCsvProductValueEntry[]> {
  return readSection<GoalCsvProductValueEntry[]>("goalCsvProductValueMapping");
}
export function getFinancePpsJoinFields(): Promise<FinancePpsJoinField[]> {
  return readSection<FinancePpsJoinField[]>("financePpsJoinFields");
}
export function getFinancePpsOutputMapping(): Promise<FinancePpsOutputMapEntry[]> {
  return readSection<FinancePpsOutputMapEntry[]>("financePpsOutputMapping");
}
export function getFinancePpsInspectColumns(): Promise<string[]> {
  return readSection<string[]>("financePpsInspectColumns");
}
export function getSoftwareGnrRules(): Promise<SoftwarePctRules> {
  return readSection<SoftwarePctRules>("softwareGnrRules");
}
export function getSoftwareAcqRules(): Promise<SoftwarePctRules> {
  return readSection<SoftwarePctRules>("softwareAcqRules");
}

export async function getGoalsConfig(): Promise<GoalsConfig> {
  const [
    roleGroupMapping,
    goalCsvJoinFields,
    goalCsvOutputMapping,
    goalCsvInspectColumns,
    goalCsvProductColumn,
    goalCsvProductValueMapping,
    financePpsJoinFields,
    financePpsOutputMapping,
    financePpsInspectColumns,
    softwareGnrRules,
    softwareAcqRules,
  ] = await Promise.all([
    getRoleGroupMapping(),
    getGoalCsvJoinFields(),
    getGoalCsvOutputMapping(),
    getGoalCsvInspectColumns(),
    getGoalCsvProductColumn(),
    getGoalCsvProductValueMapping(),
    getFinancePpsJoinFields(),
    getFinancePpsOutputMapping(),
    getFinancePpsInspectColumns(),
    getSoftwareGnrRules(),
    getSoftwareAcqRules(),
  ]);
  return {
    roleGroupMapping,
    goalCsvJoinFields,
    goalCsvOutputMapping,
    goalCsvInspectColumns,
    goalCsvProductColumn,
    goalCsvProductValueMapping,
    financePpsJoinFields,
    financePpsOutputMapping,
    financePpsInspectColumns,
    softwareGnrRules,
    softwareAcqRules,
  };
}

// ---------------------------------------------------------------------------
// Validation + typed setters
// ---------------------------------------------------------------------------

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isStr(v: unknown): v is string {
  return typeof v === "string";
}
function nonEmptyStr(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
const HIERARCHY_FIELD_SET = new Set<string>(HIERARCHY_JOIN_FIELDS);
const METRIC_SET = new Set<string>(GOAL_METRIC_KEYS);
const PRODUCT_SET = new Set<string>(GOAL_PRODUCTS);

export function validateRoleGroupMapping(input: unknown): ValidationResult<RoleGroupMapEntry[]> {
  if (!Array.isArray(input)) return { ok: false, error: "Expected an array of role→group entries" };
  const out: RoleGroupMapEntry[] = [];
  for (const [i, e] of input.entries()) {
    if (typeof e !== "object" || e === null) return { ok: false, error: `Entry ${i} is not an object` };
    const { salesRole, group } = e as Record<string, unknown>;
    if (!nonEmptyStr(salesRole)) return { ok: false, error: `Entry ${i}: salesRole is required` };
    if (!isStr(group)) return { ok: false, error: `Entry ${i}: group must be a string` };
    out.push({ salesRole: salesRole.trim(), group: group.trim() });
  }
  return { ok: true, value: out };
}

function validateHierarchyField(v: unknown, i: number): ValidationResult<HierarchyJoinField> {
  if (!isStr(v) || !HIERARCHY_FIELD_SET.has(v)) {
    return { ok: false, error: `Entry ${i}: hierarchy must be one of ${HIERARCHY_JOIN_FIELDS.join(", ")}` };
  }
  return { ok: true, value: v as HierarchyJoinField };
}

export function validateGoalCsvJoinFields(input: unknown): ValidationResult<GoalCsvJoinField[]> {
  if (!Array.isArray(input)) return { ok: false, error: "Expected an array of join fields" };
  const out: GoalCsvJoinField[] = [];
  for (const [i, e] of input.entries()) {
    if (typeof e !== "object" || e === null) return { ok: false, error: `Entry ${i} is not an object` };
    const { csv, hierarchy } = e as Record<string, unknown>;
    if (!nonEmptyStr(csv)) return { ok: false, error: `Entry ${i}: csv column is required` };
    const h = validateHierarchyField(hierarchy, i);
    if (!h.ok) return h;
    out.push({ csv: csv.trim(), hierarchy: h.value });
  }
  return { ok: true, value: out };
}

export function validateFinancePpsJoinFields(input: unknown): ValidationResult<FinancePpsJoinField[]> {
  if (!Array.isArray(input)) return { ok: false, error: "Expected an array of join fields" };
  const out: FinancePpsJoinField[] = [];
  for (const [i, e] of input.entries()) {
    if (typeof e !== "object" || e === null) return { ok: false, error: `Entry ${i} is not an object` };
    const { financePps, hierarchy } = e as Record<string, unknown>;
    if (!nonEmptyStr(financePps)) return { ok: false, error: `Entry ${i}: financePps column is required` };
    const h = validateHierarchyField(hierarchy, i);
    if (!h.ok) return h;
    out.push({ financePps: financePps.trim(), hierarchy: h.value });
  }
  return { ok: true, value: out };
}

export function validateFinancePpsOutputMapping(input: unknown): ValidationResult<FinancePpsOutputMapEntry[]> {
  if (!Array.isArray(input)) return { ok: false, error: "Expected an array of output mappings" };
  const out: FinancePpsOutputMapEntry[] = [];
  for (const [i, e] of input.entries()) {
    if (typeof e !== "object" || e === null) return { ok: false, error: `Entry ${i} is not an object` };
    const { column, metric, product } = e as Record<string, unknown>;
    if (!nonEmptyStr(column)) return { ok: false, error: `Entry ${i}: column is required` };
    if (!isStr(metric) || !METRIC_SET.has(metric)) {
      return { ok: false, error: `Entry ${i}: metric must be one of ${GOAL_METRIC_KEYS.join(", ")}` };
    }
    if (!isStr(product) || !PRODUCT_SET.has(product)) {
      return { ok: false, error: `Entry ${i}: product must be one of ${GOAL_PRODUCTS.join(", ")}` };
    }
    out.push({ column: column.trim(), metric: metric as GoalMetricKey, product: product as GoalProduct });
  }
  return { ok: true, value: out };
}

export function validateFinancePpsInspectColumns(input: unknown): ValidationResult<string[]> {
  if (!Array.isArray(input)) return { ok: false, error: "Expected an array of column names" };
  const out: string[] = [];
  for (const [i, c] of input.entries()) {
    if (!nonEmptyStr(c)) return { ok: false, error: `Entry ${i}: column name must be a non-empty string` };
    out.push(c.trim());
  }
  return { ok: true, value: out };
}

// The Goal CSV output mapping and inspect columns share the exact validation
// shape with their finance.pps counterparts (column → metric/product entries,
// and a list of column names).
export function validateGoalCsvOutputMapping(input: unknown): ValidationResult<FinancePpsOutputMapEntry[]> {
  return validateFinancePpsOutputMapping(input);
}

export function validateGoalCsvInspectColumns(input: unknown): ValidationResult<string[]> {
  return validateFinancePpsInspectColumns(input);
}

export function validateGoalCsvProductColumn(input: unknown): ValidationResult<string> {
  if (input == null || input === "") return { ok: true, value: "" };
  if (!isStr(input)) return { ok: false, error: "Product column must be a string" };
  return { ok: true, value: input.trim() };
}

export function validateGoalCsvProductValueMapping(
  input: unknown,
): ValidationResult<GoalCsvProductValueEntry[]> {
  if (!Array.isArray(input)) return { ok: false, error: "Expected an array of product→value entries" };
  const out: GoalCsvProductValueEntry[] = [];
  const seen = new Set<string>();
  for (const [i, e] of input.entries()) {
    if (typeof e !== "object" || e === null) return { ok: false, error: `Entry ${i} is not an object` };
    const { product, value } = e as Record<string, unknown>;
    if (!isStr(product) || !PRODUCT_SET.has(product)) {
      return { ok: false, error: `Entry ${i}: product must be one of ${GOAL_PRODUCTS.join(", ")}` };
    }
    if (value !== undefined && !isStr(value)) {
      return { ok: false, error: `Entry ${i}: value must be a string` };
    }
    if (seen.has(product)) return { ok: false, error: `Entry ${i}: duplicate product ${product}` };
    seen.add(product);
    const trimmed = isStr(value) ? value.trim() : "";
    // Skip products mapped to an empty value — an unset row contributes nothing.
    if (trimmed === "") continue;
    out.push({ product: product as GoalProduct, value: trimmed });
  }
  return { ok: true, value: out };
}

function validateSoftwareColumnMap(v: unknown, label: string): ValidationResult<SoftwareColumnMap> {
  if (typeof v !== "object" || v === null) return { ok: false, error: `${label} column mapping must be an object` };
  const r = v as Record<string, unknown>;
  const out = emptySoftwareColumnMap();
  for (const metric of GOAL_METRIC_KEYS) {
    const cell = r[metric];
    if (cell !== undefined && !isStr(cell)) return { ok: false, error: `${label}.${metric} must be a string` };
    out[metric] = isStr(cell) ? cell.trim() : "";
  }
  return { ok: true, value: out };
}

export function validateSoftwarePctRules(input: unknown): ValidationResult<SoftwarePctRules> {
  if (typeof input !== "object" || input === null) return { ok: false, error: "Expected an object" };
  const r = input as Record<string, unknown>;
  if (r.subSource !== "financePps" && r.subSource !== "goalCsv") {
    return { ok: false, error: "subSource must be 'financePps' or 'goalCsv'" };
  }
  const cm = r.columnMapping;
  if (typeof cm !== "object" || cm === null) return { ok: false, error: "columnMapping is required" };
  const fpp = validateSoftwareColumnMap((cm as Record<string, unknown>).financePps, "financePps");
  if (!fpp.ok) return fpp;
  const gcsv = validateSoftwareColumnMap((cm as Record<string, unknown>).goalCsv, "goalCsv");
  if (!gcsv.ok) return gcsv;

  const pct = r.percentages;
  if (typeof pct !== "object" || pct === null) return { ok: false, error: "percentages is required" };
  const pctRec = pct as Record<string, unknown>;
  const percentages = {} as Record<SoftwareProduct, number>;
  let sum = 0;
  for (const product of SOFTWARE_PRODUCTS) {
    const raw = pctRec[product];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      return { ok: false, error: `percentages.${product} must be a non-negative whole integer` };
    }
    percentages[product] = raw;
    sum += raw;
  }
  if (sum !== 100) return { ok: false, error: `percentages must sum to 100 (got ${sum})` };

  return {
    ok: true,
    value: {
      subSource: r.subSource,
      columnMapping: { financePps: fpp.value, goalCsv: gcsv.value },
      percentages,
    },
  };
}

export function setRoleGroupMapping(v: RoleGroupMapEntry[], name: string | null, role: string | null) {
  return writeSection("roleGroupMapping", v, name, role);
}
export function setGoalCsvJoinFields(v: GoalCsvJoinField[], name: string | null, role: string | null) {
  return writeSection("goalCsvJoinFields", v, name, role);
}
export function setGoalCsvOutputMapping(v: FinancePpsOutputMapEntry[], name: string | null, role: string | null) {
  return writeSection("goalCsvOutputMapping", v, name, role);
}
export function setGoalCsvInspectColumns(v: string[], name: string | null, role: string | null) {
  return writeSection("goalCsvInspectColumns", v, name, role);
}
export function setGoalCsvProductColumn(v: string, name: string | null, role: string | null) {
  return writeSection("goalCsvProductColumn", v, name, role);
}
export function setGoalCsvProductValueMapping(
  v: GoalCsvProductValueEntry[],
  name: string | null,
  role: string | null,
) {
  return writeSection("goalCsvProductValueMapping", v, name, role);
}
export function setFinancePpsJoinFields(v: FinancePpsJoinField[], name: string | null, role: string | null) {
  return writeSection("financePpsJoinFields", v, name, role);
}
export function setFinancePpsOutputMapping(v: FinancePpsOutputMapEntry[], name: string | null, role: string | null) {
  return writeSection("financePpsOutputMapping", v, name, role);
}
export function setFinancePpsInspectColumns(v: string[], name: string | null, role: string | null) {
  return writeSection("financePpsInspectColumns", v, name, role);
}
export function setSoftwareGnrRules(v: SoftwarePctRules, name: string | null, role: string | null) {
  return writeSection("softwareGnrRules", v, name, role);
}
export function setSoftwareAcqRules(v: SoftwarePctRules, name: string | null, role: string | null) {
  return writeSection("softwareAcqRules", v, name, role);
}
