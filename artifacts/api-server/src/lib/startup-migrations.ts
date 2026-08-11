import { pool, type PoolClient } from "@workspace/db";
import { logger } from "./logger";
import { canonicalizeOppId } from "./sf-id";
import { normalizeComparativeSidedFactorOp } from "./compensation";
import { EXEC_EMAILS, INTERNAL_EMAIL_DOMAIN } from "./user-roles";

// Core tables that historically were created via drizzle-kit push in the
// Replit workspace and therefore never had startup DDL. A fresh database
// (e.g. the public demo on Render/Neon) needs them created at boot or auth
// and demo seeding fail. Idempotent; matches lib/db/src/schema definitions.
const CORE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    sid varchar PRIMARY KEY,
    sess jsonb NOT NULL,
    expire timestamp NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON sessions (expire);

  CREATE TABLE IF NOT EXISTS users (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    email varchar UNIQUE,
    first_name varchar,
    last_name varchar,
    profile_image_url varchar,
    role varchar,
    hierarchy_name varchar,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key varchar NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS opp_probability_overrides (
    opp_id text PRIMARY KEY,
    probability integer NOT NULL,
    updated_at timestamp NOT NULL DEFAULT now(),
    updated_by_name text,
    reviewed_at timestamp
  );

  CREATE TABLE IF NOT EXISTS stage_default_probabilities (
    stage text PRIMARY KEY,
    probability integer NOT NULL,
    updated_at timestamp NOT NULL DEFAULT now(),
    updated_by_name text
  );

  CREATE TABLE IF NOT EXISTS rep_coverage_targets (
    hierarchy_name varchar PRIMARY KEY,
    coverage_target real NOT NULL DEFAULT 3.5,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS contests (
    id serial PRIMARY KEY,
    title text NOT NULL,
    objective text,
    metric text NOT NULL,
    product text,
    start_date text NOT NULL,
    end_date text NOT NULL,
    eligibility text,
    incentive_structure text,
    reward_details text,
    created_by_name text NOT NULL,
    created_by_role text NOT NULL,
    scope text,
    status text NOT NULL DEFAULT 'pending',
    approved_by_name text,
    approved_at timestamp,
    created_at timestamp NOT NULL DEFAULT now()
  );
`;

const ROLE_CHECK_SQL = `
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IS NULL OR role IN ('guest', 'rep', 'flm', 'slm', 'exec', 'admin', 'viewer'));
`;

// Employees on the configured internal email domain who logged in before the
// viewer fallback existed still have a NULL role; promote them to `viewer`.
// The domain comes from INTERNAL_EMAIL_DOMAIN (see user-roles.ts) — when it is
// unset this backfill is skipped entirely.
const INTERNAL_VIEWER_BACKFILL_SQL = `
  UPDATE users
  SET role = 'viewer', updated_at = now()
  WHERE role IS NULL
    AND lower(email) LIKE $1
  RETURNING id, email;
`;

// Task #533: exec-override emails may already have a users row from a prior
// login (e.g. as viewer). Backfill their stored role to 'exec' so access is
// immediate without waiting for a fresh login. Runs every boot (idempotent —
// the WHERE clause makes it a no-op once applied), and never touches admins.
const EXEC_ROLE_BACKFILL_SQL = `
  UPDATE users
  SET role = 'exec', updated_at = now()
  WHERE lower(email) = ANY($1)
    AND role IS DISTINCT FROM 'exec'
    AND role IS DISTINCT FROM 'admin'
  RETURNING id, email;
`;

// Existing rows stay NULL so the first post-deploy view shows every override as needs-review.
const REVIEWED_AT_COLUMN_SQL = `
  ALTER TABLE opp_probability_overrides
    ADD COLUMN IF NOT EXISTS reviewed_at timestamp;
`;

// Task #153: Sched Mods migrated to Databricks. We need to wipe the
// legacy sheet-keyed overrides (id shape `mod:<rep>|<account>|<date>|
// <amount>`) AND the single `Scheduled Mods` stage default. Both are
// destructive and must be ONE-SHOT — the new code path also writes
// `mod:<contact>|<date>|<amount>|<product>` fallback overrides for rows
// without a Salesforce opportunity_id, which look identical structurally
// to the legacy ids. We gate via a tiny `applied_migrations` table so
// these deletes only fire once per database.
const MANAGER_ESTIMATES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS manager_estimates (
    flm_name text NOT NULL,
    month_yyyymm text NOT NULL,
    product text NOT NULL,
    unweighted_amount integer NOT NULL DEFAULT 0,
    updated_at timestamp NOT NULL DEFAULT now(),
    updated_by_name text,
    updated_by_role text,
    PRIMARY KEY (flm_name, month_yyyymm, product)
  );
`;

const APPLIED_MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS applied_migrations (
    name text PRIMARY KEY,
    applied_at timestamp NOT NULL DEFAULT now()
  );
`;

// Per-month compensation rules config (multiplier engine + FUB↔Zpro rule).
// The June reference defaults are seeded separately in code (see
// seedReferenceCompensationConfig) so the JSON stays single-sourced.
const COMPENSATION_CONFIG_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS compensation_config (
    month_yyyymm text PRIMARY KEY,
    multiplier_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
    fub_zpro_rule jsonb NOT NULL DEFAULT '{"enabled":false,"flexFlipStatuses":[],"factor":0.1}'::jsonb,
    updated_at timestamp NOT NULL DEFAULT now(),
    updated_by_name text,
    updated_by_role text
  );
`;

// Task #317: generic cross-opp (paired-opp) rules replace the hardcoded
// FUB↔Zpro pairing and the cancel/rebook churn-suppression. Add the new column
// and relax the legacy fub_zpro_rule column to nullable (the engine no longer
// reads it). Idempotent so existing databases converge.
const COMPENSATION_PAIRED_OPP_RULES_MIGRATION_SQL = `
  ALTER TABLE compensation_config ADD COLUMN IF NOT EXISTS paired_opp_rules jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE compensation_config ALTER COLUMN fub_zpro_rule DROP NOT NULL;
`;

// Task #350: Product Logic engine config. A single global row (id 'global')
// holds the ordered first-match rule set + display-only rename map. The default
// rules are seeded separately in code (see seedProductLogicConfig) so the JSON
// stays single-sourced.
const PRODUCT_LOGIC_CONFIG_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS product_logic_config (
    id text PRIMARY KEY,
    rules jsonb NOT NULL DEFAULT '[]'::jsonb,
    rename_map jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamp NOT NULL DEFAULT now(),
    updated_by_name text,
    updated_by_role text
  );
`;

// Per-rule example opportunity snapshots, persisted so the editor always has a
// concrete example even outside the ~2-month feeder window.
const PRODUCT_LOGIC_EXAMPLES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS product_logic_examples (
    rule_id text PRIMARY KEY,
    fields jsonb NOT NULL DEFAULT '{}'::jsonb,
    source text NOT NULL DEFAULT 'feeder',
    opp_id text,
    account_id text,
    sf_contact_id text,
    sf_cpd_id text,
    captured_at timestamp NOT NULL DEFAULT now()
  );
`;

// Goals tab (Executive → Goals): kv config store, uploaded Goal CSV rows, and
// the finance.pps Databricks snapshot. Seeded config defaults live in code
// (see goals-config.ts) so the JSON stays single-sourced.
const GOAL_CONFIG_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS goal_config (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamp NOT NULL DEFAULT now(),
    updated_by_name text,
    updated_by_role text
  );
`;

const GOAL_CSV_ROWS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS goal_csv_rows (
    id serial PRIMARY KEY,
    month text NOT NULL DEFAULT '',
    "group" text NOT NULL DEFAULT '',
    region text NOT NULL DEFAULT '',
    segment text NOT NULL DEFAULT '',
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    uploaded_at timestamp NOT NULL DEFAULT now(),
    uploaded_by_name text
  );
`;

// Task #290: bring goal_csv_rows to parity with finance.pps — store the raw
// uploaded row verbatim in `data` and drop the seven fixed numeric columns.
// Idempotent column add/drop so existing databases converge to the new shape.
const GOAL_CSV_RAW_DATA_MIGRATION_SQL = `
  ALTER TABLE goal_csv_rows ADD COLUMN IF NOT EXISTS data jsonb;
  UPDATE goal_csv_rows SET data = '{}'::jsonb WHERE data IS NULL;
  ALTER TABLE goal_csv_rows ALTER COLUMN data SET DEFAULT '{}'::jsonb;
  ALTER TABLE goal_csv_rows ALTER COLUMN data SET NOT NULL;
  ALTER TABLE goal_csv_rows DROP COLUMN IF EXISTS sales_mbp_mrr_added_goal;
  ALTER TABLE goal_csv_rows DROP COLUMN IF EXISTS sales_mbp_mrr_lost_goal;
  ALTER TABLE goal_csv_rows DROP COLUMN IF EXISTS sales_sc_mrr_added_goal;
  ALTER TABLE goal_csv_rows DROP COLUMN IF EXISTS sales_sc_mrr_lost_goal;
  ALTER TABLE goal_csv_rows DROP COLUMN IF EXISTS software_mrr_added_goal;
  ALTER TABLE goal_csv_rows DROP COLUMN IF EXISTS software_mrr_lost_goal;
  ALTER TABLE goal_csv_rows DROP COLUMN IF EXISTS minimum_software_goal;
`;

const GOAL_FINANCE_PPS_ROWS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS goal_finance_pps_rows (
    id serial PRIMARY KEY,
    performance_period text NOT NULL DEFAULT '',
    employee_id text NOT NULL DEFAULT '',
    "group" text NOT NULL DEFAULT '',
    data jsonb NOT NULL,
    fetched_at timestamp NOT NULL DEFAULT now()
  );
`;

// Task 467: nightly snapshot of the Databricks eRep-multiplier source. One row
// per (employee_id, month) holding the latest erep_value; replaced wholesale on
// each refresh.
const GOAL_EREP_ROWS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS goal_erep_rows (
    id serial PRIMARY KEY,
    employee_id text NOT NULL DEFAULT '',
    month text NOT NULL DEFAULT '',
    snapshot_date text NOT NULL DEFAULT '',
    erep_value real NOT NULL DEFAULT 1,
    fetched_at timestamp NOT NULL DEFAULT now()
  );
`;

// Per-row overrides for the main Goals table (one row per month/rep/product).
// Defaults mirror the schema: source 'financePps', multipliers 1, LOA
// 'Unavailable'. Enumerated rows without an override row use these code-side
// defaults; only edited rows are persisted here.
const GOAL_ROW_OVERRIDES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS goal_row_overrides (
    month_yyyymm text NOT NULL,
    rep text NOT NULL,
    product text NOT NULL,
    source text NOT NULL DEFAULT 'financePps',
    mrr_added_manual_multiplier real NOT NULL DEFAULT 1,
    mrr_churn_manual_multiplier real NOT NULL DEFAULT 1,
    loa_status text NOT NULL DEFAULT 'Unavailable',
    erep_multiplier real,
    updated_at timestamp NOT NULL DEFAULT now(),
    updated_by_name text,
    updated_by_role text,
    PRIMARY KEY (month_yyyymm, rep, product)
  );
  -- Task 467: the eRep multiplier is now the nullable per-row MANUAL override
  -- (NULL = use the Databricks-sourced value). Relax the legacy NOT NULL/DEFAULT
  -- on databases created before this change.
  ALTER TABLE goal_row_overrides ALTER COLUMN erep_multiplier DROP NOT NULL;
  ALTER TABLE goal_row_overrides ALTER COLUMN erep_multiplier DROP DEFAULT;
`;

// Per-month roster overrides (one row per month/person). All editable fields
// are nullable: NULL means "no override" and the effective hierarchy falls back
// to the base sheet value. `active` is tri-state (NULL = use sheet flag).
const ROSTER_OVERRIDES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS roster_overrides (
    month_yyyymm text NOT NULL,
    identity_key text NOT NULL,
    person text NOT NULL,
    active boolean,
    flm text,
    slm text,
    region text,
    segment text,
    sales_role text,
    updated_at timestamp NOT NULL DEFAULT now(),
    updated_by_name text,
    updated_by_role text,
    PRIMARY KEY (month_yyyymm, identity_key)
  );
`;

// Idempotent migration: earlier builds keyed roster_overrides by (month, person)
// with no identity_key column. Add the column, backfill it from the existing
// person name (best-effort name-fallback identity), and repoint the primary key
// to (month, identity_key). All statements are individually idempotent so this
// is safe to run every boot whether the table is old- or new-shaped.
const ROSTER_OVERRIDES_IDENTITY_KEY_MIGRATION_SQL = `
  ALTER TABLE roster_overrides ADD COLUMN IF NOT EXISTS identity_key text;
  UPDATE roster_overrides SET identity_key = 'name:' || person WHERE identity_key IS NULL;
  ALTER TABLE roster_overrides ALTER COLUMN identity_key SET NOT NULL;
  ALTER TABLE roster_overrides DROP CONSTRAINT IF EXISTS roster_overrides_pkey;
  ALTER TABLE roster_overrides ADD CONSTRAINT roster_overrides_pkey PRIMARY KEY (month_yyyymm, identity_key);
`;

const TASK_153_MIGRATION_NAME = "task_153_sched_mods_databricks_cleanup";
const TASK_280_MIGRATION_NAME = "task_280_software_pct_gnr_acq_split";
const TASK_290_MIGRATION_NAME = "task_290_goal_csv_raw_data";
const TASK_343_MIGRATION_NAME = "task_343_paired_opp_rules_identity_reset";
const TASK_382_MIGRATION_NAME = "task_382_canonicalize_opp_override_keys";
// v2: the v1 marker may have been recorded by an earlier build whose traversal
// walked the wrong JSON shape (rule.conditions instead of rule.opps[].conditions),
// so it marked itself applied without normalizing anything. Use a fresh marker so
// the corrected traversal re-processes every row exactly once.
const TASK_411_MIGRATION_NAME = "task_411_comparative_sided_signed_factor_op_v2";
const TASK_467_MIGRATION_NAME = "task_467_erep_default_to_null";

type Task382OverrideRow = {
  opp_id: string;
  probability: number;
  updated_by_name: string | null;
  reviewed_at: Date | null;
  updated_at: Date | null;
};

// Task #393: raw upstream data snapshots for per-user dashboard rollback.
// Partial unique indexes enforce exactly one `last_good_refresh` row and one
// `nightly` row per Pacific calendar date.
const DATA_SNAPSHOTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS data_snapshots (
    id serial PRIMARY KEY,
    kind text NOT NULL,
    snapshot_date text,
    captured_at timestamptz NOT NULL DEFAULT now(),
    pipeline_row_count integer NOT NULL DEFAULT 0,
    payload jsonb NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS data_snapshots_good_uniq
    ON data_snapshots (kind) WHERE kind = 'last_good_refresh';
  CREATE UNIQUE INDEX IF NOT EXISTS data_snapshots_nightly_date_uniq
    ON data_snapshots (snapshot_date) WHERE kind = 'nightly';
`;

export async function runStartupMigrations(): Promise<void> {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(CORE_TABLES_SQL);
    await client.query(ROLE_CHECK_SQL);
    await client.query(REVIEWED_AT_COLUMN_SQL);
    await client.query(MANAGER_ESTIMATES_TABLE_SQL);
    await client.query(COMPENSATION_CONFIG_TABLE_SQL);
    await client.query(COMPENSATION_PAIRED_OPP_RULES_MIGRATION_SQL);
    await client.query(PRODUCT_LOGIC_CONFIG_TABLE_SQL);
    await client.query(PRODUCT_LOGIC_EXAMPLES_TABLE_SQL);
    await client.query(GOAL_CONFIG_TABLE_SQL);
    await client.query(GOAL_CSV_ROWS_TABLE_SQL);
    await client.query(GOAL_CSV_RAW_DATA_MIGRATION_SQL);
    await client.query(GOAL_FINANCE_PPS_ROWS_TABLE_SQL);
    await client.query(GOAL_EREP_ROWS_TABLE_SQL);
    await client.query(GOAL_ROW_OVERRIDES_TABLE_SQL);
    await client.query(ROSTER_OVERRIDES_TABLE_SQL);
    await client.query(ROSTER_OVERRIDES_IDENTITY_KEY_MIGRATION_SQL);
    await client.query(DATA_SNAPSHOTS_TABLE_SQL);
    await client.query(APPLIED_MIGRATIONS_SQL);

    // Idempotent: only run the destructive cleanup once. After the first
    // successful run the marker row blocks subsequent attempts so we never
    // wipe new-format mod fallback overrides written between boots.
    const alreadyApplied = await client.query<{ name: string }>(
      "SELECT name FROM applied_migrations WHERE name = $1",
      [TASK_153_MIGRATION_NAME],
    );
    let legacyModRows = 0;
    let legacyStageRows = 0;
    if (alreadyApplied.rowCount === 0) {
      const legacyMods = await client.query(
        `DELETE FROM opp_probability_overrides
         WHERE opp_id LIKE 'mod:%' AND opp_id NOT LIKE 'mod:opp:%'
         RETURNING opp_id`,
      );
      const legacyStage = await client.query(
        `DELETE FROM stage_default_probabilities
         WHERE stage = 'Scheduled Mods'
         RETURNING stage`,
      );
      await client.query(
        "INSERT INTO applied_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
        [TASK_153_MIGRATION_NAME],
      );
      legacyModRows = legacyMods.rowCount ?? 0;
      legacyStageRows = legacyStage.rowCount ?? 0;
    }

    // Task 280: split the single "Software % Rules" source into two independent
    // rule sets — GNR (seeded from the existing config) and ACQ (code defaults).
    // Idempotent via the marker: rename the persisted GNR config key and any
    // override rows that still point at the legacy source. ACQ needs no row; it
    // falls back to the code default until edited.
    let renamedGnrConfig = 0;
    let renamedGnrOverrides = 0;
    const task280Applied = await client.query<{ name: string }>(
      "SELECT name FROM applied_migrations WHERE name = $1",
      [TASK_280_MIGRATION_NAME],
    );
    if (task280Applied.rowCount === 0) {
      const cfg = await client.query(
        `UPDATE goal_config SET key = 'softwareGnrRules'
         WHERE key = 'softwarePctRules'
           AND NOT EXISTS (
             SELECT 1 FROM goal_config existing WHERE existing.key = 'softwareGnrRules'
           )
         RETURNING key`,
      );
      const ovr = await client.query(
        `UPDATE goal_row_overrides SET source = 'softwareGnr'
         WHERE source = 'softwarePct'
         RETURNING rep`,
      );
      await client.query(
        "INSERT INTO applied_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
        [TASK_280_MIGRATION_NAME],
      );
      renamedGnrConfig = cfg.rowCount ?? 0;
      renamedGnrOverrides = ovr.rowCount ?? 0;
    }

    // Task 290: the old goal_csv_rows held seven fixed numeric columns that
    // cannot be reconstructed into the new raw `data` map, so any pre-migration
    // rows are wiped once to force a one-time re-upload under the new format.
    // Gated via the marker so it never re-wipes freshly uploaded rows.
    let task290RowsWiped = 0;
    const task290Applied = await client.query<{ name: string }>(
      "SELECT name FROM applied_migrations WHERE name = $1",
      [TASK_290_MIGRATION_NAME],
    );
    if (task290Applied.rowCount === 0) {
      const wiped = await client.query("DELETE FROM goal_csv_rows RETURNING id");
      await client.query(
        "INSERT INTO applied_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
        [TASK_290_MIGRATION_NAME],
      );
      task290RowsWiped = wiped.rowCount ?? 0;
    }

    // Task 343: paired-opp rules dropped the global linkFields shape and folded
    // joins into per-opp identity comparative conditions. Legacy rule JSON is not
    // mechanically convertible, so any pre-migration rules are reset once to force
    // re-authoring under the new model. Gated via the marker so it never re-wipes
    // freshly authored rules.
    let task343RulesReset = 0;
    const task343Applied = await client.query<{ name: string }>(
      "SELECT name FROM applied_migrations WHERE name = $1",
      [TASK_343_MIGRATION_NAME],
    );
    if (task343Applied.rowCount === 0) {
      const reset = await client.query(
        `UPDATE compensation_config SET paired_opp_rules = '[]'::jsonb
         WHERE paired_opp_rules <> '[]'::jsonb
         RETURNING month_yyyymm`,
      );
      await client.query(
        "INSERT INTO applied_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
        [TASK_343_MIGRATION_NAME],
      );
      task343RulesReset = reset.rowCount ?? 0;
    }

    // Task 382: the dash now canonicalizes every Salesforce opp id up to its
    // 18-char form at ingestion. Stored override / reviewed-flag rows keyed by
    // the legacy 15-char id would otherwise drift from the live 18-char ids
    // (orphaning reviews, breaking deletes and the weekly reset). Rewrite each
    // bare-15-char key to 18-char ONCE, merging any 15/18 collision onto a
    // single 18-char row (prefer the reviewed row, then the most recently
    // updated). Synthetic / composite keys (`mod:`, `me:`, `mgr_est:`, …) are
    // left untouched by canonicalizeOppId. Gated via the marker so it never
    // re-runs.
    let task382KeysCanonicalized = 0;
    const task382Applied = await client.query<{ name: string }>(
      "SELECT name FROM applied_migrations WHERE name = $1",
      [TASK_382_MIGRATION_NAME],
    );
    if (task382Applied.rowCount === 0) {
      const all = await client.query<Task382OverrideRow>(
        `SELECT opp_id, probability, updated_by_name, reviewed_at, updated_at
         FROM opp_probability_overrides`,
      );
      const groups = new Map<string, Task382OverrideRow[]>();
      for (const r of all.rows) {
        const canon = canonicalizeOppId(r.opp_id);
        const bucket = groups.get(canon);
        if (bucket) bucket.push(r);
        else groups.set(canon, [r]);
      }
      for (const [canon, rows] of groups) {
        // Skip groups already fully canonical (synthetic/composite/18-char).
        if (rows.every((r: Task382OverrideRow) => r.opp_id === canon)) continue;
        const auth = rows.slice().sort((a: Task382OverrideRow, b: Task382OverrideRow) => {
          const ar = a.reviewed_at ? 1 : 0;
          const br = b.reviewed_at ? 1 : 0;
          if (ar !== br) return br - ar;
          const at = a.updated_at ? new Date(a.updated_at).getTime() : 0;
          const bt = b.updated_at ? new Date(b.updated_at).getTime() : 0;
          return bt - at;
        })[0];
        const oldIds = rows.map((r) => r.opp_id);
        await client.query(
          "DELETE FROM opp_probability_overrides WHERE opp_id = ANY($1)",
          [oldIds],
        );
        await client.query(
          `INSERT INTO opp_probability_overrides
             (opp_id, probability, updated_by_name, reviewed_at, updated_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            canon,
            auth.probability,
            auth.updated_by_name,
            auth.reviewed_at,
            auth.updated_at ?? new Date(),
          ],
        );
        task382KeysCanonicalized += rows.filter((r) => r.opp_id !== canon).length;
      }
      await client.query(
        "INSERT INTO applied_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
        [TASK_382_MIGRATION_NAME],
      );
    }

    // Task 411: the Comparative condition builder replaced the single `signed`
    // toggle with per-side `leftSigned`/`rightSigned` flags and the fixed `×`
    // multiplier with a `factorOp` math operator. Normalize stored rule configs
    // ONCE so legacy `signed:true` materializes as both sides Actual (signed),
    // legacy absent/false as both sides Absolute (abs), and any condition with a
    // scalar gets the explicit multiply operator. The engine already tolerates
    // the old shape, so this is purely for data cleanliness; gated via the
    // marker so it never re-touches freshly authored rules.
    let task411RulesNormalized = 0;
    const task411Applied = await client.query<{ name: string }>(
      "SELECT name FROM applied_migrations WHERE name = $1",
      [TASK_411_MIGRATION_NAME],
    );
    if (task411Applied.rowCount === 0) {
      const rows = await client.query<{
        month_yyyymm: string;
        paired_opp_rules: unknown;
      }>("SELECT month_yyyymm, paired_opp_rules FROM compensation_config");
      for (const row of rows.rows) {
        const rules = row.paired_opp_rules;
        // Shared traversal with the engine: comparatives live under
        // rule.opps[].conditions. Mutates `rules` in place, returns whether
        // anything changed.
        const changed = normalizeComparativeSidedFactorOp(rules);
        if (changed) {
          await client.query(
            "UPDATE compensation_config SET paired_opp_rules = $1 WHERE month_yyyymm = $2",
            [JSON.stringify(rules), row.month_yyyymm],
          );
          task411RulesNormalized += 1;
        }
      }
      await client.query(
        "INSERT INTO applied_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
        [TASK_411_MIGRATION_NAME],
      );
    }

    // Task 467: the eRep multiplier became the nullable per-row MANUAL override
    // (NULL = use the Databricks-sourced value). Rows that still carry the old
    // untouched default of 1.0 are indistinguishable from an explicit 1.0, so
    // per the task they are all reset to NULL once to hand control to Databricks.
    // Gated via the marker so a freshly-set manual 1.0 is never wiped on reboot.
    let task467ErepDefaultsNulled = 0;
    const task467Applied = await client.query<{ name: string }>(
      "SELECT name FROM applied_migrations WHERE name = $1",
      [TASK_467_MIGRATION_NAME],
    );
    if (task467Applied.rowCount === 0) {
      const nulled = await client.query(
        `UPDATE goal_row_overrides SET erep_multiplier = NULL
         WHERE erep_multiplier = 1
         RETURNING rep`,
      );
      await client.query(
        "INSERT INTO applied_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
        [TASK_467_MIGRATION_NAME],
      );
      task467ErepDefaultsNulled = nulled.rowCount ?? 0;
    }

    const backfill = INTERNAL_EMAIL_DOMAIN
      ? await client.query<{ id: string; email: string }>(
          INTERNAL_VIEWER_BACKFILL_SQL,
          [`%${INTERNAL_EMAIL_DOMAIN}`],
        )
      : { rowCount: 0, rows: [] as { id: string; email: string }[] };
    const execBackfill = await client.query<{ id: string; email: string }>(
      EXEC_ROLE_BACKFILL_SQL,
      [[...EXEC_EMAILS]],
    );
    await client.query("COMMIT");
    logger.info(
      {
        roleCheckUpdated: true,
        reviewedAtColumnAdded: true,
        managerEstimatesTableEnsured: true,
        compensationConfigTableEnsured: true,
        goalTablesEnsured: true,
        task153CleanupRanThisBoot: alreadyApplied.rowCount === 0,
        legacyModOverridesDeleted: legacyModRows,
        legacyModsStageDeleted: legacyStageRows,
        task280SplitRanThisBoot: task280Applied.rowCount === 0,
        softwareGnrConfigRenamed: renamedGnrConfig,
        softwareGnrOverridesRenamed: renamedGnrOverrides,
        task290RawDataRanThisBoot: task290Applied.rowCount === 0,
        task290GoalCsvRowsWiped: task290RowsWiped,
        task343RulesResetRanThisBoot: task343Applied.rowCount === 0,
        task343PairedOppRulesReset: task343RulesReset,
        task382KeysCanonicalizedRanThisBoot: task382Applied.rowCount === 0,
        task382OppOverrideKeysCanonicalized: task382KeysCanonicalized,
        task411NormalizeRanThisBoot: task411Applied.rowCount === 0,
        task411PairedRuleConfigsNormalized: task411RulesNormalized,
        task467ErepDefaultsRanThisBoot: task467Applied.rowCount === 0,
        task467ErepDefaultsNulled,
        internalViewersBackfilled: backfill.rowCount ?? 0,
        backfilledEmails: backfill.rows.map((r) => r.email),
        execRolesBackfilled: execBackfill.rowCount ?? 0,
        execBackfilledEmails: execBackfill.rows.map((r) => r.email),
      },
      "Startup migrations applied",
    );
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    logger.error({ err }, "Startup migrations failed (continuing boot)");
  } finally {
    if (client) client.release();
  }
}
