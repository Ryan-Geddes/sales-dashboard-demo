// Shared client helpers for the Executive → Goals tab.
//
// Mirrors the raw-fetch convention used by CompensationView so DEV
// impersonation (x-impersonate-user-id) flows through on writes — the generated
// client's custom-fetch does not inject that header.

import type {
  GetGoalTable200,
  GoalRowOverrideInput,
  GoalSourceId,
  GoalsConfigEnvelope,
  RoleGroupMapEntry,
  GoalCsvJoinField,
  FinancePpsJoinField,
  FinancePpsOutputMapEntry,
  SoftwarePctRules,
  GoalCsvProductValueEntry,
  InspectGoalsFinancePps200,
  InspectGoalsGoalCsv200,
  RefreshGoalsFinancePps200,
  UploadGoalsGoalCsv200,
  BulkSetGoalRowSource200,
} from "@workspace/api-client-react";
import { getDateRange, getTodayPST } from "../../../lib/utils";
import type { Timeframe } from "../../../pages/Dashboard";

export const GOAL_SOURCE_IDS: GoalSourceId[] = [
  "financePps",
  "goalCsv",
  "softwareGnr",
  "softwareAcq",
];

export const SOURCE_LABELS: Record<GoalSourceId, string> = {
  financePps: "finance.pps",
  goalCsv: "Goal CSV",
  softwareGnr: "Software % GNR",
  softwareAcq: "Software % ACQ",
};

// The metric keys and their display labels (mirrors GOAL_METRIC_KEYS).
export const METRIC_LABELS: Record<string, string> = {
  mrrAddedGoal: "MRR Added Goal",
  mrrChurnGoal: "MRR Churn Goal",
  mrrAddedMinimum: "MRR Added Minimum",
  mrrChurnMaximum: "MRR Churn Maximum",
};
export const GOAL_METRIC_KEYS = [
  "mrrAddedGoal",
  "mrrChurnGoal",
  "mrrAddedMinimum",
  "mrrChurnMaximum",
] as const;

// Mirrors the server-side DEFAULT_FINANCE_PPS_INSPECT_COLUMNS so the inspector's
// "Restore defaults" button can re-apply the seeded column set (no API exposes
// the defaults separately).
export const DEFAULT_FINANCE_PPS_INSPECT_COLUMNS = [
  "Performance Period",
  "Employee For Lookup",
  "Employee ID",
  "Group",
  "Showcase Current Month Single Month Goal",
  "MBP Current Month Single Month Goal",
];

// Mirrors the server-side DEFAULT_GOAL_CSV_INSPECT_COLUMNS so the Goal CSV
// inspector's "Restore defaults" button can re-apply the seeded column set.
export const DEFAULT_GOAL_CSV_INSPECT_COLUMNS = [
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

// Canonical Goal CSV header names per (product, metric). Mirrors the server-side
// DEFAULT_GOAL_CSV_OUTPUT_MAPPING. Used by the "Modify Goal Columns" editor to
// auto-prefill a cell when the uploaded CSV actually contains the canonical
// header. Products/metrics without a historical canonical header are omitted and
// simply start unset.
export const CANONICAL_GOAL_CSV_HEADERS: ReadonlyArray<{
  product: string;
  metric: string;
  column: string;
}> = [
  { product: "Showcase", metric: "mrrAddedGoal", column: "Sales SC MRR Added Goal" },
  { product: "Showcase", metric: "mrrChurnGoal", column: "Sales SC MRR Lost Goal" },
  { product: "MBP", metric: "mrrAddedGoal", column: "Sales MBP MRR Added Goal" },
  { product: "MBP", metric: "mrrChurnGoal", column: "Sales MBP MRR Lost Goal" },
];

// ---------------------------------------------------------------------------
// Month derivation
// ---------------------------------------------------------------------------

export function currentMonthKey(): string {
  const d = getTodayPST();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Derive the Goals YYYY-MM month from the dashboard date-range filters. */
export function deriveMonth(
  timeframe: Timeframe,
  customRange?: { from: Date; to: Date },
): string {
  const range = getDateRange(timeframe, customRange);
  const iso = range.to ?? range.from;
  if (iso && /^\d{4}-\d{2}/.test(iso)) return iso.slice(0, 7);
  return currentMonthKey();
}

export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const moneyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return moneyFmt.format(n);
}

export function fmtMult(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n}`;
}

// ---------------------------------------------------------------------------
// Headers (DEV impersonation)
// ---------------------------------------------------------------------------

export function buildHeaders(json: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers["Content-Type"] = "application/json";
  if (import.meta.env.DEV) {
    try {
      const raw = localStorage.getItem("impersonate_user");
      const imp = raw ? JSON.parse(raw) : null;
      if (imp?.id) headers["x-impersonate-user-id"] = String(imp.id);
    } catch {
      /* ignore */
    }
  }
  return headers;
}

const API_BASE = import.meta.env.BASE_URL || "/";

function apiUrl(path: string): string {
  // path starts with "sales/..."; API is mounted under <base>api/.
  return `${API_BASE}api/${path}`;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), {
    headers: buildHeaders(false),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as T;
}

async function apiSend<T>(
  path: string,
  method: "PUT" | "POST",
  body: unknown,
): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: buildHeaders(true),
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as T;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body?.error) return String(body.error);
  } catch {
    /* ignore */
  }
  return `Request failed (${res.status})`;
}

// ---------------------------------------------------------------------------
// Goals-table filters
// ---------------------------------------------------------------------------

export interface GoalTableQuery {
  month: string;
  slm: string[];
  flm: string[];
  reps: string[];
  regions: string[];
  /** Product filter — sent only by bulk-source so the server scopes the write
   *  to the selected products. The read path narrows products client-side. */
  products?: string[];
}

function qs(params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") parts.push(`${k}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

// Server supports a single slm/flm and CSV reps/regions. We send single-value
// slm/flm + reps/regions as a narrowing optimization; multi-select slm/flm is
// resolved client-side in the table to match dashboard semantics exactly.
function tableParams(q: GoalTableQuery): Record<string, string | undefined> {
  return {
    month: q.month,
    slm: q.slm.length === 1 ? q.slm[0] : undefined,
    flm: q.flm.length === 1 ? q.flm[0] : undefined,
    reps: q.reps.length ? q.reps.join(",") : undefined,
    regions: q.regions.length ? q.regions.join(",") : undefined,
    products: q.products && q.products.length ? q.products.join(",") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Endpoint wrappers
// ---------------------------------------------------------------------------

export function fetchGoalTable(q: GoalTableQuery): Promise<GetGoalTable200> {
  return apiGet<GetGoalTable200>(`sales/goals/table${qs(tableParams(q))}`);
}

export function upsertGoalRowOverride(
  input: GoalRowOverrideInput,
): Promise<{ override: unknown }> {
  return apiSend("sales/goals/table/override", "PUT", input);
}

export function bulkSetGoalRowSource(
  q: GoalTableQuery,
  source: GoalSourceId,
): Promise<BulkSetGoalRowSource200> {
  return apiSend<BulkSetGoalRowSource200>(
    `sales/goals/table/bulk-source${qs(tableParams(q))}`,
    "POST",
    { source },
  );
}

export function fetchGoalsConfig(): Promise<GoalsConfigEnvelope> {
  return apiGet<GoalsConfigEnvelope>("sales/goals/config");
}

export function saveRoleGroupMapping(
  value: RoleGroupMapEntry[],
): Promise<{ value: RoleGroupMapEntry[] }> {
  return apiSend("sales/goals/config/role-group-mapping", "PUT", { value });
}
export function saveGoalCsvJoinFields(
  value: GoalCsvJoinField[],
): Promise<{ value: GoalCsvJoinField[] }> {
  return apiSend("sales/goals/config/goal-csv-join-fields", "PUT", { value });
}
export function saveGoalCsvOutputMapping(
  value: FinancePpsOutputMapEntry[],
): Promise<{ value: FinancePpsOutputMapEntry[] }> {
  return apiSend("sales/goals/config/goal-csv-output-mapping", "PUT", { value });
}
export function saveGoalCsvInspectColumns(
  value: string[],
): Promise<{ value: string[] }> {
  return apiSend("sales/goals/config/goal-csv-inspect-columns", "PUT", { value });
}
// The Product column header + per-product value mapping are persisted together
// (they describe one CSV column's attribution rules).
export function saveGoalCsvProductMapping(
  productColumn: string,
  productValueMapping: GoalCsvProductValueEntry[],
): Promise<{ productColumn: string; productValueMapping: GoalCsvProductValueEntry[] }> {
  return apiSend("sales/goals/config/goal-csv-product-mapping", "PUT", {
    productColumn,
    productValueMapping,
  });
}
export function saveFinancePpsJoinFields(
  value: FinancePpsJoinField[],
): Promise<{ value: FinancePpsJoinField[] }> {
  return apiSend("sales/goals/config/finance-pps-join-fields", "PUT", { value });
}
export function saveFinancePpsOutputMapping(
  value: FinancePpsOutputMapEntry[],
): Promise<{ value: FinancePpsOutputMapEntry[] }> {
  return apiSend("sales/goals/config/finance-pps-output-mapping", "PUT", { value });
}
export function saveFinancePpsInspectColumns(
  value: string[],
): Promise<{ value: string[] }> {
  return apiSend("sales/goals/config/finance-pps-inspect-columns", "PUT", { value });
}
export function saveSoftwareGnrRules(
  value: SoftwarePctRules,
): Promise<{ value: SoftwarePctRules }> {
  return apiSend("sales/goals/config/software-gnr-rules", "PUT", { value });
}
export function saveSoftwareAcqRules(
  value: SoftwarePctRules,
): Promise<{ value: SoftwarePctRules }> {
  return apiSend("sales/goals/config/software-acq-rules", "PUT", { value });
}

export function fetchFinancePpsInspect(): Promise<InspectGoalsFinancePps200> {
  return apiGet<InspectGoalsFinancePps200>("sales/goals/finance-pps/inspect");
}
export function refreshFinancePps(): Promise<RefreshGoalsFinancePps200> {
  return apiSend<RefreshGoalsFinancePps200>("sales/goals/finance-pps/refresh", "POST", {});
}

export function fetchGoalCsvInspect(): Promise<InspectGoalsGoalCsv200> {
  return apiGet<InspectGoalsGoalCsv200>("sales/goals/goal-csv/inspect");
}
export function uploadGoalCsv(csv: string): Promise<UploadGoalsGoalCsv200> {
  return apiSend<UploadGoalsGoalCsv200>("sales/goals/goal-csv/upload", "POST", { csv });
}

// ---------------------------------------------------------------------------
// Final-goal math (mirrors goals-table.computeFinalGoals for optimistic UI).
// ---------------------------------------------------------------------------

export interface FinalGoals {
  finalMrrAddedGoal: number;
  finalChurnGoal: number;
  finalMrrMinGoal: number;
  finalChurnMaxGoal: number;
}

export function computeFinalGoals(
  base: {
    mrrAddedGoal: number;
    mrrChurnGoal: number;
    mrrAddedMinimum: number;
    mrrChurnMaximum: number;
  },
  ov: {
    mrrAddedManualMultiplier: number;
    mrrChurnManualMultiplier: number;
    eRepMultiplier: number;
  },
): FinalGoals {
  return {
    finalMrrAddedGoal: ov.mrrAddedManualMultiplier * ov.eRepMultiplier * base.mrrAddedGoal,
    finalChurnGoal: ov.mrrChurnManualMultiplier * ov.eRepMultiplier * base.mrrChurnGoal,
    finalMrrMinGoal: ov.eRepMultiplier * base.mrrAddedMinimum,
    finalChurnMaxGoal: ov.eRepMultiplier * base.mrrChurnMaximum,
  };
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
