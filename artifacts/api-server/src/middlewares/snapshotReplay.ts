import type { Request, Response, NextFunction } from "express";
import { runReplay } from "../lib/snapshot-context";
import { loadSnapshotForSelector } from "../lib/data-snapshots";
import { isDemoMode } from "../lib/demo-mode";

const SNAPSHOT_HEADER = "x-data-snapshot";
const CAPTURED_AT_HEADER = "X-Snapshot-Captured-At";

/**
 * Task #393: per-user/per-request data rollback.
 *
 * When the client sends an `X-Data-Snapshot` header naming a stored snapshot
 * selector (`last_good_refresh` or `nightly:YYYY-MM-DD`), this loads that
 * snapshot's raw upstream payload and runs the rest of the request inside a
 * replay context (see snapshot-context.ts). Every Google Sheets / Databricks
 * read is then served from the snapshot while all DB-backed overrides/config
 * stay live. The captured-at timestamp is echoed back so the client can render
 * "Last Refresh SNAPSHOT: <date time>".
 *
 * Absent/`live`/unknown selector => no-op (live data). Read-only: this never
 * mutates anything and the replay context blocks all cache writes.
 */
export async function snapshotReplay(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Demo mode serves EVERY upstream read from the bundled snapshot (see
  // snapshot-context.ts), so there is nothing to select between — skip the
  // stored-snapshot lookup entirely.
  if (isDemoMode()) {
    next();
    return;
  }

  const selector = req.header(SNAPSHOT_HEADER);
  if (!selector || selector === "live") {
    next();
    return;
  }

  let loaded = null as Awaited<ReturnType<typeof loadSnapshotForSelector>>;
  try {
    loaded = await loadSnapshotForSelector(selector);
  } catch {
    // Failure to load a snapshot must never break the request — fall back live.
    loaded = null;
  }

  if (!loaded) {
    next();
    return;
  }

  res.setHeader(CAPTURED_AT_HEADER, loaded.capturedAt.toISOString());
  // Establish the replay context for the remainder of the request. Express runs
  // the downstream chain synchronously off next(), so async-local context
  // propagates through all awaited handlers.
  runReplay(loaded.payload, () => {
    next();
  });
}
