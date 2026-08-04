import { logger } from "./logger";
import { executeStatement } from "./databricks-client";
import { snapshotCtxActive, isReplayActive } from "./snapshot-context";
import { addParseError } from "./sheets-data";
import { bumpDataVersion } from "./cache-version";

const WAREHOUSE_ID = "ac4f2677b84273dc";
const TABLE = "sandbox_stplus.sai_analyst.frontline_dash_cpds";
const QUERY_LINK = `https://zg-stplus-lab.cloud.databricks.com/explore/data/${TABLE.replace(/\./g, "/")}`;
const CACHE_TTL_MS = 30 * 60 * 1000;

// Showcase Incremental - Re/Max CPDs (paid deals). Every row is treated as
// a Closed Won opportunity attributed to the "Showcase Incremental - Re/Max"
// product. Column order must match the SELECT for index access in mapRow.
// Task #314: positive_change_in_mrr / negative_change_in_mrr are manual
// backend-adjustment columns the comp team can pick as a CPD rule's base MRR
// source. Appended after legacy_flag so the existing column indices used in
// mapRow stay unchanged.
const QUERY = `SELECT
  contact_name,
  sf_contact_id,
  sf_cpd_id,
  flm_name,
  rep_name,
  close_date,
  product,
  mrr_added,
  legacy_flag,
  positive_change_in_mrr,
  negative_change_in_mrr
FROM ${TABLE}`;

export interface RawRemaxCpd {
  contactName: string;
  sfContactId: string;
  sfCpdId: string;
  flmName: string;
  repName: string;
  closeDate: string;
  product: string;
  mrrAdded: number;
  legacyFlag: boolean;
  // Task #314: optional manual-adjustment MRR columns. Default 0 when the
  // Databricks column is null/blank so CPD comp is unchanged when unused.
  positiveChangeInMrr: number;
  negativeChangeInMrr: number;
}

let cachedRows: RawRemaxCpd[] | null = null;
let cacheTime = 0;
let pendingFetch: Promise<RawRemaxCpd[]> | null = null;

export function clearRemaxCpdsCache(): void {
  cachedRows = null;
  cacheTime = 0;
  bumpDataVersion();
}

function mapRow(r: any[]): RawRemaxCpd | null {
  const repName = (r[4] || "").toString().trim();
  if (!repName) return null;
  const mrrRaw = r[7];
  const mrrAdded =
    typeof mrrRaw === "number" ? mrrRaw : parseFloat(mrrRaw);
  if (!Number.isFinite(mrrAdded)) return null;
  const closeDate = (r[5] || "").toString();
  if (!closeDate) return null;
  return {
    contactName: (r[0] || "").toString(),
    sfContactId: (r[1] || "").toString(),
    sfCpdId: (r[2] || "").toString(),
    flmName: (r[3] || "").toString(),
    repName,
    closeDate,
    product: (r[6] || "").toString(),
    mrrAdded,
    legacyFlag: parseLegacyFlag(r[8]),
    positiveChangeInMrr: parseOptionalNum(r[9]),
    negativeChangeInMrr: parseOptionalNum(r[10]),
  };
}

// Task #314: optional numeric CPD columns. Null/blank/non-numeric → 0 so an
// empty manual-adjustment column leaves CPD comp unchanged.
function parseOptionalNum(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

// legacy_flag arrives as a boolean, a numeric 0/1, or a string ("true",
// "1", "t") depending on the Databricks JSON serialization. Treat any
// recognizable truthy form as true; everything else (incl. blank/null)
// defaults to false so existing behavior is unchanged when absent.
function parseLegacyFlag(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "t" || s === "yes";
  }
  return false;
}

async function fetchStatement() {
  return executeStatement(QUERY, { warehouseId: WAREHOUSE_ID });
}

async function _fetchRemaxCpdsImpl(): Promise<RawRemaxCpd[]> {
  try {
    const data = await fetchStatement();
    const rows = data.result?.data_array || [];
    const out: RawRemaxCpd[] = [];
    for (const r of rows) {
      const m = mapRow(r);
      if (m) out.push(m);
    }
    if (!isReplayActive()) {
      cachedRows = out;
      cacheTime = Date.now();
      bumpDataVersion();
    }
    logger.info({ rows: out.length }, "[RemaxCpds] Databricks fetch complete");
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[RemaxCpds] Failed to fetch from Databricks");
    addParseError({
      sheet: "Frontline CPDs (Databricks)",
      sheetUrl: QUERY_LINK,
      message: `Databricks fetch failed: ${msg}`,
      expectedHeaders: [],
      actualHeaders: [],
      timestamp: Date.now(),
    });
    if (cachedRows) return cachedRows;
    if (!isReplayActive()) {
      cachedRows = [];
      cacheTime = Date.now();
    }
    return cachedRows ?? [];
  }
}

export async function fetchRemaxCpds(): Promise<RawRemaxCpd[]> {
  const now = Date.now();
  if (!snapshotCtxActive() && cachedRows && now - cacheTime < CACHE_TTL_MS)
    return cachedRows;
  if (!snapshotCtxActive() && pendingFetch) return pendingFetch;
  pendingFetch = _fetchRemaxCpdsImpl().finally(() => {
    pendingFetch = null;
  });
  return pendingFetch;
}
