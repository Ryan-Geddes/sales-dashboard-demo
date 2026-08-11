import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, Search, X, Download } from "lucide-react";
import { CSVLink } from "react-csv";
import type { FilterState } from "../pages/Dashboard";
import { getDateRange, passesChannelFilter } from "../lib/utils";
import { sfClassicRecordUrl } from "../lib/sf-links";
import { displayProduct } from "@/lib/product-labels";

interface UnreviewedMod {
  oppId: string;
  opportunityId?: string | null;
  contactId?: string;
  contactName?: string;
  accountName?: string;
  oppName?: string;
  rep: string;
  manager?: string;
  product: string;
  modDate: string;
  amount: number;
  churnType?: string;
  reason?: string;
  description?: string;
  region?: string;
  group?: string;
  flm?: string;
  slm?: string;
  segment?: string;
  stageDefaultProbability?: number | null;
  probabilityOverride?: number | null;
  effectiveProbability?: number | null;
  isReviewed?: boolean;
}

type SortKey = "accountName" | "rep" | "product" | "modDate" | "amount" | "churnType" | "reason" | "probability";
type SortDir = "asc" | "desc";

interface AuthUser {
  role?: string | null;
  hierarchyName?: string | null;
  viewOnly?: boolean;
}

interface Props {
  filters: FilterState;
  productFilter?: string | null; // single product or "Showcase" (expands to Showcase + Showcase Incremental)
  modsFrom?: string;
  modsTo?: string;
  churnTypeFilter?: string;
  repFilter?: string | null;
  contextLabel?: string;
  authUser?: AuthUser;
  onClose: () => void;
  onProbabilityChanged?: () => void;
}

const SHOWCASE_PARTS = new Set(["Showcase", "Showcase Incremental"]);

export default function UnreviewedModsModal({
  filters,
  productFilter,
  modsFrom,
  modsTo,
  churnTypeFilter,
  repFilter,
  contextLabel,
  authUser,
  onClose,
  onProbabilityChanged,
}: Props) {
  const [mods, setMods] = useState<UnreviewedMod[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("amount");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [searchId, setSearchId] = useState("");
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

  const fetchMods = useCallback((showSpinner: boolean = true) => {
    if (showSpinner) setLoading(true);
    const dateRange = getDateRange(filters.timeframe, filters.customRange);
    const qs = new URLSearchParams();
    const from = modsFrom ?? dateRange.from;
    const to = modsTo ?? dateRange.to;
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    // Task #361: admin-only raw Conditions so the modal rows match the
    // conditioned Pipeline slice. Server ignores it for non-admins.
    if (authUser?.role === "admin") {
      const valid = (filters.rawConditions ?? []).filter((c) => c.field && c.value.trim() !== "");
      if (valid.length > 0) qs.set("rawConditions", JSON.stringify(valid));
    }
    fetch(`${apiBase}api/sales/unreviewed-mods?${qs.toString()}`)
      .then(r => r.json())
      .then(data => {
        setMods(data.mods || data.opportunities || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [apiBase, filters.timeframe, filters.customRange, filters.rawConditions, modsFrom, modsTo, authUser?.role]);

  useEffect(() => { fetchMods(true); }, [fetchMods]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Active product narrowing: combines the dashboard's products filter
  // with the modal's productFilter prop. "Showcase" expands to both
  // Showcase and Showcase Incremental.
  const activeProductSet = useMemo<Set<string> | null>(() => {
    const fromFilters = filters.products.length > 0 ? new Set(filters.products) : null;
    if (!productFilter) return fromFilters;
    const fromProp = productFilter === "Showcase" ? new Set(SHOWCASE_PARTS) : new Set([productFilter]);
    if (!fromFilters) return fromProp;
    const inter = new Set<string>();
    for (const p of fromProp) if (fromFilters.has(p)) inter.add(p);
    return inter;
  }, [filters.products, productFilter]);

  const filteredMods = useMemo(() => {
    // Keep rows visible after a probability edit (optimistic isReviewed flip)
    // so the user gets visual feedback without the row disappearing mid-edit.
    let res = mods.slice();
    if (filters.slm.length > 0) res = res.filter(o => filters.slm.includes(o.slm || ""));
    if (filters.flm.length > 0) res = res.filter(o => filters.flm.includes(o.flm || ""));
    if (filters.rep.length > 0) res = res.filter(o => filters.rep.includes(o.rep));
    if (filters.region.length > 0) res = res.filter(o => filters.region.includes(o.region || ""));
    if (filters.segment.length > 0) res = res.filter(o => filters.segment.includes(o.segment || ""));
    res = res.filter(o => passesChannelFilter(o.group, filters.group));
    if (activeProductSet) res = res.filter(o => activeProductSet.has(o.product));
    if (churnTypeFilter) res = res.filter(o => (o.churnType || "") === churnTypeFilter);
    if (repFilter) res = res.filter(o => o.rep === repFilter);
    if (searchId.trim()) {
      const q = searchId.trim().toLowerCase();
      res = res.filter(o =>
        o.oppId?.toLowerCase().includes(q)
        || o.opportunityId?.toLowerCase().includes(q)
        || o.accountName?.toLowerCase().includes(q)
        || o.contactName?.toLowerCase().includes(q)
        || o.oppName?.toLowerCase().includes(q));
    }
    return res;
  }, [mods, filters.slm, filters.flm, filters.rep, filters.region, filters.segment, filters.group, activeProductSet, churnTypeFilter, repFilter, searchId]);

  const sortedMods = useMemo(() => {
    const arr = [...filteredMods];
    arr.sort((a, b) => {
      let av: any;
      let bv: any;
      if (sortKey === "amount") { av = a.amount || 0; bv = b.amount || 0; }
      else if (sortKey === "modDate") { av = Date.parse(a.modDate) || 0; bv = Date.parse(b.modDate) || 0; }
      else if (sortKey === "probability") { av = a.effectiveProbability ?? -1; bv = b.effectiveProbability ?? -1; }
      else if (sortKey === "accountName") { av = String(a.accountName || a.contactName || "").toLowerCase(); bv = String(b.accountName || b.contactName || "").toLowerCase(); }
      else { av = String((a as any)[sortKey] ?? "").toLowerCase(); bv = String((b as any)[sortKey] ?? "").toLowerCase(); }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [filteredMods, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(key === "accountName" || key === "rep" || key === "product" || key === "churnType" ? "asc" : "desc"); }
  };

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return <ArrowUpDown className="w-3 h-3 inline opacity-40" />;
    return sortDir === "asc" ? <ArrowUp className="w-3 h-3 inline" /> : <ArrowDown className="w-3 h-3 inline" />;
  };

  const role = authUser?.role;
  const myName = authUser?.hierarchyName || "";
  const viewOnly = !!authUser?.viewOnly;
  const canEditOppProb = useCallback((o: UnreviewedMod) => {
    if (viewOnly || !o.oppId) return false;
    if (role === "admin" || role === "slm" || role === "exec") return true;
    if (role === "flm") return o.flm === myName;
    if (role === "rep") return o.rep === myName;
    return false;
  }, [role, myName, viewOnly]);

  const updateProbability = useCallback(async (oppId: string, value: number) => {
    probabilityDirtyRef.current = true;
    type Snapshot = { probabilityOverride: number | null | undefined; effectiveProbability: number | null | undefined; isReviewed: boolean | undefined };
    let prevSnapshot: Snapshot | null = null;
    setMods(prev => prev.map(o => {
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
      setMods(prev => prev.map(o => o.oppId === oppId
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
        console.warn("Failed to save mod probability override", await res.text());
        rollback();
      }
    } catch (e) {
      console.error("Error saving mod probability override", e);
      rollback();
    }
  }, []);

  const ProbabilityCell: React.FC<{ mod: UnreviewedMod }> = ({ mod }) => {
    const editable = canEditOppProb(mod);
    const eff = mod.effectiveProbability;
    const def = mod.stageDefaultProbability;
    const matchesDefault = mod.isReviewed === false;
    const [draft, setDraft] = useState<string>(eff == null ? "" : String(eff));
    const debounceRef = useRef<number | null>(null);
    useEffect(() => { setDraft(eff == null ? "" : String(eff)); }, [eff]);
    useEffect(() => () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    }, []);
    const tryCommit = (raw: string) => {
      if (!mod.oppId) return;
      const trimmed = raw.trim();
      if (trimmed === "") return;
      if (!/^\d+$/.test(trimmed)) { setDraft(eff == null ? "" : String(eff)); return; }
      let n = Number(trimmed);
      if (!Number.isInteger(n)) { setDraft(eff == null ? "" : String(eff)); return; }
      n = Math.max(0, Math.min(100, n));
      if (n === eff && mod.isReviewed === true) return;
      void updateProbability(mod.oppId, n);
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
        title={def != null ? `Stage default ${def}% — set a value to mark as reviewed` : "Set per-mod probability (marks as reviewed)"}
      />
    );
  };

  // CSV mirrors the rendered table column order exactly.
  const csvData = useMemo(() => sortedMods.map(o => ({
    "Account/Contact": o.accountName || o.contactName || "",
    "Rep": o.rep,
    "Product": displayProduct(o.product),
    "Churn Type": o.churnType || "",
    "Cancellation Date": o.modDate,
    "MRR": o.amount,
    "Reason": o.reason || "",
    "Probability": o.effectiveProbability ?? "",
  })), [sortedMods]);

  const totalAmt = sortedMods.reduce((s, o) => s + (o.amount || 0), 0);

  const heading = `Unreviewed Scheduled Mods${contextLabel ? ` — ${contextLabel}` : ""}`;

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
                <span className="ml-2 text-[12px] font-normal text-[#64748b] tabular-nums">({sortedMods.length})</span>
              )}
            </div>
            <div className="text-[10px] text-[#64748b] mt-0.5">
              Scheduled mods whose probability has never been edited. Set a probability to mark one as reviewed.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <CSVLink
              data={csvData}
              filename={`unreviewed-mods${productFilter ? `-${productFilter}` : ""}.csv`}
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
              className="pl-6 pr-2 py-1 text-[12px] border border-border rounded bg-white w-64 focus:outline-none focus:ring-1 focus:ring-[#006AFF]"
              placeholder="Search id, account, contact, or mod type…"
              value={searchId}
              onChange={(e) => setSearchId(e.target.value)}
            />
          </div>
          <div className="text-[11px] text-[#64748b] tabular-nums">
            <span className="font-semibold text-[#1e293b]">{sortedMods.length}</span> unreviewed
            <span className="mx-2 text-[#cbd5e1]">|</span>
            Amount <span className="font-semibold text-[#1e293b]">${Math.round(totalAmt).toLocaleString()}</span>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="text-center text-[12px] text-[#64748b] py-8">Loading…</div>
          ) : sortedMods.length === 0 ? (
            <div className="text-center text-[12px] text-[#64748b] py-8">No unreviewed mods in scope.</div>
          ) : (
            <table className="w-full text-[12px] border-collapse">
              <thead className="bg-[#f8fafc] sticky top-0 z-10">
                <tr className="text-left text-[10px] uppercase tracking-[0.5px] text-[#64748b]">
                  <th className="px-2 py-1.5 cursor-pointer select-none" onClick={() => toggleSort("accountName")}>Account/Contact <SortIcon k="accountName" /></th>
                  <th className="px-2 py-1.5 cursor-pointer select-none" onClick={() => toggleSort("rep")}>Rep <SortIcon k="rep" /></th>
                  <th className="px-2 py-1.5 cursor-pointer select-none" onClick={() => toggleSort("product")}>Product <SortIcon k="product" /></th>
                  <th className="px-2 py-1.5 cursor-pointer select-none" onClick={() => toggleSort("churnType")}>Churn Type <SortIcon k="churnType" /></th>
                  <th className="px-2 py-1.5 cursor-pointer select-none" onClick={() => toggleSort("modDate")}>Cancellation Date <SortIcon k="modDate" /></th>
                  <th className="px-2 py-1.5 text-right cursor-pointer select-none" onClick={() => toggleSort("amount")}>MRR <SortIcon k="amount" /></th>
                  <th className="px-2 py-1.5 cursor-pointer select-none" onClick={() => toggleSort("reason")}>Reason <SortIcon k="reason" /></th>
                  <th className="px-2 py-1.5 text-right cursor-pointer select-none" onClick={() => toggleSort("probability")}>Prob <SortIcon k="probability" /></th>
                  <th className="px-2 py-1.5 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {sortedMods.map(o => {
                  const accountLabel = o.accountName || o.contactName || "";
                  const modTypeLabel = o.oppName || "";
                  const reasonText = o.reason || "";
                  return (
                    <tr key={o.oppId} className="border-t border-border hover:bg-[#f8fafc] transition-colors">
                      <td className="px-2 py-1.5">
                        <div className="text-[#1e293b] truncate max-w-[240px]" title={accountLabel}>{accountLabel}</div>
                        {modTypeLabel && (
                          <div className="text-[10px] text-[#94a3b8] truncate max-w-[240px]" title={modTypeLabel}>{modTypeLabel}</div>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-[#1e293b]">{o.rep}</td>
                      <td className="px-2 py-1.5 text-[#1e293b]">{displayProduct(o.product)}</td>
                      <td className="px-2 py-1.5 text-[#1e293b]">{o.churnType || ""}</td>
                      <td className="px-2 py-1.5 text-[#64748b] tabular-nums">{o.modDate}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">${Math.round(o.amount || 0).toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-[#64748b] truncate max-w-[220px]" title={reasonText}>{reasonText}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums"><ProbabilityCell mod={o} /></td>
                      <td className="px-2 py-1.5">
                        {o.opportunityId ? (
                          <a
                            href={sfClassicRecordUrl(o.opportunityId)}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[#006AFF] hover:opacity-80"
                            title="Open in Salesforce"
                          >
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : null}
                      </td>
                    </tr>
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
