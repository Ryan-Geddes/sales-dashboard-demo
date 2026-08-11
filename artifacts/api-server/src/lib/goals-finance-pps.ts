// finance.pps goal source (Executive → Goals).
//
// Reads `select * from sandbox_stplus.sai_analyst.frontline_dash_quota` for the
// current and previous month, snapshots the raw rows to Postgres (so they
// survive restarts), and caches them in memory on the same ~30m cadence as the
// live quota query. Every column is retained so any of them can be exposed for
// inspection or mapped to a goal. This source is independent of today's quota
// pipeline; the live-dashboard cutover is a separate task.

import { db } from "@workspace/db";
import { goalConfigTable, goalFinancePpsRowsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { isDemoMode } from "./demo-mode";
import type { DatabricksStatementResponse } from "./databricks-types";
import { executeStatement } from "./databricks-client";

const WAREHOUSE_ID = "ac4f2677b84273dc";
const CACHE_TTL_MS = 30 * 60 * 1000;
const META_KEY = "financePpsMeta";

// `select *` so any column is available; bounded to the current + previous
// performance period to mirror the live quota cadence and keep the snapshot
// small.
const QUERY = `SELECT * FROM sandbox_stplus.sai_analyst.frontline_dash_quota
WHERE \`Performance Period\` IN (
  DATE_TRUNC('month', CURRENT_DATE()),
  ADD_MONTHS(DATE_TRUNC('month', CURRENT_DATE()), -1)
)`;

// The Databricks Statement API returns column metadata in `manifest.schema`,
// which our minimal shared type omits. Extend it locally for `select *`.
interface StatementWithManifest extends DatabricksStatementResponse {
  manifest?: { schema?: { columns?: { name: string; position?: number }[] } };
}

export interface FinancePpsSnapshot {
  rows: Record<string, string>[];
  columns: string[];
  fetchedAt: number | null;
  fetchError: boolean;
  fetchErrorMessage?: string;
}

interface FinancePpsMeta {
  columns: string[];
  fetchedAt: number;
}

let cache: { snapshot: FinancePpsSnapshot; at: number } | null = null;
let lastRefreshError: string | null = null;

// --- Pure cadence / contract helpers (unit-tested) ---

/**
 * A snapshot is "fresh" when it has a fetch time within the cache TTL. Used for
 * both the in-memory cache and the persisted snapshot so a stale snapshot is
 * never served indefinitely — it triggers a Databricks re-query instead.
 */
export function isFinancePpsFresh(
  fetchedAt: number | null,
  now: number = Date.now(),
  ttlMs: number = CACHE_TTL_MS,
): boolean {
  return fetchedAt != null && now - fetchedAt < ttlMs;
}

/**
 * The snapshot stores `fetchedAt` as epoch ms internally; the API contract
 * (OpenAPI) models it as an ISO date-time string. Convert at the boundary.
 */
export function financePpsFetchedAtIso(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

export function clearFinancePpsCache(): void {
  cache = null;
}
export function getLastFinancePpsError(): string | null {
  return lastRefreshError;
}
export function clearLastFinancePpsError(): void {
  lastRefreshError = null;
}

// --- Databricks fetch (PAT primary, service-principal OAuth fallback) ---

async function fetchStatement(): Promise<StatementWithManifest> {
  return (await executeStatement(QUERY, { warehouseId: WAREHOUSE_ID })) as StatementWithManifest;
}

function parseStatement(data: StatementWithManifest): { rows: Record<string, string>[]; columns: string[] } {
  const columns = (data.manifest?.schema?.columns || []).map((c) => c.name);
  const dataArray = data.result?.data_array || [];
  const rows: Record<string, string>[] = dataArray.map((cells) => {
    const row: Record<string, string> = {};
    columns.forEach((col, idx) => {
      const cell = cells[idx];
      row[col] = cell == null ? "" : String(cell);
    });
    return row;
  });
  return { rows, columns };
}

// --- Persistence ---

async function persistSnapshot(rows: Record<string, string>[], columns: string[], fetchedAt: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(goalFinancePpsRowsTable);
    if (rows.length > 0) {
      const fetchedAtDate = new Date(fetchedAt);
      await tx.insert(goalFinancePpsRowsTable).values(
        rows.map((data) => ({
          performancePeriod: data["Performance Period"] ?? "",
          employeeId: data["Employee ID"] ?? "",
          group: data["Group"] ?? "",
          data,
          fetchedAt: fetchedAtDate,
        })),
      );
    }
    const meta: FinancePpsMeta = { columns, fetchedAt };
    await tx
      .insert(goalConfigTable)
      .values({ key: META_KEY, value: meta, updatedByName: "system", updatedByRole: "admin" })
      .onConflictDoUpdate({ target: goalConfigTable.key, set: { value: meta } });
  });
}

async function loadSnapshotFromDb(): Promise<FinancePpsSnapshot | null> {
  const [metaRows, dataRows] = await Promise.all([
    db.select().from(goalConfigTable).where(eq(goalConfigTable.key, META_KEY)).limit(1),
    db.select().from(goalFinancePpsRowsTable),
  ]);
  if (metaRows.length === 0 && dataRows.length === 0) return null;
  const meta = (metaRows[0]?.value as FinancePpsMeta | undefined) ?? { columns: [], fetchedAt: 0 };
  return {
    rows: dataRows.map((r) => r.data),
    columns: meta.columns,
    fetchedAt: meta.fetchedAt || null,
    fetchError: false,
  };
}

/**
 * Re-query Databricks, persist the snapshot, and refresh the in-memory cache.
 * On failure, the persisted snapshot is left intact and the returned snapshot
 * carries `fetchError: true` (falling back to whatever is cached/persisted).
 */
export async function refreshFinancePpsSnapshot(): Promise<FinancePpsSnapshot> {
  lastRefreshError = null;
  // Demo mode: the snapshot rows ship in the DB seed and this query is not part
  // of the bundled upstream fixture, so a "refresh" would persist an empty
  // result over the seeded rows. Serve the persisted snapshot instead.
  if (isDemoMode()) {
    const fromDb = (await loadSnapshotFromDb().catch(() => null)) ?? {
      rows: [],
      columns: [],
      fetchedAt: null,
      fetchError: false,
    };
    const snapshot: FinancePpsSnapshot = {
      ...fromDb,
      fetchedAt: fromDb.fetchedAt ?? Date.now(),
      fetchError: false,
    };
    cache = { snapshot, at: Date.now() };
    return snapshot;
  }
  try {
    const data = await fetchStatement();
    const { rows, columns } = parseStatement(data);
    const fetchedAt = Date.now();
    await persistSnapshot(rows, columns, fetchedAt);
    const snapshot: FinancePpsSnapshot = { rows, columns, fetchedAt, fetchError: false };
    cache = { snapshot, at: fetchedAt };
    logger.info({ rowCount: rows.length, columnCount: columns.length }, "[Goals finance.pps] Snapshot refreshed");
    return snapshot;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastRefreshError = msg;
    logger.error({ err: msg }, "[Goals finance.pps] Snapshot refresh failed");
    const fallback = (await loadSnapshotFromDb().catch(() => null)) ?? {
      rows: [],
      columns: [],
      fetchedAt: null,
      fetchError: true,
    };
    const snapshot: FinancePpsSnapshot = { ...fallback, fetchError: true, fetchErrorMessage: msg };
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
export async function getFinancePpsSnapshot(force = false): Promise<FinancePpsSnapshot> {
  const now = Date.now();
  if (!force && cache && isFinancePpsFresh(cache.at, now)) return cache.snapshot;
  if (!force) {
    const fromDb = await loadSnapshotFromDb().catch(() => null);
    if (fromDb && fromDb.rows.length > 0 && fromDb.fetchedAt != null && isFinancePpsFresh(fromDb.fetchedAt, now)) {
      // Preserve the real fetch time so a stale snapshot can't masquerade as
      // fresh for another full TTL.
      cache = { snapshot: fromDb, at: fromDb.fetchedAt };
      return fromDb;
    }
  }
  return refreshFinancePpsSnapshot();
}

/**
 * Boot-time priming: load the persisted snapshot into cache, and if there is
 * none, kick off a refresh in the background. Never throws.
 */
export async function ensureFinancePpsSnapshot(): Promise<void> {
  try {
    const fromDb = await loadSnapshotFromDb();
    if (fromDb && fromDb.rows.length > 0 && fromDb.fetchedAt != null) {
      cache = { snapshot: fromDb, at: fromDb.fetchedAt };
      // If the persisted snapshot is already stale, refresh in the background.
      if (!isFinancePpsFresh(fromDb.fetchedAt)) void refreshFinancePpsSnapshot();
      return;
    }
    void refreshFinancePpsSnapshot();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[Goals finance.pps] ensureFinancePpsSnapshot failed");
  }
}
