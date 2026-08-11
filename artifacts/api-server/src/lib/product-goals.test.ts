import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProductGoals } from "./databricks-quota";

// ---------------------------------------------------------------------------
// Regression tests for the per-product GnR goal map (Task #255).
//
// buildProductGoals is THE single extension point that maps a quota source
// row's scalar goal fields into the canonical per-product goal map consumed by
// the server payload and the frontend aggregation. These tests pin:
//   1. Showcase/MBP parity — the map must mirror the scalar source exactly so
//      there is zero numeric regression for the two products that have data.
//   2. No phantom products — only products with source data appear; nothing
//      like "Unified Opp" is ever introduced.
// ---------------------------------------------------------------------------

const src = {
  scMrrAddedGoal: 12000,
  scChurnGoal: 3000,
  scNetMrrGoal: 9000,
  mbpMrrAddedGoal: 5000,
  mbpChurnGoal: 1500,
  mbpNetMrrGoal: 3500,
};

test("buildProductGoals mirrors Showcase scalar source exactly", () => {
  const pg = buildProductGoals(src);
  assert.deepEqual(pg["Showcase"], {
    mrrAddedGoal: src.scMrrAddedGoal,
    churnGoal: src.scChurnGoal,
    netGoal: src.scNetMrrGoal,
  });
});

test("buildProductGoals mirrors MBP scalar source exactly", () => {
  const pg = buildProductGoals(src);
  assert.deepEqual(pg["MBP"], {
    mrrAddedGoal: src.mbpMrrAddedGoal,
    churnGoal: src.mbpChurnGoal,
    netGoal: src.mbpNetMrrGoal,
  });
});

test("buildProductGoals introduces no phantom products (no Unified Opp)", () => {
  const pg = buildProductGoals(src);
  assert.deepEqual(Object.keys(pg).sort(), ["MBP", "Showcase"]);
  assert.equal(pg["Unified Opp"], undefined);
});
