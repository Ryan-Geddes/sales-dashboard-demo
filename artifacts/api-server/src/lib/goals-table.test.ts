import { test } from "node:test";
import assert from "node:assert/strict";
import {
  repPassesFilter,
  defaultOverrideValues,
  mergeOverrideValues,
  resolveEffectiveERep,
  computeFinalGoals,
  isGoalSourceId,
  canonicalMonth,
  overrideKey,
  teamKeyFor,
  computeTeamSizes,
  sourceDividesByTeam,
  applyTeamSplit,
} from "./goals-table";
import type { GoalRowOverride } from "@workspace/db/schema";

// ---------------------------------------------------------------------------
// Unit tests for the pure Goals-table transforms (Task #260): filter matching,
// override merge + defaults, and the four Final-goal formulas. These pin the
// math/merge without the Sheets / Databricks / DB dependencies.
// ---------------------------------------------------------------------------

const rep = (over: Partial<{ slm: string | null; flm: string | null; name: string; region: string }> = {}) => ({
  slm: "Sue SLM",
  flm: "Frank FLM",
  name: "Rep One",
  region: "West",
  ...over,
});

test("repPassesFilter: no narrowing filters → always passes", () => {
  assert.equal(repPassesFilter(rep(), { month: "2026-06" }), true);
});

test("repPassesFilter: slm/flm match case-insensitively and exclude non-matches", () => {
  assert.equal(repPassesFilter(rep(), { month: "2026-06", slm: "sue slm" }), true);
  assert.equal(repPassesFilter(rep(), { month: "2026-06", slm: "Other SLM" }), false);
  assert.equal(repPassesFilter(rep(), { month: "2026-06", flm: " frank flm " }), true);
  assert.equal(repPassesFilter(rep(), { month: "2026-06", flm: "Nope" }), false);
});

test("repPassesFilter: empty-string slm/flm are ignored", () => {
  assert.equal(repPassesFilter(rep(), { month: "2026-06", slm: "", flm: "" }), true);
});

test("repPassesFilter: reps and regions are inclusion lists (case-insensitive)", () => {
  assert.equal(repPassesFilter(rep(), { month: "2026-06", reps: ["rep one"] }), true);
  assert.equal(repPassesFilter(rep(), { month: "2026-06", reps: ["Rep Two"] }), false);
  assert.equal(repPassesFilter(rep(), { month: "2026-06", regions: ["west"] }), true);
  assert.equal(repPassesFilter(rep(), { month: "2026-06", regions: ["East"] }), false);
  // empty list is treated as "no filter"
  assert.equal(repPassesFilter(rep(), { month: "2026-06", reps: [] }), true);
});

test("repPassesFilter: null slm/flm only matches when no slm/flm filter", () => {
  assert.equal(repPassesFilter(rep({ slm: null, flm: null }), { month: "2026-06" }), true);
  assert.equal(repPassesFilter(rep({ slm: null }), { month: "2026-06", slm: "Sue SLM" }), false);
});

test("defaultOverrideValues: source financePps, multipliers 1, LOA Unavailable, eRep manual null", () => {
  assert.deepEqual(defaultOverrideValues(), {
    source: "financePps",
    mrrAddedManualMultiplier: 1,
    mrrChurnManualMultiplier: 1,
    loaStatus: "Unavailable",
    // Manual eRep override defaults to null (NULL = use the Databricks value).
    eRepManualMultiplier: null,
  });
});

test("mergeOverrideValues: undefined row → defaults", () => {
  assert.deepEqual(mergeOverrideValues(undefined), defaultOverrideValues());
});

test("mergeOverrideValues: persisted row values win; bad source falls back", () => {
  const base: GoalRowOverride = {
    monthYyyymm: "2026-06",
    rep: "Rep One",
    product: "Showcase",
    source: "goalCsv",
    mrrAddedManualMultiplier: 1.5,
    mrrChurnManualMultiplier: 0.5,
    loaStatus: "On LOA",
    eRepMultiplier: 0.8,
    updatedAt: new Date(),
    updatedByName: null,
    updatedByRole: null,
  };
  assert.deepEqual(mergeOverrideValues(base), {
    source: "goalCsv",
    mrrAddedManualMultiplier: 1.5,
    mrrChurnManualMultiplier: 0.5,
    loaStatus: "On LOA",
    eRepManualMultiplier: 0.8,
  });
  // An invalid stored source defaults back to financePps.
  assert.equal(mergeOverrideValues({ ...base, source: "bogus" }).source, "financePps");
  // A NULL stored eRep means "no manual override" → use the Databricks value.
  assert.equal(mergeOverrideValues({ ...base, eRepMultiplier: null }).eRepManualMultiplier, null);
});

test("resolveEffectiveERep: manual wins, else Databricks, else 1.0", () => {
  assert.equal(resolveEffectiveERep(0.5, 1.3), 0.5);
  assert.equal(resolveEffectiveERep(null, 1.3), 1.3);
  assert.equal(resolveEffectiveERep(null, null), 1);
  // An explicit manual 0 is honored (not treated as "use Databricks").
  assert.equal(resolveEffectiveERep(0, 1.3), 0);
});

test("computeFinalGoals: applies the four formulas", () => {
  const base = { mrrAddedGoal: 1000, mrrChurnGoal: 200, mrrAddedMinimum: 800, mrrChurnMaximum: 300 };
  const ov = {
    source: "financePps" as const,
    mrrAddedManualMultiplier: 2,
    mrrChurnManualMultiplier: 3,
    loaStatus: "Unavailable",
    eRepMultiplier: 0.5,
  };
  assert.deepEqual(computeFinalGoals(base, ov), {
    finalMrrAddedGoal: 2 * 0.5 * 1000, // 1000
    finalChurnGoal: 3 * 0.5 * 200, // 300
    finalMrrMinGoal: 0.5 * 800, // 400
    finalChurnMaxGoal: 0.5 * 300, // 150
  });
});

test("computeFinalGoals: identity multipliers pass base through", () => {
  const base = { mrrAddedGoal: 42, mrrChurnGoal: 7, mrrAddedMinimum: 9, mrrChurnMaximum: 11 };
  // Effective eRep of a default row (no manual, no Databricks) is the neutral 1.0.
  const final = computeFinalGoals(base, {
    mrrAddedManualMultiplier: 1,
    mrrChurnManualMultiplier: 1,
    eRepMultiplier: resolveEffectiveERep(defaultOverrideValues().eRepManualMultiplier, null),
  });
  assert.deepEqual(final, {
    finalMrrAddedGoal: 42,
    finalChurnGoal: 7,
    finalMrrMinGoal: 9,
    finalChurnMaxGoal: 11,
  });
});

test("isGoalSourceId guards the valid ids", () => {
  assert.equal(isGoalSourceId("financePps"), true);
  assert.equal(isGoalSourceId("goalCsv"), true);
  assert.equal(isGoalSourceId("softwareGnr"), true);
  assert.equal(isGoalSourceId("softwareAcq"), true);
  assert.equal(isGoalSourceId("nope"), false);
  assert.equal(isGoalSourceId(undefined), false);
});

test("canonicalMonth normalizes valid inputs and rejects junk", () => {
  // Already-canonical key is preserved.
  assert.equal(canonicalMonth("2026-06"), "2026-06");
  // A full date collapses to its YYYY-MM so writes match table reads.
  assert.equal(canonicalMonth("2026-06-15"), "2026-06");
  // Invalid inputs return null so routes can 400 instead of persisting junk.
  assert.equal(canonicalMonth("not-a-month"), null);
  assert.equal(canonicalMonth(""), null);
});

test("overrideKey is stable and distinct per (month, rep, product)", () => {
  assert.equal(overrideKey("2026-06", "Rep One", "Showcase"), overrideKey("2026-06", "Rep One", "Showcase"));
  assert.notEqual(overrideKey("2026-06", "Rep One", "Showcase"), overrideKey("2026-06", "Rep One", "MBP"));
});

// ---------------------------------------------------------------------------
// Task #279: team-size split. Team-level goals (Goal CSV, and Software % Rules
// whose sub-source is the Goal CSV) are divided evenly across the distinct reps
// sharing a Channel + Region + Segment, BEFORE the manual/eRep multipliers.
// ---------------------------------------------------------------------------

test("teamKeyFor: normalizes case/whitespace; product is not part of the key", () => {
  assert.equal(teamKeyFor("GnR", "West", "SMB"), teamKeyFor(" gnr ", "WEST", "smb"));
  assert.notEqual(teamKeyFor("GnR", "West", "SMB"), teamKeyFor("GnR", "East", "SMB"));
});

test("computeTeamSizes: counts distinct reps per (group, region, segment)", () => {
  const sizes = computeTeamSizes([
    { name: "Alice", group: "GnR", region: "West", segment: "SMB" },
    { name: "Bob", group: "GnR", region: "West", segment: "SMB" },
    { name: "Cara", group: "GnR", region: "East", segment: "SMB" },
    // Duplicate name in the same team is counted once.
    { name: "Alice", group: "GnR", region: "West", segment: "SMB" },
  ]);
  assert.equal(sizes.get(teamKeyFor("GnR", "West", "SMB")), 2);
  assert.equal(sizes.get(teamKeyFor("GnR", "East", "SMB")), 1);
});

test("sourceDividesByTeam: goalCsv always; each software set only when its own sub-source is goalCsv", () => {
  assert.equal(sourceDividesByTeam("goalCsv", {}), true);
  assert.equal(sourceDividesByTeam("financePps", {}), false);
  assert.equal(sourceDividesByTeam("softwareGnr", { softwareGnr: "goalCsv" }), true);
  assert.equal(sourceDividesByTeam("softwareGnr", { softwareGnr: "financePps" }), false);
  assert.equal(sourceDividesByTeam("softwareGnr", {}), false);
  // Each set is independent: an ACQ goalCsv sub-source must not divide GNR.
  assert.equal(sourceDividesByTeam("softwareGnr", { softwareAcq: "goalCsv" }), false);
  assert.equal(sourceDividesByTeam("softwareAcq", { softwareAcq: "goalCsv" }), true);
  assert.equal(sourceDividesByTeam("softwareAcq", { softwareAcq: "financePps" }), false);
  assert.equal(sourceDividesByTeam("softwareAcq", {}), false);
});

test("applyTeamSplit: divides every metric by team size", () => {
  const base = { mrrAddedGoal: 1000, mrrChurnGoal: 200, mrrAddedMinimum: 800, mrrChurnMaximum: 300 };
  assert.deepEqual(applyTeamSplit(base, 4), {
    mrrAddedGoal: 250,
    mrrChurnGoal: 50,
    mrrAddedMinimum: 200,
    mrrChurnMaximum: 75,
  });
});

test("applyTeamSplit: team size 0 or 1 leaves the base untouched", () => {
  const base = { mrrAddedGoal: 1000, mrrChurnGoal: 200, mrrAddedMinimum: 800, mrrChurnMaximum: 300 };
  assert.deepEqual(applyTeamSplit(base, 0), base);
  assert.deepEqual(applyTeamSplit(base, 1), base);
});

test("split then computeFinalGoals: division happens before the multipliers", () => {
  const base = { mrrAddedGoal: 1000, mrrChurnGoal: 200, mrrAddedMinimum: 800, mrrChurnMaximum: 300 };
  const ov = {
    source: "goalCsv" as const,
    mrrAddedManualMultiplier: 2,
    mrrChurnManualMultiplier: 3,
    loaStatus: "Unavailable",
    eRepMultiplier: 0.5,
  };
  const final = computeFinalGoals(applyTeamSplit(base, 4), ov);
  assert.deepEqual(final, {
    finalMrrAddedGoal: 2 * 0.5 * 250, // 250
    finalChurnGoal: 3 * 0.5 * 50, // 75
    finalMrrMinGoal: 0.5 * 200, // 100
    finalChurnMaxGoal: 0.5 * 75, // 37.5
  });
});
