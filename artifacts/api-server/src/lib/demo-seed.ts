// Demo-mode database seeding.
//
// The public demo has no access to the production Postgres, so the DB-backed
// layer the dashboard reads on top of the frozen upstream snapshot (goal
// config/overrides, roster overrides, probabilities, manager estimates, comp +
// product-logic config, contests, preferences) is shipped as a fixture:
// `demo-data/db-seed.json` = { <table name>: rows[] } exactly as exported by
// `SELECT *` (DB column names, ids preserved).
//
// ensureDemoSeed() runs once at boot in demo mode: if the marker table says the
// fixture was already applied it is a no-op, otherwise each table is truncated
// and re-inserted. Nothing here runs (or is even imported for effect) outside
// demo mode.

import { pool } from "@workspace/db";
import { logger } from "./logger";
import { isDemoMode, loadDemoDbSeed } from "./demo-mode";

// Bump when the fixture format or contents change so a redeploy re-seeds.
const SEED_VERSION = "2026-08-04.1";
const MARKER_TABLE = "demo_seed_meta";

const MARKER_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (
    id text PRIMARY KEY,
    version text NOT NULL,
    seeded_at timestamptz NOT NULL DEFAULT now()
  );
`;

// Insert order matters only for readability — none of these tables reference
// each other (user_preferences references users, handled separately below).
const TABLE_ORDER = [
  "goal_config",
  "goal_row_overrides",
  "goal_csv_rows",
  "goal_finance_pps_rows",
  "goal_erep_rows",
  "roster_overrides",
  "opp_probability_overrides",
  "stage_default_probabilities",
  "manager_estimates",
  "compensation_config",
  "product_logic_config",
  "product_logic_examples",
  "contests",
  "user_preferences",
];

// Tables whose primary key is a `serial`, so the sequence must be advanced past
// the highest preserved id or the next insert collides.
const SERIAL_ID_TABLES = new Set([
  "goal_csv_rows",
  "goal_finance_pps_rows",
  "goal_erep_rows",
  "contests",
]);

const CHUNK_SIZE = 250;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Coerce a fixture value to something the target column accepts.
 *
 * - json/jsonb: serialize EVERYTHING (node-postgres renders a JS array as a
 *   Postgres ARRAY literal and a bare string unquoted — both invalid JSON).
 * - integer columns: the export may carry a float (e.g. an averaged estimate);
 *   round rather than letting Postgres reject it.
 * - everything else passes through; timestamps/dates go as ISO strings.
 */
function toParam(value: unknown, dataType: string | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (dataType === "json" || dataType === "jsonb") return JSON.stringify(value);
  if (
    (dataType === "integer" || dataType === "bigint" || dataType === "smallint") &&
    typeof value === "number"
  ) {
    return Math.round(value);
  }
  if (typeof value === "object" && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [name],
  );
  return rows[0]?.exists === true;
}

/** column name -> information_schema data_type for one public table. */
async function columnTypes(table: string): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.column_name] = r.data_type;
  return out;
}

async function seedTable(
  table: string,
  rows: Record<string, unknown>[],
): Promise<number> {
  if (!(await tableExists(table))) {
    logger.warn({ table }, "[Demo seed] Table does not exist — skipping");
    return 0;
  }

  await pool.query(`TRUNCATE TABLE ${quoteIdent(table)}`);
  if (rows.length === 0) return 0;

  const types = await columnTypes(table);

  // Union of the keys present across the fixture rows; a row missing a key
  // inserts NULL (and therefore its column default where one exists). Keys with
  // no matching column are dropped (schema drift) rather than failing the
  // insert.
  const columns: string[] = [];
  const unknown: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (columns.includes(key) || unknown.includes(key)) continue;
      if (types[key] === undefined) unknown.push(key);
      else columns.push(key);
    }
  }
  if (unknown.length > 0) {
    logger.warn(
      { table, columns: unknown },
      "[Demo seed] Fixture columns not present in schema — ignored",
    );
  }
  if (columns.length === 0) return 0;
  const colSql = columns.map(quoteIdent).join(", ");

  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = columns.map((col) => {
        params.push(toParam(row[col], types[col]));
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await pool.query(
      `INSERT INTO ${quoteIdent(table)} (${colSql}) VALUES ${tuples.join(", ")}`,
      params,
    );
    inserted += chunk.length;
  }

  if (SERIAL_ID_TABLES.has(table) && columns.includes("id")) {
    // pg_get_serial_sequence returns NULL when the column is not serial-backed,
    // and setval(NULL, ...) is a no-op-safe NULL, so this is always safe.
    await pool.query(
      `SELECT setval(
         pg_get_serial_sequence($1, 'id'),
         GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${quoteIdent(table)}), 1)
       )
       WHERE pg_get_serial_sequence($1, 'id') IS NOT NULL`,
      [table],
    );
  }

  return inserted;
}

/**
 * `user_preferences.user_id` is a FK onto `users`. The demo users table is
 * populated by whatever auth the demo host runs (a later phase), so drop
 * preference rows whose user does not exist rather than failing the insert.
 */
async function filterRows(
  table: string,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (table !== "user_preferences" || rows.length === 0) return rows;
  const ids = [...new Set(rows.map((r) => String(r["user_id"] ?? "")))];
  const { rows: present } = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE id = ANY($1)",
    [ids],
  );
  const known = new Set(present.map((r) => r.id));
  const kept = rows.filter((r) => known.has(String(r["user_id"] ?? "")));
  if (kept.length !== rows.length) {
    logger.warn(
      { table, dropped: rows.length - kept.length },
      "[Demo seed] Dropped rows referencing a missing user",
    );
  }
  return kept;
}

async function alreadySeeded(): Promise<boolean> {
  const { rows } = await pool.query<{ version: string }>(
    `SELECT version FROM ${MARKER_TABLE} WHERE id = 'demo'`,
  );
  return rows[0]?.version === SEED_VERSION;
}

/**
 * Seed the demo database from `demo-data/db-seed.json`, once. Idempotent: after
 * a successful run the marker row short-circuits every later boot. A per-table
 * failure is logged and skipped rather than aborting the whole seed (e.g.
 * `user_preferences` when its referenced demo user row does not exist yet).
 * Never throws — the server must still boot and serve the snapshot-backed views.
 */
export async function ensureDemoSeed(): Promise<void> {
  if (!isDemoMode()) return;

  try {
    await pool.query(MARKER_TABLE_SQL);
    if (await alreadySeeded()) {
      logger.info(
        { version: SEED_VERSION },
        "[Demo seed] Already seeded — skipping",
      );
      return;
    }

    const seed = loadDemoDbSeed();
    const tables = [
      ...TABLE_ORDER.filter((t) => seed[t] != null),
      ...Object.keys(seed).filter((t) => !TABLE_ORDER.includes(t)),
    ];

    const counts: Record<string, number> = {};
    const missing: string[] = [];
    for (const table of tables) {
      const rows = seed[table];
      if (!Array.isArray(rows)) continue;
      try {
        if (!(await tableExists(table))) {
          missing.push(table);
          logger.warn({ table }, "[Demo seed] Table does not exist — skipping");
          continue;
        }
        counts[table] = await seedTable(table, await filterRows(table, rows));
      } catch (err) {
        logger.error(
          {
            table,
            err: err instanceof Error ? err.message : String(err),
          },
          "[Demo seed] Failed to seed table (continuing)",
        );
      }
    }

    if (missing.length > 0) {
      // Don't record success: a table missing at seed time (e.g. schema not
      // yet migrated) must trigger a full re-seed on the next boot.
      logger.warn(
        { counts, missing, version: SEED_VERSION },
        "[Demo seed] Incomplete — marker not written; will retry next boot",
      );
      return;
    }
    await pool.query(
      `INSERT INTO ${MARKER_TABLE} (id, version) VALUES ('demo', $1)
         ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, seeded_at = now()`,
      [SEED_VERSION],
    );
    logger.info({ counts, version: SEED_VERSION }, "[Demo seed] Seed complete");
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[Demo seed] Seeding failed",
    );
  }
}
