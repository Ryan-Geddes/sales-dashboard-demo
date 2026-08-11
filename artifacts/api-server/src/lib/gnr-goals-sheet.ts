// G&R rep monthly goals sourced from a dedicated Google Sheet.
//
// Per the product owner (May 2026): for any rep whose hierarchy group is
// "G&R", the goals come from this sheet — NOT Databricks. The sheet is the
// sole source of truth for G&R MRR Added, MRR Lost (churn), and the derived
// Net MRR (= MRR Added + MRR Lost, with MRR Lost stored as a negative number
// in the sheet).
//
// Sheet layout (gid 0):
//   A date_recorded   B Month (YYYY-MM-01)   C Product (Showcase|MBP)
//   D Manager         E Name (rep)           F Region   G Segment
//   H LOA Status      I eRep Value           J MRR Added Productivity
//   K MRR Lost        L Adjusted MRR Added   M Adjusted MRR Lost
//   N Starting MRR    O Ending MRR Goal      P MRR ADDED GOAL
//   Q MRR LOST GOAL
//
// Acquisition reps are unaffected — they continue to use Databricks quotas.

import { logger } from "./logger";
import { getAccessToken } from "./google-auth";
import { isDemoMode } from "./demo-mode";
import type { RepQuota } from "./databricks-quota";
import { buildProductGoals } from "./databricks-quota";

// Env-only: no hardcoded fallback so the id never ships in the public repo.
// In demo mode this sheet is never fetched (isDemoMode() guards the fetch);
// live requires GNR_GOALS_SHEET_ID to be set in the environment.
const SHEET_ID = process.env.GNR_GOALS_SHEET_ID?.trim() || "";
const GID = "0";
const CACHE_TTL_MS = 30 * 60 * 1000;

export interface GnrGoalEntry {
  scMrrAddedGoal: number;
  scChurnGoal: number;        // positive magnitude (UI convention)
  scNetMrrGoal: number;        // added + signed lost
  mbpMrrAddedGoal: number;
  mbpChurnGoal: number;
  mbpNetMrrGoal: number;
}

export interface GnrGoalsByMonth {
  // YYYY-MM -> repName -> entry
  byMonth: Record<string, Record<string, GnrGoalEntry>>;
  fetchError: boolean;
  fetchErrorMessage?: string;
}

let cached: GnrGoalsByMonth | null = null;
let cacheTime = 0;

export function clearGnrGoalsSheetCache(): void {
  cached = null;
  cacheTime = 0;
}

// Parse "$1,234", "-$1,234", or "(1,234)" -> number. Returns 0 on garbage.
function parseMoney(raw: string | undefined): number {
  if (!raw) return 0;
  let s = raw.trim();
  if (!s) return 0;
  // Accounting parentheses -> negative
  let neg = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  }
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  return neg ? -n : n;
}

// Record-level CSV parser that handles quoted fields containing commas,
// embedded newlines (CR/LF/CRLF), and escaped quotes (""). Splitting on
// raw "\n" before quote handling — as a naive line parser would do — would
// misparse any multi-line cell.
function parseCSV(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else { inQ = false; }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQ = true;
      } else if (c === ",") {
        row.push(cur); cur = "";
      } else if (c === "\n" || c === "\r") {
        row.push(cur); cur = "";
        // Skip the LF in a CRLF pair so we don't emit an empty row.
        if (c === "\r" && text[i + 1] === "\n") i++;
        if (row.length > 1 || row[0] !== "") records.push(row);
        row = [];
      } else {
        cur += c;
      }
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    if (row.length > 1 || row[0] !== "") records.push(row);
  }
  return records;
}

async function fetchSheet(): Promise<string> {
  // Demo mode: this sheet is read directly (not through the fetchSheetCSV
  // snapshot chokepoint) and is not part of the bundled fixture. Serve an empty
  // sheet rather than making an outbound Google request. Only reachable with
  // DASHBOARD_GOALS_SOURCE=legacy.
  if (isDemoMode()) return "";
  if (!SHEET_ID) {
    throw new Error("GNR_GOALS_SHEET_ID env var is required in live mode");
  }
  const token = await getAccessToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const urls = [
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`,
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${GID}`,
  ];
  let lastErr = "all endpoints failed";
  for (const url of urls) {
    try {
      const resp = await fetch(url, { headers, redirect: "follow" });
      if (resp.ok) {
        const text = await resp.text();
        if (text && text.length > 0) return text;
      } else {
        lastErr = `HTTP ${resp.status}`;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`Could not fetch G&R goals sheet — ${lastErr}`);
}

export async function fetchGnrGoalsFromSheet(): Promise<GnrGoalsByMonth> {
  const now = Date.now();
  if (cached && now - cacheTime < CACHE_TTL_MS) return cached;

  try {
    const text = await fetchSheet();
    const records = parseCSV(text);
    if (records.length < 2) throw new Error("G&R goals sheet is empty");

    const byMonth: Record<string, Record<string, GnrGoalEntry>> = {};
    let parsed = 0;
    let skipped = 0;

    // Skip header row (index 0)
    for (let i = 1; i < records.length; i++) {
      const cols = records[i];
      const rawMonth = (cols[1] || "").trim();         // B
      const rawProduct = (cols[2] || "").trim();       // C
      const repName = (cols[4] || "").trim();          // E
      if (!rawMonth || !rawProduct || !repName) { skipped++; continue; }

      const ym = rawMonth.slice(0, 7);                  // "2026-05-01" -> "2026-05"
      if (!/^\d{4}-\d{2}$/.test(ym)) { skipped++; continue; }

      const added = parseMoney(cols[15]);               // P
      const lostSigned = parseMoney(cols[16]);          // Q (typically negative)

      if (!byMonth[ym]) byMonth[ym] = {};
      if (!byMonth[ym][repName]) {
        byMonth[ym][repName] = {
          scMrrAddedGoal: 0, scChurnGoal: 0, scNetMrrGoal: 0,
          mbpMrrAddedGoal: 0, mbpChurnGoal: 0, mbpNetMrrGoal: 0,
        };
      }
      const entry = byMonth[ym][repName];
      const prod = rawProduct.toLowerCase();
      const churn = Math.abs(lostSigned);
      const net = added + lostSigned;                   // user formula

      if (prod === "showcase" || prod === "sc") {
        entry.scMrrAddedGoal = added;
        entry.scChurnGoal = churn;
        entry.scNetMrrGoal = net;
        parsed++;
      } else if (prod === "mbp" || prod === "managed business plan" || prod === "market based pricing") {
        entry.mbpMrrAddedGoal = added;
        entry.mbpChurnGoal = churn;
        entry.mbpNetMrrGoal = net;
        parsed++;
      } else {
        skipped++;
      }
    }

    const result: GnrGoalsByMonth = { byMonth, fetchError: false };
    cached = result;
    cacheTime = now;
    logger.info({
      months: Object.keys(byMonth),
      repsByMonth: Object.fromEntries(Object.entries(byMonth).map(([m, r]) => [m, Object.keys(r).length])),
      parsed,
      skipped,
    }, "[GnrGoals] Sheet load complete");
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "[GnrGoals] Failed to fetch G&R goals from sheet");
    if (cached) return { ...cached, fetchError: true, fetchErrorMessage: msg };
    return { byMonth: {}, fetchError: true, fetchErrorMessage: msg };
  }
}

// Replace G&R rep entries in the Databricks-derived current/lastMonth maps
// with sheet-derived values. Per product spec, the sheet is the sole source
// of truth for G&R reps — any G&R rep without a sheet row for the month is
// removed (NOT silently kept from Databricks). Acquisition reps are
// untouched.
//
// On a sheet fetch error, the override is skipped so the dashboard falls
// back to whatever Databricks returned (avoids clobbering on transient
// failures).
export function applyGnrSheetOverride(
  current: Record<string, RepQuota>,
  lastMonth: Record<string, RepQuota>,
  repToGroup: Record<string, string>,
  goals: GnrGoalsByMonth,
  currentYm: string,
  lastYm: string,
): { overrideApplied: boolean; gnrRepsCurrent: number; gnrRepsLast: number } {
  if (goals.fetchError) {
    return { overrideApplied: false, gnrRepsCurrent: 0, gnrRepsLast: 0 };
  }

  const stripGnr = (m: Record<string, RepQuota>) => {
    for (const rep of Object.keys(m)) {
      if (repToGroup[rep] === "G&R") delete m[rep];
    }
  };
  stripGnr(current);
  stripGnr(lastMonth);

  const fill = (ym: string, target: Record<string, RepQuota>): number => {
    const monthRows = goals.byMonth[ym] || {};
    let count = 0;
    for (const [repName, e] of Object.entries(monthRows)) {
      if (repToGroup[repName] !== "G&R") continue;
      const totalNet = e.scNetMrrGoal + e.mbpNetMrrGoal;
      target[repName] = {
        showcaseQuota: e.scNetMrrGoal,
        mbpQuota: e.mbpNetMrrGoal,
        totalQuota: totalNet,
        scNetMrrGoal: e.scNetMrrGoal,
        mbpNetMrrGoal: e.mbpNetMrrGoal,
        totalNetMrrGoal: totalNet,
        scChurnGoal: e.scChurnGoal,
        mbpChurnGoal: e.mbpChurnGoal,
        scMrrAddedGoal: e.scMrrAddedGoal,
        mbpMrrAddedGoal: e.mbpMrrAddedGoal,
        // Per-product goal map built via the single shared extension point
        // (buildProductGoals in databricks-quota.ts) — the G&R sheet entry
        // exposes the same scalar goal fields as a Databricks quota row.
        productGoals: buildProductGoals(e),
        group: "G&R",
      };
      count++;
    }
    return count;
  };

  const gnrRepsCurrent = fill(currentYm, current);
  const gnrRepsLast = fill(lastYm, lastMonth);
  return { overrideApplied: true, gnrRepsCurrent, gnrRepsLast };
}
