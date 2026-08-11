import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

import type { Timeframe } from "../pages/Dashboard";
import { demoToday } from "./demo-mode";

export const ON_DEMAND_CHANNEL = "On Demand";
export const ALL_CHANNELS = "All Channels";

// The synthetic On Demand reps (literal rep-identity strings). They are NOT in
// the hierarchy sheet / config.org, so any UI that lists reps for the On Demand
// channel must source them from here.
export const ON_DEMAND_REPS = ["Account Sales", "Compliance Sales", "Zillow Sales"];

// Channel ("group") filter predicate shared by every view. "All Channels" means
// all REAL channels, so the synthetic On Demand channel is always excluded from
// it — its reps must never leak into All Channels totals regardless of the SLM
// filter state. For a specific channel, rows match only that exact group.
export function passesChannelFilter(
  rowGroup: string | undefined,
  filterGroup: string,
): boolean {
  if (filterGroup === ALL_CHANNELS) return rowGroup !== ON_DEMAND_CHANNEL;
  return rowGroup === filterGroup;
}

export function getTodayPST(): Date {
  // Demo mode is frozen to the date the bundled snapshot was captured, so every
  // "today"/MTD/current-month calculation lines up with the fixture data. In
  // live mode demoToday() is null and this is the original real-clock path.
  const frozen = demoToday();
  if (frozen) {
    const [y, m, d] = frozen.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const pst = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  const d = new Date(pst);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * The current date-time for display/logic. In demo mode this is frozen to
 * midday on the demo date (so date AND "as of" labels never move); in live
 * mode it is the real clock. Use instead of `new Date()` anywhere the value
 * is shown to the user or selects which data is shown.
 */
export function nowPST(): Date {
  const frozen = demoToday();
  if (frozen) {
    const [y, m, d] = frozen.split("-").map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  }
  return new Date();
}

export function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---- Business-day utilities (used by quota proration) ----
// All inputs are local Dates anchored to PST midnight (consistent with the
// rest of date math in this module). `holidaySet` is a Set of holiday dates
// in `YYYY-MM-DD` form; pass an empty set to fall back to weekends-only.

export function isBusinessDay(date: Date, holidaySet: Set<string>): boolean {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false;
  return !holidaySet.has(fmtDate(date));
}

export function countBusinessDaysInMonth(year: number, month: number, holidaySet: Set<string>): number {
  const lastDay = new Date(year, month + 1, 0).getDate();
  let count = 0;
  for (let d = 1; d <= lastDay; d++) {
    const day = new Date(year, month, d);
    if (isBusinessDay(day, holidaySet)) count++;
  }
  return count;
}

export function enumerateBusinessDays(from: Date, to: Date, holidaySet: Set<string>): Date[] {
  const out: Date[] = [];
  if (!from || !to) return out;
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  if (end < start) return out;
  const cur = new Date(start);
  while (cur <= end) {
    if (isBusinessDay(cur, holidaySet)) out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export type ModsStart = "monthStart" | "today";
export type ModsExtend = "none" | "plus30";

function getNaturalPeriodBounds(timeframe: Timeframe, customRange?: { from: Date; to: Date }): { from: Date; to: Date } | null {
  const today = getTodayPST();
  switch (timeframe) {
    case "mtd": {
      const from = new Date(today.getFullYear(), today.getMonth(), 1);
      const to = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { from, to };
    }
    case "lastMonth": {
      const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const to = new Date(today.getFullYear(), today.getMonth(), 0);
      return { from, to };
    }
    case "mtd2date": {
      const from = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from, to: today };
    }
    case "thisWeek": {
      const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
      const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7);
      return { from, to };
    }
    case "eom": {
      const to = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { from: today, to };
    }
    case "today": {
      return { from: today, to: today };
    }
    case "custom": {
      if (customRange) return { from: customRange.from, to: customRange.to };
      return null;
    }
    default:
      return null;
  }
}

export function isTodayWithinPeriod(timeframe: Timeframe, customRange?: { from: Date; to: Date }): boolean {
  const bounds = getNaturalPeriodBounds(timeframe, customRange);
  if (!bounds) return false;
  const today = getTodayPST();
  return today >= bounds.from && today <= bounds.to;
}

export function getModsDateRange(
  timeframe: Timeframe,
  customRange: { from: Date; to: Date } | undefined,
  modsStart: ModsStart,
  modsExtend: ModsExtend,
): { from?: string; to?: string; fromDate?: Date; toDate?: Date } {
  const bounds = getNaturalPeriodBounds(timeframe, customRange);
  if (!bounds) return {};
  const today = getTodayPST();
  const startDate = modsStart === "today" && today >= bounds.from && today <= bounds.to ? today : bounds.from;
  const toDate = modsExtend === "plus30" ? new Date(bounds.to.getTime() + 30 * 86400000) : bounds.to;
  return { from: fmtDate(startDate), to: fmtDate(toDate), fromDate: startDate, toDate };
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatModsCaption(fromDate?: Date, toDate?: Date): string {
  if (!fromDate || !toDate) return "All Time Scheduled Mods";
  const from = `${SHORT_MONTHS[fromDate.getMonth()]} ${fromDate.getDate()}`;
  const to = `${SHORT_MONTHS[toDate.getMonth()]} ${toDate.getDate()}`;
  return `${from} – ${to} Scheduled Mods`;
}

export type WindowedRemainingEligibility =
  | { mode: 'fallback-to-pacing' }
  | {
      mode: 'windowed-remaining';
      anchorDay: number;
      windowBizdays: number;
      wasClamped: boolean;
      effectiveStartDate: Date;
      effectiveEndDate: Date;
    };

export function computeWindowedRemainingEligibility(
  filterFrom: Date,
  filterTo: Date,
  today: Date,
  holidaySet: Set<string>,
): WindowedRemainingEligibility {
  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const currentMonthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  if (filterTo < currentMonthStart) {
    return { mode: 'fallback-to-pacing' };
  }
  const effectiveStart = filterFrom < currentMonthStart ? currentMonthStart : filterFrom;
  const effectiveEnd = filterTo > currentMonthEnd ? currentMonthEnd : filterTo;
  if (effectiveStart > effectiveEnd) {
    return { mode: 'fallback-to-pacing' };
  }
  let windowBizdays = 0;
  {
    const d = new Date(effectiveStart);
    while (d <= effectiveEnd) {
      if (isBusinessDay(d, holidaySet)) windowBizdays++;
      d.setDate(d.getDate() + 1);
    }
  }
  if (windowBizdays === 0) {
    return { mode: 'fallback-to-pacing' };
  }
  const wasClamped =
    filterFrom.getTime() < currentMonthStart.getTime() ||
    filterTo.getTime() > currentMonthEnd.getTime();
  let anchorDate: Date;
  if (today >= effectiveStart && today <= effectiveEnd) {
    anchorDate = today;
  } else if (today < effectiveStart) {
    anchorDate = today;
  } else {
    anchorDate = effectiveStart;
  }
  return {
    mode: 'windowed-remaining',
    anchorDay: anchorDate.getDate(),
    windowBizdays,
    wasClamped,
    effectiveStartDate: effectiveStart,
    effectiveEndDate: effectiveEnd,
  };
}

// Date-lock for the prorate Pacing/Remaining toggles. When prorate is on,
// the date filter must align with the active mode:
//   - Remaining: every date in the window must be ≥ today (today + future).
//   - Pacing   : every date in the window must be ≤ today (today + past).
// Returns the snap target when the current filter violates the rule, or null
// when the filter already satisfies it. "thisWeek" snaps to a custom range
// inside the current calendar week; everything else snaps to the canonical
// preset (eom for Remaining, mtd2date for Pacing).
export function snapDateFilterForProrateMode(
  timeframe: Timeframe,
  customRange: { from: Date; to: Date } | undefined,
  mode: "pacing" | "remaining",
): { timeframe: Timeframe; customRange?: { from: Date; to: Date } } | null {
  const today = getTodayPST();
  const todayStr = fmtDate(today);
  const r = getDateRange(timeframe, customRange);
  // Empty / unresolvable range (e.g. timeframe="custom" with no customRange):
  // treat as a violation and snap to the canonical target so Prorate always
  // has a well-defined window.
  const empty = !r.from || !r.to;
  if (mode === "remaining") {
    if (!empty && r.from! >= todayStr) return null;
    if (timeframe === "thisWeek") {
      const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
      const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7);
      return { timeframe: "custom", customRange: { from: today, to: weekEnd } };
    }
    return { timeframe: "eom", customRange: undefined };
  }
  // Pacing
  if (!empty && r.to! <= todayStr) return null;
  if (timeframe === "thisWeek") {
    const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
    return { timeframe: "custom", customRange: { from: weekStart, to: today } };
  }
  return { timeframe: "mtd2date", customRange: undefined };
}

export function getDateRange(timeframe: Timeframe, customRange?: { from: Date; to: Date }): { from?: string; to?: string } {
  const today = getTodayPST();

  switch (timeframe) {
    case "allTime": {
      const start = new Date(today.getFullYear(), today.getMonth() - 6, today.getDate());
      return { from: fmtDate(start), to: fmtDate(today) };
    }
    case "mtd": {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { from: fmtDate(start), to: fmtDate(end) };
    }
    case "lastMonth": {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const end = new Date(today.getFullYear(), today.getMonth(), 0);
      return { from: fmtDate(start), to: fmtDate(end) };
    }
    case "mtd2date": {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: fmtDate(start), to: fmtDate(today) };
    }
    case "thisWeek": {
      const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
      return { from: fmtDate(start), to: fmtDate(end) };
    }
    case "eom": {
      const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { from: fmtDate(today), to: fmtDate(end) };
    }
    case "today": {
      return { from: fmtDate(today), to: fmtDate(today) };
    }
    case "custom": {
      if (customRange) {
        return { from: fmtDate(customRange.from), to: fmtDate(customRange.to) };
      }
      return {};
    }
    default:
      return {};
  }
}
