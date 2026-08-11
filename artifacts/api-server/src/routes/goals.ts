import { Router, type IRouter } from "express";
import { requireRole, requireWritable } from "../middlewares/requireRole";
import {
  getGoalsConfig,
  setRoleGroupMapping,
  setGoalCsvJoinFields,
  setGoalCsvOutputMapping,
  setGoalCsvInspectColumns,
  setGoalCsvProductColumn,
  setGoalCsvProductValueMapping,
  setFinancePpsJoinFields,
  setFinancePpsOutputMapping,
  setFinancePpsInspectColumns,
  setSoftwareGnrRules,
  setSoftwareAcqRules,
  validateRoleGroupMapping,
  validateGoalCsvJoinFields,
  validateGoalCsvOutputMapping,
  validateGoalCsvInspectColumns,
  validateGoalCsvProductColumn,
  validateGoalCsvProductValueMapping,
  validateFinancePpsJoinFields,
  validateFinancePpsOutputMapping,
  validateFinancePpsInspectColumns,
  validateSoftwarePctRules,
  getFinancePpsInspectColumns,
  getGoalCsvInspectColumns,
  type ValidationResult,
} from "../lib/goals-config";
import {
  getFinancePpsSnapshot,
  refreshFinancePpsSnapshot,
  financePpsFetchedAtIso,
} from "../lib/goals-finance-pps";
import { parseGoalCsv, replaceGoalCsvRows, getGoalCsvRows, getGoalCsvColumns } from "../lib/goals-csv";
import { resolveGoals } from "../lib/goals-resolvers";
import {
  GOAL_PRODUCTS,
  GOAL_METRIC_KEYS,
  HIERARCHY_JOIN_FIELDS,
  SOFTWARE_PRODUCTS,
  type GoalProduct,
  type GoalSourceId,
} from "../lib/goals-types";
import {
  buildGoalTable,
  enumerateGoalRowTargets,
  upsertRowOverride,
  bulkSetRowSource,
  isGoalSourceId,
  canonicalMonth,
  GOAL_SOURCE_IDS,
  type GoalTableFilter,
} from "../lib/goals-table";
import { currentCompMonthKey } from "../lib/compensation";
import { clearGoalsQuotaCache } from "../lib/goals-quota-source";
import {
  buildRosterForMonth,
  invalidateEffectiveHierarchy,
  fetchHierarchy,
  personIdentityKey,
} from "../lib/sheets-data";
import {
  upsertRosterOverride,
  canonicalRosterMonth,
  type RosterOverridePatch,
} from "../lib/roster-overrides";
import type { Request } from "express";

const PRODUCT_SET = new Set<string>(GOAL_PRODUCTS);

/** Parse the dashboard filter set from query params (month + narrowing). */
function parseTableFilter(req: Request): GoalTableFilter {
  const q = req.query as Record<string, string | undefined>;
  const csv = (v: string | undefined): string[] | undefined => {
    if (typeof v !== "string") return undefined;
    const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  };
  return {
    month: q.month && q.month.trim() !== "" ? q.month : currentCompMonthKey(),
    slm: q.slm,
    flm: q.flm,
    reps: csv(q.reps),
    regions: csv(q.regions),
    products: csv(q.products),
  };
}

/** Validate an optional positive-finite multiplier value from the request. */
function optMultiplier(v: unknown, label: string): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    return { ok: false, error: `${label} must be a non-negative number` };
  }
  return { ok: true, value: v };
}

/**
 * Like optMultiplier but distinguishes an explicit `null` (clear the manual
 * override back to the Databricks value) from omission (`undefined` = leave
 * unchanged). Used for the nullable eRep manual override (Task #467).
 */
function optNullableMultiplier(
  v: unknown,
  label: string,
): { ok: true; value: number | null | undefined } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    return { ok: false, error: `${label} must be a non-negative number or null` };
  }
  return { ok: true, value: v };
}

const router: IRouter = Router();

// Writes (PUT/POST) stay restricted to the Executive-edit roles.
const GOALS_ROLES = ["admin", "slm", "exec"] as const;
// Reads (GET) are open to every authenticated role (Task #363): the whole
// Executive tab is now read-only-visible to everyone. `requireRole()` with no
// args only requires authentication, leaving every mutation gated by GOALS_ROLES
// + requireWritable() below.
const requireGoalsRead = () => requireRole();

function actor(req: Request): { name: string | null; role: string | null } {
  const u = req.user;
  if (!u) return { name: null, role: null };
  const name =
    u.hierarchyName ||
    `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() ||
    u.email ||
    null;
  return { name, role: (u.role as string | null) ?? null };
}

// --- Aggregate config + enums --------------------------------------------

router.get("/sales/goals/config", requireGoalsRead(), async (_req, res): Promise<void> => {
  const config = await getGoalsConfig();
  res.json({
    config,
    options: {
      products: GOAL_PRODUCTS,
      softwareProducts: SOFTWARE_PRODUCTS,
      metrics: GOAL_METRIC_KEYS,
      hierarchyJoinFields: HIERARCHY_JOIN_FIELDS,
    },
  });
});

// Generic helper for the section PUTs: validate then persist.
async function handleSectionPut<T>(
  req: Request,
  res: import("express").Response,
  validate: (input: unknown) => ValidationResult<T>,
  persist: (value: T, name: string | null, role: string | null) => Promise<T>,
): Promise<void> {
  const result = validate(req.body?.value);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  const { name, role } = actor(req);
  const saved = await persist(result.value, name, role);
  // Config changes can shift every rep's base goals; drop the dashboard's
  // Goals-tab quota cache so the next pipeline request rebuilds from the edit.
  clearGoalsQuotaCache();
  res.json({ value: saved });
}

router.put("/sales/goals/config/role-group-mapping", requireRole(...GOALS_ROLES), requireWritable(), async (req, res) => {
  await handleSectionPut(req, res, validateRoleGroupMapping, setRoleGroupMapping);
});
router.put("/sales/goals/config/goal-csv-join-fields", requireRole(...GOALS_ROLES), requireWritable(), async (req, res) => {
  await handleSectionPut(req, res, validateGoalCsvJoinFields, setGoalCsvJoinFields);
});
router.put("/sales/goals/config/goal-csv-output-mapping", requireRole(...GOALS_ROLES), requireWritable(), async (req, res) => {
  await handleSectionPut(req, res, validateGoalCsvOutputMapping, setGoalCsvOutputMapping);
});
router.put("/sales/goals/config/goal-csv-inspect-columns", requireRole(...GOALS_ROLES), requireWritable(), async (req, res) => {
  await handleSectionPut(req, res, validateGoalCsvInspectColumns, setGoalCsvInspectColumns);
});
// The Product column + per-product value mapping are saved together (both
// describe how a single CSV column attributes rows to products). Validate both,
// persist both, then drop the quota cache like the other section PUTs.
router.put("/sales/goals/config/goal-csv-product-mapping", requireRole(...GOALS_ROLES), requireWritable(), async (req, res): Promise<void> => {
  const colResult = validateGoalCsvProductColumn(req.body?.productColumn);
  if (!colResult.ok) {
    res.status(400).json({ error: colResult.error });
    return;
  }
  const mapResult = validateGoalCsvProductValueMapping(req.body?.productValueMapping);
  if (!mapResult.ok) {
    res.status(400).json({ error: mapResult.error });
    return;
  }
  const { name, role } = actor(req);
  const [productColumn, productValueMapping] = await Promise.all([
    setGoalCsvProductColumn(colResult.value, name, role),
    setGoalCsvProductValueMapping(mapResult.value, name, role),
  ]);
  clearGoalsQuotaCache();
  res.json({ productColumn, productValueMapping });
});
router.put("/sales/goals/config/finance-pps-join-fields", requireRole(...GOALS_ROLES), requireWritable(), async (req, res) => {
  await handleSectionPut(req, res, validateFinancePpsJoinFields, setFinancePpsJoinFields);
});
router.put("/sales/goals/config/finance-pps-output-mapping", requireRole(...GOALS_ROLES), requireWritable(), async (req, res) => {
  await handleSectionPut(req, res, validateFinancePpsOutputMapping, setFinancePpsOutputMapping);
});
router.put("/sales/goals/config/finance-pps-inspect-columns", requireRole(...GOALS_ROLES), requireWritable(), async (req, res) => {
  await handleSectionPut(req, res, validateFinancePpsInspectColumns, setFinancePpsInspectColumns);
});
router.put("/sales/goals/config/software-gnr-rules", requireRole(...GOALS_ROLES), requireWritable(), async (req, res) => {
  await handleSectionPut(req, res, validateSoftwarePctRules, setSoftwareGnrRules);
});
router.put("/sales/goals/config/software-acq-rules", requireRole(...GOALS_ROLES), requireWritable(), async (req, res) => {
  await handleSectionPut(req, res, validateSoftwarePctRules, setSoftwareAcqRules);
});

// --- finance.pps source ---------------------------------------------------

router.get("/sales/goals/finance-pps/inspect", requireGoalsRead(), async (_req, res): Promise<void> => {
  const [snapshot, selectedColumns] = await Promise.all([
    getFinancePpsSnapshot(),
    getFinancePpsInspectColumns(),
  ]);
  res.json({
    rows: snapshot.rows,
    allColumns: snapshot.columns,
    selectedColumns,
    fetchedAt: financePpsFetchedAtIso(snapshot.fetchedAt),
    fetchError: snapshot.fetchError,
    fetchErrorMessage: snapshot.fetchErrorMessage ?? null,
  });
});

router.post("/sales/goals/finance-pps/refresh", requireRole(...GOALS_ROLES), requireWritable(), async (_req, res): Promise<void> => {
  const snapshot = await refreshFinancePpsSnapshot();
  clearGoalsQuotaCache();
  res.json({
    rowCount: snapshot.rows.length,
    columnCount: snapshot.columns.length,
    fetchedAt: financePpsFetchedAtIso(snapshot.fetchedAt),
    fetchError: snapshot.fetchError,
    fetchErrorMessage: snapshot.fetchErrorMessage ?? null,
  });
});

// --- Goal CSV source ------------------------------------------------------

router.get("/sales/goals/goal-csv/inspect", requireGoalsRead(), async (_req, res): Promise<void> => {
  const [storedRows, uploadedColumns, selectedColumns] = await Promise.all([
    getGoalCsvRows(),
    getGoalCsvColumns(),
    getGoalCsvInspectColumns(),
  ]);
  const rows = storedRows.map((r) => (r.data ?? {}) as Record<string, string>);
  // Prefer the uploaded column order; fall back to the union of keys present in
  // the stored rows when no order metadata exists (e.g. legacy uploads).
  let allColumns = uploadedColumns;
  if (allColumns.length === 0) {
    const seen = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
    allColumns = Array.from(seen);
  }
  res.json({ rows, allColumns, selectedColumns });
});

router.post("/sales/goals/goal-csv/upload", requireRole(...GOALS_ROLES), requireWritable(), async (req, res): Promise<void> => {
  const csv = req.body?.csv;
  if (typeof csv !== "string" || csv.trim() === "") {
    res.status(400).json({ error: "Request body must include a non-empty `csv` string" });
    return;
  }
  const parsed = parseGoalCsv(csv);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { name } = actor(req);
  const inserted = await replaceGoalCsvRows(parsed.rows, parsed.columns, name);
  clearGoalsQuotaCache();
  res.json({ inserted });
});

// --- Per-source resolution (for inspection / validation) ------------------

router.get("/sales/goals/resolve", requireGoalsRead(), async (req, res): Promise<void> => {
  const source = req.query.source as string | undefined;
  if (!isGoalSourceId(source)) {
    res.status(400).json({ error: `source must be one of: ${GOAL_SOURCE_IDS.join(", ")}` });
    return;
  }
  const month = (req.query.month as string | undefined) || currentCompMonthKey();
  const goals = await resolveGoals(source, month);
  res.json({ source, month, goals });
});

// --- Main Goals table -----------------------------------------------------

router.get("/sales/goals/table", requireGoalsRead(), async (req, res): Promise<void> => {
  const raw = req.query.month as string | undefined;
  if (raw !== undefined && raw.trim() !== "" && canonicalMonth(raw) === null) {
    res.status(400).json({ error: "month must be a valid YYYY-MM" });
    return;
  }
  const filter = parseTableFilter(req);
  const { month, rows } = await buildGoalTable(filter);
  res.json({ month, rows });
});

// Upsert a single per-row override (Source / multipliers / LOA / eRep). Only
// the provided fields change; omitted fields keep their stored/default value.
router.put("/sales/goals/table/override", requireRole(...GOALS_ROLES), requireWritable(), async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawMonth = typeof body.month === "string" && body.month.trim() !== "" ? body.month : null;
  const month = rawMonth ? canonicalMonth(rawMonth) : null;
  const rep = typeof body.rep === "string" ? body.rep.trim() : "";
  const product = typeof body.product === "string" ? body.product : "";

  if (!rawMonth) {
    res.status(400).json({ error: "month is required" });
    return;
  }
  if (!month) {
    res.status(400).json({ error: "month must be a valid YYYY-MM" });
    return;
  }
  if (rep === "") {
    res.status(400).json({ error: "rep is required" });
    return;
  }
  if (!PRODUCT_SET.has(product)) {
    res.status(400).json({ error: `product must be one of: ${GOAL_PRODUCTS.join(", ")}` });
    return;
  }
  if (body.source !== undefined && !isGoalSourceId(body.source)) {
    res.status(400).json({ error: `source must be one of: ${GOAL_SOURCE_IDS.join(", ")}` });
    return;
  }
  const added = optMultiplier(body.mrrAddedManualMultiplier, "mrrAddedManualMultiplier");
  if (!added.ok) {
    res.status(400).json({ error: added.error });
    return;
  }
  const churn = optMultiplier(body.mrrChurnManualMultiplier, "mrrChurnManualMultiplier");
  if (!churn.ok) {
    res.status(400).json({ error: churn.error });
    return;
  }
  // Nullable: an explicit null clears the manual override back to the Databricks
  // value, while omission leaves the stored override untouched (Task #467).
  const erep = optNullableMultiplier(body.eRepMultiplier, "eRepMultiplier");
  if (!erep.ok) {
    res.status(400).json({ error: erep.error });
    return;
  }
  if (body.loaStatus !== undefined && typeof body.loaStatus !== "string") {
    res.status(400).json({ error: "loaStatus must be a string" });
    return;
  }

  const { name, role } = actor(req);
  const saved = await upsertRowOverride(
    {
      month,
      rep,
      product: product as GoalProduct,
      source: body.source as GoalSourceId | undefined,
      mrrAddedManualMultiplier: added.value,
      mrrChurnManualMultiplier: churn.value,
      loaStatus: body.loaStatus as string | undefined,
      eRepMultiplier: erep.value,
    },
    name,
    role,
  );
  clearGoalsQuotaCache();
  res.json({ override: saved });
});

// Bulk-set the Source for every row in the current filter set.
router.post("/sales/goals/table/bulk-source", requireRole(...GOALS_ROLES), requireWritable(), async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!isGoalSourceId(body.source)) {
    res.status(400).json({ error: `source must be one of: ${GOAL_SOURCE_IDS.join(", ")}` });
    return;
  }
  const rawMonth = req.query.month as string | undefined;
  if (rawMonth !== undefined && rawMonth.trim() !== "" && canonicalMonth(rawMonth) === null) {
    res.status(400).json({ error: "month must be a valid YYYY-MM" });
    return;
  }
  const filter = parseTableFilter(req);
  const month = canonicalMonth(filter.month) ?? filter.month;
  const targets = await enumerateGoalRowTargets(filter);
  const { name, role } = actor(req);
  const updated = await bulkSetRowSource(month, targets, body.source, name, role);
  clearGoalsQuotaCache();
  res.json({ month, updated, source: body.source });
});

// --- Roster (per-month hierarchy overrides) -------------------------------

router.get("/sales/roster", requireGoalsRead(), async (req, res): Promise<void> => {
  const raw = req.query.month as string | undefined;
  if (raw !== undefined && raw.trim() !== "" && canonicalRosterMonth(raw) === null) {
    res.status(400).json({ error: "month must be a valid YYYY-MM" });
    return;
  }
  const month = raw && raw.trim() !== "" ? raw : currentCompMonthKey();
  const { month: resolved, rows } = await buildRosterForMonth(month);
  res.json({ month: resolved, rows });
});

// Upsert one person's per-month override. Only the provided fields change;
// pass `null` to clear a field's override.
router.put("/sales/roster/override", requireRole(...GOALS_ROLES), requireWritable(), async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawMonth = typeof body.month === "string" && body.month.trim() !== "" ? body.month : null;
  const month = rawMonth ? canonicalRosterMonth(rawMonth) : null;
  const person = typeof body.person === "string" ? body.person.trim() : "";

  if (!rawMonth) {
    res.status(400).json({ error: "month is required" });
    return;
  }
  if (!month) {
    res.status(400).json({ error: "month must be a valid YYYY-MM" });
    return;
  }
  if (person === "") {
    res.status(400).json({ error: "person is required" });
    return;
  }

  // Validate provided fields. `active` is boolean|null; the rest are
  // string|null. Omitted keys are left untouched.
  if ("active" in body && body.active !== null && typeof body.active !== "boolean") {
    res.status(400).json({ error: "active must be a boolean or null" });
    return;
  }
  const strFields = ["flm", "slm", "region", "segment", "salesRole"] as const;
  for (const f of strFields) {
    if (f in body && body[f] !== null && typeof body[f] !== "string") {
      res.status(400).json({ error: `${f} must be a string or null` });
      return;
    }
  }

  const patch: RosterOverridePatch = {};
  if ("active" in body) patch.active = body.active as boolean | null;
  for (const f of strFields) {
    if (f in body) patch[f] = body[f] as string | null;
  }

  const { name, role } = actor(req);
  // Resolve the display name to a durable identity (email/employeeId/name) from
  // the BASE hierarchy so the override survives later feeder name changes.
  const base = await fetchHierarchy();
  const identityKey = personIdentityKey(base, person);
  await upsertRosterOverride(month, identityKey, person, patch, name, role);
  // The effective hierarchy for this month changed, and quotas derive from it.
  invalidateEffectiveHierarchy(month);
  clearGoalsQuotaCache();

  const { month: resolved, rows } = await buildRosterForMonth(month);
  res.json({ month: resolved, rows });
});

export default router;
