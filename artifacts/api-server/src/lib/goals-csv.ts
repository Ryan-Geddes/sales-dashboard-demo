// Goal CSV goal source (Executive → Goals).
//
// Users upload a Goal CSV. The full source row is stored verbatim (column name
// → cell) in `data` so any column can be inspected or mapped to a goal via the
// configurable output mapping — no fixed schema is enforced. An upload replaces
// only the rows for the month(s) it contains (the CSV is the source of truth
// for those months); rows for other months are left intact, and the rows
// persist between sessions. Duplicate headers are de-duplicated on parse so each
// column keeps its own key. `Month`/`Group`/`Region`/`Segment` are denormalized
// from their canonically-named columns (case-insensitive; "Month" also matches
// e.g. "Quota Month") for filtering and joining. Resolution into per-rep goals
// lives in goals-resolvers.ts.

import { db } from "@workspace/db";
import { goalCsvRowsTable, goalConfigTable, type GoalCsvRow } from "@workspace/db/schema";
import { eq, sql, inArray } from "drizzle-orm";
import { logger } from "./logger";
import { compMonthKey } from "./compensation";

export type { GoalCsvRow };

// jsonb does not preserve object key order, so the uploaded column order is
// stored separately under this goal_config key (mirrors the finance.pps
// inspect-columns convention of keeping presentation metadata in config).
export const GOAL_CSV_META_KEY = "goalCsvMeta";

// Canonical columns used only for denormalizing the join/filter fields. Any
// other column is preserved as-is in `data`; there are no required headers.
const CANONICAL_FIELDS = {
  month: "Month",
  group: "Group",
  region: "Region",
  segment: "Segment",
} as const;

export interface ParsedGoalCsvRow {
  month: string;
  group: string;
  region: string;
  segment: string;
  data: Record<string, string>;
}

export type CsvParseResult =
  | { ok: true; rows: ParsedGoalCsvRow[]; columns: string[] }
  | { ok: false; error: string };

// --- CSV tokenizer (handles quoted fields, escaped quotes, CRLF) ---

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // ignore; handled by the following \n
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Read a value from a row's data map by header name, case-insensitively. */
function dataValueCI(data: Record<string, string>, name: string): string {
  const want = name.trim().toLowerCase();
  for (const [k, v] of Object.entries(data)) {
    if (k.trim().toLowerCase() === want) return v ?? "";
  }
  return "";
}

/** De-duplicate header names, preserving order. The first occurrence keeps its
 *  original name; later duplicates are suffixed (" (2)", " (3)", …) so every
 *  column is preserved as its own key instead of colliding in the data map.
 *  Empty headers are passed through untouched (they're skipped downstream). */
export function dedupeHeaders(raw: string[]): string[] {
  const counts = new Map<string, number>();
  return raw.map((h) => {
    const name = h.trim();
    if (name === "") return "";
    const n = (counts.get(name.toLowerCase()) ?? 0) + 1;
    counts.set(name.toLowerCase(), n);
    return n === 1 ? name : `${name} (${n})`;
  });
}

/** Resolve a row's month value from its data map. Prefers an exact "Month"
 *  header, then falls back to a header ending in "month" (e.g. the common
 *  "Quota Month") — endsWith, not includes, so analytic columns like
 *  "Month-over-Month %" aren't mistaken for the month. Returns "" when no
 *  month-like column is present. */
export function goalCsvMonthValue(data: Record<string, string>): string {
  const exact = dataValueCI(data, CANONICAL_FIELDS.month);
  if (exact) return exact;
  for (const [k, v] of Object.entries(data)) {
    if (k.trim().toLowerCase().endsWith("month") && v) return v;
  }
  return "";
}

/** Parse raw CSV text into raw rows + the uploaded column order. No required
 *  columns are enforced — every header becomes a key in each row's data map. */
export function parseGoalCsv(text: string): CsvParseResult {
  const grid = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (grid.length === 0) return { ok: false, error: "CSV is empty" };

  // Trim header names, preserving order, and de-duplicate so repeated headers
  // (e.g. two "Product" columns) each get a distinct key instead of the later
  // one clobbering the earlier (which previously made "Product" resolve to a
  // sparse display label). The first occurrence keeps its original name.
  const columns = dedupeHeaders(grid[0]);
  if (columns.every((c) => c === "")) return { ok: false, error: "CSV has no column headers" };

  const rows: ParsedGoalCsvRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i];
    const data: Record<string, string> = {};
    columns.forEach((col, c) => {
      if (col === "") return;
      data[col] = (cells[c] ?? "").trim();
    });
    rows.push({
      month: goalCsvMonthValue(data),
      group: dataValueCI(data, CANONICAL_FIELDS.group),
      region: dataValueCI(data, CANONICAL_FIELDS.region),
      segment: dataValueCI(data, CANONICAL_FIELDS.segment),
      data,
    });
  }
  if (rows.length === 0) return { ok: false, error: "CSV has a header but no data rows" };
  return { ok: true, rows, columns: columns.filter((c) => c !== "") };
}

/** Canonical month key used to scope a per-month replace. Prefers the
 *  YYYY-MM canonicalization; falls back to the raw value (lowercased) so rows
 *  whose month cannot be parsed still bucket consistently. */
export function monthBucketKey(data: Record<string, string>): string {
  const v = goalCsvMonthValue(data);
  return compMonthKey(v) || v.trim().toLowerCase();
}

/** Replace stored Goal CSV rows for only the month(s) present in a freshly
 *  uploaded set, leaving rows for other months untouched, and record the
 *  uploaded column order. Existing rows are bucketed by re-deriving their month
 *  from their stored `data` (not the denormalized column), so rows persisted
 *  before month detection was fixed are still matched and replaced. When the
 *  upload has no determinable month, falls back to a full replace. */
export async function replaceGoalCsvRows(
  rows: ParsedGoalCsvRow[],
  columns: string[],
  uploadedByName: string | null,
): Promise<number> {
  const incomingMonths = new Set(rows.map((r) => monthBucketKey(r.data)).filter((k) => k !== ""));
  await db.transaction(async (tx) => {
    if (incomingMonths.size === 0) {
      // No month could be derived from the upload — fall back to a full replace.
      await tx.delete(goalCsvRowsTable);
    } else {
      const existing = await tx
        .select({ id: goalCsvRowsTable.id, data: goalCsvRowsTable.data })
        .from(goalCsvRowsTable);
      const staleIds = existing
        .filter((e) => incomingMonths.has(monthBucketKey((e.data ?? {}) as Record<string, string>)))
        .map((e) => e.id);
      if (staleIds.length > 0) {
        await tx.delete(goalCsvRowsTable).where(inArray(goalCsvRowsTable.id, staleIds));
      }
    }
    if (rows.length > 0) {
      await tx.insert(goalCsvRowsTable).values(
        rows.map((r) => ({
          month: r.month,
          group: r.group,
          region: r.region,
          segment: r.segment,
          data: r.data,
          uploadedByName,
        })),
      );
    }
    await tx
      .insert(goalConfigTable)
      .values({ key: GOAL_CSV_META_KEY, value: { columns }, updatedByName: uploadedByName })
      .onConflictDoUpdate({
        target: goalConfigTable.key,
        set: { value: { columns }, updatedByName: uploadedByName, updatedAt: sql`now()` },
      });
  });
  logger.info(
    { rowCount: rows.length, columnCount: columns.length, months: [...incomingMonths] },
    "[Goals CSV] Rows replaced per-month",
  );
  return rows.length;
}

/** The uploaded column order (empty if nothing has been uploaded yet). */
export async function getGoalCsvColumns(): Promise<string[]> {
  try {
    const rows = await db
      .select()
      .from(goalConfigTable)
      .where(eq(goalConfigTable.key, GOAL_CSV_META_KEY))
      .limit(1);
    if (rows.length === 0) return [];
    const cols = (rows[0].value as { columns?: unknown })?.columns;
    return Array.isArray(cols) ? cols.filter((c): c is string => typeof c === "string") : [];
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[Goals CSV] getGoalCsvColumns failed; returning none",
    );
    return [];
  }
}

export interface GoalCsvFilter {
  month?: string;
  group?: string;
  region?: string;
  segment?: string;
}

/** List stored Goal CSV rows, optionally filtered (case-insensitive). */
export async function getGoalCsvRows(filter: GoalCsvFilter = {}): Promise<GoalCsvRow[]> {
  const all = await db.select().from(goalCsvRowsTable);
  const eqi = (a: string, b?: string) => b == null || a.trim().toLowerCase() === b.trim().toLowerCase();
  // Months are stored verbatim from the uploaded CSV (e.g. "5/1/2026"), but
  // callers filter with a canonical YYYY-MM key. Canonicalize both sides so a
  // stored "5/1/2026" matches a "2026-05" filter — mirrors `monthMatches` in
  // goals-resolvers, which is why resolution works while raw inspect did not.
  const monthMatches = (rowMonth: string, target?: string) => {
    if (target == null) return true;
    const t = target.trim();
    const rk = compMonthKey(rowMonth);
    const tk = compMonthKey(t) || t;
    if (rk) return rk === tk;
    return eqi(rowMonth, t);
  };
  return all.filter(
    (r) =>
      monthMatches(r.month, filter.month) &&
      eqi(r.group, filter.group) &&
      eqi(r.region, filter.region) &&
      eqi(r.segment, filter.segment),
  );
}
