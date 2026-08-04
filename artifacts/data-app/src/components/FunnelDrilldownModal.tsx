import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { X, ArrowUpDown, ArrowUp, ArrowDown, Download, ExternalLink, Search, ChevronRight, ChevronDown, AlertTriangle, Eye, EyeOff, Info } from "lucide-react";
import { FilterState, AggregateBy } from "../pages/Dashboard";
import { getDateRange, passesChannelFilter } from "../lib/utils";
import { sfLightningBase, sfClassicRecordUrl } from "../lib/sf-links";
import { useDelayedTooltip, DelayedTooltipPortal } from "../hooks/useDelayedTooltip";
import { displayProduct, displayProductText } from "@/lib/product-labels";

const SF_LIGHTNING = sfLightningBase;

// Per-product editable Manager-Estimate probability cell rendered in
// the Sched Mods drilldown's pinned ME row expansion. Defined at
// module scope (NOT inside the parent component) so it keeps a stable
// component identity across parent re-renders — otherwise every
// keystroke would unmount + remount the input, killing focus and the
// in-flight debounce timer (Task #160 bug).
//
// Draft value lives in local `useState` and is only lifted to the
// parent on commit, mirroring the per-opp ProbabilityCell pattern.
const MEProductProbabilityCell: React.FC<{
  product: string;
  effectivePct: number;
  canEdit: boolean;
  repsCount: number;
  error: string | null;
  onClearError: () => void;
  onCommit: (n: number) => void;
  // Bumped by the parent after every save attempt (success OR failure)
  // so a failed write that round-trips to the same effectivePct still
  // forces the draft to snap back to the authoritative server value.
  syncTick: number;
  // True iff every rep × product slice in scope has an explicit override
  // row with `reviewed_at` set. When false, the cell renders with the
  // same yellow "unreviewed" highlight as the per-opp ProbabilityCell so
  // managers can see at a glance which slices haven't been touched.
  isReviewed: boolean;
}> = ({ product, effectivePct, canEdit, repsCount, error, onClearError, onCommit, syncTick, isReviewed }) => {
  const [draft, setDraft] = useState<string>(String(effectivePct));
  const debounceRef = useRef<number | null>(null);
  const focusedRef = useRef(false);
  // Re-sync draft from the rolled-up server value (or after any
  // commit attempt via syncTick), but never clobber mid-edit: only
  // update when the input isn't focused so users can type freely
  // without their keystrokes being overwritten by an optimistic
  // refetch.
  useEffect(() => {
    if (!focusedRef.current) setDraft(String(effectivePct));
  }, [effectivePct, syncTick]);
  useEffect(() => () => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
  }, []);
  const tryCommit = (raw: string, immediate: boolean) => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    if (!/^\d+$/.test(trimmed)) {
      setDraft(String(effectivePct));
      return;
    }
    let n = Number(trimmed);
    if (!Number.isInteger(n)) {
      setDraft(String(effectivePct));
      return;
    }
    if (n < 0) n = 0;
    if (n > 100) n = 100;
    if (String(n) !== trimmed && immediate) setDraft(String(n));
    if (n === effectivePct) return;
    onCommit(n);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      value={draft}
      disabled={!canEdit}
      title={error ? error : canEdit ? `Bulk-applies across ${repsCount} rep(s) for ${displayProduct(product)}` : "View only"}
      onFocus={() => { focusedRef.current = true; }}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        if (error) onClearError();
        if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
        debounceRef.current = window.setTimeout(() => tryCommit(v, false), 600);
      }}
      onBlur={() => {
        focusedRef.current = false;
        if (debounceRef.current != null) { window.clearTimeout(debounceRef.current); debounceRef.current = null; }
        tryCommit(draft, true);
      }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      className={`w-[58px] text-right text-[11px] tabular-nums px-1.5 py-0.5 rounded border focus:outline-none focus:ring-1 focus:ring-[#006AFF] ${error ? "border-[#EF4444] bg-red-50" : !isReviewed ? "bg-yellow-100 border-yellow-300" : canEdit ? "bg-white border-[#cbd5e1]" : "bg-[#f8fafc] border-[#e2e8f0] text-[#64748b] cursor-not-allowed"}`}
    />
  );
};

interface LineItem {
  product: string;
  mrr: number;
  amount: number;
  // Task #246: present only in Compensable Revenue mode. rawMrr is the
  // untreated MRR for this line; multipliers/ruleNames list the stacked
  // multiplier rules applied; pairAdjustmentLabel describes a paired-opp rule.
  rawMrr?: number | null;
  multipliers?: number[] | null;
  ruleNames?: string[] | null;
  // Task #317: description of the paired-opp adjustment applied to this line's
  // side (e.g. "Side B: × 0.1"), null when not part of a pair.
  pairAdjustmentLabel?: string | null;
}

interface Opportunity {
  oppName: string;
  accountName: string;
  accountId: string;
  oppId: string;
  manager: string;
  rep: string;
  salesRole: string;
  closeDate: string;
  type: string;
  quoteType: string;
  product: string;
  rawProduct?: string;
  amount: number;
  mrr: number;
  // Present only in Compensable Revenue mode. compensableMrr mirrors mrr (the
  // server already swaps it in); pairOppName/pairKey identify a matched
  // paired-opp rule so the drilldown can link the group members like
  // cancel/rebook pairs. pairRuleLabel/pairAdjustmentLabel describe the rule +
  // adjustment; churnSuppressed/ownerReassignedTo flag waived churn and gated
  // owner reassignment.
  compensableMrr?: number | null;
  pairOppName?: string | null;
  pairKey?: string | null;
  pairRuleLabel?: string | null;
  pairAdjustmentLabel?: string | null;
  churnSuppressed?: boolean | null;
  ownerReassignedTo?: string | null;
  // Task #246: per-opp compensation detail (compensable mode only). rawMrr is
  // the untreated MRR total; compMultipliers/compRuleNames are the stacked rules.
  rawMrr?: number | null;
  compMultipliers?: number[] | null;
  compRuleNames?: string[] | null;
  // Task #276: compensable mode only. appliedMrrField is the feeder-sheet
  // column used as the base MRR for this opp after any rule override (null when
  // the engine's Type-driven default applied). mrrFieldWinner is the rule that
  // set it; mrrFieldRuleLabels lists every field-setting rule that matched (>1
  // means a conflict the engine resolved by first/top-down matching rule wins).
  appliedMrrField?: string | null;
  mrrFieldWinner?: string | null;
  mrrFieldRuleLabels?: string[] | null;
  stage: string;
  funnelStage: string;
  // Task #295: true when this Overage opp shows as Closed Won only because of the
  // Discovery->Closed Won reclassification; drives the Stage-column "i" tooltip.
  overageReclassified?: boolean;
  region: string;
  group: string;
  flm: string;
  slm: string;
  modDate?: string;
  declinedBalance?: number;
  probabilityOverride?: number | null;
  stageDefaultProbability?: number | null;
  effectiveProbability?: number | null;
  isReviewed?: boolean;
  lineItems?: LineItem[];
  // Mod-only fields populated by mapModToOpp() when mode === "mods".
  // All optional so non-mods opps can ignore them.
  churnType?: string;
  opportunityId?: string | null;
  contactId?: string;
  contactName?: string;
  reason?: string;
  description?: string;
  segment?: string;
  // Special marker for the synthetic pinned Manager Estimate row in the
  // Sched Mods drilldown. When true, the row bypasses standard rendering
  // and uses fixed display values per spec.
  isManagerEstimate?: boolean;
  // Per-product breakdown for the pinned ME row's expansion sub-rows.
  meProductBreakdown?: Array<{ product: string; amount: number }>;
  // Showcase Incremental - Re/Max (SCI-R) rows are synthesized from a
  // Databricks CPDs table whose accountId / oppId are NOT real Salesforce
  // Account / Opportunity IDs — they're synthetic dedupe keys. The real
  // Salesforce link targets (Contact for accountName, Compensation__c
  // record for oppName) ride along on these fields so the drilldown can
  // build correct Lightning URLs for SCI-R rows.
  sfContactId?: string;
  sfCpdId?: string;
}

// Builds the correct Salesforce hyperlink for a drilldown opportunity.
// CPD-derived synthetic rows (SCI-R Re/Max and ZMX) route to Contact /
// Compensation__c Lightning records because their accountId / oppId are
// synthetic keys, not real SF Account / Opportunity IDs. The real SF link
// targets ride along on sfContactId / sfCpdId. All other rows fall back to
// the classic /<id> Salesforce URL used everywhere else in this view.
function sfLinkFor(opp: Opportunity, kind: "account" | "opp"): string {
  if (opp.product === "Showcase Incremental - Re/Max" || opp.product === "ZMX") {
    if (kind === "account" && opp.sfContactId) {
      return `${SF_LIGHTNING}/Contact/${opp.sfContactId}/view`;
    }
    if (kind === "opp" && opp.sfCpdId) {
      return `${SF_LIGHTNING}/Compensation__c/${opp.sfCpdId}/view`;
    }
  }
  return sfClassicRecordUrl(kind === "account" ? opp.accountId : opp.oppId);
}

export type DrilldownMode = "stage" | "mrr" | "churn" | "mods" | "opps" | "demos";

type SortKey = "oppName" | "accountName" | "manager" | "rep" | "closeDate" | "type" | "quoteType" | "product" | "amount" | "mrr" | "compensableMrr" | "multipliers" | "rules" | "mrrField" | "funnelStage" | "modDate" | "declinedBalance" | "probability" | "churnType" | "contactName" | "reason";

// Task #276/#314: human-readable labels for the appliedMrrField code shown in
// the drilldown's "MRR Field" column. CPD-object columns use their raw names.
const MRR_FIELD_LABELS: Record<string, string> = {
  changeInMrr: "Change in MRR",
  totalMrr: "Total MRR",
  splitTotalPrice: "Split Total Price",
  totalPrice: "Total Price",
  amount: "Amount",
  mrr: "MRR",
  mrr_added: "mrr_added",
  positive_change_in_mrr: "positive_change_in_mrr",
  negative_change_in_mrr: "negative_change_in_mrr",
};

interface DrilldownAuthUser {
  role?: string | null;
  hierarchyName?: string | null;
  viewOnly?: boolean;
}
type SortDir = "asc" | "desc";

// Task #437: gate Closed-Won on the EFFECTIVE funnel stage (mapRowToOpp sets
// `funnelStage` = effectiveFunnelStage, which reclassifies Overage Discovery
// rows to Closed Won). The raw `o.stage` excluded those reclassified rows, so
// the mrr/churn drilldowns under-counted vs. the cards and the stage drilldown.
const isEffectiveClosedWon = (o: { funnelStage?: string }) =>
  o.funnelStage === "Closed Won";

const strKeys = new Set<string>(["oppName", "accountName", "manager", "rep", "type", "quoteType", "product", "funnelStage"]);

function parseDate(d: string): number {
  const t = Date.parse(d);
  return isNaN(t) ? 0 : t;
}

interface FunnelDrilldownModalProps {
  stage: string;
  mode: DrilldownMode;
  filters: FilterState;
  nameFilter?: string;
  nameFilterDimension?: AggregateBy;
  mrrMode?: "gnrNet" | "acqNet" | "added";
  // Task #241: the opp fetch is scoped to compensation-adjusted MRR for the
  // active revenue mode (rules are scoped per mode server-side) and FUB↔Zpro
  // pairs are linked in the row treatment.
  revenueMode?: "quota" | "sales";
  modsFrom?: string;
  modsTo?: string;
  pipelineMode?: "closeDate" | "allOpen";
  // Optional product-scope override. When provided, this list takes
  // precedence over filters.products for client-side filtering only —
  // it narrows the in-memory line-item + opp lists and the active-filter
  // summary text, but the modal does NOT re-issue an API request scoped
  // to it (the base `filters` prop still drives the original fetches).
  // Used by the GNR Churn Forecast popup (Task #116) to drill into a
  // single product's mods regardless of the dashboard's current product
  // filter.
  productFilter?: string[];
  // Optional per-row churn-type filter applied client-side when
  // mode === "mods". Used by the GNR Churn Forecast popup's per-Churn-Type
  // rows (Task #157) so clicking "CC Decline" pre-filters the mods
  // drilldown to that churn type. No UI chip in v1 — the filter is
  // hidden but visible in row counts.
  churnTypeFilter?: string;
  // Task #250: when true (compensable mode only), narrow the visible list to
  // opps that have at least one applied compensation rule — the same
  // "rule-affected" definition as the CSV/XLSX export (rules > 0, covering 1x
  // multiplier rules AND FUB↔Zpro linking). Defaults off so other entry points
  // are unaffected. Applied inside filteredOpps so every derived view (sort,
  // totals, header summary, CSV) reflects the rule-affected-only set.
  ruleAffectedOnly?: boolean;
  onClose: () => void;
  authUser?: DrilldownAuthUser;
  onProbabilityChanged?: () => void;
}

export default function FunnelDrilldownModal({ stage, mode, filters, nameFilter, nameFilterDimension, mrrMode = "gnrNet", revenueMode = "quota", modsFrom, modsTo, pipelineMode = "closeDate", productFilter, churnTypeFilter, ruleAffectedOnly = false, onClose, authUser, onProbabilityChanged }: FunnelDrilldownModalProps) {
  // Apply the productFilter override (if provided) by composing a derived
  // FilterState. This composed filter drives client-side filtering only —
  // the modal never re-issues an API request scoped to it. It seeds
  // `productFilterSet` (used to filter line items + opps in-memory) and
  // the active-filter summary text. The base `filters` prop still drives
  // the original API requests; the override only narrows what we render.
  const effectiveFilters = useMemo<FilterState>(() => {
    if (!productFilter || productFilter.length === 0) return filters;
    return { ...filters, products: productFilter };
  }, [filters, productFilter]);
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  // Task #483: non-null when the opportunities fetch failed (network error,
  // non-OK status, or an oversized/truncated response). Drives an actionable
  // error state with a Retry, distinct from the "no opportunities" empty state.
  const [fetchError, setFetchError] = useState<string | null>(null);
  const defaultSort: SortKey = mode === "mrr" ? "mrr" : "amount";
  const isMods = mode === "mods";
  const [sortKey, setSortKey] = useState<SortKey>(defaultSort);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [searchId, setSearchId] = useState("");
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  // Independent set keyed by oppId for the multi-product line-item expansion.
  // Kept separate from `expandedRows` (which drives the linked-opp caret)
  // so a single row can have both expansions toggled independently.
  const [expandedMulti, setExpandedMulti] = useState<Set<string>>(new Set());
  // Outer-level expansion: keyed by accountId (or `acct:${accountName}` when
  // accountId is missing — e.g. mods rows). Drives the account caret on
  // multi-opp aggregated rows. Always defaults to collapsed on open; not
  // persisted between modal opens.
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());

  const hasCRMode = (mode === "churn" || mode === "mrr" || mode === "stage") && (mrrMode === "acqNet" || mrrMode === "added" || mrrMode === "gnrNet");
  // Task #246/#344: both revenue modes (quota/sales) are compensation-adjusted
  // now, so revenue surfaces always reshape — Amount is hidden and the MRR
  // column shows RAW (untreated) MRR with three columns (Compensable MRR /
  // Multipliers / Rules) to its right. Activity drilldowns (opps/demos) are NOT
  // revenue surfaces, so they keep the legacy Amount/MRR columns.
  const isComp = mode !== "opps" && mode !== "demos";
  // Task #358: the compensable column set (Compensable MRR / Multipliers /
  // Rules / MRR Field) only renders in the non-mods opp table. Mods get their
  // own column layout even though isComp is technically true for them.
  const isCompCols = isComp && !isMods;
  // Task #358: the Compensable MRR header tracks the active revenue mode so the
  // label matches what the user selected ("Quota Target MRR" vs
  // "Sales Target MRR"). Underlying sort key/value stay "compensableMrr".
  const compMrrLabel = revenueMode === "sales" ? "Sales Target MRR" : "Quota Target MRR";
  // Task #406: raw MRR is internal — only Admins see the raw MRR header total
  // and "Raw MRR" column (incl. CSV). Uses the same authUser.role gate already
  // used elsewhere in this modal (e.g. canEditOppProb).
  const isAdmin = authUser?.role === "admin";
  const [showChurnLogic, setShowChurnLogic] = useState(false);
  // "Only unreviewed" toggle: narrows the visible list to opps whose
  // probability has not been edited (effectiveProbability still equals the
  // stage default — same condition that drives the yellow highlight on the
  // probability cell). Applies in both opportunity and scheduled-mod modes.
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(false);
  // Rule-name multi-select for the rule-affected (compensable) drilldown. Empty
  // = show all rule-affected opps (today's behavior). Non-empty narrows to opps
  // that had at least one of the selected rules applied.
  const [selectedRuleNames, setSelectedRuleNames] = useState<string[]>([]);
  const [ruleFilterOpen, setRuleFilterOpen] = useState(false);
  // Task #358: rule names configured for the drilldown's month, sourced from
  // the comp config endpoint so the picklist lists every rule — even ones that
  // match zero opps in the current view. Empty until the config loads (or when
  // the drilldown is not a compensable opp table).
  const [configRuleNames, setConfigRuleNames] = useState<string[]>([]);
  const ruleFilterRef = useRef<HTMLDivElement>(null);
  const churnLogicRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showChurnLogic) return;
    const handler = (e: MouseEvent) => {
      if (churnLogicRef.current && !churnLogicRef.current.contains(e.target as Node)) setShowChurnLogic(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showChurnLogic]);

  useEffect(() => {
    if (!ruleFilterOpen) return;
    const handler = (e: MouseEvent) => {
      if (ruleFilterRef.current && !ruleFilterRef.current.contains(e.target as Node)) setRuleFilterOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ruleFilterOpen]);

  const apiBase = import.meta.env.BASE_URL || "/";

  // Task #358: month (YYYY-MM) used to load the comp config for the rules
  // picklist. Derived from the active timeframe: when the range stays inside a
  // single month we use that month; when it spans months (or is open-ended) we
  // fall back to the current month, per spec.
  const compMonth = useMemo(() => {
    const nowMonth = new Date().toISOString().slice(0, 7);
    const range = getDateRange(filters.timeframe, filters.customRange);
    const fromM = range.from ? range.from.slice(0, 7) : "";
    const toM = range.to ? range.to.slice(0, 7) : "";
    if (fromM && toM && fromM === toM) return fromM;
    return nowMonth;
  }, [filters.timeframe, filters.customRange]);

  // Task #358/#397: load the configured rule names for the picklist so rules
  // that match zero opps still appear. The picklist lists EVERY rule configured
  // for the month — both multiplier and paired-opp rules — regardless of which
  // revenue mode they're scoped to and regardless of whether a paired-opp rule
  // is enabled. Labels are collapsed to the displayed names produced by
  // ruleNamesOf (rule labels).
  useEffect(() => {
    if (!isCompCols) { setConfigRuleNames([]); return; }
    let cancelled = false;
    fetch(`${apiBase}api/sales/compensation/config?month=${encodeURIComponent(compMonth)}`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : null))
      .then((data: { config?: { multiplierRules?: { label?: string; appliesIn?: string | null }[]; pairedOppRules?: { label?: string; enabled?: boolean; appliesIn?: string | null }[] } } | null) => {
        if (cancelled || !data?.config) return;
        const names = new Set<string>();
        for (const r of data.config.multiplierRules ?? []) {
          if (r.label) names.add(r.label);
        }
        for (const r of data.config.pairedOppRules ?? []) {
          if (r.label) names.add(r.label);
        }
        setConfigRuleNames(Array.from(names));
      })
      .catch(() => { /* keep last good / fall back to opp-derived names */ });
    return () => { cancelled = true; };
  }, [isCompCols, apiBase, compMonth]);

  const fetchOpps = useCallback((showSpinner: boolean = true) => {
    if (showSpinner) setLoading(true);
    const dateRange = getDateRange(filters.timeframe, filters.customRange);
    const dateParams = new URLSearchParams();
    if (dateRange.from) dateParams.set("from", dateRange.from);
    if (dateRange.to) dateParams.set("to", dateRange.to);
    const dateSuffix = dateParams.toString() ? `&${dateParams.toString()}` : "";
    // Task #241: opportunity endpoints honor revenueMode (server re-gates by
    // role). mods/opps/demos are not revenue surfaces, so they omit it.
    const revSuffix = `&revenueMode=${revenueMode}`;
    // Task #361: admin-only raw Conditions. Mirror the Pipeline aggregates so a
    // drilldown reflects the same slice. Only sent for admins; the server
    // ignores it for everyone else regardless of what's sent.
    const condSuffix = (() => {
      if (authUser?.role !== "admin") return "";
      const valid = (filters.rawConditions ?? []).filter(
        (c) => c.field && c.value.trim() !== "",
      );
      return valid.length > 0
        ? `&rawConditions=${encodeURIComponent(JSON.stringify(valid))}`
        : "";
    })();
    const isClosedWon = stage === "Closed Won";
    const isAllStages = stage === "All Stages";
    // Task #483: the ACQ Closed Won drilldown and every Churn drilldown only
    // need the Closed Won slice client-side, so ask the server to scope to it
    // (closedWon=1). This keeps the response small enough to clear the
    // deployment proxy's size limit — the whole-org MRR payload otherwise fails
    // to load (consistently in prod, intermittently in dev). "All Stages"
    // genuinely needs every stage, so it stays unscoped (gzip helps there).
    let url: string;
    if (mode === "stage" && mrrMode === "acqNet" && isClosedWon) {
      url = `${apiBase}api/sales/opportunities?type=mrr${dateSuffix}${revSuffix}${condSuffix}&closedWon=1`;
    } else if (mode === "stage" && isAllStages) {
      url = `${apiBase}api/sales/opportunities?type=mrr${dateSuffix}${revSuffix}${condSuffix}`;
    } else if (mode === "stage") {
      const modeSuffix = pipelineMode === "allOpen" ? `&pipelineMode=allOpen` : "";
      url = `${apiBase}api/sales/opportunities?stage=${encodeURIComponent(stage)}${dateSuffix}${modeSuffix}${revSuffix}${condSuffix}`;
    } else if (mode === "opps") {
      url = `${apiBase}api/sales/opps-created?timeframe=${filters.timeframe}${dateSuffix}`;
    } else if (mode === "demos") {
      url = `${apiBase}api/sales/demos?timeframe=${filters.timeframe}${dateSuffix}`;
    } else if (mode === "churn" && (mrrMode === "acqNet" || mrrMode === "gnrNet")) {
      url = `${apiBase}api/sales/opportunities?type=mrr${dateSuffix}${revSuffix}${condSuffix}&closedWon=1`;
    } else if (mode === "mods") {
      const modsParams = new URLSearchParams();
      if (modsFrom) modsParams.set("from", modsFrom);
      if (modsTo) modsParams.set("to", modsTo);
      const modsSuffix = modsParams.toString() ? `&${modsParams.toString()}` : "";
      url = `${apiBase}api/sales/opportunities?type=mods${modsSuffix}${condSuffix}`;
    } else {
      url = `${apiBase}api/sales/opportunities?type=${mode}${dateSuffix}${condSuffix}`;
    }
    type ModOpp = {
      oppId?: string; oppName: string; accountName: string; manager: string; rep: string;
      // New columns from the Databricks-backed loader (task #153 migration).
      // `opportunityType` replaces the legacy `oppType`; mapping below keeps
      // both code paths working during cutover.
      oppType?: string; opportunityType?: string;
      product?: string; modDate: string; amount: number;
      region: string; group: string; flm: string; slm: string;
      stageDefaultProbability?: number | null; probabilityOverride?: number | null; effectiveProbability?: number | null; isReviewed?: boolean;
      churnType?: string; opportunityId?: string | null;
      contactId?: string; contactName?: string; segment?: string;
      reason?: string; description?: string;
    };
    const mapModToOpp = (m: ModOpp): Opportunity => ({
      oppName: m.oppName,
      accountName: m.accountName,
      accountId: "",
      oppId: m.oppId || "",
      manager: m.manager,
      rep: m.rep,
      salesRole: "",
      closeDate: m.modDate || "",
      type: m.opportunityType || m.oppType || "",
      quoteType: "",
      product: m.product || "No Product Selected",
      amount: m.amount,
      mrr: 0,
      stage: "",
      funnelStage: "Scheduled Mods",
      region: m.region,
      group: m.group,
      flm: m.flm,
      slm: m.slm,
      stageDefaultProbability: m.stageDefaultProbability ?? null,
      probabilityOverride: m.probabilityOverride ?? null,
      effectiveProbability: m.effectiveProbability ?? null,
      isReviewed: m.isReviewed ?? false,
      churnType: m.churnType || "",
      opportunityId: m.opportunityId ?? null,
      contactId: m.contactId || "",
      contactName: m.contactName || m.accountName || "",
      reason: m.reason || "",
      description: m.description || "",
      segment: m.segment || "",
    });
    fetch(url, { credentials: "include" })
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        const raw = data.opportunities || [];
        setOpps(isMods ? raw.map(mapModToOpp) : raw);
        setFetchError(null);
        setLoading(false);
      })
      .catch(() => {
        // Task #483: surface failures instead of silently leaving an empty
        // list. A failed/non-OK request or an unparseable body (e.g. an
        // oversized response truncated by the proxy) now shows an actionable
        // error + Retry. Only wipe the current list on a foreground load so a
        // transient background refresh failure keeps the last good data.
        if (showSpinner) setOpps([]);
        setFetchError(
          "Couldn't load opportunities — the request failed or the result was too large to load. Try narrowing the date range or selecting a single product, then retry.",
        );
        setLoading(false);
      });
  }, [stage, mode, apiBase, filters.timeframe, filters.customRange, filters.rawConditions, mrrMode, revenueMode, modsFrom, modsTo, pipelineMode, authUser?.role]);

  useEffect(() => { fetchOpps(true); }, [fetchOpps]);

  useEffect(() => {
    const id = window.setInterval(() => { fetchOpps(false); }, 30000);
    return () => window.clearInterval(id);
  }, [fetchOpps]);

  // ----------------- Pinned Manager Estimate row state (mods only) -------
  // The pinned ME row at the top of the Sched Mods drilldown sums the
  // per-product, per-FLM Manager Estimate matrix for the active scope. We
  // fetch the raw ME rows for the currently-viewed month and apply
  // client-side scope filters (FLM/products) on top.
  type ManagerEstimateRowApi = {
    flmName: string;
    repName?: string;
    monthYyyymm: string;
    product: string;
    unweightedAmount: number;
    // Server-rolled-up weighted = sum(per-rep share × override prob/100).
    // Defaults to the unweighted amount when no override exists.
    weightedAmount?: number;
    probabilityPct?: number;
    // Per-rep-mode: true iff that rep × product override row has
    // `reviewed_at` set. Per-FLM mode: true iff every rep on that FLM's
    // team has a reviewed override for the product. Drives the per-product
    // yellow "unreviewed" highlight on the pinned ME row's expansion.
    isReviewed?: boolean;
  };
  const [meRows, setMeRows] = useState<ManagerEstimateRowApi[]>([]);
  const [meExpanded, setMeExpanded] = useState(false);
  // Per-product probability error messages keyed by product. The draft
  // value itself lives inside `MEProductProbabilityCell` so keystrokes
  // don't re-render the parent (which would unmount the input and kill
  // focus + the debounce timer — the bug fixed in Task #160). Errors
  // are still parent-owned so a failed save can surface a message that
  // outlives the input losing focus.
  const [meProbErrorByProduct, setMeProbErrorByProduct] = useState<Record<string, string | null>>({});
  // Bumped after every per-product write attempt (success OR failure)
  // so the cell's resync effect always runs against the freshly fetched
  // server value — even when `effectivePct` happens to round-trip back
  // to the same number after a failed save (otherwise the typed-but-
  // not-saved value would stick on screen).
  const [meProbSyncTickByProduct, setMeProbSyncTickByProduct] = useState<Record<string, number>>({});

  // Shared tooltip helper for the Reason → Description hover. Lifted from
  // EmailDrilldownModal into a hook so both modals stay in lock-step.
  const reasonTip = useDelayedTooltip();

  // Derive the "currently-viewed month" (yyyymm) for the ME pin. We prefer
  // `modsTo` when present (matches the Cancellation Date semantics of the
  // Sched Mods Window), then fall back to today.
  const viewedMonthYyyymm = useMemo(() => {
    const src = (modsTo && modsTo.length >= 7) ? modsTo : new Date().toISOString().slice(0, 10);
    return src.slice(0, 4) + src.slice(5, 7);
  }, [modsTo]);
  const monthEndDateStr = useMemo(() => {
    const y = parseInt(viewedMonthYyyymm.slice(0, 4), 10);
    const m = parseInt(viewedMonthYyyymm.slice(4, 6), 10);
    if (!y || !m) return "";
    const d = new Date(Date.UTC(y, m, 0));
    return d.toISOString().slice(0, 10);
  }, [viewedMonthYyyymm]);

  // Rep names that scope this drilldown — sourced from the dashboard's
  // rep filter and from a "Rep" name filter (e.g. clicking a rep cell).
  // When non-empty, the ME endpoint returns per-rep shares so the pinned
  // row reflects each rep's slice (FLM amount / # reps on team).
  const repsScope = useMemo(() => {
    const set = new Set<string>();
    for (const r of filters.rep) if (r) set.add(r);
    if (nameFilterDimension === "Rep" && nameFilter) set.add(nameFilter);
    return Array.from(set);
  }, [filters.rep, nameFilter, nameFilterDimension]);

  const fetchMeRows = useCallback(() => {
    if (!isMods) return;
    const params = new URLSearchParams();
    params.set("month", `${viewedMonthYyyymm.slice(0, 4)}-${viewedMonthYyyymm.slice(4, 6)}`);
    // Scope the Manager Estimate fetch to match the active drilldown scope
    // so the pinned ME row reconciles with the clicked Scheduled Mods bar.
    // An FLM-dimension team click scopes STRICTLY to the clicked FLM
    // (mirroring the real-opp filter `o.flm === nameFilter`), so the pinned
    // ME reflects only that team rather than the union of every globally
    // filtered FLM. Otherwise fall back to the global FLM filter.
    // An SLM-dimension team click is resolved to its FLMs server-side via
    // the `slm` param (intersected with any global FLM filter). A
    // Rep-dimension click flows through `repsScope`.
    const flmList = nameFilterDimension === "FLM" && nameFilter
      ? [nameFilter]
      : filters.flm;
    if (flmList.length > 0) params.set("flms", flmList.join(","));
    if (nameFilterDimension === "SLM" && nameFilter) params.set("slm", nameFilter);
    if (repsScope.length > 0) params.set("reps", repsScope.join(","));
    fetch(`${apiBase}api/sales/manager-estimates?${params.toString()}`, { credentials: "include" })
      .then(r => r.json())
      .then(data => {
        setMeRows(Array.isArray(data?.estimates) ? data.estimates : []);
      })
      .catch(() => { /* keep last good */ });
  }, [isMods, apiBase, viewedMonthYyyymm, filters.flm, repsScope, nameFilter, nameFilterDimension]);

  useEffect(() => { fetchMeRows(); }, [fetchMeRows]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const isClosedWonStage = stage === "Closed Won";
  const isAllStagesMode = stage === "All Stages";

  // Active product filter as a Set, or null when no filter is active.
  // Used to (a) decide which opps qualify and (b) decide which line items
  // contribute to a row's displayed MRR/Amount totals.
  const productFilterSet = useMemo<Set<string> | null>(
    () => effectiveFilters.products.length > 0 ? new Set(effectiveFilters.products) : null,
    [effectiveFilters.products],
  );
  // Returns the line items for an opp, falling back to a single synthetic
  // item built from `product`/`mrr`/`amount` when the API didn't supply any
  // (e.g. the mods endpoint, or older payloads).
  const lineItemsOf = useCallback((o: Opportunity): LineItem[] => {
    if (o.lineItems && o.lineItems.length > 0) return o.lineItems;
    return [{ product: o.product || "", mrr: o.mrr || 0, amount: o.amount || 0 }];
  }, []);
  // Multi-product = 2+ source split rows (per spec, even if products repeat).
  const isMultiOpp = useCallback((o: Opportunity) => (o.lineItems?.length ?? 0) >= 2, []);
  // Subset of line items that survive the active product filter (or all when
  // no filter). Driven by `productFilterSet`.
  const matchedLineItems = useCallback((o: Opportunity): LineItem[] => {
    const lis = lineItemsOf(o);
    if (!productFilterSet) return lis;
    return lis.filter(li => productFilterSet.has(li.product));
  }, [lineItemsOf, productFilterSet]);
  const displayedMrr = useCallback(
    (o: Opportunity) => matchedLineItems(o).reduce((s, li) => s + (li.mrr || 0), 0),
    [matchedLineItems],
  );
  const displayedAmount = useCallback(
    (o: Opportunity) => matchedLineItems(o).reduce((s, li) => s + (li.amount || 0), 0),
    [matchedLineItems],
  );
  // Product cell label: "Multiple" only when an opp's line items span more than
  // one DISTINCT product; if every line item is the same product (even across
  // many line items) we keep the product name. Sort key for the Product column
  // also uses this so genuinely-multi-product rows alphabetize under M.
  const displayedProduct = useCallback(
    (o: Opportunity) => {
      const items = lineItemsOf(o);
      const distinct = new Set(items.map(li => li.product || ""));
      if (distinct.size > 1) return "Multiple";
      return items[0]?.product || "";
    },
    [lineItemsOf],
  );
  // Task #246: RAW (untreated) MRR — the pre-multiplier MRR. In Compensable
  // Revenue mode this drives the MRR column (compensable is shown separately).
  // Falls back to li.mrr when rawMrr is absent (Total mode / older payloads).
  const displayedRawMrr = useCallback(
    (o: Opportunity) => matchedLineItems(o).reduce((s, li) => s + (li.rawMrr ?? li.mrr ?? 0), 0),
    [matchedLineItems],
  );
  // Effective combined multiplier for an opp (compensable ÷ raw). Used only to
  // sort the Multipliers column; the visible text is built by multipliersText.
  const combinedMultiplier = useCallback(
    (o: Opportunity) => {
      const raw = displayedRawMrr(o);
      return raw !== 0 ? displayedMrr(o) / raw : 1;
    },
    [displayedRawMrr, displayedMrr],
  );
  // Distinct rule names applied across an opp's matched line items. FUB↔Zpro
  // pair rows carry the synthetic "FUB↔Zpro Linking" name, so the pairing
  // counts as a single rule. Drives the Rules count + its hover tooltip.
  const ruleNamesOf = useCallback(
    (o: Opportunity): string[] => {
      const set = new Set<string>();
      for (const li of matchedLineItems(o)) {
        for (const n of li.ruleNames ?? []) set.add(n);
      }
      return Array.from(set);
    },
    [matchedLineItems],
  );
  // Human-readable Multipliers cell. Paired-opp rows show the adjustment label
  // the engine produced (e.g. "Side B: × 0.1", "Side B: |B| − |A|"). Otherwise
  // the applied rule multipliers are listed as decimals ("1.1x, 0.5x"), or "1x"
  // when no multiplier applied.
  const multipliersText = useCallback(
    (o: Opportunity): string => {
      const matched = matchedLineItems(o);
      const paired = matched.find((li) => li.pairAdjustmentLabel);
      if (paired?.pairAdjustmentLabel) return paired.pairAdjustmentLabel;
      const muls = matched.flatMap((li) => li.multipliers ?? []);
      if (muls.length === 0) return "1x";
      // Show each DISTINCT multiplier once across all line items/products
      // (e.g. five line items at 1.1x render as "1.1x", not "1.1x, 1.1x, …").
      const distinct = Array.from(new Set(muls));
      return distinct.map((m) => `${m}x`).join(", ");
    },
    [matchedLineItems],
  );

  // Centered Rules count cell with a visible hover affordance: when an opp has
  // applied rules, the count renders as a chip with a help cursor so users know
  // hovering reveals the rule-name popup. Zero shows a plain muted "0".
  const renderRulesCount = useCallback(
    (names: string[]) => {
      if (names.length === 0) {
        return (
          <span className="flex w-full justify-center tabular-nums text-muted-foreground">0</span>
        );
      }
      return (
        <span className="flex w-full justify-center">
          <span
            className="inline-flex items-center justify-center min-w-[20px] px-1.5 py-0.5 rounded-md tabular-nums font-medium cursor-help bg-black/5 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20 transition-colors"
            onMouseEnter={(ev: React.MouseEvent) => reasonTip.showTooltipDelayed(names.join("\n"), ev, "Rules")}
            onMouseMove={reasonTip.trackMouseMove}
            onMouseLeave={reasonTip.hideTooltip}
          >
            {names.length}
          </span>
        </span>
      );
    },
    [reasonTip],
  );

  const toggleExpandMulti = useCallback((id: string) => {
    setExpandedMulti(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const accountKeyOf = useCallback(
    (o: Opportunity) => {
      // Sched Mods rows carry no real Account; if we group them by the
      // (empty) accountId / contact name they all collapse into one
      // mega-group, hiding rows behind an unreachable caret. Force each
      // mod to its own group keyed on oppId.
      if (isMods) return `mod-row:${o.oppId || `${o.rep}|${o.product}|${o.closeDate}`}`;
      return o.accountId || `acct:${o.accountName ?? ""}`;
    },
    [isMods],
  );

  const toggleExpandAccount = useCallback((key: string) => {
    setExpandedAccounts(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Opps in the rule-affected drilldown's scope BEFORE the rule-name selection
  // and the text search are applied. Used both as the base for `filteredOpps`
  // and to derive the rule-name multi-select option list (so selecting a rule
  // never removes other rules from the options).
  const ruleScopeOpps = useMemo(() => {
    let res = opps;
    if (mrrMode === "added" && (mode === "stage" || mode === "mrr")) {
      if (mode === "mrr") {
        res = res.filter(o => isEffectiveClosedWon(o) && o.mrr > 0);
      } else if (mode === "stage" && !isClosedWonStage && !isAllStagesMode) {
      } else if (mode === "stage" && isAllStagesMode) {
        res = res.filter(o => o.funnelStage !== "Closed Won" || o.mrr > 0);
      } else {
        res = res.filter(o => o.mrr > 0);
      }
    } else if (mrrMode === "added" && mode === "churn") {
      res = res.filter(o => o.mrr < 0 && isEffectiveClosedWon(o));
    } else if (mrrMode === "gnrNet" && mode === "churn") {
      res = res.filter(o => o.mrr < 0 && isEffectiveClosedWon(o));
    } else if (mrrMode === "gnrNet" && (mode === "stage" || mode === "mrr")) {
      if (mode === "mrr") {
        res = res.filter(o => isEffectiveClosedWon(o));
      }
    } else if (mrrMode === "acqNet" && (mode === "stage" || mode === "mrr" || mode === "churn")) {
      const positiveKeys = new Set<string>();
      for (const o of opps) {
        if (o.mrr > 0 && isEffectiveClosedWon(o)) {
          positiveKeys.add(`${o.rep}||${o.accountId || ""}||${o.product || ""}`);
        }
      }
      if (mode === "churn") {
        res = res.filter(o => {
          if (o.mrr >= 0) return false;
          if (!isEffectiveClosedWon(o)) return false;
          const key = `${o.rep}||${o.accountId || ""}||${o.product || ""}`;
          return positiveKeys.has(key);
        });
      } else if (mode === "stage") {
        if (isAllStagesMode) {
          res = res.filter(o => {
            if (o.funnelStage !== "Closed Won") return true;
            if (o.mrr >= 0) return true;
            const key = `${o.rep}||${o.accountId || ""}||${o.product || ""}`;
            return positiveKeys.has(key);
          });
        } else if (!isClosedWonStage) {
          res = res.filter(o => o.funnelStage === stage);
        } else {
          res = res.filter(o => {
            if (o.funnelStage !== stage) return false;
            if (o.mrr >= 0) return true;
            const key = `${o.rep}||${o.accountId || ""}||${o.product || ""}`;
            return positiveKeys.has(key);
          });
        }
      } else {
        res = res.filter(o => {
          if (!isEffectiveClosedWon(o)) return false;
          if (o.mrr >= 0) return true;
          const key = `${o.rep}||${o.accountId || ""}||${o.product || ""}`;
          return positiveKeys.has(key);
        });
      }
    }
    if (nameFilter && nameFilterDimension) {
      switch (nameFilterDimension) {
        case "Rep": res = res.filter(o => o.rep === nameFilter); break;
        case "FLM": res = res.filter(o => o.flm === nameFilter); break;
        case "SLM": res = res.filter(o => o.slm === nameFilter); break;
        case "Region": res = res.filter(o => o.region === nameFilter); break;
        case "Segment": res = res.filter(o => (o as any).segment === nameFilter); break;
      }
    }
    if (filters.slm.length > 0) res = res.filter(o => filters.slm.includes(o.slm));
    if (filters.flm.length > 0) res = res.filter(o => filters.flm.includes(o.flm));
    if (nameFilterDimension !== "Rep" && filters.rep.length > 0) res = res.filter(o => filters.rep.includes(o.rep));
    if (filters.region.length > 0) res = res.filter(o => filters.region.includes(o.region));
    if (filters.segment.length > 0) res = res.filter(o => filters.segment.includes((o as any).segment));
    res = res.filter(o => passesChannelFilter(o.group, filters.group));
    if (productFilterSet) {
      // An opp qualifies if at least one of its line items matches the
      // active product filter. Each row's MRR/Amount is later summed only
      // over the matching items (see displayedMrr / displayedAmount).
      res = res.filter(o => lineItemsOf(o).some(li => productFilterSet.has(li.product)));
    }
    // Task #157: per-Churn-Type rows in the GNR Churn Forecast popup
    // open the mods drilldown pre-filtered to the row's churn type.
    if (isMods && churnTypeFilter) {
      res = res.filter(o => (o.churnType || "") === churnTypeFilter);
    }
    // Task #250: rule-affected-only narrowing (compensable mode). Mirrors the
    // export's "matched" definition: keep opps with >=1 applied rule, where the
    // synthetic "FUB↔Zpro Linking" name counts as a rule (so paired opps stay).
    if (ruleAffectedOnly) {
      res = res.filter(o => ruleNamesOf(o).length > 0);
    }
    return res;
  }, [opps, filters, productFilterSet, lineItemsOf, nameFilter, nameFilterDimension, mrrMode, mode, isMods, churnTypeFilter, ruleAffectedOnly, ruleNamesOf]);

  // Task #358: the opps the rule picklist facets against — everything in the
  // rule scope with the text search applied but BEFORE the rule multi-select.
  // This is the base both for the per-rule facet counts and for filteredOpps,
  // so each rule's badge reflects rep/region/timeframe/search but ignores the
  // rule selection itself.
  const facetBaseOpps = useMemo(() => {
    let res = ruleScopeOpps;
    if (searchId.trim()) {
      const q = searchId.trim().toLowerCase();
      res = res.filter(o => o.oppId?.toLowerCase().includes(q) || o.oppName?.toLowerCase().includes(q));
    }
    return res;
  }, [ruleScopeOpps, searchId]);

  // Rule names for the multi-select control, available on every compensable
  // drilldown (Task #358). Primary source is the month's configured rule set
  // (so rules matching zero opps still appear); merged with names actually seen
  // on the current opps as a fallback. Sorted alphabetically. The synthetic
  // "FUB↔Zpro Linking" pair name is already collapsed into rule labels by
  // ruleNamesOf, matching the config labels.
  const ruleNameOptions = useMemo(() => {
    if (!isCompCols) return [] as string[];
    const set = new Set<string>(configRuleNames);
    for (const o of facetBaseOpps) for (const n of ruleNamesOf(o)) set.add(n);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [isCompCols, configRuleNames, facetBaseOpps, ruleNamesOf]);

  // Task #358: per-rule facet counts — number of opps in the facet base
  // affected by each rule. Respects every active filter except the rule
  // multi-select. Rules with no matches are absent here and render as a greyed 0.
  const ruleFacetCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!isCompCols) return counts;
    for (const o of facetBaseOpps) {
      for (const n of ruleNamesOf(o)) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return counts;
  }, [isCompCols, facetBaseOpps, ruleNamesOf]);

  const filteredOpps = useMemo(() => {
    let res = facetBaseOpps;
    // Task #326/#358: rule-name multi-select. When one or more rules are
    // selected, keep only opps whose applied rule names intersect the
    // selection. Available on all compensable drilldowns. Empty selection
    // leaves the full list intact.
    if (isCompCols && selectedRuleNames.length > 0) {
      const sel = new Set(selectedRuleNames);
      res = res.filter(o => ruleNamesOf(o).some(n => sel.has(n)));
    }
    return res;
  }, [facetBaseOpps, isCompCols, selectedRuleNames, ruleNamesOf]);

  const isUnreviewed = useCallback((o: Opportunity) => {
    return o.isReviewed === false;
  }, []);
  const unreviewedInScope = useMemo(() => filteredOpps.filter(isUnreviewed).length, [filteredOpps, isUnreviewed]);
  // visibleOpps narrows filteredOpps when the "Only unreviewed" toggle is on.
  // Everything downstream (sort, totals, header summary, CSV) keys off this so
  // the toggle behaves like a true filter, not just a row-hider.
  const visibleOpps = useMemo(
    () => onlyUnreviewed ? filteredOpps.filter(isUnreviewed) : filteredOpps,
    [filteredOpps, onlyUnreviewed, isUnreviewed],
  );

  const linkedPositiveOpps = useMemo(() => {
    if (!hasCRMode) return new Map<string, Opportunity[]>();
    const map = new Map<string, Opportunity[]>();
    for (const o of opps) {
      if (o.mrr > 0 && isEffectiveClosedWon(o)) {
        const key = `${o.rep}||${o.accountId || ""}||${o.product || ""}`;
        const arr = map.get(key) || [];
        arr.push(o);
        map.set(key, arr);
      }
    }
    return map;
  }, [opps, hasCRMode]);

  // In Compensable Revenue mode, group opps by their paired-opp rule pair key so
  // the row treatment can link the grouped rows (reusing the same linked-opp
  // affordance as paired-opp rules). The server emits pairOppName/pairKey.
  const pairedOppGroups = useMemo(() => {
    if (!isComp) return new Map<string, Opportunity[]>();
    const map = new Map<string, Opportunity[]>();
    for (const o of opps) {
      if (o.pairKey) {
        const arr = map.get(o.pairKey) || [];
        arr.push(o);
        map.set(o.pairKey, arr);
      }
    }
    return map;
  }, [opps, revenueMode]);

  const getLinkedOpps = useCallback((opp: Opportunity): Opportunity[] => {
    // Paired-opp rule pairing takes precedence in compensable mode: return the
    // paired rows on the opposite side.
    if (isComp && opp.pairKey && opp.pairOppName) {
      const all = pairedOppGroups.get(opp.pairKey) || [];
      return all.filter(o => o.oppId !== opp.oppId && o.pairOppName !== opp.pairOppName);
    }
    if (!hasCRMode) return [];
    const key = `${opp.rep}||${opp.accountId || ""}||${opp.product || ""}`;
    return linkedPositiveOpps.get(key) || [];
  }, [hasCRMode, linkedPositiveOpps, revenueMode, pairedOppGroups]);

  const toggleExpand = useCallback((rowKey: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }, []);

  const sortedOpps = useMemo(() => {
    const sorted = [...visibleOpps].sort((a, b) => {
      if (sortKey === "closeDate") {
        const cmp = parseDate(a.closeDate) - parseDate(b.closeDate);
        return sortDir === "asc" ? cmp : -cmp;
      }
      if (sortKey === "probability") {
        const ap = a.effectiveProbability ?? -1;
        const bp = b.effectiveProbability ?? -1;
        return sortDir === "asc" ? ap - bp : bp - ap;
      }
      // Sort numerics on the displayed (filter-adjusted) values so the order
      // matches what the user actually sees in the rows.
      if (sortKey === "mrr") {
        // In compensable mode the MRR column shows RAW MRR, so sort on that.
        const av = isComp ? displayedRawMrr(a) : displayedMrr(a);
        const bv = isComp ? displayedRawMrr(b) : displayedMrr(b);
        return sortDir === "asc" ? av - bv : bv - av;
      }
      if (sortKey === "compensableMrr") {
        const av = displayedMrr(a);
        const bv = displayedMrr(b);
        return sortDir === "asc" ? av - bv : bv - av;
      }
      if (sortKey === "multipliers") {
        const av = combinedMultiplier(a);
        const bv = combinedMultiplier(b);
        return sortDir === "asc" ? av - bv : bv - av;
      }
      if (sortKey === "rules") {
        const av = ruleNamesOf(a).length;
        const bv = ruleNamesOf(b).length;
        return sortDir === "asc" ? av - bv : bv - av;
      }
      if (sortKey === "mrrField") {
        // "Default" (no override) sorts as empty so overrides group together.
        const av = a.appliedMrrField ? (MRR_FIELD_LABELS[a.appliedMrrField] ?? a.appliedMrrField) : "";
        const bv = b.appliedMrrField ? (MRR_FIELD_LABELS[b.appliedMrrField] ?? b.appliedMrrField) : "";
        const cmp = av.localeCompare(bv);
        return sortDir === "asc" ? cmp : -cmp;
      }
      if (sortKey === "amount") {
        const av = displayedAmount(a);
        const bv = displayedAmount(b);
        return sortDir === "asc" ? av - bv : bv - av;
      }
      // Product column: multi-row opps sort on the literal "Multiple" so they
      // alphabetize under M.
      if (sortKey === "product") {
        const cmp = displayedProduct(a).localeCompare(displayedProduct(b));
        return sortDir === "asc" ? cmp : -cmp;
      }
      const av = a[sortKey];
      const bv = b[sortKey];
      if (strKeys.has(sortKey)) {
        const cmp = String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      }
      return sortDir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return sorted;
  }, [visibleOpps, sortKey, sortDir, displayedMrr, displayedAmount, displayedProduct, isComp, displayedRawMrr, combinedMultiplier, ruleNamesOf]);

  const handleSort = useCallback((key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(strKeys.has(key) ? "asc" : key === "closeDate" ? "desc" : "desc");
    }
  }, [sortKey]);

  // Account-grouping aggregation. Groups are built from the already-sorted
  // visible opps so within-group child order matches the active sort.
  // Single-opp accounts render flat (no caret); multi-opp accounts collapse to
  // an aggregated row with an expand caret.
  type AccountGroup = {
    key: string;
    accountId: string;
    accountName: string;
    opps: Opportunity[];
    isMulti: boolean;
    latestOpp: Opportunity;
    aggOppName: string;
    aggManager: string;
    aggRep: string;
    aggType: string;
    aggQuoteType: string;
    aggProduct: string;
    aggStage: string;
    aggFunnelStage: string;
    aggOverageReclassified: boolean;
    aggRegion: string;
    aggGroup: string;
    aggAmount: number;
    aggMrr: number;
    aggRawMrr: number;
    aggCloseDate: string;
    aggProbability: number | null;
    // Task #358: rule names of the child opp with the MOST applied rules, so a
    // collapsed multi-opp row can surface a rule-count chip + the same hover
    // tooltip used for a single opp.
    aggRuleNames: string[];
  };

  const accountGroups = useMemo<AccountGroup[]>(() => {
    const order: string[] = [];
    const map = new Map<string, Opportunity[]>();
    for (const o of sortedOpps) {
      const k = accountKeyOf(o);
      if (!map.has(k)) {
        map.set(k, []);
        order.push(k);
      }
      map.get(k)!.push(o);
    }
    const commonOrMultiple = (opps: Opportunity[], getter: (o: Opportunity) => string): string => {
      const first = getter(opps[0]) ?? "";
      for (let i = 1; i < opps.length; i++) {
        if ((getter(opps[i]) ?? "") !== first) return "Multiple";
      }
      return first;
    };
    const groups: AccountGroup[] = order.map(k => {
      const opps = map.get(k)!;
      const latestOpp = opps.reduce((best, cur) =>
        parseDate(cur.closeDate) > parseDate(best.closeDate) ? cur : best, opps[0]);
      const earliest = opps.reduce<string>((min, o) => {
        const d = parseDate(o.closeDate);
        if (d <= 0) return min;
        if (min === "" || d < parseDate(min)) return o.closeDate;
        return min;
      }, "");
      const isMulti = opps.length >= 2;
      return {
        key: k,
        accountId: opps[0].accountId,
        accountName: opps[0].accountName,
        opps,
        isMulti,
        latestOpp,
        aggOppName: isMulti ? "Multiple" : (opps[0].oppName ?? ""),
        aggManager: commonOrMultiple(opps, o => o.manager),
        aggRep: commonOrMultiple(opps, o => o.rep),
        aggType: commonOrMultiple(opps, o => o.type),
        aggQuoteType: commonOrMultiple(opps, o => o.quoteType),
        aggProduct: commonOrMultiple(opps, o => displayedProduct(o)),
        aggStage: commonOrMultiple(opps, o => o.stage),
        aggFunnelStage: commonOrMultiple(opps, o => o.funnelStage),
        aggOverageReclassified: opps.every(o => o.overageReclassified === true),
        aggRegion: commonOrMultiple(opps, o => o.region),
        aggGroup: commonOrMultiple(opps, o => o.group),
        aggAmount: opps.reduce((s, o) => s + displayedAmount(o), 0),
        aggMrr: opps.reduce((s, o) => s + displayedMrr(o), 0),
        aggRawMrr: opps.reduce((s, o) => s + displayedRawMrr(o), 0),
        aggCloseDate: earliest,
        aggProbability: latestOpp.effectiveProbability ?? null,
        aggRuleNames: opps.reduce<string[]>((best, o) => {
          const names = ruleNamesOf(o);
          return names.length > best.length ? names : best;
        }, []),
      };
    });
    // Sort groups by current sortKey using aggregated values. "Multiple"
    // values cluster at the end of an ascending sort (and the start of a
    // descending sort) — treated as a special last-of-alphabet token.
    const dir = sortDir === "asc" ? 1 : -1;
    const cmpStr = (a: string, b: string) => {
      const aMult = a === "Multiple";
      const bMult = b === "Multiple";
      if (aMult && !bMult) return 1 * dir;
      if (!aMult && bMult) return -1 * dir;
      return a.localeCompare(b) * dir;
    };
    groups.sort((a, b) => {
      if (sortKey === "amount") return (a.aggAmount - b.aggAmount) * dir;
      if (sortKey === "mrr") return ((isComp ? a.aggRawMrr : a.aggMrr) - (isComp ? b.aggRawMrr : b.aggMrr)) * dir;
      if (sortKey === "compensableMrr") return (a.aggMrr - b.aggMrr) * dir;
      if (sortKey === "closeDate") return (parseDate(a.aggCloseDate) - parseDate(b.aggCloseDate)) * dir;
      if (sortKey === "probability") {
        const ap = a.aggProbability ?? -1;
        const bp = b.aggProbability ?? -1;
        return (ap - bp) * dir;
      }
      if (sortKey === "accountName") return cmpStr(a.accountName ?? "", b.accountName ?? "");
      if (sortKey === "oppName") return cmpStr(a.aggOppName, b.aggOppName);
      if (sortKey === "manager") return cmpStr(a.aggManager, b.aggManager);
      if (sortKey === "rep") return cmpStr(a.aggRep, b.aggRep);
      if (sortKey === "type") return cmpStr(a.aggType, b.aggType);
      if (sortKey === "quoteType") return cmpStr(a.aggQuoteType, b.aggQuoteType);
      if (sortKey === "product") return cmpStr(a.aggProduct, b.aggProduct);
      if (sortKey === "funnelStage") return cmpStr(a.aggFunnelStage, b.aggFunnelStage);
      return 0;
    });
    return groups;
  }, [sortedOpps, sortKey, sortDir, displayedAmount, displayedMrr, displayedRawMrr, displayedProduct, accountKeyOf, isComp, ruleNamesOf]);

  // When a search is active, auto-expand every multi-opp account group so the
  // matching opps surface immediately. Otherwise, honor the per-account toggle.
  const searchActive = searchId.trim() !== "";
  const isAccountOpen = useCallback(
    (key: string) => searchActive || expandedAccounts.has(key),
    [searchActive, expandedAccounts],
  );

  // All summary totals use displayedMrr/displayedAmount so they equal the
  // sum of what the user sees per row (filtered to active products).
  const totalAmount = useMemo(
    () => visibleOpps.reduce((s, o) => s + displayedAmount(o), 0),
    [visibleOpps, displayedAmount],
  );
  const totalMrr = useMemo(
    () => visibleOpps.reduce((s, o) => s + displayedMrr(o), 0),
    [visibleOpps, displayedMrr],
  );
  // Task #246: raw (untreated) MRR total — shown alongside the compensable
  // total in the header summary when in Compensable Revenue mode.
  const totalRawMrr = useMemo(
    () => visibleOpps.reduce((s, o) => s + displayedRawMrr(o), 0),
    [visibleOpps, displayedRawMrr],
  );
  const closedWonMrrTotal = useMemo(() => {
    const cwOpps = visibleOpps.filter(o => isEffectiveClosedWon(o));
    if (mrrMode === "added") {
      // Inclusion still keys on the full opp's sign so we don't drop a
      // multi-product opp whose displayed value zero'd out under filtering;
      // contribution to the total is the displayed value.
      return cwOpps
        .filter(o => o.mrr > 0)
        .reduce((s, o) => s + displayedMrr(o), 0);
    }
    if (mrrMode === "acqNet") {
      const posKeys = new Set<string>();
      for (const o of cwOpps) {
        if (o.mrr > 0) posKeys.add(`${o.rep}||${o.accountId || ""}||${o.product || ""}`);
      }
      return cwOpps.reduce((s, o) => {
        if (o.mrr > 0) return s + displayedMrr(o);
        const k = `${o.rep}||${o.accountId || ""}||${o.product || ""}`;
        return posKeys.has(k) ? s + displayedMrr(o) : s;
      }, 0);
    }
    return cwOpps.reduce((s, o) => s + displayedMrr(o), 0);
  }, [visibleOpps, mrrMode, displayedMrr]);
  const closedWonCount = useMemo(() => visibleOpps.filter(o => isEffectiveClosedWon(o)).length, [visibleOpps]);

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="inline w-3 h-3 ml-0.5 opacity-40" />;
    return sortDir === "asc" ? <ArrowUp className="inline w-3 h-3 ml-0.5" /> : <ArrowDown className="inline w-3 h-3 ml-0.5" />;
  };

  const now = new Date();
  const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: userTz });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: userTz });

  const timeframeLabel = filters.timeframe === "mtd" ? "This Month" : filters.timeframe === "lastMonth" ? "Last Month" : filters.timeframe === "mtd2date" ? "MTD" : filters.timeframe === "eom" ? "EOM" : filters.timeframe === "thisWeek" ? "This Week" : filters.timeframe === "today" ? "Today" : filters.timeframe === "custom" && filters.customRange ? `${filters.customRange.from.toLocaleDateString()} – ${filters.customRange.to.toLocaleDateString()}` : "Custom";

  const mrrModeLabel = mrrMode === "added" ? "Gross MRR" : mrrMode === "acqNet" ? "ACQ Single Month MRR" : "G&R Single Month MRR";
  const churnLabel = mrrMode === "gnrNet" ? "G&R Churn" : mrrMode === "acqNet" ? "ACQ Churn" : "Churn";
  const modeLabel = mode === "stage"
    ? `${stage} — Opportunity Detail${mrrMode !== "gnrNet" && (isClosedWonStage || isAllStagesMode) ? ` (${mrrModeLabel})` : ""}`
    : mode === "mrr"
      ? `${mrrModeLabel} — Opportunity Detail`
      : mode === "churn"
        ? `${churnLabel} — Opportunity Detail`
        : mode === "opps"
          ? "Opps Created — Opportunity Detail"
          : mode === "demos"
            ? "Demos — Opportunity Detail"
            : "Scheduled Mods";
  const modalTitle = nameFilter ? `${nameFilter} · ${modeLabel}` : modeLabel;

  const activeFilters = useMemo(() => {
    const parts: string[] = [];
    parts.push(`Timeframe: ${timeframeLabel}`);
    if (nameFilter && nameFilterDimension) parts.push(`${nameFilterDimension}: ${nameFilter}`);
    if (filters.slm.length > 0) parts.push(`SLM: ${filters.slm.join(", ")}`);
    if (filters.flm.length > 0) parts.push(`FLM: ${filters.flm.join(", ")}`);
    if (nameFilterDimension !== "Rep" && filters.rep.length > 0) parts.push(`Rep: ${filters.rep.join(", ")}`);
    if (filters.region.length > 0) parts.push(`Region: ${filters.region.join(", ")}`);
    if (filters.segment.length > 0) parts.push(`Segment: ${filters.segment.join(", ")}`);
    if (filters.group !== "All Channels") parts.push(`Channel: ${filters.group}`);
    if (effectiveFilters.products.length > 0) parts.push(`Products: ${effectiveFilters.products.map(displayProduct).join(", ")}`);
    return parts;
  }, [filters, effectiveFilters.products, timeframeLabel, nameFilter, nameFilterDimension]);

  const summaryVal = (mode === "mrr" || mode === "stage" || mode === "churn") ? totalMrr : totalAmount;
  const summaryLabel = isMods ? "total mod amount" : "total";

  const csvContent = useMemo(() => {
    const meta = [
      `"View","${modalTitle}"`,
      `"Exported","${dateStr} ${timeStr} (${userTz})"`,
      `"Filters","${activeFilters.join(' | ')}"`,
      `"Total Records",${visibleOpps.length}`,
      ...(isComp ? [] : [`"Total Amount",${totalAmount}`]),
      ...(mode !== "mods" ? (isComp
        ? [...(isAdmin ? [`"Total MRR (raw)",${totalRawMrr}`] : []), `"Total ${compMrrLabel}",${totalMrr}`]
        : [`"Total MRR",${totalMrr}`]) : []),
      ...(mode === "mrr" ? [`"Closed Won Records",${closedWonCount}`, `"Closed Won MRR",${closedWonMrrTotal}`] : []),
      "",
    ];
    const hdrs = isMods
      ? ["Churn Type", "Product", "Contact", "Contact ID", "Contact Link", "Rep", "Opportunity Type", "Opportunity ID", "Opportunity Link", "Reason", "Description", "Cancellation Date", "Prob %", "Amount"]
      : [
        "Account Name", "Account Link", "Account ID",
        "Opportunity Name", "Opportunity Link", "Opportunity ID",
        "Owner Manager", "Opportunity Owner",
        "Close Date", "Quote Type", "Product",
        // Task #246/#358: compensable mode hides Amount and adds the mode-named
        // Compensable MRR + Multipliers / Rules / MRR Field; the raw MRR column
        // is labeled "Raw MRR".
        ...(isComp ? [] : ["Amount"]),
        // Task #406: the "Raw MRR" column is Admin-only; non-comp "MRR" stays.
        ...(isComp ? (isAdmin ? ["Raw MRR"] : []) : ["MRR"]),
        ...(isComp ? [compMrrLabel, "Multipliers", "Rules", "MRR Field"] : []),
        ...(mode !== "stage" || isAllStagesMode ? ["Stage"] : []),
      ];
    const csvEsc = (v: string | undefined | null) => `"${(v ?? "").replace(/"/g, '""')}"`;
    const rows = isMods
      ? sortedOpps.map(o => [
          csvEsc(o.churnType || ""),
          csvEsc(displayProduct(o.product || "")),
          csvEsc(o.contactName || ""),
          csvEsc(o.contactId || ""),
          o.contactId ? `${SF_LIGHTNING}/Contact/${o.contactId}/view` : "",
          csvEsc(o.rep),
          csvEsc(o.type || ""),
          csvEsc(o.opportunityId || ""),
          o.opportunityId ? `${SF_LIGHTNING}/Opportunity/${o.opportunityId}/view` : "",
          csvEsc(o.reason || ""),
          csvEsc(o.description || ""),
          o.closeDate,
          o.effectiveProbability == null ? "" : String(o.effectiveProbability),
          displayedAmount(o).toString(),
        ].join(","))
      : sortedOpps.map(o => [
          `"${o.accountName.replace(/"/g, '""')}"`,
          sfLinkFor(o, "account"),
          o.accountId,
          `"${o.oppName.replace(/"/g, '""')}"`,
          sfLinkFor(o, "opp"),
          o.oppId,
          `"${o.manager.replace(/"/g, '""')}"`,
          `"${o.rep.replace(/"/g, '""')}"`,
          o.closeDate,
          `"${(o.quoteType || "").replace(/"/g, '""')}"`,
          `"${displayProduct(displayedProduct(o)).replace(/"/g, '""')}"`,
          ...(isComp ? [] : [displayedAmount(o).toString()]),
          // Task #406: raw MRR value is Admin-only; non-comp "MRR" stays.
          ...(isComp ? (isAdmin ? [displayedRawMrr(o).toString()] : []) : [displayedMrr(o).toString()]),
          ...(isComp ? [
            displayedMrr(o).toString(),
            csvEsc(multipliersText(o)),
            ruleNamesOf(o).length.toString(),
            csvEsc(o.appliedMrrField ? (MRR_FIELD_LABELS[o.appliedMrrField] ?? o.appliedMrrField) : "Default"),
          ] : []),
          ...(mode !== "stage" || isAllStagesMode ? [`"${o.funnelStage}"`] : []),
        ].join(","));
    return [...meta, hdrs.join(","), ...rows].join("\n");
  }, [sortedOpps, modalTitle, dateStr, timeStr, userTz, activeFilters, visibleOpps.length, totalAmount, totalMrr, totalRawMrr, mode, isMods, isComp, isAdmin, compMrrLabel, displayedRawMrr, displayedMrr, displayedAmount, multipliersText, ruleNamesOf, displayedProduct, isAllStagesMode]);

  const handleExport = useCallback(() => {
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const fname = mode === "stage" ? stage.replace(/\//g, "-") : mode;
    link.download = `${fname}_opportunities.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [csvContent, stage, mode]);

  const showProbabilityColumn = true;
  // Sched Mods drilldown uses a 9-column layout per the Databricks-source
  // migration spec (#153/#154). Account Name and Opportunity Name are
  // dropped; Contact (linked) + Opportunity Type (conditionally linked) +
  // Reason (with description tooltip) + Churn Type take their place.
  const columns: { key: SortKey; label: string; width: string }[] = isMods
    ? [
      { key: "churnType", label: "Churn Type", width: "min-w-[100px] max-w-[140px]" },
      { key: "product", label: "Product", width: "min-w-[80px] max-w-[120px]" },
      { key: "contactName", label: "Contact", width: "min-w-[110px] max-w-[180px]" },
      { key: "rep", label: "Rep", width: "min-w-[90px] max-w-[130px]" },
      { key: "type", label: "Opportunity Type", width: "min-w-[110px] max-w-[160px]" },
      { key: "reason", label: "Reason", width: "min-w-[110px] max-w-[200px]" },
      { key: "closeDate", label: "Cancellation Date", width: "w-[110px]" },
      { key: "probability", label: "Prob %", width: "w-[78px]" },
      { key: "amount", label: "Amount", width: "w-[100px]" },
    ]
    : [
      { key: "accountName", label: "Account", width: "min-w-[100px] max-w-[150px]" },
      { key: "oppName", label: "Opportunity", width: "min-w-[120px] max-w-[180px]" },
      { key: "manager", label: "Manager", width: "min-w-[90px] max-w-[120px]" },
      { key: "rep", label: "Owner", width: "min-w-[90px] max-w-[120px]" },
      { key: "closeDate", label: "Close Date", width: "w-[85px]" },
      { key: "quoteType", label: "Quote Type", width: "min-w-[80px] max-w-[110px]" },
      { key: "product", label: "Product", width: "min-w-[60px] max-w-[90px]" },
      ...(showProbabilityColumn ? [
        { key: "probability" as SortKey, label: "Prob %", width: "w-[78px]" },
      ] : []),
      // Task #246: Amount is hidden in Compensable Revenue mode.
      ...(isComp ? [] : [{ key: "amount" as SortKey, label: "Amount", width: "w-[90px]" }]),
      // Task #358: raw MRR column is labeled "Raw MRR" in compensable mode so
      // it's distinct from the mode-named Compensable MRR column.
      // Task #406: the "Raw MRR" column is Admin-only; the non-comp "MRR" column
      // (plain MRR, not raw) stays visible for everyone.
      ...(isComp
        ? (isAdmin ? [{ key: "mrr" as SortKey, label: "Raw MRR", width: "w-[90px]" }] : [])
        : [{ key: "mrr" as SortKey, label: "MRR", width: "w-[90px]" }]),
      // Task #246/#358: three compensation columns to the right of MRR. The
      // Compensable MRR header tracks the active revenue mode.
      ...(isComp ? [
        { key: "compensableMrr" as SortKey, label: compMrrLabel, width: "w-[110px]" },
        { key: "multipliers" as SortKey, label: "Multipliers", width: "min-w-[90px] max-w-[150px]" },
        { key: "rules" as SortKey, label: "Rules", width: "w-[70px]" },
        { key: "mrrField" as SortKey, label: "MRR Field", width: "min-w-[100px] max-w-[140px]" },
      ] : []),
      ...(mode !== "stage" || isAllStagesMode ? [
        { key: "funnelStage" as SortKey, label: "Stage", width: "min-w-[80px] max-w-[120px]" },
      ] : []),
    ];

  const getCellText = (opp: Opportunity, col: typeof columns[0]): string => {
    if (col.key === "oppName") return opp.oppName || "—";
    if (col.key === "accountName") return opp.accountName || "—";
    if (col.key === "amount") return `$${displayedAmount(opp).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (col.key === "mrr") {
      const v = isComp ? displayedRawMrr(opp) : displayedMrr(opp);
      return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    if (col.key === "compensableMrr") return `$${displayedMrr(opp).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (col.key === "multipliers") return multipliersText(opp);
    if (col.key === "rules") return String(ruleNamesOf(opp).length);
    if (col.key === "mrrField") {
      const f = opp.appliedMrrField;
      return f ? (MRR_FIELD_LABELS[f] ?? f) : "Default";
    }
    if (col.key === "product") {
      // Tooltip on the Product cell shows the comma-joined list of line-item
      // products so multi-row opps surface their full breakdown on hover.
      if (isMultiOpp(opp)) return lineItemsOf(opp).map(li => displayProduct(li.product)).join(", ");
      return displayProduct(displayedProduct(opp));
    }
    if (col.key === "funnelStage") return opp.funnelStage || "";
    if (col.key === "probability") {
      const p = opp.effectiveProbability;
      return p == null ? "" : `${p}%`;
    }
    if (col.key === "churnType") return opp.churnType || "—";
    if (col.key === "contactName") return opp.contactName || "—";
    if (col.key === "reason") return opp.reason || "—";
    if (col.key === "type") return opp.type || "—";
    if (col.key === "closeDate") return opp.closeDate || "";
    const val = opp[col.key as keyof Opportunity];
    return String(val ?? "");
  };

  const role = authUser?.role;
  const myName = authUser?.hierarchyName || "";
  const viewOnly = !!authUser?.viewOnly;

  const canEditOppProb = useCallback((opp: Opportunity) => {
    if (viewOnly) return false;
    if (!opp.oppId) return false;
    if (role === "admin" || role === "slm" || role === "exec") return true;
    if (role === "flm") return opp.flm === myName;
    if (role === "rep") return opp.rep === myName;
    return false;
  }, [role, myName, viewOnly]);

  const probabilityDirtyRef = useRef(false);
  const onProbabilityChangedRef = useRef(onProbabilityChanged);
  useEffect(() => { onProbabilityChangedRef.current = onProbabilityChanged; }, [onProbabilityChanged]);
  // Flush any pending parent-pipeline refresh when the modal unmounts so the
  // Forecast Assumptions drilldown's Current %, bar chart, and Weighted totals
  // pick up the latest per-opp probability edits.
  useEffect(() => () => {
    if (probabilityDirtyRef.current) {
      probabilityDirtyRef.current = false;
      onProbabilityChangedRef.current?.();
    }
  }, []);

  const updateOppProbability = useCallback(async (oppId: string, value: number) => {
    // Mark dirty before the request fires so that closing the modal mid-flight
    // still triggers the parent pipeline refresh on unmount. A late refresh on
    // a failed save is harmless — server numbers will be unchanged.
    probabilityDirtyRef.current = true;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      // Dev impersonation: forward the impersonated user id so the server
      // performs auth checks as that user (matching the UI's effectiveUser).
      if (import.meta.env.DEV) {
        try {
          const raw = localStorage.getItem("impersonate_user");
          const imp = raw ? JSON.parse(raw) : null;
          if (imp?.id) headers["x-impersonate-user-id"] = String(imp.id);
        } catch { /* ignore */ }
      }
      const res = await fetch(`/api/sales/opp-probabilities/${encodeURIComponent(oppId)}`, {
        method: "PUT",
        headers,
        credentials: "include",
        body: JSON.stringify({ probability: value }),
      });
      if (!res.ok) {
        console.warn("Failed to save probability override", await res.text());
        return;
      }
      // Refetch silently so this user (and other open modals via interval poll)
      // see the authoritative server value, including any cross-user edits.
      fetchOpps(false);
    } catch (e) {
      console.error("Error saving probability override", e);
    }
  }, [fetchOpps]);

  const setOppProbabilityLocal = useCallback((oppId: string, value: number | null) => {
    setOpps(prev => prev.map(o => o.oppId === oppId
      ? { ...o, probabilityOverride: value, effectiveProbability: value ?? o.stageDefaultProbability ?? null, isReviewed: true }
      : o
    ));
  }, []);

  const ProbabilityCell: React.FC<{ opp: Opportunity }> = ({ opp }) => {
    const editable = canEditOppProb(opp);
    const eff = opp.effectiveProbability;
    const def = opp.stageDefaultProbability;
    const matchesDefault = opp.isReviewed === false;
    const [draft, setDraft] = useState<string>(eff == null ? "" : String(eff));
    const debounceRef = useRef<number | null>(null);
    useEffect(() => { setDraft(eff == null ? "" : String(eff)); }, [eff]);
    useEffect(() => () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    }, []);
    const tryCommit = (raw: string, immediate: boolean) => {
      if (!opp.oppId) return;
      const trimmed = raw.trim();
      if (trimmed === "") return; // wait for more input
      // Strict integer (decimals rejected). Out-of-range is clamped to 0..100.
      if (!/^\d+$/.test(trimmed)) {
        setDraft(eff == null ? "" : String(eff));
        return;
      }
      let n = Number(trimmed);
      if (!Number.isInteger(n)) {
        setDraft(eff == null ? "" : String(eff));
        return;
      }
      if (n < 0) n = 0;
      if (n > 100) n = 100;
      if (String(n) !== trimmed && immediate) setDraft(String(n));
      if (n === eff) return;
      setOppProbabilityLocal(opp.oppId, n);
      updateOppProbability(opp.oppId, n);
    };
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setDraft(v);
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => tryCommit(v, false), 600);
    };
    const handleBlur = () => {
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      tryCommit(draft, true);
    };
    return (
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={draft}
        disabled={!editable}
        title={editable
          ? (def != null ? `Stage default ${def}%` : undefined)
          : (def != null ? `View only — stage default ${def}%` : "View only")}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className={`w-[58px] text-right text-[11px] tabular-nums px-1.5 py-0.5 rounded border focus:outline-none focus:ring-1 focus:ring-[#006AFF] ${matchesDefault ? "bg-yellow-100 border-yellow-300" : editable ? "bg-white border-[#cbd5e1]" : "bg-[#f8fafc] border-[#e2e8f0] text-[#64748b] cursor-not-allowed"}`}
      />
    );
  };

  // ----------------- Pinned ME row aggregation (mods only) -----------------
  // Filter the raw ME rows by the active product filter (FLM filter is
  // already applied server-side via the `flms` query param). Per-product
  // breakdown drives the Disclosure → sub-rows expansion.
  const meScoped = useMemo(() => {
    if (!isMods) return [] as ManagerEstimateRowApi[];
    let res = meRows;
    // Honor the productFilter override (e.g. from the GNR Churn Forecast
    // popup) via effectiveFilters, not the raw dashboard filter.
    if (effectiveFilters.products.length > 0) {
      const set = new Set(effectiveFilters.products);
      res = res.filter(r => set.has(r.product));
    }
    return res;
  }, [isMods, meRows, effectiveFilters.products]);
  const meTotalAmount = useMemo(
    () => meScoped.reduce((s, r) => s + (r.unweightedAmount || 0), 0),
    [meScoped],
  );
  // Canonical product list used to ensure every product in the active
  // scope shows a row (even at $0) when the ME breakdown is expanded.
  // Showcase Incremental is intentionally excluded — Manager Estimates
  // are entered against Showcase only and never roll into Incremental.
  const ALL_PRODUCTS_CANONICAL = useMemo(
    () => ["Showcase", "MBP", "Zillow Pro", "Follow Up Boss", "ZMX"],
    [],
  );
  // Per-product weighted/unweighted aggregates. Used both for the
  // collapsed pinned row's weighted-avg % AND to seed the per-product
  // probability cell drafts when meRows refreshes.
  const meAggByProduct = useMemo(() => {
    const m = new Map<string, { unw: number; w: number }>();
    for (const r of meScoped) {
      const prev = m.get(r.product) || { unw: 0, w: 0 };
      const u = r.unweightedAmount || 0;
      const w = typeof r.weightedAmount === "number" ? r.weightedAmount : u;
      m.set(r.product, { unw: prev.unw + u, w: prev.w + w });
    }
    return m;
  }, [meScoped]);
  // Per-product reviewed roll-up. A product is "reviewed" iff at least one
  // rep × product slice exists in scope AND every such slice has its
  // override row's `reviewed_at` stamped. Mirrors the per-opp
  // `isReviewed === false` → yellow convention so unreviewed ME slices
  // jump out the same way unreviewed pipeline opps do.
  const meIsReviewedByProduct = useMemo(() => {
    const out: Record<string, boolean> = {};
    const seen: Record<string, boolean> = {};
    for (const r of meScoped) {
      const reviewed = r.isReviewed === true;
      if (!seen[r.product]) {
        seen[r.product] = true;
        out[r.product] = reviewed;
      } else {
        out[r.product] = out[r.product] && reviewed;
      }
    }
    return out;
  }, [meScoped]);
  // Effective % per product = weighted / unweighted * 100. Falls back
  // to 100% when there's no $ in scope so the cell shows a sane default.
  const meEffectivePctByProduct = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [product, { unw, w }] of meAggByProduct.entries()) {
      out[product] = unw > 0 ? Math.round((w / unw) * 100) : 100;
    }
    return out;
  }, [meAggByProduct]);
  // Weighted-avg % across every product in scope, shown on the
  // collapsed pinned ME row. Same formula at the aggregate level.
  const meWeightedAvgPct = useMemo(() => {
    let unw = 0;
    let w = 0;
    for (const { unw: u, w: ww } of meAggByProduct.values()) {
      unw += u;
      w += ww;
    }
    return unw > 0 ? Math.round((w / unw) * 100) : 100;
  }, [meAggByProduct]);

  const meProductBreakdown = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of meScoped) {
      m.set(r.product, (m.get(r.product) || 0) + (r.unweightedAmount || 0));
    }
    // Determine which products to render: if a product scope is active,
    // use it; otherwise enumerate the canonical full list. Missing
    // products show $0 so the breakdown is always populated.
    const scopeProducts = effectiveFilters.products.length > 0
      ? effectiveFilters.products
      : ALL_PRODUCTS_CANONICAL;
    const seen = new Set<string>();
    const ordered: Array<{ product: string; amount: number }> = [];
    for (const product of scopeProducts) {
      if (seen.has(product)) continue;
      seen.add(product);
      ordered.push({ product, amount: m.get(product) || 0 });
    }
    // Include any extra products that returned ME data but aren't in the
    // canonical list / scope, so nothing is silently dropped.
    for (const [product, amount] of m.entries()) {
      if (!seen.has(product)) {
        seen.add(product);
        ordered.push({ product, amount });
      }
    }
    return ordered;
  }, [meScoped, effectiveFilters.products, ALL_PRODUCTS_CANONICAL]);
  // Visible reps for the bulk-write fallback when a Rep filter narrows the
  // pinned row's prob editor to a known scope. Without this, the editor
  // bulk-writes to every rep that appears in the current mods list.
  const visibleRepsForMe = useMemo(() => {
    const reps = new Set<string>();
    for (const o of filteredOpps) if (o.rep) reps.add(o.rep);
    for (const r of filters.rep) reps.add(r);
    if (nameFilterDimension === "Rep" && nameFilter) reps.add(nameFilter);
    return Array.from(reps);
  }, [filteredOpps, filters.rep, nameFilter, nameFilterDimension]);
  const visibleProductsForMe = useMemo(() => {
    if (filters.products.length > 0) return filters.products;
    return Array.from(new Set(meScoped.map(r => r.product)));
  }, [filters.products, meScoped]);

  const meCanEdit = useMemo(() => {
    if (viewOnly) return false;
    return role === "rep" || role === "flm" || role === "slm" || role === "exec" || role === "admin";
  }, [viewOnly, role]);

  // Bulk-write a single per-product probability across every visible
  // rep × the given product. Per-product so users can keep asymmetric
  // confidence (e.g. Showcase 80%, MBP 50%) instead of the old single
  // value clobbering every product on save.
  const bulkWriteMeProbForProduct = useCallback(async (product: string, n: number) => {
    if (visibleRepsForMe.length === 0 || !product) return;
    // Mark dirty before the writes fire (mirrors updateOppProbability at
    // line ~1125) so that closing the modal mid-flight still triggers the
    // parent pipeline refresh on unmount. A late refresh after a fully-
    // failed save is harmless — server numbers will be unchanged.
    probabilityDirtyRef.current = true;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (import.meta.env.DEV) {
      try {
        const raw = localStorage.getItem("impersonate_user");
        const imp = raw ? JSON.parse(raw) : null;
        if (imp?.id) headers["x-impersonate-user-id"] = String(imp.id);
      } catch { /* ignore */ }
    }
    const writes: Promise<Response>[] = [];
    for (const rep of visibleRepsForMe) {
      const oppId = `mgr_est:${rep}|${viewedMonthYyyymm}|${product}`;
      writes.push(fetch(`/api/sales/opp-probabilities/${encodeURIComponent(oppId)}`, {
        method: "PUT",
        headers,
        credentials: "include",
        body: JSON.stringify({ probability: n }),
      }));
    }
    let okCount = 0;
    let failCount = 0;
    let firstFailStatus = 0;
    // Capture the first server-supplied error string so we surface
    // the actual reason ("View-only session — sign in to make changes.",
    // etc.) instead of a generic "HTTP 403" message.
    let firstFailServerMsg = "";
    try {
      const results = await Promise.allSettled(writes);
      for (const r of results) {
        if (r.status === "fulfilled" && r.value.ok) {
          okCount++;
        } else {
          failCount++;
          if (firstFailStatus === 0 && r.status === "fulfilled") {
            firstFailStatus = r.value.status;
            try {
              const body = await r.value.clone().text();
              if (body) {
                try {
                  const parsed = JSON.parse(body);
                  if (parsed && typeof parsed.error === "string") firstFailServerMsg = parsed.error;
                } catch { firstFailServerMsg = body.slice(0, 200); }
              }
            } catch { /* ignore */ }
          }
        }
      }
    } catch (e) {
      console.error("ME bulk prob write failed", e);
      failCount = writes.length;
    }
    if (failCount > 0) {
      console.warn(`ME bulk prob write (${product}): ${okCount} ok, ${failCount} failed (status ${firstFailStatus || "n/a"})`);
      const fallback = firstFailStatus === 403
        ? "Not allowed to edit Manager Estimate probability"
        : firstFailStatus === 404
          ? "Manager Estimate target not found"
          : `Save failed (HTTP ${firstFailStatus || "?"})`;
      const msg = okCount === 0
        ? (firstFailServerMsg || fallback)
        : `Saved ${okCount} of ${okCount + failCount} (some failed)`;
      setMeProbErrorByProduct(prev => ({ ...prev, [product]: msg }));
    } else {
      setMeProbErrorByProduct(prev => ({ ...prev, [product]: null }));
    }
    // Bump the sync tick so the cell snaps back to authoritative
    // server state after the refetch — even if `effectivePct` ends up
    // identical to what was already there (e.g. on a 403 revert).
    setMeProbSyncTickByProduct(prev => ({ ...prev, [product]: (prev[product] ?? 0) + 1 }));
    // On a total failure (e.g. 403 across the board) skip the heavy
    // refetch + pipeline invalidation — that cascade is what the user
    // perceives as "the page reloaded". The error message + red border
    // surface the failure, and the syncTick above snaps the draft back
    // to the authoritative effectivePct. Refetch only when at least one
    // rep slice actually saved, so the rolled-up % stays in sync.
    if (okCount > 0) {
      // Defer the parent's pipeline-refresh callback to modal unmount
      // (mirrors the per-opp updateOppProbability pattern at line 1125).
      // Firing it inline triggered a parent-side query invalidation that,
      // in some flows (e.g. rep editing their own ME slice via the Sched
      // Mods drilldown), caused the drilldown to close mid-edit before
      // the local fetchMeRows/fetchOpps responses applied — so the prob
      // also appeared to "not update". Setting the dirty flag and
      // relying on the unmount effect (lines 1114-1119) keeps the modal
      // stable while still ensuring the parent pipeline is refreshed
      // once the user closes the drilldown.
      probabilityDirtyRef.current = true;
      fetchMeRows();
      fetchOpps(false);
    }
  }, [visibleRepsForMe, viewedMonthYyyymm, fetchOpps, fetchMeRows]);

  // Render the pinned ME row + its optional per-product expansion sub-rows.
  // Always shown at the top of the mods table, before accountGroups.
  const renderPinnedMeRow = () => {
    if (!isMods) return null;
    return (
      <React.Fragment key="me-pinned-row">
        <tr className="bg-[#fef3c7]/60 dark:bg-amber-900/15 hover:bg-[#fef3c7] dark:hover:bg-amber-900/20 font-medium border-b-2 border-amber-300/60">
          {columns.map((col) => {
            const baseCls = `px-3 py-2 ${col.width} ${isNumCol(col.key) ? "text-right whitespace-nowrap" : col.key === "closeDate" ? "whitespace-nowrap" : "truncate"}`;
            if (col.key === "churnType") {
              return (
                <td key={col.key} className={baseCls}>
                  <span className="inline-flex items-center gap-1.5 max-w-full">
                    <button
                      type="button"
                      onClick={() => setMeExpanded(v => !v)}
                      className="shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                      aria-label={meExpanded ? "Collapse Manager Estimate breakdown" : "Expand Manager Estimate breakdown"}
                      title={meExpanded ? "Hide per-product breakdown" : `Show per-product breakdown (${meProductBreakdown.length})`}
                    >
                      {meExpanded ? <ChevronDown className="w-3.5 h-3.5 text-amber-700" /> : <ChevronRight className="w-3.5 h-3.5 text-amber-700" />}
                    </button>
                    <span className="truncate font-semibold">Manager Estimate</span>
                  </span>
                </td>
              );
            }
            if (col.key === "product") return <td key={col.key} className={baseCls}><span className="truncate italic text-muted-foreground">All</span></td>;
            if (col.key === "contactName") return <td key={col.key} className={baseCls}><span className="truncate">Rep Book</span></td>;
            if (col.key === "rep") return <td key={col.key} className={baseCls}><span className="truncate italic text-muted-foreground">{visibleRepsForMe.length} rep{visibleRepsForMe.length === 1 ? "" : "s"}</span></td>;
            if (col.key === "type") return <td key={col.key} className={baseCls}><span className="truncate">Manager Estimate</span></td>;
            if (col.key === "reason") return <td key={col.key} className={baseCls}><span className="truncate">Manager Estimate</span></td>;
            if (col.key === "closeDate") return <td key={col.key} className={baseCls}><span>{monthEndDateStr || "—"}</span></td>;
            if (col.key === "probability") return (
              <td key={col.key} className={baseCls}>
                <span
                  className="inline-block tabular-nums text-[11px] text-muted-foreground"
                  title={meExpanded
                    ? "Edit per-product % below"
                    : "Weighted-avg across products — expand to edit per product"}
                >
                  {meWeightedAvgPct}%
                </span>
              </td>
            );
            if (col.key === "amount") return <td key={col.key} className={`${baseCls} font-semibold`}><span>${meTotalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></td>;
            return <td key={col.key} className={baseCls}></td>;
          })}
        </tr>
        {meExpanded && meProductBreakdown.map((p, idx) => (
          <tr key={`me-pin-sub-${p.product}`} className="bg-amber-50/40 dark:bg-amber-900/5 text-[11px]">
            {columns.map((col) => {
              const baseCls = `px-3 py-1 ${col.width} ${isNumCol(col.key) ? "text-right whitespace-nowrap" : col.key === "closeDate" ? "whitespace-nowrap" : "truncate"} text-muted-foreground`;
              if (col.key === "churnType") return <td key={col.key} className={baseCls}><span className="inline-flex items-center gap-1 max-w-full pl-[26px]"><span className="text-[10px] mr-1">↳</span><span className="truncate italic">Per product</span></span></td>;
              if (col.key === "product") return <td key={col.key} className={baseCls}><span className="truncate font-medium text-foreground">{displayProduct(p.product)}</span></td>;
              if (col.key === "probability") return (
                <td key={col.key} className={baseCls}>
                  <MEProductProbabilityCell
                    key={p.product}
                    product={p.product}
                    effectivePct={meEffectivePctByProduct[p.product] ?? 100}
                    canEdit={meCanEdit}
                    repsCount={visibleRepsForMe.length}
                    error={meProbErrorByProduct[p.product] ?? null}
                    syncTick={meProbSyncTickByProduct[p.product] ?? 0}
                    isReviewed={meIsReviewedByProduct[p.product] ?? false}
                    onClearError={() => setMeProbErrorByProduct(prev => ({ ...prev, [p.product]: null }))}
                    onCommit={(n) => bulkWriteMeProbForProduct(p.product, n)}
                  />
                </td>
              );
              if (col.key === "amount") return <td key={col.key} className={`${baseCls} font-medium text-foreground`}><span>${p.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></td>;
              return <td key={col.key} className={baseCls}></td>;
            })}
          </tr>
        ))}
      </React.Fragment>
    );
  };

  const OVERAGE_TOOLTIP = displayProductText(
    "Overage opps open in Discovery at the start of each month and move to Closed Won on the last day, accruing MRR as credits are purchased. The dashboard counts Discovery-stage Overage opps as Closed Won.");
  const renderStageWithInfo = (
    reclassified: boolean | undefined,
    text: string,
    colorClass = "",
  ) => {
    const label = <span className={`truncate ${colorClass}`}>{text}</span>;
    if (!reclassified) return label;
    return (
      <span className="inline-flex items-center gap-1 max-w-full">
        {label}
        <Info
          className="w-3 h-3 shrink-0 text-[#006AFF] cursor-help"
          onMouseEnter={(ev: React.MouseEvent) =>
            reasonTip.showTooltipDelayed(OVERAGE_TOOLTIP, ev, displayProduct("Overage"))
          }
          onMouseLeave={reasonTip.hideTooltip}
        />
      </span>
    );
  };
  const renderCell = (opp: Opportunity, col: typeof columns[0]) => {
    // ----- Mod-specific cell renderers (9-col layout per #154) -----------
    if (isMods) {
      if (col.key === "churnType") {
        return <span className="truncate">{opp.churnType || "—"}</span>;
      }
      if (col.key === "contactName") {
        const label = opp.contactName || "—";
        return opp.contactId ? (
          <a href={`${SF_LIGHTNING}/Contact/${opp.contactId}/view`} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline truncate inline-block max-w-full">{label}</a>
        ) : <span className="truncate">{label}</span>;
      }
      if (col.key === "type") {
        const label = opp.type || "—";
        return opp.opportunityId ? (
          <a href={`${SF_LIGHTNING}/Opportunity/${opp.opportunityId}/view`} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline inline-flex items-center gap-1 max-w-full">
            <span className="truncate">{label}</span>
            <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
          </a>
        ) : <span className="truncate">{label}</span>;
      }
      if (col.key === "reason") {
        const label = opp.reason || "—";
        const desc = opp.description || "";
        const hoverProps = desc
          ? {
              onMouseEnter: (ev: React.MouseEvent) => reasonTip.showTooltipDelayed(desc, ev, "Description"),
              onMouseMove: reasonTip.trackMouseMove,
              onMouseLeave: reasonTip.hideTooltip,
            }
          : {};
        return <span className="truncate" {...hoverProps}>{label}</span>;
      }
      if (col.key === "closeDate") {
        return <span className="whitespace-nowrap">{opp.closeDate || "—"}</span>;
      }
      if (col.key === "product") {
        const display = opp.product === "Showcase Incremental - Re/Max"
          ? (opp.rawProduct || opp.product)
          : opp.product;
        return <span className="truncate">{displayProduct(display) || "—"}</span>;
      }
      if (col.key === "rep") {
        return <span className="truncate">{opp.rep || "—"}</span>;
      }
    }
    if (col.key === "oppName") {
      return (
        <a href={sfLinkFor(opp, "opp")} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline inline-flex items-center gap-1 max-w-full">
          <span className="truncate">{opp.oppName || "—"}</span>
          <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
        </a>
      );
    }
    if (col.key === "accountName") {
      return (
        <a href={sfLinkFor(opp, "account")} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline inline-flex items-center gap-1 max-w-full">
          <span className="truncate">{opp.accountName || "—"}</span>
          <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
        </a>
      );
    }
    if (col.key === "amount") {
      return <span>${displayedAmount(opp).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
    }
    if (col.key === "mrr") {
      // Compensable mode: MRR column shows RAW (untreated) MRR.
      const v = isComp ? displayedRawMrr(opp) : displayedMrr(opp);
      return <span className="font-bold">${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
    }
    if (col.key === "compensableMrr") {
      return <span className="font-bold">${displayedMrr(opp).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
    }
    if (col.key === "multipliers") {
      return <span className="truncate tabular-nums">{multipliersText(opp)}</span>;
    }
    if (col.key === "rules") {
      return renderRulesCount(ruleNamesOf(opp));
    }
    if (col.key === "mrrField") {
      const f = opp.appliedMrrField;
      if (!f) return <span className="text-muted-foreground">Default</span>;
      const label = MRR_FIELD_LABELS[f] ?? f;
      const labels = opp.mrrFieldRuleLabels ?? [];
      const conflict = labels.length > 1;
      const tipLines: string[] = [];
      if (opp.mrrFieldWinner) tipLines.push(`Set by rule: ${opp.mrrFieldWinner}`);
      if (conflict) tipLines.push(`Matched ${labels.length} MRR-field rules:\n${labels.join("\n")}`);
      if (tipLines.length === 0) return <span className="truncate">{label}</span>;
      return (
        <span
          className={`truncate cursor-help inline-flex items-center gap-1 ${conflict ? "text-amber-600" : ""}`}
          onMouseEnter={(ev: React.MouseEvent) => reasonTip.showTooltipDelayed(tipLines.join("\n\n"), ev, "MRR Field")}
          onMouseMove={reasonTip.trackMouseMove}
          onMouseLeave={reasonTip.hideTooltip}
        >
          {label}
          {conflict && <AlertTriangle className="w-3 h-3 shrink-0" />}
        </span>
      );
    }
    if (col.key === "product") {
      const multi = isMultiOpp(opp);
      if (!multi) return <span className="truncate">{displayProduct(displayedProduct(opp))}</span>;
      const isOpen = !!opp.oppId && expandedMulti.has(`${opp.oppId}|${opp.rep}`);
      const tip = lineItemsOf(opp).map(li => displayProduct(li.product)).join(", ");
      return (
        <span className="inline-flex items-center gap-1 max-w-full">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (opp.oppId) toggleExpandMulti(`${opp.oppId}|${opp.rep}`); }}
            className="shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
            aria-label={isOpen ? "Collapse line items" : "Expand line items"}
            title={isOpen ? "Hide line items" : `Line items: ${tip}`}
          >
            {isOpen
              ? <ChevronDown className="w-3.5 h-3.5 text-[#006AFF]" />
              : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
          </button>
          <span className="truncate font-medium" title={tip}>{displayProduct(displayedProduct(opp))}</span>
        </span>
      );
    }
    if (col.key === "funnelStage") {
      return renderStageWithInfo(opp.overageReclassified, opp.funnelStage);
    }
    if (col.key === "probability") {
      return <ProbabilityCell opp={opp} />;
    }
    const val = opp[col.key as keyof Opportunity];
    return <span className="truncate">{String(val)}</span>;
  };

  const isNumCol = (key: SortKey) => key === "amount" || key === "mrr" || key === "probability" || key === "compensableMrr" || key === "rules";

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={modalTitle}
        className="bg-white dark:bg-[#0f1d32] rounded-lg shadow-2xl w-full max-w-[95vw] max-h-[92vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="text-[16px] font-bold text-foreground truncate inline-flex items-center gap-2">
              {modalTitle}
              {mode === "churn" && (
                <div className="relative inline-block" ref={churnLogicRef}>
                  <button
                    onClick={() => setShowChurnLogic(s => !s)}
                    className="text-[10px] text-[#006AFF] hover:underline cursor-pointer font-normal"
                  >
                    Churn Logic
                  </button>
                  {showChurnLogic && (
                    <div className="absolute left-0 top-6 z-50 w-[400px] bg-white dark:bg-[#1a2744] border border-border rounded-md shadow-lg p-3 text-[11px] font-normal">
                      <div className="font-semibold text-[12px] mb-2 text-[#1e293b] dark:text-white">Churn Logic</div>
                      <div className="space-y-2 text-[#64748b] dark:text-[#94a3b8]">
                        <div>
                          <span className="font-medium text-[#1e293b] dark:text-white">G&R Churn:</span> All negative-value Closed Won opportunities within the selected timeframe. Includes all churn regardless of matching positive sales.
                        </div>
                        <div>
                          <span className="font-medium text-[#1e293b] dark:text-white">ACQ Churn:</span> Only negative-value Closed Won opportunities where a matching positive Closed Won opportunity exists for the same rep, account, and product within the same timeframe.
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </h2>
            <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground">
              <span>{dateStr} · {timeStr} ({userTz})</span>
              <span className="text-foreground font-medium">{visibleOpps.length} {isMods ? "records" : "opportunities"}{isComp
                ? `${isAdmin ? ` · $${totalRawMrr.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} raw MRR` : ""} · $${totalMrr.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${compMrrLabel}`
                : ` · $${summaryVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${summaryLabel}`}</span>
              {mode === "mrr" && (
                <span className="text-foreground font-medium">· Closed Won: {closedWonCount} opps · ${closedWonMrrTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              )}
            </div>
            {activeFilters.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {activeFilters.map(f => (
                  <span key={f} className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#006AFF]/10 text-[#006AFF]">{f}</span>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 ml-4 shrink-0">
            {(unreviewedInScope > 0 || onlyUnreviewed) && (
              <button
                type="button"
                onClick={() => setOnlyUnreviewed(v => !v)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium border rounded-md transition-all [&_svg]:pointer-events-none ${
                  onlyUnreviewed
                    ? "bg-yellow-100 border-yellow-300 text-yellow-800 dark:bg-yellow-900/20 dark:border-yellow-700 dark:text-yellow-300"
                    : "border-border text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5"
                }`}
                title={onlyUnreviewed
                  ? "Showing only unreviewed (probability not yet edited). Click to show all."
                  : `Filter to unreviewed only (${unreviewedInScope} of ${filteredOpps.length})`}
                aria-pressed={onlyUnreviewed}
              >
                {onlyUnreviewed ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                Unreviewed ({unreviewedInScope})
              </button>
            )}
            {isCompCols && ruleNameOptions.length > 0 && (
              <div className="relative" ref={ruleFilterRef}>
                <button
                  type="button"
                  onClick={() => setRuleFilterOpen(v => !v)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium border rounded-md transition-all [&_svg]:pointer-events-none ${
                    selectedRuleNames.length > 0
                      ? "bg-[#006AFF]/10 border-[#006AFF]/40 text-[#006AFF]"
                      : "border-border text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5"
                  }`}
                  title="Filter to opps that had specific compensation rules applied"
                  aria-haspopup="listbox"
                  aria-expanded={ruleFilterOpen}
                >
                  Rules{selectedRuleNames.length > 0 ? ` (${selectedRuleNames.length})` : ""}
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
                {ruleFilterOpen && (
                  <div className="absolute right-0 z-50 mt-1 w-[260px] max-h-[320px] overflow-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg">
                    <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Filter by rule</span>
                      {selectedRuleNames.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSelectedRuleNames([])}
                          className="text-[10px] font-medium text-[#006AFF] hover:underline"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    {ruleNameOptions.map(name => {
                      const checked = selectedRuleNames.includes(name);
                      // Task #358: facet count — opps affected by this rule
                      // under all filters except the rule multi-select itself.
                      const count = ruleFacetCounts.get(name) ?? 0;
                      return (
                        <label
                          key={name}
                          className="flex items-start gap-2 px-2.5 py-1.5 text-[11px] cursor-pointer hover:bg-black/5 dark:hover:bg-white/5"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setSelectedRuleNames(prev => checked ? prev.filter(n => n !== name) : [...prev, name])}
                            className="mt-0.5 accent-[#006AFF]"
                          />
                          <span className="leading-snug break-words flex-1">{name}</span>
                          <span
                            className="shrink-0 text-[11px] tabular-nums"
                            title={`${count} opp${count === 1 ? "" : "s"} affected by this rule`}
                          >
                            {count}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={searchId}
                onChange={e => setSearchId(e.target.value)}
                placeholder="Search by Opp ID or Name"
                className="pl-7 pr-2 py-1.5 text-[11px] border border-border rounded-md w-[200px] bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[#006AFF]"
              />
            </div>
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium border border-border rounded-md hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-foreground"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-black/10 dark:hover:bg-white/10 rounded-md transition-colors text-foreground"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground text-[13px]">Loading opportunities…</div>
          ) : fetchError && sortedOpps.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 h-64 px-6 text-center">
              <div className="text-[13px] font-medium text-red-600 dark:text-red-400">Couldn't load opportunities</div>
              <div className="text-[12px] text-muted-foreground max-w-md">{fetchError}</div>
              <button
                onClick={() => fetchOpps(true)}
                className="mt-1 px-3 py-1.5 text-[12px] font-medium rounded-md border border-border bg-background hover:bg-muted transition-colors"
              >
                Retry
              </button>
            </div>
          ) : sortedOpps.length === 0 && !(isMods && meTotalAmount > 0) ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground text-[13px]">No opportunities found with the current filters.</div>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-gray-50 dark:bg-[#0a1628] z-10">
                <tr>
                  {columns.map(col => (
                    <th
                      key={col.key}
                      className={`${col.width} ${col.key === "rules" ? "text-center" : "text-left"} px-3 py-2.5 font-semibold text-[11px] ${col.key === "mrr" ? "text-foreground font-bold" : "text-muted-foreground"} uppercase tracking-wide cursor-pointer hover:text-foreground select-none whitespace-nowrap`}
                      onClick={() => handleSort(col.key)}
                    >
                      {col.label} <SortIcon col={col.key} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {renderPinnedMeRow()}
                {accountGroups.map((group, gi) => {
                  // Per-opp fragment: the row for the opp itself, plus its
                  // multi-product line-item sub-rows and its linked-opp
                  // sub-rows. When `isGroupChild`, the row is
                  // nested under an expanded multi-opp account group, so the
                  // first cell gets extra left padding to indicate nesting.
                  const renderOppFragment = (opp: Opportunity, idx: number, isGroupChild: boolean) => {
                    const rowKey = opp.oppId ? `${opp.oppId}|${opp.rep}` : `${opp.rep}|${opp.accountId}|${opp.product}|${opp.closeDate}|${gi}-${idx}`;
                    // Task #317: paired-opp rule rows (compensable mode) get the
                    // linked-opp affordance regardless of the funnel mode.
                    const isPaired = isComp && !!opp.pairOppName;
                    const showLinked = (hasCRMode && mode === "churn") || isPaired;
                    const linked = showLinked ? getLinkedOpps(opp) : [];
                    const hasLinked = linked.length > 0;
                    const isExpanded = expandedRows.has(rowKey);
                    const multi = isMultiOpp(opp);
                    const multiOpen = multi && !!opp.oppId && expandedMulti.has(`${opp.oppId}|${opp.rep}`);
                    const lis = multi ? lineItemsOf(opp) : [];
                    return (
                      <React.Fragment key={rowKey}>
                        <tr className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
                          {columns.map((col, ci) => (
                            <td
                              key={col.key}
                              title={col.key === "rules" ? undefined : getCellText(opp, col)}
                              className={`px-3 py-2 ${col.width} ${isNumCol(col.key) ? "text-right font-medium whitespace-nowrap" : col.key === "closeDate" ? "whitespace-nowrap" : "truncate"} ${ci === 0 && isGroupChild ? "pl-8" : ""}`}
                            >
                              {ci === 0 && showLinked ? (
                                <span className="inline-flex items-center gap-1 max-w-full">
                                  {hasLinked ? (
                                    <button
                                      onClick={() => toggleExpand(rowKey)}
                                      className="shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                                      aria-label={isExpanded ? "Collapse linked opps" : "Expand linked opps"}
                                    >
                                      {isExpanded
                                        ? <ChevronDown className="w-3.5 h-3.5 text-[#006AFF]" />
                                        : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
                                    </button>
                                  ) : (isPaired || mode === "churn") ? <span className="w-[18px] shrink-0" /> : null}
                                  {isPaired && (
                                    <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 mr-0.5" title={`${opp.pairRuleLabel ?? "Paired-opp rule"} — "${opp.pairOppName}" linked opp (compensable revenue)`}>{opp.pairOppName}</span>
                                  )}
                                  {renderCell(opp, col)}
                                </span>
                              ) : (
                                renderCell(opp, col)
                              )}
                            </td>
                          ))}
                        </tr>
                        {multiOpen && lis.map((li, lidx) => {
                          const matched = !productFilterSet || productFilterSet.has(li.product);
                          const tone = matched ? "text-foreground" : "text-muted-foreground/60";
                          return (
                            <tr key={`${rowKey}-li-${lidx}`} className={`bg-[#006AFF]/[0.03] dark:bg-[#006AFF]/[0.06] ${matched ? "" : "opacity-60"}`}>
                              {columns.map((col, ci) => (
                                <td
                                  key={col.key}
                                  className={`px-3 py-1 ${col.width} text-[11px] ${isNumCol(col.key) ? `text-right font-medium whitespace-nowrap ${tone}` : col.key === "closeDate" ? `whitespace-nowrap ${tone}` : `truncate ${tone}`} ${ci === 0 && isGroupChild ? "pl-8" : ""}`}
                                >
                                  {ci === 0 ? (
                                    <span className="inline-flex items-center gap-1 max-w-full pl-[22px]">
                                      <span className="text-[10px] mr-1">↳</span>
                                      <span className="truncate">Line item {lidx + 1}</span>
                                    </span>
                                  ) : col.key === "product" ? (
                                    <span className="truncate" title={displayProduct(li.product)}>{displayProduct(li.product) || "—"}</span>
                                  ) : col.key === "amount" ? (
                                    <span>${li.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                  ) : col.key === "mrr" ? (
                                    <span>${(isComp ? (li.rawMrr ?? li.mrr) : li.mrr).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                  ) : col.key === "compensableMrr" ? (
                                    <span>${li.mrr.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                  ) : col.key === "multipliers" ? (
                                    <span className="truncate tabular-nums">{li.pairAdjustmentLabel ? li.pairAdjustmentLabel : ((li.multipliers && li.multipliers.length > 0) ? li.multipliers.map(m => `${m}x`).join(", ") : "1x")}</span>
                                  ) : col.key === "rules" ? (
                                    renderRulesCount(li.ruleNames ?? [])
                                  ) : null}
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                        {(hasCRMode || isPaired) && isExpanded && linked.map((lo, lidx) => (
                          <tr key={`${rowKey}-linked-${lidx}`} className="bg-[#006AFF]/[0.03] dark:bg-[#006AFF]/[0.06]">
                            {columns.map((col, ci) => (
                              <td
                                key={col.key}
                                title={col.key === "rules" ? undefined : getCellText(lo, col)}
                                className={`px-3 py-1.5 ${col.width} ${isNumCol(col.key) ? "text-right font-medium whitespace-nowrap text-[#22c55e]" : col.key === "closeDate" ? "whitespace-nowrap text-muted-foreground" : "truncate text-muted-foreground"} text-[11px] ${ci === 0 && isGroupChild ? "pl-8" : ""}`}
                              >
                                {ci === 0 ? (
                                  <span className="inline-flex items-center gap-1 max-w-full pl-[22px]">
                                    <span className="text-[10px] font-semibold text-[#22c55e] mr-1">+</span>
                                    <a href={sfLinkFor(lo, "opp")} target="_blank" rel="noopener noreferrer" className="text-[#22c55e] hover:underline inline-flex items-center gap-1 max-w-full">
                                      <span className="truncate">{lo.oppName || "—"}</span>
                                      <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
                                    </a>
                                  </span>
                                ) : col.key === "accountName" ? (
                                  <a href={sfLinkFor(lo, "account")} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:underline inline-flex items-center gap-1 max-w-full">
                                    <span className="truncate">{lo.accountName || "—"}</span>
                                    <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
                                  </a>
                                ) : col.key === "amount" ? (
                                  <span className="text-[#22c55e]">${lo.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                ) : col.key === "mrr" ? (
                                  <span className="text-[#22c55e]">${(isComp ? displayedRawMrr(lo) : lo.mrr).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                ) : col.key === "compensableMrr" ? (
                                  <span className="text-[#22c55e]">${displayedMrr(lo).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                ) : col.key === "multipliers" ? (
                                  <span className="truncate tabular-nums text-[#22c55e]">{multipliersText(lo)}</span>
                                ) : col.key === "rules" ? (
                                  renderRulesCount(ruleNamesOf(lo))
                                ) : col.key === "funnelStage" ? (
                                  renderStageWithInfo(lo.overageReclassified, lo.funnelStage, "text-[#22c55e]")
                                ) : (
                                  <span className="truncate">{String(lo[col.key as keyof Opportunity] || "")}</span>
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  };

                  // Single-opp account: render flat (no caret).
                  if (!group.isMulti) {
                    return renderOppFragment(group.opps[0], 0, false);
                  }

                  // Multi-opp account: aggregated parent row + collapsible
                  // child opp rows. Parent row has the account caret on the
                  // first (Account) cell and aggregated values across the
                  // remaining columns.
                  const open = isAccountOpen(group.key);
                  const aggHasNumericClose = parseDate(group.aggCloseDate) > 0;
                  return (
                    <React.Fragment key={`grp-${group.key}`}>
                      <tr className="bg-[#f1f5f9]/60 dark:bg-white/[0.03] hover:bg-black/[0.04] dark:hover:bg-white/[0.05] font-medium">
                        {columns.map((col, ci) => {
                          const baseCls = `px-3 py-2 ${col.width} ${isNumCol(col.key) ? "text-right whitespace-nowrap" : col.key === "closeDate" ? "whitespace-nowrap" : "truncate"}`;
                          if (col.key === "accountName") {
                            return (
                              <td key={col.key} className={baseCls} title={group.accountName}>
                                <span className="inline-flex items-center gap-1 max-w-full">
                                  <button
                                    onClick={() => toggleExpandAccount(group.key)}
                                    className="shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                                    aria-label={open ? "Collapse account opportunities" : "Expand account opportunities"}
                                    title={open ? "Hide opportunities" : `Show ${group.opps.length} opportunities`}
                                  >
                                    {open
                                      ? <ChevronDown className="w-3.5 h-3.5 text-[#006AFF]" />
                                      : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
                                  </button>
                                  {isMods || !group.accountId ? (
                                    <span className="truncate font-semibold text-foreground">{group.accountName || "—"}</span>
                                  ) : (
                                    <a href={sfLinkFor(group.latestOpp, "account")} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline inline-flex items-center gap-1 max-w-full font-semibold">
                                      <span className="truncate">{group.accountName || "—"}</span>
                                      <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
                                    </a>
                                  )}
                                  <span className="shrink-0 ml-1 text-[10px] text-muted-foreground tabular-nums">({group.opps.length})</span>
                                </span>
                              </td>
                            );
                          }
                          if (col.key === "oppName") {
                            const tip = `Multiple — link goes to latest-close-date opp: ${group.latestOpp.oppName}`;
                            if (isMods || !group.latestOpp.oppId) {
                              return <td key={col.key} className={baseCls} title={tip}><span className="truncate italic text-muted-foreground">Multiple</span></td>;
                            }
                            return (
                              <td key={col.key} className={baseCls} title={tip}>
                                <a href={sfLinkFor(group.latestOpp, "opp")} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline inline-flex items-center gap-1 max-w-full">
                                  <span className="truncate italic">Multiple</span>
                                  <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
                                </a>
                              </td>
                            );
                          }
                          if (col.key === "manager") return <td key={col.key} className={baseCls} title={group.aggManager}><span className="truncate">{group.aggManager || "—"}</span></td>;
                          if (col.key === "rep") return <td key={col.key} className={baseCls} title={group.aggRep}><span className="truncate">{group.aggRep || "—"}</span></td>;
                          if (col.key === "type") return <td key={col.key} className={baseCls} title={group.aggType}><span className="truncate">{group.aggType || "—"}</span></td>;
                          if (col.key === "quoteType") return <td key={col.key} className={baseCls} title={group.aggQuoteType}><span className="truncate">{group.aggQuoteType || "—"}</span></td>;
                          if (col.key === "product") return <td key={col.key} className={baseCls} title={displayProduct(group.aggProduct)}><span className="truncate">{displayProduct(group.aggProduct) || "—"}</span></td>;
                          if (col.key === "funnelStage") return <td key={col.key} className={baseCls} title={group.aggFunnelStage}>{renderStageWithInfo(group.aggOverageReclassified, group.aggFunnelStage || "—")}</td>;
                          if (col.key === "closeDate") return <td key={col.key} className={baseCls}><span>{aggHasNumericClose ? group.aggCloseDate : "—"}</span></td>;
                          if (col.key === "amount") return <td key={col.key} className={`${baseCls} font-semibold`}><span>${group.aggAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></td>;
                          if (col.key === "mrr") return <td key={col.key} className={`${baseCls} font-bold`}><span>${(isComp ? group.aggRawMrr : group.aggMrr).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></td>;
                          if (col.key === "compensableMrr") return <td key={col.key} className={`${baseCls} font-bold`}><span>${group.aggMrr.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></td>;
                          // Task #358: collapsed multi-opp rows show the rule
                          // count + hover tooltip of the child opp with the most
                          // rules (same chip used for a single opp).
                          if (col.key === "rules") return <td key={col.key} className={baseCls}>{renderRulesCount(group.aggRuleNames)}</td>;
                          if (col.key === "probability") {
                            return (
                              <td key={col.key} className={baseCls}>
                                <span
                                  className="inline-block w-[58px] text-right text-[11px] tabular-nums px-1.5 py-0.5 rounded border bg-[#f8fafc] border-[#e2e8f0] text-[#64748b]"
                                  title={`Read-only — from latest-close-date opp (${group.latestOpp.oppName || "—"})`}
                                >
                                  {group.aggProbability == null ? "—" : `${group.aggProbability}%`}
                                </span>
                              </td>
                            );
                          }
                          return <td key={col.key} className={baseCls}></td>;
                        })}
                      </tr>
                      {open && group.opps.map((o, idx) => renderOppFragment(o, idx, true))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <DelayedTooltipPortal tooltip={reasonTip.tooltip} />
    </div>
  );
}
