import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveFunnelStage, effectiveCloseDate, displayCloseDate } from "./sheets-data";

// ---------------------------------------------------------------------------
// Regression tests for the Overage Discovery -> Closed Won reclassification.
//
// Overage opportunities are created at the start of each month in the Discovery
// stage and only flipped to Closed Won on the last day of the month, even
// though their MRR accrues all month as credits are purchased. effectiveFunnelStage
// upgrades a Discovery-stage Overage opp to "Closed Won" so its accrued MRR is
// counted throughout the month (headline Added/Churn, funnel, breakdowns,
// weighting, drilldowns) instead of appearing all at once at month end.
//
// Scope guardrails asserted here:
//   - ONLY Overage opps whose stage maps to Discovery are reclassified.
//   - Closed Lost Overage is left untouched (stays out of Closed Won).
//   - Non-Overage Discovery opps are unchanged.
// ---------------------------------------------------------------------------

type Row = Parameters<typeof effectiveFunnelStage>[0];

function row(partial: Partial<Row>): Row {
  return partial as Row;
}

test("Discovery-stage Overage opp is reclassified as Closed Won", () => {
  assert.equal(
    effectiveFunnelStage(row({ type: "Overage", product: "Overage", stage: "Discovery" })),
    "Closed Won",
  );
});

test("Overage on raw stages that collapse to Discovery is also reclassified", () => {
  // mapStageToFunnel folds these raw stages (and any unmapped stage) into
  // "Discovery", so the reclassification keys off the funnel stage, not the
  // literal raw "Discovery" string.
  for (const stage of ["New", "Discover", "Engage", "Influence", "Zips Added"]) {
    assert.equal(
      effectiveFunnelStage(row({ type: "Overage", product: "Overage", stage })),
      "Closed Won",
      `raw stage "${stage}" should reclassify to Closed Won`,
    );
  }
});

test("Overage identified by attributed Product alone (no type) still reclassifies", () => {
  assert.equal(
    effectiveFunnelStage(row({ type: "", product: "Overage", stage: "Discovery" })),
    "Closed Won",
  );
});

test("Closed Lost Overage is left untouched", () => {
  assert.equal(
    effectiveFunnelStage(row({ type: "Overage", product: "Overage", stage: "Closed Lost" })),
    "Closed Lost",
  );
});

test("Already-Closed-Won Overage is unchanged", () => {
  assert.equal(
    effectiveFunnelStage(row({ type: "Overage", product: "Overage", stage: "Closed: Won" })),
    "Closed Won",
  );
});

test("Overage in a mid-funnel stage is not reclassified", () => {
  // Only the Discovery bucket is in scope; a Demo-stage Overage stays put.
  assert.equal(
    effectiveFunnelStage(row({ type: "Overage", product: "Overage", stage: "Demo Performed" })),
    "Demo Scheduled",
  );
});

test("Non-Overage Discovery opp is unchanged", () => {
  assert.equal(
    effectiveFunnelStage(row({ type: "Checkout", product: "Showcase", stage: "Discovery" })),
    "Discovery",
  );
  assert.equal(
    effectiveFunnelStage(row({ type: "Cart", product: "MBP", stage: "New" })),
    "Discovery",
  );
});

test("Non-Overage closed opps are unchanged", () => {
  assert.equal(
    effectiveFunnelStage(row({ type: "Showcase", product: "Showcase", stage: "Closed: Won" })),
    "Closed Won",
  );
  assert.equal(
    effectiveFunnelStage(row({ type: "Checkout", product: "Zillow Pro", stage: "Closed Lost" })),
    "Closed Lost",
  );
});

// ---------------------------------------------------------------------------
// effectiveCloseDate: reclassified Overage opps carry an end-of-month close
// date, but their MRR accrues from the very first of the month. The effective
// close date is pinned to the first day of that same month so any
// month-to-date window includes them immediately instead of only on day 31.
// ---------------------------------------------------------------------------

test("Reclassified Overage close date is pinned to the first of its month", () => {
  const cd = effectiveCloseDate(
    row({ type: "Overage", product: "Overage", stage: "Discovery", closeDate: "6/30/2026" }),
  );
  assert.ok(cd, "expected a date");
  assert.equal(cd!.getFullYear(), 2026);
  assert.equal(cd!.getMonth(), 5); // June (0-indexed)
  assert.equal(cd!.getDate(), 1);
});

test("Reclassified Overage stays in the same month bucket after pinning", () => {
  const cd = effectiveCloseDate(
    row({ type: "", product: "Overage", stage: "New", closeDate: "12/31/2026" }),
  )!;
  assert.equal(cd.getFullYear(), 2026);
  assert.equal(cd.getMonth(), 11); // December
  assert.equal(cd.getDate(), 1);
});

test("Non-reclassified Overage (Closed Won) keeps its real close date", () => {
  const cd = effectiveCloseDate(
    row({ type: "Overage", product: "Overage", stage: "Closed: Won", closeDate: "6/30/2026" }),
  )!;
  assert.equal(cd.getMonth(), 5);
  assert.equal(cd.getDate(), 30);
});

test("Non-Overage opp keeps its real close date", () => {
  const cd = effectiveCloseDate(
    row({ type: "Checkout", product: "Showcase", stage: "Discovery", closeDate: "6/30/2026" }),
  )!;
  assert.equal(cd.getMonth(), 5);
  assert.equal(cd.getDate(), 30);
});

test("Missing or invalid close date yields null", () => {
  assert.equal(
    effectiveCloseDate(row({ type: "Overage", product: "Overage", stage: "Discovery" })),
    null,
  );
  assert.equal(
    effectiveCloseDate(
      row({ type: "Overage", product: "Overage", stage: "Discovery", closeDate: "not-a-date" }),
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// displayCloseDate: the close date shown in opportunity drilldowns. A
// reclassified Overage opp displays the 1st-of-month effective close date so
// the shown value (and the sort / min-max / export that read it) matches how
// the opp is bucketed. Everything else shows its raw Salesforce close date.
// ---------------------------------------------------------------------------

test("Reclassified Overage displays the 1st of its month", () => {
  assert.equal(
    displayCloseDate(
      row({ type: "Overage", product: "Overage", stage: "Discovery", closeDate: "6/30/2026" }),
    ),
    "6/1/2026",
  );
});

test("Reclassified Overage display stays in the same month", () => {
  assert.equal(
    displayCloseDate(
      row({ type: "", product: "Overage", stage: "New", closeDate: "12/31/2026" }),
    ),
    "12/1/2026",
  );
});

test("Non-reclassified Overage (Closed Won) displays its raw close date", () => {
  assert.equal(
    displayCloseDate(
      row({ type: "Overage", product: "Overage", stage: "Closed: Won", closeDate: "6/30/2026" }),
    ),
    "6/30/2026",
  );
});

test("Non-Overage opp displays its raw close date", () => {
  assert.equal(
    displayCloseDate(
      row({ type: "Checkout", product: "Showcase", stage: "Discovery", closeDate: "6/30/2026" }),
    ),
    "6/30/2026",
  );
});

test("Reclassified Overage with missing close date falls back to raw (empty)", () => {
  assert.equal(
    displayCloseDate(row({ type: "Overage", product: "Overage", stage: "Discovery" })),
    undefined,
  );
});
