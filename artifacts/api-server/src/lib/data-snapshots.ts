// Task #393: persistence + scheduling for raw upstream data snapshots used by
// the per-user dashboard rollback feature. See snapshot-context.ts for the
// capture/replay mechanics.

import { pool, db, dataSnapshotsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "./logger";
import type { SnapshotPayload } from "./snapshot-context";
import {
  captureDashboardSnapshot,
  snapshotPipelineRowCount,
} from "./sheets-data";

const GOOD_KIND = "last_good_refresh";
const NIGHTLY_KIND = "nightly";
const NIGHTLY_KEEP = 7;

// A captured snapshot is only healthy enough to become the rolling "good
// refresh" if its pipeline has a sane number of rows. Guards the incident where
// an upstream returning 0 rows overwrote a good snapshot with empty data.
const MIN_PIPELINE_ROWS = 5;
const MIN_RATIO_VS_PRIOR = 0.5;

// ---------------------------------------------------------------------------
// Storing
// ---------------------------------------------------------------------------

/**
 * Replace the single rolling `last_good_refresh` row IFF the freshly captured
 * payload passes a health check. Never throws — a snapshot failure must never
 * break the live refresh it piggybacks on.
 */
export async function storeGoodRefreshIfHealthy(
  payload: SnapshotPayload,
): Promise<void> {
  try {
    const newCount = snapshotPipelineRowCount(payload);
    if (newCount < MIN_PIPELINE_ROWS) {
      logger.warn(
        { newCount },
        "[Snapshot] Skipping last_good_refresh: pipeline row count below floor",
      );
      return;
    }

    const prior = await db
      .select({ count: dataSnapshotsTable.pipelineRowCount })
      .from(dataSnapshotsTable)
      .where(eq(dataSnapshotsTable.kind, GOOD_KIND))
      .limit(1);
    const priorCount = prior[0]?.count ?? 0;
    if (priorCount > 0 && newCount < priorCount * MIN_RATIO_VS_PRIOR) {
      logger.warn(
        { newCount, priorCount },
        "[Snapshot] Skipping last_good_refresh: pipeline rows dropped below 50% of prior good",
      );
      return;
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(dataSnapshotsTable)
        .where(eq(dataSnapshotsTable.kind, GOOD_KIND));
      await tx.insert(dataSnapshotsTable).values({
        kind: GOOD_KIND,
        snapshotDate: null,
        pipelineRowCount: newCount,
        payload,
      });
    });
    invalidateSelectorCache(GOOD_KIND);
    logger.info({ newCount }, "[Snapshot] Stored last_good_refresh");
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[Snapshot] Failed to store last_good_refresh",
    );
  }
}

/**
 * Store (or replace) the nightly snapshot for a Pacific calendar date, then
 * prune to the most recent NIGHTLY_KEEP dates. Never throws.
 */
export async function storeNightlySnapshot(
  payload: SnapshotPayload,
  snapshotDate: string,
): Promise<void> {
  try {
    const newCount = snapshotPipelineRowCount(payload);
    if (newCount < MIN_PIPELINE_ROWS) {
      logger.warn(
        { snapshotDate, newCount },
        "[Snapshot] Skipping nightly: pipeline row count below floor",
      );
      return;
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(dataSnapshotsTable)
        .where(
          and(
            eq(dataSnapshotsTable.kind, NIGHTLY_KIND),
            eq(dataSnapshotsTable.snapshotDate, snapshotDate),
          ),
        );
      await tx.insert(dataSnapshotsTable).values({
        kind: NIGHTLY_KIND,
        snapshotDate,
        pipelineRowCount: newCount,
        payload,
      });
    });

    // Prune to the newest NIGHTLY_KEEP dates.
    await pool.query(
      `DELETE FROM data_snapshots
         WHERE kind = $1
           AND snapshot_date NOT IN (
             SELECT snapshot_date FROM data_snapshots
              WHERE kind = $1
              ORDER BY snapshot_date DESC
              LIMIT $2
           )`,
      [NIGHTLY_KIND, NIGHTLY_KEEP],
    );
    invalidateSelectorCache(`${NIGHTLY_KIND}:${snapshotDate}`);
    logger.info({ snapshotDate, newCount }, "[Snapshot] Stored nightly snapshot");
  } catch (err) {
    logger.error(
      {
        snapshotDate,
        err: err instanceof Error ? err.message : String(err),
      },
      "[Snapshot] Failed to store nightly snapshot",
    );
  }
}

// ---------------------------------------------------------------------------
// Listing + loading
// ---------------------------------------------------------------------------

export interface SnapshotListEntry {
  date: string;
  capturedAt: string;
}

export interface SnapshotList {
  lastGoodRefresh: { capturedAt: string } | null;
  nightly: SnapshotListEntry[];
}

export async function listSnapshots(): Promise<SnapshotList> {
  const rows = await db
    .select({
      kind: dataSnapshotsTable.kind,
      snapshotDate: dataSnapshotsTable.snapshotDate,
      capturedAt: dataSnapshotsTable.capturedAt,
    })
    .from(dataSnapshotsTable)
    .orderBy(desc(dataSnapshotsTable.snapshotDate));

  let lastGoodRefresh: { capturedAt: string } | null = null;
  const nightly: SnapshotListEntry[] = [];
  for (const r of rows) {
    if (r.kind === GOOD_KIND) {
      lastGoodRefresh = { capturedAt: r.capturedAt.toISOString() };
    } else if (r.kind === NIGHTLY_KIND && r.snapshotDate) {
      nightly.push({
        date: r.snapshotDate,
        capturedAt: r.capturedAt.toISOString(),
      });
    }
  }
  nightly.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { lastGoodRefresh, nightly };
}

export interface LoadedSnapshot {
  payload: SnapshotPayload;
  capturedAt: Date;
}

// Big jsonb payloads: cache loaded snapshots briefly so repeated requests under
// one selection don't re-read megabytes per call.
const SELECTOR_TTL_MS = 60_000;
const selectorCache = new Map<
  string,
  { value: LoadedSnapshot | null; at: number }
>();

function invalidateSelectorCache(selector: string): void {
  selectorCache.delete(selector);
}

/**
 * Resolve a client-supplied selector to a stored snapshot.
 * Selectors: `last_good_refresh` | `nightly:YYYY-MM-DD`.
 * Returns null when the selector is unknown or no matching row exists (caller
 * then falls back to live data).
 */
export async function loadSnapshotForSelector(
  selector: string,
): Promise<LoadedSnapshot | null> {
  const cached = selectorCache.get(selector);
  if (cached && Date.now() - cached.at < SELECTOR_TTL_MS) return cached.value;

  let loaded: LoadedSnapshot | null = null;
  try {
    if (selector === GOOD_KIND) {
      const rows = await db
        .select({
          payload: dataSnapshotsTable.payload,
          capturedAt: dataSnapshotsTable.capturedAt,
        })
        .from(dataSnapshotsTable)
        .where(eq(dataSnapshotsTable.kind, GOOD_KIND))
        .limit(1);
      if (rows[0]) {
        loaded = {
          payload: rows[0].payload as SnapshotPayload,
          capturedAt: rows[0].capturedAt,
        };
      }
    } else if (selector.startsWith(`${NIGHTLY_KIND}:`)) {
      const date = selector.slice(NIGHTLY_KIND.length + 1);
      const rows = await db
        .select({
          payload: dataSnapshotsTable.payload,
          capturedAt: dataSnapshotsTable.capturedAt,
        })
        .from(dataSnapshotsTable)
        .where(
          and(
            eq(dataSnapshotsTable.kind, NIGHTLY_KIND),
            eq(dataSnapshotsTable.snapshotDate, date),
          ),
        )
        .limit(1);
      if (rows[0]) {
        loaded = {
          payload: rows[0].payload as SnapshotPayload,
          capturedAt: rows[0].capturedAt,
        };
      }
    }
  } catch (err) {
    logger.error(
      { selector, err: err instanceof Error ? err.message : String(err) },
      "[Snapshot] Failed to load snapshot for selector",
    );
    return null;
  }

  selectorCache.set(selector, { value: loaded, at: Date.now() });
  return loaded;
}

// ---------------------------------------------------------------------------
// Nightly scheduler (America/Los_Angeles midnight)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD for `instant` in Pacific time. */
export function pacificDateString(instant = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

/** Milliseconds from `instant` until the next Pacific 00:00 (handles PST/PDT). */
export function msUntilNextPacificMidnight(instant = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const h = get("hour") % 24;
  const m = get("minute");
  const s = get("second");
  const elapsed = ((h * 60 + m) * 60 + s) * 1000;
  let ms = DAY_MS - elapsed;
  if (ms <= 0) ms += DAY_MS;
  return ms;
}

async function runNightlySnapshot(): Promise<void> {
  const date = pacificDateString();
  logger.info({ date }, "[Snapshot] Running nightly snapshot capture...");
  try {
    const payload = await captureDashboardSnapshot();
    await storeNightlySnapshot(payload, date);
  } catch (err) {
    logger.error(
      { date, err: err instanceof Error ? err.message : String(err) },
      "[Snapshot] Nightly snapshot capture failed",
    );
  }
}

/**
 * Self-rescheduling timer that fires at the next Pacific midnight and then once
 * per day. Recomputed each fire so it stays pinned across DST transitions.
 */
export function startNightlySnapshotScheduler(): void {
  const schedule = () => {
    const ms = msUntilNextPacificMidnight();
    logger.info(
      { hoursUntil: (ms / 3_600_000).toFixed(1) },
      "[Snapshot] Nightly snapshot scheduled",
    );
    setTimeout(async () => {
      await runNightlySnapshot();
      schedule();
    }, ms);
  };
  schedule();
}
