import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGoalCsv, dedupeHeaders, goalCsvMonthValue, monthBucketKey } from "./goals-csv";

// ---------------------------------------------------------------------------
// Unit tests for Goal CSV parsing: duplicate-header de-duplication (so two
// "Product" columns no longer collide on the data map) and month derivation
// from a "Quota Month"-style header.
// ---------------------------------------------------------------------------

test("dedupeHeaders keeps the first occurrence and suffixes later duplicates", () => {
  assert.deepEqual(
    dedupeHeaders(["Quota Month", "Product", "Channel", "Segment", "Channel", "Product", "Channel", "Segment"]),
    ["Quota Month", "Product", "Channel", "Segment", "Channel (2)", "Product (2)", "Channel (3)", "Segment (2)"],
  );
});

test("dedupeHeaders is case-insensitive and passes empty headers through", () => {
  assert.deepEqual(dedupeHeaders(["Product", "", "product", ""]), ["Product", "", "product (2)", ""]);
});

test("goalCsvMonthValue prefers exact Month then falls back to a *month header", () => {
  assert.equal(goalCsvMonthValue({ Month: "5/1/2026", "Quota Month": "6/1/2026" }), "5/1/2026");
  assert.equal(goalCsvMonthValue({ "Quota Month": "6/1/2026" }), "6/1/2026");
  assert.equal(goalCsvMonthValue({ Region: "Central" }), "");
  // endsWith, not includes: an analytic column is not mistaken for the month.
  assert.equal(goalCsvMonthValue({ "Month-over-Month %": "3%" }), "");
});

test("monthBucketKey canonicalizes the derived month, falling back to raw", () => {
  assert.equal(monthBucketKey({ "Quota Month": "6/1/2026" }), "2026-06");
  assert.equal(monthBucketKey({ "Quota Month": "" }), "");
  assert.equal(monthBucketKey({}), "");
  // Unparseable month strings bucket consistently on the lowercased raw value.
  assert.equal(monthBucketKey({ "Quota Month": "FY26-Q2" }), "fy26-q2");
});

test("parseGoalCsv exposes both Product columns separately; first keeps clean per-row values", () => {
  const csv = [
    "Quota Month,Product,Channel,Segment,Channel,Product,Channel,Segment,Region",
    "6/1/2026,FUB,ACQ,SMB,ACQ,FUB / zPro,Acquisition,SMB,Central",
    "6/1/2026,zPro,ACQ,SMB,ACQ,,,,Central",
    "6/1/2026,ZMX,ACQ,SMB,ACQ,ZMX,Acquisition,SMB,Central",
  ].join("\n");
  const result = parseGoalCsv(csv);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // Both Product columns survive as distinct keys.
  assert.ok(result.columns.includes("Product"));
  assert.ok(result.columns.includes("Product (2)"));

  // The first "Product" column holds clean, separate per-row values...
  assert.deepEqual(
    result.rows.map((r) => r.data["Product"]),
    ["FUB", "zPro", "ZMX"],
  );
  // ...while the sparse display label (lumping "FUB / zPro") lands on "Product (2)".
  assert.equal(result.rows[0].data["Product (2)"], "FUB / zPro");
});

test("parseGoalCsv derives month from a Quota Month header", () => {
  const csv = ["Quota Month,Product,Region", "6/1/2026,MBP,Central"].join("\n");
  const result = parseGoalCsv(csv);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows[0].month, "6/1/2026");
});
