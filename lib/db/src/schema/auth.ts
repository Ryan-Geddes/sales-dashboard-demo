import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, primaryKey, real, timestamp, varchar } from "drizzle-orm/pg-core";

// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const sessionsTable = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const usersTable = pgTable(
  "users",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    email: varchar("email").unique(),
    firstName: varchar("first_name"),
    lastName: varchar("last_name"),
    profileImageUrl: varchar("profile_image_url"),
    // role is one of "guest" | "rep" | "flm" | "slm" | "exec" | "admin" |
    // "viewer", or null when the user is signed in but not yet provisioned in
    // the sales hierarchy and not on the internal email domain. "guest" is a
    // read-only role used by the "Continue without signing in" option.
    // "viewer" is auto-assigned to logged-in internal-domain employees (see
    // INTERNAL_EMAIL_DOMAIN) who are not in the
    // Sales Hierarchy and not on the admin list — they get org-wide read
    // access identical to a `rep` but cannot mutate any data. "exec" is a
    // leadership role outside the Sales Hierarchy that mirrors SLM privileges
    // with org-wide scope.
    role: varchar("role"),
    // The full name as it appears in the Sheets sales hierarchy. Used to
    // resolve org relationships from the user's email at sign-in time.
    hierarchyName: varchar("hierarchy_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "users_role_check",
      sql`${table.role} IS NULL OR ${table.role} IN ('guest', 'rep', 'flm', 'slm', 'exec', 'admin', 'viewer')`,
    ),
  ],
);

export type UpsertUser = typeof usersTable.$inferInsert;
export type User = typeof usersTable.$inferSelect;

// Per-user JSON preferences. Stores arbitrary client-controlled UI state
// (filter sets, default views, etc). Not for shared business state.
export const userPreferencesTable = pgTable(
  "user_preferences",
  {
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    key: varchar("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })],
);

export type UserPreference = typeof userPreferencesTable.$inferSelect;

// Per-rep coverage target multiple. Keyed by hierarchy_name so it works for
// reps regardless of whether they have a Replit account. SLMs/Admins edit
// these from the Forecast drilldown header in the Pipeline view.
export const repCoverageTargetsTable = pgTable(
  "rep_coverage_targets",
  {
    hierarchyName: varchar("hierarchy_name").primaryKey(),
    coverageTarget: real("coverage_target").notNull().default(3.5),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export type RepCoverageTarget = typeof repCoverageTargetsTable.$inferSelect;
