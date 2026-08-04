import { useState, useMemo, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { 
  useGetSalesConfig, 
  useGetSalesActivity, 
  useGetSalesActions,
  useGetSalesAnaplan,
  getGetSalesAnaplanQueryKey 
} from "@workspace/api-client-react";
import type { PipelineData } from "@workspace/api-client-react";
import { getDateRange, getModsDateRange, computeWindowedRemainingEligibility, getTodayPST, snapDateFilterForProrateMode, ON_DEMAND_REPS } from "../lib/utils";
import { 
  Printer, 
  Sun, 
  Moon,
  RefreshCw,
  Check,
  ChevronsUpDown,
  Search,
  CalendarIcon,
  AlertTriangle,
  X,
  ExternalLink,
  SlidersHorizontal,
  ChevronDown
} from "lucide-react";
import { format } from "date-fns";
import SheetUrlInput from "../components/SheetUrlInput";
import {
  LIVE_SELECTOR,
  getSnapshotSelector,
  setSnapshotSelector,
  getSnapshotCapturedAt,
  subscribeSnapshot,
} from "../lib/snapshot";
import type { AuthUser } from "@workspace/replit-auth-web";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import type { DateRange } from "react-day-picker";
import { registerProductLabels, displayProduct, displayProductAbbrev, displayProductText } from "@/lib/product-labels";
import PipelineView from "../components/views/PipelineView";
import { PipelineSettingsPopup } from "../components/views/PipelineView";
import type { MrrMode } from "../components/views/PipelineView";
import ActivityView from "../components/views/ActivityView";
import ActionsView, { mapInboundProduct } from "../components/views/ActionsView";
import SpiffView from "../components/views/SpiffView";
import type { SpiffViewRef } from "../components/views/SpiffView";
import ExecutiveView from "../components/views/ExecutiveView";
import AdminView from "../components/views/AdminView";
import AnaplanView from "../components/views/AnaplanView";
import { LogOut, Plus, HelpCircle } from "lucide-react";
import { usePhotoMap, resolvePhotoUrl } from "../hooks/usePhotoMap";
import { useUsHolidays } from "../hooks/useUsHolidays";
import { useUserPreference } from "../hooks/useUserPreference";
import { toast } from "../hooks/use-toast";
const SalesforceExplainerModal = lazy(() => import("../components/SalesforceExplainerModal"));

export type Timeframe = "mtd" | "lastMonth" | "custom" | "allTime" | "mtd2date" | "eom" | "thisWeek" | "today";
export type AggregateBy = "Rep" | "FLM" | "SLM" | "Region" | "Segment";
export type PipelineMode = "closeDate" | "allOpen";
export type RevenueMode = "quota" | "sales";

interface ParseError {
  sheet: string;
  sheetUrl: string;
  message: string;
  expectedHeaders: string[];
  actualHeaders: string[];
  timestamp: number;
}

export interface FilterState {
  timeframe: Timeframe;
  customRange?: { from: Date; to: Date };
  segment: string[];
  region: string[];
  group: string;
  slm: string[];
  flm: string[];
  rep: string[];
  products: string[];
  aggregateBy: AggregateBy;
  // Task #361: admin-only raw-field "Conditions". Each `{ field, value }` slices
  // the entire Pipeline by a raw opportunity field (AND, "is"/equals). Only sent
  // to the server for admins; non-admins never see the UI and the server ignores
  // the param regardless. Non-persisted (not part of saved default filters).
  rawConditions?: RawCondition[];
}

// Task #361: a single admin Condition row. `field` is one of RAW_CONDITION_FIELDS.
export interface RawCondition {
  field: string;
  value: string;
}

// Keys whose filter value is a string[] (multi-select set membership). Empty
// array == "All". The Dashboard exposes a single helper (`setMultiFilter`) that
// updates any of these from child views.
export type MultiFilterKey = "slm" | "flm" | "rep" | "region" | "segment";

const TABS = ["Pipeline", "Activity", "Actions", "Anaplan", "Sales Contests", "Comp", "Admin"] as const;

const AUTO_REFRESH_MS = 30 * 60 * 1000;
const API_BASE = import.meta.env.BASE_URL || "/";
// Task #428: align the pipeline query's client-side freshness window with the
// server-side computed-result cache (raw data lives ~30 min). With a long
// staleTime, toggling back to an already-loaded revenue mode is served from the
// client cache with no spinner; manual refresh still forces a refetch via
// queryClient.invalidateQueries (which overrides staleTime).
const PIPELINE_STALE_MS = 30 * 60 * 1000;

const DEFAULT_FILTERS_PREF_KEY = "dashboard.defaultFilters";
// Bumped to 2 when segment/region/flm/rep changed from string to string[] for
// multi-select. `hydrateFromSavedDefaults` accepts both shapes so v1 blobs
// still hydrate, but new saves write v2.
const DEFAULT_FILTERS_SCHEMA_VERSION = 2;

type SavedDefaultFilters = {
  version: number;
  timeframe: Timeframe;
  customRange?: { from: string; to: string };
  // segment/region/flm/rep are string[] in v2+. v1 saved them as a single
  // string ("All Segments" / a single name) — `hydrateFromSavedDefaults`
  // accepts either shape so older blobs still load.
  segment: string[];
  region: string[];
  slm: string[];
  flm: string[];
  rep: string[];
  products: string[];
  aggregateBy: AggregateBy;
  groupPreset: string;
  pipelineMode: PipelineMode;
  mrrMode: MrrMode;
  revenueMode: RevenueMode;
  subtractMods: boolean;
  modsStart: "monthStart" | "today";
  modsExtend: "none" | "plus30";
};

const VALID_TIMEFRAMES: Timeframe[] = ["mtd", "lastMonth", "custom", "allTime", "mtd2date", "eom", "thisWeek", "today"];
const VALID_AGGREGATE_BYS: AggregateBy[] = ["Rep", "FLM", "SLM", "Region", "Segment"];
const VALID_MRR_MODES: MrrMode[] = ["gnrNet", "acqNet"];

interface DashboardProps {
  realUser: AuthUser;
  allowImpersonate: boolean;
  authUser: AuthUser;
}

export default function Dashboard({ authUser, realUser, allowImpersonate }: DashboardProps) {
  const [isDark, setIsDark] = useState(false);
  const [activeTab, setActiveTab] = useState<typeof TABS[number]>("Pipeline");
  const [isSpinning, setIsSpinning] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [showCalendarPicker, setShowCalendarPicker] = useState(false);
  const [draftCustomRange, setDraftCustomRange] = useState<DateRange | undefined>(undefined);
  // Memoize so the Calendar's internal display state doesn't reset on
  // every Dashboard re-render (which previously caused the picker to
  // visually jump on each click).
  const calendarDisabled = useCallback((date: Date) => {
    const today = new Date();
    const twoMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 2, 1);
    return date < twoMonthsAgo;
  }, []);
  const calendarDefaultMonth = useMemo(
    () => new Date(new Date().getFullYear(), new Date().getMonth() - 1),
    [],
  );
  const [pipelineMode, setPipelineMode] = useState<PipelineMode>("closeDate");
  const [modsStart, setModsStart] = useState<"monthStart" | "today">("monthStart");
  const [modsExtend, setModsExtend] = useState<"none" | "plus30">("none");
  const [mrrMode, setMrrMode] = useState<MrrMode>("acqNet");
  // Task #241: Total Revenue (default) vs Compensable Revenue. Gated to
  // admin/SLM/exec; the backend also enforces the gate, so a non-privileged
  // value here is harmless. Persisted with the rest of "My Defaults".
  const [revenueMode, setRevenueMode] = useState<RevenueMode>("quota");
  const [subtractMods, setSubtractMods] = useState(false);
  // Task #484: "eReps Override" — when on, every rep's eRep multiplier is
  // treated as 1x in the displayed pipeline/quota/forecast goals. Always starts
  // OFF on each load (intentionally NOT persisted via saved defaults).
  const [eRepOverride, setERepOverride] = useState(false);
  const [prorateQuota, setProrateQuota] = useState(false);
  // Snapshot of the date filter taken the moment Prorate is turned ON, so we
  // can restore it when the user toggles Prorate OFF. Auto-snaps that fire
  // while Prorate is on do NOT update this snapshot.
  const prevDateFilterRef = useRef<{ timeframe: Timeframe; customRange?: { from: Date; to: Date } } | null>(null);
  const handleProrateQuotaChange = useCallback((next: boolean) => {
    setProrateQuota((prev) => {
      if (next === prev) return prev;
      if (next) {
        // OFF → ON: snapshot current date filter for later restore.
        prevDateFilterRef.current = {
          timeframe: filtersRef.current.timeframe,
          customRange: filtersRef.current.customRange,
        };
      } else {
        // ON → OFF: restore snapshot if we have one.
        const snap = prevDateFilterRef.current;
        prevDateFilterRef.current = null;
        if (snap) {
          setFilters((f) => ({ ...f, timeframe: snap.timeframe, customRange: snap.customRange }));
        }
      }
      return next;
    });
  }, []);
  // Task #162: Quota Mode toggle. "remaining" = max(0, monthly_goal − closed)
  // floored at the displayed aggregate (so overperformers fill team buckets).
  // "pacing" = monthly_goal × bizday_share (pure time-share, ignores closed,
  // no floor needed). Persisted per-browser; only meaningful when prorateQuota
  // is on. Default Remaining (matches the pre-toggle behavior conceptually).
  const [quotaMode, setQuotaModeState] = useState<"pacing" | "remaining">(() => {
    if (typeof window === "undefined") return "remaining";
    try {
      const v = localStorage.getItem("quota_mode");
      if (v === "pacing" || v === "remaining") return v;
    } catch {/* ignore */}
    return "remaining";
  });
  const setQuotaMode = useCallback((m: "pacing" | "remaining") => {
    setQuotaModeState(m);
    try { localStorage.setItem("quota_mode", m); } catch {/* ignore */}
  }, []);
  const { holidaySet, holidayNameMap, fetchError: holidayFetchError } = useUsHolidays();
  const [showExplainer, setShowExplainer] = useState(false);
  
  const [filters, setFilters] = useState<FilterState>({
    timeframe: "mtd",
    segment: [],
    region: [],
    group: "All Channels",
    slm: [],
    flm: [],
    rep: [],
    products: [],
    aggregateBy: "Rep" as AggregateBy
  });
  // Mirror of `filters` accessible from stable callbacks (e.g. handleProrateQuotaChange)
  // without forcing them to depend on `filters` and re-create on every change.
  const filtersRef = useRef<FilterState>(filters);
  useEffect(() => { filtersRef.current = filters; }, [filters]);
  // Task #183: Tracks the user's most recent timeframe selection from the
  // dropdown — does NOT change when the prorate snap effect rewrites
  // filters.timeframe to "custom". Used for the dropdown label, the
  // dropdown's selected-row highlight, and to tell PipelineView that the
  // user originally picked thisWeek (so the Goal-card calendar can
  // highlight all 7 days of the week even after the actuals window has
  // been snapped to today→weekEnd).
  const [displayTimeframe, setDisplayTimeframe] = useState<Timeframe>("mtd");
  // Date-lock: while Prorate is on, snap any violating date filter to the
  // canonical target for the active quota mode (Remaining → today→EOM /
  // today→EOW; Pacing → MTD / SOW→today). Runs whenever the filter, mode,
  // or prorate flag changes — so manual filter picks and mode flips are
  // both enforced. snapDateFilterForProrateMode returns null if no change
  // is needed, so this is a no-op once the filter is already valid.
  useEffect(() => {
    if (!prorateQuota) return;
    const snap = snapDateFilterForProrateMode(filters.timeframe, filters.customRange, quotaMode);
    if (!snap) return;
    setFilters((prev) => ({ ...prev, timeframe: snap.timeframe, customRange: snap.customRange }));
  }, [prorateQuota, quotaMode, filters.timeframe, filters.customRange]);
  // Task #183: When the user picks This Week or Today, auto-enable Prorate +
  // Remaining (the only sensible config for those short windows). When the
  // user picks Custom, auto-disable Prorate (custom ranges can't be
  // prorated). Driven by `displayTimeframe` (the user-picked value), not
  // `filters.timeframe` (which gets snapped to "custom" by the effect
  // above). The snap effect then aligns the actuals window.
  useEffect(() => {
    if (displayTimeframe === "thisWeek" || displayTimeframe === "today") {
      setProrateQuota((prev) => {
        if (!prev) {
          prevDateFilterRef.current = {
            timeframe: filtersRef.current.timeframe,
            customRange: filtersRef.current.customRange,
          };
        }
        return true;
      });
      setQuotaModeState((prev) => prev === "remaining" ? prev : "remaining");
      try { localStorage.setItem("quota_mode", "remaining"); } catch {/* ignore */}
    } else if (displayTimeframe === "custom") {
      setProrateQuota((prev) => {
        if (prev) {
          // Drop the snapshot — switching to custom is itself a deliberate
          // date-filter change, so there's nothing meaningful to restore.
          prevDateFilterRef.current = null;
        }
        return false;
      });
    } else if (displayTimeframe === "mtd" || displayTimeframe === "lastMonth") {
      // Picking This Month or Last Month covers the full month window, so
      // proration no longer makes sense — turn it off. Drop the snapshot
      // for the same reason as Custom: the user just made a deliberate
      // date-filter choice.
      //
      // We also force `filters.timeframe` back to the picked month and
      // clear any customRange, because the snap effect above runs while
      // prorateQuota is still true and may have just rewritten
      // filters.timeframe to "custom" with a partial (today→EOM) range.
      // Without this, the first click into the month view would query
      // actuals against the partial range and show $0 attainment.
      setProrateQuota((prev) => {
        if (prev) prevDateFilterRef.current = null;
        return false;
      });
      setFilters((f) =>
        f.timeframe === displayTimeframe && !f.customRange
          ? f
          : { ...f, timeframe: displayTimeframe, customRange: undefined }
      );
    }
  }, [displayTimeframe]);
  const [groupPreset, setGroupPreset] = useState<string>("Acquisitions");
  const [groupInitialized, setGroupInitialized] = useState(false);
  const prevTimeframeRef = useRef<{ timeframe: Timeframe; customRange?: { from: Date; to: Date } } | null>(null);
  // Tracks whether the user has actively changed any in-scope filter or
  // toggle since mount. If true, we skip silent hydration / role-based init
  // when the saved-defaults preference resolves later, so we don't clobber
  // their changes.
  const userInteractedRef = useRef(false);
  const markInteracted = useCallback(() => { userInteractedRef.current = true; }, []);

  // Task #168: determine if Remaining mode is unavailable for the current filter
  // (past-month or fully-past custom range) so the toggle can be grayed out.
  const remainingForcedPacing = useMemo(() => {
    if (!prorateQuota || quotaMode !== 'remaining') return false;
    if (filters.timeframe === 'lastMonth') return true;
    const range = getDateRange(filters.timeframe, filters.customRange);
    if (!range.from || !range.to) return false;
    const today = getTodayPST();
    const filterFrom = new Date(range.from + 'T00:00:00');
    const filterTo = new Date(range.to + 'T00:00:00');
    const elig = computeWindowedRemainingEligibility(filterFrom, filterTo, today, holidaySet);
    return elig.mode === 'fallback-to-pacing';
  }, [prorateQuota, quotaMode, filters.timeframe, filters.customRange, holidaySet]);

  const queryClient = useQueryClient();

  // Task #393: per-user data snapshot rollback. The selector lives in
  // localStorage; a global fetch interceptor (lib/snapshot) stamps it onto
  // every /api/sales request. Subscribe so the header label re-renders when
  // the captured-at timestamp arrives from the server.
  const [snapshotSelector, setSnapshotSelectorState] = useState<string>(() => getSnapshotSelector());
  const [snapshotCapturedAt, setSnapshotCapturedAt] = useState<string | null>(() => getSnapshotCapturedAt());
  const [snapshotList, setSnapshotList] = useState<{
    lastGoodRefresh: { capturedAt: string } | null;
    nightly: { date: string; capturedAt: string }[];
  }>({ lastGoodRefresh: null, nightly: [] });

  useEffect(() => {
    return subscribeSnapshot(() => {
      setSnapshotSelectorState(getSnapshotSelector());
      setSnapshotCapturedAt(getSnapshotCapturedAt());
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}api/sales/snapshots`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) {
          setSnapshotList({
            lastGoodRefresh: d.lastGoodRefresh ?? null,
            nightly: Array.isArray(d.nightly) ? d.nightly : [],
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const snapshotMode = snapshotSelector !== LIVE_SELECTOR;

  const handleSnapshotChange = useCallback(
    (selector: string) => {
      setSnapshotSelector(selector);
      setSnapshotSelectorState(selector);
      // Force every view to re-render from the newly selected data source.
      queryClient.invalidateQueries();
    },
    [queryClient],
  );

  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const spiffViewRef = useRef<SpiffViewRef>(null);
  const canManageContests = authUser.role === "flm" || authUser.role === "slm" || authUser.role === "exec" || authUser.role === "admin";
  // Task #363 / #540: the Comp tab (formerly "Executive") is read-only-visible
  // to every role. Write controls inside each section remain gated by their own
  // canEdit/viewOnly logic, and every mutation endpoint still rejects
  // non-admin/slm/exec users.
  const canSeeComp = true;
  // Task #533: the Anaplan tab is open to slm/exec/admin (Task #477's
  // temporary admin-only gate is lifted). Task #493: the Admin tab stays
  // admin-only. Every other tab stays visible to all roles.
  const canSeeAnaplan =
    authUser.role === "slm" || authUser.role === "exec" || authUser.role === "admin";
  const visibleTabs = useMemo(
    () =>
      TABS.filter(tab => {
        if (tab === "Anaplan") return canSeeAnaplan;
        if (tab === "Admin") return authUser.role === "admin";
        // Task #540: Sales Contests is on hold — hidden from everyone except
        // admins (UI-only; contest API permissions are unchanged).
        if (tab === "Sales Contests") return authUser.role === "admin";
        return true;
      }),
    [authUser.role, canSeeAnaplan],
  );
  // Task #477 / #493 / #533 / #540: if a user ever lands on a tab their role
  // can't see (e.g. via stale state), fall back to the default visible tab so
  // it can't render.
  useEffect(() => {
    if (
      (activeTab === "Anaplan" && !canSeeAnaplan) ||
      (activeTab === "Admin" && authUser.role !== "admin") ||
      (activeTab === "Sales Contests" && authUser.role !== "admin")
    ) {
      setActiveTab("Pipeline");
    }
  }, [activeTab, authUser.role, canSeeAnaplan]);
  const handleLogout = useCallback(() => {
    window.location.href = "/api/logout";
  }, []);
  const [isCompact, setIsCompact] = useState(false);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const filterPanelRef = useRef<HTMLDivElement>(null);
  const filterBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1439px)");
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      setIsCompact(e.matches);
      if (!e.matches) setFilterPanelOpen(false);
    };
    handler(mql);
    mql.addEventListener("change", handler as (e: MediaQueryListEvent) => void);
    return () => mql.removeEventListener("change", handler as (e: MediaQueryListEvent) => void);
  }, []);

  useEffect(() => {
    if (!filterPanelOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (filterPanelRef.current?.contains(target)) return;
      if (filterBtnRef.current?.contains(target)) return;
      if (target.closest("[data-radix-popper-content-wrapper]")) return;
      if (target.closest("[role='listbox']")) return;
      if (target.closest("[data-radix-select-viewport]")) return;
      setFilterPanelOpen(false);
    };
    const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setFilterPanelOpen(false); };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEsc);
    return () => { document.removeEventListener("mousedown", handleClick); document.removeEventListener("keydown", handleEsc); };
  }, [filterPanelOpen]);

  const SUBVIEW_TIMEFRAMES: Record<string, Timeframe> = {
    staleOpps: "lastMonth",
  };

  const handleActionsSubViewChange = useCallback((subView: string) => {
    const targetTf = SUBVIEW_TIMEFRAMES[subView];
    if (targetTf) {
      markInteracted();
      // Task #183: snapshot the user-picked displayTimeframe (pre-snap), not
      // the snapped filters.timeframe — otherwise returning from Actions
      // restores "custom" instead of e.g. "thisWeek".
      if (!prevTimeframeRef.current) {
        prevTimeframeRef.current = { timeframe: displayTimeframe, customRange: filters.customRange };
      }
      setDisplayTimeframe(targetTf);
      setFilters(prev => {
        if (prev.timeframe === targetTf) return prev;
        return { ...prev, timeframe: targetTf };
      });
    } else {
      if (prevTimeframeRef.current) {
        markInteracted();
        const saved = prevTimeframeRef.current;
        prevTimeframeRef.current = null;
        setDisplayTimeframe(saved.timeframe);
        setFilters(prev => ({ ...prev, timeframe: saved.timeframe, customRange: saved.customRange }));
      }
    }
  }, [markInteracted, displayTimeframe, filters.customRange]);

  const pipelineDateRange = useMemo(
    () => getDateRange(filters.timeframe, filters.customRange),
    [filters.timeframe, filters.customRange]
  );

  // Month (YYYY-MM) the selected date filter resolves to, derived the same way
  // the server's data paths do (monthFromFilter: prefer `from`, else `to`). The
  // config/selector lists are fetched for this month so per-month roster
  // reactivations surface in the dropdowns, re-fetching when the month changes.
  const configMonth = useMemo(() => {
    const src = pipelineDateRange.from || pipelineDateRange.to;
    return src ? src.slice(0, 7) : undefined;
  }, [pipelineDateRange.from, pipelineDateRange.to]);

  const configQuery = useGetSalesConfig(
    configMonth ? { month: configMonth } : undefined
  );
  const modsDateRange = useMemo(
    () => getModsDateRange(filters.timeframe, filters.customRange, modsStart, modsExtend),
    [filters.timeframe, filters.customRange, modsStart, modsExtend]
  );
  // Task #361: serialized admin Conditions, sent only for admins and only when
  // there is at least one complete `{ field, value }` pair. Empty string for
  // everyone else so the query key and request stay unchanged.
  const rawConditionsParam = useMemo(() => {
    if (authUser.role !== "admin") return "";
    const valid = (filters.rawConditions ?? []).filter(
      (c) => c.field && c.value.trim() !== "",
    );
    return valid.length > 0 ? JSON.stringify(valid) : "";
  }, [authUser.role, filters.rawConditions]);

  // Task #428: build the queryKey + queryFn for a given revenue mode so the same
  // definition can drive both the active query and a background prefetch of the
  // sibling mode (making the first toggle instant on the client too).
  const buildPipelineQuery = useCallback(
    (mode: "quota" | "sales") => ({
      queryKey: [
        "/api/sales/pipeline",
        pipelineDateRange,
        pipelineMode,
        mode,
        modsDateRange.from,
        modsDateRange.to,
        rawConditionsParam,
        // Task #484: part of the key so toggling eReps Override refetches (and
        // never serves the standard cached payload) and so the sibling-mode
        // prefetch below stays scoped to the active override state.
        eRepOverride,
      ] as const,
      queryFn: async () => {
        const params = new URLSearchParams();
        if (pipelineDateRange.from) params.set("from", pipelineDateRange.from);
        if (pipelineDateRange.to) params.set("to", pipelineDateRange.to);
        if (pipelineMode !== "closeDate") params.set("pipelineMode", pipelineMode);
        if (mode !== "quota") params.set("revenueMode", mode);
        if (modsDateRange.from) params.set("modsFrom", modsDateRange.from);
        if (modsDateRange.to) params.set("modsTo", modsDateRange.to);
        if (rawConditionsParam) params.set("rawConditions", rawConditionsParam);
        if (eRepOverride) params.set("eRepOverride", "1");
        const qs = params.toString();
        const url = `${API_BASE}api/sales/pipeline${qs ? `?${qs}` : ""}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error("Pipeline fetch failed");
        return res.json() as Promise<PipelineData>;
      },
    }),
    [pipelineDateRange, pipelineMode, modsDateRange.from, modsDateRange.to, rawConditionsParam, eRepOverride],
  );

  const pipelineQuery = useQuery<PipelineData>({
    ...buildPipelineQuery(revenueMode),
    staleTime: PIPELINE_STALE_MS,
    gcTime: PIPELINE_STALE_MS * 2,
  });

  // Once the active mode has loaded, warm the sibling revenue mode into the
  // client cache so flipping the toggle is instant (no spinner). The server
  // already warms its own sibling result, so this prefetch is typically a fast
  // cache hit. Skipped in snapshot mode.
  useEffect(() => {
    if (snapshotMode) return;
    if (!pipelineQuery.data) return;
    const sibling: "quota" | "sales" = revenueMode === "sales" ? "quota" : "sales";
    queryClient.prefetchQuery({
      ...buildPipelineQuery(sibling),
      staleTime: PIPELINE_STALE_MS,
      gcTime: PIPELINE_STALE_MS * 2,
    });
  }, [revenueMode, buildPipelineQuery, queryClient, snapshotMode, pipelineQuery.data]);

  const activityQuery = useGetSalesActivity();
  const actionsQuery = useGetSalesActions();
  // Anaplan reconciliation is expensive (full comp-engine run) and only used by
  // its own tab, so gate the fetch on the tab being active. Follows the same
  // close-date window the rest of the dashboard uses to pick the month.
  const anaplanParams = {
    ...(pipelineDateRange.from ? { from: pipelineDateRange.from } : {}),
    ...(pipelineDateRange.to ? { to: pipelineDateRange.to } : {}),
    ...(rawConditionsParam ? { rawConditions: rawConditionsParam } : {}),
  };
  const anaplanQuery = useGetSalesAnaplan(anaplanParams, {
    query: {
      queryKey: getGetSalesAnaplanQueryKey(anaplanParams),
      enabled: activeTab === "Anaplan",
      staleTime: PIPELINE_STALE_MS,
    },
  });

  // Opp-less Anaplan CPDs (no found opportunity) carry server-derived fallback
  // dimensions so the header filters can still narrow them. When a fallback
  // dimension can't be resolved it becomes the literal "None", so surface
  // "None" as a selectable value in the affected header filters (only while the
  // Anaplan tab is active) so those CPDs stay findable. Product falls back to
  // "No Product Selected" (never "None"), so that chip is surfaced instead.
  const anaplanFallbackFlags = useMemo(() => {
    const flags = {
      slm: false,
      flm: false,
      rep: false,
      region: false,
      noProduct: false,
    };
    if (activeTab !== "Anaplan") return flags;
    for (const r of anaplanQuery.data?.rows ?? []) {
      if (r.opps.some((o) => o.found)) continue; // only opp-less CPDs
      const fb = r.fallbackDims;
      if (fb.slm === "None") flags.slm = true;
      if (fb.flm === "None") flags.flm = true;
      if (fb.rep === "None") flags.rep = true;
      if (fb.region === "None") flags.region = true;
      if (fb.product === "No Product Selected") flags.noProduct = true;
    }
    return flags;
  }, [activeTab, anaplanQuery.data]);

  const loading = configQuery.isLoading || configQuery.isFetching || 
                  pipelineQuery.isLoading || pipelineQuery.isFetching ||
                  activityQuery.isLoading || activityQuery.isFetching ||
                  actionsQuery.isLoading || actionsQuery.isFetching;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  useEffect(() => {
    if (loading) {
      setIsSpinning(true);
      return undefined;
    }
    const t = setTimeout(() => setIsSpinning(false), 600);
    return () => clearTimeout(t);
  }, [loading]);

  const handleRefresh = useCallback(async () => {
    // Task #393: refresh is disabled while viewing a historical snapshot.
    if (snapshotMode) return;
    try {
      await fetch(`${API_BASE}api/sales/refresh`, { method: "POST" });
    } catch {}
    queryClient.invalidateQueries();
  }, [queryClient, snapshotMode]);

  useEffect(() => {
    autoRefreshRef.current = setInterval(() => {
      handleRefresh();
    }, AUTO_REFRESH_MS);
    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    };
  }, [handleRefresh]);

  const [hasActiveContests, setHasActiveContests] = useState(false);
  const [contestStrobeType, setContestStrobeType] = useState<"flm" | "admin" | null>(null);
  const moneyCursorRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!hasActiveContests) return;
    const el = moneyCursorRef.current;
    if (!el) return;
    let frame = 0;
    const iv = setInterval(() => {
      frame = (frame + 1) % 2;
      el.classList.toggle("money-cursor-up", frame === 0);
      el.classList.toggle("money-cursor-down", frame === 1);
    }, 180);
    el.classList.add("money-cursor-up");
    return () => { clearInterval(iv); el.classList.remove("money-cursor-up", "money-cursor-down"); };
  }, [hasActiveContests]);

  useEffect(() => {
    const checkContests = async () => {
      try {
        const res = await fetch(`${API_BASE}api/sales/contests`);
        const d = await res.json();
        if (d.contests) {
          const now = new Date();
          interface ContestSummary { status: string; endDate: string; startDate: string; createdByRole: string }
          const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
          const active = d.contests.filter((c: ContestSummary) => {
            if (c.status !== "active") return false;
            return todayStr >= c.startDate && todayStr <= c.endDate;
          });
          setHasActiveContests(active.length > 0);
          if (active.length > 0) {
            const hasAdminCreated = active.some((c: ContestSummary) => c.createdByRole === "admin" || c.createdByRole === "slm" || c.createdByRole === "exec");
            setContestStrobeType(hasAdminCreated ? "admin" : "flm");
          } else {
            setContestStrobeType(null);
          }
        }
      } catch {}
    };
    checkContests();
    const interval = setInterval(checkContests, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const [lastSheetCsv, setLastSheetCsv] = useState<string | null>(null);
  const [lastSheetUrl, setLastSheetUrl] = useState<string | null>(null);

  const handleSheetDataLoaded = (csv: string, sheetUrl: string) => {
    setLastSheetCsv(csv);
    setLastSheetUrl(sheetUrl);
  };

  const config = configQuery.data;

  // Demo-mode product display labels: register the server-provided map
  // before any child renders product names/abbreviations. Idempotent and a
  // no-op outside DEMO_MODE (the field is absent → passthrough labels).
  registerProductLabels((config as { demoProductLabels?: Record<string, { name: string; abbrev: string }> } | undefined)?.demoProductLabels);

  const slmOptions = useMemo(() => {
    if (!config?.org) return [];
    const active: string[] = [];
    const inactive: string[] = [];
    for (const slm of Object.keys(config.org)) {
      const flmGroup = config.org[slm];
      const hasAssigned = Object.keys(flmGroup).length > 0 &&
        Object.values(flmGroup).some(reps => reps.length > 0);
      if (hasAssigned) active.push(slm);
      else inactive.push(slm);
    }
    return [...active.sort(), ...inactive.sort()];
  }, [config]);

  const inactiveSlms = useMemo(() => {
    if (!config?.org) return new Set<string>();
    const set = new Set<string>();
    for (const slm of Object.keys(config.org)) {
      const flmGroup = config.org[slm];
      const hasAssigned = Object.keys(flmGroup).length > 0 &&
        Object.values(flmGroup).some(reps => reps.length > 0);
      if (!hasAssigned) set.add(slm);
    }
    return set;
  }, [config]);

  // Data-driven Acquisitions SLM set from the backend (derived from each
  // rep's channel group) — no hardcoded names, so it works in the anonymized
  // public demo too.
  const ACQ_SLMS = useMemo(() => new Set(config?.acqSlms ?? []), [config]);

  const myTeamLocation = useMemo<{ slm: string[]; flm: string[]; rep: string[] } | null>(() => {
    const org = config?.org;
    const name = authUser.hierarchyName;
    const role = authUser.role;
    if (!org || !name || !role) return null;
    if (role === "slm") {
      if (org[name]) return { slm: [name], flm: [], rep: [] };
      return null;
    }
    if (role === "flm") {
      for (const slmName of Object.keys(org)) {
        if (org[slmName]?.[name]) {
          return { slm: [slmName], flm: [name], rep: [] };
        }
      }
      return null;
    }
    if (role === "rep") {
      for (const slmName of Object.keys(org)) {
        const flms = org[slmName] || {};
        for (const flmName of Object.keys(flms)) {
          if (flms[flmName]?.includes(name)) {
            return { slm: [slmName], flm: [flmName], rep: [] };
          }
        }
      }
      return null;
    }
    return null;
  }, [config, authUser.hierarchyName, authUser.role]);

  const myLocation = useMemo(() => {
    if (authUser.role !== "rep") return null;
    if (!myTeamLocation || !authUser.hierarchyName) return null;
    return { ...myTeamLocation, rep: [authUser.hierarchyName] };
  }, [authUser.role, authUser.hierarchyName, myTeamLocation]);

  // Derive the group-allowed SLM set from the active group preset.
  // Returns `null` to indicate "no scoping" (i.e. every SLM is allowed).
  const groupAllowedSlms = useMemo<Set<string> | null>(() => {
    if (!config?.org) return null;
    const allSlms = Object.keys(config.org);
    if (groupPreset === "Acquisitions") {
      return new Set(allSlms.filter(s => ACQ_SLMS.has(s)));
    }
    if (groupPreset === "G&R") {
      return new Set(allSlms.filter(s => !ACQ_SLMS.has(s)));
    }
    if (groupPreset === "My Team" || groupPreset === "Me") {
      const userSlm = myTeamLocation?.slm[0];
      if (!userSlm) return null;
      const userIsAcq = ACQ_SLMS.has(userSlm);
      return new Set(allSlms.filter(s => ACQ_SLMS.has(s) === userIsAcq));
    }
    // On Demand reps belong to no real SLM, so no SLM option is selectable.
    if (groupPreset === "On Demand") return new Set();
    return null;
  }, [config, groupPreset, ACQ_SLMS, myTeamLocation]);

  // SLM dropdown options scoped to the active group. The unscoped
  // `slmOptions` is still used for `applyGroupPreset` so that group
  // transitions can pick the new group's SLMs from the full org.
  const scopedSlmOptions = useMemo(() => {
    const base = !groupAllowedSlms
      ? slmOptions
      : slmOptions.filter(s => groupAllowedSlms.has(s));
    if (anaplanFallbackFlags.slm && !base.includes("None")) return [...base, "None"];
    return base;
  }, [slmOptions, groupAllowedSlms, anaplanFallbackFlags.slm]);

  // Task #560: "All SLMs" (empty SLM selection) must mean "every SLM in the
  // active channel", not "the whole org". When the selection is empty and the
  // active group preset restricts SLMs (Acquisitions / G&R / My Team / Me),
  // resolve it to the full channel-allowed SLM set for every data consumer
  // (views, drilldowns, exports, modal fetches). The raw `filters` state keeps
  // the empty array so the dropdown still reads "All SLMs" and the select-all
  // sentinel semantics are unchanged. All Channels (null) keeps today's
  // org-wide behavior; On Demand (empty set — scoped by its group tag, its
  // reps belong to no real SLM) also stays as-is.
  const effectiveFilters = useMemo<FilterState>(() => {
    if (filters.slm.length > 0) return filters;
    if (!groupAllowedSlms || groupAllowedSlms.size === 0) return filters;
    const slm = Array.from(groupAllowedSlms).sort();
    // Mirror scopedSlmOptions: while the Anaplan tab surfaces the "None"
    // fallback option, "All SLMs" must keep opp-less CPD fallback rows visible.
    if (anaplanFallbackFlags.slm) slm.push("None");
    return { ...filters, slm };
  }, [filters, groupAllowedSlms, anaplanFallbackFlags.slm]);

  const flmOptions = useMemo(() => {
    if (!config?.org) return [];
    // Append "None" when an opp-less Anaplan CPD resolves to a None FLM.
    const withNone = (opts: string[]): string[] =>
      anaplanFallbackFlags.flm && !opts.includes("None")
        ? [...opts, "None"]
        : opts;
    if (filters.slm.length > 0) {
      const all = new Set<string>();
      for (const s of filters.slm) {
        if (config.org[s]) {
          Object.keys(config.org[s]).forEach(flm => all.add(flm));
        }
      }
      return withNone(Array.from(all).sort());
    }
    const all = new Set<string>();
    const slmsToScan = groupAllowedSlms
      ? Object.keys(config.org).filter(s => groupAllowedSlms.has(s))
      : Object.keys(config.org);
    for (const s of slmsToScan) {
      const flmGroup = config.org[s];
      if (flmGroup) Object.keys(flmGroup).forEach(flm => all.add(flm));
    }
    return withNone(Array.from(all).sort());
  }, [config, filters.slm, groupAllowedSlms, anaplanFallbackFlags.flm]);

  const availableProducts = useMemo(() => {
    // The canonical products always appear (in this fixed order) so the filter
    // is usable even for a month/scope with no opps yet. Any product detected
    // in the data that isn't canonical is appended after them.
    const CANONICAL_PRODUCTS = ["Showcase", "MBP", "Zillow Pro", "Follow Up Boss", "ZMX"];
    // Showcase sub-parts (independently filterable) are pinned in too — like the
    // canonical products — so they don't silently drop out of the filter in any
    // month/scope that currently has no opps for them. Overage opps in particular
    // only close at month-end, so a mid-month (MTD) close-date window has none yet,
    // which previously made the Overage chip disappear.
    const SHOWCASE_PARTS = ["Showcase Incremental", "Showcase Incremental - Re/Max", "Overage"];
    const reps = pipelineQuery.data?.reps;
    const detected = new Set<string>();
    let hasUnmappedMods = false;
    for (const r of reps ?? []) {
      const pf = r.productFunnel as Record<string, Record<string, number>> | undefined;
      if (pf) {
        for (const prod of Object.keys(pf)) {
          if (prod) detected.add(prod);
        }
      }
      const pm = (r as any).productMods as Record<string, number> | undefined;
      if (pm) {
        for (const [prod, val] of Object.entries(pm)) {
          if (!prod) continue;
          if (prod === "No Product Selected") {
            if ((val || 0) > 0) hasUnmappedMods = true;
          } else if ((val || 0) > 0) {
            detected.add(prod);
          }
        }
      }
    }
    // Hard-coded canonical + Showcase parts first, then any newly-detected
    // (config + data) products not already pinned, then "No Product Selected".
    const canonicalSet = new Set([...CANONICAL_PRODUCTS, ...SHOWCASE_PARTS]);
    const extras = new Set<string>();
    for (const p of config?.products ?? []) {
      if (p && !canonicalSet.has(p)) extras.add(p);
    }
    for (const p of detected) {
      if (!canonicalSet.has(p)) extras.add(p);
    }
    extras.delete("No Product Selected");
    // Inbound rows (Actions view) with a blank/unknown "Product of Interest"
    // map to "No Product Selected", so surface that chip when such rows exist.
    let hasNoProductInbounds = false;
    for (const item of actionsQuery.data?.inboundItems ?? []) {
      if (mapInboundProduct((item as any).productOfInterest) === "No Product Selected") {
        hasNoProductInbounds = true;
        break;
      }
    }
    // Pin the Showcase sub-parts right after their parent "Showcase".
    const pinned: string[] = [];
    for (const p of CANONICAL_PRODUCTS) {
      pinned.push(p);
      if (p === "Showcase") pinned.push(...SHOWCASE_PARTS);
    }
    const result = [...pinned, ...[...extras].sort()];
    // Opp-less Anaplan CPDs fall back to the "No Product Selected" product, so
    // surface that chip on the Anaplan tab too even when no mods/inbounds need it.
    if (hasUnmappedMods || hasNoProductInbounds || anaplanFallbackFlags.noProduct)
      result.push("No Product Selected");
    return result;
  }, [pipelineQuery.data, config, actionsQuery.data, anaplanFallbackFlags.noProduct]);

  const segmentOptions = useMemo(() => {
    if (!config?.segments) return [];
    return config.segments.sort();
  }, [config]);

  const regionOptions = useMemo(() => {
    if (!config?.regions) return [];
    const base = config.regions.sort();
    // Append "None" when an opp-less Anaplan CPD resolves to a None region.
    if (anaplanFallbackFlags.region && !base.includes("None"))
      return [...base, "None"];
    return base;
  }, [config, anaplanFallbackFlags.region]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.slm.length > 0) count++;
    if (filters.flm.length > 0) count++;
    if (filters.rep.length > 0) count++;
    if (filters.region.length > 0) count++;
    if (filters.segment.length > 0) count++;
    if (filters.products.length > 0) count++;
    if (filters.aggregateBy !== "Rep") count++;
    return count;
  }, [filters]);

  const groupOptions = useMemo(() => {
    if (!config?.groups) return [];
    return config.groups.sort();
  }, [config]);

  const repOptions = useMemo(() => {
    if (!config?.org) return [];
    // Append "None" when an opp-less Anaplan CPD resolves to a None rep (its
    // owner field is blank), so those CPDs stay findable via the Rep filter.
    const withNone = (opts: string[]): string[] =>
      anaplanFallbackFlags.rep && !opts.includes("None")
        ? [...opts, "None"]
        : opts;
    // On Demand reps are synthetic and live outside config.org, so the SLM/FLM
    // narrowing below can never surface them. List them directly for the preset.
    if (groupPreset === "On Demand") return withNone([...ON_DEMAND_REPS]);
    // Narrow rep options to selected FLMs first (a rep belongs to a single
    // FLM, so listing every rep that lives under any selected FLM is the
    // correct union for multi-select).
    if (filters.flm.length > 0) {
      const selectedFlms = new Set(filters.flm);
      const reps = new Set<string>();
      for (const slmGroup of Object.values(config.org)) {
        for (const flmName of Object.keys(slmGroup)) {
          if (selectedFlms.has(flmName)) {
            (slmGroup[flmName] || []).forEach(r => reps.add(r));
          }
        }
      }
      return withNone(Array.from(reps).sort());
    }
    if (filters.slm.length > 0) {
      const allReps = new Set<string>();
      for (const s of filters.slm) {
        if (config.org[s]) {
          Object.values(config.org[s]).forEach(reps => {
            reps.forEach(r => allReps.add(r));
          });
        }
      }
      return withNone(Array.from(allReps).sort());
    }
    const all = new Set<string>();
    const slmsToScan = groupAllowedSlms
      ? Object.keys(config.org).filter(s => groupAllowedSlms.has(s))
      : Object.keys(config.org);
    for (const s of slmsToScan) {
      const flmGroup = config.org[s];
      if (!flmGroup) continue;
      Object.values(flmGroup).forEach(reps => {
        reps.forEach(r => all.add(r));
      });
    }
    return withNone(Array.from(all).sort());
  }, [config, filters.slm, filters.flm, groupAllowedSlms, groupPreset, anaplanFallbackFlags.rep]);

  // setFilter is for primitive (string) filter keys only — `timeframe`,
  // `aggregateBy`, `group`. Array-valued filters (slm/flm/rep/region/segment/
  // products) go through `setMultiFilter` / `setSlmFilter` / `setProductsUI`.
  const setFilter = (key: keyof FilterState, value: string) => {
    markInteracted();
    if (key === "timeframe") setDisplayTimeframe(value as Timeframe);
    setFilters(prev => ({ ...prev, [key]: value }));
  };

  // Multi-select filter setter for flm/rep/region/segment. When the FLM
  // selection changes we clear `rep` (mirrors the original cascade) so the
  // rep array can't reference reps that are no longer in scope.
  const setMultiFilter = useCallback((key: MultiFilterKey, value: string[]) => {
    markInteracted();
    setFilters(prev => {
      if (key === "slm") {
        return { ...prev, slm: value, flm: [], rep: [] };
      }
      const next = { ...prev, [key]: value };
      if (key === "flm") next.rep = [];
      return next;
    });
  }, [markInteracted]);

  const applyGroupPreset = useCallback((preset: string, allSlms: string[]) => {
    setGroupInitialized(true);
    setGroupPreset(preset);
    if (preset === "Acquisitions") {
      const acqSlms = allSlms.filter(s => ACQ_SLMS.has(s));
      setFilters(prev => ({ ...prev, group: "All Channels", slm: acqSlms, flm: [], rep: [] }));
      setMrrMode("acqNet");
    } else if (preset === "G&R") {
      const gnrSlms = allSlms.filter(s => !ACQ_SLMS.has(s));
      setFilters(prev => ({ ...prev, group: "All Channels", slm: gnrSlms, flm: [], rep: [] }));
      setMrrMode("gnrNet");
    } else if (preset === "My Team" && myTeamLocation) {
      setFilters(prev => ({ ...prev, group: "All Channels", ...myTeamLocation }));
      // Match MRR mode to the user's group: ACQ SLMs → acqNet; G&R SLMs → gnrNet.
      const userSlm = myTeamLocation.slm[0];
      setMrrMode(userSlm && ACQ_SLMS.has(userSlm) ? "acqNet" : "gnrNet");
    } else if (preset === "Me" && myLocation) {
      setFilters(prev => ({ ...prev, group: "All Channels", ...myLocation }));
      const userSlm = myLocation.slm[0];
      setMrrMode(userSlm && ACQ_SLMS.has(userSlm) ? "acqNet" : "gnrNet");
    } else if (preset === "On Demand") {
      // Synthetic third channel: scope by its group tag (its reps belong to no
      // real SLM, so an SLM list can't select them). G&R-style net (added − |churn|).
      setFilters(prev => ({ ...prev, group: "On Demand", slm: [], flm: [], rep: [] }));
      setMrrMode("gnrNet");
    } else {
      // All Channels = every real channel. Exclusion of the synthetic On Demand
      // channel is enforced by passesChannelFilter at every view's group filter,
      // so it holds regardless of SLM state (empty list, saved defaults, etc.).
      setFilters(prev => ({ ...prev, group: "All Channels", slm: [], flm: [], rep: [] }));
    }
  }, [ACQ_SLMS, myTeamLocation, myLocation]);

  const defaultsPref = useUserPreference<SavedDefaultFilters>(DEFAULT_FILTERS_PREF_KEY);
  const hasSavedDefaults = defaultsPref.value != null;

  const hydrateFromSavedDefaults = useCallback((saved: SavedDefaultFilters) => {
    if (!config?.org) return;
    const allSlms = Object.keys(config.org);
    const validSlms = (Array.isArray(saved.slm) ? saved.slm : []).filter(s => allSlms.includes(s));

    // Accept either v2 string[] or v1 legacy string ("All FLMs" / single name).
    // Empty / "All …" sentinel → empty array. Unknown names are dropped.
    const coerceToArray = (raw: unknown, allSentinel: string): string[] => {
      if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
      if (typeof raw === "string" && raw !== allSentinel && raw !== "") return [raw];
      return [];
    };

    const candidateFlms = coerceToArray(saved.flm, "All FLMs");
    let validFlms: string[] = [];
    if (candidateFlms.length > 0) {
      const flmsForSlms = new Set<string>();
      const slmsToCheck = validSlms.length > 0 ? validSlms : allSlms;
      for (const s of slmsToCheck) {
        Object.keys(config.org[s] || {}).forEach(f => flmsForSlms.add(f));
      }
      validFlms = candidateFlms.filter(f => flmsForSlms.has(f));
    }

    const candidateReps = coerceToArray(saved.rep, "All Reps");
    let validReps: string[] = [];
    if (candidateReps.length > 0) {
      const repsForScope = new Set<string>();
      if (validFlms.length > 0) {
        const selectedFlms = new Set(validFlms);
        for (const slmGroup of Object.values(config.org)) {
          for (const flmName of Object.keys(slmGroup)) {
            if (selectedFlms.has(flmName)) {
              (slmGroup[flmName] || []).forEach(r => repsForScope.add(r));
            }
          }
        }
      } else {
        const slmsToCheck = validSlms.length > 0 ? validSlms : allSlms;
        for (const s of slmsToCheck) {
          Object.values(config.org[s] || {}).forEach(reps => reps.forEach(r => repsForScope.add(r)));
        }
      }
      validReps = candidateReps.filter(r => repsForScope.has(r));
    }

    const segOpts = config.segments || [];
    const candidateSegments = coerceToArray(saved.segment, "All Segments");
    const validSegments = candidateSegments.filter(s => segOpts.includes(s));

    const regOpts = config.regions || [];
    const candidateRegions = coerceToArray(saved.region, "All Regions");
    const validRegions = candidateRegions.filter(r => regOpts.includes(r));

    const prodOpts = config.products || [];
    const validProducts = (Array.isArray(saved.products) ? saved.products : []).filter(p => prodOpts.includes(p));

    // Task #183: legacy values eom/mtd2date are no longer offered in the
    // dropdown — collapse them to "mtd" on hydrate so the label/highlight
    // resolve to a supported preset.
    const rawTimeframe: Timeframe = VALID_TIMEFRAMES.includes(saved.timeframe) ? saved.timeframe : "mtd";
    const validTimeframe: Timeframe = (rawTimeframe === "eom" || rawTimeframe === "mtd2date") ? "mtd" : rawTimeframe;

    let validCustomRange: { from: Date; to: Date } | undefined;
    if (validTimeframe === "custom" && saved.customRange) {
      const from = new Date(saved.customRange.from);
      const to = new Date(saved.customRange.to);
      if (!isNaN(from.getTime()) && !isNaN(to.getTime())) {
        validCustomRange = { from, to };
      }
    }

    const validAggregateBy: AggregateBy = VALID_AGGREGATE_BYS.includes(saved.aggregateBy)
      ? saved.aggregateBy : "Rep";

    const validMrrMode: MrrMode = saved.mrrMode === "added" ? "gnrNet" : VALID_MRR_MODES.includes(saved.mrrMode) ? saved.mrrMode : "acqNet";
    // Task #254: Revenue Mode is open to all authenticated users, so a saved
    // Quota Target Revenue is the default; only an explicit "sales" preference
    // restores Sales Target Revenue (legacy "total"/"compensable" values fall
    // back to the new "quota" default).
    const validRevenueMode: RevenueMode = saved.revenueMode === "sales" ? "sales" : "quota";
    const validPipelineMode: PipelineMode = saved.pipelineMode === "allOpen" ? "allOpen" : "closeDate";
    const validModsStart: "monthStart" | "today" = saved.modsStart === "today" ? "today" : "monthStart";
    const validModsExtend: "none" | "plus30" = saved.modsExtend === "plus30" ? "plus30" : "none";

    const allowedPresets = new Set<string>(["Acquisitions", "G&R", "On Demand", "All Channels"]);
    // Viewers (Zillow employees not in the sales hierarchy) never get Me /
    // My Team — they have no place in the org tree, so any saved value other
    // than the three org-wide presets falls back to Acquisitions.
    const isViewer = authUser.role === "viewer";
    if (!isViewer && myTeamLocation) allowedPresets.add("My Team");
    if (!isViewer && myLocation) allowedPresets.add("Me");
    // Backward-compat: the "all channels" sentinel was previously persisted as
    // "All Groups". Normalize legacy saved values so existing users keep their
    // intended scope instead of silently falling back to Acquisitions.
    const savedGroupPreset = saved.groupPreset === "All Groups" ? "All Channels" : saved.groupPreset;
    const validGroupPreset = typeof savedGroupPreset === "string" && allowedPresets.has(savedGroupPreset)
      ? savedGroupPreset : "Acquisitions";

    setGroupInitialized(true);
    setGroupPreset(validGroupPreset);
    setPipelineMode(validPipelineMode);
    setMrrMode(validMrrMode);
    setRevenueMode(validRevenueMode);
    setSubtractMods(!!saved.subtractMods);
    setModsStart(validModsStart);
    setModsExtend(validModsExtend);
    setDisplayTimeframe(validTimeframe);
    setFilters(prev => ({
      ...prev,
      // Restore channel semantics from the saved preset. Only "On Demand"
      // scopes by its group tag; every other preset (Acquisitions/G&R/My
      // Team/Me/All Channels) runs under "All Channels" and narrows via the
      // SLM/FLM/Rep sets, so On Demand stays excluded via passesChannelFilter.
      group: validGroupPreset === "On Demand" ? "On Demand" : "All Channels",
      timeframe: validTimeframe,
      customRange: validCustomRange,
      segment: validSegments,
      region: validRegions,
      slm: validSlms,
      flm: validFlms,
      rep: validReps,
      products: validProducts,
      aggregateBy: validAggregateBy,
    }));
  }, [config, myTeamLocation, myLocation]);

  useEffect(() => {
    if (groupInitialized) return;
    if (!config?.org || slmOptions.length === 0) return;
    // Wait for the saved-defaults preference to resolve before deciding how
    // to initialize. If it errored, treat it as "no saved defaults" and fall
    // through to the role-based init.
    if (defaultsPref.isLoading && !defaultsPref.error) return;

    // If the user already changed any in-scope filter or toggle while the
    // preference was loading, respect their choices: don't hydrate from saved
    // defaults and don't run the role-based init. Just mark init done so this
    // effect stops firing.
    if (userInteractedRef.current) {
      setGroupInitialized(true);
      return;
    }

    const saved = defaultsPref.value;
    // Accept v1 (string flm/rep/region/segment) and v2 (string[]) — the
    // hydrator coerces either shape into the canonical array form.
    if (saved && typeof saved === "object" && (saved.version === 1 || saved.version === DEFAULT_FILTERS_SCHEMA_VERSION)) {
      hydrateFromSavedDefaults(saved);
      return;
    }

    setGroupInitialized(true);
    const role = authUser.role;
    const wantsMyTeam = role === "rep" || role === "flm" || role === "slm";
    if (role === "slm") {
      setFilters(prev => ({ ...prev, aggregateBy: "FLM" as AggregateBy }));
    }
    if (wantsMyTeam && myTeamLocation) {
      applyGroupPreset("My Team", slmOptions);
    } else {
      applyGroupPreset("Acquisitions", slmOptions);
    }
  }, [config, slmOptions, groupInitialized, applyGroupPreset, authUser.role, myTeamLocation, defaultsPref.isLoading, defaultsPref.error, defaultsPref.value, hydrateFromSavedDefaults]);

  const saveDefaults = useCallback(async () => {
    const blob: SavedDefaultFilters = {
      version: DEFAULT_FILTERS_SCHEMA_VERSION,
      // Task #183: persist the user-picked timeframe (pre-snap), not the
      // snapped filters.timeframe. Otherwise picking "This Week" with
      // prorate-on would persist as "custom" and reload as Custom (which
      // also auto-disables proration).
      timeframe: displayTimeframe,
      customRange: (displayTimeframe === "custom" && filters.customRange) ? {
        from: filters.customRange.from.toISOString(),
        to: filters.customRange.to.toISOString(),
      } : undefined,
      segment: filters.segment,
      region: filters.region,
      slm: filters.slm,
      flm: filters.flm,
      rep: filters.rep,
      products: filters.products,
      aggregateBy: filters.aggregateBy,
      groupPreset,
      pipelineMode,
      mrrMode,
      revenueMode,
      subtractMods,
      modsStart,
      modsExtend,
    };
    try {
      await defaultsPref.setValue(blob);
      toast({
        title: "Defaults saved",
        description: "This view will load by default next time.",
      });
    } catch (e) {
      toast({
        title: "Couldn't save defaults",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    }
  }, [filters, groupPreset, pipelineMode, mrrMode, revenueMode, subtractMods, modsStart, modsExtend, defaultsPref, displayTimeframe]);

  const resetDefaults = useCallback(async () => {
    try {
      await defaultsPref.removeValue();
      toast({
        title: "Defaults cleared",
        description: "The dashboard will use built-in defaults next time.",
      });
    } catch (e) {
      toast({
        title: "Couldn't clear defaults",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    }
  }, [defaultsPref]);

  const setSlmFilter = (value: string[]) => {
    markInteracted();
    setFilters(prev => ({
      ...prev,
      slm: value,
      flm: [],
      rep: [],
    }));
  };

  // Wrappers for in-scope toggles that mark user-interaction so they aren't
  // overwritten if the saved-defaults preference resolves later.
  const setMrrModeUI = useCallback((m: MrrMode) => { markInteracted(); setMrrMode(m); }, [markInteracted]);
  const setRevenueModeUI = useCallback((m: RevenueMode) => { markInteracted(); setRevenueMode(m); }, [markInteracted]);
  const setPipelineModeUI = useCallback((m: PipelineMode) => { markInteracted(); setPipelineMode(m); }, [markInteracted]);
  const setSubtractModsUI = useCallback((v: boolean) => { markInteracted(); setSubtractMods(v); }, [markInteracted]);
  const setModsStartUI = useCallback((v: "monthStart" | "today") => { markInteracted(); setModsStart(v); }, [markInteracted]);
  const setModsExtendUI = useCallback((v: "none" | "plus30") => { markInteracted(); setModsExtend(v); }, [markInteracted]);
  const setProductsUI = useCallback((v: string[]) => { markInteracted(); setFilters(prev => ({ ...prev, products: v })); }, [markInteracted]);
  // Task #361: admin-only raw Conditions setter (FilterState.rawConditions).
  const setRawConditions = useCallback((v: RawCondition[]) => { markInteracted(); setFilters(prev => ({ ...prev, rawConditions: v })); }, [markInteracted]);

  const lastRefreshed = pipelineQuery.dataUpdatedAt
    ? new Date(pipelineQuery.dataUpdatedAt).toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      }) + " PST"
    : null;

  // Task #393: when viewing a snapshot, show its capture time (Pacific) instead
  // of the live "Last Refresh" label.
  const snapshotRefreshed = snapshotMode && snapshotCapturedAt
    ? new Date(snapshotCapturedAt).toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      }) + " PST"
    : null;

  const [parseErrors, setParseErrors] = useState<ParseError[]>([]);
  const [parseErrorsDismissed, setParseErrorsDismissed] = useState(false);
  const [parseErrorsExpanded, setParseErrorsExpanded] = useState(false);

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch(`${API_BASE}api/sales/parse-errors`);
        const d = await res.json();
        if (d.errors && d.errors.length > 0) {
          setParseErrors(prev => {
            const newKey = d.errors.map((e: ParseError) => `${e.sheet}:${e.message}`).sort().join("|");
            const oldKey = prev.map(e => `${e.sheet}:${e.message}`).sort().join("|");
            if (newKey !== oldKey) {
              setParseErrorsDismissed(false);
            }
            return d.errors;
          });
        } else {
          setParseErrors([]);
        }
      } catch {}
    };
    check();
    const iv = setInterval(check, 60_000);
    return () => clearInterval(iv);
  }, []);


  return (
    <div className="min-h-screen bg-background flex flex-col font-sans">
      <header className="h-[52px] shrink-0 bg-[#0a1628] text-white flex items-center justify-between px-4 z-50 fixed top-0 left-0 right-0">
        <div className="flex items-center gap-3">
          <h1 className="font-bold text-[20px]">Frontline Sales Dashboard</h1>
          <div className="w-px h-4 bg-white/30 mx-2" />
          <span className="text-[13px] text-white/70">Sales Org &middot; Frontline Managers</span>
        </div>
        
        <div className="flex items-center gap-4 text-[13px]">
          {snapshotMode ? (
            <span className="text-amber-300 text-[11px] font-semibold">
              Last Refresh SNAPSHOT: {snapshotRefreshed ?? "loading…"}
            </span>
          ) : (
            lastRefreshed && <span className="text-white/70 text-[11px]">Last Refresh: {lastRefreshed}</span>
          )}
          <span className="font-bold text-[14px] text-[#006AFF]">GTM Intelligence Hub</span>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00C49F] opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[#00C49F]"></span>
            </span>
            <span className="font-medium">Updated Hourly</span>
          </div>
          <div className="flex items-center gap-2 ml-2 print:hidden">
            {pipelineQuery.data?.quotaError && (
              <span
                className="inline-flex items-center text-amber-300"
                title={`Unable to fetch goal data: ${pipelineQuery.data?.quotaErrorMessage || "the upstream query failed or timed out"}. Goals are showing as zero — try refreshing.`}
                aria-label="Goal fetch warning"
              >
                <AlertTriangle className="w-4 h-4" />
              </span>
            )}
            <select
              value={snapshotSelector}
              onChange={(e) => handleSnapshotChange(e.target.value)}
              className="bg-white/10 hover:bg-white/15 text-white text-[11px] rounded px-1.5 py-1 border border-white/20 focus:outline-none focus:ring-1 focus:ring-[#006AFF] cursor-pointer"
              aria-label="Data snapshot"
              title="View live data or roll back to a captured snapshot"
            >
              <option className="text-black" value={LIVE_SELECTOR}>Live</option>
              {snapshotList.lastGoodRefresh && (
                <option className="text-black" value="last_good_refresh">Most recent good refresh</option>
              )}
              {snapshotList.nightly.map((s) => (
                <option className="text-black" key={s.date} value={`nightly:${s.date}`}>
                  Nightly {s.date}
                </option>
              ))}
            </select>
            {authUser.role !== "viewer" && (
              <button
                onClick={handleRefresh}
                disabled={snapshotMode}
                className={`p-1.5 rounded transition-colors ${snapshotMode ? "opacity-40 cursor-not-allowed" : "hover:bg-white/10"}`}
                aria-label="Refresh"
                title={snapshotMode ? "Refresh disabled while viewing a snapshot" : "Force refresh data from Google Sheets"}
              >
                <RefreshCw className={`w-4 h-4 ${isSpinning ? 'animate-spin' : ''}`} />
              </button>
            )}
            <button onClick={() => window.print()} className="p-1.5 hover:bg-white/10 rounded transition-colors" aria-label="Print">
              <Printer className="w-4 h-4" />
            </button>
            {authUser.viewOnly && (
              <span
                className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded bg-amber-500 text-white border border-amber-600"
                title="Read-only mode — changes won't be saved. Sign in to enable saving."
              >
                Read-only
              </span>
            )}
            <ImpersonateMenu realUser={realUser} allowImpersonate={allowImpersonate} />
            <div className="flex items-center gap-2 ml-2 pl-3 border-l border-white/20">
              <HeaderAvatar authUser={authUser} />

              <div className="flex flex-col leading-tight">
                <span className="text-[12px] font-medium">
                  {`${authUser.firstName ?? ""} ${authUser.lastName ?? ""}`.trim() || authUser.email || "User"}
                </span>
                {authUser.role && (
                  <span className="text-[10px] text-white/60 uppercase tracking-wide">{authUser.role}</span>
                )}
              </div>
              <button
                onClick={handleLogout}
                className="p-1.5 hover:bg-white/10 rounded transition-colors"
                aria-label="Log out"
                title="Log out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
            <button onClick={() => setIsDark(d => !d)} className="p-1.5 hover:bg-white/10 rounded transition-colors" aria-label="Toggle Dark Mode">
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </header>

      <div className="h-[60px] shrink-0 bg-white dark:bg-[#0a1628] border-b border-border flex items-center px-4 gap-4 z-40 fixed top-[52px] left-0 right-0 overflow-x-auto print:hidden">
        <Popover open={calendarOpen} onOpenChange={(open) => {
          setCalendarOpen(open);
          if (open) {
            setDraftCustomRange(filters.timeframe === "custom" && filters.customRange
              ? { from: filters.customRange.from, to: filters.customRange.to }
              : undefined);
          } else {
            setShowCalendarPicker(false);
            setDraftCustomRange(undefined);
          }
        }}>
          <PopoverTrigger asChild>
            <button className="h-[34px] px-3 text-[12px] font-medium rounded-lg border border-border bg-white dark:bg-transparent text-foreground hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0">
              <CalendarIcon className="w-3.5 h-3.5 text-muted-foreground" />
              <span>{displayTimeframe === "custom" && filters.customRange
                ? `${format(filters.customRange.from, "MMM d")} – ${format(filters.customRange.to, "MMM d")}`
                : displayTimeframe === "allTime" ? "Last 6 Months"
                : displayTimeframe === "mtd" ? "This Month"
                : displayTimeframe === "thisWeek" ? "This Week"
                : displayTimeframe === "today" ? "Today"
                : displayTimeframe === "lastMonth" ? "Last Month"
                : "This Month"}</span>
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[200px] p-1" align="start">
            {!showCalendarPicker ? (
              <div className="flex flex-col">
                {(([
                  ["lastMonth", "Last Month"],
                  ["mtd", "This Month"],
                  ["thisWeek", "This Week"],
                  ["today", "Today"],
                  ...(activeTab === "Actions" ? [["allTime", "Last 6 Months"]] : []),
                ] as [string, string][])).map(([key, label]) => (
                  <button
                    key={key}
                    className={`w-full text-left px-3 py-2 text-[12px] font-medium rounded-md transition-colors ${displayTimeframe === key ? "bg-[#006AFF] text-white" : "text-foreground hover:bg-accent"}`}
                    onClick={() => { setFilter("timeframe", key as Timeframe); setCalendarOpen(false); }}
                  >
                    {label}
                  </button>
                ))}
                <button
                  className={`w-full text-left px-3 py-2 text-[12px] font-medium rounded-md transition-colors flex items-center gap-2 ${displayTimeframe === "custom" ? "bg-[#006AFF] text-white" : "text-foreground hover:bg-accent"}`}
                  onClick={() => setShowCalendarPicker(true)}
                >
                  <CalendarIcon className="w-3 h-3" />
                  Custom Date Range
                </button>
              </div>
            ) : (
              <div className="w-auto -mx-1">
                <button
                  className="flex items-center gap-1 px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowCalendarPicker(false)}
                >
                  <ChevronDown className="w-3 h-3 rotate-90" />
                  Back
                </button>
                <Calendar
                  mode="range"
                  showOutsideDays={false}
                  selected={draftCustomRange}
                  onSelect={(range: DateRange | undefined, triggerDate: Date | undefined) => {
                    // If a complete range is already drafted and the user
                    // clicks again, treat the new click as the start of a
                    // fresh range so they can freely change the start date.
                    if (draftCustomRange?.from && draftCustomRange?.to && triggerDate) {
                      setDraftCustomRange({ from: triggerDate, to: undefined });
                      return;
                    }
                    setDraftCustomRange(range);
                  }}
                  disabled={(date: Date) => {
                    if (calendarDisabled(date)) return true;
                    const t = new Date();
                    const todayMid = new Date(t.getFullYear(), t.getMonth(), t.getDate());
                    if (prorateQuota && quotaMode === "remaining" && date < todayMid) return true;
                    if (prorateQuota && quotaMode === "pacing" && date > todayMid) return true;
                    return false;
                  }}
                  numberOfMonths={2}
                  defaultMonth={calendarDefaultMonth}
                  holidayNameMap={holidayNameMap}
                />
                <div className="flex items-center justify-between gap-2 px-2 py-1.5 mt-1 border-t border-border">
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {draftCustomRange?.from && draftCustomRange?.to
                      ? `${format(draftCustomRange.from, "MMM d")} – ${format(draftCustomRange.to, "MMM d")}`
                      : draftCustomRange?.from
                        ? `${format(draftCustomRange.from, "MMM d")} – …`
                        : "Pick a start date"}
                  </span>
                  <button
                    type="button"
                    disabled={!draftCustomRange?.from || !draftCustomRange?.to}
                    onClick={() => {
                      if (draftCustomRange?.from && draftCustomRange?.to) {
                        markInteracted();
                        setDisplayTimeframe("custom");
                        setFilters(prev => ({ ...prev, timeframe: "custom" as Timeframe, customRange: { from: draftCustomRange.from!, to: draftCustomRange.to! } }));
                        setCalendarOpen(false);
                        setShowCalendarPicker(false);
                        setDraftCustomRange(undefined);
                      }
                    }}
                    className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-[#006AFF] text-white hover:bg-[#006AFF]/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >Apply</button>
                </div>
              </div>
            )}
          </PopoverContent>
        </Popover>
        

        <div className="w-px h-6 bg-border" />

        <Popover>
          <PopoverTrigger asChild>
            <button className="h-[34px] px-4 text-[13px] font-semibold tracking-tight rounded-lg border-2 border-[#006AFF]/30 shadow-sm bg-[#006AFF] text-white hover:bg-[#006AFF]/90 transition-colors flex items-center gap-2 whitespace-nowrap">
              {groupPreset}
              <ChevronsUpDown className="w-3.5 h-3.5 opacity-70" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[180px] p-1 bg-popover text-popover-foreground" align="start">
            {(() => {
              const base: string[] =
                activeTab === "Pipeline" || activeTab === "Anaplan"
                  ? ["Acquisitions", "G&R", "On Demand"]
                  : ["Acquisitions", "G&R", "On Demand", "All Channels"];
              const extras: string[] = [];
              // Viewers (Zillow employees outside the sales hierarchy) never
              // get Me / My Team — they have no place in the org tree.
              const isViewer = authUser.role === "viewer";
              if (!isViewer && authUser.role === "rep" && myLocation) extras.push("Me");
              if (!isViewer && myTeamLocation) extras.push("My Team");
              return [...extras, ...base];
            })().map(opt => (
              <button
                key={opt}
                className={`w-full text-left text-[13px] font-medium px-3 py-2 rounded-md flex items-center gap-2 transition-colors ${groupPreset === opt ? "bg-[#006AFF] text-white" : "hover:bg-accent text-foreground"}`}
                onClick={() => { markInteracted(); applyGroupPreset(opt, slmOptions); }}
              >
                {opt}
              </button>
            ))}
          </PopoverContent>
        </Popover>

        {activeTab === "Pipeline" && (
          <>
            <div className="w-px h-6 bg-border" />
            <PipelineSettingsPopup
              mrrMode={mrrMode}
              onMrrModeChange={setMrrModeUI}
              revenueMode={revenueMode}
              onRevenueModeChange={setRevenueModeUI}
              canUseCompensable={true}
              eRepOverride={eRepOverride}
              onERepOverrideChange={setERepOverride}
              pipelineMode={pipelineMode}
              onPipelineModeChange={setPipelineModeUI}
              subtractMods={subtractMods}
              onSubtractModsChange={setSubtractModsUI}
              prorateQuota={prorateQuota}
              onProrateQuotaChange={handleProrateQuotaChange}
              quotaMode={quotaMode}
              onQuotaModeChange={setQuotaMode}
              remainingForcedPacing={remainingForcedPacing}
              holidayFetchError={holidayFetchError}
              onSaveDefaults={saveDefaults}
              onResetDefaults={resetDefaults}
              hasSavedDefaults={hasSavedDefaults}
              selectedTimeframe={displayTimeframe}
            />
          </>
        )}

        {isCompact ? (
          <>
            <div className="w-px h-6 bg-border" />
            <button
              ref={filterBtnRef}
              onClick={() => setFilterPanelOpen(p => !p)}
              className={`h-[34px] px-3 text-[12px] font-medium rounded-lg border transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 ${filterPanelOpen ? "bg-[#006AFF] text-white border-[#006AFF]" : activeFilterCount > 0 ? "bg-[#006AFF]/10 text-[#006AFF] border-[#006AFF]/30" : "bg-white dark:bg-transparent text-foreground border-border hover:bg-black/5 dark:hover:bg-white/5"}`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
              <ChevronDown className={`w-3 h-3 transition-transform ${filterPanelOpen ? "rotate-180" : ""}`} />
            </button>
          </>
        ) : (
          <>
            <div className="w-px h-6 bg-border" />
            <SlmMultiSelect selected={filters.slm} onChange={setSlmFilter} options={scopedSlmOptions} inactiveItems={inactiveSlms} />
            <SearchableMultiSelect selected={filters.flm} onChange={(v) => setMultiFilter("flm", v)} options={flmOptions} allLabel="All FLMs" pluralLabel="FLMs" />
            <SearchableMultiSelect selected={filters.rep} onChange={(v) => setMultiFilter("rep", v)} options={repOptions} allLabel="All Reps" pluralLabel="Reps" />
            <SearchableMultiSelect selected={filters.region} onChange={(v) => setMultiFilter("region", v)} options={regionOptions} allLabel="All Regions" pluralLabel="Regions" />
            {(activeTab === "Pipeline" || activeTab === "Comp") && (
              <SearchableMultiSelect selected={filters.segment} onChange={(v) => setMultiFilter("segment", v)} options={segmentOptions} allLabel="All Segments" pluralLabel="Segments" />
            )}
            <div className="w-px h-6 bg-border" />
            <MultiSelectFilter
              label="Products"
              selected={filters.products}
              onChange={setProductsUI}
              options={availableProducts}
            />
            {(activeTab === "Pipeline" || activeTab === "Anaplan") && authUser.role === "admin" && (
              <>
                <div className="w-px h-6 bg-border" />
                <ConditionsBuilder
                  conditions={filters.rawConditions ?? []}
                  onChange={setRawConditions}
                  config={config}
                />
              </>
            )}
            <div className="w-px h-6 bg-border" />
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium text-muted-foreground whitespace-nowrap">Aggregate By</span>
              <div className="flex items-center rounded overflow-hidden border border-border">
                {(["Rep", "FLM", "SLM", "Region", ...(activeTab === "Pipeline" ? ["Segment"] : [])] as AggregateBy[]).map(opt => (
                  <button
                    key={opt}
                    className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${filters.aggregateBy === opt ? "bg-[#006AFF] text-white" : "bg-white text-foreground hover:bg-black/5 dark:hover:bg-white/5 dark:bg-transparent"}`}
                    onClick={() => setFilter("aggregateBy", opt)}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {isCompact && filterPanelOpen && (
        <div
          ref={filterPanelRef}
          className="fixed top-[160px] left-0 right-0 z-[39] bg-white dark:bg-[#0a1628] border-b border-border shadow-lg px-4 py-3 print:hidden"
        >
          <div className="grid grid-cols-3 gap-3 items-start">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">SLMs</span>
              <SlmMultiSelect selected={filters.slm} onChange={setSlmFilter} options={scopedSlmOptions} inactiveItems={inactiveSlms} />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">FLMs</span>
              <SearchableMultiSelect selected={filters.flm} onChange={(v) => setMultiFilter("flm", v)} options={flmOptions} allLabel="All FLMs" pluralLabel="FLMs" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Reps</span>
              <SearchableMultiSelect selected={filters.rep} onChange={(v) => setMultiFilter("rep", v)} options={repOptions} allLabel="All Reps" pluralLabel="Reps" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Region</span>
              <SearchableMultiSelect selected={filters.region} onChange={(v) => setMultiFilter("region", v)} options={regionOptions} allLabel="All Regions" pluralLabel="Regions" />
            </div>
            {(activeTab === "Pipeline" || activeTab === "Comp") && (
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Segment</span>
                <SearchableMultiSelect selected={filters.segment} onChange={(v) => setMultiFilter("segment", v)} options={segmentOptions} allLabel="All Segments" pluralLabel="Segments" />
              </div>
            )}
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Products</span>
              <MultiSelectFilter
                label="Products"
                selected={filters.products}
                onChange={setProductsUI}
                options={availableProducts}
              />
            </div>
            {(activeTab === "Pipeline" || activeTab === "Anaplan") && authUser.role === "admin" && (
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Conditions</span>
                <ConditionsBuilder
                  conditions={filters.rawConditions ?? []}
                  onChange={setRawConditions}
                  config={config}
                />
              </div>
            )}
            <div className="flex flex-col gap-1 col-span-3">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Aggregate By</span>
              <div className="flex items-center rounded overflow-hidden border border-border w-fit">
                {(["Rep", "FLM", "SLM", "Region", ...(activeTab === "Pipeline" ? ["Segment"] : [])] as AggregateBy[]).map(opt => (
                  <button
                    key={opt}
                    className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${filters.aggregateBy === opt ? "bg-[#006AFF] text-white" : "bg-white text-foreground hover:bg-black/5 dark:hover:bg-white/5 dark:bg-transparent"}`}
                    onClick={() => setFilter("aggregateBy", opt)}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="h-[48px] shrink-0 bg-white dark:bg-[#0a1628] border-b border-border flex items-center justify-between px-4 z-30 fixed top-[112px] left-0 right-0 overflow-x-auto print:hidden">
        <div className="flex h-full gap-6">
          {visibleTabs.map(tab => {
            const isContestTab = tab === "Sales Contests";
            const contestRestricted = isContestTab && authUser.role === "rep";
            const showStrobe = isContestTab && hasActiveContests && activeTab !== tab && !contestRestricted;
            const strobeClass = showStrobe
              ? contestStrobeType === "admin" ? "contest-strobe-admin" : "contest-strobe-flm"
              : "";
            const greyedClass = isContestTab ? "opacity-60" : "";
            const button = (
              <button 
                key={tab}
                disabled={contestRestricted}
                onClick={() => {
                  if (contestRestricted) return;
                  setActiveTab(tab);
                  if (tab !== "Actions") {
                    if (prevTimeframeRef.current) {
                      markInteracted();
                      const saved = prevTimeframeRef.current;
                      prevTimeframeRef.current = null;
                      setDisplayTimeframe(saved.timeframe);
                      setFilters(prev => ({ ...prev, timeframe: saved.timeframe, customRange: saved.customRange }));
                    } else if (filters.timeframe === "allTime") {
                      setFilter("timeframe", "mtd");
                    }
                  }
                  if (
                    (tab === "Pipeline" || tab === "Anaplan") &&
                    groupPreset === "All Channels"
                  ) {
                    markInteracted();
                    applyGroupPreset("Acquisitions", slmOptions);
                  }
                }}
                className={`h-full px-2 flex items-center text-[13px] font-medium border-b-2 transition-colors ${contestRestricted ? "cursor-not-allowed" : "hover:bg-black/5 dark:hover:bg-white/5"} ${activeTab === tab ? "border-[#006AFF] text-[#006AFF]" : "border-transparent text-foreground"} ${strobeClass} ${greyedClass}`}
                ref={isContestTab && hasActiveContests && !contestRestricted ? moneyCursorRef : undefined}
                title={
                  contestRestricted ? "Coming Soon"
                  : tab === "Pipeline" ? "What is my goal?"
                  : tab === "Activity" ? "What have I done so far?"
                  : tab === "Actions" ? "What should I do today?"
                  : tab === "Sales Contests" ? "What can I win?"
                  : undefined
                }
              >
                {isContestTab && hasActiveContests && <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse mr-1.5" />}
                {tab === "Actions" ? (
                  <span className="relative">
                    <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-[8px] font-normal leading-none text-muted-foreground/70 pointer-events-none">
                      beta
                    </span>
                    {tab}
                  </span>
                ) : (
                  tab
                )}
              </button>
            );
            if (!isContestTab) return button;
            return (
              <div key={tab} className="relative group h-full flex items-center">
                {button}
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 hidden group-hover:block z-50 pointer-events-none">
                  <div className="bg-[#1e293b] text-white text-[11px] font-semibold px-3 py-1.5 rounded-md shadow-lg whitespace-nowrap">
                    Coming Soon!
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {activeTab === "Pipeline" && (
          <div className="flex-1 flex items-center justify-center px-4 min-w-0">
            <span className="text-[11px] font-bold text-red-600 text-center leading-tight">
              NOTE: Anaplan is the source of truth for all compensation tracking. This dash is meant to be directional and does not reflect any windfall calculation or manual compensation adjustments.
            </span>
          </div>
        )}
        {activeTab === "Pipeline" && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowExplainer(true)}
              className="h-[28px] px-3 bg-white hover:bg-gray-50 border border-gray-200 text-[#64748b] hover:text-[#1e293b] rounded-md text-[11px] font-medium transition-colors flex items-center gap-1.5 shrink-0"
              title="Learn how pipeline settings affect your MRR numbers vs. Salesforce"
            >
              <HelpCircle className="w-3.5 h-3.5" />
              <span className="hidden xl:inline">Why is my MRR different in Salesforce?</span>
              <span className="xl:hidden">MRR Explainer</span>
            </button>
          </div>
        )}
        {activeTab === "Sales Contests" && canManageContests && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => spiffViewRef.current?.toggleCreateForm()}
              className="h-[28px] px-3 bg-[#006AFF] text-white rounded-md text-[11px] font-medium hover:bg-[#005ce6] transition-colors flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> New Contest
            </button>
          </div>
        )}
      </div>

      <main className="flex-1 overflow-y-auto mt-[160px] p-4 lg:p-6 print:mt-0">
        <div className="max-w-[1600px] mx-auto">
          {activeTab === "Pipeline" && <PipelineView loading={loading} data={pipelineQuery.data} filters={effectiveFilters} pipelineMode={pipelineMode} onPipelineModeChange={setPipelineModeUI} mrrMode={mrrMode} onMrrModeChange={setMrrModeUI} revenueMode={revenueMode} subtractMods={subtractMods} authUser={authUser} groupPreset={groupPreset} modsStart={modsStart} onModsStartChange={setModsStartUI} modsExtend={modsExtend} onModsExtendChange={setModsExtendUI} modsDateRange={modsDateRange} onProductsChange={setProductsUI} onSetSlmFilter={setSlmFilter} onSetMultiFilter={setMultiFilter} uiSlmFilter={filters.slm} prorateQuota={prorateQuota} quotaMode={quotaMode} holidaySet={holidaySet} holidayNameMap={holidayNameMap} holidayFetchError={holidayFetchError} selectedTimeframe={displayTimeframe} availableProducts={availableProducts} />}
          {activeTab === "Activity" && <ActivityView loading={loading} data={activityQuery.data} filters={effectiveFilters} />}
          {activeTab === "Actions" && <ActionsView loading={loading} data={actionsQuery.data} filters={effectiveFilters} onSubViewChange={handleActionsSubViewChange} />}
          {activeTab === "Anaplan" && <AnaplanView loading={anaplanQuery.isLoading || anaplanQuery.isFetching} data={anaplanQuery.data} filters={effectiveFilters} />}
          {activeTab === "Sales Contests" && <SpiffView ref={spiffViewRef} loading={loading} data={activityQuery.data} pipelineData={pipelineQuery.data} config={config} filters={effectiveFilters} authUser={authUser} />}
          {activeTab === "Comp" && canSeeComp && <ExecutiveView filters={effectiveFilters} authUser={authUser} />}
          {activeTab === "Admin" && authUser.role === "admin" && <AdminView authUser={authUser} />}
        </div>
      </main>

      <footer className="shrink-0 bg-white dark:bg-[#0a1628] border-t border-border px-4 py-3 text-[11px] text-[#64748b] flex items-center justify-between print:hidden">
        <span>Data Source: Salesforce Export via Coefficient &middot; Google Sheets</span>
        {lastRefreshed && <span>Last Refreshed: {lastRefreshed}</span>}
      </footer>

      {showExplainer && (
        <Suspense fallback={null}>
          <SalesforceExplainerModal onClose={() => setShowExplainer(false)} />
        </Suspense>
      )}

      {parseErrors.length > 0 && !parseErrorsDismissed && (
        <div className="fixed bottom-4 right-4 z-[100] max-w-[420px] print:hidden">
          {!parseErrorsExpanded ? (
            <div
              role="button"
              tabIndex={0}
              onClick={() => setParseErrorsExpanded(true)}
              onKeyDown={(e) => e.key === "Enter" && setParseErrorsExpanded(true)}
              className="flex items-center gap-2 bg-amber-50 dark:bg-amber-950 border border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200 rounded-lg px-3 py-2 shadow-lg text-[12px] hover:bg-amber-100 dark:hover:bg-amber-900 transition-colors cursor-pointer"
            >
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{parseErrors.length} data feed {parseErrors.length === 1 ? "issue" : "issues"} detected</span>
              <button
                onClick={(e) => { e.stopPropagation(); setParseErrorsDismissed(true); }}
                className="ml-1 p-0.5 hover:bg-amber-200 dark:hover:bg-amber-800 rounded"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <div className="bg-white dark:bg-[#1a1a2e] border border-amber-300 dark:border-amber-700 rounded-lg shadow-xl overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-amber-50 dark:bg-amber-950 border-b border-amber-200 dark:border-amber-800">
                <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200 text-[12px] font-medium">
                  <AlertTriangle className="w-4 h-4" />
                  Data Feed Issues
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setParseErrorsExpanded(false)} className="p-1 hover:bg-amber-200 dark:hover:bg-amber-800 rounded text-amber-600">
                    <span className="text-[10px]">minimize</span>
                  </button>
                  <button onClick={() => setParseErrorsDismissed(true)} className="p-1 hover:bg-amber-200 dark:hover:bg-amber-800 rounded text-amber-600">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="max-h-[300px] overflow-y-auto divide-y divide-border">
                {parseErrors.map((err, i) => (
                  <div key={i} className="px-3 py-2 text-[11px]">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-semibold text-foreground">{err.sheet} Sheet</span>
                      <a
                        href={err.sheetUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[#006AFF] hover:underline"
                      >
                        Open Sheet <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                    <p className="text-red-600 dark:text-red-400 mb-1">{err.message}</p>
                    <div className="text-muted-foreground">
                      <span className="font-medium">Expected:</span> {err.expectedHeaders.join(", ")}
                    </div>
                    <div className="text-muted-foreground">
                      <span className="font-medium">Found:</span> {err.actualHeaders.join(", ") || "(empty)"}
                    </div>
                    <div className="text-muted-foreground mt-0.5">
                      {new Date(err.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type ImpersonateUser = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
  role: string | null;
  hierarchyName: string | null;
};

type ImpersonationListEntry = ImpersonateUser & {
  slm: string | null;
  flm: string | null;
  source: "db+sheet" | "sheet-only" | "db-only";
};

function HeaderAvatar({ authUser }: { authUser: AuthUser }) {
  const { data: photos } = usePhotoMap();
  const fullName = `${authUser.firstName ?? ""} ${authUser.lastName ?? ""}`.trim();
  const syncedUrl = resolvePhotoUrl(photos, authUser.hierarchyName, fullName);
  const initialSrc = syncedUrl ?? authUser.profileImageUrl ?? null;
  const [src, setSrc] = useState<string | null>(initialSrc);
  useEffect(() => { setSrc(initialSrc); }, [initialSrc]);

  if (src) {
    return (
      <img
        src={src}
        alt={fullName || "User"}
        className="w-7 h-7 rounded-full object-cover"
        onError={() => {
          if (src === syncedUrl && authUser.profileImageUrl) {
            setSrc(authUser.profileImageUrl);
          } else {
            setSrc(null);
          }
        }}
      />
    );
  }
  return (
    <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center text-[11px] font-medium">
      {(authUser.firstName?.[0] ?? authUser.email?.[0] ?? "?").toUpperCase()}
    </div>
  );
}

const IMPERSONATE_KEY = "impersonate_user";

export function getImpersonatedUser(): ImpersonateUser | null {
  try {
    const raw = localStorage.getItem(IMPERSONATE_KEY);
    return raw ? JSON.parse(raw) as ImpersonateUser : null;
  } catch { return null; }
}

function ImpersonateMenu({ realUser, allowImpersonate }: { realUser: AuthUser; allowImpersonate: boolean }) {
  const current = getImpersonatedUser();
  const isImpersonating = !!current;
  const isAdmin = realUser.role === "admin";
  const enabled = allowImpersonate || (import.meta.env.DEV && isImpersonating);
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<ImpersonationListEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || loaded) return;
    const path = isAdmin ? "api/admin/impersonation-list" : "api/admin/impersonation-list-dev";
    fetch(`${API_BASE}${path}`)
      .then(r => r.ok ? r.json() : { users: [] })
      .then((d: { users: ImpersonationListEntry[] }) => { setUsers(d.users || []); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [open, loaded, isAdmin]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!enabled) return null;

  const apply = (u: ImpersonateUser | null) => {
    if (u) {
      // Strip the extra ImpersonationListEntry fields before storing — only
      // the ImpersonateUser shape is consumed by the rest of the app.
      const stored: ImpersonateUser = {
        id: u.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        profileImageUrl: u.profileImageUrl,
        role: u.role,
        hierarchyName: u.hierarchyName,
      };
      localStorage.setItem(IMPERSONATE_KEY, JSON.stringify(stored));
    } else {
      localStorage.removeItem(IMPERSONATE_KEY);
    }
    window.location.reload();
  };

  const filtered = users.filter(u => {
    if (!filter) return true;
    const f = filter.toLowerCase();
    return (
      (u.email ?? "").toLowerCase().includes(f) ||
      `${u.firstName ?? ""} ${u.lastName ?? ""}`.toLowerCase().includes(f) ||
      (u.hierarchyName ?? "").toLowerCase().includes(f) ||
      (u.role ?? "").toLowerCase().includes(f)
    );
  });

  const matched = filtered.filter(u => u.source !== "db-only");
  const unmatched = filtered.filter(u => u.source === "db-only");

  const renderRow = (u: ImpersonationListEntry) => {
    const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.hierarchyName || u.email || "(no name)";
    const isCur = current?.id === u.id;
    return (
      <button
        key={u.id}
        onClick={() => apply(u)}
        className={`w-full text-left px-3 py-2 text-[12px] hover:bg-gray-50 border-b border-border/30 ${isCur ? "bg-blue-50" : ""}`}
      >
        <div className="font-medium truncate">{name}</div>
        <div className="text-[10px] text-muted-foreground flex items-center gap-2">
          <span className="uppercase font-semibold">{u.role ?? "—"}</span>
          {u.email && <span className="truncate">{u.email}</span>}
        </div>
      </button>
    );
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`px-2 py-1 text-[11px] rounded border transition-colors ${isImpersonating ? "bg-amber-500 text-white border-amber-600 hover:bg-amber-600" : "bg-white/10 hover:bg-white/20 border-white/20 text-white"}`}
        title="Debug: view as another user"
      >
        {isImpersonating ? `Viewing as: ${current?.firstName ?? current?.email ?? "user"}` : "View as…"}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-[320px] bg-white text-[#1e293b] border border-border rounded-md shadow-xl z-[100] max-h-[420px] flex flex-col">
          <div className="p-2 border-b border-border/60 flex items-center gap-2">
            <input
              autoFocus
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Search users…"
              className="flex-1 text-[12px] px-2 py-1 border border-border rounded"
            />
            {isImpersonating && (
              <button
                onClick={() => apply(null)}
                className="text-[11px] px-2 py-1 bg-amber-100 hover:bg-amber-200 text-amber-900 rounded whitespace-nowrap font-medium"
                title="Stop impersonating and return to your real account"
              >
                ← {realUser.firstName || realUser.email || "me"}
              </button>
            )}
          </div>
          <div className="overflow-auto flex-1">
            {!loaded && <div className="p-3 text-[12px] text-muted-foreground">Loading…</div>}
            {loaded && filtered.length === 0 && <div className="p-3 text-[12px] text-muted-foreground">No users found</div>}
            {matched.map(renderRow)}
            {unmatched.length > 0 && (
              <div
                className="px-3 py-1.5 text-[10px] uppercase tracking-wide font-semibold text-amber-800 bg-amber-50 border-y border-amber-200"
                title="These people signed in but aren't in the org sheet — please add them or check their email."
              >
                Unmatched users
              </div>
            )}
            {unmatched.map(renderRow)}
          </div>
        </div>
      )}
    </div>
  );
}

const PRODUCT_ABBREV_MAP: Record<string, string> = {
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

function getProductAbbrevDash(product: string): string {
  return displayProductAbbrev(product, PRODUCT_ABBREV_MAP[product] || product.substring(0, 3).toUpperCase());
}

const PRODUCT_CANONICAL_ORDER = [
  "MBP", "Showcase", "Showcase Incremental", "Showcase Incremental - Re/Max",
  "Overage", "Zillow Pro", "Follow Up Boss", "ZMX", "No Product Selected",
];

function MultiSelectFilter({ selected, onChange, options, label }: { selected: string[], onChange: (v: string[]) => void, options: string[], label?: string }) {
  const [open, setOpen] = useState(false);

  const toggle = (opt: string) => {
    if (selected.includes(opt)) {
      onChange(selected.filter(s => s !== opt));
    } else {
      onChange([...selected, opt]);
    }
  };

  const nonMbpProducts = options.filter(o => o !== "MBP");
  const hasMbp = options.includes("MBP");
  const mbpSelected = selected.includes("MBP");
  const allNonMbpSelected = nonMbpProducts.length > 0 && nonMbpProducts.every(p => selected.includes(p));

  const toggleSoftware = () => {
    if (allNonMbpSelected) {
      onChange(selected.filter(p => p === "MBP"));
    } else {
      const next = hasMbp && mbpSelected ? ["MBP", ...nonMbpProducts] : [...nonMbpProducts];
      onChange(next);
    }
  };

  let displayText: string;
  if (selected.length === 0) {
    displayText = "All Products";
  } else if (hasMbp && mbpSelected && allNonMbpSelected) {
    displayText = "All Products";
  } else if (!mbpSelected && allNonMbpSelected) {
    displayText = "Software";
  } else if (mbpSelected && selected.length === 1) {
    displayText = displayProduct("MBP");
  } else {
    const canonical = PRODUCT_CANONICAL_ORDER.filter(p => options.includes(p));
    for (const p of options) if (!canonical.includes(p)) canonical.push(p);
    const set = new Set(selected);
    const ordered: string[] = [];
    for (const p of canonical) if (set.has(p)) ordered.push(p);
    for (const p of selected) if (!canonical.includes(p)) ordered.push(p);
    displayText = ordered.map(getProductAbbrevDash).join("+");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label={label}
          className="h-[30px] text-[12px] w-[160px] bg-white dark:bg-transparent border border-border rounded-md px-2 flex items-center justify-between gap-1 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left text-foreground"
        >
          <span className="truncate">{displayText}</span>
          <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-0 bg-popover text-popover-foreground" align="start">
        <div className="p-1">
          <button
            className={`w-full text-left text-[12px] px-2 py-1.5 rounded-sm flex items-center gap-2 hover:bg-accent ${selected.length === 0 ? "font-medium text-[#006AFF]" : ""}`}
            onClick={() => { onChange([]); setOpen(false); }}
          >
            <Check className={`w-3 h-3 shrink-0 ${selected.length === 0 ? "opacity-100" : "opacity-0"}`} />
            All Products
          </button>
          {hasMbp && (
            <button
              key="MBP"
              className={`w-full text-left text-[12px] px-2 py-1.5 rounded-sm flex items-center gap-2 hover:bg-accent ${mbpSelected ? "font-medium text-[#006AFF]" : ""}`}
              onClick={() => toggle("MBP")}
            >
              <div className={`w-3.5 h-3.5 shrink-0 border rounded-sm flex items-center justify-center ${mbpSelected ? "bg-[#006AFF] border-[#006AFF]" : "border-border"}`}>
                {mbpSelected && <Check className="w-2.5 h-2.5 text-white" />}
              </div>
              {displayProduct("MBP")}
            </button>
          )}
          {nonMbpProducts.length > 0 && (
            <button
              className={`w-full text-left text-[12px] px-2 py-1.5 rounded-sm flex items-center gap-2 hover:bg-accent ${allNonMbpSelected ? "font-medium text-[#006AFF]" : ""}`}
              onClick={toggleSoftware}
            >
              <div className={`w-3.5 h-3.5 shrink-0 border rounded-sm flex items-center justify-center ${allNonMbpSelected ? "bg-[#006AFF] border-[#006AFF]" : "border-border"}`}>
                {allNonMbpSelected && <Check className="w-2.5 h-2.5 text-white" />}
              </div>
              Software
            </button>
          )}
          {nonMbpProducts.map(opt => (
            <button
              key={opt}
              className={`w-full text-left text-[12px] pl-7 pr-2 py-1.5 rounded-sm flex items-center gap-2 hover:bg-accent ${selected.includes(opt) ? "font-medium text-[#006AFF]" : ""}`}
              onClick={() => toggle(opt)}
            >
              <div className={`w-3.5 h-3.5 shrink-0 border rounded-sm flex items-center justify-center ${selected.includes(opt) ? "bg-[#006AFF] border-[#006AFF]" : "border-border"}`}>
                {selected.includes(opt) && <Check className="w-2.5 h-2.5 text-white" />}
              </div>
              {displayProduct(opt)}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SlmMultiSelect({ selected, onChange, options, inactiveItems }: { selected: string[], onChange: (v: string[]) => void, options: string[], inactiveItems: Set<string> }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!search) return options;
    const q = search.toLowerCase();
    return options.filter(o => o.toLowerCase().includes(q));
  }, [options, search]);

  useEffect(() => {
    if (open) {
      setSearch("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const toggle = (opt: string) => {
    if (selected.includes(opt)) {
      onChange(selected.filter(s => s !== opt));
    } else {
      onChange([...selected, opt]);
    }
  };

  const displayText = selected.length === 0
    ? "All SLMs"
    : selected.length === 1
      ? selected[0]
      : `${selected.length} SLMs`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label="SLMs"
          className="h-[30px] text-[12px] w-[160px] bg-white dark:bg-transparent border border-border rounded-md px-2 flex items-center justify-between gap-1 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left text-foreground"
        >
          <span className="truncate">{displayText}</span>
          <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-0 bg-popover text-popover-foreground" align="start">
        <div className="flex items-center border-b border-border px-2">
          <Search className="w-3.5 h-3.5 shrink-0 opacity-40" />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search SLMs..."
            className="h-[32px] w-full bg-transparent text-[12px] px-2 outline-none text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[240px] overflow-y-auto p-1">
          <button
            className={`w-full text-left text-[12px] px-2 py-1.5 rounded-sm flex items-center gap-2 hover:bg-accent ${selected.length === 0 ? "font-medium text-[#006AFF]" : ""}`}
            onClick={() => { onChange([]); setOpen(false); }}
          >
            <Check className={`w-3 h-3 shrink-0 ${selected.length === 0 ? "opacity-100" : "opacity-0"}`} />
            All SLMs
          </button>
          {filtered.map(opt => {
            const isInactive = inactiveItems.has(opt);
            const isSelected = selected.includes(opt);
            return (
              <button
                key={opt}
                className={`w-full text-left text-[12px] px-2 py-1.5 rounded-sm flex items-center gap-2 hover:bg-accent ${isSelected ? "font-medium text-[#006AFF]" : isInactive ? "text-muted-foreground/50" : ""}`}
                onClick={() => toggle(opt)}
              >
                <div className={`w-3.5 h-3.5 shrink-0 border rounded-sm flex items-center justify-center ${isSelected ? "bg-[#006AFF] border-[#006AFF]" : "border-border"}`}>
                  {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                </div>
                {opt}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="text-[12px] text-muted-foreground px-2 py-3 text-center">No results</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SearchableMultiSelect({
  selected,
  onChange,
  options,
  allLabel,
  pluralLabel,
}: {
  selected: string[];
  onChange: (v: string[]) => void;
  options: string[];
  allLabel: string;
  pluralLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!search) return options;
    const q = search.toLowerCase();
    return options.filter(o => o.toLowerCase().includes(q));
  }, [options, search]);

  useEffect(() => {
    if (open) {
      setSearch("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const toggle = (opt: string) => {
    if (selected.includes(opt)) {
      onChange(selected.filter(s => s !== opt));
    } else {
      onChange([...selected, opt]);
    }
  };

  const displayText = selected.length === 0
    ? allLabel
    : selected.length === 1
      ? selected[0]
      : `${selected.length} ${pluralLabel}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label={pluralLabel}
          className="h-[30px] text-[12px] w-[160px] bg-white dark:bg-transparent border border-border rounded-md px-2 flex items-center justify-between gap-1 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left text-foreground"
        >
          <span className="truncate">{displayText}</span>
          <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-0 bg-popover text-popover-foreground" align="start">
        <div className="flex items-center border-b border-border px-2">
          <Search className="w-3.5 h-3.5 shrink-0 opacity-40" />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${pluralLabel.toLowerCase()}...`}
            className="h-[32px] w-full bg-transparent text-[12px] px-2 outline-none text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[240px] overflow-y-auto p-1">
          <button
            className={`w-full text-left text-[12px] px-2 py-1.5 rounded-sm flex items-center gap-2 hover:bg-accent ${selected.length === 0 ? "font-medium text-[#006AFF]" : ""}`}
            onClick={() => { onChange([]); setOpen(false); }}
          >
            <Check className={`w-3 h-3 shrink-0 ${selected.length === 0 ? "opacity-100" : "opacity-0"}`} />
            {allLabel}
          </button>
          {filtered.map(opt => {
            const isSelected = selected.includes(opt);
            return (
              <button
                key={opt}
                className={`w-full text-left text-[12px] px-2 py-1.5 rounded-sm flex items-center gap-2 hover:bg-accent ${isSelected ? "font-medium text-[#006AFF]" : ""}`}
                onClick={() => toggle(opt)}
              >
                <div className={`w-3.5 h-3.5 shrink-0 border rounded-sm flex items-center justify-center ${isSelected ? "bg-[#006AFF] border-[#006AFF]" : "border-border"}`}>
                  {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                </div>
                {opt}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="text-[12px] text-muted-foreground px-2 py-3 text-center">No results</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SearchableFilterSelect({ value, onChange, options, label, allLabel }: { value: string, onChange: (v: string) => void, options: string[], label?: string, allLabel: string }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!search) return options;
    const q = search.toLowerCase();
    return options.filter(o => o.toLowerCase().includes(q));
  }, [options, search]);

  const allItems = useMemo(() => [allLabel, ...filtered], [allLabel, filtered]);

  useEffect(() => {
    if (open) {
      setSearch("");
      setHighlightIdx(-1);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setHighlightIdx(-1);
  }, [search]);

  const selectItem = useCallback((val: string) => {
    onChange(val);
    setOpen(false);
  }, [onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx(i => Math.min(i + 1, allItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && highlightIdx >= 0) {
      e.preventDefault();
      selectItem(allItems[highlightIdx]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }, [allItems, highlightIdx, selectItem]);

  useEffect(() => {
    if (highlightIdx >= 0 && listRef.current) {
      const el = listRef.current.children[highlightIdx] as HTMLElement;
      if (el) el.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIdx]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          aria-haspopup="listbox"
          className="h-[30px] text-[12px] w-[160px] bg-white dark:bg-transparent border border-border rounded-md px-2 flex items-center justify-between gap-1 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left text-foreground"
        >
          <span className="truncate">{value}</span>
          <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-0 bg-popover text-popover-foreground" align="start" onKeyDown={handleKeyDown}>
        <div className="flex items-center border-b border-border px-2">
          <Search className="w-3.5 h-3.5 shrink-0 opacity-40" />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${label?.toLowerCase() || ""}...`}
            aria-label={`Search ${label || ""}`}
            className="h-[32px] w-full bg-transparent text-[12px] px-2 outline-none text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <div ref={listRef} role="listbox" aria-label={label} className="max-h-[240px] overflow-y-auto p-1">
          {allItems.map((opt, idx) => (
            <button
              key={opt}
              role="option"
              aria-selected={value === opt}
              className={`w-full text-left text-[12px] px-2 py-1.5 rounded-sm flex items-center gap-2 transition-colors ${value === opt ? "font-medium text-[#006AFF]" : ""} ${highlightIdx === idx ? "bg-accent" : "hover:bg-accent"}`}
              onClick={() => selectItem(opt)}
            >
              <Check className={`w-3 h-3 shrink-0 ${value === opt ? "opacity-100" : "opacity-0"}`} />
              {opt}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="text-[12px] text-muted-foreground px-2 py-3 text-center">No results</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ============================================================================
// Task #361: admin-only "Conditions" builder. Each row is `{ field, value }`
// combined with AND ("is"/equals). Slices the entire Pipeline by a raw
// opportunity field. Only rendered for admins; the server independently ignores
// the param for non-admins. Non-persisted.
// ============================================================================
const CONDITION_FIELDS: { value: string; label: string }[] = [
  { value: "type", label: "Type" },
  { value: "rawProduct", label: "Raw Product" },
  { value: "productFamily", label: "Product Family" },
  { value: "product", label: "Product" },
  { value: "quoteType", label: "Quote Type" },
  { value: "termLength", label: "Term Length" },
  { value: "channel", label: "Channel" },
  { value: "segment", label: "Segment" },
  { value: "salesRole", label: "Sales Role" },
  { value: "oppName", label: "Opportunity Name" },
  { value: "funnelStage", label: "Funnel Stage" },
];

// Map each condition field to its distinct value list from the sales config.
// `oppName` has no enumerable list (free text), so it returns [].
function conditionValueOptions(field: string, config: any): string[] {
  switch (field) {
    case "type":
      return config?.types ?? [];
    case "rawProduct":
      return config?.rawProducts ?? [];
    case "productFamily":
      return config?.productFamilies ?? [];
    case "product":
      return config?.products ?? [];
    case "quoteType":
      return config?.quoteTypes ?? [];
    case "termLength":
      return config?.termLengths ?? [];
    case "channel":
      return config?.groups ?? [];
    case "segment":
      return config?.segments ?? [];
    case "salesRole":
      return config?.salesRoles ?? [];
    case "funnelStage":
      return config?.funnelStages ?? [];
    default:
      return [];
  }
}

// Compact single-select dropdown with a search box and a checkmark on the
// selected item. Reused for the field picker and list-based value pickers.
function ConditionSelect({
  value,
  onChange,
  options,
  placeholder,
  width = "w-[150px]",
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!search) return options;
    const q = search.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, search]);

  useEffect(() => {
    if (open) {
      setSearch("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const selectedLabel = options.find((o) => o.value === value)?.label;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={`h-[30px] text-[12px] ${width} bg-white dark:bg-transparent border border-border rounded-md px-2 flex items-center justify-between gap-1 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left text-foreground`}
        >
          <span className={`truncate ${selectedLabel ? "" : "text-muted-foreground"}`}>
            {selectedLabel ?? placeholder}
          </span>
          <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-0 bg-popover text-popover-foreground" align="start">
        <div className="flex items-center border-b border-border px-2">
          <Search className="w-3.5 h-3.5 shrink-0 opacity-40" />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="h-[32px] w-full bg-transparent text-[12px] px-2 outline-none text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[240px] overflow-y-auto p-1">
          {filtered.map((opt) => (
            <button
              key={opt.value}
              className={`w-full text-left text-[12px] px-2 py-1.5 rounded-sm flex items-center gap-2 hover:bg-accent ${value === opt.value ? "font-medium text-[#006AFF]" : ""}`}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              <Check className={`w-3 h-3 shrink-0 ${value === opt.value ? "opacity-100" : "opacity-0"}`} />
              {opt.label}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="text-[12px] text-muted-foreground px-2 py-3 text-center">No results</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ConditionsBuilder({
  conditions,
  onChange,
  config,
}: {
  conditions: RawCondition[];
  onChange: (c: RawCondition[]) => void;
  config: any;
}) {
  const [open, setOpen] = useState(false);
  const activeCount = conditions.filter((c) => c.field && c.value.trim() !== "").length;

  const updateRow = (idx: number, next: Partial<RawCondition>) => {
    onChange(conditions.map((c, i) => (i === idx ? { ...c, ...next } : c)));
  };
  const removeRow = (idx: number) => {
    onChange(conditions.filter((_, i) => i !== idx));
  };
  const addRow = () => {
    onChange([...conditions, { field: "type", value: "" }]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label="Conditions"
          className={`h-[30px] text-[12px] rounded-md px-2.5 flex items-center gap-1.5 border transition-colors whitespace-nowrap ${
            activeCount > 0
              ? "bg-[#006AFF]/10 text-[#006AFF] border-[#006AFF]/30"
              : "bg-white dark:bg-transparent text-foreground border-border hover:bg-black/5 dark:hover:bg-white/5"
          }`}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          Conditions{activeCount > 0 ? ` (${activeCount})` : ""}
          <ChevronDown className="w-3 h-3 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[460px] p-3 bg-popover text-popover-foreground" align="start">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[12px] font-semibold text-foreground">Conditions</span>
          {conditions.length > 0 && (
            <button
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => onChange([])}
            >
              Clear all
            </button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground mb-2">
          Slice the entire Pipeline by raw opportunity fields. All conditions must
          match (AND).
        </p>
        <div className="flex flex-col gap-2">
          {conditions.length === 0 && (
            <div className="text-[12px] text-muted-foreground py-2">No conditions yet.</div>
          )}
          {conditions.map((cond, idx) => {
            const opts = conditionValueOptions(cond.field, config);
            const isFreeText = cond.field === "oppName";
            return (
              <div key={idx} className="flex items-center gap-1.5">
                <ConditionSelect
                  value={cond.field}
                  onChange={(field) => updateRow(idx, { field, value: "" })}
                  options={CONDITION_FIELDS}
                  placeholder="Field"
                  width="w-[150px]"
                />
                <span className="text-[11px] text-muted-foreground shrink-0">is</span>
                {isFreeText ? (
                  <input
                    value={cond.value}
                    onChange={(e) => updateRow(idx, { value: e.target.value })}
                    placeholder="Enter value..."
                    className="h-[30px] text-[12px] flex-1 bg-white dark:bg-transparent border border-border rounded-md px-2 outline-none text-foreground placeholder:text-muted-foreground"
                  />
                ) : (
                  <div className="flex-1">
                    <ConditionSelect
                      value={cond.value}
                      onChange={(value) => updateRow(idx, { value })}
                      options={opts.map((o) => ({ value: o, label: o }))}
                      placeholder="Select value"
                      width="w-full"
                    />
                  </div>
                )}
                <button
                  aria-label="Remove condition"
                  className="h-[30px] w-[30px] shrink-0 flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
                  onClick={() => removeRow(idx)}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        <button
          className="mt-3 h-[30px] text-[12px] font-medium rounded-md px-2.5 flex items-center gap-1.5 border border-border text-foreground hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          onClick={addRow}
        >
          <Plus className="w-3.5 h-3.5" /> Add condition
        </button>
      </PopoverContent>
    </Popover>
  );
}
