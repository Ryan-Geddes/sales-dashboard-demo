import { db } from "@workspace/db";
import {
  oppProbabilityOverridesTable,
  stageDefaultProbabilitiesTable,
  HARDCODED_STAGE_DEFAULTS,
} from "@workspace/db/schema";
import { canonicalizeOppId } from "./sf-id";
import { bumpDataVersion } from "./cache-version";
import { dbScopeKey } from "./demo-session";

const CACHE_TTL_MS = 30_000;

// Per-opp override entry as stored in the cache. `reviewedAt` is null when
// the opp's review status has been cleared (e.g. by the Sunday cron) but the
// probability value is still preserved.
export type OppOverrideEntry = { probability: number; reviewedAt: Date | null };

// Test seam: lets cache-generation race tests drive the loader deterministically.
export type OverrideRow = { oppId: string; probability: number; reviewedAt: Date | null };
type OverrideLoader = () => Promise<OverrideRow[]>;
const realOverrideLoader: OverrideLoader = () =>
  db.select().from(oppProbabilityOverridesTable);
let overrideLoader: OverrideLoader = realOverrideLoader;

export function __setOverrideLoaderForTesting(loader: OverrideLoader | null): void {
  overrideLoader = loader ?? realOverrideLoader;
}

// Both caches are partitioned by DB scope (see demo-session.ts): the empty
// key is the normal pool context — the ONLY key that ever exists in live mode,
// so live behavior is a plain single-entry lookup — and each demo session gets
// its own slot so it never reads another session's uncommitted overrides.
interface ScopeState<T> {
  cache: T | null;
  cacheTime: number;
  pending: Promise<T> | null;
  pendingGen: number;
}

function newScopeState<T>(): ScopeState<T> {
  return { cache: null, cacheTime: 0, pending: null, pendingGen: -1 };
}

const entriesByScope = new Map<string, ScopeState<Record<string, OppOverrideEntry>>>();
const defaultsByScope = new Map<string, ScopeState<Record<string, number>>>();

function scopeState<T>(map: Map<string, ScopeState<T>>): ScopeState<T> {
  const key = dbScopeKey();
  let state = map.get(key);
  if (!state) {
    state = newScopeState<T>();
    map.set(key, state);
  }
  return state;
}

// Generation counter bumped on every invalidation. Any in-flight read that
// started before the bump is not allowed to (a) write its (now-stale) result
// back into the cache, or (b) be returned to a caller that arrived after the
// invalidation. Without this, a PUT or Sunday-cron clear that happens while
// a read is in flight could be silently overwritten by the stale promise for
// up to TTL_MS, OR a fresh read-after-invalidate caller could be served the
// pre-invalidation snapshot — both of which produce wrong reviewed/unreviewed
// state in the UI.
let cacheGeneration = 0;

export function invalidateProbabilityCaches() {
  entriesByScope.clear();
  defaultsByScope.clear();
  cacheGeneration += 1;
  bumpDataVersion();
}

// Internal: the canonical source of override + reviewed-at data, backed by a
// single DB scan. Both `getOppProbabilityOverrides` and `getOppReviewedMap`
// derive their views from this so a request that needs both does not hit the
// DB twice.
export async function getOppOverrideEntries(): Promise<Record<string, OppOverrideEntry>> {
  const now = Date.now();
  const state = scopeState(entriesByScope);
  if (state.cache && now - state.cacheTime < CACHE_TTL_MS) return state.cache;
  // Only reuse an in-flight promise if it was started under the CURRENT
  // generation. After an invalidation, that promise is pre-write data and
  // must not be returned to callers arriving post-invalidate.
  if (state.pending && state.pendingGen === cacheGeneration) return state.pending;
  const startGen = cacheGeneration;
  state.pendingGen = startGen;
  const myPromise = (async () => {
    const rows = await overrideLoader();
    const map: Record<string, OppOverrideEntry> = {};
    for (const r of rows) {
      // Canonicalize stored keys to 18-char so overrides/reviewed flags set
      // under a legacy 15-char id still match canonicalized pipeline opp ids.
      const key = canonicalizeOppId(r.oppId);
      const entry: OppOverrideEntry = {
        probability: r.probability,
        reviewedAt: r.reviewedAt ?? null,
      };
      const existing = map[key];
      // A legacy 15-char row and an 18-char row can collapse to the same opp.
      // Prefer the reviewed one so review state is never lost in the merge.
      if (!existing || (existing.reviewedAt == null && entry.reviewedAt != null)) {
        map[key] = entry;
      }
    }
    // Only persist to cache if no invalidation happened mid-flight.
    if (cacheGeneration === startGen) {
      state.cache = map;
      state.cacheTime = Date.now();
    }
    return map;
  })();
  state.pending = myPromise;
  // Only clear the slot if it still points at this promise. A post-invalidate
  // caller may have replaced it with a fresh promise; we must not null that.
  myPromise.finally(() => {
    if (state.pending === myPromise) state.pending = null;
  });
  return myPromise;
}

export async function getOppProbabilityOverrides(): Promise<Record<string, number>> {
  const entries = await getOppOverrideEntries();
  const out: Record<string, number> = {};
  for (const id of Object.keys(entries)) out[id] = entries[id].probability;
  return out;
}

// Returns a per-opp boolean map: true iff the rep has explicitly reviewed
// the opp (override row exists AND reviewed_at IS NOT NULL). Used by the
// pipeline DTO so the frontend can highlight unreviewed opps regardless of
// whether the override value happens to equal the stage default.
export async function getOppReviewedMap(): Promise<Record<string, boolean>> {
  const entries = await getOppOverrideEntries();
  const out: Record<string, boolean> = {};
  for (const id of Object.keys(entries)) {
    out[id] = entries[id].reviewedAt != null;
  }
  return out;
}

export async function getStageDefaultProbabilities(): Promise<Record<string, number>> {
  const now = Date.now();
  const state = scopeState(defaultsByScope);
  if (state.cache && now - state.cacheTime < CACHE_TTL_MS) return state.cache;
  if (state.pending && state.pendingGen === cacheGeneration) return state.pending;
  const startGen = cacheGeneration;
  state.pendingGen = startGen;
  const myPromise = (async () => {
    const rows = await db.select().from(stageDefaultProbabilitiesTable);
    const map: Record<string, number> = { ...HARDCODED_STAGE_DEFAULTS };
    for (const r of rows) map[r.stage] = r.probability;
    if (cacheGeneration === startGen) {
      state.cache = map;
      state.cacheTime = Date.now();
    }
    return map;
  })();
  state.pending = myPromise;
  myPromise.finally(() => {
    if (state.pending === myPromise) state.pending = null;
  });
  return myPromise;
}

export function effectiveProbability(
  oppId: string | undefined,
  funnelStage: string,
  overrides: Record<string, number>,
  defaults: Record<string, number>,
): number {
  if (oppId && overrides[oppId] !== undefined) return overrides[oppId];
  return defaults[funnelStage] ?? 0;
}
