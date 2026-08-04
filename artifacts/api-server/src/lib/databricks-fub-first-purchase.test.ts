import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFubFirstPurchaseIndex,
  lookupFubFirstPurchase,
  type RawFubFirstPurchase,
} from "./databricks-fub-first-purchase";

// Databricks stores the 18-char Salesforce id; the Pipeline sheet often carries
// the 15-char form. The join must resolve across both, or FUB-only fields stay
// blank and date comparatives on them never fire.
const rows: RawFubFirstPurchase[] = [
  {
    opportunityId: "006Do00000ClgHhIAJ",
    fubFirstPurchaseDate: "2019-04-22",
    fubFirstPurchaseOppId: "006Do00000FfwSCIAZ",
  },
];

test("lookup resolves a 15-char Pipeline opp id against an 18-char Databricks id", () => {
  const idx = buildFubFirstPurchaseIndex(rows);
  const hit = lookupFubFirstPurchase(idx, "006Do00000ClgHh");
  assert.equal(hit?.fubFirstPurchaseDate, "2019-04-22");
});

test("lookup resolves the full 18-char opp id", () => {
  const idx = buildFubFirstPurchaseIndex(rows);
  const hit = lookupFubFirstPurchase(idx, "006Do00000ClgHhIAJ");
  assert.equal(hit?.fubFirstPurchaseDate, "2019-04-22");
});

test("lookup tolerates surrounding whitespace", () => {
  const idx = buildFubFirstPurchaseIndex(rows);
  assert.equal(
    lookupFubFirstPurchase(idx, "  006Do00000ClgHh  ")?.fubFirstPurchaseDate,
    "2019-04-22",
  );
});

test("lookup returns undefined for an unknown id and for blank input", () => {
  const idx = buildFubFirstPurchaseIndex(rows);
  assert.equal(lookupFubFirstPurchase(idx, "006Do00000Unknown"), undefined);
  assert.equal(lookupFubFirstPurchase(idx, ""), undefined);
  assert.equal(lookupFubFirstPurchase(idx, undefined), undefined);
});

test("malformed long ids (not 18-char) get no prefix fallback", () => {
  // A 19-char junk id must not silently match the real opp via a 15-char prefix.
  const idx = buildFubFirstPurchaseIndex(rows);
  assert.equal(lookupFubFirstPurchase(idx, "006Do00000ClgHhIAJX"), undefined);
  assert.equal(lookupFubFirstPurchase(idx, "006Do00000ClgHhI"), undefined);
});

test("a genuine 15-char id key does not get clobbered by an 18-char prefix", () => {
  // Exact 15-char rows take precedence over a longer row's derived prefix.
  const mixed: RawFubFirstPurchase[] = [
    { opportunityId: "006Do00000ClgHh", fubFirstPurchaseDate: "2020-01-01", fubFirstPurchaseOppId: "" },
    { opportunityId: "006Do00000ClgHhIAJ", fubFirstPurchaseDate: "2019-04-22", fubFirstPurchaseOppId: "" },
  ];
  const idx = buildFubFirstPurchaseIndex(mixed);
  assert.equal(lookupFubFirstPurchase(idx, "006Do00000ClgHh")?.fubFirstPurchaseDate, "2020-01-01");
});
