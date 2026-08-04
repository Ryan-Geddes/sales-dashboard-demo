// Shared types and constants for the Goals tab (Executive → Goals).
//
// Scope (Task #259): the three goal SOURCES and the editable mapping/config
// they depend on, plus per-source resolvers. The main Goals table assembly,
// final-goal math, the frontend, and the live-dashboard cutover are separate
// later tasks and intentionally NOT covered here.

/** The five canonical products shown in the Goals table. */
export const GOAL_PRODUCTS = [
  "Showcase",
  "MBP",
  "Zillow Pro",
  "Follow Up Boss",
  "ZMX",
] as const;
export type GoalProduct = (typeof GOAL_PRODUCTS)[number];

/**
 * Software products that the Software % Rules source distributes a software
 * total across. MBP is intentionally excluded — it is a sales product, not
 * software.
 */
export const SOFTWARE_PRODUCTS = [
  "Showcase",
  "Zillow Pro",
  "Follow Up Boss",
  "ZMX",
] as const;
export type SoftwareProduct = (typeof SOFTWARE_PRODUCTS)[number];

/** The four goal metrics resolved per (rep, product). */
export const GOAL_METRIC_KEYS = [
  "mrrAddedGoal",
  "mrrChurnGoal",
  "mrrAddedMinimum",
  "mrrChurnMaximum",
] as const;
export type GoalMetricKey = (typeof GOAL_METRIC_KEYS)[number];

export interface GoalMetrics {
  mrrAddedGoal: number;
  mrrChurnGoal: number;
  mrrAddedMinimum: number;
  mrrChurnMaximum: number;
}

export function emptyGoalMetrics(): GoalMetrics {
  return { mrrAddedGoal: 0, mrrChurnGoal: 0, mrrAddedMinimum: 0, mrrChurnMaximum: 0 };
}

/**
 * The goal sources. There are two independent Software % rule sets — GNR and
 * ACQ — each with its own sub-source, column mapping, and product split.
 */
export type GoalSourceId = "financePps" | "goalCsv" | "softwareGnr" | "softwareAcq";

/**
 * Resolved goals for a month: rep name → product name → metrics. Products and
 * metrics a source does not populate are absent (read as zero downstream).
 */
export type ResolvedGoals = Record<string, Partial<Record<GoalProduct, GoalMetrics>>>;

// ---------------------------------------------------------------------------
// Hierarchy join fields
// ---------------------------------------------------------------------------

/**
 * Hierarchy-side fields available for joining a source row to a rep. "Employee
 * Number" is the rep's employee id; "Group" is derived from the role→group
 * mapping; the rest come straight from the hierarchy sheet.
 */
export const HIERARCHY_JOIN_FIELDS = [
  "Employee Number",
  "Group",
  "Region",
  "Segment",
  "Name",
] as const;
export type HierarchyJoinField = (typeof HIERARCHY_JOIN_FIELDS)[number];

// ---------------------------------------------------------------------------
// Config section shapes (stored in goal_config; defaults seeded in code)
// ---------------------------------------------------------------------------

/** hierarchy sales role → group label used by the Goal CSV join. */
export interface RoleGroupMapEntry {
  salesRole: string;
  group: string;
}

/** A join pair linking a Goal CSV column to a hierarchy field. */
export interface GoalCsvJoinField {
  csv: string;
  hierarchy: HierarchyJoinField;
}

/** A join pair linking a finance.pps column to a hierarchy field. */
export interface FinancePpsJoinField {
  financePps: string;
  hierarchy: HierarchyJoinField;
}

/** Maps a finance.pps column to a (metric, product) goal target. */
export interface FinancePpsOutputMapEntry {
  column: string;
  metric: GoalMetricKey;
  product: GoalProduct;
}

/** Maps a Goal CSV column to a (metric, product) goal target. Identical shape
 *  to the finance.pps output mapping — a column name → goal cell pairing. */
export type GoalCsvOutputMapEntry = FinancePpsOutputMapEntry;

/** Maps a dashboard product to the distinct value found in the Goal CSV's
 *  Product column that identifies that product's rows. */
export interface GoalCsvProductValueEntry {
  product: GoalProduct;
  value: string;
}

/** Per-metric sub-source column names for the Software % Rules source. */
export interface SoftwareColumnMap {
  mrrAddedGoal: string;
  mrrChurnGoal: string;
  mrrAddedMinimum: string;
  mrrChurnMaximum: string;
}

/** Software % rule set config (shared shape for both the GNR and ACQ rule
 *  sets): sub-source choice, its column mapping, and the per-software-product
 *  percentages (whole integers summing to 100). */
export interface SoftwarePctRules {
  subSource: "financePps" | "goalCsv";
  columnMapping: {
    financePps: SoftwareColumnMap;
    goalCsv: SoftwareColumnMap;
  };
  percentages: Record<SoftwareProduct, number>;
}

/** The complete editable config powering the Goals tab. */
export interface GoalsConfig {
  roleGroupMapping: RoleGroupMapEntry[];
  goalCsvJoinFields: GoalCsvJoinField[];
  goalCsvOutputMapping: GoalCsvOutputMapEntry[];
  goalCsvInspectColumns: string[];
  goalCsvProductColumn: string;
  goalCsvProductValueMapping: GoalCsvProductValueEntry[];
  financePpsJoinFields: FinancePpsJoinField[];
  financePpsOutputMapping: FinancePpsOutputMapEntry[];
  financePpsInspectColumns: string[];
  softwareGnrRules: SoftwarePctRules;
  softwareAcqRules: SoftwarePctRules;
}
