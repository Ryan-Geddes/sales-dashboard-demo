import { test } from "node:test";
import assert from "node:assert/strict";
import { rowsToRepQuotas } from "./goals-quota-source";
import type { GoalTableRow } from "./goals-table";
import type { GoalProduct } from "./goals-types";

// ---------------------------------------------------------------------------
// Task #262: the dashboard's goal source is the Goals tab's FINAL output.
// rowsToRepQuotas reduces the rep × product Final rows into the per-rep
// RepQuota shape the dashboard already consumed from the legacy quota path.
// These tests pin the cutover contract:
//   1. Per-product map carries Final Added/Churn and net = Added − Churn.
//   2. Showcase/MBP scalar fields mirror their product rows exactly.
//   3. Rep totals sum the net goal across ALL FIVE products (the expansion).
// ---------------------------------------------------------------------------

function row(
  rep: string,
  product: GoalProduct,
  added: number,
  churn: number,
  group = "GnR",
): GoalTableRow {
  return {
    month: "2026-06",
    group,
    rep,
    employeeId: "E1",
    salesRole: "rep",
    slm: "S",
    flm: "F",
    region: "West",
    segment: "SMB",
    teamSize: 1,
    product,
    source: "financePps",
    mrrAddedGoal: added,
    mrrChurnGoal: churn,
    mrrAddedMinimum: 0,
    mrrChurnMaximum: 0,
    mrrAddedManualMultiplier: 1,
    mrrChurnManualMultiplier: 1,
    loaStatus: "Active",
    eRepManualMultiplier: null,
    eRepDatabricksMultiplier: null,
    eRepMultiplier: 1,
    finalMrrAddedGoal: added,
    finalChurnGoal: churn,
    finalMrrMinGoal: 0,
    finalChurnMaxGoal: 0,
  };
}

test("rowsToRepQuotas maps Final goals per product with net = added - churn", () => {
  const q = rowsToRepQuotas([row("Alice", "Zillow Pro", 1000, 200)])["Alice"];
  assert.deepEqual(q.productGoals["Zillow Pro"], {
    mrrAddedGoal: 1000,
    churnGoal: 200,
    netGoal: 800,
  });
});

test("Showcase/MBP scalar fields mirror their product rows exactly", () => {
  const q = rowsToRepQuotas([
    row("Bob", "Showcase", 12000, 3000),
    row("Bob", "MBP", 5000, 1500),
  ])["Bob"];
  assert.equal(q.scMrrAddedGoal, 12000);
  assert.equal(q.scChurnGoal, 3000);
  assert.equal(q.scNetMrrGoal, 9000);
  assert.equal(q.showcaseQuota, 9000);
  assert.equal(q.mbpMrrAddedGoal, 5000);
  assert.equal(q.mbpChurnGoal, 1500);
  assert.equal(q.mbpNetMrrGoal, 3500);
  assert.equal(q.mbpQuota, 3500);
});

test("rep totals sum net goal across all five products", () => {
  const q = rowsToRepQuotas([
    row("Cara", "Showcase", 1000, 100),
    row("Cara", "MBP", 2000, 200),
    row("Cara", "Zillow Pro", 3000, 300),
    row("Cara", "Follow Up Boss", 4000, 400),
    row("Cara", "ZMX", 5000, 500),
  ])["Cara"];
  // nets: 900 + 1800 + 2700 + 3600 + 4500 = 13500
  assert.equal(q.totalQuota, 13500);
  assert.equal(q.totalNetMrrGoal, 13500);
  assert.equal(Object.keys(q.productGoals).length, 5);
});

// ---------------------------------------------------------------------------
// Task #311: scoped GNR-vs-ACQ churn handling.
//   - ACQ reps carry NO churn goal: ignore it entirely → net = MRR Added only.
//   - GNR net = Added − |Churn|: the feeder sheet's loss sign keeps changing, so
//     always subtract the loss magnitude (positive or accounting-negative).
//   - The "ACQ" group label and the hierarchy's "Acquisitions" both count as ACQ.
// ---------------------------------------------------------------------------

test("ACQ reps ignore churn entirely: net = added, churn goal zeroed", () => {
  const q = rowsToRepQuotas([
    row("Andrew", "Showcase", 4859, 5076, "ACQ"),
    row("Andrew", "MBP", 2000, 800, "ACQ"),
  ])["Andrew"];
  assert.equal(q.scMrrAddedGoal, 4859);
  assert.equal(q.scChurnGoal, 0);
  assert.equal(q.scNetMrrGoal, 4859);
  assert.equal(q.showcaseQuota, 4859);
  assert.deepEqual(q.productGoals["Showcase"], {
    mrrAddedGoal: 4859,
    churnGoal: 0,
    netGoal: 4859,
  });
  assert.equal(q.mbpChurnGoal, 0);
  assert.equal(q.mbpNetMrrGoal, 2000);
  // totals = added only (no churn subtracted): 4859 + 2000
  assert.equal(q.totalQuota, 6859);
  assert.equal(q.totalNetMrrGoal, 6859);
});

test("hierarchy 'Acquisitions' label is also treated as ACQ", () => {
  const q = rowsToRepQuotas([row("Acq2", "Zillow Pro", 1000, 400, "Acquisitions")])["Acq2"];
  assert.deepEqual(q.productGoals["Zillow Pro"], {
    mrrAddedGoal: 1000,
    churnGoal: 0,
    netGoal: 1000,
  });
});

test("GNR net subtracts churn magnitude when sheet expresses it as negative", () => {
  // added $1k, churn expressed as -$500 → net $500 (subtract the magnitude).
  const q = rowsToRepQuotas([row("Gina", "Showcase", 1000, -500, "G&R")])["Gina"];
  assert.deepEqual(q.productGoals["Showcase"], {
    mrrAddedGoal: 1000,
    churnGoal: 500,
    netGoal: 500,
  });
  assert.equal(q.scChurnGoal, 500);
  assert.equal(q.scNetMrrGoal, 500);
});

test("GNR net subtracts churn magnitude when sheet expresses it as positive", () => {
  const q = rowsToRepQuotas([row("Gabe", "Showcase", 1000, 500, "G&R")])["Gabe"];
  assert.deepEqual(q.productGoals["Showcase"], {
    mrrAddedGoal: 1000,
    churnGoal: 500,
    netGoal: 500,
  });
});

test("missing Showcase/MBP rows leave their scalar fields at zero", () => {
  const q = rowsToRepQuotas([row("Dan", "ZMX", 5000, 500)])["Dan"];
  assert.equal(q.showcaseQuota, 0);
  assert.equal(q.mbpQuota, 0);
  assert.equal(q.totalQuota, 4500);
  assert.equal(q.productGoals["Showcase"], undefined);
});
