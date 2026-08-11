import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2, X, Loader2, Check, AlertCircle, Lock, Download, Table2, CopyPlus, SlidersHorizontal } from "lucide-react";
import type { FilterState } from "../../pages/Dashboard";
import type { AuthUser } from "@workspace/replit-auth-web";
import {
  useGetSalesConfig,
  type CompensationConfig,
  type CompMultiplierRule,
  type CompCondition,
  type PairedOppRule,
  type CompAdjustment,
  type CompNamedOpp,
  type CompPairedCondition,
  type CompPairedConditionFactorOp,
  type CompLogicTerm,
  type CompTestOppResult,
  type CompConditionTestStatus,
  type CompPairedOppDiagnosis,
  type CompPairedFiresVerdict,
} from "@workspace/api-client-react";
import { headerFiresVerdict } from "./compensationTester";
import {
  isCompDateField,
  compDateGranularityControl,
  compDateGranularityPatch,
  type CompDateGranularityValue,
} from "./compDateGranularity";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { displayProduct, displayProductText } from "@/lib/product-labels";
import { getTodayPST } from "@/lib/utils";

interface CompensationViewProps {
  filters: FilterState;
  authUser: AuthUser;
}

type ConditionField = CompCondition["field"];
type ConditionOp = CompCondition["op"];

const FIELD_OPTIONS: { value: ConditionField; label: string }[] = [
  { value: "product", label: "Product" },
  { value: "rawProduct", label: "Raw Product" },
  { value: "productFamily", label: "Product Family" },
  { value: "type", label: "Type" },
  { value: "termLength", label: "Term Length" },
  { value: "legacyFlag", label: "Legacy Flag" },
  { value: "group", label: "Channel" },
  { value: "segment", label: "Segment" },
  { value: "salesRole", label: "Sales Role" },
  { value: "quoteType", label: "Quote Type" },
  // Task #317: extra fields used by paired-opp side/guard conditions.
  { value: "oppName", label: "Opportunity Name" },
  { value: "funnelStage", label: "Funnel Stage" },
  { value: "changeInMrr", label: "Change in MRR" },
  { value: "splitTotalPrice", label: "Split Total Price" },
  { value: "flexFlipAgentStatus", label: "Flex Flip Agent Status" },
  // Task #347: FUB first-purchase date enrichment field.
  { value: "fub_first_purchase_date", label: "FUB First Purchase Date" },
  // Task #434: raw people columns, independent of the blended rep. Free-text
  // value input (no generated picklist) via suggestionsFor returning none.
  { value: "user", label: "User" },
  { value: "oppOwner", label: "Opportunity Owner" },
];

const OP_OPTIONS: { value: ConditionOp; label: string }[] = [
  { value: "eq", label: "is" },
  { value: "ne", label: "is not" },
  { value: "in", label: "is one of" },
  { value: "notIn", label: "is not one of" },
  // Task #317: numeric comparisons + substring matches for paired-opp rules.
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "contains", label: "contains" },
  { value: "notContains", label: "does not contain" },
];

// Identity fields used by comparative conditions to JOIN opps by shared value
// (e.g. "this opp's Account ID = the anchor's Account ID"). Op is restricted to
// = / ≠; closeDate carries a month/exact granularity.
const IDENTITY_FIELD_OPTIONS: { value: string; label: string }[] = [
  { value: "accountId", label: "Account ID" },
  { value: "contactId", label: "Contact ID" },
  { value: "closeDate", label: "Close Date" },
  // Task #347: FUB first-purchase date as a paired-rule comparative/join field.
  { value: "fub_first_purchase_date", label: "FUB First Purchase Date" },
  { value: "product", label: "Product" },
  { value: "rawProduct", label: "Raw Product" },
  { value: "productFamily", label: "Product Family" },
  { value: "type", label: "Type" },
  { value: "rep", label: "Rep" },
  // Task #434: raw people columns as comparative (join/≠) identity fields.
  { value: "user", label: "User" },
  { value: "oppOwner", label: "Opportunity Owner" },
  { value: "oppName", label: "Opp Name" },
  { value: "funnelStage", label: "Funnel Stage" },
  { value: "termLength", label: "Term Length" },
  { value: "group", label: "Group" },
  { value: "segment", label: "Segment" },
  { value: "salesRole", label: "Sales Role" },
  { value: "quoteType", label: "Quote Type" },
];
const IDENTITY_FIELD_VALUES = new Set(IDENTITY_FIELD_OPTIONS.map(o => o.value));

// Chronological ordering ops. On an identity comparative these are only valid
// between date fields (either side may be Close Date or FUB First Purchase Date).
const isOrderingOp = (op: unknown): boolean =>
  op === "gt" || op === "gte" || op === "lt" || op === "lte";
const DATE_IDENTITY_FIELD_OPTIONS = IDENTITY_FIELD_OPTIONS.filter(o =>
  isCompDateField(o.value),
);

// Numeric feeder columns used by comparative conditions + reassignMrrField.
const COMPARABLE_FIELD_OPTIONS: { value: string; label: string }[] = [
  { value: "changeInMrr", label: "Change in MRR" },
  { value: "totalMrr", label: "Total MRR" },
  { value: "splitTotalPrice", label: "Split Total Price" },
  { value: "totalPrice", label: "Total Price" },
  { value: "amount", label: "Amount" },
  { value: "mrr", label: "MRR" },
];

// Numeric comparison operators for comparative conditions.
const COMPARATIVE_OP_OPTIONS: { value: ConditionOp; label: string }[] = [
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "eq", label: "=" },
  { value: "ne", label: "≠" },
];

// Task #411: math operators combining the right operand's Σ field with `factor`.
const FACTOR_OP_OPTIONS: {
  value: NonNullable<CompPairedConditionFactorOp>;
  label: string;
}[] = [
  { value: "add", label: "+" },
  { value: "subtract", label: "−" },
  { value: "multiply", label: "×" },
  { value: "divide", label: "÷" },
];

// Task #411: resolve a comparative's per-side magnitude flags. New per-side
// flags (leftSigned/rightSigned) win; otherwise fall back to the legacy single
// `signed` flag (true → both sides signed). Default is magnitude (both abs).
function resolveSidedSigned(c: CompPairedCondition): {
  left: boolean;
  right: boolean;
} {
  const legacy = c.signed === true;
  return {
    left: typeof c.leftSigned === "boolean" ? c.leftSigned : legacy,
    right: typeof c.rightSigned === "boolean" ? c.rightSigned : legacy,
  };
}

// Task #420 — does this numeric comparative use the per-side formula model? Must
// mirror the server's hasFormulaTerms (presence of either side's term list).
function hasFormulaTerms(c: CompPairedCondition): boolean {
  return (
    c.kind === "comparative" &&
    (Array.isArray(c.leftTerms) || Array.isArray(c.rightTerms))
  );
}

// Plain-language rendering of one logic term (abs-INSIDE, per spec).
function logicTermText(t: CompLogicTerm): string {
  if (t.source === "custom") {
    return String(typeof t.value === "number" ? t.value : 0);
  }
  const sym =
    FACTOR_OP_OPTIONS.find(o => o.value === (t.factorOp ?? "multiply"))?.label ??
    "×";
  const scalar = typeof t.factor === "number" ? t.factor : 1;
  const field =
    COMPARABLE_FIELD_OPTIONS.find(o => o.value === t.field)?.label ??
    t.field ??
    "changeInMrr";
  const hasMod = t.factorOp != null || (typeof t.factor === "number" && t.factor !== 1);
  const core = hasMod
    ? `Σ ${field} of "${t.opp ?? "?"}" ${sym} ${scalar}`
    : `Σ ${field} of "${t.opp ?? "?"}"`;
  return t.signed ? `(${core})` : `|${core}|`;
}

// Render one formula SIDE: terms joined by their join operators (joinOp lives on
// the SECOND+ term). Standard precedence is applied at evaluation time; here we
// just print the ordered, parenthesis-free term sequence.
function formulaSideText(terms: CompLogicTerm[] | null | undefined): string {
  if (!terms || terms.length === 0) return "0";
  return terms
    .map((t, i) => {
      const join =
        i === 0
          ? ""
          : `${FACTOR_OP_OPTIONS.find(o => o.value === (t.joinOp ?? "add"))?.label ?? "+"} `;
      return `${join}${logicTermText(t)}`;
    })
    .join(" ");
}

// Task #276/#314: fallback MRR-source-field options for the per-rule picker,
// used only if the live /sales/config payload omits `mrrFields`. The server is
// the source of truth (it ships `mrrFields`); this keeps the UI working offline.
// Feeder columns first, then CPD-object columns (raw column-name labels).
const MRR_FIELD_FALLBACK: { value: string; label: string }[] = [
  { value: "changeInMrr", label: "Change in MRR" },
  { value: "totalMrr", label: "Total MRR" },
  { value: "splitTotalPrice", label: "Split Total Price" },
  { value: "totalPrice", label: "Total Price" },
  { value: "amount", label: "Amount" },
  { value: "mrr", label: "MRR" },
  { value: "mrr_added", label: "mrr_added" },
  { value: "positive_change_in_mrr", label: "positive_change_in_mrr" },
  { value: "negative_change_in_mrr", label: "negative_change_in_mrr" },
];

// Task #276: frontend mirror of the server's `defaultMrrFieldForType` (in
// sheets-data.ts) — the feeder column `standardizeMrr` reads for a given
// Type/Product, as an MrrField code. Used to show the auto-detected default in
// each rule's picker before the editor customizes it. Keep in sync with the
// server mapping.
function defaultMrrFieldForType(value: string): string {
  const t = (value || "").trim();
  if (t === "Unified Opp" || t === "Cancel") return "changeInMrr";
  if (
    t === "Cart" ||
    t === "Checkout" ||
    t === "Showcase" ||
    t === "Showcase Incremental" ||
    t === "Showcase Incremental - Re/Max" ||
    t === "Overage" ||
    t === "ZMX"
  ) {
    return "splitTotalPrice";
  }
  return "changeInMrr";
}

// Task #276: auto-detect the base MRR field a rule would use today, derived from
// the same Type→column mapping as the engine. Collects eq/in values on
// type/product conditions; if they all map to one field, use it, else fall back
// to Change in MRR (ambiguous / no single resolution), matching the spec.
function autoDetectMrrField(rule: CompMultiplierRule): string {
  const vals: string[] = [];
  for (const c of rule.conditions) {
    if (c.field !== "type" && c.field !== "product" && c.field !== "rawProduct") continue;
    if (c.op !== "eq" && c.op !== "in") continue;
    if (Array.isArray(c.value)) vals.push(...c.value.map(String));
    else if (typeof c.value === "string" && c.value) vals.push(c.value);
  }
  if (vals.length === 0) return "changeInMrr";
  const fields = new Set(vals.map(defaultMrrFieldForType));
  return fields.size === 1 ? [...fields][0] : "changeInMrr";
}

// Task #276/#314: CPD-sourced products (ZMX / Showcase Incremental - Re/Max)
// take their MRR from Databricks, not the feeder sheet. A rule's "source" is
// derived from its eq/in conditions on type/product/rawProduct: a rule that
// pins a CPD value is CPD-sourced and reads CPD columns; one that pins a feeder
// value is feeder-sourced. A rule that references both is "mixed" (blocked on
// save). The default fallback set is overridden by config.cpdSourcedValues.
const CPD_SOURCED_VALUES = new Set(["ZMX", "Showcase Incremental - Re/Max"]);
// Raw CPD-object MRR columns and the CPD default (no numeric movement).
const CPD_MRR_FIELD_CODES = new Set([
  "mrr_added",
  "positive_change_in_mrr",
  "negative_change_in_mrr",
]);
const CPD_DEFAULT_MRR_FIELD = "mrr_added";
type RuleSource = "feeder" | "cpd" | "mixed" | "none";
function ruleSourceOf(rule: CompMultiplierRule, cpdValues: Set<string>): RuleSource {
  let hasCpd = false;
  let hasFeeder = false;
  for (const c of rule.conditions) {
    if (c.field !== "type" && c.field !== "product" && c.field !== "rawProduct") continue;
    if (c.op !== "eq" && c.op !== "in") continue;
    const vals = Array.isArray(c.value)
      ? c.value.map(String)
      : typeof c.value === "string"
        ? [c.value]
        : [];
    for (const v of vals) {
      const t = v.trim();
      if (!t) continue;
      if (cpdValues.has(t.toLowerCase())) hasCpd = true;
      else hasFeeder = true;
    }
  }
  if (hasCpd && hasFeeder) return "mixed";
  if (hasCpd) return "cpd";
  if (hasFeeder) return "feeder";
  return "none";
}

const FunnelDrilldownModal = lazy(() => import("../FunnelDrilldownModal"));

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function genId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

// The `YYYY-MM` immediately before the given month key.
function prevMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return monthKey(new Date(y, m - 2, 1));
}

function buildMonthOptions(): string[] {
  const now = getTodayPST();
  const out: string[] = [];
  // Next month first, then the current month and the prior 11 months.
  for (let i = 1; i >= -11; i--) {
    out.push(monthKey(new Date(now.getFullYear(), now.getMonth() + i, 1)));
  }
  return out;
}

// Same DEV impersonation convention used by the rest of the dashboard's
// mutating fetches — forwards the impersonated user id so writes are
// attributed (and authorized) correctly while testing locally.
function buildHeaders(json: boolean): Record<string, string> {
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

async function fetchConfig(month: string): Promise<CompensationConfig> {
  const res = await fetch(
    `/api/sales/compensation/config?month=${encodeURIComponent(month)}`,
    { headers: buildHeaders(false), credentials: "include" },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(txt || `Failed to load config (${res.status})`);
  }
  const data = (await res.json()) as { config: CompensationConfig };
  return data.config;
}

// Task #375: POST a pasted opp id + a (draft) rule to the read-only condition
// tester. Sends the on-screen rule so highlighting tracks unsaved edits.
async function fetchTestOpp(
  oppId: string,
  kind: "multiplier" | "paired",
  rule: CompMultiplierRule | PairedOppRule,
): Promise<CompTestOppResult> {
  const res = await fetch(`/api/sales/compensation/test-opp`, {
    method: "POST",
    headers: buildHeaders(true),
    credentials: "include",
    body: JSON.stringify({ oppId, kind, rule }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(txt || `Failed to test opp (${res.status})`);
  }
  return (await res.json()) as CompTestOppResult;
}

// Task #394: POST a paired rule with an opp id PINNED to each named role. The
// ids are aligned index-for-index to rule.opps ("" = blank → auto-resolved).
// A single call diagnoses every card plus the overall rule-fires verdict.
async function fetchTestOppPaired(
  oppTestIds: string[],
  rule: PairedOppRule,
): Promise<CompTestOppResult> {
  const res = await fetch(`/api/sales/compensation/test-opp`, {
    method: "POST",
    headers: buildHeaders(true),
    credentials: "include",
    body: JSON.stringify({ kind: "paired", rule, oppTestIds }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(txt || `Failed to test opp (${res.status})`);
  }
  return (await res.json()) as CompTestOppResult;
}

// Task #375: per-rule test state shape (mirrors the component's `oppTests` map).
type OppTestState = {
  oppId: string;
  result: CompTestOppResult | null;
  loading: boolean;
  error: string | null;
};

// Task #394: per-paired-rule test state. `oppIds` is aligned to rule.opps (one
// pasted id per card; "" = blank). A single shared `result` carries every card's
// diagnosis + the overall fires verdict. `editingIdx` is the card that triggered
// the in-flight call, so loading / error render on that specific card.
type PairedTestState = {
  oppIds: string[];
  result: CompTestOppResult | null;
  loading: boolean;
  error: string | null;
  editingIdx: number | null;
};

// Map a per-condition diagnosis to its highlight classes. `undefined` means no
// active test → no highlight (the row keeps its normal styling).
function condStatusClasses(
  status: CompConditionTestStatus | undefined,
): string {
  if (status === "match") return "bg-green-50 border-green-300";
  if (status === "noMatch") return "bg-red-50 border-red-300";
  if (status === "notTestable") return "bg-gray-50 border-gray-300";
  return "";
}

// The opp-id tester field shown to the right of each rule's name. Read-only
// diagnostic — never gated by edit permission. Shows a loading hint, an
// "Opp not found" message, or an error under the input.
function OppTesterField({
  test,
  onChange,
}: {
  test: OppTestState | undefined;
  onChange: (value: string) => void;
}) {
  const oppId = test?.oppId ?? "";
  const notFound =
    !!oppId.trim() &&
    !test?.loading &&
    !test?.error &&
    test?.result?.found === false;
  return (
    <div className="flex flex-col gap-1 w-[190px]">
      <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
        Test opp id
      </label>
      <Input
        value={oppId}
        onChange={e => onChange(e.target.value)}
        className="h-8 text-[12px]"
        placeholder="Paste opp id…"
      />
      {test?.loading && (
        <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> Testing…
        </span>
      )}
      {notFound && <span className="text-[10px] text-amber-700">Opp not found</span>}
      {test?.error && <span className="text-[10px] text-red-600">{test.error}</span>}
    </div>
  );
}

// Task #394: overall rule-fires badge for a paired rule, shown in the rule
// header. `incomplete` (no ids entered) is neutral gray; "Rule fires" green;
// "Rule does not fire" red. Renders nothing until a diagnosis exists.
function FiresBadge({
  verdict,
}: {
  verdict: CompPairedFiresVerdict | undefined;
}) {
  if (!verdict) return null;
  const map = {
    fires: { text: "Rule fires", cls: "bg-green-50 text-green-700 border-green-300" },
    doesNotFire: {
      text: "Rule does not fire",
      cls: "bg-red-50 text-red-700 border-red-300",
    },
    incomplete: {
      text: "Incomplete",
      cls: "bg-gray-50 text-gray-600 border-gray-300",
    },
  } as const;
  const { text, cls } = map[verdict];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {text}
    </span>
  );
}

// Task #394: the per-card "Test opp id" field shown inside each opportunity card
// of a paired rule. Read-only diagnostic — never gated by edit permission. The
// pasted id is pinned to this card's role. `diag` is this card's slice of the
// shared diagnosis (drives "Opp not found"); loading / error render only on the
// card that triggered the in-flight call.
function OppCardTesterField({
  value,
  diag,
  loading,
  error,
  onChange,
}: {
  value: string;
  diag: CompPairedOppDiagnosis | undefined;
  loading: boolean;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const trimmed = value.trim();
  const notFound = !!trimmed && !loading && !error && diag?.found === false;
  return (
    <div className="flex flex-col gap-1 w-[190px]">
      <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
        Test opp id
      </label>
      <Input
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-8 text-[12px]"
        placeholder="Paste opp id…"
      />
      {loading && trimmed && (
        <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> Testing…
        </span>
      )}
      {notFound && <span className="text-[10px] text-amber-700">Opp not found</span>}
      {error && <span className="text-[10px] text-red-600">{error}</span>}
    </div>
  );
}

// ─── Rule-affected export ────────────────────────────────────────────────────
// Shape returned by GET /sales/compensation/rule-affected. Declared locally
// (rather than via the generated client) to mirror the raw-fetch convention the
// rest of this tab already uses for the compensation endpoints.
interface RuleAffectedLineItem {
  product: string;
  rawProduct: string;
  type: string;
  rawMrr: number;
  compensableMrr: number;
  multiplier: number;
  ruleNames: string[];
  ruleIds: string[];
  matched: boolean;
  rawCells: string[];
}
interface RuleAffectedOpp {
  oppId: string;
  accountId: string;
  accountName: string;
  oppName: string;
  manager: string;
  rep: string;
  salesRole: string;
  group: string;
  segment: string;
  closeDate: string;
  quoteType: string;
  stage: string;
  product: string;
  amount: number;
  rawMrr: number;
  compensableMrr: number;
  lineItems: RuleAffectedLineItem[];
}
interface RuleAffectedExport {
  month: string;
  config: CompensationConfig;
  rawHeaders: string[];
  opportunities: RuleAffectedOpp[];
}

const FIELD_LABEL: Record<string, string> = {
  product: "Product",
  rawProduct: "Raw Product",
  productFamily: "Product Family",
  type: "Type",
  termLength: "Term Length",
  legacyFlag: "Legacy Flag",
  group: "Channel",
  segment: "Segment",
  salesRole: "Sales Role",
  quoteType: "Quote Type",
  oppName: "Opportunity Name",
  funnelStage: "Funnel Stage",
  changeInMrr: "Change in MRR",
  splitTotalPrice: "Split Total Price",
  flexFlipAgentStatus: "Flex Flip Agent Status",
  fub_first_purchase_date: "FUB First Purchase Date",
};
const OP_PHRASE: Record<string, string> = {
  eq: "is",
  ne: "is not",
  in: "is one of",
  notIn: "is not one of",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "contains",
  notContains: "does not contain",
};

function conditionText(cond: CompCondition): string {
  const field = FIELD_LABEL[cond.field] ?? cond.field;
  const op = OP_PHRASE[cond.op] ?? cond.op;
  let val: string;
  if (Array.isArray(cond.value)) val = cond.value.join(", ");
  else if (typeof cond.value === "boolean") val = cond.value ? "true" : "false";
  else val = String(cond.value ?? "");
  return `${field} ${op} ${val}`;
}

function multiplierRuleText(rule: CompMultiplierRule): string {
  const conds = rule.conditions.length
    ? rule.conditions.map(conditionText).join(" AND ")
    : "(no conditions — never matches)";
  return `${rule.label}: multiply compensable MRR by ${rule.multiplier}× when ${conds}.`;
}

// Human label for a feeder MRR field code (null when unset).
function pairedMrrFieldLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return MRR_FIELD_FALLBACK.find(o => o.value === code)?.label ?? code;
}

// "comparison opp" or "comparison opp.field" when a comparison feeder column is
// chosen — used in the plain-language adjustment description.
function comparisonText(a: CompAdjustment): string {
  const opp = a.comparisonOpp ?? "?";
  return a.comparisonField ? `${opp}.${a.comparisonField}` : opp;
}

// Plain-language description of a single adjustment for the rule summary +
// CSV/XLSX export.
function adjustmentText(a: CompAdjustment): string {
  let math: string;
  switch (a.op) {
    case "waive":
      math = "set compensable MRR to 0";
      break;
    case "keep":
      math = "keep compensable MRR unchanged";
      break;
    case "fixedCredit":
      math = `set compensable MRR to ${a.amount ?? 0} (sign-preserving)`;
      break;
    case "capAt":
      math = `cap compensable MRR at ${a.amount ?? 0}`;
      break;
    case "incremental":
      math = `set compensable MRR to |${a.targetOpp}| − |${comparisonText(a)}|`;
      break;
    case "greaterOfFloorOrIncremental":
      math = `set compensable MRR to max(${a.amount ?? 0}, |${a.targetOpp}| − |${comparisonText(a)}|)`;
      break;
    case "multiplyByFactor":
      math = `multiply compensable MRR by ${a.amount ?? 0}`;
      break;
    case "reassignMrrField":
      math = `set compensable MRR to the ${pairedMrrFieldLabel(a.mrrField) ?? a.mrrField} column`;
      break;
    default:
      math = String(a.op);
  }
  const reassign = a.reassignOwnerToOpp
    ? `, and reassign the owner to "${a.reassignOwnerToOpp}" (gated to eligible roles)`
    : "";
  return `on "${a.targetOpp}", ${math}${reassign}`;
}

// Plain-language description of one named-opp condition. Identity comparatives
// are value-joins (this opp's field = another opp's field); numeric comparatives
// compare aggregate magnitudes; field tests are simple per-row filters.
function pairedConditionText(c: CompPairedCondition): string {
  if (c.kind === "comparative") {
    if (IDENTITY_FIELD_VALUES.has(c.field as string)) {
      const gran = isCompDateField(c.field)
        ? ` (${c.dateGranularity ?? "month"})`
        : "";
      const opTxt =
        COMPARATIVE_OP_OPTIONS.find(o => o.value === c.op)?.label ?? "=";
      return `${c.field}${gran} ${opTxt} ${c.compareToField} of "${c.compareToOpp}"`;
    }
    const opTxt = COMPARATIVE_OP_OPTIONS.find(o => o.value === c.op)?.label ?? c.op;
    // Task #420 — formula mode: render each side as its ordered logic terms.
    if (hasFormulaTerms(c)) {
      return `${formulaSideText(c.leftTerms)} ${opTxt} ${formulaSideText(c.rightTerms)}`;
    }
    const { left: leftSigned, right: rightSigned } = resolveSidedSigned(c);
    const sym = (op: string | null | undefined) =>
      FACTOR_OP_OPTIONS.find(o => o.value === (op ?? "multiply"))?.label ?? "×";
    const leftSym = sym(c.leftFactorOp);
    const leftScalar = typeof c.leftFactor === "number" ? c.leftFactor : 1;
    const rightSym = sym(c.rightFactorOp ?? c.factorOp);
    const rightScalar =
      typeof c.rightFactor === "number"
        ? c.rightFactor
        : typeof c.factor === "number"
          ? c.factor
          : 1;
    const leftCore = `Σ ${c.field} ${leftSym} ${leftScalar}`;
    const leftStr = leftSigned ? `(${leftCore})` : `|${leftCore}|`;
    const rightCore = `Σ ${c.compareToField} of "${c.compareToOpp}" ${rightSym} ${rightScalar}`;
    const rightStr = rightSigned ? `(${rightCore})` : `|${rightCore}|`;
    return `${leftStr} ${opTxt} ${rightStr}`;
  }
  return conditionText({ field: c.field, op: c.op, value: c.value } as CompCondition);
}

function pairedRuleText(rule: PairedOppRule): string {
  if (!rule.enabled) return `${rule.label}: disabled for this month.`;
  const oppsDesc = rule.opps
    .map(o => {
      const conds = o.conditions.length
        ? o.conditions.map(pairedConditionText).join(" AND ")
        : "(any)";
      return `${o.mode === "exclude" ? "NO" : "a"} "${o.name}" opp (${conds})`;
    })
    .join(", ");
  const adj = rule.adjustments.length
    ? rule.adjustments.map(adjustmentText).join("; ")
    : "(no adjustments)";
  return `${rule.label}: require ${oppsDesc}, then ${adj}.`;
}

function ruleDescriptions(config: CompensationConfig): string[] {
  const lines = config.multiplierRules.map(multiplierRuleText);
  for (const rule of config.pairedOppRules) lines.push(pairedRuleText(rule));
  return lines;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// Left-hand columns: standard drilldown columns + compensation columns. Opp
// totals are labeled "(opp total)" AND populated only on each opportunity's
// first line-item row so repeated totals can never be double-counted (Option C).
const EXPORT_LEFT_HEADERS = [
  "Account",
  "Opportunity",
  "Opportunity ID",
  "Manager",
  "Owner / Rep",
  "Channel",
  "Segment",
  "Close Date",
  "Quote Type",
  "Product",
  "Stage",
  "Amount (opp total)",
  "MRR (opp total)",
  "Compensable MRR (opp total)",
  "Line Item Product",
  "Line Item MRR",
  "Line Item Compensable MRR",
  "Effective Multiplier",
  "Applied Rule(s)",
  "Rule Match?",
] as const;

type Cell = string | number | null;

function buildExportMatrix(data: RuleAffectedExport): {
  headers: string[];
  rows: Cell[][];
} {
  const rawHeaders = data.rawHeaders;
  const headers = [
    ...EXPORT_LEFT_HEADERS,
    ...rawHeaders.map((h) => `Raw: ${h}`),
  ];
  const rows: Cell[][] = [];
  for (const opp of data.opportunities) {
    opp.lineItems.forEach((li, idx) => {
      const first = idx === 0;
      const row: Cell[] = [
        opp.accountName,
        opp.oppName,
        opp.oppId,
        opp.manager,
        opp.rep,
        opp.group,
        opp.segment,
        opp.closeDate,
        opp.quoteType,
        displayProduct(opp.product),
        opp.stage,
        first ? round2(opp.amount) : null,
        first ? round2(opp.rawMrr) : null,
        first ? round2(opp.compensableMrr) : null,
        displayProduct(li.product),
        round2(li.rawMrr),
        round2(li.compensableMrr),
        round2(li.multiplier),
        displayProductText(li.ruleNames.join("; ")),
        li.matched ? "Yes" : "No",
      ];
      for (let j = 0; j < rawHeaders.length; j++) {
        row.push(displayProductText(String(li.rawCells[j] ?? "")));
      }
      rows.push(row);
    });
  }
  return { headers, rows };
}

async function fetchRuleAffected(month: string): Promise<RuleAffectedExport> {
  const res = await fetch(
    `/api/sales/compensation/rule-affected?month=${encodeURIComponent(month)}`,
    { headers: buildHeaders(false), credentials: "include" },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(txt || `Failed to load export data (${res.status})`);
  }
  return (await res.json()) as RuleAffectedExport;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvCell(v: Cell): string {
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(data: RuleAffectedExport, monthText: string): void {
  const { headers, rows } = buildExportMatrix(data);
  const lines: string[] = [];
  lines.push(`# Compensation Rule-Affected Opportunities`);
  lines.push(`# Month,${csvCell(monthText)}`);
  lines.push(`# Exported,${csvCell(new Date().toLocaleString())}`);
  lines.push(`# Matching opportunities,${data.opportunities.length}`);
  lines.push(`#`);
  lines.push(`# Rules applied:`);
  for (const desc of ruleDescriptions(data.config)) {
    lines.push(`# ${csvCell(displayProductText(desc)).replace(/^"|"$/g, "")}`);
  }
  // Blank separator row, then the column header row and data rows.
  lines.push("");
  lines.push(headers.map(csvCell).join(","));
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  triggerDownload(blob, `compensation-rule-affected-${data.month}.csv`);
}

async function exportXlsx(
  data: RuleAffectedExport,
  monthText: string,
): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const { headers, rows } = buildExportMatrix(data);
  const wb = new ExcelJS.Workbook();

  // Opportunities tab — pure table (header row + data) so it filters/sorts
  // cleanly. Header bold + frozen.
  const ws = wb.addWorksheet("Opportunities");
  const headerRow = ws.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle", wrapText: true };
  for (const row of rows) ws.addRow(row);
  ws.views = [{ state: "frozen", ySplit: 1 }];

  // Rules tab — plain-language descriptions of every applied rule.
  const rulesWs = wb.addWorksheet("Rules");
  const titleRow = rulesWs.addRow(["Compensation Rules Applied"]);
  titleRow.font = { bold: true, size: 13 };
  rulesWs.addRow(["Month", monthText]);
  rulesWs.addRow(["Exported", new Date().toLocaleString()]);
  rulesWs.addRow(["Matching opportunities", data.opportunities.length]);
  rulesWs.addRow([]);
  const ruleHeader = rulesWs.addRow(["Rule"]);
  ruleHeader.font = { bold: true };
  for (const desc of ruleDescriptions(data.config)) {
    const r = rulesWs.addRow([displayProductText(desc)]);
    r.alignment = { wrapText: true, vertical: "top" };
  }
  rulesWs.getColumn(1).width = 120;
  rulesWs.getColumn(2).width = 28;

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  triggerDownload(blob, `compensation-rule-affected-${data.month}.xlsx`);
}

type SaveState = "idle" | "saving" | "saved" | "error";

export default function CompensationView({ authUser }: CompensationViewProps) {
  const monthOptions = useMemo(() => buildMonthOptions(), []);
  const [month, setMonth] = useState<string>(() => monthKey(getTodayPST()));

  const role = authUser?.role ?? null;
  const viewOnly = authUser?.viewOnly === true;
  const canEdit =
    !viewOnly && (role === "admin" || role === "slm" || role === "exec");

  const configQuery = useQuery({
    queryKey: ["compensation-config", month],
    queryFn: () => fetchConfig(month),
  });
  const salesConfigQuery = useGetSalesConfig();

  // Task #276/#314: MRR-source-field options for the per-rule picker. The server
  // is the source of truth via /sales/config `mrrFields`; fall back to a local
  // list only if it's missing so the picker always renders.
  const mrrFieldOptions = salesConfigQuery.data?.mrrFields ?? MRR_FIELD_FALLBACK;

  // Task #314: the options split by upstream source so each rule's picker only
  // offers columns from its own source. The server ships `mrrFieldSources`;
  // fall back to the CPD-code set so the split works offline.
  const mrrFieldSources = salesConfigQuery.data?.mrrFieldSources;
  const feederMrrOptions = mrrFieldSources
    ? mrrFieldOptions.filter(o => mrrFieldSources.feeder.includes(o.value))
    : mrrFieldOptions.filter(o => !CPD_MRR_FIELD_CODES.has(o.value));
  const cpdMrrOptions = mrrFieldSources
    ? mrrFieldOptions.filter(o => mrrFieldSources.cpd.includes(o.value))
    : mrrFieldOptions.filter(o => CPD_MRR_FIELD_CODES.has(o.value));

  // Task #314: CPD-sourced product/type values (lowercased), config-driven with
  // a static fallback. Used to classify a rule's source and to scope both the
  // MRR picker and the condition value suggestions.
  const cpdValuesSet = useMemo(
    () =>
      new Set(
        (salesConfigQuery.data?.cpdSourcedValues ?? [...CPD_SOURCED_VALUES]).map(v =>
          v.toLowerCase(),
        ),
      ),
    [salesConfigQuery.data],
  );

  // Task #276/#314: map an MrrField code (or in-progress free text) to its
  // display label within a given option set. Unknown values echo back so the
  // combobox can show partially typed text; the server rejects unknown fields.
  const labelForMrrField = (
    opts: { value: string; label: string }[],
    code: string,
  ): string => opts.find(o => o.value === code)?.label ?? code;

  // Resolve typed combobox text to a valid MrrField code within an option set
  // (case-insensitive, matching either label or code). Null when unresolved.
  const resolveMrrFieldText = (
    opts: { value: string; label: string }[],
    text: string,
  ): string | null => {
    const lc = text.trim().toLowerCase();
    if (!lc) return null;
    const byLabel = opts.find(o => o.label.toLowerCase() === lc);
    if (byLabel) return byLabel.value;
    const byValue = opts.find(o => o.value.toLowerCase() === lc);
    return byValue ? byValue.value : null;
  };

  // Task #276: while a Base MRR combobox is focused, mirror exactly what the
  // user typed (including empty) so clearing the field doesn't instantly refill
  // with the auto-detected default. Only one picker is focused at a time.
  const [mrrEdit, setMrrEdit] = useState<{ id: string; text: string } | null>(null);

  const [draft, setDraft] = useState<CompensationConfig | null>(null);
  const [baseline, setBaseline] = useState<CompensationConfig | null>(null);

  // Task #375: per-rule opp-id condition tester, keyed by rule id. `oppId` is the
  // pasted text; `result` is the latest diagnostic (null while none/loading).
  const [oppTests, setOppTests] = useState<
    Record<
      string,
      {
        oppId: string;
        result: CompTestOppResult | null;
        loading: boolean;
        error: string | null;
      }
    >
  >({});
  // Debounce timers + a ref mirror of oppTests so the re-run effect can read the
  // latest active tests without re-subscribing (avoids an update loop).
  const oppTestTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const oppTestsRef = useRef(oppTests);
  useEffect(() => {
    oppTestsRef.current = oppTests;
  }, [oppTests]);

  // Task #394: per-paired-rule tester keyed by rule id. Each card pins its own
  // pasted opp id; a single debounced call returns the whole diagnosis.
  const [pairedTests, setPairedTests] = useState<Record<string, PairedTestState>>({});
  const pairedTestTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pairedTestsRef = useRef(pairedTests);
  useEffect(() => {
    pairedTestsRef.current = pairedTests;
  }, [pairedTests]);

  // Schedule (debounced) a paired-rule test from the current per-card opp ids.
  const schedulePairedTest = useCallback(
    (ruleId: string, rule: PairedOppRule, oppIds: string[]) => {
      if (pairedTestTimers.current[ruleId])
        clearTimeout(pairedTestTimers.current[ruleId]);
      // Nothing pinned → clear any prior result (badge hides) and skip the call.
      if (!oppIds.some((id) => id.trim() !== "")) {
        setPairedTests((prev) =>
          prev[ruleId]
            ? {
                ...prev,
                [ruleId]: {
                  ...prev[ruleId],
                  result: null,
                  loading: false,
                  error: null,
                },
              }
            : prev,
        );
        return;
      }
      const snapshot = oppIds.join("\u0000");
      pairedTestTimers.current[ruleId] = setTimeout(() => {
        void (async () => {
          try {
            const result = await fetchTestOppPaired(oppIds, rule);
            setPairedTests((prev) => {
              const cur = prev[ruleId];
              if (!cur || cur.oppIds.join("\u0000") !== snapshot) return prev; // stale
              return { ...prev, [ruleId]: { ...cur, result, loading: false, error: null } };
            });
          } catch (e) {
            setPairedTests((prev) => {
              const cur = prev[ruleId];
              if (!cur || cur.oppIds.join("\u0000") !== snapshot) return prev; // stale
              return {
                ...prev,
                [ruleId]: {
                  ...cur,
                  loading: false,
                  error: e instanceof Error ? e.message : "Failed to test opp",
                },
              };
            });
          }
        })();
      }, 400);
    },
    [],
  );

  // Update one card's pasted opp id and (re)run or reset the rule's test.
  const setPairedOppTestId = useCallback(
    (ruleId: string, rule: PairedOppRule, oppIdx: number, value: string) => {
      const next = (() => {
        const cur = pairedTestsRef.current[ruleId];
        const base = cur?.oppIds ? cur.oppIds.slice() : [];
        while (base.length < rule.opps.length) base.push("");
        base[oppIdx] = value;
        return base;
      })();
      const anyPinned = next.some((id) => id.trim() !== "");
      setPairedTests((prev) => ({
        ...prev,
        [ruleId]: {
          oppIds: next,
          // Keep the prior diagnosis visible while a new lookup is in flight;
          // clear entirely once every card is emptied.
          result: anyPinned ? (prev[ruleId]?.result ?? null) : null,
          loading: anyPinned,
          error: null,
          editingIdx: oppIdx,
        },
      }));
      schedulePairedTest(ruleId, rule, next);
    },
    [schedulePairedTest],
  );

  // Schedule (debounced) a condition test for one rule against a pasted opp id.
  const scheduleOppTest = useCallback(
    (
      ruleId: string,
      kind: "multiplier" | "paired",
      rule: CompMultiplierRule | PairedOppRule,
      oppId: string,
    ) => {
      const id = oppId.trim();
      if (oppTestTimers.current[ruleId]) clearTimeout(oppTestTimers.current[ruleId]);
      if (!id) return;
      oppTestTimers.current[ruleId] = setTimeout(() => {
        void (async () => {
          try {
            const result = await fetchTestOpp(id, kind, rule);
            setOppTests((prev) => {
              if ((prev[ruleId]?.oppId ?? "").trim() !== id) return prev; // stale
              return {
                ...prev,
                [ruleId]: { oppId: prev[ruleId].oppId, result, loading: false, error: null },
              };
            });
          } catch (e) {
            setOppTests((prev) => {
              if ((prev[ruleId]?.oppId ?? "").trim() !== id) return prev; // stale
              return {
                ...prev,
                [ruleId]: {
                  oppId: prev[ruleId].oppId,
                  result: null,
                  loading: false,
                  error: e instanceof Error ? e.message : "Failed to test opp",
                },
              };
            });
          }
        })();
      }, 400);
    },
    [],
  );

  // Update a rule's opp-id input and (re)run or reset its test.
  const setOppTestId = useCallback(
    (
      ruleId: string,
      kind: "multiplier" | "paired",
      rule: CompMultiplierRule | PairedOppRule,
      oppId: string,
    ) => {
      const id = oppId.trim();
      setOppTests((prev) => ({
        ...prev,
        [ruleId]: {
          oppId,
          // Keep the prior result visible while a new lookup is in flight; clear
          // entirely when the field is emptied.
          result: id ? (prev[ruleId]?.result ?? null) : null,
          loading: id.length > 0,
          error: null,
        },
      }));
      scheduleOppTest(ruleId, kind, rule, oppId);
    },
    [scheduleOppTest],
  );

  const [saveState, setSaveState] = useState<SaveState>("idle");
  // Re-run any active opp test when its rule definition changes, so highlighting
  // tracks unsaved edits. Reads the active tests via a ref to avoid a loop.
  useEffect(() => {
    if (!draft) return;
    const active = oppTestsRef.current;
    for (const rule of draft.multiplierRules) {
      const t = active[rule.id];
      if (t && t.oppId.trim()) scheduleOppTest(rule.id, "multiplier", rule, t.oppId);
    }
    // Task #394: paired rules re-run their per-card pinned ids on edit.
    const activePaired = pairedTestsRef.current;
    for (const rule of draft.pairedOppRules) {
      const t = activePaired[rule.id];
      if (t && t.oppIds.some((id) => id.trim() !== ""))
        schedulePairedTest(rule.id, rule, t.oppIds);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, scheduleOppTest, schedulePairedTest]);

  const [saveError, setSaveError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<null | "csv" | "xlsx">(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [showDrilldown, setShowDrilldown] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  // Task #366: editor-chosen source month for "copy rules". null = use the
  // default (immediately previous month when it's in range).
  const [copySource, setCopySource] = useState<string | null>(null);
  // The source month can be any month in the picker range except the current
  // target month itself.
  const copySourceOptions = useMemo(
    () => monthOptions.filter(m => m !== month),
    [monthOptions, month],
  );
  // Resolve the selected source: keep the editor's pick when it's still valid,
  // otherwise default to the immediately previous month (or the first option).
  const effectiveCopySource = useMemo(() => {
    if (copySource && copySourceOptions.includes(copySource)) return copySource;
    const prev = prevMonthKey(month);
    if (copySourceOptions.includes(prev)) return prev;
    return copySourceOptions[0] ?? null;
  }, [copySource, copySourceOptions, month]);

  // Scope the rule-affected drilldown to the selected comp month. We build a
  // full-calendar-month custom range so the closed-won opp fetch aligns with
  // the comp-month set used by the rule-affected export; team/product filters
  // are left empty so the popup is org-wide like the export.
  const drilldownFilters = useMemo<FilterState>(() => {
    const [y, m] = month.split("-").map(Number);
    return {
      timeframe: "custom",
      customRange: { from: new Date(y, m - 1, 1), to: new Date(y, m, 0) },
      segment: [],
      region: [],
      group: "All Channels",
      slm: [],
      flm: [],
      rep: [],
      products: [],
      aggregateBy: "Rep",
    };
  }, [month]);

  const handleExport = async (format: "csv" | "xlsx") => {
    setExporting(format);
    setExportError(null);
    try {
      const data = await fetchRuleAffected(month);
      const label = monthLabel(month);
      if (format === "csv") exportCsv(data, label);
      else await exportXlsx(data, label);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(null);
    }
  };

  // Reset the editable draft whenever a different month's config loads. This
  // is what guarantees switching months never bleeds edits across months.
  useEffect(() => {
    if (configQuery.data) {
      setDraft(clone(configQuery.data));
      setBaseline(clone(configQuery.data));
      setSaveState("idle");
      setSaveError(null);
      setCopyMsg(null);
    }
  }, [configQuery.data]);

  const dirty = useMemo(() => {
    if (!draft || !baseline) return false;
    return (
      JSON.stringify({ m: draft.multiplierRules, p: draft.pairedOppRules }) !==
      JSON.stringify({ m: baseline.multiplierRules, p: baseline.pairedOppRules })
    );
  }, [draft, baseline]);

  const suggestionsFor = (field: ConditionField): string[] => {
    const cfg = salesConfigQuery.data;
    if (!cfg) return [];
    if (field === "product" || field === "rawProduct" || field === "productFamily")
      return cfg.products ?? [];
    if (field === "group") return cfg.groups ?? [];
    if (field === "segment") return cfg.segments ?? [];
    if (field === "type") return cfg.types ?? [];
    if (field === "salesRole") return cfg.salesRoles ?? [];
    if (field === "quoteType") return cfg.quoteTypes ?? [];
    return [];
  };

  // ---- draft mutation helpers -------------------------------------------
  const updateRule = (idx: number, patch: Partial<CompMultiplierRule>) => {
    setDraft(prev => {
      if (!prev) return prev;
      const rules = prev.multiplierRules.slice();
      rules[idx] = { ...rules[idx], ...patch };
      return { ...prev, multiplierRules: rules };
    });
  };

  const updateCondition = (
    ruleIdx: number,
    condIdx: number,
    patch: Partial<CompCondition>,
  ) => {
    setDraft(prev => {
      if (!prev) return prev;
      const rules = prev.multiplierRules.slice();
      const conditions = rules[ruleIdx].conditions.slice();
      conditions[condIdx] = { ...conditions[condIdx], ...patch };
      rules[ruleIdx] = { ...rules[ruleIdx], conditions };
      return { ...prev, multiplierRules: rules };
    });
  };

  const onFieldChange = (ruleIdx: number, condIdx: number, field: ConditionField) => {
    // Legacy Flag is boolean-valued; everything else is string-valued.
    const value = field === "legacyFlag" ? false : "";
    updateCondition(ruleIdx, condIdx, { field, value });
  };

  const onOpChange = (ruleIdx: number, condIdx: number, op: ConditionOp) => {
    setDraft(prev => {
      if (!prev) return prev;
      const rules = prev.multiplierRules.slice();
      const conditions = rules[ruleIdx].conditions.slice();
      const cur = conditions[condIdx];
      let value = cur.value;
      const toList = op === "in" || op === "notIn";
      const wasList = Array.isArray(cur.value);
      if (toList && !wasList) {
        value = cur.value === "" || cur.value == null ? [] : [String(cur.value)];
      } else if (!toList && wasList) {
        const arr = cur.value as string[];
        value = arr.length ? String(arr[0]) : "";
      }
      conditions[condIdx] = { ...cur, op, value };
      rules[ruleIdx] = { ...rules[ruleIdx], conditions };
      return { ...prev, multiplierRules: rules };
    });
  };

  const addCondition = (ruleIdx: number) => {
    setDraft(prev => {
      if (!prev) return prev;
      const rules = prev.multiplierRules.slice();
      rules[ruleIdx] = {
        ...rules[ruleIdx],
        conditions: [
          ...rules[ruleIdx].conditions,
          { field: "product", op: "eq", value: "" },
        ],
      };
      return { ...prev, multiplierRules: rules };
    });
  };

  const removeCondition = (ruleIdx: number, condIdx: number) => {
    setDraft(prev => {
      if (!prev) return prev;
      const rules = prev.multiplierRules.slice();
      rules[ruleIdx] = {
        ...rules[ruleIdx],
        conditions: rules[ruleIdx].conditions.filter((_, i) => i !== condIdx),
      };
      return { ...prev, multiplierRules: rules };
    });
  };

  const addRule = () => {
    setDraft(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        multiplierRules: [
          ...prev.multiplierRules,
          {
            id: genId(),
            label: "New rule",
            conditions: [{ field: "product", op: "eq", value: "" }],
            multiplier: 1,
          },
        ],
      };
    });
  };

  const removeRule = (idx: number) => {
    setDraft(prev =>
      prev
        ? { ...prev, multiplierRules: prev.multiplierRules.filter((_, i) => i !== idx) }
        : prev,
    );
  };

  // ---- paired-opp rule mutation helpers ---------------------------------
  const addPairedRule = () => {
    setDraft(prev =>
      prev
        ? {
            ...prev,
            pairedOppRules: [
              ...prev.pairedOppRules,
              {
                id: genId(),
                label: "New paired-opp rule",
                enabled: true,
                opps: [
                  {
                    name: "Opp A",
                    mode: "match",
                    conditions: [{ kind: "field", field: "product", op: "eq", value: "" }],
                  },
                ],
                adjustments: [],
              },
            ],
          }
        : prev,
    );
  };

  const updatePairedRule = (idx: number, patch: Partial<PairedOppRule>) => {
    setDraft(prev => {
      if (!prev) return prev;
      const rules = prev.pairedOppRules.slice();
      rules[idx] = { ...rules[idx], ...patch };
      return { ...prev, pairedOppRules: rules };
    });
  };

  const removePairedRule = (idx: number) => {
    setDraft(prev =>
      prev
        ? { ...prev, pairedOppRules: prev.pairedOppRules.filter((_, i) => i !== idx) }
        : prev,
    );
  };

  const copyPairedRule = (idx: number) => {
    setDraft(prev => {
      if (!prev) return prev;
      const original = prev.pairedOppRules[idx];
      if (!original) return prev;
      const clone: PairedOppRule = structuredClone(original);
      clone.id = genId();
      const baseName = original.label.replace(/ copy \d+$/, "");
      const existingNames = new Set(prev.pairedOppRules.map(r => r.label));
      let n = 1;
      while (existingNames.has(`${baseName} copy ${n}`)) n += 1;
      clone.label = `${baseName} copy ${n}`;
      const rules = prev.pairedOppRules.slice();
      rules.splice(idx + 1, 0, clone);
      return { ...prev, pairedOppRules: rules };
    });
  };

  // ---- named opps -------------------------------------------------------
  const mutateOpps = (
    ruleIdx: number,
    fn: (list: CompNamedOpp[]) => CompNamedOpp[],
  ) => {
    setDraft(prev => {
      if (!prev) return prev;
      const rules = prev.pairedOppRules.slice();
      rules[ruleIdx] = { ...rules[ruleIdx], opps: fn(rules[ruleIdx].opps.slice()) };
      return { ...prev, pairedOppRules: rules };
    });
  };

  const addOpp = (ruleIdx: number) =>
    mutateOpps(ruleIdx, list => {
      // The first opp is the anchor; every later opp needs ≥1 identity "=" link
      // to an earlier opp, so seed one against the anchor (Account ID) by default.
      const anchorName = list[0]?.name?.trim() ?? "";
      const conditions: CompPairedCondition[] =
        list.length > 0 && anchorName
          ? [
              {
                kind: "comparative",
                field: "accountId",
                op: "eq",
                compareToOpp: anchorName,
                compareToField: "accountId",
              },
            ]
          : [];
      return [
        ...list,
        {
          name: `Opp ${String.fromCharCode(65 + list.length)}`,
          mode: "match",
          conditions,
        },
      ];
    });

  const updateOpp = (ruleIdx: number, oppIdx: number, patch: Partial<CompNamedOpp>) =>
    mutateOpps(ruleIdx, list => {
      list[oppIdx] = { ...list[oppIdx], ...patch };
      return list;
    });

  const removeOpp = (ruleIdx: number, oppIdx: number) =>
    mutateOpps(ruleIdx, list => list.filter((_, i) => i !== oppIdx));

  // ---- conditions inside a named opp ------------------------------------
  const mutateOppConds = (
    ruleIdx: number,
    oppIdx: number,
    fn: (list: CompPairedCondition[]) => CompPairedCondition[],
  ) =>
    mutateOpps(ruleIdx, list => {
      list[oppIdx] = { ...list[oppIdx], conditions: fn(list[oppIdx].conditions.slice()) };
      return list;
    });

  const addOppCondition = (ruleIdx: number, oppIdx: number) =>
    mutateOppConds(ruleIdx, oppIdx, list => [
      ...list,
      { kind: "field", field: "product", op: "eq", value: "" },
    ]);

  const removeOppCondition = (ruleIdx: number, oppIdx: number, condIdx: number) =>
    mutateOppConds(ruleIdx, oppIdx, list => list.filter((_, i) => i !== condIdx));

  const updateOppCondition = (
    ruleIdx: number,
    oppIdx: number,
    condIdx: number,
    patch: Partial<CompPairedCondition>,
  ) =>
    mutateOppConds(ruleIdx, oppIdx, list => {
      list[condIdx] = { ...list[condIdx], ...patch } as CompPairedCondition;
      return list;
    });

  // ---- adjustments ------------------------------------------------------
  const mutateAdjustments = (
    ruleIdx: number,
    fn: (list: CompAdjustment[]) => CompAdjustment[],
  ) => {
    setDraft(prev => {
      if (!prev) return prev;
      const rules = prev.pairedOppRules.slice();
      rules[ruleIdx] = {
        ...rules[ruleIdx],
        adjustments: fn(rules[ruleIdx].adjustments.slice()),
      };
      return { ...prev, pairedOppRules: rules };
    });
  };

  const addAdjustment = (ruleIdx: number) =>
    setDraft(prev => {
      if (!prev) return prev;
      const rules = prev.pairedOppRules.slice();
      const firstMatch =
        rules[ruleIdx].opps.find(o => o.mode === "match")?.name ?? "";
      rules[ruleIdx] = {
        ...rules[ruleIdx],
        adjustments: [
          ...rules[ruleIdx].adjustments,
          { targetOpp: firstMatch, op: "keep" },
        ],
      };
      return { ...prev, pairedOppRules: rules };
    });

  const updateAdjustment = (
    ruleIdx: number,
    adjIdx: number,
    patch: Partial<CompAdjustment>,
  ) =>
    mutateAdjustments(ruleIdx, list => {
      list[adjIdx] = { ...list[adjIdx], ...patch };
      return list;
    });

  const removeAdjustment = (ruleIdx: number, adjIdx: number) =>
    mutateAdjustments(ruleIdx, list => list.filter((_, i) => i !== adjIdx));

  const discard = () => {
    if (baseline) setDraft(clone(baseline));
    setSaveState("idle");
    setSaveError(null);
  };

  // Task #356/#366: pull a chosen source month's saved multiplier + paired-opp
  // rules into the current draft so editors don't re-create a near-identical
  // rule set by hand each month. The editor picks any source month from the
  // month-picker range (excluding the current target). The copy lands in the
  // draft (marking it dirty) — the user still reviews + Saves.
  const copyFromMonth = async (source: string) => {
    if (!draft || !canEdit || copying || !source || source === month) return;
    setCopying(true);
    setCopyMsg(null);
    try {
      const sourceConfig = await fetchConfig(source);
      // A month with no saved row returns the reference defaults (isDefault).
      // There's nothing the editor actually authored to copy, so leave the
      // current draft untouched and say so.
      if (sourceConfig.isDefault) {
        setCopyMsg(`${monthLabel(source)} has no saved rules to copy.`);
        return;
      }
      const hasCurrent =
        draft.multiplierRules.length > 0 || draft.pairedOppRules.length > 0;
      if (hasCurrent) {
        const ok = window.confirm(
          `Replace ${monthLabel(month)}'s rules with ${monthLabel(source)}'s rules?\n\n` +
            `This overwrites the current draft (you can still Discard before saving).`,
        );
        if (!ok) return;
      }
      setDraft(cur =>
        cur
          ? {
              ...cur,
              multiplierRules: clone(sourceConfig.multiplierRules),
              pairedOppRules: clone(sourceConfig.pairedOppRules),
            }
          : cur,
      );
      setSaveState("idle");
      setSaveError(null);
      setCopyMsg(`Copied ${monthLabel(source)}'s rules — review and Save.`);
    } catch (e) {
      setCopyMsg(e instanceof Error ? e.message : "Failed to copy rules");
    } finally {
      setCopying(false);
    }
  };

  const save = async () => {
    if (!draft || !canEdit) return;
    setSaveState("saving");
    setSaveError(null);
    try {
      const res = await fetch(
        `/api/sales/compensation/config?month=${encodeURIComponent(month)}`,
        {
          method: "PUT",
          headers: buildHeaders(true),
          credentials: "include",
          body: JSON.stringify({
            multiplierRules: draft.multiplierRules,
            pairedOppRules: draft.pairedOppRules,
          }),
        },
      );
      if (!res.ok) {
        let msg = `Save failed (${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {
          /* ignore */
        }
        setSaveError(msg);
        setSaveState("error");
        return;
      }
      const data = (await res.json()) as { config: CompensationConfig };
      setBaseline(clone(data.config));
      setDraft(clone(data.config));
      setSaveState("saved");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
      setSaveState("error");
    }
  };

  // ---- render -----------------------------------------------------------
  if (configQuery.isLoading || !draft) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground py-8">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading compensation config…
      </div>
    );
  }

  if (configQuery.isError) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-red-600 py-8">
        <AlertCircle className="w-4 h-4" />
        {(configQuery.error as Error)?.message || "Failed to load compensation config."}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar: month selector + save controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-muted-foreground">Month</span>
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger className="h-8 w-[160px] text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {monthOptions.map(m => (
                <SelectItem key={m} value={m} className="text-[12px]">
                  {monthLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {baseline?.isDefault && (
            <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
              Reference defaults
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            {exportError && (
              <span className="text-[11px] text-red-600 inline-flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" /> {exportError}
              </span>
            )}
            <span className="text-[11px] text-muted-foreground hidden sm:inline">
              Export rule-affected opps
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[12px]"
              onClick={() => handleExport("csv")}
              disabled={exporting !== null}
              title="Download every opportunity matching an applied compensation rule (CSV)"
            >
              {exporting === "csv" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
              ) : (
                <Download className="w-3.5 h-3.5 mr-1" />
              )}
              CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[12px]"
              onClick={() => handleExport("xlsx")}
              disabled={exporting !== null}
              title="Download every opportunity matching an applied compensation rule (XLSX)"
            >
              {exporting === "xlsx" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
              ) : (
                <Download className="w-3.5 h-3.5 mr-1" />
              )}
              XLSX
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[12px]"
              onClick={() => setShowDrilldown(true)}
              title="Open the closed-won opportunity drilldown for opps matching an applied compensation rule"
            >
              <Table2 className="w-3.5 h-3.5 mr-1" />
              View Rule-Affected Opps
            </Button>
          </div>
          {canEdit && (
            <div className="flex items-center gap-2">
              {copyMsg && (
                <span className="text-[11px] text-muted-foreground hidden md:inline">
                  {copyMsg}
                </span>
              )}
              <span className="text-[11px] text-muted-foreground hidden lg:inline">
                Copy rules from
              </span>
              <Select
                value={effectiveCopySource ?? undefined}
                onValueChange={setCopySource}
                disabled={
                  copying ||
                  saveState === "saving" ||
                  copySourceOptions.length === 0
                }
              >
                <SelectTrigger className="h-8 w-[150px] text-[12px]">
                  <SelectValue placeholder="Select month" />
                </SelectTrigger>
                <SelectContent>
                  {copySourceOptions.map(m => (
                    <SelectItem key={m} value={m} className="text-[12px]">
                      {monthLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[12px]"
                onClick={() =>
                  effectiveCopySource && copyFromMonth(effectiveCopySource)
                }
                disabled={
                  copying || saveState === "saving" || !effectiveCopySource
                }
                title={
                  effectiveCopySource
                    ? `Copy all rules from ${monthLabel(effectiveCopySource)} into ${monthLabel(month)}'s draft`
                    : "No source month available"
                }
              >
                {copying ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                ) : (
                  <CopyPlus className="w-3.5 h-3.5 mr-1" />
                )}
                Copy
              </Button>
            </div>
          )}
          <SaveStatus
            saveState={saveState}
            saveError={saveError}
            dirty={dirty}
            baseline={baseline}
          />
          {canEdit && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[12px]"
                onClick={discard}
                disabled={!dirty || saveState === "saving"}
              >
                Discard
              </Button>
              <Button
                size="sm"
                className="h-8 text-[12px] bg-[#006AFF] hover:bg-[#005ce6]"
                onClick={save}
                disabled={!dirty || saveState === "saving"}
              >
                {saveState === "saving" ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> Saving…
                  </>
                ) : (
                  "Save changes"
                )}
              </Button>
            </div>
          )}
        </div>
      </div>

      {!canEdit && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground bg-muted/50 border border-border rounded-md px-3 py-2">
          <Lock className="w-3.5 h-3.5" />
          Read-only — you don't have permission to edit compensation rules.
        </div>
      )}

      {/* Multiplier rules */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[13px] font-semibold text-foreground">
              Product Multiplier Rules
            </h3>
            <p className="text-[11px] text-muted-foreground">
              Evaluated top-to-bottom; the first rule whose conditions all match
              sets the compensable multiplier.
            </p>
          </div>
          {canEdit && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[12px]"
              onClick={addRule}
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> Add rule
            </Button>
          )}
        </div>

        {draft.multiplierRules.length === 0 && (
          <div className="text-[12px] text-muted-foreground border border-dashed border-border rounded-md px-3 py-6 text-center">
            No multiplier rules. {canEdit && "Use “Add rule” to create one."}
          </div>
        )}

        {draft.multiplierRules.map((rule, ruleIdx) => {
          // Task #314: a rule's upstream source drives which MRR columns its
          // picker offers and which condition values are suggested, keeping the
          // rule single-source (the server also blocks mixed/cross-source rules).
          const ruleSrc = ruleSourceOf(rule, cpdValuesSet);
          const isCpd = ruleSrc === "cpd";
          const pickerOptions = isCpd ? cpdMrrOptions : feederMrrOptions;
          const pickerDefault = isCpd ? CPD_DEFAULT_MRR_FIELD : autoDetectMrrField(rule);
          const condSuggestions = (field: ConditionField): string[] => {
            const base = suggestionsFor(field);
            if (field !== "product" && field !== "rawProduct" && field !== "type")
              return base;
            if (ruleSrc === "cpd")
              return base.filter(v => cpdValuesSet.has(v.toLowerCase()));
            if (ruleSrc === "feeder")
              return base.filter(v => !cpdValuesSet.has(v.toLowerCase()));
            return base;
          };
          return (
          <Card key={rule.id} className="no-shadow">
            <CardContent className="p-4 flex flex-col gap-3">
              <div className="flex items-start gap-2">
                <div className="flex-1 flex flex-col gap-1">
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Rule name
                  </label>
                  <Input
                    value={rule.label}
                    disabled={!canEdit}
                    onChange={e => updateRule(ruleIdx, { label: e.target.value })}
                    className="h-8 text-[12px]"
                    placeholder="Rule name"
                  />
                </div>
                <OppTesterField
                  test={oppTests[rule.id]}
                  onChange={v => setOppTestId(rule.id, "multiplier", rule, v)}
                />
                <div className="flex flex-col gap-1 w-[110px]">
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Multiplier ×
                  </label>
                  <Input
                    type="number"
                    step="0.05"
                    min="0"
                    max="100"
                    value={rule.multiplier}
                    disabled={!canEdit}
                    onChange={e =>
                      updateRule(ruleIdx, { multiplier: Number(e.target.value) })
                    }
                    className="h-8 text-[12px] tabular-nums"
                  />
                </div>
                <div className="flex flex-col gap-1 w-[130px]">
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Applies in
                  </label>
                  <Select
                    value={rule.appliesIn ?? "quota"}
                    disabled={!canEdit}
                    onValueChange={v =>
                      updateRule(ruleIdx, { appliesIn: v as "quota" | "sales" | "both" })
                    }
                  >
                    <SelectTrigger className="h-8 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="quota">Quota Target</SelectItem>
                      <SelectItem value="sales">Sales Target</SelectItem>
                      <SelectItem value="both">Both</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {canEdit && (
                  <button
                    onClick={() => removeRule(ruleIdx)}
                    className="mt-5 text-muted-foreground hover:text-red-600 transition-colors"
                    title="Remove rule"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className="flex flex-col gap-2 pl-1">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                  Conditions (all must match)
                </label>
                {rule.conditions.length === 0 && (
                  <p className="text-[11px] text-amber-700">
                    No conditions — this rule will never match.
                  </p>
                )}
                {rule.conditions.map((cond, condIdx) => (
                  <ConditionRow
                    key={condIdx}
                    cond={cond}
                    canEdit={canEdit}
                    status={oppTests[rule.id]?.result?.multiplier?.conditions?.[condIdx]}
                    suggestions={condSuggestions(cond.field as ConditionField)}
                    onFieldChange={f => onFieldChange(ruleIdx, condIdx, f)}
                    onOpChange={o => onOpChange(ruleIdx, condIdx, o)}
                    onValueChange={v => updateCondition(ruleIdx, condIdx, { value: v })}
                    onRemove={() => removeCondition(ruleIdx, condIdx)}
                  />
                ))}
                {canEdit && (
                  <button
                    onClick={() => addCondition(ruleIdx)}
                    className="self-start text-[11px] text-[#006AFF] hover:underline inline-flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> Add condition
                  </button>
                )}
              </div>

              {/* Task #276/#314: per-rule base MRR source override, styled like
                  the condition combobox. Type any value; valid numeric columns
                  for the rule's source are suggested. Until customized, the
                  picker shows the auto-detected default (the field the dashboard
                  already uses for the rule's product/type for feeder rules, or
                  `mrr_added` for CPD rules). CPD rules (ZMX / Showcase
                  Incremental - Re/Max) read CPD columns from Databricks; feeder
                  rules read feeder-sheet columns — the two can't be mixed. */}
              <div className="flex flex-col gap-1 pl-1">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                  Base MRR source
                </label>
                <Input
                  value={
                    mrrEdit?.id === rule.id
                      ? mrrEdit.text
                      : labelForMrrField(pickerOptions, rule.mrrField ?? pickerDefault)
                  }
                  disabled={!canEdit}
                  list={`mrr-field-${rule.id}`}
                  placeholder="Base MRR field"
                  onFocus={() =>
                    setMrrEdit({
                      id: rule.id,
                      text: labelForMrrField(pickerOptions, rule.mrrField ?? pickerDefault),
                    })
                  }
                  onBlur={() => setMrrEdit(null)}
                  onChange={e => {
                    const text = e.target.value;
                    setMrrEdit({ id: rule.id, text });
                    const resolved = resolveMrrFieldText(pickerOptions, text);
                    updateRule(ruleIdx, {
                      mrrField: (resolved ??
                        (text.trim() === ""
                          ? undefined
                          : text)) as CompMultiplierRule["mrrField"],
                    });
                  }}
                  className="h-8 text-[12px] w-[240px]"
                />
                <datalist id={`mrr-field-${rule.id}`}>
                  {pickerOptions.map(o => (
                    <option key={o.value} value={o.label} />
                  ))}
                </datalist>
                <p className="text-[11px] text-muted-foreground">
                  {isCpd
                    ? "Which CPD (Databricks) column is the base MRR before the multiplier. Defaults to mrr_added."
                    : "Which feeder-sheet column is the base MRR before the multiplier. Type any valid column; shows the auto-detected default until changed."}
                </p>
              </div>
            </CardContent>
          </Card>
          );
        })}
      </div>

      {/* Task #317: generic cross-opp (paired-opp) rules */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[13px] font-semibold text-foreground">
              Paired-Opp Rules
            </h3>
            <p className="text-[11px] text-muted-foreground">
              {displayProductText(
                "Pair a Side A opp with a Side B opp that share the link field(s) and close month, then adjust compensable MRR (replaces the legacy FUB↔Zpro pairing and cancel/rebook churn-suppression).",
              )}
            </p>
          </div>
          {canEdit && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[12px]"
              onClick={addPairedRule}
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> Add paired rule
            </Button>
          )}
        </div>

        {draft.pairedOppRules.length === 0 && (
          <div className="text-[12px] text-muted-foreground border border-dashed border-border rounded-md px-3 py-6 text-center">
            No paired-opp rules. {canEdit && "Use “Add paired rule” to create one."}
          </div>
        )}

        {draft.pairedOppRules.map((rule, ruleIdx) => (
          <Card key={rule.id} className="no-shadow">
            <CardContent className="p-4 flex flex-col gap-4">
              <div className="flex items-start gap-2">
                <div className="flex-1 flex flex-col gap-1">
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Rule name
                  </label>
                  <Input
                    value={rule.label}
                    disabled={!canEdit}
                    onChange={e => updatePairedRule(ruleIdx, { label: e.target.value })}
                    className="h-8 text-[12px]"
                    placeholder="Rule name"
                  />
                </div>
                <div className="flex flex-col gap-1 items-center self-stretch justify-center">
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Rule result
                  </label>
                  <div className="h-8 flex items-center">
                    <FiresBadge verdict={headerFiresVerdict(pairedTests[rule.id])} />
                  </div>
                </div>
                <div className="flex flex-col gap-1 items-center">
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Enabled
                  </label>
                  <div className="h-8 flex items-center">
                    <Switch
                      checked={rule.enabled}
                      disabled={!canEdit}
                      onCheckedChange={v => updatePairedRule(ruleIdx, { enabled: v })}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1 w-[130px]">
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Applies in
                  </label>
                  <Select
                    value={rule.appliesIn ?? "quota"}
                    disabled={!canEdit}
                    onValueChange={v =>
                      updatePairedRule(ruleIdx, { appliesIn: v as "quota" | "sales" | "both" })
                    }
                  >
                    <SelectTrigger className="h-8 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="quota">Quota Target</SelectItem>
                      <SelectItem value="sales">Sales Target</SelectItem>
                      <SelectItem value="both">Both</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {canEdit && (
                  <button
                    onClick={() => copyPairedRule(ruleIdx)}
                    className="mt-5 text-muted-foreground hover:text-primary transition-colors"
                    title="Copy rule"
                  >
                    <CopyPlus className="w-4 h-4" />
                  </button>
                )}
                {canEdit && (
                  <button
                    onClick={() => removePairedRule(ruleIdx)}
                    className="mt-5 text-muted-foreground hover:text-red-600 transition-colors"
                    title="Remove rule"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Named opportunities */}
              <div className="flex flex-col gap-3 pl-1">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                  Opportunities — the first opp is the anchor; each later opp
                  joins it via an identity (=) comparative. EXISTS opps must be
                  present; DOES NOT EXIST opps must be absent.
                </label>
                {rule.opps.length === 0 && (
                  <p className="text-[11px] text-amber-700">
                    No opps — this rule never fires.
                  </p>
                )}
                {rule.opps.map((opp, oppIdx) => {
                  // Comparatives may target ANY opp in the rule (Match or
                  // Exclude), INCLUDING this opp itself — a same-opp comparative
                  // is a per-row internal field comparison.
                  const compareToOppNames = rule.opps
                    .filter(o => o.name.trim() !== "")
                    .map(o => o.name);
                  return (
                    <div
                      key={oppIdx}
                      className="flex flex-col gap-2 border border-border rounded-md p-3"
                    >
                      <div className="flex items-center gap-2">
                        <Input
                          value={opp.name}
                          disabled={!canEdit}
                          onChange={e => updateOpp(ruleIdx, oppIdx, { name: e.target.value })}
                          className="h-8 text-[12px] w-[200px]"
                          placeholder="Opp name (unique)"
                        />
                        <Select
                          value={opp.mode}
                          disabled={!canEdit}
                          onValueChange={v =>
                            updateOpp(ruleIdx, oppIdx, {
                              mode: v as CompNamedOpp["mode"],
                            })
                          }
                        >
                          <SelectTrigger className="h-8 w-[120px] text-[12px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="match" className="text-[12px]">EXISTS</SelectItem>
                            <SelectItem value="exclude" className="text-[12px]">DOES NOT EXIST</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="ml-auto flex items-start gap-2">
                          <OppCardTesterField
                            value={pairedTests[rule.id]?.oppIds?.[oppIdx] ?? ""}
                            diag={
                              pairedTests[rule.id]?.result?.paired?.opps?.[oppIdx]
                            }
                            loading={
                              !!pairedTests[rule.id]?.loading &&
                              pairedTests[rule.id]?.editingIdx === oppIdx
                            }
                            error={
                              pairedTests[rule.id]?.editingIdx === oppIdx
                                ? pairedTests[rule.id]?.error ?? null
                                : null
                            }
                            onChange={v =>
                              setPairedOppTestId(rule.id, rule, oppIdx, v)
                            }
                          />
                          {canEdit && (
                            <button
                              onClick={() => removeOpp(ruleIdx, oppIdx)}
                              className="mt-5 text-muted-foreground hover:text-red-600 transition-colors"
                              title="Remove opp"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                      {opp.conditions.length === 0 && (
                        <p className="text-[11px] text-amber-700">
                          No conditions — matches any opp in the group.
                        </p>
                      )}
                      {opp.conditions.map((cond, condIdx) => (
                        <PairedConditionRow
                          key={condIdx}
                          cond={cond}
                          canEdit={canEdit}
                          status={
                            pairedTests[rule.id]?.result?.paired?.opps?.[oppIdx]
                              ?.conditions?.[condIdx]
                          }
                          compareToOppNames={compareToOppNames}
                          ownOppName={opp.name}
                          suggestions={
                            cond.kind === "field"
                              ? suggestionsFor(cond.field as ConditionField)
                              : []
                          }
                          onChange={patch =>
                            updateOppCondition(ruleIdx, oppIdx, condIdx, patch)
                          }
                          onRemove={() => removeOppCondition(ruleIdx, oppIdx, condIdx)}
                        />
                      ))}
                      {canEdit && (
                        <button
                          onClick={() => addOppCondition(ruleIdx, oppIdx)}
                          className="self-start text-[11px] text-[#006AFF] hover:underline inline-flex items-center gap-1"
                        >
                          <Plus className="w-3 h-3" /> Add condition
                        </button>
                      )}
                    </div>
                  );
                })}
                {canEdit && (
                  <button
                    onClick={() => addOpp(ruleIdx)}
                    className="self-start text-[11px] text-[#006AFF] hover:underline inline-flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> Add opportunity
                  </button>
                )}
              </div>

              {/* Adjustments */}
              <div className="flex flex-col gap-2 pl-1">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                  Adjustments (applied in order, by Match opp name)
                </label>
                {rule.adjustments.length === 0 && (
                  <p className="text-[11px] text-amber-700">
                    No adjustments — the rule has no effect.
                  </p>
                )}
                {rule.adjustments.map((adj, adjIdx) => (
                  <AdjustmentRow
                    key={adjIdx}
                    adj={adj}
                    canEdit={canEdit}
                    matchOppNames={rule.opps
                      .filter(o => o.mode === "match" && o.name.trim() !== "")
                      .map(o => o.name)}
                    mrrFieldOptions={feederMrrOptions}
                    onChange={patch => updateAdjustment(ruleIdx, adjIdx, patch)}
                    onRemove={() => removeAdjustment(ruleIdx, adjIdx)}
                  />
                ))}
                {canEdit && (
                  <button
                    onClick={() => addAdjustment(ruleIdx)}
                    className="self-start text-[11px] text-[#006AFF] hover:underline inline-flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> Add adjustment
                  </button>
                )}
              </div>

              {/* Owner-reassignment gate (optional override) */}
              <div className="flex flex-col gap-2 pl-1">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                  Reassignable owner roles (gate for owner reassignment; blank =
                  Compliance Sales / Account Sales)
                </label>
                <StatusListEditor
                  statuses={rule.reassignableOwnerRoles ?? []}
                  canEdit={canEdit}
                  onChange={list =>
                    updatePairedRule(ruleIdx, {
                      reassignableOwnerRoles: list.length ? list : undefined,
                    })
                  }
                />
              </div>

              <p className="text-[11px] text-muted-foreground border-t border-border pt-2">
                {displayProductText(pairedRuleText(rule))}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {showDrilldown && (
        <Suspense fallback={null}>
          <FunnelDrilldownModal
            stage="Closed Won"
            mode="stage"
            revenueMode="quota"
            ruleAffectedOnly
            filters={drilldownFilters}
            authUser={authUser}
            onClose={() => setShowDrilldown(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SaveStatus({
  saveState,
  saveError,
  dirty,
  baseline,
}: {
  saveState: SaveState;
  saveError: string | null;
  dirty: boolean;
  baseline: CompensationConfig | null;
}) {
  if (saveState === "error") {
    return (
      <span className="text-[11px] text-red-600 inline-flex items-center gap-1">
        <AlertCircle className="w-3.5 h-3.5" /> {saveError || "Save failed"}
      </span>
    );
  }
  if (saveState === "saved" && !dirty) {
    return (
      <span className="text-[11px] text-green-600 inline-flex items-center gap-1">
        <Check className="w-3.5 h-3.5" /> Saved
      </span>
    );
  }
  if (dirty) {
    return <span className="text-[11px] text-amber-700">Unsaved changes</span>;
  }
  if (baseline && !baseline.isDefault && baseline.updatedByName) {
    const when = baseline.updatedAt
      ? new Date(baseline.updatedAt).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "";
    return (
      <span className="text-[11px] text-muted-foreground">
        Last saved by {baseline.updatedByName}
        {when ? ` · ${when}` : ""}
      </span>
    );
  }
  return null;
}

// Editor for a single paired-opp adjustment: which Match opp it targets, the
// math op + its amount, the comparison opp (for incremental ops), the feeder
// column (for reassignMrrField), and an optional gated owner reassignment.
const ADJ_OP_OPTIONS: { value: CompAdjustment["op"]; label: string }[] = [
  { value: "keep", label: "Keep (unchanged)" },
  { value: "waive", label: "Waive (set to 0)" },
  { value: "fixedCredit", label: "Fixed credit (= amount)" },
  { value: "capAt", label: "Cap at amount" },
  { value: "incremental", label: "Incremental (|target| − |comparison|)" },
  {
    value: "greaterOfFloorOrIncremental",
    label: "Greater of floor or incremental",
  },
  { value: "multiplyByFactor", label: "Multiply by factor" },
  { value: "reassignMrrField", label: "Reassign MRR field (use column)" },
  { value: "ignoreAcqChurn", label: "Ignore ACQ Churn Logic" },
];

const ADJ_AMOUNT_OPS = new Set<CompAdjustment["op"]>([
  "fixedCredit",
  "capAt",
  "greaterOfFloorOrIncremental",
  "multiplyByFactor",
]);

const ADJ_COMPARISON_OPS = new Set<CompAdjustment["op"]>([
  "incremental",
  "greaterOfFloorOrIncremental",
]);

const ADJ_NO_OWNER = "__none__";

// Sentinel for "no comparison field" (= measure the comparison opp by its
// standardized MRR, the existing behavior).
const ADJ_COMPARISON_DEFAULT_FIELD = "__standardized__";

function AdjustmentRow({
  adj,
  canEdit,
  matchOppNames,
  mrrFieldOptions,
  onChange,
  onRemove,
}: {
  adj: CompAdjustment;
  canEdit: boolean;
  matchOppNames: string[];
  mrrFieldOptions: { value: string; label: string }[];
  onChange: (patch: Partial<CompAdjustment>) => void;
  onRemove: () => void;
}) {
  const showAmount = ADJ_AMOUNT_OPS.has(adj.op);
  const showComparison = ADJ_COMPARISON_OPS.has(adj.op);
  const showMrrField = adj.op === "reassignMrrField";
  const feederOptions = mrrFieldOptions.filter(o =>
    COMPARABLE_FIELD_OPTIONS.some(c => c.value === o.value),
  );
  return (
    <div className="flex flex-wrap items-center gap-2 border border-border rounded-md px-2 py-1.5">
      <Select
        value={adj.targetOpp || undefined}
        disabled={!canEdit}
        onValueChange={v => onChange({ targetOpp: v })}
      >
        <SelectTrigger className="h-8 w-[150px] text-[12px]">
          <SelectValue placeholder="target opp" />
        </SelectTrigger>
        <SelectContent>
          {matchOppNames.length === 0 && (
            <SelectItem value="__empty__" disabled className="text-[12px]">
              No match opps
            </SelectItem>
          )}
          {matchOppNames.map(n => (
            <SelectItem key={n} value={n} className="text-[12px]">
              {n}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={adj.op}
        disabled={!canEdit}
        onValueChange={v => onChange({ op: v as CompAdjustment["op"] })}
      >
        <SelectTrigger className="h-8 w-[240px] text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ADJ_OP_OPTIONS.map(o => (
            <SelectItem key={o.value} value={o.value} className="text-[12px]">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {showAmount && (
        <Input
          type="number"
          step="0.01"
          value={adj.amount ?? 0}
          disabled={!canEdit}
          onChange={e => onChange({ amount: Number(e.target.value) })}
          className="h-8 w-[110px] text-[12px] tabular-nums"
          placeholder="amount"
        />
      )}

      {showComparison && (
        <Select
          value={adj.comparisonOpp || undefined}
          disabled={!canEdit}
          onValueChange={v => onChange({ comparisonOpp: v })}
        >
          <SelectTrigger className="h-8 w-[150px] text-[12px]">
            <SelectValue placeholder="comparison opp" />
          </SelectTrigger>
          <SelectContent>
            {matchOppNames.length === 0 && (
              <SelectItem value="__empty__" disabled className="text-[12px]">
                No match opps
              </SelectItem>
            )}
            {matchOppNames.map(n => (
              <SelectItem key={n} value={n} className="text-[12px]">
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {showComparison && (
        <Select
          value={adj.comparisonField || ADJ_COMPARISON_DEFAULT_FIELD}
          disabled={!canEdit}
          onValueChange={v =>
            onChange({
              comparisonField:
                v === ADJ_COMPARISON_DEFAULT_FIELD
                  ? undefined
                  : (v as NonNullable<CompAdjustment["comparisonField"]>),
            })
          }
        >
          <SelectTrigger className="h-8 w-[180px] text-[12px]">
            <SelectValue placeholder="comparison field" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              value={ADJ_COMPARISON_DEFAULT_FIELD}
              className="text-[12px]"
            >
              standardized MRR
            </SelectItem>
            {feederOptions.map(o => (
              <SelectItem key={o.value} value={o.value} className="text-[12px]">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {showMrrField && (
        <Select
          value={adj.mrrField || undefined}
          disabled={!canEdit}
          onValueChange={v =>
            onChange({ mrrField: v as NonNullable<CompAdjustment["mrrField"]> })
          }
        >
          <SelectTrigger className="h-8 w-[180px] text-[12px]">
            <SelectValue placeholder="MRR column" />
          </SelectTrigger>
          <SelectContent>
            {feederOptions.map(o => (
              <SelectItem key={o.value} value={o.value} className="text-[12px]">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Select
        value={adj.reassignOwnerToOpp || ADJ_NO_OWNER}
        disabled={!canEdit}
        onValueChange={v =>
          onChange({ reassignOwnerToOpp: v === ADJ_NO_OWNER ? undefined : v })
        }
      >
        <SelectTrigger className="h-8 w-[190px] text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ADJ_NO_OWNER} className="text-[12px]">
            No owner reassignment
          </SelectItem>
          {matchOppNames.map(n => (
            <SelectItem key={n} value={n} className="text-[12px]">
              Reassign owner to {n}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {canEdit && (
        <button
          onClick={onRemove}
          className="ml-auto text-muted-foreground hover:text-red-600 transition-colors"
          title="Remove adjustment"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

// Sentinel for the combined opp/custom picker: selecting this turns the term
// into a custom literal instead of an opp-field reference (no separate source
// dropdown — "Custom value" lives at the end of the opp list). The leading NUL
// guarantees it can never collide with a real opp name (so the Select never has
// duplicate values and a legitimately-named opp can't be misread as "custom").
const CUSTOM_TERM_VALUE = "\u0000__custom__";

function defaultOppTerm(opp: string): CompLogicTerm {
  return { source: "opp", opp, field: "changeInMrr" } as CompLogicTerm;
}

// Synthesize the LEFT side's term list. If the condition already carries
// `leftTerms` use them verbatim; otherwise build a single opp term equivalent to
// the legacy single-operand left side (this opp's `field`). For a single term
// abs-INSIDE and the legacy abs-OUTSIDE coincide when the factor is a no-op,
// which is the common case; once the user edits, the explicit formula governs.
function synthLeftTerms(c: CompPairedCondition, ownOppName: string): CompLogicTerm[] {
  if (Array.isArray(c.leftTerms) && c.leftTerms.length > 0) return c.leftTerms;
  const sided = resolveSidedSigned(c);
  return [
    {
      source: "opp",
      opp: ownOppName,
      field: (c.field as CompLogicTerm["field"]) ?? "changeInMrr",
      factorOp: c.leftFactorOp ?? undefined,
      factor: c.leftFactor ?? undefined,
      signed: sided.left || undefined,
    } as CompLogicTerm,
  ];
}

// Synthesize the RIGHT side's term list from `rightTerms` or the legacy
// compare-to operand (compareToOpp's compareToField, with the legacy
// `factor`/`factorOp` fallbacks already folded in).
function synthRightTerms(c: CompPairedCondition, ownOppName: string): CompLogicTerm[] {
  if (Array.isArray(c.rightTerms) && c.rightTerms.length > 0) return c.rightTerms;
  const sided = resolveSidedSigned(c);
  return [
    {
      source: "opp",
      opp: c.compareToOpp || ownOppName,
      field: (c.compareToField as CompLogicTerm["field"]) ?? "changeInMrr",
      factorOp: c.rightFactorOp ?? c.factorOp ?? undefined,
      factor: c.rightFactor ?? c.factor ?? undefined,
      signed: sided.right || undefined,
    } as CompLogicTerm,
  ];
}

// Free-text decimal input that keeps a local string so partial entries like
// "1." or "0." survive a render; the parsed number is propagated only when
// finite (empty → undefined). Resyncs from the prop only when the stored number
// diverges from what the local string parses to (external reset), never
// mid-typing. Mirrors the per-side factor input pattern.
function DecimalInput({
  value,
  disabled,
  placeholder,
  className,
  onValue,
}: {
  value: number | null | undefined;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  onValue: (n: number | undefined) => void;
}) {
  const [str, setStr] = useState(value != null ? String(value) : "");
  useEffect(() => {
    const cur = str === "" ? undefined : Number(str);
    if (cur !== (value ?? undefined)) {
      setStr(value != null ? String(value) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      placeholder={placeholder}
      className={className}
      value={str}
      onChange={e => {
        const v = e.target.value;
        setStr(v);
        if (v === "") {
          onValue(undefined);
          return;
        }
        const n = Number(v);
        if (Number.isFinite(n)) onValue(n);
      }}
    />
  );
}

// Editor for a single logic term. A non-first term gets a leading join-op picker
// (+ − × ÷). An "opp" term exposes opp/field pickers plus per-term Absolute
// (|abs|) / Actual (signed) and a factor-op + factor scalar (applied ABS-INSIDE
// at eval time). A "custom" term is a single literal value.
function LogicTermEditor({
  term,
  isFirst,
  canEdit,
  canRemove,
  oppNames,
  onChange,
  onRemove,
}: {
  term: CompLogicTerm;
  isFirst: boolean;
  canEdit: boolean;
  canRemove: boolean;
  oppNames: string[];
  onChange: (patch: Partial<CompLogicTerm>) => void;
  onRemove: () => void;
}) {
  const signed = term.signed === true;
  const factorOp = term.factorOp ?? "multiply";
  const isCustom = (term.source ?? "opp") === "custom";
  // Modifiers (Absolute/Actual + factor-op + factor) start expanded only when
  // the term carries non-default values, so opening a rule never silently
  // resets them; clean terms start collapsed.
  const hasNonDefaultMods =
    signed ||
    (term.factorOp != null && term.factorOp !== "multiply") ||
    (typeof term.factor === "number" && term.factor !== 1);
  const [showMods, setShowMods] = useState(hasNonDefaultMods);
  // Collapsing resets the modifiers to their defaults (|abs|, ×1) so a hidden
  // term always evaluates as the plain |Σ field|.
  const toggleMods = () => {
    if (showMods) {
      onChange({ signed: undefined, factorOp: undefined, factor: undefined });
    }
    setShowMods(s => !s);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!isFirst && (
        <Select
          value={term.joinOp ?? "add"}
          disabled={!canEdit}
          onValueChange={v =>
            onChange({ joinOp: v as NonNullable<CompLogicTerm["joinOp"]> })
          }
        >
          <SelectTrigger className="h-8 w-[52px] text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FACTOR_OP_OPTIONS.map(o => (
              <SelectItem key={o.value} value={o.value} className="text-[12px]">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {/* Combined opp / custom-value picker: the opp list carries a trailing
          "Custom value" entry instead of a separate source dropdown. */}
      <Select
        value={isCustom ? CUSTOM_TERM_VALUE : term.opp || undefined}
        disabled={!canEdit}
        onValueChange={v => {
          if (v === CUSTOM_TERM_VALUE) {
            onChange({
              source: "custom",
              value: typeof term.value === "number" ? term.value : 0,
              opp: undefined,
              field: undefined,
              factor: undefined,
              factorOp: undefined,
              signed: undefined,
            });
          } else {
            onChange({
              source: "opp",
              opp: v,
              field: term.field ?? "changeInMrr",
              value: undefined,
            });
          }
        }}
      >
        <SelectTrigger className="h-8 w-[150px] text-[12px]">
          <SelectValue placeholder="opp" />
        </SelectTrigger>
        <SelectContent>
          {oppNames.map(n => (
            <SelectItem key={n} value={n} className="text-[12px]">
              {n}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_TERM_VALUE} className="text-[12px]">
            Custom value
          </SelectItem>
        </SelectContent>
      </Select>

      {isCustom ? (
        <DecimalInput
          value={typeof term.value === "number" ? term.value : undefined}
          disabled={!canEdit}
          placeholder="0"
          className="h-8 w-[90px] text-[12px]"
          onValue={n => onChange({ value: n ?? 0 })}
        />
      ) : (
        <>
          <Select
            value={term.field ?? "changeInMrr"}
            disabled={!canEdit}
            onValueChange={v =>
              onChange({ field: v as NonNullable<CompLogicTerm["field"]> })
            }
          >
            <SelectTrigger className="h-8 w-[150px] text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMPARABLE_FIELD_OPTIONS.map(o => (
                <SelectItem key={o.value} value={o.value} className="text-[12px]">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canEdit && (
            <button
              type="button"
              onClick={toggleMods}
              className={`transition-colors ${showMods ? "text-[#006AFF]" : "text-muted-foreground hover:text-foreground"}`}
              title={
                showMods
                  ? "Hide modifiers (resets to |abs| ×1)"
                  : "Show modifiers"
              }
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>
          )}
          {showMods && (
            <>
              <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Switch
                  checked={signed}
                  disabled={!canEdit}
                  onCheckedChange={v => onChange({ signed: v === true })}
                />
                <span>{signed ? "Actual" : "Absolute"}</span>
              </label>
              <Select
                value={factorOp}
                disabled={!canEdit}
                onValueChange={v =>
                  onChange({
                    factorOp: v as NonNullable<CompLogicTerm["factorOp"]>,
                  })
                }
              >
                <SelectTrigger className="h-8 w-[52px] text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FACTOR_OP_OPTIONS.map(o => (
                    <SelectItem key={o.value} value={o.value} className="text-[12px]">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <DecimalInput
                value={typeof term.factor === "number" ? term.factor : undefined}
                disabled={!canEdit}
                placeholder="1"
                className="h-8 w-[64px] text-[12px]"
                onValue={n => onChange({ factor: n })}
              />
            </>
          )}
        </>
      )}

      {canEdit && canRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="text-muted-foreground hover:text-red-600 transition-colors"
          title="Remove term"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// One side of the formula: an ordered, vertically-stacked list of logic terms
// plus an "Add term" control. Standard precedence (×÷ before +−) is applied at
// evaluation time on the server; the editor just maintains the ordered list.
function FormulaSideEditor({
  label,
  terms,
  canEdit,
  oppNames,
  onTermChange,
  onAddTerm,
  onRemoveTerm,
}: {
  label: string;
  terms: CompLogicTerm[];
  canEdit: boolean;
  oppNames: string[];
  onTermChange: (idx: number, patch: Partial<CompLogicTerm>) => void;
  onAddTerm: () => void;
  onRemoveTerm: (idx: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-dashed border-border/70 p-1.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {terms.map((t, i) => (
        <LogicTermEditor
          key={i}
          term={t}
          isFirst={i === 0}
          canEdit={canEdit}
          canRemove={terms.length > 1}
          oppNames={oppNames}
          onChange={patch => onTermChange(i, patch)}
          onRemove={() => onRemoveTerm(i)}
        />
      ))}
      {canEdit && (
        <button
          type="button"
          onClick={onAddTerm}
          className="self-start text-[11px] text-[#006AFF] hover:underline inline-flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> Add term
        </button>
      )}
    </div>
  );
}

// Editor for a single named-opp condition: a "field" test (field/op/value) or a
// "comparative" test against another opp in the rule (identity value-join, or
// this opp's |Σ feeder| vs the other opp's |Σ feeder|).
function PairedConditionRow({
  cond,
  canEdit,
  status,
  compareToOppNames,
  ownOppName,
  suggestions,
  onChange,
  onRemove,
}: {
  cond: CompPairedCondition;
  canEdit: boolean;
  status?: CompConditionTestStatus;
  compareToOppNames: string[];
  ownOppName: string;
  suggestions: string[];
  onChange: (patch: Partial<CompPairedCondition>) => void;
  onRemove: () => void;
}) {
  const isList = cond.op === "in" || cond.op === "notIn";
  const isBool = cond.field === "legacyFlag";
  const hl = condStatusClasses(status);
  const listId = useMemo(
    () => `pcond-sg-${Math.random().toString(36).slice(2, 8)}`,
    [],
  );

  // A comparative on an identity field (Account ID, Close Date, …) is a per-row
  // VALUE join (op restricted to = / ≠). A comparative on a feeder MRR column is
  // an aggregate |Σ| magnitude comparison. Both sides must be the same kind.
  const compIsIdentity =
    cond.kind === "comparative" && IDENTITY_FIELD_VALUES.has(cond.field as string);

  // Task #420 — the leftmost selector is a 3-way mode: Field (plain field
  // condition), Comparative (identity/join), or Magnitude (Σ-formula builder).
  // Comparative + Magnitude both persist as kind "comparative"; identity-vs-
  // magnitude is distinguished by whether `field` is an identity field.
  const compMode: "field" | "comparative" | "magnitude" =
    cond.kind === "field" ? "field" : compIsIdentity ? "comparative" : "magnitude";

  // Task #422 — the left/right month/exact dropdowns each appear only next to a
  // date-typed field, but their value + disabled state come from shared helpers
  // (no per-side value), so whenever both render they are slaved to one another
  // and can never display differing granularities.
  const leftDateGranularity = compDateGranularityControl(cond, "left", canEdit);
  const rightDateGranularity = compDateGranularityControl(
    cond,
    "right",
    canEdit,
  );

  // Task #420 — formula builder. The numeric comparative branch is a 2-sided
  // formula of ordered logic terms. Effective terms come from the stored
  // `leftTerms`/`rightTerms`, or are synthesized from the legacy single-operand
  // fields so a legacy condition opens pre-populated. Any edit commits BOTH
  // sides (persisting the synthesis) and clears the superseded legacy
  // single-operand modifiers so the dual eval path resolves to the formula.
  const effLeftTerms = useMemo(
    () => synthLeftTerms(cond, ownOppName),
    [cond, ownOppName],
  );
  const effRightTerms = useMemo(
    () => synthRightTerms(cond, ownOppName),
    [cond, ownOppName],
  );
  const commitTerms = (left: CompLogicTerm[], right: CompLogicTerm[]) => {
    onChange({
      leftTerms: left,
      rightTerms: right,
      factor: undefined,
      factorOp: undefined,
      leftFactor: undefined,
      leftFactorOp: undefined,
      rightFactor: undefined,
      rightFactorOp: undefined,
      signed: undefined,
      leftSigned: undefined,
      rightSigned: undefined,
    } as Partial<CompPairedCondition>);
  };
  const updateTerm = (
    side: "left" | "right",
    idx: number,
    patch: Partial<CompLogicTerm>,
  ) => {
    const arr = (side === "left" ? effLeftTerms : effRightTerms).map((t, i) =>
      i === idx ? ({ ...t, ...patch } as CompLogicTerm) : t,
    );
    commitTerms(
      side === "left" ? arr : effLeftTerms,
      side === "right" ? arr : effRightTerms,
    );
  };
  const addTerm = (side: "left" | "right") => {
    const arr = [
      ...(side === "left" ? effLeftTerms : effRightTerms),
      defaultOppTerm(compareToOppNames[0] ?? ownOppName),
    ];
    commitTerms(
      side === "left" ? arr : effLeftTerms,
      side === "right" ? arr : effRightTerms,
    );
  };
  const removeTerm = (side: "left" | "right", idx: number) => {
    const base = side === "left" ? effLeftTerms : effRightTerms;
    if (base.length <= 1) return;
    const arr = base.filter((_, i) => i !== idx);
    commitTerms(
      side === "left" ? arr : effLeftTerms,
      side === "right" ? arr : effRightTerms,
    );
  };

  const onKindChange = (kind: CompPairedCondition["kind"]) => {
    if (kind === "comparative") {
      // Default to a numeric (formula) comparative seeded with one opp term per
      // side so the formula builder opens populated.
      onChange({
        kind: "comparative",
        field: "changeInMrr",
        op: "gte",
        value: undefined,
        compareToOpp: compareToOppNames[0] ?? "",
        compareToField: "changeInMrr",
        dateGranularity: undefined,
        leftTerms: [defaultOppTerm(ownOppName)],
        rightTerms: [defaultOppTerm(compareToOppNames[0] ?? ownOppName)],
        factor: undefined,
        factorOp: undefined,
        leftFactor: undefined,
        leftFactorOp: undefined,
        rightFactor: undefined,
        rightFactorOp: undefined,
        signed: undefined,
        leftSigned: undefined,
        rightSigned: undefined,
      } as Partial<CompPairedCondition>);
    } else {
      onChange({
        kind: "field",
        field: "product",
        op: "eq",
        value: "",
        compareToOpp: undefined,
        compareToField: undefined,
        dateGranularity: undefined,
        factor: undefined,
        factorOp: undefined,
        leftFactor: undefined,
        leftFactorOp: undefined,
        rightFactor: undefined,
        rightFactorOp: undefined,
        signed: undefined,
        leftSigned: undefined,
        rightSigned: undefined,
      } as Partial<CompPairedCondition>);
    }
  };

  // Task #420 — 3-way mode selector. Field/Magnitude reuse onKindChange
  // (Magnitude = the numeric formula comparative it already seeds); Comparative
  // seeds an identity (value-join) comparative on the first identity field.
  const onModeChange = (mode: "field" | "comparative" | "magnitude") => {
    if (mode === "field") {
      onKindChange("field");
      return;
    }
    if (mode === "magnitude") {
      onKindChange("comparative");
      return;
    }
    const idField = IDENTITY_FIELD_OPTIONS[0]?.value ?? "accountId";
    onChange({
      kind: "comparative",
      field: idField as CompPairedCondition["field"],
      op: "eq",
      value: undefined,
      compareToOpp: compareToOppNames[0] ?? "",
      compareToField: idField as CompPairedCondition["compareToField"],
      dateGranularity: undefined,
      leftTerms: undefined,
      rightTerms: undefined,
      factor: undefined,
      factorOp: undefined,
      leftFactor: undefined,
      leftFactorOp: undefined,
      rightFactor: undefined,
      rightFactorOp: undefined,
      signed: undefined,
      leftSigned: undefined,
      rightSigned: undefined,
    } as Partial<CompPairedCondition>);
  };

  // Switching the comparative LEFT field flips the whole condition's kind
  // (identity vs numeric): op + compareToField must follow so both sides stay
  // the same kind, and dateGranularity only applies to identity closeDate.
  const onComparativeFieldChange = (field: string) => {
    const toIdentity = IDENTITY_FIELD_VALUES.has(field);
    const patch: Partial<CompPairedCondition> = {
      field: field as CompPairedCondition["field"],
    };
    if (toIdentity) {
      const toDate = isCompDateField(field);
      // Non-date identity fields only support value joins (= / ≠); date fields
      // also support chronological ordering, so keep an ordering op when moving
      // between two date fields.
      let op = cond.op;
      if (!toDate && op !== "eq" && op !== "ne") {
        op = "eq";
        patch.op = "eq";
      }
      const cf = cond.compareToField as string;
      if (isOrderingOp(op)) {
        // Ordering requires a DATE compareToField.
        if (!isCompDateField(cf)) {
          patch.compareToField = field as CompPairedCondition["compareToField"];
        }
      } else if (!IDENTITY_FIELD_VALUES.has(cf)) {
        patch.compareToField = field as CompPairedCondition["compareToField"];
      }
      patch.dateGranularity = toDate
        ? (cond.dateGranularity ?? "month")
        : undefined;
      // factor/factorOp/signed flags and formula terms are numeric-magnitude
      // only — clear on identity.
      patch.factor = undefined;
      patch.factorOp = undefined;
      patch.leftFactor = undefined;
      patch.leftFactorOp = undefined;
      patch.rightFactor = undefined;
      patch.rightFactorOp = undefined;
      patch.signed = undefined;
      patch.leftSigned = undefined;
      patch.rightSigned = undefined;
      patch.leftTerms = undefined;
      patch.rightTerms = undefined;
    } else {
      if (cond.op === "eq" || cond.op === "ne") patch.op = "gte";
      if (IDENTITY_FIELD_VALUES.has(cond.compareToField as string)) {
        patch.compareToField = "changeInMrr" as CompPairedCondition["compareToField"];
      }
      patch.dateGranularity = undefined;
      // Entering numeric mode from identity: seed the formula builder.
      if (!Array.isArray(cond.leftTerms)) {
        patch.leftTerms = [defaultOppTerm(ownOppName)];
      }
      if (!Array.isArray(cond.rightTerms)) {
        patch.rightTerms = [
          defaultOppTerm(compareToOppNames[0] ?? ownOppName),
        ];
      }
    }
    onChange(patch);
  };

  const onOpChange = (op: ConditionOp) => {
    let value = cond.value;
    const toList = op === "in" || op === "notIn";
    const wasList = Array.isArray(cond.value);
    if (toList && !wasList) {
      value = cond.value === "" || cond.value == null ? [] : [String(cond.value)];
    } else if (!toList && wasList) {
      const arr = cond.value as string[];
      value = arr.length ? String(arr[0]) : "";
    }
    onChange({ op: op as CompPairedCondition["op"], value });
  };

  // Comparative op change: an ordering op on an identity comparative is only
  // valid between date fields, so force a DATE compareToField when one isn't set.
  const onComparativeOpChange = (op: ConditionOp) => {
    const patch: Partial<CompPairedCondition> = {
      op: op as CompPairedCondition["op"],
    };
    if (compIsIdentity && isOrderingOp(op) && !isCompDateField(cond.compareToField)) {
      patch.compareToField = (
        isCompDateField(cond.field) ? cond.field : "closeDate"
      ) as CompPairedCondition["compareToField"];
    }
    onChange(patch);
  };

  return (
    <div
      className={`flex flex-wrap items-center gap-2${hl ? ` ${hl} border rounded-md p-1` : ""}`}
    >
      <Select
        value={compMode}
        disabled={!canEdit}
        onValueChange={v =>
          onModeChange(v as "field" | "comparative" | "magnitude")
        }
      >
        <SelectTrigger className="h-8 w-[120px] text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="field" className="text-[12px]">Field</SelectItem>
          <SelectItem value="comparative" className="text-[12px]">Comparative</SelectItem>
          <SelectItem value="magnitude" className="text-[12px]">Magnitude</SelectItem>
        </SelectContent>
      </Select>

      {cond.kind === "comparative" ? (
        compIsIdentity ? (
            <>
              <Select
                value={cond.field}
                disabled={!canEdit}
                onValueChange={onComparativeFieldChange}
              >
                <SelectTrigger className="h-8 w-[170px] text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IDENTITY_FIELD_OPTIONS.map(o => (
                    <SelectItem key={o.value} value={o.value} className="text-[12px]">
                      {displayProductText(o.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {leftDateGranularity.visible && (
                <Select
                  value={leftDateGranularity.value}
                  disabled={leftDateGranularity.disabled}
                  onValueChange={v =>
                    onChange(
                      compDateGranularityPatch(v as CompDateGranularityValue),
                    )
                  }
                >
                  <SelectTrigger className="h-8 w-[90px] text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="month" className="text-[12px]">month</SelectItem>
                    <SelectItem value="exact" className="text-[12px]">exact</SelectItem>
                  </SelectContent>
                </Select>
              )}

              <Select
                value={cond.op}
                disabled={!canEdit}
                onValueChange={v => onComparativeOpChange(v as ConditionOp)}
              >
                <SelectTrigger className="h-8 w-[90px] text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(!isCompDateField(cond.field)
                    ? COMPARATIVE_OP_OPTIONS.filter(o => o.value === "eq" || o.value === "ne")
                    : COMPARATIVE_OP_OPTIONS
                  ).map(o => (
                    <SelectItem key={o.value} value={o.value} className="text-[12px]">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={cond.compareToOpp || undefined}
                disabled={!canEdit}
                onValueChange={v => onChange({ compareToOpp: v })}
              >
                <SelectTrigger className="h-8 w-[150px] text-[12px]">
                  <SelectValue placeholder="compare-to opp" />
                </SelectTrigger>
                <SelectContent>
                  {compareToOppNames.length === 0 && (
                    <SelectItem value="__empty__" disabled className="text-[12px]">
                      No other opps
                    </SelectItem>
                  )}
                  {compareToOppNames.map(n => (
                    <SelectItem key={n} value={n} className="text-[12px]">
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={cond.compareToField ?? "changeInMrr"}
                disabled={!canEdit}
                onValueChange={v =>
                  onChange({
                    compareToField: v as NonNullable<
                      CompPairedCondition["compareToField"]
                    >,
                  })
                }
              >
                <SelectTrigger className="h-8 w-[160px] text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(isOrderingOp(cond.op)
                    ? DATE_IDENTITY_FIELD_OPTIONS
                    : IDENTITY_FIELD_OPTIONS
                  ).map(o => (
                    <SelectItem key={o.value} value={o.value} className="text-[12px]">
                      {displayProductText(o.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {rightDateGranularity.visible && (
                <Select
                  value={rightDateGranularity.value}
                  disabled={rightDateGranularity.disabled}
                  onValueChange={v =>
                    onChange(
                      compDateGranularityPatch(v as CompDateGranularityValue),
                    )
                  }
                >
                  <SelectTrigger className="h-8 w-[90px] text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="month" className="text-[12px]">month</SelectItem>
                    <SelectItem value="exact" className="text-[12px]">exact</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </>
          ) : (
            <>
              {/* Task #420: per-side formula builder. Each side is an ordered
                  list of logic terms joined by + − × ÷ (×÷ before +− at eval).
                  Each opp term applies its Absolute/Actual + factor ABS-INSIDE;
                  custom terms are literals. */}
              <FormulaSideEditor
                label="Left side (Σ formula)"
                terms={effLeftTerms}
                canEdit={canEdit}
                oppNames={compareToOppNames}
                onTermChange={(idx, patch) => updateTerm("left", idx, patch)}
                onAddTerm={() => addTerm("left")}
                onRemoveTerm={idx => removeTerm("left", idx)}
              />

              <Select
                value={cond.op}
                disabled={!canEdit}
                onValueChange={v => onComparativeOpChange(v as ConditionOp)}
              >
                <SelectTrigger className="h-8 w-[90px] text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPARATIVE_OP_OPTIONS.map(o => (
                    <SelectItem key={o.value} value={o.value} className="text-[12px]">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <FormulaSideEditor
                label="Right side (Σ formula)"
                terms={effRightTerms}
                canEdit={canEdit}
                oppNames={compareToOppNames}
                onTermChange={(idx, patch) => updateTerm("right", idx, patch)}
                onAddTerm={() => addTerm("right")}
                onRemoveTerm={idx => removeTerm("right", idx)}
              />
            </>
          )
      ) : (
        <>
          <Select
            value={cond.field}
            disabled={!canEdit}
            onValueChange={v =>
              onChange({
                field: v as CompPairedCondition["field"],
                value: v === "legacyFlag" ? false : "",
              })
            }
          >
            <SelectTrigger className="h-8 w-[150px] text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIELD_OPTIONS.map(o => (
                <SelectItem key={o.value} value={o.value} className="text-[12px]">
                  {displayProductText(o.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={cond.op}
            disabled={!canEdit || isBool}
            onValueChange={v => onOpChange(v as ConditionOp)}
          >
            <SelectTrigger className="h-8 w-[120px] text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OP_OPTIONS.filter(o =>
                isBool ? o.value === "eq" || o.value === "ne" : true,
              ).map(o => (
                <SelectItem key={o.value} value={o.value} className="text-[12px]">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {isBool ? (
            <Select
              value={String(cond.value === true)}
              disabled={!canEdit}
              onValueChange={v => onChange({ value: v === "true" })}
            >
              <SelectTrigger className="h-8 w-[120px] text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true" className="text-[12px]">true</SelectItem>
                <SelectItem value="false" className="text-[12px]">false</SelectItem>
              </SelectContent>
            </Select>
          ) : isList ? (
            <Input
              value={(Array.isArray(cond.value) ? cond.value : []).join(", ")}
              disabled={!canEdit}
              onChange={e =>
                onChange({
                  value: e.target.value
                    .split(",")
                    .map(s => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder="value1, value2"
              className="h-8 text-[12px] flex-1 min-w-[160px]"
            />
          ) : (
            <>
              {/* Task #410: contains / does not contain accept a comma-separated
                  list (matches ANY token / excludes ALL tokens). */}
              <Input
                value={cond.value == null ? "" : String(cond.value)}
                disabled={!canEdit}
                list={suggestions.length ? listId : undefined}
                onChange={e => onChange({ value: e.target.value })}
                placeholder={
                  cond.op === "contains" || cond.op === "notContains"
                    ? "value or v4, version4"
                    : "value"
                }
                title={
                  cond.op === "contains" || cond.op === "notContains"
                    ? "Separate multiple values with commas"
                    : undefined
                }
                className="h-8 text-[12px] flex-1 min-w-[160px]"
              />
              {suggestions.length > 0 && (
                <datalist id={listId}>
                  {suggestions.map(s => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              )}
            </>
          )}
        </>
      )}

      {canEdit && (
        <button
          onClick={onRemove}
          className="text-muted-foreground hover:text-red-600 transition-colors"
          title="Remove condition"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function ConditionRow({
  cond,
  canEdit,
  status,
  suggestions,
  onFieldChange,
  onOpChange,
  onValueChange,
  onRemove,
}: {
  cond: CompCondition;
  canEdit: boolean;
  status?: CompConditionTestStatus;
  suggestions: string[];
  onFieldChange: (f: ConditionField) => void;
  onOpChange: (o: ConditionOp) => void;
  onValueChange: (v: CompCondition["value"]) => void;
  onRemove: () => void;
}) {
  const isList = cond.op === "in" || cond.op === "notIn";
  const isBool = cond.field === "legacyFlag";
  const listId = useMemo(
    () => `cond-sg-${Math.random().toString(36).slice(2, 8)}`,
    [],
  );
  const hl = condStatusClasses(status);

  return (
    <div
      className={`flex flex-wrap items-center gap-2${hl ? ` ${hl} border rounded-md p-1` : ""}`}
    >
      <Select
        value={cond.field}
        disabled={!canEdit}
        onValueChange={v => onFieldChange(v as ConditionField)}
      >
        <SelectTrigger className="h-8 w-[140px] text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FIELD_OPTIONS.map(o => (
            <SelectItem key={o.value} value={o.value} className="text-[12px]">
              {displayProductText(o.label)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={cond.op}
        disabled={!canEdit || isBool}
        onValueChange={v => onOpChange(v as ConditionOp)}
      >
        <SelectTrigger className="h-8 w-[120px] text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OP_OPTIONS.filter(o => (isBool ? o.value === "eq" || o.value === "ne" : true)).map(
            o => (
              <SelectItem key={o.value} value={o.value} className="text-[12px]">
                {o.label}
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>

      {isBool ? (
        <Select
          value={String(cond.value === true)}
          disabled={!canEdit}
          onValueChange={v => onValueChange(v === "true")}
        >
          <SelectTrigger className="h-8 w-[120px] text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true" className="text-[12px]">
              true
            </SelectItem>
            <SelectItem value="false" className="text-[12px]">
              false
            </SelectItem>
          </SelectContent>
        </Select>
      ) : isList ? (
        <Input
          value={(Array.isArray(cond.value) ? cond.value : []).join(", ")}
          disabled={!canEdit}
          onChange={e =>
            onValueChange(
              e.target.value
                .split(",")
                .map(s => s.trim())
                .filter(Boolean),
            )
          }
          placeholder="value1, value2"
          className="h-8 text-[12px] flex-1 min-w-[160px]"
        />
      ) : (
        <>
          <Input
            value={cond.value == null ? "" : String(cond.value)}
            disabled={!canEdit}
            list={suggestions.length ? listId : undefined}
            onChange={e => onValueChange(e.target.value)}
            placeholder="value"
            className="h-8 text-[12px] flex-1 min-w-[160px]"
          />
          {suggestions.length > 0 && (
            <datalist id={listId}>
              {suggestions.map(s => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
        </>
      )}

      {canEdit && (
        <button
          onClick={onRemove}
          className="text-muted-foreground hover:text-red-600 transition-colors"
          title="Remove condition"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function StatusListEditor({
  statuses,
  canEdit,
  onChange,
}: {
  statuses: string[];
  canEdit: boolean;
  onChange: (list: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (statuses.some(s => s.toLowerCase() === v.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...statuses, v]);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {statuses.length === 0 && (
          <span className="text-[11px] text-muted-foreground">No statuses added.</span>
        )}
        {statuses.map(s => (
          <span
            key={s}
            className="inline-flex items-center gap-1 text-[11px] bg-muted border border-border rounded-full pl-2.5 pr-1 py-0.5"
          >
            {s}
            {canEdit && (
              <button
                onClick={() => onChange(statuses.filter(x => x !== s))}
                className="text-muted-foreground hover:text-red-600 transition-colors"
                title="Remove status"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </span>
        ))}
      </div>
      {canEdit && (
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Add a status…"
            className="h-8 text-[12px] w-[240px]"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-[12px]"
            onClick={add}
            disabled={!draft.trim()}
          >
            <Plus className="w-3.5 h-3.5 mr-1" /> Add
          </Button>
        </div>
      )}
    </div>
  );
}
