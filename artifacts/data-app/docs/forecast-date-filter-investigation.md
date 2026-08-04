# Forecast Card: Date Filter Behavior Investigation

_Task #169 — Snapshot date: post-#168 merge (windowed prorate-remaining goal card)._
_All file:line references are against `artifacts/data-app/src/components/views/PipelineView.tsx` unless noted._

---

## 1. Inputs feeding the Forecast card

| Display value | Variable | Source line | Formula |
|---|---|---|---|
| Weighted Pipeline | `forecastAmt` | `:3897` | `= activeTotalWeighted` (sum of mode-aware weighted Closed-Won + active-stage weighted pipeline across products in `activeProductSet`) |
| Pipeline Coverage | `coverage` | `:3913` | `= activeTotalWeighted / |forecastGoal|` |
| Forecast % | `forecastPct` | `:3902` | `= (forecastAmt / |forecastGoal|) × 100` |
| Win Rate to Hit | `winRateToHit` | `:3912` | `= (forecastRemaining / activeTotalWeighted) × 100`, where `forecastRemaining = max(0, forecastGoal − activeTotalMrrForQuota)` |
| 3.5× Coverage milestone (denominator on the bar) | `forecastGoal × 3.5` | bar render, `:5840–5907` | uses same `forecastGoal` |
| MTD Closed Won (booked) | `activeTotalMrrForQuota` | `:3112` | sum of `p.mrr` across products in `activeProductSet` (per-product MRR comes from `allProductQuotas`) |
| Projected | `activeTotalMrrForQuota + activeTotalWeighted` | tile renders | (visible in expanded card / drilldown) |
| **Goal (forecast denominator)** | `forecastGoal` | `:3900` | `= prorateQuota ? activeTotalGoalRemaining : activeTotalGoal` — **hard-wired to Remaining-mode goal**, see §5 |

The Acquisition Forecast card uses the same code path; `mrrMode === "acqNet"` only changes which CW values feed `selectCwForMode` upstream and which 3.5× target row is highlighted. Both cards converge on the same `forecastGoal`, `forecastPct`, `coverage`, `winRateToHit` formulas.

GNR Both renders two Forecast cards side-by-side; they both flow through the same `forecastGoal` derivation, with `grossProductSplit` (`:3141+`) supplying split MRR-Added vs Churn-only goals via the same `prorate(...)` helper.

---

## 2. Date-filter behavior per input

| Input | Reacts to filter? | How |
|---|---|---|
| `activeTotalWeighted` (Pipeline) | **Yes** | Stage rows in `weightedData` are summed from upstream pipeline data already filtered by `closeDate ∈ range` server-side. CW-in-pipeline portion uses `selectCwForMode(cwMtd)` for current-month MTD or filter-window CW for past/custom ranges. |
| `activeTotalMrrForQuota` (MTD CW) | **Yes** | Pulled from `allProductQuotas[].mrr`, which uses the same windowed CW summation as the Goal card (`cwMtd` → MTD; `cwByMonth` for fully-covered past months; `cwDaysByMonth` summed segment for partial past months). |
| `activeTotalGoal` (full-month goal) | **Pacing-prorated only** | When `prorateQuota=true`, this becomes the time-share goal `monthlyGoal × bizdays_in_window / bizdays_in_month` per slot, summed across `monthSlots`. When `prorateQuota=false`, it stays the raw monthly goal sum (filter ignored). |
| `activeTotalGoalRemaining` (the one Forecast actually uses) | **Yes via `floorRemainingAlways`** | `:3028` — `floorRemainingAlways(bag)` sums `Σ_month max(0, goalInWindow − closed)` across the breakdown bag. This **does honor the filter window** (via the bag's per-slot `goalInWindow` and `closed` values) but **does NOT use the new windowed L[anchor]×bizdays formula** added by #168. See §7 for the resulting incoherence. |
| `forecastGoal × 3.5` | Same as `forecastGoal` | Inherits filter behavior from `forecastGoal`. |

The exact predicate for "in window" is the same one used everywhere: `getDateRange(filters.timeframe, filters.customRange)` (`lib/utils.ts:128+`) → `from`/`to` ISO strings → matched against opportunity `closeDate` for CW and active stage rows. Goal proration uses `monthSlots` (`:1756+`), the per-month decomposition of that range.

---

## 3. Mode coverage

| MRR mode | Forecast card honors filter? | Notes |
|---|---|---|
| GNR Net (default) | Yes | Standard path. `selectCwForMode` returns the GNR Net CW bucket. |
| Gross MRR (Added) | Yes | `prorate(g)` in the Both/Gross split path (`:3157+`). For Gross-only goals, the `closed` bag entry is treated as 0 in `prorateNetGoalCore` (so "Remaining" mode for Gross simply equals goalInWindow — no scaling-down). |
| Acquisition Net | Yes | Same code path; `mrrMode === "acqNet"` switches CW selection + 3.5× target row only. |
| Churn-only | Yes (with sign quirk) | Goal is negative; `forecastPct` and `coverage` use `|forecastGoal|` so the bar reads positive. `forecastExceeded` (`:3909`) has a sign-aware branch (`activeTotalMrrForQuota > forecastGoal` for negative goals = "beat the churn target"). |
| GNR Both | Yes | Renders Net and Gross sides; both use the same `forecastGoal` derivation against their respective bags. The gross side's per-product goals are computed via `prorate(...)` on raw MRR-Added/Churn goals. |

**No mode skips the filter.** All MRR modes flow through the same windowed `monthSlots` proration when `prorateQuota=true`.

---

## 4. Aggregation coverage (Rep / FLM / SLM / All)

The Forecast card renders at the currently-selected aggregation level. Aggregation flows through `processedData` (a useMemo over the `reps` slice), which is already scoped by the group/team filter.

**Per-rep flooring quirk parallel to the Goal card:**
- `productGoalsRemaining[prod]` (`:3028`) is computed via `floorRemainingAlways(bag)` which floors `max(0, goalInWindow − closed)` per **month entry** in an already-aggregated bag. So at the aggregate level the floor is per-(product, month) — not per-rep — meaning Forecast does NOT have the per-rep overperformer-inflation bug that Goal had pre-#162.
- However, this is also NOT the same as the new #168 "no aggregate floor" behavior. `floorRemainingAlways` still clips negative remaining to zero per (product, month). `floorRemainingFromBag` (Goal card, post-#168) does not. **So overperforming products on the team level deflate the Goal but not the Forecast denominator.**
- At per-rep grain (Rep drilldown), the per-rep contribution is already floored at `:2101` (`Math.max(0, goalInWindow − subtractable)`). Forecast inherits this floored value when summing across reps within an aggregate.

---

## 5. Interaction with the Quota Mode toggle (Pacing vs Remaining)

**Hard-wired to Remaining, confirmed:**
```ts
// :3898–3900
// Task #162: Forecast card always uses Remaining-mode goal so
// forecastPct/coverage/winRateToHit are toggle-invariant.
const forecastGoal = prorateQuota ? activeTotalGoalRemaining : activeTotalGoal;
```

`activeTotalGoalRemaining` (`:3116`) sums `productGoalsRemaining[p]` for products in `activeProductSet`. `productGoalsRemaining` is built unconditionally via `floorRemainingAlways` regardless of `quotaMode`/`effectiveQuotaMode`. So toggling Pacing↔Remaining never changes the Forecast denominator — only the Goal card moves.

**Visual hint when toggle disagrees:** A small purple `R` badge is rendered on the "Win Rate to Hit" tile (`:5853–5855`) with the tooltip: _"Forecast hard-wired to Remaining-mode goal"_. The expanded-card formula footnote (`:5554`) restates this: _"the Forecast card always uses Remaining-mode goal regardless of this toggle."_

**After the #168 windowed-Goal-card work, this hard-wiring still holds — but the underlying Remaining-mode math diverges between the two cards.** See §7.

---

## 6. Edge cases

| Filter | What the Forecast card shows |
|---|---|
| **Fully past month** (e.g. April 1–30, today = May 14) | `activeTotalGoalRemaining` = `Σ products max(0, monthly_goal − full_month_CW)` for that past month. CW values come from `cwByMonth` (full-month bucket). Effectively shows "did April hit goal?" — non-zero only if the past month under-performed. *Note:* The Goal card falls back to Pacing in this case (`quotaWindow.kind === "fallback-pacing"`), so the displayed Goal will be the full month's pacing-prorated value (= full month goal × 1.0), while Forecast's denominator stays the floored remaining. **These will disagree for any past month that was hit (Goal=full, Forecast denom=0).** |
| **Future-only filter** (e.g. June 1–30) | `subtractable` = 0 in `prorateNetGoalCore`. `goalInWindow` = full June goal × pacing factor (= 1.0 for full month). Forecast denom = `max(0, full_June_goal − 0)` = full June goal. Pipeline weighted is whatever has `closeDate ∈ June`. Coverage/forecast% reflect "what % of June goal is covered by June pipeline". |
| **Range spanning today** (e.g. May 1–31, today = May 14) | Standard MTD case. `quotaWindow` is `windowed` with `effectiveStart=May 1`, `effectiveEnd=May 31`, `anchor=May 14`. Goal card uses `L[May 14] × 21 bizdays` (pace-adjusted). Forecast denom uses `max(0, May_monthly_goal − May_MTD_CW)` — the **classic** Remaining formula. **These disagree by the L-pace adjustment.** |
| **Crosses month boundary** (e.g. April 20 – May 10) | `monthSlots` has two entries. April slot is past-month-partial (uses `cwDaysByMonth` summed segment). May slot is current-month-partial (`anchor = max(today, eff_start)`, but since today=May 14 > May 10 = effEnd, anchor falls back to `effStart`). Forecast denom sums `max(0, goalInWindow − closed)` across both slots. Goal card on the May slot uses `L[anchor]×bizdays`; on the April slot it falls through to `goalInWindow − closed` signed. |
| **"Last Month" preset** (April 1–30) | Same as fully-past-month above. Goal card falls back to Pacing; Forecast keeps Remaining math. |
| **Multi-month custom range** (e.g. March 1 – May 14) | `monthSlots` has 3 entries. Forecast sums `max(0, goalInWindow − closed)` per month. Goal card uses windowed-L on May only and signed remainder on March/April. |
| **Filter with zero business days** (e.g. weekend-only custom range) | `quotaWindow.kind = "fallback-pacing"`, Goal toggle disabled, Goal card shows pacing-prorated value (≈ 0 because pacingFactor ≈ 0). Forecast denom = `max(0, monthly_goal − closed_in_zero_bizday_window)` = full monthly goal (closed=0). **Forecast goal will be huge; Goal will be ~0.** |

---

## 7. Identified incoherences

The biggest one is **post-#168**:

1. **Goal card uses `L[anchor]×bizdays` (pace-adjusted), Forecast denominator uses `max(0, goalInWindow − closed)` (classic).** When a date filter sits in the current month, the two cards now report different "Goal" numbers. Example with windowed range May 1–14, monthly goal $100k, MTD CW $40k:
   - Goal card (post-#168): `L[May 14] × 10 bizdays` ≈ pace-adjusted required pace × window — could be e.g. `$5k × 10 = $50k`.
   - Forecast denom: `max(0, $100k − $40k) = $60k`. Forecast %, coverage, win-rate-to-hit all anchor on $60k.
   - User sees **two different "Goal" values on the same screen** depending on which card they look at.

2. **No "no-floor" parallel for Forecast.** #168 stripped the per-rep `max(0, …)` floor from Goal aggregates so overperformers reduce team buckets. Forecast still uses `floorRemainingAlways` which floors per (product, month). Net effect: an overperforming product (e.g. Showcase already over its monthly goal) zeros out of the Forecast denominator but contributes negative to the Goal denominator. **Goal can be lower than Forecast denom for the same window.**

3. **Past-month filter divergence** (described in §6 row 1). Goal falls back to Pacing (= full-month goal because pacingFactor=1.0); Forecast stays on Remaining (= max(0, goal − full-CW), often = 0). For any past month that was hit, the Goal card shows the original goal as the bar denominator but the Forecast card shows `forecastPct` / `coverage` / `winRateToHit` as if there's nothing left to do. This is technically correct ("the past month is decided") but the side-by-side framing is confusing.

4. **Fallback-pacing window with zero bizdays** (§6 last row): Goal ≈ $0, Forecast Goal = full monthly. The disabled-Remaining tooltip on Goal doesn't extend to Forecast — there's no UI signal that Forecast is showing a wildly different denominator.

5. **Toggle-invariance "R" badge is only on Win Rate to Hit tile.** The Pipeline Coverage and Forecast % tiles use the same hard-wired denominator but don't show the badge or tooltip. Users may not realize all three derive from the same Remaining-mode goal.

6. **`forecastExceeded` uses `forecastGoal` not `quotaExceeded`** (`:3909`, intentional per #162). This is correct under unfiltered current-month but reads strangely under past-month filters — the bar can show "exceeded" even when the Goal card shows under-attainment in Pacing mode.

---

## Recommended options for follow-up

Three candidate behaviors the user can pick from for the implementation task:

**Option A — Mirror Goal card exactly under windowed filters.**
- Replace `floorRemainingAlways` with the same `floorRemainingFromBag` logic (or a forecast-specific variant): when `quotaWindow.kind === "windowed"`, compute the Forecast denom from `L[anchor] × bizdays`. When `fallback-pacing`, fall back to Pacing-windowed goal.
- Pros: Goal and Forecast cards always agree on "Goal".
- Cons: Forecast `winRateToHit` becomes pace-adjusted, which changes its meaning ("close X% of pipeline by anchor day to maintain pace"). Loses the simple "remaining-to-hit-monthly-goal" narrative.

**Option B — Keep Forecast independent but make the divergence explicit in the UI.**
- Leave Forecast on classic `max(0, monthly_goal − MTD_CW)` for current-month filters.
- Add a tooltip / inline note on the Forecast card whenever Goal and Forecast denominators diverge (windowed remaining, past-month filters, no-floor cases) explaining why.
- Pros: Forecast stays asking the simple "what win rate gets me to monthly goal" question.
- Cons: Two-Goal confusion isn't eliminated, just labeled.

**Option C — Add a Forecast-card sub-toggle: "Anchor to monthly goal" vs "Anchor to filter window".**
- Default to "Anchor to monthly goal" (current behavior).
- When user picks "Anchor to filter window", route Forecast through the same windowed/pace math as Goal.
- Pros: User controls the framing per session.
- Cons: Yet another toggle on a card that already has many.

Recommendation: **Option A** if the user accepts redefining `winRateToHit` as a pace-anchored metric, otherwise **Option B** as the lower-risk path.
