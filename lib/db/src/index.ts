import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { PoolClient as PgPoolClient } from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Replit's managed Postgres (production) presents a certificate that isn't in
// the deployment image's trust store. Recent node-postgres treats
// `sslmode=require` (and prefer/verify-ca) as `verify-full`, which then rejects
// that certificate and makes every query throw — crashing the server on
// startup. When the connection string asks for SSL, keep TLS enabled but skip
// chain verification so the managed certificate is accepted. Dev uses
// `sslmode=disable`, so this is a no-op locally.
const wantsSsl = /[?&]sslmode=(require|prefer|verify-ca|verify-full)/.test(
  connectionString,
);

// Pool size. Defaults to node-postgres' own default (10) so live behavior is
// unchanged. The public demo holds one long-lived client per demo session (see
// the routing resolver below), so it needs headroom — DEMO_MODE raises the
// default and PG_POOL_MAX overrides both.
const envPoolMax = Number(process.env.PG_POOL_MAX);
const demoModeEnv = /^(1|true)$/i.test((process.env.DEMO_MODE ?? "").trim());
const poolMax =
  Number.isFinite(envPoolMax) && envPoolMax > 0
    ? envPoolMax
    : demoModeEnv
      ? 24
      : undefined;

export const pool = new Pool({
  connectionString,
  ...(wantsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  ...(poolMax !== undefined ? { max: poolMax } : {}),
});

// Re-export the connection type so consumers can annotate a checked-out client
// without taking a direct `pg` dependency. `ReturnType<typeof pool.connect>`
// resolves to the callback overload (`void`) instead of `Promise<PoolClient>`,
// so deriving the client type from `pool.connect` is unreliable.
export type { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Optional per-context query routing
// ---------------------------------------------------------------------------
//
// A host application can install a resolver that redirects the queries issued
// through the shared `db` handle onto a specific checked-out client instead of
// the pool. The public demo uses this to give every demo session its own
// never-committed transaction (see api-server/src/lib/demo-session.ts), so a
// demo user's writes are visible only to that session and disappear when it
// ends.
//
// Nothing is installed by default: with no resolver (or a resolver that returns
// null) every query goes straight to the pool exactly as before, so the live
// path is byte-identical.

/** Resolves the client the current async context must use, or null for the pool. */
export type DbRoutingResolver = () => Promise<PgPoolClient | null>;

let routingResolver: DbRoutingResolver | null = null;

export function setDbRoutingResolver(resolver: DbRoutingResolver | null): void {
  routingResolver = resolver;
}

/**
 * Observer invoked (synchronously, in the caller's async context) whenever a
 * ROUTED query — one running on a resolver-provided client, i.e. inside a demo
 * session's transaction — looks like a write. The demo layer uses this to
 * detect a session's first edit and switch it from the shared baseline cache
 * scope to a private one. Never called for pool (live) queries.
 */
export type DbWriteObserver = (queryText: string) => void;

let writeObserver: DbWriteObserver | null = null;

export function setDbWriteObserver(observer: DbWriteObserver | null): void {
  writeObserver = observer;
}

// Statements that can change data. CTE-led writes (`WITH … INSERT/UPDATE/…`)
// are matched by the second alternative.
const WRITE_QUERY_RE =
  /^\s*(insert|update|delete|merge|truncate|alter|create|drop|copy)\b|^\s*with\b[\s\S]*?\b(insert|update|delete|merge)\b/i;

function notifyIfWrite(arg0: unknown): void {
  if (!writeObserver) return;
  const text = queryText(arg0);
  if (WRITE_QUERY_RE.test(text)) writeObserver(text);
}

type QueryArgs = Parameters<PgPoolClient["query"]>;

function queryText(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && typeof (arg as { text?: unknown }).text === "string") {
    return (arg as { text: string }).text;
  }
  return "";
}

/**
 * Wraps an already-open transactional client so a nested `BEGIN … COMMIT`
 * (what drizzle's `db.transaction()` emits) becomes savepoint bracketing. Without
 * this, drizzle's COMMIT would commit — and thereby persist — the enclosing
 * session transaction the demo isolation depends on never being committed.
 */
function savepointClient(client: PgPoolClient): PgPoolClient {
  const stack: string[] = [];
  let counter = 0;

  const proxied = {
    query: (...args: unknown[]): unknown => {
      const text = queryText(args[0]).trim();
      if (/^begin\b/i.test(text)) {
        const name = `drz_sp_${++counter}`;
        stack.push(name);
        return client.query(`SAVEPOINT ${name}`);
      }
      if (/^commit\b/i.test(text)) {
        const name = stack.pop();
        return name
          ? client.query(`RELEASE SAVEPOINT ${name}`)
          : Promise.resolve({ rows: [], rowCount: 0 } as never);
      }
      if (/^rollback\b/i.test(text)) {
        const name = stack.pop();
        if (!name) return Promise.resolve({ rows: [], rowCount: 0 } as never);
        return client
          .query(`ROLLBACK TO SAVEPOINT ${name}`)
          .then(() => client.query(`RELEASE SAVEPOINT ${name}`));
      }
      // savepointClient only ever wraps a ROUTED (demo-session) client, so
      // every write through it belongs to that session.
      notifyIfWrite(args[0]);
      return (client.query as (...a: unknown[]) => unknown)(...args);
    },
    // The session owns the client's lifetime; a transaction borrowing it must
    // never hand it back to the pool.
    release: () => {},
  };
  return proxied as unknown as PgPoolClient;
}

/**
 * Pool-compatible façade drizzle talks to. Every query consults the routing
 * resolver first; with no resolver installed this is a thin pass-through to the
 * real pool. The class name intentionally contains "Pool" because drizzle's
 * node-postgres session detects pools by constructor name to decide whether a
 * transaction needs its own checked-out client.
 */
class RoutingPool {
  async query(...args: unknown[]): Promise<unknown> {
    const routed = routingResolver ? await routingResolver() : null;
    if (routed) notifyIfWrite(args[0]);
    const target = routed ?? pool;
    return (target.query as (...a: unknown[]) => unknown)(...args) as Promise<unknown>;
  }

  async connect(): Promise<PgPoolClient> {
    const routed = routingResolver ? await routingResolver() : null;
    return routed ? savepointClient(routed) : pool.connect();
  }
}

const routingPool = new RoutingPool();

export const db = drizzle(routingPool as unknown as pg.Pool, { schema });

/**
 * Drizzle handle bound directly to the pool, bypassing any routing resolver.
 * Used for state that must persist regardless of the caller's context — most
 * importantly the `sessions` table (a demo session's own login row must not
 * live inside the transaction it is about to roll back).
 */
export const dbDirect = drizzle(pool, { schema });

export * from "./schema";
