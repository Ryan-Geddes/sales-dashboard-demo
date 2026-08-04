import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCompensation,
  evaluatePairedOppRules,
  validatePairedOppRules,
  normalizeComparativeSidedFactorOp,
  validateMultiplierRules,
  filterConfigForMode,
  diagnoseMultiplierRule,
  diagnosePairedRuleForOpp,
  diagnosePairedRuleForOpps,
  REFERENCE_PAIRED_OPP_RULES,
  REFERENCE_MULTIPLIER_RULES,
  DEFAULT_FLEX_FLIP_STATUSES,
  type CompRowInput,
  type CompensationConfig,
  type CompMultiplierRule,
  type PairedOppRule,
  type CompNamedOpp,
  type CompPairedCondition,
} from "./compensation";
import {
  ruleAffectmentForDrilldown,
  ruleAffectmentForExport,
} from "./sheets-data";

// ---------------------------------------------------------------------------
// Generic paired-opp rule engine (clean rebuild).
//
// A rule's opps are tied together by per-opp identity comparative conditions:
// the first opp is the ANCHOR and every other opp carries ≥1 identity `=` link
// (e.g. "this opp's Account ID = anchor's Account ID") to an earlier opp, which
// joins them into the same deal. Each named opp (mode "match" / "exclude") is
// built from field conditions, identity links, and numeric comparative gates.
// When every Match opp has ≥1 row, every Exclude opp has none, and all numeric
// comparatives pass, the rule fires and applies name-referenced adjustments
// (waive / keep / fixedCredit / capAt / incremental /
// greaterOfFloorOrIncremental / multiplyByFactor / reassignMrrField) to its
// target opps, with an optional gated owner reassignment.
//
// These tests cover matching, exclusion, identity joins, comparative gates,
// every adjustment op, the gated owner reassignment, the FUB↔Zpro reference
// rules, and the before/after-comp reversibility.
// ---------------------------------------------------------------------------

function row(overrides: Partial<CompRowInput>): CompRowInput {
  return {
    oppId: "opp-default",
    accountId: "acct-1",
    product: "",
    rawProduct: "",
    productFamily: "",
    type: "",
    closeDate: "2026-06-15",
    funnelStage: "Closed Won",
    standardizedMrr: 0,
    ...overrides,
  };
}

function configWith(pairedOppRules: PairedOppRule[]): CompensationConfig {
  return {
    monthYyyymm: "2026-06",
    multiplierRules: [],
    pairedOppRules,
    isDefault: true,
  };
}

// Identity `=` link helper: "this opp's <field> = <toOpp>'s <field>", the join
// that ties a non-anchor opp to an earlier opp / the anchor.
function sameAs(
  field: "accountId" | "closeDate",
  toOpp: string,
  dateGranularity?: "month" | "exact",
): CompPairedCondition {
  return {
    kind: "comparative",
    field,
    op: "eq",
    compareToOpp: toOpp,
    compareToField: field,
    ...(dateGranularity ? { dateGranularity } : {}),
  };
}

// A V3 cancellation ↔ V4 win churn-rebook rule, expressed with named opps and a
// per-branch comparative gate. The thresholds are rule-configurable, not
// hardcoded in the engine. Each branch (downsell / flat / upsell) is its own
// rule, gated by a numeric comparative on the V4 opp, which is joined to the V3
// anchor by Account ID.
const v3Match: CompNamedOpp = {
  name: "v3",
  mode: "match",
  conditions: [
    { kind: "field", field: "product", op: "eq", value: "V3" },
    { kind: "field", field: "type", op: "eq", value: "Cancel" },
  ],
};

const downsellRule: PairedOppRule = {
  id: "v3-v4-downsell",
  label: "V3→V4 downsell (cap 275)",
  enabled: true,
  opps: [
    v3Match,
    {
      name: "v4",
      mode: "match",
      conditions: [
        { kind: "field", field: "product", op: "eq", value: "V4" },
        { kind: "field", field: "type", op: "eq", value: "New" },
        sameAs("accountId", "v3"),
        // downsell: |Σ V4 changeInMrr| < |Σ V3 changeInMrr|
        {
          kind: "comparative",
          field: "changeInMrr",
          op: "lt",
          compareToOpp: "v3",
          compareToField: "changeInMrr",
        },
      ],
    },
  ],
  adjustments: [
    { targetOpp: "v3", op: "waive" },
    { targetOpp: "v4", op: "capAt", amount: 275 },
  ],
};

const flatRule: PairedOppRule = {
  id: "v3-v4-flat",
  label: "V3→V4 flat (fixed 300)",
  enabled: true,
  opps: [
    v3Match,
    {
      name: "v4",
      mode: "match",
      conditions: [
        { kind: "field", field: "product", op: "eq", value: "V4" },
        { kind: "field", field: "type", op: "eq", value: "New" },
        sameAs("accountId", "v3"),
        {
          kind: "comparative",
          field: "changeInMrr",
          op: "eq",
          compareToOpp: "v3",
          compareToField: "changeInMrr",
        },
      ],
    },
  ],
  adjustments: [
    { targetOpp: "v3", op: "waive" },
    { targetOpp: "v4", op: "fixedCredit", amount: 300 },
  ],
};

const upsellRule: PairedOppRule = {
  id: "v3-v4-upsell",
  label: "V3→V4 upsell (greater of 425 / incremental)",
  enabled: true,
  opps: [
    v3Match,
    {
      name: "v4",
      mode: "match",
      conditions: [
        { kind: "field", field: "product", op: "eq", value: "V4" },
        { kind: "field", field: "type", op: "eq", value: "New" },
        sameAs("accountId", "v3"),
        {
          kind: "comparative",
          field: "changeInMrr",
          op: "gt",
          compareToOpp: "v3",
          compareToField: "changeInMrr",
        },
      ],
    },
  ],
  adjustments: [
    { targetOpp: "v3", op: "waive" },
    { targetOpp: "v4", op: "greaterOfFloorOrIncremental", amount: 425, comparisonOpp: "v3" },
  ],
};

const v3Cancel = (o: Partial<CompRowInput> = {}) =>
  row({ oppId: "v3-cancel", product: "V3", type: "Cancel", standardizedMrr: -500, ...o });
const v4Win = (o: Partial<CompRowInput> = {}) =>
  row({ oppId: "v4-win", product: "V4", type: "New", standardizedMrr: 300, ...o });

// --- Detection-only rule: keep both sides untouched -------------------------

test("Detect-only: a keep/keep rule flags the group but changes no values", () => {
  const rule: PairedOppRule = {
    id: "v3-v3",
    label: "V3>V3 double subscription (detect only)",
    enabled: true,
    opps: [
      v3Match,
      {
        name: "v3new",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "V3" },
          { kind: "field", field: "type", op: "eq", value: "New" },
          sameAs("accountId", "v3"),
        ],
      },
    ],
    adjustments: [
      { targetOpp: "v3", op: "keep" },
      { targetOpp: "v3new", op: "keep" },
    ],
  };
  const rows = [
    v3Cancel({ standardizedMrr: -400 }),
    row({ oppId: "v3-new", product: "V3", type: "New", standardizedMrr: 400 }),
  ];
  const res = computeCompensation(rows, configWith([rule]));

  // Group is detected on both rows…
  assert.equal(res.pairSummaries.length, 1);
  assert.equal(res.pairOppName[0], "v3");
  assert.equal(res.pairOppName[1], "v3new");
  assert.equal(res.pairRuleLabel[0], "V3>V3 double subscription (detect only)");
  // …but no value changes (full churn + full credit), no churn suppression.
  assert.equal(res.compensable[0], -400);
  assert.equal(res.compensable[1], 400);
  assert.equal(res.churnSuppressed[0], false);
  assert.equal(res.totalCompensable, 0);
});

// --- Reference FUB↔Zpro rules ------------------------------------------------

test("Reference: FUB Cancel nets against a Zpro win (net branch, not in flex list)", () => {
  const rows = [
    row({ oppId: "fub", product: "Follow Up Boss", type: "Cancel", standardizedMrr: -200, flexFlipAgentStatus: "Churned" }),
    row({ oppId: "zpro", product: "Zillow Pro", type: "New", standardizedMrr: 500, changeInMrr: 500, flexFlipAgentStatus: "Churned" }),
  ];
  const res = computeCompensation(rows, configWith(REFERENCE_PAIRED_OPP_RULES));

  assert.equal(res.pairSummaries.length, 1);
  // Net branch: |zpro| − |fub| = 500 − 200 = 300 on the Zpro row; FUB churn waived.
  assert.equal(res.compensable[1], 300);
  assert.equal(res.compensable[0], 0);
  assert.equal(res.churnSuppressed[0], true);
  assert.equal(res.pairOppName[0], "fub");
  assert.equal(res.pairOppName[1], "zpro");
});

test("Reference: FUB Cancel in the flex list pairs on the flex branch (× factor)", () => {
  const flexStatus = DEFAULT_FLEX_FLIP_STATUSES[0];
  const rows = [
    row({ oppId: "fub", product: "Follow Up Boss", type: "Cancel", standardizedMrr: -200, flexFlipAgentStatus: flexStatus }),
    row({ oppId: "zpro", product: "Zillow Pro", type: "New", standardizedMrr: 500, changeInMrr: 500, flexFlipAgentStatus: flexStatus }),
  ];
  const res = computeCompensation(rows, configWith(REFERENCE_PAIRED_OPP_RULES));

  assert.equal(res.pairSummaries.length, 1);
  // Flex branch: Zpro MRR × 0.1 = 50; FUB churn waived.
  assert.equal(res.compensable[1], 50);
  assert.equal(res.compensable[0], 0);
});

test("Reference: a FUB amend-churn opp (Type != Cancel) must NOT pair", () => {
  // Only a Type === "Cancel" FUB opp may trigger the pairing. An amend opp that
  // nets negative MRR must never be pulled into the link.
  const rows = [
    row({ oppId: "fub-amend", product: "Follow Up Boss", type: "Unified Opp", standardizedMrr: -200, flexFlipAgentStatus: "Churned" }),
    row({ oppId: "zpro", product: "Zillow Pro", type: "New", standardizedMrr: 500, changeInMrr: 500, flexFlipAgentStatus: "Churned" }),
  ];
  const res = computeCompensation(rows, configWith(REFERENCE_PAIRED_OPP_RULES));

  assert.equal(res.pairSummaries.length, 0);
  assert.equal(res.compensable[1], 500); // Zpro keeps full MRR (no netting)
  assert.equal(res.pairOppName[0], null);
});

test("Reference: a FUB Cancel on a DIFFERENT account does not pair (account join)", () => {
  // The Zpro win's identity link requires the same Account ID as the FUB anchor.
  const rows = [
    row({ oppId: "fub", accountId: "acct-A", product: "Follow Up Boss", type: "Cancel", standardizedMrr: -200, flexFlipAgentStatus: "Churned" }),
    row({ oppId: "zpro", accountId: "acct-B", product: "Zillow Pro", type: "New", standardizedMrr: 500, changeInMrr: 500, flexFlipAgentStatus: "Churned" }),
  ];
  const res = computeCompensation(rows, configWith(REFERENCE_PAIRED_OPP_RULES));

  assert.equal(res.pairSummaries.length, 0);
  assert.equal(res.compensable[1], 500);
});

// --- Exclude opp blocks the pairing -----------------------------------------

test("Exclude opp: presence of a blocking opp suppresses the pairing entirely", () => {
  // A downsell rule that only fires when NO blocking opp (here a V5) exists on
  // the same account — the generalized "no matching X exists" guard via an
  // Exclude named opp, scoped to the deal by an Account ID identity link.
  const guarded: PairedOppRule = {
    ...downsellRule,
    id: "v3-v4-guarded",
    opps: [
      ...downsellRule.opps,
      {
        name: "blocker",
        mode: "exclude",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "V5" },
          sameAs("accountId", "v3"),
        ],
      },
    ],
  };
  const base = [v3Cancel({ standardizedMrr: -500 }), v4Win({ standardizedMrr: 300 })];

  // No blocker → pairs normally (downsell cap at 275).
  const ok = computeCompensation(base, configWith([guarded]));
  assert.equal(ok.pairSummaries.length, 1);
  assert.equal(ok.compensable[1], 275);

  // Blocker present → exclude opp suppresses the pairing entirely.
  const blocked = computeCompensation(
    [...base, row({ oppId: "v5", product: "V5", type: "New", standardizedMrr: 100 })],
    configWith([guarded]),
  );
  assert.equal(blocked.pairSummaries.length, 0);
  assert.equal(blocked.compensable[0], -500); // V3 churn untouched
  assert.equal(blocked.compensable[1], 300); // V4 keeps full credit
});

test("Exclude opp on a different account does NOT block (identity-scoped)", () => {
  const guarded: PairedOppRule = {
    ...downsellRule,
    id: "v3-v4-guarded-scoped",
    opps: [
      ...downsellRule.opps,
      {
        name: "blocker",
        mode: "exclude",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "V5" },
          sameAs("accountId", "v3"),
        ],
      },
    ],
  };
  // A V5 on a DIFFERENT account must not suppress this deal's pairing.
  const rows = [
    v3Cancel({ standardizedMrr: -500 }),
    v4Win({ standardizedMrr: 300 }),
    row({ oppId: "v5-other", accountId: "acct-other", product: "V5", type: "New", standardizedMrr: 100 }),
  ];
  const res = computeCompensation(rows, configWith([guarded]));
  assert.equal(res.pairSummaries.length, 1);
  assert.equal(res.compensable[1], 275);
});

// --- Comparative gate: downsell (cap at 275) --------------------------------

test("Downsell: comparative gate fires and caps the V4 credit at 275", () => {
  const rows = [v3Cancel({ standardizedMrr: -500 }), v4Win({ standardizedMrr: 300 })];
  const res = computeCompensation(rows, configWith([downsellRule]));

  assert.equal(res.pairSummaries.length, 1);
  assert.equal(res.compensable[0], 0); // V3 churn waived
  assert.equal(res.compensable[1], 275); // capped at 275
  assert.equal(res.churnSuppressed[0], true);
});

test("Downsell: V4 below the cap keeps the full V4 credit", () => {
  const rows = [v3Cancel({ standardizedMrr: -500 }), v4Win({ standardizedMrr: 200 })];
  const res = computeCompensation(rows, configWith([downsellRule]));

  assert.equal(res.pairSummaries.length, 1);
  assert.equal(res.compensable[0], 0);
  assert.equal(res.compensable[1], 200); // min(200, 275) = 200
});

test("Downsell gate does not fire when |V4| ≥ |V3|", () => {
  // |V4|=600 > |V3|=500 → the `lt` comparative fails, rule does not fire.
  const rows = [v3Cancel({ standardizedMrr: -500 }), v4Win({ standardizedMrr: 600 })];
  const res = computeCompensation(rows, configWith([downsellRule]));
  assert.equal(res.pairSummaries.length, 0);
  assert.equal(res.compensable[1], 600);
});

// --- Comparative gate: flat (fixed 300) -------------------------------------

test("Flat: equal magnitudes credit the configured fixed amount (300)", () => {
  const rows = [v3Cancel({ standardizedMrr: -300 }), v4Win({ standardizedMrr: 300 })];
  const res = computeCompensation(rows, configWith([flatRule]));

  assert.equal(res.pairSummaries.length, 1);
  assert.equal(res.compensable[0], 0);
  assert.equal(res.compensable[1], 300);
});

// --- Comparative gate: upsell (greater of 425 floor or incremental) ---------

test("Upsell: credits the 425 floor when it beats the increment", () => {
  const rows = [v3Cancel({ standardizedMrr: -300 }), v4Win({ standardizedMrr: 500 })];
  const res = computeCompensation(rows, configWith([upsellRule]));

  assert.equal(res.pairSummaries.length, 1);
  assert.equal(res.compensable[0], 0);
  // max(425, 500 − 300 = 200) = 425
  assert.equal(res.compensable[1], 425);
});

test("Upsell: credits the incremental increase when it beats the floor", () => {
  const rows = [v3Cancel({ standardizedMrr: -300 }), v4Win({ standardizedMrr: 900 })];
  const res = computeCompensation(rows, configWith([upsellRule]));

  assert.equal(res.pairSummaries.length, 1);
  // max(425, 900 − 300 = 600) = 600
  assert.equal(res.compensable[1], 600);
});

// --- reassignMrrField adjustment --------------------------------------------

test("reassignMrrField: target opp comp is set per-row from the chosen feeder column", () => {
  const rule: PairedOppRule = {
    id: "reassign-field",
    label: "reassign MRR field",
    enabled: true,
    opps: [
      {
        name: "cancel",
        mode: "match",
        conditions: [{ kind: "field", field: "type", op: "eq", value: "Cancel" }],
      },
      {
        name: "win",
        mode: "match",
        conditions: [
          { kind: "field", field: "type", op: "eq", value: "New" },
          sameAs("accountId", "cancel"),
        ],
      },
    ],
    adjustments: [
      { targetOpp: "cancel", op: "waive" },
      // Use each win row's own `amount` column as its compensable MRR — no
      // cross-row distribution.
      { targetOpp: "win", op: "reassignMrrField", mrrField: "amount" },
    ],
  };
  const rows = [
    row({ oppId: "cancel", type: "Cancel", standardizedMrr: -100 }),
    row({ oppId: "winA", type: "New", standardizedMrr: 50, amount: 200 }),
    row({ oppId: "winB", type: "New", standardizedMrr: 80, amount: 70 }),
  ];
  const res = computeCompensation(rows, configWith([rule]));

  assert.equal(res.compensable[0], 0); // cancel waived
  assert.equal(res.compensable[1], 200); // winA → its own amount
  assert.equal(res.compensable[2], 70); // winB → its own amount (no distribution)
});

// --- ignoreAcqChurn adjustment ----------------------------------------------

test("ignoreAcqChurn: flags target rows without changing their compensable MRR", () => {
  const rule: PairedOppRule = {
    id: "ignore-acq",
    label: "ignore acq churn",
    enabled: true,
    opps: [
      {
        name: "cancel",
        mode: "match",
        conditions: [{ kind: "field", field: "type", op: "eq", value: "Cancel" }],
      },
      {
        name: "win",
        mode: "match",
        conditions: [
          { kind: "field", field: "type", op: "eq", value: "New" },
          sameAs("accountId", "cancel"),
        ],
      },
    ],
    adjustments: [{ targetOpp: "cancel", op: "ignoreAcqChurn" }],
  };
  const rows = [
    row({ oppId: "cancel", type: "Cancel", standardizedMrr: -100 }),
    row({ oppId: "winA", type: "New", standardizedMrr: 50 }),
  ];
  const res = computeCompensation(rows, configWith([rule]));

  assert.equal(res.pairSummaries.length, 1);
  // MRR untouched — the op is a pure flag.
  assert.equal(res.compensable[0], -100);
  assert.equal(res.compensable[1], 50);
  assert.equal(res.acqChurnIgnored[0], true);
  assert.equal(res.acqChurnIgnored[1], false);
  assert.equal(res.pairAdjustmentLabel[0], "cancel: ignore ACQ churn logic");
});

test("ignoreAcqChurn composes with other adjustments on the same target", () => {
  const rule: PairedOppRule = {
    id: "ignore-acq-compose",
    label: "ignore acq churn + cap",
    enabled: true,
    opps: [
      {
        name: "cancel",
        mode: "match",
        conditions: [{ kind: "field", field: "type", op: "eq", value: "Cancel" }],
      },
      {
        name: "win",
        mode: "match",
        conditions: [
          { kind: "field", field: "type", op: "eq", value: "New" },
          sameAs("accountId", "cancel"),
        ],
      },
    ],
    adjustments: [
      { targetOpp: "cancel", op: "multiplyByFactor", amount: 0.5 },
      { targetOpp: "cancel", op: "ignoreAcqChurn" },
    ],
  };
  const rows = [
    row({ oppId: "cancel", type: "Cancel", standardizedMrr: -100 }),
    row({ oppId: "winA", type: "New", standardizedMrr: 50 }),
  ];
  const res = computeCompensation(rows, configWith([rule]));

  // multiplyByFactor still applies; the flag rides along.
  assert.equal(res.compensable[0], -50);
  assert.equal(res.acqChurnIgnored[0], true);
});

test("acqChurnIgnored is all-false when no rule uses ignoreAcqChurn", () => {
  const rows = [row({ oppId: "a", type: "New", standardizedMrr: 10 })];
  const res = computeCompensation(rows, configWith([]));
  assert.deepEqual(res.acqChurnIgnored, [false]);
});

// --- incremental with a comparison-field selector ---------------------------

const incrFieldRule = (comparisonField?: "amount"): PairedOppRule => ({
  id: "v3-v4-incr-field",
  label: "V3→V4 incremental, comparison measured by a chosen field",
  enabled: true,
  opps: upsellRule.opps,
  adjustments: [
    { targetOpp: "v3", op: "waive" },
    { targetOpp: "v4", op: "incremental", comparisonOpp: "v3", comparisonField },
  ],
});

test("incremental: comparisonField measures the comparison opp by that feeder column", () => {
  // Target v4 always uses |standardized| (900). Comparison v3 is measured by
  // its `amount` column (700), not its standardized MRR (-300).
  const rows = [
    v3Cancel({ standardizedMrr: -300, amount: -700 }),
    v4Win({ standardizedMrr: 900, amount: 123 }),
  ];
  const res = computeCompensation(rows, configWith([incrFieldRule("amount")]));

  assert.equal(res.compensable[0], 0); // v3 waived
  // |900| − |amount of v3 = -700| = 900 − 700 = 200
  assert.equal(res.compensable[1], 200);
});

test("incremental: omitting comparisonField preserves standardized-MRR behavior", () => {
  const rows = [
    v3Cancel({ standardizedMrr: -300, amount: -700 }),
    v4Win({ standardizedMrr: 900, amount: 123 }),
  ];
  const res = computeCompensation(rows, configWith([incrFieldRule()]));

  assert.equal(res.compensable[0], 0);
  // |900| − |standardized of v3 = -300| = 900 − 300 = 600
  assert.equal(res.compensable[1], 600);
});

test("greaterOfFloorOrIncremental: comparisonField measures the comparison opp by that feeder column", () => {
  const rule: PairedOppRule = {
    id: "v3-v4-floor-field",
    label: "V3→V4 floor/incremental, comparison measured by amount",
    enabled: true,
    opps: upsellRule.opps,
    adjustments: [
      { targetOpp: "v3", op: "waive" },
      {
        targetOpp: "v4",
        op: "greaterOfFloorOrIncremental",
        amount: 425,
        comparisonOpp: "v3",
        comparisonField: "amount",
      },
    ],
  };
  const rows = [
    v3Cancel({ standardizedMrr: -300, amount: -700 }),
    v4Win({ standardizedMrr: 900, amount: 123 }),
  ];
  const res = computeCompensation(rows, configWith([rule]));

  assert.equal(res.compensable[0], 0);
  // max(425, |900| − |amount of v3 = -700| = 200) = 425
  assert.equal(res.compensable[1], 425);
});

// --- Gated owner reassignment (reassignOwnerToOpp) --------------------------

const reassignRule: PairedOppRule = {
  id: "v3-v4-reassign",
  label: "V3→V4 with owner reassignment",
  enabled: true,
  opps: downsellRule.opps,
  adjustments: [
    { targetOpp: "v3", op: "waive", reassignOwnerToOpp: "v4" },
    { targetOpp: "v4", op: "capAt", amount: 275 },
  ],
};

test("Gated reassignment: a Compliance Sales owner is reassigned to the named opp's owner", () => {
  const rows = [
    v3Cancel({ standardizedMrr: -500, rep: "rep-A", salesRole: "Compliance Sales" }),
    v4Win({ standardizedMrr: 300, rep: "rep-B", salesRole: "New Business" }),
  ];
  const res = computeCompensation(rows, configWith([reassignRule]));
  assert.equal(res.ownerReassignedTo[0], "rep-B"); // reassigned to v4's owner
});

test("Gated reassignment: an ineligible owner role is NOT reassigned", () => {
  const rows = [
    v3Cancel({ standardizedMrr: -500, rep: "rep-A", salesRole: "Account Executive" }),
    v4Win({ standardizedMrr: 300, rep: "rep-B", salesRole: "New Business" }),
  ];
  const res = computeCompensation(rows, configWith([reassignRule]));
  assert.equal(res.ownerReassignedTo[0], null); // role not in the gate → no reassignment
});

test("Gated reassignment honors a custom reassignableOwnerRoles set", () => {
  const rule: PairedOppRule = {
    ...reassignRule,
    id: "v3-v4-reassign-custom",
    reassignableOwnerRoles: ["Account Executive"],
  };
  const rows = [
    v3Cancel({ standardizedMrr: -500, rep: "rep-A", salesRole: "Account Executive" }),
    v4Win({ standardizedMrr: 300, rep: "rep-B" }),
  ];
  const res = computeCompensation(rows, configWith([rule]));
  assert.equal(res.ownerReassignedTo[0], "rep-B");
});

// --- Opportunity Name matching (contains / notContains, comma lists) ---------
// Task #410: the engine reads the opportunity name off the row (fieldValue ->
// row.oppName) and `contains` / `notContains` accept a comma-separated list.
// These rules gate the V4 win on its Opportunity Name; the rule only pairs (and
// caps at 275) when the name condition passes.

const nameGatedRule = (nameCond: CompPairedCondition): PairedOppRule => ({
  ...downsellRule,
  id: "v3-v4-name-gated",
  opps: [
    v3Match,
    {
      name: "v4",
      mode: "match",
      conditions: [
        { kind: "field", field: "product", op: "eq", value: "V4" },
        { kind: "field", field: "type", op: "eq", value: "New" },
        sameAs("accountId", "v3"),
        nameCond,
      ],
    },
  ],
});

test("Opp Name notContains: a name containing the term blocks the pairing", () => {
  const rule = nameGatedRule({
    kind: "field",
    field: "oppName",
    op: "notContains",
    value: "V4",
  });
  // V4 win whose name contains "V4" → notContains fails → no pairing.
  const rows = [
    v3Cancel({ standardizedMrr: -500 }),
    v4Win({ standardizedMrr: 300, oppName: "Acme Renewal V4" }),
  ];
  const res = computeCompensation(rows, configWith([rule]));
  assert.equal(res.pairSummaries.length, 0);
  assert.equal(res.compensable[1], 300); // full credit, rule did not fire
});

test("Opp Name notContains: a name without the term allows the pairing (case-insensitive)", () => {
  const rule = nameGatedRule({
    kind: "field",
    field: "oppName",
    op: "notContains",
    value: "V4",
  });
  const rows = [
    v3Cancel({ standardizedMrr: -500 }),
    v4Win({ standardizedMrr: 300, oppName: "Acme Renewal v3 Upgrade" }),
  ];
  const res = computeCompensation(rows, configWith([rule]));
  assert.equal(res.pairSummaries.length, 1);
  assert.equal(res.compensable[1], 275); // capped → rule fired
});

test("Opp Name contains: matches against the real name (case-insensitive)", () => {
  const rule = nameGatedRule({
    kind: "field",
    field: "oppName",
    op: "contains",
    value: "v4",
  });
  // Matching name → pairs; non-matching name → does not.
  const match = computeCompensation(
    [v3Cancel({ standardizedMrr: -500 }), v4Win({ standardizedMrr: 300, oppName: "BigCo V4 Deal" })],
    configWith([rule]),
  );
  assert.equal(match.pairSummaries.length, 1);
  assert.equal(match.compensable[1], 275);

  const noMatch = computeCompensation(
    [v3Cancel({ standardizedMrr: -500 }), v4Win({ standardizedMrr: 300, oppName: "BigCo V3 Deal" })],
    configWith([rule]),
  );
  assert.equal(noMatch.pairSummaries.length, 0);
  assert.equal(noMatch.compensable[1], 300);
});

test("Opp Name comma list: notContains excludes a name matching ANY token", () => {
  const rule = nameGatedRule({
    kind: "field",
    field: "oppName",
    op: "notContains",
    value: "v4, version4",
  });
  // Contains the second token → excluded (no pairing).
  const blocked = computeCompensation(
    [v3Cancel({ standardizedMrr: -500 }), v4Win({ standardizedMrr: 300, oppName: "Acme Version4 Renewal" })],
    configWith([rule]),
  );
  assert.equal(blocked.pairSummaries.length, 0);
  assert.equal(blocked.compensable[1], 300);

  // Contains neither token → allowed (pairs, capped).
  const allowed = computeCompensation(
    [v3Cancel({ standardizedMrr: -500 }), v4Win({ standardizedMrr: 300, oppName: "Acme V3 Renewal" })],
    configWith([rule]),
  );
  assert.equal(allowed.pairSummaries.length, 1);
  assert.equal(allowed.compensable[1], 275);
});

test("Opp Name comma list: contains matches a name containing ANY token", () => {
  const rule = nameGatedRule({
    kind: "field",
    field: "oppName",
    op: "contains",
    value: "v4, version4",
  });
  const res = computeCompensation(
    [v3Cancel({ standardizedMrr: -500 }), v4Win({ standardizedMrr: 300, oppName: "Acme version4 Plan" })],
    configWith([rule]),
  );
  assert.equal(res.pairSummaries.length, 1);
  assert.equal(res.compensable[1], 275);
});

test("Opp Name comma list: whitespace and empty tokens are ignored", () => {
  // Stray/trailing commas + spaces around tokens must not change the result.
  const rule = nameGatedRule({
    kind: "field",
    field: "oppName",
    op: "notContains",
    value: "  v4 ,, version4 , ",
  });
  const blocked = computeCompensation(
    [v3Cancel({ standardizedMrr: -500 }), v4Win({ standardizedMrr: 300, oppName: "BigCo V4 Deal" })],
    configWith([rule]),
  );
  assert.equal(blocked.pairSummaries.length, 0);

  // An all-empty value (only commas/spaces) yields no tokens → notContains is
  // true (excludes nothing), so the pairing still fires.
  const emptyRule = nameGatedRule({
    kind: "field",
    field: "oppName",
    op: "notContains",
    value: " , , ",
  });
  const allowed = computeCompensation(
    [v3Cancel({ standardizedMrr: -500 }), v4Win({ standardizedMrr: 300, oppName: "BigCo V4 Deal" })],
    configWith([emptyRule]),
  );
  assert.equal(allowed.pairSummaries.length, 1);
  assert.equal(allowed.compensable[1], 275);
});

// --- Reversibility (before/after comp adjustment) ----------------------------

test("Reverse: pre- and post-adjustment values are both recoverable", () => {
  const rows = [v3Cancel({ standardizedMrr: -500 }), v4Win({ standardizedMrr: 300 })];
  const res = computeCompensation(rows, configWith([downsellRule]));

  // Post-adjustment (as-comped) compensable totals.
  assert.equal(res.compensable[0], 0);
  assert.equal(res.compensable[1], 275);
  assert.equal(res.totalCompensable, 275);

  // Pre-adjustment (reversed) actuals are preserved on the result + inputs, so a
  // toggle can show the raw revenue Salesforce started from.
  assert.equal(res.totalActual, -200); // -500 + 300
  assert.equal(rows[0].standardizedMrr, -500);
  assert.equal(rows[1].standardizedMrr, 300);
});

// --- Pure matcher: no pairing without every Match opp -----------------------

test("A Match opp with no counterpart does not pair", () => {
  const rows = [v3Cancel({ standardizedMrr: -500 })];
  const { rowMeta, summaries } = evaluatePairedOppRules(rows, [downsellRule]);
  assert.equal(summaries.length, 0);
  assert.equal(rowMeta.size, 0);
});

test("Opps in different months on the same account do not pair (closeDate month link)", () => {
  // The V4 opp joins on BOTH Account ID and Close Date (month), so a V4 win in
  // a later month than the V3 cancel falls out of the deal.
  const monthLinkedRule: PairedOppRule = {
    ...downsellRule,
    id: "v3-v4-month-linked",
    opps: [
      v3Match,
      {
        name: "v4",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "V4" },
          { kind: "field", field: "type", op: "eq", value: "New" },
          sameAs("accountId", "v3"),
          sameAs("closeDate", "v3", "month"),
          {
            kind: "comparative",
            field: "changeInMrr",
            op: "lt",
            compareToOpp: "v3",
            compareToField: "changeInMrr",
          },
        ],
      },
    ],
  };
  const rows = [
    v3Cancel({ standardizedMrr: -500, closeDate: "2026-06-15" }),
    v4Win({ standardizedMrr: 300, closeDate: "2026-07-15" }),
  ];
  const res = computeCompensation(rows, configWith([monthLinkedRule]));
  assert.equal(res.pairSummaries.length, 0);
});

test("Same account + same month DO pair under a closeDate(month) identity link", () => {
  const monthLinkedRule: PairedOppRule = {
    ...downsellRule,
    id: "v3-v4-month-linked-ok",
    opps: [
      v3Match,
      {
        name: "v4",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "V4" },
          { kind: "field", field: "type", op: "eq", value: "New" },
          sameAs("accountId", "v3"),
          sameAs("closeDate", "v3", "month"),
          {
            kind: "comparative",
            field: "changeInMrr",
            op: "lt",
            compareToOpp: "v3",
            compareToField: "changeInMrr",
          },
        ],
      },
    ],
  };
  const rows = [
    v3Cancel({ standardizedMrr: -500, closeDate: "2026-06-05" }),
    v4Win({ standardizedMrr: 300, closeDate: "2026-06-28" }),
  ];
  const res = computeCompensation(rows, configWith([monthLinkedRule]));
  assert.equal(res.pairSummaries.length, 1);
  assert.equal(res.compensable[1], 275);
});

// --- Validation: anchor + identity-link structure ---------------------------

test("Validation: a non-anchor opp without an identity link is rejected", () => {
  const rows = [v3Cancel({ standardizedMrr: -500 }), v4Win({ standardizedMrr: 300 })];
  const unlinkedRule: PairedOppRule = {
    ...downsellRule,
    id: "v3-v4-unlinked",
    opps: [
      v3Match,
      {
        name: "v4",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "V4" },
          { kind: "field", field: "type", op: "eq", value: "New" },
          // No identity `=` link to an earlier opp → the engine cannot group it.
        ],
      },
    ],
  };
  // The engine treats a rule with no anchor join as inert (no deals formed).
  const res = computeCompensation(rows, configWith([unlinkedRule]));
  assert.equal(res.pairSummaries.length, 0);
});

// --- reassignMrrField fallback ----------------------------------------------

test("reassignMrrField falls back to standardized MRR for a row missing the chosen column", () => {
  const rule: PairedOppRule = {
    id: "fallback",
    label: "reassign field fallback",
    enabled: true,
    opps: [
      {
        name: "cancel",
        mode: "match",
        conditions: [{ kind: "field", field: "type", op: "eq", value: "Cancel" }],
      },
      {
        name: "win",
        mode: "match",
        conditions: [
          { kind: "field", field: "type", op: "eq", value: "New" },
          sameAs("accountId", "cancel"),
        ],
      },
    ],
    adjustments: [{ targetOpp: "win", op: "reassignMrrField", mrrField: "amount" }],
  };
  const rows = [
    row({ oppId: "cancel", type: "Cancel", standardizedMrr: -100 }),
    row({ oppId: "winA", type: "New", standardizedMrr: 50, amount: 200 }),
    // No amount supplied → this row falls back to standardizedMrr (80).
    row({ oppId: "winB", type: "New", standardizedMrr: 80 }),
  ];
  const res = computeCompensation(rows, configWith([rule]));
  assert.equal(res.compensable[1], 200); // own amount
  assert.equal(res.compensable[2], 80); // fallback to standardizedMrr
});

// --- Identity field surface --------------------------------------------------

test("Validation: dateGranularity is rejected on a non-closeDate identity link", () => {
  const badRule: PairedOppRule = {
    id: "bad-granularity",
    label: "granularity on accountId",
    enabled: true,
    opps: [
      v3Match,
      {
        name: "v4",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "V4" },
          // accountId is an identity field but NOT a date → dateGranularity is invalid.
          {
            kind: "comparative",
            field: "accountId",
            op: "eq",
            compareToOpp: "v3",
            compareToField: "accountId",
            dateGranularity: "month",
          },
        ],
      },
    ],
    adjustments: [{ targetOpp: "v3", op: "waive" }],
  };
  const res = validatePairedOppRules([badRule]);
  assert.equal(res.ok, false);
  assert.match(String(res.error), /dateGranularity is only allowed on an identity date comparative/);
});

test("A non-date identity field (Product) joins opps end-to-end", () => {
  // Two opps on the same account joined by a shared Product value: the win is
  // grouped with the cancel only when their Product cells match.
  const productJoinRule: PairedOppRule = {
    id: "product-join",
    label: "join by Product identity",
    enabled: true,
    opps: [
      {
        name: "cancel",
        mode: "match",
        conditions: [{ kind: "field", field: "type", op: "eq", value: "Cancel" }],
      },
      {
        name: "win",
        mode: "match",
        conditions: [
          { kind: "field", field: "type", op: "eq", value: "New" },
          sameAs("accountId", "cancel"),
          {
            kind: "comparative",
            field: "product",
            op: "eq",
            compareToOpp: "cancel",
            compareToField: "product",
          },
        ],
      },
    ],
    adjustments: [{ targetOpp: "cancel", op: "waive" }],
  };
  // Same account, SAME product → pairs and waives the cancel.
  const paired = computeCompensation(
    [
      row({ oppId: "c", type: "Cancel", product: "V4", standardizedMrr: -100 }),
      row({ oppId: "w", type: "New", product: "V4", standardizedMrr: 100 }),
    ],
    configWith([productJoinRule]),
  );
  assert.equal(paired.pairSummaries.length, 1);
  assert.equal(paired.compensable[0], 0); // cancel waived

  // Same account, DIFFERENT product → no join, no pairing.
  const unpaired = computeCompensation(
    [
      row({ oppId: "c", type: "Cancel", product: "V4", standardizedMrr: -100 }),
      row({ oppId: "w", type: "New", product: "V3", standardizedMrr: 100 }),
    ],
    configWith([productJoinRule]),
  );
  assert.equal(unpaired.pairSummaries.length, 0);
});

// --- compareToOpp reference scope -------------------------------------------

test("Validation: a comparative MAY reference its own opp (per-row internal comparison)", () => {
  const rule: PairedOppRule = {
    id: "self-ref-ok",
    label: "self-referencing comparative",
    enabled: true,
    opps: [
      {
        name: "anchor",
        mode: "match",
        conditions: [
          { kind: "field", field: "type", op: "eq", value: "New" },
          // per-row internal comparison: this opp's changeInMrr vs its own totalMrr.
          {
            kind: "comparative",
            field: "changeInMrr",
            op: "gt",
            compareToOpp: "anchor",
            compareToField: "totalMrr",
          },
        ],
      },
    ],
    adjustments: [{ targetOpp: "anchor", op: "waive" }],
  };
  const res = validatePairedOppRules([rule]);
  assert.equal(res.ok, true);
});

// A same-opp comparative is a per-row filter on its own opp's candidate rows.
// It must live on an opp that is already tied into a deal by a cross-opp link
// (a rule needs ≥1 anchor key field to fire), so we attach it to the V4 opp of
// a V3↔V4 pairing joined by accountId.
const selfNumericRule: PairedOppRule = {
  id: "self-numeric",
  label: "V4 per-row changeInMrr > totalMrr",
  enabled: true,
  opps: [
    v3Match,
    {
      name: "v4",
      mode: "match",
      conditions: [
        { kind: "field", field: "product", op: "eq", value: "V4" },
        { kind: "field", field: "type", op: "eq", value: "New" },
        sameAs("accountId", "v3"),
        {
          kind: "comparative",
          field: "changeInMrr",
          op: "gt",
          compareToOpp: "v4",
          compareToField: "totalMrr",
        },
      ],
    },
  ],
  adjustments: [{ targetOpp: "v3", op: "waive" }],
};

test("Same-opp numeric comparative is a per-row filter (field vs own other field)", () => {
  const rows = [
    v3Cancel({ standardizedMrr: -500 }),
    v4Win({ standardizedMrr: 300, changeInMrr: 500, totalMrr: 300 }),
  ];
  const res = computeCompensation(rows, configWith([selfNumericRule]));
  assert.equal(res.pairSummaries.length, 1); // V4 passes its per-row filter → pairs
  assert.equal(res.compensable[0], 0); // V3 churn waived
});

test("Same-opp numeric comparative excludes a row that fails the per-row filter", () => {
  const rows = [
    v3Cancel({ standardizedMrr: -500 }),
    v4Win({ standardizedMrr: 300, changeInMrr: 100, totalMrr: 300 }),
  ];
  const res = computeCompensation(rows, configWith([selfNumericRule]));
  assert.equal(res.pairSummaries.length, 0); // V4 fails its per-row filter → no counterpart
  assert.equal(res.compensable[1], 300); // V4 untouched
});

const selfIdentityRule: PairedOppRule = {
  id: "self-identity",
  label: "V4 per-row product = rawProduct",
  enabled: true,
  opps: [
    v3Match,
    {
      name: "v4",
      mode: "match",
      conditions: [
        { kind: "field", field: "product", op: "eq", value: "V4" },
        { kind: "field", field: "type", op: "eq", value: "New" },
        sameAs("accountId", "v3"),
        {
          kind: "comparative",
          field: "product",
          op: "eq",
          compareToOpp: "v4",
          compareToField: "rawProduct",
        },
      ],
    },
  ],
  adjustments: [{ targetOpp: "v3", op: "waive" }],
};

test("Same-opp identity comparative is a per-row filter (product = rawProduct)", () => {
  const rows = [
    v3Cancel({ standardizedMrr: -500 }),
    v4Win({ standardizedMrr: 300, product: "V4", rawProduct: "V4" }),
  ];
  const res = computeCompensation(rows, configWith([selfIdentityRule]));
  assert.equal(res.pairSummaries.length, 1); // product == rawProduct → pairs
  assert.equal(res.compensable[0], 0); // V3 churn waived
});

test("Same-opp identity comparative excludes a row where the fields differ", () => {
  const rows = [
    v3Cancel({ standardizedMrr: -500 }),
    v4Win({ standardizedMrr: 300, product: "V4", rawProduct: "V3" }),
  ];
  const res = computeCompensation(rows, configWith([selfIdentityRule]));
  assert.equal(res.pairSummaries.length, 0); // product != rawProduct → no counterpart
  assert.equal(res.compensable[1], 300); // V4 untouched
});

test("Validation: a comparative may reference an Exclude opp (not only Match opps)", () => {
  const rule: PairedOppRule = {
    id: "ref-exclude",
    label: "comparative referencing an exclude opp",
    enabled: true,
    opps: [
      v3Match,
      {
        name: "blocker",
        mode: "exclude",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "V5" },
          sameAs("accountId", "v3"),
        ],
      },
      {
        name: "v4",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "V4" },
          sameAs("accountId", "v3"),
          // numeric magnitude comparative pointing at the EXCLUDE opp — allowed.
          {
            kind: "comparative",
            field: "changeInMrr",
            op: "gte",
            compareToOpp: "blocker",
            compareToField: "changeInMrr",
          },
        ],
      },
    ],
    adjustments: [{ targetOpp: "v3", op: "waive" }],
  };
  const res = validatePairedOppRules([rule]);
  assert.equal(res.ok, true);
});

// --- Task #411: per-side Absolute/Actual + math-operator dropdown -----------
// A numeric comparative gate on the V4 opp: LEFT operand = V4's own field
// (`field`), RIGHT operand = the V3 opp's field (`compareToField`) combined with
// the scalar `factor` via `factorOp`. Each side applies abs unless its per-side
// "Actual Value" flag is set (leftSigned / rightSigned). We assert via whether
// the rule fires: it waives V3, so a fired rule → compensable[0] === 0 and one
// pairSummary; a non-fired rule leaves both rows untouched.
function t411GateRule(gate: Partial<CompPairedCondition>): PairedOppRule {
  return {
    id: "t411",
    label: "t411 comparative gate",
    enabled: true,
    opps: [
      v3Match,
      {
        name: "v4",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "V4" },
          { kind: "field", field: "type", op: "eq", value: "New" },
          sameAs("accountId", "v3"),
          {
            kind: "comparative",
            field: "changeInMrr", // LEFT = V4
            op: "gte",
            compareToOpp: "v3",
            compareToField: "changeInMrr", // RIGHT = V3
            ...gate,
          } as CompPairedCondition,
        ],
      },
    ],
    adjustments: [{ targetOpp: "v3", op: "waive" }],
  };
}

// rows[0] = V3 (RIGHT operand B), rows[1] = V4 (LEFT operand A).
const t411Rows = (left: number, right: number) => [
  v3Cancel({ standardizedMrr: right }),
  v4Win({ standardizedMrr: left }),
];
const t411Fired = (res: ReturnType<typeof computeCompensation>) =>
  res.pairSummaries.length === 1 && res.compensable[0] === 0;

// Per-side abs/actual: LEFT A=-200, RIGHT B=100, op gte.
//   both absolute → |−200|=200 >= |100|=100 → TRUE
//   left actual   → −200 >= |100|=100        → FALSE
//   right actual  → |−200|=200 >= 100        → TRUE
//   both actual   → −200 >= 100              → FALSE
test("Task #411: both sides Absolute (default) compares magnitudes", () => {
  const res = computeCompensation(t411Rows(-200, 100), configWith([t411GateRule({})]));
  assert.equal(t411Fired(res), true);
});

test("Task #411: LEFT Actual uses the raw signed left operand", () => {
  const res = computeCompensation(
    t411Rows(-200, 100),
    configWith([t411GateRule({ leftSigned: true })]),
  );
  assert.equal(t411Fired(res), false);
});

test("Task #411: RIGHT Actual uses the raw signed right operand", () => {
  const res = computeCompensation(
    t411Rows(-200, 100),
    configWith([t411GateRule({ rightSigned: true })]),
  );
  assert.equal(t411Fired(res), true);
});

test("Task #411: both sides Actual compares raw signed numbers", () => {
  const res = computeCompensation(
    t411Rows(-200, 100),
    configWith([t411GateRule({ leftSigned: true, rightSigned: true })]),
  );
  assert.equal(t411Fired(res), false);
});

// Operator dropdown: RIGHT = applyFactorOp(Σ B, op, factor), then abs. With
// B=100, factor=2 and op "eq", we set LEFT A to the exact expected right value
// so a correct operator fires and a wrong one does not.
test("Task #411: factorOp add (Σ field + scalar)", () => {
  const res = computeCompensation(
    t411Rows(102, 100),
    configWith([t411GateRule({ op: "eq", factorOp: "add", factor: 2 })]),
  );
  assert.equal(t411Fired(res), true);
});

test("Task #411: factorOp subtract (Σ field − scalar)", () => {
  const res = computeCompensation(
    t411Rows(98, 100),
    configWith([t411GateRule({ op: "eq", factorOp: "subtract", factor: 2 })]),
  );
  assert.equal(t411Fired(res), true);
});

test("Task #411: factorOp multiply (Σ field × scalar)", () => {
  const res = computeCompensation(
    t411Rows(200, 100),
    configWith([t411GateRule({ op: "eq", factorOp: "multiply", factor: 2 })]),
  );
  assert.equal(t411Fired(res), true);
});

test("Task #411: factorOp divide (Σ field ÷ scalar)", () => {
  const res = computeCompensation(
    t411Rows(50, 100),
    configWith([t411GateRule({ op: "eq", factorOp: "divide", factor: 2 })]),
  );
  assert.equal(t411Fired(res), true);
});

test("Task #411: factorOp divide by zero is safe (right operand → 0)", () => {
  const res = computeCompensation(
    t411Rows(0, 100),
    configWith([t411GateRule({ op: "eq", factorOp: "divide", factor: 0 })]),
  );
  assert.equal(t411Fired(res), true);
});

// Back-compat: legacy single `signed:true` ⇒ both sides Actual. With equal
// magnitudes A=-100 / B=100 and op gte: actual −100 >= 100 → FALSE (no fire);
// the default (signed absent → both abs) gives 100 >= 100 → TRUE (fires).
test("Task #411 back-compat: legacy signed:true ⇒ both sides Actual", () => {
  const res = computeCompensation(
    t411Rows(-100, 100),
    configWith([t411GateRule({ signed: true })]),
  );
  assert.equal(t411Fired(res), false);
});

test("Task #411 back-compat: legacy signed absent ⇒ both sides Absolute", () => {
  const res = computeCompensation(
    t411Rows(-100, 100),
    configWith([t411GateRule({})]),
  );
  assert.equal(t411Fired(res), true);
});

// Back-compat: a legacy `factor` with no `factorOp` multiplies (the old fixed
// "×"). B=50, factor=2, both abs, op eq, LEFT A=100 = |50 × 2| → fires; if the
// factor were ignored the right operand would be 50 ≠ 100.
test("Task #411 back-compat: legacy factor with no factorOp multiplies", () => {
  const res = computeCompensation(
    t411Rows(100, 50),
    configWith([t411GateRule({ op: "eq", factor: 2 })]),
  );
  assert.equal(t411Fired(res), true);
});

// Per-side factors: the LEFT operand (V4's own field) now carries its OWN scalar
// + operator (leftFactor/leftFactorOp), independent of the RIGHT operand. With
// op eq, LEFT A and RIGHT B both run through applyFactorOp then abs.
test("Per-side: leftFactor multiplies the LEFT operand", () => {
  // |A × 3| = |30 × 3| = 90 ; |B| = 90 → eq → fires. Without leftFactor LEFT=30.
  const res = computeCompensation(
    t411Rows(30, 90),
    configWith([
      t411GateRule({ op: "eq", leftFactor: 3, leftFactorOp: "multiply" }),
    ]),
  );
  assert.equal(t411Fired(res), true);
});

test("Per-side: leftFactorOp add combines this opp's Σ with leftFactor", () => {
  // |A + 5| = |95 + 5| = 100 ; |B| = 100 → eq → fires.
  const res = computeCompensation(
    t411Rows(95, 100),
    configWith([t411GateRule({ op: "eq", leftFactor: 5, leftFactorOp: "add" })]),
  );
  assert.equal(t411Fired(res), true);
});

test("Per-side: leftFactor and rightFactor apply independently", () => {
  // LEFT |A × 2| = |40 × 2| = 80 ; RIGHT |B + 30| = |50 + 30| = 80 → eq → fires.
  const res = computeCompensation(
    t411Rows(40, 50),
    configWith([
      t411GateRule({
        op: "eq",
        leftFactor: 2,
        leftFactorOp: "multiply",
        rightFactor: 30,
        rightFactorOp: "add",
      }),
    ]),
  );
  assert.equal(t411Fired(res), true);
});

test("Per-side: rightFactor wins over the legacy factor for the RIGHT side", () => {
  // rightFactor 2 → |B × 2| = |50 × 2| = 100 = |A|; legacy factor 10 (ignored)
  // would give 500 ≠ 100. eq → fires only if rightFactor takes precedence.
  const res = computeCompensation(
    t411Rows(100, 50),
    configWith([
      t411GateRule({
        op: "eq",
        factor: 10,
        rightFactor: 2,
        rightFactorOp: "multiply",
      }),
    ]),
  );
  assert.equal(t411Fired(res), true);
});

test("Per-side: rightFactorOp falls back to legacy factorOp when absent", () => {
  // rightFactorOp omitted but legacy factorOp "add" present: |B + 2| = |98 + 2|
  // = 100 = |A|. If it fell back to multiply instead, |98 × 2| = 196 ≠ 100.
  const res = computeCompensation(
    t411Rows(100, 98),
    configWith([t411GateRule({ op: "eq", factorOp: "add", rightFactor: 2 })]),
  );
  assert.equal(t411Fired(res), true);
});

test("Per-side: leftFactor absent ⇒ LEFT operand is the raw Σ (× 1)", () => {
  // No leftFactor → |A| = |80| = 80 = |B| → eq → fires.
  const res = computeCompensation(
    t411Rows(80, 80),
    configWith([t411GateRule({ op: "eq" })]),
  );
  assert.equal(t411Fired(res), true);
});

test("Validation: per-side factor/factorOp round-trip on a numeric comparative", () => {
  const rule = t411GateRule({
    op: "eq",
    leftFactor: 1.5,
    leftFactorOp: "add",
    rightFactor: 2.5,
    rightFactorOp: "divide",
  });
  const res = validatePairedOppRules([rule as unknown as PairedOppRule]);
  assert.equal(res.ok, true, res.ok ? "" : res.error);
  if (!res.ok) return;
  const cond = res.rules![0].opps[1].conditions[3] as Extract<
    CompPairedCondition,
    { kind: "comparative" }
  >;
  assert.equal(cond.leftFactor, 1.5);
  assert.equal(cond.leftFactorOp, "add");
  assert.equal(cond.rightFactor, 2.5);
  assert.equal(cond.rightFactorOp, "divide");
});

test("Validation: leftFactor is rejected on an identity comparative", () => {
  const bad: PairedOppRule = {
    id: "bad-leftfactor-identity",
    label: "leftFactor on accountId",
    enabled: true,
    opps: [
      v3Match,
      {
        name: "v4",
        mode: "match",
        conditions: [
          {
            kind: "comparative",
            field: "accountId",
            op: "eq",
            compareToOpp: "v3",
            compareToField: "accountId",
            leftFactor: 2,
          } as unknown as CompPairedCondition,
        ],
      },
    ],
    adjustments: [{ targetOpp: "v3", op: "waive" }],
  };
  const res = validatePairedOppRules([bad]);
  assert.equal(res.ok, false);
});

// Per-side flags must win over the legacy `signed` flag when both are present.
test("Task #411: per-side flags override the legacy signed flag", () => {
  // signed:true would make both Actual (−200 >= 100 → false), but rightSigned
  // is explicitly false → right uses abs; leftSigned absent falls back to the
  // legacy signed (true) for the left only: −200 >= |100| → still false.
  const res = computeCompensation(
    t411Rows(-200, 100),
    configWith([t411GateRule({ signed: true, rightSigned: false })]),
  );
  assert.equal(t411Fired(res), false);
  // Now force left to abs explicitly: |−200|=200 >= |100|=100 → fires.
  const res2 = computeCompensation(
    t411Rows(-200, 100),
    configWith([t411GateRule({ signed: true, leftSigned: false, rightSigned: false })]),
  );
  assert.equal(t411Fired(res2), true);
});

// --- Task #411: config migration (normalizeComparativeSidedFactorOp) --------
// The startup migration shares this exact traversal/logic. Comparatives live
// under rule.opps[].conditions (NOT rule.conditions).
test("Task #411 migration: legacy signed:true ⇒ both sides Actual, signed dropped", () => {
  const rules = [
    {
      id: "r",
      opps: [
        {
          name: "v4",
          mode: "match",
          conditions: [
            { kind: "field", field: "product", op: "eq", value: "V4" },
            {
              kind: "comparative",
              field: "changeInMrr",
              op: "gte",
              compareToOpp: "v3",
              compareToField: "changeInMrr",
              signed: true,
            },
          ],
        },
      ],
    },
  ];
  const changed = normalizeComparativeSidedFactorOp(rules);
  assert.equal(changed, true);
  const cond = (rules[0].opps[0].conditions[1] ?? {}) as Record<string, unknown>;
  assert.equal(cond.leftSigned, true);
  assert.equal(cond.rightSigned, true);
  assert.equal("signed" in cond, false);
});

test("Task #411 migration: legacy signed:false ⇒ both sides Absolute (false)", () => {
  const rules = [
    {
      id: "r",
      opps: [
        {
          name: "v4",
          mode: "match",
          conditions: [
            {
              kind: "comparative",
              field: "changeInMrr",
              op: "gte",
              compareToOpp: "v3",
              compareToField: "changeInMrr",
              signed: false,
            },
          ],
        },
      ],
    },
  ];
  const changed = normalizeComparativeSidedFactorOp(rules);
  assert.equal(changed, true);
  const cond = rules[0].opps[0].conditions[0] as Record<string, unknown>;
  assert.equal(cond.leftSigned, false);
  assert.equal(cond.rightSigned, false);
  assert.equal("signed" in cond, false);
});

test("Task #411 migration: existing factor ⇒ explicit multiply operator", () => {
  const rules = [
    {
      id: "r",
      opps: [
        {
          name: "v4",
          mode: "match",
          conditions: [
            {
              kind: "comparative",
              field: "changeInMrr",
              op: "gte",
              compareToOpp: "v3",
              compareToField: "changeInMrr",
              factor: 2,
            },
          ],
        },
      ],
    },
  ];
  const changed = normalizeComparativeSidedFactorOp(rules);
  assert.equal(changed, true);
  const cond = rules[0].opps[0].conditions[0] as Record<string, unknown>;
  assert.equal(cond.factorOp, "multiply");
  assert.equal(cond.factor, 2);
});

test("Task #411 migration: explicit per-side flags win over legacy signed", () => {
  const rules = [
    {
      id: "r",
      opps: [
        {
          name: "v4",
          mode: "match",
          conditions: [
            {
              kind: "comparative",
              field: "changeInMrr",
              op: "gte",
              compareToOpp: "v3",
              compareToField: "changeInMrr",
              signed: true,
              leftSigned: false,
            },
          ],
        },
      ],
    },
  ];
  const changed = normalizeComparativeSidedFactorOp(rules);
  assert.equal(changed, true);
  const cond = rules[0].opps[0].conditions[0] as Record<string, unknown>;
  // per-side flag present → leftSigned kept, rightSigned NOT auto-materialized,
  // redundant legacy signed dropped.
  assert.equal(cond.leftSigned, false);
  assert.equal("rightSigned" in cond, false);
  assert.equal("signed" in cond, false);
});

test("Task #411 migration: identity comparatives and clean rules are untouched", () => {
  const rules = [
    {
      id: "r",
      opps: [
        {
          name: "v4",
          mode: "match",
          conditions: [
            // identity comparative (no signed/factor) — left alone.
            {
              kind: "comparative",
              field: "accountId",
              op: "eq",
              compareToOpp: "v3",
              compareToField: "accountId",
            },
            // already-migrated numeric comparative — no change.
            {
              kind: "comparative",
              field: "changeInMrr",
              op: "gte",
              compareToOpp: "v3",
              compareToField: "changeInMrr",
              leftSigned: true,
              rightSigned: false,
              factorOp: "divide",
              factor: 2,
            },
          ],
        },
      ],
    },
  ];
  const before = JSON.stringify(rules);
  const changed = normalizeComparativeSidedFactorOp(rules);
  assert.equal(changed, false);
  assert.equal(JSON.stringify(rules), before);
});

test("Task #411 migration: tolerates malformed config without throwing", () => {
  assert.equal(normalizeComparativeSidedFactorOp(undefined), false);
  assert.equal(normalizeComparativeSidedFactorOp(null), false);
  assert.equal(normalizeComparativeSidedFactorOp("nope"), false);
  assert.equal(normalizeComparativeSidedFactorOp([{ id: "r" }]), false);
  assert.equal(
    normalizeComparativeSidedFactorOp([{ id: "r", opps: [{ name: "v4" }] }]),
    false,
  );
});

// --- Task #420: per-side FORMULA builder ------------------------------------
// A numeric comparative whose LEFT and RIGHT sides are each an ordered list of
// logic terms (opp-field or custom literal), combined by + − × ÷ with standard
// precedence and the per-term modifier applied ABS-INSIDE. The gate sits on the
// V4 opp and waives V3 when it fires, so t411Fired() reports firing.
type LogicTerm = NonNullable<
  Extract<CompPairedCondition, { kind: "comparative" }>["leftTerms"]
>[number];

function formulaGateRule(
  op: Extract<CompPairedCondition, { kind: "comparative" }>["op"],
  leftTerms: LogicTerm[],
  rightTerms: LogicTerm[],
): PairedOppRule {
  return {
    id: "t420",
    label: "t420 formula gate",
    enabled: true,
    opps: [
      v3Match,
      {
        name: "v4",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "V4" },
          { kind: "field", field: "type", op: "eq", value: "New" },
          sameAs("accountId", "v3"),
          {
            kind: "comparative",
            field: "changeInMrr",
            op,
            // Legacy operand fields are ignored once terms are present, but the
            // type requires them — they prove the dual path skips them.
            compareToOpp: "v3",
            compareToField: "changeInMrr",
            leftTerms,
            rightTerms,
          } as CompPairedCondition,
        ],
      },
    ],
    adjustments: [{ targetOpp: "v3", op: "waive" }],
  };
}

// rows[0] = V3, rows[1] = V4. The formula references opps by name, so the term's
// `opp` selects which row(s) it sums (changeInMrr ← standardizedMrr feeder).
const fRows = (v4: number, v3: number) => [
  v3Cancel({ standardizedMrr: v3 }),
  v4Win({ standardizedMrr: v4 }),
];

test("Task #420: single opp term per side reproduces a plain |Σ| gate", () => {
  // LEFT |Σ v4| = |200| ; RIGHT |Σ v3| = |100| ; gte → fires.
  const res = computeCompensation(
    fRows(200, 100),
    configWith([
      formulaGateRule(
        "gte",
        [{ source: "opp", opp: "v4", field: "changeInMrr" }],
        [{ source: "opp", opp: "v3", field: "changeInMrr" }],
      ),
    ]),
  );
  assert.equal(t411Fired(res), true);
});

test("Task #420: abs-INSIDE per-term modifier — (abs(Σ) − 1)", () => {
  // LEFT (|Σ v4| − 1) = |−200| − 1 = 199 ; RIGHT custom 199 ; eq → fires. Abs is
  // applied to the Σ BEFORE the −1, so a signed/outside reading (−201) would not.
  const res = computeCompensation(
    fRows(-200, 0),
    configWith([
      formulaGateRule(
        "eq",
        [
          {
            source: "opp",
            opp: "v4",
            field: "changeInMrr",
            factorOp: "subtract",
            factor: 1,
          },
        ],
        [{ source: "custom", value: 199 }],
      ),
    ]),
  );
  assert.equal(t411Fired(res), true);
});

test("Task #420: actual (signed) per-term modifier compares the raw Σ", () => {
  // LEFT signed Σ v4 = −200 ; RIGHT custom −200 ; eq → fires. With abs it would
  // be 200 ≠ −200 and not fire.
  const res = computeCompensation(
    fRows(-200, 0),
    configWith([
      formulaGateRule(
        "eq",
        [{ source: "opp", opp: "v4", field: "changeInMrr", signed: true }],
        [{ source: "custom", value: -200 }],
      ),
    ]),
  );
  assert.equal(t411Fired(res), true);
});

test("Task #420: precedence — × / ÷ bind before + / −", () => {
  // LEFT = a + b × c with a=|Σ v4|=10, b=custom 2, c=custom 3 → 10 + (2×3) = 16.
  // RIGHT custom 16 ; eq → fires. A naive left-to-right fold would give (10+2)×3
  // = 36 ≠ 16, so this asserts precedence.
  const res = computeCompensation(
    fRows(10, 0),
    configWith([
      formulaGateRule(
        "eq",
        [
          { source: "opp", opp: "v4", field: "changeInMrr" },
          { source: "custom", value: 2, joinOp: "add" },
          { source: "custom", value: 3, joinOp: "multiply" },
        ],
        [{ source: "custom", value: 16 }],
      ),
    ]),
  );
  assert.equal(t411Fired(res), true);
});

test("Task #420: division by zero in a side yields 0 (safe)", () => {
  // LEFT = |Σ v4| ÷ 0 → 0 ; RIGHT custom 0 ; eq → fires.
  const res = computeCompensation(
    fRows(500, 0),
    configWith([
      formulaGateRule(
        "eq",
        [
          { source: "opp", opp: "v4", field: "changeInMrr" },
          { source: "custom", value: 0, joinOp: "divide" },
        ],
        [{ source: "custom", value: 0 }],
      ),
    ]),
  );
  assert.equal(t411Fired(res), true);
});

test("Task #420: two opp terms across both sides combine correctly", () => {
  // LEFT = |Σ v4| + |Σ v3| = 200 + 100 = 300 ; RIGHT custom 300 ; eq → fires.
  const res = computeCompensation(
    fRows(200, 100),
    configWith([
      formulaGateRule(
        "eq",
        [
          { source: "opp", opp: "v4", field: "changeInMrr" },
          { source: "opp", opp: "v3", field: "changeInMrr", joinOp: "add" },
        ],
        [{ source: "custom", value: 300 }],
      ),
    ]),
  );
  assert.equal(t411Fired(res), true);
});

test("Task #420 back-compat: a legacy single-operand gate is unaffected", () => {
  // No terms → the legacy abs-OUTSIDE comparativeOperands path runs unchanged:
  // |Σ v4|=100 >= |Σ v3|=100 → fires (identical to pre-#420 behavior).
  const res = computeCompensation(
    t411Rows(-100, 100),
    configWith([t411GateRule({})]),
  );
  assert.equal(t411Fired(res), true);
});

test("Task #420 validation: formula terms round-trip through validation", () => {
  const rule = formulaGateRule(
    "gte",
    [
      {
        source: "opp",
        opp: "v4",
        field: "changeInMrr",
        factorOp: "subtract",
        factor: 1.25,
        signed: true,
      },
      { source: "custom", value: 2.5, joinOp: "multiply" },
    ],
    [{ source: "opp", opp: "v3", field: "changeInMrr" }],
  );
  const res = validatePairedOppRules([rule]);
  assert.equal(res.ok, true, res.ok ? "" : res.error);
  if (!res.ok) return;
  const cond = res.rules![0].opps[1].conditions[3] as Extract<
    CompPairedCondition,
    { kind: "comparative" }
  >;
  assert.equal(cond.leftTerms?.length, 2);
  assert.equal(cond.leftTerms?.[0].factor, 1.25);
  assert.equal(cond.leftTerms?.[0].factorOp, "subtract");
  assert.equal(cond.leftTerms?.[0].signed, true);
  assert.equal(cond.leftTerms?.[1].joinOp, "multiply");
  assert.equal(cond.leftTerms?.[1].value, 2.5);
  assert.equal(cond.rightTerms?.[0].opp, "v3");
});

test("Task #420 validation: a term referencing an unknown opp is rejected", () => {
  const rule = formulaGateRule(
    "gte",
    [{ source: "opp", opp: "ghost", field: "changeInMrr" }],
    [{ source: "custom", value: 1 }],
  );
  const res = validatePairedOppRules([rule]);
  assert.equal(res.ok, false);
});

test("Task #420 validation: a custom value beyond 2 decimals is rejected", () => {
  const rule = formulaGateRule(
    "gte",
    [{ source: "opp", opp: "v4", field: "changeInMrr" }],
    [{ source: "custom", value: 1.234 }],
  );
  const res = validatePairedOppRules([rule]);
  assert.equal(res.ok, false);
});

test("Task #420 validation: an empty formula side is rejected", () => {
  const rule = formulaGateRule(
    "gte",
    [],
    [{ source: "custom", value: 1 }],
  );
  const res = validatePairedOppRules([rule]);
  assert.equal(res.ok, false);
});

// --- closeDate ordering comparatives ----------------------------------------

// A V3 cancel ↔ V4 rebook tied by accountId, with a cross-opp ordering gate:
// the V4 rebook close date must be on/after the V3 cancel close date.
const rebookOrderingRule: PairedOppRule = {
  id: "v3-v4-rebook-order",
  label: "V4 rebook on/after V3 cancel",
  enabled: true,
  opps: [
    v3Match,
    {
      name: "v4",
      mode: "match",
      conditions: [
        { kind: "field", field: "product", op: "eq", value: "V4" },
        { kind: "field", field: "type", op: "eq", value: "New" },
        sameAs("accountId", "v3"),
        {
          kind: "comparative",
          field: "closeDate",
          op: "gte",
          compareToOpp: "v3",
          compareToField: "closeDate",
          dateGranularity: "exact",
        },
      ],
    },
  ],
  adjustments: [{ targetOpp: "v3", op: "waive" }],
};

test("Cross-opp closeDate ordering gate fires when V4 closes on/after V3", () => {
  const rows = [
    v3Cancel({ standardizedMrr: -500, closeDate: "2026-06-05" }),
    v4Win({ standardizedMrr: 300, closeDate: "2026-06-28" }),
  ];
  const res = computeCompensation(rows, configWith([rebookOrderingRule]));
  assert.equal(res.pairSummaries.length, 1);
  assert.equal(res.compensable[0], 0); // V3 churn waived
});

test("Cross-opp closeDate ordering gate does not fire when V4 closes before V3", () => {
  const rows = [
    v3Cancel({ standardizedMrr: -500, closeDate: "2026-06-28" }),
    v4Win({ standardizedMrr: 300, closeDate: "2026-06-05" }),
  ];
  const res = computeCompensation(rows, configWith([rebookOrderingRule]));
  assert.equal(res.pairSummaries.length, 0);
});

test("Validation: ordering ops require closeDate on both sides", () => {
  // closeDate (ordering ops are allowed) compared against a non-date identity
  // field is rejected — ordering is only meaningful between Close Date fields.
  const badRule: PairedOppRule = {
    id: "bad-ordering",
    label: "ordering closeDate vs product",
    enabled: true,
    opps: [
      v3Match,
      {
        name: "v4",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "V4" },
          sameAs("accountId", "v3"),
          {
            kind: "comparative",
            field: "closeDate",
            op: "gt",
            compareToOpp: "v3",
            compareToField: "product",
          },
        ],
      },
    ],
    adjustments: [{ targetOpp: "v3", op: "waive" }],
  };
  const res = validatePairedOppRules([badRule]);
  assert.equal(res.ok, false);
  assert.match(String(res.error), /ordering comparison/);
});

test("Validation: ordering ops are rejected on a non-closeDate identity field", () => {
  const badRule: PairedOppRule = {
    id: "bad-ordering-account",
    label: "ordering on accountId",
    enabled: true,
    opps: [
      v3Match,
      {
        name: "v4",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "V4" },
          sameAs("accountId", "v3"),
          {
            kind: "comparative",
            field: "accountId",
            op: "gt",
            compareToOpp: "v3",
            compareToField: "accountId",
          },
        ],
      },
    ],
    adjustments: [{ targetOpp: "v3", op: "waive" }],
  };
  const res = validatePairedOppRules([badRule]);
  assert.equal(res.ok, false);
  assert.match(String(res.error), /must be "eq" or "ne"/);
});

// Cross-field date ordering: the V4 rebook only counts when its OWN Close Date
// is on/after its OWN FUB First Purchase Date (two DIFFERENT date fields, same
// opp — a per-row self-comparative). The engine computes each side's date
// ordinal independently, so the two fields need not match.
const crossFieldDateOrderRule: PairedOppRule = {
  id: "v3-v4-close-after-firstpurchase",
  label: "V4 rebook Close Date ≥ FUB First Purchase Date",
  enabled: true,
  opps: [
    v3Match,
    {
      name: "v4",
      mode: "match",
      conditions: [
        { kind: "field", field: "product", op: "eq", value: "V4" },
        { kind: "field", field: "type", op: "eq", value: "New" },
        sameAs("accountId", "v3"),
        {
          kind: "comparative",
          field: "closeDate",
          op: "gte",
          compareToOpp: "v4", // same opp → per-row cross-field date check
          compareToField: "fub_first_purchase_date",
          dateGranularity: "exact",
        },
      ],
    },
  ],
  adjustments: [{ targetOpp: "v3", op: "waive" }],
};

test("Cross-field date ordering fires when Close Date is on/after FUB First Purchase Date", () => {
  const rows = [
    v3Cancel({ closeDate: "2026-06-05" }),
    v4Win({ closeDate: "2026-06-20", fubFirstPurchaseDate: "2026-06-05" }),
  ];
  const res = computeCompensation(rows, configWith([crossFieldDateOrderRule]));
  assert.equal(res.pairSummaries.length, 1);
  assert.equal(res.compensable[0], 0); // V3 churn waived
});

test("Cross-field date ordering does not fire when Close Date is before FUB First Purchase Date", () => {
  const rows = [
    v3Cancel({ closeDate: "2026-06-05" }),
    v4Win({ closeDate: "2026-06-01", fubFirstPurchaseDate: "2026-06-15" }),
  ];
  const res = computeCompensation(rows, configWith([crossFieldDateOrderRule]));
  assert.equal(res.pairSummaries.length, 0);
});

test("Validation: cross-field date ordering (Close Date vs FUB First Purchase Date) is allowed", () => {
  const res = validatePairedOppRules([crossFieldDateOrderRule]);
  assert.equal(res.ok, true);
});

// Task #376: exact-granularity identity date equality (Close Date =
// FUB First Purchase Date) must compare the two as calendar days, not raw
// strings. Close Date arrives from the Pipeline sheet as M/D/YYYY while
// FUB First Purchase Date arrives from Databricks as ISO YYYY-MM-DD, so the
// engine must normalize both before comparing — a new FUB first-purchase deal
// is one whose Close Date is the SAME day as its FUB First Purchase Date.
const sameDayFirstPurchaseRule: PairedOppRule = {
  id: "v3-v4-close-eq-firstpurchase",
  label: "V4 first-purchase: Close Date = FUB First Purchase Date",
  enabled: true,
  opps: [
    v3Match,
    {
      name: "v4",
      mode: "match",
      conditions: [
        { kind: "field", field: "product", op: "eq", value: "V4" },
        { kind: "field", field: "type", op: "eq", value: "New" },
        sameAs("accountId", "v3"),
        {
          kind: "comparative",
          field: "closeDate",
          op: "eq",
          compareToOpp: "v4", // same opp → per-row cross-field date check
          compareToField: "fub_first_purchase_date",
          dateGranularity: "exact",
        },
      ],
    },
  ],
  adjustments: [{ targetOpp: "v3", op: "waive" }],
};

test("Exact date equality fires when same day across mismatched formats (M/D/YYYY vs ISO)", () => {
  const rows = [
    v3Cancel({ closeDate: "2026-06-05" }),
    // Pipeline-style M/D/YYYY close date vs Databricks ISO first-purchase date,
    // both the same calendar day.
    v4Win({ closeDate: "6/16/2026", fubFirstPurchaseDate: "2026-06-16" }),
  ];
  const res = computeCompensation(rows, configWith([sameDayFirstPurchaseRule]));
  assert.equal(res.pairSummaries.length, 1);
  assert.equal(res.compensable[0], 0); // V3 churn waived
});

test("Exact date equality does not fire for an existing customer (different days)", () => {
  const rows = [
    v3Cancel({ closeDate: "2026-06-05" }),
    // Close Date is a different day than the original first purchase.
    v4Win({ closeDate: "6/16/2026", fubFirstPurchaseDate: "2025-01-10" }),
  ];
  const res = computeCompensation(rows, configWith([sameDayFirstPurchaseRule]));
  assert.equal(res.pairSummaries.length, 0);
});

test("Exact date equality never matches when a date is empty or unparseable", () => {
  const emptyRows = [
    v3Cancel({ closeDate: "2026-06-05" }),
    v4Win({ closeDate: "6/16/2026", fubFirstPurchaseDate: "" }),
  ];
  assert.equal(
    computeCompensation(emptyRows, configWith([sameDayFirstPurchaseRule]))
      .pairSummaries.length,
    0,
  );
  const badRows = [
    v3Cancel({ closeDate: "2026-06-05" }),
    v4Win({ closeDate: "not-a-date", fubFirstPurchaseDate: "not-a-date" }),
  ];
  // Even though the two raw strings are identical, an unparseable date must not
  // match (preserves the "blanks never equal" guard).
  assert.equal(
    computeCompensation(badRows, configWith([sameDayFirstPurchaseRule]))
      .pairSummaries.length,
    0,
  );
});

// Month granularity is unchanged: a same-month (different-day) deal still
// matches when granularity is month, even across mismatched input formats.
const sameMonthFirstPurchaseRule: PairedOppRule = {
  ...sameDayFirstPurchaseRule,
  id: "v3-v4-close-eq-firstpurchase-month",
  opps: [
    v3Match,
    {
      name: "v4",
      mode: "match",
      conditions: [
        { kind: "field", field: "product", op: "eq", value: "V4" },
        { kind: "field", field: "type", op: "eq", value: "New" },
        sameAs("accountId", "v3"),
        {
          kind: "comparative",
          field: "closeDate",
          op: "eq",
          compareToOpp: "v4",
          compareToField: "fub_first_purchase_date",
          dateGranularity: "month",
        },
      ],
    },
  ],
};

test("Month granularity still matches same-month dates across formats (unchanged)", () => {
  const rows = [
    v3Cancel({ closeDate: "2026-06-05" }),
    v4Win({ closeDate: "6/28/2026", fubFirstPurchaseDate: "2026-06-01" }),
  ];
  const res = computeCompensation(rows, configWith([sameMonthFirstPurchaseRule]));
  assert.equal(res.pairSummaries.length, 1);
  assert.equal(res.compensable[0], 0);
});

// ---------------------------------------------------------------------------
// Mode-aware rules (Task #344): per-rule appliesIn scope + filterConfigForMode.
//
// Both revenue views ("quota" / "sales") run the same compensation engine but
// over only the rules tagged for that view. A rule with no appliesIn defaults
// to "quota"; "both" applies in either view. filterConfigForMode narrows a
// config's multiplier + paired-opp rules to the active mode.
// ---------------------------------------------------------------------------

function multRule(overrides: Partial<CompMultiplierRule>): CompMultiplierRule {
  return {
    id: "m-default",
    label: "rule",
    conditions: [],
    multiplier: 1,
    ...overrides,
  };
}

function configWithMultipliers(
  multiplierRules: CompMultiplierRule[],
  pairedOppRules: PairedOppRule[] = [],
): CompensationConfig {
  return {
    monthYyyymm: "2026-06",
    multiplierRules,
    pairedOppRules,
    isDefault: true,
  };
}

test("filterConfigForMode: omitted appliesIn defaults to quota (kept in quota, dropped in sales)", () => {
  const cfg = configWithMultipliers([multRule({ id: "m1" })]);
  assert.equal(filterConfigForMode(cfg, "quota").multiplierRules.length, 1);
  assert.equal(filterConfigForMode(cfg, "sales").multiplierRules.length, 0);
});

test('filterConfigForMode: appliesIn "sales" rule is dropped in quota and kept in sales', () => {
  const cfg = configWithMultipliers([multRule({ id: "m1", appliesIn: "sales" })]);
  assert.equal(filterConfigForMode(cfg, "quota").multiplierRules.length, 0);
  assert.equal(filterConfigForMode(cfg, "sales").multiplierRules.length, 1);
});

test('filterConfigForMode: appliesIn "both" rule is kept in both modes', () => {
  const cfg = configWithMultipliers([multRule({ id: "m1", appliesIn: "both" })]);
  assert.equal(filterConfigForMode(cfg, "quota").multiplierRules.length, 1);
  assert.equal(filterConfigForMode(cfg, "sales").multiplierRules.length, 1);
});

test("filterConfigForMode: scopes paired-opp rules by appliesIn too", () => {
  const salesPaired: PairedOppRule = {
    ...REFERENCE_PAIRED_OPP_RULES[0],
    appliesIn: "sales",
  };
  const cfg = configWithMultipliers([], [salesPaired]);
  assert.equal(filterConfigForMode(cfg, "quota").pairedOppRules.length, 0);
  assert.equal(filterConfigForMode(cfg, "sales").pairedOppRules.length, 1);
});

test("filterConfigForMode: a mode with no applicable rules yields an empty (raw) rule set", () => {
  const cfg = configWithMultipliers([multRule({ id: "m1", appliesIn: "quota" })]);
  const sales = filterConfigForMode(cfg, "sales");
  assert.equal(sales.multiplierRules.length, 0);
  assert.equal(sales.pairedOppRules.length, 0);
});

test("validateMultiplierRules: accepts each valid appliesIn value and preserves it", () => {
  for (const scope of ["quota", "sales", "both"] as const) {
    const res = validateMultiplierRules([
      { id: "m1", label: "r", conditions: [], multiplier: 2, appliesIn: scope },
    ]);
    assert.equal(res.ok, true);
    assert.equal(res.rules?.[0].appliesIn, scope);
  }
});

test("validateMultiplierRules: omitted appliesIn is left undefined (treated as quota)", () => {
  const res = validateMultiplierRules([
    { id: "m1", label: "r", conditions: [], multiplier: 2 },
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.rules?.[0].appliesIn, undefined);
});

test("validateMultiplierRules: rejects an invalid appliesIn value", () => {
  const res = validateMultiplierRules([
    { id: "m1", label: "r", conditions: [], multiplier: 2, appliesIn: "total" },
  ]);
  assert.equal(res.ok, false);
  assert.match(String(res.error), /appliesIn .* must be one of quota, sales, both/);
});

test("validatePairedOppRules: accepts and preserves a valid appliesIn", () => {
  const rule: PairedOppRule = {
    ...REFERENCE_PAIRED_OPP_RULES[0],
    appliesIn: "both",
  };
  const res = validatePairedOppRules([rule]);
  assert.equal(res.ok, true);
  assert.equal(res.rules?.[0].appliesIn, "both");
});

test("validatePairedOppRules: rejects an invalid appliesIn value", () => {
  const rule = {
    ...REFERENCE_PAIRED_OPP_RULES[0],
    appliesIn: "nope",
  } as unknown as PairedOppRule;
  const res = validatePairedOppRules([rule]);
  assert.equal(res.ok, false);
  assert.match(String(res.error), /appliesIn .* must be one of quota, sales, both/);
});

// --- Task #362: malformed persisted config must not crash the engine ---------
//
// A jsonb compensation_config row (or a hand-edited / pre-validation row) can
// carry a rule whose `conditions` is missing or not an array. Before the fix the
// engine dereferenced `rule.conditions.length` / iterated `opp.conditions`
// directly, throwing mid-compute and 500-ing the whole (unfiltered) Product
// Logic "Unattributed opportunities" endpoint. The engine must now treat such a
// rule as a non-match and finish without throwing.

test("Malformed config: a multiplier rule missing conditions is ignored, not thrown", () => {
  const badMultiplier = { id: "m-bad", label: "no conditions", multiplier: 3 } as unknown as CompMultiplierRule;
  const config: CompensationConfig = {
    monthYyyymm: "2026-05",
    multiplierRules: [badMultiplier],
    pairedOppRules: [],
    isDefault: true,
  };
  const rows = [row({ oppId: "a", product: "Showcase", standardizedMrr: 100 })];
  let res!: ReturnType<typeof computeCompensation>;
  assert.doesNotThrow(() => {
    res = computeCompensation(rows, config);
  });
  // Treated as a non-match: raw MRR, no rule applied.
  assert.equal(res.compensable[0], 100);
  assert.equal(res.multipliers[0], 1);
  assert.equal(res.appliedRules[0].length, 0);
});

test("Malformed config: a paired-opp opp missing conditions is ignored, not thrown", () => {
  const badPaired = {
    id: "p-bad",
    label: "no conditions",
    enabled: true,
    opps: [
      { name: "anchor", mode: "match" },
      { name: "other", mode: "match" },
    ],
    adjustments: [{ targetOpp: "anchor", op: "waive" }],
  } as unknown as PairedOppRule;
  const config: CompensationConfig = {
    monthYyyymm: "2026-05",
    multiplierRules: [],
    pairedOppRules: [badPaired],
    isDefault: true,
  };
  const rows = [
    row({ oppId: "fub", product: "Follow Up Boss", type: "Cancel", standardizedMrr: -200 }),
    row({ oppId: "zpro", product: "Zillow Pro", type: "New", standardizedMrr: 500 }),
  ];
  let res!: ReturnType<typeof computeCompensation>;
  assert.doesNotThrow(() => {
    res = computeCompensation(rows, config);
  });
  // No deal key resolvable → rule never fires → raw MRR, no pairing.
  assert.equal(res.pairSummaries.length, 0);
  assert.equal(res.compensable[0], -200);
  assert.equal(res.compensable[1], 500);
});

// ---------------------------------------------------------------------------
// Task #375: read-only "paste-an-opp-id" condition tester diagnostics.
// diagnoseMultiplierRule + diagnosePairedRuleForOpp classify each condition as
// match / noMatch / notTestable without altering real evaluation.
// ---------------------------------------------------------------------------

function multiplierRule(
  conditions: CompMultiplierRule["conditions"],
): CompMultiplierRule {
  return { id: "m1", label: "Test", conditions, multiplier: 2 };
}

// A V4 win joined to the V3 anchor by Account ID, with a cross-opp comparative.
const v4Match: CompNamedOpp = {
  name: "v4",
  mode: "match",
  conditions: [
    { kind: "field", field: "product", op: "eq", value: "V4" },
    { kind: "field", field: "type", op: "eq", value: "New" },
    sameAs("accountId", "v3"),
    {
      kind: "comparative",
      field: "changeInMrr",
      op: "lt",
      compareToOpp: "v3",
      compareToField: "changeInMrr",
    },
  ],
};

test("diagnoseMultiplierRule: all conditions match → all green", () => {
  const rule = multiplierRule([
    { field: "product", op: "eq", value: "Showcase" },
    { field: "type", op: "eq", value: "New" },
  ]);
  const d = diagnoseMultiplierRule(
    [row({ oppId: "o1", product: "Showcase", type: "New" })],
    rule,
  );
  assert.deepEqual(d.conditions, ["match", "match"]);
});

test("diagnoseMultiplierRule: a failing condition → red", () => {
  const rule = multiplierRule([
    { field: "product", op: "eq", value: "Showcase" },
    { field: "type", op: "eq", value: "New" },
  ]);
  const d = diagnoseMultiplierRule(
    [row({ oppId: "o1", product: "Showcase", type: "Renewal" })],
    rule,
  );
  assert.deepEqual(d.conditions, ["match", "noMatch"]);
});

test("diagnoseMultiplierRule: no rows → all conditions notTestable", () => {
  const rule = multiplierRule([{ field: "product", op: "eq", value: "Showcase" }]);
  const d = diagnoseMultiplierRule([], rule);
  assert.deepEqual(d.conditions, ["notTestable"]);
});

test("diagnoseMultiplierRule: best-fitting line item is chosen across rows", () => {
  const rule = multiplierRule([
    { field: "product", op: "eq", value: "Showcase" },
    { field: "type", op: "eq", value: "New" },
  ]);
  // Two line items for the same opp; the second fits both conditions.
  const d = diagnoseMultiplierRule(
    [
      row({ oppId: "o1", product: "Other", type: "New" }),
      row({ oppId: "o1", product: "Showcase", type: "New" }),
    ],
    rule,
  );
  assert.deepEqual(d.conditions, ["match", "match"]);
});

test("diagnosePairedRuleForOpp: opp absent from month → every condition notTestable", () => {
  const rule: PairedOppRule = {
    id: "p1",
    label: "V3↔V4",
    enabled: true,
    opps: [v3Match, v4Match],
    adjustments: [],
  };
  const d = diagnosePairedRuleForOpp(
    [row({ oppId: "someone-else", product: "V3", type: "Cancel" })],
    "missing",
    rule,
  );
  assert.equal(d.selfOppName, null);
  for (const o of d.opps) assert.ok(o.conditions.every((c) => c === "notTestable"));
});

test("diagnosePairedRuleForOpp: pasted opp maps to its role; field conditions classified", () => {
  const rule: PairedOppRule = {
    id: "p1",
    label: "V3↔V4",
    enabled: true,
    opps: [v3Match, v4Match],
    adjustments: [],
  };
  // Only the V3 opp is present (no V4 partner).
  const d = diagnosePairedRuleForOpp(
    [row({ oppId: "v3", product: "V3", type: "Cancel", accountId: "A" })],
    "v3",
    rule,
  );
  assert.equal(d.selfOppName, "v3");
  const v3 = d.opps.find((o) => o.name === "v3")!;
  assert.ok(v3.isSelf);
  assert.ok(v3.resolved);
  // Both V3 field conditions (product=V3, type=Cancel) match.
  assert.deepEqual(v3.conditions, ["match", "match"]);
});

test("diagnosePairedRuleForOpp: cross-opp comparative is notTestable when partner absent", () => {
  // v4Match carries the identity link to v3; with no v3 present the link is
  // unresolved and the comparative cannot be evaluated.
  const rule: PairedOppRule = {
    id: "p1",
    label: "V3↔V4",
    enabled: true,
    opps: [v3Match, v4Match],
    adjustments: [],
  };
  const d = diagnosePairedRuleForOpp(
    [row({ oppId: "v4", product: "V4", type: "New", accountId: "A" })],
    "v4",
    rule,
  );
  assert.equal(d.selfOppName, "v4");
  const v3 = d.opps.find((o) => o.name === "v3")!;
  assert.equal(v3.resolved, false);
  // The cross-opp identity link on v4 has no v3 partner → notTestable.
  const v4 = d.opps.find((o) => o.name === "v4")!;
  assert.ok(v4.conditions.includes("notTestable"));
});

// ---------------------------------------------------------------------------
// diagnosePairedRuleForOpps (Task #394): each role pins its own pasted opp id;
// blank roles fall back to auto-resolution. Returns a per-card diagnosis plus an
// overall fires verdict (fires / doesNotFire / incomplete).
// ---------------------------------------------------------------------------

// A V3 cancel ↔ V3 new rebook joined by Account ID (no numeric gate).
const v3NewOpp: CompNamedOpp = {
  name: "v3new",
  mode: "match",
  conditions: [
    { kind: "field", field: "product", op: "eq", value: "V3" },
    { kind: "field", field: "type", op: "eq", value: "New" },
    sameAs("accountId", "v3"),
  ],
};
const multiRule: PairedOppRule = {
  id: "p-multi",
  label: "V3 cancel ↔ V3 new",
  enabled: true,
  opps: [v3Match, v3NewOpp],
  adjustments: [
    { targetOpp: "v3", op: "keep" },
    { targetOpp: "v3new", op: "keep" },
  ],
};
const multiRows = () => [
  row({ oppId: "c1", product: "V3", type: "Cancel", accountId: "A" }),
  row({ oppId: "n1", product: "V3", type: "New", accountId: "A" }),
];

test("diagnosePairedRuleForOpps: both ids pinned to their roles → rule fires", () => {
  const d = diagnosePairedRuleForOpps(multiRows(), ["c1", "n1"], multiRule);
  assert.equal(d.fires, "fires");
  const v3 = d.opps.find((o) => o.name === "v3")!;
  const v3new = d.opps.find((o) => o.name === "v3new")!;
  assert.equal(v3.pinned, true);
  assert.equal(v3.found, true);
  assert.equal(v3.resolved, true);
  assert.ok(v3.conditions.every((c) => c === "match"));
  assert.equal(v3new.pinned, true);
  assert.equal(v3new.found, true);
  assert.ok(v3new.conditions.every((c) => c === "match"));
});

test("diagnosePairedRuleForOpps: no ids entered → incomplete verdict", () => {
  const d = diagnosePairedRuleForOpps(multiRows(), ["", ""], multiRule);
  assert.equal(d.fires, "incomplete");
  // Blank roles are not pinned and carry found=true (nothing to look up).
  for (const o of d.opps) {
    assert.equal(o.pinned, false);
    assert.equal(o.found, true);
  }
});

test("diagnosePairedRuleForOpps: blank role auto-resolves from the pinned partner", () => {
  // Only the V3 cancel is pinned; the V3-new partner is auto-resolved by join.
  const d = diagnosePairedRuleForOpps(multiRows(), ["c1", ""], multiRule);
  assert.equal(d.fires, "fires");
  const v3 = d.opps.find((o) => o.name === "v3")!;
  const v3new = d.opps.find((o) => o.name === "v3new")!;
  assert.equal(v3.pinned, true);
  assert.equal(v3new.pinned, false);
  // The blank role still resolves a representative row via the deal join.
  assert.equal(v3new.resolved, true);
});

test("diagnosePairedRuleForOpps: pinned id absent from month → found=false, does not fire", () => {
  const d = diagnosePairedRuleForOpps(multiRows(), ["nope", "n1"], multiRule);
  const v3 = d.opps.find((o) => o.name === "v3")!;
  assert.equal(v3.pinned, true);
  assert.equal(v3.found, false);
  assert.equal(v3.resolved, false);
  // A match role that cannot resolve means the rule cannot fire.
  assert.equal(d.fires, "doesNotFire");
});

// ---------------------------------------------------------------------------
// Task #436: the tester must not let force-included DUPLICATE rows (carrying the
// same opp id but failing a role's field condition) leak into the numeric
// "magnitude" gates. The real engine only sums rows that pass the role's field
// conditions, so the tester must mirror that or it reports a false "does not
// fire". Repro: a V3 Cancel anchor with two identical −450 rows differing only
// by `user`; a `user is one of …` field condition keeps exactly one row in the
// engine (Σ = −450, equals the V4 +450 → fires), but the unfixed tester summed
// both (Σ = −900 ≠ 450 → false negative).
// ---------------------------------------------------------------------------

// V3 Cancel anchor whose `user` must be one of the compliance/account roster.
const v3DupAnchor: CompNamedOpp = {
  name: "v3",
  mode: "match",
  conditions: [
    { kind: "field", field: "product", op: "eq", value: "V3" },
    { kind: "field", field: "type", op: "eq", value: "Cancel" },
    {
      kind: "field",
      field: "user",
      op: "in",
      value: ["Compliance Sales", "Account Sales", "Zillow Sales"],
    },
  ],
};
// V4 win joined to the V3 anchor by Account ID with an equality magnitude gate.
const v4EqMagnitude: CompNamedOpp = {
  name: "v4",
  mode: "match",
  conditions: [
    { kind: "field", field: "product", op: "eq", value: "V4" },
    { kind: "field", field: "type", op: "eq", value: "New" },
    sameAs("accountId", "v3"),
    {
      kind: "comparative",
      field: "changeInMrr",
      op: "eq",
      compareToOpp: "v3",
      compareToField: "changeInMrr",
    },
  ],
};
const dupMagnitudeRule: PairedOppRule = {
  id: "v3-v4-eq-dup",
  label: "V3 = V4 magnitude (duplicate anchor rows)",
  enabled: true,
  opps: [v3DupAnchor, v4EqMagnitude],
  adjustments: [
    { targetOpp: "v3", op: "waive" },
    { targetOpp: "v4", op: "keep" },
  ],
};
// Two V3 rows for the same opp id, differing ONLY by `user`: one passes the
// roster condition, one fails it. Plus the matching V4 win.
const dupMagnitudeRows = (): CompRowInput[] => [
  row({
    oppId: "v3",
    product: "V3",
    type: "Cancel",
    accountId: "A",
    user: "Compliance Sales",
    standardizedMrr: -450,
    changeInMrr: -450,
  }),
  row({
    oppId: "v3",
    product: "V3",
    type: "Cancel",
    accountId: "A",
    user: "Some Rep",
    standardizedMrr: -450,
    changeInMrr: -450,
  }),
  row({
    oppId: "v4",
    product: "V4",
    type: "New",
    accountId: "A",
    standardizedMrr: 450,
    changeInMrr: 450,
  }),
];

test("Task #436: the real engine fires (duplicate anchor row filtered out of Σ)", () => {
  const res = computeCompensation(dupMagnitudeRows(), configWith([dupMagnitudeRule]));
  // Σ of field-matching V3 rows = −450 (the "Some Rep" duplicate is filtered),
  // equals the V4 +450 → the equality gate passes and the rule fires.
  assert.equal(res.pairSummaries.length, 1);
});

test("Task #436: single-opp tester reports the magnitude gate green (no double-count)", () => {
  const d = diagnosePairedRuleForOpp(dupMagnitudeRows(), "v4", dupMagnitudeRule);
  const v4 = d.opps.find((o) => o.name === "v4")!;
  // conditions[3] is the changeInMrr equality magnitude gate. Before the fix the
  // tester summed BOTH v3 rows (−900) and reported "noMatch"; now it sums only
  // the field-matching row (−450) and reports "match".
  assert.equal(v4.conditions[3], "match");
});

test("Task #436: multi-opp tester fires (magnitude gate not double-counted)", () => {
  const d = diagnosePairedRuleForOpps(
    dupMagnitudeRows(),
    ["v3", "v4"],
    dupMagnitudeRule,
  );
  assert.equal(d.fires, "fires");
  const v4 = d.opps.find((o) => o.name === "v4")!;
  assert.equal(v4.conditions[3], "match");
});

test("Task #436: a genuinely-failing field condition still shows red", () => {
  // Only the duplicate that FAILS the roster condition is present (plus the V4).
  // The V3 role's field condition must still highlight red, and the now-empty
  // field-matched set makes the magnitude gate untestable (engine wouldn't fire).
  const rows: CompRowInput[] = [
    row({
      oppId: "v3",
      product: "V3",
      type: "Cancel",
      accountId: "A",
      user: "Some Rep",
      standardizedMrr: -450,
      changeInMrr: -450,
    }),
    row({
      oppId: "v4",
      product: "V4",
      type: "New",
      accountId: "A",
      standardizedMrr: 450,
      changeInMrr: 450,
    }),
  ];
  const d = diagnosePairedRuleForOpp(rows, "v3", dupMagnitudeRule);
  const v3 = d.opps.find((o) => o.name === "v3")!;
  // conditions[2] is the `user is one of …` field condition → red.
  assert.equal(v3.conditions[2], "noMatch");
});

// ---------------------------------------------------------------------------
// Drilldown ↔ export rule-affected parity (Task #404).
//
// Tasks #402/#403 fixed a divergence where the on-screen drilldown and the CSV
// export disagreed about which opps a FIRED paired rule (e.g. FUB↔Zpro) marks
// as "affected by a rule". The fix was hand-mirrored in two builders in
// sheets-data.ts; this guards against re-introducing the divergence by feeding
// one fixture through BOTH builders' (now extracted, pure) flag derivations and
// asserting they agree.
// ---------------------------------------------------------------------------

// The set of opp ids each surface flags as affected by the rule with the given
// LABEL. The drilldown exposes labels directly; the export exposes labels too
// (ruleNames), so we compare label-membership apples-to-apples.
function affectedOppsDrilldown(
  rows: CompRowInput[],
  result: ReturnType<typeof computeCompensation>,
  label: string,
): Set<string> {
  const out = new Set<string>();
  rows.forEach((r, i) => {
    const { ruleNames } = ruleAffectmentForDrilldown(result, i);
    if (ruleNames.includes(label) && r.oppId) out.add(r.oppId);
  });
  return out;
}
function affectedOppsExport(
  rows: CompRowInput[],
  result: ReturnType<typeof computeCompensation>,
  label: string,
): Set<string> {
  const out = new Set<string>();
  rows.forEach((r, i) => {
    const { ruleNames } = ruleAffectmentForExport(result, i);
    if (ruleNames.includes(label) && r.oppId) out.add(r.oppId);
  });
  return out;
}

const NET_PAIR_LABEL = REFERENCE_PAIRED_OPP_RULES.find(
  (r) => r.id === "fub-zpro-net",
)!.label;

function ruleAffectmentFixture(): {
  rows: CompRowInput[];
  result: ReturnType<typeof computeCompensation>;
} {
  const rows = [
    // FIRED net pair on account A: a FUB cancel + a Zpro win on the same
    // account/month, flex status NOT in the flex list → net branch fires. Both
    // members must be flagged as affected by the paired rule.
    row({ oppId: "fub-A", accountId: "acct-A", product: "Follow Up Boss", type: "Cancel", standardizedMrr: -200, flexFlipAgentStatus: "Churned" }),
    row({ oppId: "zpro-A", accountId: "acct-A", product: "Zillow Pro", type: "New", standardizedMrr: 500, changeInMrr: 500, flexFlipAgentStatus: "Churned" }),
    // UNFIRED pair on account B: the Zpro candidate has changeInMrr <= 0, so the
    // "changeInMrr > 0" match condition fails and the pair never forms. Neither
    // member may be flagged by either surface.
    row({ oppId: "fub-B", accountId: "acct-B", product: "Follow Up Boss", type: "Cancel", standardizedMrr: -150, flexFlipAgentStatus: "Churned" }),
    row({ oppId: "zpro-B", accountId: "acct-B", product: "Zillow Pro", type: "New", standardizedMrr: 0, changeInMrr: -50, flexFlipAgentStatus: "Churned" }),
    // A plain multiplier-rule row (ZMX, legacy_flag = false → ×0.5), unrelated to
    // any pairing, to check non-paired flagging stays consistent across surfaces.
    row({ oppId: "zmx", accountId: "acct-C", product: "ZMX", type: "New", standardizedMrr: 100, legacyFlag: false }),
  ];
  const config: CompensationConfig = {
    monthYyyymm: "2026-06",
    multiplierRules: REFERENCE_MULTIPLIER_RULES,
    pairedOppRules: REFERENCE_PAIRED_OPP_RULES,
    isDefault: true,
  };
  return { rows, result: computeCompensation(rows, config) };
}

test("Parity: a fired paired rule flags the same opps in the drilldown and the export", () => {
  const { rows, result } = ruleAffectmentFixture();
  // The pair actually fired exactly once (account A).
  assert.equal(result.pairSummaries.length, 1);

  const drill = affectedOppsDrilldown(rows, result, NET_PAIR_LABEL);
  const exp = affectedOppsExport(rows, result, NET_PAIR_LABEL);

  // Both surfaces flag BOTH fired-pair members — not only the adjustment target.
  assert.deepEqual([...drill].sort(), ["fub-A", "zpro-A"]);
  assert.deepEqual([...exp].sort(), ["fub-A", "zpro-A"]);
  // …and they agree with each other.
  assert.deepEqual([...drill].sort(), [...exp].sort());
});

test("Parity: an unfired pair flags no opps in either surface", () => {
  const { rows, result } = ruleAffectmentFixture();

  // The account-B candidates never pair, so neither carries the rule label…
  const drill = affectedOppsDrilldown(rows, result, NET_PAIR_LABEL);
  const exp = affectedOppsExport(rows, result, NET_PAIR_LABEL);
  assert.equal(drill.has("fub-B"), false);
  assert.equal(drill.has("zpro-B"), false);
  assert.equal(exp.has("fub-B"), false);
  assert.equal(exp.has("zpro-B"), false);

  // …and the unfired rows are flagged by NO rule at all in either surface.
  const idx = new Map(rows.map((r, i) => [r.oppId, i]));
  for (const id of ["fub-B", "zpro-B"]) {
    const i = idx.get(id)!;
    assert.deepEqual(ruleAffectmentForDrilldown(result, i).ruleNames, []);
    assert.deepEqual(ruleAffectmentForExport(result, i).ruleNames, []);
    assert.equal(ruleAffectmentForExport(result, i).matched, false);
  }
});

test("Parity: plain multiplier-rule flagging is unchanged and consistent across surfaces", () => {
  const { rows, result } = ruleAffectmentFixture();
  const zmxLabel = REFERENCE_MULTIPLIER_RULES.find(
    (r) => r.id === "zmx-not-legacy",
  )!.label;

  const drill = affectedOppsDrilldown(rows, result, zmxLabel);
  const exp = affectedOppsExport(rows, result, zmxLabel);

  // The ZMX row is flagged for its multiplier rule by both surfaces, and only it.
  assert.deepEqual([...drill].sort(), ["zmx"]);
  assert.deepEqual([...exp].sort(), ["zmx"]);
  assert.deepEqual([...drill].sort(), [...exp].sort());
});

// --- Numeric comparative factor / signed modifiers --------------------------

// A V3→V4 downsell gate whose numeric comparative can carry an optional
// `factor` (RHS multiplier) and `signed` (sign-preserving) modifier.
function gateRule(
  op: CompPairedCondition["op"],
  factor?: number,
  signed?: boolean,
): PairedOppRule {
  return {
    id: "gate-test",
    label: "gate test",
    enabled: true,
    opps: [
      v3Match,
      {
        name: "v4",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "V4" },
          { kind: "field", field: "type", op: "eq", value: "New" },
          sameAs("accountId", "v3"),
          {
            kind: "comparative",
            field: "changeInMrr",
            op,
            compareToOpp: "v3",
            compareToField: "changeInMrr",
            ...(factor !== undefined ? { factor } : {}),
            ...(signed !== undefined ? { signed } : {}),
          },
        ],
      },
    ],
    adjustments: [
      { targetOpp: "v3", op: "waive" },
      { targetOpp: "v4", op: "keep" },
    ],
  };
}

test("factor scales the RHS of a magnitude comparative", () => {
  // |V4|=600 < |V3|=500 is false → no pair without a factor.
  const rows = [
    v3Cancel({ standardizedMrr: -500, changeInMrr: -500 }),
    v4Win({ standardizedMrr: 600, changeInMrr: 600 }),
  ];
  assert.equal(evaluatePairedOppRules(rows, [gateRule("lt")]).summaries.length, 0);
  // factor 1.5 → |600| < |1.5·(−500)| = 750 → true → pairs.
  assert.equal(evaluatePairedOppRules(rows, [gateRule("lt", 1.5)]).summaries.length, 1);
});

test("factor undefined behaves exactly like factor=1 (backward compatible)", () => {
  const rows = [
    v3Cancel({ standardizedMrr: -500, changeInMrr: -500 }),
    v4Win({ standardizedMrr: 300, changeInMrr: 300 }),
  ];
  const a = evaluatePairedOppRules(rows, [gateRule("lt")]).summaries.length;
  const b = evaluatePairedOppRules(rows, [gateRule("lt", 1)]).summaries.length;
  assert.equal(a, 1);
  assert.equal(a, b);
});

test("signed mode compares raw aggregates instead of magnitudes", () => {
  // LHS=−600, RHS=500, op=gt: |−600|=600 > |500|=500 fires in magnitude mode,
  // but −600 > 500 is false in signed mode.
  const rows = [
    v3Cancel({ standardizedMrr: -500, changeInMrr: 500 }),
    v4Win({ standardizedMrr: 300, changeInMrr: -600 }),
  ];
  assert.equal(evaluatePairedOppRules(rows, [gateRule("gt")]).summaries.length, 1);
  assert.equal(evaluatePairedOppRules(rows, [gateRule("gt", undefined, true)]).summaries.length, 0);
});

test("Validation: factor and signed round-trip on a numeric comparative", () => {
  const res = validatePairedOppRules([gateRule("lt", 1.5, true)]);
  assert.equal(res.ok, true);
  const cond = res.rules![0].opps[1].conditions[3] as Extract<
    CompPairedCondition,
    { kind: "comparative" }
  >;
  assert.equal(cond.factor, 1.5);
  assert.equal(cond.signed, true);
});

test("Validation: factor is rejected on an identity comparative", () => {
  const badRule: PairedOppRule = {
    id: "bad-factor-identity",
    label: "factor on accountId",
    enabled: true,
    opps: [
      v3Match,
      {
        name: "v4",
        mode: "match",
        conditions: [
          { kind: "field", field: "product", op: "eq", value: "V4" },
          {
            kind: "comparative",
            field: "accountId",
            op: "eq",
            compareToOpp: "v3",
            compareToField: "accountId",
            factor: 2,
          },
        ],
      },
    ],
    adjustments: [{ targetOpp: "v3", op: "waive" }],
  };
  const res = validatePairedOppRules([badRule]);
  assert.equal(res.ok, false);
  assert.match(String(res.error), /factor is only allowed on a numeric/);
});

test("Validation: a non-finite factor is rejected", () => {
  const res = validatePairedOppRules([gateRule("lt", Number.POSITIVE_INFINITY)]);
  assert.equal(res.ok, false);
  assert.match(String(res.error), /factor .* must be a finite number/);
});
