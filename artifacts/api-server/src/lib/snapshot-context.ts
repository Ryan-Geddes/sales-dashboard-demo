// Task #393: per-request data-source context for capturing and replaying raw
// upstream payloads (Google Sheets CSVs + Databricks data_arrays).
//
// The dashboard reads ALL Google Sheets through fetchSheetCSV() and ALL
// Databricks data through executeStatement(). Those two chokepoints consult the
// AsyncLocalStorage context here:
//   - capture mode: the live fetch runs and its raw result is recorded, keyed
//     by source, so it can be persisted as a snapshot.
//   - replay mode: the stored raw payload is returned instead of hitting
//     upstream, so the whole transformation pipeline re-runs against the
//     snapshot's data while every DB-backed override/config stays live.
//
// When ANY snapshot context is active, the higher-level fetchers bypass their
// module caches (reads + in-flight coalescing) so they actually re-run the
// chokepoint. Cache WRITES are still allowed in capture mode (a capture doubles
// as a cache warm) but blocked in replay mode so a snapshot view never pollutes
// the live caches.

import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabricksStatementResponse } from "./databricks-types";
import {
  isDemoMode,
  demoSnapshotPayload,
  warnMissingDemoSource,
} from "./demo-mode";

export interface DatabricksCapture {
  data_array: string[][];
  // finance.pps reads manifest.schema.columns; preserved when present.
  manifest?: unknown;
}

export interface SnapshotPayload {
  // key `${sheetId}:${gid}` -> raw CSV text
  sheets: Record<string, string>;
  // key = raw SQL query string -> captured data
  databricks: Record<string, DatabricksCapture>;
}

type SnapshotCtx =
  | { mode: "capture"; payload: SnapshotPayload }
  | { mode: "replay"; payload: SnapshotPayload };

const als = new AsyncLocalStorage<SnapshotCtx>();

export function snapshotCtxActive(): boolean {
  return als.getStore() != null;
}

export function isReplayActive(): boolean {
  return als.getStore()?.mode === "replay";
}

export function isCaptureActive(): boolean {
  return als.getStore()?.mode === "capture";
}

export function emptySnapshotPayload(): SnapshotPayload {
  return { sheets: {}, databricks: {} };
}

export function sheetSnapshotKey(sheetId: string, gid: string): string {
  return `${sheetId}:${gid}`;
}

// A Databricks response shaped like a successful statement with zero rows.
// `manifest.schema.columns` is read by the finance.pps parser, so the minimal
// manifest keeps that shape rather than being undefined.
function emptyDatabricksResponse(): DatabricksStatementResponse {
  return {
    status: { state: "SUCCEEDED" },
    manifest: { schema: { columns: [] }, total_row_count: 0 },
    result: { data_array: [] },
  } as unknown as DatabricksStatementResponse;
}

// Chokepoint helper for Google Sheets. `live` performs the real network fetch.
export async function resolveSheetCSV(
  sheetId: string,
  gid: string,
  live: () => Promise<string>,
): Promise<string> {
  // Demo mode: ALWAYS serve the bundled fixture, regardless of any ALS context
  // or `x-data-snapshot` header, and NEVER fall back to a live fetch (the demo
  // host has no Google credentials and must make no outbound calls). A source
  // that is absent from the fixture degrades to an empty CSV.
  if (isDemoMode()) {
    const key = sheetSnapshotKey(sheetId, gid);
    const stored = demoSnapshotPayload().sheets[key];
    if (stored != null) return stored;
    warnMissingDemoSource("sheet", key);
    return "";
  }
  const ctx = als.getStore();
  if (!ctx) return live();
  const key = sheetSnapshotKey(sheetId, gid);
  if (ctx.mode === "replay") {
    const stored = ctx.payload.sheets[key];
    // Missing source (e.g. added after the snapshot was taken): fall back to
    // live so the view still renders rather than throwing.
    return stored != null ? stored : live();
  }
  const value = await live();
  ctx.payload.sheets[key] = value;
  return value;
}

// Chokepoint helper for Databricks. `live` performs the real statement call.
export async function resolveDatabricks(
  query: string,
  live: () => Promise<DatabricksStatementResponse>,
): Promise<DatabricksStatementResponse> {
  // Demo mode: same rules as sheets — bundled fixture only, never live.
  if (isDemoMode()) {
    const stored = demoSnapshotPayload().databricks[query];
    if (!stored) {
      warnMissingDemoSource("databricks", query);
      return emptyDatabricksResponse();
    }
    return {
      status: { state: "SUCCEEDED" },
      manifest: stored.manifest,
      result: { data_array: stored.data_array },
    } as unknown as DatabricksStatementResponse;
  }
  const ctx = als.getStore();
  if (!ctx) return live();
  if (ctx.mode === "replay") {
    const stored = ctx.payload.databricks[query];
    if (!stored) return live();
    return {
      status: { state: "SUCCEEDED" },
      manifest: stored.manifest,
      result: { data_array: stored.data_array },
    } as unknown as DatabricksStatementResponse;
  }
  const value = await live();
  ctx.payload.databricks[query] = {
    data_array: value.result?.data_array ?? [],
    manifest: (value as { manifest?: unknown }).manifest,
  };
  return value;
}

// Run `fn` while recording every chokepoint fetch, returning the captured
// payload. Cache writes are permitted (a capture warms the live caches too).
export async function runCapture(
  fn: () => Promise<void>,
): Promise<SnapshotPayload> {
  const payload = emptySnapshotPayload();
  await als.run({ mode: "capture", payload }, fn);
  return payload;
}

// Run `fn` serving all upstream reads from `payload`. Cache writes are blocked.
export function runReplay<T>(
  payload: SnapshotPayload,
  fn: () => T,
): T {
  return als.run({ mode: "replay", payload }, fn);
}
