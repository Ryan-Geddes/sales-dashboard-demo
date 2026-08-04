import { test } from "node:test";
import assert from "node:assert/strict";
import { to18CharId, canonicalizeOppId } from "./sf-id";

// The 18-char form is the 15-char id plus a deterministic 3-char checksum. This
// pair is taken from databricks-fub-first-purchase.test.ts (a real SF id).
test("to18CharId computes the Salesforce checksum suffix", () => {
  assert.equal(to18CharId("006Do00000ClgHh"), "006Do00000ClgHhIAJ");
});

test("to18CharId leaves non-15-char input unchanged", () => {
  assert.equal(to18CharId("006Do00000ClgHhIAJ"), "006Do00000ClgHhIAJ"); // already 18
  assert.equal(to18CharId(""), "");
  assert.equal(to18CharId("short"), "short");
});

test("canonicalizeOppId upgrades a bare 15-char id and trims", () => {
  assert.equal(canonicalizeOppId("006Do00000ClgHh"), "006Do00000ClgHhIAJ");
  assert.equal(canonicalizeOppId("  006Do00000ClgHh  "), "006Do00000ClgHhIAJ");
});

test("canonicalizeOppId passes through 18-char ids", () => {
  assert.equal(canonicalizeOppId("006Do00000ClgHhIAJ"), "006Do00000ClgHhIAJ");
});

test("canonicalizeOppId never rewrites synthetic / composite ids", () => {
  // These are not bare 15-char alphanumeric SF ids, so they must be untouched.
  for (const id of [
    "mod:c1|2026-01-01|10|Showcase",
    "me:opp:foo",
    "mgr_est:bar",
  ]) {
    assert.equal(canonicalizeOppId(id), id);
  }
});

test("canonicalizeOppId returns empty string for nullish input", () => {
  assert.equal(canonicalizeOppId(null), "");
  assert.equal(canonicalizeOppId(undefined), "");
  assert.equal(canonicalizeOppId("   "), "");
});
