// eRep-multiplier source for the Goals table (Executive → Goals).
//
// Reads `erep_value` from
// `premier_agent.sales_revenue_gold.dim_sales_erep_metrics_daily_snapshot` for
// the current + previous month, keeps the LATEST snapshot per (employee_id,
// month), snapshots the collapsed rows to Postgres (so they survive restarts),
// and caches them in memory on the same ~30m cadence as the live quota query.
//
// The value joins onto a Goals-table row by employee id (zero-padding tolerant)
// and goal month. It is the Databricks-sourced eRep multiplier; the per-row
// MANUAL override (when set) wins. Effective eRep is computed in goals-table.ts
// as `manualOverride ?? databricksValue ?? 1.0`. Mirrors goals-finance-pps.ts.

import { db } from "@workspace/db";
import { goalConfigTable, goalErepRowsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { isDemoMode } from "./demo-mode";
import { executeStatement } from "./databricks-client";
import { normalizeJoinValue } from "./goals-resolvers";

const WAREHOUSE_ID = "ac4f2677b84273dc";
const CACHE_TTL_MS = 30 * 60 * 1000;
const META_KEY = "erepMeta";

// Bounded to snapshots from the start of the previous month onward (current +
// previous month) to mirror the live quota cadence and keep the snapshot small.
const QUERY = `SELECT employee_id, snapshot_date, erep_value
FROM premier_agent.sales_revenue_gold.dim_sales_erep_metrics_daily_snapshot
WHERE snapshot_date >= DATE_TRUNC('month', ADD_MONTHS(DATE_TRUNC('month', CURRENT_DATE()), -1))`;

/** One collapsed eRep observation: the latest snapshot for an (employeeId,
 *  month) pair. `employeeId` is normalized (zero-padding stripped) so it joins
 *  the hierarchy's employee id regardless of formatting. */
export interface ErepRow {
  employeeId: string;
  month: string;
  snapshotDate: string;
  erepValue: number;
}

export interface ErepSnapshot {
  rows: ErepRow[];
  fetchedAt: number | null;
  fetchError: boolean;
  fetchErrorMessage?: string;
}

interface ErepMeta {
  fetchedAt: number;
}

let cache: { snapshot: ErepSnapshot; at: number } | null = null;
let lastRefreshError: string | null = null;
let lastRefreshFallbackWarning: string | null = null;

// --- Pure cadence / contract / collapse helpers (unit-tested) ---

/**
 * A snapshot is "fresh" when it has a fetch time within the cache TTL. Used for
 * both the in-memory cache and the persisted snapshot so a stale snapshot is
 * never served indefinitely — it triggers a Databricks re-query instead.
 */
export function isErepFresh(
  fetchedAt: number | null,
  now: number = Date.now(),
  ttlMs: number = CACHE_TTL_MS,
): boolean {
  return fetchedAt != null && now - fetchedAt < ttlMs;
}

/**
 * The snapshot stores `fetchedAt` as epoch ms internally; the API contract
 * models it as an ISO date-time string. Convert at the boundary.
 */
export function erepFetchedAtIso(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

/** Derive the `YYYY-MM` month key from a raw snapshot_date cell. */
export function erepMonthKey(snapshotDate: string): string {
  return String(snapshotDate ?? "").slice(0, 7);
}

/**
 * Collapse raw daily snapshots to the LATEST row per (normalized employeeId,
 * month). ISO snapshot dates sort lexicographically, so the max string is the
 * most recent. Rows with a blank employee id, an unparseable month, or a
 * non-finite erep_value are dropped.
 */
export function collapseLatestPerMonth(
  raw: Array<{ employeeId: string; snapshotDate: string; erepValue: number }>,
): ErepRow[] {
  const latest = new Map<string, ErepRow>();
  for (const r of raw) {
    const employeeId = normalizeJoinValue(r.employeeId);
    const month = erepMonthKey(r.snapshotDate);
    if (employeeId === "" || month.length !== 7) continue;
    if (!Number.isFinite(r.erepValue)) continue;
    const key = `${employeeId}\u0000${month}`;
    const prev = latest.get(key);
    if (!prev || String(r.snapshotDate) > String(prev.snapshotDate)) {
      latest.set(key, { employeeId, month, snapshotDate: String(r.snapshotDate), erepValue: r.erepValue });
    }
  }
  return [...latest.values()];
}

/**
 * Build the per-month lookup `normalizedEmployeeId → erep_value` for a single
 * goal month from a snapshot.
 */
export function erepMultipliersForMonth(snapshot: ErepSnapshot, month: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of snapshot.rows) {
    if (r.month === month) out.set(r.employeeId, r.erepValue);
  }
  return out;
}

export function clearErepCache(): void {
  cache = null;
}
export function getLastErepError(): string | null {
  return lastRefreshError;
}
export function clearLastErepError(): void {
  lastRefreshError = null;
}
export function getLastErepFallbackWarning(): string | null {
  return lastRefreshFallbackWarning;
}
export function clearLastErepFallbackWarning(): void {
  lastRefreshFallbackWarning = null;
}

// --- Databricks fetch (PAT primary, service-principal OAuth fallback) ---

function parseStatement(data: Awaited<ReturnType<typeof executeStatement>>): ErepRow[] {
  const dataArray = data.result?.data_array || [];
  const raw = dataArray.map((cells) => ({
    employeeId: cells[0] == null ? "" : String(cells[0]),
    snapshotDate: cells[1] == null ? "" : String(cells[1]),
    erepValue: parseFloat(cells[2]),
  }));
  return collapseLatestPerMonth(raw);
}

// --- Persistence ---

async function persistSnapshot(rows: ErepRow[], fetchedAt: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(goalErepRowsTable);
    if (rows.length > 0) {
      const fetchedAtDate = new Date(fetchedAt);
      await tx.insert(goalErepRowsTable).values(
        rows.map((r) => ({
          employeeId: r.employeeId,
          month: r.month,
          snapshotDate: r.snapshotDate,
          erepValue: r.erepValue,
          fetchedAt: fetchedAtDate,
        })),
      );
    }
    const meta: ErepMeta = { fetchedAt };
    await tx
      .insert(goalConfigTable)
      .values({ key: META_KEY, value: meta, updatedByName: "system", updatedByRole: "admin" })
      .onConflictDoUpdate({ target: goalConfigTable.key, set: { value: meta } });
  });
}

async function loadSnapshotFromDb(): Promise<ErepSnapshot | null> {
  const [metaRows, dataRows] = await Promise.all([
    db.select().from(goalConfigTable).where(eq(goalConfigTable.key, META_KEY)).limit(1),
    db.select().from(goalErepRowsTable),
  ]);
  if (metaRows.length === 0 && dataRows.length === 0) return null;
  const meta = (metaRows[0]?.value as ErepMeta | undefined) ?? { fetchedAt: 0 };
  return {
    rows: dataRows.map((r) => ({
      employeeId: r.employeeId,
      month: r.month,
      snapshotDate: r.snapshotDate,
      erepValue: r.erepValue,
    })),
    fetchedAt: meta.fetchedAt || null,
    fetchError: false,
  };
}

/**
 * Re-query Databricks, persist the snapshot, and refresh the in-memory cache.
 * On failure, the persisted snapshot is left intact and the returned snapshot
 * carries `fetchError: true` (falling back to whatever is cached/persisted).
 */
export async function refreshErepSnapshot(): Promise<ErepSnapshot> {
  lastRefreshError = null;
  lastRefreshFallbackWarning = null;
  // Demo mode: rows come from the DB seed and this query is not in the bundled
  // upstream fixture — a "refresh" would clear the seeded rows. Serve the
  // persisted snapshot instead. (See goals-finance-pps.ts for the same guard.)
  if (isDemoMode()) {
    const fromDb = (await loadSnapshotFromDb().catch(() => null)) ?? {
      rows: [],
      fetchedAt: null,
      fetchError: false,
    };
    const snapshot: ErepSnapshot = {
      ...fromDb,
      fetchedAt: fromDb.fetchedAt ?? Date.now(),
      fetchError: false,
    };
    cache = { snapshot, at: Date.now() };
    return snapshot;
  }
  try {
    const data = await executeStatement(QUERY, {
      warehouseId: WAREHOUSE_ID,
      onAuthFallback: (msg) => {
        lastRefreshFallbackWarning = msg;
      },
    });
    const rows = parseStatement(data);
    const fetchedAt = Date.now();
    await persistSnapshot(rows, fetchedAt);
    const snapshot: ErepSnapshot = { rows, fetchedAt, fetchError: false };
    cache = { snapshot, at: fetchedAt };
    logger.info({ rowCount: rows.length }, "[Goals eRep] Snapshot refreshed");
    return snapshot;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastRefreshError = msg;
    logger.error({ err: msg }, "[Goals eRep] Snapshot refresh failed");
    const fallback = (await loadSnapshotFromDb().catch(() => null)) ?? {
      rows: [],
      fetchedAt: null,
      fetchError: true,
    };
    const snapshot: ErepSnapshot = { ...fallback, fetchError: true, fetchErrorMessage: msg };
    // Cache the failure (with the stale rows) so reads back off for a full TTL
    // instead of stampeding Databricks on every request; the next stale read
    // (or a manual refresh) retries.
    cache = { snapshot, at: Date.now() };
    return snapshot;
  }
}

/**
 * Return the current snapshot on the same ~30m cadence as the live quota query.
 * Order: fresh in-memory cache → still-fresh persisted snapshot → re-query
 * Databricks (refresh, which falls back to the persisted snapshot on failure).
 * A persisted snapshot older than the TTL is treated as stale and triggers a
 * refresh rather than being served indefinitely.
 */
export async function getErepSnapshot(force = false): Promise<ErepSnapshot> {
  const now = Date.now();
  if (!force && cache && isErepFresh(cache.at, now)) return cache.snapshot;
  if (!force) {
    const fromDb = await loadSnapshotFromDb().catch(() => null);
    if (fromDb && fromDb.fetchedAt != null && isErepFresh(fromDb.fetchedAt, now)) {
      // Preserve the real fetch time so a stale snapshot can't masquerade as
      // fresh for another full TTL.
      cache = { snapshot: fromDb, at: fromDb.fetchedAt };
      return fromDb;
    }
  }
  return refreshErepSnapshot();
}

/**
 * Boot-time priming: load the persisted snapshot into cache, and if there is
 * none, kick off a refresh in the background. Never throws.
 */
export async function ensureErepSnapshot(): Promise<void> {
  try {
    const fromDb = await loadSnapshotFromDb();
    if (fromDb && fromDb.fetchedAt != null) {
      cache = { snapshot: fromDb, at: fromDb.fetchedAt };
      // If the persisted snapshot is already stale, refresh in the background.
      if (!isErepFresh(fromDb.fetchedAt)) void refreshErepSnapshot();
      return;
    }
    void refreshErepSnapshot();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[Goals eRep] ensureErepSnapshot failed");
  }
}
