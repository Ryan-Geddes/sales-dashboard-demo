// Public demo runtime.
//
// The dashboard ships a fully anonymized, frozen-in-time demo that runs OUTSIDE
// Replit (public repo + free host) with NO access to Google Sheets, Databricks,
// Slack or object storage. Everything the demo serves comes from two bundled
// fixtures in `demo-data/`:
//
//   snapshot.json  raw upstream payload (Sheets CSVs + Databricks data_arrays)
//                  in the exact SnapshotPayload shape produced by the Task #393
//                  capture pipeline, keyed by placeholder sheet ids.
//   db-seed.json   { tableName: rows[] } for the DB-backed overrides/config.
//
// Demo mode is opt-in via DEMO_MODE=1 (or "true"). When it is not set NOTHING
// in this module changes behavior — every guard in the codebase is written as
// `if (isDemoMode())` / `if (!isDemoMode())` so the live path is untouched.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";
import type { SnapshotPayload } from "./snapshot-context";

/** True when the process was started with DEMO_MODE=1 / DEMO_MODE=true. */
export function isDemoMode(): boolean {
  const v = process.env.DEMO_MODE?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * The demo is frozen to this Pacific calendar date — the date the bundled
 * snapshot was captured. Everything the server treats as "today" / "current
 * month" resolves from it (see currentDate()).
 */
export const DEMO_TODAY = "2026-07-29";

// Midday Pacific on DEMO_TODAY: far enough from either midnight that any
// UTC/PST conversion downstream still lands on the same calendar day.
const DEMO_NOW_ISO = `${DEMO_TODAY}T12:00:00-07:00`;

/**
 * The server's notion of "now". In demo mode this is frozen to DEMO_TODAY so
 * the month windows (current month / last month / MTD boundaries) always match
 * the frozen snapshot. Live mode returns the real clock.
 *
 * Use this ONLY where the value selects which dashboard data is shown — not for
 * logging, cache timestamps or audit `updated_at` columns.
 */
export function currentDate(): Date {
  return isDemoMode() ? new Date(DEMO_NOW_ISO) : new Date();
}

/** Epoch millis counterpart of currentDate(). */
export function demoNow(): number {
  return currentDate().getTime();
}

/** `YYYY-MM-DD` for currentDate() in Pacific time. */
export function todayString(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(currentDate());
}

// ---------------------------------------------------------------------------
// Bundled fixtures
// ---------------------------------------------------------------------------

export interface DemoSnapshotFile {
  snapshotDate: string;
  capturedAt: string;
  payload: SnapshotPayload;
}

/**
 * Placeholder Google Sheet ids used by the fixtures. The real ids never appear
 * in the demo build (see sheets-data.ts, which swaps the constants over in demo
 * mode).
 */
export const DEMO_SHEET_IDS = {
  pipeline: "demo-sheet-pipeline",
  ondemand: "demo-sheet-ondemand",
  hierarchy: "demo-sheet-hierarchy",
  sbr: "demo-sheet-sbr",
  dials: "demo-sheet-dials",
  ccDeclines: "demo-sheet-ccdeclines",
  inbounds: "demo-sheet-inbounds",
  // Weighted pipe and stale opps live on the same workbook (different gids).
  weighted: "demo-sheet-weighted",
  feederIndex: "demo-sheet-feeder-index",
  emails: "demo-sheet-emails",
} as const;

// ---------------------------------------------------------------------------
// Anonymized identities
// ---------------------------------------------------------------------------
//
// A couple of real names are hard-coded in the business logic because they are
// structural, not data: the VP the org tree is rooted at, and the synthetic
// "On Demand" pseudo-rep identities that only exist in the pipeline feeds. The
// anonymizer rewrote them inside the fixtures, so demo mode must use the SAME
// fake names or the hierarchy comes back empty. Kept here (next to the rest of
// the fixture contract) rather than scattered through sheets-data.ts.

/** Fake name the anonymizer assigned to the VP the org tree is rooted at. */
export const DEMO_VP_NAME = "Dennis Sullivan";

/** Fake name the anonymizer assigned to the "Compliance Sales" pseudo-rep. */
export const DEMO_COMPLIANCE_SALES_REP = "Nicholas Riley A.";

/** Pick the live value or its anonymized counterpart. */
export function demoName(liveName: string, demoName_: string): string {
  return isDemoMode() ? demoName_ : liveName;
}

/** Directory of THIS module, whether running under tsx (ESM) or bundled (CJS). */
function moduleDir(): string | null {
  // Bundled output is CJS (see build.ts) — __dirname is the dist directory.
  try {
    if (typeof __dirname === "string" && __dirname.length > 0) return __dirname;
  } catch {
    /* not CJS */
  }
  // tsx / native ESM.
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

/**
 * Candidate locations of the `demo-data` directory, most specific first. The
 * fixtures live in the api-server package root, which is two levels up from
 * `src/lib` (tsx) and one level up from `dist` (compiled).
 */
function demoDataDirCandidates(): string[] {
  const out: string[] = [];
  const envDir = process.env.DEMO_DATA_DIR?.trim();
  if (envDir) out.push(path.resolve(envDir));
  const dir = moduleDir();
  if (dir) {
    out.push(path.resolve(dir, "..", "..", "demo-data")); // src/lib -> package root
    out.push(path.resolve(dir, "..", "demo-data")); // dist -> package root
    out.push(path.resolve(dir, "demo-data"));
  }
  out.push(path.resolve(process.cwd(), "demo-data"));
  out.push(path.resolve(process.cwd(), "artifacts", "api-server", "demo-data"));
  return out;
}

function resolveDemoFile(fileName: string): string {
  const tried: string[] = [];
  for (const dir of demoDataDirCandidates()) {
    const p = path.join(dir, fileName);
    tried.push(p);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `[Demo] Bundled fixture ${fileName} not found. Looked in: ${tried.join(", ")}`,
  );
}

let snapshotCache: DemoSnapshotFile | null = null;

/**
 * Load (once) and cache the bundled demo snapshot. ~55MB of JSON, so the parse
 * is deliberately lazy — the first upstream read (or the startup warm) pays for
 * it and every later read is a map lookup.
 */
export function loadDemoSnapshot(): DemoSnapshotFile {
  if (snapshotCache) return snapshotCache;
  const file = resolveDemoFile("snapshot.json");
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as DemoSnapshotFile;
  if (!parsed?.payload?.sheets || !parsed.payload.databricks) {
    throw new Error(`[Demo] ${file} is not a valid snapshot fixture`);
  }
  snapshotCache = parsed;
  logger.info(
    {
      snapshotDate: parsed.snapshotDate,
      sheets: Object.keys(parsed.payload.sheets).length,
      databricks: Object.keys(parsed.payload.databricks).length,
      file,
    },
    "[Demo] Loaded bundled snapshot fixture",
  );
  return parsed;
}

const EMPTY_PAYLOAD: SnapshotPayload = { sheets: {}, databricks: {} };
let snapshotLoadFailed = false;

/**
 * The demo snapshot payload, or an empty payload if the fixture is missing /
 * unreadable. Never throws — a broken fixture degrades every upstream read to
 * "empty" rather than taking the server down.
 */
export function demoSnapshotPayload(): SnapshotPayload {
  try {
    return loadDemoSnapshot().payload;
  } catch (err) {
    if (!snapshotLoadFailed) {
      snapshotLoadFailed = true;
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[Demo] Failed to load snapshot fixture — serving empty upstream data",
      );
    }
    return EMPTY_PAYLOAD;
  }
}

/** Absolute path of the db seed fixture. Throws when it is missing. */
export function demoDbSeedPath(): string {
  return resolveDemoFile("db-seed.json");
}

/** Load + parse the DB seed fixture (`{ tableName: rows[] }`). */
export function loadDemoDbSeed(): Record<string, Record<string, unknown>[]> {
  const file = demoDbSeedPath();
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
    string,
    Record<string, unknown>[]
  >;
  return parsed;
}

// Missing-source warnings are noisy inside per-row loops — log each key once.
const warnedKeys = new Set<string>();

export function warnMissingDemoSource(kind: "sheet" | "databricks", key: string): void {
  const id = `${kind}:${key}`;
  if (warnedKeys.has(id)) return;
  warnedKeys.add(id);
  logger.warn(
    { kind, key: key.length > 200 ? `${key.slice(0, 200)}…` : key },
    "[Demo] No fixture for upstream source — serving empty result",
  );
}
