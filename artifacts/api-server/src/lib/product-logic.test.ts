import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateProductLogic,
  resolveProduct,
  resolveMrrField,
  resolveStandardizedMrr,
  isTreatedAsClosedWon,
  closedWonProductSet,
  displayFilterName,
  displayAbbreviation,
  oppNameOverrideFor,
  validateProductLogicRules,
  validateRenameMap,
  setActiveProductLogicConfig,
  __resetActiveRulesForTesting,
  DEFAULT_PRODUCT_LOGIC_RULES,
  type ProductLogicMatchRow,
} from "./product-logic";
import type { ProductLogicRule } from "@workspace/db/schema";

// ---------------------------------------------------------------------------
// Parity tests for the Product Logic engine (Task #350).
//
// The default rule set (DEFAULT_PRODUCT_LOGIC_RULES) must reproduce the previous
// hardcoded attribution / MRR-field / Overage closed-won behavior EXACTLY. The
// engine is evaluated against the DEFAULT rules directly (not the in-memory
// active config) so these tests are independent of DB/boot state.
// ---------------------------------------------------------------------------

const RULES = DEFAULT_PRODUCT_LOGIC_RULES;

function row(p: Partial<ProductLogicMatchRow>): ProductLogicMatchRow {
  return p;
}

function product(p: Partial<ProductLogicMatchRow>): string {
  return evaluateProductLogic(row(p), RULES).product;
}

function mrrField(p: Partial<ProductLogicMatchRow>): string {
  return evaluateProductLogic(row(p), RULES).mrrField;
}

// --- Product attribution (replaces attributeProduct) -----------------------

test("Cart type attributes to MBP", () => {
  assert.equal(product({ type: "Cart", rawProduct: "anything" }), "MBP");
});

test("Showcase type attributes to Showcase", () => {
  assert.equal(product({ type: "Showcase" }), "Showcase");
});

test("Showcase Incremental type attributes to Showcase Incremental", () => {
  assert.equal(
    product({ type: "Showcase Incremental" }),
    "Showcase Incremental",
  );
});

test("Showcase Incremental - Re/Max type attributes to its literal product", () => {
  assert.equal(
    product({ type: "Showcase Incremental - Re/Max" }),
    "Showcase Incremental - Re/Max",
  );
});

test("Overage type attributes to Overage", () => {
  assert.equal(product({ type: "Overage" }), "Overage");
});

test("ZMX type attributes to ZMX", () => {
  assert.equal(product({ type: "ZMX" }), "ZMX");
});

test("Unified Opp / Cancel attribute to Product Family", () => {
  assert.equal(
    product({ type: "Unified Opp", productFamily: "Showcase" }),
    "Showcase",
  );
  assert.equal(
    product({ type: "Cancel", productFamily: "MBP" }),
    "MBP",
  );
});

test("Checkout attributes to raw Product", () => {
  assert.equal(
    product({ type: "Checkout", rawProduct: "Some Product" }),
    "Some Product",
  );
});

test("Catch-all attributes to raw Product", () => {
  assert.equal(
    product({ type: "WhateverNewType", rawProduct: "Brand New" }),
    "Brand New",
  );
});

// --- Legacy field-read normalization ---------------------------------------

test("Field-assign normalizes 'Market Based Pricing' to 'MBP'", () => {
  // Old Unified-Opp + PF == "Market Based Pricing" and Checkout + raw ==
  // "Market Based Pricing" both collapsed to MBP.
  assert.equal(
    product({ type: "Unified Opp", productFamily: "Market Based Pricing" }),
    "MBP",
  );
  assert.equal(
    product({ type: "Checkout", rawProduct: "Market Based Pricing" }),
    "MBP",
  );
});

test("Field-assign maps blank to 'No Product Selected'", () => {
  assert.equal(product({ type: "Checkout", rawProduct: "" }), "No Product Selected");
  assert.equal(product({ type: "Checkout" }), "No Product Selected");
  assert.equal(product({ type: "Unified Opp", productFamily: "   " }), "No Product Selected");
});

test("Catch-all with blank raw Product maps to 'No Product Selected'", () => {
  assert.equal(product({ rawProduct: "" }), "No Product Selected");
  assert.equal(product({}), "No Product Selected");
});

// --- MRR field resolution (replaces defaultMrrFieldForType) -----------------

test("Cart / Showcase / Overage MRR field is splitTotalPrice", () => {
  assert.equal(mrrField({ type: "Cart" }), "splitTotalPrice");
  assert.equal(mrrField({ type: "Showcase" }), "splitTotalPrice");
  assert.equal(mrrField({ type: "Showcase Incremental" }), "splitTotalPrice");
  assert.equal(mrrField({ type: "Overage" }), "splitTotalPrice");
  assert.equal(mrrField({ type: "Checkout" }), "splitTotalPrice");
});

test("CPD-sourced types resolve the mrr_added CPD MRR field", () => {
  assert.equal(mrrField({ type: "ZMX" }), "mrr_added");
  assert.equal(mrrField({ type: "Showcase Incremental - Re/Max" }), "mrr_added");
});

test("Unified Opp / Cancel and catch-all MRR field is changeInMrr", () => {
  assert.equal(mrrField({ type: "Unified Opp" }), "changeInMrr");
  assert.equal(mrrField({ type: "Cancel" }), "changeInMrr");
  assert.equal(mrrField({ type: "AnythingElse" }), "changeInMrr");
});

// --- Standardized MRR reads the resolved column -----------------------------

test("Standardized MRR reads splitTotalPrice for Showcase", () => {
  assert.equal(
    resolveStandardizedMrr(
      row({ type: "Showcase", splitTotalPrice: 123, changeInMrr: 999 }),
    ),
    123,
  );
});

test("Standardized MRR reads changeInMrr for Unified Opp", () => {
  assert.equal(
    resolveStandardizedMrr(
      row({ type: "Unified Opp", changeInMrr: 42, splitTotalPrice: 7 }),
    ),
    42,
  );
});

test("Standardized MRR falls back to 0 when the resolved column is absent", () => {
  assert.equal(resolveStandardizedMrr(row({ type: "Showcase" })), 0);
});

test("CPD mrr_added reads the splitTotalPrice basis (parity with legacy)", () => {
  // CPD ingest copies mrr_added into splitTotalPrice, so the default CPD rule
  // resolves the same value it did before source scoping.
  assert.equal(
    resolveStandardizedMrr(row({ type: "ZMX", splitTotalPrice: 250 })),
    250,
  );
});

// --- Overage closed-won set (replaces isOverageRow) ------------------------

test("closedWonProductSet contains only Overage by default", () => {
  const set = closedWonProductSet(RULES);
  assert.deepEqual([...set], ["Overage"]);
});

test("isTreatedAsClosedWon is true for Overage product, false otherwise", () => {
  assert.equal(isTreatedAsClosedWon("Overage", RULES), true);
  assert.equal(isTreatedAsClosedWon("Showcase", RULES), false);
  assert.equal(isTreatedAsClosedWon("", RULES), false);
});

// --- First-match ordering ---------------------------------------------------

test("Rules are first-match: the earliest matching rule wins", () => {
  // A Cart row also has a rawProduct, but the Cart rule (literal MBP) precedes
  // the catch-all (field rawProduct), so MBP wins.
  const m = evaluateProductLogic(
    row({ type: "Cart", rawProduct: "ShouldNotWin" }),
    RULES,
  );
  assert.equal(m.ruleId, "cart");
  assert.equal(m.product, "MBP");
});

test("Catch-all is the terminal rule and is flagged isCatchAll", () => {
  const last = RULES[RULES.length - 1];
  assert.equal(last.isCatchAll, true);
  assert.equal(last.conditions.length, 0);
});

// --- resolveProduct / resolveMrrField wrappers ------------------------------

test("resolveProduct and resolveMrrField match evaluateProductLogic", () => {
  // These wrappers consult the active in-memory config; with the default seed
  // they agree with a direct DEFAULT-rules evaluation.
  const input = row({ type: "Showcase", splitTotalPrice: 5 });
  const m = evaluateProductLogic(input, RULES);
  assert.equal(resolveProduct(input), m.product);
  assert.equal(resolveMrrField(input), m.mrrField);
});

// --- Rename map (display only) ----------------------------------------------

test("Rename map defaults: display helpers fall back to the canonical name", () => {
  assert.equal(displayFilterName("Showcase", []), "Showcase");
  assert.equal(displayAbbreviation("Showcase", []), "Showcase");
  assert.equal(oppNameOverrideFor("Showcase", []), null);
});

test("Rename map overrides filter name / abbreviation / opp name", () => {
  const map = [
    {
      canonical: "MBP",
      filterName: "Market Based Pricing",
      abbreviation: "MBP",
      oppNameOverride: "Cart Sale",
    },
  ];
  assert.equal(displayFilterName("MBP", map), "Market Based Pricing");
  assert.equal(displayAbbreviation("MBP", map), "MBP");
  assert.equal(oppNameOverrideFor("MBP", map), "Cart Sale");
  // Unlisted canonical falls back.
  assert.equal(displayFilterName("Showcase", map), "Showcase");
  assert.equal(oppNameOverrideFor("Showcase", map), null);
});

// --- Validators -------------------------------------------------------------

test("validateProductLogicRules accepts the default rule set", () => {
  const res = validateProductLogicRules(DEFAULT_PRODUCT_LOGIC_RULES);
  assert.equal(res.ok, true);
});

test("validateProductLogicRules rejects a non-array", () => {
  assert.equal(validateProductLogicRules("nope").ok, false);
  assert.equal(validateProductLogicRules(null).ok, false);
});

test("validateProductLogicRules accepts CPD-object mrrFields on a CPD-source rule", () => {
  for (const mrrField of [
    "mrr_added",
    "positive_change_in_mrr",
    "negative_change_in_mrr",
  ]) {
    const res = validateProductLogicRules([
      {
        id: "x",
        label: "X",
        conditions: [{ field: "type", op: "eq", value: "ZMX" }],
        assign: { kind: "literal", product: "ZMX" },
        mrrField,
        treatAsClosedWon: false,
        source: "cpd",
      },
    ]);
    assert.equal(res.ok, true, `mrrField "${mrrField}" should be accepted`);
  }
});

test("validateProductLogicRules rejects a feeder mrrField on a CPD-source rule", () => {
  // Source scoping: a CPD object takes its MRR from the Databricks CPD columns,
  // so a Salesforce feeder column is meaningless for it and must be rejected.
  const res = validateProductLogicRules([
    {
      id: "zmx",
      label: "ZMX",
      conditions: [{ field: "type", op: "eq", value: "ZMX" }],
      assign: { kind: "literal", product: "ZMX" },
      mrrField: "splitTotalPrice",
      treatAsClosedWon: false,
      source: "cpd",
    },
  ]);
  assert.equal(res.ok, false);
});

test("validateProductLogicRules rejects a CPD mrrField on a feeder-source rule", () => {
  const res = validateProductLogicRules([
    {
      id: "sc",
      label: "Showcase",
      conditions: [{ field: "type", op: "eq", value: "Showcase" }],
      assign: { kind: "literal", product: "Showcase" },
      mrrField: "mrr_added",
      treatAsClosedWon: false,
      source: "feeder",
    },
  ]);
  assert.equal(res.ok, false);
});

test("validateRenameMap accepts an empty map and a well-formed entry", () => {
  assert.equal(validateRenameMap([]).ok, true);
  assert.equal(
    validateRenameMap([{ canonical: "Showcase", filterName: "SC" }]).ok,
    true,
  );
});

// --- Active config drives resolution (Task #440) ----------------------------
// The engine's per-request resolution (resolveMrrField / resolveStandardizedMrr
// with no explicit rules arg) reads the in-memory active config via
// getActiveRules(). It must reflect the SAVED config, not the seed default —
// previously a drifted in-memory active config silently kept serving seed rules
// while the admin tab (reading the DB) showed the saved value.

test("engine resolves the SAVED active config's MRR field, not the seed default (Task #440)", () => {
  // Seed default for Showcase Incremental is splitTotalPrice; the saved config
  // maps it to `amount`. The engine (active config) must resolve `amount`.
  const savedRules: ProductLogicRule[] = [
    {
      id: "showcase-incremental",
      label: "Showcase Incremental",
      conditions: [{ field: "type", op: "eq", value: "Showcase Incremental" }],
      assign: { kind: "literal", product: "Showcase Incremental" },
      mrrField: "amount",
      treatAsClosedWon: false,
      source: "feeder",
    },
    {
      id: "catch-all",
      label: "Catch-all",
      conditions: [],
      assign: { kind: "field", field: "rawProduct" },
      mrrField: "changeInMrr",
      treatAsClosedWon: false,
      source: "feeder",
      isCatchAll: true,
    },
  ];
  try {
    // Sanity: the seed default really is splitTotalPrice (drift baseline).
    assert.equal(
      evaluateProductLogic(
        { type: "Showcase Incremental" },
        DEFAULT_PRODUCT_LOGIC_RULES,
      ).mrrField,
      "splitTotalPrice",
    );
    setActiveProductLogicConfig({ rules: savedRules, renameMap: [] });
    // resolveMrrField / resolveStandardizedMrr default to the active config.
    assert.equal(resolveMrrField({ type: "Showcase Incremental" }), "amount");
    assert.equal(
      resolveStandardizedMrr({
        type: "Showcase Incremental",
        amount: 99,
        splitTotalPrice: 150,
      }),
      99,
    );
  } finally {
    __resetActiveRulesForTesting();
  }
});

test("displayed MRR field uses the FULL-row match, not Type alone (Task #440)", () => {
  // A rule that keys on Type AND rawProduct precedes a Type-only rule for the
  // same Type. A full-row input matches the specific rule (amount); a Type-only
  // input misses it and falls through to the broad rule (splitTotalPrice). The
  // drilldown's displayed field is now resolved from the full row, so it agrees
  // with the value standardizeMrr actually read.
  const rules: ProductLogicRule[] = [
    {
      id: "sc-inc-special",
      label: "SC Incremental (special raw product)",
      conditions: [
        { field: "type", op: "eq", value: "Showcase Incremental" },
        { field: "rawProduct", op: "eq", value: "Special" },
      ],
      assign: { kind: "literal", product: "Showcase Incremental" },
      mrrField: "amount",
      treatAsClosedWon: false,
      source: "feeder",
    },
    {
      id: "sc-inc",
      label: "SC Incremental",
      conditions: [{ field: "type", op: "eq", value: "Showcase Incremental" }],
      assign: { kind: "literal", product: "Showcase Incremental" },
      mrrField: "splitTotalPrice",
      treatAsClosedWon: false,
      source: "feeder",
    },
    {
      id: "catch-all",
      label: "Catch-all",
      conditions: [],
      assign: { kind: "field", field: "rawProduct" },
      mrrField: "changeInMrr",
      treatAsClosedWon: false,
      source: "feeder",
      isCatchAll: true,
    },
  ];
  try {
    setActiveProductLogicConfig({ rules, renameMap: [] });
    const fullRow = { type: "Showcase Incremental", rawProduct: "Special" };
    // Type-only resolution would miss the specific rule -> splitTotalPrice.
    assert.equal(resolveMrrField({ type: "Showcase Incremental" }), "splitTotalPrice");
    // Full-row resolution matches the specific rule -> amount, and that is the
    // field standardizeMrr actually read for the value.
    assert.equal(resolveMrrField(fullRow), "amount");
  } finally {
    __resetActiveRulesForTesting();
  }
});
