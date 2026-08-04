import { test } from "node:test";
import assert from "node:assert/strict";
import { oppProbabilityOverridesTable } from "@workspace/db/schema";
import { getTableColumns } from "drizzle-orm";

test("opp_probability_overrides has nullable reviewed_at column", () => {
  const cols = getTableColumns(oppProbabilityOverridesTable);
  assert.ok(cols.reviewedAt);
  assert.equal(cols.reviewedAt.name, "reviewed_at");
  assert.equal(cols.reviewedAt.notNull, false);
});

test("opp_probability_overrides preserves probability NOT NULL", () => {
  const cols = getTableColumns(oppProbabilityOverridesTable);
  assert.ok(cols.oppId);
  assert.ok(cols.probability);
  assert.ok(cols.updatedAt);
  assert.equal(cols.probability.notNull, true);
});
