import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isErepFresh,
  erepFetchedAtIso,
  erepMonthKey,
  collapseLatestPerMonth,
  erepMultipliersForMonth,
  type ErepSnapshot,
} from "./goals-erep";

// ---------------------------------------------------------------------------
// Pure helpers for the eRep snapshot (Task #467): the ~30m freshness cadence,
// the fetchedAt ISO contract, the latest-snapshot-per-month collapse (with
// employee-id zero-padding normalization), and the per-month lookup builder.
// ---------------------------------------------------------------------------

const TTL = 30 * 60 * 1000;

test("isErepFresh: within TTL fresh, at/over TTL stale, null never fresh", () => {
  const now = 10_000_000;
  assert.equal(isErepFresh(now - 1000, now, TTL), true);
  assert.equal(isErepFresh(now - (TTL - 1), now, TTL), true);
  assert.equal(isErepFresh(now - TTL, now, TTL), false);
  assert.equal(isErepFresh(now - (TTL + 1), now, TTL), false);
  assert.equal(isErepFresh(null, now, TTL), false);
});

test("erepFetchedAtIso: epoch ms → ISO string, null → null", () => {
  assert.equal(erepFetchedAtIso(null), null);
  assert.equal(erepFetchedAtIso(0), "1970-01-01T00:00:00.000Z");
  assert.equal(erepFetchedAtIso(Date.UTC(2026, 5, 8, 12, 30, 0)), "2026-06-08T12:30:00.000Z");
});

test("erepMonthKey: takes the YYYY-MM prefix of a snapshot date", () => {
  assert.equal(erepMonthKey("2026-06-15"), "2026-06");
  assert.equal(erepMonthKey("2026-06-15T00:00:00.000Z"), "2026-06");
  assert.equal(erepMonthKey(""), "");
});

test("collapseLatestPerMonth: keeps the latest snapshot per (employeeId, month)", () => {
  const rows = collapseLatestPerMonth([
    { employeeId: "123", snapshotDate: "2026-06-01", erepValue: 1.1 },
    { employeeId: "123", snapshotDate: "2026-06-20", erepValue: 1.5 },
    { employeeId: "123", snapshotDate: "2026-05-28", erepValue: 0.9 },
  ]);
  // One row for June (latest 06-20 → 1.5) and one for May (0.9).
  const june = rows.find((r) => r.month === "2026-06");
  const may = rows.find((r) => r.month === "2026-05");
  assert.equal(rows.length, 2);
  assert.equal(june?.erepValue, 1.5);
  assert.equal(may?.erepValue, 0.9);
});

test("collapseLatestPerMonth: normalizes zero-padded employee ids and collapses them together", () => {
  const rows = collapseLatestPerMonth([
    { employeeId: "00123", snapshotDate: "2026-06-01", erepValue: 1.1 },
    { employeeId: "123", snapshotDate: "2026-06-10", erepValue: 1.4 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].employeeId, "123");
  assert.equal(rows[0].erepValue, 1.4);
});

test("collapseLatestPerMonth: drops blank ids, bad months, and non-finite values", () => {
  const rows = collapseLatestPerMonth([
    { employeeId: "", snapshotDate: "2026-06-01", erepValue: 1.1 },
    { employeeId: "555", snapshotDate: "bad", erepValue: 1.1 },
    { employeeId: "777", snapshotDate: "2026-06-01", erepValue: NaN },
    { employeeId: "888", snapshotDate: "2026-06-01", erepValue: 1.2 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].employeeId, "888");
});

test("erepMultipliersForMonth: builds the per-month employeeId → value lookup", () => {
  const snapshot: ErepSnapshot = {
    rows: [
      { employeeId: "123", month: "2026-06", snapshotDate: "2026-06-20", erepValue: 1.5 },
      { employeeId: "456", month: "2026-06", snapshotDate: "2026-06-20", erepValue: 0.8 },
      { employeeId: "123", month: "2026-05", snapshotDate: "2026-05-20", erepValue: 1.0 },
    ],
    fetchedAt: 1,
    fetchError: false,
  };
  const june = erepMultipliersForMonth(snapshot, "2026-06");
  assert.equal(june.get("123"), 1.5);
  assert.equal(june.get("456"), 0.8);
  assert.equal(june.has("789"), false);
  const may = erepMultipliersForMonth(snapshot, "2026-05");
  assert.equal(may.get("123"), 1.0);
  assert.equal(may.has("456"), false);
});
