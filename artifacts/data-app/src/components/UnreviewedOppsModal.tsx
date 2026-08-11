import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, ExternalLink, Search, X } from "lucide-react";
import { CSVLink } from "react-csv";
import { Download } from "lucide-react";
import type { FilterState } from "../pages/Dashboard";
import { getDateRange, passesChannelFilter } from "../lib/utils";
import { sfLightningBase, sfClassicRecordUrl } from "../lib/sf-links";
import { displayProduct } from "@/lib/product-labels";

interface LineItem {
  product: string;
  mrr: number;
  amount: number;
}

interface UnreviewedOpp {
  oppName: string;
  accountName: string;
  accountId: string;
  oppId: string;
  manager: string;
  rep: string;
  salesRole: string;
  closeDate: string;
  type: string;
  product: string;
  amount: number;
  mrr: number;
  stage: string;
  funnelStage: string;
  region: string;
  segment?: string;
  group: string;
  flm: string;
  slm: string;
  probabilityOverride?: number | null;
  stageDefaultProbability?: number | null;
  effectiveProbability?: number | null;
  // True iff the override row was edited by the rep and not yet cleared by the Sunday cron.
  isReviewed?: boolean;
  lineItems?: LineItem[];
  // SCI-R (Showcase Incremental - Re/Max) synthetic rows carry the real
  // Salesforce Contact / Compensation__c IDs so the drilldown can build
  // correct Lightning hyperlinks (the accountId / oppId on these rows
  // are synthetic dedupe keys, not real SF IDs).
  sfContactId?: string;
  sfCpdId?: string;
}

type SortKey = "oppName" | "accountName" | "rep" | "funnelStage" | "closeDate" | "amount" | "mrr" | "probability";
type SortDir = "asc" | "desc";

interface AuthUser {
  role?: string | null;
  hierarchyName?: string | null;
  viewOnly?: boolean;
}

interface Props {
  filters: FilterState;
  pipelineMode?: "closeDate" | "allOpen";
  productFilter?: string | null;
  repFilter?: string | null;
  contextLabel?: string;
  authUser?: AuthUser;
  onClose: () => void;
  onProbabilityChanged?: () => void;
}

const SF_LIGHTNING = sfLightningBase;
const SHOWCASE_PARTS = new Set(["Showcase", "Showcase Incremental"]);

// Builds the correct Salesforce hyperlink for an unreviewed opportunity.
// SCI-R (Re/Max CPD) synthetic rows route to Contact / Compensation__c
// Lightning records because their accountId / oppId are synthetic keys,
// not real SF Account / Opportunity IDs. All other rows fall back to the
// classic /<id> Salesforce URL. Mirrors sfLinkFor in FunnelDrilldownModal.
function sfLinkFor(opp: UnreviewedOpp, kind: "account" | "opp"): string {
  if (opp.product === "Showcase Incremental - Re/Max") {
    if (kind === "account" && opp.sfContactId) {
      return `${SF_LIGHTNING}/Contact/${opp.sfContactId}/view`;
    }
    if (kind === "opp" && opp.sfCpdId) {
      return `${SF_LIGHTNING}/Compensation__c/${opp.sfCpdId}/view`;
    }
  }
  return sfClassicRecordUrl(kind === "account" ? opp.accountId : opp.oppId);
}

export default function UnreviewedOppsModal({
  filters,
  pipelineMode = "closeDate",
  productFilter,
  repFilter,
  contextLabel,
  authUser,
  onClose,
  onProbabilityChanged,
}: Props) {
  const [opps, setOpps] = useState<UnreviewedOpp[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("amount");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [searchId, setSearchId] = useState("");
  // Set of oppIds whose multi-product line items are expanded.
  const [expandedMulti, setExpandedMulti] = useState<Set<string>>(new Set());
  const toggleExpandMulti = useCallback((id: string) => {
    setExpandedMulti(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const apiBase = import.meta.env.BASE_URL || "/";
  const probabilityDirtyRef = useRef(false);
  const onProbabilityChangedRef = useRef(onProbabilityChanged);
  useEffect(() => { onProbabilityChangedRef.current = onProbabilityChanged; }, [onProbabilityChanged]);
  useEffect(() => () => {
    if (probabilityDirtyRef.current) {
      probabilityDirtyRef.current = false;
      onProbabilityChangedRef.current?.();
    }
  }, []);

  const fetchOpps = useCallback((showSpinner: boolean = true) => {
    if (showSpinner) setLoading(true);
    const dateRange = getDateRange(filters.timeframe, filters.customRange);
    const qs = new URLSearchParams();
    qs.set("timeframe", filters.timeframe);
    if (dateRange.from) qs.set("from", dateRange.from);
    if (dateRange.to) qs.set("to", dateRange.to);
    if (pipelineMode === "allOpen") qs.set("pipelineMode", "allOpen");
    // Task #361: admin-only raw Conditions so the modal rows match the
    // conditioned Pipeline slice. Server ignores it for non-admins.
    if (authUser?.role === "admin") {
      const valid = (filters.rawConditions ?? []).filter((c) => c.field && c.value.trim() !== "");
      if (valid.length > 0) qs.set("rawConditions", JSON.stringify(valid));
    }
    fetch(`${apiBase}api/sales/unreviewed-opps?${qs.toString()}`)
      .then(r => r.json())
      .then(data => {
        setOpps(data.opportunities || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [apiBase, filters.timeframe, filters.customRange, filters.rawConditions, pipelineMode, authUser?.role]);

  useEffect(() => { fetchOpps(true); }, [fetchOpps]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Active "narrowing" set of products: combines the dashboard's products
  // filter with the modal's optional `productFilter` prop (used by per-product
  // drilldowns). Each line item must match at least one entry in this set
  // for the row's MRR/Amount to count.
  const activeProductSet = useMemo<Set<string> | null>(() => {
    const fromFilters = filters.products.length > 0 ? new Set(filters.products) : null;
    if (!productFilter) return fromFilters;
    const fromProp = productFilter === "Showcase" ? new Set(SHOWCASE_PARTS) : new Set([productFilter]);
    if (!fromFilters) return fromProp;
    // Intersect both sets so the row only includes line items that satisfy
    // both the dashboard's selection and the per-product narrowing.
    const inter = new Set<string>();
    for (const p of fromProp) if (fromFilters.has(p)) inter.add(p);
    return inter;
  }, [filters.products, productFilter]);

  const lineItemsOf = useCallback((o: UnreviewedOpp): LineItem[] => {
    if (o.lineItems && o.lineItems.length > 0) return o.lineItems;
    return [{ product: o.product || "", mrr: o.mrr || 0, amount: o.amount || 0 }];
  }, []);
  const isMultiOpp = useCallback((o: UnreviewedOpp) => (o.lineItems?.length ?? 0) >= 2, []);
  const matchedLineItems = useCallback((o: UnreviewedOpp): LineItem[] => {
    const lis = lineItemsOf(o);
    if (!activeProductSet) return lis;
    return lis.filter(li => activeProductSet.has(li.product));
  }, [activeProductSet, lineItemsOf]);
  const displayedMrr = useCallback(
    (o: UnreviewedOpp) => matchedLineItems(o).reduce((s, li) => s + (li.mrr || 0), 0),
    [matchedLineItems],
  );
  const displayedAmount = useCallback(
    (o: UnreviewedOpp) => matchedLineItems(o).reduce((s, li) => s + (li.amount || 0), 0),
    [matchedLineItems],
  );
  const displayedProduct = useCallback(
    (o: UnreviewedOpp) => isMultiOpp(o) ? "Multiple" : (lineItemsOf(o)[0]?.product || ""),
    [isMultiOpp, lineItemsOf],
  );

  const filteredOpps = useMemo(() => {
    // Keep rows visible even after the rep edits the probability — they only
    // drop out of the list the next time the modal is opened (server refetch
    // excludes now-reviewed rows). The yellow "unreviewed" highlight still
    // clears immediately via `isReviewed`, so users get visual feedback
    // without the row disappearing mid-edit.
    let res = opps.slice();
    if (filters.slm.length > 0) res = res.filter(o => filters.slm.includes(o.slm));
    if (filters.flm.length > 0) res = res.filter(o => filters.flm.includes(o.flm));
    if (filters.rep.length > 0) res = res.filter(o => filters.rep.includes(o.rep));
    if (filters.region.length > 0) res = res.filter(o => filters.region.includes(o.region));
    if (filters.segment.length > 0) res = res.filter(o => filters.segment.includes((o as any).segment));
    res = res.filter(o => passesChannelFilter(o.group, filters.group));
    if (activeProductSet) {
      // An opp qualifies if at least one line item matches the active set.
      // Per-row MRR/Amount sums later use only matching items.
      res = res.filter(o => lineItemsOf(o).some(li => activeProductSet.has(li.product)));
    }
    if (repFilter) res = res.filter(o => o.rep === repFilter);
    if (searchId.trim()) {
      const q = searchId.trim().toLowerCase();
      res = res.filter(o => o.oppId?.toLowerCase().includes(q) || o.oppName?.toLowerCase().includes(q));
    }
    return res;
  }, [opps, filters.slm, filters.flm, filters.rep, filters.region, filters.segment, filters.group, activeProductSet, lineItemsOf, repFilter, searchId]);

  const sortedOpps = useMemo(() => {
    const arr = [...filteredOpps];
    arr.sort((a, b) => {
      let av: any;
      let bv: any;
      // Numeric columns sort on the displayed (filter-adjusted) value so the
      // row order matches the rendered MRR/Amount the user sees.
      if (sortKey === "amount") { av = displayedAmount(a); bv = displayedAmount(b); }
      else if (sortKey === "mrr") { av = displayedMrr(a); bv = displayedMrr(b); }
      else if (sortKey === "closeDate") { av = Date.parse(a.closeDate) || 0; bv = Date.parse(b.closeDate) || 0; }
      else if (sortKey === "probability") { av = a.effectiveProbability ?? -1; bv = b.effectiveProbability ?? -1; }
      else { av = String((a as any)[sortKey] ?? "").toLowerCase(); bv = String((b as any)[sortKey] ?? "").toLowerCase(); }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [filteredOpps, sortKey, sortDir, displayedAmount, displayedMrr]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(key === "oppName" || key === "accountName" || key === "rep" || key === "funnelStage" ? "asc" : "desc"); }
  };

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return <ArrowUpDown className="w-3 h-3 inline opacity-40" />;
    return sortDir === "asc" ? <ArrowUp className="w-3 h-3 inline" /> : <ArrowDown className="w-3 h-3 inline" />;
  };

  const role = authUser?.role;
  const myName = authUser?.hierarchyName || "";
  const viewOnly = !!authUser?.viewOnly;
  const canEditOppProb = useCallback((o: UnreviewedOpp) => {
    if (viewOnly || !o.oppId) return false;
    if (role === "admin" || role === "slm" || role === "exec") return true;
    if (role === "flm") return o.flm === myName;
    if (role === "rep") return o.rep === myName;
    return false;
  }, [role, myName, viewOnly]);

  const updateOppProbability = useCallback(async (oppId: string, value: number) => {
    probabilityDirtyRef.current = true;
    // Optimistically flip isReviewed=true so (a) the yellow "unreviewed"
    // highlight clears immediately and (b) the row drops out of the
    // filtered list (see filteredOpps above). Snapshot the prior values so
    // we can roll back — restoring the prior isReviewed (false/undefined)
    // makes the row reappear in the list automatically.
    type Snapshot = { probabilityOverride: number | null | undefined; effectiveProbability: number | null | undefined; isReviewed: boolean | undefined };
    let prevSnapshot: Snapshot | null = null;
    setOpps(prev => prev.map(o => {
      if (o.oppId !== oppId) return o;
      prevSnapshot = {
        probabilityOverride: o.probabilityOverride,
        effectiveProbability: o.effectiveProbability,
        isReviewed: o.isReviewed,
      };
      return { ...o, probabilityOverride: value, effectiveProbability: value, isReviewed: true };
    }));
    const rollback = () => {
      const snap = prevSnapshot;
      if (!snap) return;
      setOpps(prev => prev.map(o => o.oppId === oppId
        ? { ...o, probabilityOverride: snap.probabilityOverride, effectiveProbability: snap.effectiveProbability, isReviewed: snap.isReviewed }
        : o
      ));
    };
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
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
        rollback();
      }
    } catch (e) {
      console.error("Error saving probability override", e);
      rollback();
    }
  }, []);

  const ProbabilityCell: React.FC<{ opp: UnreviewedOpp }> = ({ opp }) => {
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
    const tryCommit = (raw: string) => {
      if (!opp.oppId) return;
      const trimmed = raw.trim();
      if (trimmed === "") return;
      if (!/^\d+$/.test(trimmed)) { setDraft(eff == null ? "" : String(eff)); return; }
      let n = Number(trimmed);
      if (!Number.isInteger(n)) { setDraft(eff == null ? "" : String(eff)); return; }
      n = Math.max(0, Math.min(100, n));
      // Always commit — even when the value matches the current/default
      // probability — so that hitting Enter on the default value still
      // marks the opp as reviewed (per user request).
      if (n === eff && opp.isReviewed === true) return;
      void updateOppProbability(opp.oppId, n);
    };
    if (!editable) {
      return (
        <span
          className={`inline-block w-[58px] text-right text-[11px] tabular-nums px-1.5 py-0.5 rounded border ${matchesDefault ? "bg-yellow-100 border-yellow-300 text-[#1e293b]" : "bg-[#f8fafc] border-[#e2e8f0] text-[#64748b]"}`}
          title={def != null ? `View only — stage default ${def}%` : "View only"}
        >
          {eff == null ? "" : `${eff}%`}
        </span>
      );
    }
    return (
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        className={`w-[58px] text-right text-[11px] tabular-nums px-1.5 py-0.5 rounded border focus:outline-none focus:ring-1 focus:ring-[#006AFF] ${matchesDefault ? "bg-yellow-100 border-yellow-300" : "bg-white border-[#cbd5e1]"}`}
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
          debounceRef.current = window.setTimeout(() => tryCommit(v), 700);
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
        placeholder="—"
        title={def != null ? `Stage default ${def}% — set a value to mark as reviewed` : "Set per-opp probability (marks as reviewed)"}
      />
    );
  };

  const csvData = useMemo(() => sortedOpps.map(o => ({
    "Account": o.accountName,
    "Opp Name": o.oppName,
    "Opp Id": o.oppId,
    "Rep": o.rep,
    "FLM": o.flm,
    "SLM": o.slm,
    "Stage": o.funnelStage,
    "Close Date": o.closeDate,
    "Product": displayProduct(displayedProduct(o)),
    "Amount": displayedAmount(o),
    "MRR": displayedMrr(o),
    "Default %": o.stageDefaultProbability ?? "",
    "Current %": o.effectiveProbability ?? "",
  })), [sortedOpps, displayedProduct, displayedAmount, displayedMrr]);

  const totalAmt = sortedOpps.reduce((s, o) => s + displayedAmount(o), 0);
  const totalMrr = sortedOpps.reduce((s, o) => s + displayedMrr(o), 0);

  const heading = `Unreviewed Opportunities${contextLabel ? ` — ${contextLabel}` : ""}`;

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-[1080px] max-w-[95vw] max-h-[88vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-2 border-b border-border">
          <div>
            <div className="text-[14px] font-semibold text-[#1e293b]">
              {heading}
              {!loading && (
                <span className="ml-2 text-[12px] font-normal text-[#64748b] tabular-nums">({sortedOpps.length})</span>
              )}
            </div>
            <div className="text-[10px] text-[#64748b] mt-0.5">
              Open opportunities whose probability has never been edited. Set a probability to mark one as reviewed.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <CSVLink
              data={csvData}
              filename={`unreviewed-opportunities${productFilter ? `-${productFilter}` : ""}.csv`}
              className="flex items-center gap-1 px-2 py-1 text-[11px] text-[#1e293b] border border-border rounded hover:bg-gray-50 transition-colors"
              title="Download as CSV"
            >
              <Download className="w-3 h-3" /> CSV
            </CSVLink>
            <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded transition-colors" aria-label="Close">
              <X className="w-4 h-4 text-[#64748b]" />
            </button>
          </div>
        </div>

        <div className="px-4 py-2 flex items-center gap-3 border-b border-border bg-[#f8fafc]">
          <div className="relative">
            <Search className="w-3 h-3 text-[#94a3b8] absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              className="pl-6 pr-2 py-1 text-[12px] border border-border rounded bg-white w-56 focus:outline-none focus:ring-1 focus:ring-[#006AFF]"
              placeholder="Search opp id or name…"
              value={searchId}
              onChange={(e) => setSearchId(e.target.value)}
            />
          </div>
          <div className="text-[11px] text-[#64748b] tabular-nums">
            <span className="font-semibold text-[#1e293b]">{sortedOpps.length}</span> unreviewed
            <span className="mx-2 text-[#cbd5e1]">|</span>
            Amount <span className="font-semibold text-[#1e293b]">${Math.round(totalAmt).toLocaleString()}</span>
            <span className="mx-2 text-[#cbd5e1]">|</span>
            MRR <span className="font-semibold text-[#1e293b]">${Math.round(totalMrr).toLocaleString()}</span>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="text-center text-[12px] text-[#64748b] py-8">Loading…</div>
          ) : sortedOpps.length === 0 ? (
            <div className="text-center text-[12px] text-[#64748b] py-8">No unreviewed opportunities in scope.</div>
          ) : (
            <table className="w-full text-[12px] border-collapse">
              <thead className="bg-[#f8fafc] sticky top-0 z-10">
                <tr className="text-left text-[10px] uppercase tracking-[0.5px] text-[#64748b]">
                  <th className="px-2 py-1.5 cursor-pointer select-none" onClick={() => toggleSort("accountName")}>Account <SortIcon k="accountName" /></th>
                  <th className="px-2 py-1.5 cursor-pointer select-none" onClick={() => toggleSort("oppName")}>Opp Name <SortIcon k="oppName" /></th>
                  {!productFilter && (
                    <th className="px-2 py-1.5">Product</th>
                  )}
                  <th className="px-2 py-1.5 cursor-pointer select-none" onClick={() => toggleSort("rep")}>Rep <SortIcon k="rep" /></th>
                  <th className="px-2 py-1.5 cursor-pointer select-none" onClick={() => toggleSort("funnelStage")}>Stage <SortIcon k="funnelStage" /></th>
                  <th className="px-2 py-1.5 cursor-pointer select-none" onClick={() => toggleSort("closeDate")}>Close <SortIcon k="closeDate" /></th>
                  <th className="px-2 py-1.5 text-right cursor-pointer select-none" onClick={() => toggleSort("amount")}>Amount <SortIcon k="amount" /></th>
                  <th className="px-2 py-1.5 text-right cursor-pointer select-none" onClick={() => toggleSort("mrr")}>MRR <SortIcon k="mrr" /></th>
                  <th className="px-2 py-1.5 text-right cursor-pointer select-none" onClick={() => toggleSort("probability")}>Prob <SortIcon k="probability" /></th>
                </tr>
              </thead>
              <tbody>
                {sortedOpps.map(o => {
                  const multi = isMultiOpp(o);
                  const multiOpen = multi && !!o.oppId && expandedMulti.has(o.oppId);
                  const lis = multi ? lineItemsOf(o) : [];
                  const productLabel = displayProduct(displayedProduct(o));
                  const productTip = multi ? lineItemsOf(o).map(li => displayProduct(li.product)).join(", ") : productLabel;
                  return (
                    <React.Fragment key={o.oppId || `${o.rep}|${o.accountId}|${o.closeDate}`}>
                      <tr className="border-t border-border hover:bg-[#f8fafc] transition-colors">
                        <td className="px-2 py-1.5 max-w-[200px]" title={o.accountName}>
                          {o.accountId ? (
                            <a
                              href={sfLinkFor(o, "account")}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#006AFF] hover:underline inline-flex items-center gap-1 max-w-full"
                            >
                              <span className="truncate">{o.accountName || "—"}</span>
                              <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
                            </a>
                          ) : (
                            <span className="text-[#1e293b] truncate block">{o.accountName}</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          {o.oppId ? (
                            <a
                              href={sfLinkFor(o, "opp")}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium text-[#006AFF] hover:underline inline-flex items-center gap-1 max-w-[260px]"
                              title={o.oppName}
                            >
                              <span className="truncate">{o.oppName || "—"}</span>
                              <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
                            </a>
                          ) : (
                            <div className="font-medium text-[#1e293b] truncate max-w-[260px]" title={o.oppName}>{o.oppName}</div>
                          )}
                          <div className="text-[10px] text-[#94a3b8] inline-flex items-center gap-1" title={productTip}>
                            {multi ? (
                              <>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); if (o.oppId) toggleExpandMulti(o.oppId); }}
                                  className="shrink-0 p-0.5 rounded hover:bg-black/10 transition-colors"
                                  aria-label={multiOpen ? "Collapse line items" : "Expand line items"}
                                  title={multiOpen ? "Hide line items" : `Line items: ${productTip}`}
                                >
                                  {multiOpen
                                    ? <ChevronDown className="w-3 h-3 text-[#006AFF]" />
                                    : <ChevronRight className="w-3 h-3 text-[#94a3b8]" />}
                                </button>
                                <span className="font-medium">Multiple</span>
                              </>
                            ) : (
                              <span>{productLabel}</span>
                            )}
                          </div>
                        </td>
                        {!productFilter && (
                          <td className="px-2 py-1.5 text-[#1e293b]" title={productTip}>
                            {multi ? <span className="font-medium">Multiple</span> : productLabel}
                          </td>
                        )}
                        <td className="px-2 py-1.5 text-[#1e293b]">{o.rep}</td>
                        <td className="px-2 py-1.5 text-[#1e293b]">{o.funnelStage}</td>
                        <td className="px-2 py-1.5 text-[#64748b] tabular-nums">{o.closeDate}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">${Math.round(displayedAmount(o)).toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">${Math.round(displayedMrr(o)).toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums"><ProbabilityCell opp={o} /></td>
                      </tr>
                      {multiOpen && lis.map((li, idx) => {
                        const matched = !activeProductSet || activeProductSet.has(li.product);
                        return (
                          <tr key={`${o.oppId}-li-${idx}`} className={`bg-[#f8fafc] border-t border-border/50 ${matched ? "" : "opacity-60"}`}>
                            <td className="px-2 py-1 pl-6 text-[10px] text-[#64748b]" colSpan={productFilter ? 4 : 5}>
                              <span className="mr-2">↳</span>
                              <span className="font-medium">{displayProduct(li.product) || "—"}</span>
                            </td>
                            <td className="px-2 py-1"></td>
                            <td className="px-2 py-1 text-right tabular-nums text-[10px] text-[#64748b]">${Math.round(li.amount).toLocaleString()}</td>
                            <td className="px-2 py-1 text-right tabular-nums text-[10px] text-[#64748b]">${Math.round(li.mrr).toLocaleString()}</td>
                            <td className="px-2 py-1"></td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
