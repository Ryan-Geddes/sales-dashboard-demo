import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeJoinValue,
  parseGoalNumber,
  buildJoinKey,
  hierarchyFieldValue,
  buildRoleToGroup,
  csvJoinValue,
  csvCellByHeader,
  mapFinanceRowToProducts,
  mapCsvRowsToProducts,
  splitSoftwareTotals,
} from "./goals-resolvers";
import type { GoalCsvRow } from "@workspace/db/schema";
import type {
  FinancePpsOutputMapEntry,
  GoalMetricKey,
  SoftwarePctRules,
} from "./goals-types";

// ---------------------------------------------------------------------------
// Unit tests for the pure resolver transforms (Task #259 T005): join-key
// normalization/building, hierarchy field resolution, finance.pps row mapping,
// Goal CSV summing, and the Software % split. These pin the join + mapping +
// % math without the Databricks / Sheets / DB dependencies.
// ---------------------------------------------------------------------------

// --- normalization --------------------------------------------------------

test("normalizeJoinValue trims, lowercases, and strips leading zeros on ids", () => {
  assert.equal(normalizeJoinValue("  ABC123 "), "abc123");
  assert.equal(normalizeJoinValue("00012345"), "12345");
  assert.equal(normalizeJoinValue("000"), "0"); // keeps at least one digit
  assert.equal(normalizeJoinValue("0"), "0");
  assert.equal(normalizeJoinValue(undefined), "");
  assert.equal(normalizeJoinValue(null), "");
  // non-all-digit values keep their characters (no zero-strip)
  assert.equal(normalizeJoinValue("Region-01"), "region-01");
});

test("parseGoalNumber handles currency, commas, percent, and parens", () => {
  assert.equal(parseGoalNumber("$1,234.50"), 1234.5);
  assert.equal(parseGoalNumber("25%"), 25);
  assert.equal(parseGoalNumber("(500)"), -500);
  assert.equal(parseGoalNumber(""), 0);
  assert.equal(parseGoalNumber("n/a"), 0);
  assert.equal(parseGoalNumber(42), 42);
  assert.equal(parseGoalNumber(null), 0);
});

// --- join keys ------------------------------------------------------------

test("buildJoinKey returns null when any part is empty, else a stable key", () => {
  assert.equal(buildJoinKey(["A", ""]), null);
  assert.equal(buildJoinKey(["A", undefined]), null);
  const k1 = buildJoinKey(["Acquisitions", "00077"]);
  const k2 = buildJoinKey([" acquisitions ", "77"]);
  assert.notEqual(k1, null);
  assert.equal(k1, k2); // normalization makes padded ids match
});

// --- hierarchy field resolution -------------------------------------------

const fakeHierarchy = {
  people: [],
  personToEmployeeId: { "Jane Rep": "0099" },
  repToSalesRole: { "Jane Rep": "ASA" },
  repToRegion: { "Jane Rep": "West" },
  repToSegment: { "Jane Rep": "Enterprise" },
} as unknown as Parameters<typeof hierarchyFieldValue>[1];

test("hierarchyFieldValue resolves each join field, deriving Group via mapping", () => {
  const roleToGroup = buildRoleToGroup([{ salesRole: "ASA", group: "Acquisitions" }]);
  assert.equal(hierarchyFieldValue("Jane Rep", fakeHierarchy, roleToGroup, "Employee Number"), "0099");
  assert.equal(hierarchyFieldValue("Jane Rep", fakeHierarchy, roleToGroup, "Group"), "Acquisitions");
  assert.equal(hierarchyFieldValue("Jane Rep", fakeHierarchy, roleToGroup, "Region"), "West");
  assert.equal(hierarchyFieldValue("Jane Rep", fakeHierarchy, roleToGroup, "Segment"), "Enterprise");
  assert.equal(hierarchyFieldValue("Jane Rep", fakeHierarchy, roleToGroup, "Name"), "Jane Rep");
  // unmapped role => empty group
  assert.equal(hierarchyFieldValue("Jane Rep", fakeHierarchy, new Map(), "Group"), "");
});

// --- finance.pps mapping --------------------------------------------------

test("mapFinanceRowToProducts maps configured columns into (product, metric)", () => {
  const mapping: FinancePpsOutputMapEntry[] = [
    { column: "SC Single Month Goal", metric: "mrrAddedGoal", product: "Showcase" },
    { column: "SC Churn Goal", metric: "mrrChurnGoal", product: "Showcase" },
    { column: "MBP Single Month Goal", metric: "mrrAddedGoal", product: "MBP" },
  ];
  const row = {
    "SC Single Month Goal": "$1,000",
    "SC Churn Goal": "(200)",
    "MBP Single Month Goal": "500",
    "Ignored Column": "999",
  };
  const products = mapFinanceRowToProducts(row, mapping);
  assert.equal(products.Showcase?.mrrAddedGoal, 1000);
  assert.equal(products.Showcase?.mrrChurnGoal, -200);
  assert.equal(products.Showcase?.mrrAddedMinimum, 0); // unmapped metric => 0
  assert.equal(products.MBP?.mrrAddedGoal, 500);
  assert.equal(products["Zillow Pro"], undefined); // unmapped product absent
});

// --- Goal CSV summing -----------------------------------------------------

function csvRow(partial: Partial<GoalCsvRow> & { data?: Record<string, string> }): GoalCsvRow {
  const { data, ...rest } = partial;
  return {
    id: 1,
    month: "2026-06",
    group: "Acquisitions",
    region: "",
    segment: "",
    data: data ?? {},
    uploadedAt: new Date(),
    uploadedByName: null,
    ...rest,
  };
}

const CSV_OUTPUT_MAPPING: FinancePpsOutputMapEntry[] = [
  { column: "Sales SC MRR Added Goal", metric: "mrrAddedGoal", product: "Showcase" },
  { column: "Sales SC MRR Lost Goal", metric: "mrrChurnGoal", product: "Showcase" },
  { column: "Sales MBP MRR Added Goal", metric: "mrrAddedGoal", product: "MBP" },
  { column: "Sales MBP MRR Lost Goal", metric: "mrrChurnGoal", product: "MBP" },
];

// The Goal CSV now uses a single Product column + shared metric columns. Each
// product row maps its metrics to the SAME shared columns; rows are attributed
// to a product by the Product-column value.
const SHARED_OUTPUT_MAPPING: FinancePpsOutputMapEntry[] = [
  { column: "MRR Added Goal", metric: "mrrAddedGoal", product: "Showcase" },
  { column: "MRR Churn Goal", metric: "mrrChurnGoal", product: "Showcase" },
  { column: "MRR Added Goal", metric: "mrrAddedGoal", product: "MBP" },
  { column: "MRR Churn Goal", metric: "mrrChurnGoal", product: "MBP" },
];
const PRODUCT_VALUE_MAPPING = [
  { product: "Showcase" as const, value: "SC" },
  { product: "MBP" as const, value: "MBP" },
];

test("mapCsvRowsToProducts scopes each row to its Product-column value", () => {
  const rows = [
    csvRow({ data: { Product: "SC", "MRR Added Goal": "100", "MRR Churn Goal": "10" } }),
    csvRow({ data: { Product: "SC", "MRR Added Goal": "200", "MRR Churn Goal": "20" } }),
    csvRow({ data: { Product: "MBP", "MRR Added Goal": "40", "MRR Churn Goal": "4" } }),
    csvRow({ data: { Product: "MBP", "MRR Added Goal": "60", "MRR Churn Goal": "6" } }),
  ];
  const products = mapCsvRowsToProducts(rows, SHARED_OUTPUT_MAPPING, "Product", PRODUCT_VALUE_MAPPING);
  // Showcase only gets the SC rows; MBP only gets the MBP rows — not summed
  // into every product.
  assert.equal(products.Showcase?.mrrAddedGoal, 300);
  assert.equal(products.Showcase?.mrrChurnGoal, 30);
  assert.equal(products.MBP?.mrrAddedGoal, 100);
  assert.equal(products.MBP?.mrrChurnGoal, 10);
});

test("mapCsvRowsToProducts ignores rows whose Product value is unmapped", () => {
  const rows = [
    csvRow({ data: { Product: "SC", "MRR Added Goal": "100", "MRR Churn Goal": "10" } }),
    csvRow({ data: { Product: "ZMX", "MRR Added Goal": "999", "MRR Churn Goal": "99" } }),
  ];
  const products = mapCsvRowsToProducts(rows, SHARED_OUTPUT_MAPPING, "Product", PRODUCT_VALUE_MAPPING);
  assert.equal(products.Showcase?.mrrAddedGoal, 100);
  assert.equal(products.ZMX, undefined);
  assert.equal(products.MBP, undefined);
});

test("mapCsvRowsToProducts fails safe (attributes nothing) without a Product column", () => {
  const rows = [
    csvRow({ data: { Product: "SC", "MRR Added Goal": "100", "MRR Churn Goal": "10" } }),
  ];
  const none = mapCsvRowsToProducts(rows, SHARED_OUTPUT_MAPPING, "", PRODUCT_VALUE_MAPPING);
  assert.equal(Object.keys(none).length, 0);
  // Also nothing when no product values are mapped.
  const noMap = mapCsvRowsToProducts(rows, SHARED_OUTPUT_MAPPING, "Product", []);
  assert.equal(Object.keys(noMap).length, 0);
});

// Legacy one-column-per-product layouts (distinct columns per product) still
// resolve when each product row maps to its own column and the Product value
// matches.
test("mapCsvRowsToProducts supports distinct per-product columns", () => {
  const rows = [
    csvRow({
      data: {
        Product: "SC",
        "Sales SC MRR Added Goal": "300",
        "Sales SC MRR Lost Goal": "30",
      },
    }),
    csvRow({
      data: {
        Product: "MBP",
        "Sales MBP MRR Added Goal": "100",
        "Sales MBP MRR Lost Goal": "10",
      },
    }),
  ];
  const products = mapCsvRowsToProducts(rows, CSV_OUTPUT_MAPPING, "Product", PRODUCT_VALUE_MAPPING);
  assert.equal(products.Showcase?.mrrAddedGoal, 300);
  assert.equal(products.Showcase?.mrrChurnGoal, 30);
  assert.equal(products.MBP?.mrrAddedGoal, 100);
  assert.equal(products.MBP?.mrrChurnGoal, 10);
});

test("csvJoinValue / csvCellByHeader read denormalized fields and raw data", () => {
  const r = csvRow({ region: "East", data: { "Software MRR Added Goal": "777" } });
  assert.equal(csvJoinValue(r, "Region"), "East");
  assert.equal(csvJoinValue(r, "month"), "2026-06");
  assert.equal(csvJoinValue(r, "unknown"), "");
  // Generic data columns are read case-insensitively.
  assert.equal(csvJoinValue(r, "software mrr added goal"), "777");
  assert.equal(csvCellByHeader(r, "Software MRR Added Goal"), 777);
  assert.equal(csvCellByHeader(r, "Nonexistent Header"), 0);
});

// --- Software % split -----------------------------------------------------

test("splitSoftwareTotals distributes raw totals across software products by percentage", () => {
  const raw: Record<GoalMetricKey, number> = {
    mrrAddedGoal: 1000,
    mrrChurnGoal: 200,
    mrrAddedMinimum: 0,
    mrrChurnMaximum: 0,
  };
  const rules: SoftwarePctRules = {
    subSource: "financePps",
    columnMapping: {
      financePps: { mrrAddedGoal: "", mrrChurnGoal: "", mrrAddedMinimum: "", mrrChurnMaximum: "" },
      goalCsv: { mrrAddedGoal: "", mrrChurnGoal: "", mrrAddedMinimum: "", mrrChurnMaximum: "" },
    },
    percentages: { Showcase: 25, "Zillow Pro": 25, "Follow Up Boss": 25, ZMX: 25 },
  };
  const products = splitSoftwareTotals(raw, rules);
  // MBP is intentionally NOT a software product
  assert.equal(products.MBP, undefined);
  for (const p of ["Showcase", "Zillow Pro", "Follow Up Boss", "ZMX"] as const) {
    assert.equal(products[p]?.mrrAddedGoal, 250);
    assert.equal(products[p]?.mrrChurnGoal, 50);
  }
  // percentages sum back to the original total
  const total = (["Showcase", "Zillow Pro", "Follow Up Boss", "ZMX"] as const).reduce(
    (s, p) => s + (products[p]?.mrrAddedGoal ?? 0),
    0,
  );
  assert.equal(total, 1000);
});

test("splitSoftwareTotals respects uneven percentages", () => {
  const raw: Record<GoalMetricKey, number> = {
    mrrAddedGoal: 1000,
    mrrChurnGoal: 0,
    mrrAddedMinimum: 0,
    mrrChurnMaximum: 0,
  };
  const rules: SoftwarePctRules = {
    subSource: "financePps",
    columnMapping: {
      financePps: { mrrAddedGoal: "", mrrChurnGoal: "", mrrAddedMinimum: "", mrrChurnMaximum: "" },
      goalCsv: { mrrAddedGoal: "", mrrChurnGoal: "", mrrAddedMinimum: "", mrrChurnMaximum: "" },
    },
    percentages: { Showcase: 50, "Zillow Pro": 30, "Follow Up Boss": 20, ZMX: 0 },
  };
  const products = splitSoftwareTotals(raw, rules);
  assert.equal(products.Showcase?.mrrAddedGoal, 500);
  assert.equal(products["Zillow Pro"]?.mrrAddedGoal, 300);
  assert.equal(products["Follow Up Boss"]?.mrrAddedGoal, 200);
  assert.equal(products.ZMX?.mrrAddedGoal, 0);
});
