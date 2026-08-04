import { db } from "@workspace/db";
import { managerEstimatesTable, type ManagerEstimate } from "@workspace/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import { currentDate } from "./demo-mode";

// `month_yyyymm` is `YYYY-MM`. Helper centralizes formatting so callers
// never accidentally drift from this convention.
export function monthKey(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d + (d.length === 10 ? "T00:00:00" : "")) : d;
  if (Number.isNaN(dt.getTime())) return "";
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
}

export function currentMonthKey(): string {
  // currentDate() is the real clock live, and the frozen demo date in demo mode.
  return monthKey(currentDate());
}

// Last day of a YYYY-MM month, returned as ISO `YYYY-MM-DD`. Used by the
// pinned Manager Estimate row in the Sched Mods drilldown so its
// "Cancellation Date" cell shows month-end (per spec).
export function monthEndDate(monthYyyymm: string): string {
  const [y, m] = monthYyyymm.split("-").map(Number);
  if (!y || !m) return "";
  const d = new Date(y, m, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface ManagerEstimateRow {
  flmName: string;
  monthYyyymm: string;
  product: string;
  unweightedAmount: number;
  updatedByName: string | null;
  updatedByRole: string | null;
  updatedAt: string;
}

function rowFromDb(r: ManagerEstimate): ManagerEstimateRow {
  return {
    flmName: r.flmName,
    monthYyyymm: r.monthYyyymm,
    product: r.product,
    unweightedAmount: r.unweightedAmount,
    updatedByName: r.updatedByName,
    updatedByRole: r.updatedByRole,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function getManagerEstimates(
  monthYyyymm: string,
  flms?: string[],
): Promise<ManagerEstimateRow[]> {
  if (!monthYyyymm) return [];
  const where = flms && flms.length > 0
    ? and(eq(managerEstimatesTable.monthYyyymm, monthYyyymm), inArray(managerEstimatesTable.flmName, flms))
    : eq(managerEstimatesTable.monthYyyymm, monthYyyymm);
  const rows = await db.select().from(managerEstimatesTable).where(where);
  return rows.map(rowFromDb);
}

// Idempotently materialize a $0 row for (flm, current month, product)
// when none exists. Used on read so the matrix always has a row to bind
// the FLM input to. Past months never auto-create.
export async function ensureCurrentMonthRows(
  flmsByProduct: Array<{ flm: string; product: string }>,
): Promise<void> {
  if (flmsByProduct.length === 0) return;
  const month = currentMonthKey();
  const values = flmsByProduct.map((p) => ({
    flmName: p.flm,
    monthYyyymm: month,
    product: p.product,
    unweightedAmount: 0,
  }));
  try {
    await db
      .insert(managerEstimatesTable)
      .values(values)
      .onConflictDoNothing({
        target: [
          managerEstimatesTable.flmName,
          managerEstimatesTable.monthYyyymm,
          managerEstimatesTable.product,
        ],
      });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[ManagerEstimates] ensureCurrentMonthRows failed");
  }
}

export async function upsertManagerEstimate(
  flmName: string,
  monthYyyymm: string,
  product: string,
  unweightedAmount: number,
  updatedByName: string,
  updatedByRole: string,
): Promise<ManagerEstimateRow> {
  const cleaned = Math.max(0, Math.round(unweightedAmount));
  const inserted = await db
    .insert(managerEstimatesTable)
    .values({
      flmName,
      monthYyyymm,
      product,
      unweightedAmount: cleaned,
      updatedByName,
      updatedByRole,
    })
    .onConflictDoUpdate({
      target: [
        managerEstimatesTable.flmName,
        managerEstimatesTable.monthYyyymm,
        managerEstimatesTable.product,
      ],
      set: {
        unweightedAmount: cleaned,
        updatedByName,
        updatedByRole,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return rowFromDb(inserted[0]);
}

// Per-rep distribution: split each FLM's product amount evenly across the
// reps on that FLM's team; rounding remainders are absorbed by the first
// rep so the team total exactly matches the FLM-entered $.
export interface RepProductShare {
  rep: string;
  flm: string;
  monthYyyymm: string;
  product: string;
  amount: number;
}

export function distributePerRep(
  estimates: ManagerEstimateRow[],
  flmToReps: Record<string, string[]>,
): RepProductShare[] {
  const out: RepProductShare[] = [];
  for (const est of estimates) {
    const reps = (flmToReps[est.flmName] || []).filter((n) => !!n);
    if (reps.length === 0 || est.unweightedAmount <= 0) continue;
    const base = Math.floor(est.unweightedAmount / reps.length);
    const remainder = est.unweightedAmount - base * reps.length;
    for (let i = 0; i < reps.length; i++) {
      out.push({
        rep: reps[i],
        flm: est.flmName,
        monthYyyymm: est.monthYyyymm,
        product: est.product,
        amount: base + (i === 0 ? remainder : 0),
      });
    }
  }
  return out;
}

export function managerEstimateOppId(rep: string, monthYyyymm: string, product: string): string {
  return `mgr_est:${rep}|${monthYyyymm}|${product}`;
}
