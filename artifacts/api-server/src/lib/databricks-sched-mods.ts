import { logger } from "./logger";
import { executeStatement } from "./databricks-client";
import { snapshotCtxActive, isReplayActive } from "./snapshot-context";
import { addParseError } from "./sheets-data";
import { canonicalizeOppId } from "./sf-id";
import { bumpDataVersion } from "./cache-version";

const WAREHOUSE_ID = "ac4f2677b84273dc";
const TABLE = "sandbox_stplus.sai_analyst.frontline_dash_sched_mods";
const QUERY_LINK =
  "https://zg-stplus-lab.cloud.databricks.com/editor/queries/2482332804685710?o=1616033453304964";
const CACHE_TTL_MS = 30 * 60 * 1000;

// Curated Sched Mods table. Column order matches the SELECT below; do not
// rearrange without updating the index access in `mapRow`.
const QUERY = `SELECT
  amount,
  cancellation_date,
  segment,
  rep_name,
  rep_title,
  rep_region,
  rep_email,
  description,
  reason,
  contact_id,
  contact_zuid,
  opportunity_type,
  opportunity_id,
  contact_name,
  product,
  churn_type
FROM ${TABLE}`;

export interface RawScheduledMod {
  amount: number;
  cancellationDate: string;
  segment: string;
  repName: string;
  repTitle: string;
  repRegion: string;
  repEmail: string;
  description: string;
  reason: string;
  contactId: string;
  contactZuid: string;
  opportunityType: string;
  opportunityId: string | null;
  contactName: string;
  product: string;
  churnType: string;
}

let cachedMods: RawScheduledMod[] | null = null;
let cacheTime = 0;
let pendingFetch: Promise<RawScheduledMod[]> | null = null;

export function clearSchedModsCache(): void {
  cachedMods = null;
  cacheTime = 0;
  bumpDataVersion();
}

function mapRow(r: any[]): RawScheduledMod | null {
  const repName = (r[3] || "").toString().trim();
  if (!repName) return null;
  const amountRaw = r[0];
  const amount = typeof amountRaw === "number" ? amountRaw : parseFloat(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cancellationDate = (r[1] || "").toString();
  if (!cancellationDate) return null;
  const oppId = r[12];
  return {
    amount,
    cancellationDate,
    segment: (r[2] || "").toString(),
    repName,
    repTitle: (r[4] || "").toString(),
    repRegion: (r[5] || "").toString(),
    repEmail: (r[6] || "").toString(),
    description: (r[7] || "").toString(),
    reason: (r[8] || "").toString(),
    contactId: (r[9] || "").toString(),
    contactZuid: (r[10] || "").toString(),
    opportunityType: (r[11] || "").toString(),
    opportunityId: oppId == null || oppId === "" ? null : oppId.toString(),
    contactName: (r[13] || "").toString(),
    product: (r[14] || "").toString(),
    churnType: (r[15] || "").toString(),
  };
}

async function fetchStatement() {
  return executeStatement(QUERY, { warehouseId: WAREHOUSE_ID });
}

async function _fetchSchedModsImpl(): Promise<RawScheduledMod[]> {
  try {
    const data = await fetchStatement();
    const rows = data.result?.data_array || [];
    const out: RawScheduledMod[] = [];
    for (const r of rows) {
      const m = mapRow(r);
      if (m) out.push(m);
    }
    if (!isReplayActive()) {
      cachedMods = out;
      cacheTime = Date.now();
      bumpDataVersion();
    }
    logger.info({ rows: out.length }, "[SchedMods] Databricks fetch complete");
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[SchedMods] Failed to fetch from Databricks");
    addParseError({
      sheet: "Mods (Databricks)",
      sheetUrl: QUERY_LINK,
      message: `Databricks fetch failed: ${msg}`,
      expectedHeaders: [],
      actualHeaders: [],
      timestamp: Date.now(),
    });
    if (cachedMods) return cachedMods;
    if (!isReplayActive()) {
      cachedMods = [];
      cacheTime = Date.now();
    }
    return cachedMods ?? [];
  }
}

export async function fetchSchedMods(): Promise<RawScheduledMod[]> {
  const now = Date.now();
  if (!snapshotCtxActive() && cachedMods && now - cacheTime < CACHE_TTL_MS)
    return cachedMods;
  if (!snapshotCtxActive() && pendingFetch) return pendingFetch;
  pendingFetch = _fetchSchedModsImpl().finally(() => {
    pendingFetch = null;
  });
  return pendingFetch;
}

// Stable id used for per-mod probability overrides in
// opp_probability_overrides. Per task #153 spec: when the real Salesforce
// opportunity_id is present we use it raw, so a probability override set
// on a sched-mod row also applies if the same opp surfaces elsewhere
// (cross-surface identity). Falls back to a composite key for rows where
// opportunity_id is null (~half of CC Decline rows in current data).
export function modOppIdFor(m: RawScheduledMod): string {
  if (m.opportunityId) return canonicalizeOppId(m.opportunityId);
  return `mod:${m.contactId}|${m.cancellationDate}|${m.amount}|${m.product}`;
}

export function filterSchedMods(
  rows: RawScheduledMod[],
  dateFilter?: { from?: string; to?: string },
): RawScheduledMod[] {
  if (!dateFilter) return rows;
  const from = dateFilter.from ? new Date(dateFilter.from + "T00:00:00") : null;
  const to = dateFilter.to ? new Date(dateFilter.to + "T23:59:59") : null;
  return rows.filter((r) => {
    const d = new Date(r.cancellationDate);
    if (Number.isNaN(d.getTime())) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}
