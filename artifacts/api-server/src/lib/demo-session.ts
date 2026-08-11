// Demo-mode session isolation.
//
// In the public demo every visitor signs in as one of the anonymized demo
// identities and is allowed to edit things (probability overrides, manager
// estimates, goals, comp config…). Those edits must be
//
//   * visible to the visitor who made them, for as long as they stay signed in,
//   * invisible to every other visitor, and
//   * gone once the session ends,
//
// without ever touching the seeded fixture data.
//
// Implementation: each demo session checks out ONE dedicated pg client from the
// pool and opens a transaction on it that is never committed. All queries made
// during that session's requests are routed onto that client (via the
// AsyncLocalStorage store below + the routing resolver installed on
// @workspace/db), so the session reads its own uncommitted writes while every
// other session — running on the pool — still sees only the committed seed
// (default READ COMMITTED). Session end ⇒ ROLLBACK + release ⇒ the edits vanish.
//
// The Owner (GitHub) login is deliberately NOT session scoped: it runs on the
// normal pool so its writes commit and persist.
//
// Nothing in this module is active outside DEMO_MODE: installDemoDbRouting()
// returns immediately and no resolver is installed, so `db` keeps talking to
// the pool exactly as before.

import { AsyncLocalStorage } from "node:async_hooks";
import { pool, setDbRoutingResolver, setDbWriteObserver, type PoolClient } from "@workspace/db";
import { logger } from "./logger";
import { isDemoMode } from "./demo-mode";

/** Max concurrent demo sessions holding a transactional client. */
const MAX_SESSION_CLIENTS = Number(process.env.DEMO_MAX_SESSION_CLIENTS) || 8;
/** Idle time after which a session's client is rolled back and released. */
const IDLE_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

interface SessionEntry {
  client: PoolClient;
  lastUsed: number;
  /**
   * Flipped to true the moment the client's connection errors or ends (Neon
   * drops idle connections; network blips happen). A dead entry is discarded
   * and transparently replaced with a fresh transactional client on the
   * session's next request — the session loses its uncommitted edits (same
   * semantics as LRU eviction) but keeps working instead of failing every
   * query until logout / the idle sweep.
   */
  dead: boolean;
  /**
   * True once this session has performed a write (other than exempted tables,
   * see the write observer below). Until then the session reads only committed
   * seed data — identical for everyone — so its cache scope is the shared
   * baseline and expensive computations (the pipeline) are computed once and
   * shared across all clean sessions. The first real edit flips this and the
   * session gets a private scope from then on. Reset naturally on reopen after
   * a dead connection (the edits were lost with the transaction anyway).
   */
  dirty: boolean;
  /** Listener refs so healthy clients go back to the pool without leaks. */
  onError: (err: Error) => void;
  onEnd: () => void;
}

// Insertion-ordered map doubles as the LRU: `touch` re-inserts at the end, so
// the first key is always the least recently used.
const sessions = new Map<string, SessionEntry>();
const opening = new Map<string, Promise<PoolClient | null>>();

// Per-session client generation, bumped every time a fresh transactional
// client is opened for a sid. Folded into dbScopeKey so in-memory caches can
// never serve a value computed from a previous (now rolled-back / dead)
// client's uncommitted state after a transparent reopen.
const generations = new Map<string, number>();

const als = new AsyncLocalStorage<string>();

/** The demo session id owning the current async context, if any. */
export function currentDemoSessionId(): string | undefined {
  return als.getStore();
}

/**
 * Cache scope shared by every demo session that has not written anything yet.
 * A clean session's transaction reads only committed seed data (READ
 * COMMITTED), so its computed values are identical to every other clean
 * session's — sharing one cache scope means the expensive pipeline result is
 * computed once, not once per visitor. Non-empty on purpose: several guards
 * use `if (dbScopeKey())` to mean "inside a demo session" (e.g. product-logic
 * refuses to publish a session's config process-wide), and those must keep
 * treating clean sessions as session-scoped.
 */
const BASELINE_SCOPE = "demo:baseline";

/**
 * Cache-partition key for the current context. Every in-memory cache holding
 * DB-derived data folds this in so one demo session can never be served a value
 * computed from another session's uncommitted writes. Empty string (the live /
 * pool context) outside a demo session, so live cache keys are unchanged.
 * Clean (no writes yet) sessions share BASELINE_SCOPE; a session that has
 * edited something gets a private per-sid scope, with a generation suffix so a
 * reopened (post-dead-connection) client never sees pre-death cached values.
 */
export function dbScopeKey(): string {
  const sid = als.getStore();
  if (!sid) return "";
  const entry = sessions.get(sid);
  if (!entry || !entry.dirty) return BASELINE_SCOPE;
  return `demo:${sid}:g${generations.get(sid) ?? 0}`;
}

/** Run `fn` with every DB query routed onto `sid`'s transactional client. */
export function runInDemoSession<T>(sid: string, fn: () => T): T {
  return als.run(sid, fn);
}

function touch(sid: string, entry: SessionEntry): void {
  entry.lastUsed = Date.now();
  sessions.delete(sid);
  sessions.set(sid, entry);
}

/**
 * Whether pg considers this client unusable. `_queryable` flips to false on a
 * connection error ("Client has encountered a connection error and is not
 * queryable"), `_ending` when the socket is being torn down. Both are internal
 * but stable across node-postgres 8.x; the error/end listeners are the primary
 * signal and this is a belt-and-braces check for cases where the failure was
 * observed by a query before the event fired into our listener.
 */
function clientLooksDead(client: PoolClient): boolean {
  const c = client as unknown as { _queryable?: boolean; _ending?: boolean };
  return c._queryable === false || c._ending === true;
}

async function discard(sid: string, entry: SessionEntry, reason: string): Promise<void> {
  sessions.delete(sid);
  entry.client.removeListener("error", entry.onError);
  entry.client.removeListener("end", entry.onEnd);
  const dead = entry.dead || clientLooksDead(entry.client);
  if (!dead) {
    try {
      // NEVER COMMIT — the whole point is that demo edits are thrown away.
      await entry.client.query("ROLLBACK");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), sid, reason },
        "[Demo session] ROLLBACK failed",
      );
      entry.dead = true;
    }
  }
  try {
    // A dead client must be destroyed, not returned to the pool for reuse.
    // (The uncommitted transaction dies with the connection, so skipping
    // ROLLBACK on a dead client is safe — nothing can ever commit it.)
    entry.client.release(entry.dead || clientLooksDead(entry.client) ? true : undefined);
  } catch {
    /* already released */
  }
  logger.info({ sid, reason, open: sessions.size }, "[Demo session] Released client");
}

async function evictIfNeeded(): Promise<void> {
  while (sessions.size >= MAX_SESSION_CLIENTS) {
    const oldest = sessions.entries().next();
    if (oldest.done) return;
    const [sid, entry] = oldest.value;
    // An evicted session keeps working — its next request simply opens a fresh
    // transaction, which means it loses the edits it had made.
    await discard(sid, entry, "lru-evicted");
  }
}

async function openSessionClient(sid: string): Promise<PoolClient | null> {
  await evictIfNeeded();
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    // FAIL CLOSED: a session-scoped demo user must never silently fall back to
    // the shared pool — its writes would commit and leak across sessions.
    // Throwing here fails the request instead (surfaces as a 500).
    logger.error(
      { err: err instanceof Error ? err.message : String(err), sid },
      "[Demo session] Could not check out a client — failing the request (fail-closed)",
    );
    throw new Error("Demo session storage unavailable — please retry");
  }
  try {
    await client.query("BEGIN");
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), sid },
      "[Demo session] BEGIN failed — failing the request (fail-closed)",
    );
    client.release();
    throw new Error("Demo session storage unavailable — please retry");
  }
  const entry: SessionEntry = {
    client,
    lastUsed: Date.now(),
    dead: false,
    dirty: false,
    onError: (err: Error) => {
      entry.dead = true;
      logger.warn(
        { err: err.message, sid },
        "[Demo session] Client connection errored — will reopen on next request",
      );
    },
    onEnd: () => {
      entry.dead = true;
    },
  };
  client.on("error", entry.onError);
  client.on("end", entry.onEnd);
  generations.set(sid, (generations.get(sid) ?? 0) + 1);
  sessions.set(sid, entry);
  logger.info(
    { sid, open: sessions.size, generation: generations.get(sid) },
    "[Demo session] Opened transaction",
  );
  return client;
}

async function clientForSession(sid: string): Promise<PoolClient | null> {
  const existing = sessions.get(sid);
  if (existing) {
    if (existing.dead || clientLooksDead(existing.client)) {
      // The pinned connection died (Neon idle timeout, restart, network blip).
      // Discard it and fall through to open a fresh transactional client —
      // the session loses its uncommitted demo edits but keeps working.
      existing.dead = true;
      await discard(sid, existing, "connection-dead");
    } else {
      touch(sid, existing);
      return existing.client;
    }
  }
  // Coalesce concurrent requests of the same session onto one open.
  const pending = opening.get(sid);
  if (pending) return pending;
  const run = openSessionClient(sid).finally(() => {
    opening.delete(sid);
  });
  opening.set(sid, run);
  return run;
}

/** Roll back and release a session's client (logout / session expiry). */
export async function endDemoSession(sid: string | undefined): Promise<void> {
  if (!sid) return;
  const entry = sessions.get(sid);
  if (!entry) return;
  await discard(sid, entry, "session-ended");
}

function sweepIdle(): void {
  const cutoff = Date.now() - IDLE_TTL_MS;
  for (const [sid, entry] of [...sessions.entries()]) {
    if (entry.lastUsed < cutoff) void discard(sid, entry, "idle");
  }
}

let installed = false;

/**
 * Install the demo query routing. No-op outside demo mode (and idempotent), so
 * the live server never gets a resolver and `db` keeps using the pool directly.
 */
export function installDemoDbRouting(): void {
  if (installed || !isDemoMode()) return;
  installed = true;
  setDbRoutingResolver(async () => {
    const sid = als.getStore();
    if (!sid) return null;
    return clientForSession(sid);
  });
  // First-write detection: flips the session out of the shared baseline cache
  // scope. user_preferences writes are exempt — the frontend saves per-user
  // preferences routinely (saved defaults, dismissals), preferences are read
  // straight from the DB per request (never held in a shared server cache),
  // and they are keyed by user id — so a prefs-only session can safely keep
  // serving shared baseline values. Any other write goes private.
  setDbWriteObserver((text) => {
    const sid = als.getStore();
    if (!sid) return;
    const entry = sessions.get(sid);
    if (!entry || entry.dirty) return;
    if (/\buser_preferences\b/i.test(text)) return;
    entry.dirty = true;
    logger.info(
      { sid, statement: text.slice(0, 60) },
      "[Demo session] First write — switching to private cache scope",
    );
  });
  const timer = setInterval(sweepIdle, SWEEP_INTERVAL_MS);
  timer.unref?.();
  logger.info(
    { maxSessions: MAX_SESSION_CLIENTS, idleTtlMinutes: IDLE_TTL_MS / 60000 },
    "[Demo session] Per-session DB isolation enabled",
  );
}

/**
 * Run `fn` inside a synthetic, always-clean demo session so its DB reads and
 * cache writes land in the shared BASELINE_SCOPE — used at boot to pre-warm
 * the expensive pipeline caches before the first visitor arrives. The
 * session's client is rolled back and released afterwards.
 */
export async function withDemoBaselineSession<T>(fn: () => Promise<T>): Promise<T> {
  const sid = `boot-warm-${Date.now()}`;
  try {
    return await als.run(sid, fn);
  } finally {
    await endDemoSession(sid);
  }
}

/** Diagnostics: number of demo sessions currently holding a transaction. */
export function demoSessionCount(): number {
  return sessions.size;
}
