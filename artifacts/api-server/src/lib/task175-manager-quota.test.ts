import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRepQuotaFields } from "./sheets-data";

// ---------------------------------------------------------------------------
// Regression test for Task #175: prorated Goal double-counting FLMs / SLMs
//
// Root cause: the per-rep payload builder in sheets-data.ts had duplicate
// object keys for showcaseGoalByYm / mbpGoalByYm / goal30dByYm. The first
// definitions were correctly gated with `isManager ? {} : { ... }`, but a
// second unguarded block later in the same object literal silently overrode
// them (last-key-wins in JS). This caused manager quotas to leak into the
// prorated Goal/Forecast totals.
//
// The fix extracted the guard logic into `buildRepQuotaFields` (exported from
// sheets-data.ts) and replaced the inline duplicate block with a single call.
// These tests import and exercise that real production function directly.
// ---------------------------------------------------------------------------

const CURRENT_YM = "2026-05";
const LAST_YM = "2026-04";

const FLM_NAME = "Test Manager";
const REP1_NAME = "Rep A";
const REP2_NAME = "Rep B";

function makeQuota(showcase: number, mbp: number) {
  return {
    showcaseQuota: showcase,
    mbpQuota: mbp,
    totalQuota: showcase + mbp,
    scNetMrrGoal: showcase,
    mbpNetMrrGoal: mbp,
    totalNetMrrGoal: showcase + mbp,
    scChurnGoal: 0,
    mbpChurnGoal: 0,
    scMrrAddedGoal: 0,
    mbpMrrAddedGoal: 0,
    productGoals: {
      Showcase: { mrrAddedGoal: 0, churnGoal: 0, netGoal: showcase },
      MBP: { mrrAddedGoal: 0, churnGoal: 0, netGoal: mbp },
    },
    group: "G&R",
  };
}

const currentQuotas = {
  [FLM_NAME]: makeQuota(20800, 5000),
  [REP1_NAME]: makeQuota(10400, 2500),
  [REP2_NAME]: makeQuota(10400, 2500),
};

const lastMonthQuotas = {
  [FLM_NAME]: makeQuota(19000, 4500),
  [REP1_NAME]: makeQuota(9500, 2000),
  [REP2_NAME]: makeQuota(9500, 2000),
};

// selectedQuotas = currentQuotas when filtering to current month (normal case)
const selectedCurrentMonth = currentQuotas;
// selectedQuotas = lastMonthQuotas when user has filtered to prior month
const selectedLastMonth = lastMonthQuotas;

// ---------------------------------------------------------------------------
// FLM (player-coach) — must have empty per-month maps and zero scalar goals
// ---------------------------------------------------------------------------

test("Task #175: player-coach FLM showcaseGoalByYm is empty {}", () => {
  const fields = buildRepQuotaFields(FLM_NAME, true, CURRENT_YM, LAST_YM, selectedCurrentMonth, currentQuotas, lastMonthQuotas);
  assert.deepEqual(fields.showcaseGoalByYm, {}, "FLM showcaseGoalByYm must be empty to avoid double-counting");
});

test("Task #175: player-coach FLM mbpGoalByYm is empty {}", () => {
  const fields = buildRepQuotaFields(FLM_NAME, true, CURRENT_YM, LAST_YM, selectedCurrentMonth, currentQuotas, lastMonthQuotas);
  assert.deepEqual(fields.mbpGoalByYm, {}, "FLM mbpGoalByYm must be empty to avoid double-counting");
});

test("Task #175: player-coach FLM goal30dByYm is empty {}", () => {
  const fields = buildRepQuotaFields(FLM_NAME, true, CURRENT_YM, LAST_YM, selectedCurrentMonth, currentQuotas, lastMonthQuotas);
  assert.deepEqual(fields.goal30dByYm, {}, "FLM goal30dByYm must be empty to avoid double-counting");
});

test("Task #175: player-coach FLM scalar showcaseGoal is 0", () => {
  const fields = buildRepQuotaFields(FLM_NAME, true, CURRENT_YM, LAST_YM, selectedCurrentMonth, currentQuotas, lastMonthQuotas);
  assert.equal(fields.showcaseGoal, 0, "FLM scalar showcaseGoal must be 0");
});

test("Task #175: player-coach FLM scalar mbpGoal is 0", () => {
  const fields = buildRepQuotaFields(FLM_NAME, true, CURRENT_YM, LAST_YM, selectedCurrentMonth, currentQuotas, lastMonthQuotas);
  assert.equal(fields.mbpGoal, 0, "FLM scalar mbpGoal must be 0");
});

test("Task #175: player-coach FLM scalar goal30d is 0", () => {
  const fields = buildRepQuotaFields(FLM_NAME, true, CURRENT_YM, LAST_YM, selectedCurrentMonth, currentQuotas, lastMonthQuotas);
  assert.equal(fields.goal30d, 0, "FLM scalar goal30d must be 0");
});

// ---------------------------------------------------------------------------
// SLM — same assertions (isManager=true path is identical)
// ---------------------------------------------------------------------------

test("Task #175: SLM all quota fields are empty/zero", () => {
  const fields = buildRepQuotaFields(FLM_NAME, true, CURRENT_YM, LAST_YM, selectedCurrentMonth, currentQuotas, lastMonthQuotas);
  assert.deepEqual(fields.showcaseGoalByYm, {});
  assert.deepEqual(fields.mbpGoalByYm, {});
  assert.deepEqual(fields.goal30dByYm, {});
  assert.equal(fields.showcaseGoal, 0);
  assert.equal(fields.mbpGoal, 0);
  assert.equal(fields.goal30d, 0);
});

// ---------------------------------------------------------------------------
// IC rep — current-month filter: scalars from currentQuotas, maps populated
// ---------------------------------------------------------------------------

test("Task #175: IC rep (current month) showcaseGoalByYm populated, scalars from current quota", () => {
  const fields = buildRepQuotaFields(REP1_NAME, false, CURRENT_YM, LAST_YM, selectedCurrentMonth, currentQuotas, lastMonthQuotas);
  assert.equal(Object.keys(fields.showcaseGoalByYm).length, 2);
  assert.equal(fields.showcaseGoalByYm[CURRENT_YM], 10400);
  assert.equal(fields.showcaseGoalByYm[LAST_YM], 9500, "last-month slot uses lastMonthQuotas, not currentQuotas");
  assert.equal(fields.showcaseGoal, 10400, "scalar must come from selectedQuotas (current month)");
  assert.equal(fields.mbpGoal, 2500);
  assert.equal(fields.goal30d, 12900);
});

// ---------------------------------------------------------------------------
// IC rep — LAST-month filter: scalars must reflect last-month quota, not
// current month. This is the non-prorated path; it must remain unchanged.
// ---------------------------------------------------------------------------

test("Task #175: IC rep (last-month filter) scalars come from last-month quota", () => {
  const fields = buildRepQuotaFields(REP1_NAME, false, CURRENT_YM, LAST_YM, selectedLastMonth, currentQuotas, lastMonthQuotas);
  // Scalars must come from selectedLastMonth (9500/2000), NOT currentQuotas (10400/2500)
  assert.equal(fields.showcaseGoal, 9500, "scalar showcaseGoal must reflect last-month selectedQuotas");
  assert.equal(fields.mbpGoal, 2000, "scalar mbpGoal must reflect last-month selectedQuotas");
  assert.equal(fields.goal30d, 11500, "scalar goal30d must reflect last-month selectedQuotas");
  // Per-month maps are always current+last regardless of selected month
  assert.equal(fields.showcaseGoalByYm[CURRENT_YM], 10400, "ByYm map current slot always from currentQuotas");
  assert.equal(fields.showcaseGoalByYm[LAST_YM], 9500, "ByYm map last slot always from lastMonthQuotas");
});

test("Task #175: IC rep goal30dByYm populated with correct month values", () => {
  const fields = buildRepQuotaFields(REP2_NAME, false, CURRENT_YM, LAST_YM, selectedCurrentMonth, currentQuotas, lastMonthQuotas);
  assert.equal(Object.keys(fields.goal30dByYm).length, 2);
  assert.equal(fields.goal30dByYm[CURRENT_YM], 12900);
  assert.equal(fields.goal30dByYm[LAST_YM], 11500);
});

// ---------------------------------------------------------------------------
// Team total sanity: goalLookupFor logic — sum across FLM + 2 reps must
// equal only the 2 reps' quotas (FLM's empty map causes fallback to scalar=0)
// ---------------------------------------------------------------------------

test("Task #175: team total excludes FLM quota from per-month maps", () => {
  const people: Array<{ name: string; isManager: boolean }> = [
    { name: FLM_NAME, isManager: true },
    { name: REP1_NAME, isManager: false },
    { name: REP2_NAME, isManager: false },
  ];

  let totalShowcaseForCurrentMonth = 0;
  for (const person of people) {
    const f = buildRepQuotaFields(person.name, person.isManager, CURRENT_YM, LAST_YM, selectedCurrentMonth, currentQuotas, lastMonthQuotas);
    // Mirrors PipelineView.tsx goalLookupFor: use per-month value when the ym
    // key exists, otherwise fall back to scalar. For managers the map is {}
    // so hasOwnProperty returns false and the scalar (0) is used instead.
    const monthGoal = Object.prototype.hasOwnProperty.call(f.showcaseGoalByYm, CURRENT_YM)
      ? f.showcaseGoalByYm[CURRENT_YM]
      : f.showcaseGoal;
    totalShowcaseForCurrentMonth += monthGoal;
  }

  // REP1 (10400) + REP2 (10400) = 20800. FLM must contribute 0.
  assert.equal(totalShowcaseForCurrentMonth, 20800, "Team total must exclude the FLM's own quota");
});
