import { logger } from "./logger";
import { executeStatement } from "./databricks-client";
import { snapshotCtxActive, isReplayActive } from "./snapshot-context";

const WAREHOUSE_ID = "ac4f2677b84273dc";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export interface UsHoliday {
  date: string;
  name: string;
}

export interface UsHolidaysResult {
  holidays: UsHoliday[];
  fetchError: boolean;
  fetchErrorMessage?: string;
}

let cachedHolidays: UsHolidaysResult | null = null;
let holidayCacheTime = 0;
let lastNightlyError: string | null = null;
let lastNightlyFallbackWarning: string | null = null;

const QUERY = `SELECT HOLIDAY_DATE, HOLIDAY_NAME
FROM engineering.engineering_metrics_silver.vw_us_holidays
ORDER BY HOLIDAY_DATE`;

export function clearHolidayCache(): void {
  cachedHolidays = null;
  holidayCacheTime = 0;
}

export function getLastHolidayError(): string | null {
  return lastNightlyError;
}

export function clearLastHolidayError(): void {
  lastNightlyError = null;
}

export function getLastHolidayFallbackWarning(): string | null {
  return lastNightlyFallbackWarning;
}

export function clearLastHolidayFallbackWarning(): void {
  lastNightlyFallbackWarning = null;
}

async function fetchHolidayStatement() {
  return executeStatement(QUERY, {
    warehouseId: WAREHOUSE_ID,
    onAuthFallback: (msg) => {
      lastNightlyFallbackWarning = msg;
    },
  });
}

export async function fetchUsHolidays(): Promise<UsHolidaysResult> {
  const now = Date.now();
  if (
    !snapshotCtxActive() &&
    cachedHolidays &&
    !cachedHolidays.fetchError &&
    now - holidayCacheTime < CACHE_TTL_MS
  ) {
    return cachedHolidays;
  }

  try {
    const data = await fetchHolidayStatement();

    const holidays: UsHoliday[] = (data.result?.data_array || [])
      .map((r) => {
        const raw = r[0] || "";
        const date = raw.slice(0, 10);
        const name = r[1] || "";
        return { date, name };
      })
      .filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date));

    logger.info({ count: holidays.length }, "[Holidays] Databricks holiday fetch complete");

    const result: UsHolidaysResult = { holidays, fetchError: false };
    if (!isReplayActive()) {
      cachedHolidays = result;
      holidayCacheTime = now;
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[Holidays] Failed to fetch holidays from Databricks");
    if (cachedHolidays) {
      return { ...cachedHolidays, fetchError: true, fetchErrorMessage: msg };
    }
    return {
      holidays: [],
      fetchError: true,
      fetchErrorMessage: msg,
    };
  }
}

export async function runNightlyHolidayRefresh(): Promise<void> {
  logger.info("[Holidays] Running nightly holiday refresh...");
  lastNightlyError = null;
  lastNightlyFallbackWarning = null;
  clearHolidayCache();

  try {
    const result = await fetchUsHolidays();
    if (result.fetchError) {
      lastNightlyError = `Nightly holiday refresh failed: ${result.fetchErrorMessage || "unknown error"}`;
      logger.warn(lastNightlyError);
    } else {
      logger.info({ count: result.holidays.length }, "[Holidays] Nightly holiday refresh succeeded");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    lastNightlyError = `Nightly holiday refresh failed: ${msg}\n\nStack: ${stack || "N/A"}`;
    logger.error({ err: msg }, "[Holidays] Nightly holiday refresh failed");
  }
}
