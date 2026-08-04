import { pgTable, primaryKey, text, serial, timestamp, integer, real, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export * from "./auth";

export const oppProbabilityOverridesTable = pgTable("opp_probability_overrides", {
  oppId: text("opp_id").primaryKey(),
  probability: integer("probability").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedByName: text("updated_by_name"),
  // When the rep most recently confirmed this opp's probability — set on
  // every PUT (even if the value matches the stage default), nulled by the
  // weekly Sunday cron for opps under SLMs with the auto-reset toggle on.
  // When NULL, the opp shows in the Unreviewed Opportunities list and the
  // probability cell renders with the yellow highlight.
  reviewedAt: timestamp("reviewed_at"),
});

export type OppProbabilityOverride = typeof oppProbabilityOverridesTable.$inferSelect;

export const stageDefaultProbabilitiesTable = pgTable("stage_default_probabilities", {
  stage: text("stage").primaryKey(),
  probability: integer("probability").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedByName: text("updated_by_name"),
});

export type StageDefaultProbability = typeof stageDefaultProbabilitiesTable.$inferSelect;

export const HARDCODED_STAGE_DEFAULTS: Record<string, number> = {
  "Discovery": 20,
  "Demo Scheduled": 30,
  "Proposal/Negotiation": 43,
  "Paperwork Sent": 60,
  "Awaiting Payment": 90,
  "Closed Won": 100,
  "Closed Lost": 0,
};

// Manager Estimate: per-(flm, month, product) unweighted churn estimate
// entered by FLMs (or SLMs with a confirm-then-overwrite flow). Per-rep
// shares are derived at read time (see lib/manager-estimates.ts in the
// api-server). Probability % overrides for the pinned Manager Estimate row
// in the Sched Mods drilldown reuse opp_probability_overrides keyed by the
// synthetic id `mgr_est:{rep}|{month_yyyymm}|{product}`.
export const managerEstimatesTable = pgTable("manager_estimates", {
  flmName: text("flm_name").notNull(),
  monthYyyymm: text("month_yyyymm").notNull(),
  product: text("product").notNull(),
  unweightedAmount: integer("unweighted_amount").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedByName: text("updated_by_name"),
  updatedByRole: text("updated_by_role"),
}, (t) => [primaryKey({ columns: [t.flmName, t.monthYyyymm, t.product] })]);

export type ManagerEstimate = typeof managerEstimatesTable.$inferSelect;

export const contestsTable = pgTable("contests", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  objective: text("objective"),
  metric: text("metric").notNull(),
  product: text("product"),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  eligibility: text("eligibility"),
  incentiveStructure: text("incentive_structure"),
  rewardDetails: text("reward_details"),
  createdByName: text("created_by_name").notNull(),
  createdByRole: text("created_by_role").notNull(),
  scope: text("scope"),
  status: text("status").notNull().default("pending"),
  approvedByName: text("approved_by_name"),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertContestSchema = createInsertSchema(contestsTable).omit({ id: true, createdAt: true, approvedByName: true, approvedAt: true });
export type InsertContest = z.infer<typeof insertContestSchema>;
export type Contest = typeof contestsTable.$inferSelect;

// ============================================================================
// Compensation rules ("compensable revenue")
// ============================================================================
// A per-month set of adjustments that transform actual MRR into
// compensation-adjusted ("compensable") MRR. Two complexity classes:
//   (a) a configurable multiplier engine — conditional rules that map a
//       product/attribute combination to a multiplier applied to the opp's
//       MRR. Task #246: ALL matching rules STACK (their multipliers are
//       multiplied together), rather than first-match-wins; and
//   (b) a built-in FUB↔Zpro linking rule with editable parameters.
// Config is keyed by `YYYY-MM` and is independent month-to-month: editing
// June never changes May. See artifacts/api-server/src/lib/compensation.ts
// for the engine and the seeded June reference config.

// Fields an engine condition can test. `legacyFlag` is boolean; the rest are
// string-valued (numeric-aware comparison handles term length etc.).
export type CompField =
  | "product"
  | "rawProduct"
  | "productFamily"
  | "type"
  | "termLength"
  | "legacyFlag"
  | "group"
  | "segment"
  | "salesRole"
  | "quoteType"
  // Task #317: extra fields needed to express cross-opp (paired-opp) rule
  // scenarios — opportunity name (substring match), funnel stage gate, and the
  // numeric Change-in-MRR / Split Total Price comparisons.
  | "oppName"
  | "funnelStage"
  | "changeInMrr"
  | "splitTotalPrice"
  | "flexFlipAgentStatus"
  // Task #347: FUB first-purchase date, enriched onto feeder rows from the
  // frontline_dash_product_data Databricks table (join by 18-char opp id).
  | "fub_first_purchase_date"
  // Task #434: the two raw people columns from the feeder sheet, exposed as
  // independently-selectable condition fields. Distinct from the blended `rep`
  // (User || Opportunity Owner) used for attribution.
  | "user"
  | "oppOwner";

export type CompOp =
  | "eq"
  | "ne"
  | "in"
  | "notIn"
  // Task #317: numeric comparisons and case-insensitive substring matches used
  // by paired-opp side conditions (e.g. Change in MRR > 0, Name not-contains
  // "v4").
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "notContains";

// Numeric columns a multiplier rule may pick as its base MRR source. There are
// two disjoint upstream sources (Task #314): the Salesforce feeder sheet
// (Task #276) and the Databricks CPD object (`frontline_dash_cpds`). A single
// rule may only reference one source. When a rule sets a field, opps matching
// that rule use this column as the base MRR (before the multiplier) instead of
// the Type-driven default resolved by `standardizeMrr`.
export type MrrField =
  // Feeder-sheet columns (Task #276).
  | "changeInMrr"
  | "totalMrr"
  | "splitTotalPrice"
  | "totalPrice"
  | "amount"
  | "mrr"
  // CPD-object columns (Task #314) — raw column names from frontline_dash_cpds.
  | "mrr_added"
  | "positive_change_in_mrr"
  | "negative_change_in_mrr";

// Feeder-sheet MRR source options (Task #276). Display labels are human
// readable. Order is the picker order.
export const FEEDER_MRR_FIELD_OPTIONS: { value: MrrField; label: string }[] = [
  { value: "changeInMrr", label: "Change in MRR" },
  { value: "totalMrr", label: "Total MRR" },
  { value: "splitTotalPrice", label: "Split Total Price" },
  { value: "totalPrice", label: "Total Price" },
  { value: "amount", label: "Amount" },
  { value: "mrr", label: "MRR" },
];

// CPD-object MRR source options (Task #314). Labels are the raw column names —
// this is backend-only comp tooling. `mrr_added` is the default base.
export const CPD_MRR_FIELD_OPTIONS: { value: MrrField; label: string }[] = [
  { value: "mrr_added", label: "mrr_added" },
  { value: "positive_change_in_mrr", label: "positive_change_in_mrr" },
  { value: "negative_change_in_mrr", label: "negative_change_in_mrr" },
];

// Default CPD base MRR column when a CPD-pinned rule sets no explicit override —
// keeps CPD comp unchanged from before the picker was enabled (Task #314).
export const CPD_DEFAULT_MRR_FIELD: MrrField = "mrr_added";

// Canonical valid MRR source fields with display labels — shared by the API
// (config endpoint + save validation) and the rules UI so the picker stays
// data-driven. Feeder options first, then CPD options.
export const MRR_FIELD_OPTIONS: { value: MrrField; label: string }[] = [
  ...FEEDER_MRR_FIELD_OPTIONS,
  ...CPD_MRR_FIELD_OPTIONS,
];

// Upstream source of each MRR field (Task #314). A rule's product/type
// conditions determine its source; the chosen MRR field must match it.
export type MrrFieldSource = "feeder" | "cpd";
export const MRR_FIELD_SOURCE: Record<MrrField, MrrFieldSource> = {
  changeInMrr: "feeder",
  totalMrr: "feeder",
  splitTotalPrice: "feeder",
  totalPrice: "feeder",
  amount: "feeder",
  mrr: "feeder",
  mrr_added: "cpd",
  positive_change_in_mrr: "cpd",
  negative_change_in_mrr: "cpd",
};

// Product/type values whose opps are CPD-sourced (Databricks), not feeder
// (Task #314). A rule referencing any of these may not also reference a feeder
// product/type. ZMX and Re/Max share this CPD source, so they may coexist.
export const CPD_SOURCED_VALUES: string[] = [
  "ZMX",
  "Showcase Incremental - Re/Max",
];

export interface CompCondition {
  field: CompField;
  op: CompOp;
  // `in` / `notIn` use a string[]; `eq` / `ne` use a scalar.
  value: string | number | boolean | string[];
}

// Which revenue-view mode(s) a compensation rule applies in. "quota" = Quota
// Target Revenue (the default/compensable view), "sales" = Sales Target
// Revenue, "both" = applied in either. An omitted value is treated as "quota"
// so pre-existing rules keep applying in the default view.
export type CompRevenueScope = "quota" | "sales" | "both";

export interface CompMultiplierRule {
  id: string;
  label: string;
  // All conditions must match (logical AND) for the rule to apply.
  conditions: CompCondition[];
  multiplier: number;
  // Revenue-view mode(s) this rule applies in (omitted => "quota").
  appliesIn?: CompRevenueScope;
  // Optional per-rule base MRR source field override (Task #276). When set,
  // opps matching this rule's full condition set use this feeder-sheet numeric
  // column as the base MRR (before the multiplier) instead of the Type-driven
  // default. When an opp matches multiple field-setting rules, the first
  // (top-down) wins. Ignored for CPD-sourced rows (ZMX / Showcase Incremental
  // - Re/Max) whose MRR comes from Databricks, not the feeder sheet.
  mrrField?: MrrField;
}

export interface FubZproRule {
  enabled: boolean;
  // Contact Flex Flip Agent Status values that flip the pairing to the
  // factor branch (Zpro MRR × factor) instead of the netting branch
  // (Zpro MRR − FUB lost revenue).
  flexFlipStatuses: string[];
  factor: number;
}

// ─── Generic cross-opp (paired-opp) comp adjustment rules ─────────────────────
// A configurable replacement for hardcoded cross-opp pairings (FUB↔Zpro,
// cancel/rebook). A rule links opportunities sharing configurable link-field
// values, then describes a set of NAMED opportunities (each Match or Exclude)
// and adjustments that reference those opps by name. The framing is that
// Salesforce has already applied these adjustments to the data; the dashboard
// MODELS each one so a toggle can REVERSE it (show pre-adjustment revenue).

// Numeric/MRR feeder columns usable on both sides of a comparative condition and
// by the reassign-MRR-field adjustment. Feeder-only (CPD columns out of scope
// for paired rules).
export type CompComparableField =
  | "changeInMrr"
  | "totalMrr"
  | "splitTotalPrice"
  | "totalPrice"
  | "amount"
  | "mrr";

// Granularity for a date-typed identity comparison: match by calendar month or
// exact day.
export type CompDateGranularity = "month" | "exact";

// Task #411: the math operator applied between the RIGHT operand's Σ field and
// its scalar (`factor`) before a numeric comparative runs. Defaults to multiply
// (preserving the legacy `× factor` behavior).
export type CompFactorOp = "add" | "subtract" | "multiply" | "divide";

// Identity (string-valued) fields usable on either side of an identity
// comparative condition. An identity `=` comparative is what joins two opps into
// the same deal/group (e.g. "this opp's Account ID = opp \"fub\"'s Account ID");
// an identity `≠` comparative filters within the group (e.g. "different
// Product"). For a date field, `dateGranularity` selects month-of-date vs
// exact-date matching.
export type CompIdentityField =
  | "contactId"
  | "accountId"
  | "closeDate"
  // Task #347: FUB first-purchase date as a date-typed identity (join) field,
  // supporting month/exact granularity like closeDate.
  | "fub_first_purchase_date"
  | "product"
  | "rawProduct"
  | "productFamily"
  | "type"
  | "rep"
  // Task #434: raw User / Opportunity Owner columns as comparative (join/≠)
  // identity fields, independent of the blended `rep`.
  | "user"
  | "oppOwner"
  | "oppName"
  | "funnelStage"
  | "termLength"
  | "group"
  | "segment"
  | "salesRole"
  | "quoteType";

// Canonical list of identity fields, shared by the engine/validator and the UI
// picker so they stay in lockstep.
export const COMP_IDENTITY_FIELDS: CompIdentityField[] = [
  "contactId",
  "accountId",
  "closeDate",
  "fub_first_purchase_date",
  "product",
  "rawProduct",
  "productFamily",
  "type",
  "rep",
  "user",
  "oppOwner",
  "oppName",
  "funnelStage",
  "termLength",
  "group",
  "segment",
  "salesRole",
  "quoteType",
];

// A single condition inside a named opportunity. Two kinds:
//  - "field": a normal field/op/value test (same semantics as CompCondition).
//  - "comparative": compares THIS opp's value/magnitude of a field to ANOTHER
//    opp's value/magnitude of a field. Two sub-kinds, by field type:
//     • identity field (string): a per-row VALUE join. `=` ties the two opps
//       into the same deal/group (scoped to account/contact/etc.); `≠` filters
//       within the group, e.g. "this opp's Account ID = opp \"fub\"'s Account
//       ID" or "this opp's Product ≠ opp \"a\"'s Product".
//     • numeric field (feeder MRR): an aggregate |Σ| MAGNITUDE comparison, e.g.
//       "this opp's |Σ Change in MRR| > opp \"zpro\"'s |Σ Amount|".
export interface CompFieldCondition {
  kind: "field";
  field: CompField;
  op: CompOp;
  value: string | number | boolean | string[];
}

export interface CompComparativeCondition {
  kind: "comparative";
  // This opp's field (left operand). Identity field → value join; numeric
  // (feeder MRR) field → aggregate magnitude.
  field: CompComparableField | CompIdentityField;
  // For identity fields: eq (join) / ne (filter). Date identity fields
  // (closeDate, fub_first_purchase_date) also support the ordering ops
  // gt/gte/lt/lte (chronological) — including cross-field comparisons between
  // two different date fields. For numeric fields: any of eq/ne/gt/gte/lt/lte.
  op: CompOp;
  // Name of an opp in the same rule (right operand source). May be ANOTHER opp
  // or THIS opp's own name (a same-opp, per-row internal field comparison). A
  // cross-opp identity eq/ne JOIN must reference an EARLIER opp in the rule's
  // list; same-opp comparisons and closeDate ordering gates have no such
  // ordering requirement.
  compareToOpp: string;
  // That opp's field (right operand). Must be the same kind (identity vs
  // numeric) as `field`.
  compareToField: CompComparableField | CompIdentityField;
  // Only meaningful when either side is `closeDate` (an identity comparison).
  // Defaults to "month" when omitted.
  dateGranularity?: CompDateGranularity;
  // Numeric (magnitude) comparative only — scalar applied to the RIGHT operand
  // (the compareTo opp's Σ field) via `factorOp` before the comparison runs.
  // Defaults to 1. Ignored for identity comparatives.
  factor?: number;
  // Task #411 — math operator combining the RIGHT operand's Σ field with the
  // `factor` scalar (Σ RHS  factorOp  factor). Defaults to "multiply",
  // preserving the legacy `× factor` behavior. Ignored for identity comparatives.
  factorOp?: CompFactorOp;
  // Per-side scalar + math operator. Each operand may carry its OWN scalar and
  // operator, applied to that side's Σ field before sign/abs and the comparison.
  // `leftFactor`/`leftFactorOp` modify THIS opp's Σ field; `rightFactor`/
  // `rightFactorOp` modify the compareTo opp's Σ field. Each defaults to 1 /
  // "multiply" (identity no-op). The legacy single `factor`/`factorOp` above are
  // still read as the RIGHT side's values when `rightFactor`/`rightFactorOp` are
  // absent (back-compat). Ignored for identity comparatives.
  leftFactor?: number;
  leftFactorOp?: CompFactorOp;
  rightFactor?: number;
  rightFactorOp?: CompFactorOp;
  // Task #411 — per-side magnitude flags. When true, that side compares the raw
  // SIGNED aggregate ("Actual Value"); when false/absent it compares the
  // magnitude ("Absolute Value", the legacy default). `leftSigned` governs this
  // opp's Σ field; `rightSigned` governs the compareTo opp's combined operand.
  // Ignored for identity comparatives.
  leftSigned?: boolean;
  rightSigned?: boolean;
  // Legacy (pre-#411) single flag: when true, BOTH sides compared signed. Still
  // read for back-compat when `leftSigned`/`rightSigned` are absent. Superseded
  // by the per-side flags above. Ignored for identity comparatives.
  signed?: boolean;
  // Task #420 — per-side FORMULA. When present (numeric comparatives only), each
  // side is an ordered list of logic terms combined by precedence (× / ÷ before
  // + / −) and this SUPERSEDES the single field / compareToOpp / compareToField +
  // factor/sign fields above. When BOTH are absent the legacy single-operand
  // evaluation (using those fields) runs unchanged, so existing rules evaluate
  // identically. Note the per-term modifier is applied ABS-INSIDE
  // (`(abs(Σ) factorOp factor)`), unlike the legacy abs-OUTSIDE single operand —
  // hence the dual evaluation path. Ignored for identity comparatives.
  leftTerms?: CompLogicTerm[];
  rightTerms?: CompLogicTerm[];
}

// Task #420 — a single "logic object" within a numeric comparative SIDE. Each
// side of a numeric comparative can be an ordered list of these terms, combined
// by `joinOp` using standard operator precedence (× / ÷ before + / −). A term is
// either an opp-field term (Σ of a feeder MRR column over a named opp's matched
// rows, with the abs/actual flag + factor modifier applied INSIDE its
// parentheses, e.g. `(abs(opp "a" Σ change in mrr) − 1)`) or a custom literal.
// Numeric comparatives only; ignored for identity comparatives.
export type CompLogicSource = "opp" | "custom";

export interface CompLogicTerm {
  source: CompLogicSource;
  // Operator joining this term to the PREVIOUS term on its side. Ignored on the
  // first term of a side. One of the four math ops; defaults to "add".
  joinOp?: CompFactorOp;
  // ── opp-field term (source === "opp") ───────────────────────────────────
  // Name of an opp in the same rule whose Σ field this term sums.
  opp?: string;
  // Feeder MRR column summed for that opp.
  field?: CompComparableField;
  // Inner modifier applied to the (abs/actual) Σ: value = (Σ) factorOp factor.
  // Both default to the identity ×1, so an unset modifier is a no-op.
  factor?: number;
  factorOp?: CompFactorOp;
  // false/absent → magnitude |Σ| (default); true → raw signed Σ ("Actual Value").
  signed?: boolean;
  // ── custom term (source === "custom") ───────────────────────────────────
  // Literal constant (may be negative; up to 2 decimal places).
  value?: number;
}

export type CompPairedCondition = CompFieldCondition | CompComparativeCondition;

// A named opportunity within a paired-opp rule. `match` opps must have at least
// one matching row in a linked group; `exclude` opps must have none.
export type CompOppMode = "match" | "exclude";

export interface CompNamedOpp {
  // Unique within the rule — referenced by comparative conditions + adjustments.
  name: string;
  mode: CompOppMode;
  // AND-joined conditions (field + comparative).
  conditions: CompPairedCondition[];
}

// The math a single adjustment applies to its target opp's compensable MRR.
//  - waive:    set compensable to 0 (remove churn / remove credit).
//  - keep:     leave the value unchanged (used when only reassigning the owner).
//  - fixedCredit: set compensable to ±`amount` (sign of the target preserved).
//  - capAt:    compensable = sign-preserving min(|targetMrr|, amount).
//  - incremental: compensable = |target| − |comparison| (needs comparisonOpp;
//    may go negative; no floor).
//  - greaterOfFloorOrIncremental: compensable = max(amount, |target| −
//    |comparison|) (credit floor).
//  - multiplyByFactor: compensable = targetMrr × amount.
//  - reassignMrrField: set each target row's compensable to its own feeder MRR
//    column (`mrrField`). Replaces the old per-side MRR field override.
//  - ignoreAcqChurn: leaves MRR unchanged but flags the target opp to bypass
//    the global ACQ same-month churn gate, so its churn counts even without a
//    matching positive same-month Closed Won.
export type CompAdjustmentOp =
  | "waive"
  | "keep"
  | "fixedCredit"
  | "capAt"
  | "incremental"
  | "greaterOfFloorOrIncremental"
  | "multiplyByFactor"
  | "reassignMrrField"
  | "ignoreAcqChurn";

export interface CompAdjustment {
  // Name of the Match opp this adjustment affects.
  targetOpp: string;
  op: CompAdjustmentOp;
  // Dollar/factor parameter for fixedCredit / capAt /
  // greaterOfFloorOrIncremental / multiplyByFactor.
  amount?: number;
  // Name of the Match opp supplying |comparison| for incremental /
  // greaterOfFloorOrIncremental.
  comparisonOpp?: string;
  // Optional feeder MRR column used to measure the comparison opp for
  // incremental / greaterOfFloorOrIncremental. When omitted, the comparison
  // uses the comparison opp's standardized MRR (the existing behavior). The
  // target side always uses |standardized MRR|.
  comparisonField?: MrrField;
  // Feeder MRR column for reassignMrrField.
  mrrField?: MrrField;
  // Reassign the target opp's credit/attribution to this named (Match) opp's
  // owner — gated to target rows whose owner role is in reassignableOwnerRoles.
  reassignOwnerToOpp?: string;
}

export interface PairedOppRule {
  id: string;
  label: string;
  enabled: boolean;
  // Named opportunities (Match/Exclude). The first opp is the ANCHOR (must be
  // Match); every other opp ties itself to the group via ≥1 identity `=`
  // comparative condition referencing an earlier opp. The rule fires for a deal
  // when every Match opp has ≥1 matching row and every Exclude opp has none.
  opps: CompNamedOpp[];
  // Adjustments applied to matched groups, in order (reference opps by name).
  adjustments: CompAdjustment[];
  // Owner roles whose opps may be reassigned by a reassignOwnerToOpp
  // adjustment. Defaults to DEFAULT_REASSIGNABLE_OWNER_ROLES when omitted.
  reassignableOwnerRoles?: string[];
  // Revenue-view mode(s) this rule applies in (omitted => "quota").
  appliesIn?: CompRevenueScope;
}

// Default gate for owner reassignment: only Compliance Sales / Account Sales
// owned opps may be reassigned to a paired opp's owner.
export const DEFAULT_REASSIGNABLE_OWNER_ROLES: string[] = [
  "Compliance Sales",
  "Account Sales",
];

// ============================================================================
// Product Logic (Task #350): data-driven product attribution + MRR-field engine
// ============================================================================
// Replaces the hardcoded product-attribution / MRR-field / Overage-stage logic
// with an ordered, FIRST-MATCH rule set stored in Postgres. Product keys stay
// CANONICAL so Goals/Compensation (keyed on product names) keep matching; the
// separate rename map below is display-only.

// How a matched rule assigns the canonical product. "literal" => a fixed
// product name. "field" => copy the value of a raw opp field, applying the same
// "Market Based Pricing" -> "MBP" normalization and blank -> "No Product
// Selected" fallback the legacy code applied.
export type ProductLogicAssignKind = "literal" | "field";
export type ProductLogicAssignField = "rawProduct" | "productFamily";

export interface ProductLogicAssign {
  kind: ProductLogicAssignKind;
  // Set when kind === "literal".
  product?: string;
  // Set when kind === "field".
  field?: ProductLogicAssignField;
}

export interface ProductLogicRule {
  id: string;
  label: string;
  // All conditions must match (logical AND); rules are evaluated top-down and
  // the FIRST matching rule wins (unlike comp multiplier rules, which stack).
  conditions: CompCondition[];
  assign: ProductLogicAssign;
  // Feeder-sheet (or CPD) numeric column standardizeMrr() reads for matched rows.
  mrrField: MrrField;
  // When true, rows attributed to this rule's (literal) product are treated as
  // Closed Won while sitting in Discovery, and their effective close date is
  // pinned to the 1st of the month. Generalizes the old Overage special-casing.
  treatAsClosedWon: boolean;
  // Informational source tag: "feeder" (Salesforce feeder sheet) vs "cpd"
  // (Databricks CPD synthetic rows whose MRR-field override is CPD-scoped).
  source: MrrFieldSource;
  // The terminal passthrough rule that catches everything else. At most one.
  isCatchAll?: boolean;
}

// Display-only rename for a canonical product. The canonical key is never
// changed (Goals/Comp depend on it); these only affect dashboard presentation.
export interface ProductRenameEntry {
  // Canonical product key this entry renames.
  canonical: string;
  // Name shown in the product filter (defaults to canonical when blank).
  filterName?: string;
  // Short label used in charts/visualizations.
  abbreviation?: string;
  // Optional override for the opportunity name shown in drilldowns.
  oppNameOverride?: string;
}

export interface ProductLogicConfigShape {
  rules: ProductLogicRule[];
  renameMap: ProductRenameEntry[];
}

// Singleton global Product Logic config. One standing row (id = "global"); the
// config is NOT month-scoped. Seeded from code defaults on first boot.
export const PRODUCT_LOGIC_CONFIG_ID = "global" as const;

export const productLogicConfigTable = pgTable("product_logic_config", {
  id: text("id").primaryKey(),
  rules: jsonb("rules").$type<ProductLogicRule[]>().notNull().default([]),
  renameMap: jsonb("rename_map").$type<ProductRenameEntry[]>().notNull().default([]),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedByName: text("updated_by_name"),
  updatedByRole: text("updated_by_role"),
});

export type ProductLogicConfigRow = typeof productLogicConfigTable.$inferSelect;

// A representative example opportunity snapshotted per rule so it persists
// beyond the ~2-month feeder window. `fields` holds the raw opp fields needed
// to display the example and prefill a new rule; the SF identity columns let
// the frontend resolve a Salesforce link (including CPD/synthetic objects).
export const productLogicExamplesTable = pgTable("product_logic_examples", {
  ruleId: text("rule_id").primaryKey(),
  fields: jsonb("fields").$type<Record<string, string>>().notNull(),
  // "feeder" | "cpd" — drives which SF link convention the frontend uses.
  source: text("source").notNull().default("feeder"),
  oppId: text("opp_id"),
  accountId: text("account_id"),
  sfContactId: text("sf_contact_id"),
  sfCpdId: text("sf_cpd_id"),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
});

export type ProductLogicExampleRow = typeof productLogicExamplesTable.$inferSelect;

export const compensationConfigTable = pgTable("compensation_config", {
  monthYyyymm: text("month_yyyymm").primaryKey(),
  multiplierRules: jsonb("multiplier_rules").$type<CompMultiplierRule[]>().notNull().default([]),
  // Task #317: generic cross-opp pairing rules. Replaces the legacy
  // `fub_zpro_rule` column (kept nullable for back-compat reads during
  // migration; the engine no longer uses it).
  pairedOppRules: jsonb("paired_opp_rules").$type<PairedOppRule[]>().notNull().default([]),
  fubZproRule: jsonb("fub_zpro_rule").$type<FubZproRule | null>(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedByName: text("updated_by_name"),
  updatedByRole: text("updated_by_role"),
});

export type CompensationConfigRow = typeof compensationConfigTable.$inferSelect;

// ============================================================================
// Goals sources & persistence (Executive → Goals tab)
// ============================================================================
// Three goal sources (finance.pps via Databricks, an uploaded Goal CSV, and
// Software % Rules) plus the editable mapping/config they depend on. Persisted
// here so goals survive restarts. See artifacts/api-server/src/lib/goals-*.ts
// for the config store, sources and per-source resolvers. This task does NOT
// change what the live dashboard uses for goals — that cutover is separate.

// Generic key/value config store for the Goals tab. Each editable config
// section is stored under a stable string key with its value as JSON; the
// seeded defaults live in code (see goals-config.ts), mirroring the
// compensation reference-config pattern.
export const goalConfigTable = pgTable("goal_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedByName: text("updated_by_name"),
  updatedByRole: text("updated_by_role"),
});

export type GoalConfigRow = typeof goalConfigTable.$inferSelect;

// Uploaded Goal CSV rows. The CSV is the source of truth; an upload replaces
// the whole table. The full source row is kept in `data` (column name → cell)
// so any column can be inspected or mapped to a goal via the configurable
// output mapping. `month`/`group`/`region`/`segment` are denormalized from the
// canonically-named columns for filtering/joining.
export const goalCsvRowsTable = pgTable("goal_csv_rows", {
  id: serial("id").primaryKey(),
  month: text("month").notNull().default(""),
  group: text("group").notNull().default(""),
  region: text("region").notNull().default(""),
  segment: text("segment").notNull().default(""),
  data: jsonb("data").$type<Record<string, string>>().notNull(),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  uploadedByName: text("uploaded_by_name"),
});

export type GoalCsvRow = typeof goalCsvRowsTable.$inferSelect;

// Snapshot of the finance.pps Databricks query (`frontline_dash_quota`).
// Refreshed on the quota cadence and replaced wholesale; the full source row
// is kept in `data` (column name → cell) so any column can be exposed for
// inspection or mapped to a goal. `performancePeriod`/`employeeId`/`group`
// are denormalized for filtering/joining.
export const goalFinancePpsRowsTable = pgTable("goal_finance_pps_rows", {
  id: serial("id").primaryKey(),
  performancePeriod: text("performance_period").notNull().default(""),
  employeeId: text("employee_id").notNull().default(""),
  group: text("group").notNull().default(""),
  data: jsonb("data").$type<Record<string, string>>().notNull(),
  fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
});

export type GoalFinancePpsRow = typeof goalFinancePpsRowsTable.$inferSelect;

// Snapshot of the eRep-multiplier Databricks query
// (`dim_sales_erep_metrics_daily_snapshot`). Refreshed on the nightly cadence
// and replaced wholesale. Each row is the LATEST `erep_value` for an
// (employeeId, month) pair — the latest-snapshot-per-month collapse happens
// before persisting so reads are a simple per-month lookup. `month` is the
// `YYYY-MM` derived from `snapshot_date`; `snapshotDate` is retained for
// diagnostics.
export const goalErepRowsTable = pgTable("goal_erep_rows", {
  id: serial("id").primaryKey(),
  employeeId: text("employee_id").notNull().default(""),
  month: text("month").notNull().default(""),
  snapshotDate: text("snapshot_date").notNull().default(""),
  erepValue: real("erep_value").notNull().default(1),
  fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
});

export type GoalErepRow = typeof goalErepRowsTable.$inferSelect;

// Task #393: raw upstream data snapshots (Google Sheets CSVs + Databricks
// data_arrays) for per-user dashboard rollback. Two kinds:
//   - `last_good_refresh`: a single rolling row, replaced only after a refresh
//     that passes a health check.
//   - `nightly`: one row per Pacific calendar date, pruned to the last 7.
// `payload` holds the captured raw sources; `pipelineRowCount` is denormalized
// for the health gate + listing without loading the (large) payload.
export const dataSnapshotsTable = pgTable("data_snapshots", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  snapshotDate: text("snapshot_date"),
  capturedAt: timestamp("captured_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  pipelineRowCount: integer("pipeline_row_count").notNull().default(0),
  payload: jsonb("payload").notNull(),
});

export type DataSnapshotRow = typeof dataSnapshotsTable.$inferSelect;

// Per-row overrides for the main Goals table (Executive → Goals). One row per
// (month, rep, product); enumerated rows that have never been edited fall back
// to the code defaults below. `source` selects which goal source drives the
// row's base goals (default finance.pps). The manual multipliers default to 1;
// LOA status defaults to "Unavailable". `eRepMultiplier` is the per-row MANUAL
// override and is nullable: NULL means "use the Databricks-sourced eRep value"
// (effective eRep = manualOverride ?? databricksValue ?? 1.0). Final goal
// columns are computed at read time and not stored.
export const GOAL_ROW_SOURCE_DEFAULT = "financePps" as const;
export const GOAL_ROW_LOA_STATUS_DEFAULT = "Unavailable" as const;

export const goalRowOverridesTable = pgTable("goal_row_overrides", {
  monthYyyymm: text("month_yyyymm").notNull(),
  rep: text("rep").notNull(),
  product: text("product").notNull(),
  source: text("source").notNull().default(GOAL_ROW_SOURCE_DEFAULT),
  mrrAddedManualMultiplier: real("mrr_added_manual_multiplier").notNull().default(1),
  mrrChurnManualMultiplier: real("mrr_churn_manual_multiplier").notNull().default(1),
  loaStatus: text("loa_status").notNull().default(GOAL_ROW_LOA_STATUS_DEFAULT),
  eRepMultiplier: real("erep_multiplier"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedByName: text("updated_by_name"),
  updatedByRole: text("updated_by_role"),
}, (t) => [primaryKey({ columns: [t.monthYyyymm, t.rep, t.product] })]);

export type GoalRowOverride = typeof goalRowOverridesTable.$inferSelect;

// Per-month roster overrides (Executive → Roster). One row per (month, person).
// Each editable field is nullable: NULL means "no override for this field" and
// the effective hierarchy falls back to the base sheet value for that month.
// `active` is a tri-state override: NULL = use the sheet's Active flag, TRUE =
// force-include, FALSE = force-exclude. Overrides are strictly month-scoped and
// never carry forward. Overrides are keyed by a durable person identity
// (email -> employee ID -> canonical name) so they survive feeder name changes.
export const rosterOverridesTable = pgTable("roster_overrides", {
  monthYyyymm: text("month_yyyymm").notNull(),
  // Durable person identity (email -> employee ID -> canonical name) so an
  // override survives feeder name variations. Mirrors the hierarchy's own
  // dedupe identity. `person` is kept as the last-known display name.
  identityKey: text("identity_key").notNull(),
  person: text("person").notNull(),
  active: boolean("active"),
  flm: text("flm"),
  slm: text("slm"),
  region: text("region"),
  segment: text("segment"),
  salesRole: text("sales_role"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedByName: text("updated_by_name"),
  updatedByRole: text("updated_by_role"),
}, (t) => [primaryKey({ columns: [t.monthYyyymm, t.identityKey] })]);

export type RosterOverride = typeof rosterOverridesTable.$inferSelect;
