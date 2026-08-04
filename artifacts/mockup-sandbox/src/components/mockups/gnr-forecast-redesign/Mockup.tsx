// Forecast card redesign — Both mode. v2.
// - TOP KPI strip: each tile shows MRR (top row) AND Churn (bottom row),
//   per the green-X annotation.
// - Per-product rows: 4 metrics above the MRR bar (existing) AND a matching
//   4 metrics BELOW the churn bar (new), per the green-line annotation.
// - Heights/spacing aligned with the Quota redesign mockup so headers and
//   product sections line up across the two cards.

const formatCurrencyShort = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
};
const fmtCur = (n: number) => `$${formatCurrencyShort(n)}`;
const fmtSignedGap = (g: number) => g >= 0 ? `$${formatCurrencyShort(g)}` : `-$${formatCurrencyShort(Math.abs(g))}`;

const PRODUCT_COLORS: Record<string, string> = {
  "MBP": "#006AFF",
  "Follow Up Boss": "#EAB308",
  "Showcase": "#FF6B35",
  "Zillow Pro": "#7C3AED",
};

const TARGET_MULTIPLE = 3.5;
const MRR_DOT = "#006AFF";
const CHURN_DOT = "#EF4444";

type ForecastRow = {
  product: string;
  // MRR-add forecast
  mrrGoal: number;
  mrrBooked: number;
  mrrWeighted: number;
  // Churn forecast
  churnGoal: number;
  churnBooked: number;
  churnWeighted: number;
};

// MRR: more is better. Negative gap (weighted > goal) is good (green),
// positive gap (weighted < goal) is bad (red).
function mrrGapColor(gap: number) {
  if (gap > 0) return "#EF4444";
  if (gap < 0) return "#10B981";
  return "#64748b";
}
// Churn: less is better. Negative gap (weighted > goal) is bad (red),
// positive gap (weighted < goal) is good (green).
function churnGapColor(gap: number) {
  if (gap > 0) return "#10B981";
  if (gap < 0) return "#EF4444";
  return "#64748b";
}

function ForecastBar({
  goal,
  weighted,
  flavor,
  position,
}: { goal: number; weighted: number; flavor: "mrr" | "churn"; position: "top" | "bottom" }) {
  const isMrr = flavor === "mrr";
  const multiple = goal > 0 ? weighted / goal : 0;
  const exceeds = multiple > TARGET_MULTIPLE;
  const fillPct = exceeds ? 100 : Math.max(0, (multiple / TARGET_MULTIPLE) * 100);
  const quotaMarkerPct = Math.min(100, (1 / TARGET_MULTIPLE) * 100);

  const mrrColor = exceeds ? "#00C49F" : multiple >= 1 ? "#006AFF" : "#FF6B35";
  const churnColor = goal > 0
    ? (multiple <= 1 ? "#00C49F" : multiple <= TARGET_MULTIPLE ? "#FF6B35" : "#EF4444")
    : "#94a3b8";
  const fillColor = isMrr ? mrrColor : churnColor;

  const targetLabel = goal > 0 ? `${TARGET_MULTIPLE}x ${fmtCur(Math.abs(goal) * TARGET_MULTIPLE)}` : `${TARGET_MULTIPLE}x $0`;
  const attainmentLabel = fmtCur(Math.abs(weighted));

  return (
    <div className={`relative h-4 w-full overflow-hidden bg-gray-100 ${position === "bottom" ? "border-t border-white" : ""}`}>
      <div
        className="absolute inset-0 opacity-[0.07] pointer-events-none"
        style={{ background: `repeating-linear-gradient(45deg, transparent, transparent 4px, #94a3b8 4px, #94a3b8 5px)` }}
      />
      <div
        className="absolute top-0 bottom-0 left-0 h-full transition-all"
        style={{ width: `${fillPct}%`, backgroundColor: fillColor }}
      />
      {weighted > 0 && (
        <div
          className="absolute top-0 bottom-0 left-0 overflow-hidden pointer-events-none"
          style={{ width: `${Math.min(50, fillPct)}%` }}
        >
          <div className="h-full flex items-center pl-1.5 text-[10px] font-semibold text-white tabular-nums whitespace-nowrap leading-none">
            {attainmentLabel}
          </div>
        </div>
      )}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-[#1e293b]/40"
        style={{ left: `${quotaMarkerPct}%` }}
        title="1x Quota"
      />
      <div className="absolute top-0 bottom-0 right-0 flex items-center pr-1.5 pointer-events-none">
        <span className="text-[10px] font-semibold tabular-nums whitespace-nowrap leading-none text-[#1e293b]/55">
          {targetLabel}
        </span>
      </div>
    </div>
  );
}

// Compact 4-up metrics row, used both above MRR and below Churn.
function MetricsRow({
  goal,
  booked,
  weighted,
  flavor,
}: {
  goal: number;
  booked: number;
  weighted: number;
  flavor: "mrr" | "churn";
}) {
  const isMrr = flavor === "mrr";
  const multiple = goal > 0 ? weighted / goal : 0;
  const wrToHit = goal > 0 && weighted > 0 && booked < goal
    ? Math.max(0, ((goal - booked) / weighted) * 100)
    : 0;
  const gap = goal - weighted;

  const coverageColor = isMrr
    ? (multiple > TARGET_MULTIPLE ? "#10B981" : multiple >= 1 ? "#006AFF" : "#FF6B35")
    : (multiple <= 1 ? "#10B981" : multiple <= TARGET_MULTIPLE ? "#FF6B35" : "#EF4444");
  const weightedColor = isMrr ? "#006AFF" : "#EF4444";
  const gapColor = isMrr ? mrrGapColor(gap) : churnGapColor(gap);

  return (
    <div className="grid grid-cols-4 gap-2 text-[12px] font-semibold tabular-nums">
      <div className="text-center" style={{ color: "#FF6B35" }} title="Win Rate to Hit">
        {wrToHit.toFixed(0)}%
      </div>
      <div className="text-center" style={{ color: coverageColor }} title="Coverage">
        {multiple.toFixed(1)}x
      </div>
      <div className="text-center" style={{ color: weightedColor }} title="Weighted">
        {fmtCur(weighted)}
      </div>
      <div className="text-center" style={{ color: gapColor }} title="Gap (Quota − Weighted)">
        {fmtSignedGap(gap)}
      </div>
    </div>
  );
}

// Product short codes — used as a small text label above each product's
// metrics block. Same font as Quota's product label (text-[12px] font-semibold,
// colored to the product accent), and rendered on its OWN row so the metric
// grid below stays centered under the TOTAL strip headers.
const PRODUCT_ABBREV: Record<string, string> = {
  "Showcase": "SC",
  "MBP": "MBP",
  "Zillow Pro": "ZPRO",
  "Follow Up Boss": "FUB",
};

function ByRepBtn({ color }: { color: string }) {
  return (
    <button
      type="button"
      aria-label="View by Rep"
      title="View by Rep"
      className="flex-shrink-0 self-stretch rounded transition-all duration-300 ease-out flex items-center justify-center overflow-hidden cursor-pointer w-1.5 hover:w-1/3 opacity-50 hover:opacity-100"
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
  // TOTAL strip metrics — MRR (top) and Churn (bottom) per tile.
  const total = {
    mrrGoal: 465_900,
    mrrBooked: 535_000,
    mrrWeighted: 673_200,
    churnGoal: 50_000,
    churnBooked: 42_000,
    churnWeighted: 53_700,
  };
  const totalMrrCoverage = total.mrrWeighted / total.mrrGoal;
  const totalMrrGap = total.mrrGoal - total.mrrWeighted;
  const totalMrrWr = Math.max(0, ((total.mrrGoal - total.mrrBooked) / total.mrrWeighted) * 100);

  const totalChurnCoverage = total.churnWeighted / total.churnGoal;
  const totalChurnGap = total.churnGoal - total.churnWeighted;
  const totalChurnWr = Math.max(0, ((total.churnGoal - total.churnBooked) / total.churnWeighted) * 100);

  const products: ForecastRow[] = [
    {
      product: "Showcase",
      mrrGoal: 101_500,  mrrBooked:  103_200, mrrWeighted: 156_500,
      churnGoal: 20_000, churnBooked: 14_000, churnWeighted: 18_500,
    },
    {
      product: "MBP",
      mrrGoal: 364_400,  mrrBooked: 424_000, mrrWeighted: 506_900,
      churnGoal: 28_000, churnBooked: 25_000, churnWeighted: 31_000,
    },
    {
      product: "Zillow Pro",
      mrrGoal:      0,   mrrBooked:   7_800, mrrWeighted:  9_800,
      churnGoal:  2_000, churnBooked:  3_000, churnWeighted: 4_200,
    },
    {
      product: "Follow Up Boss",
      mrrGoal: 0,        mrrBooked: 0,       mrrWeighted: 0,
      churnGoal: 0,      churnBooked: 0,     churnWeighted: 0,
    },
  ];

  return (
    <div className="min-h-screen bg-[#f8fafc] p-4 font-sans text-[#1e293b]">
      <div className="max-w-[500px] mx-auto">
        <div className="bg-white rounded-md border border-[#e2e8f0] min-h-[510px]">
          {/* Header — same height/structure as Quota mockup */}
          <div className="px-4 pt-4 pb-2 flex items-center gap-2">
            <div className="text-[16px] font-semibold">Forecast</div>
            <span className="text-[11px] text-[#64748b] inline-flex items-center gap-1">
              <span className="w-3 h-3 inline-block">↗</span> SF Report
            </span>
            <div className="ml-auto">
              <ModeToggle value="Both" />
            </div>
          </div>

          {/* TOTAL strip — MRR row + Churn row inside each tile.
              Sized to match the overall vertical height of the Quota
              "All Products" section (title + dual bars + bottom $) so the
              per-product rows below line up across both cards. py-4 + gap-1
              between the two value rows grows the strip to match Quota.
              Wrapped in a flex+ByRepBtn to mirror Quota's All Products row. */}
          <div className="px-4 py-4 border-b border-[#e2e8f0]">
           <div className="flex items-stretch gap-2">
            <ByRepBtn color="#0f172a" />
            <div className="grid grid-cols-4 gap-2 flex-1">
            {/* Win Rate to Hit */}
            <div className="flex flex-col items-center text-center px-1">
              <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] leading-tight">Win Rate to Hit</div>
              <div className="flex flex-col items-center mt-1 gap-1">
                <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: MRR_DOT }} />
                  <span style={{ color: "#FF6B35" }}>{totalMrrWr.toFixed(0)}%</span>
                </div>
                <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: CHURN_DOT }} />
                  <span style={{ color: "#FF6B35" }}>{totalChurnWr.toFixed(0)}%</span>
                </div>
              </div>
            </div>
            {/* Coverage */}
            <div className="flex flex-col items-center text-center px-1 border-l border-[#e2e8f0]">
              <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] leading-tight">Coverage</div>
              <div className="flex flex-col items-center mt-1 gap-1">
                <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: MRR_DOT }} />
                  <span style={{ color: "#006AFF" }}>{totalMrrCoverage.toFixed(1)}x</span>
                </div>
                <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: CHURN_DOT }} />
                  <span style={{ color: totalChurnCoverage <= 1 ? "#10B981" : totalChurnCoverage <= TARGET_MULTIPLE ? "#FF6B35" : "#EF4444" }}>
                    {totalChurnCoverage.toFixed(1)}x
                  </span>
                </div>
              </div>
            </div>
            {/* Total Weighted */}
            <div className="flex flex-col items-center text-center px-1 border-l border-[#e2e8f0]">
              <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] leading-tight">Total Weighted</div>
              <div className="flex flex-col items-center mt-1 gap-1">
                <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1 text-[#006AFF]">
                  <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: MRR_DOT }} />
                  {fmtCur(total.mrrWeighted)}
                </div>
                <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1 text-[#EF4444]">
                  <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: CHURN_DOT }} />
                  {fmtCur(total.churnWeighted)}
                </div>
              </div>
            </div>
            {/* Gap */}
            <div className="flex flex-col items-center text-center px-1 border-l border-[#e2e8f0]">
              <div className="text-[10px] uppercase tracking-[0.5px] text-[#64748b] leading-tight">Gap</div>
              <div className="flex flex-col items-center mt-1 gap-1">
                <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: MRR_DOT }} />
                  <span style={{ color: mrrGapColor(totalMrrGap) }}>{fmtSignedGap(totalMrrGap)}</span>
                </div>
                <div className="text-[14px] font-semibold tabular-nums leading-tight flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: CHURN_DOT }} />
                  <span style={{ color: churnGapColor(totalChurnGap) }}>{fmtSignedGap(totalChurnGap)}</span>
                </div>
              </div>
            </div>
            </div>
           </div>
          </div>

          {/* Per-product list — metrics above MRR, abbrev attached to top
              of bar (overlay, doesn't add layout height), bars, then metrics
              below Churn. space-y-3 matches Quota's per-product spacing so
              each product row lines up across the two cards. Each row is
              wrapped in flex+ByRepBtn to mirror Quota's per-product format. */}
          <div className="px-4 pt-3 pb-4 space-y-3">
            {products.map(p => {
              const prodColor = PRODUCT_COLORS[p.product] || "#64748b";
              const abbr = PRODUCT_ABBREV[p.product] || p.product;
              return (
                <div key={p.product} className="flex items-stretch gap-2">
                  <ByRepBtn color={prodColor} />
                  <div className="flex-1 min-w-0 space-y-0.5">
                    {/* MRR metrics ABOVE MRR bar — full width, centered under TOTAL headers */}
                    <MetricsRow goal={p.mrrGoal} booked={p.mrrBooked} weighted={p.mrrWeighted} flavor="mrr" />
                    {/* Bars block is wrapped in a `relative` div so we can
                        anchor the product-abbreviation "tab" just above the
                        top edge of the MRR bar. The tab is absolute-positioned
                        with -translate-y-full so it sits entirely above the
                        bar (no overlap with the bar's fill) — still an overlay
                        that does not contribute to layout height or shift the
                        bars horizontally. */}
                    <div className="relative">
                      <span
                        className="absolute top-0 left-1.5 -translate-y-full z-10 px-1 text-[11px] font-semibold leading-none bg-white pointer-events-none"
                        style={{ color: prodColor }}
                      >
                        {abbr}
                      </span>
                      <div className="rounded-md overflow-hidden border border-gray-200">
                        <ForecastBar goal={p.mrrGoal}   weighted={p.mrrWeighted}   flavor="mrr"   position="top" />
                        <ForecastBar goal={p.churnGoal} weighted={p.churnWeighted} flavor="churn" position="bottom" />
                      </div>
                    </div>
                    {/* Churn metrics BELOW Churn bar — same full-width grid */}
                    <MetricsRow goal={p.churnGoal} booked={p.churnBooked} weighted={p.churnWeighted} flavor="churn" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Caption */}
        <div className="mt-3 text-[10px] text-[#64748b] leading-relaxed">
          <div className="font-semibold text-[#334155] mb-1">Both-mode redesign · v8</div>
          <div>Restored the slim vertical "by rep" affordance on the left of every section, mirroring Quota: gray for the TOTAL header, and product color (Showcase orange / MBP blue / Zillow Pro purple / FUB yellow) for each per-product row. Each strip is `self-stretch`, so it grows to match the full vertical height of its product section (metrics-above + bars + metrics-below). Card height is still locked to min-h-[510px].</div>
        </div>
      </div>
    </div>
  );
}
