import { displayProduct } from "@/lib/product-labels";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

// Manager Estimate row for the GNR Churn Forecast popup (#155, reformatted #160).
//
// Visual layout mirrors the Sched Mod / CC Decline `StageProbabilityRow`
// in PipelineView.tsx so the popup reads as a single consistent table:
// `[label | default% | current% | progress bar | unweighted | weighted]`.
//
// - Default % is fixed at 100 (ME has no editable stage default).
// - Current % is the dollar-weighted average of the per-rep × product
//   ME probability overrides, computed as weightedTotal / total * 100.
// - The unweighted column doubles as the FLM/SLM editor when the
//   viewer is allowed to enter a Manager Estimate $ for the scope.
//
// Task #192: when used in the aggregate (all-products) Churn popup,
// the caller passes `products` so this component renders ONE parent
// "Manager Estimate" row plus per-product sub-rows beneath, matching
// the Scheduled Mod / CC Decline parent+sub-rows pattern. In the
// per-product (single) Churn popup, `products` is omitted and the
// component renders just a single row as before.

type AuthUser = { role?: string | null; hierarchyName?: string | null; viewOnly?: boolean };

interface ProductSubRow {
  product: string;
  color: string;
}

interface Props {
  product: string;
  monthYyyymm: string;
  authUser?: AuthUser;
  onSaved?: () => void;
  // Scope hints from the GNR popup. When `repsScope` is non-empty, the
  // ME endpoint returns per-rep shares so the rolled-up current % can
  // be computed from the same per-rep × product probability overrides
  // that drive the scheduled-mods drilldown's pinned ME row.
  repsScope?: string[];
  flmsScope?: string[];
  // Task #192: when provided, the parent row aggregates across these
  // products and indented per-product sub-rows are rendered beneath
  // (mirrors the Scheduled Mod / CC Decline pattern). When omitted,
  // the row uses `product` alone as a single-product display.
  products?: ProductSubRow[];
  // Task #193: when sub-rows are rendered (i.e. `products` is set),
  // optionally show an expand/collapse caret on the parent row so
  // users can hide the per-product breakdown. Controlled by the
  // parent so collapse state can be coordinated with the other
  // stage sections in the aggregate drilldown.
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

type EstimateRow = {
  flmName: string;
  monthYyyymm: string;
  product: string;
  unweightedAmount: number;
  weightedAmount?: number;
};

const ACCENT = "#EF4444"; // matches the popup's churn red

function ymToIsoMonth(yyyymm: string): string {
  return yyyymm.length === 6 ? `${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}` : yyyymm;
}

function fmtMrrShort(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

export const ChurnForecastMERow: React.FC<Props> = ({ product, monthYyyymm, authUser, onSaved, repsScope, flmsScope, products, collapsible, collapsed, onToggleCollapse }) => {
  const role = authUser?.role || "";
  const isFlm = role === "flm";
  const isSlm = role === "slm";
  const ownName = (authUser?.hierarchyName || "").trim();
  // When `products` is provided we aggregate across all of them;
  // otherwise we fall back to the single `product`.
  const productSet = useMemo(
    () => (products && products.length > 0 ? products.map(p => p.product) : [product]),
    [products, product]
  );

  const [rows, setRows] = useState<EstimateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(0);
  const draftDirtyRef = useRef(false);

  const repsScopeKey = (repsScope && repsScope.length > 0) ? repsScope.join(",") : "";
  const flmsScopeKey = (flmsScope && flmsScope.length > 0) ? flmsScope.join(",") : "";

  useEffect(() => {
    let cancelled = false;
    const month = ymToIsoMonth(monthYyyymm);
    if (!month) return;
    const params = new URLSearchParams();
    params.set("month", month);
    if (flmsScopeKey) params.set("flms", flmsScopeKey);
    else if (isFlm && ownName) params.set("flms", ownName);
    if (repsScopeKey) params.set("reps", repsScopeKey);
    setLoading(true);
    fetch(`/api/sales/manager-estimates?${params.toString()}`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : { estimates: [] }))
      .then(data => {
        if (cancelled) return;
        const list: EstimateRow[] = Array.isArray(data?.estimates) ? data.estimates : [];
        setRows(list);
      })
      .catch(() => { /* keep last good */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [monthYyyymm, isFlm, ownName, savedTick, repsScopeKey, flmsScopeKey]);

  // Aggregate totals across the in-scope products.
  const { total, weightedTotal } = useMemo(() => {
    const allow = new Set(productSet);
    let unw = 0;
    let w = 0;
    for (const r of rows) {
      if (!allow.has(r.product)) continue;
      const u = r.unweightedAmount || 0;
      unw += u;
      w += typeof r.weightedAmount === "number" ? r.weightedAmount : u;
    }
    return { total: unw, weightedTotal: w };
  }, [rows, productSet]);

  // Per-product breakdown for the indented sub-rows.
  const perProduct = useMemo(() => {
    if (!products || products.length === 0) return null;
    const byProduct = new Map<string, { unw: number; w: number }>();
    for (const r of rows) {
      const u = r.unweightedAmount || 0;
      const w = typeof r.weightedAmount === "number" ? r.weightedAmount : u;
      const cur = byProduct.get(r.product) ?? { unw: 0, w: 0 };
      cur.unw += u;
      cur.w += w;
      byProduct.set(r.product, cur);
    }
    return products.map(p => {
      const agg = byProduct.get(p.product) ?? { unw: 0, w: 0 };
      const cur = agg.unw > 0 ? (agg.w / agg.unw) * 100 : 100;
      return { ...p, unw: agg.unw, w: agg.w, currentPct: cur };
    });
  }, [rows, products]);

  // Mirrors the StageProbabilityRow formula: weighted$ / unweighted$ * 100.
  // Falls back to 100% when there's no $ in scope so the row visually
  // matches the other "no overrides" stage rows.
  const currentPct = total > 0 ? (weightedTotal / total) * 100 : 100;
  const barPct = Math.min(100, Math.max(0, currentPct));

  useEffect(() => {
    if (!draftDirtyRef.current) setDraft(String(Math.round(total)));
  }, [total]);

  const canEdit = (isFlm || isSlm) && !!ownName && !authUser?.viewOnly;

  const commit = async () => {
    if (!canEdit) return;
    const trimmed = draft.replace(/[$,\s]/g, "");
    if (trimmed === "" || !/^-?\d+(\.\d+)?$/.test(trimmed)) {
      setDraft(String(Math.round(total)));
      draftDirtyRef.current = false;
      return;
    }
    let n = Number(trimmed);
    if (!Number.isFinite(n)) n = 0;
    if (n < 0) n = 0;
    if (Math.abs(n - total) < 0.5) {
      draftDirtyRef.current = false;
      setDraft(String(Math.round(total)));
      return;
    }
    const per = n / productSet.length;
    setSaving(true);
    setError(null);
    try {
      const isoMonth = ymToIsoMonth(monthYyyymm);
      const responses = await Promise.all(productSet.map(p => fetch("/api/sales/manager-estimates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(isSlm
          ? {
              scope: "slm" as const,
              slmName: ownName,
              monthYyyymm: isoMonth,
              product: p,
              unweightedAmount: per,
            }
          : {
              flmName: ownName,
              monthYyyymm: isoMonth,
              product: p,
              unweightedAmount: per,
            }),
      })));
      const allOk = responses.every(r => r.ok);
      if (!allOk) {
        const firstFail = responses.find(r => !r.ok);
        const status = firstFail?.status ?? 0;
        const msg = status === 403
          ? "Not allowed to edit this Manager Estimate"
          : status === 400
            ? "Invalid value"
            : `Save failed (HTTP ${status})`;
        setError(msg);
        draftDirtyRef.current = false;
        setSavedTick(t => t + 1);
      } else {
        draftDirtyRef.current = false;
        setSavedTick(t => t + 1);
        onSaved?.();
      }
    } catch (e) {
      console.error("ME upsert failed", e);
      setError("Network error saving Manager Estimate");
      draftDirtyRef.current = false;
      setSavedTick(t => t + 1);
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
    if (e.key === "Escape") {
      draftDirtyRef.current = false;
      setDraft(String(Math.round(total)));
      (e.target as HTMLInputElement).blur();
    }
  };

  const scopeLabel = products && products.length > 0 ? "all in-scope products" : product;
  const helpText = error
    ? error
    : canEdit
      ? `Your unweighted Manager Estimate for ${scopeLabel} • ${monthYyyymm.slice(0, 4)}-${monthYyyymm.slice(4)}`
      : isFlm
        ? "Sign in mapped to a hierarchy name to edit your Manager Estimate"
        : `Read-only aggregate across visible FLMs (${rows.length}) — edit per-FLM via the funnel drilldown`;

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="grid grid-cols-[1fr_92px_64px_1fr_70px_70px] items-center gap-2 py-1.5 text-[12px] bg-amber-50/40 dark:bg-amber-900/10">
        <div className="truncate" title="Manager Estimate">
          <div className="font-medium flex items-center gap-1.5" style={{ color: ACCENT }}>
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
            <span>Manager Estimate</span>
          </div>
          <div
            className={`text-[9px] leading-tight truncate ${error ? "text-[#EF4444] font-medium" : "text-[#94a3b8]"}`}
            title={helpText}
          >
            {helpText}
          </div>
        </div>
        <div className="flex items-center justify-center gap-1">
          <input
            type="number"
            value={100}
            disabled
            title="Manager Estimate has no editable stage default"
            className="w-[58px] text-right text-[12px] tabular-nums px-1.5 py-0.5 rounded border border-[#e2e8f0] bg-[#f8fafc] text-[#64748b] cursor-not-allowed"
          />
          <span className="text-[#64748b]">%</span>
        </div>
        <div
          className="text-center tabular-nums font-medium"
          style={{ color: ACCENT }}
          title="Rolled up from per-rep × product Manager Estimate probabilities edited in the scheduled-mods drilldown."
        >
          {currentPct.toFixed(0)}%
        </div>
        <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
          <div className="h-full transition-all rounded-full" style={{ width: `${barPct}%`, backgroundColor: ACCENT }} />
        </div>
        <div className="text-right tabular-nums">
          {canEdit ? (
            <input
              type="text"
              inputMode="numeric"
              value={loading ? "…" : draft}
              disabled={loading || saving}
              onChange={e => { draftDirtyRef.current = true; setDraft(e.target.value); }}
              onBlur={commit}
              onKeyDown={onKeyDown}
              className="w-[64px] text-right text-[12px] tabular-nums px-1.5 py-0.5 rounded border bg-white border-[#cbd5e1] focus:outline-none focus:ring-1 focus:ring-[#EF4444] disabled:opacity-60"
              title={helpText}
            />
          ) : (
            <span style={{ color: ACCENT }} title={helpText}>{fmtMrrShort(total)}</span>
          )}
        </div>
        <div
          className="text-right tabular-nums font-semibold"
          style={{ color: ACCENT }}
          title="Weighted = sum of per-rep × product unweighted Manager Estimate × that slice's probability."
        >
          {fmtMrrShort(weightedTotal)}
        </div>
      </div>
      {/* Task #192: per-product sub-rows beneath the parent — mirrors the
          Scheduled Mod / CC Decline parent+sub-rows pattern in the
          aggregate Churn drilldown. Task #193: hidden when `collapsed`. */}
      {perProduct && !collapsed && perProduct.map(p => {
        const cur = Math.max(0, Math.min(100, p.currentPct));
        return (
          <div
            key={`me-sub-${p.product}`}
            className="grid grid-cols-[1fr_92px_64px_1fr_90px_90px] items-center gap-2 py-1 pl-4 text-[11px] bg-amber-50/20 dark:bg-amber-900/5"
          >
            <div className="truncate flex items-center gap-1.5" title={displayProduct(p.product)}>
              <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: p.color }} />
              <span style={{ color: p.color }} className="font-medium">{displayProduct(p.product)}</span>
            </div>
            <div className="text-center tabular-nums text-[#475569]">100%</div>
            <div className="text-center tabular-nums text-[#475569]">{cur.toFixed(0)}%</div>
            <div>
              <div className="h-1.5 bg-black/5 rounded overflow-hidden">
                <div className="h-full rounded" style={{ width: `${cur}%`, backgroundColor: p.color }} />
              </div>
            </div>
            <div className="text-right tabular-nums text-[#475569]">{fmtMrrShort(p.unw)}</div>
            <div className="text-right tabular-nums font-medium" style={{ color: p.color }}>{fmtMrrShort(p.w)}</div>
          </div>
        );
      })}
    </div>
  );
};
