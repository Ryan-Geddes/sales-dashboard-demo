import { test } from "node:test";
import assert from "node:assert/strict";
import { headerFiresVerdict } from "./compensationTester";

// Task #394: the paired-rule header badge must ALWAYS be visible, defaulting to
// "incomplete" until the user pastes at least one opp id.

test("headerFiresVerdict: no state at all → incomplete", () => {
  assert.equal(headerFiresVerdict(undefined), "incomplete");
});

test("headerFiresVerdict: all blank ids → incomplete", () => {
  assert.equal(headerFiresVerdict({ oppIds: ["", "  "], result: null }), "incomplete");
});

test("headerFiresVerdict: a diagnosis present → its verdict wins", () => {
  assert.equal(
    headerFiresVerdict({
      oppIds: ["c1", "n1"],
      result: { paired: { fires: "fires" } },
    }),
    "fires",
  );
  assert.equal(
    headerFiresVerdict({
      oppIds: ["c1", ""],
      result: { paired: { fires: "doesNotFire" } },
    }),
    "doesNotFire",
  );
});

test("headerFiresVerdict: ids entered but no diagnosis yet → hidden (undefined)", () => {
  assert.equal(headerFiresVerdict({ oppIds: ["c1", ""], result: null }), undefined);
});
