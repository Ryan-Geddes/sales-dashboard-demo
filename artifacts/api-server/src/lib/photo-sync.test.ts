import { test } from "node:test";
import assert from "node:assert/strict";
import {
  honoluluDayOfWeek,
  collectAllSlmNames,
  computeEnabledReps,
  filterOppsToReset,
} from "./photo-sync";

// honoluluDayOfWeek: must report HST day-of-week regardless of host TZ.

test("honoluluDayOfWeek: midnight HST Sunday → 0", () => {
  assert.equal(honoluluDayOfWeek(new Date("2026-05-03T10:00:00Z")), 0);
});

test("honoluluDayOfWeek: 23:59 HST Sunday → 0", () => {
  assert.equal(honoluluDayOfWeek(new Date("2026-05-04T09:59:00Z")), 0);
});

test("honoluluDayOfWeek: midnight HST Monday → 1", () => {
  assert.equal(honoluluDayOfWeek(new Date("2026-05-04T10:00:00Z")), 1);
});

test("honoluluDayOfWeek: Saturday afternoon HST → 6", () => {
  assert.equal(honoluluDayOfWeek(new Date("2026-05-03T00:00:00Z")), 6);
});

test("honoluluDayOfWeek: UTC-Monday-but-still-HST-Sunday → 0", () => {
  assert.equal(honoluluDayOfWeek(new Date("2026-05-04T08:00:00Z")), 0);
});

test("honoluluDayOfWeek: full Sun..Sat sweep at 12:00 HST", () => {
  const cases: Array<[string, number]> = [
    ["2026-05-03T22:00:00Z", 0],
    ["2026-05-04T22:00:00Z", 1],
    ["2026-05-05T22:00:00Z", 2],
    ["2026-05-06T22:00:00Z", 3],
    ["2026-05-07T22:00:00Z", 4],
    ["2026-05-08T22:00:00Z", 5],
    ["2026-05-09T22:00:00Z", 6],
  ];
  for (const [utc, dow] of cases) {
    assert.equal(honoluluDayOfWeek(new Date(utc)), dow);
  }
});

// Sunday-reset filter helpers.

const hierarchy: Record<string, string> = {
  "Rep A": "Sandra SLM",
  "Rep B": "Sandra SLM",
  "Rep C": "Frank SLM",
  "Rep D": "Frank SLM",
  "Rep E": "",
};

test("collectAllSlmNames: dedupes and skips empty", () => {
  const names = collectAllSlmNames(hierarchy);
  assert.equal(names.size, 2);
  assert.ok(names.has("Sandra SLM"));
  assert.ok(names.has("Frank SLM"));
});

test("computeEnabledReps: unset pref defaults to opt-in", () => {
  const all = collectAllSlmNames(hierarchy);
  const { enabledSlms, enabledReps, optedOutSlms } = computeEnabledReps(hierarchy, all, []);
  assert.equal(optedOutSlms.size, 0);
  assert.equal(enabledSlms.size, 2);
  assert.equal(enabledReps.size, 4);
  assert.ok(!enabledReps.has("Rep E"));
});

test("computeEnabledReps: strict false opts out", () => {
  const all = collectAllSlmNames(hierarchy);
  const { enabledReps, optedOutSlms } = computeEnabledReps(hierarchy, all, [
    { hierarchyName: "Sandra SLM", value: false },
    { hierarchyName: "Frank SLM", value: true },
  ]);
  assert.deepEqual([...optedOutSlms], ["Sandra SLM"]);
  assert.ok(!enabledReps.has("Rep A"));
  assert.ok(enabledReps.has("Rep C"));
});

test("computeEnabledReps: non-boolean values do not opt out", () => {
  const all = collectAllSlmNames(hierarchy);
  const { optedOutSlms } = computeEnabledReps(hierarchy, all, [
    { hierarchyName: "Sandra SLM", value: 0 },
    { hierarchyName: "Frank SLM", value: null },
    { hierarchyName: "Sandra SLM", value: "false" },
  ]);
  assert.equal(optedOutSlms.size, 0);
});

test("computeEnabledReps: every SLM out → no enabled reps", () => {
  const all = collectAllSlmNames(hierarchy);
  const { enabledReps } = computeEnabledReps(hierarchy, all, [
    { hierarchyName: "Sandra SLM", value: false },
    { hierarchyName: "Frank SLM", value: false },
  ]);
  assert.equal(enabledReps.size, 0);
});

test("filterOppsToReset: orphan opps are skipped", () => {
  const result = filterOppsToReset(
    ["OPP-1", "OPP-2", "OPP-3"],
    { "OPP-1": "Rep A", "OPP-2": "Rep C" },
    new Set(["Rep A", "Rep B", "Rep C", "Rep D"]),
  );
  assert.deepEqual(result.oppIdsToReset.sort(), ["OPP-1", "OPP-2"]);
  assert.equal(result.orphanCount, 1);
  assert.equal(result.optedOutOppCount, 0);
});

test("filterOppsToReset: opted-out reps are skipped", () => {
  const result = filterOppsToReset(
    ["OPP-1", "OPP-2", "OPP-3", "OPP-4"],
    { "OPP-1": "Rep A", "OPP-2": "Rep C", "OPP-3": "Rep D", "OPP-4": "Rep B" },
    new Set(["Rep A", "Rep B"]),
  );
  assert.deepEqual(result.oppIdsToReset.sort(), ["OPP-1", "OPP-4"]);
  assert.equal(result.optedOutOppCount, 2);
  assert.equal(result.orphanCount, 0);
});

test("filterOppsToReset: mixed opted-out + orphan", () => {
  const all = collectAllSlmNames(hierarchy);
  const { enabledReps } = computeEnabledReps(hierarchy, all, [
    { hierarchyName: "Frank SLM", value: false },
  ]);
  const result = filterOppsToReset(
    ["OPP-A", "OPP-B", "OPP-C", "OPP-D", "OPP-E", "OPP-F"],
    {
      "OPP-A": "Rep A",
      "OPP-B": "Rep B",
      "OPP-C": "Rep C",
      "OPP-D": "Rep D",
      "OPP-E": "Rep E",
    },
    enabledReps,
  );
  assert.deepEqual(result.oppIdsToReset.sort(), ["OPP-A", "OPP-B"]);
  assert.equal(result.optedOutOppCount, 3);
  assert.equal(result.orphanCount, 1);
});

test("filterOppsToReset: empty input", () => {
  const result = filterOppsToReset([], {}, new Set());
  assert.deepEqual(result.oppIdsToReset, []);
  assert.equal(result.orphanCount, 0);
  assert.equal(result.optedOutOppCount, 0);
});
