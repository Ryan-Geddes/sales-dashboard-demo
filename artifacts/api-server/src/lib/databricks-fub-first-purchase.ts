import { logger } from "./logger";
import { executeStatement } from "./databricks-client";
import { snapshotCtxActive, isReplayActive } from "./snapshot-context";
import { addParseError } from "./sheets-data";
import { bumpDataVersion } from "./cache-version";

const WAREHOUSE_ID = "ac4f2677b84273dc";
const TABLE = "sandbox_stplus.sai_analyst.frontline_dash_product_data";
const QUERY_LINK = `https://zg-stplus-lab.cloud.databricks.com/explore/data/${TABLE.replace(/\./g, "/")}`;
const CACHE_TTL_MS = 30 * 60 * 1000;

// Task #347: FUB first-purchase enrichment table. Almost every column is null
// except on FUB opportunities. This is an ENRICHMENT join keyed by the 18-char
// opportunity_id — it adds columns to existing opportunity rows and never
// creates synthetic rows (unlike frontline_dash_cpds). Column order must match
// the SELECT for index access in mapRow.
const QUERY = `SELECT
  opportunity_id,
  fub_first_purchase_date,
  fub_first_purchase_opp_id
FROM ${TABLE}`;

export interface RawFubFirstPurchase {
  opportunityId: string;
  fubFirstPurchaseDate: string;
  fubFirstPurchaseOppId: string;
}

let cachedRows: RawFubFirstPurchase[] | null = null;
let cacheTime = 0;
let pendingFetch: Promise<RawFubFirstPurchase[]> | null = null;

export function clearFubFirstPurchaseCache(): void {
  cachedRows = null;
  cacheTime = 0;
  bumpDataVersion();
}

function mapRow(r: any[]): RawFubFirstPurchase | null {
  const opportunityId = (r[0] || "").toString().trim();
  if (!opportunityId) return null;
  return {
    opportunityId,
    fubFirstPurchaseDate: (r[1] || "").toString().trim(),
    fubFirstPurchaseOppId: (r[2] || "").toString().trim(),
  };
}

async function fetchStatement() {
  return executeStatement(QUERY, { warehouseId: WAREHOUSE_ID });
}

async function _fetchFubFirstPurchaseImpl(): Promise<RawFubFirstPurchase[]> {
  try {
    const data = await fetchStatement();
    const rows = data.result?.data_array || [];
    const out: RawFubFirstPurchase[] = [];
    for (const r of rows) {
      const m = mapRow(r);
      if (m) out.push(m);
    }
    if (!isReplayActive()) {
      cachedRows = out;
      cacheTime = Date.now();
      bumpDataVersion();
    }
    logger.info({ rows: out.length }, "[FubFirstPurchase] Databricks fetch complete");
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[FubFirstPurchase] Failed to fetch from Databricks");
    addParseError({
      sheet: "FUB First Purchase (Databricks)",
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

export async function fetchFubFirstPurchase(): Promise<RawFubFirstPurchase[]> {
  const now = Date.now();
  if (!snapshotCtxActive() && cachedRows && now - cacheTime < CACHE_TTL_MS)
    return cachedRows;
  if (!snapshotCtxActive() && pendingFetch) return pendingFetch;
  pendingFetch = _fetchFubFirstPurchaseImpl().finally(() => {
    pendingFetch = null;
  });
  return pendingFetch;
}

// Lookup for enriching feeder rows. Databricks stores the 18-char Salesforce
// opportunity_id, but the Pipeline sheet often carries the 15-char form, so the
// index is keyed by BOTH the full id AND its case-sensitive 15-char prefix.
// (15-char SF ids are case-sensitive and unique on their own, so the prefix is a
// safe join key — without this, FUB-only fields like FUB First Purchase Date
// stay blank for every 15-char-id opp and date comparatives never fire.)
export function buildFubFirstPurchaseIndex(
  rows: RawFubFirstPurchase[],
): Map<string, RawFubFirstPurchase> {
  const map = new Map<string, RawFubFirstPurchase>();
  for (const r of rows) {
    if (!r.opportunityId) continue;
    map.set(r.opportunityId, r);
    // Salesforce ids are exactly 15 or 18 chars; only an 18-char id has a
    // meaningful 15-char prefix to fall back on.
    if (r.opportunityId.length === 18) {
      const short = r.opportunityId.slice(0, 15);
      if (!map.has(short)) map.set(short, r);
    }
  }
  return map;
}

// Resolve a Pipeline opp id (15- or 18-char) against the index: exact match
// first, then the 15-char prefix.
export function lookupFubFirstPurchase(
  index: Map<string, RawFubFirstPurchase>,
  oppId: string | undefined | null,
): RawFubFirstPurchase | undefined {
  const id = (oppId || "").trim();
  if (!id) return undefined;
  return index.get(id) ?? (id.length === 18 ? index.get(id.slice(0, 15)) : undefined);
}
