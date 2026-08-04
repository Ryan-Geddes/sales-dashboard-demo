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
import { pool, setDbRoutingResolver, type PoolClient } from "@workspace/db";
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
}

// Insertion-ordered map doubles as the LRU: `touch` re-inserts at the end, so
// the first key is always the least recently used.
const sessions = new Map<string, SessionEntry>();
const opening = new Map<string, Promise<PoolClient | null>>();

const als = new AsyncLocalStorage<string>();

/** The demo session id owning the current async context, if any. */
export function currentDemoSessionId(): string | undefined {
  return als.getStore();
}

/**
 * Cache-partition key for the current context. Every in-memory cache holding
 * DB-derived data folds this in so one demo session can never be served a value
 * computed from another session's uncommitted writes. Empty string (the live /
 * pool context) outside a demo session, so live cache keys are unchanged.
 */
export function dbScopeKey(): string {
  const sid = als.getStore();
  return sid ? `demo:${sid}` : "";
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

async function discard(sid: string, entry: SessionEntry, reason: string): Promise<void> {
  sessions.delete(sid);
  try {
    // NEVER COMMIT — the whole point is that demo edits are thrown away.
    await entry.client.query("ROLLBACK");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), sid, reason },
      "[Demo session] ROLLBACK failed",
    );
  } finally {
    try {
      entry.client.release();
    } catch {
      /* already released */
    }
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
  const entry: SessionEntry = { client, lastUsed: Date.now() };
  sessions.set(sid, entry);
  logger.info({ sid, open: sessions.size }, "[Demo session] Opened transaction");
  return client;
}

async function clientForSession(sid: string): Promise<PoolClient | null> {
  const existing = sessions.get(sid);
  if (existing) {
    touch(sid, existing);
    return existing.client;
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
  const timer = setInterval(sweepIdle, SWEEP_INTERVAL_MS);
  timer.unref?.();
  logger.info(
    { maxSessions: MAX_SESSION_CLIENTS, idleTtlMinutes: IDLE_TTL_MS / 60000 },
    "[Demo session] Per-session DB isolation enabled",
  );
}

/** Diagnostics: number of demo sessions currently holding a transaction. */
export function demoSessionCount(): number {
  return sessions.size;
}
