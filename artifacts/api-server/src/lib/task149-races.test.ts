import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSundayBulkResetUpdate,
  runSundayOppReviewResetWithDeps,
  type SundayResetDeps,
} from "./photo-sync";
import {
  __setOverrideLoaderForTesting,
  invalidateProbabilityCaches,
  getOppReviewedMap,
  getOppProbabilityOverrides,
  type OverrideRow,
} from "./probabilities";

// Sunday 00:01 HST. 2026-05-03 was a Sunday.
const SUNDAY_HST = new Date("2026-05-03T10:01:00.000Z");

// ---------------------------------------------------------------------------
// Production SQL regression: the cron's bulk reset MUST emit
// `reviewed_at <= $cutoff` in its WHERE clause. This is the half of the
// Task #149 fix that lives in the actual production query, not in the
// orchestration. Without this predicate a PUT that lands between the
// snapshot scan and the UPDATE is silently clobbered.
// ---------------------------------------------------------------------------

test("production cron UPDATE emits the reviewed_at <= cutoff predicate", () => {
  const cutoff = new Date("2026-05-03T10:00:00.000Z");
  const { sql, params } = buildSundayBulkResetUpdate(["OPP-1", "OPP-2"], cutoff).toSQL();

  // The UPDATE must clear reviewed_at, scope by oppId, AND gate on the cutoff.
  assert.match(sql, /update\s+"opp_probability_overrides"/i);
  assert.match(sql, /set\s+"reviewed_at"\s*=\s*NULL/i);
  assert.match(sql, /"opp_id"\s+in\s*\(/i);
  assert.match(
    sql,
    /"reviewed_at"\s*<=\s*\$\d+/i,
    "missing the Task #149 cutoff predicate — concurrent PUTs would be clobbered",
  );
  assert.ok(
    params.includes(cutoff.toISOString()),
    "cutoff timestamp must be bound as a parameter to the UPDATE",
  );
});

// ---------------------------------------------------------------------------
// Orchestration regression: the cron must capture `resetStart` BEFORE
// reading the snapshot AND must pass it to bulkResetReviewed. We verify
// the contract by injecting fakes that record what was passed where.
// ---------------------------------------------------------------------------

test("cron captures cutoff before snapshot read and passes it through to bulk reset", async () => {
  // Deterministic cutoff via injected `now`. Realistic wall-clock stamps:
  //   - OPP-1 reviewed 90s before the cutoff → in snapshot, must be cleared
  //   - OPP-2 reviewed 100ms AFTER the cutoff → not in snapshot, untouched
  const beforeCutoff = new Date(SUNDAY_HST.getTime() - 90_000);
  const afterCutoff = new Date(SUNDAY_HST.getTime() + 100);

  const dbState = new Map<string, { probability: number; reviewedAt: Date | null }>([
    ["OPP-1", { probability: 60, reviewedAt: beforeCutoff }],
    ["OPP-2", { probability: 40, reviewedAt: afterCutoff }],
  ]);

  let snapshotCutoff: Date | null = null;
  let updateCutoff: Date | null = null;
  let updateOppIds: string[] = [];

  const deps: SundayResetDeps = {
    now: () => SUNDAY_HST,
    loadHierarchy: async () => ({ repToSlm: { "Rep A": "Sandra SLM" } }),
    loadPrefRows: async () => [],
    loadReviewedOverrides: async (c) => {
      snapshotCutoff = c;
      const out: Array<{ oppId: string }> = [];
      for (const [oppId, row] of dbState) {
        if (row.reviewedAt && row.reviewedAt.getTime() <= c.getTime()) {
          out.push({ oppId });
        }
      }
      return out;
    },
    loadOppOwners: async () => ({ "OPP-1": "Rep A", "OPP-2": "Rep A" }),
    bulkResetReviewed: async (oppIds, c) => {
      updateOppIds = [...oppIds];
      updateCutoff = c;
    },
    invalidateCaches: () => {},
  };

  // `now` returns SUNDAY_HST so the Sunday-only branch passes and the
  // captured cutoff IS that exact value (deps.now() is stable in the test).
  await runSundayOppReviewResetWithDeps({ ...deps, now: () => SUNDAY_HST });

  const snap = snapshotCutoff as Date | null;
  const upd = updateCutoff as Date | null;
  assert.ok(snap, "loadReviewedOverrides must receive a cutoff");
  assert.ok(upd, "bulkResetReviewed must receive a cutoff");
  assert.equal(
    snap.getTime(),
    upd.getTime(),
    "snapshot cutoff and UPDATE cutoff must be the same instant",
  );
  assert.equal(
    upd.getTime(),
    SUNDAY_HST.getTime(),
    "cutoff must come from deps.now() captured up-front, not a fresh new Date()",
  );
  // Snapshot saw OPP-1 (pre-cutoff). OPP-2 (post-cutoff) was filtered out
  // by the cutoff predicate, exactly as the production WHERE clause would.
  assert.deepEqual(updateOppIds, ["OPP-1"]);
});

test("cron does not clobber a PUT whose stamp is after the captured cutoff", async () => {
  // End-to-end race: snapshot scan happens, rep PUTs OPP-1 with a stamp
  // strictly AFTER the captured cutoff, then bulk UPDATE runs. Production
  // would honor `reviewed_at <= cutoff` and skip OPP-1; we mirror the same
  // SQL semantics in the test executor and assert OPP-1 survives.
  const cutoff = SUNDAY_HST;
  const dbState = new Map<string, { probability: number; reviewedAt: Date | null }>([
    ["OPP-1", { probability: 60, reviewedAt: new Date(cutoff.getTime() - 60_000) }],
    ["OPP-2", { probability: 40, reviewedAt: new Date(cutoff.getTime() - 60_000) }],
  ]);

  let putFired = false;

  const deps: SundayResetDeps = {
    now: () => cutoff,
    loadHierarchy: async () => ({ repToSlm: { "Rep A": "Sandra SLM" } }),
    loadPrefRows: async () => [],
    loadReviewedOverrides: async (c) => {
      const out: Array<{ oppId: string }> = [];
      for (const [oppId, row] of dbState) {
        if (row.reviewedAt && row.reviewedAt.getTime() <= c.getTime()) {
          out.push({ oppId });
        }
      }
      return out;
    },
    loadOppOwners: async () => {
      // Rep PUT lands strictly between snapshot and UPDATE, with a realistic
      // timestamp 1ms after the cutoff (the rep's PUT happens "moments after"
      // the cron started its scan).
      if (!putFired) {
        putFired = true;
        dbState.set("OPP-1", {
          probability: 95,
          reviewedAt: new Date(cutoff.getTime() + 1),
        });
      }
      return { "OPP-1": "Rep A", "OPP-2": "Rep A" };
    },
    bulkResetReviewed: async (oppIds, c) => {
      // Production SQL semantics: only clear rows whose stored reviewed_at
      // is still <= the captured cutoff.
      for (const id of oppIds) {
        const row = dbState.get(id);
        if (!row || !row.reviewedAt) continue;
        if (row.reviewedAt.getTime() <= c.getTime()) {
          dbState.set(id, { ...row, reviewedAt: null });
        }
      }
    },
    invalidateCaches: () => {},
  };

  const summary = await runSundayOppReviewResetWithDeps(deps);
  assert.ok(summary !== null);

  const opp1 = dbState.get("OPP-1")!;
  assert.notEqual(opp1.reviewedAt, null, "rep's fresh PUT must survive the cron");
  assert.equal(opp1.probability, 95);

  const opp2 = dbState.get("OPP-2")!;
  assert.equal(opp2.reviewedAt, null, "untouched rows are still cleared");

  assert.ok(putFired);
});

// ---------------------------------------------------------------------------
// probabilities.ts cache-generation regression: in-flight reads must not be
// served to (or written for) callers that arrive after invalidation.
// ---------------------------------------------------------------------------

test("post-invalidate reader does not get the in-flight stale snapshot", async () => {
  let resolveFirstLoad!: (rows: OverrideRow[]) => void;
  const firstLoadPromise = new Promise<OverrideRow[]>((res) => {
    resolveFirstLoad = res;
  });
  let loadCount = 0;

  __setOverrideLoaderForTesting(() => {
    loadCount++;
    if (loadCount === 1) return firstLoadPromise;
    return Promise.resolve([
      { oppId: "OPP-1", probability: 80, reviewedAt: new Date("2026-05-04T12:00:00Z") },
    ]);
  });

  invalidateProbabilityCaches();

  try {
    const reader1Promise = getOppReviewedMap();
    await new Promise((r) => setImmediate(r));

    invalidateProbabilityCaches();

    const reader2Promise = getOppReviewedMap();

    resolveFirstLoad([{ oppId: "OPP-1", probability: 50, reviewedAt: null }]);

    const reader1 = await reader1Promise;
    const reader2 = await reader2Promise;

    assert.equal(reader1["OPP-1"], false, "reader1 sees its own snapshot");
    assert.equal(
      reader2["OPP-1"],
      true,
      "reader2 must see fresh data, NOT the pre-invalidate pending promise",
    );
    assert.equal(loadCount, 2, "post-invalidate reader must trigger a fresh load");
  } finally {
    __setOverrideLoaderForTesting(null);
    invalidateProbabilityCaches();
  }
});

test("in-flight read does not write stale data into cache after invalidate", async () => {
  let resolveFirstLoad!: (rows: OverrideRow[]) => void;
  const firstLoadPromise = new Promise<OverrideRow[]>((res) => {
    resolveFirstLoad = res;
  });
  let loadCount = 0;

  __setOverrideLoaderForTesting(() => {
    loadCount++;
    if (loadCount === 1) return firstLoadPromise;
    return Promise.resolve([
      { oppId: "OPP-1", probability: 80, reviewedAt: new Date("2026-05-04T12:00:00Z") },
    ]);
  });

  invalidateProbabilityCaches();

  try {
    const reader1Promise = getOppProbabilityOverrides();
    await new Promise((r) => setImmediate(r));

    invalidateProbabilityCaches();

    resolveFirstLoad([{ oppId: "OPP-1", probability: 50, reviewedAt: null }]);
    const reader1 = await reader1Promise;
    assert.equal(reader1["OPP-1"], 50);

    await new Promise((r) => setImmediate(r));

    const reader3 = await getOppProbabilityOverrides();
    assert.equal(reader3["OPP-1"], 80, "post-invalidate reader gets fresh value");
    assert.equal(
      loadCount,
      2,
      "stale in-flight result must NOT have populated entriesCache",
    );
  } finally {
    __setOverrideLoaderForTesting(null);
    invalidateProbabilityCaches();
  }
});
