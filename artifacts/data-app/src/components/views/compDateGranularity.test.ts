import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompPairedCondition } from "@workspace/api-client-react";
import {
  isCompDateField,
  compDateGranularityValue,
  compDateGranularityPatch,
  showCompDateGranularity,
  compDateGranularityControl,
} from "./compDateGranularity";

// Task #422 — the two month/exact dropdowns on the comparative-identity card are
// slaved to one shared `dateGranularity` value: whenever both render they show
// the same value, the same disabled state, and edits from either side emit the
// same patch. Each dropdown only appears next to a date-typed field. These tests
// pin both the sync guarantee and the per-side visibility rule.

const cond = (
  patch: Partial<CompPairedCondition> = {},
): CompPairedCondition =>
  ({
    kind: "comparative",
    field: "closeDate",
    op: "eq",
    compareToOpp: "fub",
    compareToField: "closeDate",
    ...patch,
  }) as CompPairedCondition;

test("editing either side produces the SAME shared-value patch", () => {
  // The patch is side-agnostic: whichever dropdown the user changes, the patch
  // it emits is identical, so both controls always edit one value.
  const fromLeft = compDateGranularityPatch("exact");
  const fromRight = compDateGranularityPatch("exact");
  assert.deepEqual(fromLeft, { dateGranularity: "exact" });
  assert.deepEqual(fromLeft, fromRight);

  assert.deepEqual(compDateGranularityPatch("month"), {
    dateGranularity: "month",
  });
});

test("both dropdowns read the same value (defaulting to month)", () => {
  assert.equal(compDateGranularityValue(cond()), "month");
  assert.equal(
    compDateGranularityValue(cond({ dateGranularity: undefined })),
    "month",
  );
  assert.equal(
    compDateGranularityValue(cond({ dateGranularity: "exact" })),
    "exact",
  );
});

test("left and right controls share value + disabled — they stay in sync", () => {
  // For a date-vs-date comparison both dropdowns render, and their value and
  // disabled state are sourced from the shared helpers (no per-side value), so
  // they can never display differing granularities.
  const c = cond({
    field: "closeDate",
    compareToField: "closeDate",
    dateGranularity: "exact",
  });
  const left = compDateGranularityControl(c, "left", true);
  const right = compDateGranularityControl(c, "right", true);
  assert.equal(left.visible, true);
  assert.equal(right.visible, true);
  assert.equal(left.value, right.value);
  assert.equal(left.value, "exact");
  assert.equal(left.disabled, right.disabled);
});

test("each dropdown appears only when ITS OWN side is a date field", () => {
  // Left side gated by `field`, right side gated by `compareToField`.
  const dateVsDate = cond({ field: "closeDate", compareToField: "closeDate" });
  assert.equal(showCompDateGranularity(dateVsDate, "left"), true);
  assert.equal(showCompDateGranularity(dateVsDate, "right"), true);

  // FUB first-purchase-date is also a date type.
  const fubVsFub = cond({
    field: "fub_first_purchase_date",
    compareToField: "fub_first_purchase_date",
  });
  assert.equal(showCompDateGranularity(fubVsFub, "left"), true);
  assert.equal(showCompDateGranularity(fubVsFub, "right"), true);

  // Only the left side is a date → only the left dropdown shows.
  const leftOnly = cond({ field: "closeDate", compareToField: "accountId" });
  assert.equal(showCompDateGranularity(leftOnly, "left"), true);
  assert.equal(showCompDateGranularity(leftOnly, "right"), false);

  // Only the right side is a date → only the right dropdown shows.
  const rightOnly = cond({ field: "accountId", compareToField: "closeDate" });
  assert.equal(showCompDateGranularity(rightOnly, "left"), false);
  assert.equal(showCompDateGranularity(rightOnly, "right"), true);

  // Neither side a date → both hidden.
  const neither = cond({ field: "accountId", compareToField: "contactId" });
  assert.equal(showCompDateGranularity(neither, "left"), false);
  assert.equal(showCompDateGranularity(neither, "right"), false);
});

test("control.visible mirrors showCompDateGranularity per side", () => {
  const leftOnly = cond({ field: "closeDate", compareToField: "accountId" });
  assert.equal(compDateGranularityControl(leftOnly, "left", true).visible, true);
  assert.equal(
    compDateGranularityControl(leftOnly, "right", true).visible,
    false,
  );

  const neither = cond({ field: "accountId", compareToField: "contactId" });
  assert.equal(compDateGranularityControl(neither, "left", true).visible, false);
  assert.equal(
    compDateGranularityControl(neither, "right", true).visible,
    false,
  );
});

test("canEdit=false disables both dropdowns", () => {
  const c = cond({ field: "closeDate", compareToField: "closeDate" });
  assert.equal(compDateGranularityControl(c, "left", false).disabled, true);
  assert.equal(compDateGranularityControl(c, "right", false).disabled, true);
  assert.equal(compDateGranularityControl(c, "left", true).disabled, false);
  assert.equal(compDateGranularityControl(c, "right", true).disabled, false);
});

test("isCompDateField recognises only the date identity fields", () => {
  assert.equal(isCompDateField("closeDate"), true);
  assert.equal(isCompDateField("fub_first_purchase_date"), true);
  assert.equal(isCompDateField("accountId"), false);
  assert.equal(isCompDateField("product"), false);
  assert.equal(isCompDateField(undefined), false);
  assert.equal(isCompDateField(null), false);
});
