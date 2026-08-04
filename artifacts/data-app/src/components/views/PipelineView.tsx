import React, { useMemo, useState, useEffect, useRef, useCallback, lazy, Suspense } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { FilterState, AggregateBy, PipelineMode, RevenueMode, MultiFilterKey } from "../../pages/Dashboard";
import { PipelineData, useGetProductLogicConfig, type ProductLogicRule, type CompCondition } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { CSVLink } from "react-csv";
import type { CellFormulaValue } from "exceljs";
import { Download, Settings2, X, ChevronLeft, ChevronDown, ChevronRight, Maximize2, Minimize2, BarChart3 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tooltip as UiTooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { getDateRange, formatModsCaption, isTodayWithinPeriod, countBusinessDaysInMonth, isBusinessDay, getTodayPST, computeWindowedRemainingEligibility, passesChannelFilter } from "@/lib/utils";
import type { WindowedRemainingEligibility } from "@/lib/utils";
import { sfReportUrl as buildSfReportUrl } from "@/lib/sf-links";
import { SfReportLink } from "../SfReportLink";
import { displayProduct, displayProductAbbrev, displayProductText } from "@/lib/product-labels";

const ALL_PRODUCTS = ["MBP", "Showcase", "Zillow Pro", "Follow Up Boss", "ZMX"] as const;

// Per-product GnR goal accessor. Reads the rep's data-driven `productGoals`
// map (server source of truth, keyed by canonical product name); falls back to
// the legacy scalar fields only for the two originally-hardcoded products so
// older cached payloads still resolve. Any product without goal data yields 0,
// so new products flow through automatically once finance supplies their goals.
function gnrGoalFor(r: unknown, prod: string, kind: "mrrAdded" | "churn"): number {
  const rep = r as {
    productGoals?: Record<string, { mrrAddedGoal?: number; churnGoal?: number }>;
    scMrrAddedGoal?: number; scChurnGoal?: number;
    mbpMrrAddedGoal?: number; mbpChurnGoal?: number;
  };
  const pg = rep?.productGoals?.[prod];
  if (pg) return kind === "mrrAdded" ? (pg.mrrAddedGoal || 0) : (pg.churnGoal || 0);
  if (prod === "Showcase") return kind === "mrrAdded" ? (rep?.scMrrAddedGoal || 0) : (rep?.scChurnGoal || 0);
  if (prod === "MBP") return kind === "mrrAdded" ? (rep?.mbpMrrAddedGoal || 0) : (rep?.mbpChurnGoal || 0);
  return 0;
}

// Per-product NET goal accessor (MRR-Added − Churn). Reads the rep's
// data-driven `productGoals` map (server source of truth, populated for all
// canonical products once goals come from the Goals tab); falls back to the
// legacy net scalar fields only for the two originally-hardcoded products so
// older cached payloads still resolve. Products without goal data yield 0.
function netGoalFor(r: unknown, prod: string): number {
  const rep = r as {
    productGoals?: Record<string, { netGoal?: number }>;
    showcaseGoal?: number; mbpGoal?: number;
  };
  const pg = rep?.productGoals?.[prod];
  if (pg && Number.isFinite(pg.netGoal)) return pg.netGoal as number;
  if (prod === "Showcase") return rep?.showcaseGoal ?? 0;
  if (prod === "MBP") return rep?.mbpGoal ?? 0;
  return 0;
}

// Ym-aware net goal: Showcase/MBP carry per-month upstream quotas via their
// *ByYm maps, so a specific month slot resolves to that month's value; other
// products fall back to the flat net goal (no per-month upstream split).
function netGoalForYm(r: unknown, prod: string, ym: string): number {
  const rep = r as { showcaseGoalByYm?: Record<string, number>; mbpGoalByYm?: Record<string, number> };
  if (prod === "Showcase") {
    const m = rep?.showcaseGoalByYm;
    if (m && Object.prototype.hasOwnProperty.call(m, ym)) return m[ym];
  } else if (prod === "MBP") {
    const m = rep?.mbpGoalByYm;
    if (m && Object.prototype.hasOwnProperty.call(m, ym)) return m[ym];
  }
  return netGoalFor(r, prod);
}


import type { DrilldownMode } from "../FunnelDrilldownModal";
import { ChurnForecastMERow } from "../ChurnForecastMERow";
import { useUserPreference } from "../../hooks/useUserPreference";
const FunnelDrilldownModal = lazy(() => import("../FunnelDrilldownModal"));
const UnreviewedOppsModal = lazy(() => import("../UnreviewedOppsModal"));
const UnreviewedModsModal = lazy(() => import("../UnreviewedModsModal"));

const SF_OPPS_REPORT = buildSfReportUrl("opps");
const SF_MODS_REPORT = buildSfReportUrl("mods");

const STAGE_MAPPING_INFO = [
  { funnel: "Discovery", raw: "New, Discover, Engage, Influence, Zips Added" },
  { funnel: "Demo Scheduled", raw: "Demo Performed, Presentation" },
  { funnel: "Proposal/Negotiation", raw: "Advance, Committed to Purchase" },
  { funnel: "Paperwork Sent", raw: "Contract Sent" },
  { funnel: "Awaiting Payment", raw: "(direct match)" },
  { funnel: "Closed Won", raw: "Closed: Won" },
  { funnel: "Closed Lost", raw: "Closed Waitlist" },
];

function StageMappingLink() {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!show) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [show]);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => setShow(s => !s)}
        className="text-[10px] text-[#006AFF] hover:underline cursor-pointer"
      >
        Stage Mapping
      </button>
      {show && (
        <div className="absolute left-0 top-5 z-50 w-[320px] bg-white border border-border rounded-md shadow-lg p-3 text-[11px]">
          <div className="font-semibold text-[12px] mb-2 text-[#1e293b]">Salesforce Stage → Funnel Mapping</div>
          <table className="w-full">
            <thead>
              <tr className="text-[#64748b]">
                <th className="text-left pb-1 font-medium">Funnel Stage</th>
                <th className="text-left pb-1 font-medium">Raw Salesforce Stages</th>
              </tr>
            </thead>
            <tbody>
              {STAGE_MAPPING_INFO.map(row => (
                <tr key={row.funnel} className="border-t border-border/50">
                  <td className="py-1 font-medium text-[#1e293b]">{stageLabel(row.funnel)}</td>
                  <td className="py-1 text-[#64748b]">{row.raw}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 pt-2 border-t border-border/50 text-[#64748b]">
            Any unrecognized stages are dynamically caught and mapped to <span className="font-medium text-[#1e293b]">Discovery</span> by default. Check server logs for warnings about unmapped stages.
          </div>
        </div>
      )}
    </div>
  );
}

// The fixed opportunity-type rows shown in the "MRR Logic" popup. `match` is the
// opp `type` value used to resolve the live MRR field from Product Logic; the
// empty match falls through to the catch-all ("Any other (or blank)").
const MRR_LOGIC_ROWS: { type: string; match: string }[] = [
  { type: 'Unified Opp', match: 'Unified Opp' },
  { type: 'Cart', match: 'Cart' },
  { type: 'Checkout', match: 'Checkout' },
  { type: 'Showcase', match: 'Showcase' },
  { type: 'Showcase Incremental', match: 'Showcase Incremental' },
  { type: 'Overage', match: 'Overage' },
  { type: 'Any other (or blank)', match: '' },
];

// Friendly labels for every MRR field the Product Logic engine can select
// (feeder + CPD columns). Mirrors the picker label maps in ProductLogicView.
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

// Numeric-aware, case-insensitive equality — mirrors the server engine's
// valuesEqual so "12" matches "12.0" and casing is ignored.
function mrrLogicValuesEqual(a: string, b: unknown): boolean {
  const sa = String(a).trim();
  const sb = String(b).trim();
  if (sa !== "" && sb !== "") {
    const na = Number(sa);
    const nb = Number(sb);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  }
  return sa.toLowerCase() === sb.toLowerCase();
}

// Mirrors the server engine's matchCondition, but only the opp `type` field is
// known in the popup context; every other field resolves to "" (the same
// default the engine applies to absent fields).
function mrrLogicConditionMatches(typeVal: string, cond: CompCondition): boolean {
  const fv = cond.field === "type" ? typeVal : "";
  switch (cond.op) {
    case "eq":
      return mrrLogicValuesEqual(fv, cond.value);
    case "ne":
      return !mrrLogicValuesEqual(fv, cond.value);
    case "in":
      return Array.isArray(cond.value) && cond.value.some((v) => mrrLogicValuesEqual(fv, v));
    case "notIn":
      return Array.isArray(cond.value) && !cond.value.some((v) => mrrLogicValuesEqual(fv, v));
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
      return String(fv).toLowerCase().includes(String(cond.value).toLowerCase());
    case "notContains":
      return !String(fv).toLowerCase().includes(String(cond.value).toLowerCase());
    default:
      return false;
  }
}

// First-match evaluation mirroring evaluateProductLogic: returns the mrrField of
// the first rule whose conditions all match the given opp type, else the engine
// fallback "changeInMrr" (when nothing matches / no catch-all is configured).
function resolveMrrFieldForType(rules: ProductLogicRule[], typeVal: string): string {
  for (const rule of rules) {
    if (rule.conditions.every((c) => mrrLogicConditionMatches(typeVal, c))) {
      return rule.mrrField;
    }
  }
  return "changeInMrr";
}

function MrrLogicLink() {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Pull the active Product Logic rules so the "MRR Value Used" column always
  // reflects the real engine. Open to all roles (Task #363).
  const { data, isLoading, isError } = useGetProductLogicConfig();
  const rules = data?.config?.rules ?? [];
  const hasRules = rules.length > 0;

  useEffect(() => {
    if (!show) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [show]);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => setShow(s => !s)}
        className="text-[10px] text-[#006AFF] hover:underline cursor-pointer"
      >
        MRR Logic
      </button>
      {show && (
        <div className="absolute left-0 top-5 z-50 w-[420px] bg-white border border-border rounded-md shadow-lg p-3 text-[11px]">
          <div className="font-semibold text-[12px] mb-2 text-[#1e293b]">How Monthly MRR Is Derived</div>
          <table className="w-full">
            <thead>
              <tr className="text-[#64748b]">
                <th className="text-left pb-1 font-medium">Opportunity Type</th>
                <th className="text-left pb-1 font-medium w-[160px]">MRR Value Used</th>
              </tr>
            </thead>
            <tbody>
              {MRR_LOGIC_ROWS.map(row => {
                let value: string;
                if (hasRules) {
                  const field = resolveMrrFieldForType(rules, row.match);
                  value = MRR_FIELD_LABELS[field] ?? field;
                } else {
                  value = isLoading ? "Loading…" : "Unavailable";
                }
                return (
                  <tr key={row.type} className="border-t border-border/50 align-top">
                    <td className="py-1.5 text-[#1e293b]">{displayProductText(row.type)}</td>
                    <td className="py-1.5 font-medium text-[#1e293b]">{value}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-2 pt-2 border-t border-border/50 text-[10px] text-[#64748b]">
            {isError
              ? "Couldn't load live Product Logic rules — values unavailable."
              : "Reflects the live Product Logic attribution rules."}
          </div>
        </div>
      )}
    </div>
  );
}



function ChurnLogicLink() {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!show) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [show]);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => setShow(s => !s)}
        className="text-[10px] text-[#006AFF] hover:underline cursor-pointer"
      >
        Churn Logic
      </button>
      {show && (
        <div className="absolute left-0 top-5 z-50 w-[400px] bg-white border border-border rounded-md shadow-lg p-3 text-[11px]">
          <div className="font-semibold text-[12px] mb-2 text-[#1e293b]">Churn Logic</div>
          <div className="space-y-2 text-[#64748b]">
            <div>
              <span className="font-medium text-[#1e293b]">G&R Churn:</span> All negative-value Closed Won opportunities within the selected timeframe. Includes all churn regardless of matching positive sales.
            </div>
            <div>
              <span className="font-medium text-[#1e293b]">ACQ Churn:</span> Only negative-value Closed Won opportunities where a matching positive Closed Won opportunity exists for the same rep, account, and product within the same timeframe.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PipelineLogicLink() {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!show) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [show]);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => setShow(s => !s)}
        className="text-[10px] text-[#006AFF] hover:underline cursor-pointer"
      >
        Pipeline Logic
      </button>
      {show && (
        <div className="absolute left-0 top-5 z-50 w-[360px] bg-white border border-border rounded-md shadow-lg p-3 text-[11px]">
          <div className="font-semibold text-[12px] mb-2 text-[#1e293b]">Pipeline Logic Explained</div>
          <div className="space-y-2 text-[#64748b]">
            <div>
              By default, only opportunities whose close date falls within the selected timeframe are shown. All funnel stages (including Closed Won and Closed Lost) are filtered to the selected date range.
            </div>
            <div>
              <span className="font-medium text-[#1e293b]">Include Stale Opps:</span> When enabled, includes last month's open opps with close date ≤ end of the filtered timeframe. Closed Won and Closed Lost are still filtered to the selected date range. This gives a full view of current pipeline including stale opportunities that haven't been updated.
            </div>
          </div>
          <div className="mt-2 pt-2 border-t border-border/50 text-[#94a3b8]">
            Data source is filtered to current month and previous month from Salesforce.
          </div>
        </div>
      )}
    </div>
  );
}

function GoalLogicLink() {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!show) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [show]);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => setShow(s => !s)}
        className="text-[10px] text-[#006AFF] hover:underline cursor-pointer"
      >
        Goal Logic
      </button>
      {show && (
        <div className="absolute left-0 top-5 z-50 w-[400px] bg-white border border-border rounded-md shadow-lg p-3 text-[11px]">
          <div className="font-semibold text-[12px] mb-2 text-[#1e293b]">Reading the Goal Bars</div>
          <div className="space-y-2 text-[#64748b]">
            <div>
              <span className="font-medium text-[#1e293b]">Two bars per product:</span> the top bar is <span className="font-medium text-[#1e293b]">MRR Added</span> (actual vs. goal) and the bottom bar is <span className="font-medium text-[#1e293b]">Churn</span> (actual vs. the churn cap).
            </div>
            <div>
              <span className="font-medium text-[#1e293b]">Numbers on each bar:</span> the white number is actual dollars, the <span className="font-medium text-[#1e293b]">$X beat</span> / <span className="font-medium text-[#1e293b]">$X gap</span> label is variance vs. goal, and the far-right <span className="font-medium text-[#1e293b]">%</span> is attainment.
            </div>
            <div>
              <span className="font-medium text-[#1e293b]">Beat vs. gap is inverted:</span> MRR beats when actual is at or above goal; Churn beats when actual is at or under the cap (less churn is better).
            </div>
            <div>
              <span className="font-medium text-[#1e293b]">Colors:</span> the MRR bar is green. The Churn bar is <span className="font-medium" style={{ color: "#00C49F" }}>green</span> under 50% of cap, <span className="font-medium" style={{ color: "#FF6B35" }}>orange</span> 50–79%, and <span className="font-medium" style={{ color: "#EF4444" }}>red</span> at 80%+ — the scale is inverted because low churn is good.
            </div>
            <div>
              <span className="font-medium text-[#1e293b]">Dark vs. light shading:</span> {displayProductText("inside a bar this is the Showcase family split — dark = SC (core Showcase), light = SCi (Showcase Inbound). A solid color means there's no SCi breakdown.")}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ForecastLogicLink() {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!show) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [show]);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => setShow(s => !s)}
        className="text-[10px] text-[#006AFF] hover:underline cursor-pointer"
      >
        Forecast Logic
      </button>
      {show && (
        <div className="absolute left-0 top-5 z-50 w-[400px] bg-white border border-border rounded-md shadow-lg p-3 text-[11px]">
          <div className="font-semibold text-[12px] mb-2 text-[#1e293b]">Reading the Forecast Bars</div>
          <div className="space-y-2 text-[#64748b]">
            <div>
              <span className="font-medium text-[#1e293b]">Two bars per product:</span> the top (<span className="font-medium" style={{ color: "#006AFF" }}>blue</span>) bar is the weighted MRR pipeline and the bottom (<span className="font-medium" style={{ color: "#EF4444" }}>orange/red</span>) bar is weighted churn.
            </div>
            <div>
              <span className="font-medium text-[#1e293b]">WIN RATE:</span> the historical close rate applied to open pipeline to weight it.
            </div>
            <div>
              <span className="font-medium text-[#1e293b]">COVERAGE:</span> total open pipeline relative to the remaining goal.
            </div>
            <div>
              <span className="font-medium text-[#1e293b]">WEIGHTED:</span> pipeline after applying the win rate — the expected contribution toward goal.
            </div>
            <div>
              <span className="font-medium text-[#1e293b]">GAP:</span> what's still missing between the weighted forecast and the goal.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export type ForecastWeights = {
  Discovery: number;
  "Demo Scheduled": number;
  "Proposal/Negotiation": number;
  "Paperwork Sent": number;
  "Awaiting Payment": number;
  "Closed Won": number;
  "Scheduled Mods": number;
};

// Alias retained for readability at the (small number of) Churn Forecast
// read sites. The generated RepPipeline type already declares the optional
// productMods / productModsWeighted / productModsCount maps, so no field
// extension is required here.
type RepPipelineWithMods = NonNullable<PipelineData["reps"]>[number];

interface PipelineViewProps {
  loading: boolean;
  data?: PipelineData;
  filters: FilterState;
  pipelineMode: PipelineMode;
  onPipelineModeChange: (mode: PipelineMode) => void;
  mrrMode: MrrMode;
  onMrrModeChange: (mode: MrrMode) => void;
  revenueMode: RevenueMode;
  subtractMods: boolean;
  weights?: ForecastWeights;
  onWeightsChange?: (w: ForecastWeights) => void;
  groupPreset: string;
  modsStart: "monthStart" | "today";
  onModsStartChange: (v: "monthStart" | "today") => void;
  modsExtend: "none" | "plus30";
  onModsExtendChange: (v: "none" | "plus30") => void;
  modsDateRange: { from?: string; to?: string; fromDate?: Date; toDate?: Date };
  onProductsChange: (products: string[]) => void;
  onSetSlmFilter?: (value: string[]) => void;
  onSetMultiFilter?: (key: MultiFilterKey, value: string[]) => void;
  // Task #560: the raw SLM selection as held in Dashboard state ([] == "All
  // SLMs" sentinel). `filters.slm` may be the channel-resolved effective list
  // (empty selection expanded to every channel-allowed SLM), which is correct
  // for data filtering but not for click-toggle/highlight/snapshot semantics —
  // those must keep operating on the sentinel so clicking an SLM under "All
  // SLMs" selects just that SLM and popup close restores "All SLMs".
  uiSlmFilter?: string[];
  authUser?: { role?: string | null; hierarchyName?: string | null; viewOnly?: boolean };
  prorateQuota: boolean;
  // Task #162: Quota Mode for prorated goal display.
  //   "pacing"    = monthly_goal × (bizdays_in_window / bizdays_in_month)
  //                 — pure time-share, no closed math, no floor.
  //   "remaining" = max(0, monthly_goal − closed_in_window) floored at the
  //                 displayed aggregate level (so overperformer overage fills
  //                 the team bucket at FLM/SLM views).
  // Only consulted when prorateQuota is true; ignored otherwise.
  quotaMode: "pacing" | "remaining";
  holidaySet: Set<string>;
  holidayNameMap?: Map<string, string>;
  holidayFetchError?: boolean;
  // Task #183: The user's most recent dropdown pick — does not change when
  // the prorate snap effect rewrites filters.timeframe to "custom". Used by
  // the Goal-card calendar so the highlight covers all 7 days of the
  // selected week even after actuals were snapped to today→weekEnd.
  selectedTimeframe?: import("../../pages/Dashboard").Timeframe;
  availableProducts?: string[];
}

const formatMrrShort = (val: number) => {
  const sign = val < 0 ? "-" : "";
  const abs = Math.abs(val);
  if (abs >= 1000000) return `${sign}$${(abs / 1000000).toFixed(1)}M`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  return `${sign}$${Math.round(abs).toLocaleString()}`;
};

// Compact human summary of the active filter scope, for the CSV header
// context block emitted from the per-product Forecast drilldown.
function describeActiveFilters(
  filters: FilterState,
  mrrMode: string,
  pipelineMode: string,
): string {
  const parts: string[] = [];
  parts.push(`MRR Mode: ${mrrMode}`);
  parts.push(`Pipeline Mode: ${pipelineMode}`);
  parts.push(`Timeframe: ${filters.timeframe}`);
  if (filters.slm.length > 0) parts.push(`SLM: ${filters.slm.join(", ")}`);
  if (filters.flm.length > 0) parts.push(`FLM: ${filters.flm.join(", ")}`);
  if (filters.rep.length > 0) parts.push(`Rep: ${filters.rep.join(", ")}`);
  if (filters.region.length > 0) parts.push(`Region: ${filters.region.join(", ")}`);
  if (filters.segment.length > 0) parts.push(`Segment: ${filters.segment.join(", ")}`);
  if (filters.group !== "All Channels") parts.push(`Channel: ${filters.group}`);
  if (filters.products.length > 0) parts.push(`Products: ${filters.products.join(", ")}`);
  return parts.join(" | ");
}

interface ProductDrilldownStageRow {
  stage: string;
  val: number;
  wVal: number;
  defaultPct: number;
  currentPct: number;
}
interface ProductDrilldownHeaderProps {
  product: string;
  productTitle: string;
  activeRepNames: string[];
  repCoverageTargets: Record<string, number>;
  defaultTarget: number;
  authUser?: { role?: string | null; hierarchyName?: string | null; viewOnly?: boolean };
  filtersSummary: string;
  stageRows: ProductDrilldownStageRow[];
  modsRow: { stage: string; val: number; wVal: number; defaultPct: number; currentPct: number } | null;
  weightedTotal: number;
  goal: number;
  gap: number;
  winRateToHit: number;
  coverage: number;
  onSaveCoverage: (value: number) => void;
  onOpenUnreviewed: () => void;
}
const ProductDrilldownHeader: React.FC<ProductDrilldownHeaderProps> = ({
  product,
  productTitle,
  activeRepNames,
  repCoverageTargets,
  defaultTarget,
  authUser,
  filtersSummary,
  stageRows,
  modsRow,
  weightedTotal,
  goal,
  gap,
  winRateToHit,
  coverage,
  onSaveCoverage,
  onOpenUnreviewed,
}) => {
  // Average effective coverage across the visible reps in this scope.
  const avgCoverage = useMemo(() => {
    if (activeRepNames.length === 0) return defaultTarget;
    let sum = 0; let n = 0;
    for (const name of activeRepNames) {
      const v = repCoverageTargets[name];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) { sum += v; n += 1; }
    }
    if (n === 0) return defaultTarget;
    return sum / n;
  }, [activeRepNames, repCoverageTargets, defaultTarget]);

  const role = authUser?.role;
  const viewOnly = !!authUser?.viewOnly;
  const canEditCoverage = !viewOnly && (role === "admin" || role === "slm" || role === "exec");
  // SLMs (and admins) can opt their org out of the Sunday reset; default ON when unset.
  const canToggleWeeklyReset = !viewOnly && (role === "admin" || role === "slm" || role === "exec");
  const {
    value: weeklyResetPref,
    setValue: setWeeklyResetPref,
    isLoading: weeklyResetLoading,
  } = useUserPreference<boolean>("weeklyOppReviewReset");
  const weeklyResetEnabled =
    weeklyResetPref === null || weeklyResetPref === undefined ? true : !!weeklyResetPref;

  const [draft, setDraft] = useState<string>(avgCoverage.toFixed(2));
  const debounceRef = useRef<number | null>(null);
  useEffect(() => { setDraft(avgCoverage.toFixed(2)); }, [avgCoverage]);
  useEffect(() => () => { if (debounceRef.current != null) window.clearTimeout(debounceRef.current); }, []);

  const tryCommit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") { setDraft(avgCoverage.toFixed(2)); return; }
    if (!/^\d+(\.\d+)?$/.test(trimmed)) { setDraft(avgCoverage.toFixed(2)); return; }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0 || n > 100) { setDraft(avgCoverage.toFixed(2)); return; }
    const rounded = Math.round(n * 100) / 100;
    if (Math.abs(rounded - avgCoverage) < 0.005) return;
    onSaveCoverage(rounded);
  };

  // CSV: header context + stage rows + (optional) mods row + footer totals.
  const csvData = useMemo(() => {
    const rows: Record<string, string | number>[] = [];
    rows.push({ Stage: `# ${displayProductText(productTitle)}`, "Default %": "", "Current %": "", Unweighted: "", Weighted: "" });
    rows.push({ Stage: `# Filters: ${filtersSummary}`, "Default %": "", "Current %": "", Unweighted: "", Weighted: "" });
    rows.push({ Stage: `# Coverage Target (avg): ${avgCoverage.toFixed(2)}x`, "Default %": "", "Current %": "", Unweighted: "", Weighted: "" });
    rows.push({ Stage: "", "Default %": "", "Current %": "", Unweighted: "", Weighted: "" });
    for (const r of stageRows) {
      rows.push({
        Stage: r.stage,
        "Default %": Math.round(r.defaultPct),
        "Current %": Math.round(r.currentPct),
        Unweighted: Math.round(r.val),
        Weighted: Math.round(r.wVal),
      });
    }
    if (modsRow) {
      rows.push({
        Stage: "Scheduled Mods",
        "Default %": Math.round(modsRow.defaultPct),
        "Current %": Math.round(modsRow.currentPct),
        Unweighted: -Math.round(modsRow.val),
        Weighted: -Math.round(modsRow.wVal),
      });
    }
    const totalUnweighted = stageRows.reduce((s, r) => s + r.val, 0) - (modsRow ? modsRow.val : 0);
    rows.push({ Stage: "", "Default %": "", "Current %": "", Unweighted: "", Weighted: "" });
    rows.push({ Stage: "TOTAL Unweighted", "Default %": "", "Current %": "", Unweighted: Math.round(totalUnweighted), Weighted: "" });
    rows.push({ Stage: "TOTAL Weighted", "Default %": "", "Current %": "", Unweighted: "", Weighted: Math.round(weightedTotal) });
    rows.push({ Stage: "Goal", "Default %": "", "Current %": "", Unweighted: "", Weighted: Math.round(goal) });
    rows.push({ Stage: "Gap (Goal - Weighted)", "Default %": "", "Current %": "", Unweighted: "", Weighted: Math.round(gap) });
    rows.push({ Stage: "Pipeline Coverage (Weighted / Goal)", "Default %": "", "Current %": "", Unweighted: "", Weighted: coverage.toFixed(2) });
    rows.push({ Stage: "Win Rate to Hit (%)", "Default %": "", "Current %": "", Unweighted: "", Weighted: winRateToHit.toFixed(1) });
    return rows;
  }, [productTitle, filtersSummary, avgCoverage, stageRows, modsRow, weightedTotal, goal, gap, coverage, winRateToHit]);

  const csvFilename = `${product.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-forecast-drilldown.csv`;
  const cascadeNote = canEditCoverage
    ? (role === "admin"
        ? `Saves to all ${activeRepNames.length} reps in scope.`
        : `Saves to your ${activeRepNames.length} reps in scope.`)
    : "Read-only. SLMs and Admins can edit.";

  return (
    <div className="px-4 pb-3 pt-1 border-b border-border bg-[#f8fafc]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-[0.5px] text-[#64748b] font-semibold">Coverage:</span>
          {canEditCoverage ? (
            <>
              <input
                type="text"
                inputMode="decimal"
                className="w-16 px-1.5 py-0.5 text-right border border-border rounded bg-white tabular-nums text-[12px] focus:outline-none focus:ring-1 focus:ring-[#006AFF]"
                value={draft}
                onChange={(e) => {
                  const v = e.target.value;
                  setDraft(v);
                  if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
                  debounceRef.current = window.setTimeout(() => tryCommit(v), 800);
                }}
                onBlur={(e) => {
                  if (debounceRef.current != null) { window.clearTimeout(debounceRef.current); debounceRef.current = null; }
                  tryCommit(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (debounceRef.current != null) { window.clearTimeout(debounceRef.current); debounceRef.current = null; }
                    tryCommit((e.target as HTMLInputElement).value);
                  }
                }}
                title={cascadeNote}
              />
              <span className="text-[11px] text-[#64748b]">x</span>
              <span className="text-[10px] text-[#94a3b8] ml-1">{cascadeNote}</span>
            </>
          ) : (
            <>
              <span className="text-[12px] font-semibold tabular-nums text-[#1e293b]">{avgCoverage.toFixed(2)}x</span>
              <span className="text-[10px] text-[#94a3b8] ml-1">avg across {activeRepNames.length} reps</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canToggleWeeklyReset && (
            <label
              className={`flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded border border-border bg-white text-[#1e293b] cursor-pointer hover:bg-[#f1f5f9] transition-colors ${weeklyResetLoading ? "opacity-60" : ""}`}
              title="When on, every Sunday at midnight HST the system clears the 'reviewed' flag on all open opportunities owned by reps under you, so they show up in Unreviewed Opportunities again the following week."
            >
              <input
                type="checkbox"
                className="h-3 w-3 accent-[#006AFF] cursor-pointer"
                checked={weeklyResetEnabled}
                disabled={weeklyResetLoading}
                onChange={(e) => { void setWeeklyResetPref(e.target.checked); }}
              />
              <span>Reset 'Opp Reviewed' status every Sunday</span>
            </label>
          )}
          <button
            type="button"
            onClick={onOpenUnreviewed}
            className="text-[11px] font-medium px-2 py-1 rounded border border-[#FF6B35]/40 text-[#FF6B35] hover:bg-[#FF6B35]/10 transition-colors"
            title="Open opportunities whose probability has never been changed"
          >
            Unreviewed Opportunities
          </button>
          <CSVLink
            data={csvData}
            filename={csvFilename}
            className="text-[11px] font-medium px-2 py-1 rounded border border-border text-[#1e293b] hover:bg-white transition-colors flex items-center gap-1"
            title="Export this drilldown to CSV"
          >
            <Download className="w-3 h-3" /> CSV
          </CSVLink>
        </div>
      </div>
    </div>
  );
};

const StageProbabilityRow: React.FC<{
  stage: string;
  defaultPct: number;
  currentPct: number;
  unweightedMrr: number;
  weightedMrr: number;
  canEdit: boolean;
  onSaveDefault: (v: number) => void;
  accentColor?: string;
  subLabel?: string;
  // Task #116 follow-up: optional opp/mod count rendered next to the
  // stage label as a small badge ("3 mods"). Only used by the new
  // Churn Forecast popup so the count of underlying scheduled mods
  // is visible without opening the funnel drilldown.
  count?: number;
  countSuffix?: string;
  // Task #193: optional expand/collapse caret rendered before the
  // stage label. Used in the aggregate forecast drilldown so users
  // can hide/show the per-product sub-rows beneath each stage.
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}> = ({ stage, defaultPct, currentPct, unweightedMrr, weightedMrr, canEdit, onSaveDefault, accentColor = "#006AFF", subLabel, count, countSuffix, collapsible, collapsed, onToggleCollapse }) => {
  const [draft, setDraft] = useState<string>(String(defaultPct));
  const debounceRef = useRef<number | null>(null);
  useEffect(() => { setDraft(String(defaultPct)); }, [defaultPct]);
  useEffect(() => () => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
  }, []);
  const tryCommit = (raw: string, immediate: boolean) => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    if (!/^\d+$/.test(trimmed)) {
      setDraft(String(defaultPct));
      return;
    }
    let n = Number(trimmed);
    if (!Number.isInteger(n)) {
      setDraft(String(defaultPct));
      return;
    }
    if (n < 0) n = 0;
    if (n > 100) n = 100;
    if (String(n) !== trimmed && immediate) setDraft(String(n));
    if (n === defaultPct) return;
    onSaveDefault(n);
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
  const label = stage === "Proposal/Negotiation" ? "Proposal/Negot." : stage;
  const barPct = Math.min(100, Math.max(0, currentPct));
  const isAccent = accentColor !== "#006AFF";
  const valueTextClass = isAccent ? "" : "text-[#1e293b]";
  const valueTextStyle = isAccent ? { color: accentColor } : undefined;
  return (
    <div className="grid grid-cols-[1fr_92px_64px_1fr_70px_70px] items-center gap-2 py-1.5 text-[12px] border-b border-border/50 last:border-b-0">
      <div className="truncate" title={stage}>
        <div className={isAccent ? "font-medium flex items-center gap-1.5" : "text-[#1e293b] flex items-center gap-1.5"} style={valueTextStyle}>
          {collapsible && (
            <button
              type="button"
              onClick={onToggleCollapse}
              className="shrink-0 w-4 h-4 flex items-center justify-center text-[#94a3b8] hover:text-[#1e293b] -ml-0.5 rounded hover:bg-black/5"
              title={collapsed ? "Expand product breakdown" : "Collapse product breakdown"}
              aria-label={collapsed ? "Expand product breakdown" : "Collapse product breakdown"}
            >
              {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
          <span>{label}</span>
          {typeof count === "number" && (
            <span className="text-[9px] tabular-nums px-1 py-px rounded bg-black/5 text-[#475569]" title={`${count} ${countSuffix || "items"}`}>
              {count} {countSuffix || ""}
            </span>
          )}
        </div>
        {subLabel && <div className="text-[9px] text-[#94a3b8] leading-tight">{subLabel}</div>}
      </div>
      <div className="flex items-center justify-center gap-1">
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          value={draft}
          disabled={!canEdit}
          title={canEdit ? "Stage default probability" : "View only — managers can edit"}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          style={canEdit ? { ["--tw-ring-color" as any]: accentColor } : undefined}
          className={`w-[58px] text-right text-[12px] tabular-nums px-1.5 py-0.5 rounded border focus:outline-none focus:ring-1 ${canEdit ? "border-[#cbd5e1] bg-white" : "border-[#e2e8f0] bg-[#f8fafc] text-[#64748b] cursor-not-allowed"}`}
        />
        <span className="text-[#64748b]">%</span>
      </div>
      <div className="text-center tabular-nums font-medium" style={{ color: accentColor }}>
        {currentPct.toFixed(0)}%
      </div>
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div className="h-full transition-all rounded-full" style={{ width: `${barPct}%`, backgroundColor: accentColor }} />
      </div>
      <div className={`text-right tabular-nums ${valueTextClass}`} style={valueTextStyle}>{formatMrrShort(unweightedMrr)}</div>
      <div className="text-right tabular-nums font-semibold" style={{ color: accentColor }}>{formatMrrShort(weightedMrr)}</div>
    </div>
  );
};

const PRODUCT_ABBREV: Record<string, string> = {
  "MBP": "MBP",
  "Follow Up Boss": "FUB",
  "Showcase": "SC",
  "Showcase Incremental": "SCI",
  "Showcase Incremental - Re/Max": "SCI-R",
  "Overage": "OV",
  "Zillow Pro": "Zpro",
  "ZMX": "ZMX",
  "ShowingTimePlus Showcase": "STP",
  "ShowingTimePlus Showcase; Zillow Pro": "SC+Zpro",
  "No Product Selected": "NA",
};

const PRODUCT_COLORS: Record<string, string> = {
  "MBP": "#006AFF",
  "Follow Up Boss": "#EAB308",
  "Showcase": "#FF6B35",
  "Zillow Pro": "#7C3AED",
  "ZMX": "#10B981",
  "ShowingTimePlus Showcase": "#F59E0B",
  "ShowingTimePlus Showcase; Zillow Pro": "#EC4899",
  "No Product Selected": "#FCA5A5",
};

const DEFAULT_PRODUCT_COLORS = ["#006AFF", "#00C49F", "#FF6B35", "#7C3AED", "#F59E0B", "#EC4899", "#14B8A6", "#8B5CF6"];

function lightenHex(hex: string, amt: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amt);
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

function getProductColor(product: string, index: number): string {
  // SCI consistently renders as a lighter shade of the Showcase palette color
  // across funnel, MRR, and other product bar charts.
  if (product === "Showcase Incremental") {
    return lightenHex(PRODUCT_COLORS["Showcase"] || "#FF6B35", 0.55);
  }
  // SCI-R renders as an even lighter shade of the Showcase palette color so
  // it stays visually distinct from both Showcase (full strength) and SCI
  // (mid-light) in stacked bar charts where all three may appear together.
  if (product === "Showcase Incremental - Re/Max") {
    return lightenHex(PRODUCT_COLORS["Showcase"] || "#FF6B35", 0.75);
  }
  return PRODUCT_COLORS[product] || DEFAULT_PRODUCT_COLORS[index % DEFAULT_PRODUCT_COLORS.length];
}

function getProductAbbrev(product: string): string {
  return displayProductAbbrev(product, PRODUCT_ABBREV[product] || product.substring(0, 3).toUpperCase());
}

// "May 17th, 2026"
function ordinalSuffix(d: number): string {
  if (d >= 11 && d <= 13) return "th";
  switch (d % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}
function formatLongDate(d: Date): string {
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${months[d.getMonth()]} ${d.getDate()}${ordinalSuffix(d.getDate())}, ${d.getFullYear()}`;
}

const STAGE_DISPLAY_LABELS: Record<string, string> = {
  "Proposal/Negotiation": "Proposal",
};
const stageLabel = (s: string) => STAGE_DISPLAY_LABELS[s] || s;

const FUNNEL_STAGE_COLORS: Record<string, string> = {
  "Discovery": "#006AFF",
  "Demo Scheduled": "#00C49F",
  "Proposal/Negotiation": "#FF6B35",
  "Paperwork Sent": "#7C3AED",
  "Awaiting Payment": "#F59E0B",
  "Closed Won": "#00C49F",
  "Closed Lost": "#EF4444",
};

const formatCurrency = (val: number) => {
  const sign = val < 0 ? "-" : "";
  const abs = Math.abs(val);
  if (abs >= 1000000) return `${sign}$${(abs / 1000000).toFixed(1)}M`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  return `${sign}$${Math.round(abs).toLocaleString()}`;
};

const formatCurrencyFull = (val: number) => {
  const sign = val < 0 ? "-" : "";
  const abs = Math.abs(val);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatCurrencyShort = (val: number) => {
  const sign = val < 0 ? "-" : "";
  const abs = Math.abs(val);
  if (abs >= 1000000) return `${sign}${(abs / 1000000).toFixed(1)}M`;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}K`;
  return `${sign}${Math.round(abs).toLocaleString()}`;
};

interface StackedBarEntry {
  name: string;
  total: number;
  [key: string]: number | string;
}

// Rich hover tooltip + enlarged-bar renderer for individual multi-product bars.
// Renders the inline stacked bar exactly as before, but augments the basic
// `title` hover with a portal tooltip showing a larger version of the bar plus
// a per-product table (full currency + percentage). Only used in multi-product
// mode; single-product bars keep their plain rendering.
function MultiProductStackedBar({
  entry,
  products,
  widthPct,
  labelThresholdPct,
  labelClassName,
  rounded = "rounded-r",
}: {
  entry: StackedBarEntry;
  products: string[];
  widthPct: number;
  labelThresholdPct: number;
  labelClassName: string;
  rounded?: string;
}) {
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const TT_W = 280;
  const TT_MAX_H = 360;
  const clamp = (clientX: number, clientY: number) => {
    let x = clientX + 16;
    let y = clientY + 16;
    if (typeof window !== "undefined") {
      if (x + TT_W > window.innerWidth - 8) x = clientX - TT_W - 16;
      if (x < 8) x = 8;
      if (y + TT_MAX_H > window.innerHeight - 8) y = Math.max(8, window.innerHeight - TT_MAX_H - 8);
    }
    return { x, y };
  };

  const segs = products
    .map((prod, pi) => ({ prod, pi, val: (entry[prod] as number) || 0 }))
    .filter(s => s.val > 0);

  return (
    <>
      <div
        className={`flex h-full ${rounded} overflow-hidden`}
        style={{ width: `${widthPct}%` }}
        onMouseEnter={(e) => { setHover(true); setPos(clamp(e.clientX, e.clientY)); }}
        onMouseMove={(e) => setPos(clamp(e.clientX, e.clientY))}
        onMouseLeave={() => setHover(false)}
      >
        {segs.map(({ prod, pi, val }) => {
          const pct = entry.total > 0 ? (val / entry.total) * 100 : 0;
          return (
            <div
              key={prod}
              className="h-full flex items-center justify-center overflow-hidden"
              style={{ width: `${pct}%`, backgroundColor: getProductColor(prod, pi), minWidth: 2 }}
            >
              {pct > labelThresholdPct && (
                <span className={labelClassName}>
                  {getProductAbbrev(prod)} {formatCurrencyShort(val)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {hover && segs.length > 0 && createPortal(
        <div
          className="bg-white border border-border rounded-lg shadow-xl p-3"
          style={{ position: "fixed", top: pos.y, left: pos.x, width: TT_W, zIndex: 10000, pointerEvents: "none" }}
        >
          <div className="text-[12px] font-semibold text-[#1e293b] mb-1 truncate">{entry.name}</div>
          <div className="flex h-5 rounded overflow-hidden mb-2 w-full">
            {segs.map(({ prod, pi, val }) => {
              const pct = entry.total > 0 ? (val / entry.total) * 100 : 0;
              return (
                <div
                  key={prod}
                  className="h-full flex items-center justify-center overflow-hidden"
                  style={{ width: `${pct}%`, backgroundColor: getProductColor(prod, pi), minWidth: 2 }}
                >
                  {pct > 12 && (
                    <span className="text-[9px] text-white font-medium truncate px-0.5">{getProductAbbrev(prod)}</span>
                  )}
                </div>
              );
            })}
          </div>
          <table className="w-full text-[11px] tabular-nums">
            <tbody>
              {segs.map(({ prod, pi, val }) => {
                const pct = entry.total > 0 ? (val / entry.total) * 100 : 0;
                return (
                  <tr key={prod}>
                    <td className="py-0.5 pr-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: getProductColor(prod, pi) }} />
                        <span className="text-[#475569] truncate">{displayProduct(prod)}</span>
                      </span>
                    </td>
                    <td className="py-0.5 text-right font-medium text-[#1e293b] whitespace-nowrap">{formatCurrencyFull(val)}</td>
                    <td className="py-0.5 pl-2 text-right text-[#94a3b8] whitespace-nowrap">{pct.toFixed(1)}%</td>
                  </tr>
                );
              })}
              <tr className="border-t border-border">
                <td className="pt-1 pr-2 font-semibold text-[#1e293b]">Total</td>
                <td className="pt-1 text-right font-semibold text-[#1e293b] whitespace-nowrap">{formatCurrencyFull(entry.total)}</td>
                <td className="pt-1 pl-2 text-right text-[#94a3b8]">100%</td>
              </tr>
            </tbody>
          </table>
        </div>,
        document.body
      )}
    </>
  );
}

// Read-only popup showing an enlarged, fully-labeled version of a stacked bar
// chart plus a per-row breakdown of each product's full dollar value. Used by
// the MRR leaderboard, Churn card, and Pipeline Funnel card when 2+ products
// are selected so squeezed inline labels remain readable. Dismiss via close
// button, backdrop click, or Esc. No drilldowns or row interactions inside.
function EnlargedBarChartPopup({
  title,
  rows,
  products,
  onClose,
  nameLabel,
}: {
  title: string;
  rows: StackedBarEntry[];
  products: string[];
  onClose: () => void;
  nameLabel?: (name: string) => string;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const maxVal = Math.max(...rows.map(r => r.total), 1);
  const label = nameLabel || ((n: string) => n);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[860px] max-w-[95vw] max-h-[88vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-border sticky top-0 bg-white z-10">
          <div className="text-[15px] font-semibold text-[#1e293b]">{title}</div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded transition-colors" aria-label="Close">
            <X className="w-4 h-4 text-[#64748b]" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          {rows.map((entry) => {
            const segs = products
              .map((prod, pi) => ({ prod, pi, val: (entry[prod] as number) || 0 }))
              .filter(s => s.val > 0);
            const barWidthPct = Math.max(entry.total > 0 ? 1 : 0, (entry.total / maxVal) * 100);
            return (
              <div key={entry.name} className="border-b border-border/40 pb-3 last:border-0 last:pb-0">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[13px] font-semibold text-[#1e293b] truncate">{label(entry.name)}</span>
                  <span className="text-[13px] font-semibold text-[#1e293b] tabular-nums whitespace-nowrap pl-3">{formatCurrencyFull(entry.total)}</span>
                </div>
                <div className="relative w-full mb-2" style={{ height: 28 }}>
                  <div className="flex h-full rounded overflow-hidden" style={{ width: `${barWidthPct}%`, minWidth: entry.total > 0 ? 2 : 0 }}>
                    {segs.map(({ prod, pi, val }) => {
                      const pct = entry.total > 0 ? (val / entry.total) * 100 : 0;
                      return (
                        <div
                          key={prod}
                          className="h-full flex items-center justify-center overflow-hidden"
                          style={{ width: `${pct}%`, backgroundColor: getProductColor(prod, pi), minWidth: 2 }}
                        >
                          {pct > 10 && (
                            <span className="text-[10px] text-white font-semibold truncate px-1">
                              {getProductAbbrev(prod)} {formatCurrencyFull(val)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {segs.map(({ prod, pi, val }) => (
                    <span key={prod} className="inline-flex items-center gap-1.5 text-[11px] tabular-nums">
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: getProductColor(prod, pi) }} />
                      <span className="text-[#475569]">{displayProduct(prod)}</span>
                      <span className="font-medium text-[#1e293b]">{formatCurrencyFull(val)}</span>
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );
}

// Small bar-chart icon button that opens the EnlargedBarChartPopup. Only shown
// when 2+ products are selected (handled by callers).
function EnlargeChartButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="inline-flex items-center gap-1 text-[10px] text-[#64748b] hover:text-[#006AFF] transition-colors print:hidden"
      title="View full product breakdown"
    >
      <BarChart3 className="w-3 h-3" />
      <span>Breakdown</span>
    </button>
  );
}

function ModsWindowLink({
  fromDate,
  toDate,
  modsStart,
  onModsStartChange,
  modsExtend,
  onModsExtendChange,
  todayInPeriod,
}: {
  fromDate?: Date;
  toDate?: Date;
  modsStart: "monthStart" | "today";
  onModsStartChange: (v: "monthStart" | "today") => void;
  modsExtend: "none" | "plus30";
  onModsExtendChange: (v: "none" | "plus30") => void;
  todayInPeriod: boolean;
}) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!show) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [show]);

  const caption = formatModsCaption(fromDate, toDate);
  const baseSeg = "px-2 py-0.5 text-[10px] font-medium transition-colors";
  const isLink = !!fromDate;

  return (
    <div className="relative inline-block mt-0.5" ref={ref}>
      <button
        type="button"
        onClick={() => isLink && setShow(s => !s)}
        className={`text-[10px] ${isLink ? "text-[#006AFF] hover:underline cursor-pointer" : "text-[#64748b] cursor-default"}`}
        disabled={!isLink}
      >
        {caption}
      </button>
      {show && (
        <div className="absolute left-0 top-5 z-50 w-[260px] bg-white border border-border rounded-md shadow-lg p-3 text-[11px]">
          <div className="font-semibold text-[12px] mb-2 text-[#1e293b]">Scheduled Mods Window</div>

          <div className="mb-2">
            <div className="text-[#64748b] mb-1">Start from</div>
            <div className="inline-flex rounded border border-[#e2e8f0] overflow-hidden" role="group">
              <button
                type="button"
                className={`${baseSeg} ${modsStart === "monthStart" ? "bg-[#006AFF] text-white" : "bg-transparent text-[#64748b] hover:bg-black/5"}`}
                onClick={() => onModsStartChange("monthStart")}
                aria-pressed={modsStart === "monthStart"}
              >
                Month start
              </button>
              <button
                type="button"
                className={`${baseSeg} border-l border-[#e2e8f0] ${modsStart === "today" ? "bg-[#006AFF] text-white" : "bg-transparent text-[#64748b] hover:bg-black/5"} ${!todayInPeriod ? "opacity-40 cursor-not-allowed" : ""}`}
                onClick={() => todayInPeriod && onModsStartChange("today")}
                disabled={!todayInPeriod}
                aria-pressed={modsStart === "today"}
                title={!todayInPeriod ? "Today is outside the selected period" : ""}
              >
                Today
              </button>
            </div>
          </div>

          <div className="mb-2">
            <div className="text-[#64748b] mb-1">Extend by</div>
            <div className="inline-flex rounded border border-[#e2e8f0] overflow-hidden" role="group">
              <button
                type="button"
                className={`${baseSeg} ${modsExtend === "none" ? "bg-[#006AFF] text-white" : "bg-transparent text-[#64748b] hover:bg-black/5"}`}
                onClick={() => onModsExtendChange("none")}
                aria-pressed={modsExtend === "none"}
              >
                None
              </button>
              <button
                type="button"
                className={`${baseSeg} border-l border-[#e2e8f0] ${modsExtend === "plus30" ? "bg-[#006AFF] text-white" : "bg-transparent text-[#64748b] hover:bg-black/5"}`}
                onClick={() => onModsExtendChange("plus30")}
                aria-pressed={modsExtend === "plus30"}
              >
                +30 days
              </button>
            </div>
          </div>

          <div className="mt-2 pt-2 border-t border-border/50 text-[#64748b]">
            Filtering by Schedule Mod Date.
          </div>
        </div>
      )}
    </div>
  );
}

function StackedHorizontalBar({ data, products, height, barColor, csvData, csvFilename, title, titleSum, sfReportUrl, onTitleClick, onNameClick, headerExtra }: {
  data: StackedBarEntry[];
  products: string[];
  height: number;
  barColor: string;
  csvData: Array<{ name: string; value: number }>;
  csvFilename: string;
  title: string;
  titleSum?: React.ReactNode;
  sfReportUrl?: string;
  onTitleClick?: () => void;
  onNameClick?: (name: string) => void;
  headerExtra?: React.ReactNode;
}) {
  const isMultiProduct = products.length > 1;
  const barHeight = 16;
  const rowHeight = 26;
  const maxVal = Math.max(...data.map(d => d.total), 1);
  const [popupOpen, setPopupOpen] = useState(false);

  return (
    <Card className="no-shadow flex flex-col">
      <CardHeader className="px-4 pt-4 pb-2 flex-row items-center justify-between space-y-0">
        <div>
          <div className="flex items-center gap-2">
            {onTitleClick ? (
              <CardTitle className="text-[16px] font-semibold cursor-pointer hover:text-[#006AFF] transition-colors" onClick={onTitleClick}>{title}</CardTitle>
            ) : (
              <CardTitle className="text-[16px] font-semibold">{title}</CardTitle>
            )}
            {titleSum != null && (
              <span className="text-[16px] font-semibold text-[#1e293b] tabular-nums">{titleSum}</span>
            )}
          </div>
          {(headerExtra || sfReportUrl || isMultiProduct) && (
            <div className="flex items-center gap-2 flex-wrap">
              {headerExtra}
              {sfReportUrl && <SfReportLink href={sfReportUrl} />}
              {isMultiProduct && <EnlargeChartButton onClick={() => setPopupOpen(true)} />}
            </div>
          )}
        </div>
        <CSVLink data={csvData} filename={csvFilename} className="print:hidden p-1 hover:bg-black/5 rounded">
          <Download className="w-3.5 h-3.5" />
        </CSVLink>
      </CardHeader>
      <CardContent className="p-0" style={{ height, overflow: 'hidden' }}>
        <div style={{ height, overflowY: 'auto', overflowX: 'hidden', padding: '0 16px 16px' }}>
          <div style={{ height: Math.max(height, data.length * rowHeight) }}>
            {data.map((entry, i) => (
              <div
                key={entry.name}
                className={`flex items-center ${onNameClick ? "cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.03] rounded transition-colors" : ""}`}
                style={{ height: rowHeight }}
                onClick={onNameClick ? () => onNameClick(entry.name) : undefined}
                role={onNameClick ? "button" : undefined}
                tabIndex={onNameClick ? 0 : undefined}
                onKeyDown={onNameClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onNameClick(entry.name); } } : undefined}
              >
                <div
                  className="w-[80px] shrink-0 pr-2 text-[11px] text-[#64748b] text-right truncate"
                  title={entry.name}
                >
                  {entry.name}
                </div>
                <div className="flex-1 relative mr-2" style={{ height: barHeight }}>
                  {isMultiProduct ? (
                    <MultiProductStackedBar
                      entry={entry}
                      products={products}
                      widthPct={Math.max(entry.total > 0 ? 2 : 0, (entry.total / maxVal) * 100)}
                      labelThresholdPct={15}
                      labelClassName="text-[8px] text-white font-medium truncate px-0.5"
                    />
                  ) : (
                    <div
                      className="h-full rounded-r"
                      style={{
                        width: `${Math.max(entry.total > 0 ? 2 : 0, (entry.total / maxVal) * 100)}%`,
                        backgroundColor: isMultiProduct ? getProductColor(products[0], 0) : barColor,
                      }}
                    />
                  )}
                </div>
                <div className="w-[50px] shrink-0 text-right text-[11px] text-[#64748b] font-medium">
                  {formatCurrency(entry.total)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
      {popupOpen && isMultiProduct && (
        <EnlargedBarChartPopup
          title={title}
          rows={data}
          products={products}
          onClose={() => setPopupOpen(false)}
        />
      )}
    </Card>
  );
}

export type MrrMode = "gnrNet" | "acqNet" | "added";

const MRR_MODE_LABELS: Record<MrrMode, string> = {
  gnrNet: "G&R Net",
  acqNet: "ACQ MRR",
  added: "Gross MRR",
};

function MrrModeLogicLink() {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!show) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [show]);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => setShow(s => !s)}
        className="text-[10px] text-[#006AFF] hover:underline cursor-pointer"
      >
        MRR Mode Explained
      </button>
      {show && (
        <div className="absolute left-0 top-5 z-50 w-[420px] bg-white border border-border rounded-md shadow-lg p-3 text-[11px]">
          <div className="font-semibold text-[12px] mb-2 text-[#1e293b]">MRR Mode Definitions</div>
          <div className="space-y-3 text-[#64748b]">
            <div>
              <span className="font-medium text-[#1e293b]">G&R Net MRR:</span> All Closed Won opportunities (positive and negative) filtered by close date within the selected timeframe. Does not include Scheduled Mods.
            </div>
            <div>
              <span className="font-medium text-[#1e293b]">ACQ MRR (ACQ Single Month MRR):</span> All Closed Won opportunities with positive values, plus in-month churn, defined as: Closed Won opportunities with negative MRR where a matching positive MRR Closed Won opportunity exists for the same rep, account, and product within the same timeframe. Does not include Scheduled Mods.
            </div>
          </div>
          <div className="mt-2 pt-2 border-t border-border/50 text-[#94a3b8]">
            Churn = negative-value Closed Won opportunities. The difference between G&R and ACQ is which churn counts: G&R includes all churn, ACQ only includes churn where the rep also had a positive sale for the same account + product in the period.
          </div>
        </div>
      )}
    </div>
  );
}

export function PipelineSettingsPopup({
  mrrMode,
  onMrrModeChange,
  revenueMode,
  onRevenueModeChange,
  canUseCompensable,
  eRepOverride,
  onERepOverrideChange,
  pipelineMode,
  onPipelineModeChange,
  subtractMods,
  onSubtractModsChange,
  prorateQuota,
  onProrateQuotaChange,
  quotaMode,
  onQuotaModeChange,
  quotaModeFallbackActive,
  holidayFetchError,
  onSaveDefaults,
  onResetDefaults,
  hasSavedDefaults,
  remainingForcedPacing,
  selectedTimeframe,
}: {
  mrrMode: MrrMode;
  onMrrModeChange: (m: MrrMode) => void;
  revenueMode: RevenueMode;
  onRevenueModeChange: (m: RevenueMode) => void;
  canUseCompensable: boolean;
  // Task #484: "eReps Override" toggle — forces every rep's eRep multiplier to
  // 1x in the displayed goals. Visible to all Pipeline viewers (not gated by
  // canUseCompensable).
  eRepOverride: boolean;
  onERepOverrideChange: (v: boolean) => void;
  pipelineMode: PipelineMode;
  onPipelineModeChange: (m: PipelineMode) => void;
  subtractMods: boolean;
  onSubtractModsChange: (v: boolean) => void;
  prorateQuota: boolean;
  onProrateQuotaChange: (v: boolean) => void;
  quotaMode: "pacing" | "remaining";
  onQuotaModeChange: (m: "pacing" | "remaining") => void;
  quotaModeFallbackActive?: boolean;
  holidayFetchError?: boolean;
  onSaveDefaults?: () => void | Promise<void>;
  onResetDefaults?: () => void | Promise<void>;
  hasSavedDefaults?: boolean;
  remainingForcedPacing?: boolean;
  // Task #183: User-picked timeframe (pre-snap). When "custom", proration
  // is not allowed and the toggle is greyed out.
  selectedTimeframe?: import("../../pages/Dashboard").Timeframe;
}) {
  // Reference unused prop to avoid TS noUnusedParameters and to make
  // intent explicit — Pacing UI was hidden in Task #183 but the prop
  // remains so the underlying logic stays wired.
  void onQuotaModeChange;
  void quotaMode;
  void remainingForcedPacing;
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [resettingDefaults, setResettingDefaults] = useState(false);

  const handleSaveDefaults = async () => {
    if (!onSaveDefaults || savingDefaults) return;
    setSavingDefaults(true);
    try {
      await onSaveDefaults();
    } finally {
      setSavingDefaults(false);
    }
  };

  const handleResetDefaults = async () => {
    if (!onResetDefaults || resettingDefaults || !hasSavedDefaults) return;
    setResettingDefaults(true);
    try {
      await onResetDefaults();
    } finally {
      setResettingDefaults(false);
    }
  };
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) &&
          btnRef.current && !btnRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen(o => !o);
  };

  const mrrModes: MrrMode[] = ["gnrNet", "acqNet"];

  const mrrLabel = mrrMode === "gnrNet" ? "G&R Net" : mrrMode === "acqNet" ? "ACQ MRR" : "Gross";
  const staleLabel = pipelineMode === "allOpen" ? "Stale On" : "Stale Off";
  const modsLabel = subtractMods ? "Mods On" : "Mods Off";
  const prorateLabel = prorateQuota ? "Prorated" : "Full Month";

  return (
    <div className="relative inline-flex items-center gap-2">
      <button
        ref={btnRef}
        onClick={handleToggle}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-all cursor-pointer border ${
          open
            ? "bg-[#006AFF]/10 text-[#006AFF] border-[#006AFF]/30"
            : "bg-white hover:bg-[#f1f5f9] text-[#475569] hover:text-[#1e293b] border-[#e2e8f0]"
        }`}
        title="Settings"
      >
        <Settings2 className="w-3.5 h-3.5" />
        <span>Settings</span>
      </button>
      <div className="flex items-center gap-1">
        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-[#f1f5f9] text-[#475569]">{mrrLabel}</span>
        <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${pipelineMode === "allOpen" ? "bg-blue-50 text-blue-600" : "bg-[#f1f5f9] text-[#475569]"}`}>{staleLabel}</span>
        <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${subtractMods ? "bg-red-50 text-red-700" : "bg-[#f1f5f9] text-[#475569]"}`}>{modsLabel}</span>
        <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${prorateQuota ? "bg-purple-50 text-purple-700" : "bg-[#f1f5f9] text-[#475569]"}`}>{prorateLabel}</span>
      </div>
      {open && createPortal(
        <div ref={ref} className="w-[300px] bg-white border border-border rounded-lg shadow-lg p-3 text-[11px]" style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 9999 }}>
          <div className="font-semibold text-[12px] mb-3 text-[#1e293b]">Settings</div>

          <div className="mb-3">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="text-[10px] font-medium text-[#64748b] uppercase tracking-wider">MRR Mode</div>
              <MrrModeLogicLink />
            </div>
            <div className="flex bg-[#f1f5f9] rounded-md p-0.5">
              {mrrModes.map(mode => (
                <button
                  key={mode}
                  onClick={() => onMrrModeChange(mode)}
                  className={`flex-1 px-1.5 py-1 text-[10px] font-medium rounded transition-all ${
                    mrrMode === mode
                      ? "bg-white text-[#0a1628] shadow-sm"
                      : "text-[#64748b] hover:text-[#1e293b]"
                  }`}
                >
                  {mode === "gnrNet" ? "G&R Net" : "ACQ MRR"}
                </button>
              ))}
            </div>
            <div className="mt-1 text-[10px] text-[#94a3b8]">
              {mrrMode === "gnrNet"
                ? "All Closed Won opps including all churn"
                : "Closed Won opps + matched in month churn only (same rep/account/product/close month)"}
            </div>
          </div>

          <div className="border-t border-border/50 pt-3 mb-3">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="text-[10px] font-medium text-[#64748b] uppercase tracking-wider">Pipeline Logic</div>
              <PipelineLogicLink />
            </div>
            <button
              onClick={() => onPipelineModeChange(pipelineMode === "closeDate" ? "allOpen" : "closeDate")}
              className={`w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-medium rounded-md border transition-all ${
                pipelineMode === "allOpen"
                  ? "bg-[#006AFF]/10 border-[#006AFF]/30 text-[#006AFF]"
                  : "bg-[#f1f5f9] border-transparent text-[#64748b] hover:text-[#1e293b]"
              }`}
            >
              <span>Include Stale Opps</span>
              <div className={`w-7 h-4 rounded-full transition-all relative ${pipelineMode === "allOpen" ? "bg-[#006AFF]" : "bg-[#cbd5e1]"}`}>
                <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all ${pipelineMode === "allOpen" ? "left-3.5" : "left-0.5"}`} />
              </div>
            </button>
            <div className="mt-1 text-[10px] text-[#94a3b8]">
              {pipelineMode === "allOpen"
                ? "Including last month\u2019s open opps with close date \u2264 end of filtered timeframe"
                : "Only opps with close date in selected timeframe"}
            </div>
          </div>

          <div className="border-t border-border/50 pt-3 mt-3">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="text-[10px] font-medium text-[#64748b] uppercase tracking-wider">Scheduled Mods</div>
            </div>
            <button
              onClick={() => onSubtractModsChange(!subtractMods)}
              className={`w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-medium rounded-md border transition-all ${
                subtractMods
                  ? "bg-red-50 border-red-200 text-red-700"
                  : "bg-[#f1f5f9] border-transparent text-[#64748b] hover:text-[#1e293b]"
              }`}
            >
              <span>Subtract Scheduled Mods from Forecast</span>
              <div className={`w-7 h-4 rounded-full transition-all relative ${subtractMods ? "bg-red-500" : "bg-[#cbd5e1]"}`}>
                <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all ${subtractMods ? "left-3.5" : "left-0.5"}`} />
              </div>
            </button>
            <div className="mt-1 text-[10px] text-[#94a3b8]">
              {subtractMods
                ? "Scheduled mods reduce weighted forecast (per-product and total)"
                : "Scheduled mods do not affect the weighted forecast"}
            </div>
          </div>

          <div className="border-t border-border/50 pt-3 mt-3">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="text-[10px] font-medium text-[#64748b] uppercase tracking-wider">Goal Proration</div>
            </div>
            {(() => {
              const prorateDisabled = selectedTimeframe === "custom" || selectedTimeframe === "lastMonth";
              const tip = prorateDisabled
                ? selectedTimeframe === "lastMonth"
                  ? "Proration is unavailable for Last Month — the window is fully in the past"
                  : "Custom date ranges can't be prorated"
                : undefined;
              return (
                <>
                  <button
                    onClick={() => { if (!prorateDisabled) onProrateQuotaChange(!prorateQuota); }}
                    disabled={prorateDisabled}
                    title={tip}
                    className={`w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-medium rounded-md border transition-all ${
                      prorateDisabled
                        ? "bg-gray-50 border-transparent text-[#cbd5e1] cursor-not-allowed"
                        : prorateQuota
                          ? "bg-purple-50 border-purple-200 text-purple-700"
                          : "bg-[#f1f5f9] border-transparent text-[#64748b] hover:text-[#1e293b]"
                    }`}
                  >
                    <span>Prorate Goal to Date Filter</span>
                    <div className={`w-7 h-4 rounded-full transition-all relative ${prorateDisabled ? "bg-[#e2e8f0]" : prorateQuota ? "bg-purple-500" : "bg-[#cbd5e1]"}`}>
                      <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all ${prorateQuota && !prorateDisabled ? "left-3.5" : "left-0.5"}`} />
                    </div>
                  </button>
                  <div className="mt-1 text-[10px] text-[#94a3b8]">
                    {prorateDisabled
                      ? selectedTimeframe === "lastMonth"
                        ? "Proration is unavailable for Last Month — the window is fully in the past"
                        : "Custom date ranges can't be prorated"
                      : prorateQuota
                        ? "Goal = sum of per-business-day targets across the filtered range"
                        : "Goal stays at full monthly target"}
                  </div>
                </>
              );
            })()}
            {prorateQuota && holidayFetchError && (
              <div className="mt-1.5 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                Holidays unavailable — weekends only
              </div>
            )}
            {/* Task #183: Pacing/Remaining segmented toggle removed from UI.
                The underlying quotaMode + remainingForcedPacing logic stays
                wired up via props so it can be re-exposed in the future. */}
          </div>

          {/* Task #254: Revenue Mode — Quota Target (default) vs Sales Target.
              Both modes are compensation-adjusted; each applies the rules tagged
              for it (see the Compensation tab). Open to all authenticated
              users (canUseCompensable is always true). */}
          {canUseCompensable && (
            <div className="border-t border-border/50 pt-3 mt-3">
              <div className="text-[10px] font-medium text-[#64748b] uppercase tracking-wider mb-1.5">Revenue Mode</div>
              <button
                onClick={() => onRevenueModeChange(revenueMode === "sales" ? "quota" : "sales")}
                className={`w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-medium rounded-md border transition-all ${
                  revenueMode === "sales"
                    ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                    : "bg-[#f1f5f9] border-transparent text-[#64748b] hover:text-[#1e293b]"
                }`}
              >
                <span>{revenueMode === "sales" ? "Sales Target Revenue" : "Quota Target Revenue"}</span>
                <div className={`w-7 h-4 rounded-full transition-all relative ${revenueMode === "sales" ? "bg-emerald-500" : "bg-[#cbd5e1]"}`}>
                  <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all ${revenueMode === "sales" ? "left-3.5" : "left-0.5"}`} />
                </div>
              </button>
              <div className="mt-1 text-[10px] text-[#94a3b8]">
                {revenueMode === "sales"
                  ? "Sales target revenue. MRR shown with Sales Target rules applied across funnel, quota, forecast & contests"
                  : "Compensable revenue. MRR shown as compensation-adjusted amounts across funnel, quota, forecast & contests"}
              </div>
            </div>
          )}

          {/* Task #484: eReps Override — when on, every rep's eRep multiplier is
              treated as 1x in the displayed pipeline/quota/forecast goals.
              Visible to all Pipeline viewers (NOT gated by canUseCompensable)
              and always starts off on each load (not persisted). */}
          <div className="border-t border-border/50 pt-3 mt-3">
            <div className="text-[10px] font-medium text-[#64748b] uppercase tracking-wider mb-1.5">eReps Override</div>
            <button
              onClick={() => onERepOverrideChange(!eRepOverride)}
              className={`w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-medium rounded-md border transition-all ${
                eRepOverride
                  ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                  : "bg-[#f1f5f9] border-transparent text-[#64748b] hover:text-[#1e293b]"
              }`}
            >
              <span>{eRepOverride ? "Override eReps" : "Apply eReps"}</span>
              <div className={`w-7 h-4 rounded-full transition-all relative ${eRepOverride ? "bg-emerald-500" : "bg-[#cbd5e1]"}`}>
                <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all ${eRepOverride ? "left-3.5" : "left-0.5"}`} />
              </div>
            </button>
            <div className="mt-1 text-[10px] text-[#94a3b8]">
              {eRepOverride
                ? "Override eRep multiplier to 1x."
                : "Apply eRep multiplier to rep monthly goal."}
            </div>
          </div>

          {onSaveDefaults && (
            <div className="border-t border-border/50 pt-3 mt-3">
              <div className="text-[10px] font-medium text-[#64748b] uppercase tracking-wider mb-1.5">My Defaults</div>
              <div className="flex items-stretch gap-2">
                <button
                  onClick={handleSaveDefaults}
                  disabled={savingDefaults}
                  className="flex-1 px-2 py-1.5 text-[10px] font-medium rounded-md border bg-[#006AFF]/10 border-[#006AFF]/30 text-[#006AFF] hover:bg-[#006AFF]/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savingDefaults ? "Saving…" : "Save current filters as default"}
                </button>
                <button
                  onClick={handleResetDefaults}
                  disabled={!hasSavedDefaults || resettingDefaults}
                  className="px-2 py-1.5 text-[10px] font-medium rounded-md border bg-[#f1f5f9] border-transparent text-[#64748b] hover:text-[#1e293b] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {resettingDefaults ? "Resetting…" : "Reset defaults"}
                </button>
              </div>
              <div className="mt-1 text-[10px] text-[#94a3b8]">
                {hasSavedDefaults
                  ? "Your filters and toggles will load by default on every visit."
                  : "Save your current filters and toggles so the dashboard re-opens with this exact view."}
              </div>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

export default function PipelineView({ loading, data, filters, pipelineMode, onPipelineModeChange, mrrMode, onMrrModeChange, revenueMode, subtractMods, groupPreset, modsStart, onModsStartChange, modsExtend, onModsExtendChange, modsDateRange, onProductsChange, onSetSlmFilter, onSetMultiFilter, uiSlmFilter, authUser, prorateQuota, quotaMode, holidaySet, holidayNameMap, holidayFetchError, selectedTimeframe, availableProducts }: PipelineViewProps) {
  const canEditStageDefault = !authUser?.viewOnly && (authUser?.role === "admin" || authUser?.role === "slm" || authUser?.role === "exec" || authUser?.role === "flm");
  const queryClient = useQueryClient();
  const updateStageDefault = useCallback(async (stage: string, value: number) => {
    try {
      const res = await fetch(`/api/sales/stage-default-probabilities/${encodeURIComponent(stage)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ probability: value }),
      });
      if (!res.ok) {
        console.warn("Failed to save stage default", await res.text());
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["/api/sales/pipeline"] });
    } catch (e) {
      console.error("Error saving stage default", e);
    }
  }, [queryClient]);
  const [drilldown, setDrilldown] = useState<{ stage: string; mode: DrilldownMode; nameFilter?: string; nameFilterDimension?: AggregateBy; productFilter?: string[]; churnTypeFilter?: string } | null>(null);
  // Per-rep coverage targets (multiple e.g. 3.5x). Map keyed by hierarchy
  // name. SLM/admin can edit from the per-product Forecast drilldown header.
  const DEFAULT_COVERAGE_TARGET = 3.5;
  const [coverageTargets, setCoverageTargets] = useState<Record<string, number>>({});
  const fetchCoverageTargets = useCallback(() => {
    fetch("/api/sales/coverage-targets", { credentials: "include" })
      .then(r => r.json())
      .then(d => { if (d?.targets) setCoverageTargets(d.targets); })
      .catch(() => {/* ignore */});
  }, []);
  useEffect(() => { fetchCoverageTargets(); }, [fetchCoverageTargets]);
  // Drilldown popup state for unreviewed opps. The product context comes
  // from the active per-product Forecast drilldown popup.
  const [unreviewedDrilldown, setUnreviewedDrilldown] = useState<{ product: string | null; label?: string } | null>(null);
  const [unreviewedModsDrilldown, setUnreviewedModsDrilldown] = useState<{ product: string | null; label?: string; rep?: string } | null>(null);
  // In-scope count of unreviewed mods, shown as a badge on the "Review
  // Unreviewed Mods" button in the GNR Churn Forecast popup. Refetched
  // whenever the popup opens, the date window changes, or the user edits
  // a mod's probability (which decrements the count).
  const [unreviewedModsCount, setUnreviewedModsCount] = useState<number | null>(null);
  const [unreviewedModsRefetchTick, setUnreviewedModsRefetchTick] = useState(0);
  // Task #187: in-scope count of unreviewed opps (sum across all in-scope
  // products) for the aggregate MRR Forecast popup button badge.
  const [unreviewedOppsCount, setUnreviewedOppsCount] = useState<number | null>(null);
  const [unreviewedOppsRefetchTick, setUnreviewedOppsRefetchTick] = useState(0);
  // Task #187: aggregate GNR Churn Forecast popup (all in-scope products
  // stacked together). Opened from the BAN strip click when the active
  // forecast metric is "churn".
  const [forecastChurnAggregatePopupOpen, setForecastChurnAggregatePopupOpen] = useState(false);
  // Save handler for coverage target edits — cascades to the supplied rep
  // names server-side. Optimistically updates local state so the bars
  // refresh immediately.
  const updateCoverageTargets = useCallback(async (value: number, repNames: string[]) => {
    if (!Number.isFinite(value) || value <= 0 || repNames.length === 0) return;
    const rounded = Math.round(value * 100) / 100;
    setCoverageTargets(prev => {
      const next = { ...prev };
      for (const n of repNames) next[n] = rounded;
      return next;
    });
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (import.meta.env.DEV) {
        try {
          const raw = localStorage.getItem("impersonate_user");
          const imp = raw ? JSON.parse(raw) : null;
          if (imp?.id) headers["x-impersonate-user-id"] = String(imp.id);
        } catch {/* ignore */}
      }
      const res = await fetch("/api/sales/coverage-targets", {
        method: "PUT",
        headers,
        credentials: "include",
        body: JSON.stringify({ value: rounded, repNames }),
      });
      if (!res.ok) {
        console.warn("Failed to update coverage targets", await res.text());
      } else {
        // Re-sync from server so we reflect the actual scope the server
        // applied (an SLM may have requested a wider set than allowed).
        fetchCoverageTargets();
      }
    } catch (e) {
      console.error("Error updating coverage targets", e);
    }
  }, [fetchCoverageTargets]);
  // Aggregate Forecast Assumptions popup — only used by the GNR Net / Gross MRR
  // forecast cards. The ASM Forecast card opens a per-product drilldown instead
  // (driven by `forecastPopupProduct` below).
  const [forecastPopupOpen, setForecastPopupOpen] = useState(false);
  const [forecastPopupProduct, setForecastPopupProduct] = useState<string | null>(null);
  // Task #193 / #200: per-section expand state for the aggregate forecast
  // drilldown's per-product sub-rows. Keys: "mrr:<stage>",
  // "churn:<type>", "me". Default-collapsed (empty set); entries are
  // added when the user clicks a caret to expand a section.
  const [aggregateExpandedSections, setAggregateExpandedSections] = useState<Set<string>>(() => new Set());
  // Task #200: reset to fully-collapsed whenever the popup opens or closes
  // so reopening the drilldown always starts compact.
  useEffect(() => {
    setAggregateExpandedSections(new Set());
  }, [forecastPopupOpen]);
  const toggleAggregateSection = (key: string) => {
    setAggregateExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  // Shared GNR metric toggle for both the Quota card and the Forecast card:
  // "both" = tornado / stacked dual-bar view (MRR + Churn together), "mrr" or
  // "churn" = single-metric view formatted like the Acquisitions cards. The
  // Quota and Forecast Both/MRR/Churn toggles are slaved to this single piece
  // of state so flipping one always updates the other. Declared here (above the
  // churn-badge effect) so that effect can suppress churn fetches in the "net"
  // sub-view without a use-before-declaration TDZ error.
  const [quotaGrossMetric, setQuotaGrossMetric] = useState<"both" | "mrr" | "churn" | "net">("both");
  const forecastMetric = quotaGrossMetric;
  const setForecastMetric = setQuotaGrossMetric;
  // Task #448: the Goal/Forecast gross-vs-net sub-view toggle only applies in
  // G&R Net mode. Default it to Both whenever G&R Net becomes active.
  useEffect(() => {
    if (mrrMode === "gnrNet") setQuotaGrossMetric("both");
  }, [mrrMode]);
  // Task #116: per-product Churn Forecast popup. Mirrors the MRR popup but
  // shows a single "Scheduled Mods" row with inverted color scheme. `rep`
  // is set when opened from the by-rep view so the funnel drilldown can
  // scope to the selected rep (passed as nameFilter + nameFilterDimension
  // = "Rep") for parity with MRR rep-snapshot behavior.
  const [forecastChurnPopup, setForecastChurnPopup] = useState<{ product: string; rep?: string } | null>(null);
  // Refetch the unreviewed-mods count whenever the GNR Churn Forecast
  // popup is open or its date window changes. The modal's
  // onProbabilityChanged callback bumps `unreviewedModsRefetchTick` so
  // the badge stays in sync with optimistic edits inside the modal.
  useEffect(() => {
    // Task #187/#190: also fire when the combined G&R aggregate Forecast
    // popup is open and its churn section is visible (see churnSectionVisible
    // below). No per-product/rep scope — defers to dashboard filters only.
    // Task #448: the aggregate Forecast popup only renders the churn section
    // when the gross G&R dual block is shown — i.e. G&R Net mode, NOT the "net"
    // sub-view, AND an aggregate preset (G&R / My Team / Me) where the gross
    // per-product split exists. This mirrors `!forecastShowNet` so the churn
    // badge is never pre-fetched when its UI is hidden (Net sub-view, ACQ MRR,
    // or non-aggregate fallback).
    const churnSectionVisible =
      mrrMode === "gnrNet" &&
      quotaGrossMetric !== "net" &&
      (groupPreset === "G&R" || groupPreset === "My Team" || groupPreset === "Me");
    const aggregateOpen = forecastChurnAggregatePopupOpen || (forecastPopupOpen && churnSectionVisible);
    if (!forecastChurnPopup && !aggregateOpen) { setUnreviewedModsCount(null); return; }
    let cancelled = false;
    const qs = new URLSearchParams();
    if (modsDateRange.from) qs.set("from", modsDateRange.from);
    if (modsDateRange.to) qs.set("to", modsDateRange.to);
    // Task #361: admin-only raw Conditions so the badge count matches the
    // conditioned aggregates. Server ignores it for non-admins.
    if (authUser?.role === "admin") {
      const valid = (filters.rawConditions ?? []).filter((c) => c.field && c.value.trim() !== "");
      if (valid.length > 0) qs.set("rawConditions", JSON.stringify(valid));
    }
    // The badge must match the rows the modal will render, so apply the
    // same scope predicate the modal uses: dashboard filters
    // (SLM/FLM/rep/region/segment/group + product set), the popup's
    // product context (with Showcase expanding to Showcase + Showcase
    // Incremental), and the optional rep popup scope.
    const SHOWCASE_PARTS = new Set(["Showcase", "Showcase Incremental", "Showcase Incremental - Re/Max", "Overage"]);
    const scopeProduct = forecastChurnPopup?.product || null;
    const scopeRep = forecastChurnPopup?.rep || null;
    const fromFilters = (filters.products && filters.products.length > 0)
      ? new Set(filters.products)
      : null;
    const fromProp = scopeProduct
      ? (scopeProduct === "Showcase" ? new Set(SHOWCASE_PARTS) : new Set([scopeProduct]))
      : null;
    let activeProductSet: Set<string> | null = null;
    if (fromFilters && fromProp) {
      activeProductSet = new Set(Array.from(fromProp).filter(p => fromFilters.has(p)));
    } else {
      activeProductSet = fromProp ?? fromFilters;
    }
    fetch(`/api/sales/unreviewed-mods?${qs.toString()}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : { mods: [] })
      .then(d => {
        if (cancelled) return;
        const rows: Array<any> = Array.isArray(d?.mods)
          ? d.mods
          : Array.isArray(d?.opportunities) ? d.opportunities : [];
        const filtered = rows.filter(o => {
          if (filters.slm.length > 0 && !filters.slm.includes(o.slm || "")) return false;
          if (filters.flm.length > 0 && !filters.flm.includes(o.flm || "")) return false;
          if (filters.rep.length > 0 && !filters.rep.includes(o.rep || "")) return false;
          if (filters.region.length > 0 && !filters.region.includes(o.region || "")) return false;
          if (filters.segment.length > 0 && !filters.segment.includes(o.segment || "")) return false;
          if (!passesChannelFilter(o.group, filters.group)) return false;
          if (activeProductSet && !activeProductSet.has(o.product)) return false;
          if (scopeRep && o.rep !== scopeRep) return false;
          return true;
        });
        setUnreviewedModsCount(filtered.length);
      })
      .catch(() => { if (!cancelled) setUnreviewedModsCount(null); });
    return () => { cancelled = true; };
  }, [
    forecastChurnPopup,
    forecastChurnAggregatePopupOpen,
    forecastPopupOpen,
    mrrMode,
    quotaGrossMetric,
    groupPreset,
    modsDateRange.from,
    modsDateRange.to,
    unreviewedModsRefetchTick,
    filters.products,
    filters.slm,
    filters.flm,
    filters.rep,
    filters.region,
    filters.segment,
    filters.group,
    filters.rawConditions,
    authUser?.role,
  ]);
  const forecastChurnPopupProduct = forecastChurnPopup?.product ?? null;
  const setForecastChurnPopupProduct = useCallback((p: string | null) => {
    setForecastChurnPopup(p ? { product: p } : null);
  }, []);
  // Task #187: in-scope unreviewed-opps count for the aggregate MRR
  // Forecast popup badge. Mirrors unreviewed-mods effect: dashboard
  // filters narrow the rows, and `filters.products` (if any) constrains
  // by line-item product. Refetches when popup opens or a probability
  // edit fires onProbabilityChanged.
  useEffect(() => {
    if (!forecastPopupOpen) { setUnreviewedOppsCount(null); return; }
    let cancelled = false;
    const dr = getDateRange(filters.timeframe, filters.customRange);
    const qs = new URLSearchParams();
    qs.set("timeframe", filters.timeframe);
    if (dr.from) qs.set("from", dr.from);
    if (dr.to) qs.set("to", dr.to);
    if (pipelineMode === "allOpen") qs.set("pipelineMode", "allOpen");
    // Task #361: admin-only raw Conditions so the badge count matches the
    // conditioned aggregates. Server ignores it for non-admins.
    if (authUser?.role === "admin") {
      const valid = (filters.rawConditions ?? []).filter((c) => c.field && c.value.trim() !== "");
      if (valid.length > 0) qs.set("rawConditions", JSON.stringify(valid));
    }
    const activeProductSet: Set<string> | null = (filters.products && filters.products.length > 0)
      ? new Set(filters.products)
      : null;
    type OppCountRow = {
      slm?: string; flm?: string; rep?: string; region?: string;
      segment?: string; group?: string; product?: string;
      lineItems?: Array<{ product: string }>;
    };
    fetch(`/api/sales/unreviewed-opps?${qs.toString()}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : { opportunities: [] })
      .then((d: { opportunities?: OppCountRow[] }) => {
        if (cancelled) return;
        const rows: OppCountRow[] = Array.isArray(d?.opportunities) ? d.opportunities : [];
        const filtered = rows.filter(o => {
          if (filters.slm.length > 0 && !filters.slm.includes(o.slm || "")) return false;
          if (filters.flm.length > 0 && !filters.flm.includes(o.flm || "")) return false;
          if (filters.rep.length > 0 && !filters.rep.includes(o.rep || "")) return false;
          if (filters.region.length > 0 && !filters.region.includes(o.region || "")) return false;
          if (filters.segment.length > 0 && !filters.segment.includes(o.segment || "")) return false;
          if (!passesChannelFilter(o.group, filters.group)) return false;
          if (activeProductSet) {
            const lis: Array<{ product: string }> = Array.isArray(o.lineItems) && o.lineItems.length > 0
              ? o.lineItems
              : [{ product: o.product || "" }];
            if (!lis.some(li => activeProductSet.has(li.product))) return false;
          }
          return true;
        });
        setUnreviewedOppsCount(filtered.length);
      })
      .catch(() => { if (!cancelled) setUnreviewedOppsCount(null); });
    return () => { cancelled = true; };
  }, [
    forecastPopupOpen,
    filters.timeframe,
    filters.customRange,
    pipelineMode,
    unreviewedOppsRefetchTick,
    filters.products,
    filters.slm,
    filters.flm,
    filters.rep,
    filters.region,
    filters.segment,
    filters.group,
    filters.rawConditions,
    authUser?.role,
  ]);
  const [quotaDrilldownScope, setQuotaDrilldownScope] = useState<{ kind: "total" | "product"; product?: string } | null>(null);
  const [quotaDrilldownGrossSort, setQuotaDrilldownGrossSort] = useState<"added" | "churn">("added");
  const [quotaDrilldownGrossDisplay, setQuotaDrilldownGrossDisplay] = useState<"pct" | "dollar">("pct");
  const [quotaDrilldownNetSort, setQuotaDrilldownNetSort] = useState<"mrr" | "pct">("mrr");
  // Set of rep names currently expanded in the by-rep view. A Set lets the
  // user expand multiple reps simultaneously (and toggle them independently),
  // and the header "Expand All / Hide All" button just swaps it for the full
  // rep-name set or an empty one.
  const [expandedReps, setExpandedReps] = useState<Set<string>>(new Set());
  const toggleExpandedRep = useCallback((name: string) => {
    setExpandedReps(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);
  // Reset expanded reps when drilldown scope changes or closes.
  useEffect(() => { setExpandedReps(new Set()); }, [quotaDrilldownScope]);
  // Per-card "expand height" toggle for the by-Rep drilldown views. When on,
  // the card's max height grows by ~33% so more reps fit without scrolling.
  // Each card has its own independent state and resets to false whenever its
  // drilldown closes (mirroring the existing sort/expand resets).
  const [quotaCardExpanded, setQuotaCardExpanded] = useState(false);
  const [forecastCardExpanded, setForecastCardExpanded] = useState(false);
  useEffect(() => { if (!quotaDrilldownScope) setQuotaCardExpanded(false); }, [quotaDrilldownScope]);
  // Per-rep Forecast drilldown (AcqNet view). Holds the product name whose
  // per-rep forecast bar list is being shown; null = normal per-product view.
  const [forecastRepDrilldownProduct, setForecastRepDrilldownProduct] = useState<string | null>(null);
  // Sort state for the by-rep Forecast view. Each metric has its own default
  // direction (Coverage/Weighted/WRtoHit desc; Gap asc) — clicking the same
  // metric toggles direction. Reset whenever the drilldown closes or the
  // aggregateBy/mrrMode/active products change.
  type RepSortMetric = "coverage" | "weighted" | "winRateToHit" | "gap";
  const REP_SORT_DEFAULT_DIR: Record<RepSortMetric, "asc" | "desc"> = {
    coverage: "desc",
    weighted: "desc",
    winRateToHit: "desc",
    gap: "asc",
  };
  const [repForecastSortMetric, setRepForecastSortMetric] = useState<RepSortMetric>("coverage");
  const [repForecastSortDir, setRepForecastSortDir] = useState<"asc" | "desc">("desc");
  // Pipeline Funnel rightmost-column display mode: "opps" shows opportunity
  // count; "pctMrr" shows each stage's share of total active pipeline MRR.
  const [funnelRightColMode, setFunnelRightColMode] = useState<"opps" | "pctMrr">("opps");
  const [funnelBreakdownOpen, setFunnelBreakdownOpen] = useState(false);
  // Rep name displayed in the per-product Forecast popup title when the popup
  // was opened from the by-rep view. Null = popup opened from per-product view.
  const [forecastPopupRep, setForecastPopupRep] = useState<string | null>(null);
  // Snapshot of the dim filter at the moment the popup was opened from a rep
  // bar; restored on close so the by-rep view returns to its prior state
  // (with sort intact). Null when popup was not opened from rep view.
  const popupRepFilterSnapshotRef = useRef<{ kind: AggDim["kind"]; value: string[] } | null>(null);
  // Aggregate-unit click handling for the by-rep Forecast drilldown. When
  // aggregateBy is "Rep" the unit is a rep and we toggle filters.rep; for
  // FLM/SLM/Region/Segment we toggle membership in the corresponding
  // hierarchy filter so a click on (e.g.) an FLM bar adds/removes that FLM
  // from the active multi-select. Empty array == "All …".
  type AggDim = { kind: "rep" | "flm" | "slm" | "region" | "segment" };
  const aggDim = useCallback((agg: AggregateBy): AggDim => {
    switch (agg) {
      case "FLM": return { kind: "flm" };
      case "SLM": return { kind: "slm" };
      case "Region": return { kind: "region" };
      case "Segment": return { kind: "segment" };
      case "Rep":
      default: return { kind: "rep" };
    }
  }, []);
  // Task #560: for the SLM dim, toggle/highlight/snapshot semantics operate on
  // the raw UI selection ([] == "All SLMs") rather than the channel-resolved
  // effective list in `filters.slm`.
  const isUnitActive = useCallback((dim: AggDim, name: string): boolean => {
    const arr = dim.kind === "slm" && uiSlmFilter ? uiSlmFilter : filters[dim.kind];
    return arr.includes(name);
  }, [filters, uiSlmFilter]);
  const currentDimValue = useCallback((dim: AggDim): string[] => {
    if (dim.kind === "slm" && uiSlmFilter) return uiSlmFilter;
    return filters[dim.kind];
  }, [filters, uiSlmFilter]);
  const applyDimFilter = useCallback((dim: AggDim, value: string[]) => {
    if (dim.kind === "slm") {
      onSetSlmFilter?.(value);
    } else {
      onSetMultiFilter?.(dim.kind, value);
    }
  }, [onSetSlmFilter, onSetMultiFilter]);
  const handleAggUnitClick = useCallback((name: string) => {
    const dim = aggDim(filters.aggregateBy);
    if (dim.kind === "slm" ? !onSetSlmFilter : !onSetMultiFilter) return;
    const current = currentDimValue(dim);
    const next = current.includes(name)
      ? current.filter(v => v !== name)
      : [...current, name];
    applyDimFilter(dim, next);
  }, [aggDim, applyDimFilter, currentDimValue, onSetSlmFilter, onSetMultiFilter, filters.aggregateBy]);
  // Task #116 follow-up: when opening the Churn popup from a by-rep
  // row, also narrow the active dim filter to that rep (snapshotted on
  // the shared popupRepFilterSnapshotRef) so processedData — and thus
  // churnDrilldownData totals — reflect just that rep. This matches
  // the MRR popup's openForecastPopupForRep rep-snapshot pattern. The
  // snapshot is restored on close via closeForecastChurnPopup.
  const openForecastChurnPopupForRep = useCallback((repName: string, product: string) => {
    const dim = aggDim(filters.aggregateBy);
    if (dim.kind === "slm" ? !onSetSlmFilter : !onSetMultiFilter) {
      // Can't narrow — fall back to aggregate popup.
      setForecastChurnPopup({ product });
      return;
    }
    const current = currentDimValue(dim);
    const isExactlyThisRep = current.length === 1 && current[0] === repName;
    if (!isExactlyThisRep) {
      popupRepFilterSnapshotRef.current = { kind: dim.kind, value: current };
      applyDimFilter(dim, [repName]);
    } else {
      popupRepFilterSnapshotRef.current = null;
    }
    setForecastChurnPopup({ product, rep: repName });
  }, [aggDim, filters.aggregateBy, onSetSlmFilter, onSetMultiFilter, currentDimValue, applyDimFilter]);
  const closeForecastChurnPopup = useCallback(() => {
    const snap = popupRepFilterSnapshotRef.current;
    if (snap) {
      applyDimFilter({ kind: snap.kind }, snap.value);
      popupRepFilterSnapshotRef.current = null;
    }
    setForecastChurnPopup(null);
  }, [applyDimFilter]);
  // Clear the per-rep Forecast drilldown when the user changes MRR mode (AcqNet
  // is the only mode that surfaces this drilldown today; switching out of it
  // would otherwise leave a stale drilldown ready to reappear later) or when
  // the active product filter changes (mirrors the spec for the Quota by-rep
  // drilldown — a top-level filter change exits the drilldown).
  useEffect(() => { setForecastRepDrilldownProduct(null); }, [mrrMode]);
  // Close the by-rep drilldown only when the active products filter changes
  // such that the drilldown product is no longer included. Opening the
  // drilldown itself sets the filter to that product (and pulls SCi along
  // for Showcase), so this guard keeps the drilldown open in that case.
  // An empty filter ([] = "All") is also treated as inclusive.
  useEffect(() => {
    if (!forecastRepDrilldownProduct) return;
    if (filters.products.length === 0) return;
    if (!filters.products.includes(forecastRepDrilldownProduct)) {
      setForecastRepDrilldownProduct(null);
    }
  }, [filters.products, forecastRepDrilldownProduct]);
  // Reset by-rep Forecast sort whenever the drilldown closes (so re-entering
  // always starts at the default Coverage-desc). Sort persists across an
  // aggregateBy change while the drilldown stays open — the chosen metric
  // applies cleanly to whatever units (Rep/FLM/SLM/etc.) are shown.
  useEffect(() => {
    if (!forecastRepDrilldownProduct) {
      setRepForecastSortMetric("coverage");
      setRepForecastSortDir("desc");
      setForecastCardExpanded(false);
    }
  }, [forecastRepDrilldownProduct]);
  // Task #116: GNR Churn now supports by-rep view (per-rep weighted mods are
  // wired). The previous auto-clear effect was removed; flipping between MRR/
  // Both/Churn modes preserves the active drilldown product. mrrMode changes
  // (AcqNet ↔ GNR) are still handled by a separate effect.
  // Click handler for the 4 aggregate metric tiles when the by-rep view is
  // open: clicking the active metric toggles direction; clicking a different
  // metric switches to that metric with its default direction.
  const handleRepSortTileClick = useCallback((metric: RepSortMetric) => {
    if (repForecastSortMetric === metric) {
      setRepForecastSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setRepForecastSortMetric(metric);
      setRepForecastSortDir(REP_SORT_DEFAULT_DIR[metric]);
    }
  }, [repForecastSortMetric]);
  // If the user switches MRR mode while the per-product Forecast popup is
  // open (or while a rep-snapshot is pending restore), close the popup and
  // restore any snapshotted dim filter so we don't leave orphan state behind
  // when the AcqNet card unmounts. Same trigger as the drilldown clear above.
  useEffect(() => {
    const snap = popupRepFilterSnapshotRef.current;
    if (snap) {
      if (snap.kind === "slm") {
        onSetSlmFilter?.(snap.value);
      } else {
        onSetMultiFilter?.(snap.kind, snap.value);
      }
      popupRepFilterSnapshotRef.current = null;
    }
    setForecastPopupRep(null);
    setForecastPopupProduct(null);
    // intentionally only re-run on mrrMode change — the close-on-mode-switch
    // is the whole point of this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mrrMode]);
  // Centralized close for the per-product Forecast popup. If the popup was
  // opened from a rep bar, restore the dim filter we snapshotted on open so
  // the by-rep view returns to its prior shape (sort state is preserved as
  // separate React state).
  const closeForecastPopup = useCallback(() => {
    const snap = popupRepFilterSnapshotRef.current;
    if (snap) {
      applyDimFilter({ kind: snap.kind }, snap.value);
      popupRepFilterSnapshotRef.current = null;
    }
    setForecastPopupRep(null);
    setForecastPopupProduct(null);
  }, [applyDimFilter]);
  // Open the per-product Forecast popup scoped to a single rep (called from
  // the by-rep Forecast view). Snapshots the current dim filter and narrows
  // it to just `[repName]` so the popup's totals reflect that single rep.
  // Restored on close. If the active filter is already exactly [repName] we
  // skip the snapshot (nothing to restore).
  const openForecastPopupForRep = useCallback((repName: string, product: string) => {
    const dim = aggDim(filters.aggregateBy);
    if (dim.kind === "slm" ? !onSetSlmFilter : !onSetMultiFilter) return;
    const current = currentDimValue(dim);
    const isExactlyThisRep = current.length === 1 && current[0] === repName;
    if (!isExactlyThisRep) {
      popupRepFilterSnapshotRef.current = { kind: dim.kind, value: current };
      applyDimFilter(dim, [repName]);
    } else {
      popupRepFilterSnapshotRef.current = null;
    }
    setForecastPopupRep(repName);
    setForecastPopupProduct(product);
  }, [aggDim, filters.aggregateBy, onSetSlmFilter, onSetMultiFilter, currentDimValue, applyDimFilter]);

  const toggleProductFilter = (product: string) => {
    const current = filters.products;
    const targets = product === "Showcase" ? ["Showcase", "Showcase Incremental", "Showcase Incremental - Re/Max", "Overage"] : [product];
    const allSelected = targets.every(t => current.includes(t));
    if (allSelected) {
      onProductsChange(current.filter(p => !targets.includes(p)));
    } else {
      const next = [...current];
      for (const t of targets) if (!next.includes(t)) next.push(t);
      onProductsChange(next);
    }
  };

  const processedData = useMemo(() => {
    if (!data?.reps) return null;

    const aggBy = filters.aggregateBy;

    // `repsAll` applies every filter EXCEPT the one matching the current
    // aggregateBy dimension. The Forecast by-Rep drilldown uses this so its
    // row list keeps showing every eligible row when a Rep / FLM / SLM /
    // Region / Segment filter is active (with the selected row highlighted
    // and others greyed out). Every other downstream calculation uses the
    // narrower `reps` (full filter set) below so totals and other charts
    // continue to respond to the active filter.
    let repsAll = data.reps;
    if (filters.slm.length > 0 && aggBy !== "SLM") repsAll = repsAll.filter(r => filters.slm.includes(r.slm));
    if (filters.flm.length > 0 && aggBy !== "FLM") repsAll = repsAll.filter(r => filters.flm.includes(r.flm));
    if (filters.rep.length > 0 && aggBy !== "Rep") repsAll = repsAll.filter(r => filters.rep.includes(r.name));
    if (filters.region.length > 0 && aggBy !== "Region") repsAll = repsAll.filter(r => filters.region.includes(r.region));
    if (filters.segment.length > 0 && aggBy !== "Segment") repsAll = repsAll.filter(r => filters.segment.includes((r as any).segment));
    repsAll = repsAll.filter(r => passesChannelFilter(r.group, filters.group));

    let reps = repsAll;
    if (aggBy === "SLM" && filters.slm.length > 0) reps = reps.filter(r => filters.slm.includes(r.slm));
    if (aggBy === "FLM" && filters.flm.length > 0) reps = reps.filter(r => filters.flm.includes(r.flm));
    if (aggBy === "Rep" && filters.rep.length > 0) reps = reps.filter(r => filters.rep.includes(r.name));
    if (aggBy === "Region" && filters.region.length > 0) reps = reps.filter(r => filters.region.includes(r.region));
    if (aggBy === "Segment" && filters.segment.length > 0) reps = reps.filter(r => filters.segment.includes((r as any).segment));

    const isAdded = mrrMode === "added";
    const isAcqNet = mrrMode === "acqNet";
    // Task #448: in G&R Net mode with an aggregate preset, the Goal/Forecast
    // gross sub-views (Both/MRR/Churn) drive the FORECAST weighted Closed Won to
    // the gross (Added) flavor; the "Net" sub-view keeps the net G&R weighted CW.
    // Only the forecast (allProductQuotas.weighted / weightedData) consumes this
    // — the Pipeline Funnel card and MRR/Churn cards are unaffected.
    const weightedCwGross =
      mrrMode === "gnrNet" &&
      (groupPreset === "G&R" || groupPreset === "My Team" || groupPreset === "Me") &&
      quotaGrossMetric !== "net";

    // Quota proration: convert each rep's monthly goal to a per-business-day
    // rate (Mon-Fri minus US holidays) and sum across the filtered range.
    // Because every month in scope shares the same monthly goal, we can
    // collapse this into a single multiplier `quotaProrationFactor` applied
    // uniformly to every rep's goal value:
    //   factor = sum_over_months(filterBusinessDaysInMonth / monthBusinessDaysInMonth)
    // Quota proration (Task #159): For each calendar month overlapping the
    // selected range we compute a business-day factor anchored on today for
    // the current month, then per-rep we subtract already-booked closed-won
    // from the monthly goal BEFORE applying the factor (floored at 0). For
    // multi-month custom ranges the per-month contributions are summed.
    //
    //   contribution(month) = max(0, monthly_goal − closed_in_month) × factor
    //   factor(current month) = bizDays(seg ∩ month) / bizDaysFromTodayToEoM
    //   factor(other month)   = bizDays(seg ∩ month) / bizDaysInMonth
    //
    // The legacy `prorate(g)` (single multiplier × monthly goal) is kept for
    // gross MRR-Added / Churn goals — those are out of scope for the Net
    // proration change but still need consistent multi-month scaling.
    // Task #182: the `churn` per-day series on each CW bucket powers the GnR
    // Goal-card pacing calendar's Churn side. It is sign-preserving (negative
    // numbers) — calendar already paints negative amounts red via its existing
    // branch (Task #178).
    type CwBucket = { added: number; acqNet: number; std: number; churn: number };
    const selectCwForMode = (b: CwBucket | undefined): number => {
      if (!b) return 0;
      if (isAdded) return b.added;
      if (isAcqNet) return b.acqNet;
      return b.std;
    };
    type MonthSlot = {
      ymKey: string;
      y: number; m: number;
      factor: number;
      isCurrentMonth: boolean;
      isPastMonth: boolean;
      // Inclusive day-of-month bounds of the segment of this month that
      // overlaps the active range. Used to sum sparse cwDaysByMonth entries
      // for partial-coverage past months at range boundaries.
      segStartDay: number;
      segEndDay: number;
      // True when the segment covers the full calendar month — lets us short-
      // circuit per-day summation and use the precomputed cwByMonth bucket.
      fullCoverage: boolean;
      // Task #162: explicit business-day counts for audit-grade tooltip and
      // pacing-mode math (factor = bizdaysInWindow / bizdaysInMonth in
      // pacing mode; in remaining mode for the current month the factor
      // denominator is bizdays-from-today-to-EoM, not bizdaysInMonth).
      bizdaysInMonth: number;
      bizdaysInWindow: number;
      // Pacing-mode factor: always inRange / monthBusinessDays regardless
      // of whether this is the current month. Distinct from `factor` which
      // reflects the existing remaining-mode semantics.
      pacingFactor: number;
    };
    let windowedEligibility: WindowedRemainingEligibility | null = null;
    const monthSlots: MonthSlot[] = [];
    let quotaProrationFactor = 1;
    if (prorateQuota) {
      const range = getDateRange(filters.timeframe, filters.customRange);
      if (range.from && range.to) {
        const fromD = new Date(range.from + "T00:00:00");
        const toD = new Date(range.to + "T00:00:00");
        if (toD >= fromD) {
          const today = getTodayPST();
          const today0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
          if (quotaMode === 'remaining') {
            if (filters.timeframe === 'lastMonth') {
              windowedEligibility = { mode: 'fallback-to-pacing' };
            } else {
              windowedEligibility = computeWindowedRemainingEligibility(fromD, toD, today0, holidaySet);
            }
          }
          let factorSum = 0;
          const cur = new Date(fromD.getFullYear(), fromD.getMonth(), 1);
          const monthEndCutoff = new Date(toD.getFullYear(), toD.getMonth(), 1);
          while (cur <= monthEndCutoff) {
            const y = cur.getFullYear();
            const m = cur.getMonth();
            const monthBusinessDays = countBusinessDaysInMonth(y, m, holidaySet);
            const monthStart = new Date(y, m, 1);
            const monthEnd = new Date(y, m + 1, 0);
            const segStart = monthStart < fromD ? fromD : monthStart;
            const segEnd = monthEnd > toD ? toD : monthEnd;
            const isCurrent = y === today0.getFullYear() && m === today0.getMonth();
            const isPast = monthEnd < today0;
            let inRange = 0;
            {
              const d = new Date(segStart);
              while (d <= segEnd) {
                if (isBusinessDay(d, holidaySet)) inRange++;
                d.setDate(d.getDate() + 1);
              }
            }
            let denom = monthBusinessDays;
            if (isCurrent) {
              // Biz days remaining in current month from today (inclusive of today).
              let rem = 0;
              const d = new Date(today0);
              while (d <= monthEnd) {
                if (isBusinessDay(d, holidaySet)) rem++;
                d.setDate(d.getDate() + 1);
              }
              denom = rem;
            }
            const factor = denom > 0 ? inRange / denom : 0;
            const pacingFactor = monthBusinessDays > 0 ? inRange / monthBusinessDays : 0;
            monthSlots.push({
              ymKey: `${y}-${String(m + 1).padStart(2, "0")}`,
              y, m, factor,
              isCurrentMonth: isCurrent,
              isPastMonth: isPast,
              segStartDay: segStart.getDate(),
              segEndDay: segEnd.getDate(),
              fullCoverage: segStart.getTime() === monthStart.getTime() && segEnd.getTime() === monthEnd.getTime(),
              bizdaysInMonth: monthBusinessDays,
              bizdaysInWindow: inRange,
              pacingFactor,
            });
            if (monthBusinessDays > 0) factorSum += inRange / monthBusinessDays;
            cur.setMonth(cur.getMonth() + 1);
          }
          quotaProrationFactor = factorSum;
        }
      }
    }
    // Task #162 (per spec line 112): Gross MRR Added / Churn goal proration
    // routes through the same Pacing/Remaining model as Net. Gross goals
    // do not have per-month closed buckets in the current data shape, so
    // we treat closed = 0 per slot — which makes:
    //   - Pacing : g × Σ pacingFactor (== legacy quotaProrationFactor)
    //   - Remaining : g × Σ (goalInWindow share without closed reduction)
    //                 i.e. for current month or fully-covered past months
    //                 the full monthly equivalent stands; for partial past
    //                 months it's pacing-share-scaled.
    const prorate = (g: number): number => {
      if (!prorateQuota || monthSlots.length === 0) return g;
      // Task #162 (per spec lines 102-108): churn goals are negative.
      // Sign-preserving — do NOT clamp to 0 here. Display layer applies
      // the headroom-positive convention via Math.abs() where appropriate;
      // the math itself must keep sign so negative goals scale correctly.
      let total = 0;
      for (const slot of monthSlots) {
        if (effectiveQuotaMode === "pacing") {
          total += g * slot.pacingFactor;
        } else {
          const goalInWindow = (slot.isCurrentMonth || slot.fullCoverage)
            ? g
            : g * slot.pacingFactor;
          total += goalInWindow;
        }
      }
      return total;
    };
    // Task #195 (re-applied): GNR gross MRR-Added and Churn goals are always
    // scaled by pacingFactor (window bizdays ÷ month bizdays) regardless of
    // Remaining/Pacing mode. Gross goals have no per-month closed-won bucket
    // to subtract, so the Remaining-mode "full monthly for current month"
    // path would leave the goal unscaled for short windows like Today or
    // This Week, making the BAN/displayed goal not match the selected
    // timeframe. Pacing-style scaling keeps the goal and the actuals in the
    // same window. (The "Remaining" toggle still controls the table layout
    // and label inside the proration tooltip.)
    const prorateGross = (g: number): number => {
      if (!prorateQuota || monthSlots.length === 0) return g;
      let total = 0;
      for (const slot of monthSlots) total += g * slot.pacingFactor;
      return total;
    };
    void quotaProrationFactor;

    // Per-month aggregated breakdown used by the prorated-goal hover tooltip.
    // Sums across reps of (monthlyGoal, subtractable closed, floored
    // contribution) per (product, ymKey). The total breakdown shown on the
    // aggregate goal value is derived by summing across active products at
    // display time so it always matches activeTotalGoal.
    type ProrationBreakdownEntry = {
      ymKey: string;
      monthlyGoal: number;
      // Task #162: goal-in-window for Remaining mode = monthlyGoal for
      // current month and fully-covered past months, monthlyGoal ×
      // pacingFactor for partial-coverage past months at custom-range
      // boundaries (per spec lines 33-37). Used by floorRemainingFromBag
      // so aggregate Remaining = max(0, Σ goalInWindow − Σ closed).
      goalInWindow: number;
      closed: number;
      factor: number;
      contribution: number;
      // Task #162: audit-grade tooltip needs the underlying business-day
      // counts and current/past flags so reps can see the exact inputs that
      // produced the displayed prorated value.
      bizdaysInMonth: number;
      bizdaysInWindow: number;
      pacingFactor: number;
      isCurrentMonth: boolean;
      isPastMonth: boolean;
      // Task #162: per-day-of-month closed CW summed across reps for the
      // current month. Powers the bizday calendar widget's past/today
      // actual cells. Sparse — only days with non-zero CW are present.
      closedByDay: Record<number, number>;
    };
    const productBreakdownByMonth: Record<string, Record<string, ProrationBreakdownEntry>> = {};
    const ensureSlot = (
      bag: Record<string, ProrationBreakdownEntry>,
      slot: MonthSlot,
    ): ProrationBreakdownEntry => {
      let entry = bag[slot.ymKey];
      if (!entry) {
        entry = {
          ymKey: slot.ymKey,
          monthlyGoal: 0,
          goalInWindow: 0,
          closed: 0,
          factor: slot.factor,
          contribution: 0,
          bizdaysInMonth: slot.bizdaysInMonth,
          bizdaysInWindow: slot.bizdaysInWindow,
          pacingFactor: slot.pacingFactor,
          isCurrentMonth: slot.isCurrentMonth,
          isPastMonth: slot.isPastMonth,
          closedByDay: {},
        };
        bag[slot.ymKey] = entry;
      }
      return entry;
    };
    // Sums per-day CW buckets across `[1, segStartDay - 1]` in the slot's
    // month under the active CW mode — i.e. CW that was already booked
    // BEFORE the in-range segment begins. This is the "already-booked"
    // amount that should be subtracted from the monthly goal before
    // prorating the remainder by the segment's business-day factor
    // (mirrors the MTD semantics used for the current month). For a fully
    // covered past month (segStartDay === 1) this returns 0, leaving the
    // full monthly goal × factor=1 to land in the contribution.
    const sumCwDaysBeforeSegment = (
      daysInMonth: Record<string, CwBucket> | undefined,
      slot: MonthSlot,
    ): number => {
      if (!daysInMonth) return 0;
      let s = 0;
      for (let d = 1; d < slot.segStartDay; d++) {
        const b = daysInMonth[String(d)];
        if (b) s += selectCwForMode(b);
      }
      return s;
    };
    // Task #162: sum per-day CW buckets INSIDE the segment [segStartDay,
    // segEndDay] for past months under the Remaining-mode definition
    // ("closed in window" — spec lines 36-37). For a fully-covered past
    // month this should equal the precomputed cwByMonth bucket; we fall
    // through to that bucket when fullCoverage is true to avoid the
    // O(daysInMonth) loop.
    const sumCwDaysInSegment = (
      daysInMonth: Record<string, CwBucket> | undefined,
      slot: MonthSlot,
    ): number => {
      if (!daysInMonth) return 0;
      let s = 0;
      for (let d = slot.segStartDay; d <= slot.segEndDay; d++) {
        const b = daysInMonth[String(d)];
        if (b) s += selectCwForMode(b);
      }
      return s;
    };
    // Task #168: windowed-Remaining mode computes a per-bizday daily pace L
    // and projects the displayed goal as L[anchor] × window_bizdays. When the
    // active filter window is entirely in a past month, fall back silently to
    // Pacing — Remaining math has no anchor.
    type QuotaWindow =
      | { kind: "none" }
      | { kind: "fallback-pacing" }
      | {
          kind: "windowed";
          effectiveStart: Date;
          effectiveEnd: Date;
          windowBizdays: number;
          anchorDay: number;
          currentYm: string;
          wasClamped: boolean;
        };
    const todayPstForWindow = getTodayPST();
    const today0ForWindow = new Date(todayPstForWindow.getFullYear(), todayPstForWindow.getMonth(), todayPstForWindow.getDate());
    const currentYmForWindow = `${today0ForWindow.getFullYear()}-${String(today0ForWindow.getMonth() + 1).padStart(2, "0")}`;
    const computeQuotaWindow = (): QuotaWindow => {
      if (!prorateQuota) return { kind: "none" };
      const r = getDateRange(filters.timeframe, filters.customRange);
      if (!r.from || !r.to) return { kind: "none" };
      const fromD = new Date(r.from + "T00:00:00");
      const toD = new Date(r.to + "T00:00:00");
      const monthStart = new Date(today0ForWindow.getFullYear(), today0ForWindow.getMonth(), 1);
      const monthEnd = new Date(today0ForWindow.getFullYear(), today0ForWindow.getMonth() + 1, 0);
      // Filter window entirely before current month → fallback to Pacing.
      if (toD < monthStart) return { kind: "fallback-pacing" };
      // If the window starts in a future month, treat as "no windowing" so
      // the existing pacing/remaining math handles it (Remaining math at the
      // aggregate level is only well-defined for the current month).
      if (fromD > monthEnd) return { kind: "none" };
      const effStart = fromD < monthStart ? new Date(monthStart) : fromD;
      const effEnd = toD > monthEnd ? new Date(monthEnd) : toD;
      if (effStart > effEnd) return { kind: "none" };
      const wasClamped =
        effStart.getTime() !== fromD.getTime() || effEnd.getTime() !== toD.getTime();
      let anchor: Date;
      if (today0ForWindow < effStart) anchor = effStart;
      else if (today0ForWindow > effEnd) anchor = effStart;
      else anchor = today0ForWindow;
      let windowBizdays = 0;
      const d = new Date(effStart);
      while (d <= effEnd) {
        if (isBusinessDay(d, holidaySet)) windowBizdays++;
        d.setDate(d.getDate() + 1);
      }
      if (windowBizdays === 0) return { kind: "fallback-pacing" };
      return {
        kind: "windowed",
        effectiveStart: effStart,
        effectiveEnd: effEnd,
        windowBizdays,
        anchorDay: anchor.getDate(),
        currentYm: currentYmForWindow,
        wasClamped,
      };
    };
    const quotaWindow = computeQuotaWindow();
    // When eligibility falls back, math/UI must read pacing semantics. Toggle
    // UI still shows the user's preferred mode but disables Remaining.
    const effectiveQuotaMode: "pacing" | "remaining" =
      quotaWindow.kind === "fallback-pacing" ? "pacing" : quotaMode;

    // Build the L (daily pace) series for the current month from a per-day
    // closed map and a monthly goal. Returns lookup-by-day-of-month.
    // Sign convention: take Math.abs of both goal and actuals so churn slots
    // (negative) yield positive L values.
    const buildLForCurrentMonth = (
      monthlyGoal: number,
      closedByDay: Record<number, number> | undefined,
    ): { L: Record<number, number>; H: number; bizdaysOfMonth: number[] } => {
      const y = today0ForWindow.getFullYear();
      const m = today0ForWindow.getMonth();
      const monthEnd = new Date(y, m + 1, 0);
      const bizdaysOfMonth: number[] = [];
      const cur = new Date(y, m, 1);
      while (cur <= monthEnd) {
        if (isBusinessDay(cur, holidaySet)) bizdaysOfMonth.push(cur.getDate());
        cur.setDate(cur.getDate() + 1);
      }
      const N = bizdaysOfMonth.length;
      const absG = Math.abs(monthlyGoal);
      const H = N > 0 ? absG / N : 0;
      const L: Record<number, number> = {};
      if (N === 0) return { L, H, bizdaysOfMonth };
      let cumActual = 0;
      let prevK = 0;
      const cbd = closedByDay || {};
      for (let i = 0; i < N; i++) {
        const dom = bizdaysOfMonth[i];
        const remIncl = N - i;
        const l = i === 0 ? H : H - prevK / remIncl;
        L[dom] = l;
        cumActual += Math.abs(cbd[dom] || 0);
        prevK = cumActual - H * (i + 1);
      }
      return { L, H, bizdaysOfMonth };
    };
    // Pick L at anchor day-of-month, walking forward to the next bizday if
    // the anchor itself is a weekend/holiday; final fallback = last bizday.
    const lookupLAtAnchor = (
      L: Record<number, number>,
      bizdaysOfMonth: number[],
      anchorDay: number,
    ): number => {
      if (bizdaysOfMonth.length === 0) return 0;
      for (const d of bizdaysOfMonth) {
        if (d >= anchorDay) return L[d] || 0;
      }
      return L[bizdaysOfMonth[bizdaysOfMonth.length - 1]] || 0;
    };

    const prorateNetGoalCore = (
      monthlyGoalSrc: number | ((ym: string) => number),
      cwByMonth: Record<string, CwBucket> | undefined,
      cwDaysByMonth: Record<string, Record<string, CwBucket>> | undefined,
      cwMtd: CwBucket | undefined,
      bag: Record<string, ProrationBreakdownEntry>,
      goalByYm?: Record<string, number>,
    ): number => {
      // Task #165: monthlyGoalSrc may be a per-ym lookup so each month row
      // surfaces its own M GOAL (May shows May's quota, April shows April's).
      // Number form is preserved for callsites that don't have per-month data
      // (e.g. gross MRR added / churn goals — single value per rep).
      const lookup = typeof monthlyGoalSrc === "function" ? monthlyGoalSrc : (_ym: string) => monthlyGoalSrc;
      if (!prorateQuota || monthSlots.length === 0) return lookup(monthSlots[0]?.ymKey || "");
      let total = 0;
      for (const slot of monthSlots) {
        const slotMonthlyGoal = lookup(slot.ymKey);
        // Compute subtractable closed-to-date even in pacing mode so the
        // bag preserves the full audit trail (tooltip / calendar can show
        // closed-to-date as context). Pacing math itself ignores it.
        // Task #162 (per spec lines 35-37): Remaining-mode "closed in
        // window" = MTD CW for current month, full-month CW for fully
        // covered past months, per-day CW summed over the segment for
        // partial-coverage past months. Future months always 0.
        let subtractable = 0;
        if (slot.isCurrentMonth) {
          subtractable = selectCwForMode(cwMtd);
        } else if (slot.isPastMonth) {
          if (slot.fullCoverage) {
            subtractable = selectCwForMode(cwByMonth?.[slot.ymKey]);
          } else {
            subtractable = sumCwDaysInSegment(cwDaysByMonth?.[slot.ymKey], slot);
          }
        } else {
          subtractable = 0;
        }
        // Reference suppress-warning if unused branch eliminates it.
        void sumCwDaysBeforeSegment;
        // Task #162 (per spec lines 25-37): dispatch on quotaMode.
        // - Pacing  : contribution = slotMonthlyGoal × pacingFactor (no
        //             closed, no floor — pure time-share against the
        //             calendar month).
        // - Remaining: goalInWindow = full slotMonthlyGoal for current month
        //             and fully-covered past months; slotMonthlyGoal ×
        //             pacingFactor for partial-coverage past months at
        //             custom-range boundaries. Per-rep contribution =
        //             max(0, goalInWindow − closed_in_window). Aggregate-level
        //             un-floored re-derivation happens after the rep loop in
        //             floorRemainingFromBag.
        const goalInWindow = (slot.isCurrentMonth || slot.fullCoverage)
          ? slotMonthlyGoal
          : slotMonthlyGoal * slot.pacingFactor;
        let contribution = 0;
        if (effectiveQuotaMode === "pacing") {
          contribution = slotMonthlyGoal * slot.pacingFactor;
        } else {
          // Per-rep contribution stays floored — drilldown rows show this.
          // Aggregate readout strips the floor in floorRemainingFromBag.
          contribution = Math.max(0, goalInWindow - subtractable);
        }
        total += contribution;
        const entry = ensureSlot(bag, slot);
        entry.monthlyGoal += slotMonthlyGoal;
        entry.goalInWindow += goalInWindow;
        entry.closed += subtractable;
        entry.contribution += contribution;
        // Task #162: aggregate per-day actuals for current month only —
        // these power the calendar widget's past/today $ cells. Sum across
        // reps via the shared bag.
        if (slot.isCurrentMonth) {
          const days = cwDaysByMonth?.[slot.ymKey];
          if (days) {
            for (const [dStr, b] of Object.entries(days)) {
              const dNum = parseInt(dStr, 10);
              if (!Number.isFinite(dNum)) continue;
              const v = selectCwForMode(b);
              if (!v) continue;
              entry.closedByDay[dNum] = (entry.closedByDay[dNum] || 0) + v;
            }
          }
        }
      }
      return total;
    };
    // Task #162: derive a floor-at-aggregate Remaining-mode total from a
    // breakdown bag. For each month we compute max(0, sum(monthlyGoal) −
    // sum(closed)) × factor, i.e. apply the floor AFTER the cross-rep sum.
    // This is the value that fixes the overperformer-inflation bug — it
    // can never exceed the per-rep floored sum (entry.contribution sum)
    // and equals it when no rep is over their personal monthly goal.
    // Pacing mode short-circuits to the bag's pre-computed contribution
    // sum (already correct, no floor needed).
    const floorRemainingFromBag = (bag: Record<string, ProrationBreakdownEntry>): number => {
      if (!prorateQuota) return 0;
      // Task #168: when filter is windowed AND in remaining mode, replace
      // the current-month contribution with L[anchor] × window_bizdays
      // (computed from aggregate H/K, since L is path-dependent).
      // Past-month entries fall back to pacing-style contribution since
      // Remaining math has no anchor for past months.
      if (effectiveQuotaMode === "remaining" && quotaWindow.kind === "windowed") {
        let total = 0;
        for (const e of Object.values(bag)) {
          if (e.ymKey === quotaWindow.currentYm) {
            const { L, bizdaysOfMonth } = buildLForCurrentMonth(e.monthlyGoal, e.closedByDay);
            const lAnchor = lookupLAtAnchor(L, bizdaysOfMonth, quotaWindow.anchorDay);
            // Preserve sign of the original goal (negative for churn).
            const sign = e.monthlyGoal < 0 ? -1 : 1;
            total += sign * lAnchor * quotaWindow.windowBizdays;
          } else {
            // Past/future months in the same filter window: use the
            // (unfloored) goalInWindow − closed signed remainder.
            total += e.goalInWindow - e.closed;
          }
        }
        return total;
      }
      let total = 0;
      for (const e of Object.values(bag)) {
        if (effectiveQuotaMode === "pacing") {
          total += e.contribution;
        } else {
          // Task #168: strip the per-rep max(0, …) floor at the aggregate
          // readout — overperformer overage now reduces team buckets
          // instead of being clipped to zero.
          total += e.goalInWindow - e.closed;
        }
      }
      return total;
    };
    const isWindowedRemaining = windowedEligibility?.mode === 'windowed-remaining';
    const wr = isWindowedRemaining
      ? (windowedEligibility as Extract<WindowedRemainingEligibility, { mode: 'windowed-remaining' }>)
      : null;
    const productGoalsWindowed: Record<string, number> = {};
    // Per-rep windowed-remaining contribution. Closed-through-anchor is
    // sourced from the BAN-side `productFunnelAdded` (window-filtered CW)
    // so the aggregate BAN value reconciles to the card BAN. The previous
    // implementation summed `productCwDaysByMonth` day buckets for days <
    // anchorDay, but that bucket can diverge from pfAdded on certain rows
    // (~$2.8k for Trevor's team on Showcase+SCI in May), which yielded a
    // stale prorated number like $17.2k instead of the expected $18.7k.
    // Formula: max(0, monthlyGoal − closedThroughAnchor) ÷ bizdaysRemFromAnchor
    //          × windowBizdays. Matches the user's hand calc exactly.
    const computeWindowedContribFromClosed = (
      monthlyGoalFn: (ym: string) => number,
      closedThroughAnchor: number,
    ): number => {
      if (!wr) return 0;
      const todayW = getTodayPST();
      const wy = todayW.getFullYear();
      const wm = todayW.getMonth();
      const ymKey = `${wy}-${String(wm + 1).padStart(2, '0')}`;
      const monthlyGoal = monthlyGoalFn(ymKey);
      const monthEnd = new Date(wy, wm + 1, 0);
      let bizdaysRemFromAnchor = 0;
      {
        const d = new Date(wy, wm, wr.anchorDay);
        while (d <= monthEnd) {
          if (isBusinessDay(d, holidaySet)) bizdaysRemFromAnchor++;
          d.setDate(d.getDate() + 1);
        }
      }
      if (bizdaysRemFromAnchor <= 0) return 0;
      const remaining = Math.max(0, monthlyGoal - closedThroughAnchor);
      return (remaining / bizdaysRemFromAnchor) * wr.windowBizdays;
    };
    // Task #165: build a per-ym monthly-goal lookup for a rep × product so
    // each month slot in the proration breakdown surfaces its own M GOAL
    // instead of bleeding the loaded snapshot's value across all months.
    // Only Showcase and MBP have per-month upstream quotas; other products
    // (Showcase Incremental, etc.) fall back to the single passed value.
    const goalLookupFor = (g: number, r: typeof reps[0], prod: string): ((ym: string) => number) => {
      const byYm =
        prod === "Showcase" ? (r as any).showcaseGoalByYm as Record<string, number> | undefined
          : prod === "MBP" ? (r as any).mbpGoalByYm as Record<string, number> | undefined
            : undefined;
      if (!byYm || Object.keys(byYm).length === 0) return () => g;
      // Fall through to the passed `g` when a slot's ym isn't in the per-ym
      // map (only current + previous month are available upstream).
      // Distinguish "missing key" from "legitimate zero quota". A rep with
       // an explicit 0 monthly quota for a given ym should yield 0, not the
       // snapshot fallback (which would re-introduce the bleed).
      return (ym: string) => (Object.prototype.hasOwnProperty.call(byYm, ym) ? byYm[ym] : g);
    };
    const prorateNetProduct = (g: number, r: typeof reps[0], prod: string) => {
      const bag = (productBreakdownByMonth[prod] ||= {});
      const pcm = (r.productCwByMonth || {}) as Record<string, Record<string, CwBucket>>;
      const pcMtd = (r.productCwMtd || {}) as Record<string, CwBucket>;
      const pcDays = (r.productCwDaysByMonth || {}) as Record<string, Record<string, Record<string, CwBucket>>>;
      if (isWindowedRemaining) {
        // Source closed-through-anchor from `productCwMtd.added` — month-to-
        // date positive Closed Won, independent of the user's date filter.
        // This is the "closed so far this month" quantity the formula
        // expects: remaining = max(0, monthlyGoal − MTD closed), then
        // amortized across remaining bizdays and scaled to the window.
        //
        // For Trevor's team Showcase+SCI on May 18 ("This Week" filter):
        //   monthlyGoal = $68,690 (G&R sheet combined SC+SCI quota)
        //   closed MTD = $23,728 (SC) + $11,220 (SCI) = $34,948
        //   remaining = $33,742; 9 bizdays left in month; window = 5 bizdays
        //   ⇒ $33,742 / 9 × 5 = $18,745.56 (matches user's hand calc).
        //
        // Showcase rolls SCI's closed in too — mirrors the existing
        // convention that the Showcase quota row's `mrr` always combines
        // Showcase + SCI Closed Won (see allProductQuotas Showcase branch).
        // For G&R reps, `showcaseGoal` is already the combined SC+SCI
        // monthly target, so subtracting only SC's closed would inflate
        // the remaining-to-hit by the SCI booked amount.
        let closedThroughAnchor = pcMtd[prod]?.added || 0;
        if (prod === "Showcase") {
          closedThroughAnchor += pcMtd["Showcase Incremental"]?.added || 0;
          closedThroughAnchor += pcMtd["Showcase Incremental - Re/Max"]?.added || 0;
          closedThroughAnchor += pcMtd["Overage"]?.added || 0;
        }
        productGoalsWindowed[prod] = (productGoalsWindowed[prod] || 0) +
          computeWindowedContribFromClosed(goalLookupFor(g, r, prod), closedThroughAnchor);
      }
      return prorateNetGoalCore(goalLookupFor(g, r, prod), pcm[prod], pcDays[prod], pcMtd[prod], bag);
    };
    // Same math as `prorateNetProduct` but writes to a discarded bag — used
    // by the per-rep breakdown builder so we don't double-count contributions
    // into the aggregated tooltip bag (the main rep loop already populated it).
    const prorateNetProductNoBag = (g: number, r: typeof reps[0], prod: string) => {
      const throwaway: Record<string, ProrationBreakdownEntry> = {};
      const pcm = (r.productCwByMonth || {}) as Record<string, Record<string, CwBucket>>;
      const pcMtd = (r.productCwMtd || {}) as Record<string, CwBucket>;
      const pcDays = (r.productCwDaysByMonth || {}) as Record<string, Record<string, Record<string, CwBucket>>>;
      return prorateNetGoalCore(goalLookupFor(g, r, prod), pcm[prod], pcDays[prod], pcMtd[prod], throwaway);
    };
    // Used only on the "no products selected" total branch where the rep's
    // total `goal30d` doesn't have a per-product decomposition. It writes to
    // a private bag (not surfaced) since the displayed total is derived from
    // the active product breakdowns instead.
    const noopTotalBag: Record<string, ProrationBreakdownEntry> = {};
    const prorateNetTotal = (g: number, r: typeof reps[0]) => {
      const cwByMonth = (r.cwByMonth || {}) as Record<string, CwBucket>;
      const cwDays = (r.cwDaysByMonth || {}) as Record<string, Record<string, CwBucket>>;
      const cwMtd = r.cwMtd as CwBucket | undefined;
      return prorateNetGoalCore(g, cwByMonth, cwDays, cwMtd, noopTotalBag);
    };

    const selectedProducts = filters.products;
    const isMultiProduct = selectedProducts.length > 1;
    const isSingleProduct = selectedProducts.length === 1;
    const activeProducts = selectedProducts.length > 0 ? selectedProducts : [];

    const funnelSums: Record<string, number> = {
      Discovery: 0, "Demo Scheduled": 0, "Proposal/Negotiation": 0,
      "Paperwork Sent": 0, "Awaiting Payment": 0, "Closed Won": 0, "Closed Lost": 0,
    };

    const funnelProductSums: Record<string, Record<string, number>> = {};
    for (const stage of Object.keys(funnelSums)) {
      funnelProductSums[stage] = {};
    }

    const funnelCountSums: Record<string, number> = {
      Discovery: 0, "Demo Scheduled": 0, "Proposal/Negotiation": 0,
      "Paperwork Sent": 0, "Awaiting Payment": 0, "Closed Won": 0, "Closed Lost": 0,
    };
    const funnelProductCountSums: Record<string, Record<string, number>> = {};
    for (const stage of Object.keys(funnelCountSums)) {
      funnelProductCountSums[stage] = {};
    }
    const _ALL_STAGES_FOR_COUNT = Object.keys(funnelCountSums);



    let totalGoal = 0;
    let totalMrr = 0;
    let totalMrrForQuota = 0;
    const productGoals: Record<string, number> = {};
    const productMrrForQuota: Record<string, number> = {};
    // SCI is tracked separately (always, regardless of filter) so it can roll
    // into the Showcase quota row when SCI is selected — even if the filter is
    // SCI-only and the rep loop doesn't otherwise visit SCI.
    let sciMrrForQuotaTotal = 0;
    let sciWeightedTotal = 0;
    // SCI-R (Showcase Incremental - Re/Max) tracked separately, same pattern
    // as SCI — its own bucket, rolls into the Showcase quota row alongside SCI.
    let scirMrrForQuotaTotal = 0;
    let scirWeightedTotal = 0;
    // Overage tracked separately, same pattern as SCI/SCI-R — rolls into the
    // Showcase quota row alongside SCI and SCI-R.
    let overageMrrForQuotaTotal = 0;
    let overageWeightedTotal = 0;

    const getKey = (r: typeof reps[0]) => {
      if (aggBy === "FLM") return r.flm;
      if (aggBy === "SLM") return r.slm;
      if (aggBy === "Region") return r.region;
      if (aggBy === "Segment") return (r as any).segment || "";
      return r.name;
    };
    
    const repMrrMap: Record<string, StackedBarEntry> = {};
    const repChurnMap: Record<string, StackedBarEntry> = {};
    const repModsMap: Record<string, StackedBarEntry> = {};

    reps.forEach(r => {
      const pfStd = (r as any).productFunnel as Record<string, Record<string, number>> | undefined;
      const pfMode = (r as any)[isAdded ? "productFunnelAdded" : isAcqNet ? "productFunnelAcqNet" : "productFunnel"] as Record<string, Record<string, number>> | undefined;
      const pcAll = (r as any).productChurn as Record<string, number> | undefined;
      const pcAcq = (r as any).acqProductChurn as Record<string, number> | undefined;
      let pc: Record<string, number> | undefined;
      if (isAdded) {
        pc = pcAll;
      } else if (isAcqNet) {
        pc = pcAcq;
      } else {
        pc = pcAll;
      }

      const stdFunnel = r.funnel || {};
      const modeFunnel = isAdded ? ((r as any).funnelAdded || {}) : isAcqNet ? ((r as any).funnelAcqNet || {}) : stdFunnel;
      // Task #448: the MRR card is ALWAYS gross (positive Closed Won), in every
      // mode. Source its values from the Added funnel, independent of the active
      // mode. Quota-booked figures (totalMrrForQuota/productMrrForQuota) stay on
      // pfMode/modeFunnel so the Goal/Forecast booked math is unchanged.
      const pfGross = (r as any).productFunnelAdded as Record<string, Record<string, number>> | undefined;
      const grossFunnel = (r as any).funnelAdded || {};
      const closedWonStages = new Set(["Closed Won"]);

      const fCount = (r as any).funnelOppCount as Record<string, number> | undefined;
      const pfCount = (r as any).productFunnelOppCount as Record<string, Record<string, number>> | undefined;

      // Mode-aware Closed Won opp count: matches drilldown modal filter semantics.
      // Non-CW stages have identical counts across modes/CR, so only Closed Won is overridden.
      const cwCountForRep = (() => {
        if (isAdded) return (r as any).closedWonOppCountAdded as number | undefined;
        if (isAcqNet) {
          return (r as any).closedWonOppCountAcqNet as number | undefined;
        }
        return fCount?.["Closed Won"] as number | undefined;
      })();
      const cwCountForProd = (prod: string): number => {
        if (isAdded) {
          const m = (r as any).productClosedWonOppCountAdded as Record<string, number> | undefined;
          return m?.[prod] || 0;
        }
        if (isAcqNet) {
          const m = (r as any).productClosedWonOppCountAcqNet as Record<string, number> | undefined;
          return m?.[prod] || 0;
        }
        return pfCount?.[prod]?.["Closed Won"] || 0;
      };

      if (activeProducts.length > 0 && pfStd) {
        // MRR sums per product (these are additive across products by design).
        for (const prod of activeProducts) {
          const stdStages = pfStd[prod] || {};
          const modeStages = pfMode?.[prod] || {};
          for (const [stage, val] of Object.entries(stdStages)) {
            if (funnelSums[stage] !== undefined) {
              // For Closed Won in mode-specific views (added/acqNet), never fall back to pfStd.
              // pfStd may contain net-negative MRR (churn) that the mode explicitly excludes —
              // falling back would leak those values into the funnel and weighted/forecast totals.
              const useVal = closedWonStages.has(stage) ? (modeStages[stage] || 0) : val;
              funnelSums[stage] += useVal;
              funnelProductSums[stage][prod] = (funnelProductSums[stage][prod] || 0) + useVal;
            }
          }
          if (modeStages["Closed Won"] !== undefined && stdStages["Closed Won"] === undefined) {
            funnelSums["Closed Won"] += modeStages["Closed Won"];
            funnelProductSums["Closed Won"][prod] = (funnelProductSums["Closed Won"][prod] || 0) + modeStages["Closed Won"];
          }
          // Per-product opp count breakdown (used elsewhere for tooltips); for
          // Closed Won use mode-aware count.
          const prodCounts = pfCount?.[prod] || {};
          for (const [stage, cnt] of Object.entries(prodCounts)) {
            if (funnelCountSums[stage] !== undefined && stage !== "Closed Won") {
              funnelProductCountSums[stage][prod] = (funnelProductCountSums[stage][prod] || 0) + cnt;
            }
          }
          const prodCw = cwCountForProd(prod);
          if (prodCw) {
            funnelProductCountSums["Closed Won"][prod] = (funnelProductCountSums["Closed Won"][prod] || 0) + prodCw;
          }
        }
        // Distinct opp counts per stage: union opp IDs across selected products
        // (an opp present in 2+ selected products must be counted once).
        const pfIds = (r as any).productFunnelOppIds as Record<string, Record<string, string[]>> | undefined;
        const cwIdsByProd = (() => {
          if (isAdded) return (r as any).productClosedWonOppIdsAdded as Record<string, string[]> | undefined;
          if (isAcqNet) {
            return (r as any).productClosedWonOppIdsAcqNet as Record<string, string[]> | undefined;
          }
          const m: Record<string, string[]> = {};
          if (pfIds) {
            for (const [p, stages] of Object.entries(pfIds)) {
              if (stages["Closed Won"]) m[p] = stages["Closed Won"];
            }
          }
          return m;
        })();
        for (const stage of _ALL_STAGES_FOR_COUNT) {
          const union = new Set<string>();
          for (const prod of activeProducts) {
            const ids = stage === "Closed Won"
              ? (cwIdsByProd?.[prod] || [])
              : (pfIds?.[prod]?.[stage] || []);
            for (const id of ids) union.add(id);
          }
          funnelCountSums[stage] += union.size;
        }
      } else {
        Object.entries(stdFunnel).forEach(([k, v]: [string, any]) => {
          if (funnelSums[k] !== undefined) {
            const useVal = closedWonStages.has(k) ? (modeFunnel[k] || 0) : v;
            funnelSums[k] += useVal;
          }
        });
        if (modeFunnel["Closed Won"] !== undefined && stdFunnel["Closed Won"] === undefined) {
          funnelSums["Closed Won"] += modeFunnel["Closed Won"];
        }
        if (pfStd) {
          for (const [prod, stages] of Object.entries(pfStd)) {
            const modeStages = pfMode?.[prod] || {};
            for (const [stage, val] of Object.entries(stages)) {
              if (funnelProductSums[stage]) {
                const useVal = closedWonStages.has(stage) ? (modeStages[stage] || 0) : val;
                funnelProductSums[stage][prod] = (funnelProductSums[stage][prod] || 0) + useVal;
              }
            }
            if (modeStages["Closed Won"] !== undefined && stages["Closed Won"] === undefined) {
              funnelProductSums["Closed Won"][prod] = (funnelProductSums["Closed Won"][prod] || 0) + modeStages["Closed Won"];
            }
          }
        }
        if (fCount) {
          for (const [stage, cnt] of Object.entries(fCount)) {
            if (funnelCountSums[stage] !== undefined && stage !== "Closed Won") {
              funnelCountSums[stage] += cnt;
            }
          }
        }
        if (cwCountForRep) {
          funnelCountSums["Closed Won"] += cwCountForRep;
        }
        if (pfCount) {
          for (const [prod, stages] of Object.entries(pfCount)) {
            for (const [stage, cnt] of Object.entries(stages)) {
              if (funnelProductCountSums[stage] && stage !== "Closed Won") {
                funnelProductCountSums[stage][prod] = (funnelProductCountSums[stage][prod] || 0) + cnt;
              }
            }
          }
          for (const prod of Object.keys(pfCount)) {
            const prodCw = cwCountForProd(prod);
            if (prodCw) {
              funnelProductCountSums["Closed Won"][prod] = (funnelProductCountSums["Closed Won"][prod] || 0) + prodCw;
            }
          }
        }
      }

      const key = getKey(r);
      if (!repChurnMap[key]) repChurnMap[key] = { name: key, total: 0 };
      if (!repModsMap[key]) repModsMap[key] = { name: key, total: 0 };

      const modeClosedWon = modeFunnel["Closed Won"] || 0;

      // Always accumulate SCI Closed Won for the Showcase quota row, regardless of filter.
      const sciStages = pfMode?.["Showcase Incremental"];
      if (sciStages) {
        sciMrrForQuotaTotal += sciStages["Closed Won"] || 0;
        // Per-opp probability weighting for SCI active stages is recomputed below
        // from the server-provided weightedProductFunnel (see sciActiveWeighted).
      }
      // Mirror for SCI-R — rolls into Showcase quota row alongside SCI.
      const scirStages = pfMode?.["Showcase Incremental - Re/Max"];
      if (scirStages) {
        scirMrrForQuotaTotal += scirStages["Closed Won"] || 0;
      }
      // Mirror for Overage — rolls into Showcase quota row alongside SCI and SCI-R.
      const overageStages = pfMode?.["Overage"];
      if (overageStages) {
        overageMrrForQuotaTotal += overageStages["Closed Won"] || 0;
      }

      if (isSingleProduct) {
        const prod0 = selectedProducts[0];
        const prodGoal = prorateNetProduct(netGoalFor(r, prod0), r, prod0);
        totalGoal += prodGoal;
        productGoals[prod0] = (productGoals[prod0] || 0) + prodGoal;
        const modeProductCW = pfMode?.[selectedProducts[0]]?.["Closed Won"] || 0;
        totalMrrForQuota += modeProductCW;
        productMrrForQuota[prod0] = (productMrrForQuota[prod0] || 0) + modeProductCW;
        const mrr = pfGross?.[selectedProducts[0]]?.["Closed Won"] || 0;
        totalMrr += mrr;

        for (const p of ALL_PRODUCTS) {
          if (p === prod0) continue;
          const pgRaw = netGoalFor(r, p);
          const pg = prorateNetProduct(pgRaw, r, p);
          productGoals[p] = (productGoals[p] || 0) + pg;
          const pCW = pfMode?.[p]?.["Closed Won"] || 0;
          if (pCW !== 0) productMrrForQuota[p] = (productMrrForQuota[p] || 0) + pCW;
        }

        if (!repMrrMap[key]) repMrrMap[key] = { name: key, total: 0 };
        repMrrMap[key].total += mrr;
        repMrrMap[key][selectedProducts[0]] = (repMrrMap[key][selectedProducts[0]] as number || 0) + mrr;

        const prodChurn = (pc?.[selectedProducts[0]] || 0);
        repChurnMap[key].total += prodChurn;
        repChurnMap[key][selectedProducts[0]] = (repChurnMap[key][selectedProducts[0]] as number || 0) + prodChurn;

        const pm = (r as RepPipelineWithMods).productMods;
        repModsMap[key].total += pm?.[selectedProducts[0]] || 0;
      } else if (isMultiProduct && pfMode) {
        let multiGoal = 0;
        for (const prod of selectedProducts) {
          const pgRaw = netGoalFor(r, prod);
          const pg = prorateNetProduct(pgRaw, r, prod);
          multiGoal += pg;
          productGoals[prod] = (productGoals[prod] || 0) + pg;
        }
        totalGoal += multiGoal;
        let repTotalMrr = 0;
        for (const prod of selectedProducts) {
          const prodMrr = pfMode?.[prod]?.["Closed Won"] || 0;
          totalMrrForQuota += prodMrr;
          productMrrForQuota[prod] = (productMrrForQuota[prod] || 0) + prodMrr;
          const prodMrrGross = pfGross?.[prod]?.["Closed Won"] || 0;
          if (!repMrrMap[key]) repMrrMap[key] = { name: key, total: 0 };
          repMrrMap[key][prod] = (repMrrMap[key][prod] as number || 0) + prodMrrGross;
          repTotalMrr += prodMrrGross;
        }
        repMrrMap[key].total += repTotalMrr;
        totalMrr += repTotalMrr;

        const selectedSet = new Set(selectedProducts);
        for (const p of ALL_PRODUCTS) {
          if (selectedSet.has(p)) continue;
          const pgRaw = netGoalFor(r, p);
          const pg = prorateNetProduct(pgRaw, r, p);
          productGoals[p] = (productGoals[p] || 0) + pg;
          const pCW = pfMode?.[p]?.["Closed Won"] || 0;
          if (pCW !== 0) productMrrForQuota[p] = (productMrrForQuota[p] || 0) + pCW;
        }

        let churnTotal = 0;
        for (const prod of selectedProducts) {
          const cv = (pc?.[prod] || 0);
          repChurnMap[key][prod] = (repChurnMap[key][prod] as number || 0) + cv;
          churnTotal += cv;
        }
        repChurnMap[key].total += churnTotal;
        const pm = (r as RepPipelineWithMods).productMods;
        let modsTotal = 0;
        for (const prod of selectedProducts) {
          modsTotal += pm?.[prod] || 0;
        }
        repModsMap[key].total += modsTotal;
      } else {
        totalGoal += prorateNetTotal(r.goal30d, r);
        totalMrrForQuota += modeClosedWon;
        const mrr = grossFunnel["Closed Won"] || 0;
        totalMrr += mrr;

        for (const prod of ALL_PRODUCTS) {
          const pg = prorateNetProduct(netGoalFor(r, prod), r, prod);
          productGoals[prod] = (productGoals[prod] || 0) + pg;
        }

        if (pfMode) {
          for (const prod of ALL_PRODUCTS) {
            const prodCW = pfMode[prod]?.["Closed Won"] || 0;
            if (prodCW !== 0) {
              productMrrForQuota[prod] = (productMrrForQuota[prod] || 0) + prodCW;
            }
          }
        }

        if (!repMrrMap[key]) repMrrMap[key] = { name: key, total: 0 };
        repMrrMap[key].total += mrr;
        if (pfGross) {
          for (const [prod, stages] of Object.entries(pfGross)) {
            const prodMrr = stages["Closed Won"] || 0;
            if (prodMrr !== 0) {
              repMrrMap[key][prod] = (repMrrMap[key][prod] as number || 0) + prodMrr;
            }
          }
        }

        const churnVal = isAcqNet
            ? ((r as any).acqChurn30d || 0)
            : (r.churn30d || 0);
        repChurnMap[key].total += churnVal;
        if (pc) {
          for (const [prod, val] of Object.entries(pc)) {
            repChurnMap[key][prod] = (repChurnMap[key][prod] as number || 0) + val;
          }
        }

        repModsMap[key].total += r.mods30d;
      }
    });

    const repMrr = Object.values(repMrrMap).sort((a, b) => b.total - a.total);
    const repChurn = Object.values(repChurnMap).sort((a, b) => b.total - a.total);
    const repMods = Object.values(repModsMap).sort((a, b) => b.total - a.total);

    const displayProducts = activeProducts.length > 0
      ? activeProducts
      : [];

    // ---- Per-opp probability aggregation (server-side weighted sums) ----
    // All weighted stages use per-opp effective probability (server-side sums),
    // including Closed Won — Closed Won opps may have per-opp probability overrides.
    const ACTIVE_WEIGHTED_STAGES = ["Discovery", "Demo Scheduled", "Proposal/Negotiation", "Paperwork Sent", "Awaiting Payment"];
    const ALL_WEIGHTED_STAGES = [...ACTIVE_WEIGHTED_STAGES, "Closed Won"];
    const weightedActiveSums: Record<string, number> = {};
    const weightedActiveProductSums: Record<string, Record<string, number>> = {};
    for (const s of ALL_WEIGHTED_STAGES) {
      weightedActiveSums[s] = 0;
      weightedActiveProductSums[s] = {};
    }
    // SCI weighted (all stages incl. CW) accumulated independently for the
    // Showcase quota row roll-up, mirroring the existing sciWeightedTotal logic.
    let sciActiveWeighted = 0;
    let scirActiveWeighted = 0;
    let overageActiveWeighted = 0;
    // Per-rep mode-aware weighted product funnel snapshot (built once per rep
    // inside the loop below) so the per-rep Forecast drilldown can compute
    // weighted-per-product without re-deriving the mode-specific Closed Won.
    const wpfByRep = new WeakMap<object, Record<string, Record<string, number>>>();
    // Current avg probability stats per stage (across visible reps).
    const probSumActive: Record<string, number> = {};
    const probCountActive: Record<string, number> = {};
    const probSumProductActive: Record<string, Record<string, number>> = {};
    const probCountProductActive: Record<string, Record<string, number>> = {};
    for (const s of ALL_WEIGHTED_STAGES) {
      probSumActive[s] = 0;
      probCountActive[s] = 0;
      probSumProductActive[s] = {};
      probCountProductActive[s] = {};
    }

    reps.forEach(r => {
      const wfRaw = (r as any).weightedFunnel as Record<string, number> | undefined;
      const wpfRaw = (r as any).weightedProductFunnel as Record<string, Record<string, number>> | undefined;
      const wCwAdded: number = (r as any).weightedClosedWonAdded || 0;
      const wCwAcqNet: number = (r as any).weightedClosedWonAcqNet || 0;
      const wpCwAdded: Record<string, number> = (r as any).weightedProductClosedWonAdded || {};
      const wpCwAcqNet: Record<string, number> = (r as any).weightedProductClosedWonAcqNet || {};

      // Mode-aware weighted Closed Won: mirror the unweighted Added / AcqNet
      // rules so the modal's weighted CW reconciles with the unweighted CW under
      // every mode. Active stages are mode-agnostic and pass through unchanged.
      const cwForMode: number = isAdded
        ? wCwAdded
        : isAcqNet
          ? wCwAcqNet
          : weightedCwGross
            ? wCwAdded
            : (wfRaw?.["Closed Won"] || 0);
      const wf: Record<string, number> | undefined = wfRaw
        ? { ...wfRaw, "Closed Won": cwForMode }
        : { "Closed Won": cwForMode };

      const wpf: Record<string, Record<string, number>> = {};
      const allProductsForCw = new Set<string>([
        ...Object.keys(wpfRaw || {}),
        ...Object.keys(wpCwAdded),
        ...Object.keys(wpCwAcqNet),
      ]);
      if (wpfRaw) {
        for (const [prod, stages] of Object.entries(wpfRaw)) wpf[prod] = { ...stages };
      }
      for (const prod of allProductsForCw) {
        const cwAll = wpfRaw?.[prod]?.["Closed Won"] || 0;
        const cwAddedP = wpCwAdded[prod] || 0;
        const cwAcqNetP = wpCwAcqNet[prod] || 0;
        const cw = isAdded
          ? cwAddedP
          : isAcqNet
            ? cwAcqNetP
            : weightedCwGross
              ? cwAddedP
              : cwAll;
        if (!wpf[prod]) wpf[prod] = {};
        wpf[prod]["Closed Won"] = cw;
      }
      wpfByRep.set(r as unknown as object, wpf);

      const psSum = (r as any).funnelProbSum as Record<string, number> | undefined;
      const psSumProd = (r as any).productFunnelProbSum as Record<string, Record<string, number>> | undefined;
      const fc = (r as any).funnelOppCount as Record<string, number> | undefined;
      const pfc = (r as any).productFunnelOppCount as Record<string, Record<string, number>> | undefined;

      for (const s of ALL_WEIGHTED_STAGES) {
        if (activeProducts.length === 0) {
          weightedActiveSums[s] += wf?.[s] || 0;
          probSumActive[s] += psSum?.[s] || 0;
          probCountActive[s] += fc?.[s] || 0;
        } else {
          for (const prod of activeProducts) {
            const v = wpf?.[prod]?.[s] || 0;
            weightedActiveSums[s] += v;
            const pSum = psSumProd?.[prod]?.[s] || 0;
            const pCnt = pfc?.[prod]?.[s] || 0;
            probSumActive[s] += pSum;
            probCountActive[s] += pCnt;
          }
        }
        // Per-product weighted + prob stats are always accumulated across ALL
        // products (independent of product filter) so product roll-ups
        // (productWeighted, allProductQuotas) and per-product current-prob stats
        // remain correct in the default unfiltered view.
        if (wpf) {
          for (const [prod, stages] of Object.entries(wpf)) {
            const v = stages?.[s] || 0;
            if (v) weightedActiveProductSums[s][prod] = (weightedActiveProductSums[s][prod] || 0) + v;
          }
        }
        if (psSumProd) {
          for (const [prod, stages] of Object.entries(psSumProd)) {
            const pSum = stages?.[s] || 0;
            if (pSum) probSumProductActive[s][prod] = (probSumProductActive[s][prod] || 0) + pSum;
          }
        }
        if (pfc) {
          for (const [prod, stages] of Object.entries(pfc)) {
            const pCnt = stages?.[s] || 0;
            if (pCnt) probCountProductActive[s][prod] = (probCountProductActive[s][prod] || 0) + pCnt;
          }
        }
        // SCI roll-up — independent of product filter (mirrors sciMrrForQuotaTotal pattern)
        sciActiveWeighted += wpf?.["Showcase Incremental"]?.[s] || 0;
        scirActiveWeighted += wpf?.["Showcase Incremental - Re/Max"]?.[s] || 0;
        overageActiveWeighted += wpf?.["Overage"]?.[s] || 0;
      }
    });

    // The Forecast by-Rep drilldown sources its rows from `repsAll` (broader
    // set, see top of memo). Populate `wpfByRep` for any extra reps in
    // repsAll that the main loop above didn't cover, so per-rep weighted
    // figures resolve correctly when we build forecastRepBreakdowns below.
    // Only the wpf side-effect runs here — no accumulators are touched.
    const repSetForReps = new Set(reps);
    const extraReps = repsAll.filter(r => !repSetForReps.has(r));
    extraReps.forEach(r => {
      const wpfRaw = (r as any).weightedProductFunnel as Record<string, Record<string, number>> | undefined;
      const wpCwAdded: Record<string, number> = (r as any).weightedProductClosedWonAdded || {};
      const wpCwAcqNet: Record<string, number> = (r as any).weightedProductClosedWonAcqNet || {};
      const wpf: Record<string, Record<string, number>> = {};
      const allProductsForCw = new Set<string>([
        ...Object.keys(wpfRaw || {}),
        ...Object.keys(wpCwAdded),
        ...Object.keys(wpCwAcqNet),
      ]);
      if (wpfRaw) {
        for (const [prod, stages] of Object.entries(wpfRaw)) wpf[prod] = { ...stages };
      }
      for (const prod of allProductsForCw) {
        const cwAll = wpfRaw?.[prod]?.["Closed Won"] || 0;
        const cwAddedP = wpCwAdded[prod] || 0;
        const cwAcqNetP = wpCwAcqNet[prod] || 0;
        const cw = isAdded
          ? cwAddedP
          : isAcqNet
            ? cwAcqNetP
            : weightedCwGross
              ? cwAddedP
              : cwAll;
        if (!wpf[prod]) wpf[prod] = {};
        wpf[prod]["Closed Won"] = cw;
      }
      wpfByRep.set(r as unknown as object, wpf);
    });

    const stageDefaults = ((data as any)?.stageDefaultProbabilities || {}) as Record<string, number>;
    // Override the (now-unused) sciWeightedTotal so existing code reading it gets the new value.
    sciWeightedTotal = sciActiveWeighted;
    scirWeightedTotal = scirActiveWeighted;
    overageWeightedTotal = overageActiveWeighted;

    const funnelStages = [
      "Discovery", "Demo Scheduled", "Proposal/Negotiation", 
      "Paperwork Sent", "Awaiting Payment",
      "Closed Won", "Closed Lost"
    ];

    const funnelChartData: StackedBarEntry[] = funnelStages.map(stage => {
      const entry: StackedBarEntry = {
        name: stage,
        total: funnelSums[stage] || 0,
        oppCount: funnelCountSums[stage] || 0,
      };
      for (const prod of displayProducts) {
        entry[prod] = funnelProductSums[stage]?.[prod] || 0;
      }
      return entry;
    });

    // Task #476: Gross funnel chart data (positives-only). The Pipeline Funnel
    // card in G&R Channel exposes a Gross/Net toggle; in Gross it sources from
    // the server's positives-only (stdMrr > 0) aggregates so negative-MRR opps
    // are excluded from stage MRR totals, per-product stacked bars AND the
    // per-stage opp count. Mirrors the net funnel accumulation above but reads
    // funnelAdded / productFunnelAdded / *OppIdsAdded.
    const funnelGrossSums: Record<string, number> = {};
    const funnelGrossProductSums: Record<string, Record<string, number>> = {};
    const funnelGrossCountSums: Record<string, number> = {};
    for (const stage of funnelStages) {
      funnelGrossSums[stage] = 0;
      funnelGrossProductSums[stage] = {};
      funnelGrossCountSums[stage] = 0;
    }
    reps.forEach(r => {
      const fAdded = (r as any).funnelAdded as Record<string, number> | undefined;
      const pfAdded = (r as any).productFunnelAdded as Record<string, Record<string, number>> | undefined;
      const fCountAdded = (r as any).funnelOppCountAdded as Record<string, number> | undefined;
      const pfIdsAdded = (r as any).productFunnelOppIdsAdded as Record<string, Record<string, string[]>> | undefined;

      if (activeProducts.length > 0) {
        for (const prod of activeProducts) {
          const stages = pfAdded?.[prod] || {};
          for (const stage of funnelStages) {
            const val = stages[stage] || 0;
            funnelGrossSums[stage] += val;
            funnelGrossProductSums[stage][prod] = (funnelGrossProductSums[stage][prod] || 0) + val;
          }
        }
        // Distinct opp counts per stage: union positives-only opp IDs across
        // the selected products (an opp in 2+ selected products counts once).
        for (const stage of funnelStages) {
          const union = new Set<string>();
          for (const prod of activeProducts) {
            for (const id of (pfIdsAdded?.[prod]?.[stage] || [])) union.add(id);
          }
          funnelGrossCountSums[stage] += union.size;
        }
      } else {
        for (const stage of funnelStages) {
          funnelGrossSums[stage] += fAdded?.[stage] || 0;
          funnelGrossCountSums[stage] += fCountAdded?.[stage] || 0;
        }
      }
    });

    const funnelChartDataGross: StackedBarEntry[] = funnelStages.map(stage => {
      const entry: StackedBarEntry = {
        name: stage,
        total: funnelGrossSums[stage] || 0,
        oppCount: funnelGrossCountSums[stage] || 0,
      };
      for (const prod of displayProducts) {
        entry[prod] = funnelGrossProductSums[stage]?.[prod] || 0;
      }
      return entry;
    });

    let totalWeighted = 0;
    const weightedStages = ["Discovery", "Demo Scheduled", "Proposal/Negotiation", "Paperwork Sent", "Awaiting Payment", "Closed Won"];
    const weightedData = weightedStages.map(stage => {
      const val = funnelSums[stage] || 0;
      const wVal = weightedActiveSums[stage] || 0;
      totalWeighted += wVal;
      const defaultPct = stageDefaults[stage] ?? (stage === "Closed Won" ? 100 : 0);
      const cnt = probCountActive[stage] || 0;
      const currentPct = cnt > 0 ? (probSumActive[stage] / cnt) : defaultPct;
      return { stage, val, wVal, defaultPct, currentPct };
    });

    // Sum scheduled mods per product across the filtered reps. Mirrors the
    // unconditional per-product accumulation used for productMrrForQuota so the
    // downstream Showcase/SCI gating in allProductQuotas can apply consistently.
    const productModsForForecast: Record<string, number> = {};
    const productModsWeightedForForecast: Record<string, number> = {};
    // Task #116 follow-up: per-product scheduled-mod count, used by the
    // Churn Forecast popup to display the count of underlying mods.
    const productModsCountForForecast: Record<string, number> = {};
    // Task #157: per-product × per-churn-type breakdowns. Drives the
    // per-Churn-Type rows in the GNR Churn Forecast popup. Excludes ME.
    const productChurnTypeModsForForecast: Record<string, Record<string, number>> = {};
    const productChurnTypeModsWeightedForForecast: Record<string, Record<string, number>> = {};
    const productChurnTypeModsCountForForecast: Record<string, Record<string, number>> = {};
    reps.forEach(r => {
      const rm = r as RepPipelineWithMods;
      const pm = rm.productMods;
      const pmw = rm.productModsWeighted;
      const pmc = rm.productModsCount;
      const pct = rm.productChurnTypeMods;
      const pctw = rm.productChurnTypeModsWeighted;
      const pctc = rm.productChurnTypeModsCount;
      if (pm) {
        for (const [prod, val] of Object.entries(pm)) {
          if (prod === "No Product Selected") continue;
          productModsForForecast[prod] = (productModsForForecast[prod] || 0) + (val || 0);
        }
      }
      if (pmw) {
        for (const [prod, val] of Object.entries(pmw)) {
          if (prod === "No Product Selected") continue;
          productModsWeightedForForecast[prod] = (productModsWeightedForForecast[prod] || 0) + (val || 0);
        }
      }
      if (pmc) {
        for (const [prod, val] of Object.entries(pmc)) {
          if (prod === "No Product Selected") continue;
          productModsCountForForecast[prod] = (productModsCountForForecast[prod] || 0) + (val || 0);
        }
      }
      if (pct) {
        for (const [prod, byType] of Object.entries(pct)) {
          if (prod === "No Product Selected") continue;
          if (!productChurnTypeModsForForecast[prod]) productChurnTypeModsForForecast[prod] = {};
          for (const [ct, val] of Object.entries(byType)) {
            productChurnTypeModsForForecast[prod][ct] = (productChurnTypeModsForForecast[prod][ct] || 0) + (val || 0);
          }
        }
      }
      if (pctw) {
        for (const [prod, byType] of Object.entries(pctw)) {
          if (prod === "No Product Selected") continue;
          if (!productChurnTypeModsWeightedForForecast[prod]) productChurnTypeModsWeightedForForecast[prod] = {};
          for (const [ct, val] of Object.entries(byType)) {
            productChurnTypeModsWeightedForForecast[prod][ct] = (productChurnTypeModsWeightedForForecast[prod][ct] || 0) + (val || 0);
          }
        }
      }
      if (pctc) {
        for (const [prod, byType] of Object.entries(pctc)) {
          if (prod === "No Product Selected") continue;
          if (!productChurnTypeModsCountForForecast[prod]) productChurnTypeModsCountForForecast[prod] = {};
          for (const [ct, val] of Object.entries(byType)) {
            productChurnTypeModsCountForForecast[prod][ct] = (productChurnTypeModsCountForForecast[prod][ct] || 0) + (val || 0);
          }
        }
      }
    });
    const totalMods = Object.values(productModsForForecast).reduce((s, v) => s + v, 0);
    // Scheduled mods default probability is now manager-editable; falls back
    // to 100% if no override has been saved.
    const modsDefaultPct = stageDefaults["Scheduled Mods"] ?? 100;
    const modsWeight = modsDefaultPct / 100;

    if (subtractMods) {
      totalWeighted -= totalMods * modsWeight;
    }

    const productWeighted: Record<string, number> = {};
    if (selectedProducts.length > 0) {
      for (const prod of selectedProducts) {
        let pw = 0;
        for (const stage of weightedStages) {
          pw += weightedActiveProductSums[stage]?.[prod] || 0;
        }
        if (subtractMods) {
          pw -= (productModsForForecast[prod] || 0) * modsWeight;
        }
        productWeighted[prod] = pw;
      }
    }

    // Filter gating for the Showcase quota row breakdown:
    //   - no filter: include both Showcase and SCI
    //   - filter contains "Showcase": include Showcase portion
    //   - filter contains "Showcase Incremental": include SCI portion
    // When SCI is selected but Showcase is NOT, the row should show SCI only
    // (no Showcase MRR contribution to row, total quota, or weighted pipeline).
    const showcaseSelected = selectedProducts.length === 0 || selectedProducts.includes("Showcase");
    // SCI, SCI-R, and Overage are INDEPENDENTLY filterable. Each is "selected"
    // only when the filter is empty (everything) or its own product key is
    // present — it is NOT force-included just because the base "Showcase" chip
    // is selected. Selecting the Showcase chip still lights up all four parts
    // because toggleProductFilter("Showcase") bundles SC + SCI + SCI-R + OV
    // into the filter set; but the user can uncheck any of them individually.
    // All still roll up into the single Showcase quota row (see
    // activeProductSet expansion below).
    const sciSelected = selectedProducts.length === 0
      || selectedProducts.includes("Showcase Incremental");
    const scirSelected = selectedProducts.length === 0
      || selectedProducts.includes("Showcase Incremental - Re/Max");
    const overageSelected = selectedProducts.length === 0
      || selectedProducts.includes("Overage");

    // Build a stable per-month order (for tooltips) from the slot list so the
    // breakdown rows render chronologically regardless of insertion order.
    const monthOrder = monthSlots.map(s => s.ymKey);
    const breakdownToList = (bag: Record<string, ProrationBreakdownEntry>): ProrationBreakdownEntry[] => {
      const out: ProrationBreakdownEntry[] = [];
      for (const ym of monthOrder) {
        const e = bag[ym];
        if (e && (e.monthlyGoal !== 0 || e.closed !== 0 || e.contribution !== 0)) out.push(e);
      }
      return out;
    };
    type ProductQuotaRow = {
      product: typeof ALL_PRODUCTS[number];
      goal: number;
      mrr: number;
      weighted: number;
      breakdown: { showcase: number; sci: number; scir: number; overage: number } | null;
      goalBreakdown: ProrationBreakdownEntry[];
      // Task #162: also expose the per-rep floored sum so the per-rep
      // drilldown can show a reconciliation footnote when the displayed
      // (aggregate-floored) goal is smaller than the sum of per-rep
      // floored goals (overperformer overage).
      goalPerRepSum: number;
      // Task #202 follow-up: canonical month-to-date "added" Closed Won
      // for this product across reps (Showcase rolls SCI in to match the
      // showcaseGoal+SCI quota convention). Used by the Acq proration
      // popup as `overrideClosed` so its Closed/Remaining/catch-up math
      // reconciles to the BAN goal's windowed-remaining formula
      // (which already sources from productCwMtd.added).
      mtdClosed: number;
    };
    // Task #162: parallel Remaining-mode goals (used by the Forecast card,
    // which is hard-wired to Remaining regardless of the Quota Mode toggle).
    // We re-derive these from the same breakdown bag — even in Pacing mode
    // the bag still records the per-month closed-to-date subtractable, so
    // floorRemainingAlways gives the canonical Remaining value.
    const floorRemainingAlways = (bag: Record<string, ProrationBreakdownEntry>): number => {
      if (!prorateQuota) return 0;
      let total = 0;
      for (const e of Object.values(bag)) {
        // Task #168: signed sum — overperformers contribute negative remainders.
        total += e.goalInWindow - e.closed;
      }
      return total;
    };
    // Task #162: floor-at-aggregate Remaining-mode override.
    // For each product (and Showcase rolling SCI in), recompute productGoals
    // from the breakdown bag using floorRemainingFromBag — which floors
    // monthlyGoal − closed at the aggregate level instead of per-rep. In
    // pacing mode this is a no-op (sum of per-rep contributions equals the
    // bag-derived total). In remaining mode this is the fix for the
    // overperformer-inflation bug (e.g. Showcase $164.5K → $156.25K).
    // We snapshot the per-rep-floored sum first so the drilldown footnote
    // can highlight the reconciliation gap.
    const productGoalsPerRepSum: Record<string, number> = {};
    if (prorateQuota) {
      for (const prod of ALL_PRODUCTS) {
        productGoalsPerRepSum[prod] = productGoals[prod] || 0;
      }
      // Pre-merge SCI bag into a synthetic Showcase bag so the floor pass
      // applies AFTER SCI rollup (matches the goalBreakdown the tooltip
      // shows for Showcase). For non-Showcase products use the bag as-is.
      const aggBagFor = (prod: string): Record<string, ProrationBreakdownEntry> => {
        const base = productBreakdownByMonth[prod] || {};
        if (prod !== "Showcase") return base;
        const sciBag = productBreakdownByMonth["Showcase Incremental"];
        const scirBag = productBreakdownByMonth["Showcase Incremental - Re/Max"];
        const overageBag = productBreakdownByMonth["Overage"];
        if (!sciBag && !scirBag && !overageBag) return base;
        const merged: Record<string, ProrationBreakdownEntry> = {};
        for (const [k, v] of Object.entries(base)) merged[k] = { ...v, closedByDay: { ...(v.closedByDay || {}) } };
        const mergeIn = (src: Record<string, ProrationBreakdownEntry> | undefined) => {
          if (!src) return;
          for (const [k, v] of Object.entries(src)) {
            const m = merged[k];
            if (m) {
              m.monthlyGoal += v.monthlyGoal;
              m.goalInWindow += v.goalInWindow;
              m.closed += v.closed;
              m.contribution += v.contribution;
              for (const [dStr, dv] of Object.entries(v.closedByDay || {})) {
                const dNum = parseInt(dStr, 10);
                m.closedByDay[dNum] = (m.closedByDay[dNum] || 0) + dv;
              }
            } else {
              merged[k] = { ...v, closedByDay: { ...(v.closedByDay || {}) } };
            }
          }
        };
        mergeIn(sciBag);
        mergeIn(scirBag);
        mergeIn(overageBag);
        return merged;
      };
      for (const prod of ALL_PRODUCTS) {
        productGoals[prod] = floorRemainingFromBag(aggBagFor(prod));
      }
      // Task #203: windowed-remaining override — recompute at the ORG level
      // so the BAN reconciles to (Σmonthly − Σmtd)/bizdaysRem × windowBizdays
      // shown by the popup. The per-rep accumulation in prorateNetProduct
      // (productGoalsWindowed) sums max(0, repMonthly − repMtd)/bizdays ×
      // window per rep, which clips overperformers to 0 and inflates the
      // total above the popup's CLOSED/REMAINING math. Stripping that floor
      // at the aggregate (Task #168 spirit) keeps card BAN ↔ popup footer
      // consistent for entire-org scopes.
      if (isWindowedRemaining && wr) {
        const todayWa = getTodayPST();
        const wyA = todayWa.getFullYear();
        const wmA = todayWa.getMonth();
        const currentYmA = `${wyA}-${String(wmA + 1).padStart(2, '0')}`;
        const monthEndA = new Date(wyA, wmA + 1, 0);
        let bizdaysRemA = 0;
        {
          const dA = new Date(wyA, wmA, wr.anchorDay);
          while (dA <= monthEndA) {
            if (isBusinessDay(dA, holidaySet)) bizdaysRemA++;
            dA.setDate(dA.getDate() + 1);
          }
        }
        // Org-level raw monthly goal per product (current ym). showcaseGoal
        // already encodes the combined SC+SCI quota convention, so SCI gets
        // no separate monthly goal; only its MTD added rolls into Showcase.
        const productMonthlyGoalAcq: Record<string, number> = {};
        for (const r of reps) {
          for (const prod of ALL_PRODUCTS) {
            productMonthlyGoalAcq[prod] = (productMonthlyGoalAcq[prod] || 0) + netGoalForYm(r, prod, currentYmA);
          }
        }
        // Org-level MTD added per product. Showcase rolls SCI in — SCI is
        // NOT in ALL_PRODUCTS, so it's summed explicitly under its own key
        // and folded into the Showcase row below.
        const productMtdAddedAcq: Record<string, number> = {};
        for (const r of reps) {
          const pcMtdR = (r as any).productCwMtd as Record<string, { added?: number }> | undefined;
          if (!pcMtdR) continue;
          for (const prod of ALL_PRODUCTS) {
            productMtdAddedAcq[prod] = (productMtdAddedAcq[prod] || 0) + (pcMtdR[prod]?.added || 0);
          }
          productMtdAddedAcq["Showcase Incremental"] =
            (productMtdAddedAcq["Showcase Incremental"] || 0) + (pcMtdR["Showcase Incremental"]?.added || 0);
          productMtdAddedAcq["Showcase Incremental - Re/Max"] =
            (productMtdAddedAcq["Showcase Incremental - Re/Max"] || 0) + (pcMtdR["Showcase Incremental - Re/Max"]?.added || 0);
          productMtdAddedAcq["Overage"] =
            (productMtdAddedAcq["Overage"] || 0) + (pcMtdR["Overage"]?.added || 0);
        }
        for (const prod of ALL_PRODUCTS) {
          const monthly = productMonthlyGoalAcq[prod] || 0;
          let mtd = productMtdAddedAcq[prod] || 0;
          if (prod === "Showcase") mtd += (productMtdAddedAcq["Showcase Incremental"] || 0) + (productMtdAddedAcq["Showcase Incremental - Re/Max"] || 0) + (productMtdAddedAcq["Overage"] || 0);
          const remaining = Math.max(0, monthly - mtd);
          const windowedOrg = bizdaysRemA > 0 ? (remaining / bizdaysRemA) * wr.windowBizdays : 0;
          productGoalsWindowed[prod] = windowedOrg;
          productGoals[prod] = windowedOrg;
        }
      }
    }
    // Always-Remaining productGoals (forecast hard-wires to this).
    const productGoalsRemaining: Record<string, number> = {};
    if (prorateQuota) {
      for (const prod of ALL_PRODUCTS) {
        const base = productBreakdownByMonth[prod] || {};
        let bag = base;
        if (prod === "Showcase") {
          // Merge SCI + SCI-R sub-buckets into the Showcase bag (both roll
          // into Showcase quota attainment per Task #204).
          const mergeInBag = (src: Record<string, ProrationBreakdownEntry> | undefined, into: Record<string, ProrationBreakdownEntry>) => {
            if (!src) return into;
            for (const [k, v] of Object.entries(src)) {
              const m = into[k];
              if (m) {
                m.monthlyGoal += v.monthlyGoal;
                m.goalInWindow += v.goalInWindow;
                m.closed += v.closed;
                m.contribution += v.contribution;
                for (const [dStr, dv] of Object.entries(v.closedByDay || {})) {
                  const dNum = parseInt(dStr, 10);
                  m.closedByDay[dNum] = (m.closedByDay[dNum] || 0) + dv;
                }
              } else {
                into[k] = { ...v, closedByDay: { ...(v.closedByDay || {}) } };
              }
            }
            return into;
          };
          const sciBag = productBreakdownByMonth["Showcase Incremental"];
          const scirBag = productBreakdownByMonth["Showcase Incremental - Re/Max"];
          const overageBag = productBreakdownByMonth["Overage"];
          if (sciBag || scirBag || overageBag) {
            const merged: Record<string, ProrationBreakdownEntry> = {};
            for (const [k, v] of Object.entries(base)) merged[k] = { ...v, closedByDay: { ...(v.closedByDay || {}) } };
            mergeInBag(sciBag, merged);
            mergeInBag(scirBag, merged);
            mergeInBag(overageBag, merged);
            bag = merged;
          }
        }
        productGoalsRemaining[prod] = floorRemainingAlways(bag);
      }
    } else {
      for (const prod of ALL_PRODUCTS) productGoalsRemaining[prod] = productGoals[prod] || 0;
    }
    // Task #168: windowed-remaining also updates the Forecast card's always-remaining goals.
    if (isWindowedRemaining) {
      for (const prod of ALL_PRODUCTS) {
        productGoalsRemaining[prod] = productGoalsWindowed[prod] || 0;
      }
    }
    // Per-product MTD "added" Closed Won across all reps. Showcase rolls
    // SCI in so the Showcase row's mtdClosed mirrors the showcaseGoal
    // (combined SC+SCI) convention used everywhere else. Sourced from
    // productCwMtd — the same canonical bucket the windowed-remaining
    // goal formula uses (see prorateNetProduct line 2478).
    const productMtdClosedAcq: Record<string, number> = {};
    for (const r of reps) {
      const pcMtdR = (r as any).productCwMtd as Record<string, { added?: number }> | undefined;
      if (!pcMtdR) continue;
      for (const prod of ALL_PRODUCTS) {
        productMtdClosedAcq[prod] = (productMtdClosedAcq[prod] || 0) + (pcMtdR[prod]?.added || 0);
      }
      // SCI isn't in ALL_PRODUCTS — sum it explicitly so the Showcase row's
      // mtdClosed (= SC + SCI) and downstream popup override resolve correctly.
      productMtdClosedAcq["Showcase Incremental"] =
        (productMtdClosedAcq["Showcase Incremental"] || 0) + (pcMtdR["Showcase Incremental"]?.added || 0);
      productMtdClosedAcq["Showcase Incremental - Re/Max"] =
        (productMtdClosedAcq["Showcase Incremental - Re/Max"] || 0) + (pcMtdR["Showcase Incremental - Re/Max"]?.added || 0);
      productMtdClosedAcq["Overage"] =
        (productMtdClosedAcq["Overage"] || 0) + (pcMtdR["Overage"]?.added || 0);
    }
    const allProductQuotas: ProductQuotaRow[] = ALL_PRODUCTS.map((prod): ProductQuotaRow => {
      let pw = 0;
      for (const stage of weightedStages) {
        pw += weightedActiveProductSums[stage]?.[prod] || 0;
      }
      // Showcase row's mtdClosed combines SC + SCI + SCI-R + OV to mirror the
      // combined showcaseGoal quota convention.
      const mtdClosed = prod === "Showcase"
        ? (productMtdClosedAcq["Showcase"] || 0) + (productMtdClosedAcq["Showcase Incremental"] || 0) + (productMtdClosedAcq["Showcase Incremental - Re/Max"] || 0) + (productMtdClosedAcq["Overage"] || 0)
        : (productMtdClosedAcq[prod] || 0);
      // Per-product proration breakdown — used by the hover tooltip on
      // pq.goal. For Showcase we merge the SCI bag in (SCI rolls up into
      // Showcase quota attainment) so the tooltip totals reconcile with
      // the displayed pq.goal.
      const productBag = productBreakdownByMonth[prod] || {};
      let goalBreakdown: ProrationBreakdownEntry[] = breakdownToList(productBag);
      if (prod === "Showcase") {
        const sciBag = productBreakdownByMonth["Showcase Incremental"];
        const scirBag = productBreakdownByMonth["Showcase Incremental - Re/Max"];
        const overageBag = productBreakdownByMonth["Overage"];
        if (sciBag || scirBag || overageBag) {
          const merged: Record<string, ProrationBreakdownEntry> = {};
          for (const e of breakdownToList(productBag)) {
            merged[e.ymKey] = { ...e, closedByDay: { ...(e.closedByDay || {}) } };
          }
          const mergeEntries = (src: Record<string, ProrationBreakdownEntry> | undefined) => {
            if (!src) return;
            for (const e of breakdownToList(src)) {
              const m = merged[e.ymKey];
              if (m) {
                m.monthlyGoal += e.monthlyGoal;
                m.goalInWindow += e.goalInWindow;
                m.closed += e.closed;
                m.contribution += e.contribution;
                for (const [dStr, dv] of Object.entries(e.closedByDay || {})) {
                  const dNum = parseInt(dStr, 10);
                  m.closedByDay[dNum] = (m.closedByDay[dNum] || 0) + dv;
                }
              } else {
                merged[e.ymKey] = { ...e, closedByDay: { ...(e.closedByDay || {}) } };
              }
            }
          };
          mergeEntries(sciBag);
          mergeEntries(scirBag);
          mergeEntries(overageBag);
          goalBreakdown = breakdownToList(merged);
        }
      }
      const perRepSum = productGoalsPerRepSum[prod] || (productGoals[prod] || 0);
      if (prod === "Showcase") {
        const showcasePart = showcaseSelected ? (productMrrForQuota["Showcase"] || 0) : 0;
        const sciPart = sciSelected ? sciMrrForQuotaTotal : 0;
        const scirPart = scirSelected ? scirMrrForQuotaTotal : 0;
        const overagePart = overageSelected ? overageMrrForQuotaTotal : 0;
        const showcaseWeightedPart = showcaseSelected ? pw : 0;
        const sciWeightedPart = sciSelected ? sciWeightedTotal : 0;
        const scirWeightedPart = scirSelected ? scirWeightedTotal : 0;
        const overageWeightedPart = overageSelected ? overageWeightedTotal : 0;
        let weighted = showcaseWeightedPart + sciWeightedPart + scirWeightedPart + overageWeightedPart;
        if (subtractMods) {
          const showcaseMods = showcaseSelected ? (productModsForForecast["Showcase"] || 0) : 0;
          const sciMods = sciSelected ? (productModsForForecast["Showcase Incremental"] || 0) : 0;
          const scirMods = scirSelected ? (productModsForForecast["Showcase Incremental - Re/Max"] || 0) : 0;
          const overageMods = overageSelected ? (productModsForForecast["Overage"] || 0) : 0;
          weighted -= (showcaseMods + sciMods + scirMods + overageMods) * modsWeight;
        }
        return {
          product: prod,
          goal: productGoals[prod] || 0,
          mrr: showcasePart + sciPart + scirPart + overagePart,
          weighted,
          breakdown: { showcase: showcasePart, sci: sciPart, scir: scirPart, overage: overagePart },
          goalBreakdown,
          goalPerRepSum: perRepSum,
          mtdClosed,
        };
      }
      let weighted = pw;
      if (subtractMods) {
        weighted -= (productModsForForecast[prod] || 0) * modsWeight;
      }
      return {
        product: prod,
        goal: productGoals[prod] || 0,
        mrr: productMrrForQuota[prod] || 0,
        weighted,
        breakdown: null,
        goalBreakdown,
        goalPerRepSum: perRepSum,
        mtdClosed,
      };
    });

    // When Showcase Incremental / Overage is in the active filter, also light
    // up the Showcase quota row (SCI/OV roll up into Showcase quota attainment).
    const activeProductSet = new Set<string>(selectedProducts.length > 0 ? selectedProducts : ALL_PRODUCTS as unknown as string[]);
    if (activeProductSet.has("Showcase Incremental")) activeProductSet.add("Showcase");
    if (activeProductSet.has("Showcase Incremental - Re/Max")) activeProductSet.add("Showcase");
    if (activeProductSet.has("Overage")) activeProductSet.add("Showcase");

    const activeTotalGoal = allProductQuotas.filter(p => activeProductSet.has(p.product)).reduce((s, p) => s + p.goal, 0);
    const activeTotalMrrForQuota = allProductQuotas.filter(p => activeProductSet.has(p.product)).reduce((s, p) => s + p.mrr, 0);
    // Task #162: Forecast card hard-wires to Remaining mode regardless of
    // the Quota Mode toggle (forecast asks "given remaining-to-hit, what
    // win rate is required" — pacing semantics don't apply to forecasting).
    const activeTotalGoalRemaining = ALL_PRODUCTS.reduce((s, p) => activeProductSet.has(p) ? s + (productGoalsRemaining[p] || 0) : s, 0);
    const activeTotalGoalPerRepSum = allProductQuotas.filter(p => activeProductSet.has(p.product)).reduce((s, p) => s + p.goalPerRepSum, 0);
    const activeTotalWeighted = allProductQuotas.filter(p => activeProductSet.has(p.product)).reduce((s, p) => s + p.weighted, 0);

    // Active-filter-aware mods total (mirrors the Showcase/SCI gating used in
    // allProductQuotas) so the Scheduled Mods row in the assumptions popup
    // reflects exactly what's being subtracted from the displayed Total Weighted.
    let activeTotalMods = 0;
    for (const prod of activeProductSet) {
      if (prod === "Showcase") {
        const sm = showcaseSelected ? (productModsForForecast["Showcase"] || 0) : 0;
        const sci = sciSelected ? (productModsForForecast["Showcase Incremental"] || 0) : 0;
        const scir = scirSelected ? (productModsForForecast["Showcase Incremental - Re/Max"] || 0) : 0;
        const ov = overageSelected ? (productModsForForecast["Overage"] || 0) : 0;
        activeTotalMods += sm + sci + scir + ov;
      } else if (prod === "Showcase Incremental" || prod === "Showcase Incremental - Re/Max" || prod === "Overage") {
        // SCI/SCI-R/OV roll into Showcase row above; skip to avoid double-counting.
        continue;
      } else {
        activeTotalMods += productModsForForecast[prod] || 0;
      }
    }

    // Trigger gross MRR Added/Churn breakout when in MRR Added mode AND group is G&R
    // OR My Team OR Me (the latter two are user-scoped and may belong to either group;
    // gross mode is the user's choice when they explicitly select Added).
    // Task #448: the gross per-product split now powers the G&R Net gross
    // sub-views (Both/MRR/Churn) as well as the legacy Gross MRR mode. Compute
    // it whenever G&R Net is active for an aggregate preset — independent of the
    // sub-view — so the toggle stays visible and the user can switch back from
    // Net. (isAdded is retained for the legacy path but is always false now.)
    const isGrossGnr = (isAdded || mrrMode === "gnrNet") && (groupPreset === "G&R" || groupPreset === "My Team" || groupPreset === "Me");
    const grossProductSplit = isGrossGnr ? (() => {
      const mrrAddedGoals: Record<string, number> = {};
      const churnGoals: Record<string, number> = {};
      // Windowed-remaining variants: when isWindowedRemaining (Remaining
      // quota mode + intra-current-month window), each rep contributes
      // (monthlyGoal − MTD-actual) / bizdays-left-in-month × window-bizdays
      // — the same formula prorateNetProduct uses for net goals. Used to
      // override mrrAddedGoals/churnGoals below so the GnR gross goal
      // cards reconcile to user's hand calc instead of the legacy
      // pacingFactor-only scaling. Showcase rolls SCI's MTD in too, to
      // mirror Showcase+SCI display gating used everywhere else.
      const mrrAddedGoalsWindowed: Record<string, number> = {};
      const churnGoalsWindowed: Record<string, number> = {};
      const mrrAddedActual: Record<string, number> = {};
      const churnActual: Record<string, number> = {};
      // SCI is tracked separately so it can roll into the Showcase row
      // and respect the same showcaseSelected/sciSelected gating used elsewhere.
      let sciMrrAdded = 0;
      let sciChurn = 0;
      let scirMrrAdded = 0;
      let scirChurn = 0;
      let overageMrrAdded = 0;
      let overageChurn = 0;
      // Proration-mode "closed" totals: ALL Closed Won in the current
      // calendar month (MTD), independent of the timeframe filter. Used
      // by the proration popup so its Closed / Remaining / catch-up math
      // counts everything booked this month.
      const mrrAddedMtd: Record<string, number> = {};
      const churnMtd: Record<string, number> = {};
      let sciMrrAddedMtd = 0;
      let sciChurnMtd = 0;
      let scirMrrAddedMtd = 0;
      let scirChurnMtd = 0;
      let overageMrrAddedMtd = 0;
      let overageChurnMtd = 0;

      reps.forEach(r => {
        // Prorate the raw monthly MRR-Added and Churn goals by the same
        // business-day factor used everywhere else (productGoals,
        // per-rep mrrAddedGoal/churnGoal in forecastRepBreakdowns), so the
        // GNR Both-mode Quota and Forecast cards' per-product goal totals
        // match their by-rep drilldowns when proration is on.
        // Data-driven per-product accumulation over the canonical product
        // list. Products without goal data contribute 0 (gnrGoalFor → 0), so
        // this is byte-identical to the prior Showcase+MBP-only sum today and
        // picks up new products automatically once finance supplies their data.
        for (const prod of ALL_PRODUCTS) {
          mrrAddedGoals[prod] = (mrrAddedGoals[prod] || 0) + prorateGross(gnrGoalFor(r, prod, "mrrAdded"));
          churnGoals[prod] = (churnGoals[prod] || 0) + prorateGross(gnrGoalFor(r, prod, "churn"));
        }

        const pfAdded = (r as any).productFunnelAdded as Record<string, Record<string, number>> | undefined;
        const pc = (r as any).productChurn as Record<string, number> | undefined;
        const pcMtdRep = (r as any).productCwMtd as Record<string, { added?: number; churn?: number }> | undefined;

        if (isWindowedRemaining) {
          // Per-rep windowed-remaining contribution for gross MRR-Added
          // and Churn goals, mirroring the prorateNetProduct branch for
          // net goals. Sources MTD actuals from productCwMtd (same
          // canonical month-to-date bucket used by mrrAddedMtd display).
          // Showcase rolls SCI MTD in — consistent with the Showcase row
          // gating used for actuals/booked everywhere else in this view.
          const churnKey = "churn" as const;
          // Showcase rolls its parts' (SCI / SCI-R / Overage) MTD actuals into
          // its own bucket; every other canonical product uses its own MTD.
          const scAddedMtdRep = (pcMtdRep?.["Showcase"]?.added || 0)
            + (pcMtdRep?.["Showcase Incremental"]?.added || 0)
            + (pcMtdRep?.["Showcase Incremental - Re/Max"]?.added || 0)
            + (pcMtdRep?.["Overage"]?.added || 0);
          const scChurnMtdRep = (pcMtdRep?.["Showcase"]?.[churnKey] || 0)
            + (pcMtdRep?.["Showcase Incremental"]?.[churnKey] || 0)
            + (pcMtdRep?.["Showcase Incremental - Re/Max"]?.[churnKey] || 0)
            + (pcMtdRep?.["Overage"]?.[churnKey] || 0);
          for (const prod of ALL_PRODUCTS) {
            const monthlyAdded = gnrGoalFor(r, prod, "mrrAdded");
            const monthlyChurn = gnrGoalFor(r, prod, "churn");
            const addedMtdRep = prod === "Showcase" ? scAddedMtdRep : (pcMtdRep?.[prod]?.added || 0);
            const churnMtdRep = prod === "Showcase" ? scChurnMtdRep : (pcMtdRep?.[prod]?.[churnKey] || 0);
            mrrAddedGoalsWindowed[prod] = (mrrAddedGoalsWindowed[prod] || 0) +
              computeWindowedContribFromClosed(() => monthlyAdded, addedMtdRep);
            churnGoalsWindowed[prod] = (churnGoalsWindowed[prod] || 0) +
              computeWindowedContribFromClosed(() => monthlyChurn, churnMtdRep);
          }
        }
        const mtdChurnKey = "churn" as const;
        for (const prod of ALL_PRODUCTS) {
          const addedCW = pfAdded?.[prod]?.["Closed Won"] || 0;
          mrrAddedActual[prod] = (mrrAddedActual[prod] || 0) + addedCW;
          const addedMtd = pcMtdRep?.[prod]?.added || 0;
          mrrAddedMtd[prod] = (mrrAddedMtd[prod] || 0) + addedMtd;
          const churnVal = pc?.[prod] || 0;
          if (churnVal !== 0) {
            churnActual[prod] = (churnActual[prod] || 0) - churnVal;
          }
          // Canonical MTD churn (sign-flipped to match churnActual's
          // negative-rendered convention) so the popup's Closed column can
          // override window-filtered values with MTD when isWindowedRemaining.
          const churnMtdVal = pcMtdRep?.[prod]?.[mtdChurnKey] || 0;
          if (churnMtdVal !== 0) {
            churnMtd[prod] = (churnMtd[prod] || 0) - churnMtdVal;
          }
        }
        sciMrrAdded += pfAdded?.["Showcase Incremental"]?.["Closed Won"] || 0;
        sciMrrAddedMtd += pcMtdRep?.["Showcase Incremental"]?.added || 0;
        sciChurn += pc?.["Showcase Incremental"] || 0;
        sciChurnMtd += pcMtdRep?.["Showcase Incremental"]?.[mtdChurnKey] || 0;
        scirMrrAdded += pfAdded?.["Showcase Incremental - Re/Max"]?.["Closed Won"] || 0;
        scirMrrAddedMtd += pcMtdRep?.["Showcase Incremental - Re/Max"]?.added || 0;
        scirChurn += pc?.["Showcase Incremental - Re/Max"] || 0;
        scirChurnMtd += pcMtdRep?.["Showcase Incremental - Re/Max"]?.[mtdChurnKey] || 0;
        overageMrrAdded += pfAdded?.["Overage"]?.["Closed Won"] || 0;
        overageMrrAddedMtd += pcMtdRep?.["Overage"]?.added || 0;
        overageChurn += pc?.["Overage"] || 0;
        overageChurnMtd += pcMtdRep?.["Overage"]?.[mtdChurnKey] || 0;
      });

      // Task #203: windowed-remaining override — recompute at the ORG level
      // (Σmonthly − Σmtd)/bizdaysRem × windowBizdays so the per-product card
      // BAN reconciles to the popup's CLOSED/REMAINING math for entire-org
      // scopes. The per-rep accumulation above (mrrAddedGoalsWindowed /
      // churnGoalsWindowed) clips overperformers to 0 and inflates the sum;
      // stripping the floor at the aggregate matches the Task #168 spirit
      // applied here to GnR MRR Added and GnR Churn alike.
      if (isWindowedRemaining && wr) {
        const todayWg = getTodayPST();
        const wyG = todayWg.getFullYear();
        const wmG = todayWg.getMonth();
        const monthEndG = new Date(wyG, wmG + 1, 0);
        let bizdaysRemG = 0;
        {
          const dG = new Date(wyG, wmG, wr.anchorDay);
          while (dG <= monthEndG) {
            if (isBusinessDay(dG, holidaySet)) bizdaysRemG++;
            dG.setDate(dG.getDate() + 1);
          }
        }
        if (bizdaysRemG > 0) {
          const monthlyAddedTotal: Record<string, number> = {};
          const monthlyChurnTotal: Record<string, number> = {};
          for (const prod of ALL_PRODUCTS) { monthlyAddedTotal[prod] = 0; monthlyChurnTotal[prod] = 0; }
          for (const r of reps) {
            for (const prod of ALL_PRODUCTS) {
              monthlyAddedTotal[prod] += gnrGoalFor(r, prod, "mrrAdded");
              monthlyChurnTotal[prod] += gnrGoalFor(r, prod, "churn");
            }
          }
          // Org MTD for Showcase rolls SCI + OV in (combined quota convention).
          // churnMtd is sign-flipped negative; use magnitudes.
          const compute = (monthly: number, mtd: number) =>
            (Math.max(0, monthly - mtd) / bizdaysRemG) * wr.windowBizdays;
          for (const prod of ALL_PRODUCTS) {
            const addedMtdAll = prod === "Showcase"
              ? (mrrAddedMtd["Showcase"] || 0) + sciMrrAddedMtd + scirMrrAddedMtd + overageMrrAddedMtd
              : (mrrAddedMtd[prod] || 0);
            const churnMtdAll = prod === "Showcase"
              ? Math.abs(churnMtd["Showcase"] || 0) + Math.abs(sciChurnMtd) + Math.abs(scirChurnMtd) + Math.abs(overageChurnMtd)
              : Math.abs(churnMtd[prod] || 0);
            mrrAddedGoals[prod] = compute(monthlyAddedTotal[prod], addedMtdAll);
            churnGoals[prod] = compute(monthlyChurnTotal[prod], churnMtdAll);
          }
        }
      }

      return ALL_PRODUCTS.map(prod => {
        if (prod === "Showcase") {
          const scAdded = mrrAddedActual["Showcase"] || 0;
          const scChurn = churnActual["Showcase"] || 0;
          const scAddedMtd = mrrAddedMtd["Showcase"] || 0;
          const scChurnMtd = churnMtd["Showcase"] || 0;
          const showcasePartAdded = showcaseSelected ? scAdded : 0;
          const sciPartAdded = sciSelected ? sciMrrAdded : 0;
          const scirPartAdded = scirSelected ? scirMrrAdded : 0;
          const overagePartAdded = overageSelected ? overageMrrAdded : 0;
          const showcasePartAddedMtd = showcaseSelected ? scAddedMtd : 0;
          const sciPartAddedMtd = sciSelected ? sciMrrAddedMtd : 0;
          const scirPartAddedMtd = scirSelected ? scirMrrAddedMtd : 0;
          const overagePartAddedMtd = overageSelected ? overageMrrAddedMtd : 0;
          const showcasePartChurn = showcaseSelected ? scChurn : 0;
          const sciPartChurn = sciSelected ? -sciChurn : 0;
          const scirPartChurn = scirSelected ? -scirChurn : 0;
          const overagePartChurn = overageSelected ? -overageChurn : 0;
          const showcasePartChurnMtd = showcaseSelected ? scChurnMtd : 0;
          const sciPartChurnMtd = sciSelected ? -sciChurnMtd : 0;
          const scirPartChurnMtd = scirSelected ? -scirChurnMtd : 0;
          const overagePartChurnMtd = overageSelected ? -overageChurnMtd : 0;
          // Churn forecast booked/weighted come from scheduled mods, mirroring
          // the Showcase+SCI gating used for MRR Added.
          const showcaseModsBooked = showcaseSelected ? (productModsForForecast["Showcase"] || 0) : 0;
          const sciModsBooked = sciSelected ? (productModsForForecast["Showcase Incremental"] || 0) : 0;
          const scirModsBooked = scirSelected ? (productModsForForecast["Showcase Incremental - Re/Max"] || 0) : 0;
          const overageModsBooked = overageSelected ? (productModsForForecast["Overage"] || 0) : 0;
          const showcaseModsWeighted = showcaseSelected ? (productModsWeightedForForecast["Showcase"] || 0) : 0;
          const sciModsWeighted = sciSelected ? (productModsWeightedForForecast["Showcase Incremental"] || 0) : 0;
          const scirModsWeighted = scirSelected ? (productModsWeightedForForecast["Showcase Incremental - Re/Max"] || 0) : 0;
          const overageModsWeighted = overageSelected ? (productModsWeightedForForecast["Overage"] || 0) : 0;
          return {
            product: prod,
            mrrAddedGoal: mrrAddedGoals[prod] || 0,
            churnGoal: churnGoals[prod] || 0,
            mrrAddedActual: showcasePartAdded + sciPartAdded + scirPartAdded + overagePartAdded,
            mrrAddedMtd: showcasePartAddedMtd + sciPartAddedMtd + scirPartAddedMtd + overagePartAddedMtd,
            churnActual: showcasePartChurn + sciPartChurn + scirPartChurn + overagePartChurn,
            churnMtd: showcasePartChurnMtd + sciPartChurnMtd + scirPartChurnMtd + overagePartChurnMtd,
            churnBooked: showcaseModsBooked + sciModsBooked + scirModsBooked + overageModsBooked,
            churnWeighted: showcaseModsWeighted + sciModsWeighted + scirModsWeighted + overageModsWeighted,
            mrrAddedBreakdown: { showcase: showcasePartAdded, sci: sciPartAdded + scirPartAdded + overagePartAdded },
            churnBreakdown: { showcase: showcasePartChurn, sci: sciPartChurn + scirPartChurn + overagePartChurn },
          };
        }
        return {
          product: prod,
          mrrAddedGoal: mrrAddedGoals[prod] || 0,
          churnGoal: churnGoals[prod] || 0,
          mrrAddedActual: mrrAddedActual[prod] || 0,
          mrrAddedMtd: mrrAddedMtd[prod] || 0,
          churnActual: churnActual[prod] || 0,
          churnMtd: churnMtd[prod] || 0,
          churnBooked: productModsForForecast[prod] || 0,
          churnWeighted: productModsWeightedForForecast[prod] || 0,
          mrrAddedBreakdown: null as { showcase: number; sci: number } | null,
          churnBreakdown: null as { showcase: number; sci: number } | null,
        };
      });
    })() : null;

    // Task #182: per-month proration breakdowns for the GnR Goal-card pacing
    // calendar. Sums across reps × selected products (Showcase merges SCI's
    // per-day actuals), using the same pacing/goalInWindow math as `prorate()`
    // — closed=0 (gross goals don't subtract closed in their displayed total)
    // and a custom per-day selector (b.added for MRR Added; b.churn for
    // Churn). Only built when the GnR aggregate
    // gross display is active; null otherwise.
    type GnrGoalBreakdownEntry = {
      ymKey: string;
      monthlyGoal: number;
      goalInWindow: number;
      closed: number;
      factor: number;
      contribution: number;
      bizdaysInMonth: number;
      bizdaysInWindow: number;
      pacingFactor: number;
      isCurrentMonth: boolean;
      isPastMonth: boolean;
      closedByDay: Record<number, number>;
    };
    const buildGnrAggregateBreakdown = (
      monthlyGoalForRep: (r: typeof reps[0]) => number,
      pickPerDay: (b: CwBucket) => number,
      includeShowcase: boolean,
      includeMbp: boolean,
      includeSci: boolean,
      includeScir: boolean,
      includeOverage: boolean,
    ): GnrGoalBreakdownEntry[] => {
      if (!isGrossGnr || !prorateQuota || monthSlots.length === 0) return [];
      const merged: Record<string, GnrGoalBreakdownEntry> = {};
      const ensure = (slot: MonthSlot): GnrGoalBreakdownEntry => {
        let m = merged[slot.ymKey];
        if (!m) {
          m = {
            ymKey: slot.ymKey,
            monthlyGoal: 0,
            goalInWindow: 0,
            closed: 0,
            factor: slot.factor,
            contribution: 0,
            bizdaysInMonth: slot.bizdaysInMonth,
            bizdaysInWindow: slot.bizdaysInWindow,
            pacingFactor: slot.pacingFactor,
            isCurrentMonth: slot.isCurrentMonth,
            isPastMonth: slot.isPastMonth,
            closedByDay: {},
          };
          merged[slot.ymKey] = m;
        }
        return m;
      };
      const addPerDay = (
        entry: GnrGoalBreakdownEntry,
        days: Record<string, CwBucket> | undefined,
        slot: MonthSlot,
      ) => {
        if (!days) return;
        for (const [dStr, bucket] of Object.entries(days)) {
          const dNum = parseInt(dStr, 10);
          if (!Number.isFinite(dNum)) continue;
          if (!slot.fullCoverage && !slot.isCurrentMonth) {
            if (dNum < slot.segStartDay || dNum > slot.segEndDay) continue;
          }
          const v = pickPerDay(bucket) || 0;
          if (!v) continue;
          entry.closedByDay[dNum] = (entry.closedByDay[dNum] || 0) + v;
        }
      };
      const productKeys: string[] = [];
      if (includeShowcase) productKeys.push("Showcase");
      if (includeMbp) productKeys.push("MBP");
      if (includeSci) productKeys.push("Showcase Incremental");
      if (includeScir) productKeys.push("Showcase Incremental - Re/Max");
      if (includeOverage) productKeys.push("Overage");
      for (const r of reps) {
        const monthlyGoal = monthlyGoalForRep(r);
        const pcDays = (r as unknown as { productCwDaysByMonth?: Record<string, Record<string, Record<string, CwBucket>>> }).productCwDaysByMonth;
        for (const slot of monthSlots) {
          const entry = ensure(slot);
          // Goal accumulation: gross goals always use pacing-style scaling
          // (Task #195, re-applied) — g × pacingFactor regardless of Remaining
          // /Pacing mode. Gross goals have no per-month closed bucket, so the
          // Remaining-mode path (which would return the full monthly goal for
          // the current month) would leave the goal unscaled for short windows
          // like Today or This Week.
          if (monthlyGoal !== 0) {
            entry.monthlyGoal += monthlyGoal;
            const giw = monthlyGoal * slot.pacingFactor;
            entry.goalInWindow += giw;
            entry.contribution += giw;
          }
          // Per-day actuals: only the current month feeds the calendar grid;
          // past months still need their `closed` total to render the tooltip
          // table truthfully.
          for (const pk of productKeys) {
            const days = pcDays?.[pk]?.[slot.ymKey];
            if (!days) continue;
            // Sum into entry.closed (sign-preserving) for non-current months
            // so the tooltip's Closed column matches.
            if (!slot.isCurrentMonth) {
              for (const [dStr, bucket] of Object.entries(days)) {
                const dNum = parseInt(dStr, 10);
                if (!Number.isFinite(dNum)) continue;
                if (!slot.fullCoverage && (dNum < slot.segStartDay || dNum > slot.segEndDay)) continue;
                entry.closed += pickPerDay(bucket) || 0;
              }
            } else {
              addPerDay(entry, days, slot);
              for (const bucket of Object.values(days)) entry.closed += pickPerDay(bucket) || 0;
            }
          }
        }
      }
      return Object.values(merged).sort((a, b) => a.ymKey.localeCompare(b.ymKey));
    };
    const showcaseSel = activeProductSet.has("Showcase");
    const mbpSel = activeProductSet.has("MBP");
    // Showcase row aggregates SCI, SCI-R, and Overage per their independent gating flags.
    const includeSciInShowcase = showcaseSel && sciSelected;
    const includeScirInShowcase = showcaseSel && scirSelected;
    const includeOverageInShowcase = showcaseSel && overageSelected;
    const mrrAddedAggregatedGoalBreakdown = isGrossGnr
      ? buildGnrAggregateBreakdown(
          (r) => (showcaseSel ? gnrGoalFor(r, "Showcase", "mrrAdded") : 0)
            + (mbpSel ? gnrGoalFor(r, "MBP", "mrrAdded") : 0),
          (b) => b.added,
          showcaseSel, mbpSel, includeSciInShowcase, includeScirInShowcase, includeOverageInShowcase,
        )
      : [];
    const churnAggregatedGoalBreakdown = isGrossGnr
      ? buildGnrAggregateBreakdown(
          (r) => (showcaseSel ? gnrGoalFor(r, "Showcase", "churn") : 0)
            + (mbpSel ? gnrGoalFor(r, "MBP", "churn") : 0),
          (b) => b.churn,
          showcaseSel, mbpSel, includeSciInShowcase, includeScirInShowcase, includeOverageInShowcase,
        )
      : [];
    // Task #182 follow-up: per-product proration breakdowns so the GnR
    // per-product split rows (Showcase, MBP) get the same hover popup as
    // the aggregate row (and as Acq's per-product rows). Showcase rolls up
    // SCI per `sciSelected` to mirror grossProductSplit's actual gating.
    const grossProductGoalBreakdowns: Record<string, { mrr: GnrGoalBreakdownEntry[]; churn: GnrGoalBreakdownEntry[] }> = {};
    if (isGrossGnr) {
      const mkRow = (prod: "Showcase" | "MBP") => {
        const isSc = prod === "Showcase";
        return {
          mrr: buildGnrAggregateBreakdown(
            (r) => gnrGoalFor(r, prod, "mrrAdded"),
            (b) => b.added,
            isSc, !isSc, isSc && sciSelected, isSc && scirSelected, isSc && overageSelected,
          ),
          churn: buildGnrAggregateBreakdown(
            (r) => gnrGoalFor(r, prod, "churn"),
            (b) => b.churn,
            isSc, !isSc, isSc && sciSelected, isSc && scirSelected, isSc && overageSelected,
          ),
        };
      };
      grossProductGoalBreakdowns["Showcase"] = mkRow("Showcase");
      grossProductGoalBreakdowns["MBP"] = mkRow("MBP");
    }

    // Per-rep breakdown for "By Rep" drilldown on Quota Attainment.
    // Mirrors the Showcase+SCI rollup and mode-aware churn logic
    // used elsewhere in this memo so per-rep totals reconcile to the card totals.
    type RepProductBreakdown = {
      goal: number;
      mrr: number;
      mrrAdded: number;
      mrrAddedGoal: number;
      churn: number;
      churnGoal: number;
      // Mode-aware weighted pipeline contribution for this rep × product,
      // using the same Showcase+SCI gating, mods subtraction, and mode rules
      // as the aggregate `allProductQuotas[i].weighted`.
      weighted: number;
      // Churn forecast booked/weighted from scheduled mods. Used by the GNR
      // Churn forecast (standalone Churn mode + Both mode + by-rep) so the
      // per-rep churn bars no longer hardcode 0. Showcase rolls in SCI per
      // the Showcase+SCI gating rules. Task #116 wired this in.
      churnBooked: number;
      churnWeighted: number;
      // Task #187: unweighted Open Pipeline (sum of active weighted
      // stages excluding Closed Won) per product per rep. Used by the
      // Export Forecast workbook so each rep × product row carries an
      // Open Pipeline column distinct from Weighted MRR Forecast.
      unweightedOpen: number;
      // Showcase only: split of the contribution into base Showcase vs SCI
      breakdown?: { showcase: number; sci: number } | null;
      mrrAddedBreakdown?: { showcase: number; sci: number } | null;
      churnBreakdown?: { showcase: number; sci: number } | null;
    };
    type RepBreakdown = {
      name: string;
      perProduct: Record<string, RepProductBreakdown>;
    };
    const buildPerRepEntry = (r: typeof reps[0]): RepBreakdown & { groupKey: string } => {
      const pfMode = (r as any)[isAdded ? "productFunnelAdded" : isAcqNet ? "productFunnelAcqNet" : "productFunnel"] as Record<string, Record<string, number>> | undefined;
      const pfStd = (r as any).productFunnel as Record<string, Record<string, number>> | undefined;
      const pfAdded = (r as any).productFunnelAdded as Record<string, Record<string, number>> | undefined;
      const pcAll = (r as any).productChurn as Record<string, number> | undefined;
      const pcAcq = (r as any).acqProductChurn as Record<string, number> | undefined;

      // Mode-aware Closed Won per product (mirrors main loop exactly).
      // No fallback to standard Closed Won — mode-specific data stands on its own.
      const cwForProd = (prod: string): number => {
        return pfMode?.[prod]?.["Closed Won"] || 0;
      };

      // Net-mode churn per product (matches main loop's pc selection).
      let pcNet: Record<string, number> | undefined;
      if (isAcqNet) {
        pcNet = pcAcq;
      } else {
        pcNet = pcAll;
      }
      // Gross-mode churn (always uses total churn, not acq).
      const pcGross = pcAll;

      // Per-rep weighted product funnel snapshot (mode-aware), built in the
      // earlier reps.forEach. Used to compute weighted-per-product per rep
      // for the per-rep Forecast drilldown so totals reconcile to allProductQuotas.
      const wpfRep = wpfByRep.get(r as unknown as object) || ({} as Record<string, Record<string, number>>);
      const rm = r as RepPipelineWithMods;
      const repProductMods: Record<string, number> = rm.productMods || {};
      const repProductModsWeighted: Record<string, number> = rm.productModsWeighted || {};
      const sumWeightedForProd = (prod: string): number => {
        let s = 0;
        for (const stage of ALL_WEIGHTED_STAGES) s += wpfRep?.[prod]?.[stage] || 0;
        if (subtractMods) s -= (repProductMods[prod] || 0) * modsWeight;
        return s;
      };
      // Task #187: sum unweighted Open Pipeline (active weighted stages
      // only — excludes Closed Won) per product per rep, used by the
      // Export Forecast workbook's "Open Pipeline" column.
      const sumUnweightedOpenForProd = (prod: string): number => {
        let s = 0;
        for (const stage of ACTIVE_WEIGHTED_STAGES) s += pfMode?.[prod]?.[stage] || 0;
        return s;
      };

      const perProduct: Record<string, RepProductBreakdown> = {};
      for (const prod of ALL_PRODUCTS) {
        // Net quota is data-driven per canonical product (Goals-tab Final
        // net = MRR-Added − Churn) via netGoalFor, matching the aggregate
        // per-product net paths. Gross MRR-Added + Churn use gnrGoalFor below.
        let goal = prorateNetProductNoBag(netGoalFor(r, prod), r, prod);
        let mrrAddedGoal = prorateGross(gnrGoalFor(r, prod, "mrrAdded"));
        let churnGoal = prorateGross(gnrGoalFor(r, prod, "churn"));
        // Apply windowed-remaining formula to per-rep gross goals so by-rep
        // drilldown rows reconcile with the aggregate grossProductSplit
        // override above. Same MTD source (productCwMtd); Showcase rolls its
        // parts' MTD in. No-op when !isWindowedRemaining.
        if (isWindowedRemaining) {
          const pcMtdR = (r as any).productCwMtd as Record<string, { added?: number; churn?: number }> | undefined;
          const churnKey = "churn" as const;
          const monthlyAdded = gnrGoalFor(r, prod, "mrrAdded");
          const monthlyChurn = gnrGoalFor(r, prod, "churn");
          const addedMtd = prod === "Showcase"
            ? (pcMtdR?.["Showcase"]?.added || 0) + (pcMtdR?.["Showcase Incremental"]?.added || 0) + (pcMtdR?.["Showcase Incremental - Re/Max"]?.added || 0) + (pcMtdR?.["Overage"]?.added || 0)
            : (pcMtdR?.[prod]?.added || 0);
          const churnMtd = prod === "Showcase"
            ? (pcMtdR?.["Showcase"]?.[churnKey] || 0) + (pcMtdR?.["Showcase Incremental"]?.[churnKey] || 0) + (pcMtdR?.["Showcase Incremental - Re/Max"]?.[churnKey] || 0) + (pcMtdR?.["Overage"]?.[churnKey] || 0)
            : (pcMtdR?.[prod]?.[churnKey] || 0);
          mrrAddedGoal = computeWindowedContribFromClosed(() => monthlyAdded, addedMtd);
          churnGoal = computeWindowedContribFromClosed(() => monthlyChurn, churnMtd);
        }

        let mrr = cwForProd(prod);
        let mrrAdded = pfAdded?.[prod]?.["Closed Won"] || 0;
        let churn = -(pcGross?.[prod] || 0); // gross churn rendered as negative actual (mirrors grossProductSplit)
        let churnNet = pcNet?.[prod] || 0; // unused for now but kept for potential future net-churn views
        let weighted = sumWeightedForProd(prod);
        let unweightedOpen = sumUnweightedOpenForProd(prod);
        // Per-rep churn forecast booked/weighted from scheduled mods (Task #116).
        let churnBooked = repProductMods[prod] || 0;
        let churnWeighted = repProductModsWeighted[prod] || 0;

        let breakdown: { showcase: number; sci: number } | null = null;
        let mrrAddedBreakdown: { showcase: number; sci: number } | null = null;
        let churnBreakdown: { showcase: number; sci: number } | null = null;

        if (prod === "Showcase") {
          const sciCW = cwForProd("Showcase Incremental");
          const scirCW = cwForProd("Showcase Incremental - Re/Max");
          const overageCW = cwForProd("Overage");
          const sciAdded = pfAdded?.["Showcase Incremental"]?.["Closed Won"] || 0;
          const scirAdded = pfAdded?.["Showcase Incremental - Re/Max"]?.["Closed Won"] || 0;
          const overageAdded = pfAdded?.["Overage"]?.["Closed Won"] || 0;
          const sciChurnVal = pcGross?.["Showcase Incremental"] || 0;
          const scirChurnVal = pcGross?.["Showcase Incremental - Re/Max"] || 0;
          const overageChurnVal = pcGross?.["Overage"] || 0;
          const showcasePart = showcaseSelected ? mrr : 0;
          const sciPart = sciSelected ? sciCW : 0;
          const scirPart = scirSelected ? scirCW : 0;
          const overagePart = overageSelected ? overageCW : 0;
          mrr = showcasePart + sciPart + scirPart + overagePart;
          breakdown = { showcase: showcasePart, sci: sciPart + scirPart + overagePart };

          const showcasePartAdded = showcaseSelected ? mrrAdded : 0;
          const sciPartAdded = sciSelected ? sciAdded : 0;
          const scirPartAdded = scirSelected ? scirAdded : 0;
          const overagePartAdded = overageSelected ? overageAdded : 0;
          mrrAdded = showcasePartAdded + sciPartAdded + scirPartAdded + overagePartAdded;
          mrrAddedBreakdown = { showcase: showcasePartAdded, sci: sciPartAdded + scirPartAdded + overagePartAdded };

          const showcasePartChurn = showcaseSelected ? churn : 0;
          const sciPartChurn = sciSelected ? -sciChurnVal : 0;
          const scirPartChurn = scirSelected ? -scirChurnVal : 0;
          const overagePartChurn = overageSelected ? -overageChurnVal : 0;
          churn = showcasePartChurn + sciPartChurn + scirPartChurn + overagePartChurn;
          churnBreakdown = { showcase: showcasePartChurn, sci: sciPartChurn + scirPartChurn + overagePartChurn };

          // Showcase row weighted rolls in SCI + SCI-R + Overage (mirrors allProductQuotas).
          const sciWeighted = sumWeightedForProd("Showcase Incremental");
          const scirWeighted = sumWeightedForProd("Showcase Incremental - Re/Max");
          const overageWeighted = sumWeightedForProd("Overage");
          const showcaseWeightedPart = showcaseSelected ? weighted : 0;
          const sciWeightedPart = sciSelected ? sciWeighted : 0;
          const scirWeightedPart = scirSelected ? scirWeighted : 0;
          const overageWeightedPart = overageSelected ? overageWeighted : 0;
          weighted = showcaseWeightedPart + sciWeightedPart + scirWeightedPart + overageWeightedPart;
          const sciOpen = sumUnweightedOpenForProd("Showcase Incremental");
          const scirOpen = sumUnweightedOpenForProd("Showcase Incremental - Re/Max");
          const overageOpen = sumUnweightedOpenForProd("Overage");
          unweightedOpen = (showcaseSelected ? unweightedOpen : 0) + (sciSelected ? sciOpen : 0) + (scirSelected ? scirOpen : 0) + (overageSelected ? overageOpen : 0);

          // Showcase churn forecast rolls in SCI + SCI-R + Overage mods.
          const sciModsBooked = repProductMods["Showcase Incremental"] || 0;
          const scirModsBooked = repProductMods["Showcase Incremental - Re/Max"] || 0;
          const overageModsBooked = repProductMods["Overage"] || 0;
          const sciModsWeighted = repProductModsWeighted["Showcase Incremental"] || 0;
          const scirModsWeighted = repProductModsWeighted["Showcase Incremental - Re/Max"] || 0;
          const overageModsWeighted = repProductModsWeighted["Overage"] || 0;
          const showcaseModsBookedPart = showcaseSelected ? churnBooked : 0;
          const sciModsBookedPart = sciSelected ? sciModsBooked : 0;
          const scirModsBookedPart = scirSelected ? scirModsBooked : 0;
          const overageModsBookedPart = overageSelected ? overageModsBooked : 0;
          const showcaseModsWeightedPart = showcaseSelected ? churnWeighted : 0;
          const sciModsWeightedPart = sciSelected ? sciModsWeighted : 0;
          const scirModsWeightedPart = scirSelected ? scirModsWeighted : 0;
          const overageModsWeightedPart = overageSelected ? overageModsWeighted : 0;
          churnBooked = showcaseModsBookedPart + sciModsBookedPart + scirModsBookedPart + overageModsBookedPart;
          churnWeighted = showcaseModsWeightedPart + sciModsWeightedPart + scirModsWeightedPart + overageModsWeightedPart;
        }

        perProduct[prod] = {
          goal,
          mrr,
          mrrAdded,
          mrrAddedGoal,
          churn,
          churnGoal,
          weighted,
          churnBooked,
          churnWeighted,
          unweightedOpen,
          breakdown,
          mrrAddedBreakdown,
          churnBreakdown,
        };
        void churnNet;
      }
      return { name: r.name, groupKey: getKey(r) || r.name, perProduct };
    };

    const aggregatePerRepEntries = (entries: (RepBreakdown & { groupKey: string })[]): RepBreakdown[] => {
      if (aggBy === "Rep") {
        return entries.map(({ name, perProduct }) => ({ name, perProduct }));
      }
      const grouped = new Map<string, RepBreakdown>();
      const order: string[] = [];
      for (const entry of entries) {
        const key = entry.groupKey || "(unknown)";
        let existing = grouped.get(key);
        if (!existing) {
          existing = { name: key, perProduct: {} };
          for (const prod of ALL_PRODUCTS) {
            existing.perProduct[prod] = {
              goal: 0, mrr: 0, mrrAdded: 0, mrrAddedGoal: 0, churn: 0, churnGoal: 0, weighted: 0,
              churnBooked: 0, churnWeighted: 0, unweightedOpen: 0,
              breakdown: null, mrrAddedBreakdown: null, churnBreakdown: null,
            };
          }
          grouped.set(key, existing);
          order.push(key);
        }
        for (const prod of ALL_PRODUCTS) {
          const src = entry.perProduct[prod];
          if (!src) continue;
          const dst = existing.perProduct[prod];
          dst.goal += src.goal;
          dst.mrr += src.mrr;
          dst.mrrAdded += src.mrrAdded;
          dst.mrrAddedGoal += src.mrrAddedGoal;
          dst.churn += src.churn;
          dst.churnGoal += src.churnGoal;
          dst.weighted += src.weighted;
          dst.churnBooked += src.churnBooked;
          dst.churnWeighted += src.churnWeighted;
          dst.unweightedOpen += src.unweightedOpen;
          if (src.breakdown) {
            dst.breakdown = dst.breakdown || { showcase: 0, sci: 0 };
            dst.breakdown.showcase += src.breakdown.showcase;
            dst.breakdown.sci += src.breakdown.sci;
          }
          if (src.mrrAddedBreakdown) {
            dst.mrrAddedBreakdown = dst.mrrAddedBreakdown || { showcase: 0, sci: 0 };
            dst.mrrAddedBreakdown.showcase += src.mrrAddedBreakdown.showcase;
            dst.mrrAddedBreakdown.sci += src.mrrAddedBreakdown.sci;
          }
          if (src.churnBreakdown) {
            dst.churnBreakdown = dst.churnBreakdown || { showcase: 0, sci: 0 };
            dst.churnBreakdown.showcase += src.churnBreakdown.showcase;
            dst.churnBreakdown.sci += src.churnBreakdown.sci;
          }
        }
      }
      return order.map(k => grouped.get(k)!);
    };

    const perRepBreakdowns = reps.map(buildPerRepEntry);
    const repBreakdowns = aggregatePerRepEntries(perRepBreakdowns);
    // Task #187: per-rep breakdowns enriched with flm/slm for the
    // role-aware "Export Forecast" workbook. Distinct from
    // perRepBreakdowns so we can roll up by flm/slm in the exporter
    // without losing rep identity.
    const perRepBreakdownsForExport = reps.map((r, i) => {
      const rm = r as RepPipelineWithMods;
      return {
        name: perRepBreakdowns[i].name,
        flm: rm.flm || "",
        slm: rm.slm || "",
        perProduct: perRepBreakdowns[i].perProduct,
      };
    });

    // Forecast by-Rep drilldown breakdown — same shape as `repBreakdowns`
    // but built from `repsAll`, the broader rep set that ignores the active
    // aggregation-dimension filter. Lets the by-Rep card keep showing every
    // row when a Rep / FLM / SLM / Region / Segment filter is selected so
    // we can highlight the active row and grey out the rest. When no aggDim
    // filter is active (`reps === repsAll`) this reuses repBreakdowns so the
    // default view is unchanged.
    const forecastRepBreakdowns: RepBreakdown[] = extraReps.length === 0
      ? repBreakdowns
      : aggregatePerRepEntries(repsAll.map(buildPerRepEntry));

    return {
      funnelChartData,
      funnelChartDataGross,
      totalGoal,
      totalMrr,
      totalMrrForQuota,
      repMrr,
      repChurn,
      repMods,
      weightedData,
      totalWeighted,
      modsRow: { stage: "Scheduled Mods", val: activeTotalMods, wVal: activeTotalMods * modsWeight, defaultPct: modsDefaultPct, currentPct: modsDefaultPct },
      displayProducts,
      allProductQuotas,
      activeProductSet,
      activeTotalGoal,
      activeTotalGoalRemaining,
      effectiveQuotaMode,
      quotaWindow,
      activeTotalGoalPerRepSum,
      productGoalsRemaining,
      activeTotalMrrForQuota,
      activeTotalWeighted,
      grossProductSplit,
      isWindowedRemaining,
      mrrAddedAggregatedGoalBreakdown,
      churnAggregatedGoalBreakdown,
      grossProductGoalBreakdowns,
      repBreakdowns,
      forecastRepBreakdowns,
      perRepBreakdownsForExport,
      // Per-product accumulators for the per-product Forecast drilldown.
      weightedActiveProductSums,
      funnelProductSums,
      probSumProductActive,
      probCountProductActive,
      productModsForForecast,
      productModsWeightedForForecast,
      productModsCountForForecast,
      productChurnTypeModsForForecast,
      productChurnTypeModsWeightedForForecast,
      productChurnTypeModsCountForForecast,
      productGoals,
      productMrrForQuota,
      sciMrrForQuotaTotal,
      sciWeightedTotal,
      scirMrrForQuotaTotal,
      scirWeightedTotal,
      overageMrrForQuotaTotal,
      overageWeightedTotal,
      stageDefaults,
      modsDefaultPct,
      modsWeight,
      weightedStages,
      showcaseSelected,
      sciSelected,
      scirSelected,
      overageSelected,
      windowedEligibility,
    };
  }, [data, filters, mrrMode, subtractMods, groupPreset, prorateQuota, quotaMode, holidaySet, quotaGrossMetric]);

  const quotaPeriodLabel = useMemo(() => {
    const range = getDateRange(filters.timeframe, filters.customRange);
    const fmt = (d: Date) => d.toLocaleString("en-US", { month: "long", year: "numeric" });
    const fmtDay = (d: Date) => `${d.toLocaleString("en-US", { month: "short" })}-${d.getDate()}`;
    const suffix = prorateQuota ? " · Prorated" : "";
    if (range.from && range.to) {
      const fromD = new Date(range.from + "T00:00:00");
      const toD = new Date(range.to + "T00:00:00");
      const lastDayOfFromMonth = new Date(fromD.getFullYear(), fromD.getMonth() + 1, 0).getDate();
      const isWholeMonth =
        fromD.getDate() === 1
        && fromD.getMonth() === toD.getMonth()
        && fromD.getFullYear() === toD.getFullYear()
        && toD.getDate() === lastDayOfFromMonth;
      if (isWholeMonth) return fmt(fromD) + suffix;
      if (range.from === range.to) return fmtDay(fromD) + suffix;
      return `${fmtDay(fromD)} - ${fmtDay(toD)}${suffix}`;
    }
    if (range.from) return fmt(new Date(range.from + "T00:00:00")) + suffix;
    return fmt(new Date()) + suffix;
  }, [filters.timeframe, filters.customRange, prorateQuota]);

  // Header label for the Quota card's "Total" row. Defaults to "All Products"
  // and switches to a `+`-joined list of product abbreviations when one or
  // more products are selected via the dashboard's products filter
  // (e.g. SC+SCI+MBP). Order is fixed (Showcase, SCI, MBP, Zillow Pro,
  // Follow Up Boss, then anything else) so the label is stable regardless
  // of selection order.
  const productsLabel = useMemo(() => {
    const sel = filters.products;
    if (!sel || sel.length === 0) return "All Products";

    const avail = availableProducts ?? [];
    const nonMbpProducts = avail.filter(p => p !== "MBP");
    const hasMbp = avail.includes("MBP");
    const mbpSelected = sel.includes("MBP");
    const allNonMbpSelected = nonMbpProducts.length > 0 && nonMbpProducts.every(p => sel.includes(p));

    if (hasMbp && mbpSelected && allNonMbpSelected) return "All Products";
    if (!mbpSelected && allNonMbpSelected) return "Software";
    if (mbpSelected && sel.length === 1) return displayProduct("MBP");

    // Order by ALL_PRODUCTS (shared canonical product order), inserting
    // "Showcase Incremental" right after "Showcase" since SCI is not a
    // standalone entry in ALL_PRODUCTS but is a separately filterable
    // product in the dashboard. Anything outside this list falls through
    // in selection order.
    const canonical: string[] = [];
    for (const p of ALL_PRODUCTS) {
      canonical.push(p);
      if (p === "Showcase") {
        canonical.push("Showcase Incremental");
        canonical.push("Showcase Incremental - Re/Max");
        canonical.push("Overage");
      }
    }
    const set = new Set(sel);
    const ordered: string[] = [];
    for (const p of canonical) if (set.has(p)) ordered.push(p);
    for (const p of sel) if (!canonical.includes(p)) ordered.push(p);
    return ordered.map(p => getProductAbbrev(p)).join("+");
  }, [filters.products, availableProducts]);


  // Per-product Forecast drilldown data — computed only when a product bar is
  // clicked (otherwise null). Mirrors the aggregate weightedData/modsRow shape
  // but every figure comes from the selected product's own pipeline. For
  // Showcase, sums Showcase + SCI rows per stage AND mods, gated by the same
  // showcaseSelected / sciSelected flags used elsewhere so the drilldown
  // matches the per-product bar exactly.
  // NOTE: hook must be declared BEFORE the loading early-return to keep hook
  // order stable across renders.
  const productDrilldownData = useMemo(() => {
    if (!forecastPopupProduct || !processedData) return null;
    const prod = forecastPopupProduct;
    const {
      weightedActiveProductSums: pdWaps,
      funnelProductSums: pdFps,
      probSumProductActive: pdPsp,
      probCountProductActive: pdPcp,
      productModsForForecast: pdPmf,
      productGoals: pdPg,
      productMrrForQuota: pdPmq,
      sciMrrForQuotaTotal: pdSciMrr,
      scirMrrForQuotaTotal: pdScirMrr,
      overageMrrForQuotaTotal: pdOverageMrr,
      stageDefaults: pdStageDefaults,
      modsDefaultPct: pdModsDefaultPct,
      modsWeight: pdModsWeight,
      weightedStages: pdWeightedStages,
      showcaseSelected: pdShowcaseSelected,
      sciSelected: pdSciSelected,
      scirSelected: pdScirSelected,
      overageSelected: pdOverageSelected,
    } = processedData;

    const buildStageRow = (stage: string) => {
      let val = 0;
      let wVal = 0;
      let pSum = 0;
      let pCnt = 0;
      if (prod === "Showcase") {
        if (pdShowcaseSelected) {
          val += pdFps[stage]?.["Showcase"] || 0;
          wVal += pdWaps[stage]?.["Showcase"] || 0;
          pSum += pdPsp[stage]?.["Showcase"] || 0;
          pCnt += pdPcp[stage]?.["Showcase"] || 0;
        }
        if (pdSciSelected) {
          val += pdFps[stage]?.["Showcase Incremental"] || 0;
          wVal += pdWaps[stage]?.["Showcase Incremental"] || 0;
          pSum += pdPsp[stage]?.["Showcase Incremental"] || 0;
          pCnt += pdPcp[stage]?.["Showcase Incremental"] || 0;
        }
        if (pdScirSelected) {
          val += pdFps[stage]?.["Showcase Incremental - Re/Max"] || 0;
          wVal += pdWaps[stage]?.["Showcase Incremental - Re/Max"] || 0;
          pSum += pdPsp[stage]?.["Showcase Incremental - Re/Max"] || 0;
          pCnt += pdPcp[stage]?.["Showcase Incremental - Re/Max"] || 0;
        }
        if (pdOverageSelected) {
          val += pdFps[stage]?.["Overage"] || 0;
          wVal += pdWaps[stage]?.["Overage"] || 0;
          pSum += pdPsp[stage]?.["Overage"] || 0;
          pCnt += pdPcp[stage]?.["Overage"] || 0;
        }
      } else {
        val = pdFps[stage]?.[prod] || 0;
        wVal = pdWaps[stage]?.[prod] || 0;
        pSum = pdPsp[stage]?.[prod] || 0;
        pCnt = pdPcp[stage]?.[prod] || 0;
      }
      const defaultPct = pdStageDefaults[stage] ?? (stage === "Closed Won" ? 100 : 0);
      const currentPct = pCnt > 0 ? pSum / pCnt : defaultPct;
      return { stage, val, wVal, defaultPct, currentPct };
    };

    const stageRows = pdWeightedStages.map(buildStageRow);

    let mods = 0;
    if (prod === "Showcase") {
      if (pdShowcaseSelected) mods += pdPmf["Showcase"] || 0;
      if (pdSciSelected) mods += pdPmf["Showcase Incremental"] || 0;
      if (pdScirSelected) mods += pdPmf["Showcase Incremental - Re/Max"] || 0;
      if (pdOverageSelected) mods += pdPmf["Overage"] || 0;
    } else {
      mods = pdPmf[prod] || 0;
    }

    let weightedTotal = stageRows.reduce((s, r) => s + r.wVal, 0);
    if (subtractMods) weightedTotal -= mods * pdModsWeight;

    const goal = pdPg[prod] || 0;
    let mrrForQuota = 0;
    if (prod === "Showcase") {
      if (pdShowcaseSelected) mrrForQuota += pdPmq["Showcase"] || 0;
      if (pdSciSelected) mrrForQuota += pdSciMrr;
      if (pdScirSelected) mrrForQuota += pdScirMrr;
      if (pdOverageSelected) mrrForQuota += pdOverageMrr;
    } else {
      mrrForQuota = pdPmq[prod] || 0;
    }

    const gap = goal - weightedTotal;
    const wrToHit = weightedTotal > 0 && mrrForQuota < goal
      ? Math.max(0, ((goal - mrrForQuota) / weightedTotal) * 100)
      : 0;
    const cov = goal > 0 ? weightedTotal / goal : 0;

    let title = `${prod} Forecast`;
    if (prod === "Showcase") {
      if (pdShowcaseSelected && (pdSciSelected || pdScirSelected)) title = "Showcase + Showcase Incremental Forecast";
      else if (pdShowcaseSelected) title = "Showcase (Incremental Excluded) Forecast";
      else if (pdSciSelected || pdScirSelected) title = "Showcase Incremental Forecast";
    }

    return {
      product: prod,
      title,
      stageRows,
      mods,
      modsRow: { stage: "Scheduled Mods", val: mods, wVal: mods * pdModsWeight, defaultPct: pdModsDefaultPct, currentPct: pdModsDefaultPct },
      weightedTotal,
      goal,
      mrrForQuota,
      gap,
      winRateToHit: wrToHit,
      coverage: cov,
    };
  }, [forecastPopupProduct, processedData, subtractMods]);

  // ─── Churn Forecast helpers (Task #116). Color & WR formulas are
  // semantically inverted vs MRR: low fill = green (under churn cap),
  // approaching/exceeding 1x = red. WR-to-Hit is the % of remaining
  // unweighted scheduled mods that must NOT happen for the team to stay at
  // or under the cap; rendered as `null` when undefined (already under cap
  // or no remaining mod tail).
  // Inverted color thresholds (locked spec, Task #116):
  //   < 1x  → green (forecast safely under churn cap)
  //   ≥ 1x  → red   (forecast would breach the cap)
  //   > target × cap → darker red (severely past the cap)
  // No orange middle band — breaching the cap at all is bad.
  const churnFillColor = useCallback((booked: number, weighted: number, goal: number, target: number): string => {
    if (goal <= 0) return "#94a3b8";
    const m = weighted / goal;
    if (m < 1) return "#00C49F";
    if (m <= target) return "#EF4444";
    return "#991B1B";
  }, []);
  const churnCovColor = useCallback((coverage: number, goal: number, target: number): string => {
    if (goal <= 0) return "#94a3b8";
    if (coverage < 1) return "#00C49F";
    if (coverage <= target) return "#EF4444";
    return "#991B1B";
  }, []);
  const churnGapColor = useCallback((gap: number, goal: number): string => {
    if (goal <= 0) return "#94a3b8";
    // Inverted: positive gap (under cap) = green, negative gap (over cap) = red.
    if (gap > 0) return "#10B981";
    if (gap < 0) return "#EF4444";
    return "#64748b";
  }, []);
  // Inverted WR-to-Hit: max(0, (booked − goal) / (booked − weighted)) × 100.
  // Returns null when undefined (booked ≤ goal → already under cap, or
  // booked − weighted ≤ 0 → no unweighted mod tail to prevent).
  const churnWrToHit = useCallback((booked: number, weighted: number, goal: number): number | null => {
    if (goal <= 0) return null;
    if (booked <= goal) return null;
    const denom = booked - weighted;
    if (denom <= 0) return null;
    // Clamp to [0, 100] — values >100 mean even pulling every weighted
    // mod won't keep us under quota, so cap at 100% display.
    return Math.min(100, Math.max(0, ((booked - goal) / denom) * 100));
  }, []);

  // Per-product Churn Forecast drilldown data — computed only when a
  // churn product bar is clicked. Single "Scheduled Mods" stage row sourced
  // from `productModsForForecast` and `productModsWeightedForForecast` with
  // Showcase+SCI gating. Header tiles use the churn-side helpers above so
  // the popup matches the per-product churn bar exactly.
  const churnDrilldownData = useMemo(() => {
    if (!forecastChurnPopupProduct || !processedData) return null;
    const prod = forecastChurnPopupProduct;
    const gps = processedData.grossProductSplit;
    if (!gps) return null;
    const row = gps.find(p => p.product === prod);
    if (!row) return null;
    const {
      productModsForForecast: pdPmf,
      productModsWeightedForForecast: pdPmwf,
      productModsCountForForecast: pdPmcf,
      productChurnTypeModsForForecast: pdPctMf,
      productChurnTypeModsWeightedForForecast: pdPctMwf,
      productChurnTypeModsCountForForecast: pdPctMcf,
      stageDefaults: pdStageDefaults,
      showcaseSelected: pdShowcaseSelected,
      sciSelected: pdSciSelected,
      scirSelected: pdScirSelected,
      overageSelected: pdOverageSelected,
    } = processedData;

    let booked = 0;
    let weighted = 0;
    let count = 0;
    // Per-churn-type aggregates summed across the relevant product
    // sub-keys (Showcase rolls Showcase + Showcase Incremental together).
    const ctVal: Record<string, number> = {};
    const ctWVal: Record<string, number> = {};
    const ctCount: Record<string, number> = {};
    const accumProduct = (p: string) => {
      booked += pdPmf[p] || 0;
      weighted += pdPmwf[p] || 0;
      count += (pdPmcf?.[p]) || 0;
      const byType = pdPctMf?.[p];
      if (byType) {
        for (const [ct, v] of Object.entries(byType)) {
          ctVal[ct] = (ctVal[ct] || 0) + (v || 0);
        }
      }
      const byTypeW = pdPctMwf?.[p];
      if (byTypeW) {
        for (const [ct, v] of Object.entries(byTypeW)) {
          ctWVal[ct] = (ctWVal[ct] || 0) + (v || 0);
        }
      }
      const byTypeC = pdPctMcf?.[p];
      if (byTypeC) {
        for (const [ct, v] of Object.entries(byTypeC)) {
          ctCount[ct] = (ctCount[ct] || 0) + (v || 0);
        }
      }
    };
    if (prod === "Showcase") {
      if (pdShowcaseSelected) accumProduct("Showcase");
      if (pdSciSelected) accumProduct("Showcase Incremental");
      if (pdScirSelected) accumProduct("Showcase Incremental - Re/Max");
      if (pdOverageSelected) accumProduct("Overage");
    } else {
      accumProduct(prod);
    }

    // Build per-churn-type rows. Always render the canonical pair
    // ("Scheduled Mods", "CC Decline") even when the current scope has
    // zero rows of that type — managers want both lines visible so an
    // empty CC Decline column reads as "no declines this window", not
    // "missing row". Any additional churn_type values discovered in
    // the data render as extra rows. Sort: Scheduled Mods first, CC
    // Decline second, then alphabetical.
    // Databricks emits the singular "Scheduled Mod" / "CC Decline" as the
    // raw `churn_type` values; we always render those two rows, plus any
    // additional types discovered in the data.
    const REQUIRED_CHURN_TYPES = ["Scheduled Mod", "CC Decline"];
    const churnTypeSet = new Set<string>(REQUIRED_CHURN_TYPES);
    for (const ct of Object.keys(ctVal)) {
      if ((ctCount[ct] || 0) > 0 || (ctVal[ct] || 0) > 0) churnTypeSet.add(ct);
    }
    const churnTypes = Array.from(churnTypeSet);
    churnTypes.sort((a, b) => {
      if (a === "Scheduled Mod") return -1;
      if (b === "Scheduled Mod") return 1;
      if (a === "CC Decline") return -1;
      if (b === "CC Decline") return 1;
      return a.localeCompare(b);
    });
    const churnTypeRows = churnTypes.map(ct => {
      const val = ctVal[ct] || 0;
      const wVal = ctWVal[ct] || 0;
      const cnt = ctCount[ct] || 0;
      const defaultPct = pdStageDefaults[ct] ?? 100;
      const currentPct = val > 0 ? (wVal / val) * 100 : defaultPct;
      return { churnType: ct, val, wVal, defaultPct, currentPct, count: cnt };
    });

    const goal = row.churnGoal || 0;
    const gap = goal - weighted;
    const cov = goal > 0 ? weighted / goal : 0;
    const wr = churnWrToHit(booked, weighted, goal);

    let title = `${prod} Churn Forecast`;
    if (prod === "Showcase") {
      if (pdShowcaseSelected && (pdSciSelected || pdScirSelected)) title = "Showcase + Showcase Incremental Churn Forecast";
      else if (pdShowcaseSelected) title = "Showcase (Incremental Excluded) Churn Forecast";
      else if (pdSciSelected || pdScirSelected) title = "Showcase Incremental Churn Forecast";
    }

    return {
      product: prod,
      title,
      churnTypeRows,
      booked,
      weighted,
      goal,
      gap,
      coverage: cov,
      winRateToHit: wr,
    };
  }, [forecastChurnPopupProduct, processedData, churnWrToHit]);

  // Task #187: aggregate per-product MRR Forecast drilldown data. One
  // entry per product currently in scope (filters.products if any, else
  // displayProducts) using the same per-product math as
  // productDrilldownData. Showcase rolls SCI in per the active gating.
  const mrrAggregateProductDrilldowns = useMemo(() => {
    if (!processedData) return [] as Array<{
      product: string;
      color: string;
      stageRows: { stage: string; val: number; wVal: number; defaultPct: number; currentPct: number }[];
      modsRow: { val: number; wVal: number; defaultPct: number; currentPct: number };
      weightedTotal: number;
      goal: number;
      booked: number;
      gap: number;
      coverage: number;
      winRateToHit: number;
    }>;
    const {
      weightedActiveProductSums: pdWaps,
      funnelProductSums: pdFps,
      probSumProductActive: pdPsp,
      probCountProductActive: pdPcp,
      productModsForForecast: pdPmf,
      productGoals: pdPg,
      productMrrForQuota: pdPmq,
      sciMrrForQuotaTotal: pdSciMrr,
      stageDefaults: pdStageDefaults,
      modsDefaultPct: pdModsDefaultPct,
      modsWeight: pdModsWeight,
      weightedStages: pdWeightedStages,
      showcaseSelected: pdShowcaseSelected,
      sciSelected: pdSciSelected,
      scirSelected: pdScirSelected,
      scirMrrForQuotaTotal: pdScirMrr,
      overageMrrForQuotaTotal: pdOverageMrr,
      overageSelected: pdOverageSelected,
      displayProducts: pdDisplayProducts,
      grossProductSplit: pdGps,
      allProductQuotas: pdApq,
    } = processedData;
    // Task #208: Align per-product Goal / Booked / Weighted with the
    // Forecast card's data lane so the popup's per-product rows and BAN
    // breakdown reconcile exactly with the per-product bars on the card.
    // In Gross MRR / GnR mode, goal+booked come from grossProductSplit
    // (mrrAddedGoal / mrrAddedActual); weighted comes from
    // allProductQuotas (already does Showcase+SCI rollup + subtractMods).
    // In Net / non-GnR modes, fall back to the existing Net sources.
    const pdGpsArr = (pdGps || []) as ReadonlyArray<{ product: string; mrrAddedGoal: number; mrrAddedActual: number }>;
    const pdApqArr = pdApq as ReadonlyArray<{ product: string; weighted: number }>;
    const pdGpsByProduct = new Map<string, typeof pdGpsArr[number]>(pdGpsArr.map(p => [p.product, p]));
    const pdApqByProduct = new Map<string, typeof pdApqArr[number]>(pdApqArr.map(p => [p.product, p]));
    // Task #190: Source list — dashboard product filter (in order) when
    // set; otherwise the canonical ALL_PRODUCTS list (Showcase rolls SCI
    // in via existing pdShowcaseSelected/pdSciSelected accumulation, so
    // "Showcase Incremental" never renders as its own row). Falling back
    // to pdDisplayProducts (which is [] when no product filter is set)
    // was the reason per-product sub-rows didn't appear in the default
    // "All Products" view.
    void pdDisplayProducts;
    // Task #190 (review follow-up): map any user-selected "Showcase
    // Incremental" entry to "Showcase" (SCI rolls into Showcase, never
    // standalone) and dedupe so an SCI-only / OV-only filter still renders a
    // Showcase row instead of an empty list.
    const remapShowcase = (arr: string[]) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const p of arr) {
        const m = (p === "Showcase Incremental" || p === "Showcase Incremental - Re/Max" || p === "Overage") ? "Showcase" : p;
        if (!seen.has(m)) { seen.add(m); out.push(m); }
      }
      return out;
    };
    const source: string[] = (filters.products && filters.products.length > 0)
      ? remapShowcase(filters.products)
      : (ALL_PRODUCTS as readonly string[]).slice();
    return source.map((prod, idx) => {
      const buildStageRow = (stage: string) => {
        let val = 0, wVal = 0, pSum = 0, pCnt = 0;
        if (prod === "Showcase") {
          if (pdShowcaseSelected) {
            val += pdFps[stage]?.["Showcase"] || 0;
            wVal += pdWaps[stage]?.["Showcase"] || 0;
            pSum += pdPsp[stage]?.["Showcase"] || 0;
            pCnt += pdPcp[stage]?.["Showcase"] || 0;
          }
          if (pdSciSelected) {
            val += pdFps[stage]?.["Showcase Incremental"] || 0;
            wVal += pdWaps[stage]?.["Showcase Incremental"] || 0;
            pSum += pdPsp[stage]?.["Showcase Incremental"] || 0;
            pCnt += pdPcp[stage]?.["Showcase Incremental"] || 0;
          }
          if (pdScirSelected) {
            val += pdFps[stage]?.["Showcase Incremental - Re/Max"] || 0;
            wVal += pdWaps[stage]?.["Showcase Incremental - Re/Max"] || 0;
            pSum += pdPsp[stage]?.["Showcase Incremental - Re/Max"] || 0;
            pCnt += pdPcp[stage]?.["Showcase Incremental - Re/Max"] || 0;
          }
          if (pdOverageSelected) {
            val += pdFps[stage]?.["Overage"] || 0;
            wVal += pdWaps[stage]?.["Overage"] || 0;
            pSum += pdPsp[stage]?.["Overage"] || 0;
            pCnt += pdPcp[stage]?.["Overage"] || 0;
          }
        } else {
          val = pdFps[stage]?.[prod] || 0;
          wVal = pdWaps[stage]?.[prod] || 0;
          pSum = pdPsp[stage]?.[prod] || 0;
          pCnt = pdPcp[stage]?.[prod] || 0;
        }
        const defaultPct = pdStageDefaults[stage] ?? (stage === "Closed Won" ? 100 : 0);
        const currentPct = pCnt > 0 ? pSum / pCnt : defaultPct;
        return { stage, val, wVal, defaultPct, currentPct };
      };
      const stageRows = pdWeightedStages.map(buildStageRow);
      let mods = 0;
      if (prod === "Showcase") {
        if (pdShowcaseSelected) mods += pdPmf["Showcase"] || 0;
        if (pdSciSelected) mods += pdPmf["Showcase Incremental"] || 0;
        if (pdScirSelected) mods += pdPmf["Showcase Incremental - Re/Max"] || 0;
        if (pdOverageSelected) mods += pdPmf["Overage"] || 0;
      } else {
        mods = pdPmf[prod] || 0;
      }
      // Task #208: Weighted comes from allProductQuotas when available
      // (matches Forecast card; already handles Showcase+SCI rollup and
      // subtractMods identically to the stage-sum below). Stage-sum
      // fallback preserves behavior in non-GnR modes where pdApq is
      // still the same data lane.
      let weightedTotal = stageRows.reduce((s, r) => s + r.wVal, 0);
      if (subtractMods) weightedTotal -= mods * pdModsWeight;
      const apqRow = pdApqByProduct.get(prod);
      if (apqRow) weightedTotal = apqRow.weighted;
      // Task #208: Goal/Booked in Gross MRR / GnR mode come from
      // grossProductSplit so they reconcile with the Forecast card's
      // per-product bars (which use mrrAddedGoal / mrrAddedActual). In
      // Net / non-GnR modes (no pdGps), fall back to the existing
      // productGoals / productMrrForQuota path.
      const gpsRow = pdGpsByProduct.get(prod);
      let goal: number;
      let booked: number;
      if (gpsRow) {
        goal = gpsRow.mrrAddedGoal || 0;
        booked = gpsRow.mrrAddedActual || 0;
      } else {
        goal = pdPg[prod] || 0;
        booked = 0;
        if (prod === "Showcase") {
          if (pdShowcaseSelected) booked += pdPmq["Showcase"] || 0;
          if (pdSciSelected) booked += pdSciMrr;
          if (pdScirSelected) booked += pdScirMrr;
          if (pdOverageSelected) booked += pdOverageMrr;
        } else {
          booked = pdPmq[prod] || 0;
        }
      }
      const gap = goal - weightedTotal;
      const wrToHit = weightedTotal > 0 && booked < goal
        ? Math.max(0, ((goal - booked) / weightedTotal) * 100)
        : 0;
      const cov = goal > 0 ? weightedTotal / goal : 0;
      return {
        product: prod,
        color: getProductColor(prod, idx),
        stageRows,
        modsRow: { val: mods, wVal: mods * pdModsWeight, defaultPct: pdModsDefaultPct, currentPct: pdModsDefaultPct },
        weightedTotal,
        goal,
        booked,
        gap,
        coverage: cov,
        winRateToHit: wrToHit,
      };
    });
  }, [processedData, filters.products, subtractMods]);

  // Task #205: Reconciled All Products popup Win Rate to Hit and Coverage,
  // derived by summing the same per-product remaining goals and weighted
  // pipeline that mrrAggregateProductDrilldowns uses for each product row.
  // This ensures the popup header tiles are mathematically consistent with
  // the per-product sub-rows rendered directly below them: the aggregate
  // Remaining Goal equals Σ max(0, goal_i − booked_i), not the
  // aggregate-floored max(0, Σgoals − Σbooked) used by the BAN tiles.
  const popupSumRemaining = mrrAggregateProductDrilldowns.reduce(
    (s, p) => s + Math.max(0, p.goal - p.booked), 0
  );
  const popupSumGoal = mrrAggregateProductDrilldowns.reduce(
    (s, p) => s + p.goal, 0
  );
  const popupSumWeighted = mrrAggregateProductDrilldowns.reduce(
    (s, p) => s + p.weightedTotal, 0
  );
  const popupWinRateToHit = popupSumWeighted > 0 && popupSumRemaining > 0
    ? (popupSumRemaining / popupSumWeighted) * 100
    : 0;
  const popupCoverage = popupSumGoal !== 0
    ? popupSumWeighted / Math.abs(popupSumGoal)
    : 0;

  // Task #187: aggregate per-product Churn Forecast drilldown data.
  const churnAggregateProductDrilldowns = useMemo(() => {
    if (!processedData) return [] as Array<{
      product: string;
      color: string;
      churnTypeRows: { churnType: string; val: number; wVal: number; defaultPct: number; currentPct: number; count: number }[];
      booked: number;
      weighted: number;
      goal: number;
      gap: number;
      coverage: number;
      winRateToHit: number | null;
    }>;
    const {
      productModsForForecast: pdPmf,
      productModsWeightedForForecast: pdPmwf,
      productModsCountForForecast: pdPmcf,
      productChurnTypeModsForForecast: pdPctMf,
      productChurnTypeModsWeightedForForecast: pdPctMwf,
      productChurnTypeModsCountForForecast: pdPctMcf,
      stageDefaults: pdStageDefaults,
      showcaseSelected: pdShowcaseSelected,
      sciSelected: pdSciSelected,
      scirSelected: pdScirSelected,
      overageSelected: pdOverageSelected,
      grossProductSplit: pdGps,
      displayProducts: pdDisplayProducts,
    } = processedData;
    // Task #190: same canonical-fallback as the MRR drilldown above,
    // including SCI→Showcase remap so an SCI-only / OV-only filter still
    // renders a Showcase row.
    void pdDisplayProducts;
    const remapShowcase = (arr: string[]) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const p of arr) {
        const m = (p === "Showcase Incremental" || p === "Showcase Incremental - Re/Max" || p === "Overage") ? "Showcase" : p;
        if (!seen.has(m)) { seen.add(m); out.push(m); }
      }
      return out;
    };
    const source: string[] = (filters.products && filters.products.length > 0)
      ? remapShowcase(filters.products)
      : (ALL_PRODUCTS as readonly string[]).slice();
    const REQUIRED_CHURN_TYPES = ["Scheduled Mod", "CC Decline"];
    return source.map((prod, idx) => {
      let booked = 0, weighted = 0;
      const ctVal: Record<string, number> = {};
      const ctWVal: Record<string, number> = {};
      const ctCount: Record<string, number> = {};
      const accumProduct = (p: string) => {
        booked += pdPmf[p] || 0;
        weighted += pdPmwf[p] || 0;
        const byType = pdPctMf?.[p];
        if (byType) for (const [ct, v] of Object.entries(byType)) ctVal[ct] = (ctVal[ct] || 0) + (v || 0);
        const byTypeW = pdPctMwf?.[p];
        if (byTypeW) for (const [ct, v] of Object.entries(byTypeW)) ctWVal[ct] = (ctWVal[ct] || 0) + (v || 0);
        const byTypeC = pdPctMcf?.[p];
        if (byTypeC) for (const [ct, v] of Object.entries(byTypeC)) ctCount[ct] = (ctCount[ct] || 0) + (v || 0);
      };
      if (prod === "Showcase") {
        if (pdShowcaseSelected) accumProduct("Showcase");
        if (pdSciSelected) accumProduct("Showcase Incremental");
        if (pdScirSelected) accumProduct("Showcase Incremental - Re/Max");
        if (pdOverageSelected) accumProduct("Overage");
      } else {
        accumProduct(prod);
      }
      const churnTypeSet = new Set<string>(REQUIRED_CHURN_TYPES);
      for (const ct of Object.keys(ctVal)) {
        if ((ctCount[ct] || 0) > 0 || (ctVal[ct] || 0) > 0) churnTypeSet.add(ct);
      }
      const churnTypes = Array.from(churnTypeSet);
      churnTypes.sort((a, b) => {
        if (a === "Scheduled Mod") return -1;
        if (b === "Scheduled Mod") return 1;
        if (a === "CC Decline") return -1;
        if (b === "CC Decline") return 1;
        return a.localeCompare(b);
      });
      const churnTypeRows = churnTypes.map(ct => {
        const val = ctVal[ct] || 0;
        const wVal = ctWVal[ct] || 0;
        const cnt = ctCount[ct] || 0;
        const defaultPct = pdStageDefaults[ct] ?? 100;
        const currentPct = val > 0 ? (wVal / val) * 100 : defaultPct;
        return { churnType: ct, val, wVal, defaultPct, currentPct, count: cnt };
      });
      const goalRow = pdGps?.find(p => p.product === prod);
      const goal = goalRow?.churnGoal || 0;
      const gap = goal - weighted;
      const cov = goal > 0 ? weighted / goal : 0;
      const wr = churnWrToHit(booked, weighted, goal);
      return {
        product: prod,
        color: getProductColor(prod, idx),
        churnTypeRows,
        booked,
        weighted,
        goal,
        gap,
        coverage: cov,
        winRateToHit: wr,
      };
    });
  }, [processedData, filters.products, churnWrToHit]);

  // Rep names currently in scope (post-filter). These are TRUE rep
  // identities (rep.name from data.reps), not aggregate labels — so
  // coverage-target writes always cascade to actual reps regardless of
  // whether the dashboard is currently aggregated by FLM/SLM/Region/etc.
  // Computed BEFORE the loading early-return so hook order stays stable.
  const popupActiveRepNames = useMemo<string[]>(() => {
    if (!data?.reps) return [];
    let reps = data.reps;
    if (filters.slm.length > 0) reps = reps.filter(r => filters.slm.includes(r.slm));
    if (filters.flm.length > 0) reps = reps.filter(r => filters.flm.includes(r.flm));
    if (filters.rep.length > 0) reps = reps.filter(r => filters.rep.includes(r.name));
    if (filters.region.length > 0) reps = reps.filter(r => filters.region.includes(r.region));
    if (filters.segment.length > 0) reps = reps.filter(r => filters.segment.includes((r as any).segment));
    reps = reps.filter(r => passesChannelFilter(r.group, filters.group));
    const names = new Set<string>();
    for (const r of reps) if (r.name) names.add(r.name);
    return Array.from(names);
  }, [data, filters.slm, filters.flm, filters.rep, filters.region, filters.segment, filters.group]);
  // Avg coverage target across visible reps. Falls back to the global
  // default when no overrides exist yet. Used everywhere a single
  // multiple drives the bar (per-product, total Forecast, GNR mini-bars).
  const effectiveCoverageTarget = useMemo<number>(() => {
    if (popupActiveRepNames.length === 0) return DEFAULT_COVERAGE_TARGET;
    let sum = 0; let n = 0;
    for (const name of popupActiveRepNames) {
      const v = coverageTargets[name];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) { sum += v; n += 1; }
    }
    if (n === 0) return DEFAULT_COVERAGE_TARGET;
    return sum / n;
  }, [popupActiveRepNames, coverageTargets]);

  // Task #187 (superseded by #192): role-aware xlsx export of the aggregate
  // Forecast view. Kept declared so the hook list stays stable across
  // renders, but unwired from the UI (Task #192 replaced the single button
  // with two new per-rep CSV/XLSX exports below).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _exportForecastWorkbookLegacy = useCallback(async (mode: "mrr" | "churn") => {
    if (!processedData) return;
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const role = (authUser?.role || "").toLowerCase();
    const isRep = role === "rep" || role === "ae" || role === "se";
    const isFlm = role === "flm" || role === "manager";
    const includeChurn = mrrMode !== "acqNet";
    // Task #187: per-rep breakdown keys are the canonical ALL_PRODUCTS
    // set; "Showcase Incremental" is rolled into "Showcase". Normalize
    // the in-scope product list to those keys (with dedupe) so workbook
    // columns line up with real data instead of writing zeros.
    const rawScope: string[] = (filters.products && filters.products.length > 0)
      ? filters.products
      : processedData.displayProducts;
    const seen = new Set<string>();
    const exportProductsLocal: string[] = [];
    const isCanonicalProduct = (p: string): p is (typeof ALL_PRODUCTS)[number] =>
      (ALL_PRODUCTS as readonly string[]).includes(p);
    for (const p of rawScope) {
      const norm = (p === "Showcase Incremental" || p === "Showcase Incremental - Re/Max" || p === "Overage") ? "Showcase" : p;
      if (!isCanonicalProduct(norm)) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
      exportProductsLocal.push(norm);
    }
    const perRepRows = processedData.perRepBreakdownsForExport;
    type PerProductExport = {
      goal: number;
      mrr: number;
      mrrAdded: number;
      mrrAddedGoal: number;
      churn: number;
      churnGoal: number;
      weighted: number;
      churnBooked: number;
      churnWeighted: number;
      unweightedOpen: number;
    };
    type Row = { name: string; perProduct: Record<string, PerProductExport> };
    const emptyPerProduct = (): PerProductExport => ({
      goal: 0, mrr: 0, mrrAdded: 0, mrrAddedGoal: 0, churn: 0, churnGoal: 0,
      weighted: 0, churnBooked: 0, churnWeighted: 0, unweightedOpen: 0,
    });

    // Task #187: build the per-sheet preamble (analysis date + active
    // filter summary) so every worksheet self-documents the export
    // context. All hierarchy/region filters are string[] multi-select
    // arrays; group is a scalar string.
    const fmtFilterList = (v: string[] | undefined | null): string =>
      v && v.length ? v.join(", ") : "All";
    const fmtFilterScalar = (v: string | undefined | null): string =>
      v && v.trim() && v !== "All Channels" ? v : "All";
    const preambleLines: [string, string][] = [
      ["Exported", formatLongDate(new Date())],
      ["Dashboard", includeChurn ? "G&R" : "ACQ"],
      ["Metric", mode === "churn" ? "Churn" : "MRR"],
      ["Pipeline Mode", pipelineMode === "allOpen" ? "All Open" : "Close Date"],
      ["Timeframe", String(filters.timeframe || "")],
      ["Products", filters.products && filters.products.length ? filters.products.map(displayProduct).join(", ") : "All"],
      ["SLM", fmtFilterList(filters.slm)],
      ["FLM", fmtFilterList(filters.flm)],
      ["Rep", fmtFilterList(filters.rep)],
      ["Region", fmtFilterList(filters.region)],
      ["Segment", fmtFilterList(filters.segment)],
      ["Channel", fmtFilterScalar(filters.group)],
    ];

    const buildSheet = (title: string, rows: Row[]) => {
      const ws = wb.addWorksheet(title);
      // Preamble — date + filter summary at the top of every sheet
      for (const [k, v] of preambleLines) {
        const r = ws.addRow([k, v]);
        r.getCell(1).font = { bold: true };
      }
      ws.addRow([]); // spacer
      const headerRow1Idx = ws.rowCount + 1;
      const perProdCols = includeChurn ? 5 : 3;
      const headerRow1: (string | null)[] = ["Name"];
      const headerRow2: string[] = [""];
      for (const prod of exportProductsLocal) {
        headerRow1.push(displayProduct(prod));
        for (let i = 1; i < perProdCols; i++) headerRow1.push(null);
        if (includeChurn) headerRow2.push("Goal", "Open Pipeline", "Weighted MRR Forecast", "Forecasted Churn", "Net Forecast");
        else headerRow2.push("Goal", "Open Pipeline", "Weighted MRR Forecast");
      }
      ws.addRow(headerRow1);
      ws.addRow(headerRow2);
      let col = 2;
      for (let p = 0; p < exportProductsLocal.length; p++) {
        ws.mergeCells(headerRow1Idx, col, headerRow1Idx, col + perProdCols - 1);
        const cell = ws.getCell(headerRow1Idx, col);
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.font = { bold: true };
        const color = getProductColor(exportProductsLocal[p], p).replace("#", "");
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${color}` } };
        col += perProdCols;
      }
      ws.getRow(headerRow1Idx + 1).font = { bold: true };
      const dataStartRow = headerRow1Idx + 2;
      for (const row of rows) {
        const out: (string | number)[] = [row.name];
        for (const prod of exportProductsLocal) {
          const pp: PerProductExport = row.perProduct[prod] || emptyPerProduct();
          const goal = includeChurn ? pp.goal : pp.mrrAddedGoal;
          const openPipe = pp.unweightedOpen;
          const weightedFcst = pp.mrr + pp.weighted;
          if (includeChurn) {
            const fcstChurn = pp.churnBooked + pp.churnWeighted;
            const net = weightedFcst - fcstChurn;
            out.push(goal, openPipe, weightedFcst, fcstChurn, net);
          } else {
            out.push(goal, openPipe, weightedFcst);
          }
        }
        ws.addRow(out);
      }
      for (let r = dataStartRow; r <= dataStartRow + rows.length - 1; r++) {
        for (let c = 2; c <= 1 + exportProductsLocal.length * perProdCols; c++) {
          ws.getCell(r, c).numFmt = '"$"#,##0';
        }
      }
      ws.getColumn(1).width = 28;
      for (let c = 2; c <= 1 + exportProductsLocal.length * perProdCols; c++) ws.getColumn(c).width = 16;
    };

    const rollupBy = (key: "flm" | "slm"): Row[] => {
      const map = new Map<string, Row>();
      const order: string[] = [];
      for (const e of perRepRows) {
        const rawKey = key === "flm" ? e.flm : e.slm;
        const k = (rawKey || "(unassigned)").trim() || "(unassigned)";
        let existing = map.get(k);
        if (!existing) {
          const pp: Record<string, PerProductExport> = {};
          for (const prod of ALL_PRODUCTS) pp[prod] = emptyPerProduct();
          existing = { name: k, perProduct: pp };
          map.set(k, existing); order.push(k);
        }
        for (const prod of ALL_PRODUCTS) {
          const src = e.perProduct[prod]; if (!src) continue;
          const dst = existing.perProduct[prod];
          dst.goal += src.goal; dst.mrr += src.mrr; dst.mrrAdded += src.mrrAdded;
          dst.mrrAddedGoal += src.mrrAddedGoal; dst.churn += src.churn;
          dst.churnGoal += src.churnGoal; dst.weighted += src.weighted;
          dst.churnBooked += src.churnBooked; dst.churnWeighted += src.churnWeighted;
          dst.unweightedOpen += src.unweightedOpen || 0;
        }
      }
      return order.map(k => map.get(k)!);
    };

    const repRows: Row[] = perRepRows.map(({ name, perProduct }) => ({ name, perProduct }));
    if (isRep) buildSheet("Rep", repRows);
    else if (isFlm) { buildSheet("Rep", repRows); buildSheet("FLM", rollupBy("flm")); }
    else { buildSheet("Rep", repRows); buildSheet("FLM", rollupBy("flm")); buildSheet("SLM", rollupBy("slm")); }
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const today = new Date();
    const fname = `forecast-${mode}-${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}.xlsx`;
    const a = document.createElement("a");
    a.href = url; a.download = fname; document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }, [authUser, mrrMode, filters, pipelineMode, processedData]);

  // Task #192: per-rep GNR forecast export (CSV + XLSX). Emits one row per
  // rep with SLM / FLM / Rep and 16 product columns (4 products × 2 metrics
  // × weighted+unweighted). XLSX uses Excel native row outline grouped
  // SLM→FLM→Rep with SUM subtotal formulas. Both formats include a
  // filters-summary preamble so the file documents its own scope.
  const exportPerRepForecast = useCallback(async (format: "csv" | "xlsx") => {
    if (!processedData) return;
    const FORECAST_PRODUCTS = ["MBP", "Showcase", "Zillow Pro", "Follow Up Boss"] as const;
    type PP = {
      mrr: number; mrrAdded: number; weighted: number; unweightedOpen: number;
      churnBooked: number; churnWeighted: number;
    };
    const perRepRows = processedData.perRepBreakdownsForExport;

    type FlatRow = { slm: string; flm: string; rep: string; values: number[] };
    const flatRows: FlatRow[] = perRepRows.map((e) => {
      const values: number[] = [];
      for (const prod of FORECAST_PRODUCTS) {
        const pp = (e.perProduct[prod] || {}) as Partial<PP>;
        // Weighted MRR forecast = pp.weighted alone (sumWeightedForProd
        // already spans ALL_WEIGHTED_STAGES including Closed Won, and
        // matches the popup BAN's per-product `allProductQuotas[i].weighted`).
        // Unweighted MRR forecast = raw Closed Won (pp.mrr) + raw open
        // pipeline across active stages (pp.unweightedOpen).
        const mrrW = pp.weighted || 0;
        const mrrU = (pp.mrr || 0) + (pp.unweightedOpen || 0);
        // Churn values are stored as positive magnitudes upstream; emit as
        // negative so MRR Added vs Churn carry opposite signs in the export.
        const chW = -(pp.churnWeighted || 0);
        const chU = -(pp.churnBooked || 0);
        values.push(mrrW, mrrU, chW, chU);
      }
      return {
        slm: (e.slm || "(unassigned)").trim() || "(unassigned)",
        flm: (e.flm || "(unassigned)").trim() || "(unassigned)",
        rep: e.name,
        values,
      };
    });
    flatRows.sort((a, b) => a.slm.localeCompare(b.slm) || a.flm.localeCompare(b.flm) || a.rep.localeCompare(b.rep));

    const valueHeaders: string[] = [];
    for (const prod of FORECAST_PRODUCTS) {
      const prodLabel = displayProduct(prod);
      valueHeaders.push(
        `${prodLabel} MRR Added Forecast (Weighted)`,
        `${prodLabel} MRR Added Forecast (Unweighted)`,
        `${prodLabel} Churn Forecast (Weighted)`,
        `${prodLabel} Churn Forecast (Unweighted)`,
      );
    }
    const numValueCols = valueHeaders.length;

    const fmtFilterList = (v: string[] | undefined | null): string =>
      v && v.length ? v.join(", ") : "All";
    const fmtFilterScalar = (v: string | undefined | null): string =>
      v && v.trim() && v !== "All Channels" ? v : "All";
    const preamble: [string, string][] = [
      ["Exported", formatLongDate(new Date())],
      ["Dashboard", mrrMode === "acqNet" ? "ACQ" : "G&R"],
      ["MRR Mode", String(mrrMode)],
      ["Pipeline Mode", pipelineMode === "allOpen" ? "All Open" : "Close Date"],
      ["Timeframe", String(filters.timeframe || "")],
      ["Mods Date Range", `${modsStart}${modsExtend === "plus30" ? " + 30d" : ""}`],
      ["Products", filters.products && filters.products.length ? filters.products.map(displayProduct).join(", ") : "All"],
      ["SLM", fmtFilterList(filters.slm)],
      ["FLM", fmtFilterList(filters.flm)],
      ["Rep", fmtFilterList(filters.rep)],
      ["Region", fmtFilterList(filters.region)],
      ["Segment", fmtFilterList(filters.segment)],
      ["Channel", fmtFilterScalar(filters.group)],
      ["Reps In Scope", String(flatRows.length)],
    ];

    const today = new Date();
    const dateStamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const triggerDownload = (blob: Blob, ext: string) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gnr-forecast-per-rep-${dateStamp}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    if (format === "csv") {
      const escape = (v: string | number): string => {
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines: string[] = [];
      for (const [k, v] of preamble) lines.push(`# ${escape(k)},${escape(v)}`);
      lines.push("");
      lines.push(["SLM", "FLM", "Rep", ...valueHeaders].map(escape).join(","));
      for (const row of flatRows) {
        lines.push([row.slm, row.flm, row.rep, ...row.values].map(escape).join(","));
      }
      const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
      triggerDownload(blob, "csv");
      return;
    }

    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Per-Rep Forecast");
    // Parent rows render ABOVE their children. Full outline hierarchy is
    // declared via outlineLevelRow=2 (SLM=0 / FLM=1 / Rep=2); the workbook
    // opens collapsed to SLM via per-row `hidden`+`collapsed` flags set
    // below (children hidden, SLM parents marked collapsed).
    ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
    ws.properties.outlineLevelRow = 2;

    for (const [k, v] of preamble) {
      const r = ws.addRow([k, v]);
      r.getCell(1).font = { bold: true };
    }
    ws.addRow([]);

    const headerRow = ws.addRow(["SLM", "FLM", "Rep", ...valueHeaders]);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: "middle", wrapText: true };
    headerRow.height = 30;

    // Group reps by SLM → FLM.
    type RepGroup = Map<string, FlatRow[]>;
    const bySlm = new Map<string, RepGroup>();
    const slmOrder: string[] = [];
    for (const r of flatRows) {
      if (!bySlm.has(r.slm)) { bySlm.set(r.slm, new Map()); slmOrder.push(r.slm); }
      const flmMap = bySlm.get(r.slm)!;
      if (!flmMap.has(r.flm)) flmMap.set(r.flm, []);
      flmMap.get(r.flm)!.push(r);
    }

    const colLetter = (idx1: number): string => {
      let n = idx1; let s = "";
      while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
      return s;
    };
    const firstValCol = 4; // SLM(1), FLM(2), Rep(3), values start at 4
    const lastValCol = firstValCol + numValueCols - 1;

    const formulaCell = (formula: string): CellFormulaValue => ({
      formula,
      date1904: false,
    });

    for (const slm of slmOrder) {
      const slmRowIdx = ws.rowCount + 1;
      // Placeholder; we'll fill SUM formulas after FLM rows are written.
      const slmRow = ws.addRow([slm, "", "", ...new Array(numValueCols).fill(0)]);
      slmRow.outlineLevel = 0;
      slmRow.font = { bold: true };
      slmRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
      // Note: exceljs Row.collapsed is read-only at runtime; the collapsed
      // visual state is produced by hiding child FLM/Rep rows below.

      const flmMap = bySlm.get(slm)!;
      const flmSummaryRowIdxs: number[] = [];
      for (const [flm, reps] of flmMap.entries()) {
        const flmRowIdx = ws.rowCount + 1;
        const flmRow = ws.addRow([slm, flm, "", ...new Array(numValueCols).fill(0)]);
        flmRow.outlineLevel = 1;
        flmRow.font = { bold: true };
        flmRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
        flmRow.hidden = true;
        flmSummaryRowIdxs.push(flmRowIdx);

        const repFirstIdx = ws.rowCount + 1;
        for (const rep of reps) {
          const row = ws.addRow([slm, flm, rep.rep, ...rep.values]);
          row.outlineLevel = 2;
          row.hidden = true;
        }
        const repLastIdx = ws.rowCount;
        // Fill FLM subtotal formulas summing child rep rows.
        if (repLastIdx >= repFirstIdx) {
          for (let c = firstValCol; c <= lastValCol; c++) {
            const L = colLetter(c);
            ws.getCell(flmRowIdx, c).value = formulaCell(`SUM(${L}${repFirstIdx}:${L}${repLastIdx})`);
          }
        }
      }
      // SLM subtotal sums its FLM summary rows (one cell per FLM, per column).
      if (flmSummaryRowIdxs.length > 0) {
        for (let c = firstValCol; c <= lastValCol; c++) {
          const L = colLetter(c);
          const refs = flmSummaryRowIdxs.map((idx) => `${L}${idx}`).join(",");
          ws.getCell(slmRowIdx, c).value = formulaCell(`SUM(${refs})`);
        }
      }
    }

    // Raw numeric format (no currency symbol) per spec, negatives in red.
    for (let c = firstValCol; c <= lastValCol; c++) {
      ws.getColumn(c).numFmt = '#,##0;[Red]-#,##0';
      ws.getColumn(c).width = 22;
    }
    ws.getColumn(1).width = 22;
    ws.getColumn(2).width = 22;
    ws.getColumn(3).width = 24;

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    triggerDownload(blob, "xlsx");
  }, [filters, mrrMode, pipelineMode, processedData, modsStart, modsExtend]);

  if (loading || !processedData) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <Card key={i} className="no-shadow">
            <CardContent className="p-6">
              <Skeleton className="h-4 w-1/2 mb-4" />
              <Skeleton className="h-48 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const { funnelChartData, funnelChartDataGross, totalGoal, totalMrr, totalMrrForQuota, repMrr, repChurn, repMods, weightedData, totalWeighted, modsRow, displayProducts, allProductQuotas, activeProductSet, activeTotalGoal, activeTotalGoalRemaining, activeTotalGoalPerRepSum, productGoalsRemaining, activeTotalMrrForQuota, activeTotalWeighted, grossProductSplit, isWindowedRemaining, mrrAddedAggregatedGoalBreakdown, churnAggregatedGoalBreakdown, grossProductGoalBreakdowns, repBreakdowns, forecastRepBreakdowns, effectiveQuotaMode, quotaWindow } = processedData;
  const isMultiProduct = displayProducts.length > 1;
  // Task #182: lift bizday-calendar helpers (formatYm, calendarFilter,
  // today vars, renderCalendar) to component scope so the GnR Goal-card
  // branch can reuse renderCalendar for both MRR Added and Churn.
  type GoalBreakdownEntry = {
    ymKey: string;
    monthlyGoal: number;
    goalInWindow: number;
    closed: number;
    factor: number;
    contribution: number;
    bizdaysInMonth: number;
    bizdaysInWindow: number;
    pacingFactor: number;
    isCurrentMonth: boolean;
    isPastMonth: boolean;
    closedByDay: Record<number, number>;
  };
  const formatYm = (ym: string) => {
    const [y, m] = ym.split("-").map(n => parseInt(n, 10));
    if (!y || !m) return ym;
    return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short", year: "numeric" });
  };
  const _tf_cal = filters.timeframe as string;
  const calendarFilter: "MTD" | "EOM" | "ThisMonth" =
    _tf_cal === "mtd" ? "ThisMonth"
      : _tf_cal === "mtd2date" ? "MTD"
      : _tf_cal === "eom" ? "EOM"
      : _tf_cal === "qtd" || _tf_cal === "ytd" || _tf_cal === "all" ? "MTD"
      : "ThisMonth";
  const todayPst = getTodayPST();
  const todayDay = todayPst.getDate();
  const todayMonth = todayPst.getMonth();
  const todayYear = todayPst.getFullYear();
  const renderCalendar = (e: GoalBreakdownEntry, calendarLabel?: string, overrideClosed?: number): React.JSX.Element | null => {
    if (!e.isCurrentMonth) return null;
    const [yStr, mStr] = e.ymKey.split("-");
    const y = parseInt(yStr, 10);
    const m = parseInt(mStr, 10) - 1;
    const isPacing = effectiveQuotaMode === "pacing";
    const monthBizdays = e.bizdaysInMonth;
    const monthlyGoal = e.monthlyGoal;
    // Prefer the BAN's "Closed" value (overrideClosed) when provided so the
    // popup's Remaining / catch-up math reconciles to the card BAN exactly.
    // e.closed is sourced from the server's productCwDaysByMonth bucket and
    // can diverge from pfAdded by a small amount on certain CW rows; passing
    // the BAN-side total in keeps the table + footer numbers self-consistent.
    const closed = overrideClosed !== undefined ? overrideClosed : e.closed;
    // Task #182: GnR Churn goals are negative (e.g. -$5K). All target /
    // pacing / footer math should be computed in magnitudes so the
    // calendar shows positive "$X needed/bizday" targets and positive
    // catch-up amounts. Negative actuals are still colorized red via the
    // raw signed `closedByDay` value — that path stays unchanged.
    const goalMag = Math.abs(monthlyGoal);
    const closedMag = Math.abs(closed);
    const paceTargetPerDay = monthBizdays > 0 ? goalMag / monthBizdays : 0;
    const buildLAgg = (): { L: Record<number, number>; bizdaysOfMonthList: number[] } => {
      const monthEnd2 = new Date(y, m + 1, 0);
      const list: number[] = [];
      const cur = new Date(y, m, 1);
      while (cur <= monthEnd2) {
        if (isBusinessDay(cur, holidaySet)) list.push(cur.getDate());
        cur.setDate(cur.getDate() + 1);
      }
      const N = list.length;
      const absG = Math.abs(monthlyGoal);
      const H = N > 0 ? absG / N : 0;
      const Lm: Record<number, number> = {};
      if (N === 0) return { L: Lm, bizdaysOfMonthList: list };
      let cum = 0;
      let prevK = 0;
      const cbd2 = e.closedByDay || {};
      for (let i = 0; i < N; i++) {
        const dom = list[i];
        const remIncl = N - i;
        Lm[dom] = i === 0 ? H : H - prevK / remIncl;
        cum += Math.abs(cbd2[dom] || 0);
        prevK = cum - H * (i + 1);
      }
      return { L: Lm, bizdaysOfMonthList: list };
    };
    const lookupL = (Lmap: Record<number, number>, list: number[], anchorDay: number): number => {
      if (list.length === 0) return 0;
      for (const d of list) if (d >= anchorDay) return Lmap[d] || 0;
      return Lmap[list[list.length - 1]] || 0;
    };
    let flatLTarget = 0;
    if (!isPacing) {
      const { L: Lmap, bizdaysOfMonthList } = buildLAgg();
      flatLTarget = lookupL(Lmap, bizdaysOfMonthList, todayDay);
    }
    let bizdaysRem = 0;
    const monthEnd = new Date(y, m + 1, 0);
    {
      const d = new Date(y, m, todayDay);
      while (d <= monthEnd) {
        if (isBusinessDay(d, holidaySet)) bizdaysRem++;
        d.setDate(d.getDate() + 1);
      }
    }
    const gap = goalMag - closedMag;
    const catchUpPerDay = bizdaysRem > 0 ? Math.max(0, gap) / bizdaysRem : 0;
    const H_L = monthBizdays > 0 ? goalMag / monthBizdays : 0;
    let cumCW_L = 0;
    for (let dL = 1; dL < todayDay; dL++) cumCW_L += Math.abs((e.closedByDay || {})[dL] || 0);
    let cumBizdaysBefore_L = 0;
    {
      const dL = new Date(y, m, 1);
      const todayDateL = new Date(y, m, todayDay);
      while (dL < todayDateL) {
        if (isBusinessDay(dL, holidaySet)) cumBizdaysBefore_L++;
        dL.setDate(dL.getDate() + 1);
      }
    }
    const K_yesterday_L = cumCW_L - H_L * cumBizdaysBefore_L;
    const L_today_flat = bizdaysRem > 0 ? H_L - K_yesterday_L / bizdaysRem : H_L;
    const firstDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    type CalCell = {
      kind: "blank" | "weekend" | "holiday" | "bizday";
      day?: number;
      amount?: number;
      amountKind?: "actual" | "target";
      isToday?: boolean;
      isPast?: boolean;
      isFuture?: boolean;
      inSelectedWindow?: boolean;
      holidayLabel?: string;
    };
    const filterRange = getDateRange(filters.timeframe, filters.customRange);
    let filterFrom = filterRange.from ? new Date(filterRange.from + "T00:00:00") : null;
    let filterTo = filterRange.to ? new Date(filterRange.to + "T00:00:00") : null;
    // Task #183: When the user picked "This Week", highlight all 7 days of
    // the calendar week (Sun→Sat) regardless of the snapped today→weekEnd
    // actuals window. The goal math + actuals continue to use the snapped
    // window — only the calendar's blue highlight ring is widened.
    if (selectedTimeframe === "thisWeek") {
      const wkStart = new Date(todayPst.getFullYear(), todayPst.getMonth(), todayPst.getDate() - todayPst.getDay());
      const wkEnd = new Date(wkStart.getFullYear(), wkStart.getMonth(), wkStart.getDate() + 6);
      filterFrom = wkStart;
      filterTo = wkEnd;
    }
    const inFilterWindow = (dt: Date): boolean => {
      if (!filterFrom || !filterTo) return false;
      return dt >= filterFrom && dt <= filterTo;
    };
    const cells: CalCell[] = [];
    const closedByDay = e.closedByDay || {};
    for (let i = 0; i < firstDow; i++) cells.push({ kind: "blank" });
    for (let d = 1; d <= daysInMonth; d++) {
      const dt = new Date(y, m, d);
      const dow = dt.getDay();
      const ymd = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const isHol = holidaySet.has(ymd);
      const inSel = inFilterWindow(dt);
      const dayActualWk = closedByDay[d] || 0;
      if (dow === 0 || dow === 6) {
        cells.push({ kind: "weekend", day: d, amount: dayActualWk !== 0 ? dayActualWk : undefined, amountKind: "actual", inSelectedWindow: inSel });
        continue;
      }
      if (isHol) {
        const label = holidayNameMap?.get(ymd) || "Holiday";
        cells.push({ kind: "holiday", day: d, holidayLabel: label, amount: dayActualWk !== 0 ? dayActualWk : undefined, amountKind: "actual", inSelectedWindow: inSel });
        continue;
      }
      const isToday = d === todayDay && m === todayMonth && y === todayYear;
      const isPast = !isToday && (
        y < todayYear ||
        (y === todayYear && m < todayMonth) ||
        (y === todayYear && m === todayMonth && d < todayDay)
      );
      const isFuture = !isToday && !isPast;
      const dayActual = closedByDay[d] || 0;
      let amount: number | undefined = undefined;
      let amountKind: "actual" | "target" | undefined = undefined;
      if (isPacing) {
        if (calendarFilter === "EOM") {
          if (!isPast) { amount = paceTargetPerDay; amountKind = "target"; }
        } else {
          if (isPast || isToday) {
            if (dayActual !== 0) { amount = dayActual; amountKind = "actual"; }
          } else {
            amount = paceTargetPerDay; amountKind = "target";
          }
        }
      } else {
        if (calendarFilter === "MTD") {
          if ((isPast || isToday) && dayActual !== 0) {
            amount = dayActual; amountKind = "actual";
          }
        } else {
          if (isPast) {
            if (dayActual !== 0) { amount = dayActual; amountKind = "actual"; }
          } else {
            // Future bizday: show the catch-up rate (gap ÷ remaining bizdays)
            // so the cell matches the footer lines below. The flat monthly
            // pace target is intentionally ignored per user direction.
            amount = catchUpPerDay; amountKind = "target";
          }
        }
      }
      cells.push({ kind: "bizday", day: d, amount, amountKind, isToday, isPast, isFuture, inSelectedWindow: inSel });
    }
    while (cells.length % 7 !== 0) cells.push({ kind: "blank" });
    const dowLabels = ["S", "M", "T", "W", "T", "F", "S"];
    const fmtCell = (n?: number) => {
      if (n === undefined) return "";
      if (Math.abs(n) >= 1000) return `${n < 0 ? "-" : ""}$${(Math.abs(n) / 1000).toFixed(1)}K`;
      return `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n))}`;
    };
    return (
      <div className="mt-2 pt-2 border-t border-gray-100">
        <div className="text-[9.5px] uppercase tracking-wider text-[#94a3b8] font-semibold mb-1">
          {calendarLabel || `${formatYm(e.ymKey)} bizday calendar · ${isPacing ? "pace target" : "catch-up rate"}`}
        </div>
        <div className="grid grid-cols-7 gap-px text-[8.5px]">
          {dowLabels.map((l, i) => (
            <div key={`dow-${i}`} className="text-[#94a3b8] text-center font-medium pb-0.5">{l}</div>
          ))}
          {cells.map((c, i) => {
            if (c.kind === "blank") return <div key={i} className="h-7" />;
            const selRing = c.inSelectedWindow && !c.isToday ? "ring-1 ring-sky-300 bg-sky-100" : "";
            if (c.kind === "weekend") {
              return (
                <div key={i} className={`h-7 bg-gray-50 text-gray-300 rounded-sm flex flex-col items-center justify-center px-0.5 ${selRing}`}>
                  <span className="text-[7.5px] leading-none">{c.day}</span>
                  {c.amount !== undefined && <span className={`text-[8px] leading-none tabular-nums font-medium ${c.amount < 0 ? "text-red-600" : "text-emerald-700"}`}>{fmtCell(c.amount)}</span>}
                </div>
              );
            }
            if (c.kind === "holiday") {
              const shortLabel = (c.holidayLabel || "Holiday")
                .replace(/\s*Day\b/, "")
                .replace(/Memorial/, "Mem")
                .replace(/Independence/, "Ind")
                .replace(/Thanksgiving/, "Thx")
                .replace(/Christmas/, "Xmas")
                .replace(/Veterans/, "Vet")
                .replace(/Columbus/, "Col")
                .replace(/Presidents'?/, "Pres")
                .replace(/Martin Luther King(, Jr\.?)?/, "MLK")
                .replace(/New Year'?s?/, "NYD")
                .replace(/Labor/, "Lab")
                .slice(0, 5);
              return (
                <div key={i} className={`h-7 bg-gray-100 text-gray-400 rounded-sm flex flex-col items-center justify-center px-0.5 ${selRing}`} title={c.holidayLabel}>
                  {c.amount !== undefined ? (
                    <>
                      <span className="text-[7px] leading-none">{c.day}</span>
                      <span className="text-[8px] leading-none tabular-nums font-medium text-red-600">{fmtCell(c.amount)}</span>
                      <span className="text-[6px] leading-none text-gray-400">{shortLabel}</span>
                    </>
                  ) : (
                    <>
                      <span className="text-[8px] leading-none">{c.day}</span>
                      <span className="text-[6.5px] leading-none">{shortLabel}</span>
                    </>
                  )}
                </div>
              );
            }
            const todayCls = c.isToday
              ? "ring-1 ring-amber-500 bg-amber-50"
              : (c.inSelectedWindow
                ? "ring-1 ring-sky-300 bg-sky-100"
                : (c.isPast ? "bg-white text-gray-400" : "bg-blue-50/60"));
            const amountCls = c.amountKind === "actual"
              ? ((c.amount ?? 0) < 0 ? "text-red-600" : "text-emerald-700")
              : "text-[#0f172a]";
            return (
              <div key={i} className={`h-7 ${todayCls} rounded-sm flex flex-col items-center justify-center px-0.5`}>
                <span className="text-[7.5px] leading-none text-[#64748b]">{c.day}</span>
                {c.amount !== undefined && <span className={`text-[8px] leading-none tabular-nums font-medium ${amountCls}`}>{fmtCell(c.amount)}</span>}
              </div>
            );
          })}
        </div>
        {!isPacing && (calendarFilter === "EOM" || calendarFilter === "ThisMonth") && bizdaysRem > 0 && (
          <div className="text-[9.5px] text-[#475569] mt-1">
            Need <span className="font-semibold">{fmtCell(catchUpPerDay)}/bizday</span> for next {bizdaysRem} bizdays to hit month goal.
          </div>
        )}
        {!isPacing && filterTo && filterTo < monthEnd && (() => {
          // Sum the catch-up rate across the remaining bizdays inside the
          // selected timeframe (today through min(filterTo, monthEnd)). Uses
          // catchUpPerDay (gap ÷ remaining bizdays) so cells and footer all
          // reconcile to the same number.
          const windowEnd = filterTo < monthEnd ? filterTo : monthEnd;
          let bizdaysToWindowEnd = 0;
          const dW = new Date(y, m, todayDay);
          while (dW <= windowEnd) {
            if (isBusinessDay(dW, holidaySet)) bizdaysToWindowEnd++;
            dW.setDate(dW.getDate() + 1);
          }
          if (bizdaysToWindowEnd <= 0) return null;
          const amt = catchUpPerDay * bizdaysToWindowEnd;
          if (amt <= 0) return null;
          const monthShort = windowEnd.toLocaleDateString("en-US", { month: "short" });
          const dayStr = String(windowEnd.getDate()).padStart(2, "0");
          return (
            <div className="text-[9.5px] text-[#475569] mt-0.5">
              Need <span className="font-semibold">{fmtCell(amt)}</span> by <span className="font-semibold">{monthShort}-{dayStr}</span> to pace.
            </div>
          );
        })()}
        {isPacing && (
          <div className="text-[9.5px] text-[#475569] mt-1">
            Daily catch-up rate = <span className="font-semibold">{fmtCell(catchUpPerDay)}/bizday</span> (gap ÷ {bizdaysRem} remaining bizdays).
          </div>
        )}
      </div>
    );
  };
  // Task #182: lifted renderProrationSection (table + footer + calendar)
  // and renderProrationTooltip (the TooltipContent wrapper). Splitting
  // them lets the GnR Both-mode tooltip render two full sections inside
  // a single TooltipContent, while non-GnR / GnR single-mode keep the
  // existing one-section-per-popup wrapper.
  const renderProrationSection = (
    entries: GoalBreakdownEntry[],
    displayedGoal: number,
    opts?: { perRepSum?: number; isAggregate?: boolean; productName?: string; sectionTitle?: string; overrideClosed?: number },
  ): React.JSX.Element => {
    const overrideClosed = opts?.overrideClosed;
    // GNR gross goals now share ACQ's Remaining/Pacing semantics (Task #195
    // reverted by user request), so the tooltip simply mirrors the active
    // quota mode — no per-call override needed.
    const isPacing = effectiveQuotaMode === "pacing";
    const currentEntry = entries.find(en => en.isCurrentMonth);
    const productLabel = opts?.productName || (opts?.isAggregate ? "Aggregate" : "Prorated Goal");
    const headerText = opts?.sectionTitle || (isPacing
      ? `${productLabel} Prorated Pacing Goal`
      : `${productLabel} Prorated Remaining Goal`);
    const formula = isPacing
      ? "Pacing Goal = Monthly Goal × (Biz days in Window ÷ Biz days in month)"
      : "Daily MRR to hit goal.";
    const totalPaceGoal = entries.reduce(
      (s, e) => s + (e.bizdaysInMonth > 0 ? e.monthlyGoal * (e.bizdaysInWindow / e.bizdaysInMonth) : 0),
      0,
    );
    // Row display helper: when overrideClosed is supplied, swap in the BAN
    // value on the current-month row so Closed / Remaining columns match
    // the card's BAN exactly (other months keep their server-bucketed value).
    const closedForRow = (e: GoalBreakdownEntry) =>
      overrideClosed !== undefined && e.isCurrentMonth ? overrideClosed : e.closed;
    return (
      <div>
        <div className="flex items-baseline justify-between gap-3 mb-1">
          <div className="font-semibold text-[12px]">{displayProductText(headerText)}</div>
          <div className={`text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${isPacing ? "bg-blue-50 text-blue-700" : "bg-purple-50 text-purple-700"}`}>{isPacing ? "Pacing" : "Remaining"}</div>
        </div>
        <div className="text-[10px] text-[#64748b] mb-1.5">{formula}</div>
        {entries.length === 0 ? (
          <div className="text-[#64748b]">No proration applied.</div>
        ) : isPacing ? (
          <table className="w-full text-[10.5px] border-collapse">
            <thead>
              <tr className="text-[#94a3b8] text-[9.5px] uppercase tracking-wide">
                <th className="text-left font-medium pr-2">Month</th>
                <th className="text-right font-medium pr-2">Bizdays</th>
                <th className="text-right font-medium pr-2">M Goal</th>
                <th className="text-right font-medium pr-2">D Goal</th>
                <th className="text-right font-medium pr-2">Closed</th>
                <th className="text-right font-medium">Pace Goal</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => {
                const dGoal = e.bizdaysInMonth > 0 ? e.monthlyGoal / e.bizdaysInMonth : 0;
                const paceGoal = e.bizdaysInMonth > 0
                  ? e.monthlyGoal * (e.bizdaysInWindow / e.bizdaysInMonth)
                  : 0;
                const ringClass = e.isCurrentMonth ? "bg-amber-50" : "";
                return (
                  <tr key={e.ymKey} className={`border-t border-gray-50 ${ringClass}`}>
                    <td className="py-0.5 pr-2 text-[#475569]">
                      {formatYm(e.ymKey)}
                      {e.isCurrentMonth && <span className="ml-1 text-[9px] text-amber-700">(now)</span>}
                    </td>
                    <td className="py-0.5 pr-2 text-right tabular-nums text-[#64748b]">{e.bizdaysInWindow}/{e.bizdaysInMonth}</td>
                    <td className="py-0.5 pr-2 text-right tabular-nums">{formatCurrency(e.monthlyGoal)}</td>
                    <td className="py-0.5 pr-2 text-right tabular-nums text-[#64748b]">{formatCurrency(dGoal)}</td>
                    <td className="py-0.5 pr-2 text-right tabular-nums text-[#64748b]">{formatCurrency(closedForRow(e))}</td>
                    <td className="py-0.5 text-right tabular-nums font-medium">{formatCurrency(paceGoal)}</td>
                  </tr>
                );
              })}
              <tr className="border-t border-gray-200 font-semibold">
                <td className="py-0.5 pr-2 text-[#475569] uppercase text-[9.5px] tracking-wide">Total</td>
                <td className="py-0.5 pr-2"></td>
                <td className="py-0.5 pr-2"></td>
                <td className="py-0.5 pr-2"></td>
                <td className="py-0.5 pr-2"></td>
                <td className="py-0.5 text-right tabular-nums">{formatCurrency(totalPaceGoal)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <table className="w-full text-[10.5px] border-collapse">
            <thead>
              <tr className="text-[#94a3b8] text-[9.5px] uppercase tracking-wide">
                <th className="text-left font-medium pr-2">Month</th>
                <th className="text-right font-medium pr-2">Bizdays</th>
                <th className="text-right font-medium pr-2">Goal</th>
                <th className="text-right font-medium pr-2">Closed</th>
                <th className="text-right font-medium">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => {
                // "Goal" column always shows the full monthly goal; "Remaining"
                // is the headroom left to hit it (monthly goal − closed so
                // far). Window/proration affects the BAN goal value above, not
                // the per-month row figures here.
                const closedShown = closedForRow(e);
                const remainingShown = e.monthlyGoal - closedShown;
                const ringClass = e.isCurrentMonth ? "bg-amber-50" : "";
                return (
                  <tr key={e.ymKey} className={`border-t border-gray-50 ${ringClass}`}>
                    <td className="py-0.5 pr-2 text-[#475569]">
                      {formatYm(e.ymKey)}
                      {e.isCurrentMonth && <span className="ml-1 text-[9px] text-amber-700">(now)</span>}
                    </td>
                    <td className="py-0.5 pr-2 text-right tabular-nums text-[#64748b]">{e.bizdaysInWindow}/{e.bizdaysInMonth}</td>
                    <td className="py-0.5 pr-2 text-right tabular-nums">{formatCurrency(e.monthlyGoal)}</td>
                    <td className="py-0.5 pr-2 text-right tabular-nums text-[#64748b]">{formatCurrency(closedShown)}</td>
                    <td className="py-0.5 text-right tabular-nums font-medium">{formatCurrency(remainingShown)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {(() => {
          const tipRange = getDateRange(filters.timeframe, filters.customRange);
          const tipFrom = tipRange.from ? new Date(tipRange.from + "T00:00:00") : null;
          const tipTo = tipRange.to ? new Date(tipRange.to + "T00:00:00") : null;
          const fmtMmDd = (d: Date) => {
            const ms = d.toLocaleDateString("en-US", { month: "short" });
            const ds = String(d.getDate()).padStart(2, "0");
            return `${ms}-${ds}`;
          };
          const label = isPacing
            ? "Displayed goal (pacing):"
            : (tipFrom && tipTo
                ? `${fmtMmDd(tipFrom)} - ${fmtMmDd(tipTo)} MRR to hit month goal:`
                : "MRR to hit month goal:");
          return (
            <div className="text-[#64748b] mt-1.5 pt-1.5 border-t border-gray-100 flex items-center justify-between gap-3">
              <span>{label}</span>
              <span className="font-semibold text-[#0f172a] text-[12px]">{formatCurrency(displayedGoal)}</span>
            </div>
          );
        })()}
        {isPacing && opts?.isAggregate && (
          <div className="mt-1.5 pt-1.5 border-t border-gray-100 text-[10px] text-blue-800 bg-blue-50 -mx-1 px-1.5 py-1 rounded">
            <span className="font-semibold">Forecast note:</span> the Forecast card always uses Remaining-mode goal regardless of this toggle.
          </div>
        )}
        {currentEntry && renderCalendar(currentEntry, undefined, overrideClosed)}
      </div>
    );
  };
  const renderProrationTooltip = (
    title: string,
    entries: GoalBreakdownEntry[],
    displayedGoal: number,
    opts?: { perRepSum?: number; isAggregate?: boolean; productName?: string; overrideClosed?: number },
  ): React.JSX.Element => (
    <TooltipContent
      side="top"
      sideOffset={6}
      className="bg-white border border-gray-200 text-[#0f172a] shadow-md p-2.5 rounded text-[11px] leading-tight max-w-[460px]"
    >
      {renderProrationSection(entries, displayedGoal, opts)}
    </TooltipContent>
  );
  // Task #476: the Pipeline Funnel's Gross/Net toggle is a derived 2-state view
  // of the shared quotaGrossMetric, shown only where the Goal/Forecast
  // Both/MRR/Churn/Net toggle appears (G&R Channel + grossProductSplit). In
  // Gross the funnel excludes negative-MRR opps by sourcing the positives-only
  // (funnelAdded) aggregates; in Net it shows everything (current behavior).
  const funnelGrossToggleVisible = mrrMode === "gnrNet" && grossProductSplit;
  const funnelGrossActive = funnelGrossToggleVisible && quotaGrossMetric !== "net";
  const effectiveFunnelChartData = funnelGrossActive ? funnelChartDataGross : funnelChartData;
  const activeFunnelData = effectiveFunnelChartData.filter(d => d.name !== "Closed Lost");
  const closedLostData = effectiveFunnelChartData.find(d => d.name === "Closed Lost");
  const maxActiveFunnelVal = Math.max(...activeFunnelData.map(d => d.total), 1);
  const activeFunnelTotalMrr = activeFunnelData.reduce((s, d) => s + (d.total || 0), 0);

  const isNegativeQuota = activeTotalGoal < 0;
  const quotaPct = activeTotalGoal !== 0
    ? (isNegativeQuota
        ? 100 + ((activeTotalMrrForQuota - activeTotalGoal) / Math.abs(activeTotalGoal)) * 100
        : (activeTotalMrrForQuota / activeTotalGoal) * 100)
    : 0;
  let quotaColor = "#EF4444";
  if (quotaPct >= 80) quotaColor = "#00C49F";
  else if (quotaPct >= 50) quotaColor = "#FF6B35";

  const quotaExceeded = isNegativeQuota
    ? activeTotalMrrForQuota > activeTotalGoal && activeTotalGoal !== 0
    : activeTotalMrrForQuota >= activeTotalGoal && activeTotalGoal > 0;
  const exceedAmt = Math.abs(activeTotalMrrForQuota - activeTotalGoal);
  const remainingToHit = isNegativeQuota
    ? Math.max(0, activeTotalGoal - activeTotalMrrForQuota)
    : Math.max(0, activeTotalGoal - activeTotalMrrForQuota);
  
  const forecastAmt = activeTotalWeighted;
  // Task #162: Forecast card always uses Remaining-mode goal so
  // forecastPct/coverage/winRateToHit are toggle-invariant.
  const forecastGoal = prorateQuota ? activeTotalGoalRemaining : activeTotalGoal;
  const forecastRemaining = Math.max(0, forecastGoal - activeTotalMrrForQuota);
  const forecastPct = forecastGoal !== 0 ? (forecastAmt / Math.abs(forecastGoal)) * 100 : 0;

  // Task #162: Forecast must stay invariant across the Pacing/Remaining
  // toggle. Use a forecast-specific exceeded check derived from
  // `forecastGoal` (which is hard-wired to the Remaining-mode goal when
  // proration is on), not `quotaExceeded` which is computed from the
  // toggle-dependent `activeTotalGoal`.
  const forecastExceeded = isNegativeQuota
    ? activeTotalMrrForQuota > forecastGoal && forecastGoal !== 0
    : forecastRemaining <= 0 && forecastGoal > 0;
  const winRateToHit = !forecastExceeded && activeTotalWeighted > 0 ? (forecastRemaining / activeTotalWeighted) * 100 : 0;
  const coverage = forecastGoal !== 0 ? (activeTotalWeighted / Math.abs(forecastGoal)) : 0;
  const isAcqNet = mrrMode === "acqNet";
  // Task #448: the Forecast card renders the net (ACQ-style, MRR-only) block
  // both for ACQ MRR mode AND for the G&R Net "Net" sub-view. The gross G&R
  // dual block (MRR + Churn) renders for the Both/MRR/Churn sub-views.
  // Falls back to the net block when no gross per-product split exists (G&R Net
  // with a non-aggregate preset) so the Forecast card stays consistent with the
  // Goal card, which renders its net branch in exactly that case.
  const forecastShowNet = isAcqNet || (mrrMode === "gnrNet" && (quotaGrossMetric === "net" || !grossProductSplit));
  // Task #190 (follow-up): the combined All-Products Forecast popup
  // now goes side-by-side ONLY when the user is viewing both MRR and
  // Churn forecasts ("both" mode). In MRR-only and ACQ/Net modes the popup
  // stays MRR-only; in Churn-only mode it shows just the Churn drilldown.
  const showMrrSection = forecastShowNet || quotaGrossMetric === "mrr" || quotaGrossMetric === "both";
  const showChurnSection = !forecastShowNet && (quotaGrossMetric === "churn" || quotaGrossMetric === "both");
  const forecastPopupSideBySide = showMrrSection && showChurnSection;

  const exportProducts: string[] = (filters.products && filters.products.length > 0)
    ? filters.products
    : displayProducts;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
      <Card className="no-shadow flex flex-col">
        <CardHeader className="px-4 pt-4 pb-2 flex-row items-start justify-between space-y-0">
          <div>
            <div className="flex items-center gap-2">
              <CardTitle className="text-[16px] font-semibold cursor-pointer hover:text-[#006AFF] transition-colors" onClick={() => setDrilldown({ stage: "All Stages", mode: "stage" })}>Pipeline Funnel — {MRR_MODE_LABELS[mrrMode]}</CardTitle>
              <SfReportLink href={SF_OPPS_REPORT} />
              <CSVLink data={effectiveFunnelChartData.map(d => ({ stage: d.name, value: d.total, opps: (d.oppCount as number) || 0 }))} filename="pipeline-funnel.csv" className="print:hidden p-1 hover:bg-black/5 rounded">
                <Download className="w-3.5 h-3.5" />
              </CSVLink>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <StageMappingLink />
              <MrrLogicLink />
              {isMultiProduct && <EnlargeChartButton onClick={() => setFunnelBreakdownOpen(true)} />}
              {pipelineMode === "allOpen" && (
                <span className="text-[9px] px-1.5 py-0.5 bg-[#006AFF]/10 text-[#006AFF] rounded font-medium">+ Stale Opps</span>
              )}
            </div>
          </div>
          {funnelGrossToggleVisible && (
            <div className="flex items-center rounded border border-gray-200 bg-white overflow-hidden text-[10px] font-semibold leading-none">
              {(["Gross", "Net"] as const).map((m, i) => {
                const active = (quotaGrossMetric === "net" ? "Net" : "Gross") === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setQuotaGrossMetric(m === "Net" ? "net" : "both"); }}
                    title={m === "Net" ? "Include all opportunities (positive and negative MRR)" : "Exclude negative-MRR opportunities"}
                    className={`px-1.5 py-0.5 transition-colors ${active ? "bg-[#0f172a] text-white" : "text-[#475569] hover:bg-gray-50"} ${i > 0 ? "border-l border-gray-200" : ""}`}
                  >{m}</button>
                );
              })}
            </div>
          )}
        </CardHeader>
        <CardContent className="flex-1 min-h-[300px] px-4 flex flex-col">
          <div className="flex-1 flex flex-col justify-center">
            <div className="flex items-center pb-1 border-b border-border/40 text-[10px] uppercase tracking-wide text-[#94a3b8] font-semibold">
              <div className="w-[90px] shrink-0 pr-2 text-right">Stage</div>
              <div className="flex-1 mr-2" />
              <div className="w-[50px] shrink-0 text-center">MRR</div>
              <div className="w-[40px] shrink-0 flex justify-end">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setFunnelRightColMode(funnelRightColMode === "opps" ? "pctMrr" : "opps"); }}
                  title={funnelRightColMode === "opps" ? "Show each stage's % of total pipeline MRR" : "Show opportunity count per stage"}
                  className="px-1.5 py-0.5 rounded border border-gray-200 bg-white hover:bg-gray-50 text-[10px] font-semibold leading-none text-[#475569]"
                >{funnelRightColMode === "opps" ? "Opps" : "% MRR"}</button>
              </div>
            </div>
            {activeFunnelData.map((entry) => (
              <div key={entry.name} role="button" tabIndex={0} className="flex items-center py-[6px] cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.03] rounded transition-colors" onClick={() => setDrilldown({ stage: entry.name, mode: "stage" })} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDrilldown({ stage: entry.name, mode: "stage" }); } }}>
                <div className="w-[90px] shrink-0 pr-2 text-[11px] text-[#64748b] text-right">
                  {stageLabel(entry.name)}
                </div>
                <div className="flex-1 relative mr-2" style={{ height: 18 }}>
                  {isMultiProduct ? (
                    <MultiProductStackedBar
                      entry={entry}
                      products={displayProducts}
                      widthPct={Math.max(entry.total > 0 ? 3 : 0, (entry.total / maxActiveFunnelVal) * 100)}
                      labelThresholdPct={18}
                      labelClassName="text-[7px] text-white font-semibold truncate px-0.5 leading-none"
                    />
                  ) : (
                    <div
                      className="h-full rounded-r"
                      style={{
                        width: `${Math.max(entry.total > 0 ? 3 : 0, (entry.total / maxActiveFunnelVal) * 100)}%`,
                        backgroundColor: FUNNEL_STAGE_COLORS[entry.name] || "#006AFF",
                      }}
                    />
                  )}
                </div>
                <div className="w-[50px] shrink-0 text-right text-[11px] text-[#64748b] font-medium">
                  {formatCurrency(entry.total)}
                </div>
                <div className="w-[40px] shrink-0 text-right text-[11px] text-[#64748b] font-medium tabular-nums">
                  {funnelRightColMode === "pctMrr"
                    ? (activeFunnelTotalMrr > 0 ? `${((entry.total / activeFunnelTotalMrr) * 100).toFixed(1)}%` : "0%")
                    : ((entry.oppCount as number) || 0).toLocaleString()}
                </div>
              </div>
            ))}
            {closedLostData && (
              <>
                <div className="border-t border-dashed border-border/60 my-1.5" />
                <div role="button" tabIndex={0} className="flex items-center py-[6px] cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.03] rounded transition-colors" onClick={() => setDrilldown({ stage: "Closed Lost", mode: "stage" })} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDrilldown({ stage: "Closed Lost", mode: "stage" }); } }}>
                  <div className="w-[90px] shrink-0 pr-2 text-[11px] text-[#64748b] text-right">
                    Closed Lost
                  </div>
                  <div className="flex-1 relative mr-2" style={{ height: 18 }}>
                    {isMultiProduct ? (
                      <MultiProductStackedBar
                        entry={closedLostData}
                        products={displayProducts}
                        widthPct={100}
                        labelThresholdPct={18}
                        labelClassName="text-[7px] text-white font-semibold truncate px-0.5 leading-none"
                      />
                    ) : (
                      <div
                        className="h-full rounded-r"
                        style={{
                          width: "100%",
                          backgroundColor: "#EF4444",
                        }}
                      />
                    )}
                  </div>
                  <div className="w-[50px] shrink-0 text-right text-[11px] text-[#EF4444] font-medium">
                    {formatCurrency(closedLostData.total)}
                  </div>
                  <div className="w-[40px] shrink-0 text-right text-[11px] text-[#EF4444] font-medium tabular-nums">
                    {funnelRightColMode === "pctMrr"
                      ? "n/a"
                      : ((closedLostData.oppCount as number) || 0).toLocaleString()}
                  </div>
                </div>
              </>
            )}
          </div>
          {isMultiProduct && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 pt-2 border-t border-border/50">
              {displayProducts.map((prod, i) => (
                <div key={prod} className="flex items-center gap-1">
                  <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: getProductColor(prod, i) }} />
                  <span className="text-[9px] text-[#64748b]">{getProductAbbrev(prod)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
        {funnelBreakdownOpen && isMultiProduct && (
          <EnlargedBarChartPopup
            title={`Pipeline Funnel — ${MRR_MODE_LABELS[mrrMode]}`}
            rows={closedLostData ? [...activeFunnelData, closedLostData] : activeFunnelData}
            products={displayProducts}
            onClose={() => setFunnelBreakdownOpen(false)}
            nameLabel={stageLabel}
          />
        )}
      </Card>

      <Card className="no-shadow flex flex-col relative" style={{ maxHeight: quotaDrilldownScope && quotaCardExpanded ? 805 : 620 }}>
        <CardHeader className="px-4 pt-4 pb-0">
          <div className="flex items-center gap-2">
            {quotaDrilldownScope ? (
              <>
                <button
                  onClick={() => setQuotaDrilldownScope(null)}
                  aria-label="Back to Goal"
                  title="Back"
                  className="flex items-center justify-center w-5 h-5 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <CardTitle className="text-[16px] font-semibold">
                  Goal:&nbsp;
                  <span style={{ color: quotaDrilldownScope.kind === "total" ? "#0f172a" : (PRODUCT_COLORS[quotaDrilldownScope.product || ""] || "#64748b") }}>
                    {quotaDrilldownScope.kind === "total" ? "Total" : displayProduct(quotaDrilldownScope.product)}
                  </span>
                </CardTitle>
              </>
            ) : (
              <CardTitle className="text-[16px] font-semibold">
                {grossProductSplit
                  ? quotaGrossMetric === "mrr"
                    ? "MRR Added Goal"
                    : quotaGrossMetric === "churn"
                      ? "Churn Goal"
                      : "Goal"
                  : "Goal"}
              </CardTitle>
            )}
            <span className="text-[10px] bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded font-medium">{quotaPeriodLabel}</span>
            {data?.quotaDataAvailable === false && !data?.quotaError && (
              <span
                className="text-[10px] bg-amber-50 text-amber-800 border border-amber-200 px-1.5 py-0.5 rounded font-medium"
                title="Anaplan publishes monthly goals around the 5th of the month. Goals for this month will appear here once they land — other months in the date range still show their actual goals."
              >
                Goal not yet published
              </span>
            )}
            <SfReportLink href={SF_OPPS_REPORT} />
            <GoalLogicLink />
            {grossProductSplit && (
              <div className="ml-auto flex items-center rounded border border-gray-200 bg-white overflow-hidden text-[10px] font-semibold leading-none">
                {(["both", "mrr", "churn", "net"] as const).map((m, i) => {
                  const active = quotaGrossMetric === m;
                  const label = m === "both" ? "Both" : m === "mrr" ? "MRR" : m === "churn" ? "Churn" : "Net";
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setQuotaGrossMetric(m); }}
                      title={`Show ${label}`}
                      className={`px-1.5 py-0.5 transition-colors ${active ? "bg-[#0f172a] text-white" : "text-[#475569] hover:bg-gray-50"} ${i > 0 ? "border-l border-gray-200" : ""}`}
                    >{label}</button>
                  );
                })}
              </div>
            )}
            {quotaDrilldownScope && (
              <button
                type="button"
                onClick={() => setQuotaCardExpanded(v => !v)}
                aria-label={quotaCardExpanded ? "Collapse card" : "Expand card"}
                aria-pressed={quotaCardExpanded}
                title={quotaCardExpanded ? "Collapse card" : "Expand card"}
                className={`${grossProductSplit ? "" : "ml-auto"} flex items-center justify-center w-5 h-5 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors`}
              >
                {quotaCardExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-4 flex-1 flex flex-col gap-4 overflow-y-auto min-h-0">
          {quotaDrilldownScope ? (() => {
            const scope = quotaDrilldownScope;
            const isGross = !!grossProductSplit && quotaGrossMetric !== "net";
            const activeProds = ALL_PRODUCTS.filter(p => activeProductSet.has(p));

            // Rows: { name, mrr, goal, churn, churnGoal, breakdown, mrrAddedBreakdown, churnBreakdown }
            const rows = (repBreakdowns || []).map(rb => {
              if (scope.kind === "product" && scope.product) {
                const pp = rb.perProduct[scope.product];
                if (!pp) return null;
                return {
                  name: rb.name,
                  mrr: pp.mrr,
                  goal: pp.goal,
                  mrrAdded: pp.mrrAdded,
                  mrrAddedGoal: pp.mrrAddedGoal,
                  churn: pp.churn,
                  churnGoal: pp.churnGoal,
                  breakdown: pp.breakdown ?? null,
                  mrrAddedBreakdown: pp.mrrAddedBreakdown ?? null,
                  churnBreakdown: pp.churnBreakdown ?? null,
                };
              }
              // Total scope: sum across active products (skipping SCI which rolls into Showcase).
              let mrr = 0, goal = 0, mrrAdded = 0, mrrAddedGoal = 0, churn = 0, churnGoal = 0;
              for (const prod of activeProds) {
                // SCI is not in ALL_PRODUCTS — its contribution is already rolled into Showcase via repBreakdowns.
                const pp = rb.perProduct[prod];
                if (!pp) continue;
                mrr += pp.mrr;
                goal += pp.goal;
                mrrAdded += pp.mrrAdded;
                mrrAddedGoal += pp.mrrAddedGoal;
                churn += pp.churn;
                churnGoal += pp.churnGoal;
              }
              return {
                name: rb.name,
                mrr, goal, mrrAdded, mrrAddedGoal, churn, churnGoal,
                breakdown: null, mrrAddedBreakdown: null, churnBreakdown: null,
              };
            }).filter((r): r is NonNullable<typeof r> => {
              if (!r) return false;
              // Include rep if they have a goal OR non-zero actual for the displayed metric.
              if (isGross) {
                if (quotaGrossMetric === "mrr") return r.mrrAddedGoal !== 0 || r.mrrAdded !== 0;
                if (quotaGrossMetric === "churn") return r.churnGoal !== 0 || r.churn !== 0;
                return r.mrrAddedGoal !== 0 || r.churnGoal !== 0 || r.mrrAdded !== 0 || r.churn !== 0;
              }
              return r.goal !== 0 || r.mrr !== 0;
            });

            // Sort descending. Net: by MRR. Gross: by selected metric (added or churn).
            // When the metric toggle is "mrr" or "churn", force-sort by that metric
            // regardless of the user's sticky tornado sort preference.
            const effectiveGrossSort: "added" | "churn" =
              quotaGrossMetric === "mrr" ? "added"
                : quotaGrossMetric === "churn" ? "churn"
                  : quotaDrilldownGrossSort;
            rows.sort((a, b) => {
              if (isGross) {
                const isDollar = quotaDrilldownGrossDisplay === "dollar";
                if (effectiveGrossSort === "churn") {
                  if (isDollar) {
                    // $ mode: best at top = largest amount saved vs goal
                    // (|goal| - |actual|, positive = beat goal).
                    return (Math.abs(b.churnGoal) - Math.abs(b.churn))
                      - (Math.abs(a.churnGoal) - Math.abs(a.churn));
                  }
                  // % mode: best at top = lowest churn attainment %
                  // (lower % of goal consumed = lost less). Zero-goal sorts last.
                  const pctOf = (act: number, goal: number) => {
                    const g = Math.abs(goal);
                    if (g === 0) return Number.POSITIVE_INFINITY;
                    return (Math.abs(act) / g) * 100;
                  };
                  return pctOf(a.churn, a.churnGoal) - pctOf(b.churn, b.churnGoal);
                }
                if (isDollar) {
                  // $ mode: biggest MRR Added at top.
                  return b.mrrAdded - a.mrrAdded;
                }
                // % mode: highest MRR Added attainment % at top.
                const pctOf = (act: number, goal: number) => {
                  const g = Math.abs(goal);
                  if (g === 0) return Math.abs(act) > 0 ? Number.POSITIVE_INFINITY : 0;
                  return (Math.abs(act) / g) * 100;
                };
                return pctOf(b.mrrAdded, b.mrrAddedGoal) - pctOf(a.mrrAdded, a.mrrAddedGoal);
              }
              if (quotaDrilldownNetSort === "pct") {
                // Zero-goal reps sort as 0% (n/a in display).
                const pctOf = (mrr: number, goal: number) => {
                  const absG = Math.abs(goal);
                  if (absG === 0) return 0;
                  return (Math.abs(mrr) / absG) * 100;
                };
                return pctOf(b.mrr, b.goal) - pctOf(a.mrr, a.goal);
              }
              return b.mrr - a.mrr;
            });

            const scopeColor = scope.kind === "product" && scope.product
              ? (PRODUCT_COLORS[scope.product] || "#64748b")
              : "#0f172a";

            if (rows.length === 0) {
              return (
                <div className="text-[12px] text-[#64748b] py-6 text-center">
                  No {filters.aggregateBy === "Rep" ? "reps" : `${filters.aggregateBy}s`} with goal or activity for this scope.
                </div>
              );
            }

            // Compute pct + color for one side of a tornado bar.
            const computeSide = (actual: number, goal: number, isChurn: boolean) => {
              const absActual = Math.abs(actual);
              const absGoal = Math.abs(goal);
              const zeroGoalWithActual = absGoal === 0 && absActual > 0;
              const pct = absGoal > 0 ? (absActual / absGoal) * 100 : (zeroGoalWithActual ? 100 : 0);
              let color = "#EF4444";
              if (isChurn) {
                // Churn uses the INVERSE of MRR-added thresholds: low attainment %
                // is good (less churn vs goal), high % fills the bar toward red.
                if (zeroGoalWithActual) color = "#EF4444";
                else if (pct < 50) color = "#00C49F";
                else if (pct < 80) color = "#FF6B35";
              } else {
                if (zeroGoalWithActual) color = "#00C49F";
                else if (pct >= 80) color = "#00C49F";
                else if (pct >= 50) color = "#FF6B35";
              }
              return { absActual, absGoal, pct, color };
            };

            // "Expand All / Hide All" header toggle that lives in the same
            // w-28 slot as the rep-name column, so it sits directly above the
            // first row's chevron. Toggle works against `expandedReps` and the
            // current rendered `rows` set.
            const allExpanded = rows.length > 0 && rows.every(r => expandedReps.has(r.name));
            const expandAllBtn = (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpandedReps(allExpanded ? new Set() : new Set(rows.map(r => r.name)));
                }}
                className="text-[10px] text-[#475569] hover:text-[#0f172a] hover:bg-gray-100 rounded px-1 py-0.5 -ml-1 transition-colors"
                title={allExpanded ? "Collapse all reps" : "Expand all reps"}
              >
                {allExpanded ? "− Hide All" : "+ Expand All"}
              </button>
            );

            // Task #162: reconciliation note. When the per-rep floored sum
            // exceeds the displayed (aggregate-floored) goal — i.e. one or
            // more reps are over their personal monthly goal — surface the
            // gap so users understand why the column-sum doesn't match the
            // displayed total.
            const scopeAggGoal = scope.kind === "product" && scope.product
              ? (allProductQuotas.find(pq => pq.product === scope.product)?.goal || 0)
              : activeTotalGoal;
            const scopePerRepSum = scope.kind === "product" && scope.product
              ? (allProductQuotas.find(pq => pq.product === scope.product)?.goalPerRepSum || 0)
              : activeTotalGoalPerRepSum;
            const reconcileGap = scopePerRepSum - scopeAggGoal;
            const showReconcileNote = !isGross && prorateQuota && effectiveQuotaMode === "remaining" && reconcileGap > 0.5;
            return (
              <div className="space-y-0.5">
                {showReconcileNote && (
                  <div className="mb-1.5 px-2 py-1 bg-amber-50 border border-amber-200 rounded text-[10px] text-amber-800 leading-snug">
                    <span className="font-semibold">Per-rep sum {formatCurrency(scopePerRepSum)}</span> &gt; aggregate {formatCurrency(scopeAggGoal)} (gap {formatCurrency(reconcileGap)}). Aggregate floors closed against goal at the team level — reps over personal goal don't reduce the team bucket twice.
                  </div>
                )}
                {/* Column headers (gross + tornado view) — click to sort. Layout mirrors
                    the rep row: w-28 name | w-14 churn$ | flex-1 churn bar | axis |
                    flex-1 mrr bar | w-14 mrr$ — so "Churn" / "MRR" labels are centered
                    over their bars and the $/% toggle sits over the rightmost ($) column. */}
                {isGross && quotaGrossMetric === "both" && (() => {
                  const sortedChurn = quotaDrilldownGrossSort === "churn";
                  const isDollar = quotaDrilldownGrossDisplay === "dollar";
                  const headerCls = (active: boolean) =>
                    `cursor-pointer select-none transition-colors px-2 py-0.5 rounded hover:bg-gray-100 ${active ? "text-[#0f172a] font-semibold" : "text-[#94a3b8]"}`;
                  return (
                    <div className="flex items-center gap-2 pb-1 mb-1 border-b border-gray-100 text-[10px] uppercase tracking-wide font-medium">
                      <div className="w-28 shrink-0 flex items-center">{expandAllBtn}</div>
                      <div className="flex-1 min-w-0 flex items-center">
                        <div className="w-14 shrink-0 mr-1" />
                        <div className="flex-1 min-w-0 flex justify-center">
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={() => setQuotaDrilldownGrossSort("churn")}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setQuotaDrilldownGrossSort("churn"); } }}
                            className={headerCls(sortedChurn)}
                            title="Sort by Churn"
                          >Churn{sortedChurn ? " ▾" : ""}</span>
                        </div>
                        <div className="w-px mx-px" />
                        <div className="flex-1 min-w-0 flex justify-center">
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={() => setQuotaDrilldownGrossSort("added")}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setQuotaDrilldownGrossSort("added"); } }}
                            className={headerCls(!sortedChurn)}
                            title="Sort by MRR Added"
                          >MRR{!sortedChurn ? " ▾" : ""}</span>
                        </div>
                        <div className="w-14 shrink-0 ml-1 flex justify-center">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setQuotaDrilldownGrossDisplay(isDollar ? "pct" : "dollar"); }}
                            title={isDollar ? "Show attainment % (sort & values)" : "Show $ values (sort by $)"}
                            className="px-1.5 py-0.5 rounded border border-gray-200 bg-white hover:bg-gray-50 text-[10px] font-semibold leading-none text-[#475569]"
                          >{isDollar ? "%" : "$"}</button>
                        </div>
                      </div>
                    </div>
                  );
                })()}
                {/* Column headers (gross + single-metric view) — mirrors net-mode header layout.
                    Widths match the row (w-28 name, flex-1 bar, w-16 $, w-12 %).
                    Clicking the metric header sorts by $ value; clicking % sorts by attainment %. */}
                {isGross && quotaGrossMetric !== "both" && (() => {
                  const isMrr = quotaGrossMetric === "mrr";
                  const isDollar = quotaDrilldownGrossDisplay === "dollar";
                  const headerCls = (active: boolean) =>
                    `cursor-pointer select-none transition-colors px-2 py-0.5 rounded hover:bg-gray-100 ${active ? "text-[#0f172a] font-semibold" : "text-[#94a3b8]"}`;
                  return (
                    <div className="flex items-center gap-2 pb-1 mb-1 border-b border-gray-100 text-[10px] uppercase tracking-wide font-medium">
                      <div className="w-28 shrink-0 flex items-center">{expandAllBtn}</div>
                      <div className="flex-1 min-w-0" />
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setQuotaDrilldownGrossDisplay("dollar")}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setQuotaDrilldownGrossDisplay("dollar"); } }}
                        className={`${headerCls(isDollar)} w-16 text-right`}
                        title={`Sort by ${isMrr ? "MRR Added" : "Churn"} $`}
                      >{isMrr ? "MRR Added →" : "← Churn"}{isDollar ? " ▾" : ""}</div>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setQuotaDrilldownGrossDisplay("pct")}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setQuotaDrilldownGrossDisplay("pct"); } }}
                        className={`${headerCls(!isDollar)} w-12 text-right`}
                        title="Sort by attainment %"
                      >%{!isDollar ? " ▾" : ""}</div>
                    </div>
                  );
                })()}
                {/* Column headers (net mode) — click to sort. Widths match the row layout
                    (w-28 name, flex-1 bar, w-16 $, w-12 %) so headers sit over their columns. */}
                {!isGross && (() => {
                  const sortedPct = quotaDrilldownNetSort === "pct";
                  const headerCls = (active: boolean) =>
                    `cursor-pointer select-none transition-colors px-2 py-0.5 rounded hover:bg-gray-100 ${active ? "text-[#0f172a] font-semibold" : "text-[#94a3b8]"}`;
                  return (
                    <div className="flex items-center gap-2 pb-1 mb-1 border-b border-gray-100 text-[10px] uppercase tracking-wide font-medium">
                      <div className="w-28 shrink-0 flex items-center">{expandAllBtn}</div>
                      <div className="flex-1 min-w-0" />
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setQuotaDrilldownNetSort("mrr")}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setQuotaDrilldownNetSort("mrr"); } }}
                        className={`${headerCls(!sortedPct)} w-16 text-right`}
                        title="Sort by MRR"
                      >MRR{!sortedPct ? " ▾" : ""}</div>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setQuotaDrilldownNetSort("pct")}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setQuotaDrilldownNetSort("pct"); } }}
                        className={`${headerCls(sortedPct)} w-12 text-right`}
                        title="Sort by attainment %"
                      >%{sortedPct ? " ▾" : ""}</div>
                    </div>
                  );
                })()}
                {rows.map(row => {
                  if (!isGross) {
                    const absActual = Math.abs(row.mrr);
                    const absGoal = Math.abs(row.goal);
                    const zeroGoal = absGoal === 0;
                    const pct = zeroGoal ? 0 : (absActual / absGoal) * 100;
                    let barColor = "#EF4444";
                    if (zeroGoal) barColor = "#00C49F";
                    else if (pct >= 80) barColor = "#00C49F";
                    else if (pct >= 50) barColor = "#FF6B35";
                    const barFillPct = zeroGoal ? 100 : Math.min(100, Math.max(0, pct));
                    const sciAbs = row.breakdown ? Math.abs(row.breakdown.sci) : 0;
                    const scAbs = row.breakdown ? Math.abs(row.breakdown.showcase) : 0;
                    const hasBreak = !!row.breakdown && sciAbs > 0 && absGoal > 0;
                    const scPctRaw = hasBreak ? (scAbs / absGoal) * 100 : 0;
                    const sciPctRaw = hasBreak ? (sciAbs / absGoal) * 100 : 0;
                    const totRaw = scPctRaw + sciPctRaw;
                    const scClamp = hasBreak ? (totRaw > 100 ? (scPctRaw / totRaw) * 100 : scPctRaw) : 0;
                    const sciClamp = hasBreak ? (totRaw > 100 ? (sciPctRaw / totRaw) * 100 : sciPctRaw) : 0;
                    const SCI_BAR_COLOR = lightenHex(barColor, 0.55);
                    const isExpanded = expandedReps.has(row.name);
                    const sortedPct = quotaDrilldownNetSort === "pct";
                    // Task #162: overperformer badge — when actual > goal AND
                    // goal > 0, surface the overage next to the rep name so
                    // it's obvious which rep contributed to the
                    // reconciliation gap.
                    const isOver = row.goal > 0 && row.mrr > row.goal && prorateQuota && effectiveQuotaMode === "remaining";
                    const overAmt = isOver ? row.mrr - row.goal : 0;
                    return (
                      <React.Fragment key={row.name}>
                        <div className={`flex items-center gap-2 py-1 rounded cursor-pointer ${isExpanded ? "bg-gray-100" : "hover:bg-gray-50"}`} onClick={() => toggleExpandedRep(row.name)}>
                          <div className="text-[12px] font-medium truncate w-28 shrink-0 flex items-center gap-0.5" style={{ color: scopeColor }} title={row.name}>
                            <span className="text-[9px] opacity-60">{isExpanded ? "▾" : "▸"}</span>
                            <span className="truncate">{row.name}</span>
                            {isOver && (
                              <span
                                className="ml-1 px-1 py-px rounded bg-emerald-100 text-emerald-800 text-[9px] font-semibold leading-none whitespace-nowrap"
                                title={`Over personal goal by ${formatCurrency(overAmt)} — adds to team bucket via aggregate floor`}
                              >+{formatCurrency(overAmt)} over goal</span>
                            )}
                          </div>
                          <div className="flex-1 min-w-0 h-3 bg-gray-200 rounded-full overflow-hidden flex" title={zeroGoal ? `${formatCurrency(absActual)} / no goal` : `${formatCurrency(absActual)} / ${formatCurrency(absGoal)}`}>
                            {hasBreak ? (
                              <>
                                <div className="h-full transition-all" style={{ width: `${scClamp}%`, backgroundColor: barColor }} title={`${displayProduct("Showcase")}: ${formatCurrency(scAbs)}`} />
                                <div className="h-full transition-all" style={{ width: `${sciClamp}%`, backgroundColor: SCI_BAR_COLOR }} title={`${displayProductAbbrev("Showcase Incremental", "SCI")}: ${formatCurrency(sciAbs)}`} />
                              </>
                            ) : (
                              <div className="h-full transition-all rounded-full" style={{ width: `${barFillPct}%`, backgroundColor: barColor }} />
                            )}
                          </div>
                          <span className={`text-[11px] tabular-nums whitespace-nowrap w-16 text-right ${!sortedPct ? "font-semibold text-[#0f172a]" : "text-[#64748b]"}`}>{formatCurrency(absActual)}</span>
                          <span className={`text-[11px] tabular-nums whitespace-nowrap w-12 text-right ${sortedPct ? "font-semibold" : ""}`} style={{ color: barColor }}>{zeroGoal ? "n/a" : `${pct.toFixed(0)}%`}</span>
                        </div>
                        {isExpanded && (
                          <div className="ml-28 pl-2 pr-1 pb-2 pt-1 mb-1 border-l-2 border-gray-200 bg-gray-50/60 rounded-r">
                            <div className="text-[11px] tabular-nums space-y-0.5">
                              <div><span className="text-gray-500">MRR:</span> <span className="font-medium" style={{ color: barColor }}>{formatCurrencyFull(row.mrr)}</span></div>
                              <div><span className="text-gray-500">Goal:</span> <span className="font-medium">{formatCurrencyFull(row.goal)}</span></div>
                            </div>
                          </div>
                        )}
                      </React.Fragment>
                    );
                  }
                  // Single-metric layout for gross mode (when "MRR" or "Churn" toggle is active).
                  // Mirrors the net-mode row layout (w-40 bar + $ + %) but driven by either
                  // MRR Added or Churn data with the appropriate color thresholds.
                  if (quotaGrossMetric !== "both") {
                    const isChurn = quotaGrossMetric === "churn";
                    const actual = isChurn ? row.churn : row.mrrAdded;
                    const goal = isChurn ? row.churnGoal : row.mrrAddedGoal;
                    const breakdown = isChurn ? row.churnBreakdown : row.mrrAddedBreakdown;
                    const side = computeSide(actual, goal, isChurn);
                    const absActual = side.absActual;
                    const absGoal = side.absGoal;
                    const zeroGoal = absGoal === 0;
                    const pct = side.pct;
                    const barColor = side.color;
                    const barFillPct = zeroGoal && absActual > 0 ? 100 : Math.min(100, Math.max(0, pct));
                    const sciAbs = breakdown ? Math.abs(breakdown.sci) : 0;
                    const scAbs = breakdown ? Math.abs(breakdown.showcase) : 0;
                    const hasBreak = !!breakdown && sciAbs > 0 && absGoal > 0;
                    const scPctRaw = hasBreak ? (scAbs / absGoal) * 100 : 0;
                    const sciPctRaw = hasBreak ? (sciAbs / absGoal) * 100 : 0;
                    const totRaw = scPctRaw + sciPctRaw;
                    const scClamp = hasBreak ? (totRaw > 100 ? (scPctRaw / totRaw) * 100 : scPctRaw) : 0;
                    const sciClamp = hasBreak ? (totRaw > 100 ? (sciPctRaw / totRaw) * 100 : sciPctRaw) : 0;
                    const SCI_BAR_COLOR = lightenHex(barColor, 0.55);
                    const isExpanded = expandedReps.has(row.name);
                    // Diff semantics: for MRR, "exceeded" = actual >= goal; for churn, "beat" = actual <= goal.
                    const diff = isChurn
                      ? Math.abs(goal) - Math.abs(actual)   // positive = beat goal
                      : actual - goal;                       // positive = exceeded goal
                    const beat = diff >= 0;
                    const diffLabel = isChurn
                      ? (beat ? "Beat goal by" : "Over by")
                      : (beat ? "Exceeded by" : "Under by");
                    const signed = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                    return (
                      <React.Fragment key={row.name}>
                        <div className={`flex items-center gap-2 py-1 rounded cursor-pointer ${isExpanded ? "bg-gray-100" : "hover:bg-gray-50"}`} onClick={() => toggleExpandedRep(row.name)}>
                          <div className="text-[12px] font-medium truncate w-28 shrink-0 flex items-center gap-0.5" style={{ color: scopeColor }} title={row.name}>
                            <span className="text-[9px] opacity-60">{isExpanded ? "▾" : "▸"}</span>
                            <span className="truncate">{row.name}</span>
                          </div>
                          <div className="flex-1 min-w-0 h-3 bg-gray-200 rounded-full overflow-hidden flex" title={zeroGoal ? `${formatCurrency(absActual)} / no goal` : `${formatCurrency(absActual)} / ${formatCurrency(absGoal)}`}>
                            {hasBreak ? (
                              <>
                                <div className="h-full transition-all" style={{ width: `${scClamp}%`, backgroundColor: barColor }} title={`${displayProduct("Showcase")}: ${formatCurrency(scAbs)}`} />
                                <div className="h-full transition-all" style={{ width: `${sciClamp}%`, backgroundColor: SCI_BAR_COLOR }} title={`${displayProductAbbrev("Showcase Incremental", "SCI")}: ${formatCurrency(sciAbs)}`} />
                              </>
                            ) : (
                              <div className="h-full transition-all rounded-full" style={{ width: `${barFillPct}%`, backgroundColor: barColor }} />
                            )}
                          </div>
                          <span className="text-[11px] tabular-nums whitespace-nowrap w-16 text-right font-semibold text-[#0f172a]">{formatCurrency(absActual)}</span>
                          <span className="text-[11px] tabular-nums whitespace-nowrap w-12 text-right font-semibold" style={{ color: barColor }}>{zeroGoal ? "n/a" : `${pct.toFixed(0)}%`}</span>
                        </div>
                        {isExpanded && (
                          <div className="ml-28 pl-2 pr-1 pb-2 pt-1 mb-1 border-l-2 border-gray-200 bg-gray-50/60 rounded-r">
                            <div className="text-[11px] tabular-nums space-y-0.5">
                              <div><span className="text-gray-500">{isChurn ? "Churn:" : "MRR:"}</span> <span className="font-medium" style={{ color: barColor }}>{formatCurrencyFull(actual)}</span></div>
                              <div><span className="text-gray-500">Goal:</span> <span className="font-medium">{formatCurrencyFull(goal)}</span></div>
                              <div><span className="text-gray-500">{diffLabel}:</span> <span className="font-medium" style={{ color: beat ? "#16a34a" : "#dc2626" }}>{signed(diff)}</span></div>
                            </div>
                          </div>
                        )}
                      </React.Fragment>
                    );
                  }
                  // Tornado layout for gross mode.
                  const churn = computeSide(row.churn, row.churnGoal, true);
                  const added = computeSide(row.mrrAdded, row.mrrAddedGoal, false);
                  const sortedChurn = quotaDrilldownGrossSort === "churn";
                  const churnW = Math.min(100, churn.pct);
                  const addedW = Math.min(100, added.pct);
                  const isExpanded = expandedReps.has(row.name);
                  const SCI_LIGHTEN = 0.55;
                  // Churn breakdown segments (right-aligned: SCi extends left, SC against center axis)
                  const churnSciAbs = row.churnBreakdown ? Math.abs(row.churnBreakdown.sci) : 0;
                  const churnScAbs = row.churnBreakdown ? Math.abs(row.churnBreakdown.showcase) : 0;
                  const churnHasBreak = !!row.churnBreakdown && churnSciAbs > 0 && churn.absGoal > 0;
                  const churnScPctRaw = churnHasBreak ? (churnScAbs / churn.absGoal) * 100 : 0;
                  const churnSciPctRaw = churnHasBreak ? (churnSciAbs / churn.absGoal) * 100 : 0;
                  const churnTotRaw = churnScPctRaw + churnSciPctRaw;
                  const churnScClamp = churnHasBreak ? (churnTotRaw > 100 ? (churnScPctRaw / churnTotRaw) * 100 : churnScPctRaw) : 0;
                  const churnSciClamp = churnHasBreak ? (churnTotRaw > 100 ? (churnSciPctRaw / churnTotRaw) * 100 : churnSciPctRaw) : 0;
                  const churnSciColor = lightenHex(churn.color, SCI_LIGHTEN);
                  // MRR Added breakdown segments (left-aligned: SC against center axis on left, SCi extends right)
                  const addedSciAbs = row.mrrAddedBreakdown ? Math.abs(row.mrrAddedBreakdown.sci) : 0;
                  const addedScAbs = row.mrrAddedBreakdown ? Math.abs(row.mrrAddedBreakdown.showcase) : 0;
                  const addedHasBreak = !!row.mrrAddedBreakdown && addedSciAbs > 0 && added.absGoal > 0;
                  const addedScPctRaw = addedHasBreak ? (addedScAbs / added.absGoal) * 100 : 0;
                  const addedSciPctRaw = addedHasBreak ? (addedSciAbs / added.absGoal) * 100 : 0;
                  const addedTotRaw = addedScPctRaw + addedSciPctRaw;
                  const addedScClamp = addedHasBreak ? (addedTotRaw > 100 ? (addedScPctRaw / addedTotRaw) * 100 : addedScPctRaw) : 0;
                  const addedSciClamp = addedHasBreak ? (addedTotRaw > 100 ? (addedSciPctRaw / addedTotRaw) * 100 : addedSciPctRaw) : 0;
                  const addedSciColor = lightenHex(added.color, SCI_LIGHTEN);
                  return (
                    <React.Fragment key={row.name}>
                      <div className={`flex items-center gap-2 py-0.5 rounded cursor-pointer ${isExpanded ? "bg-gray-100" : "hover:bg-gray-50"}`} onClick={() => toggleExpandedRep(row.name)}>
                        <div className="text-[12px] font-medium truncate w-28 shrink-0 flex items-center gap-0.5" style={{ color: scopeColor }} title={row.name}>
                          <span className="text-[9px] opacity-60">{isExpanded ? "▾" : "▸"}</span>
                          <span className="truncate">{row.name}</span>
                        </div>
                        <div className="flex-1 min-w-0 flex items-center">
                          {/* LEFT: churn — values then bar that fills from right edge */}
                          <span
                            className={`text-[11px] tabular-nums whitespace-nowrap mr-1 w-14 shrink-0 text-right ${sortedChurn ? "font-semibold" : "opacity-60"}`}
                            style={{ color: sortedChurn ? churn.color : "#64748b" }}
                            title={`Churn: ${formatCurrency(churn.absActual)} of ${formatCurrency(churn.absGoal)} target`}
                          >{quotaDrilldownGrossDisplay === "dollar" ? formatCurrency(churn.absActual) : `${churn.pct.toFixed(0)}%`}</span>
                          <div className="flex-1 h-3 bg-gray-100 rounded-l-full overflow-hidden flex justify-end" title={`Churn ${formatCurrency(churn.absActual)} / ${formatCurrency(churn.absGoal)}`}>
                            {churnHasBreak ? (
                              <>
                                <div className="h-full transition-all" style={{ width: `${churnSciClamp}%`, backgroundColor: churnSciColor, opacity: sortedChurn ? 1 : 0.7 }} title={`${displayProductAbbrev("Showcase Incremental", "SCI")}: ${formatCurrency(churnSciAbs)}`} />
                                <div className="h-full transition-all" style={{ width: `${churnScClamp}%`, backgroundColor: churn.color, opacity: sortedChurn ? 1 : 0.7 }} title={`${displayProduct("Showcase")}: ${formatCurrency(churnScAbs)}`} />
                              </>
                            ) : (
                              <div className="h-full transition-all" style={{ width: `${churnW}%`, backgroundColor: churn.color, opacity: sortedChurn ? 1 : 0.7 }} />
                            )}
                          </div>
                          {/* CENTER axis */}
                          <div className="w-px h-3 bg-gray-300 mx-px" />
                          {/* RIGHT: mrr added — bar that fills from left edge then values */}
                          <div className="flex-1 h-3 bg-gray-100 rounded-r-full overflow-hidden flex" title={`MRR Added ${formatCurrency(added.absActual)} / ${formatCurrency(added.absGoal)}`}>
                            {addedHasBreak ? (
                              <>
                                <div className="h-full transition-all" style={{ width: `${addedScClamp}%`, backgroundColor: added.color, opacity: !sortedChurn ? 1 : 0.7 }} title={`${displayProduct("Showcase")}: ${formatCurrency(addedScAbs)}`} />
                                <div className="h-full transition-all" style={{ width: `${addedSciClamp}%`, backgroundColor: addedSciColor, opacity: !sortedChurn ? 1 : 0.7 }} title={`${displayProductAbbrev("Showcase Incremental", "SCI")}: ${formatCurrency(addedSciAbs)}`} />
                              </>
                            ) : (
                              <div className="h-full transition-all" style={{ width: `${addedW}%`, backgroundColor: added.color, opacity: !sortedChurn ? 1 : 0.7 }} />
                            )}
                          </div>
                          <span
                            className={`text-[11px] tabular-nums whitespace-nowrap ml-1 w-14 shrink-0 text-left ${!sortedChurn ? "font-semibold" : "opacity-60"}`}
                            style={{ color: !sortedChurn ? added.color : "#64748b" }}
                            title={`MRR Added: ${formatCurrency(added.absActual)} of ${formatCurrency(added.absGoal)} target`}
                          >{quotaDrilldownGrossDisplay === "dollar" ? formatCurrency(added.absActual) : `${added.pct.toFixed(0)}%`}</span>
                        </div>
                      </div>
                      {isExpanded && (() => {
                        // Churn: beating goal = losing less than allowed.
                        // diff > 0 = beat goal by that much; diff < 0 = over goal (worse).
                        const churnDiff = Math.abs(row.churnGoal) - Math.abs(row.churn);
                        const mrrDiff = row.mrrAdded - row.mrrAddedGoal;
                        const churnLabel = churnDiff >= 0 ? "Beat goal by" : "Over by";
                        const mrrLabel = mrrDiff >= 0 ? "Exceeded by" : "Under by";
                        const signed = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                        return (
                          <div className="ml-28 pl-2 pr-1 pb-2 pt-1 mb-1 border-l-2 border-gray-200 bg-gray-50/60 rounded-r flex gap-6">
                            <div className="flex-1 text-[11px] tabular-nums space-y-0.5">
                              <div><span className="text-gray-500">Churn:</span> <span className="font-medium" style={{ color: churn.color }}>{formatCurrencyFull(row.churn)}</span></div>
                              <div><span className="text-gray-500">Goal:</span> <span className="font-medium">{formatCurrencyFull(row.churnGoal)}</span></div>
                              <div><span className="text-gray-500">{churnLabel}:</span> <span className="font-medium" style={{ color: churnDiff >= 0 ? "#16a34a" : "#dc2626" }}>{signed(churnDiff)}</span></div>
                            </div>
                            <div className="flex-1 text-[11px] tabular-nums space-y-0.5">
                              <div><span className="text-gray-500">MRR:</span> <span className="font-medium" style={{ color: added.color }}>{formatCurrencyFull(row.mrrAdded)}</span></div>
                              <div><span className="text-gray-500">Goal:</span> <span className="font-medium">{formatCurrencyFull(row.mrrAddedGoal)}</span></div>
                              <div><span className="text-gray-500">{mrrLabel}:</span> <span className="font-medium" style={{ color: mrrDiff >= 0 ? "#16a34a" : "#dc2626" }}>{signed(mrrDiff)}</span></div>
                            </div>
                          </div>
                        );
                      })()}
                    </React.Fragment>
                  );
                })}
              </div>
            );
          })() : (grossProductSplit && quotaGrossMetric !== "net") ? (() => {
            const activeGross = grossProductSplit.filter(p => activeProductSet.has(p.product));
            const totMrrAdded = activeGross.reduce((s, p) => s + p.mrrAddedActual, 0);
            const totMrrAddedGoal = activeGross.reduce((s, p) => s + p.mrrAddedGoal, 0);
            const totChurn = activeGross.reduce((s, p) => s + p.churnActual, 0);
            const totChurnGoal = activeGross.reduce((s, p) => s + p.churnGoal, 0);
            // Popup Closed/Remaining + calendar catch-up reconcile to canonical
            // MTD closed when windowed-remaining mode is active. The card BANs
            // still use the window-filtered actuals above; only the popup's
            // `overrideClosed` swaps to MTD so the table/footer/calendar agree
            // with the BAN's windowed-remaining goal math (Task #202).
            const totMrrAddedClosedForPopup = isWindowedRemaining
              ? activeGross.reduce((s, p) => s + (p.mrrAddedMtd || 0), 0)
              : totMrrAdded;
            const totChurnClosedForPopup = isWindowedRemaining
              ? Math.abs(activeGross.reduce((s, p) => s + (p.churnMtd || 0), 0))
              : Math.abs(totChurn);

            // Compute everything needed to render one side of a tornado bar (churn or added).
            const computeBarSide = (actual: number, goal: number, isChurn: boolean, breakdown?: { showcase: number; sci: number } | null, isActive: boolean = true) => {
              const absActual = Math.abs(actual);
              const absGoal = Math.abs(goal);
              const zeroGoalWithActual = absGoal === 0 && absActual > 0;
              const pct = absGoal > 0 ? (absActual / absGoal) * 100 : (zeroGoalWithActual ? 100 : 0);
              let barColor = "#EF4444";
              if (isChurn) {
                // Churn uses the INVERSE of MRR-added thresholds: low attainment %
                // is good (less churn vs goal), high % fills the bar toward red.
                if (zeroGoalWithActual) barColor = "#EF4444";
                else if (pct < 50) barColor = "#00C49F";
                else if (pct < 80) barColor = "#FF6B35";
              } else {
                if (zeroGoalWithActual) barColor = "#00C49F";
                else if (pct >= 80) barColor = "#00C49F";
                else if (pct >= 50) barColor = "#FF6B35";
              }
              const exceeded = isChurn ? absActual <= absGoal && absGoal > 0 : absActual >= absGoal && absGoal > 0;
              const diff = Math.abs(absActual - absGoal);
              const sciAbs = breakdown ? Math.abs(breakdown.sci) : 0;
              const scAbs = breakdown ? Math.abs(breakdown.showcase) : 0;
              const hasBreak = !!breakdown && sciAbs > 0 && absGoal > 0;
              const scPctRaw = hasBreak ? (scAbs / absGoal) * 100 : 0;
              const sciPctRaw = hasBreak ? (sciAbs / absGoal) * 100 : 0;
              const totRaw = scPctRaw + sciPctRaw;
              const scClamp = hasBreak ? (totRaw > 100 ? (scPctRaw / totRaw) * 100 : scPctRaw) : 0;
              const sciClamp = hasBreak ? (totRaw > 100 ? (sciPctRaw / totRaw) * 100 : sciPctRaw) : 0;
              const SCI_BAR_COLOR = lightenHex(barColor, 0.55);
              const fillW = Math.min(100, Math.max(0, pct));
              return { absActual, absGoal, pct, barColor, exceeded, diff, sciAbs, scAbs, hasBreak, scClamp, sciClamp, SCI_BAR_COLOR, fillW, isActive };
            };

            // Render a tornado-style row: Churn (left, fills toward center) | axis | MRR Added (right, fills from center).
            // Keeps all data labels: title, $/$, %, SC/SCI breakdown, exceeded/remaining footer.
            const renderTornadoRow = (
              left: { label: string; actual: number; goal: number; breakdown?: { showcase: number; sci: number } | null },
              right: { label: string; actual: number; goal: number; breakdown?: { showcase: number; sci: number } | null },
              isActive: boolean,
              labelColor?: string,
            ) => {
              const L = computeBarSide(left.actual, left.goal, true, left.breakdown ?? null, isActive);
              const R = computeBarSide(right.actual, right.goal, false, right.breakdown ?? null, isActive);
              const headerColor = isActive ? (labelColor || "#334155") : "#94a3b8";
              const pacingMode = prorateQuota && effectiveQuotaMode === "pacing";
              const renderFooter = (s: ReturnType<typeof computeBarSide>, isChurn: boolean) => {
                if (pacingMode && s.absGoal > 0) {
                  return s.exceeded
                    ? <span className={isActive ? "text-green-600" : ""}>{formatCurrency(s.diff)} ahead of pace</span>
                    : <>{formatCurrency(s.diff)} behind pace</>;
                }
                return s.exceeded
                  ? <span className={isActive ? "text-green-600" : ""}>{isChurn ? `Beat target by ${formatCurrency(s.diff)}` : `${formatCurrency(s.diff)} over`}</span>
                  : <>{formatCurrency(s.diff)} {isChurn ? "over target" : "gap"}</>;
              };
              return (
                <div className={`flex-1 min-w-0 ${!isActive ? "opacity-40" : ""}`}>
                  {/* Headers row: Churn label / $ on left, $ / MRR Added label on right */}
                  <div className="flex items-baseline text-[10px] mb-0.5">
                    <div className="flex-1 min-w-0 flex items-baseline gap-1">
                      <span className="font-medium truncate" style={{ color: headerColor }}>{left.label}</span>
                      <span className="text-[#64748b] whitespace-nowrap tabular-nums ml-auto">{formatCurrency(L.absActual)} / {formatCurrency(L.absGoal)}</span>
                    </div>
                    <div className="w-px mx-1" />
                    <div className="flex-1 min-w-0 flex items-baseline gap-1">
                      <span className="text-[#64748b] whitespace-nowrap tabular-nums">{formatCurrency(R.absActual)} / {formatCurrency(R.absGoal)}</span>
                      <span className="font-medium truncate ml-auto text-right" style={{ color: headerColor }}>{right.label}</span>
                    </div>
                  </div>
                  {/* Tornado bars */}
                  <div className="flex items-center">
                    <span className="text-[9px] font-semibold tabular-nums whitespace-nowrap mr-1 w-9 text-right" style={{ color: isActive ? L.barColor : "#94a3b8" }}>{L.pct.toFixed(0)}%</span>
                    <div className="flex-1 h-2 bg-gray-200 rounded-l-full overflow-hidden flex justify-end" title={`${left.label}: ${formatCurrency(L.absActual)} / ${formatCurrency(L.absGoal)}`}>
                      {L.hasBreak ? (
                        <div className="h-full flex" style={{ width: `${Math.min(100, L.scClamp + L.sciClamp)}%` }}>
                          <div className="h-full transition-all" style={{ width: `${(L.sciClamp / Math.max(0.0001, L.scClamp + L.sciClamp)) * 100}%`, backgroundColor: isActive ? L.SCI_BAR_COLOR : "#e2e8f0" }} title={`${displayProductAbbrev("Showcase Incremental", "SCI")}: ${formatCurrency(L.sciAbs)}`} />
                          <div className="h-full transition-all" style={{ width: `${(L.scClamp / Math.max(0.0001, L.scClamp + L.sciClamp)) * 100}%`, backgroundColor: isActive ? L.barColor : "#cbd5e1" }} title={`${displayProduct("Showcase")}: ${formatCurrency(L.scAbs)}`} />
                        </div>
                      ) : (
                        <div className="h-full transition-all" style={{ width: `${L.fillW}%`, backgroundColor: isActive ? L.barColor : "#cbd5e1" }} />
                      )}
                    </div>
                    <div className="w-px h-3 bg-gray-400 mx-px" />
                    <div className="flex-1 h-2 bg-gray-200 rounded-r-full overflow-hidden" title={`${right.label}: ${formatCurrency(R.absActual)} / ${formatCurrency(R.absGoal)}`}>
                      {R.hasBreak ? (
                        <div className="h-full flex" style={{ width: `${Math.min(100, R.scClamp + R.sciClamp)}%` }}>
                          <div className="h-full transition-all" style={{ width: `${(R.scClamp / Math.max(0.0001, R.scClamp + R.sciClamp)) * 100}%`, backgroundColor: isActive ? R.barColor : "#cbd5e1" }} title={`${displayProduct("Showcase")}: ${formatCurrency(R.scAbs)}`} />
                          <div className="h-full transition-all" style={{ width: `${(R.sciClamp / Math.max(0.0001, R.scClamp + R.sciClamp)) * 100}%`, backgroundColor: isActive ? R.SCI_BAR_COLOR : "#e2e8f0" }} title={`${displayProductAbbrev("Showcase Incremental", "SCI")}: ${formatCurrency(R.sciAbs)}`} />
                        </div>
                      ) : (
                        <div className="h-full transition-all" style={{ width: `${R.fillW}%`, backgroundColor: isActive ? R.barColor : "#cbd5e1" }} />
                      )}
                    </div>
                    <span className="text-[9px] font-semibold tabular-nums whitespace-nowrap ml-1 w-9" style={{ color: isActive ? R.barColor : "#94a3b8" }}>{R.pct.toFixed(0)}%</span>
                  </div>
                  {/* Footer: exceeded / gap text on each side */}
                  <div className="flex text-[9px] text-[#94a3b8] mt-0.5">
                    <div className="flex-1 min-w-0 truncate">{renderFooter(L, true)}</div>
                    <div className="w-px mx-1" />
                    <div className="flex-1 min-w-0 truncate text-right">{renderFooter(R, false)}</div>
                  </div>
                </div>
              );
            };

            const renderBar = (label: string, actual: number, goal: number, isChurn: boolean, isActive: boolean, color?: string, breakdown?: { showcase: number; sci: number } | null, hideHeader?: boolean) => {
              const absActual = Math.abs(actual);
              const absGoal = Math.abs(goal);
              const zeroGoalWithActual = absGoal === 0 && absActual > 0;
              const pct = absGoal > 0 ? (absActual / absGoal) * 100 : (zeroGoalWithActual ? 100 : 0);
              let barColor = "#EF4444";
              if (isChurn) {
                // Churn uses the INVERSE of MRR-added thresholds: low attainment %
                // is good (less churn vs goal), high % fills the bar toward red.
                if (zeroGoalWithActual) barColor = "#EF4444";
                else if (pct < 50) barColor = "#00C49F";
                else if (pct < 80) barColor = "#FF6B35";
              } else {
                if (zeroGoalWithActual) barColor = "#00C49F";
                else if (pct >= 80) barColor = "#00C49F";
                else if (pct >= 50) barColor = "#FF6B35";
              }
              const exceeded = isChurn ? absActual <= absGoal && absGoal > 0 : absActual >= absGoal && absGoal > 0;
              const diff = Math.abs(absActual - absGoal);
              const sciAbs = breakdown ? Math.abs(breakdown.sci) : 0;
              const scAbs = breakdown ? Math.abs(breakdown.showcase) : 0;
              const hasBreak = !!breakdown && sciAbs > 0 && absGoal > 0;
              const scPctRaw = hasBreak ? (scAbs / absGoal) * 100 : 0;
              const sciPctRaw = hasBreak ? (sciAbs / absGoal) * 100 : 0;
              const totRaw = scPctRaw + sciPctRaw;
              const scClamp = hasBreak ? (totRaw > 100 ? (scPctRaw / totRaw) * 100 : scPctRaw) : 0;
              const sciClamp = hasBreak ? (totRaw > 100 ? (sciPctRaw / totRaw) * 100 : sciPctRaw) : 0;
              const SCI_BAR_COLOR = lightenHex(barColor, 0.55);
              return (
                <div className={`flex-1 min-w-0 ${!isActive ? "opacity-40" : ""}`}>
                  {!hideHeader && (
                    <div className="flex justify-between text-[12px] mb-0.5">
                      <span className="font-medium truncate" style={{ color: isActive ? (color || "#334155") : "#94a3b8" }}>{displayProduct(label)}</span>
                      <span className="text-[#64748b] whitespace-nowrap ml-1">{formatCurrency(absActual)} / {formatCurrency(absGoal)}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <div className="h-3 flex-1 bg-gray-200 rounded-full overflow-hidden flex">
                      {hasBreak ? (
                        <>
                          <div className="h-full transition-all" style={{ width: `${scClamp}%`, backgroundColor: isActive ? barColor : "#cbd5e1" }} title={`${displayProduct("Showcase")}: ${formatCurrency(scAbs)}`} />
                          <div className="h-full transition-all" style={{ width: `${sciClamp}%`, backgroundColor: isActive ? SCI_BAR_COLOR : "#e2e8f0" }} title={`${displayProductAbbrev("Showcase Incremental", "SCI")}: ${formatCurrency(sciAbs)}`} />
                        </>
                      ) : (
                        <div className="h-full transition-all rounded-full" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, backgroundColor: isActive ? barColor : "#cbd5e1" }} />
                      )}
                    </div>
                    <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color: isActive ? barColor : "#94a3b8" }}>{pct.toFixed(0)}%</span>
                  </div>
                  <div className="text-[11px] text-[#94a3b8] mt-0.5">
                    {prorateQuota && effectiveQuotaMode === "pacing" && absGoal > 0
                      ? (exceeded
                          ? <span className={isActive ? "text-green-600" : ""}>{formatCurrency(diff)} ahead of pace</span>
                          : <>{formatCurrency(diff)} behind pace</>)
                      : (exceeded
                          ? <span className={isActive ? "text-green-600" : ""}>{isChurn ? `Beat target by ${formatCurrency(diff)}` : `${formatCurrency(diff)} over`}</span>
                          : <>{formatCurrency(diff)} {isChurn ? "over target" : "gap"}</>)}
                  </div>
                </div>
              );
            };

            const ByRepBtn = ({ color, onClick, ariaLabel, forceFullOpacity = false }: { color: string; onClick: () => void; ariaLabel: string; forceFullOpacity?: boolean }) => (
              <button
                onClick={(e) => { e.stopPropagation(); onClick(); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onClick(); } }}
                aria-label={ariaLabel}
                title={ariaLabel}
                className={`group/byrep flex-shrink-0 self-stretch rounded transition-all duration-300 ease-out flex items-center justify-center overflow-hidden cursor-pointer w-1.5 hover:w-1/5 ${forceFullOpacity ? "opacity-100" : "opacity-50 hover:opacity-100"}`}
                style={{ backgroundColor: color }}
              >
                <span className="text-[9px] font-semibold text-white opacity-0 group-hover/byrep:opacity-100 transition-opacity duration-200 whitespace-nowrap pointer-events-none px-1">By Rep</span>
              </button>
            );

            // Stacked dual-bar renderer used in Both mode (mockup parity).
            // MRR bar (top) + Churn bar (bottom) inside a single rounded
            // border. Each bar shows the attainment $ in white, pinned left,
            // and a "$X beat" / "$X gap" variance label in dark green / red.
            // A small right-side column shows the attainment % for each bar.
            // Title row: product name on the left, $MRRActual / $MRRGoal on
            // the right. Bottom line: $ChurnActual / $ChurnGoal on the right.
            const MRR_BAR_COLOR = "#00C49F";
            const CHURN_BAR_COLOR = "#EF4444";
            const BEAT_COLOR = "#14532d"; // dark green
            const GAP_COLOR = "#7f1d1d";  // dark red
            const variance = (actual: number, goal: number, flavor: "mrr" | "churn") => {
              if (Math.abs(goal) < 1) return null;
              const diff = Math.abs(actual) - Math.abs(goal);
              const isBeat = flavor === "mrr" ? diff >= 0 : diff <= 0;
              const magnitude = Math.abs(diff);
              if (magnitude < 1) return null;
              return { label: `${formatCurrency(magnitude)} ${isBeat ? "beat" : "gap"}`, color: isBeat ? BEAT_COLOR : GAP_COLOR };
            };
            const attainmentPctColor = (actual: number, goal: number, flavor: "mrr" | "churn") => {
              const absActual = Math.abs(actual);
              const absGoal = Math.abs(goal);
              const zeroGoalWithActual = absGoal === 0 && absActual > 0;
              const pct = absGoal > 0 ? (absActual / absGoal) * 100 : (zeroGoalWithActual ? 100 : 0);
              const isChurn = flavor === "churn";
              let color = "#EF4444";
              if (isChurn) {
                if (zeroGoalWithActual) color = "#EF4444";
                else if (pct < 50) color = "#00C49F";
                else if (pct < 80) color = "#FF6B35";
              } else {
                if (zeroGoalWithActual) color = "#00C49F";
                else if (pct >= 80) color = "#00C49F";
                else if (pct >= 50) color = "#FF6B35";
              }
              return { pct, color };
            };
            const renderMetricBar = (
              actual: number,
              goal: number,
              flavor: "mrr" | "churn",
              isActive: boolean,
              position: "top" | "bottom",
              breakdown?: { showcase: number; sci: number } | null,
            ) => {
              const absActual = Math.abs(actual);
              const absGoal = Math.abs(goal);
              const hasGoal = absGoal > 0;
              const pct = hasGoal ? (absActual / absGoal) * 100 : (absActual > 0 ? 100 : 0);
              const fillPct = Math.min(100, Math.max(0, pct));
              // Inverted churn fill color: low attainment = green (good, we
              // churned less than the cap), mid = orange, high/over = red.
              // Mirrors the right-side % color from attainmentPctColor.
              const churnFill = pct < 50 ? "#00C49F" : pct < 80 ? "#FF6B35" : "#EF4444";
              const fillColor = flavor === "mrr" ? MRR_BAR_COLOR : churnFill;
              const v = isActive ? variance(actual, goal, flavor) : null;
              const sciAbs = breakdown ? Math.abs(breakdown.sci) : 0;
              const scAbs = breakdown ? Math.abs(breakdown.showcase) : 0;
              const hasBreak = !!breakdown && sciAbs > 0 && hasGoal;
              const scPctRaw = hasBreak ? (scAbs / absGoal) * 100 : 0;
              const sciPctRaw = hasBreak ? (sciAbs / absGoal) * 100 : 0;
              const totRaw = scPctRaw + sciPctRaw;
              const scClamp = hasBreak ? (totRaw > 100 ? (scPctRaw / totRaw) * 100 : scPctRaw) : 0;
              const sciClamp = hasBreak ? (totRaw > 100 ? (sciPctRaw / totRaw) * 100 : sciPctRaw) : 0;
              const SCI_BAR_COLOR = lightenHex(fillColor, 0.55);
              return (
                <div className={`h-4 bg-gray-100 relative overflow-hidden ${position === "bottom" ? "border-t border-white" : ""}`}>
                  {hasBreak ? (
                    <div className="absolute inset-y-0 left-0 flex" style={{ width: `${Math.min(100, scClamp + sciClamp)}%` }}>
                      <div className="h-full transition-all" style={{ width: `${(scClamp / Math.max(0.0001, scClamp + sciClamp)) * 100}%`, backgroundColor: isActive ? fillColor : "#cbd5e1" }} title={`${displayProduct("Showcase")}: ${formatCurrency(scAbs)}`} />
                      <div className="h-full transition-all" style={{ width: `${(sciClamp / Math.max(0.0001, scClamp + sciClamp)) * 100}%`, backgroundColor: isActive ? SCI_BAR_COLOR : "#e2e8f0" }} title={`${displayProductAbbrev("Showcase Incremental", "SCI")}: ${formatCurrency(sciAbs)}`} />
                    </div>
                  ) : (
                    <div
                      className="absolute inset-y-0 left-0 transition-all"
                      style={{ width: `${fillPct}%`, backgroundColor: isActive ? fillColor : "#cbd5e1" }}
                    />
                  )}
                  {absActual > 0 && (
                    <div
                      className="absolute inset-y-0 left-0 overflow-hidden pointer-events-none"
                      style={{ width: `${Math.max(fillPct, 0)}%` }}
                    >
                      <div className="h-full flex items-center pl-1.5 text-[10px] font-semibold text-white tabular-nums whitespace-nowrap leading-none">
                        {formatCurrency(absActual)}
                      </div>
                    </div>
                  )}
                  {v && (
                    <div className="absolute inset-y-0 left-[68px] flex items-center pointer-events-none">
                      <span className="text-[10px] font-semibold tabular-nums whitespace-nowrap leading-none" style={{ color: v.color }}>
                        {v.label}
                      </span>
                    </div>
                  )}
                </div>
              );
            };
            const renderDualBar = (
              opts: {
                label: string;
                labelColor: string;
                isActive: boolean;
                mrrActual: number;
                mrrGoal: number;
                churnActual: number;
                churnGoal: number;
                mrrBreakdown?: { showcase: number; sci: number } | null;
                churnBreakdown?: { showcase: number; sci: number } | null;
                isTotal?: boolean;
              },
            ) => {
              const { label, labelColor, isActive, mrrActual, mrrGoal, churnActual, churnGoal, mrrBreakdown, churnBreakdown, isTotal } = opts;
              const headerColor = isActive ? labelColor : "#94a3b8";
              const labelTextSize = isTotal ? "text-[14px]" : "text-[12px]";
              const mrrPct = attainmentPctColor(mrrActual, mrrGoal, "mrr");
              const churnPct = attainmentPctColor(Math.abs(churnActual), churnGoal, "churn");
              return (
                <div className={`flex-1 min-w-0 ${!isActive ? "opacity-40" : ""}`}>
                  {/* Top line: label + $MRRActual / $MRRGoal */}
                  <div className={`flex justify-between items-baseline gap-2 ${labelTextSize} mb-0.5`}>
                    <span className="font-semibold truncate" style={{ color: headerColor }}>{label}</span>
                    <span className="text-[11px] font-semibold text-[#0f172a] tabular-nums whitespace-nowrap">
                      {formatCurrency(Math.abs(mrrActual))} / {formatCurrency(Math.abs(mrrGoal))}
                    </span>
                  </div>
                  {/* Stacked dual bars + small right-side % column */}
                  <div className="flex items-stretch gap-2">
                    <div className="flex-1 min-w-0 overflow-hidden rounded-md border border-gray-200">
                      {renderMetricBar(mrrActual, mrrGoal, "mrr", isActive, "top", mrrBreakdown)}
                      {renderMetricBar(churnActual, churnGoal, "churn", isActive, "bottom", churnBreakdown)}
                    </div>
                    <div className="flex flex-col justify-between items-end w-9 tabular-nums leading-none">
                      <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color: isActive ? mrrPct.color : "#94a3b8" }}>
                        {mrrPct.pct.toFixed(0)}%
                      </span>
                      <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color: isActive ? churnPct.color : "#94a3b8" }}>
                        {churnPct.pct.toFixed(0)}%
                      </span>
                    </div>
                  </div>
                  {/* Bottom line: $ChurnActual / $ChurnGoal aligned right */}
                  <div className="flex justify-end mt-0.5">
                    <span className="text-[11px] font-semibold text-[#64748b] tabular-nums whitespace-nowrap">
                      {formatCurrency(Math.abs(churnActual))} / {formatCurrency(Math.abs(churnGoal))}
                    </span>
                  </div>
                </div>
              );
            };

            // Task #182: per-bizday pacing calendars for the GnR aggregate
            // Goal card. Both mode renders two calendars side-by-side (MRR
            // Added | Churn). Single mode renders one calendar.
            // Task #182: full proration tooltip (header + formula + bizdays
            // table + Pacing|Remaining badge + calendar) for the GnR
            // aggregate Goal card. Both mode renders two full sections
            // (MRR Added | Churn) inside one TooltipContent.
            const hasMrrEntries = mrrAddedAggregatedGoalBreakdown.length > 0;
            const hasChurnEntries = churnAggregatedGoalBreakdown.length > 0;
            const renderGnrAggCalendars = (which: "both" | "mrr" | "churn"): React.JSX.Element | null => {
              if (which === "both") {
                if (!hasMrrEntries && !hasChurnEntries) return null;
                return (
                  <TooltipContent
                    side="top"
                    sideOffset={6}
                    className="bg-white border border-gray-200 text-[#0f172a] shadow-md p-2.5 rounded text-[11px] leading-tight max-w-[940px]"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-[300px]">
                        {renderProrationSection(mrrAddedAggregatedGoalBreakdown, totMrrAddedGoal, { isAggregate: true, productName: "MRR Added", overrideClosed: totMrrAddedClosedForPopup })}
                      </div>
                      <div className="w-px self-stretch bg-gray-200" />
                      <div className="flex-1 min-w-[300px]">
                        {renderProrationSection(churnAggregatedGoalBreakdown, totChurnGoal, { isAggregate: true, productName: "Churn", overrideClosed: totChurnClosedForPopup })}
                      </div>
                    </div>
                  </TooltipContent>
                );
              }
              if (which === "mrr") {
                if (!hasMrrEntries) return null;
                return renderProrationTooltip("MRR Added Prorated Goal", mrrAddedAggregatedGoalBreakdown, totMrrAddedGoal, { isAggregate: true, productName: "MRR Added", overrideClosed: totMrrAddedClosedForPopup });
              }
              if (!hasChurnEntries) return null;
              return renderProrationTooltip("Churn Prorated Goal", churnAggregatedGoalBreakdown, totChurnGoal, { isAggregate: true, productName: "Churn", overrideClosed: totChurnClosedForPopup });
            };
            // Task #182 follow-up: same tooltip for each per-product split
            // row (Showcase, MBP). Mirrors Acq's per-product hover, with
            // Both / MRR / Churn sub-modes routed to the per-product
            // breakdown built in processedData.
            const renderGnrProductCalendars = (
              product: string,
              which: "both" | "mrr" | "churn",
              mrrGoal: number,
              churnGoal: number,
            ): React.JSX.Element | null => {
              const bk = grossProductGoalBreakdowns[product];
              if (!bk) return null;
              const hasMrr = bk.mrr.length > 0;
              const hasChurn = bk.churn.length > 0;
              // Source the BAN-side closed totals so the popup's Closed /
              // Remaining / catch-up reconcile to the per-product bar exactly.
              const prodSplit = grossProductSplit?.find(p => p.product === product);
              // Same MTD override as the aggregate path (Task #202): popup's
              // Closed/Remaining/catch-up reconcile to canonical month-to-date
              // when windowed-remaining mode is active.
              const prodMrrClosed = isWindowedRemaining
                ? (prodSplit?.mrrAddedMtd || 0)
                : (prodSplit?.mrrAddedActual || 0);
              const prodChurnClosed = isWindowedRemaining
                ? Math.abs(prodSplit?.churnMtd || 0)
                : Math.abs(prodSplit?.churnActual || 0);
              if (which === "both") {
                if (!hasMrr && !hasChurn) return null;
                return (
                  <TooltipContent
                    side="top"
                    sideOffset={6}
                    className="bg-white border border-gray-200 text-[#0f172a] shadow-md p-2.5 rounded text-[11px] leading-tight max-w-[940px]"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-[300px]">
                        {renderProrationSection(bk.mrr, mrrGoal, { productName: `${product} MRR Added`, overrideClosed: prodMrrClosed })}
                      </div>
                      <div className="w-px self-stretch bg-gray-200" />
                      <div className="flex-1 min-w-[300px]">
                        {renderProrationSection(bk.churn, churnGoal, { productName: `${product} Churn`, overrideClosed: prodChurnClosed })}
                      </div>
                    </div>
                  </TooltipContent>
                );
              }
              if (which === "mrr") {
                if (!hasMrr) return null;
                return renderProrationTooltip(`${product} MRR Added Prorated Goal`, bk.mrr, mrrGoal, { productName: `${product} MRR Added`, overrideClosed: prodMrrClosed });
              }
              if (!hasChurn) return null;
              return renderProrationTooltip(`${product} Churn Prorated Goal`, bk.churn, churnGoal, { productName: `${product} Churn`, overrideClosed: prodChurnClosed });
            };
            return (
              <>
                <div className="flex items-stretch gap-2">
                  <ByRepBtn color="#0f172a" ariaLabel="View Total by Rep" onClick={() => setQuotaDrilldownScope({ kind: "total" })} />
                  <div className="flex-1 min-w-0">
                    {quotaGrossMetric === "both" ? (
                      (hasMrrEntries || hasChurnEntries) ? (
                        <TooltipProvider delayDuration={150}>
                          <UiTooltip>
                            <TooltipTrigger asChild>
                              <div className="cursor-help">
                                {renderDualBar({
                                  label: productsLabel,
                                  labelColor: "#0f172a",
                                  isActive: true,
                                  mrrActual: totMrrAdded,
                                  mrrGoal: totMrrAddedGoal,
                                  churnActual: totChurn,
                                  churnGoal: totChurnGoal,
                                  isTotal: true,
                                })}
                              </div>
                            </TooltipTrigger>
                            {renderGnrAggCalendars("both")}
                          </UiTooltip>
                        </TooltipProvider>
                      ) : renderDualBar({
                        label: productsLabel,
                        labelColor: "#0f172a",
                        isActive: true,
                        mrrActual: totMrrAdded,
                        mrrGoal: totMrrAddedGoal,
                        churnActual: totChurn,
                        churnGoal: totChurnGoal,
                        isTotal: true,
                      })
                    ) : (
                      <>
                        <div className="flex justify-between text-[14px] mb-1">
                          <span className="font-semibold">{productsLabel}</span>
                          {((quotaGrossMetric === "mrr" && hasMrrEntries) || (quotaGrossMetric === "churn" && hasChurnEntries)) ? (
                            <TooltipProvider delayDuration={150}>
                              <UiTooltip>
                                <TooltipTrigger asChild>
                                  <span className="font-semibold cursor-help">
                                    {quotaGrossMetric === "mrr"
                                      ? <>{formatCurrency(Math.abs(totMrrAdded))} / {formatCurrency(Math.abs(totMrrAddedGoal))}</>
                                      : <>{formatCurrency(Math.abs(totChurn))} / {formatCurrency(Math.abs(totChurnGoal))}</>}
                                  </span>
                                </TooltipTrigger>
                                {renderGnrAggCalendars(quotaGrossMetric === "mrr" ? "mrr" : "churn")}
                              </UiTooltip>
                            </TooltipProvider>
                          ) : (
                            <span className="font-semibold">
                              {quotaGrossMetric === "mrr"
                                ? <>{formatCurrency(Math.abs(totMrrAdded))} / {formatCurrency(Math.abs(totMrrAddedGoal))}</>
                                : <>{formatCurrency(Math.abs(totChurn))} / {formatCurrency(Math.abs(totChurnGoal))}</>}
                            </span>
                          )}
                        </div>
                        {quotaGrossMetric === "mrr"
                          ? renderBar("MRR Added", totMrrAdded, totMrrAddedGoal, false, true, undefined, undefined, true)
                          : renderBar("Churn", totChurn, totChurnGoal, true, true, undefined, undefined, true)}
                      </>
                    )}
                  </div>
                </div>
                <div className="space-y-3 border-t border-border/50 pt-3">
                  {grossProductSplit.map(ps => {
                    const isActive = activeProductSet.has(ps.product);
                    const prodColor = PRODUCT_COLORS[ps.product] || "#64748b";
                    const psBk = grossProductGoalBreakdowns[ps.product];
                    const psHasMrr = !!psBk && psBk.mrr.length > 0;
                    const psHasChurn = !!psBk && psBk.churn.length > 0;
                    const dualBarEl = renderDualBar({
                      label: ps.product,
                      labelColor: prodColor,
                      isActive,
                      mrrActual: ps.mrrAddedActual,
                      mrrGoal: ps.mrrAddedGoal,
                      churnActual: ps.churnActual,
                      churnGoal: ps.churnGoal,
                      mrrBreakdown: ps.mrrAddedBreakdown,
                      churnBreakdown: ps.churnBreakdown,
                    });
                    return (
                      <div key={ps.product} className="flex items-stretch gap-2">
                        <ByRepBtn color={prodColor} ariaLabel={`View ${displayProduct(ps.product)} by Rep`} onClick={() => setQuotaDrilldownScope({ kind: "product", product: ps.product })} forceFullOpacity={filters.products.length > 0 && isActive} />
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleProductFilter(ps.product)}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleProductFilter(ps.product); } }}
                          className="flex-1 min-w-0 cursor-pointer rounded-md px-1 py-0.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                          title={isActive ? `Remove ${displayProduct(ps.product)} from filter` : `Filter to ${displayProduct(ps.product)}`}
                        >
                          {quotaGrossMetric === "both" ? (
                            (psHasMrr || psHasChurn) ? (
                              <TooltipProvider delayDuration={150}>
                                <UiTooltip>
                                  <TooltipTrigger asChild>
                                    <div className="cursor-help">{dualBarEl}</div>
                                  </TooltipTrigger>
                                  {renderGnrProductCalendars(ps.product, "both", ps.mrrAddedGoal, ps.churnGoal)}
                                </UiTooltip>
                              </TooltipProvider>
                            ) : dualBarEl
                          ) : (
                            <>
                              <div className={`flex justify-between items-center text-[12px] mb-0.5 gap-2 ${!isActive ? "opacity-40" : ""}`}>
                                <span className="font-medium truncate" style={{ color: isActive ? prodColor : "#94a3b8" }}>{displayProduct(ps.product)}</span>
                                {((quotaGrossMetric === "mrr" && psHasMrr) || (quotaGrossMetric === "churn" && psHasChurn)) ? (
                                  <TooltipProvider delayDuration={150}>
                                    <UiTooltip>
                                      <TooltipTrigger asChild>
                                        <span className="text-[#64748b] whitespace-nowrap ml-1 cursor-help">
                                          {quotaGrossMetric === "mrr"
                                            ? <>{formatCurrency(Math.abs(ps.mrrAddedActual))} / {formatCurrency(Math.abs(ps.mrrAddedGoal))}</>
                                            : <>{formatCurrency(Math.abs(ps.churnActual))} / {formatCurrency(Math.abs(ps.churnGoal))}</>}
                                        </span>
                                      </TooltipTrigger>
                                      {renderGnrProductCalendars(ps.product, quotaGrossMetric === "mrr" ? "mrr" : "churn", ps.mrrAddedGoal, ps.churnGoal)}
                                    </UiTooltip>
                                  </TooltipProvider>
                                ) : (
                                  <span className="text-[#64748b] whitespace-nowrap ml-1">
                                    {quotaGrossMetric === "mrr"
                                      ? <>{formatCurrency(Math.abs(ps.mrrAddedActual))} / {formatCurrency(Math.abs(ps.mrrAddedGoal))}</>
                                      : <>{formatCurrency(Math.abs(ps.churnActual))} / {formatCurrency(Math.abs(ps.churnGoal))}</>}
                                  </span>
                                )}
                              </div>
                              {quotaGrossMetric === "mrr"
                                ? renderBar("MRR Added Goal", ps.mrrAddedActual, ps.mrrAddedGoal, false, isActive, prodColor, ps.mrrAddedBreakdown, true)
                                : renderBar("Churn Goal", ps.churnActual, ps.churnGoal, true, isActive, prodColor, ps.churnBreakdown, true)}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })() : (() => {
            const ByRepBtnNet = ({ color, onClick, ariaLabel, forceFullOpacity = false }: { color: string; onClick: () => void; ariaLabel: string; forceFullOpacity?: boolean }) => (
              <button
                onClick={(e) => { e.stopPropagation(); onClick(); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onClick(); } }}
                aria-label={ariaLabel}
                title={ariaLabel}
                className={`group/byrep flex-shrink-0 self-stretch rounded transition-all duration-300 ease-out flex items-center justify-center overflow-hidden cursor-pointer w-1.5 hover:w-1/3 ${forceFullOpacity ? "opacity-100" : "opacity-50 hover:opacity-100"}`}
                style={{ backgroundColor: color }}
              >
                <span className="text-[9px] font-semibold text-white opacity-0 group-hover/byrep:opacity-100 transition-opacity duration-200 whitespace-nowrap pointer-events-none px-1">By Rep</span>
              </button>
            );
            // Aggregate proration breakdown for the tooltip on activeTotalGoal.
            // Derived from the per-product breakdowns of currently-active
            // products so the displayed total always reconciles with the sum
            // of pq.goal values shown below.
            // Type, helpers and renderCalendar/renderProrationTooltip are
            // lifted to component scope (Task #182) so the GnR Goal-card
            // branch can render the same calendar/tooltip for MRR Added and
            // Churn. The non-GnR aggregatedGoalBreakdown stays here because
            // it depends on local closures (allProductQuotas + filter set).
            const aggregatedGoalBreakdown: GoalBreakdownEntry[] = (() => {
              const merged: Record<string, GoalBreakdownEntry> = {};
              for (const pq of allProductQuotas) {
                if (!activeProductSet.has(pq.product)) continue;
                const list = pq.goalBreakdown || [];
                for (const e of list) {
                  const m = merged[e.ymKey];
                  if (m) {
                    m.monthlyGoal += e.monthlyGoal;
                    m.goalInWindow += e.goalInWindow;
                    m.closed += e.closed;
                    m.contribution += e.contribution;
                    if (e.closedByDay) {
                      for (const [k, v] of Object.entries(e.closedByDay)) {
                        const dNum = parseInt(k, 10);
                        m.closedByDay[dNum] = (m.closedByDay[dNum] || 0) + v;
                      }
                    }
                  } else {
                    merged[e.ymKey] = { ...e, closedByDay: { ...(e.closedByDay || {}) } };
                  }
                }
              }
              return Object.values(merged).sort((a, b) => a.ymKey.localeCompare(b.ymKey));
            })();
            return (
          <>
          <div className="flex items-stretch gap-2">
            <ByRepBtnNet color="#0f172a" ariaLabel="View Total by Rep" onClick={() => setQuotaDrilldownScope({ kind: "total" })} />
            <div className="flex-1 min-w-0">
              <div className="flex justify-between text-[14px] mb-1">
                <span className="font-semibold">{productsLabel}</span>
                {aggregatedGoalBreakdown.length > 0 ? (
                  <TooltipProvider delayDuration={150}>
                    <UiTooltip>
                      <TooltipTrigger asChild>
                        <span className="font-semibold cursor-help">{formatCurrency(activeTotalMrrForQuota)} / {formatCurrency(activeTotalGoal)}</span>
                      </TooltipTrigger>
                      {renderProrationTooltip("Prorated Goal", aggregatedGoalBreakdown, activeTotalGoal, { perRepSum: activeTotalGoalPerRepSum, isAggregate: true, overrideClosed: isWindowedRemaining ? allProductQuotas.filter(p => activeProductSet.has(p.product)).reduce((s, p) => s + (p.mtdClosed || 0), 0) : undefined })}
                    </UiTooltip>
                  </TooltipProvider>
                ) : (
                  <span className="font-semibold">{formatCurrency(activeTotalMrrForQuota)} / {formatCurrency(activeTotalGoal)}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className="h-4 flex-1 bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-full transition-all" style={{ width: `${Math.min(100, Math.max(0, quotaPct))}%`, backgroundColor: quotaColor }} />
                </div>
                <span className="text-[13px] font-semibold whitespace-nowrap" style={{ color: quotaColor }}>{quotaPct.toFixed(0)}%</span>
              </div>
              <div className="text-[12px] text-[#64748b] mt-1">
                {prorateQuota && effectiveQuotaMode === "pacing" && !isNegativeQuota
                  ? (quotaExceeded
                      ? <span className="text-green-600">{formatCurrency(exceedAmt)} ahead of pace</span>
                      : <>{formatCurrency(remainingToHit)} behind pace</>)
                  : (quotaExceeded
                      ? <span className="text-green-600">{isNegativeQuota ? `Beat churn target by ${formatCurrency(exceedAmt)}` : `Exceeded by ${formatCurrency(exceedAmt)}`}</span>
                      : isNegativeQuota
                        ? <>{formatCurrency(Math.abs(remainingToHit))} more churn than target</>
                        : <>{formatCurrency(remainingToHit)} remaining to hit monthly goal</>)}
              </div>
              {quotaWindow.kind === "windowed" && quotaWindow.wasClamped && effectiveQuotaMode === "remaining" && (() => {
                const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                return (
                  <div className="text-[10.5px] text-[#94a3b8] mt-0.5 italic">
                    Showing goal for {fmt(quotaWindow.effectiveStart)}–{fmt(quotaWindow.effectiveEnd)} ({quotaWindow.windowBizdays} business {quotaWindow.windowBizdays === 1 ? "day" : "days"})
                  </div>
                );
              })()}
            </div>
          </div>

          <div className="space-y-2 border-t border-border/50 pt-3">
            {allProductQuotas.map((pq) => {
              const isActive = activeProductSet.has(pq.product);
              const pIsNeg = pq.goal < 0;
              const pZeroGoalWithActual = pq.goal === 0 && pq.mrr !== 0;
              const pQuotaPct = pq.goal !== 0
                ? (pIsNeg
                    ? 100 + ((pq.mrr - pq.goal) / Math.abs(pq.goal)) * 100
                    : (pq.mrr / pq.goal) * 100)
                : (pZeroGoalWithActual ? 100 : 0);
              let pQuotaColor = "#EF4444";
              if (pZeroGoalWithActual) pQuotaColor = pq.mrr > 0 ? "#00C49F" : "#EF4444";
              else if (pQuotaPct >= 80) pQuotaColor = "#00C49F";
              else if (pQuotaPct >= 50) pQuotaColor = "#FF6B35";
              const pExceeded = pIsNeg ? pq.mrr > pq.goal && pq.goal !== 0 : pq.mrr >= pq.goal && pq.goal > 0;
              const pExceedAmt = Math.abs(pq.mrr - pq.goal);
              const pRemaining = Math.max(0, pq.goal - pq.mrr);
              // SCI segment uses a lighter shade of the Showcase attainment color
              // so the pair (SC + SCI) stays visually unified as attainment changes.
              const lighten = (hex: string, amt: number) => {
                const h = hex.replace("#", "");
                const r = parseInt(h.slice(0, 2), 16);
                const g = parseInt(h.slice(2, 4), 16);
                const b = parseInt(h.slice(4, 6), 16);
                const mix = (c: number) => Math.round(c + (255 - c) * amt);
                const toHex = (n: number) => n.toString(16).padStart(2, "0");
                return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
              };
              const SCI_COLOR = lighten(pQuotaColor, 0.6);
              const SCIR_COLOR = lighten(pQuotaColor, 0.75);
              const OV_COLOR = lighten(pQuotaColor, 0.87);
              const breakdown = pq.breakdown as { showcase: number; sci: number; scir: number; overage: number } | null;
              const hasBreakdown = !!breakdown && (breakdown.sci + breakdown.scir + (breakdown.overage || 0)) > 0 && pq.goal > 0;
              const showcasePct = hasBreakdown ? Math.max(0, (breakdown!.showcase / pq.goal) * 100) : 0;
              const sciPct = hasBreakdown ? Math.max(0, (breakdown!.sci / pq.goal) * 100) : 0;
              const scirPct = hasBreakdown ? Math.max(0, (breakdown!.scir / pq.goal) * 100) : 0;
              const overagePct = hasBreakdown ? Math.max(0, ((breakdown!.overage || 0) / pq.goal) * 100) : 0;
              const totalPctRaw = showcasePct + sciPct + scirPct + overagePct;
              const showcaseClamped = hasBreakdown ? (totalPctRaw > 100 ? (showcasePct / totalPctRaw) * 100 : showcasePct) : 0;
              const sciClamped = hasBreakdown ? (totalPctRaw > 100 ? (sciPct / totalPctRaw) * 100 : sciPct) : 0;
              const scirClamped = hasBreakdown ? (totalPctRaw > 100 ? (scirPct / totalPctRaw) * 100 : scirPct) : 0;
              const overageClamped = hasBreakdown ? (totalPctRaw > 100 ? (overagePct / totalPctRaw) * 100 : overagePct) : 0;
              const prodColor = PRODUCT_COLORS[pq.product] || "#64748b";
              return (
                <div key={pq.product} className="flex items-stretch gap-2">
                  <ByRepBtnNet color={prodColor} ariaLabel={`View ${displayProduct(pq.product)} by Rep`} onClick={() => setQuotaDrilldownScope({ kind: "product", product: pq.product })} forceFullOpacity={filters.products.length > 0 && isActive} />
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleProductFilter(pq.product)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleProductFilter(pq.product); } }}
                    className={`flex-1 min-w-0 cursor-pointer rounded-md px-1 py-0.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors ${!isActive ? "opacity-40" : ""}`}
                    title={isActive ? `Remove ${displayProduct(pq.product)} from filter` : `Filter to ${displayProduct(pq.product)}`}
                  >
                    <div className="flex justify-between items-center text-[12px] mb-0.5 gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium" style={{ color: isActive ? prodColor : "#94a3b8" }}>{displayProduct(pq.product)}</span>
                      </div>
                      {(() => {
                        const goalEntries = pq.goalBreakdown || [];
                        if (goalEntries.length === 0) {
                          return <span className="text-[#64748b] whitespace-nowrap">{formatCurrency(pq.mrr)} / {formatCurrency(pq.goal)}</span>;
                        }
                        return (
                          <TooltipProvider delayDuration={150}>
                            <UiTooltip>
                              <TooltipTrigger asChild>
                                <span className="text-[#64748b] whitespace-nowrap cursor-help">{formatCurrency(pq.mrr)} / {formatCurrency(pq.goal)}</span>
                              </TooltipTrigger>
                              {renderProrationTooltip(`${pq.product} prorated goal`, goalEntries as GoalBreakdownEntry[], pq.goal, { perRepSum: pq.goalPerRepSum, productName: pq.product, overrideClosed: isWindowedRemaining ? (pq.mtdClosed || 0) : undefined })}
                            </UiTooltip>
                          </TooltipProvider>
                        );
                      })()}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {hasBreakdown ? (
                        <TooltipProvider delayDuration={150}>
                          <UiTooltip>
                            <TooltipTrigger asChild>
                              <div className="h-3 flex-1 bg-gray-200 rounded-full overflow-hidden flex cursor-help">
                                <div className="h-full transition-all" style={{ width: `${showcaseClamped}%`, backgroundColor: isActive ? pQuotaColor : "#cbd5e1" }} />
                                <div className="h-full transition-all" style={{ width: `${sciClamped}%`, backgroundColor: isActive ? SCI_COLOR : "#e2e8f0" }} />
                                <div className="h-full transition-all" style={{ width: `${scirClamped}%`, backgroundColor: isActive ? SCIR_COLOR : "#f1f5f9" }} />
                                <div className="h-full transition-all" style={{ width: `${overageClamped}%`, backgroundColor: isActive ? OV_COLOR : "#f8fafc" }} />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent
                              side="top"
                              sideOffset={6}
                              className="bg-white border border-gray-200 text-[#0f172a] shadow-md p-2 rounded text-[12px] leading-tight"
                            >
                              <div className="font-semibold mb-1">{displayProduct(pq.product)}</div>
                              <div className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: isActive ? pQuotaColor : "#cbd5e1" }} />
                                <span>{displayProductAbbrev("Showcase", "SC")}: <span className="font-medium">{formatCurrency(breakdown!.showcase)}</span></span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: isActive ? SCI_COLOR : "#e2e8f0" }} />
                                <span>{displayProductAbbrev("Showcase Incremental", "SCi")}: <span className="font-medium">{formatCurrency(breakdown!.sci)}</span></span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: isActive ? SCIR_COLOR : "#f1f5f9" }} />
                                <span>{displayProductAbbrev("Showcase Incremental - Re/Max", "SCr")}: <span className="font-medium">{formatCurrency(breakdown!.scir)}</span></span>
                              </div>
                              {(breakdown!.overage || 0) > 0 && (
                                <div className="flex items-center gap-1.5">
                                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: isActive ? OV_COLOR : "#f8fafc" }} />
                                  <span>{displayProductAbbrev("Overage", "OV")}: <span className="font-medium">{formatCurrency(breakdown!.overage)}</span></span>
                                </div>
                              )}
                              <div className="text-[#64748b] mt-1 pt-1 border-t border-gray-100">
                                Total: <span className="font-medium text-[#0f172a]">{formatCurrency(breakdown!.showcase + breakdown!.sci + breakdown!.scir + (breakdown!.overage || 0))}</span> / {formatCurrency(pq.goal)}
                              </div>
                            </TooltipContent>
                          </UiTooltip>
                        </TooltipProvider>
                      ) : (
                        <div className="h-3 flex-1 bg-gray-200 rounded-full overflow-hidden flex">
                          <div className="h-full transition-all rounded-full" style={{ width: `${Math.min(100, Math.max(0, pQuotaPct))}%`, backgroundColor: isActive ? pQuotaColor : "#cbd5e1" }} />
                        </div>
                      )}
                      <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color: isActive ? pQuotaColor : "#94a3b8" }}>{pQuotaPct.toFixed(0)}%</span>
                    </div>
                    <div className="text-[11px] text-[#94a3b8] mt-0.5">
                      {prorateQuota && effectiveQuotaMode === "pacing" && !pIsNeg
                        ? (pExceeded
                            ? <span className={isActive ? "text-green-600" : ""}>{formatCurrency(pExceedAmt)} ahead of pace</span>
                            : <>{formatCurrency(pRemaining)} behind pace</>)
                        : (pExceeded
                            ? <span className={isActive ? "text-green-600" : ""}>{pIsNeg ? `Beat target by ${formatCurrency(pExceedAmt)}` : `Exceeded by ${formatCurrency(pExceedAmt)}`}</span>
                            : pIsNeg
                              ? <>{formatCurrency(Math.abs(pRemaining))} more churn than target</>
                              : <>{formatCurrency(pRemaining)} remaining</>)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          </>
            );
          })()}
        </CardContent>
      </Card>

      <Card
        className="no-shadow flex flex-col"
        style={(forecastShowNet || (!forecastShowNet && (forecastMetric === "mrr" || forecastMetric === "both"))) && forecastRepDrilldownProduct ? { height: forecastCardExpanded ? 805 : 620 } : undefined}
      >
        <CardHeader className="px-4 pt-4 pb-0">
          <div className="flex items-center gap-2">
            {(forecastShowNet || (!forecastShowNet && (forecastMetric === "mrr" || forecastMetric === "both"))) && forecastRepDrilldownProduct ? (
              <>
                <button
                  onClick={() => setForecastRepDrilldownProduct(null)}
                  aria-label="Back to Forecast"
                  title="Back"
                  className="flex items-center justify-center w-5 h-5 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <CardTitle className="text-[16px] font-semibold">
                  {!forecastShowNet
                    ? (forecastMetric === "mrr" ? "MRR Added Forecast:" : "Forecast:")
                    : "Forecast:"}&nbsp;
                  <span style={{ color: PRODUCT_COLORS[forecastRepDrilldownProduct] || "#64748b" }}>{displayProduct(forecastRepDrilldownProduct)}</span>
                </CardTitle>
              </>
            ) : !forecastShowNet ? (
              <CardTitle className="text-[16px] font-semibold">
                {forecastMetric === "mrr" ? "MRR Added Forecast" : forecastMetric === "churn" ? "Churn Forecast" : "Forecast"}
              </CardTitle>
            ) : (
              <CardTitle className="text-[16px] font-semibold">Forecast</CardTitle>
            )}
            <SfReportLink href={SF_OPPS_REPORT} />
            <ForecastLogicLink />
            {grossProductSplit && !forecastRepDrilldownProduct && (
              <div className="ml-auto flex items-center rounded border border-gray-200 bg-white overflow-hidden text-[10px] font-semibold leading-none">
                {(["both", "mrr", "churn", "net"] as const).map((m, i) => {
                  const active = forecastMetric === m;
                  const label = m === "both" ? "Both" : m === "mrr" ? "MRR" : m === "churn" ? "Churn" : "Net";
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setForecastMetric(m); }}
                      title={`Show ${label}`}
                      className={`px-1.5 py-0.5 transition-colors ${active ? "bg-[#0f172a] text-white" : "text-[#475569] hover:bg-gray-50"} ${i > 0 ? "border-l border-gray-200" : ""}`}
                    >{label}</button>
                  );
                })}
              </div>
            )}
            {(forecastShowNet || (!forecastShowNet && (forecastMetric === "mrr" || forecastMetric === "both"))) && forecastRepDrilldownProduct && (
              <button
                type="button"
                onClick={() => setForecastCardExpanded(v => !v)}
                aria-label={forecastCardExpanded ? "Collapse card" : "Expand card"}
                aria-pressed={forecastCardExpanded}
                title={forecastCardExpanded ? "Collapse card" : "Expand card"}
                className="ml-auto flex items-center justify-center w-5 h-5 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              >
                {forecastCardExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-4 flex-1 flex flex-col min-h-0 overflow-hidden">
          {forecastShowNet ? (<>
          {(() => {
            const totalGap = activeTotalGoal - activeTotalWeighted;
            const totalGapColor = totalGap > 0 ? "#EF4444" : totalGap < 0 ? "#10B981" : "#64748b";
            const totalGapText = totalGap >= 0 ? `$${formatCurrencyShort(totalGap)}` : `-$${formatCurrencyShort(Math.abs(totalGap))}`;
            // When the by-rep view is open the 4 aggregate tiles double as
            // sort controls — each tile becomes a button that selects the
            // metric (or toggles direction if already active). In the
            // per-product view the tiles render as plain divs.
            const inRepView = !!forecastRepDrilldownProduct;
            const sortMetric = repForecastSortMetric;
            const sortDir = repForecastSortDir;
            const sortArrow = (m: RepSortMetric) => {
              if (!inRepView || sortMetric !== m) return null;
              return (
                <span className="ml-0.5 text-[9px] leading-none align-middle" aria-hidden="true">
                  {sortDir === "asc" ? "▲" : "▼"}
                </span>
              );
            };
            const tileLabelClass = (m: RepSortMetric) =>
              `text-[10px] uppercase tracking-[0.5px] leading-tight ${
                inRepView && sortMetric === m ? "text-[#1e293b] font-semibold" : "text-[#64748b]"
              }`;
            const tileButtonClass = (extra = "") =>
              `text-center flex flex-col min-w-0 ${extra} ${
                inRepView
                  ? "cursor-pointer rounded transition-colors hover:bg-black/[0.03] dark:hover:bg-white/5 px-1 -mx-1"
                  : ""
              }`;
            const Tile = ({
              metric, title, extra, children,
            }: { metric: RepSortMetric; title: string; extra?: string; children: React.ReactNode }) => {
              if (inRepView) {
                return (
                  <button
                    type="button"
                    onClick={() => handleRepSortTileClick(metric)}
                    title={`${title} — click to sort by this metric (toggle direction).`}
                    aria-label={`Sort by ${title}${sortMetric === metric ? `, currently ${sortDir === "asc" ? "ascending" : "descending"}` : ""}`}
                    aria-pressed={sortMetric === metric}
                    className={tileButtonClass(extra)}
                  >
                    {children}
                  </button>
                );
              }
              return (
                <div className={tileButtonClass(extra)} title={title}>
                  {children}
                </div>
              );
            };
            return (
              <div className="grid grid-cols-4 gap-2 pt-1 pb-3 border-b border-border min-h-[78px]">
                <Tile
                  metric="winRateToHit"
                  title={`% of remaining unweighted pipeline that must close to hit goal = (Remaining-mode goal − MRR booked) ÷ Weighted pipeline.${prorateQuota && effectiveQuotaMode === "pacing" ? " Forecast always uses Remaining-mode goal regardless of the Quota Mode toggle." : ""}`}
                >
                  <div className={tileLabelClass("winRateToHit")}>
                    Win Rate to Hit{sortArrow("winRateToHit")}
                    {prorateQuota && effectiveQuotaMode === "pacing" && (
                      <span className="ml-1 text-[8px] uppercase tracking-wider text-purple-700 font-semibold" title="Forecast hard-wired to Remaining-mode goal">R</span>
                    )}
                  </div>
                  <div className="text-[16px] font-bold mt-auto pt-1 tabular-nums whitespace-nowrap truncate" style={{ color: "#FF6B35" }}>{winRateToHit.toFixed(0)}%</div>
                </Tile>
                <Tile
                  metric="coverage"
                  title="Weighted pipeline ÷ goal. How many times your goal is covered by probability-weighted pipeline."
                  extra="border-l border-border"
                >
                  <div className={tileLabelClass("coverage")}>Pipeline Coverage{sortArrow("coverage")}</div>
                  <div className="text-[16px] font-bold mt-auto pt-1 tabular-nums whitespace-nowrap truncate" style={{ color: "#006AFF" }}>{coverage.toFixed(1)}x</div>
                </Tile>
                <Tile
                  metric="weighted"
                  title="Total weighted pipeline across active products."
                  extra="border-l border-border"
                >
                  <div className={tileLabelClass("weighted")}>Total Weighted{sortArrow("weighted")}</div>
                  <div className="text-[16px] font-bold text-[#006AFF] mt-auto pt-1 tabular-nums whitespace-nowrap truncate">${formatCurrencyShort(activeTotalWeighted)}</div>
                </Tile>
                <Tile
                  metric="gap"
                  title="Gap = Sum of active product goals − Total Weighted. Positive = more pipeline still needed; negative = surplus."
                  extra="border-l border-border"
                >
                  <div className={tileLabelClass("gap")}>Gap{sortArrow("gap")}</div>
                  <div className="text-[16px] font-bold tabular-nums mt-auto pt-1 whitespace-nowrap truncate" style={{ color: totalGapColor }}>{totalGapText}</div>
                </Tile>
              </div>
            );
          })()}

          {(() => {
            // Tall, skinny vertical "By Rep" button — mirrors the Quota card's
            // ByRepBtnNet (same width, hover-expand, opacity, and label fade-in)
            // so the affordance is consistent across cards.
            const ByRepBtn = ({ color, onClick, ariaLabel, forceFullOpacity = false }: { color: string; onClick: () => void; ariaLabel: string; forceFullOpacity?: boolean }) => (
              <button
                onClick={(e) => { e.stopPropagation(); onClick(); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onClick(); } }}
                aria-label={ariaLabel}
                title={ariaLabel}
                className={`group/byrep flex-shrink-0 self-stretch rounded transition-all duration-300 ease-out flex items-center justify-center overflow-hidden cursor-pointer w-1.5 hover:w-1/3 ${forceFullOpacity ? "opacity-100" : "opacity-50 hover:opacity-100"}`}
                style={{ backgroundColor: color }}
              >
                <span className="text-[9px] font-semibold text-white opacity-0 group-hover/byrep:opacity-100 transition-opacity duration-200 whitespace-nowrap pointer-events-none px-1">By Rep</span>
              </button>
            );

            const fmtSignedGapShort = (g: number) => g >= 0 ? `$${formatCurrencyShort(g)}` : `-$${formatCurrencyShort(Math.abs(g))}`;
            const fmtMultiple = (n: number) => Number.isInteger(n) ? `${n}` : n.toFixed(1).replace(/\.0$/, "");

            // Renders a single forecast bar row body (mirrors the per-product
            // bar layout). Used both for the per-product view and per-rep view
            // inside the AcqNet Forecast card so they share visual format.
            // `target` is the coverage multiple driving the bar — defaults to
            // the avg effective target across visible reps but per-rep rows
            // pass the rep's own coverage_target.
            const renderForecastBarBody = (opts: {
              label: string;
              labelColor: string;
              isActive: boolean;
              goal: number;
              mrr: number;
              weighted: number;
              target?: number;
              onLabelClick?: () => void;
              labelTitle?: string;
            }) => {
              const { label, labelColor, isActive, goal, mrr, weighted, onLabelClick, labelTitle } = opts;
              const TARGET_MULTIPLE = (typeof opts.target === "number" && opts.target > 0)
                ? opts.target
                : effectiveCoverageTarget;
              const multiple = goal > 0 ? weighted / goal : 0;
              const exceeds = multiple > TARGET_MULTIPLE;
              const fillPct = exceeds ? 100 : (multiple / TARGET_MULTIPLE) * 100;
              const quotaMarkerPct = (1 / TARGET_MULTIPLE) * 100;
              const fillColor = exceeds ? "#00C49F" : multiple >= 1 ? "#006AFF" : "#FF6B35";
              const wrToHit = weighted > 0 && mrr < goal ? Math.max(0, ((goal - mrr) / weighted) * 100) : 0;
              const gap = goal - weighted;
              const gapColor = !isActive ? "#94a3b8" : gap > 0 ? "#EF4444" : gap < 0 ? "#10B981" : "#64748b";
              return (
                <>
                  <div className="flex justify-between items-center text-[12px] mb-0.5 gap-2">
                    {onLabelClick ? (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); onLabelClick(); }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            onLabelClick();
                          }
                        }}
                        className="font-medium truncate cursor-pointer hover:underline"
                        style={{ color: isActive ? labelColor : "#94a3b8" }}
                        title={labelTitle}
                      >
                        {displayProduct(label)}
                      </span>
                    ) : (
                      <span className="font-medium truncate" style={{ color: isActive ? labelColor : "#94a3b8" }}>{displayProduct(label)}</span>
                    )}
                    <span className="text-[11px] text-[#94a3b8] whitespace-nowrap tabular-nums">{fmtMultiple(TARGET_MULTIPLE)}x&nbsp;${formatCurrencyShort(goal * TARGET_MULTIPLE)}</span>
                  </div>
                  <div className="relative group/bar">
                    <div
                      className="absolute opacity-0 group-hover/bar:opacity-100 transition-opacity text-[10px] text-[#94a3b8] whitespace-nowrap pointer-events-none tabular-nums z-10"
                      style={{ left: `${quotaMarkerPct}%`, transform: "translateX(-50%)", bottom: "100%" }}
                    >
                      1x&nbsp;${formatCurrencyShort(goal)}
                    </div>
                    <div className="relative h-3 w-full rounded-full overflow-hidden bg-gray-100">
                      <div className="absolute inset-0 opacity-[0.07] rounded-full" style={{ background: `repeating-linear-gradient(45deg, transparent, transparent 4px, #94a3b8 4px, #94a3b8 5px)` }} />
                      <div className="absolute top-0 bottom-0 left-0 h-full rounded-l-full transition-all" style={{ width: `${fillPct}%`, backgroundColor: isActive ? fillColor : "#cbd5e1" }} />
                      {fillPct > 25 && (
                        <div className="absolute top-0 bottom-0 left-0 flex items-center justify-center text-[9px] font-semibold text-white pointer-events-none leading-none" style={{ width: `${fillPct}%` }}>
                          ${formatCurrencyShort(weighted)}
                        </div>
                      )}
                      <div className="absolute top-0 bottom-0 flex flex-col items-center" style={{ left: `${quotaMarkerPct}%` }}>
                        <div className="w-0.5 h-full bg-[#1e293b]/40" />
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-2 mt-1 text-[13px] font-semibold tabular-nums">
                    <div className="text-center" style={{ color: isActive ? "#FF6B35" : "#94a3b8" }} title="Win Rate to Hit">{wrToHit.toFixed(0)}%</div>
                    <div className="text-center" style={{ color: isActive ? fillColor : "#94a3b8" }} title="Pipeline Coverage">{multiple.toFixed(1)}x</div>
                    <div className="text-center" style={{ color: isActive ? "#006AFF" : "#94a3b8" }} title="Weighted">${formatCurrencyShort(weighted)}</div>
                    <div className="text-center" style={{ color: gapColor }} title="Gap (Goal − Weighted)">{fmtSignedGapShort(gap)}</div>
                  </div>
                </>
              );
            };

            // Per-product list — always rendered so the Forecast card's
            // height stays driven by it. When the by-rep view is open we
            // hide it (visibility:hidden keeps it taking up space) and
            // overlay the per-rep list at absolute inset-0 so the rep list
            // can scroll within the same fixed footprint.
            const productListNode = (
              <div className={`space-y-2 ${forecastRepDrilldownProduct ? "invisible" : ""}`}>
                {allProductQuotas.map((pq) => {
                  const isActive = activeProductSet.has(pq.product);
                  const prodColor = PRODUCT_COLORS[pq.product] || "#64748b";
                  return (
                    <div key={pq.product} className="flex items-stretch gap-2">
                      <ByRepBtn
                        color={prodColor}
                        ariaLabel={`View ${displayProduct(pq.product)} forecast by Rep`}
                        onClick={() => {
                          // Opening a product's by-Rep view also filters the
                          // dashboard to that product. Showcase pulls SCi
                          // along by default since SCi rolls into Showcase
                          // attainment everywhere else in the app.
                          const next = pq.product === "Showcase"
                            ? ["Showcase", "Showcase Incremental", "Showcase Incremental - Re/Max", "Overage"]
                            : [pq.product];
                          onProductsChange(next);
                          setForecastRepDrilldownProduct(pq.product);
                        }}
                        forceFullOpacity={filters.products.length > 0 && isActive}
                      />
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setForecastPopupProduct(pq.product)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setForecastPopupProduct(pq.product); } }}
                        className={`flex-1 min-w-0 cursor-pointer rounded-md px-1 py-0.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors ${!isActive ? "opacity-40" : ""}`}
                        title={`Open ${displayProduct(pq.product)} forecast`}
                      >
                        {renderForecastBarBody({
                          label: pq.product,
                          labelColor: prodColor,
                          isActive,
                          goal: pq.goal,
                          mrr: pq.mrr,
                          weighted: pq.weighted,
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );

            let repListNode: React.ReactNode = null;
            if (forecastRepDrilldownProduct) {
              const prod = forecastRepDrilldownProduct;
              const prodColor = PRODUCT_COLORS[prod] || "#64748b";
              type RepRow = {
                name: string;
                goal: number;
                mrr: number;
                weighted: number;
                coverage: number;
                winRateToHit: number;
                gap: number;
              };
              // Source from `forecastRepBreakdowns` (broader rep set that
              // ignores the active aggDim filter) so applying a Rep / FLM /
              // SLM / Region / Segment filter doesn't remove rows from this
              // list — only highlights one and greys out the rest.
              const repRows: RepRow[] = (forecastRepBreakdowns || []).map(rb => {
                const pp = rb.perProduct[prod];
                if (!pp) return null;
                const coverage = pp.goal > 0 ? pp.weighted / pp.goal : -Infinity;
                const wrToHit = pp.weighted > 0 && pp.mrr < pp.goal
                  ? Math.max(0, ((pp.goal - pp.mrr) / pp.weighted) * 100)
                  : 0;
                const gap = pp.goal - pp.weighted;
                return {
                  name: rb.name,
                  goal: pp.goal,
                  mrr: pp.mrr,
                  weighted: pp.weighted,
                  coverage,
                  winRateToHit: wrToHit,
                  gap,
                };
              }).filter((x): x is RepRow => !!x);
              // Reps with no goal for this product (coverage = -Infinity)
              // always sink to the bottom regardless of sort metric/direction.
              const noGoal = (r: RepRow) => !Number.isFinite(r.coverage);
              const dirMul = repForecastSortDir === "asc" ? 1 : -1;
              const sortKey = (r: RepRow): number => {
                switch (repForecastSortMetric) {
                  case "coverage": return Number.isFinite(r.coverage) ? r.coverage : 0;
                  case "weighted": return r.weighted;
                  case "winRateToHit": return r.winRateToHit;
                  case "gap": return r.gap;
                }
              };
              repRows.sort((a, b) => {
                const aNo = noGoal(a), bNo = noGoal(b);
                if (aNo && !bNo) return 1;
                if (!aNo && bNo) return -1;
                if (aNo && bNo) return a.name.localeCompare(b.name);
                const diff = sortKey(a) - sortKey(b);
                return diff === 0 ? a.name.localeCompare(b.name) : diff * dirMul;
              });
              const dimForCard = aggDim(filters.aggregateBy);
              // "Any active" = at least one row matches the current aggDim
              // filter. When true we treat the matched row as the highlighted
              // selection and mute the rest. When false (default state, or
              // multi-selection where no single row matches isUnitActive) we
              // render every row at full strength — no greying.
              const anyRowActive = repRows.some(r => isUnitActive(dimForCard, r.name));
              const dimLabelForCard: Record<AggDim["kind"], string> = {
                rep: "rep",
                flm: "FLM",
                slm: "SLM",
                region: "region",
                segment: "segment",
              };
              const canToggleCard = dimForCard.kind === "slm" ? !!onSetSlmFilter : !!onSetMultiFilter;
              repListNode = (
                <div className="absolute inset-0 overflow-y-auto bg-white space-y-2 pr-1">
                  {repRows.length === 0 ? (
                    <div className="text-[11px] text-[#94a3b8] py-2 text-center">No reps to show.</div>
                  ) : repRows.map(row => {
                    const isSelectedRow = isUnitActive(dimForCard, row.name);
                    // Renderer's `isActive` drives label/bar/metric coloring.
                    // The container's opacity adds the muted look (per spec).
                    const isActiveForRender = !anyRowActive || isSelectedRow;
                    const muted = anyRowActive && !isSelectedRow;
                    return (
                      <div
                        key={row.name}
                        role="button"
                        tabIndex={0}
                        onClick={() => openForecastPopupForRep(row.name, prod)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openForecastPopupForRep(row.name, prod);
                          }
                        }}
                        className={`px-1 py-0.5 cursor-pointer rounded-md hover:bg-black/5 dark:hover:bg-white/5 transition-[background-color,opacity] ${muted ? "opacity-40" : ""}`}
                        title={`Open ${displayProduct(prod)} forecast for ${row.name}`}
                      >
                        {renderForecastBarBody({
                          label: row.name,
                          labelColor: prodColor,
                          isActive: isActiveForRender,
                          goal: row.goal,
                          mrr: row.mrr,
                          weighted: row.weighted,
                          target: coverageTargets[row.name] ?? effectiveCoverageTarget,
                          onLabelClick: canToggleCard ? () => handleAggUnitClick(row.name) : undefined,
                          labelTitle: isSelectedRow
                            ? `Remove ${row.name} from ${dimLabelForCard[dimForCard.kind]} filter`
                            : `Add ${row.name} to ${dimLabelForCard[dimForCard.kind]} filter`,
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            }

            return (
              // When the by-rep drilldown is open we let this container grow
              // to fill the remaining card space (so the absolute-positioned
              // rep list overlay tracks the card's expand/collapse height).
              // In the per-product view it stays content-sized as before.
              <div className={`relative pt-3 mb-4 ${forecastRepDrilldownProduct ? "flex-1 min-h-0" : ""}`}>
                {productListNode}
                {repListNode}
              </div>
            );
          })()}
          </>) : (<>
          {(() => {
            // Shared "By Rep" affordance (matches AcqNet Forecast/Quota
            // cards). All three modes (MRR/Both/Churn) wire onClick to open
            // the per-rep overlay for the clicked product.
            const ByRepBtn = ({ color, onClick, ariaLabel, forceFullOpacity = false }: { color: string; onClick?: () => void; ariaLabel: string; forceFullOpacity?: boolean }) => (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onClick?.(); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onClick?.(); } }}
                aria-label={ariaLabel}
                title={ariaLabel}
                className={`group/byrep flex-shrink-0 self-stretch rounded transition-all duration-300 ease-out flex items-center justify-center overflow-hidden w-1.5 hover:w-1/3 ${onClick ? "cursor-pointer" : "cursor-default"} ${forceFullOpacity ? "opacity-100" : "opacity-50 hover:opacity-100"}`}
                style={{ backgroundColor: color }}
              >
                <span className="text-[9px] font-semibold text-white opacity-0 group-hover/byrep:opacity-100 transition-opacity duration-200 whitespace-nowrap pointer-events-none px-1">By Rep</span>
              </button>
            );

            const fmtSignedGapShort = (g: number) => g >= 0 ? `$${formatCurrencyShort(g)}` : `-$${formatCurrencyShort(Math.abs(g))}`;
            const fmtMultiple = (n: number) => Number.isInteger(n) ? `${n}` : n.toFixed(1).replace(/\.0$/, "");
            const PRODUCT_ABBREV: Record<string, string> = {
              "Showcase": "SC",
              "MBP": "MBP",
              "Zillow Pro": "ZPRO",
              "Follow Up Boss": "FUB",
            };

            // ────────────────────────────────────────────────────────
            // BOTH MODE — mockup-style stacked dual bars + 4-tile TOTAL
            // strip with stacked MRR + Churn rows. As of Task #116 the
            // churn side is fully wired: booked/weighted come from
            // scheduled mods (effective probability per mod), and the
            // 4-tile churn row uses the inverted color/WR-to-Hit helpers.
            // ────────────────────────────────────────────────────────
            if (forecastMetric === "both") {
              const MRR_DOT = "#006AFF";
              const CHURN_DOT = "#EF4444";
              const TARGET_MULTIPLE = effectiveCoverageTarget;
              const targetMultLabel = fmtMultiple(TARGET_MULTIPLE);
              // By-rep drilldown: when set, render one dual-bar row per
              // active aggDim unit (rep/FLM/SLM/Region/Segment) instead of
              // one row per product. TOTAL strip tiles become MRR-side sort
              // buttons (churn metrics are real but kept off the sort axis
              // for visual continuity with MRR mode).
              const inBothRepView = !!forecastRepDrilldownProduct;

              // MRR totals — goal & booked sourced from grossProductSplit
              // (MRR Added quota / MRR Added Closed Won), NOT activeTotalGoal
              // / activeTotalMrrForQuota which would be the Acq Net flavors.
              // Weighted is already mode-aware (Added-flavored) via wpf.
              const activeGross = (grossProductSplit || []).filter(p => activeProductSet.has(p.product));
              const totalMrrGoal = activeGross.reduce((s, p) => s + p.mrrAddedGoal, 0);
              const totalMrrBooked = activeGross.reduce((s, p) => s + p.mrrAddedActual, 0);
              const totalMrrWeighted = activeTotalWeighted;
              const totalMrrCoverage = totalMrrGoal > 0 ? totalMrrWeighted / totalMrrGoal : 0;
              const totalMrrGap = totalMrrGoal - totalMrrWeighted;
              const totalMrrWr = totalMrrWeighted > 0 && totalMrrBooked < totalMrrGoal
                ? Math.max(0, ((totalMrrGoal - totalMrrBooked) / totalMrrWeighted) * 100)
                : 0;

              // Churn totals — sourced from scheduled mods via grossProductSplit
              // (Task #116 superseded the prior $0 placeholders / cancelled
              // follow-up #107). Booked = sum of mod amounts in window;
              // weighted = sum(amount × effective probability per mod).
              const totalChurnGoal = activeGross.reduce((s, p) => s + p.churnGoal, 0);
              const totalChurnBooked = activeGross.reduce((s, p) => s + (p.churnBooked || 0), 0);
              const totalChurnWeighted = activeGross.reduce((s, p) => s + (p.churnWeighted || 0), 0);
              const totalChurnCoverage = totalChurnGoal > 0 ? totalChurnWeighted / totalChurnGoal : 0;
              const totalChurnGap = totalChurnGoal - totalChurnWeighted;
              const totalChurnWr = churnWrToHit(totalChurnBooked, totalChurnWeighted, totalChurnGoal);

              const mrrCovColor = totalMrrCoverage > TARGET_MULTIPLE ? "#10B981" : totalMrrCoverage >= 1 ? "#006AFF" : "#FF6B35";
              const mrrGapColor = totalMrrGap > 0 ? "#EF4444" : totalMrrGap < 0 ? "#10B981" : "#64748b";
              const churnCovColorTotal = churnCovColor(totalChurnCoverage, totalChurnGoal, TARGET_MULTIPLE);
              const churnGapColorTotal = churnGapColor(totalChurnGap, totalChurnGoal);

              // Stacked dual bars for per-product rows.
              const ForecastBar = ({ goal, weighted, flavor, position, isActive, onClick }: { goal: number; weighted: number; flavor: "mrr" | "churn"; position: "top" | "bottom"; isActive: boolean; onClick?: () => void }) => {
                const isMrr = flavor === "mrr";
                const multiple = goal > 0 ? Math.abs(weighted) / goal : 0;
                const exceeds = multiple > TARGET_MULTIPLE;
                const fillPct = exceeds ? 100 : Math.max(0, (multiple / TARGET_MULTIPLE) * 100);
                // Always position the 1x marker at the standard 1x slot (so the
                // hover label sits inside the bar, above/below it) even when
                // goal is $0 — instead of collapsing to the bar's left edge
                // and letting the hover label overlap the product label.
                const quotaMarkerPct = Math.min(100, (1 / TARGET_MULTIPLE) * 100);
                const mrrColor = exceeds ? "#00C49F" : multiple >= 1 ? "#006AFF" : "#FF6B35";
                const churnColor = goal > 0
                  ? (multiple <= 1 ? "#00C49F" : multiple <= TARGET_MULTIPLE ? "#FF6B35" : "#EF4444")
                  : "#94a3b8";
                const fillColor = isMrr ? mrrColor : churnColor;
                const targetAmountLabel = goal > 0 ? `$${formatCurrencyShort(goal * TARGET_MULTIPLE)}` : `$0`;
                const attainmentLabel = `$${formatCurrencyShort(Math.abs(weighted))}`;
                return (
                  // Outer wrapper has no overflow-hidden so the 1x hover label
                  // can extend above (top bar) or below (bottom bar) the bar
                  // without being clipped. The bar's visual fill/clip stays
                  // inside the inner overflow-hidden layer.
                  <div
                    className={`relative h-4 w-full group/forecastbar ${onClick ? "cursor-pointer" : ""}`}
                    {...(onClick ? {
                      role: "button" as const,
                      tabIndex: 0,
                      onClick: (e: React.MouseEvent) => { e.stopPropagation(); onClick(); },
                      onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onClick(); } },
                    } : {})}
                  >
                    <div className={`absolute inset-0 overflow-hidden bg-gray-100 ${position === "top" ? "rounded-t-[5px]" : "rounded-b-[5px] border-t border-white"}`}>
                      <div className="absolute inset-0 opacity-[0.07] pointer-events-none" style={{ background: `repeating-linear-gradient(45deg, transparent, transparent 4px, #94a3b8 4px, #94a3b8 5px)` }} />
                      <div className="absolute top-0 bottom-0 left-0 h-full transition-all" style={{ width: `${fillPct}%`, backgroundColor: isActive ? fillColor : "#cbd5e1" }} />
                      {Math.abs(weighted) > 0 && isActive && (
                        <div className="absolute top-0 bottom-0 left-0 overflow-hidden pointer-events-none" style={{ width: `${Math.min(50, fillPct)}%` }}>
                          <div className="h-full flex items-center pl-1.5 text-[10px] font-semibold text-white tabular-nums whitespace-nowrap leading-none">
                            {attainmentLabel}
                          </div>
                        </div>
                      )}
                      {goal > 0 && (
                        <div className="absolute top-0 bottom-0 w-0.5 bg-[#1e293b]/40" style={{ left: `${quotaMarkerPct}%` }} title="1x Goal" />
                      )}
                      {/* "<target>x $<goal*target>" label — hidden by default,
                          revealed only while THIS bar is hovered (mirroring
                          the 1x hover label below). The target multiple
                          prefix and the dollar amount are split into two
                          absolutely-positioned spans so the prefix anchors
                          at a fixed offset from the bar's right edge,
                          landing at the same horizontal x on every row
                          regardless of the dollar amount's character width.
                          The dollar amount sits in a fixed-width right-
                          aligned slot at the bar's right edge. The slot is
                          sized to comfortably fit formatCurrencyShort's
                          longest realistic output (e.g. "$1500.0M" = 8
                          chars) without truncating or pushing under the
                          prefix. */}
                      <span
                        className="absolute top-1/2 -translate-y-1/2 opacity-0 group-hover/forecastbar:opacity-100 transition-opacity text-[10px] font-semibold tabular-nums whitespace-nowrap leading-none text-[#1e293b]/55 pointer-events-none"
                        style={{ right: "calc(0.375rem + 8.5ch + 0.25ch)" }}
                      >
                        {targetMultLabel}x
                      </span>
                      <span
                        className="absolute top-1/2 -translate-y-1/2 right-1.5 opacity-0 group-hover/forecastbar:opacity-100 transition-opacity text-[10px] font-semibold tabular-nums whitespace-nowrap leading-none text-right text-[#1e293b]/55 pointer-events-none"
                        style={{ width: "8.5ch" }}
                      >
                        {targetAmountLabel}
                      </span>
                      {/* Grey "1x $<goal>" hover label — split into a
                          fixed-offset "1x" prefix anchored just right of
                          the 1x marker line and a fixed-width dollar slot
                          adjacent to it, mirroring the 3.5x label's
                          alignment treatment. The prefix lands at the same
                          horizontal x on every row regardless of the
                          dollar amount's character width, and neither
                          piece is clipped by the bar's edges or the
                          stacked-neighbor bar. Hover gating, vertical
                          centering, and format are unchanged. */}
                      <span
                        className="absolute top-1/2 -translate-y-1/2 opacity-0 group-hover/forecastbar:opacity-100 transition-opacity text-[10px] text-[#94a3b8] whitespace-nowrap pointer-events-none tabular-nums leading-none z-10"
                        style={{ left: `calc(${quotaMarkerPct}% + 0.25ch)` }}
                      >
                        1x
                      </span>
                      <span
                        className="absolute top-1/2 -translate-y-1/2 opacity-0 group-hover/forecastbar:opacity-100 transition-opacity text-[10px] text-[#94a3b8] whitespace-nowrap pointer-events-none tabular-nums leading-none text-left z-10"
                        style={{ left: `calc(${quotaMarkerPct}% + 0.25ch + 2.25ch + 0.4ch)`, width: "8.5ch" }}
                      >
                        ${formatCurrencyShort(goal)}
                      </span>
                    </div>
                  </div>
                );
              };

              const MetricsRow = ({ goal, booked, weighted, flavor, isActive }: { goal: number; booked: number; weighted: number; flavor: "mrr" | "churn"; isActive: boolean }) => {
                const isMrr = flavor === "mrr";
                // Task #116: Churn-side now wired to real scheduled-mods
                // weighted pipeline. Inverted color logic: low coverage =
                // green (under churn quota), high coverage = red.
                const multiple = goal > 0 ? Math.abs(weighted) / goal : 0;
                const wrToHit = isMrr
                  ? (goal > 0 && weighted > 0 && booked < goal ? Math.max(0, ((goal - booked) / weighted) * 100) : 0)
                  : churnWrToHit(booked, weighted, goal);
                const gap = goal - weighted;
                const displayWeighted = Math.abs(weighted);
                const coverageColor = isMrr
                  ? (multiple > TARGET_MULTIPLE ? "#10B981" : multiple >= 1 ? "#006AFF" : "#FF6B35")
                  : churnCovColor(multiple, goal, TARGET_MULTIPLE);
                const weightedColor = isMrr ? "#006AFF" : "#EF4444";
                const gColor = isMrr
                  ? (gap > 0 ? "#EF4444" : gap < 0 ? "#10B981" : "#64748b")
                  : churnGapColor(gap, goal);
                const wrColor = "#FF6B35";
                const muted = !isActive ? "#94a3b8" : null;
                const wrText = isMrr
                  ? `${(wrToHit as number).toFixed(0)}%`
                  : (wrToHit === null ? "—" : `${(wrToHit as number).toFixed(0)}%`);
                return (
                  <div className="grid grid-cols-4 gap-2 text-[12px] font-semibold tabular-nums">
                    <div className="text-center" style={{ color: muted || wrColor }} title="Win Rate to Hit">{wrText}</div>
                    <div className="text-center" style={{ color: muted || coverageColor }} title="Coverage">{multiple.toFixed(1)}x</div>
                    <div className="text-center" style={{ color: muted || weightedColor }} title="Weighted">${formatCurrencyShort(displayWeighted)}</div>
                    <div className="text-center" style={{ color: muted || gColor }} title="Gap (Goal − Weighted)">{fmtSignedGapShort(gap)}</div>
                  </div>
                );
              };

              // Sort-tile helpers (only meaningful when inBothRepView) —
              // sort by MRR-side metric.
              const sortArrowBoth = (m: RepSortMetric) => {
                if (!inBothRepView || repForecastSortMetric !== m) return null;
                return (
                  <span className="ml-0.5 inline-block text-[8px] leading-none align-middle">
                    {repForecastSortDir === "asc" ? "▲" : "▼"}
                  </span>
                );
              };
              const tileLabelClassBoth = (m: RepSortMetric) => {
                const base = "text-[10px] uppercase tracking-[0.5px] leading-tight";
                if (inBothRepView && repForecastSortMetric === m) return `${base} text-[#1e293b] font-semibold`;
                return `${base} text-[#64748b]`;
              };
              const tileTitleBoth = (m: RepSortMetric, defaultTitle: string) => {
                if (!inBothRepView) return defaultTitle;
                if (repForecastSortMetric === m) {
                  return `Sorted by ${defaultTitle}, ${repForecastSortDir === "asc" ? "ascending" : "descending"} (click to flip direction)`;
                }
                return `Sort by ${defaultTitle}`;
              };

              return (
                <>
                  {/* TOTAL strip — 4 tiles, each with stacked MRR + Churn rows.
                      Click on any tile opens the Forecast Assumptions popup
                      (same target as the existing GNR Forecast title click).
                      In by-rep view the outer click-to-popup is removed and
                      each column becomes a sort button (sorts the rep list
                      by the column's MRR-side metric). */}
                  <div className="flex items-stretch gap-2 pb-3 border-b border-border">
                    <ByRepBtn color="#0f172a" ariaLabel="View Total by Rep" />
                    <div
                      {...(inBothRepView ? {} : {
                        role: "button" as const,
                        tabIndex: 0,
                        "aria-label": "Adjust forecast assumptions",
                        onClick: () => setForecastPopupOpen(true),
                        onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setForecastPopupOpen(true); } },
                        title: "Click to adjust forecast assumptions",
                      })}
                      className={`grid grid-cols-4 gap-2 flex-1 ${inBothRepView ? "" : "cursor-pointer"}`}
                    >
                      {/* Win Rate to Hit */}
                      <div
                        className={`flex flex-col items-center text-center px-1 ${inBothRepView ? "cursor-pointer rounded-md hover:bg-black/5 dark:hover:bg-white/5" : ""}`}
                        {...(inBothRepView ? { role: "button", tabIndex: 0, onClick: (e: React.MouseEvent) => { e.stopPropagation(); handleRepSortTileClick("winRateToHit"); }, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleRepSortTileClick("winRateToHit"); } } } : {})}
                        title={tileTitleBoth("winRateToHit", "Win Rate to Hit")}
                      >
                        <div className={tileLabelClassBoth("winRateToHit")}>Win Rate{sortArrowBoth("winRateToHit")}</div>
                        <div className="flex flex-col items-center mt-1 gap-1">
                          <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1">
                            <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: MRR_DOT }} />
                            <span style={{ color: "#FF6B35" }}>{totalMrrWr.toFixed(0)}%</span>
                          </div>
                          <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1">
                            <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: CHURN_DOT }} />
                            <span style={{ color: "#FF6B35" }}>{totalChurnWr === null ? "—" : `${totalChurnWr.toFixed(0)}%`}</span>
                          </div>
                        </div>
                      </div>
                      {/* Coverage */}
                      <div
                        className={`flex flex-col items-center text-center px-1 border-l border-border ${inBothRepView ? "cursor-pointer rounded-md hover:bg-black/5 dark:hover:bg-white/5" : ""}`}
                        {...(inBothRepView ? { role: "button", tabIndex: 0, onClick: (e: React.MouseEvent) => { e.stopPropagation(); handleRepSortTileClick("coverage"); }, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleRepSortTileClick("coverage"); } } } : {})}
                        title={tileTitleBoth("coverage", "Pipeline Coverage")}
                      >
                        <div className={tileLabelClassBoth("coverage")}>Coverage{sortArrowBoth("coverage")}</div>
                        <div className="flex flex-col items-center mt-1 gap-1">
                          <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1">
                            <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: MRR_DOT }} />
                            <span style={{ color: mrrCovColor }}>{totalMrrCoverage.toFixed(1)}x</span>
                          </div>
                          <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1">
                            <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: CHURN_DOT }} />
                            <span style={{ color: churnCovColorTotal }}>{totalChurnCoverage.toFixed(1)}x</span>
                          </div>
                        </div>
                      </div>
                      {/* Total Weighted */}
                      <div
                        className={`flex flex-col items-center text-center px-1 border-l border-border ${inBothRepView ? "cursor-pointer rounded-md hover:bg-black/5 dark:hover:bg-white/5" : ""}`}
                        {...(inBothRepView ? { role: "button", tabIndex: 0, onClick: (e: React.MouseEvent) => { e.stopPropagation(); handleRepSortTileClick("weighted"); }, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleRepSortTileClick("weighted"); } } } : {})}
                        title={tileTitleBoth("weighted", "Total Weighted")}
                      >
                        <div className={tileLabelClassBoth("weighted")}>Weighted{sortArrowBoth("weighted")}</div>
                        <div className="flex flex-col items-center mt-1 gap-1">
                          <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1 text-[#006AFF]">
                            <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: MRR_DOT }} />
                            ${formatCurrencyShort(totalMrrWeighted)}
                          </div>
                          <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1 text-[#EF4444]">
                            <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: CHURN_DOT }} />
                            ${formatCurrencyShort(totalChurnWeighted)}
                          </div>
                        </div>
                      </div>
                      {/* Gap */}
                      <div
                        className={`flex flex-col items-center text-center px-1 border-l border-border ${inBothRepView ? "cursor-pointer rounded-md hover:bg-black/5 dark:hover:bg-white/5" : ""}`}
                        {...(inBothRepView ? { role: "button", tabIndex: 0, onClick: (e: React.MouseEvent) => { e.stopPropagation(); handleRepSortTileClick("gap"); }, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleRepSortTileClick("gap"); } } } : {})}
                        title={tileTitleBoth("gap", "Gap")}
                      >
                        <div className={tileLabelClassBoth("gap")}>Gap{sortArrowBoth("gap")}</div>
                        <div className="flex flex-col items-center mt-1 gap-1">
                          <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1">
                            <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: MRR_DOT }} />
                            <span style={{ color: mrrGapColor }}>{fmtSignedGapShort(totalMrrGap)}</span>
                          </div>
                          <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1">
                            <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: CHURN_DOT }} />
                            <span style={{ color: churnGapColorTotal }}>{fmtSignedGapShort(totalChurnGap)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Per-product rows: MRR row, stacked dual bars with
                      abbreviation tab (click-to-filter), Churn row. Hidden
                      in by-rep view. */}
                  {!inBothRepView && (
                  <div className="pt-3 pb-4 space-y-3">
                    {allProductQuotas.map((pq) => {
                      const isActive = activeProductSet.has(pq.product);
                      const prodColor = PRODUCT_COLORS[pq.product] || "#64748b";
                      const abbr = displayProductAbbrev(pq.product, PRODUCT_ABBREV[pq.product] || pq.product);
                      const ps = (grossProductSplit || []).find(p => p.product === pq.product);
                      const churnGoal = ps?.churnGoal || 0;
                      // GNR Both view runs in MRR Added mode, so the MRR side
                      // uses MRR Added quota (mrrAddedGoal) and MRR Added
                      // Closed Won (mrrAddedActual) — NOT pq.goal / pq.mrr,
                      // which are Acq Net flavors. pq.weighted is already
                      // mode-aware (Added-flavored) via the underlying wpf.
                      // Churn booked/weighted are sourced from scheduled-mods
                      // via grossProductSplit (Task #116).
                      const mrrGoal = ps?.mrrAddedGoal ?? 0;
                      const mrrBooked = ps?.mrrAddedActual ?? 0;
                      const churnBooked = ps?.churnBooked ?? 0;
                      const churnWeighted = ps?.churnWeighted ?? 0;
                      return (
                        <div key={pq.product} className="flex items-stretch gap-2">
                          <ByRepBtn
                            color={prodColor}
                            ariaLabel={`View ${displayProduct(pq.product)} by Rep`}
                            onClick={() => {
                              // Filter the dashboard to this product (Showcase
                              // includes SCi to mirror the rolled-up bar) and
                              // open the by-rep drilldown for it.
                              const next = pq.product === "Showcase"
                                ? ["Showcase", "Showcase Incremental", "Showcase Incremental - Re/Max", "Overage"]
                                : [pq.product];
                              onProductsChange(next);
                              setForecastRepDrilldownProduct(pq.product);
                            }}
                            forceFullOpacity={filters.products.length > 0 && isActive}
                          />
                          <div className={`flex-1 min-w-0 space-y-0.5 ${!isActive ? "opacity-40" : ""}`}>
                            <MetricsRow goal={mrrGoal} booked={mrrBooked} weighted={pq.weighted} flavor="mrr" isActive={isActive} />
                            <div className="relative">
                              <span
                                role="button"
                                tabIndex={0}
                                onClick={(e) => { e.stopPropagation(); toggleProductFilter(pq.product); }}
                                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleProductFilter(pq.product); } }}
                                className="absolute top-0 left-0 -translate-y-full z-10 text-[11px] font-semibold leading-none bg-white cursor-pointer hover:underline"
                                style={{ color: isActive ? prodColor : "#94a3b8" }}
                                title={isActive ? `Remove ${displayProduct(pq.product)} from filter` : `Filter to ${displayProduct(pq.product)}`}
                              >
                                {abbr}
                              </span>
                              {/* Border + rounding only — no overflow-hidden,
                                  so each ForecastBar's 1x hover label can
                                  extend above/below the bar without being
                                  clipped. Each bar handles its own rounded
                                  fill clipping internally. */}
                              <div className="rounded-md border border-gray-200">
                                <ForecastBar
                                  goal={mrrGoal}
                                  weighted={pq.weighted}
                                  flavor="mrr"
                                  position="top"
                                  isActive={isActive}
                                  onClick={() => setForecastPopupProduct(pq.product)}
                                />
                                <ForecastBar
                                  goal={churnGoal}
                                  weighted={churnWeighted}
                                  flavor="churn"
                                  position="bottom"
                                  isActive={isActive}
                                  onClick={() => setForecastChurnPopupProduct(pq.product)}
                                />
                              </div>
                            </div>
                            <MetricsRow goal={churnGoal} booked={churnBooked} weighted={churnWeighted} flavor="churn" isActive={isActive} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  )}

                  {/* By-rep drilldown — one dual-bar row per rep/FLM/SLM/
                      Region/Segment (whatever the active aggregateBy dim is).
                      Each row mirrors the per-product layout: MRR metrics
                      row → dual bar with the unit-name tab anchored above
                      the MRR bar → Churn metrics row. The unit-name tab is
                      the click-to-toggle filter target (matches MRR by-rep).
                      Sorted by `repForecastSortMetric` /
                      `repForecastSortDir` (MRR-side metrics). */}
                  {inBothRepView && (() => {
                    const prod = forecastRepDrilldownProduct!;
                    const prodColor = PRODUCT_COLORS[prod] || "#64748b";
                    const dimForCard = aggDim(filters.aggregateBy);
                    const dimLabelForCard: Record<AggDim["kind"], string> = {
                      rep: "rep", flm: "FLM", slm: "SLM", region: "region", segment: "segment",
                    };
                    const canToggleCard = dimForCard.kind === "slm" ? !!onSetSlmFilter : !!onSetMultiFilter;

                    // Pull per-rep numbers for the drilldown product. Showcase
                    // has SCi already rolled in via aggregatePerRepEntries.
                    type RepRow = { name: string; mrrGoal: number; mrrBooked: number; mrrWeighted: number; churnGoal: number; churnBooked: number; churnWeighted: number; };
                    const rows: RepRow[] = (forecastRepBreakdowns || []).map(rb => {
                      const pp = rb.perProduct?.[prod];
                      return {
                        name: rb.name,
                        mrrGoal: pp?.mrrAddedGoal ?? 0,
                        mrrBooked: pp?.mrrAdded ?? 0,
                        mrrWeighted: pp?.weighted ?? 0,
                        churnGoal: pp?.churnGoal ?? 0,
                        churnBooked: pp?.churnBooked ?? 0,
                        churnWeighted: pp?.churnWeighted ?? 0,
                      };
                    });

                    // Sort key (MRR-side). Reps with no MRR goal sink to bottom.
                    const sortKey = (r: RepRow): number => {
                      switch (repForecastSortMetric) {
                        case "winRateToHit":
                          return r.mrrWeighted > 0 && r.mrrBooked < r.mrrGoal
                            ? Math.max(0, ((r.mrrGoal - r.mrrBooked) / r.mrrWeighted) * 100)
                            : 0;
                        case "coverage":
                          return r.mrrGoal > 0 ? r.mrrWeighted / r.mrrGoal : 0;
                        case "weighted":
                          return r.mrrWeighted;
                        case "gap":
                          return r.mrrGoal - r.mrrWeighted;
                      }
                    };
                    const noGoal = (r: RepRow) => r.mrrGoal <= 0;
                    const dirMul = repForecastSortDir === "asc" ? 1 : -1;
                    rows.sort((a, b) => {
                      const aNo = noGoal(a), bNo = noGoal(b);
                      if (aNo && !bNo) return 1;
                      if (!aNo && bNo) return -1;
                      if (aNo && bNo) return a.name.localeCompare(b.name);
                      const diff = sortKey(a) - sortKey(b);
                      return diff === 0 ? a.name.localeCompare(b.name) : diff * dirMul;
                    });

                    const anyRowActive = rows.some(r => isUnitActive(dimForCard, r.name));

                    return (
                      <div className="pt-3 pb-1 flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
                        {rows.length === 0 ? (
                          <div className="text-[11px] text-[#94a3b8] py-2 text-center">No {dimLabelForCard[dimForCard.kind]}s to show.</div>
                        ) : rows.map(row => {
                          const isSelectedRow = isUnitActive(dimForCard, row.name);
                          const isActiveForRender = !anyRowActive || isSelectedRow;
                          return (
                            <div
                              key={row.name}
                              role="button"
                              tabIndex={0}
                              onClick={() => openForecastPopupForRep(row.name, prod)}
                              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openForecastPopupForRep(row.name, prod); } }}
                              className={`flex items-stretch gap-2 rounded-md px-1 py-0.5 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-[background-color,opacity] ${!isActiveForRender ? "opacity-40" : ""}`}
                              title={`Open ${displayProduct(prod)} forecast for ${row.name}`}
                            >
                              <div className="flex-1 min-w-0 space-y-0.5">
                                <MetricsRow goal={row.mrrGoal} booked={row.mrrBooked} weighted={row.mrrWeighted} flavor="mrr" isActive={isActiveForRender} />
                                <div className="relative">
                                  <span
                                    role="button"
                                    tabIndex={0}
                                    onClick={(e) => { e.stopPropagation(); if (canToggleCard) handleAggUnitClick(row.name); }}
                                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); if (canToggleCard) handleAggUnitClick(row.name); } }}
                                    className={`absolute top-0 left-0 -translate-y-full z-10 text-[11px] font-semibold leading-none bg-white max-w-[60%] truncate ${canToggleCard ? "cursor-pointer hover:underline" : "cursor-default"}`}
                                    style={{ color: isActiveForRender ? prodColor : "#94a3b8" }}
                                    title={canToggleCard ? (isSelectedRow
                                      ? `Remove ${row.name} from ${dimLabelForCard[dimForCard.kind]} filter`
                                      : `Add ${row.name} to ${dimLabelForCard[dimForCard.kind]} filter`) : row.name}
                                  >
                                    {row.name}
                                  </span>
                                  <div className="rounded-md overflow-hidden border border-gray-200">
                                    <ForecastBar goal={row.mrrGoal} weighted={row.mrrWeighted} flavor="mrr" position="top" isActive={isActiveForRender} />
                                    <ForecastBar goal={row.churnGoal} weighted={row.churnWeighted} flavor="churn" position="bottom" isActive={isActiveForRender} />
                                  </div>
                                </div>
                                <MetricsRow goal={row.churnGoal} booked={row.churnBooked} weighted={row.churnWeighted} flavor="churn" isActive={isActiveForRender} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </>
              );
            }

            // ────────────────────────────────────────────────────────
            // MRR or CHURN MODE — AcqNet-style 4-tile TOTAL strip plus
            // per-product list. Churn uses scheduled mods + inverted
            // color/WR-to-Hit semantics. Both modes share interactions:
            // bar→drilldown popup, label→filter toggle, ByRep→per-rep
            // overlay (TOTAL tiles become sort buttons).
            // ────────────────────────────────────────────────────────
            const isChurn = forecastMetric === "churn";
            const isMrr = forecastMetric === "mrr";
            const inRepView = (isMrr || isChurn) && !!forecastRepDrilldownProduct;
            const TARGET_MULTIPLE = effectiveCoverageTarget;

            type Row = { product: string; goal: number; mrr: number; weighted: number };
            // GNR MRR/Churn rows: goal is MRR Added quota (or Churn quota in
            // churn mode), NOT the Acq Net quota that allProductQuotas uses.
            // Source mrrAddedGoal/churnGoal from grossProductSplit so the bar's
            // 1x marker and 3.5x labels reflect the active gross metric.
            // Weighted in MRR mode is already mode-aware (the underlying
            // weightedProductFunnel uses Added-flavored Closed Won when the
            // dashboard is in Added mode), so allProductQuotas[i].weighted
            // is the correct MRR-Added weighted pipeline. Task #116: Churn
            // mode now uses real churnBooked/churnWeighted from scheduled mods.
            const gpsByProduct = new Map((grossProductSplit || []).map(p => [p.product, p]));
            const rows: Row[] = isChurn
              ? (grossProductSplit || []).map(p => ({
                  product: p.product,
                  goal: p.churnGoal,
                  mrr: p.churnBooked || 0,
                  weighted: p.churnWeighted || 0,
                }))
              : allProductQuotas.map(pq => ({
                  product: pq.product,
                  goal: gpsByProduct.get(pq.product)?.mrrAddedGoal ?? 0,
                  mrr: gpsByProduct.get(pq.product)?.mrrAddedActual ?? pq.mrr,
                  weighted: pq.weighted,
                }));

            const totGoal = rows.filter(r => activeProductSet.has(r.product)).reduce((s, r) => s + r.goal, 0);
            const totBooked = rows.filter(r => activeProductSet.has(r.product)).reduce((s, r) => s + r.mrr, 0);
            const totWeighted = rows.filter(r => activeProductSet.has(r.product)).reduce((s, r) => s + r.weighted, 0);
            const totWr = isChurn
              ? churnWrToHit(totBooked, totWeighted, totGoal)
              : (totWeighted > 0 && totBooked < totGoal
                ? Math.max(0, ((totGoal - totBooked) / totWeighted) * 100)
                : 0);
            const totCoverage = totGoal > 0 ? totWeighted / totGoal : 0;
            const totGap = totGoal - totWeighted;
            const totGapColor = isChurn
              ? churnGapColor(totGap, totGoal)
              : (totGap > 0 ? "#EF4444" : totGap < 0 ? "#10B981" : "#64748b");
            const totGapText = totGap >= 0 ? `$${formatCurrencyShort(totGap)}` : `-$${formatCurrencyShort(Math.abs(totGap))}`;
            const covColor = isChurn
              ? churnCovColor(totCoverage, totGoal, TARGET_MULTIPLE)
              : (totCoverage > TARGET_MULTIPLE ? "#10B981" : totCoverage >= 1 ? "#006AFF" : "#FF6B35");
            const totWrText = isChurn && totWr === null ? "—" : `${(totWr as number).toFixed(0)}%`;

            const renderForecastBarBody = (opts: {
              label: string;
              labelColor: string;
              isActive: boolean;
              goal: number;
              mrr: number;
              weighted: number;
              target?: number;
              onLabelClick?: () => void;
              labelTitle?: string;
            }) => {
              const { label, labelColor, isActive, goal, mrr, weighted, onLabelClick, labelTitle } = opts;
              const ROW_TARGET = (typeof opts.target === "number" && opts.target > 0) ? opts.target : TARGET_MULTIPLE;
              const multiple = goal > 0 ? weighted / goal : 0;
              const exceeds = multiple > ROW_TARGET;
              const fillPct = exceeds ? 100 : (multiple / ROW_TARGET) * 100;
              // Always position the 1x marker at the standard 1x slot — even
              // when goal is $0 — so the grey hover label sits inside the bar
              // (and reads "1x $0") instead of collapsing to the bar's left
              // edge and overlapping the product label above it. The visible
              // marker line itself stays gated by goal > 0 below.
              const quotaMarkerPct = (1 / ROW_TARGET) * 100;
              // Task #116: Churn now uses real weighted from scheduled mods.
              const fillColor = isChurn
                ? churnFillColor(mrr, weighted, goal, ROW_TARGET)
                : (exceeds ? "#00C49F" : multiple >= 1 ? "#006AFF" : "#FF6B35");
              const wrToHitNum = isChurn
                ? churnWrToHit(mrr, weighted, goal)
                : (weighted > 0 && mrr < goal ? Math.max(0, ((goal - mrr) / weighted) * 100) : 0);
              const wrToHitText = isChurn && wrToHitNum === null
                ? "—"
                : `${(wrToHitNum as number).toFixed(0)}%`;
              const gap = goal - weighted;
              const gapColor = !isActive
                ? "#94a3b8"
                : isChurn
                  ? churnGapColor(gap, goal)
                  : (gap > 0 ? "#EF4444" : gap < 0 ? "#10B981" : "#64748b");
              return (
                <>
                  <div className="flex justify-between items-center text-[12px] mb-0.5 gap-2">
                    {onLabelClick ? (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); onLabelClick(); }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            onLabelClick();
                          }
                        }}
                        className="font-medium truncate cursor-pointer hover:underline"
                        style={{ color: isActive ? labelColor : "#94a3b8" }}
                        title={labelTitle}
                      >
                        {displayProduct(label)}
                      </span>
                    ) : (
                      <span className="font-medium truncate" style={{ color: isActive ? labelColor : "#94a3b8" }}>{displayProduct(label)}</span>
                    )}
                    <span className="text-[11px] text-[#94a3b8] whitespace-nowrap tabular-nums">{fmtMultiple(ROW_TARGET)}x&nbsp;${formatCurrencyShort(goal * ROW_TARGET)}</span>
                  </div>
                  <div className="relative group/bar">
                    <div
                      className="absolute opacity-0 group-hover/bar:opacity-100 transition-opacity text-[10px] text-[#94a3b8] whitespace-nowrap pointer-events-none tabular-nums z-10"
                      style={{ left: `${quotaMarkerPct}%`, transform: "translateX(-50%)", bottom: "100%" }}
                    >
                      1x&nbsp;${formatCurrencyShort(goal)}
                    </div>
                    <div className="relative h-3 w-full rounded-full overflow-hidden bg-gray-100">
                      <div className="absolute inset-0 opacity-[0.07] rounded-full" style={{ background: `repeating-linear-gradient(45deg, transparent, transparent 4px, #94a3b8 4px, #94a3b8 5px)` }} />
                      <div className="absolute top-0 bottom-0 left-0 h-full rounded-l-full transition-all" style={{ width: `${fillPct}%`, backgroundColor: isActive ? fillColor : "#cbd5e1" }} />
                      {fillPct > 25 && (
                        <div className="absolute top-0 bottom-0 left-0 flex items-center justify-center text-[9px] font-semibold text-white pointer-events-none leading-none" style={{ width: `${fillPct}%` }}>
                          ${formatCurrencyShort(weighted)}
                        </div>
                      )}
                      {goal > 0 && (
                        <div className="absolute top-0 bottom-0 flex flex-col items-center" style={{ left: `${quotaMarkerPct}%` }}>
                          <div className="w-0.5 h-full bg-[#1e293b]/40" />
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-2 mt-1 text-[13px] font-semibold tabular-nums">
                    <div className="text-center" style={{ color: isActive ? "#FF6B35" : "#94a3b8" }} title="Win Rate to Hit">{wrToHitText}</div>
                    <div className="text-center" style={{ color: isActive ? fillColor : "#94a3b8" }} title="Pipeline Coverage">{multiple.toFixed(1)}x</div>
                    <div className="text-center" style={{ color: isActive ? (isChurn ? "#EF4444" : "#006AFF") : "#94a3b8" }} title="Weighted">${formatCurrencyShort(weighted)}</div>
                    <div className="text-center" style={{ color: gapColor }} title="Gap (Goal − Weighted)">{gap >= 0 ? `$${formatCurrencyShort(gap)}` : `-$${formatCurrencyShort(Math.abs(gap))}`}</div>
                  </div>
                </>
              );
            };

            // ─── TOTAL strip helpers — when MRR mode + by-rep view is
            // open, the 4 tiles double as sort buttons (mirrors AcqNet). In
            // any other state the strip is a single click target that
            // opens the Forecast Assumptions popup.
            const sortMetric = repForecastSortMetric;
            const sortDir = repForecastSortDir;
            const sortArrow = (m: RepSortMetric) => {
              if (!inRepView || sortMetric !== m) return null;
              return (
                <span className="ml-0.5 text-[9px] leading-none align-middle" aria-hidden="true">
                  {sortDir === "asc" ? "▲" : "▼"}
                </span>
              );
            };
            const tileLabelClass = (m: RepSortMetric) =>
              `text-[10px] uppercase tracking-[0.5px] leading-tight ${
                inRepView && sortMetric === m ? "text-[#1e293b] font-semibold" : "text-[#64748b]"
              }`;
            const tileButtonClass = (extra = "") =>
              `text-center flex flex-col min-w-0 ${extra} ${
                inRepView
                  ? "cursor-pointer rounded transition-colors hover:bg-black/[0.03] dark:hover:bg-white/5 px-1 -mx-1"
                  : ""
              }`;
            const Tile = ({
              metric, title, extra, children,
            }: { metric: RepSortMetric; title: string; extra?: string; children: React.ReactNode }) => {
              if (inRepView) {
                return (
                  <button
                    type="button"
                    onClick={() => handleRepSortTileClick(metric)}
                    title={`${title} — click to sort by this metric (toggle direction).`}
                    aria-label={`Sort by ${title}${sortMetric === metric ? `, currently ${sortDir === "asc" ? "ascending" : "descending"}` : ""}`}
                    aria-pressed={sortMetric === metric}
                    className={tileButtonClass(extra)}
                  >
                    {children}
                  </button>
                );
              }
              return (
                <div className={tileButtonClass(extra)} title={title}>
                  {children}
                </div>
              );
            };

            // ─── Per-product list (always rendered so the card height stays
            // driven by it). When the by-rep view is open we hide it
            // (visibility:hidden keeps it taking up space) and the rep list
            // overlays at absolute inset-0 within the same footprint.
            const productListNode = (
              <div className={`space-y-2 ${inRepView ? "invisible" : ""}`}>
                {rows.map((r) => {
                  const isActive = activeProductSet.has(r.product);
                  const prodColor = PRODUCT_COLORS[r.product] || "#64748b";
                  // MRR mode mirrors AcqNet:
                  //   • By Rep button → opens per-rep drilldown for product
                  //   • Bar container click → opens forecast popup
                  //   • Label click → toggles product filter
                  // Task #116: Churn mode now mirrors that pattern — bar
                  // opens the Churn Forecast Assumptions popup (single
                  // Scheduled Mods row with probability slider), and the
                  // By Rep button opens the per-rep churn drilldown.
                  const onByRep = (isMrr || isChurn)
                    ? () => {
                        const next = r.product === "Showcase"
                          ? ["Showcase", "Showcase Incremental", "Showcase Incremental - Re/Max", "Overage"]
                          : [r.product];
                        onProductsChange(next);
                        setForecastRepDrilldownProduct(r.product);
                      }
                    : undefined;
                  const onBarClick = isMrr
                    ? () => setForecastPopupProduct(r.product)
                    : isChurn
                      ? () => setForecastChurnPopupProduct(r.product)
                      : () => toggleProductFilter(r.product);
                  const barTitle = isMrr
                    ? `Open ${displayProduct(r.product)} forecast`
                    : isChurn
                      ? `Open ${displayProduct(r.product)} churn forecast`
                      : (isActive ? `Remove ${displayProduct(r.product)} from filter` : `Filter to ${displayProduct(r.product)}`);
                  return (
                    <div key={r.product} className="flex items-stretch gap-2">
                      <ByRepBtn
                        color={prodColor}
                        ariaLabel={isMrr ? `View ${displayProduct(r.product)} forecast by Rep` : `View ${displayProduct(r.product)} by Rep`}
                        onClick={onByRep}
                        forceFullOpacity={filters.products.length > 0 && isActive}
                      />
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={onBarClick}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onBarClick(); } }}
                        className={`flex-1 min-w-0 cursor-pointer rounded-md px-1 py-0.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors ${!isActive ? "opacity-40" : ""}`}
                        title={barTitle}
                      >
                        {renderForecastBarBody({
                          label: r.product,
                          labelColor: prodColor,
                          isActive,
                          goal: r.goal,
                          mrr: r.mrr,
                          weighted: r.weighted,
                          // Task #116: Churn mode also gets label-click parity
                          // with MRR — clicking the product label toggles the
                          // product filter; bar click opens the churn popup.
                          onLabelClick: (isMrr || isChurn) ? () => toggleProductFilter(r.product) : undefined,
                          labelTitle: (isMrr || isChurn) ? (isActive ? `Remove ${displayProduct(r.product)} from filter` : `Filter to ${displayProduct(r.product)}`) : undefined,
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );

            // ─── Per-rep overlay (MRR + Churn modes). Sources from
            // `forecastRepBreakdowns` (broader rep set that ignores the
            // active aggDim filter) so applying a Rep / FLM / SLM / Region
            // / Segment filter doesn't remove rows — it just highlights
            // one and greys out the rest. Mirrors AcqNet.
            let repListNode: React.ReactNode = null;
            if (inRepView) {
              const prod = forecastRepDrilldownProduct!;
              const prodColor = PRODUCT_COLORS[prod] || "#64748b";
              type RepRow = {
                name: string;
                goal: number;
                mrr: number;
                weighted: number;
                coverage: number;
                // Nullable in Churn mode: `null` matches the explicit "—"
                // semantics used by the totals strip + popup header when the
                // row is already under cap or has no remaining mod tail.
                // MRR mode always populates a number.
                winRateToHit: number | null;
                gap: number;
              };
              // GNR by-rep view runs in MRR Added mode, so the row's "goal" is
              // the MRR Added quota (mrrAddedGoal) and "mrr booked" is the
              // gross MRR Added Closed Won (mrrAdded) — NOT the Acq Net pp.goal
              // / pp.mrr fields. Weighted is already mode-aware (Added-flavored
              // when isAdded is true), so pp.weighted is correct.
              // Task #116: Churn mode pulls churnGoal/churnBooked/churnWeighted
              // from the same per-rep breakdown.
              const repRows: RepRow[] = (forecastRepBreakdowns || []).map(rb => {
                const pp = rb.perProduct[prod];
                if (!pp) return null;
                const rowGoal = isChurn ? pp.churnGoal : pp.mrrAddedGoal;
                const rowMrr = isChurn ? (pp.churnBooked ?? 0) : pp.mrrAdded;
                const rowWeighted = isChurn ? (pp.churnWeighted ?? 0) : pp.weighted;
                const cov = rowGoal > 0 ? rowWeighted / rowGoal : -Infinity;
                const wr: number | null = isChurn
                  ? churnWrToHit(rowMrr, rowWeighted, rowGoal)
                  : (rowWeighted > 0 && rowMrr < rowGoal
                    ? Math.max(0, ((rowGoal - rowMrr) / rowWeighted) * 100)
                    : 0);
                const g = rowGoal - rowWeighted;
                return {
                  name: rb.name,
                  goal: rowGoal,
                  mrr: rowMrr,
                  weighted: rowWeighted,
                  coverage: cov,
                  winRateToHit: wr,
                  gap: g,
                };
              }).filter((x): x is RepRow => !!x);
              const noGoal = (r: RepRow) => !Number.isFinite(r.coverage);
              const dirMul = repForecastSortDir === "asc" ? 1 : -1;
              const sortKey = (r: RepRow): number => {
                switch (repForecastSortMetric) {
                  case "coverage": return Number.isFinite(r.coverage) ? r.coverage : 0;
                  case "weighted": return r.weighted;
                  // null WR (under cap / no mod tail) sinks like noGoal rows
                  // by mapping to -Infinity, which the noGoal check below
                  // already pushes to the bottom regardless of direction.
                  case "winRateToHit": return r.winRateToHit ?? -Infinity;
                  case "gap": return r.gap;
                }
              };
              repRows.sort((a, b) => {
                const aNo = noGoal(a), bNo = noGoal(b);
                if (aNo && !bNo) return 1;
                if (!aNo && bNo) return -1;
                if (aNo && bNo) return a.name.localeCompare(b.name);
                const diff = sortKey(a) - sortKey(b);
                return diff === 0 ? a.name.localeCompare(b.name) : diff * dirMul;
              });
              const dimForCard = aggDim(filters.aggregateBy);
              const anyRowActive = repRows.some(r => isUnitActive(dimForCard, r.name));
              const dimLabelForCard: Record<AggDim["kind"], string> = {
                rep: "rep",
                flm: "FLM",
                slm: "SLM",
                region: "region",
                segment: "segment",
              };
              const canToggleCard = dimForCard.kind === "slm" ? !!onSetSlmFilter : !!onSetMultiFilter;
              repListNode = (
                <div className="absolute inset-0 overflow-y-auto bg-white space-y-2 pr-1">
                  {repRows.length === 0 ? (
                    <div className="text-[11px] text-[#94a3b8] py-2 text-center">No reps to show.</div>
                  ) : repRows.map(row => {
                    const isSelectedRow = isUnitActive(dimForCard, row.name);
                    const isActiveForRender = !anyRowActive || isSelectedRow;
                    const muted = anyRowActive && !isSelectedRow;
                    // Task #116: in Churn mode, by-rep row click opens the
                    // product-scoped Churn popup AND captures the rep so the
                    // funnel drilldown opened from the popup row scopes to
                    // that rep (parity with MRR's openForecastPopupForRep
                    // snapshot pattern). Calling the MRR-popup helper here
                    // would silently mutate aggregate filters with no popup
                    // to render (MRR popup is gated on forecastMetric).
                    const handleRepRowClick = isChurn
                      ? () => openForecastChurnPopupForRep(row.name, prod)
                      : () => openForecastPopupForRep(row.name, prod);
                    return (
                      <div
                        key={row.name}
                        role="button"
                        tabIndex={0}
                        onClick={handleRepRowClick}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleRepRowClick();
                          }
                        }}
                        className={`px-1 py-0.5 cursor-pointer rounded-md hover:bg-black/5 dark:hover:bg-white/5 transition-[background-color,opacity] ${muted ? "opacity-40" : ""}`}
                        title={`Open ${displayProduct(prod)} forecast for ${row.name}`}
                      >
                        {renderForecastBarBody({
                          label: row.name,
                          labelColor: prodColor,
                          isActive: isActiveForRender,
                          goal: row.goal,
                          mrr: row.mrr,
                          weighted: row.weighted,
                          target: coverageTargets[row.name] ?? effectiveCoverageTarget,
                          onLabelClick: canToggleCard ? () => handleAggUnitClick(row.name) : undefined,
                          labelTitle: isSelectedRow
                            ? `Remove ${row.name} from ${dimLabelForCard[dimForCard.kind]} filter`
                            : `Add ${row.name} to ${dimLabelForCard[dimForCard.kind]} filter`,
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            }

            const totalStrip = inRepView ? (
              <div className="grid grid-cols-4 gap-2 pt-1 pb-3 border-b border-border min-h-[78px]">
                <Tile metric="winRateToHit" title="% of remaining unweighted pipeline that must close to hit goal = (Goal − MRR booked) ÷ Weighted pipeline.">
                  <div className={tileLabelClass("winRateToHit")}>Win Rate to Hit{sortArrow("winRateToHit")}</div>
                  <div className="text-[16px] font-bold mt-auto pt-1 tabular-nums whitespace-nowrap truncate" style={{ color: "#FF6B35" }}>{totWrText}</div>
                </Tile>
                <Tile metric="coverage" title="Weighted pipeline ÷ goal." extra="border-l border-border">
                  <div className={tileLabelClass("coverage")}>Pipeline Coverage{sortArrow("coverage")}</div>
                  <div className="text-[16px] font-bold mt-auto pt-1 tabular-nums whitespace-nowrap truncate" style={{ color: covColor }}>{totCoverage.toFixed(1)}x</div>
                </Tile>
                <Tile metric="weighted" title="Total weighted pipeline across active products." extra="border-l border-border">
                  <div className={tileLabelClass("weighted")}>Total Weighted{sortArrow("weighted")}</div>
                  <div className="text-[16px] font-bold mt-auto pt-1 tabular-nums whitespace-nowrap truncate" style={{ color: isChurn ? "#EF4444" : "#006AFF" }}>${formatCurrencyShort(totWeighted)}</div>
                </Tile>
                <Tile metric="gap" title="Gap = Sum of active product goals − Total Weighted." extra="border-l border-border">
                  <div className={tileLabelClass("gap")}>Gap{sortArrow("gap")}</div>
                  <div className="text-[16px] font-bold tabular-nums mt-auto pt-1 whitespace-nowrap truncate" style={{ color: totGapColor }}>{totGapText}</div>
                </Tile>
              </div>
            ) : (
              <div
                role="button"
                tabIndex={0}
                aria-label="Adjust forecast assumptions"
                className="grid grid-cols-4 gap-2 pt-1 pb-3 border-b border-border min-h-[78px] cursor-pointer"
                onClick={() => {
                  // Task #190: a single combined popup handles both MRR
                  // and Churn drilldowns side-by-side for GNR (any
                  // forecast metric). ACQ still uses the same popup but
                  // renders MRR-only inside.
                  setForecastPopupOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setForecastPopupOpen(true);
                  }
                }}
                title="Click to adjust forecast assumptions"
              >
                <div className="text-center flex flex-col min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.5px] leading-tight text-[#64748b]">Win Rate to Hit</div>
                  <div className="text-[16px] font-bold mt-auto pt-1 tabular-nums whitespace-nowrap truncate" style={{ color: "#FF6B35" }}>{totWrText}</div>
                </div>
                <div className="text-center flex flex-col min-w-0 border-l border-border">
                  <div className="text-[10px] uppercase tracking-[0.5px] leading-tight text-[#64748b]">Pipeline Coverage</div>
                  <div className="text-[16px] font-bold mt-auto pt-1 tabular-nums whitespace-nowrap truncate" style={{ color: covColor }}>{totCoverage.toFixed(1)}x</div>
                </div>
                <div className="text-center flex flex-col min-w-0 border-l border-border">
                  <div className="text-[10px] uppercase tracking-[0.5px] leading-tight text-[#64748b]">Total Weighted</div>
                  <div className="text-[16px] font-bold mt-auto pt-1 tabular-nums whitespace-nowrap truncate" style={{ color: isChurn ? "#EF4444" : "#006AFF" }}>${formatCurrencyShort(totWeighted)}</div>
                </div>
                <div className="text-center flex flex-col min-w-0 border-l border-border">
                  <div className="text-[10px] uppercase tracking-[0.5px] leading-tight text-[#64748b]">Gap</div>
                  <div className="text-[16px] font-bold tabular-nums mt-auto pt-1 whitespace-nowrap truncate" style={{ color: totGapColor }}>{totGapText}</div>
                </div>
              </div>
            );

            return (
              <>
                {totalStrip}
                <div className={`relative pt-3 pb-4 ${inRepView ? "flex-1 min-h-0" : ""}`}>
                  {productListNode}
                  {repListNode}
                </div>
              </>
            );
          })()}
          </>)}
        </CardContent>
      </Card>

      {forecastPopupOpen && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30" onClick={() => setForecastPopupOpen(false)}>
          <div className={`bg-white rounded-lg shadow-xl ${forecastPopupSideBySide ? "w-[1640px] max-w-[97vw]" : "w-[920px]"} max-h-[90vh] overflow-auto`} onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between px-4 pt-4 pb-2 gap-3">
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-[#1e293b]">
                  All Products Forecast: {formatLongDate(new Date())}
                </div>
                <div className="text-[10px] text-[#64748b] mt-0.5">
                  {canEditStageDefault
                    ? "Stage defaults seed each new opportunity. Edit per-opp probability in the funnel drilldown."
                    : "Stage defaults seed each new opportunity. Per-opp overrides edited in the funnel drilldown."}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {showMrrSection && (
                  <button
                    type="button"
                    onClick={() => setUnreviewedDrilldown({ product: null, label: "All Products" })}
                    className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded border border-[#006AFF]/40 text-[#006AFF] hover:bg-[#006AFF]/10 transition-colors"
                    title="Opportunities whose probability has never been changed"
                  >
                    Review Unreviewed Opps
                    {unreviewedOppsCount != null && (
                      <span className="inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 rounded-full text-[10px] font-semibold bg-[#006AFF] text-white tabular-nums">
                        {unreviewedOppsCount}
                      </span>
                    )}
                  </button>
                )}
                {showChurnSection && (
                  <button
                    type="button"
                    onClick={() => setUnreviewedModsDrilldown({ product: null, label: "All Products" })}
                    className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded border border-[#EF4444]/40 text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors"
                    title="Scheduled mods whose probability has never been changed"
                  >
                    Review Unreviewed Mods
                    {unreviewedModsCount != null && (
                      <span className="inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 rounded-full text-[10px] font-semibold bg-[#EF4444] text-white tabular-nums">
                        {unreviewedModsCount}
                      </span>
                    )}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => exportPerRepForecast("csv")}
                  className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded border border-[#10B981]/40 text-[#10B981] hover:bg-[#10B981]/10 transition-colors"
                  title="Download flat per-rep CSV (one row per rep, 4 products × weighted/unweighted MRR + Churn)"
                >
                  <Download className="w-3 h-3" />
                  Export CSV
                </button>
                <button
                  type="button"
                  onClick={() => exportPerRepForecast("xlsx")}
                  className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded border border-[#10B981]/40 text-[#10B981] hover:bg-[#10B981]/10 transition-colors"
                  title="Download per-rep XLSX grouped SLM → FLM → Rep with collapsible subtotals"
                >
                  <Download className="w-3 h-3" />
                  Export XLSX
                </button>
                <button onClick={() => setForecastPopupOpen(false)} className="p-1 hover:bg-gray-100 rounded transition-colors">
                  <X className="w-4 h-4 text-[#64748b]" />
                </button>
              </div>
            </div>
            {/* Task #190: combined body. ACQ keeps the MRR-only layout
                (table + 3-BAN footer). GNR shows MRR (left) and Churn
                (right) side-by-side, with a per-section BAN footer
                beneath each table so the per-product stacks stay
                paired with their drilldown. */}
            <div className={forecastPopupSideBySide ? "grid grid-cols-2 gap-0 divide-x divide-border" : ""}>
            {showMrrSection && (<>
            <div className="min-w-0">
            <div className="px-4 pb-3">
              <div className="grid grid-cols-[1fr_92px_64px_1fr_90px_90px] gap-2 text-[10px] uppercase tracking-[0.5px] text-[#94a3b8] pb-1 border-b border-border">
                <div>Stage / Product</div>
                <div className="text-center">Default</div>
                <div className="text-center">Current</div>
                <div></div>
                <div className="text-right">Unweighted</div>
                <div className="text-right">Weighted</div>
              </div>
              {weightedData.map(item => {
                const sectionKey = `mrr:${item.stage}`;
                const isCollapsed = !aggregateExpandedSections.has(sectionKey);
                return (
                <div key={item.stage} className="border-b border-border/60 last:border-b-0">
                  <StageProbabilityRow
                    stage={item.stage}
                    defaultPct={item.defaultPct}
                    currentPct={item.currentPct}
                    unweightedMrr={item.val}
                    weightedMrr={item.wVal}
                    canEdit={canEditStageDefault}
                    onSaveDefault={(v) => updateStageDefault(item.stage, v)}
                    collapsible
                    collapsed={isCollapsed}
                    onToggleCollapse={() => toggleAggregateSection(sectionKey)}
                  />
                  {/* Task #187: per-product sub-rows within each stage,
                      using dashboard product colors. Display-only — stage
                      defaults are edited once above; per-product current%
                      is the rep-weighted average for that stage × product. */}
                  {!isCollapsed && mrrAggregateProductDrilldowns.map(p => {
                    const row = p.stageRows.find(s => s.stage === item.stage);
                    if (!row) return null;
                    const cur = Math.max(0, Math.min(100, row.currentPct));
                    const def = Math.max(0, Math.min(100, row.defaultPct));
                    return (
                      <div key={p.product} className="grid grid-cols-[1fr_92px_64px_1fr_90px_90px] items-center gap-2 py-1 pl-4 text-[11px] bg-black/[0.015]">
                        <div className="truncate flex items-center gap-1.5" title={displayProduct(p.product)}>
                          <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: p.color }} />
                          <span style={{ color: p.color }} className="font-medium">{displayProduct(p.product)}</span>
                        </div>
                        <div className="text-center tabular-nums text-[#475569]">{def.toFixed(0)}%</div>
                        <div className="text-center tabular-nums text-[#475569]">{cur.toFixed(0)}%</div>
                        <div>
                          <div className="h-1.5 bg-black/5 rounded overflow-hidden">
                            <div className="h-full rounded" style={{ width: `${cur}%`, backgroundColor: p.color }} />
                          </div>
                        </div>
                        <div className="text-right tabular-nums text-[#475569]">{formatCurrency(row.val)}</div>
                        <div className="text-right tabular-nums font-medium" style={{ color: p.color }}>{formatCurrency(row.wVal)}</div>
                      </div>
                    );
                  })}
                </div>
                );
              })}
              {subtractMods && (
                <StageProbabilityRow
                  stage="Scheduled Mods"
                  defaultPct={modsRow.defaultPct}
                  currentPct={modsRow.currentPct}
                  unweightedMrr={-modsRow.val}
                  weightedMrr={-modsRow.wVal}
                  canEdit={canEditStageDefault}
                  onSaveDefault={(v) => updateStageDefault("Scheduled Mods", v)}
                  accentColor="#ef4444"
                  subLabel={modsDateRange.fromDate && modsDateRange.toDate
                    ? `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][modsDateRange.fromDate.getMonth()]}-${modsDateRange.fromDate.getDate()} – ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][modsDateRange.toDate.getMonth()]}-${modsDateRange.toDate.getDate()}`
                    : undefined}
                />
              )}
            </div>
            {/* Task #187: BAN footer with per-product stacks. Each cell
                shows the aggregate value plus a vertical list of per-
                product contributions in dashboard colors. */}
            <div className="grid grid-cols-3 gap-4 px-4 py-3 border-t border-border bg-[#f8fafc] rounded-b-lg">
              <div className="text-center">
                <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Win Rate to Hit</div>
                <div className="text-[16px] font-bold" style={{ color: "#FF6B35" }}>{popupWinRateToHit.toFixed(0)}%</div>
                <div className="mt-1.5 space-y-0.5">
                  {mrrAggregateProductDrilldowns.map(p => (
                    <div key={p.product} className="flex items-center justify-between gap-2 text-[10px]">
                      <span className="truncate" style={{ color: p.color }}>{displayProduct(p.product)}</span>
                      <span className="tabular-nums text-[#475569]">{p.winRateToHit.toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="text-center border-l border-border">
                <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Pipeline Coverage</div>
                <div className="text-[16px] font-bold" style={{ color: "#006AFF" }}>{popupCoverage.toFixed(1)}x</div>
                <div className="mt-1.5 space-y-0.5">
                  {mrrAggregateProductDrilldowns.map(p => (
                    <div key={p.product} className="flex items-center justify-between gap-2 text-[10px]">
                      <span className="truncate" style={{ color: p.color }}>{displayProduct(p.product)}</span>
                      <span className="tabular-nums text-[#475569]">{p.coverage.toFixed(1)}x</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="text-center border-l border-border">
                <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Total Weighted</div>
                <div className="text-[16px] font-bold text-[#006AFF]">{formatCurrency(popupSumWeighted)}</div>
                <div className="mt-1.5 space-y-0.5">
                  {mrrAggregateProductDrilldowns.map(p => (
                    <div key={p.product} className="flex items-center justify-between gap-2 text-[10px]">
                      <span className="truncate" style={{ color: p.color }}>{displayProduct(p.product)}</span>
                      <span className="tabular-nums text-[#475569]">{formatCurrency(p.weightedTotal)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            </div>{/* /MRR left column */}
            </>)}
            {/* Task #190: Churn right column (GNR only). Same shape as
                the standalone aggregate Churn popup: churn-type rows
                with per-product drilldowns and a 5-BAN footer. */}
            {showChurnSection && (
              <div className="min-w-0">
                <div className="px-4 pb-3">
                  <div className="text-[10px] text-[#64748b] pt-2 pb-1 italic">
                    {canEditStageDefault
                      ? "Each churn type's stage default seeds its mods. Edit per-mod probability in the funnel drilldown."
                      : "Each churn type's stage default seeds its mods. Per-mod overrides edited in the funnel drilldown."}
                  </div>
                  <div className="grid grid-cols-[1fr_92px_64px_1fr_90px_90px] gap-2 text-[10px] uppercase tracking-[0.5px] text-[#94a3b8] pb-1 border-b border-border">
                    <div>Churn Type / Product</div>
                    <div className="text-center">Default</div>
                    <div className="text-center">Current</div>
                    <div></div>
                    <div className="text-right">Unweighted</div>
                    <div className="text-right">Weighted</div>
                  </div>
                  {/* Task #190 (follow-up): one Manager Estimate row per
                      in-scope product, pinned above the churn-type rows so
                      reviewers see the human estimate in the aggregate
                      drilldown — matches the per-product Churn popup UX. */}
                  {(() => {
                    const ymSrc = modsDateRange.toDate ?? modsDateRange.fromDate ?? new Date();
                    const yyyymm = `${ymSrc.getFullYear()}${String(ymSrc.getMonth() + 1).padStart(2, "0")}`;
                    // Task #192: single parent ME row + per-product
                    // sub-rows (mirrors Scheduled Mod / CC Decline).
                    const meKey = "me";
                    const meCollapsed = !aggregateExpandedSections.has(meKey);
                    return (
                      <ChurnForecastMERow
                        key="me-aggregate"
                        product={churnAggregateProductDrilldowns[0]?.product ?? ""}
                        monthYyyymm={yyyymm}
                        authUser={authUser}
                        repsScope={popupActiveRepNames}
                        flmsScope={filters.flm.length > 0 ? filters.flm : undefined}
                        products={churnAggregateProductDrilldowns.map(p => ({ product: p.product, color: p.color }))}
                        collapsible
                        collapsed={meCollapsed}
                        onToggleCollapse={() => toggleAggregateSection(meKey)}
                      />
                    );
                  })()}
                  {(() => {
                    const typeSet = new Set<string>(["Scheduled Mod", "CC Decline"]);
                    for (const p of churnAggregateProductDrilldowns) for (const r of p.churnTypeRows) typeSet.add(r.churnType);
                    const types = Array.from(typeSet).sort((a, b) => {
                      if (a === "Scheduled Mod") return -1;
                      if (b === "Scheduled Mod") return 1;
                      if (a === "CC Decline") return -1;
                      if (b === "CC Decline") return 1;
                      return a.localeCompare(b);
                    });
                    const subLabel = modsDateRange.fromDate && modsDateRange.toDate
                      ? `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][modsDateRange.fromDate.getMonth()]}-${modsDateRange.fromDate.getDate()} – ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][modsDateRange.toDate.getMonth()]}-${modsDateRange.toDate.getDate()}`
                      : undefined;
                    return types.map(ct => {
                      let aggVal = 0, aggWVal = 0;
                      for (const p of churnAggregateProductDrilldowns) {
                        const r = p.churnTypeRows.find(x => x.churnType === ct);
                        if (r) { aggVal += r.val; aggWVal += r.wVal; }
                      }
                      const defaultPct = processedData?.stageDefaults[ct] ?? 100;
                      const aggCur = aggVal > 0 ? (aggWVal / aggVal) * 100 : defaultPct;
                      const sectionKey = `churn:${ct}`;
                      const isCollapsed = !aggregateExpandedSections.has(sectionKey);
                      return (
                        <div key={ct} className="border-b border-border/60 last:border-b-0">
                          <StageProbabilityRow
                            stage={ct}
                            defaultPct={defaultPct}
                            currentPct={aggCur}
                            unweightedMrr={aggVal}
                            weightedMrr={aggWVal}
                            canEdit={canEditStageDefault}
                            onSaveDefault={(v) => updateStageDefault(ct, v)}
                            accentColor="#ef4444"
                            subLabel={subLabel}
                            collapsible
                            collapsed={isCollapsed}
                            onToggleCollapse={() => toggleAggregateSection(sectionKey)}
                          />
                          {!isCollapsed && churnAggregateProductDrilldowns.map(p => {
                            // Task #190 (review follow-up): if this product
                            // has no row for the given churn type,
                            // synthesize a zero row using the stage default
                            // so every product×type combination renders in
                            // the All-Products view.
                            const found = p.churnTypeRows.find(s => s.churnType === ct);
                            const defPct = processedData?.stageDefaults[ct] ?? 100;
                            const row = found ?? { churnType: ct, val: 0, wVal: 0, count: 0, defaultPct: defPct, currentPct: defPct };
                            const cur = Math.max(0, Math.min(100, row.currentPct));
                            const def = Math.max(0, Math.min(100, row.defaultPct));
                            return (
                              <div key={p.product} className="grid grid-cols-[1fr_92px_64px_1fr_90px_90px] items-center gap-2 py-1 pl-4 text-[11px] bg-black/[0.015]">
                                <div className="truncate flex items-center gap-1.5" title={displayProduct(p.product)}>
                                  <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: p.color }} />
                                  <span style={{ color: p.color }} className="font-medium">{displayProduct(p.product)}</span>
                                </div>
                                <div className="text-center tabular-nums text-[#475569]">{def.toFixed(0)}%</div>
                                <div className="text-center tabular-nums text-[#475569]">{cur.toFixed(0)}%</div>
                                <div>
                                  <div className="h-1.5 bg-black/5 rounded overflow-hidden">
                                    <div className="h-full rounded" style={{ width: `${cur}%`, backgroundColor: p.color }} />
                                  </div>
                                </div>
                                <div className="text-right tabular-nums text-[#475569]">{formatCurrency(row.val)}</div>
                                <div className="text-right tabular-nums font-medium" style={{ color: p.color }}>{formatCurrency(row.wVal)}</div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    });
                  })()}
                </div>
                {(() => {
                  const totalBooked = churnAggregateProductDrilldowns.reduce((s, p) => s + p.booked, 0);
                  const totalWeightedC = churnAggregateProductDrilldowns.reduce((s, p) => s + p.weighted, 0);
                  const totalGoal = churnAggregateProductDrilldowns.reduce((s, p) => s + p.goal, 0);
                  const totalGap = totalGoal - totalWeightedC;
                  const totalCov = totalGoal > 0 ? totalWeightedC / totalGoal : 0;
                  return (
                    <div className="grid grid-cols-5 gap-3 px-4 py-3 border-t border-border bg-[#f8fafc]">
                      <div className="text-center" title="Sum of churn goal caps across in-scope products.">
                        <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Goal</div>
                        <div className="text-[16px] font-bold text-[#1e293b] tabular-nums">{formatCurrency(totalGoal)}</div>
                        <div className="mt-1.5 space-y-0.5">
                          {churnAggregateProductDrilldowns.map(p => (
                            <div key={p.product} className="flex items-center justify-between gap-2 text-[10px]">
                              <span className="truncate" style={{ color: p.color }}>{displayProduct(p.product)}</span>
                              <span className="tabular-nums text-[#475569]">{formatCurrency(p.goal)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="text-center border-l border-border" title="Sum of scheduled-mod amounts (booked) across in-scope products.">
                        <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Booked</div>
                        <div className="text-[16px] font-bold text-[#EF4444] tabular-nums">{formatCurrency(totalBooked)}</div>
                        <div className="mt-1.5 space-y-0.5">
                          {churnAggregateProductDrilldowns.map(p => (
                            <div key={p.product} className="flex items-center justify-between gap-2 text-[10px]">
                              <span className="truncate" style={{ color: p.color }}>{displayProduct(p.product)}</span>
                              <span className="tabular-nums text-[#475569]">{formatCurrency(p.booked)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="text-center border-l border-border" title="Sum of (mod amount × effective probability) across in-scope products.">
                        <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Weighted</div>
                        <div className="text-[16px] font-bold text-[#EF4444] tabular-nums">{formatCurrency(totalWeightedC)}</div>
                        <div className="mt-1.5 space-y-0.5">
                          {churnAggregateProductDrilldowns.map(p => (
                            <div key={p.product} className="flex items-center justify-between gap-2 text-[10px]">
                              <span className="truncate" style={{ color: p.color }}>{displayProduct(p.product)}</span>
                              <span className="tabular-nums text-[#475569]">{formatCurrency(p.weighted)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="text-center border-l border-border" title="Total weighted ÷ total goal.">
                        <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Coverage</div>
                        <div className="text-[16px] font-bold text-[#006AFF] tabular-nums">{totalCov.toFixed(1)}x</div>
                        <div className="mt-1.5 space-y-0.5">
                          {churnAggregateProductDrilldowns.map(p => (
                            <div key={p.product} className="flex items-center justify-between gap-2 text-[10px]">
                              <span className="truncate" style={{ color: p.color }}>{displayProduct(p.product)}</span>
                              <span className="tabular-nums text-[#475569]">{p.coverage.toFixed(1)}x</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="text-center border-l border-border" title="Gap = Goal − Total Weighted. Positive = under cap.">
                        <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Gap</div>
                        <div className="text-[16px] font-bold tabular-nums" style={{ color: totalGap >= 0 ? "#10B981" : "#EF4444" }}>{totalGap >= 0 ? formatCurrency(totalGap) : `-${formatCurrency(Math.abs(totalGap))}`}</div>
                        <div className="mt-1.5 space-y-0.5">
                          {churnAggregateProductDrilldowns.map(p => (
                            <div key={p.product} className="flex items-center justify-between gap-2 text-[10px]">
                              <span className="truncate" style={{ color: p.color }}>{displayProduct(p.product)}</span>
                              <span className="tabular-nums" style={{ color: p.gap >= 0 ? "#10B981" : "#EF4444" }}>{p.gap >= 0 ? formatCurrency(p.gap) : `-${formatCurrency(Math.abs(p.gap))}`}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
            </div>{/* /combined body wrapper */}
          </div>
        </div>,
        document.body
      )}

      {/* Task #190: standalone aggregate GNR Churn Forecast popup has
          been folded into the combined `forecastPopupOpen` popup above
          (left = MRR drilldown, right = Churn drilldown). The state
          variable is preserved for any latent callers but never set
          true; nothing renders here. */}

      {/* Task #116: also render the MRR popup in Both mode so the by-rep
          row click in `inBothRepView` opens a visible modal (it sets
          `forecastPopupProduct` via openForecastPopupForRep). Without this
          gate widening the click silently mutated aggregate filters with
          no popup to render. */}
      {(forecastShowNet || (!forecastShowNet && (forecastMetric === "mrr" || forecastMetric === "both"))) && productDrilldownData && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30" onClick={closeForecastPopup}>
          <div className="bg-white rounded-lg shadow-xl w-[760px] max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <div>
                <div className="text-[14px] font-semibold text-[#1e293b]">
                  {displayProductText(productDrilldownData.title)}
                  {forecastPopupRep ? <span className="text-[#64748b] font-normal"> — </span> : null}
                  {forecastPopupRep ? <span>{forecastPopupRep}</span> : null}
                </div>
                <div className="text-[10px] text-[#64748b] mt-0.5">
                  {canEditStageDefault
                    ? "Stage defaults seed each new opportunity. Edit per-opp probability in the funnel drilldown."
                    : "Stage defaults seed each new opportunity. Per-opp overrides edited in the funnel drilldown."}
                </div>
              </div>
              <button onClick={closeForecastPopup} className="p-1 hover:bg-gray-100 rounded transition-colors">
                <X className="w-4 h-4 text-[#64748b]" />
              </button>
            </div>
            {/* Drilldown header controls: coverage target (editable for slm/admin),
                Unreviewed Opportunities, and Export CSV. */}
            <ProductDrilldownHeader
              product={productDrilldownData.product}
              productTitle={productDrilldownData.title}
              activeRepNames={popupActiveRepNames}
              repCoverageTargets={coverageTargets}
              defaultTarget={DEFAULT_COVERAGE_TARGET}
              authUser={authUser}
              filtersSummary={describeActiveFilters(filters, mrrMode, pipelineMode)}
              stageRows={productDrilldownData.stageRows}
              modsRow={subtractMods ? productDrilldownData.modsRow : null}
              weightedTotal={productDrilldownData.weightedTotal}
              goal={productDrilldownData.goal}
              gap={productDrilldownData.gap}
              winRateToHit={productDrilldownData.winRateToHit}
              coverage={productDrilldownData.coverage}
              onSaveCoverage={(v) => updateCoverageTargets(v, popupActiveRepNames)}
              onOpenUnreviewed={() => setUnreviewedDrilldown({ product: productDrilldownData.product, label: displayProductText(productDrilldownData.title) })}
            />
            <div className="px-4 pb-3">
              <div className="grid grid-cols-[1fr_92px_64px_1fr_70px_70px] gap-2 text-[10px] uppercase tracking-[0.5px] text-[#94a3b8] pb-1 border-b border-border">
                <div>Stage</div>
                <div className="text-center">Default</div>
                <div className="text-center">Current</div>
                <div></div>
                <div className="text-right">Unweighted</div>
                <div className="text-right">Weighted</div>
              </div>
              {productDrilldownData.stageRows.map(item => (
                <StageProbabilityRow
                  key={item.stage}
                  stage={item.stage}
                  defaultPct={item.defaultPct}
                  currentPct={item.currentPct}
                  unweightedMrr={item.val}
                  weightedMrr={item.wVal}
                  canEdit={canEditStageDefault}
                  onSaveDefault={(v) => updateStageDefault(item.stage, v)}
                />
              ))}
              {subtractMods && (
                <StageProbabilityRow
                  stage="Scheduled Mods"
                  defaultPct={productDrilldownData.modsRow.defaultPct}
                  currentPct={productDrilldownData.modsRow.currentPct}
                  unweightedMrr={-productDrilldownData.modsRow.val}
                  weightedMrr={-productDrilldownData.modsRow.wVal}
                  canEdit={canEditStageDefault}
                  onSaveDefault={(v) => updateStageDefault("Scheduled Mods", v)}
                  accentColor="#ef4444"
                  subLabel={modsDateRange.fromDate && modsDateRange.toDate
                    ? `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][modsDateRange.fromDate.getMonth()]}-${modsDateRange.fromDate.getDate()} – ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][modsDateRange.toDate.getMonth()]}-${modsDateRange.toDate.getDate()}`
                    : undefined}
                />
              )}
            </div>
            {(() => {
              const pGap = productDrilldownData.gap;
              const pGapColor = pGap > 0 ? "#EF4444" : pGap < 0 ? "#10B981" : "#64748b";
              const pGapText = pGap >= 0 ? formatCurrency(pGap) : `-${formatCurrency(Math.abs(pGap))}`;
              const cov = productDrilldownData.coverage;
              const covColor = cov > 3.5 ? "#00C49F" : cov >= 1 ? "#006AFF" : "#FF6B35";
              return (
                <div className="grid grid-cols-4 gap-4 px-4 py-3 border-t border-border bg-[#f8fafc] rounded-b-lg">
                  <div className="text-center" title="% of remaining unweighted pipeline that must close to hit goal = (Goal − MRR booked) ÷ Weighted pipeline.">
                    <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Win Rate to Hit</div>
                    <div className="text-[16px] font-bold" style={{ color: "#FF6B35" }}>{productDrilldownData.winRateToHit.toFixed(0)}%</div>
                  </div>
                  <div className="text-center border-l border-border" title="Weighted pipeline ÷ goal.">
                    <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Pipeline Coverage</div>
                    <div className="text-[16px] font-bold" style={{ color: covColor }}>{cov.toFixed(1)}x</div>
                  </div>
                  <div className="text-center border-l border-border">
                    <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Total Weighted</div>
                    <div className="text-[16px] font-bold text-[#006AFF]">{formatCurrency(productDrilldownData.weightedTotal)}</div>
                  </div>
                  <div className="text-center border-l border-border" title="Gap = Goal − Total Weighted. Positive = more pipeline still needed; negative = surplus.">
                    <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Gap</div>
                    <div className="text-[16px] font-bold tabular-nums" style={{ color: pGapColor }}>{pGapText}</div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>,
        document.body
      )}

      {/* Task #116/#157: Churn Forecast drilldown popup. Mirrors the MRR
          popup but with one row per distinct churn_type plus the pinned
          Manager Estimate row, and inverted-color tiles. Clicking a
          churn-type row opens FunnelDrilldownModal in mods mode scoped
          to the active product + that churn type. */}
      {!forecastShowNet && (forecastMetric === "churn" || forecastMetric === "both") && churnDrilldownData && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30" onClick={closeForecastChurnPopup}>
          <div className="bg-white rounded-lg shadow-xl w-[760px] max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <div>
                <div className="text-[14px] font-semibold text-[#1e293b]">{displayProductText(churnDrilldownData.title)}</div>
                <div className="text-[10px] text-[#64748b] mt-0.5">
                  {canEditStageDefault
                    ? "Each churn type's stage default seeds its mods. Edit per-mod probability in the funnel drilldown."
                    : "Each churn type's stage default seeds its mods. Per-mod overrides edited in the funnel drilldown."}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setUnreviewedModsDrilldown({
                    product: churnDrilldownData.product,
                    label: displayProductText(churnDrilldownData.title),
                    rep: forecastChurnPopup?.rep,
                  })}
                  className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded border border-[#EF4444]/40 text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors"
                  title="Scheduled mods whose probability has never been changed"
                >
                  Review Unreviewed Mods
                  {unreviewedModsCount != null && (
                    <span className="inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 rounded-full text-[10px] font-semibold bg-[#EF4444] text-white tabular-nums">
                      {unreviewedModsCount}
                    </span>
                  )}
                </button>
                <button onClick={closeForecastChurnPopup} className="p-1 hover:bg-gray-100 rounded transition-colors">
                  <X className="w-4 h-4 text-[#64748b]" />
                </button>
              </div>
            </div>
            <div className="px-4 pb-3">
              <div className="grid grid-cols-[1fr_92px_64px_1fr_70px_70px] gap-2 text-[10px] uppercase tracking-[0.5px] text-[#94a3b8] pb-1 border-b border-border">
                <div>Churn Type</div>
                <div className="text-center">Default</div>
                <div className="text-center">Current</div>
                <div></div>
                <div className="text-right">Unweighted</div>
                <div className="text-right">Weighted</div>
              </div>
              {/* Task #155/#157: Pin the editable Manager Estimate row at
                  the top of the per-churn-type list so reviewers always see
                  the human estimate before the auto-rolled mods. */}
              {(() => {
                const ymSrc = modsDateRange.toDate ?? modsDateRange.fromDate ?? new Date();
                const yyyymm = `${ymSrc.getFullYear()}${String(ymSrc.getMonth() + 1).padStart(2, "0")}`;
                return (
                  <ChurnForecastMERow
                    product={churnDrilldownData.product}
                    monthYyyymm={yyyymm}
                    authUser={authUser}
                    // Scope: when the popup was opened from a by-rep row,
                    // narrow to that single rep so the rolled-up current
                    // % reflects only that rep's ME slice. Otherwise pass
                    // every rep visible under the dashboard filters so
                    // SLM/admin viewers see the org-wide weighted-avg
                    // across all rep × product overrides. The FLM filter
                    // is forwarded too so an FLM-scoped popup pulls only
                    // that team's amounts before per-rep distribution.
                    repsScope={forecastChurnPopup?.rep
                      ? [forecastChurnPopup.rep]
                      : popupActiveRepNames}
                    flmsScope={filters.flm.length > 0 ? filters.flm : undefined}
                  />
                );
              })()}
              {(() => {
                // Task #116/#157: Scope the funnel drilldown to product +
                // optional rep (if popup was opened from a by-rep row) +
                // the clicked row's churn type.
                const drillProductFilter = churnDrilldownData.product === "Showcase"
                  ? ["Showcase", "Showcase Incremental", "Showcase Incremental - Re/Max", "Overage"]
                  : [churnDrilldownData.product];
                const drillRep = forecastChurnPopup?.rep;
                return churnDrilldownData.churnTypeRows.map((r) => {
                  const openDrill = () => setDrilldown({
                    stage: "",
                    mode: "mods",
                    productFilter: drillProductFilter,
                    churnTypeFilter: r.churnType,
                    ...(drillRep ? { nameFilter: drillRep, nameFilterDimension: "Rep" as AggregateBy } : {}),
                  });
                  // Every per-churn-type row reflects the same mod date
                  // window, so each row carries its own date sub-label
                  // (matches the original single Scheduled Mods row's UX).
                  const showDateLabel = true;
                  return (
                    <div
                      key={r.churnType}
                      role="button"
                      tabIndex={0}
                      onClick={openDrill}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDrill(); } }}
                      className="cursor-pointer rounded hover:bg-black/[0.03] dark:hover:bg-white/5"
                      title={`Open ${r.churnType} drilldown for ${displayProduct(churnDrilldownData.product)}${drillRep ? ` — ${drillRep}` : ""}`}
                    >
                      <StageProbabilityRow
                        stage={r.churnType}
                        defaultPct={r.defaultPct}
                        currentPct={r.currentPct}
                        unweightedMrr={r.val}
                        weightedMrr={r.wVal}
                        count={r.count}
                        countSuffix={r.count === 1 ? "mod" : "mods"}
                        canEdit={canEditStageDefault}
                        onSaveDefault={(v) => updateStageDefault(r.churnType, v)}
                        accentColor="#ef4444"
                        subLabel={showDateLabel && modsDateRange.fromDate && modsDateRange.toDate
                          ? `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][modsDateRange.fromDate.getMonth()]}-${modsDateRange.fromDate.getDate()} – ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][modsDateRange.toDate.getMonth()]}-${modsDateRange.toDate.getDate()}`
                          : undefined}
                      />
                    </div>
                  );
                });
              })()}
            </div>
            {(() => {
              const cGap = churnDrilldownData.gap;
              const cGapColor = churnGapColor(cGap, churnDrilldownData.goal);
              const cGapText = cGap >= 0 ? formatCurrency(cGap) : `-${formatCurrency(Math.abs(cGap))}`;
              const cCov = churnDrilldownData.coverage;
              const cCovColor = churnCovColor(cCov, churnDrilldownData.goal, effectiveCoverageTarget);
              const cWr = churnDrilldownData.winRateToHit;
              const cWrText = cWr === null ? "—" : `${cWr.toFixed(0)}%`;
              return (
                <div className="grid grid-cols-6 gap-3 px-4 py-3 border-t border-border bg-[#f8fafc] rounded-b-lg">
                  <div className="text-center" title="Churn goal cap for the period.">
                    <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Goal</div>
                    <div className="text-[16px] font-bold text-[#1e293b] tabular-nums">{formatCurrency(churnDrilldownData.goal)}</div>
                  </div>
                  <div className="text-center border-l border-border" title="Sum of scheduled-mod amounts (booked) for this product.">
                    <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Booked</div>
                    <div className="text-[16px] font-bold text-[#EF4444] tabular-nums">{formatCurrency(churnDrilldownData.booked)}</div>
                  </div>
                  <div className="text-center border-l border-border" title="Sum of (mod amount × effective probability) — weighted scheduled-mod pipeline.">
                    <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Weighted</div>
                    <div className="text-[16px] font-bold text-[#EF4444] tabular-nums">{formatCurrency(churnDrilldownData.weighted)}</div>
                  </div>
                  <div className="text-center border-l border-border" title="Weighted scheduled-mod pipeline ÷ churn goal.">
                    <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Coverage</div>
                    <div className="text-[16px] font-bold tabular-nums" style={{ color: cCovColor }}>{cCov.toFixed(1)}x</div>
                  </div>
                  <div className="text-center border-l border-border" title="Gap = Goal − Total Weighted. Positive = under cap (good); negative = over cap.">
                    <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Gap</div>
                    <div className="text-[16px] font-bold tabular-nums" style={{ color: cGapColor }}>{cGapText}</div>
                  </div>
                  <div className="text-center border-l border-border" title="% of remaining unweighted mods that must close to stay under churn cap = (Booked − Goal) ÷ (Booked − Weighted), clamped to [0, 100].">
                    <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] mb-1">WR to Hit</div>
                    <div className="text-[16px] font-bold tabular-nums" style={{ color: "#FF6B35" }}>{cWrText}</div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>,
        document.body
      )}

      <StackedHorizontalBar
        data={repMrr}
        products={displayProducts}
        height={310}
        barColor="#006AFF"
        csvData={repMrr.map(d => ({ name: d.name, value: d.total }))}
        csvFilename="mrr-by-rep.csv"
        title={mrrMode === "gnrNet" ? "G&R Single Month MRR" : "ACQ Single Month MRR"}
        titleSum={formatCurrencyFull(repMrr.reduce((s, d) => s + d.total, 0))}
        sfReportUrl={SF_OPPS_REPORT}
        onTitleClick={() => setDrilldown({ stage: "", mode: "mrr" })}
        onNameClick={(name) => setDrilldown({ stage: "", mode: "mrr", nameFilter: name, nameFilterDimension: filters.aggregateBy })}
        headerExtra={<MrrLogicLink />}
      />

      <StackedHorizontalBar
        data={repChurn}
        products={displayProducts}
        height={310}
        barColor="#EF4444"
        csvData={repChurn.map(d => ({ name: d.name, value: d.total }))}
        csvFilename="churn.csv"
        title={mrrMode === "gnrNet" ? "G&R Churn" : mrrMode === "acqNet" ? "ACQ Churn" : "Churn"}
        titleSum={formatCurrencyFull(repChurn.reduce((s, d) => s + d.total, 0))}
        sfReportUrl={SF_OPPS_REPORT}
        onTitleClick={() => setDrilldown({ stage: "", mode: "churn" })}
        onNameClick={(name) => setDrilldown({ stage: "", mode: "churn", nameFilter: name, nameFilterDimension: filters.aggregateBy })}
        headerExtra={<ChurnLogicLink />}
      />

      <StackedHorizontalBar
        data={repMods}
        products={[]}
        height={310}
        barColor="#FF6B35"
        csvData={repMods.map(d => ({ name: d.name, value: d.total }))}
        csvFilename="scheduled-mods.csv"
        title="Scheduled Mods"
        titleSum={formatCurrencyFull(repMods.reduce((s, d) => s + d.total, 0))}
        sfReportUrl={SF_MODS_REPORT}
        onTitleClick={() => setDrilldown({ stage: "", mode: "mods" })}
        onNameClick={(name) => setDrilldown({ stage: "", mode: "mods", nameFilter: name, nameFilterDimension: filters.aggregateBy })}
        headerExtra={
          <ModsWindowLink
            fromDate={modsDateRange.fromDate}
            toDate={modsDateRange.toDate}
            modsStart={modsStart}
            onModsStartChange={onModsStartChange}
            modsExtend={modsExtend}
            onModsExtendChange={onModsExtendChange}
            todayInPeriod={isTodayWithinPeriod(filters.timeframe, filters.customRange)}
          />
        }
      />

      {drilldown && (
        <Suspense fallback={null}>
          <FunnelDrilldownModal
            stage={drilldown.stage}
            mode={drilldown.mode}
            filters={filters}
            nameFilter={drilldown.nameFilter}
            nameFilterDimension={drilldown.nameFilterDimension}
            productFilter={drilldown.productFilter}
            churnTypeFilter={drilldown.churnTypeFilter}
            mrrMode={mrrMode}
            revenueMode={revenueMode}
            modsFrom={modsDateRange.from}
            modsTo={modsDateRange.to}
            pipelineMode={pipelineMode}
            onClose={() => setDrilldown(null)}
            authUser={authUser}
            onProbabilityChanged={() => {
              // Per-opp probability edits in the funnel drilldown affect the
              // Forecast Assumptions Current %, bar chart, and Weighted totals
              // (which are derived from server-side per-stage prob sums/counts).
              // Refetch the pipeline payload so those values stay in sync.
              queryClient.invalidateQueries({ queryKey: ["/api/sales/pipeline"] });
            }}
          />
        </Suspense>
      )}

      {unreviewedDrilldown && (
        <Suspense fallback={null}>
          <UnreviewedOppsModal
            filters={filters}
            pipelineMode={pipelineMode}
            productFilter={unreviewedDrilldown.product}
            contextLabel={unreviewedDrilldown.label}
            authUser={authUser}
            onClose={() => setUnreviewedDrilldown(null)}
            onProbabilityChanged={() => {
              queryClient.invalidateQueries({ queryKey: ["/api/sales/pipeline"] });
              queryClient.invalidateQueries({ queryKey: ["/api/sales/unreviewed-opps"] });
              // Task #187: keep the aggregate MRR popup's badge count
              // in sync with modal edits without requiring popup close.
              setUnreviewedOppsRefetchTick(t => t + 1);
            }}
          />
        </Suspense>
      )}

      {unreviewedModsDrilldown && (
        <Suspense fallback={null}>
          <UnreviewedModsModal
            filters={filters}
            productFilter={unreviewedModsDrilldown.product}
            modsFrom={modsDateRange.from}
            modsTo={modsDateRange.to}
            repFilter={unreviewedModsDrilldown.rep}
            contextLabel={unreviewedModsDrilldown.label}
            authUser={authUser}
            onClose={() => setUnreviewedModsDrilldown(null)}
            onProbabilityChanged={() => {
              queryClient.invalidateQueries({ queryKey: ["/api/sales/pipeline"] });
              queryClient.invalidateQueries({ queryKey: ["/api/sales/unreviewed-mods"] });
              setUnreviewedModsRefetchTick(t => t + 1);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
