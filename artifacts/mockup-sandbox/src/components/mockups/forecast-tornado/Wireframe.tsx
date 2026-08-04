type ProductRow = {
  product: string;
  color: string;
  booked: number;
  weighted: number;
  goal: number;
};

const formatCurrencyShort = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
};
const fmtCur = (n: number) => `$${formatCurrencyShort(n)}`;

const lightenHex = (hex: string, amt: number) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lr = Math.round(r + (255 - r) * amt);
  const lg = Math.round(g + (255 - g) * amt);
  const lb = Math.round(b + (255 - b) * amt);
  return `#${lr.toString(16).padStart(2, "0")}${lg.toString(16).padStart(2, "0")}${lb.toString(16).padStart(2, "0")}`;
};

const colorFor = (pct: number) => {
  if (pct >= 80) return "#00C49F";
  if (pct >= 50) return "#FF6B35";
  return "#EF4444";
};

function computeSide(actual: number, goal: number, breakdown?: { showcase: number; sci: number } | null) {
  const absA = Math.abs(actual);
  const absG = Math.abs(goal);
  const pct = absG > 0 ? (absA / absG) * 100 : 0;
  const barColor = colorFor(pct);
  const exceeded = absA >= absG && absG > 0;
  const diff = Math.abs(absA - absG);
  const sciAbs = breakdown ? Math.abs(breakdown.sci) : 0;
  const scAbs = breakdown ? Math.abs(breakdown.showcase) : 0;
  const hasBreak = !!breakdown && sciAbs > 0 && absG > 0;
  const scPctRaw = hasBreak ? (scAbs / absG) * 100 : 0;
  const sciPctRaw = hasBreak ? (sciAbs / absG) * 100 : 0;
  const tot = scPctRaw + sciPctRaw;
  const scClamp = hasBreak ? (tot > 100 ? (scPctRaw / tot) * 100 : scPctRaw) : 0;
  const sciClamp = hasBreak ? (tot > 100 ? (sciPctRaw / tot) * 100 : sciPctRaw) : 0;
  const SCI_BAR_COLOR = lightenHex(barColor, 0.55);
  const fillW = Math.min(100, Math.max(0, pct));
  return { absA, absG, pct, barColor, exceeded, diff, sciAbs, scAbs, hasBreak, scClamp, sciClamp, SCI_BAR_COLOR, fillW };
}

function TornadoForecastRow({ row, breakdownLeft, breakdownRight }: {
  row: ProductRow;
  breakdownLeft?: { showcase: number; sci: number } | null;
  breakdownRight?: { showcase: number; sci: number } | null;
}) {
  const L = computeSide(row.booked, row.goal, breakdownLeft ?? null);
  const R = computeSide(row.weighted, row.goal, breakdownRight ?? null);
  const headerColor = row.color;
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-baseline text-[10px] mb-0.5">
        <div className="flex-1 min-w-0 flex items-baseline gap-1">
          <span className="font-medium truncate" style={{ color: headerColor }}>
            {row.product}
          </span>
          <span className="text-[#64748b] whitespace-nowrap tabular-nums ml-auto">
            {fmtCur(L.absA)} / {fmtCur(L.absG)}
          </span>
        </div>
        <div className="w-px mx-1" />
        <div className="flex-1 min-w-0 flex items-baseline gap-1">
          <span className="text-[#64748b] whitespace-nowrap tabular-nums">
            {fmtCur(R.absA)} / {fmtCur(R.absG)}
          </span>
          <span className="font-medium truncate ml-auto text-right" style={{ color: headerColor }}>
            {row.product}
          </span>
        </div>
      </div>
      <div className="flex items-center">
        <span className="text-[9px] font-semibold tabular-nums whitespace-nowrap mr-1 w-9 text-right" style={{ color: L.barColor }}>
          {L.pct.toFixed(0)}%
        </span>
        <div className="flex-1 h-2 bg-gray-200 rounded-l-full overflow-hidden flex justify-end">
          {L.hasBreak ? (
            <div className="h-full flex" style={{ width: `${Math.min(100, L.scClamp + L.sciClamp)}%` }}>
              <div className="h-full" style={{ width: `${(L.sciClamp / Math.max(0.0001, L.scClamp + L.sciClamp)) * 100}%`, backgroundColor: L.SCI_BAR_COLOR }} />
              <div className="h-full" style={{ width: `${(L.scClamp / Math.max(0.0001, L.scClamp + L.sciClamp)) * 100}%`, backgroundColor: L.barColor }} />
            </div>
          ) : (
            <div className="h-full" style={{ width: `${L.fillW}%`, backgroundColor: L.barColor }} />
          )}
        </div>
        <div className="w-px h-3 bg-gray-400 mx-px" />
        <div className="flex-1 h-2 bg-gray-200 rounded-r-full overflow-hidden">
          {R.hasBreak ? (
            <div className="h-full flex" style={{ width: `${Math.min(100, R.scClamp + R.sciClamp)}%` }}>
              <div className="h-full" style={{ width: `${(R.scClamp / Math.max(0.0001, R.scClamp + R.sciClamp)) * 100}%`, backgroundColor: R.barColor }} />
              <div className="h-full" style={{ width: `${(R.sciClamp / Math.max(0.0001, R.scClamp + R.sciClamp)) * 100}%`, backgroundColor: R.SCI_BAR_COLOR }} />
            </div>
          ) : (
            <div className="h-full" style={{ width: `${R.fillW}%`, backgroundColor: R.barColor }} />
          )}
        </div>
        <span className="text-[9px] font-semibold tabular-nums whitespace-nowrap ml-1 w-9" style={{ color: R.barColor }}>
          {R.pct.toFixed(0)}%
        </span>
      </div>
      <div className="flex text-[9px] text-[#94a3b8] mt-0.5">
        <div className="flex-1 min-w-0 truncate">
          {L.exceeded ? <span className="text-green-600">{fmtCur(L.diff)} over</span> : <>{fmtCur(L.diff)} gap</>}
        </div>
        <div className="w-px mx-1" />
        <div className="flex-1 min-w-0 truncate text-right">
          {R.exceeded ? <span className="text-green-600">{fmtCur(R.diff)} over</span> : <>{fmtCur(R.diff)} gap</>}
        </div>
      </div>
    </div>
  );
}

export function Wireframe() {
  const totalGoal = 1_250_000;
  const totalBooked = 980_000;
  const totalWeighted = 2_350_000;

  const products: ProductRow[] = [
    { product: "Showcase",            color: "#006AFF", booked: 540_000, weighted: 1_420_000, goal: 700_000 },
    { product: "Premier Agent Direct", color: "#7C3AED", booked: 220_000, weighted:   480_000, goal: 280_000 },
    { product: "Connections Plus",     color: "#00C49F", booked: 130_000, weighted:   240_000, goal: 160_000 },
    { product: "Tech Connect",         color: "#F59E0B", booked:  65_000, weighted:    140_000, goal: 80_000 },
    { product: "ShowingTime+",         color: "#EF4444", booked:  25_000, weighted:    70_000, goal: 30_000 },
  ];

  const totalL = computeSide(totalBooked, totalGoal);
  const totalR = computeSide(totalWeighted, totalGoal);
  const coverage = totalWeighted / totalGoal;

  return (
    <div className="min-h-screen bg-[#f8fafc] p-6 font-sans text-[#1e293b]">
      <div className="max-w-[640px] mx-auto">
        <div className="mb-3 text-[10px] uppercase tracking-wider text-[#64748b] font-semibold">
          Wireframe — Forecast w/ G&amp;R Tornado Logic
        </div>

        <div className="bg-white rounded-md border border-[#e2e8f0] shadow-sm">
          {/* Header */}
          <div className="px-4 pt-4 pb-2 flex items-center gap-2">
            <div className="text-[16px] font-semibold">Forecast</div>
          </div>

          {/* TOTAL FORECAST tornado */}
          <div className="px-4 pb-3">
            <div className="flex justify-between text-[12px] mb-1">
              <span className="font-semibold">Forecast</span>
              <span className="text-[10px] text-[#64748b]">
                Coverage:{" "}
                <span className="font-semibold" style={{ color: coverage >= 1 ? "#006AFF" : "#FF6B35" }}>
                  {coverage.toFixed(1)}x
                </span>
              </span>
            </div>

            {/* Inline column labels above the tornado */}
            <div className="flex items-baseline text-[10px] mb-0.5 text-[#64748b]">
              <div className="flex-1 min-w-0 flex items-baseline gap-1">
                <span className="font-medium uppercase tracking-wide text-[9px]">Booked</span>
                <span className="ml-auto whitespace-nowrap tabular-nums">{fmtCur(totalBooked)} / {fmtCur(totalGoal)}</span>
              </div>
              <div className="w-px mx-1" />
              <div className="flex-1 min-w-0 flex items-baseline gap-1">
                <span className="whitespace-nowrap tabular-nums">{fmtCur(totalWeighted)} / {fmtCur(totalGoal)}</span>
                <span className="ml-auto font-medium uppercase tracking-wide text-[9px] text-right">Weighted Pipeline</span>
              </div>
            </div>

            {/* Big tornado bar (taller than per-product) */}
            <div className="flex items-center">
              <span className="text-[10px] font-semibold tabular-nums whitespace-nowrap mr-1 w-10 text-right" style={{ color: totalL.barColor }}>
                {totalL.pct.toFixed(0)}%
              </span>
              <div className="flex-1 h-4 bg-gray-100 rounded-l-full overflow-hidden flex justify-end relative">
                <div
                  className="absolute inset-0 opacity-[0.07] rounded-l-full"
                  style={{ background: `repeating-linear-gradient(45deg, transparent, transparent 4px, #94a3b8 4px, #94a3b8 5px)` }}
                />
                <div className="h-full relative z-10" style={{ width: `${totalL.fillW}%`, backgroundColor: totalL.barColor }} />
              </div>
              {/* Center axis = 1x quota */}
              <div className="relative w-px h-6 bg-[#1e293b] mx-px" title="1x Quota" />
              <div className="flex-1 h-4 bg-gray-100 rounded-r-full overflow-hidden relative">
                <div
                  className="absolute inset-0 opacity-[0.07] rounded-r-full"
                  style={{ background: `repeating-linear-gradient(45deg, transparent, transparent 4px, #94a3b8 4px, #94a3b8 5px)` }}
                />
                {/* 3.5x marker on right side; right tornado side represents 0..(3.5x-1x)=2.5x of quota.
                    So % displayed (Weighted/Goal) maps onto right side fill = pct/250 (clamp). */}
                <div className="h-full relative z-10" style={{ width: `${Math.min(100, (totalR.pct / 250) * 100)}%`, backgroundColor: totalR.pct >= 350 ? "#00C49F" : totalR.pct >= 100 ? "#006AFF" : "#FF6B35" }} />
                {/* 3.5x marker line near right edge (at 100% of right side = 2.5x of quota past center = 3.5x total) */}
                <div className="absolute top-0 bottom-0 right-0 w-px bg-[#94a3b8]" title="3.5x Target" />
              </div>
              <span className="text-[10px] font-semibold tabular-nums whitespace-nowrap ml-1 w-10" style={{ color: totalR.pct >= 100 ? "#006AFF" : "#FF6B35" }}>
                {totalR.pct.toFixed(0)}%
              </span>
            </div>

            {/* Axis labels below total tornado */}
            <div className="relative mt-0.5 text-[9px] text-[#94a3b8]" style={{ height: 12 }}>
              <div className="absolute left-[calc(50%-20px)]">1x</div>
              <div className="absolute right-10">3.5x</div>
            </div>

            {/* Footer line under total tornado */}
            <div className="flex text-[9px] text-[#94a3b8] mt-1">
              <div className="flex-1 min-w-0 truncate">
                {totalL.exceeded ? <span className="text-green-600">{fmtCur(totalL.diff)} over quota booked</span> : <>{fmtCur(totalL.diff)} to quota</>}
              </div>
              <div className="w-px mx-1" />
              <div className="flex-1 min-w-0 truncate text-right">
                {coverage >= 3.5
                  ? <span className="text-green-600">Exceeds 3.5x target</span>
                  : <>{(3.5 - coverage).toFixed(1)}x to 3.5x</>}
              </div>
            </div>
          </div>

          {/* Per-product tornado list */}
          <div className="space-y-2 border-t border-[#e2e8f0] px-4 pt-3 pb-3">
            {products.map((p, idx) => (
              <div key={p.product} className="rounded-md -mx-1 px-1 py-0.5">
                <TornadoForecastRow
                  row={p}
                  breakdownLeft={idx === 0 ? { showcase: 380_000, sci: 160_000 } : null}
                  breakdownRight={idx === 0 ? { showcase: 980_000, sci: 440_000 } : null}
                />
              </div>
            ))}
          </div>

          {/* Bottom KPI strip — kept as-is for context */}
          <div className="grid grid-cols-3 gap-4 border-t border-[#e2e8f0] px-4 py-3">
            <div className="text-center">
              <div className="text-[11px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Win Rate to Hit</div>
              <div className="text-[20px] font-bold" style={{ color: "#FF6B35" }}>11%</div>
            </div>
            <div className="text-center border-l border-[#e2e8f0]">
              <div className="text-[11px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Pipeline Coverage</div>
              <div className="text-[20px] font-bold" style={{ color: "#006AFF" }}>{coverage.toFixed(1)}x</div>
            </div>
            <div className="text-center border-l border-[#e2e8f0]">
              <div className="text-[11px] uppercase tracking-[0.5px] text-[#64748b] mb-1">Total Weighted</div>
              <div className="text-[20px] font-bold text-[#006AFF]">{fmtCur(totalWeighted)}</div>
            </div>
          </div>
        </div>

        {/* Legend / explainer */}
        <div className="mt-3 text-[10px] text-[#64748b] leading-relaxed">
          <div className="font-semibold text-[#334155] mb-1">Tornado mapping (left | right)</div>
          <div>
            <span className="font-medium">Left:</span> Booked MRR vs Quota. Fills toward center; 100% = quota fully booked.
          </div>
          <div>
            <span className="font-medium">Right:</span> Weighted Pipeline vs Quota. Fills outward from center; right edge = 3.5x target.
          </div>
          <div>Center axis = 1x quota. Showcase row keeps the SC/SCI breakdown segments on each side.</div>
        </div>
      </div>
    </div>
  );
}
