import { logger } from "./logger";
import { executeStatement } from "./databricks-client";
import type { DatabricksStatementResponse } from "./databricks-types";
import { snapshotCtxActive, isReplayActive } from "./snapshot-context";
import { addParseError } from "./sheets-data";
import { bumpDataVersion } from "./cache-version";

const WAREHOUSE_ID = "ac4f2677b84273dc";
const TABLE = "sandbox_stplus.sai_analyst.frontline_dash_anaplan_data";
const QUERY_LINK = "https://zg-stplus-lab.cloud.databricks.com/";
const CACHE_TTL_MS = 30 * 60 * 1000;

// `select *` so every Anaplan source column is preserved for the Anaplan Check
// Tool's column picker. Column names come from the Statement API's
// `manifest.schema` (see parseStatement), so the SELECT order is irrelevant.
const QUERY = `SELECT * FROM ${TABLE}`;

// The Statement API returns column metadata in `manifest.schema`, which the
// shared response type omits. Extend it locally for `select *` (mirrors the
// finance.pps snapshot loader).
interface StatementWithManifest extends DatabricksStatementResponse {
  manifest?: { schema?: { columns?: { name: string; position?: number }[] } };
}

// Canonical source column names (verified via DESCRIBE). Kept as constants so
// the reconciliation consumer can read specific fields without re-typing the
// raw header strings; everything else is preserved verbatim in `rows`.
export const ANAPLAN_COL = {
  opportunityIds: "opportunity_ids",
  lastUpdate: "last_update",
  cpdId: "cpd_id",
  slm: "SLM",
  owner: "Owner",
  compensationDate: "Compensation Date",
  partnerName: "Partner Name",
  groupAMrr: "Product Group A Current Month MRR",
  groupBMrr: "Product Group B Current Month MRR",
  groupCMrr: "Product Group C Current Month MRR",
} as const;

export interface AnaplanSnapshot {
  // One object per CPD row, all source columns preserved as strings.
  rows: Record<string, string>[];
  // Source column names in manifest order (drives the UI column picker).
  columns: string[];
  // Max `last_update` across all rows (ISO date string) or null when empty.
  lastUpdate: string | null;
  fetchedAt: number | null;
  fetchError: boolean;
  fetchErrorMessage?: string;
}

let cached: AnaplanSnapshot | null = null;
let cacheTime = 0;
let pendingFetch: Promise<AnaplanSnapshot> | null = null;

export function clearAnaplanCache(bumpVersion = true): void {
  cached = null;
  cacheTime = 0;
  // Callers that already bump the global data version (e.g. invalidateCache)
  // pass false to avoid a redundant double-bump.
  if (bumpVersion) bumpDataVersion();
}

function parseStatement(data: StatementWithManifest): {
  rows: Record<string, string>[];
  columns: string[];
} {
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

function computeLastUpdate(rows: Record<string, string>[]): string | null {
  let max: string | null = null;
  for (const r of rows) {
    const v = (r[ANAPLAN_COL.lastUpdate] || "").trim();
    if (!v) continue;
    if (max === null || v > max) max = v;
  }
  return max;
}

async function _fetchImpl(): Promise<AnaplanSnapshot> {
  try {
    const data = (await executeStatement(QUERY, {
      warehouseId: WAREHOUSE_ID,
    })) as StatementWithManifest;
    const { rows, columns } = parseStatement(data);
    const snapshot: AnaplanSnapshot = {
      rows,
      columns,
      lastUpdate: computeLastUpdate(rows),
      fetchedAt: Date.now(),
      fetchError: false,
    };
    if (!isReplayActive()) {
      cached = snapshot;
      cacheTime = Date.now();
      bumpDataVersion();
    }
    logger.info(
      { rows: rows.length, columns: columns.length },
      "[Anaplan] Databricks fetch complete",
    );
    return snapshot;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[Anaplan] Failed to fetch from Databricks");
    addParseError({
      sheet: "Anaplan (Databricks)",
      sheetUrl: QUERY_LINK,
      message: `Databricks fetch failed: ${msg}`,
      expectedHeaders: [],
      actualHeaders: [],
      timestamp: Date.now(),
    });
    if (cached) return cached;
    const empty: AnaplanSnapshot = {
      rows: [],
      columns: [],
      lastUpdate: null,
      fetchedAt: Date.now(),
      fetchError: true,
      fetchErrorMessage: msg,
    };
    if (!isReplayActive()) {
      cached = empty;
      cacheTime = Date.now();
    }
    return cached ?? empty;
  }
}

export async function fetchAnaplanData(): Promise<AnaplanSnapshot> {
  const now = Date.now();
  if (!snapshotCtxActive() && cached && now - cacheTime < CACHE_TTL_MS)
    return cached;
  if (!snapshotCtxActive() && pendingFetch) return pendingFetch;
  pendingFetch = _fetchImpl().finally(() => {
    pendingFetch = null;
  });
  return pendingFetch;
}
