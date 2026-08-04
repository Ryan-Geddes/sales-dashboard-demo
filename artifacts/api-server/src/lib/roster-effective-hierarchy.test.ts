import { test } from "node:test";
import assert from "node:assert/strict";
import type { RosterOverride } from "@workspace/db/schema";

// sheets-data reads the hierarchy root from the VP_NAME env var at module load,
// so pin a fixture value BEFORE importing it. Keeps the suite hermetic on a
// fresh clone (and independent of whatever the real deployment is rooted at).
process.env.VP_NAME = "Vera VP";

const { parseActiveFlag, assembleHierarchy, buildEffectiveHierarchy } =
  await import("./sheets-data");

// ---------------------------------------------------------------------------
// Task #319 — Active column + per-month roster overrides (effective hierarchy).
//
// These tests pin the pure core that every month-scoped path resolves through:
//   - parseActiveFlag: how the sheet `Active` cell becomes a boolean.
//   - buildEffectiveHierarchy: applies a month's overrides to the BASE
//     hierarchy, dropping inactive people and re-rolling reassignments. This is
//     the input quota / aggregation / drilldowns all derive from, so getting
//     the membership + roll-up right is what makes inactive-hiding and
//     reassignment correct everywhere.
// ---------------------------------------------------------------------------

// Stands in for VP_NAME in sheets-data.ts (which is env-driven). These tests
// only exercise the pure hierarchy assembly, so any consistent root works.
const VP = "Vera VP";

// A small but representative org:
//   Sam SLM
//     Fred FLM
//       Rita Rep, Roy Rep, Ina Inactive (active=FALSE in the sheet)
//     Frank FLM
//       Rich Rep
//   Sue SLM (no reports of her own — a reassignment target)
function makeBase() {
  const personToManager: Record<string, string> = {
    "Sam SLM": VP,
    "Sue SLM": VP,
    "Fred FLM": "Sam SLM",
    "Frank FLM": "Sam SLM",
    "Rita Rep": "Fred FLM",
    "Roy Rep": "Fred FLM",
    "Ina Inactive": "Fred FLM",
    "Rich Rep": "Frank FLM",
  };
  const reps = ["Rita Rep", "Roy Rep", "Ina Inactive", "Rich Rep"];
  const personToRegion: Record<string, string> = {};
  const personToSalesRole: Record<string, string> = {};
  const personToSegment: Record<string, string> = {};
  const personToGroup: Record<string, string> = {};
  for (const r of reps) {
    personToRegion[r] = "West";
    personToSalesRole[r] = "Advisor"; // → G&R group
    personToSegment[r] = "SMB";
  }
  const personToActive: Record<string, boolean> = {
    "Sam SLM": true,
    "Sue SLM": true,
    "Fred FLM": true,
    "Frank FLM": true,
    "Rita Rep": true,
    "Roy Rep": true,
    "Ina Inactive": false,
    "Rich Rep": true,
  };
  return assembleHierarchy({
    personToManager,
    personToRegion,
    personToGroup,
    personToSalesRole,
    personToSegment,
    personToEmail: {},
    personToEmployeeId: {},
    personToActive,
  });
}

function ov(partial: Partial<RosterOverride> & { person: string }): RosterOverride {
  return {
    monthYyyymm: "2026-06",
    // Test people carry no email/employeeId, so their durable identity key is
    // the name-fallback form (`name:<person>`), matching personIdentityKey.
    identityKey: partial.identityKey ?? `name:${partial.person}`,
    person: partial.person,
    active: partial.active ?? null,
    flm: partial.flm ?? null,
    slm: partial.slm ?? null,
    region: partial.region ?? null,
    segment: partial.segment ?? null,
    salesRole: partial.salesRole ?? null,
    updatedAt: new Date(),
    updatedByName: null,
    updatedByRole: null,
  };
}

// Overrides are keyed by durable person identity (see personIdentityKey).
function overrideMap(...rows: RosterOverride[]): Map<string, RosterOverride> {
  const m = new Map<string, RosterOverride>();
  for (const r of rows) m.set(r.identityKey, r);
  return m;
}

// --- parseActiveFlag --------------------------------------------------------

test("parseActiveFlag: blank/missing defaults to active", () => {
  assert.equal(parseActiveFlag(undefined), true);
  assert.equal(parseActiveFlag(""), true);
  assert.equal(parseActiveFlag("   "), true);
});

test("parseActiveFlag: TRUE-ish values are active", () => {
  for (const v of ["TRUE", "true", "True", "yes", "Y", "1", "active"]) {
    assert.equal(parseActiveFlag(v), true, `expected ${v} → active`);
  }
});

test("parseActiveFlag: FALSE-ish values are inactive", () => {
  for (const v of ["FALSE", "false", "No", "n", "0", "inactive", "  FALSE  "]) {
    assert.equal(parseActiveFlag(v), false, `expected ${v} → inactive`);
  }
});

// --- default exclusion ------------------------------------------------------

test("base hierarchy retains inactive people; effective drops them by default", () => {
  const base = makeBase();
  // Base keeps everyone, flagged.
  assert.ok(base.allReps.has("Ina Inactive"));
  assert.equal(base.personToActive["Ina Inactive"], false);

  const eff = buildEffectiveHierarchy(base, overrideMap());
  // Inactive rep is gone from every list / lookup.
  assert.ok(!eff.allReps.has("Ina Inactive"));
  assert.equal(eff.repToFlm["Ina Inactive"], undefined);
  assert.ok(!eff.flmToReps["Fred FLM"].includes("Ina Inactive"));
  assert.ok(!eff.people.some((p) => p.name === "Ina Inactive"));
  // Active reps remain.
  assert.ok(eff.allReps.has("Rita Rep"));
  assert.ok(eff.flmToReps["Fred FLM"].includes("Rita Rep"));
});

// --- active override re-include / exclude -----------------------------------

test("active=true override re-includes an inactive person for the month", () => {
  const base = makeBase();
  const eff = buildEffectiveHierarchy(
    base,
    overrideMap(ov({ person: "Ina Inactive", active: true })),
  );
  assert.ok(eff.allReps.has("Ina Inactive"));
  assert.equal(eff.repToFlm["Ina Inactive"], "Fred FLM");
  assert.equal(eff.repToSlm["Ina Inactive"], "Sam SLM");
  assert.ok(eff.flmToReps["Fred FLM"].includes("Ina Inactive"));
});

test("active=false override hides an otherwise-active person for the month", () => {
  const base = makeBase();
  const eff = buildEffectiveHierarchy(
    base,
    overrideMap(ov({ person: "Rita Rep", active: false })),
  );
  assert.ok(!eff.allReps.has("Rita Rep"));
  assert.ok(!eff.flmToReps["Fred FLM"].includes("Rita Rep"));
  // Sibling unaffected.
  assert.ok(eff.allReps.has("Roy Rep"));
});

// --- FLM / SLM reassignment re-roll -----------------------------------------

test("FLM override re-rolls a rep under the new FLM and that FLM's SLM", () => {
  const base = makeBase();
  const eff = buildEffectiveHierarchy(
    base,
    overrideMap(ov({ person: "Rita Rep", flm: "Frank FLM" })),
  );
  assert.equal(eff.repToFlm["Rita Rep"], "Frank FLM");
  assert.equal(eff.repToSlm["Rita Rep"], "Sam SLM"); // Frank reports to Sam
  assert.ok(eff.flmToReps["Frank FLM"].includes("Rita Rep"));
  assert.ok(!eff.flmToReps["Fred FLM"].includes("Rita Rep"));
});

test("SLM override on an FLM moves the whole sub-tree under the new SLM", () => {
  const base = makeBase();
  const eff = buildEffectiveHierarchy(
    base,
    overrideMap(ov({ person: "Fred FLM", slm: "Sue SLM" })),
  );
  assert.ok((eff.slmToFlms["Sue SLM"] ?? []).includes("Fred FLM"));
  assert.ok(!(eff.slmToFlms["Sam SLM"] ?? []).includes("Fred FLM"));
  // Fred's reps roll up to Sue now.
  assert.equal(eff.repToSlm["Rita Rep"], "Sue SLM");
  assert.equal(eff.repToFlm["Rita Rep"], "Fred FLM");
});

test("rep-only SLM override keeps the FLM but rolls the rep to the chosen SLM", () => {
  const base = makeBase();
  const eff = buildEffectiveHierarchy(
    base,
    overrideMap(ov({ person: "Rich Rep", slm: "Sue SLM" })),
  );
  assert.equal(eff.repToFlm["Rich Rep"], "Frank FLM"); // FLM unchanged
  assert.equal(eff.repToSlm["Rich Rep"], "Sue SLM"); // re-pointed SLM
});

// --- attribute overrides ----------------------------------------------------

test("region / segment / salesRole overrides apply; group re-derives from role", () => {
  const base = makeBase();
  const eff = buildEffectiveHierarchy(
    base,
    overrideMap(
      ov({
        person: "Roy Rep",
        region: "East",
        segment: "Enterprise",
        salesRole: "ASA Acquisition Sales", // → Acquisitions group
      }),
    ),
  );
  assert.equal(eff.repToRegion["Roy Rep"], "East");
  assert.equal(eff.repToSegment["Roy Rep"], "Enterprise");
  assert.equal(eff.repToSalesRole["Roy Rep"], "ASA Acquisition Sales");
  assert.equal(eff.repToGroup["Roy Rep"], "Acquisitions");
  // Untouched rep keeps base attributes / group.
  assert.equal(eff.repToRegion["Rita Rep"], "West");
  assert.equal(eff.repToGroup["Rita Rep"], "G&R");
});

// --- durable identity keying ------------------------------------------------

test("override keyed by email identity applies even if the display name changed", () => {
  // A rep whose feeder row carries an email. Their durable identity is the
  // email, so an override stored under `email:<addr>` must still apply even
  // though the override's stored display name is stale ("Old Name").
  const personToManager: Record<string, string> = {
    "Sam SLM": VP,
    "Fred FLM": "Sam SLM",
    "Renee Rep": "Fred FLM",
  };
  const base = assembleHierarchy({
    personToManager,
    personToRegion: { "Renee Rep": "West" },
    personToGroup: {},
    personToSalesRole: { "Renee Rep": "Advisor" },
    personToSegment: { "Renee Rep": "SMB" },
    personToEmail: { "Renee Rep": "Renee@Example.com" },
    personToEmployeeId: {},
    personToActive: { "Sam SLM": true, "Fred FLM": true, "Renee Rep": true },
  });

  const overrides = new Map<string, RosterOverride>();
  overrides.set(
    "email:renee@example.com",
    ov({ person: "Old Name", identityKey: "email:renee@example.com", region: "East" }),
  );

  const eff = buildEffectiveHierarchy(base, overrides);
  assert.equal(eff.repToRegion["Renee Rep"], "East");
});

// --- month isolation (per-override-set independence) -------------------------

test("each override set produces an independent effective hierarchy", () => {
  const base = makeBase();
  // Empty set ⇒ exactly the base's active membership (default exclusion only).
  const empty = buildEffectiveHierarchy(base, overrideMap());
  assert.ok(!empty.allReps.has("Ina Inactive"));
  assert.ok(empty.allReps.has("Rita Rep"));

  // A different set re-includes Ina and hides Rita — and must NOT bleed back
  // into the empty-set result computed above (no shared mutable state).
  const other = buildEffectiveHierarchy(
    base,
    overrideMap(
      ov({ person: "Ina Inactive", active: true }),
      ov({ person: "Rita Rep", active: false }),
    ),
  );
  assert.ok(other.allReps.has("Ina Inactive"));
  assert.ok(!other.allReps.has("Rita Rep"));

  // Re-derive the empty set: still the original membership.
  const emptyAgain = buildEffectiveHierarchy(base, overrideMap());
  assert.ok(!emptyAgain.allReps.has("Ina Inactive"));
  assert.ok(emptyAgain.allReps.has("Rita Rep"));
});

// --- Task #578: container retention for inactive FLMs/SLMs -------------------

test("inactive FLM with an active rep is retained as a container-only node", () => {
  const base = makeBase();
  const eff = buildEffectiveHierarchy(
    base,
    overrideMap(ov({ person: "Fred FLM", active: false })),
  );
  // Fred stays in the tree structure...
  assert.ok(eff.slmToFlms["Sam SLM"].includes("Fred FLM"));
  assert.deepEqual(eff.flmToReps["Fred FLM"], ["Rita Rep", "Roy Rep"]);
  assert.equal(eff.repToFlm["Rita Rep"], "Fred FLM");
  assert.equal(eff.repToSlm["Rita Rep"], "Sam SLM");
  // ...flagged inactive...
  assert.equal(eff.personToActive["Fred FLM"], false);
  // ...but container only: no self-rep entry, so his own rows never count.
  assert.ok(!eff.allReps.has("Fred FLM"));
  assert.equal(eff.repToFlm["Fred FLM"], undefined);
  // Active reps beneath him stay everywhere.
  assert.ok(eff.allReps.has("Rita Rep"));
  assert.ok(eff.allReps.has("Roy Rep"));
});

test("inactive FLM whose reps are all inactive is dropped entirely", () => {
  const base = makeBase();
  const eff = buildEffectiveHierarchy(
    base,
    overrideMap(
      ov({ person: "Fred FLM", active: false }),
      ov({ person: "Rita Rep", active: false }),
      ov({ person: "Roy Rep", active: false }),
    ),
  );
  assert.ok(!eff.slmToFlms["Sam SLM"]?.includes("Fred FLM"));
  assert.equal(eff.flmToReps["Fred FLM"], undefined);
  assert.ok(!eff.allReps.has("Fred FLM"));
  // Frank's branch is untouched.
  assert.ok(eff.slmToFlms["Sam SLM"].includes("Frank FLM"));
  assert.ok(eff.allReps.has("Rich Rep"));
});

test("inactive SLM with an active rep deep below is retained as a container", () => {
  const base = makeBase();
  const eff = buildEffectiveHierarchy(
    base,
    overrideMap(ov({ person: "Sam SLM", active: false })),
  );
  assert.ok(eff.slms.includes("Sam SLM"));
  assert.equal(eff.personToActive["Sam SLM"], false);
  assert.ok(eff.slmToFlms["Sam SLM"].includes("Fred FLM"));
  assert.ok(eff.allReps.has("Rita Rep"));
  assert.equal(eff.repToSlm["Rita Rep"], "Sam SLM");
});

test("inactive SLM AND inactive FLM chain retained when one rep is active", () => {
  const base = makeBase();
  const eff = buildEffectiveHierarchy(
    base,
    overrideMap(
      ov({ person: "Sam SLM", active: false }),
      ov({ person: "Fred FLM", active: false }),
      ov({ person: "Roy Rep", active: false }),
      ov({ person: "Frank FLM", active: false }),
      ov({ person: "Rich Rep", active: false }),
    ),
  );
  // Rita is the only active person: her whole chain survives as containers.
  assert.ok(eff.slms.includes("Sam SLM"));
  assert.deepEqual(eff.slmToFlms["Sam SLM"], ["Fred FLM"]);
  assert.deepEqual(eff.flmToReps["Fred FLM"], ["Rita Rep"]);
  // Frank's all-inactive branch is gone.
  assert.equal(eff.flmToReps["Frank FLM"], undefined);
  assert.ok(!eff.allReps.has("Rich Rep"));
});

test("SLM with all-inactive subtree is dropped entirely", () => {
  const base = makeBase();
  const eff = buildEffectiveHierarchy(
    base,
    overrideMap(
      ov({ person: "Sam SLM", active: false }),
      ov({ person: "Fred FLM", active: false }),
      ov({ person: "Frank FLM", active: false }),
      ov({ person: "Rita Rep", active: false }),
      ov({ person: "Roy Rep", active: false }),
      ov({ person: "Rich Rep", active: false }),
    ),
  );
  assert.ok(!eff.slms.includes("Sam SLM"));
  assert.equal(eff.slmToFlms["Sam SLM"], undefined);
});

test("orphan inactive FLM (no SLM) attaches at root with reps beneath, container-only", () => {
  const base = makeBase();
  // Simulate an FLM whose SLM mapping is missing from the base tree.
  delete (base.repToSlm as Record<string, string>)["Fred FLM"];
  const eff = buildEffectiveHierarchy(
    base,
    overrideMap(ov({ person: "Fred FLM", active: false })),
  );
  // Fred appears at the org root as a single-FLM branch (SLM=FLM shape)...
  assert.ok(eff.slms.includes("Fred FLM"));
  assert.deepEqual(eff.slmToFlms["Fred FLM"], ["Fred FLM"]);
  // ...with his active reps as REPS (not misclassified as FLM nodes).
  assert.deepEqual(eff.flmToReps["Fred FLM"], ["Rita Rep", "Roy Rep"]);
  assert.equal(eff.flmToReps["Rita Rep"], undefined);
  assert.equal(eff.repToFlm["Rita Rep"], "Fred FLM");
  assert.equal(eff.repToSlm["Rita Rep"], "Fred FLM");
  assert.ok(eff.allReps.has("Rita Rep"));
  const rita = eff.people.find((p) => p.name === "Rita Rep");
  assert.equal(rita?.role, "rep");
  // Container-only: the inactive orphan FLM never counts as their own rep.
  assert.equal(eff.personToActive["Fred FLM"], false);
  assert.ok(!eff.allReps.has("Fred FLM"));
  assert.equal(eff.repToFlm["Fred FLM"], undefined);
});

test("orphan ACTIVE FLM (no SLM) attaches at root and keeps their self-rep entry", () => {
  const base = makeBase();
  delete (base.repToSlm as Record<string, string>)["Fred FLM"];
  const eff = buildEffectiveHierarchy(base, overrideMap());
  assert.ok(eff.slms.includes("Fred FLM"));
  assert.deepEqual(eff.slmToFlms["Fred FLM"], ["Fred FLM"]);
  assert.deepEqual(eff.flmToReps["Fred FLM"], ["Rita Rep", "Roy Rep"]);
  // Active player-coach orphan keeps the standard FLM self-rep entries.
  assert.ok(eff.allReps.has("Fred FLM"));
  assert.equal(eff.repToFlm["Fred FLM"], "Fred FLM");
});

test("orphan inactive FLM with all-inactive reps is dropped entirely", () => {
  const base = makeBase();
  delete (base.repToSlm as Record<string, string>)["Fred FLM"];
  const eff = buildEffectiveHierarchy(
    base,
    overrideMap(
      ov({ person: "Fred FLM", active: false }),
      ov({ person: "Rita Rep", active: false }),
      ov({ person: "Roy Rep", active: false }),
    ),
  );
  assert.ok(!eff.slms.includes("Fred FLM"));
  assert.equal(eff.slmToFlms["Fred FLM"], undefined);
  assert.equal(eff.flmToReps["Fred FLM"], undefined);
});
