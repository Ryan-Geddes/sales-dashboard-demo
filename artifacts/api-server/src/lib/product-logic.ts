// ===========================================================================
// Product Logic engine (Task #350)
// ===========================================================================
// Data-driven replacement for the hardcoded product-attribution, MRR-field, and
// Overage closed-won / close-date special-casing that used to live in
// sheets-data.ts. A single GLOBAL, ordered, FIRST-MATCH rule set (stored in
// Postgres, editable from the app) drives:
//   - which canonical product an opp is attributed to (attributeProduct),
//   - which feeder/CPD numeric column is its standardized MRR (standardizeMrr),
//   - whether it is treated as Closed Won while in Discovery (effectiveFunnelStage)
//     and gets its close date pinned to the 1st of the month (effectiveCloseDate).
//
// Product KEYS stay canonical so Goals/Compensation (keyed on product names)
// keep matching. A separate, display-only rename map controls how products are
// labeled in the UI (filter name / chart abbreviation / drilldown opp name).
//
// The seed (DEFAULT_PRODUCT_LOGIC_RULES) reproduces the previous hardcode
// EXACTLY — see product-logic.test.ts for the parity checks.

import { db, dbDirect } from "@workspace/db";
import {
  productLogicConfigTable,
  productLogicExamplesTable,
  PRODUCT_LOGIC_CONFIG_ID,
  MRR_FIELD_OPTIONS,
  MRR_FIELD_SOURCE,
  CPD_DEFAULT_MRR_FIELD,
  type CompCondition,
  type CompField,
  type MrrField,
  type MrrFieldSource,
  type ProductLogicRule,
  type ProductLogicAssign,
  type ProductRenameEntry,
  type ProductLogicConfigShape,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { rowMatchesAllConditions, type CompRowInput } from "./compensation";
import { dbScopeKey } from "./demo-session";

// ---------------------------------------------------------------------------
// Match input
// ---------------------------------------------------------------------------
// A loose, structural row shape the engine matches against. ParsedRow (and the
// 3-field attribution call site) are both assignable to this. Fields default to
// "" / 0 when absent — exactly mirroring the legacy `(x || "").trim()` behavior.

export interface ProductLogicMatchRow {
  type?: string;
  product?: string;
  rawProduct?: string;
  productFamily?: string;
  quoteType?: string;
  termLength?: string;
  salesRole?: string;
  oppName?: string;
  funnelStage?: string;
  group?: string;
  segment?: string;
  legacyFlag?: boolean;
  flexFlipAgentStatus?: string;
  fubFirstPurchaseDate?: string;
  closeDate?: string;
  changeInMrr?: number;
  totalMrr?: number;
  splitTotalPrice?: number;
  totalPrice?: number;
  amount?: number;
  mrr?: number;
  // CPD-object columns (frontline_dash_cpds), present on CPD synthetic rows.
  cpdPositiveChangeInMrr?: number;
  cpdNegativeChangeInMrr?: number;
  standardizedMrr?: number;
}

// Adapt a loose match row into the CompRowInput shape the shared matcher reads.
function toCompRow(r: ProductLogicMatchRow): CompRowInput {
  return {
    oppId: "",
    accountId: "",
    product: r.product ?? "",
    rawProduct: r.rawProduct ?? "",
    productFamily: r.productFamily ?? "",
    type: r.type ?? "",
    closeDate: r.closeDate ?? "",
    standardizedMrr: r.standardizedMrr ?? 0,
    quoteType: r.quoteType,
    termLength: r.termLength,
    salesRole: r.salesRole,
    oppName: r.oppName,
    funnelStage: r.funnelStage,
    group: r.group,
    segment: r.segment,
    legacyFlag: r.legacyFlag,
    flexFlipAgentStatus: r.flexFlipAgentStatus,
    fubFirstPurchaseDate: r.fubFirstPurchaseDate,
    changeInMrr: r.changeInMrr,
    totalMrr: r.totalMrr,
    splitTotalPrice: r.splitTotalPrice,
    totalPrice: r.totalPrice,
    amount: r.amount,
    mrr: r.mrr,
  };
}

// ---------------------------------------------------------------------------
// Default (seed) rules — reproduce the legacy hardcode EXACTLY.
// ---------------------------------------------------------------------------
// Ordered, first-match. Field-assign carries the legacy normalization intrinsically:
//   "Market Based Pricing" -> "MBP", blank -> "No Product Selected".
// Note: CPD synthetic rows (ZMX / Showcase Incremental - Re/Max) set their
// product directly at ingest and never call attributeProduct, so the ZMX/SCI-R
// rules below exist primarily to resolve their MRR field (splitTotalPrice).

export const DEFAULT_PRODUCT_LOGIC_RULES: ProductLogicRule[] = [
  {
    id: "cart",
    label: "Cart → MBP",
    conditions: [{ field: "type", op: "eq", value: "Cart" }],
    assign: { kind: "literal", product: "MBP" },
    mrrField: "splitTotalPrice",
    treatAsClosedWon: false,
    source: "feeder",
  },
  {
    id: "showcase",
    label: "Showcase",
    conditions: [{ field: "type", op: "eq", value: "Showcase" }],
    assign: { kind: "literal", product: "Showcase" },
    mrrField: "splitTotalPrice",
    treatAsClosedWon: false,
    source: "feeder",
  },
  {
    id: "showcase-incremental",
    label: "Showcase Incremental",
    conditions: [{ field: "type", op: "eq", value: "Showcase Incremental" }],
    assign: { kind: "literal", product: "Showcase Incremental" },
    mrrField: "splitTotalPrice",
    treatAsClosedWon: false,
    source: "feeder",
  },
  {
    id: "showcase-incremental-remax",
    label: "Showcase Incremental - Re/Max (CPD)",
    conditions: [
      { field: "type", op: "eq", value: "Showcase Incremental - Re/Max" },
    ],
    assign: { kind: "literal", product: "Showcase Incremental - Re/Max" },
    mrrField: "mrr_added",
    treatAsClosedWon: false,
    source: "cpd",
  },
  {
    id: "overage",
    label: "Overage (treat as Closed Won)",
    conditions: [{ field: "type", op: "eq", value: "Overage" }],
    assign: { kind: "literal", product: "Overage" },
    mrrField: "splitTotalPrice",
    treatAsClosedWon: true,
    source: "feeder",
  },
  {
    id: "zmx",
    label: "ZMX (CPD)",
    conditions: [{ field: "type", op: "eq", value: "ZMX" }],
    assign: { kind: "literal", product: "ZMX" },
    mrrField: "mrr_added",
    treatAsClosedWon: false,
    source: "cpd",
  },
  {
    id: "unified-cancel",
    label: "Unified Opp / Cancel → Product Family",
    conditions: [
      { field: "type", op: "in", value: ["Unified Opp", "Cancel"] },
    ],
    assign: { kind: "field", field: "productFamily" },
    mrrField: "changeInMrr",
    treatAsClosedWon: false,
    source: "feeder",
  },
  {
    id: "checkout",
    label: "Checkout → Product",
    conditions: [{ field: "type", op: "eq", value: "Checkout" }],
    assign: { kind: "field", field: "rawProduct" },
    mrrField: "splitTotalPrice",
    treatAsClosedWon: false,
    source: "feeder",
  },
  {
    id: "catch-all",
    label: "Everything else → Product",
    conditions: [],
    assign: { kind: "field", field: "rawProduct" },
    mrrField: "changeInMrr",
    treatAsClosedWon: false,
    source: "feeder",
    isCatchAll: true,
  },
];

export const DEFAULT_PRODUCT_RENAME_MAP: ProductRenameEntry[] = [];

export function defaultProductLogicConfig(): ProductLogicConfigShape {
  return {
    rules: clone(DEFAULT_PRODUCT_LOGIC_RULES),
    renameMap: clone(DEFAULT_PRODUCT_RENAME_MAP),
  };
}

// Back-compat: older saved configs (and the pre-source-scoping seed) stored
// CPD-source rules with the feeder `splitTotalPrice` column. Source scoping now
// requires a CPD rule to use a CPD column (and vice-versa), so coerce any
// source/field mismatch to that source's default. `mrr_added` reads the same
// splitTotalPrice basis, so CPD MRR is unchanged.
export function normalizeRuleSourceScope(
  rules: ProductLogicRule[],
): ProductLogicRule[] {
  return rules.map((r) => {
    const source: MrrFieldSource = r.source ?? "feeder";
    if (MRR_FIELD_SOURCE[r.mrrField] === source) return r;
    return {
      ...r,
      mrrField: source === "cpd" ? CPD_DEFAULT_MRR_FIELD : "splitTotalPrice",
    };
  });
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ---------------------------------------------------------------------------
// Assignment + MRR-field helpers
// ---------------------------------------------------------------------------

// Legacy normalization applied at every field-read attribution site.
function normalizeAssignValue(raw: string): string {
  const v = (raw || "").trim();
  if (v === "Market Based Pricing") return "MBP";
  return v || "No Product Selected";
}

function applyAssign(assign: ProductLogicAssign, row: CompRowInput): string {
  if (assign.kind === "literal") return assign.product ?? "";
  const raw =
    assign.field === "productFamily" ? row.productFamily : row.rawProduct;
  return normalizeAssignValue(raw);
}

// Read a numeric MRR column off a row for standardized MRR. Feeder columns
// mirror the legacy `r.<col> || 0`. CPD-object columns (selectable only on
// CPD-source rules) read the Databricks values carried on the synthetic row:
// `mrr_added` is the CPD base — ingest copies it into splitTotalPrice, so it
// reads that basis and preserves the legacy CPD value — while the change-in-MRR
// columns read their dedicated fields.
function readMrrColumn(row: ProductLogicMatchRow, field: MrrField): number {
  switch (field) {
    case "changeInMrr":
      return row.changeInMrr || 0;
    case "totalMrr":
      return row.totalMrr || 0;
    case "splitTotalPrice":
      return row.splitTotalPrice || 0;
    case "totalPrice":
      return row.totalPrice || 0;
    case "amount":
      return row.amount || 0;
    case "mrr":
      return row.mrr || 0;
    case "mrr_added":
      return row.splitTotalPrice || 0;
    case "positive_change_in_mrr":
      return row.cpdPositiveChangeInMrr || 0;
    case "negative_change_in_mrr":
      return row.cpdNegativeChangeInMrr || 0;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Engine — evaluate a row against the active (or supplied) rule set.
// ---------------------------------------------------------------------------

export interface ProductLogicMatch {
  ruleId: string;
  product: string;
  mrrField: MrrField;
  treatAsClosedWon: boolean;
  isCatchAll: boolean;
  matched: boolean;
}

// First-match evaluation. Returns the resolved product, MRR field, and flags.
// When nothing matches (no catch-all configured), falls back to the legacy
// passthrough (field rawProduct, changeInMrr) so the engine never crashes.
export function evaluateProductLogic(
  input: ProductLogicMatchRow,
  rules: ProductLogicRule[] = getActiveRules(),
): ProductLogicMatch {
  const row = toCompRow(input);
  for (const rule of rules) {
    if (rowMatchesAllConditions(row, rule.conditions)) {
      return {
        ruleId: rule.id,
        product: applyAssign(rule.assign, row),
        mrrField: rule.mrrField,
        treatAsClosedWon: rule.treatAsClosedWon,
        isCatchAll: !!rule.isCatchAll,
        matched: true,
      };
    }
  }
  return {
    ruleId: "",
    product: normalizeAssignValue(row.rawProduct),
    mrrField: "changeInMrr",
    treatAsClosedWon: false,
    isCatchAll: true,
    matched: false,
  };
}

// The canonical product an opp is attributed to (replaces attributeProduct).
export function resolveProduct(input: ProductLogicMatchRow): string {
  return evaluateProductLogic(input).product;
}

// The standardized MRR for a row (replaces standardizeMrr's body).
export function resolveStandardizedMrr(input: ProductLogicMatchRow): number {
  const m = evaluateProductLogic(input);
  return readMrrColumn(input, m.mrrField);
}

// Standardized MRR plus the match metadata, so callers that need both the value
// and the matched rule (e.g. to emit an "unmapped type" warning) evaluate once.
export function resolveStandardizedMrrDetailed(
  input: ProductLogicMatchRow,
): { value: number; match: ProductLogicMatch } {
  const match = evaluateProductLogic(input);
  return { value: readMrrColumn(input, match.mrrField), match };
}

// The MRR field a row resolves to (replaces defaultMrrFieldForType's intent).
export function resolveMrrField(input: ProductLogicMatchRow): MrrField {
  return evaluateProductLogic(input).mrrField;
}

// The set of canonical products produced by literal-assign rules flagged
// treatAsClosedWon. A row is "treated as Closed Won" when its attributed
// product is in this set — this reproduces the legacy isOverageRow check
// (type === "Overage" || product === "Overage") because type === "Overage"
// always attributes to product "Overage".
export function closedWonProductSet(
  rules: ProductLogicRule[] = getActiveRules(),
): Set<string> {
  const set = new Set<string>();
  for (const rule of rules) {
    if (rule.treatAsClosedWon && rule.assign.kind === "literal" && rule.assign.product) {
      set.add(rule.assign.product);
    }
  }
  return set;
}

// True when a row's already-attributed product is in the closed-won set.
export function isTreatedAsClosedWon(
  product: string,
  rules: ProductLogicRule[] = getActiveRules(),
): boolean {
  return closedWonProductSet(rules).has((product || "").trim());
}

// ---------------------------------------------------------------------------
// Fallthrough detection — opps the editor should review (catch-all / "Other" /
// "No Product Selected").
// ---------------------------------------------------------------------------

export const FALLTHROUGH_PRODUCTS: ReadonlySet<string> = new Set([
  "Other",
  "No Product Selected",
]);

export function isFallthroughMatch(m: ProductLogicMatch): boolean {
  return m.isCatchAll || FALLTHROUGH_PRODUCTS.has((m.product || "").trim());
}

// ---------------------------------------------------------------------------
// Rename map (display only)
// ---------------------------------------------------------------------------

function renameEntryFor(
  canonical: string,
  map: ProductRenameEntry[] = getActiveRenameMap(),
): ProductRenameEntry | undefined {
  const key = (canonical || "").trim();
  return map.find((e) => (e.canonical || "").trim() === key);
}

export function displayFilterName(
  canonical: string,
  map?: ProductRenameEntry[],
): string {
  const e = renameEntryFor(canonical, map);
  return e?.filterName?.trim() || canonical;
}

export function displayAbbreviation(
  canonical: string,
  map?: ProductRenameEntry[],
): string {
  const e = renameEntryFor(canonical, map);
  return e?.abbreviation?.trim() || canonical;
}

// Optional drilldown opportunity-name override for an attributed product.
export function oppNameOverrideFor(
  canonical: string,
  map?: ProductRenameEntry[],
): string | null {
  const e = renameEntryFor(canonical, map);
  const v = e?.oppNameOverride?.trim();
  return v ? v : null;
}

// ---------------------------------------------------------------------------
// Active in-memory config (loaded from DB at startup, refreshed on write).
// ---------------------------------------------------------------------------

let activeConfig: ProductLogicConfigShape = defaultProductLogicConfig();

export function getActiveRules(): ProductLogicRule[] {
  return activeConfig.rules;
}

export function getActiveRenameMap(): ProductRenameEntry[] {
  return activeConfig.renameMap;
}

export function setActiveProductLogicConfig(config: ProductLogicConfigShape): void {
  // The active config is process-global (it is read synchronously per parsed
  // row). A demo session's uncommitted product-logic edit must never become the
  // process-wide attribution config, so publishing is skipped inside a demo
  // session — the edit is still visible to that session in the Product Logic
  // tab, it just doesn't re-attribute the shared pipeline. Live mode and the
  // Owner session are never in a demo scope, so this is a no-op for them.
  if (dbScopeKey()) return;
  activeConfig = {
    rules: config.rules ?? [],
    renameMap: config.renameMap ?? [],
  };
}

// Test-only escape hatch to swap the active config and restore defaults.
export function __setActiveRulesForTesting(
  rules: ProductLogicRule[],
  renameMap: ProductRenameEntry[] = [],
): void {
  setActiveProductLogicConfig({ rules, renameMap });
}
export function __resetActiveRulesForTesting(): void {
  setActiveProductLogicConfig(defaultProductLogicConfig());
}

// ---------------------------------------------------------------------------
// DB read / write / seed (singleton global row).
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;
// Partitioned by DB scope so a demo session's uncommitted config edit is never
// served to another session. Live mode only ever uses the "" key.
const configCacheByScope = new Map<
  string,
  { config: ProductLogicConfigStored; at: number }
>();

export interface ProductLogicConfigStored extends ProductLogicConfigShape {
  updatedByName?: string | null;
  updatedByRole?: string | null;
  updatedAt?: string | null;
  isDefault: boolean;
}

export function invalidateProductLogicCache(): void {
  configCacheByScope.clear();
}

export async function getProductLogicConfig(): Promise<ProductLogicConfigStored> {
  const scope = dbScopeKey();
  const cached = configCacheByScope.get(scope);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.config;
  }
  let config: ProductLogicConfigStored;
  try {
    const rows = await db
      .select()
      .from(productLogicConfigTable)
      .where(eq(productLogicConfigTable.id, PRODUCT_LOGIC_CONFIG_ID))
      .limit(1);
    if (rows.length === 0) {
      config = { ...defaultProductLogicConfig(), isDefault: true };
    } else {
      const r = rows[0];
      config = {
        rules: r.rules ?? [],
        renameMap: r.renameMap ?? [],
        updatedByName: r.updatedByName,
        updatedByRole: r.updatedByRole,
        updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
        isDefault: false,
      };
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[ProductLogic] getProductLogicConfig failed; using defaults",
    );
    config = { ...defaultProductLogicConfig(), isDefault: true };
  }
  config.rules = normalizeRuleSourceScope(config.rules);
  configCacheByScope.set(scope, { config, at: Date.now() });
  return config;
}

export async function upsertProductLogicConfig(
  rules: ProductLogicRule[],
  renameMap: ProductRenameEntry[],
  updatedByName: string | null,
  updatedByRole: string | null,
): Promise<ProductLogicConfigStored> {
  const inserted = await db
    .insert(productLogicConfigTable)
    .values({ id: PRODUCT_LOGIC_CONFIG_ID, rules, renameMap, updatedByName, updatedByRole })
    .onConflictDoUpdate({
      target: productLogicConfigTable.id,
      set: { rules, renameMap, updatedByName, updatedByRole, updatedAt: sql`now()` },
    })
    .returning();
  invalidateProductLogicCache();
  const r = inserted[0];
  const config: ProductLogicConfigStored = {
    rules: r.rules ?? [],
    renameMap: r.renameMap ?? [],
    updatedByName: r.updatedByName,
    updatedByRole: r.updatedByRole,
    updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    isDefault: false,
  };
  setActiveProductLogicConfig(config);
  return config;
}

// Idempotently persist the default config so there's a concrete editable row
// before the UI ships. Safe to call on every boot.
export async function seedProductLogicConfig(): Promise<void> {
  try {
    await db
      .insert(productLogicConfigTable)
      .values({
        id: PRODUCT_LOGIC_CONFIG_ID,
        rules: clone(DEFAULT_PRODUCT_LOGIC_RULES),
        renameMap: clone(DEFAULT_PRODUCT_RENAME_MAP),
        updatedByName: "system",
        updatedByRole: "admin",
      })
      .onConflictDoNothing({ target: productLogicConfigTable.id });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[ProductLogic] seedProductLogicConfig failed",
    );
  }
}

// Load the persisted config into the in-memory active set. Called at startup
// (after seeding) so the data pipeline attributes against the stored rules.
export async function loadActiveProductLogicConfig(): Promise<void> {
  const config = await getProductLogicConfig();
  setActiveProductLogicConfig(config);
  activeConfigInitialized = true;
  activeConfigRefreshedAt = Date.now();
}

// ---------------------------------------------------------------------------
// Task #440: keep the in-memory active config coherent with the persisted DB
// config. The engine's resolution (standardizeMrr / resolveMrrField, both via
// getActiveRules) reads `activeConfig`, which was previously only populated at
// startup and on writes through upsertProductLogicConfig. Any config change
// that didn't go through that exact path — or a server whose startup load
// failed — left the engine serving stale (seed) rules indefinitely, diverging
// from the admin Product Logic tab (which reads the DB directly).
//
// This TTL-guarded refresh reconciles the active config with the persisted one
// before data computation. It reuses getProductLogicConfig's own 30s cache, so
// after the first call it is a cheap in-memory hash compare — keeping the
// per-row resolution (standardizeMrr) synchronous. Returns true when the active
// rules/renameMap actually changed, so the caller can invalidate dependent
// caches (parsed rows carry baked-in product attribution; aggregate views are
// served from a result cache).
const ACTIVE_CONFIG_TTL_MS = 30_000;
let activeConfigInitialized = false;
let activeConfigRefreshedAt = 0;

function sameProductLogicConfig(
  a: ProductLogicConfigShape,
  b: ProductLogicConfigShape,
): boolean {
  return (
    JSON.stringify(a.rules ?? []) === JSON.stringify(b.rules ?? []) &&
    JSON.stringify(a.renameMap ?? []) === JSON.stringify(b.renameMap ?? [])
  );
}

export async function refreshActiveProductLogicConfig(): Promise<boolean> {
  const now = Date.now();
  // Inside a demo session the DB reads resolve that session's uncommitted
  // config; reconciling the process-global active config from it would leak the
  // edit to everyone (and thrash the shared caches). Never reached in live mode.
  if (dbScopeKey()) return false;
  if (
    activeConfigInitialized &&
    now - activeConfigRefreshedAt < ACTIVE_CONFIG_TTL_MS
  ) {
    return false;
  }
  // getProductLogicConfig never throws (it catches DB errors and falls back to
  // defaults). Guard anyway so a failure can't pin the engine to seed defaults:
  // on error we leave the active config untouched and do NOT advance the TTL,
  // so the next data computation retries the load instead of waiting it out.
  try {
    const config = await getProductLogicConfig();
    const next: ProductLogicConfigShape = {
      rules: config.rules ?? [],
      renameMap: config.renameMap ?? [],
    };
    const changed =
      !activeConfigInitialized || !sameProductLogicConfig(activeConfig, next);
    if (changed) setActiveProductLogicConfig(next);
    activeConfigInitialized = true;
    activeConfigRefreshedAt = now;
    return changed;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[ProductLogic] refreshActiveProductLogicConfig failed; keeping current active config",
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Example opportunities (persisted snapshot, one per rule).
// ---------------------------------------------------------------------------

export interface ProductLogicExampleInput {
  ruleId: string;
  fields: Record<string, string>;
  source: MrrFieldSource;
  oppId?: string | null;
  accountId?: string | null;
  sfContactId?: string | null;
  sfCpdId?: string | null;
}

// Replace the per-rule example snapshots wholesale. Snapshots persist beyond
// the ~2-month feeder window so the editor always has a concrete example.
export async function replaceProductLogicExamples(
  examples: ProductLogicExampleInput[],
): Promise<void> {
  if (examples.length === 0) return;
  try {
    // dbDirect (autocommit pool), NOT the routed `db` handle: example
    // snapshots are system-initiated refreshes during pipeline compute, never
    // user edits. Inside a demo session's never-committed transaction they
    // would mark the session as edited and make other sessions' identical
    // upserts lock-wait behind the uncommitted rows.
    for (const ex of examples) {
      await dbDirect
        .insert(productLogicExamplesTable)
        .values({
          ruleId: ex.ruleId,
          fields: ex.fields,
          source: ex.source,
          oppId: ex.oppId ?? null,
          accountId: ex.accountId ?? null,
          sfContactId: ex.sfContactId ?? null,
          sfCpdId: ex.sfCpdId ?? null,
        })
        .onConflictDoUpdate({
          target: productLogicExamplesTable.ruleId,
          set: {
            fields: ex.fields,
            source: ex.source,
            oppId: ex.oppId ?? null,
            accountId: ex.accountId ?? null,
            sfContactId: ex.sfContactId ?? null,
            sfCpdId: ex.sfCpdId ?? null,
            capturedAt: sql`now()`,
          },
        });
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[ProductLogic] replaceProductLogicExamples failed",
    );
  }
}

export async function getProductLogicExamples() {
  try {
    return await db.select().from(productLogicExamplesTable);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[ProductLogic] getProductLogicExamples failed",
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Validation (for the write endpoint / Task #351 UI).
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
  "oppName",
  "funnelStage",
  "changeInMrr",
  "splitTotalPrice",
  "flexFlipAgentStatus",
  "fub_first_purchase_date",
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
// All selectable MRR columns. The picker is source-scoped (enforced in
// validateProductLogicRules): a feeder rule may only use feeder columns, a CPD
// rule only CPD columns. CPD synthetic rows (ZMX / Re/Max) carry mrr_added in
// splitTotalPrice, so the CPD `mrr_added` column reads that basis and preserves
// the legacy value.
const ALL_MRR_FIELDS = new Set(MRR_FIELD_OPTIONS.map((o) => o.value));

function validateConditions(
  raw: unknown,
  ruleRef: string,
): { ok: true; conditions: CompCondition[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: `${ruleRef} conditions must be an array` };
  const conditions: CompCondition[] = [];
  for (let j = 0; j < raw.length; j++) {
    const c = raw[j] as Record<string, unknown>;
    const ref = `${ruleRef} condition ${j + 1}`;
    if (!c || typeof c !== "object") return { ok: false, error: `${ref} must be an object` };
    if (!VALID_FIELDS.has(c.field as CompField)) {
      return { ok: false, error: `${ref} has invalid field "${String(c.field)}"` };
    }
    if (!VALID_OPS.has(c.op as string)) {
      return { ok: false, error: `${ref} has invalid op "${String(c.op)}"` };
    }
    const op = c.op as string;
    if (op === "in" || op === "notIn") {
      if (!Array.isArray(c.value) || c.value.length === 0) {
        return { ok: false, error: `${ref} (${op}) value must be a non-empty array` };
      }
    } else if (
      c.value === undefined ||
      c.value === null ||
      typeof c.value === "object"
    ) {
      return { ok: false, error: `${ref} value must be a scalar` };
    }
    conditions.push({ field: c.field as CompField, op: op as CompCondition["op"], value: c.value as CompCondition["value"] });
  }
  return { ok: true, conditions };
}

export function validateProductLogicRules(
  raw: unknown,
): { ok: true; rules: ProductLogicRule[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "rules must be an array" };
  const rules: ProductLogicRule[] = [];
  const ids = new Set<string>();
  let catchAllCount = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Record<string, unknown>;
    const ref = `rule ${i + 1}`;
    if (!r || typeof r !== "object") return { ok: false, error: `${ref} must be an object` };
    if (typeof r.id !== "string" || !r.id.trim()) {
      return { ok: false, error: `${ref} must have a non-empty id` };
    }
    if (ids.has(r.id)) return { ok: false, error: `${ref} has duplicate id "${r.id}"` };
    ids.add(r.id);
    if (typeof r.label !== "string" || !r.label.trim()) {
      return { ok: false, error: `${ref} must have a non-empty label` };
    }
    const condRes = validateConditions(r.conditions, ref);
    if (!condRes.ok) return condRes;

    const assign = r.assign as Record<string, unknown> | undefined;
    if (!assign || typeof assign !== "object") {
      return { ok: false, error: `${ref} must have an assign` };
    }
    if (assign.kind === "literal") {
      if (typeof assign.product !== "string" || !assign.product.trim()) {
        return { ok: false, error: `${ref} literal assign must have a product` };
      }
    } else if (assign.kind === "field") {
      if (assign.field !== "rawProduct" && assign.field !== "productFamily") {
        return { ok: false, error: `${ref} field assign must use rawProduct or productFamily` };
      }
    } else {
      return { ok: false, error: `${ref} assign.kind must be "literal" or "field"` };
    }

    const source = (r.source as MrrFieldSource) ?? "feeder";
    if (source !== "feeder" && source !== "cpd") {
      return { ok: false, error: `${ref} source must be "feeder" or "cpd"` };
    }
    const mrrField = r.mrrField as MrrField;
    if (!ALL_MRR_FIELDS.has(mrrField)) {
      return { ok: false, error: `${ref} has invalid mrrField "${String(r.mrrField)}"` };
    }
    // Source scoping (mirrors the compensation engine): CPD synthetic rows take
    // their MRR from the Databricks CPD columns and feeder rows from the
    // Salesforce feeder sheet, so the chosen mrrField must belong to the rule's
    // own source. A feeder column on a CPD rule (or vice-versa) is rejected.
    if (MRR_FIELD_SOURCE[mrrField] !== source) {
      return {
        ok: false,
        error: `${ref} mrrField "${mrrField}" is a ${MRR_FIELD_SOURCE[mrrField]} column but the rule source is "${source}"`,
      };
    }
    const isCatchAll = !!r.isCatchAll;
    if (isCatchAll) catchAllCount++;

    rules.push({
      id: r.id,
      label: r.label,
      conditions: condRes.conditions,
      assign: assign.kind === "literal"
        ? { kind: "literal", product: assign.product as string }
        : { kind: "field", field: assign.field as ProductLogicAssign["field"] },
      mrrField,
      treatAsClosedWon: !!r.treatAsClosedWon,
      source,
      ...(isCatchAll ? { isCatchAll: true } : {}),
    });
  }
  if (catchAllCount > 1) {
    return { ok: false, error: "at most one rule may be the catch-all" };
  }
  return { ok: true, rules };
}

export function validateRenameMap(
  raw: unknown,
): { ok: true; renameMap: ProductRenameEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "renameMap must be an array" };
  const map: ProductRenameEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i] as Record<string, unknown>;
    const ref = `rename ${i + 1}`;
    if (!e || typeof e !== "object") return { ok: false, error: `${ref} must be an object` };
    if (typeof e.canonical !== "string" || !e.canonical.trim()) {
      return { ok: false, error: `${ref} must have a non-empty canonical` };
    }
    const key = e.canonical.trim();
    if (seen.has(key)) return { ok: false, error: `${ref} has duplicate canonical "${key}"` };
    seen.add(key);
    const entry: ProductRenameEntry = { canonical: key };
    if (typeof e.filterName === "string" && e.filterName.trim()) entry.filterName = e.filterName.trim();
    if (typeof e.abbreviation === "string" && e.abbreviation.trim()) entry.abbreviation = e.abbreviation.trim();
    if (typeof e.oppNameOverride === "string" && e.oppNameOverride.trim()) {
      entry.oppNameOverride = e.oppNameOverride.trim();
    }
    map.push(entry);
  }
  return { ok: true, renameMap: map };
}
