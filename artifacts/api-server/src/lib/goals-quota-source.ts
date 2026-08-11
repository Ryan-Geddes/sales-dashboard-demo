// Dashboard goal source — the Goals tab's FINAL output (Task #262 cutover).
//
// This is the upstream goal source for the whole live dashboard (Quota
// Attainment, Forecast, per-product goal bars). For each rep × product × month
// it emits the Goals tab's Final goal (computeFinalGoals over the rep's selected
// Source + manual/eRep multipliers), expanded to all five canonical products
// (Showcase, MBP, Zillow Pro, Follow Up Boss, ZMX).
//
// It replaces the legacy Databricks `buildProductGoals` + G&R-sheet override
// path (databricks-quota.ts / gnr-goals-sheet.ts). To avoid double-counting,
// exactly ONE source runs per request: the dispatcher below picks the Goals tab
// by default, or the legacy path when DASHBOARD_GOALS_SOURCE=legacy (rollback).
//
// Shape parity is deliberate: this module emits the exact same
// QuotasByMonth / RepQuota shape the legacy path produced, so every downstream
// consumer (buildRepQuotaFields, the rep payload, the frontend gnrGoalFor +
// proration) is unchanged by the cutover.

import { logger } from "./logger";
import { bumpDataVersion } from "./cache-version";
import { currentDate } from "./demo-mode";
import { dbScopeKey } from "./demo-session";
import { buildGoalTable, type GoalTableRow } from "./goals-table";
import {
  fetchQuotas,
  type ProductGoal,
  type QuotasByMonth,
  type RepQuota,
} from "./databricks-quota";

const CACHE_TTL_MS = 30 * 60 * 1000;

// Cache is partitioned by DB scope (dbScopeKey) so a demo session's
// uncommitted Goals edits never populate a cache entry served to other
// visitors. Live mode always uses the "" scope — identical behavior to the
// old single-slot cache.
interface CacheEntry {
  cached: QuotasByMonth;
  cacheTime: number;
}
const cacheByScope = new Map<string, CacheEntry>();

/** Drop the cached dashboard quotas so the next request rebuilds from the
 *  Goals tab. Called on manual refresh, nightly, and after any Goals edit. */
export function clearGoalsQuotaCache(): void {
  cacheByScope.clear();
  bumpDataVersion();
}

/**
 * Which source feeds the live dashboard's goals. Defaults to the Goals tab;
 * set DASHBOARD_GOALS_SOURCE=legacy to fall back to the retired Databricks +
 * G&R-sheet quota path (rollback toggle — keeps exactly one source live so
 * goals are never double-counted).
 */
export const DASHBOARD_GOALS_SOURCE: "goalsTab" | "legacy" =
  process.env.DASHBOARD_GOALS_SOURCE === "legacy" ? "legacy" : "goalsTab";

/**
 * A rep is ACQ (Acquisitions channel) when their group resolves to the
 * acquisitions side. The Goals-table path labels this "ACQ" (via the role→group
 * mapping) while the hierarchy path uses "Acquisitions" — match both, case- and
 * spacing-insensitive, by prefix so either representation is recognized.
 */
export function isAcqGroup(group: string | null | undefined): boolean {
  return (group ?? "").trim().toLowerCase().startsWith("acq");
}

function currentMonthYm(): string {
  return currentDate().toISOString().slice(0, 7);
}

function lastMonthYm(): string {
  const d = currentDate();
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
}

/**
 * Reduce one month's Goals-table rows (one per rep × product) into a per-rep
 * RepQuota. Net goal per product = Final MRR Added − Final Churn. The rep's
 * totals (totalQuota / totalNetMrrGoal) sum the net goal across ALL five
 * products — the all-products expansion the cutover introduces. Showcase and
 * MBP also populate the legacy scalar fields the frontend still reads.
 *
 * Exported for unit testing.
 */
export function rowsToRepQuotas(rows: GoalTableRow[]): Record<string, RepQuota> {
  const out: Record<string, RepQuota> = {};
  for (const row of rows) {
    let q = out[row.rep];
    if (!q) {
      q = {
        showcaseQuota: 0,
        mbpQuota: 0,
        totalQuota: 0,
        scNetMrrGoal: 0,
        mbpNetMrrGoal: 0,
        totalNetMrrGoal: 0,
        scChurnGoal: 0,
        mbpChurnGoal: 0,
        scMrrAddedGoal: 0,
        mbpMrrAddedGoal: 0,
        productGoals: {},
        group: row.group,
      };
      out[row.rep] = q;
    }
    // ACQ reps carry NO churn/MRR-Lost goal: ignore it entirely so their
    // net = MRR Added only (no churn goal surfaces on the dashboard for them).
    // GNR net = Added − |Churn|: the feeder sheet expresses the loss as either a
    // positive or an accounting-negative and the format keeps changing, so always
    // subtract the loss MAGNITUDE. The Goals admin tab reads buildGoalTable rows
    // directly (raw finalChurnGoal), so this dashboard-only normalization leaves
    // the admin tab's raw values untouched.
    const isAcq = isAcqGroup(row.group);
    const added = row.finalMrrAddedGoal;
    const churn = isAcq ? 0 : Math.abs(row.finalChurnGoal);
    const net = added - churn;
    const pg: ProductGoal = { mrrAddedGoal: added, churnGoal: churn, netGoal: net };
    q.productGoals[row.product] = pg;
    q.totalQuota += net;
    q.totalNetMrrGoal += net;
    if (row.product === "Showcase") {
      q.showcaseQuota = net;
      q.scNetMrrGoal = net;
      q.scChurnGoal = churn;
      q.scMrrAddedGoal = added;
    } else if (row.product === "MBP") {
      q.mbpQuota = net;
      q.mbpNetMrrGoal = net;
      q.mbpChurnGoal = churn;
      q.mbpMrrAddedGoal = added;
    }
  }
  return out;
}

async function buildFromGoalsTab(eRepOverride = false): Promise<QuotasByMonth> {
  const cm = currentMonthYm();
  const lm = lastMonthYm();
  // Unscoped (no slm/flm/region filter) so every rep gets their goal. The
  // dashboard selects current vs last per the active date filter downstream,
  // and the *ByYm proration maps need both months available.
  // Task #484: eRepOverride forces every rep's effective eRep multiplier to 1.
  const [cur, last] = await Promise.all([
    buildGoalTable({ month: cm, eRepOverride }),
    buildGoalTable({ month: lm, eRepOverride }),
  ]);
  const current = rowsToRepQuotas(cur.rows);
  const lastMonth = rowsToRepQuotas(last.rows);
  const currentMonthHasData = Object.values(current).some((q) => q.totalQuota !== 0);
  logger.info(
    {
      currentReps: Object.keys(current).length,
      lastReps: Object.keys(lastMonth).length,
    },
    "[GoalsQuota] Built dashboard quotas from Goals tab Final output",
  );
  return { current, lastMonth, currentMonthHasData, fetchError: false };
}

/**
 * Dashboard quotas sourced from the Goals tab, cached 30 min (mirrors the
 * legacy fetchQuotas cache lifetime). On failure, surfaces fetchError so the
 * dashboard shows zeros + a warning rather than potentially-stale values —
 * same contract the legacy quota path honored.
 */
export async function fetchGoalsQuotas(eRepOverride = false): Promise<QuotasByMonth> {
  // Task #484: the eReps-override view is transient (always starts off, used
  // occasionally) and must never read or pollute the standard 30-min cache —
  // its numbers force every eRep multiplier to 1. Build fresh every time; the
  // upstream pipeline result cache (keyed on the override flag) absorbs repeat
  // requests, so this does not re-run on every poll.
  if (eRepOverride) {
    try {
      return await buildFromGoalsTab(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "[GoalsQuota] Failed to build eRep-override dashboard quotas");
      return {
        current: {},
        lastMonth: {},
        currentMonthHasData: false,
        fetchError: true,
        fetchErrorMessage: msg,
      };
    }
  }
  const now = Date.now();
  const scope = dbScopeKey();
  const entry = cacheByScope.get(scope);
  if (entry && now - entry.cacheTime < CACHE_TTL_MS) return entry.cached;
  try {
    const result = await buildFromGoalsTab();
    cacheByScope.set(scope, { cached: result, cacheTime: now });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "[GoalsQuota] Failed to build dashboard quotas from Goals tab");
    if (entry) return { ...entry.cached, fetchError: true, fetchErrorMessage: msg };
    return {
      current: {},
      lastMonth: {},
      currentMonthHasData: false,
      fetchError: true,
      fetchErrorMessage: msg,
    };
  }
}

/**
 * The single dashboard quota source, honoring the rollback toggle. Exactly one
 * underlying source runs per call (Goals tab or legacy), so goals are never
 * double-counted.
 */
export async function getDashboardQuotas(
  employeeIdToName: Record<string, string>,
  repToGroup?: Record<string, string>,
  eRepOverride = false,
): Promise<QuotasByMonth> {
  if (DASHBOARD_GOALS_SOURCE === "legacy") {
    // The legacy Databricks/G&R-sheet path has no notion of the Goals-tab eRep
    // multiplier, so the override toggle is a no-op there (nothing to neutralize).
    return fetchQuotas(employeeIdToName, repToGroup);
  }
  return fetchGoalsQuotas(eRepOverride);
}
