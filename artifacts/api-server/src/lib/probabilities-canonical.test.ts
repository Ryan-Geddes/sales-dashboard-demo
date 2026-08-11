import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __setOverrideLoaderForTesting,
  invalidateProbabilityCaches,
  getOppOverrideEntries,
  getOppReviewedMap,
} from "./probabilities";

const ID15 = "006Do00000ClgHh";
const ID18 = "006Do00000ClgHhIAJ";

test("override stored under a legacy 15-char id surfaces under its 18-char key", async () => {
  invalidateProbabilityCaches();
  __setOverrideLoaderForTesting(async () => [
    { oppId: ID15, probability: 42, reviewedAt: new Date("2026-06-01") },
  ]);
  try {
    const entries = await getOppOverrideEntries();
    assert.equal(entries[ID18]?.probability, 42);
    assert.equal(entries[ID15], undefined); // collapsed onto canonical key
    const reviewed = await getOppReviewedMap();
    assert.equal(reviewed[ID18], true);
  } finally {
    __setOverrideLoaderForTesting(null);
    invalidateProbabilityCaches();
  }
});

test("a 15-char and 18-char row for the same opp merge, preferring the reviewed one", async () => {
  invalidateProbabilityCaches();
  __setOverrideLoaderForTesting(async () => [
    { oppId: ID15, probability: 10, reviewedAt: null },
    { oppId: ID18, probability: 90, reviewedAt: new Date("2026-06-10") },
  ]);
  try {
    const entries = await getOppOverrideEntries();
    // Only the canonical key, and the reviewed (90) entry wins over the
    // unreviewed legacy (10) one.
    assert.equal(Object.keys(entries).length, 1);
    assert.equal(entries[ID18]?.probability, 90);
    assert.equal(entries[ID18]?.reviewedAt instanceof Date, true);
  } finally {
    __setOverrideLoaderForTesting(null);
    invalidateProbabilityCaches();
  }
});

test("synthetic / composite keys are never rewritten", async () => {
  invalidateProbabilityCaches();
  const modKey = "mod:c1|2026-01-01|10|Showcase";
  __setOverrideLoaderForTesting(async () => [
    { oppId: modKey, probability: 25, reviewedAt: null },
  ]);
  try {
    const entries = await getOppOverrideEntries();
    assert.equal(entries[modKey]?.probability, 25);
  } finally {
    __setOverrideLoaderForTesting(null);
    invalidateProbabilityCaches();
  }
});
