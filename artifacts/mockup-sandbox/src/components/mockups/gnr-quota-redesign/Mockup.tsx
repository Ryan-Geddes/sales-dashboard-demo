// Quota card redesign — Both mode (MRR Added + Churn). v2.
// - Header has a Both/MRR/Churn segmented toggle (purple-line annotation).
// - Right-side $/$ labels split: $MRR/$Goal sits ABOVE the MRR bar,
//   $Churn/$Goal sits BELOW the churn bar (red-line annotation).
// - Bars carry the attainment $ in white text inside the colored fill,
//   with "$X beat" (lime) when actual beats goal and "$X gap" (amber)
//   when it falls short — pinned right inside the bar (orange-line
//   annotation). The right-side % column is removed.

const formatCurrencyShort = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
};
const fmtCur = (n: number) => `$${formatCurrencyShort(n)}`;

const PRODUCT_COLORS: Record<string, string> = {
  "MBP": "#006AFF",
  "Follow Up Boss": "#EAB308",
  "Showcase": "#FF6B35",
  "Zillow Pro": "#7C3AED",
};

// Fixed semantic bar colors.
const MRR_BAR_COLOR = "#00C49F";   // green
const CHURN_BAR_COLOR = "#EF4444"; // red

// Variance label palette — dark for legibility on both colored fills and the
// gray track. (User: "really dark green / really dark red" was preferred.)
const BEAT_COLOR = "#14532d"; // green-900
const GAP_COLOR  = "#7f1d1d"; // red-900

type Row = {
  product: string;
  mrrActual: number;
  mrrGoal: number;
  churnActual: number;
  churnGoal: number;
};

// "Beat" / "Gap" semantics:
//   For MRR (more is better): actual >= goal → beat; else gap.
//   For Churn (less is better): actual <= goal → beat; else gap.
function variance(
  actual: number,
  goal: number,
  flavor: "mrr" | "churn"
): { label: string; color: string } | null {
  if (goal <= 0) return null;
  const diff = actual - goal;
  const isBeat = flavor === "mrr" ? diff >= 0 : diff <= 0;
  const magnitude = Math.abs(diff);
  if (magnitude < 1) return null;
  return {
    label: `${fmtCur(magnitude)} ${isBeat ? "beat" : "gap"}`,
    color: isBeat ? BEAT_COLOR : GAP_COLOR,
  };
}

function MetricBar({
  actual,
  goal,
  flavor,
  height,
  position,
}: {
  actual: number;
  goal: number;
  flavor: "mrr" | "churn";
  height: string;
  position: "top" | "bottom";
}) {
  const fillColor = flavor === "mrr" ? MRR_BAR_COLOR : CHURN_BAR_COLOR;
  const hasGoal = goal > 0;
  const pct = hasGoal ? (actual / goal) * 100 : (actual > 0 ? 100 : 0);
  const fillPct = Math.min(100, Math.max(0, pct));
  const v = variance(actual, goal, flavor);

  return (
    <div className={`${height} bg-gray-100 relative overflow-hidden ${position === "bottom" ? "border-t border-white" : ""}`}>
      <div
        className="absolute inset-y-0 left-0 transition-all"
        style={{ width: `${fillPct}%`, backgroundColor: fillColor }}
      />
      {/* Attainment $ in white, pinned left inside the bar, clipped to fill. */}
      {actual > 0 && (
        <div
          className="absolute inset-y-0 left-0 overflow-hidden pointer-events-none"
          style={{ width: `${Math.max(fillPct, 0)}%` }}
        >
          <div className="h-full flex items-center pl-1.5 text-[10px] font-semibold text-white tabular-nums whitespace-nowrap leading-none">
            {fmtCur(actual)}
          </div>
        </div>
      )}
      {/* Variance sits in an invisible column just to the right of the
          attainment numbers (fixed left offset = same column for every row,
          regardless of fill width or attainment length). */}
      {v && (
        <div className="absolute inset-y-0 left-[68px] flex items-center pointer-events-none">
          <span
            className="text-[10px] font-semibold tabular-nums whitespace-nowrap leading-none"
            style={{ color: v.color }}
          >
            {v.label}
          </span>
        </div>
      )}
    </div>
  );
}

// Right-side attainment %. Logic + color thresholds + font match the
// Acquisitions Quota view in the live PipelineView (renderBar):
//   MRR:   pct >= 80 = green, >= 50 = orange, else red.
//   Churn: pct <  50 = green, <  80 = orange, else red.
//   zero-goal-with-actual: MRR -> green (100%), Churn -> red (100%).
function AttainmentPct({
  actual,
  goal,
  flavor,
}: { actual: number; goal: number; flavor: "mrr" | "churn" }) {
  const absActual = Math.abs(actual);
  const absGoal = Math.abs(goal);
  if (absActual === 0 && absGoal === 0) {
    return <span className="text-[11px] font-semibold text-[#94a3b8] whitespace-nowrap">—</span>;
  }
  const isChurn = flavor === "churn";
  const zeroGoalWithActual = absGoal === 0 && absActual > 0;
  const pct = absGoal > 0 ? (absActual / absGoal) * 100 : (zeroGoalWithActual ? 100 : 0);
  let color = "#EF4444"; // red
  if (isChurn) {
    if (zeroGoalWithActual) color = "#EF4444";
    else if (pct < 50) color = "#00C49F";
    else if (pct < 80) color = "#FF6B35";
  } else {
    if (zeroGoalWithActual) color = "#00C49F";
    else if (pct >= 80) color = "#00C49F";
    else if (pct >= 50) color = "#FF6B35";
  }
  return (
    <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color }}>
      {pct.toFixed(0)}%
    </span>
  );
}

function DualBar({ row, isTotal = false }: { row: Row; isTotal?: boolean }) {
  const headerColor = isTotal ? "#0f172a" : (PRODUCT_COLORS[row.product] || "#64748b");
  const barH = isTotal ? "h-4" : "h-4";
  const labelTextSize = isTotal ? "text-[14px]" : "text-[12px]";

  return (
    <div className="flex-1 min-w-0">
      {/* Top line: product name (left) | $MRR / $MRRGoal (right, aligned with MRR bar) */}
      <div className={`flex justify-between items-baseline gap-2 ${labelTextSize} mb-0.5`}>
        <span className="font-semibold truncate" style={{ color: headerColor }}>
          {row.product}
        </span>
        <span className="text-[11px] font-semibold text-[#0f172a] tabular-nums whitespace-nowrap">
          {fmtCur(row.mrrActual)} / {fmtCur(row.mrrGoal)}
        </span>
      </div>

      {/* Stacked dual bars + small right-side % column for attainment. */}
      <div className="flex items-stretch gap-2">
        <div className="flex-1 min-w-0 overflow-hidden rounded-md border border-gray-200">
          <MetricBar actual={row.mrrActual}   goal={row.mrrGoal}   flavor="mrr"   height={barH} position="top" />
          <MetricBar actual={row.churnActual} goal={row.churnGoal} flavor="churn" height={barH} position="bottom" />
        </div>
        <div className="flex flex-col justify-between items-end w-9 tabular-nums leading-none">
          <AttainmentPct actual={row.mrrActual}   goal={row.mrrGoal}   flavor="mrr" />
          <AttainmentPct actual={row.churnActual} goal={row.churnGoal} flavor="churn" />
        </div>
      </div>

      {/* Bottom line: $Churn / $ChurnGoal aligned right with churn bar */}
      <div className="flex justify-end mt-0.5">
        <span className="text-[11px] font-semibold text-[#64748b] tabular-nums whitespace-nowrap">
          {fmtCur(row.churnActual)} / {fmtCur(row.churnGoal)}
        </span>
      </div>
    </div>
  );
}

// Slim vertical "By Rep" affordance — visual only in this mockup.
function ByRepBtn({ color }: { color: string }) {
  return (
    <button
      type="button"
      aria-label="View by Rep"
      title="View by Rep"
      className="flex-shrink-0 self-stretch rounded transition-all duration-300 ease-out flex items-center justify-center overflow-hidden cursor-pointer w-1.5 hover:w-1/5 opacity-50 hover:opacity-100"
      style={{ backgroundColor: color }}
    />
  );
}

function ModeToggle({ value }: { value: "Both" | "MRR" | "Churn" }) {
  const items: Array<"Both" | "MRR" | "Churn"> = ["Both", "MRR", "Churn"];
  return (
    <div className="inline-flex rounded-md border border-[#e2e8f0] overflow-hidden text-[10px] font-semibold">
      {items.map(it => (
        <button
          key={it}
          type="button"
          className={`px-2 py-0.5 transition-colors ${
            it === value
              ? "bg-[#0f172a] text-white"
              : "bg-white text-[#64748b] hover:bg-[#f1f5f9]"
          }`}
        >
          {it}
        </button>
      ))}
    </div>
  );
}

export function Mockup() {
  const total: Row = {
    product: "All Products",
    mrrActual: 535_000,
    mrrGoal: 465_900,
    churnActual: 42_000,
    churnGoal: 50_000,
  };
  const products: Row[] = [
    { product: "Showcase",       mrrActual: 103_200, mrrGoal: 101_500, churnActual: 14_000, churnGoal: 20_000 },
    { product: "MBP",            mrrActual: 424_000, mrrGoal: 364_400, churnActual: 25_000, churnGoal: 28_000 },
    { product: "Zillow Pro",     mrrActual:   7_800, mrrGoal:       0, churnActual:  3_000, churnGoal:  2_000 },
    { product: "Follow Up Boss", mrrActual:       0, mrrGoal:       0, churnActual:      0, churnGoal:      0 },
  ];

  return (
    <div className="min-h-screen bg-[#f8fafc] p-4 font-sans text-[#1e293b]">
      <div className="max-w-[500px] mx-auto">
        <div className="bg-white rounded-md border border-[#e2e8f0] min-h-[510px]">
          {/* Header */}
          <div className="px-4 pt-4 pb-2 flex items-center gap-2">
            <div className="text-[16px] font-semibold">Quota</div>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#eff6ff] text-[#1d4ed8]">
              April 2026
            </span>
            <span className="text-[11px] text-[#64748b] inline-flex items-center gap-1">
              <span className="w-3 h-3 inline-block">↗</span> SF Report
            </span>
            <div className="ml-auto">
              <ModeToggle value="Both" />
            </div>
          </div>

          {/* Total row */}
          <div className="px-4 pb-3">
            <div className="flex items-stretch gap-2">
              <ByRepBtn color="#0f172a" />
              <DualBar row={total} isTotal />
            </div>
          </div>

          {/* Per-product rows */}
          <div className="px-4 pb-4 pt-3 space-y-3 border-t border-[#e2e8f0]">
            {products.map(p => (
              <div key={p.product} className="flex items-stretch gap-2">
                <ByRepBtn color={PRODUCT_COLORS[p.product] || "#64748b"} />
                <DualBar row={p} />
              </div>
            ))}
          </div>
        </div>

        {/* Caption */}
        <div className="mt-3 text-[10px] text-[#64748b] leading-relaxed">
          <div className="font-semibold text-[#334155] mb-1">Both-mode redesign · v6</div>
          <div>Right-side attainment % now uses the exact same logic, font (text-[11px] font-semibold) and color thresholds as the Acquisitions Quota view in the live PipelineView (green ≥80 / orange ≥50 / red MRR; inverted for churn).</div>
        </div>
      </div>
    </div>
  );
}
