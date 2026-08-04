import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeProduct, standardizeMrr } from "./sheets-data";

// ---------------------------------------------------------------------------
// Regression tests for "Cancel"-type churn attribution.
//
// "Cancel" is a churn/cancellation opportunity type. These rows always arrive
// with the Product column = "Unified Opp" and the real cancelled product only
// in Product Family. attributeProduct must therefore read Product Family for
// Cancel (and Unified Opp) rows — otherwise the churn is bucketed under the
// literal "Unified Opp", which is NOT one of the products the per-product
// breakdown sums, so the headline Churn total and the breakdown disagree.
//
// The set below mirrors the products the frontend breakdown aggregates over
// (ALL_PRODUCTS + the Showcase parts). Any churn attributed outside this set
// silently leaks out of the breakdown.
// ---------------------------------------------------------------------------

const BREAKDOWN_PRODUCTS = new Set([
  "MBP",
  "Showcase",
  "Showcase Incremental",
  "Showcase Incremental - Re/Max",
  "Overage",
  "Zillow Pro",
  "Follow Up Boss",
  "ZMX",
]);

test("Cancel row is attributed by Product Family, not the Product column", () => {
  // Product column is the useless literal "Unified Opp"; family is the truth.
  assert.equal(attributeProduct({ type: "Cancel", rawProduct: "Unified Opp", productFamily: "Follow Up Boss" }), "Follow Up Boss");
  assert.equal(attributeProduct({ type: "Cancel", rawProduct: "Unified Opp", productFamily: "Zillow Pro" }), "Zillow Pro");
});

test("Cancel row with Market Based Pricing family normalizes to MBP", () => {
  assert.equal(attributeProduct({ type: "Cancel", rawProduct: "Unified Opp", productFamily: "Market Based Pricing" }), "MBP");
});

test("Cancel churn never leaks as the literal 'Unified Opp'", () => {
  // The exact regression: Product='Unified Opp' must not pass through.
  for (const family of BREAKDOWN_PRODUCTS) {
    const attributed = attributeProduct({ type: "Cancel", rawProduct: "Unified Opp", productFamily: family });
    assert.notEqual(attributed, "Unified Opp", `family "${family}" leaked as Unified Opp`);
    assert.ok(
      BREAKDOWN_PRODUCTS.has(attributed),
      `family "${family}" attributed to "${attributed}", outside the breakdown set`,
    );
  }
});

test("Unified Opp type still attributes by family (no regression)", () => {
  assert.equal(attributeProduct({ type: "Unified Opp", rawProduct: "Unified Opp", productFamily: "Follow Up Boss" }), "Follow Up Boss");
  assert.equal(attributeProduct({ type: "Unified Opp", rawProduct: "Unified Opp", productFamily: "Market Based Pricing" }), "MBP");
});

test("standardizeMrr reads Cancel value from Change in MRR (not Split Total Price)", () => {
  const row = { type: "Cancel", changeInMrr: -69, splitTotalPrice: 999 } as Parameters<typeof standardizeMrr>[0];
  assert.equal(standardizeMrr(row), -69);
});
