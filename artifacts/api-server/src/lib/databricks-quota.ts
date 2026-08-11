import { logger } from "./logger";
import { executeStatement } from "./databricks-client";
import { snapshotCtxActive, isReplayActive } from "./snapshot-context";
import { fetchGnrGoalsFromSheet, applyGnrSheetOverride, clearGnrGoalsSheetCache } from "./gnr-goals-sheet";
import { bumpDataVersion } from "./cache-version";
import { currentDate } from "./demo-mode";

const WAREHOUSE_ID = "ac4f2677b84273dc";
const CACHE_TTL_MS = 30 * 60 * 1000;

interface QuotaRow {
  performancePeriod: string;
  employeeName: string;
  employeeId: string;
  group: string;
  scStartingBook: number;
  scEndingGoal: number;
  scNetMrrGoal: number;
  scChurnGoal: number;
  scMrrAddedGoal: number;
  mbpStartingBook: number;
  mbpEndingGoal: number;
  mbpNetMrrGoal: number;
  mbpChurnGoal: number;
  mbpMrrAddedGoal: number;
  scSingleMonthGoal: number;
  mbpSingleMonthGoal: number;
  singleMonthRamping: string;
  singleMonthRampingPps: string;
  scLiveMrrQuota: number;
  mbpLiveMrrQuota: number;
}

/**
 * Per-product GnR goal triple. `netGoal` is derived (added + signed lost) and
 * only meaningful for products that have a net quota today (Showcase, MBP).
 */
export interface ProductGoal {
  mrrAddedGoal: number;
  churnGoal: number;
  netGoal: number;
}

export interface RepQuota {
  showcaseQuota: number;
  mbpQuota: number;
  totalQuota: number;
  scNetMrrGoal: number;
  mbpNetMrrGoal: number;
  totalNetMrrGoal: number;
  scChurnGoal: number;
  mbpChurnGoal: number;
  scMrrAddedGoal: number;
  mbpMrrAddedGoal: number;
  // Per-product, data-driven goal map keyed by canonical product name (the
  // same names shown in the dashboard Products filter). Today only Showcase +
  // MBP are populated; every other product is absent and reads 0 downstream.
  productGoals: Record<string, ProductGoal>;
  group: string;
}

/** Minimal scalar goal shape shared by every quota source (Databricks rows and
 *  the G&R sheet) — both expose these six fields, so one builder serves both. */
export interface ProductGoalSource {
  scMrrAddedGoal: number;
  scChurnGoal: number;
  scNetMrrGoal: number;
  mbpMrrAddedGoal: number;
  mbpChurnGoal: number;
  mbpNetMrrGoal: number;
}

/**
 * Build the per-product GnR goal map from a quota source row.
 *
 * THE SINGLE EXTENSION POINT for per-product goals. Every quota source
 * (Databricks + G&R sheet) funnels through here, and everything downstream
 * (server payload + frontend aggregation) iterates the returned map. When
 * finance supplies GnR MRR-Added + Churn goals for a new canonical product,
 * add its source fields to ProductGoalSource and one entry here; no other code
 * change is required. Products absent from this map read 0 everywhere.
 */
export function buildProductGoals(src: ProductGoalSource): Record<string, ProductGoal> {
  return {
    Showcase: {
      mrrAddedGoal: src.scMrrAddedGoal,
      churnGoal: src.scChurnGoal,
      netGoal: src.scNetMrrGoal,
    },
    MBP: {
      mrrAddedGoal: src.mbpMrrAddedGoal,
      churnGoal: src.mbpChurnGoal,
      netGoal: src.mbpNetMrrGoal,
    },
  };
}

export interface QuotasByMonth {
  current: Record<string, RepQuota>;
  lastMonth: Record<string, RepQuota>;
  currentMonthHasData: boolean;
  fetchError: boolean;
  fetchErrorMessage?: string;
}

let cachedQuotas: QuotasByMonth | null = null;
let quotaCacheTime = 0;
let lastNightlyError: string | null = null;
let lastNightlyFallbackWarning: string | null = null;

const QUERY = `SELECT
  \`Performance Period\`,
  \`Employee For Lookup\`,
  \`Employee ID\`,
  \`Group\`,

  -- gnr sc
    -- Book Goals
    \`Monthly Showcase Starting Book MRR\`,
    \`Showcase Ending MRR Goal\`,
    -- Net goal
    \`Showcase Ending MRR Goal\` - \`Monthly Showcase Starting Book MRR\` as sc_net_mrr_goal,
    -- Churn goal
    \`Showcase Churn %\` * \`Monthly Showcase Starting Book MRR\` as gnr_sc_churn_goal,
    -- MRR added goal
    \`Showcase Regional Avg MRR Added\` as gnr_sc_mrr_added_goal,

  -- gnr mbp
    -- Book Goals
    \`Monthly MBP Starting Book MRR\`,
    \`MBP Ending MRR Goal\`,
    -- Net goal
    \`MBP Ending MRR Goal\` - \`Monthly MBP Starting Book MRR\` as mbp_net_mrr_goal,
    -- Churn goal
    \`MBP Churn Goal\` as gnr_mbp_churn_goal,
    -- MRR added goal
    \`MBP MRR Added Goal\` as gnr_mbp_mrr_added_goal,

  -- acq
  \`Showcase Current Month Single Month Goal\`,
  \`MBP Current Month Single Month Goal\`,
  \`Single Month Ramping?\`,
  \`Single Month Ramping for PPS\`,
  \`Showcase Live MRR Quota\`,
  \`MBP Live MRR Quota\`
FROM finance.ipfo_anaplan_bronze.pa_pps
WHERE \`Performance Period\` IN (
    DATE_TRUNC('month', CURRENT_DATE()),
    ADD_MONTHS(DATE_TRUNC('month', CURRENT_DATE()), -1)
  )
  AND \`Group\` IN ('G&R', 'Acquisition')`;

export function clearQuotaCache() {
  cachedQuotas = null;
  quotaCacheTime = 0;
  // G&R goals sheet feeds into quotas; keep cache lifecycles aligned so a
  // manual refresh picks up the latest sheet edits too.
  clearGnrGoalsSheetCache();
  bumpDataVersion();
}

export function getLastQuotaError(): string | null {
  return lastNightlyError;
}

export function clearLastQuotaError(): void {
  lastNightlyError = null;
}

export function getLastQuotaFallbackWarning(): string | null {
  return lastNightlyFallbackWarning;
}

export function clearLastQuotaFallbackWarning(): void {
  lastNightlyFallbackWarning = null;
}

async function fetchQuotaStatement() {
  return executeStatement(QUERY, {
    warehouseId: WAREHOUSE_ID,
    onAuthFallback: (msg) => {
      lastNightlyFallbackWarning = msg;
    },
  });
}

export async function fetchQuotas(
  employeeIdToName: Record<string, string>,
  repToGroup?: Record<string, string>,
): Promise<QuotasByMonth> {
  const now = Date.now();
  if (!snapshotCtxActive() && cachedQuotas && now - quotaCacheTime < CACHE_TTL_MS)
    return cachedQuotas;

  try {
    const data = await fetchQuotaStatement();

    const rows: QuotaRow[] = (data.result?.data_array || []).map((r) => ({
      performancePeriod: r[0],
      employeeName: r[1],
      employeeId: r[2],
      group: r[3] || "",
      scStartingBook: parseFloat(r[4]) || 0,
      scEndingGoal: parseFloat(r[5]) || 0,
      scNetMrrGoal: parseFloat(r[6]) || 0,
      scChurnGoal: parseFloat(r[7]) || 0,
      scMrrAddedGoal: parseFloat(r[8]) || 0,
      mbpStartingBook: parseFloat(r[9]) || 0,
      mbpEndingGoal: parseFloat(r[10]) || 0,
      mbpNetMrrGoal: parseFloat(r[11]) || 0,
      mbpChurnGoal: parseFloat(r[12]) || 0,
      mbpMrrAddedGoal: parseFloat(r[13]) || 0,
      scSingleMonthGoal: parseFloat(r[14]) || 0,
      mbpSingleMonthGoal: parseFloat(r[15]) || 0,
      singleMonthRamping: r[16] || "",
      singleMonthRampingPps: r[17] || "",
      scLiveMrrQuota: parseFloat(r[18]) || 0,
      mbpLiveMrrQuota: parseFloat(r[19]) || 0,
    }));

    const currentMonth = currentDate().toISOString().slice(0, 7);
    const lastMonth = (() => {
      const d = currentDate();
      d.setMonth(d.getMonth() - 1);
      return d.toISOString().slice(0, 7);
    })();
    const current: Record<string, RepQuota> = {};
    const last: Record<string, RepQuota> = {};
    let matched = 0;
    let unmatched = 0;

    for (const row of rows) {
      const periodMonth = row.performancePeriod.slice(0, 7);
      if (periodMonth !== currentMonth && periodMonth !== lastMonth) continue;

      const normalizedId = row.employeeId.replace(/^0+/, "") || row.employeeId;
      const repName = employeeIdToName[row.employeeId] || employeeIdToName[normalizedId];
      if (!repName) {
        unmatched++;
        continue;
      }

      const hierarchyGroup = repToGroup?.[repName] || "";
      const isAcq = hierarchyGroup === "Acquisitions";
      const quota: RepQuota = {
        showcaseQuota: isAcq ? row.scSingleMonthGoal : row.scNetMrrGoal,
        mbpQuota: isAcq ? row.mbpSingleMonthGoal : row.mbpNetMrrGoal,
        totalQuota: isAcq
          ? row.scSingleMonthGoal + row.mbpSingleMonthGoal
          : row.scNetMrrGoal + row.mbpNetMrrGoal,
        scNetMrrGoal: row.scNetMrrGoal,
        mbpNetMrrGoal: row.mbpNetMrrGoal,
        totalNetMrrGoal: row.scNetMrrGoal + row.mbpNetMrrGoal,
        scChurnGoal: row.scChurnGoal,
        mbpChurnGoal: row.mbpChurnGoal,
        scMrrAddedGoal: row.scMrrAddedGoal,
        mbpMrrAddedGoal: row.mbpMrrAddedGoal,
        productGoals: buildProductGoals(row),
        group: row.group,
      };

      matched++;
      if (periodMonth === currentMonth) {
        current[repName] = quota;
      } else {
        last[repName] = quota;
      }
    }

    logger.info({ matched, unmatched, totalRows: rows.length }, "[Quotas] Databricks quota fetch complete");

    // G&R goal source override (May 2026): replace every G&R rep's quota
    // with values from the dedicated Google Sheet. Acquisition reps stay on
    // Databricks. If the sheet fetch fails, the override is skipped and
    // Databricks values remain so the dashboard never goes blank.
    if (repToGroup) {
      try {
        const gnrGoals = await fetchGnrGoalsFromSheet();
        const stats = applyGnrSheetOverride(current, last, repToGroup, gnrGoals, currentMonth, lastMonth);
        logger.info({ ...stats, sheetFetchError: gnrGoals.fetchError }, "[Quotas] G&R sheet override");
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[Quotas] G&R sheet override failed — keeping Databricks values for G&R");
      }
    }

    const currentMonthHasData = Object.values(current).some(q => q.totalQuota !== 0);
    const result: QuotasByMonth = { current, lastMonth: last, currentMonthHasData, fetchError: false };
    if (!isReplayActive()) {
      cachedQuotas = result;
      quotaCacheTime = now;
      bumpDataVersion();
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[Quotas] Failed to fetch quotas from Databricks");
    if (cachedQuotas) {
      // Surface the fresh failure on top of stale cache so the UI can warn
      // the user that the latest fetch failed.
      return { ...cachedQuotas, fetchError: true, fetchErrorMessage: msg };
    }
    return {
      current: {},
      lastMonth: {},
      currentMonthHasData: false,
      fetchError: true,
      fetchErrorMessage: msg,
    };
  }
}

export async function runNightlyQuotaRefresh(
  employeeIdToName: Record<string, string>,
  repToGroup?: Record<string, string>,
): Promise<void> {
  logger.info("[Quotas] Running nightly quota refresh...");
  lastNightlyError = null;
  lastNightlyFallbackWarning = null;
  clearQuotaCache();

  try {
    const result = await fetchQuotas(employeeIdToName, repToGroup);
    const count = Object.keys(result.current).length + Object.keys(result.lastMonth).length;
    if (count === 0) {
      lastNightlyError = "Nightly quota refresh returned 0 matched reps — Databricks query may have returned empty results or all employee IDs failed to match.";
      logger.warn(lastNightlyError);
    } else {
      logger.info({ repsWithQuota: count }, "[Quotas] Nightly quota refresh succeeded");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    lastNightlyError = `Nightly quota refresh failed: ${msg}\n\nStack: ${stack || "N/A"}`;
    logger.error({ err: msg }, "[Quotas] Nightly quota refresh failed");
  }
}
