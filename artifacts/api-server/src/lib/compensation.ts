import { db } from "@workspace/db";
import {
  compensationConfigTable,
  MRR_FIELD_OPTIONS,
  MRR_FIELD_SOURCE,
  CPD_SOURCED_VALUES,
  DEFAULT_REASSIGNABLE_OWNER_ROLES,
  type CompCondition,
  type CompField,
  type CompOp,
  type CompMultiplierRule,
  type CompRevenueScope,
  type FubZproRule,
  type MrrField,
  type PairedOppRule,
  type CompAdjustment,
  type CompAdjustmentOp,
  type CompIdentityField,
  COMP_IDENTITY_FIELDS,
  type CompNamedOpp,
  type CompOppMode,
  type CompPairedCondition,
  type CompComparativeCondition,
  type CompFactorOp,
  type CompComparableField,
  type CompDateGranularity,
  type CompLogicTerm,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { bumpDataVersion } from "./cache-version";
import {
  currentDate,
  isDemoMode,
  DEMO_COMPLIANCE_SALES_REP,
} from "./demo-mode";
import { dbScopeKey } from "./demo-session";

export type {
  CompCondition,
  CompField,
  CompOp,
  CompMultiplierRule,
  FubZproRule,
  MrrField,
  PairedOppRule,
  CompAdjustment,
  CompAdjustmentOp,
  CompIdentityField,
  CompNamedOpp,
  CompOppMode,
  CompPairedCondition,
  CompComparableField,
};
export { DEFAULT_REASSIGNABLE_OWNER_ROLES };

/**
 * The default owner-reassignment gate, with the "Compliance Sales" pseudo-rep
 * swapped for its anonymized counterpart in demo mode (the demo fixtures and
 * seeded comp config use the fake name). Live mode returns the shared constant
 * unchanged.
 */
function defaultReassignableOwnerRoles(): string[] {
  if (!isDemoMode()) return DEFAULT_REASSIGNABLE_OWNER_ROLES;
  return DEFAULT_REASSIGNABLE_OWNER_ROLES.map((r) =>
    r === "Compliance Sales" ? DEMO_COMPLIANCE_SALES_REP : r,
  );
}

// Valid MRR-source-field values a rule may set, for save-time validation.
const VALID_MRR_FIELDS = new Set<string>(MRR_FIELD_OPTIONS.map((o) => o.value));

// Task #335: paired-opp per-side MRR fields are feeder-only — CPD columns are
// out of scope for paired rules (CPD rows fall back to standardized MRR).
const VALID_FEEDER_MRR_FIELDS = new Set<string>(
  MRR_FIELD_OPTIONS.filter((o) => MRR_FIELD_SOURCE[o.value] === "feeder").map((o) => o.value),
);

// CPD-sourced product/type values, lowercased for case-insensitive matching.
const CPD_SOURCED_VALUE_SET = new Set<string>(
  CPD_SOURCED_VALUES.map((v) => v.trim().toLowerCase()),
);

// Task #314: classify a rule's upstream source from its product/type/rawProduct
// eq/in conditions. A rule that pins a CPD value (ZMX / Showcase Incremental -
// Re/Max) is CPD-sourced; one that pins a feeder value is feeder-sourced.
// `mixed` flags a rule that references both (rejected on save). Rules without
// any such condition default to feeder (the historical behavior).
function classifyRuleSource(conditions: CompCondition[]): {
  source: "feeder" | "cpd";
  mixed: boolean;
} {
  let hasCpd = false;
  let hasFeeder = false;
  for (const c of conditions) {
    if (c.field !== "type" && c.field !== "product" && c.field !== "rawProduct") continue;
    if (c.op !== "eq" && c.op !== "in") continue;
    const vals = Array.isArray(c.value)
      ? c.value.map((v) => String(v))
      : c.value !== undefined && c.value !== null
        ? [String(c.value)]
        : [];
    for (const v of vals) {
      const t = v.trim();
      if (!t) continue;
      if (CPD_SOURCED_VALUE_SET.has(t.toLowerCase())) hasCpd = true;
      else hasFeeder = true;
    }
  }
  return { source: hasCpd && !hasFeeder ? "cpd" : "feeder", mixed: hasCpd && hasFeeder };
}

// ---------------------------------------------------------------------------
// Month helpers — config is keyed by `YYYY-MM` and independent month-to-month.
// ---------------------------------------------------------------------------

// Single source of truth for turning a raw date string into a Date. Accepts
// both Pipeline's M/D/YYYY and Databricks' ISO YYYY-MM-DD (the latter pinned to
// local midnight so it lands on the right calendar day). Returns null for
// unparseable input. compMonthKey, dateOrdinal, and (via dateOrdinal)
// exactDateKey all route through this so the two date sources can never drift
// into separate format-specific parsers again (Task #376).
function parseRawDate(raw: string): Date | null {
  const dt = new Date(raw + (raw.length === 10 ? "T00:00:00" : ""));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export function compMonthKey(d: Date | string): string {
  const dt = typeof d === "string" ? parseRawDate(d) : d;
  if (dt === null || Number.isNaN(dt.getTime())) return "";
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
}

export function currentCompMonthKey(): string {
  return compMonthKey(currentDate());
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export function isValidMonthKey(month: unknown): month is string {
  return typeof month === "string" && MONTH_RE.test(month);
}

// ---------------------------------------------------------------------------
// June reference config — shipped as the initial default so the feature is
// usable before the editing UI lands. Returned for any month without a saved
// row, and seeded as a concrete persisted row for the current (June) month.
// ---------------------------------------------------------------------------

export const DEFAULT_FLEX_FLIP_STATUSES: string[] = [
  "Registered",
  "Onboarding",
  "Waitlisted",
  "Active",
  "On Hold (Blocked)",
  "Performance Warning",
  "On Hold",
  "Active - Doesn't Work Leads",
  "Member Selected Pause",
  "Hold Override Granted",
];

export const REFERENCE_MULTIPLIER_RULES: CompMultiplierRule[] = [
  {
    id: "fub-term-12",
    label: "FUB · Term Length = 12 → ×1.1",
    conditions: [
      { field: "product", op: "eq", value: "Follow Up Boss" },
      { field: "termLength", op: "eq", value: "12" },
    ],
    multiplier: 1.1,
  },
  {
    id: "zmx-not-legacy",
    label: "ZMX · legacy_flag = false → ×0.5",
    conditions: [
      { field: "product", op: "eq", value: "ZMX" },
      { field: "legacyFlag", op: "eq", value: false },
    ],
    multiplier: 0.5,
  },
  {
    id: "zmx-legacy",
    label: "ZMX · legacy_flag = true → ×0.0",
    conditions: [
      { field: "product", op: "eq", value: "ZMX" },
      { field: "legacyFlag", op: "eq", value: true },
    ],
    multiplier: 0.0,
  },
  {
    id: "remax-showcase-adhoc-credits",
    label: "Re/Max Showcase Adhoc Credits → ×0.5",
    conditions: [
      { field: "product", op: "eq", value: "Showcase Incremental - Re/Max" },
    ],
    multiplier: 0.5,
  },
  {
    id: "sci-acq",
    label: "Showcase Incremental (ACQ) → ×0.5",
    conditions: [
      { field: "product", op: "eq", value: "Showcase Incremental" },
      { field: "group", op: "eq", value: "Acquisitions" },
    ],
    multiplier: 0.5,
  },
  {
    id: "sci-gnr",
    label: "Showcase Incremental (GNR) → ×0.75",
    conditions: [
      { field: "product", op: "eq", value: "Showcase Incremental" },
      { field: "group", op: "eq", value: "G&R" },
    ],
    multiplier: 0.75,
  },
];

// Legacy reference (kept only for back-compat / migration reads). The engine no
// longer consumes it — the FUB↔Zpro pairing is expressed as generic paired-opp
// rules below (REFERENCE_PAIRED_OPP_RULES).
export const REFERENCE_FUB_ZPRO_RULE: FubZproRule = {
  enabled: true,
  flexFlipStatuses: [...DEFAULT_FLEX_FLIP_STATUSES],
  factor: 0.1,
};

// Task #317: the shipped FUB↔Zpro pairing, re-expressed with the generic
// paired-opp rule model so the hardcoded special-case can be removed while the
// default behavior is preserved. Side A = a Follow Up Boss cancellation, Side B
// = a positive Zillow Pro win on the same account + month. Two rules cover the
// flex branch (contact Flex Flip status in the configured list → ZPro MRR ×
// factor) and the net branch (otherwise → ZPro MRR − FUB lost revenue). Both
// waive the FUB churn.
export const REFERENCE_PAIRED_OPP_RULES: PairedOppRule[] = [
  {
    id: "fub-zpro-flex",
    label: "FUB↔Zpro (Flex Flip) · ZPro MRR × factor",
    enabled: true,
    opps: [
      {
        name: "fub",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "Follow Up Boss" },
          { kind: "field", field: "type", op: "eq", value: "Cancel" },
          { kind: "field", field: "funnelStage", op: "eq", value: "Closed Won" },
          { kind: "field", field: "flexFlipAgentStatus", op: "in", value: [...DEFAULT_FLEX_FLIP_STATUSES] },
        ],
      },
      {
        name: "zpro",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "Zillow Pro" },
          { kind: "field", field: "changeInMrr", op: "gt", value: 0 },
          { kind: "field", field: "funnelStage", op: "eq", value: "Closed Won" },
          { kind: "comparative", field: "accountId", op: "eq", compareToOpp: "fub", compareToField: "accountId" },
          { kind: "comparative", field: "closeDate", op: "eq", compareToOpp: "fub", compareToField: "closeDate", dateGranularity: "month" },
        ],
      },
    ],
    adjustments: [
      { targetOpp: "fub", op: "waive" },
      { targetOpp: "zpro", op: "multiplyByFactor", amount: 0.1 },
    ],
  },
  {
    id: "fub-zpro-net",
    label: "FUB↔Zpro (net) · ZPro MRR − FUB lost",
    enabled: true,
    opps: [
      {
        name: "fub",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "Follow Up Boss" },
          { kind: "field", field: "type", op: "eq", value: "Cancel" },
          { kind: "field", field: "funnelStage", op: "eq", value: "Closed Won" },
          { kind: "field", field: "flexFlipAgentStatus", op: "notIn", value: [...DEFAULT_FLEX_FLIP_STATUSES] },
        ],
      },
      {
        name: "zpro",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "Zillow Pro" },
          { kind: "field", field: "changeInMrr", op: "gt", value: 0 },
          { kind: "field", field: "funnelStage", op: "eq", value: "Closed Won" },
          { kind: "comparative", field: "accountId", op: "eq", compareToOpp: "fub", compareToField: "accountId" },
          { kind: "comparative", field: "closeDate", op: "eq", compareToOpp: "fub", compareToField: "closeDate", dateGranularity: "month" },
        ],
      },
    ],
    adjustments: [
      { targetOpp: "fub", op: "waive" },
      { targetOpp: "zpro", op: "incremental", comparisonOpp: "fub" },
    ],
  },
];

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export interface CompensationConfig {
  monthYyyymm: string;
  multiplierRules: CompMultiplierRule[];
  // Task #317: generic cross-opp pairing rules (replaces fubZproRule).
  pairedOppRules: PairedOppRule[];
  updatedByName?: string | null;
  updatedByRole?: string | null;
  updatedAt?: string | null;
  // True when no saved row exists and the reference defaults are being
  // returned (the row has not been customized for this month yet).
  isDefault: boolean;
}

export function referenceConfig(month: string): CompensationConfig {
  return {
    monthYyyymm: month,
    multiplierRules: clone(REFERENCE_MULTIPLIER_RULES),
    pairedOppRules: clone(REFERENCE_PAIRED_OPP_RULES),
    isDefault: true,
  };
}

// A rule applies in revenue-view mode `mode` when its scope is "both" or equals
// the mode. An omitted scope is treated as "quota" so pre-existing rules keep
// applying in the default Quota Target Revenue view.
function scopeApplies(
  scope: CompRevenueScope | undefined,
  mode: "quota" | "sales",
): boolean {
  const s = scope ?? "quota";
  return s === "both" || s === mode;
}

// Return a copy of `config` whose multiplier + paired-opp rules are narrowed to
// only those applicable in revenue-view mode `mode`. Used so both revenue modes
// run the same compensation engine but with their own subset of rules — a mode
// with no applicable rules naturally yields raw (multiplier 1) MRR.
export function filterConfigForMode(
  config: CompensationConfig,
  mode: "quota" | "sales",
): CompensationConfig {
  return {
    ...config,
    multiplierRules: config.multiplierRules.filter((r) =>
      scopeApplies(r.appliesIn, mode),
    ),
    pairedOppRules: config.pairedOppRules.filter((r) =>
      scopeApplies(r.appliesIn, mode),
    ),
  };
}

// ---------------------------------------------------------------------------
// Config read / write (cached, idempotent upsert).
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;
const configCache = new Map<string, { config: CompensationConfig; at: number }>();
// Memoized per-month config (above) is invalidated on every upsert and shares
// the data-version stamp (Task #428) so the pipeline result cache rebuilds in
// lockstep with comp-rule/config edits.

export function invalidateCompensationCache(month?: string): void {
  if (month) {
    // Keys are `<db scope>|<month>`; drop that month across every scope.
    const suffix = `|${month}`;
    for (const key of [...configCache.keys()]) {
      if (key.endsWith(suffix)) configCache.delete(key);
    }
  } else configCache.clear();
  bumpDataVersion();
}

export async function getCompensationConfig(
  month: string,
): Promise<CompensationConfig> {
  // Demo mode partitions the cache per session (dbScopeKey is "" — i.e. the
  // key is the bare month — in live mode and outside a demo session).
  const cacheKey = `${dbScopeKey()}|${month}`;
  const cached = configCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.config;

  let config: CompensationConfig;
  try {
    const rows = await db
      .select()
      .from(compensationConfigTable)
      .where(eq(compensationConfigTable.monthYyyymm, month))
      .limit(1);
    if (rows.length === 0) {
      config = referenceConfig(month);
    } else {
      const r = rows[0];
      // Migration fallback: a row saved before Task #317 has no paired-opp
      // rules but may carry the legacy enabled FUB↔Zpro rule. Reproduce its
      // behavior with the reference paired rules so pairing isn't silently lost.
      let pairedOppRules = r.pairedOppRules ?? [];
      if (pairedOppRules.length === 0 && r.fubZproRule?.enabled) {
        pairedOppRules = clone(REFERENCE_PAIRED_OPP_RULES);
      }
      config = {
        monthYyyymm: r.monthYyyymm,
        multiplierRules: r.multiplierRules ?? [],
        pairedOppRules,
        updatedByName: r.updatedByName,
        updatedByRole: r.updatedByRole,
        updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
        isDefault: false,
      };
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), month },
      "[Compensation] getCompensationConfig failed; using reference defaults",
    );
    config = referenceConfig(month);
  }

  configCache.set(cacheKey, { config, at: Date.now() });
  return config;
}

export async function upsertCompensationConfig(
  month: string,
  multiplierRules: CompMultiplierRule[],
  pairedOppRules: PairedOppRule[],
  updatedByName: string | null,
  updatedByRole: string | null,
): Promise<CompensationConfig> {
  const inserted = await db
    .insert(compensationConfigTable)
    .values({ monthYyyymm: month, multiplierRules, pairedOppRules, updatedByName, updatedByRole })
    .onConflictDoUpdate({
      target: compensationConfigTable.monthYyyymm,
      set: {
        multiplierRules,
        pairedOppRules,
        updatedByName,
        updatedByRole,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  invalidateCompensationCache(month);
  const r = inserted[0];
  return {
    monthYyyymm: r.monthYyyymm,
    multiplierRules: r.multiplierRules ?? [],
    pairedOppRules: r.pairedOppRules ?? [],
    updatedByName: r.updatedByName,
    updatedByRole: r.updatedByRole,
    updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    isDefault: false,
  };
}

// Idempotently persist the June reference config so there is a concrete,
// editable row in the DB before the UI ships. Safe to call on every boot.
export async function seedReferenceCompensationConfig(
  month: string = currentCompMonthKey(),
): Promise<void> {
  if (!isValidMonthKey(month)) return;
  try {
    await db
      .insert(compensationConfigTable)
      .values({
        monthYyyymm: month,
        multiplierRules: clone(REFERENCE_MULTIPLIER_RULES),
        pairedOppRules: clone(REFERENCE_PAIRED_OPP_RULES),
        updatedByName: "system",
        updatedByRole: "admin",
      })
      .onConflictDoNothing({ target: compensationConfigTable.monthYyyymm });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), month },
      "[Compensation] seedReferenceCompensationConfig failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Config validation (for the write endpoint / future UI).
// ---------------------------------------------------------------------------

const VALID_FIELDS: ReadonlySet<CompField> = new Set<CompField>([
  "product",
  "rawProduct",
  "productFamily",
  "type",
  "termLength",
  "legacyFlag",
  "group",
  "segment",
  "salesRole",
  "quoteType",
  // Task #317: paired-opp condition fields.
  "oppName",
  "funnelStage",
  "changeInMrr",
  "splitTotalPrice",
  "flexFlipAgentStatus",
  // Task #347: FUB first-purchase date enrichment field.
  "fub_first_purchase_date",
  // Task #434: raw feeder people columns, selectable as standard/paired fields.
  "user",
  "oppOwner",
]);
const VALID_OPS = new Set([
  "eq",
  "ne",
  "in",
  "notIn",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "notContains",
]);

// Shared condition-array validator used by both multiplier and paired-opp rules.
function validateConditions(
  raw: unknown,
  ruleRef: string,
): { ok: true; conditions: CompCondition[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: `${ruleRef} conditions must be an array` };
  const conditions: CompCondition[] = [];
  for (let j = 0; j < raw.length; j++) {
    const c = raw[j] as Record<string, unknown>;
    if (!c || typeof c !== "object") return { ok: false, error: `${ruleRef} condition[${j}] invalid` };
    if (!VALID_FIELDS.has(c.field as CompField)) {
      return { ok: false, error: `${ruleRef} condition[${j}] field "${String(c.field)}" invalid` };
    }
    if (!VALID_OPS.has(c.op as string)) {
      return { ok: false, error: `${ruleRef} condition[${j}] op "${String(c.op)}" invalid` };
    }
    const op = c.op as CompCondition["op"];
    if ((op === "in" || op === "notIn") && !Array.isArray(c.value)) {
      return { ok: false, error: `${ruleRef} condition[${j}] value must be an array for ${op}` };
    }
    const scalarOps = ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "notContains"];
    if (scalarOps.includes(op) && (Array.isArray(c.value) || c.value === undefined || c.value === null)) {
      return { ok: false, error: `${ruleRef} condition[${j}] value must be a scalar for ${op}` };
    }
    conditions.push({ field: c.field as CompField, op, value: c.value as CompCondition["value"] });
  }
  return { ok: true, conditions };
}

export function validateMultiplierRules(input: unknown): {
  ok: boolean;
  error?: string;
  rules?: CompMultiplierRule[];
} {
  if (!Array.isArray(input)) return { ok: false, error: "multiplierRules must be an array" };
  const rules: CompMultiplierRule[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const r = input[i] as Record<string, unknown>;
    if (!r || typeof r !== "object") return { ok: false, error: `rule[${i}] must be an object` };
    const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : "";
    if (!id) return { ok: false, error: `rule[${i}].id is required` };
    if (seenIds.has(id)) return { ok: false, error: `duplicate rule id "${id}"` };
    seenIds.add(id);
    const label = typeof r.label === "string" ? r.label : id;
    const multiplier = Number(r.multiplier);
    if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 100) {
      return { ok: false, error: `rule "${id}" multiplier must be a number 0-100` };
    }
    const condResult = validateConditions(r.conditions, `rule "${id}"`);
    if (!condResult.ok) return { ok: false, error: condResult.error };
    const conditions = condResult.conditions;
    // Optional per-rule MRR-source-field override (Task #276). Reject unknown
    // columns — an unrecognized field cannot produce MRR and would silently
    // break the comp math.
    let mrrField: MrrField | undefined;
    if (r.mrrField !== undefined && r.mrrField !== null && r.mrrField !== "") {
      if (typeof r.mrrField !== "string" || !VALID_MRR_FIELDS.has(r.mrrField)) {
        return { ok: false, error: `rule "${id}" mrrField "${String(r.mrrField)}" invalid` };
      }
      mrrField = r.mrrField as MrrField;
    }
    // Task #314: a rule may reference only one upstream source. Reject one that
    // mixes a CPD product (ZMX / Showcase Incremental - Re/Max) with a feeder
    // product, and reject an MRR-field choice from the wrong source.
    const { source: ruleSource, mixed } = classifyRuleSource(conditions);
    if (mixed) {
      return {
        ok: false,
        error: `rule "${id}" mixes CPD products (ZMX / Showcase Incremental - Re/Max) with feeder products; split them into separate rules`,
      };
    }
    if (mrrField && MRR_FIELD_SOURCE[mrrField] !== ruleSource) {
      return {
        ok: false,
        error: `rule "${id}" base MRR source "${mrrField}" is a ${MRR_FIELD_SOURCE[mrrField]} column but the rule targets ${ruleSource} products`,
      };
    }
    const appliesInRes = validateAppliesIn(r.appliesIn, `rule "${id}"`);
    if (!appliesInRes.ok) return { ok: false, error: appliesInRes.error };
    const appliesIn = appliesInRes.value;
    rules.push({
      id,
      label,
      conditions,
      multiplier,
      ...(mrrField ? { mrrField } : {}),
      ...(appliesIn ? { appliesIn } : {}),
    });
  }
  return { ok: true, rules };
}

// Validate an optional per-rule revenue-mode scope. Omitted/null/"" => undefined
// (treated as "quota" everywhere). Any other value must be one of the three
// valid scopes.
function validateAppliesIn(
  v: unknown,
  ref: string,
): { ok: true; value?: CompRevenueScope } | { ok: false; error: string } {
  if (v === undefined || v === null || v === "") return { ok: true };
  if (v === "quota" || v === "sales" || v === "both") {
    return { ok: true, value: v };
  }
  return {
    ok: false,
    error: `${ref} appliesIn "${String(v)}" must be one of quota, sales, both`,
  };
}

// Identity (string-valued) fields usable on either side of an identity
// comparative condition. Distinguishes value-join comparatives from numeric
// (feeder MRR) magnitude comparatives.
const IDENTITY_FIELDS = new Set<string>(COMP_IDENTITY_FIELDS);
function isIdentityField(field: unknown): field is CompIdentityField {
  return typeof field === "string" && IDENTITY_FIELDS.has(field);
}
// Date-typed identity fields support month/exact granularity and chronological
// ordering comparatives. Task #347: fub_first_purchase_date joins closeDate.
const DATE_IDENTITY_FIELDS = new Set<CompIdentityField>([
  "closeDate",
  "fub_first_purchase_date",
]);
function isDateIdentityField(field: unknown): field is CompIdentityField {
  return typeof field === "string" && DATE_IDENTITY_FIELDS.has(field as CompIdentityField);
}
const VALID_ADJ_OPS = new Set<CompAdjustmentOp>([
  "waive",
  "keep",
  "ignoreAcqChurn",
  "fixedCredit",
  "capAt",
  "incremental",
  "greaterOfFloorOrIncremental",
  "multiplyByFactor",
  "reassignMrrField",
]);
// Numeric comparison operators usable in a comparative condition.
const COMPARATIVE_OPS = new Set<CompOp>(["eq", "ne", "gt", "gte", "lt", "lte"]);

// Task #420 — validate one numeric comparative FORMULA side (leftTerms /
// rightTerms). Opp-name references are checked later (validateNamedOpps 2nd pass)
// where the rule's opp list is known. Returns the cleaned, ordered term list.
function validateLogicTerms(
  raw: unknown,
  ruleRef: string,
  idx: number,
  side: "leftTerms" | "rightTerms",
): { ok: true; terms: CompLogicTerm[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: `${ruleRef} condition[${idx}] ${side} must be a non-empty array` };
  }
  const terms: CompLogicTerm[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as Record<string, unknown>;
    if (!t || typeof t !== "object") {
      return { ok: false, error: `${ruleRef} condition[${idx}] ${side}[${i}] invalid` };
    }
    const source = t.source === "custom" ? "custom" : "opp";
    const term: CompLogicTerm = { source };
    // joinOp is ignored on the FIRST term; defaults to "add" otherwise.
    if (i > 0) {
      const jo = t.joinOp;
      if (jo === undefined || jo === null) {
        term.joinOp = "add";
      } else if (jo === "add" || jo === "subtract" || jo === "multiply" || jo === "divide") {
        term.joinOp = jo;
      } else {
        return { ok: false, error: `${ruleRef} condition[${idx}] ${side}[${i}] joinOp "${String(jo)}" invalid` };
      }
    }
    if (source === "custom") {
      const v = t.value;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return { ok: false, error: `${ruleRef} condition[${idx}] ${side}[${i}] custom value must be a finite number` };
      }
      if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-9) {
        return { ok: false, error: `${ruleRef} condition[${idx}] ${side}[${i}] custom value supports at most 2 decimal places` };
      }
      term.value = Math.round(v * 100) / 100;
    } else {
      const opp = typeof t.opp === "string" ? t.opp.trim() : "";
      if (!opp) {
        return { ok: false, error: `${ruleRef} condition[${idx}] ${side}[${i}] opp term requires an opp` };
      }
      if (!VALID_FEEDER_MRR_FIELDS.has(t.field as string)) {
        return { ok: false, error: `${ruleRef} condition[${idx}] ${side}[${i}] field must be a feeder MRR column` };
      }
      term.opp = opp;
      term.field = t.field as CompComparableField;
      if (t.factor !== undefined && t.factor !== null) {
        if (typeof t.factor !== "number" || !Number.isFinite(t.factor)) {
          return { ok: false, error: `${ruleRef} condition[${idx}] ${side}[${i}] factor must be a finite number` };
        }
        term.factor = t.factor;
      }
      if (t.factorOp !== undefined && t.factorOp !== null) {
        const fo = t.factorOp;
        if (fo !== "add" && fo !== "subtract" && fo !== "multiply" && fo !== "divide") {
          return { ok: false, error: `${ruleRef} condition[${idx}] ${side}[${i}] factorOp "${String(fo)}" invalid` };
        }
        term.factorOp = fo;
      }
      if (t.signed !== undefined && t.signed !== null) {
        if (typeof t.signed !== "boolean") {
          return { ok: false, error: `${ruleRef} condition[${idx}] ${side}[${i}] signed must be a boolean` };
        }
        term.signed = t.signed;
      }
    }
    terms.push(term);
  }
  return { ok: true, terms };
}

// Validates a single condition inside a named opp (field or comparative).
function validatePairedCondition(
  raw: unknown,
  ruleRef: string,
  idx: number,
): { ok: true; condition: CompPairedCondition } | { ok: false; error: string } {
  const c = raw as Record<string, unknown>;
  if (!c || typeof c !== "object") return { ok: false, error: `${ruleRef} condition[${idx}] invalid` };
  const kind = c.kind === "comparative" ? "comparative" : "field";
  if (kind === "field") {
    const fieldRes = validateConditions([{ field: c.field, op: c.op, value: c.value }], ruleRef);
    if (!fieldRes.ok) return { ok: false, error: fieldRes.error };
    const fc = fieldRes.conditions[0];
    return { ok: true, condition: { kind: "field", field: fc.field, op: fc.op, value: fc.value } };
  }
  // Comparative. Two sub-kinds by field type:
  //  - identity field (string): a per-row VALUE join (op must be eq/ne).
  //  - numeric field (feeder MRR): an aggregate |Σ| magnitude comparison.
  // Both sides must be the SAME kind.
  const identity = isIdentityField(c.field);
  const numeric = VALID_FEEDER_MRR_FIELDS.has(c.field as string);
  if (!identity && !numeric) {
    return { ok: false, error: `${ruleRef} condition[${idx}] comparative field "${String(c.field)}" must be an identity field or a feeder MRR column` };
  }
  if (identity) {
    if (isDateIdentityField(c.field)) {
      // A date identity (closeDate / fub_first_purchase_date) supports value
      // joins (eq/ne) AND chronological ordering (gt/gte/lt/lte).
      if (!COMPARATIVE_OPS.has(c.op as CompOp)) {
        return { ok: false, error: `${ruleRef} condition[${idx}] comparative op "${String(c.op)}" invalid` };
      }
    } else if (c.op !== "eq" && c.op !== "ne") {
      return { ok: false, error: `${ruleRef} condition[${idx}] identity comparative op "${String(c.op)}" must be "eq" or "ne"` };
    }
  } else if (!COMPARATIVE_OPS.has(c.op as CompOp)) {
    return { ok: false, error: `${ruleRef} condition[${idx}] comparative op "${String(c.op)}" invalid` };
  }
  // Task #420 — numeric FORMULA mode. When leftTerms/rightTerms are present, each
  // side is an ordered logic-term list that SUPERSEDES the single compareToOpp /
  // compareToField (+ factor/sign) operand, so those legacy fields are no longer
  // required and the compareToField kind check is skipped. Formulas are numeric
  // only; reject them on identity comparatives.
  const usesTerms =
    Array.isArray(c.leftTerms) || Array.isArray(c.rightTerms);
  if (usesTerms && identity) {
    return { ok: false, error: `${ruleRef} condition[${idx}] leftTerms/rightTerms (formula) are only allowed on a numeric (magnitude) comparative` };
  }
  const compareToOpp = typeof c.compareToOpp === "string" ? c.compareToOpp.trim() : "";
  if (!compareToOpp && !usesTerms) {
    return { ok: false, error: `${ruleRef} condition[${idx}] comparative compareToOpp is required` };
  }
  const cfIdentity = isIdentityField(c.compareToField);
  const cfNumeric = VALID_FEEDER_MRR_FIELDS.has(c.compareToField as string);
  if (identity && !cfIdentity) {
    return { ok: false, error: `${ruleRef} condition[${idx}] identity comparative compareToField "${String(c.compareToField)}" must be an identity field` };
  }
  if (numeric && !usesTerms && !cfNumeric) {
    return { ok: false, error: `${ruleRef} condition[${idx}] comparative compareToField "${String(c.compareToField)}" must be a feeder MRR column` };
  }
  // Ordering ops on an identity comparison are only meaningful between date
  // fields. Both sides must be date identity fields, but they need NOT be the
  // same field — cross-field chronological comparison (e.g. Close Date ≥ FUB
  // First Purchase Date) is supported; each side's date ordinal is computed
  // independently in evaluation.
  const orderingOp = c.op === "gt" || c.op === "gte" || c.op === "lt" || c.op === "lte";
  if (
    identity &&
    orderingOp &&
    (!isDateIdentityField(c.field) || !isDateIdentityField(c.compareToField))
  ) {
    return { ok: false, error: `${ruleRef} condition[${idx}] ordering comparison (>, ≥, <, ≤) is only supported between date fields (Close Date or FUB First Purchase Date)` };
  }
  const condition: CompComparativeCondition = {
    kind: "comparative",
    field: c.field as CompComparableField | CompIdentityField,
    op: c.op as CompOp,
    compareToOpp,
    compareToField: c.compareToField as CompComparableField | CompIdentityField,
  };
  // dateGranularity only meaningful for an identity date link (closeDate /
  // fub_first_purchase_date). Reject it on any other field per spec.
  const g = c.dateGranularity;
  if (g !== undefined && g !== null) {
    if (!identity || !isDateIdentityField(c.field)) {
      return { ok: false, error: `${ruleRef} condition[${idx}] dateGranularity is only allowed on an identity date comparative (Close Date or FUB First Purchase Date)` };
    }
    if (g !== "month" && g !== "exact") {
      return { ok: false, error: `${ruleRef} condition[${idx}] dateGranularity "${String(g)}" invalid` };
    }
    condition.dateGranularity = g;
  }
  // factor / factorOp / per-side signed flags are numeric (magnitude)
  // comparative modifiers only; reject them on identity comparatives (the UI
  // clears them when switching kinds).
  // Scalars: legacy `factor` (= right side) plus the per-side `leftFactor` /
  // `rightFactor`. All numeric-only and finite.
  for (const key of ["factor", "leftFactor", "rightFactor"] as const) {
    const fv = (c as Record<string, unknown>)[key];
    if (fv === undefined || fv === null) continue;
    if (!numeric) {
      return { ok: false, error: `${ruleRef} condition[${idx}] ${key} is only allowed on a numeric (magnitude) comparative` };
    }
    if (typeof fv !== "number" || !Number.isFinite(fv)) {
      return { ok: false, error: `${ruleRef} condition[${idx}] ${key} "${String(fv)}" must be a finite number` };
    }
    (condition as unknown as Record<string, unknown>)[key] = fv;
  }
  // Task #411 — math operators: legacy `factorOp` (= right side) plus the
  // per-side `leftFactorOp` / `rightFactorOp`.
  for (const key of ["factorOp", "leftFactorOp", "rightFactorOp"] as const) {
    const fo = (c as Record<string, unknown>)[key];
    if (fo === undefined || fo === null) continue;
    if (!numeric) {
      return { ok: false, error: `${ruleRef} condition[${idx}] ${key} is only allowed on a numeric (magnitude) comparative` };
    }
    if (fo !== "add" && fo !== "subtract" && fo !== "multiply" && fo !== "divide") {
      return { ok: false, error: `${ruleRef} condition[${idx}] ${key} "${String(fo)}" invalid` };
    }
    (condition as unknown as Record<string, unknown>)[key] = fo;
  }
  // Task #411 — per-side "Actual Value" (signed) flags. `signed` is the legacy
  // single flag, kept for back-compat.
  for (const [key, label] of [
    ["leftSigned", "leftSigned"],
    ["rightSigned", "rightSigned"],
    ["signed", "signed"],
  ] as const) {
    const v = (c as Record<string, unknown>)[key];
    if (v === undefined || v === null) continue;
    if (!numeric) {
      return { ok: false, error: `${ruleRef} condition[${idx}] ${label} is only allowed on a numeric (magnitude) comparative` };
    }
    if (typeof v !== "boolean") {
      return { ok: false, error: `${ruleRef} condition[${idx}] ${label} "${String(v)}" must be a boolean` };
    }
    condition[key] = v;
  }
  // Task #420 — attach the validated formula sides. Both sides are required when
  // in formula mode so each comparison has a complete left and right operand.
  if (usesTerms) {
    const leftRes = validateLogicTerms(c.leftTerms, ruleRef, idx, "leftTerms");
    if (!leftRes.ok) return { ok: false, error: leftRes.error };
    const rightRes = validateLogicTerms(c.rightTerms, ruleRef, idx, "rightTerms");
    if (!rightRes.ok) return { ok: false, error: rightRes.error };
    condition.leftTerms = leftRes.terms;
    condition.rightTerms = rightRes.terms;
  }
  return { ok: true, condition };
}

// Validates a rule's named opportunities (Match/Exclude). Returns the parsed
// opps plus the set of Match-opp names (the valid targets for adjustments;
// comparatives may reference any opp in the rule, see second pass below).
function validateNamedOpps(
  raw: unknown,
  ruleRef: string,
): { ok: true; opps: CompNamedOpp[]; matchNames: Set<string> } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: `${ruleRef} opps must be a non-empty array` };
  }
  const opps: CompNamedOpp[] = [];
  const seen = new Set<string>();
  const matchNames = new Set<string>();
  // First pass: shape + names. Comparative references resolved in second pass.
  for (let i = 0; i < raw.length; i++) {
    const o = raw[i] as Record<string, unknown>;
    if (!o || typeof o !== "object") return { ok: false, error: `${ruleRef} opp[${i}] must be an object` };
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) return { ok: false, error: `${ruleRef} opp[${i}].name is required` };
    if (seen.has(name)) return { ok: false, error: `${ruleRef} duplicate opp name "${name}"` };
    seen.add(name);
    const mode: CompOppMode = o.mode === "exclude" ? "exclude" : "match";
    if (mode === "match") matchNames.add(name);
    if (!Array.isArray(o.conditions) || o.conditions.length === 0) {
      return { ok: false, error: `${ruleRef} opp "${name}" conditions must be a non-empty array` };
    }
    const conditions: CompPairedCondition[] = [];
    for (let j = 0; j < o.conditions.length; j++) {
      const cRes = validatePairedCondition(o.conditions[j], `${ruleRef} opp "${name}"`, j);
      if (!cRes.ok) return { ok: false, error: cRes.error };
      conditions.push(cRes.condition);
    }
    opps.push({ name, mode, conditions });
  }
  // Second pass: validate cross-opp references + the anchor/join structure.
  //  - The first opp is the ANCHOR and must be a Match opp.
  //  - Every comparative references an opp in the rule (any mode, Match OR
  //    Exclude). A comparative MAY reference its own opp (a same-opp, per-row
  //    internal field comparison).
  //  - Cross-opp identity (value-join) comparatives must reference an EARLIER
  //    opp, so the resolution order is well-defined (and every opp is
  //    transitively tied to the anchor). Same-opp comparatives and closeDate
  //    ordering gates are exempt.
  //  - Every non-anchor opp must carry ≥1 cross-opp identity "=" link to an
  //    earlier opp.
  if (opps[0].mode !== "match") {
    return { ok: false, error: `${ruleRef} the first opp "${opps[0].name}" (anchor) must be a Match opp` };
  }
  const oppIndex = new Map<string, number>();
  opps.forEach((o, i) => oppIndex.set(o.name, i));
  for (let oi = 0; oi < opps.length; oi++) {
    const opp = opps[oi];
    let hasIdentityEqLink = false;
    for (const c of opp.conditions) {
      if (c.kind !== "comparative") continue;
      // Task #420 — formula-term numeric comparatives carry no single
      // compareToOpp; instead every opp-sourced term must reference an opp in the
      // rule. They impose no earlier-opp / identity-link obligation (rule-level
      // aggregate gates, not joins), so they are exempt from the checks below.
      if (!isIdentityField(c.field) && hasFormulaTerms(c)) {
        for (const t of [...(c.leftTerms ?? []), ...(c.rightTerms ?? [])]) {
          if (t.source === "opp" && !oppIndex.has(t.opp ?? "")) {
            return { ok: false, error: `${ruleRef} opp "${opp.name}" formula term opp "${String(t.opp)}" is not an opp in this rule` };
          }
        }
        continue;
      }
      if (!oppIndex.has(c.compareToOpp)) {
        return { ok: false, error: `${ruleRef} opp "${opp.name}" comparative compareToOpp "${c.compareToOpp}" is not an opp in this rule` };
      }
      // Same-opp comparatives are per-row internal field comparisons; they carry
      // no cross-opp ordering/join obligations.
      if (c.compareToOpp === opp.name) continue;
      if (isIdentityField(c.field)) {
        // Identity eq/ne are value JOINS that must resolve against an EARLIER
        // opp. closeDate ordering (gt/gte/lt/lte) is a post-join gate that may
        // reference any other opp, so it is exempt.
        const isJoinOp = c.op === "eq" || c.op === "ne";
        if (isJoinOp) {
          const refIdx = oppIndex.get(c.compareToOpp)!;
          if (refIdx >= oi) {
            return { ok: false, error: `${ruleRef} opp "${opp.name}" identity link must reference an EARLIER opp (not "${c.compareToOpp}")` };
          }
          if (c.op === "eq") hasIdentityEqLink = true;
        }
      }
    }
    if (oi > 0 && !hasIdentityEqLink) {
      return { ok: false, error: `${ruleRef} opp "${opp.name}" must have at least one identity "=" link to an earlier opportunity` };
    }
  }
  return { ok: true, opps, matchNames };
}

function validateAdjustment(
  raw: unknown,
  ruleRef: string,
  idx: number,
  matchNames: Set<string>,
): { ok: true; adjustment: CompAdjustment } | { ok: false; error: string } {
  const a = raw as Record<string, unknown>;
  if (!a || typeof a !== "object") return { ok: false, error: `${ruleRef} adjustment[${idx}] invalid` };
  const targetOpp = typeof a.targetOpp === "string" ? a.targetOpp.trim() : "";
  if (!targetOpp) return { ok: false, error: `${ruleRef} adjustment[${idx}].targetOpp is required` };
  if (!matchNames.has(targetOpp)) {
    return { ok: false, error: `${ruleRef} adjustment[${idx}].targetOpp "${targetOpp}" must be a Match opp` };
  }
  if (!VALID_ADJ_OPS.has(a.op as CompAdjustmentOp)) {
    return { ok: false, error: `${ruleRef} adjustment[${idx}].op "${String(a.op)}" invalid` };
  }
  const op = a.op as CompAdjustmentOp;
  const adjustment: CompAdjustment = { targetOpp, op };
  // Ops that need a numeric amount.
  if (op === "fixedCredit" || op === "capAt" || op === "greaterOfFloorOrIncremental" || op === "multiplyByFactor") {
    const amount = Number(a.amount);
    if (!Number.isFinite(amount)) {
      return { ok: false, error: `${ruleRef} adjustment[${idx}].amount must be a number for ${op}` };
    }
    adjustment.amount = amount;
  }
  // Ops that compare against another (Match) opp's magnitude.
  if (op === "incremental" || op === "greaterOfFloorOrIncremental") {
    const comparisonOpp = typeof a.comparisonOpp === "string" ? a.comparisonOpp.trim() : "";
    if (!comparisonOpp) {
      return { ok: false, error: `${ruleRef} adjustment[${idx}].comparisonOpp is required for ${op}` };
    }
    if (!matchNames.has(comparisonOpp)) {
      return { ok: false, error: `${ruleRef} adjustment[${idx}].comparisonOpp "${comparisonOpp}" must be a Match opp` };
    }
    adjustment.comparisonOpp = comparisonOpp;
    // Optional feeder MRR column to measure the comparison opp by. When omitted
    // the comparison falls back to standardized MRR (existing behavior).
    if (a.comparisonField !== undefined && a.comparisonField !== null && a.comparisonField !== "") {
      if (typeof a.comparisonField !== "string" || !VALID_FEEDER_MRR_FIELDS.has(a.comparisonField)) {
        return { ok: false, error: `${ruleRef} adjustment[${idx}].comparisonField must be a feeder MRR column for ${op}` };
      }
      adjustment.comparisonField = a.comparisonField as MrrField;
    }
  }
  // reassignMrrField sets each target row's comp to a feeder MRR column.
  if (op === "reassignMrrField") {
    if (typeof a.mrrField !== "string" || !VALID_FEEDER_MRR_FIELDS.has(a.mrrField)) {
      return { ok: false, error: `${ruleRef} adjustment[${idx}].mrrField must be a feeder MRR column for reassignMrrField` };
    }
    adjustment.mrrField = a.mrrField as MrrField;
  }
  // Optional gated owner reassignment to another (Match) opp's owner.
  if (a.reassignOwnerToOpp !== undefined && a.reassignOwnerToOpp !== null && a.reassignOwnerToOpp !== "") {
    const reassignOwnerToOpp = typeof a.reassignOwnerToOpp === "string" ? a.reassignOwnerToOpp.trim() : "";
    if (!reassignOwnerToOpp || !matchNames.has(reassignOwnerToOpp)) {
      return { ok: false, error: `${ruleRef} adjustment[${idx}].reassignOwnerToOpp "${String(a.reassignOwnerToOpp)}" must be a Match opp` };
    }
    adjustment.reassignOwnerToOpp = reassignOwnerToOpp;
  }
  return { ok: true, adjustment };
}

// Task #411 — normalize stored paired-opp rule configs in place. For every
// NUMERIC comparative condition (under `rule.opps[].conditions`) it materializes
// the legacy single `signed` flag into per-side `leftSigned`/`rightSigned`
// (per-side flags, if already present, win and the legacy flag is dropped) and
// maps an existing scalar `factor` to the explicit `multiply` operator. Returns
// true when any condition was changed. Pure (apart from mutating `rules`) so the
// startup migration and unit tests share the exact same traversal/logic.
export function normalizeComparativeSidedFactorOp(rules: unknown): boolean {
  if (!Array.isArray(rules)) return false;
  let changed = false;
  for (const rule of rules) {
    const opps = (rule as { opps?: unknown })?.opps;
    if (!Array.isArray(opps)) continue;
    for (const opp of opps) {
      const conditions = (opp as { conditions?: unknown })?.conditions;
      if (!Array.isArray(conditions)) continue;
      for (const cond of conditions) {
        if (!cond || typeof cond !== "object") continue;
        const c = cond as Record<string, unknown>;
        if (c.kind !== "comparative") continue;
        // Only numeric comparatives carry signed/factor; identity ones don't.
        const hasSigned = typeof c.signed === "boolean";
        const hasFactor =
          typeof c.factor === "number" && Number.isFinite(c.factor as number);
        // Materialize per-side flags from legacy `signed` when not already
        // explicitly set on this condition; otherwise drop the redundant flag.
        if (hasSigned) {
          if (
            typeof c.leftSigned !== "boolean" &&
            typeof c.rightSigned !== "boolean"
          ) {
            const signedOn = c.signed === true;
            c.leftSigned = signedOn;
            c.rightSigned = signedOn;
          }
          delete c.signed;
          changed = true;
        }
        // Map an existing scalar to the explicit multiply operator.
        if (hasFactor && c.factorOp === undefined) {
          c.factorOp = "multiply";
          changed = true;
        }
      }
    }
  }
  return changed;
}

export function validatePairedOppRules(input: unknown): {
  ok: boolean;
  error?: string;
  rules?: PairedOppRule[];
} {
  if (!Array.isArray(input)) return { ok: false, error: "pairedOppRules must be an array" };
  const rules: PairedOppRule[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const r = input[i] as Record<string, unknown>;
    if (!r || typeof r !== "object") return { ok: false, error: `pairedOppRule[${i}] must be an object` };
    const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : "";
    if (!id) return { ok: false, error: `pairedOppRule[${i}].id is required` };
    if (seenIds.has(id)) return { ok: false, error: `duplicate pairedOppRule id "${id}"` };
    seenIds.add(id);
    const ruleRef = `pairedOppRule "${id}"`;
    const label = typeof r.label === "string" ? r.label : id;
    const enabled = r.enabled === undefined ? true : Boolean(r.enabled);

    const oppsRes = validateNamedOpps(r.opps, ruleRef);
    if (!oppsRes.ok) return { ok: false, error: oppsRes.error };

    if (!Array.isArray(r.adjustments) || r.adjustments.length === 0) {
      return { ok: false, error: `${ruleRef} adjustments must be a non-empty array` };
    }
    const adjustments: CompAdjustment[] = [];
    let needsReassignRoles = false;
    for (let j = 0; j < r.adjustments.length; j++) {
      const adjRes = validateAdjustment(r.adjustments[j], ruleRef, j, oppsRes.matchNames);
      if (!adjRes.ok) return { ok: false, error: adjRes.error };
      if (adjRes.adjustment.reassignOwnerToOpp) needsReassignRoles = true;
      adjustments.push(adjRes.adjustment);
    }

    // Rule-level owner-reassignment gate. Defaults to the canonical
    // {Compliance Sales, Account Sales} set when reassignment is used but no
    // explicit roles are configured.
    let reassignableOwnerRoles: string[] | undefined;
    if (r.reassignableOwnerRoles !== undefined && r.reassignableOwnerRoles !== null) {
      if (
        !Array.isArray(r.reassignableOwnerRoles) ||
        r.reassignableOwnerRoles.some((s) => typeof s !== "string")
      ) {
        return { ok: false, error: `${ruleRef} reassignableOwnerRoles must be a string array` };
      }
      reassignableOwnerRoles = (r.reassignableOwnerRoles as string[]).map((s) => s.trim()).filter(Boolean);
    } else if (needsReassignRoles) {
      reassignableOwnerRoles = [...defaultReassignableOwnerRoles()];
    }

    const appliesInRes = validateAppliesIn(r.appliesIn, ruleRef);
    if (!appliesInRes.ok) return { ok: false, error: appliesInRes.error };
    const appliesIn = appliesInRes.value;

    rules.push({
      id,
      label,
      enabled,
      opps: oppsRes.opps,
      adjustments,
      ...(reassignableOwnerRoles ? { reassignableOwnerRoles } : {}),
      ...(appliesIn ? { appliesIn } : {}),
    });
  }
  return { ok: true, rules };
}

// ---------------------------------------------------------------------------
// Multiplier engine — evaluate ordered, first-match-wins conditional rules.
// ---------------------------------------------------------------------------

// Structural input — callers pass the already-standardized MRR so this module
// never needs to know the `standardizeMrr` Type→column mapping.
export interface CompRowInput {
  oppId: string;
  accountId: string;
  // Task #317: link-field source for paired-opp matching (Contact ID) and the
  // owning rep (for gated owner reassignment + drilldown display).
  contactId?: string;
  rep?: string;
  // Task #434: the raw `User` and `Opportunity Owner` feeder columns, carried
  // independently of the blended `rep` (User || Opportunity Owner) so comp
  // conditions can test/join on each raw column on its own.
  user?: string;
  oppOwner?: string;
  oppName?: string;
  product: string;
  rawProduct: string;
  productFamily: string;
  type: string;
  closeDate: string;
  // Mapped funnel stage (e.g. "Closed Won"). Used to gate the FUB↔Zpro pairing
  // to opps that are actually Closed Won on both sides.
  funnelStage?: string;
  termLength?: string;
  legacyFlag?: boolean;
  flexFlipAgentStatus?: string;
  // Task #347: FUB first-purchase date from the frontline_dash_product_data
  // Databricks table, joined onto the feeder row by 18-char opp id. Blank for
  // opps without a match. Selectable as a regular condition field and as a
  // paired-rule identity (comparative/join) field with month/exact granularity.
  fubFirstPurchaseDate?: string;
  // "Acquisitions" | "G&R" | "" — resolved from the org hierarchy by caller.
  group?: string;
  segment?: string;
  salesRole?: string;
  quoteType?: string;
  standardizedMrr: number;
  // Task #276: raw numeric feeder-sheet columns, used as the base MRR when a
  // matching rule overrides the MRR source field. Optional so callers that
  // don't supply them simply fall back to standardizedMrr.
  changeInMrr?: number;
  totalMrr?: number;
  splitTotalPrice?: number;
  totalPrice?: number;
  amount?: number;
  mrr?: number;
  // True for CPD-sourced rows (ZMX / Showcase Incremental - Re/Max) whose MRR
  // comes from Databricks, not the feeder sheet. For these rows a matching
  // rule's MRR-source override picks from the CPD columns below (Task #314),
  // not the feeder columns above.
  isCpdSourced?: boolean;
  // Task #314: CPD change-in-MRR columns (frontline_dash_cpds). Used as the
  // base MRR when a matching CPD rule overrides the source to one of these.
  // Optional so callers that don't supply them fall back to the default base.
  cpdPositiveChangeInMrr?: number;
  cpdNegativeChangeInMrr?: number;
}

// Reads a raw numeric column off a comp row for the MRR-source-field override.
// Returns null when the column wasn't supplied so the engine can fall back to
// the Type-driven standardized MRR.
function mrrFieldValue(row: CompRowInput, field: MrrField): number | null {
  switch (field) {
    case "changeInMrr":
      return row.changeInMrr ?? null;
    case "totalMrr":
      return row.totalMrr ?? null;
    case "splitTotalPrice":
      return row.splitTotalPrice ?? null;
    case "totalPrice":
      return row.totalPrice ?? null;
    case "amount":
      return row.amount ?? null;
    case "mrr":
      return row.mrr ?? null;
    default:
      return null;
  }
}

// Task #314: reads a CPD-object MRR column for a CPD-sourced row's base-MRR
// override. `mrr_added` is the default base — for CPD rows it equals the
// standardized MRR — so selecting it leaves comp unchanged. The change-in-MRR
// columns return null when not supplied so the engine falls back to the base.
function cpdMrrFieldValue(row: CompRowInput, field: MrrField): number | null {
  switch (field) {
    case "mrr_added":
      return row.standardizedMrr;
    case "positive_change_in_mrr":
      return row.cpdPositiveChangeInMrr ?? null;
    case "negative_change_in_mrr":
      return row.cpdNegativeChangeInMrr ?? null;
    default:
      return null;
  }
}

// Task #335: the signed MRR magnitude a paired-opp rule uses for one side of a
// pair. When the side has an explicit per-side MRR field, read that feeder-sheet
// column (preserving its sign so churn rows stay negative); otherwise — and for
// CPD-sourced rows or a row missing the chosen column — fall back to the
// Type-driven standardized MRR. Paired rules are feeder-only by design, so a
// non-feeder field (or a CPD row) is ignored.
function pairedSideMrrValue(row: CompRowInput, field: MrrField | undefined): number {
  if (field && !row.isCpdSourced && MRR_FIELD_SOURCE[field] === "feeder") {
    const fv = mrrFieldValue(row, field);
    if (fv !== null) return fv;
  }
  return row.standardizedMrr;
}

function fieldValue(row: CompRowInput, field: CompField): string | number | boolean {
  switch (field) {
    case "product":
      return row.product || "";
    case "rawProduct":
      return row.rawProduct || "";
    case "productFamily":
      return row.productFamily || "";
    case "type":
      return row.type || "";
    case "termLength":
      return row.termLength || "";
    case "legacyFlag":
      return row.legacyFlag === true;
    case "group":
      return row.group || "";
    case "segment":
      return row.segment || "";
    case "salesRole":
      return row.salesRole || "";
    case "quoteType":
      return row.quoteType || "";
    // Task #434: raw User / Opportunity Owner columns as standard fields.
    case "user":
      return row.user || "";
    case "oppOwner":
      return row.oppOwner || "";
    // Task #317: paired-opp condition fields.
    case "oppName":
      return row.oppName || "";
    case "funnelStage":
      return row.funnelStage || "";
    case "flexFlipAgentStatus":
      return row.flexFlipAgentStatus || "";
    case "changeInMrr":
      return row.changeInMrr ?? row.standardizedMrr;
    case "splitTotalPrice":
      return row.splitTotalPrice ?? 0;
    // Task #347: FUB first-purchase date (string-valued; standard operators
    // compare against a typed value).
    case "fub_first_purchase_date":
      return row.fubFirstPurchaseDate || "";
    default:
      return "";
  }
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

// Equality with boolean awareness and numeric-aware string comparison so that
// term length "12" matches "12.0", and case differences don't matter.
function valuesEqual(a: string | number | boolean, b: unknown): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") {
    return toBool(a) === toBool(b);
  }
  const sa = String(a).trim();
  const sb = String(b).trim();
  if (sa !== "" && sb !== "") {
    const na = Number(sa);
    const nb = Number(sb);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  }
  return sa.toLowerCase() === sb.toLowerCase();
}

function matchCondition(row: CompRowInput, cond: CompCondition): boolean {
  const fv = fieldValue(row, cond.field);
  switch (cond.op) {
    case "eq":
      return valuesEqual(fv, cond.value);
    case "ne":
      return !valuesEqual(fv, cond.value);
    case "in":
      return Array.isArray(cond.value) && cond.value.some((v: unknown) => valuesEqual(fv, v));
    case "notIn":
      return Array.isArray(cond.value) && !cond.value.some((v: unknown) => valuesEqual(fv, v));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const na = Number(fv);
      const nb = Number(cond.value);
      if (Number.isNaN(na) || Number.isNaN(nb)) return false;
      if (cond.op === "gt") return na > nb;
      if (cond.op === "gte") return na >= nb;
      if (cond.op === "lt") return na < nb;
      return na <= nb;
    }
    case "contains":
    case "notContains": {
      // Task #410: the value may be a comma-separated list (e.g. "v4, version4").
      // `contains` matches when the field contains ANY token; `notContains`
      // matches when it contains NONE. Tokens are trimmed, empties dropped, and
      // matching is case-insensitive. A single value with no comma behaves
      // exactly as before. With no non-empty tokens, `contains` is false and
      // `notContains` is true (excludes nothing).
      const hay = String(fv).toLowerCase();
      const tokens = String(cond.value)
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t !== "");
      const anyMatch = tokens.some((t) => hay.includes(t));
      return cond.op === "contains" ? anyMatch : !anyMatch;
    }
    default:
      return false;
  }
}

// Shared matcher: true when EVERY condition matches (logical AND) against a row.
// Exported so the Product Logic engine (Task #350) can reuse the exact same
// field accessor / operator semantics as compensation rules.
export function rowMatchesAllConditions(
  row: CompRowInput,
  conditions: CompCondition[],
): boolean {
  return conditions.every((c) => matchCondition(row, c));
}

// Task #572: per-condition diagnosis of a flat condition list against a single
// row — the Product Logic opp tester's row-level counterpart of
// diagnoseMultiplierRule (which picks a best row). Aligned index-for-index.
export function testConditionsAgainstRow(
  row: CompRowInput,
  conditions: CompCondition[],
): CompConditionTestStatus[] {
  return conditions.map((c) => (matchCondition(row, c) ? "match" : "noMatch"));
}

// A single multiplier rule that matched an opp, captured for drilldown display.
export interface AppliedRule {
  id: string;
  label: string;
  multiplier: number;
}

// Returns the combined multiplier — the product of every rule whose conditions
// all match (rules STACK, they are not first-match-wins) — and the ordered list
// of rules that matched. When no rule matches the multiplier is 1.0 (compensable
// MRR == actual MRR) and the list is empty.
export function evaluateMultiplier(
  row: CompRowInput,
  rules: CompMultiplierRule[],
): {
  multiplier: number;
  applied: AppliedRule[];
  // Task #276: the MRR-source field from the first (top-down) matching rule
  // that set one, the label of that winning rule, and the labels of every
  // matching field-setting rule (so the drilldown can flag multi-match opps).
  mrrField: MrrField | null;
  mrrFieldRuleLabel: string | null;
  mrrFieldRuleLabels: string[];
} {
  let multiplier = 1;
  const applied: AppliedRule[] = [];
  let mrrField: MrrField | null = null;
  let mrrFieldRuleLabel: string | null = null;
  const mrrFieldRuleLabels: string[] = [];
  for (const rule of rules) {
    // Task #362: a persisted (jsonb) rule may be malformed — missing/non-array
    // conditions — which would otherwise throw mid-compute and 500 the whole
    // request. Treat such a rule as a non-match instead of crashing.
    if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) continue;
    if (rule.conditions.every((c: CompCondition) => matchCondition(row, c))) {
      multiplier *= rule.multiplier;
      applied.push({ id: rule.id, label: rule.label, multiplier: rule.multiplier });
      if (rule.mrrField) {
        mrrFieldRuleLabels.push(rule.label);
        // First matching field-setting rule wins (top-down).
        if (mrrField === null) {
          mrrField = rule.mrrField;
          mrrFieldRuleLabel = rule.label;
        }
      }
    }
  }
  return { multiplier, applied, mrrField, mrrFieldRuleLabel, mrrFieldRuleLabels };
}

// ---------------------------------------------------------------------------
// Generic paired-opp engine.
//
// Replaces the hardcoded FUB↔Zpro pairing and the cancel/rebook
// churn-suppression with one configurable matcher. A rule links opportunities
// that share the configured link-field value(s), then evaluates a set of NAMED
// opportunities (Match/Exclude) and applies adjustments that reference those
// opps by name. The dashboard MODELS the adjustment Salesforce already applied,
// so a reverse toggle can show the pre-adjustment revenue (raw `standardizedMrr`).
// ---------------------------------------------------------------------------

// Kept for back-compat in display layers that still special-case these names.
export const FUB_PRODUCT = "Follow Up Boss";
export const ZPRO_PRODUCT = "Zillow Pro";
export const FUB_ZPRO_RULE_NAME = "FUB↔Zpro Linking";

function sign(n: number): number {
  return n < 0 ? -1 : 1;
}

// Extracts a row's value for an identity field, used by identity (value-join)
// comparative conditions. A date field is keyed by month unless the link
// explicitly asks for exact-day matching.
function identityValue(
  row: CompRowInput,
  field: CompIdentityField,
  gran?: CompDateGranularity,
): string {
  switch (field) {
    case "contactId":
      return (row.contactId || "").trim();
    case "accountId":
      return (row.accountId || "").trim();
    case "rep":
      return (row.rep || "").trim();
    // Task #434: raw User / Opportunity Owner as identity (join/≠) fields.
    case "user":
      return (row.user || "").trim();
    case "oppOwner":
      return (row.oppOwner || "").trim();
    case "closeDate":
      return gran === "exact"
        ? exactDateKey(row, "closeDate")
        : compMonthKey(row.closeDate);
    // Task #347: FUB first-purchase date as an identity (join) field, with the
    // same month/exact granularity handling as closeDate.
    case "fub_first_purchase_date":
      return gran === "exact"
        ? exactDateKey(row, "fub_first_purchase_date")
        : compMonthKey(row.fubFirstPurchaseDate || "");
    default:
      return String(fieldValue(row, field as CompField)).trim();
  }
}

// True when a row satisfies all of a named opp's FIELD conditions (comparative
// conditions are group-level gates, handled separately).
function rowMatchesOppFields(row: CompRowInput, opp: CompNamedOpp): boolean {
  return oppConditions(opp)
    .filter((c): c is Extract<CompPairedCondition, { kind: "field" }> => c.kind === "field")
    .every((c) => matchCondition(row, { field: c.field, op: c.op, value: c.value }));
}

// Task #362: a persisted (jsonb) named opp may be malformed — missing/non-array
// conditions. Normalize to an empty list so the engine never throws mid-compute
// (which would 500 the whole opportunities endpoint) on a bad config row.
function oppConditions(opp: CompNamedOpp): CompPairedCondition[] {
  return Array.isArray(opp.conditions) ? opp.conditions : [];
}

// Aggregate signed magnitude of a numeric feeder field across a set of rows.
function sumComparable(rows: CompRowInput[], idxs: number[], field: CompComparableField): number {
  return idxs.reduce((s, i) => s + pairedSideMrrValue(rows[i], field), 0);
}

// Task #411 — resolve the per-side magnitude flags for a numeric comparative.
// New per-side flags (leftSigned/rightSigned) take precedence; when both are
// absent we fall back to the legacy single `signed` flag (true → both sides
// signed). Default is the legacy MAGNITUDE comparison (both abs).
function resolveSidedSigned(c: CompComparativeCondition): {
  left: boolean;
  right: boolean;
} {
  const legacy = c.signed === true;
  return {
    left: typeof c.leftSigned === "boolean" ? c.leftSigned : legacy,
    right: typeof c.rightSigned === "boolean" ? c.rightSigned : legacy,
  };
}

// Task #411 — combine the RIGHT operand's Σ field sum with the scalar `factor`
// using the chosen operator (default multiply). Division by zero is handled
// safely by returning 0 (avoids Infinity/NaN leaking into the comparison).
function applyFactorOp(sum: number, op: CompFactorOp, scalar: number): number {
  switch (op) {
    case "add":
      return sum + scalar;
    case "subtract":
      return sum - scalar;
    case "divide":
      return scalar === 0 ? 0 : sum / scalar;
    case "multiply":
    default:
      return sum * scalar;
  }
}

// Operands for a NUMERIC comparative gate. The right operand's Σ field is
// combined with the scalar `factor` (default 1) via `factorOp` (default
// multiply). Each side then applies abs independently based on its per-side
// "Absolute Value" (default) vs "Actual Value" (signed) flag. Legacy configs
// (single `signed`, no factorOp) are honored via the resolvers above.
function comparativeOperands(
  rows: CompRowInput[],
  myIdx: number[],
  otherIdx: number[],
  c: CompComparativeCondition,
): { left: number; right: number } {
  // Per-side scalar + operator. The LEFT side defaults to identity (× 1). The
  // RIGHT side prefers its explicit per-side fields and falls back to the legacy
  // single `factor`/`factorOp` (which historically modified the right operand).
  const leftFactor =
    typeof c.leftFactor === "number" && Number.isFinite(c.leftFactor)
      ? c.leftFactor
      : 1;
  const leftOp: CompFactorOp = c.leftFactorOp ?? "multiply";
  const rightFactor =
    typeof c.rightFactor === "number" && Number.isFinite(c.rightFactor)
      ? c.rightFactor
      : typeof c.factor === "number" && Number.isFinite(c.factor)
        ? c.factor
        : 1;
  const rightOp: CompFactorOp = c.rightFactorOp ?? c.factorOp ?? "multiply";
  const leftRaw = applyFactorOp(
    sumComparable(rows, myIdx, c.field as CompComparableField),
    leftOp,
    leftFactor,
  );
  const rightRaw = applyFactorOp(
    sumComparable(rows, otherIdx, c.compareToField as CompComparableField),
    rightOp,
    rightFactor,
  );
  const { left: leftSigned, right: rightSigned } = resolveSidedSigned(c);
  return {
    left: leftSigned ? leftRaw : Math.abs(leftRaw),
    right: rightSigned ? rightRaw : Math.abs(rightRaw),
  };
}

// ── Task #420: per-side FORMULA evaluation ──────────────────────────────────
// A numeric comparative may carry leftTerms/rightTerms — an ordered list of
// logic terms per side. When present these SUPERSEDE the legacy single-operand
// fields and are evaluated here; when absent the legacy comparativeOperands path
// above runs unchanged (so existing rules are byte-identical). NB the per-term
// modifier is applied ABS-INSIDE — value = applyFactorOp(abs|signed(Σ), op,
// factor) — which differs from comparativeOperands' abs-OUTSIDE single operand.

// Does this numeric comparative use the per-side formula model?
function hasFormulaTerms(c: CompComparativeCondition): boolean {
  return Array.isArray(c.leftTerms) || Array.isArray(c.rightTerms);
}

// Value of one logic term. opp term: (abs|signed of Σ field over the opp's rows)
// combined with the term's scalar via factorOp. custom term: the literal.
function evalLogicTerm(
  rows: CompRowInput[],
  roleRows: Map<string, number[]>,
  t: CompLogicTerm,
): number {
  if (t.source === "custom") {
    return typeof t.value === "number" && Number.isFinite(t.value) ? t.value : 0;
  }
  const idx = (t.opp && roleRows.get(t.opp)) || [];
  const sum = sumComparable(
    rows,
    idx,
    (t.field ?? "changeInMrr") as CompComparableField,
  );
  const base = t.signed ? sum : Math.abs(sum);
  const factor =
    typeof t.factor === "number" && Number.isFinite(t.factor) ? t.factor : 1;
  return applyFactorOp(base, t.factorOp ?? "multiply", factor);
}

// Collapse a side's terms with standard precedence (× / ÷ before + / −).
function evalFormulaSide(
  rows: CompRowInput[],
  roleRows: Map<string, number[]>,
  terms: CompLogicTerm[] | undefined,
): number {
  if (!terms || terms.length === 0) return 0;
  const vals = terms.map((t) => evalLogicTerm(rows, roleRows, t));
  // ops[k] joins vals[k] and vals[k+1] (joinOp lives on the SECOND term).
  const ops = terms.slice(1).map((t) => t.joinOp ?? "add");
  // Pass 1: fold multiply/divide left-to-right.
  const v: number[] = [vals[0]];
  const o: CompFactorOp[] = [];
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op === "multiply") v[v.length - 1] = v[v.length - 1] * vals[k + 1];
    else if (op === "divide")
      v[v.length - 1] = vals[k + 1] === 0 ? 0 : v[v.length - 1] / vals[k + 1];
    else {
      o.push(op);
      v.push(vals[k + 1]);
    }
  }
  // Pass 2: add/subtract left-to-right.
  let acc = v[0];
  for (let k = 0; k < o.length; k++)
    acc = o[k] === "subtract" ? acc - v[k + 1] : acc + v[k + 1];
  return acc;
}

// {left,right} for a formula-based numeric comparative. roleRows maps each opp
// name to its matched row indices (the engine's matchedByName).
function formulaOperands(
  rows: CompRowInput[],
  roleRows: Map<string, number[]>,
  c: CompComparativeCondition,
): { left: number; right: number } {
  return {
    left: evalFormulaSide(rows, roleRows, c.leftTerms),
    right: evalFormulaSide(rows, roleRows, c.rightTerms),
  };
}

// Opp names referenced by a formula's opp terms (for diagnostics resolvability).
function formulaReferencedOpps(c: CompComparativeCondition): string[] {
  const out: string[] = [];
  for (const t of [...(c.leftTerms ?? []), ...(c.rightTerms ?? [])]) {
    if (t.source === "opp" && t.opp) out.push(t.opp);
  }
  return out;
}

// Applies a numeric comparison operator (comparative conditions only).
function numericOp(a: number, op: CompOp, b: number): boolean {
  switch (op) {
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    default:
      return false;
  }
}

// Comparable ordinal for a date identity field: YYYYMM for month granularity,
// YYYYMMDD for exact. Returns null when the field is not a supported date field
// or the value is unparseable. closeDate and fub_first_purchase_date are the
// supported date identity fields.
function dateOrdinal(
  row: CompRowInput,
  field: CompIdentityField,
  gran?: CompDateGranularity,
): number | null {
  let raw: string;
  if (field === "closeDate") raw = (row.closeDate || "").trim();
  else if (field === "fub_first_purchase_date") raw = (row.fubFirstPurchaseDate || "").trim();
  else return null;
  if (!raw) return null;
  const dt = parseRawDate(raw);
  if (dt === null) return null;
  const y = dt.getFullYear();
  const m = dt.getMonth() + 1;
  const d = dt.getDate();
  return gran === "exact" ? y * 10000 + m * 100 + d : y * 100 + m;
}

// Task #376: canonical exact-day identity key for a date field. Reuses the
// dateOrdinal parser (which handles both M/D/YYYY and ISO YYYY-MM-DD) so two
// dates representing the same calendar day compare equal regardless of input
// string format. Returns "" for empty/unparseable values, preserving the
// "blanks never match" behavior of identity eq/ne comparisons.
function exactDateKey(row: CompRowInput, field: CompIdentityField): string {
  const o = dateOrdinal(row, field, "exact");
  return o === null ? "" : String(o);
}

// Representative (latest) date ordinal across a set of rows, for a cross-opp
// closeDate ordering gate. Null when no row carries a parseable date.
function repDateOrdinal(
  rows: CompRowInput[],
  idxs: number[],
  field: CompIdentityField,
  gran?: CompDateGranularity,
): number | null {
  let best: number | null = null;
  for (const i of idxs) {
    const o = dateOrdinal(rows[i], field, gran);
    if (o === null) continue;
    if (best === null || o > best) best = o;
  }
  return best;
}

// True when a row satisfies all of an opp's SAME-OPP (internal) comparatives —
// comparatives whose compareToOpp is the opp's own name. These are per-row
// field-vs-field comparisons (no cross-opp aggregation):
//  - numeric field: row's |field| vs row's |compareToField| (signed values)
//  - closeDate ordering: row's date vs row's compareToField date
//  - identity eq/ne: row's field value vs row's compareToField value
function rowPassesSelfComparatives(row: CompRowInput, opp: CompNamedOpp): boolean {
  for (const c of oppConditions(opp)) {
    if (c.kind !== "comparative") continue;
    // Task #420 — formula-term numeric comparatives are RULE-LEVEL aggregate
    // gates, never per-row filters; they are evaluated in the gate loop below.
    if (!isIdentityField(c.field) && hasFormulaTerms(c)) continue;
    if (c.compareToOpp !== opp.name) continue;
    if (isIdentityField(c.field)) {
      const gran = c.dateGranularity;
      if (c.op === "eq" || c.op === "ne") {
        const a = identityValue(row, c.field as CompIdentityField, gran);
        const b = identityValue(row, c.compareToField as CompIdentityField, gran);
        if (c.op === "eq") {
          if (a === "" || a !== b) return false;
        } else if (a === b) {
          return false;
        }
      } else {
        // ordering between date fields (validated: both sides are date fields,
        // possibly different ones e.g. closeDate vs fub_first_purchase_date)
        const a = dateOrdinal(row, c.field as CompIdentityField, gran);
        const b = dateOrdinal(row, c.compareToField as CompIdentityField, gran);
        if (a === null || b === null) return false;
        if (!numericOp(a, c.op, b)) return false;
      }
    } else {
      const a = pairedSideMrrValue(row, c.field as CompComparableField);
      const b = pairedSideMrrValue(row, c.compareToField as CompComparableField);
      if (!numericOp(a, c.op, b)) return false;
    }
  }
  return true;
}

// New total compensable for the target opp, given the adjustment op. `targetSum`
// is the signed standardized-MRR sum of the target opp's rows; absTarget /
// absComparison the magnitudes for incremental ops.
function adjustedOppTotal(
  op: CompAdjustmentOp,
  targetSum: number,
  amount: number | undefined,
  absTarget: number,
  absComparison: number,
): number {
  const amt = amount ?? 0;
  switch (op) {
    case "waive":
      return 0;
    case "keep":
      return targetSum;
    case "fixedCredit":
      return sign(targetSum) * amt;
    case "capAt":
      return sign(targetSum) * Math.min(Math.abs(targetSum), amt);
    case "incremental":
      return absTarget - absComparison;
    case "greaterOfFloorOrIncremental":
      return Math.max(amt, absTarget - absComparison);
    case "multiplyByFactor":
      return targetSum * amt;
    default:
      return targetSum;
  }
}

// Human-readable description of an adjustment, for drilldown/export display.
function adjustmentLabel(adj: CompAdjustment): string {
  const t = adj.targetOpp;
  switch (adj.op) {
    case "waive":
      return `${t}: waived`;
    case "keep":
      return `${t}: unchanged`;
    case "fixedCredit":
      return `${t}: fixed credit ${adj.amount}`;
    case "capAt":
      return `${t}: capped at ${adj.amount}`;
    case "incremental":
      return `${t}: |${t}| − |${adj.comparisonOpp}${adj.comparisonField ? `.${adj.comparisonField}` : ""}|`;
    case "greaterOfFloorOrIncremental":
      return `${t}: max(${adj.amount}, |${t}| − |${adj.comparisonOpp}${adj.comparisonField ? `.${adj.comparisonField}` : ""}|)`;
    case "multiplyByFactor":
      return `${t}: × ${adj.amount}`;
    case "reassignMrrField":
      return `${t}: MRR = ${adj.mrrField}`;
    case "ignoreAcqChurn":
      return `${t}: ignore ACQ churn logic`;
    default:
      return t;
  }
}

// Per-row pairing metadata produced by the matcher.
export interface PairRowMeta {
  pairKey: string;
  pairRuleId: string;
  pairRuleLabel: string;
  // Name of the matched rule's named opp this row belongs to.
  pairOppName: string;
  // Description of the adjustment applied to this row (null if the row is a
  // group member but no adjustment targeted its opp).
  adjustmentLabel: string | null;
  // New compensable MRR for this row (null = unchanged → multiplier engine).
  override: number | null;
  // True when a `waive` was applied to a negative-actual (churn) row — the
  // generic replacement for the old cancel/rebook + FUB-cancel suppression.
  churnSuppressed: boolean;
  // Owner this row's credit was reassigned to, when a gated reassignOwnerToOpp
  // fired. Null otherwise.
  ownerReassignedTo: string | null;
  // True when an `ignoreAcqChurn` adjustment targeted this row's opp: the row's
  // MRR is unchanged, but the global ACQ same-month churn gate must be bypassed
  // for it (its churn counts even without a paired positive Closed Won).
  ignoreAcqChurn: boolean;
}

// One member opp of a matched group, for inspection / export.
export interface PairedOppMemberSummary {
  name: string;
  mode: CompOppMode;
  absMrr: number;
  oppIds: string[];
}

// One matched group, for inspection / export.
export interface PairedOppPairSummary {
  ruleId: string;
  ruleLabel: string;
  pairKey: string;
  linkValues: string[];
  monthYyyymm: string;
  opps: PairedOppMemberSummary[];
}

// Evaluates all enabled paired-opp rules over the row set. Pure: returns the
// per-row override metadata and the matched-group summaries; the caller folds
// the overrides into the compensable totals.
export function evaluatePairedOppRules(
  rows: CompRowInput[],
  rules: PairedOppRule[],
): { rowMeta: Map<number, PairRowMeta>; summaries: PairedOppPairSummary[] } {
  const rowMeta = new Map<number, PairRowMeta>();
  const summaries: PairedOppPairSummary[] = [];
  if (!rules || rules.length === 0) return { rowMeta, summaries };

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!rule.opps?.length || !rule.adjustments?.length) continue;
    const opps = rule.opps;
    const anchor = opps[0];
    // The first opp is the anchor and must be a Match opp. Malformed legacy rows
    // (no anchor / anchor not Match) are skipped rather than crashing.
    if (anchor.mode !== "match") continue;
    const reassignRoles = new Set(
      (rule.reassignableOwnerRoles ?? defaultReassignableOwnerRoles()).map((s) =>
        s.trim().toLowerCase(),
      ),
    );

    // FIELD-matched candidate rows per opp (comparative conditions are applied
    // separately: identity ones during the join, numeric ones as post gates).
    const fieldMatched = new Map<string, number[]>();
    for (const opp of opps) fieldMatched.set(opp.name, []);
    for (let i = 0; i < rows.length; i++) {
      for (const opp of opps) {
        if (
          rowMatchesOppFields(rows[i], opp) &&
          rowPassesSelfComparatives(rows[i], opp)
        )
          fieldMatched.get(opp.name)!.push(i);
      }
    }

    // A "deal" is defined by the anchor's identity values referenced by the eq
    // identity links that point at the anchor. (Every non-anchor opp carries ≥1
    // such link, transitively, by validation.)
    const anchorKeyFields: { field: CompIdentityField; gran?: CompDateGranularity }[] = [];
    const seenKey = new Set<string>();
    for (const opp of opps) {
      for (const c of oppConditions(opp)) {
        if (c.kind !== "comparative" || c.op !== "eq") continue;
        if (!isIdentityField(c.field)) continue;
        if (c.compareToOpp === opp.name) continue; // self-eq is a per-row filter, not a deal key
        if (c.compareToOpp !== anchor.name) continue;
        const f = c.compareToField as CompIdentityField;
        const k = `${f}|${c.dateGranularity ?? ""}`;
        if (seenKey.has(k)) continue;
        seenKey.add(k);
        anchorKeyFields.push({ field: f, gran: c.dateGranularity });
      }
    }
    // No opp ties itself to the anchor → nothing to group on (malformed legacy).
    if (anchorKeyFields.length === 0) continue;

    // Group anchor rows into deals by the anchor-key tuple.
    const deals = new Map<string, number[]>();
    for (const i of fieldMatched.get(anchor.name)!) {
      const vals = anchorKeyFields.map((k) => identityValue(rows[i], k.field, k.gran));
      if (vals.some((v) => !v)) continue; // missing key value → cannot group
      const dealKey = vals.join("||");
      const list = deals.get(dealKey);
      if (list) list.push(i);
      else deals.set(dealKey, [i]);
    }

    for (const [dealKey, anchorIdxs] of deals) {
      // Resolve each opp's member rows in list order. The anchor is fixed; every
      // later opp filters its field-matched candidates by its identity links
      // against already-resolved opps (eq: value ∈ counterpart; ne: value ∉).
      const matchedByName = new Map<string, number[]>();
      matchedByName.set(anchor.name, anchorIdxs);
      for (let oi = 1; oi < opps.length; oi++) {
        const opp = opps[oi];
        const identityLinks = oppConditions(opp).filter(
          (c): c is CompComparativeCondition =>
            c.kind === "comparative" &&
            isIdentityField(c.field) &&
            c.compareToOpp !== opp.name &&
            (c.op === "eq" || c.op === "ne"),
        );
        const cand = fieldMatched.get(opp.name)!.filter((i) => {
          for (const link of identityLinks) {
            const ref = matchedByName.get(link.compareToOpp);
            if (!ref) return false; // earlier-opp guarantee; defensive
            const gran = link.dateGranularity;
            const rv = identityValue(rows[i], link.field as CompIdentityField, gran);
            if (!rv) return false;
            const refVals = new Set(
              ref.map((z) =>
                identityValue(rows[z], link.compareToField as CompIdentityField, gran),
              ),
            );
            if (link.op === "eq") {
              if (!refVals.has(rv)) return false;
            } else if (refVals.has(rv)) {
              return false; // ne
            }
          }
          return true;
        });
        matchedByName.set(opp.name, cand);
      }

      // Rule fires when every Match opp has ≥1 row and every Exclude opp none.
      let fires = true;
      for (const opp of opps) {
        const count = matchedByName.get(opp.name)!.length;
        if (opp.mode === "match" && count === 0) {
          fires = false;
          break;
        }
        if (opp.mode === "exclude" && count > 0) {
          fires = false;
          break;
        }
      }
      if (!fires) continue;

      // Numeric comparative gates: this opp's |Σ field| vs the referenced opp's
      // |Σ compareToField|. (Identity comparatives are handled by the join.)
      for (const opp of opps) {
        if (opp.mode !== "match") continue;
        const myIdx = matchedByName.get(opp.name)!;
        for (const c of oppConditions(opp)) {
          if (c.kind !== "comparative" || isIdentityField(c.field)) continue;
          // Task #420 — formula-term comparatives are rule-level aggregate gates
          // evaluated over matchedByName (abs-inside per-term, precedence). They
          // ignore myIdx/compareToOpp; legacy single-operand conditions use the
          // unchanged comparativeOperands path below.
          if (hasFormulaTerms(c)) {
            const { left, right } = formulaOperands(rows, matchedByName, c);
            if (!numericOp(left, c.op, right)) {
              fires = false;
              break;
            }
            continue;
          }
          if (c.compareToOpp === opp.name) continue; // self handled per-row
          const otherIdx = matchedByName.get(c.compareToOpp) ?? [];
          const { left, right } = comparativeOperands(rows, myIdx, otherIdx, c);
          if (!numericOp(left, c.op, right)) {
            fires = false;
            break;
          }
        }
        if (!fires) break;
      }
      if (!fires) continue;

      // Cross-opp closeDate ordering gates: this opp's representative (latest)
      // close date vs the referenced opp's, applied after the join resolves.
      // (Same-opp date ordering is handled per-row above.)
      for (const opp of opps) {
        if (opp.mode !== "match") continue;
        const myIdx = matchedByName.get(opp.name)!;
        for (const c of oppConditions(opp)) {
          if (c.kind !== "comparative" || !isIdentityField(c.field)) continue;
          if (c.compareToOpp === opp.name) continue; // self handled per-row
          if (c.op === "eq" || c.op === "ne") continue; // joins handled above
          const otherIdx = matchedByName.get(c.compareToOpp) ?? [];
          const gran = c.dateGranularity;
          const left = repDateOrdinal(rows, myIdx, c.field as CompIdentityField, gran);
          const right = repDateOrdinal(
            rows,
            otherIdx,
            c.compareToField as CompIdentityField,
            gran,
          );
          if (left === null || right === null) {
            fires = false;
            break;
          }
          if (!numericOp(left, c.op, right)) {
            fires = false;
            break;
          }
        }
        if (!fires) break;
      }
      if (!fires) continue;

      const linkValues = dealKey.split("||");
      const monthYyyymm = compMonthKey(rows[anchorIdxs[0]].closeDate);
      const pairKey = `${rule.id}::${dealKey}`;

      summaries.push({
        ruleId: rule.id,
        ruleLabel: rule.label,
        pairKey,
        linkValues,
        monthYyyymm,
        opps: rule.opps.map((opp) => {
          const oi = matchedByName.get(opp.name)!;
          return {
            name: opp.name,
            mode: opp.mode,
            absMrr: Math.abs(oi.reduce((s, i) => s + rows[i].standardizedMrr, 0)),
            oppIds: uniq(oi.map((i) => rows[i].oppId)),
          };
        }),
      });

      const ensureMeta = (i: number, oppName: string): PairRowMeta => {
        let m = rowMeta.get(i);
        if (!m) {
          m = {
            pairKey,
            pairRuleId: rule.id,
            pairRuleLabel: rule.label,
            pairOppName: oppName,
            adjustmentLabel: null,
            override: null,
            churnSuppressed: false,
            ownerReassignedTo: null,
            ignoreAcqChurn: false,
          };
          rowMeta.set(i, m);
        }
        return m;
      };
      // Record membership for every Match opp's rows (Exclude opps have none).
      for (const opp of rule.opps) {
        if (opp.mode !== "match") continue;
        for (const i of matchedByName.get(opp.name)!) ensureMeta(i, opp.name);
      }

      // Apply adjustments in order. Each distributes its target opp's new
      // compensable total across that opp's rows proportional to |actual|.
      for (const adj of rule.adjustments) {
        const targetIdx = matchedByName.get(adj.targetOpp) ?? [];
        if (targetIdx.length === 0) continue;
        const label = adjustmentLabel(adj);
        // Owner of the named opp this adjustment reassigns credit to.
        const reassignToIdx = adj.reassignOwnerToOpp
          ? (matchedByName.get(adj.reassignOwnerToOpp) ?? [])
          : [];
        const reassignOwner =
          reassignToIdx.map((i) => rows[i].rep).find((x) => x && x.trim()) || "";

        if (adj.op === "ignoreAcqChurn") {
          // No-op on MRR: flag every target row to bypass the global ACQ
          // same-month churn gate. Composes with other adjustments targeting
          // the same opp (this one never touches `override`).
          for (const i of targetIdx) {
            const m = ensureMeta(i, adj.targetOpp);
            m.ignoreAcqChurn = true;
            if (!m.adjustmentLabel) m.adjustmentLabel = label;
            if (reassignOwner) {
              const role = (rows[i].salesRole || "").trim().toLowerCase();
              if (reassignRoles.has(role)) m.ownerReassignedTo = reassignOwner;
            }
          }
          continue;
        }

        if (adj.op === "reassignMrrField") {
          // Per-row: set comp to the row's own feeder MRR column (no distribution).
          for (const i of targetIdx) {
            const m = ensureMeta(i, adj.targetOpp);
            m.override = pairedSideMrrValue(rows[i], adj.mrrField);
            m.adjustmentLabel = label;
            if (reassignOwner) {
              const role = (rows[i].salesRole || "").trim().toLowerCase();
              if (reassignRoles.has(role)) m.ownerReassignedTo = reassignOwner;
            }
          }
          continue;
        }

        const targetSum = targetIdx.reduce((s, i) => s + rows[i].standardizedMrr, 0);
        // The comparison side may be measured by an optional feeder MRR column
        // (adj.comparisonField); when omitted it uses standardized MRR. The
        // target side always uses standardized MRR.
        const absTarget = Math.abs(targetSum);
        const compIdx = adj.comparisonOpp ? (matchedByName.get(adj.comparisonOpp) ?? []) : [];
        const absComparison = Math.abs(
          compIdx.reduce((s, i) => s + pairedSideMrrValue(rows[i], adj.comparisonField), 0),
        );
        const newTotal = adjustedOppTotal(adj.op, targetSum, adj.amount, absTarget, absComparison);
        const denom = targetIdx.reduce((s, i) => s + Math.abs(rows[i].standardizedMrr), 0) || 1;
        for (const i of targetIdx) {
          const m = ensureMeta(i, adj.targetOpp);
          m.override = newTotal * (Math.abs(rows[i].standardizedMrr) / denom);
          m.adjustmentLabel = label;
          if (adj.op === "waive" && rows[i].standardizedMrr < 0) m.churnSuppressed = true;
          if (reassignOwner) {
            const role = (rows[i].salesRole || "").trim().toLowerCase();
            if (reassignRoles.has(role)) m.ownerReassignedTo = reassignOwner;
          }
        }
      }
    }
  }

  return { rowMeta, summaries };
}

// ===========================================================================
// Task #375: read-only per-condition diagnostic overlay. Given a single pasted
// opp id, report each condition of a rule as matched / not-matched / not
// testable, WITHOUT changing real evaluation behavior. These functions only
// READ via the same primitives the engine uses; they never write rowMeta or
// mutate compensation output.
// ===========================================================================

export type CompConditionTestStatus = "match" | "noMatch" | "notTestable";

export interface MultiplierRuleDiagnosis {
  // Aligned index-for-index to rule.conditions.
  conditions: CompConditionTestStatus[];
}

// Task #394: overall verdict of pinning the filled-in opps to their roles and
// running the pairing. `incomplete` when no opp ids were entered at all.
export type CompPairedFiresVerdict = "fires" | "doesNotFire" | "incomplete";

export interface PairedOppDiagnosis {
  name: string;
  // True for the named-opp role the pasted opp was mapped to.
  isSelf: boolean;
  // Whether some row filled this role for the pasted opp's deal.
  resolved: boolean;
  // Aligned index-for-index to opp.conditions.
  conditions: CompConditionTestStatus[];
  // Task #394: per-role pinning state (populated by diagnosePairedRuleForOpps).
  // True when an opp id was pasted into this role's card.
  pinned?: boolean;
  // Whether the pasted opp id resolved to a row (false → "Opp not found"). True
  // for blank roles (nothing to look up).
  found?: boolean;
}

export interface PairedRuleDiagnosis {
  // The named opp the pasted opp mapped to (null if the rule has no opps).
  selfOppName: string | null;
  // Aligned index-for-index to rule.opps.
  opps: PairedOppDiagnosis[];
  // Task #394: overall rule-fires verdict (only set by the per-role pinning
  // path; undefined for the legacy single-id diagnosis).
  fires?: CompPairedFiresVerdict;
}

// Pick the row (by index) that satisfies the most of a flat condition set, so a
// multi-line-item opp is diagnosed against its best-fitting line item. First on
// a tie (deterministic). Returns null when there are no rows.
function bestRowIndexForConditions(
  rows: CompRowInput[],
  idxs: number[],
  conditions: CompCondition[],
): number | null {
  let best: number | null = null;
  let bestScore = -1;
  for (const i of idxs) {
    let score = 0;
    for (const c of conditions) if (matchCondition(rows[i], c)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

// Diagnose a multiplier rule against a pasted opp's row(s).
export function diagnoseMultiplierRule(
  testRows: CompRowInput[],
  rule: CompMultiplierRule,
): MultiplierRuleDiagnosis {
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  const repIdx = bestRowIndexForConditions(
    testRows,
    testRows.map((_, i) => i),
    conditions,
  );
  if (repIdx === null) {
    return { conditions: conditions.map(() => "notTestable") };
  }
  const row = testRows[repIdx];
  return {
    conditions: conditions.map((c) =>
      matchCondition(row, c) ? "match" : "noMatch",
    ),
  };
}

// Evaluate a single SAME-OPP (internal) comparative against one row. Mirrors the
// per-row branch of rowPassesSelfComparatives for one condition.
function evalSelfComparative(
  row: CompRowInput,
  c: CompComparativeCondition,
): boolean {
  if (isIdentityField(c.field)) {
    const gran = c.dateGranularity;
    if (c.op === "eq" || c.op === "ne") {
      const a = identityValue(row, c.field as CompIdentityField, gran);
      const b = identityValue(row, c.compareToField as CompIdentityField, gran);
      if (c.op === "eq") return a !== "" && a === b;
      return a !== b;
    }
    const a = dateOrdinal(row, c.field as CompIdentityField, gran);
    const b = dateOrdinal(row, c.compareToField as CompIdentityField, gran);
    if (a === null || b === null) return false;
    return numericOp(a, c.op, b);
  }
  const a = pairedSideMrrValue(row, c.field as CompComparableField);
  const b = pairedSideMrrValue(row, c.compareToField as CompComparableField);
  return numericOp(a, c.op, b);
}

// Evaluate a single CROSS-OPP comparative between two resolved role row sets.
// Mirrors the numeric / date-ordering / identity-join branches of the engine.
function evalCrossComparative(
  rows: CompRowInput[],
  myIdx: number[],
  otherIdx: number[],
  c: CompComparativeCondition,
): boolean {
  if (isIdentityField(c.field)) {
    const gran = c.dateGranularity;
    if (c.op === "eq" || c.op === "ne") {
      const refVals = new Set(
        otherIdx.map((z) =>
          identityValue(rows[z], c.compareToField as CompIdentityField, gran),
        ),
      );
      const rv = myIdx.length
        ? identityValue(rows[myIdx[0]], c.field as CompIdentityField, gran)
        : "";
      if (c.op === "eq") return rv !== "" && refVals.has(rv);
      return !refVals.has(rv);
    }
    const left = repDateOrdinal(rows, myIdx, c.field as CompIdentityField, gran);
    const right = repDateOrdinal(
      rows,
      otherIdx,
      c.compareToField as CompIdentityField,
      gran,
    );
    if (left === null || right === null) return false;
    return numericOp(left, c.op, right);
  }
  const { left, right } = comparativeOperands(rows, myIdx, otherIdx, c);
  return numericOp(left, c.op, right);
}

// Task #436 — restrict a force-included role row set to the rows that actually
// satisfy the opp's OWN field conditions (mirroring the engine's `fieldMatched`
// set). The diagnostics deliberately force-include every sheet row carrying a
// pinned opp id into its role so a failing field condition still highlights red
// instead of the opp silently disappearing. That force-include is correct for
// per-field highlighting / presence / identity-join resolution, but it must NOT
// leak into the numeric "magnitude" gates: the real engine only ever sums rows
// that pass `rowMatchesOppFields` + self comparatives. When a role has duplicate
// rows for one opp id where some fail a field condition, summing all of them
// diverges from the engine (e.g. a −450 anchor listed twice sums to −900 and an
// equality gate against +450 falsely fails). These helpers re-apply the field
// filter to the summed row sets only.
function fieldMatchedSubset(
  rows: CompRowInput[],
  idxs: number[],
  opp: CompNamedOpp,
): number[] {
  return idxs.filter(
    (i) =>
      rowMatchesOppFields(rows[i], opp) && rowPassesSelfComparatives(rows[i], opp),
  );
}

// Field-matched-only view of an entire role→rows map (for formula-term gates,
// which sum every referenced opp's rows). Roles whose opp can't be found are
// passed through unchanged (defensive).
function fieldMatchedRoleRows(
  rows: CompRowInput[],
  roleRows: Map<string, number[]>,
  opps: CompNamedOpp[],
): Map<string, number[]> {
  const byName = new Map(opps.map((o) => [o.name, o]));
  const out = new Map<string, number[]>();
  for (const [name, idxs] of roleRows) {
    const opp = byName.get(name);
    out.set(name, opp ? fieldMatchedSubset(rows, idxs, opp) : idxs.slice());
  }
  return out;
}

// Shared deal resolver for the diagnostics. Given each opp's FIELD-matched
// candidate rows and a `self` role known to contain `selfIdx` rows, group anchor
// rows into deals, resolve each deal's roles via the engine's identity-link
// logic, and return the role→rows map for the deal that contains the self rows.
// Returns null when no opp ties to the anchor or no deal contains the self rows.
// Mirrors evaluatePairedOppRules' join so the tester tracks engine grouping.
function resolveDealRoleRows(
  monthRows: CompRowInput[],
  opps: CompNamedOpp[],
  fieldMatched: Map<string, number[]>,
  selfOppName: string,
  selfIdx: number[],
): Map<string, number[]> | null {
  const anchor = opps[0];
  // Anchor key fields (eq identity links pointing at the anchor).
  const anchorKeyFields: { field: CompIdentityField; gran?: CompDateGranularity }[] = [];
  const seenKey = new Set<string>();
  for (const opp of opps) {
    for (const c of oppConditions(opp)) {
      if (c.kind !== "comparative" || c.op !== "eq") continue;
      if (!isIdentityField(c.field)) continue;
      if (c.compareToOpp === opp.name) continue;
      if (c.compareToOpp !== anchor.name) continue;
      const f = c.compareToField as CompIdentityField;
      const k = `${f}|${c.dateGranularity ?? ""}`;
      if (seenKey.has(k)) continue;
      seenKey.add(k);
      anchorKeyFields.push({ field: f, gran: c.dateGranularity });
    }
  }
  if (anchorKeyFields.length === 0) return null;

  // Group anchor rows into deals, resolve each deal's roles, and find the deal
  // that contains the self rows.
  const deals = new Map<string, number[]>();
  for (const i of fieldMatched.get(anchor.name)!) {
    const vals = anchorKeyFields.map((k) => identityValue(monthRows[i], k.field, k.gran));
    if (vals.some((v) => !v)) continue;
    const dealKey = vals.join("||");
    const list = deals.get(dealKey);
    if (list) list.push(i);
    else deals.set(dealKey, [i]);
  }
  for (const [, anchorIdxs] of deals) {
    const matchedByName = new Map<string, number[]>();
    matchedByName.set(anchor.name, anchorIdxs);
    for (let oi = 1; oi < opps.length; oi++) {
      const opp = opps[oi];
      const identityLinks = oppConditions(opp).filter(
        (c): c is CompComparativeCondition =>
          c.kind === "comparative" &&
          isIdentityField(c.field) &&
          c.compareToOpp !== opp.name &&
          (c.op === "eq" || c.op === "ne"),
      );
      const cand = fieldMatched.get(opp.name)!.filter((i) => {
        for (const link of identityLinks) {
          const ref = matchedByName.get(link.compareToOpp);
          if (!ref) return false;
          const gran = link.dateGranularity;
          const rv = identityValue(monthRows[i], link.field as CompIdentityField, gran);
          if (!rv) return false;
          const refVals = new Set(
            ref.map((z) =>
              identityValue(monthRows[z], link.compareToField as CompIdentityField, gran),
            ),
          );
          if (link.op === "eq") {
            if (!refVals.has(rv)) return false;
          } else if (refVals.has(rv)) {
            return false;
          }
        }
        return true;
      });
      matchedByName.set(opp.name, cand);
    }
    const selfList = matchedByName.get(selfOppName) ?? [];
    if (selfList.some((i) => selfIdx.includes(i))) {
      return matchedByName;
    }
  }
  return null;
}

// Diagnose a paired-opp rule against a pasted opp. `monthRows` are all comp rows
// for the pasted opp's close month (used to resolve partner opps); `oppId` is
// the pasted opp id. The pasted opp is mapped to the named-opp role whose field
// conditions it best satisfies, partners are resolved via the same link logic
// the engine uses, and each condition is classified match/noMatch/notTestable.
export function diagnosePairedRuleForOpp(
  monthRows: CompRowInput[],
  oppId: string,
  rule: PairedOppRule,
): PairedRuleDiagnosis {
  const opps = Array.isArray(rule.opps) ? rule.opps : [];
  if (opps.length === 0) return { selfOppName: null, opps: [] };

  const id = (oppId || "").trim();
  const testIdx = monthRows
    .map((r, i) => (r.oppId && r.oppId === id ? i : -1))
    .filter((i) => i >= 0);

  // No row for the pasted opp in this month → nothing testable.
  if (testIdx.length === 0) {
    return {
      selfOppName: null,
      opps: opps.map((opp) => ({
        name: opp.name,
        isSelf: false,
        resolved: false,
        conditions: oppConditions(opp).map(() => "notTestable" as const),
      })),
    };
  }

  // 1) Map the pasted opp to the named-opp role whose FIELD conditions it best
  //    satisfies (declaration order breaks ties), and pick its representative row.
  let selfOppName: string | null = null;
  let selfRowIdx: number | null = null;
  let bestScore = -1;
  for (const opp of opps) {
    const fieldConds = oppConditions(opp).filter(
      (c): c is Extract<CompPairedCondition, { kind: "field" }> => c.kind === "field",
    );
    for (const i of testIdx) {
      let score = 0;
      for (const c of fieldConds) {
        if (matchCondition(monthRows[i], { field: c.field, op: c.op, value: c.value }))
          score++;
      }
      if (score > bestScore) {
        bestScore = score;
        selfOppName = opp.name;
        selfRowIdx = i;
      }
    }
  }

  // 2) Field-matched candidates per opp (engine semantics), then FORCE-include
  //    the pasted opp into its mapped role so partner joins still resolve even
  //    when the pasted opp fails a field condition (the point of the diagnostic).
  const fieldMatched = new Map<string, number[]>();
  for (const opp of opps) {
    const idxs: number[] = [];
    for (let i = 0; i < monthRows.length; i++) {
      if (
        rowMatchesOppFields(monthRows[i], opp) &&
        rowPassesSelfComparatives(monthRows[i], opp)
      )
        idxs.push(i);
    }
    fieldMatched.set(opp.name, idxs);
  }
  if (selfOppName !== null) {
    const list = fieldMatched.get(selfOppName)!;
    for (const i of testIdx) if (!list.includes(i)) list.push(i);
  }

  // 3-4) Resolve the deal containing the pasted opp via the engine's link logic.
  let roleRows: Map<string, number[]> | null =
    selfOppName !== null
      ? resolveDealRoleRows(monthRows, opps, fieldMatched, selfOppName, testIdx)
      : null;

  // Fallback: the pasted opp fits no resolved deal (e.g. no partner present).
  // Only its own role is resolved; everything else is not testable.
  if (!roleRows) {
    roleRows = new Map<string, number[]>();
    for (const opp of opps) roleRows.set(opp.name, []);
    if (selfOppName !== null) roleRows.set(selfOppName, testIdx.slice());
  }

  // 5) Classify each opp's conditions.
  const result: PairedOppDiagnosis[] = opps.map((opp) => {
    const isSelf = opp.name === selfOppName;
    const myIdx = roleRows!.get(opp.name) ?? [];
    const resolved = isSelf ? true : myIdx.length > 0;
    // For the pasted opp's role, evaluate field conditions against the pasted
    // row itself (so failing conditions show red); otherwise the partner's row.
    const repIdx = isSelf ? selfRowIdx : myIdx.length ? myIdx[0] : null;
    // The row set used for this role on the cross-opp (aggregate) side.
    const myAggIdx =
      isSelf && myIdx.length === 0 && selfRowIdx !== null ? [selfRowIdx] : myIdx;

    const conditions = oppConditions(opp).map((c): CompConditionTestStatus => {
      if (c.kind === "field") {
        if (repIdx === null) return "notTestable";
        return matchCondition(monthRows[repIdx], {
          field: c.field,
          op: c.op,
          value: c.value,
        })
          ? "match"
          : "noMatch";
      }
      // comparative
      // Task #420 — formula-term numeric comparatives are rule-level aggregate
      // gates over roleRows; testable only when every referenced opp resolved.
      if (!isIdentityField(c.field) && hasFormulaTerms(c)) {
        const refs = formulaReferencedOpps(c);
        if (refs.some((n) => (roleRows!.get(n) ?? []).length === 0))
          return "notTestable";
        // Task #436 — sum only field-matching rows per referenced role (engine
        // semantics), not the force-included set.
        const fmRoles = fieldMatchedRoleRows(monthRows, roleRows!, opps);
        const { left, right } = formulaOperands(monthRows, fmRoles, c);
        return numericOp(left, c.op, right) ? "match" : "noMatch";
      }
      if (c.compareToOpp === opp.name) {
        if (repIdx === null) return "notTestable";
        return evalSelfComparative(monthRows[repIdx], c) ? "match" : "noMatch";
      }
      const otherIdx = roleRows!.get(c.compareToOpp) ?? [];
      if (myAggIdx.length === 0 || otherIdx.length === 0) return "notTestable";
      // Task #436 — for NUMERIC (magnitude) cross gates the engine sums only
      // field-matching rows; restrict both sides to their field-matched subset
      // so force-included duplicates that fail a field condition don't leak in.
      // Identity cross comparatives keep the force-included rows (the join uses
      // presence, not magnitude).
      if (!isIdentityField(c.field)) {
        const otherOpp = opps.find((o) => o.name === c.compareToOpp);
        const myField = fieldMatchedSubset(monthRows, myAggIdx, opp);
        const otherField = otherOpp
          ? fieldMatchedSubset(monthRows, otherIdx, otherOpp)
          : otherIdx;
        if (myField.length === 0 || otherField.length === 0) return "notTestable";
        return evalCrossComparative(monthRows, myField, otherField, c)
          ? "match"
          : "noMatch";
      }
      return evalCrossComparative(monthRows, myAggIdx, otherIdx, c)
        ? "match"
        : "noMatch";
    });

    return { name: opp.name, isSelf, resolved, conditions };
  });

  return { selfOppName, opps: result };
}

// Task #394: diagnose a paired-opp rule with a pasted opp id PINNED to each
// named role (rather than a single id auto-mapped to a best-fit role). Each
// filled-in card's conditions are evaluated against its own pinned opp's
// representative row; blank roles fall back to auto-resolution seeded by the
// pinned opps. Returns the per-opp per-condition statuses AND an overall
// "fires" verdict computed by pinning the filled-in opps to their roles and
// running the pairing logic. Read-only: never mutates compensation output.
// `oppTestIds` is aligned index-for-index to rule.opps ("" = blank role).
export function diagnosePairedRuleForOpps(
  monthRows: CompRowInput[],
  oppTestIds: string[],
  rule: PairedOppRule,
): PairedRuleDiagnosis {
  const opps = Array.isArray(rule.opps) ? rule.opps : [];
  if (opps.length === 0)
    return { selfOppName: null, opps: [], fires: "incomplete" };

  // Pasted id pinned to each role (aligned to opps; "" = blank → auto-resolve).
  const pinnedIds = opps.map((_, i) => ((oppTestIds[i] ?? "") || "").trim());
  const anyPinned = pinnedIds.some((id) => id !== "");

  // Rows carrying each role's pasted id (null = blank role; [] = not found).
  const pinnedIdx: (number[] | null)[] = opps.map((_, i) => {
    const id = pinnedIds[i];
    if (!id) return null;
    return monthRows
      .map((r, j) => (r.oppId && r.oppId === id ? j : -1))
      .filter((j) => j >= 0);
  });

  // FIELD-matched candidates per role (engine semantics) for auto-resolution,
  // then FORCE-include each pinned role's rows so deal joins still resolve even
  // when a pinned opp fails a field condition (the point of the diagnostic).
  const fieldMatched = new Map<string, number[]>();
  for (const opp of opps) {
    const idxs: number[] = [];
    for (let i = 0; i < monthRows.length; i++) {
      if (
        rowMatchesOppFields(monthRows[i], opp) &&
        rowPassesSelfComparatives(monthRows[i], opp)
      )
        idxs.push(i);
    }
    fieldMatched.set(opp.name, idxs);
  }
  for (let i = 0; i < opps.length; i++) {
    const idx = pinnedIdx[i];
    if (!idx || idx.length === 0) continue;
    const list = fieldMatched.get(opps[i].name)!;
    for (const j of idx) if (!list.includes(j)) list.push(j);
  }

  // Seed auto-resolution from the first pinned role that has rows (declaration
  // order), so blank roles can be resolved against the user's pinned opps.
  let seedName: string | null = null;
  let seedIdx: number[] = [];
  for (let i = 0; i < opps.length; i++) {
    const idx = pinnedIdx[i];
    if (idx && idx.length > 0) {
      seedName = opps[i].name;
      seedIdx = idx;
      break;
    }
  }

  const roleRows = new Map<string, number[]>();
  for (const opp of opps) roleRows.set(opp.name, []);
  if (seedName) {
    const resolved = resolveDealRoleRows(
      monthRows,
      opps,
      fieldMatched,
      seedName,
      seedIdx,
    );
    if (resolved) for (const [k, v] of resolved) roleRows.set(k, v);
  }
  // A pinned role's explicit rows OVERRIDE auto-resolution (even when empty /
  // not found); blank roles keep their auto-resolved rows.
  for (let i = 0; i < opps.length; i++) {
    const idx = pinnedIdx[i];
    if (idx === null) continue;
    roleRows.set(opps[i].name, idx.slice());
  }

  // Classify each role's conditions against its representative row.
  const diagnoses: PairedOppDiagnosis[] = opps.map((opp, oppIdx) => {
    const pinned = pinnedIds[oppIdx] !== "";
    const idx = pinnedIdx[oppIdx];
    const found = pinned ? (idx?.length ?? 0) > 0 : true;
    const myIdx = roleRows.get(opp.name) ?? [];
    const resolved = myIdx.length > 0;

    const fieldConds = oppConditions(opp)
      .filter(
        (c): c is Extract<CompPairedCondition, { kind: "field" }> =>
          c.kind === "field",
      )
      .map((c) => ({ field: c.field, op: c.op, value: c.value }));
    const repIdx = bestRowIndexForConditions(monthRows, myIdx, fieldConds);

    const conditions = oppConditions(opp).map((c): CompConditionTestStatus => {
      if (c.kind === "field") {
        if (repIdx === null) return "notTestable";
        return matchCondition(monthRows[repIdx], {
          field: c.field,
          op: c.op,
          value: c.value,
        })
          ? "match"
          : "noMatch";
      }
      // comparative
      // Task #420 — formula-term numeric comparatives are rule-level aggregate
      // gates over roleRows; testable only when every referenced opp resolved.
      if (!isIdentityField(c.field) && hasFormulaTerms(c)) {
        const refs = formulaReferencedOpps(c);
        if (refs.some((n) => (roleRows.get(n) ?? []).length === 0))
          return "notTestable";
        // Task #436 — sum only field-matching rows per referenced role (engine
        // semantics), not the force-included set.
        const fmRoles = fieldMatchedRoleRows(monthRows, roleRows, opps);
        const { left, right } = formulaOperands(monthRows, fmRoles, c);
        return numericOp(left, c.op, right) ? "match" : "noMatch";
      }
      if (c.compareToOpp === opp.name) {
        if (repIdx === null) return "notTestable";
        return evalSelfComparative(monthRows[repIdx], c) ? "match" : "noMatch";
      }
      const otherIdx = roleRows.get(c.compareToOpp) ?? [];
      if (myIdx.length === 0 || otherIdx.length === 0) return "notTestable";
      // Task #436 — restrict NUMERIC (magnitude) cross gates to each side's
      // field-matched subset so force-included duplicates that fail a field
      // condition don't leak into the Σ. Identity cross comparatives keep the
      // force-included rows (the join uses presence, not magnitude).
      if (!isIdentityField(c.field)) {
        const otherOpp = opps.find((o) => o.name === c.compareToOpp);
        const myField = fieldMatchedSubset(monthRows, myIdx, opp);
        const otherField = otherOpp
          ? fieldMatchedSubset(monthRows, otherIdx, otherOpp)
          : otherIdx;
        if (myField.length === 0 || otherField.length === 0) return "notTestable";
        return evalCrossComparative(monthRows, myField, otherField, c)
          ? "match"
          : "noMatch";
      }
      return evalCrossComparative(monthRows, myIdx, otherIdx, c)
        ? "match"
        : "noMatch";
    });

    return { name: opp.name, isSelf: pinned, resolved, conditions, pinned, found };
  });

  // Overall verdict: pin the filled-in opps to their roles and run the pairing.
  // An EXISTS role must resolve (have rows) with all its conditions matching; a
  // DOES NOT EXIST role whose (pinned or auto-resolved) opp is present and
  // satisfies its presence conditions means the excluded partner is present →
  // the rule does NOT fire. Numeric/date cross-gates are applied to EXISTS roles
  // only (mirrors evaluatePairedOppRules, which skips them for exclude opps).
  let fires: CompPairedFiresVerdict;
  if (!anyPinned) {
    fires = "incomplete";
  } else {
    let ok = true;
    for (let i = 0; i < opps.length; i++) {
      const opp = opps[i];
      const conds = oppConditions(opp);
      const status = diagnoses[i].conditions;
      const hasRows = (roleRows.get(opp.name) ?? []).length > 0;
      if (opp.mode === "match") {
        const allMatch =
          status.length === 0 ? true : status.every((s) => s === "match");
        if (!hasRows || !allMatch) {
          ok = false;
          break;
        }
      } else {
        // exclude: presence = field/self/identity conditions hold (cross
        // numeric/date gates are ignored, matching the engine).
        const presenceHold = conds.every((c, ci) => {
          const isCrossGate =
            c.kind === "comparative" &&
            // Task #420 — formula-term numeric gates are rule-level, never a
            // per-row presence test, so they too are skipped for exclude opps.
            ((!isIdentityField(c.field) && hasFormulaTerms(c)) ||
              (c.compareToOpp !== opp.name &&
                (!isIdentityField(c.field) || (c.op !== "eq" && c.op !== "ne"))));
          return isCrossGate ? true : status[ci] === "match";
        });
        if (hasRows && presenceHold) {
          ok = false;
          break;
        }
      }
    }
    fires = ok ? "fires" : "doesNotFire";
  }

  return { selfOppName: seedName, opps: diagnoses, fires };
}

export interface CompensationResult {
  // Aligned to the input rows array (index-for-index).
  compensable: number[];
  // Combined multiplier per row (product of all matching rules, or the
  // effective ratio for a paired-opp override row).
  multipliers: number[];
  // The rules that matched each row. For paired-opp override rows this is a
  // single synthetic entry labelled with the pairing rule's label.
  appliedRules: AppliedRule[][];
  // ── Task #317: generic paired-opp per-row metadata ──────────────────────
  // The pairing rule id/label for a paired member row (null otherwise).
  pairRuleId: (string | null)[];
  pairRuleLabel: (string | null)[];
  // Stable key grouping the members of one matched group (null otherwise).
  pairKey: (string | null)[];
  // Name of the matched rule's named opp this row belongs to (null otherwise).
  pairOppName: (string | null)[];
  // Human-readable description of the adjustment applied to this row's side.
  pairAdjustmentLabel: (string | null)[];
  // True when the row's churn was waived (cancel/rebook + FUB-cancel suppression).
  churnSuppressed: boolean[];
  // True when an `ignoreAcqChurn` adjustment flagged the row's opp to bypass
  // the global ACQ same-month churn gate (MRR itself unchanged by the op).
  acqChurnIgnored: boolean[];
  // Owner the row's credit was reassigned to (null otherwise).
  ownerReassignedTo: (string | null)[];
  // All matched pairs, for inspection / export.
  pairSummaries: PairedOppPairSummary[];
  // Task #276: per-row base MRR-source field override actually applied (null
  // when no matching rule set one, the row is CPD-sourced, or it's a paired
  // override row).
  appliedMrrField: (MrrField | null)[];
  // Label of the (first/top-down) rule whose field override won (null when no
  // override applied to the row).
  mrrFieldRuleLabel: (string | null)[];
  // Labels of every matching field-setting rule, in order, so the drilldown can
  // flag opps that matched more than one and show which one won (the first).
  mrrFieldRuleLabels: string[][];
  totalActual: number;
  totalCompensable: number;
  byProduct: Record<string, { actual: number; compensable: number }>;
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr.filter(Boolean)));
}

// Core engine. Pure: given the standardized rows and a config, produces the
// per-row compensable MRR (multiplier engine), with generic paired-opp rules
// overriding the compensable value of their member opps. Designed to run once
// per refresh across the full opportunity set.
export function computeCompensation(
  rows: CompRowInput[],
  config: CompensationConfig,
): CompensationResult {
  const n = rows.length;
  const compensable = new Array<number>(n).fill(0);
  const multipliers = new Array<number>(n).fill(1);
  const appliedRules: AppliedRule[][] = Array.from({ length: n }, () => []);
  const pairRuleId = new Array<string | null>(n).fill(null);
  const pairRuleLabel = new Array<string | null>(n).fill(null);
  const pairKey = new Array<string | null>(n).fill(null);
  const pairOppName = new Array<string | null>(n).fill(null);
  const pairAdjustmentLabel = new Array<string | null>(n).fill(null);
  const churnSuppressed = new Array<boolean>(n).fill(false);
  const acqChurnIgnored = new Array<boolean>(n).fill(false);
  const ownerReassignedTo = new Array<string | null>(n).fill(null);
  const appliedMrrField = new Array<MrrField | null>(n).fill(null);
  const mrrFieldRuleLabel = new Array<string | null>(n).fill(null);
  const mrrFieldRuleLabels: string[][] = Array.from({ length: n }, () => []);

  // 1) Generic paired-opp rules — override member opps' compensable values.
  const { rowMeta: pairMeta, summaries: pairSummaries } = evaluatePairedOppRules(
    rows,
    config.pairedOppRules ?? [],
  );

  // 2) Per-row compensable: pair override wins, else multiplier engine.
  const byProduct: Record<string, { actual: number; compensable: number }> = {};
  let totalActual = 0;
  let totalCompensable = 0;
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const actual = r.standardizedMrr;
    let comp: number;
    const meta = pairMeta.get(i);
    if (meta) {
      // Record pairing metadata for every member row (even when no adjustment
      // changed its value), so the drilldown can render the pairing + reverse.
      pairRuleId[i] = meta.pairRuleId;
      pairRuleLabel[i] = meta.pairRuleLabel;
      pairKey[i] = meta.pairKey;
      pairOppName[i] = meta.pairOppName;
      pairAdjustmentLabel[i] = meta.adjustmentLabel;
      churnSuppressed[i] = meta.churnSuppressed;
      acqChurnIgnored[i] = meta.ignoreAcqChurn;
      ownerReassignedTo[i] = meta.ownerReassignedTo;
    }
    if (meta && meta.override !== null) {
      comp = meta.override;
      const ratio = actual !== 0 ? comp / actual : 1;
      multipliers[i] = ratio;
      appliedRules[i] = [{ id: meta.pairRuleId, label: meta.pairRuleLabel, multiplier: ratio }];
    } else {
      const { multiplier, applied, mrrField, mrrFieldRuleLabel: winLabel, mrrFieldRuleLabels: labels } =
        evaluateMultiplier(r, config.multiplierRules);
      multipliers[i] = multiplier;
      appliedRules[i] = applied;
      // Task #276/#314: a matching rule may override the base MRR source. The
      // override only changes the compensable base (× multiplier); `actual`
      // (which feeds totalActual / byProduct.actual) stays the Type-driven
      // standardized MRR. The override is source-scoped: CPD-sourced rows read
      // the CPD columns, feeder rows read the feeder columns. A field whose
      // source doesn't match the row's source is ignored (save-time validation
      // also blocks cross-source rules), as is a column not supplied on the row.
      let base = actual;
      if (mrrField) {
        const fieldSource = MRR_FIELD_SOURCE[mrrField];
        const fv =
          r.isCpdSourced && fieldSource === "cpd"
            ? cpdMrrFieldValue(r, mrrField)
            : !r.isCpdSourced && fieldSource === "feeder"
              ? mrrFieldValue(r, mrrField)
              : null;
        if (fv !== null) {
          base = fv;
          appliedMrrField[i] = mrrField;
          mrrFieldRuleLabel[i] = winLabel;
          mrrFieldRuleLabels[i] = labels;
        }
      }
      comp = base * multiplier;
    }
    compensable[i] = comp;
    totalActual += actual;
    totalCompensable += comp;
    const p = r.product || "(blank)";
    const bucket = byProduct[p] ?? (byProduct[p] = { actual: 0, compensable: 0 });
    bucket.actual += actual;
    bucket.compensable += comp;
  }

  return {
    compensable,
    multipliers,
    appliedRules,
    pairRuleId,
    pairRuleLabel,
    pairKey,
    pairOppName,
    pairAdjustmentLabel,
    churnSuppressed,
    acqChurnIgnored,
    ownerReassignedTo,
    pairSummaries,
    appliedMrrField,
    mrrFieldRuleLabel,
    mrrFieldRuleLabels,
    totalActual,
    totalCompensable,
    byProduct,
  };
}
