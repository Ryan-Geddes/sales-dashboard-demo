import { test } from "node:test";
import assert from "node:assert/strict";
import { isFinancePpsFresh, financePpsFetchedAtIso } from "./goals-finance-pps";

// ---------------------------------------------------------------------------
// Pure cadence + contract helpers for the finance.pps snapshot (Task #259 T003).
// These pin the ~30m freshness cadence (so a stale snapshot triggers a
// Databricks re-query instead of being served forever) and the API contract
// for `fetchedAt` (epoch ms internally → ISO date-time string at the boundary).
// ---------------------------------------------------------------------------

const TTL = 30 * 60 * 1000;

test("isFinancePpsFresh: snapshot within the TTL is fresh", () => {
  const now = 10_000_000;
  assert.equal(isFinancePpsFresh(now - 1000, now, TTL), true);
  assert.equal(isFinancePpsFresh(now, now, TTL), true);
  assert.equal(isFinancePpsFresh(now - (TTL - 1), now, TTL), true);
});

test("isFinancePpsFresh: snapshot at/over the TTL is stale (triggers refresh)", () => {
  const now = 10_000_000;
  assert.equal(isFinancePpsFresh(now - TTL, now, TTL), false);
  assert.equal(isFinancePpsFresh(now - (TTL + 1), now, TTL), false);
  assert.equal(isFinancePpsFresh(now - 24 * 60 * 60 * 1000, now, TTL), false);
});

test("isFinancePpsFresh: null fetchedAt is never fresh", () => {
  assert.equal(isFinancePpsFresh(null, 10_000_000, TTL), false);
});

test("financePpsFetchedAtIso: epoch ms → ISO string, null → null", () => {
  assert.equal(financePpsFetchedAtIso(null), null);
  const iso = financePpsFetchedAtIso(0);
  assert.equal(iso, "1970-01-01T00:00:00.000Z");
  const ms = Date.UTC(2026, 5, 8, 12, 30, 0);
  assert.equal(financePpsFetchedAtIso(ms), "2026-06-08T12:30:00.000Z");
});
