import app from "./app";
import { logger } from "./lib/logger";
import { startNightlySync } from "./lib/photo-sync";
import { runStartupMigrations } from "./lib/startup-migrations";
import { seedReferenceCompensationConfig } from "./lib/compensation";
import {
  seedProductLogicConfig,
  loadActiveProductLogicConfig,
} from "./lib/product-logic";
import { ensureFinancePpsSnapshot } from "./lib/goals-finance-pps";
import { ensureErepSnapshot } from "./lib/goals-erep";
import { startNightlySnapshotScheduler } from "./lib/data-snapshots";
import {
  isDemoMode,
  DEMO_TODAY,
  verifyDemoStructuralNames,
} from "./lib/demo-mode";
import { ensureDemoSeed } from "./lib/demo-seed";
import { withDemoBaselineSession } from "./lib/demo-session";
import { getLivePipelineData } from "./lib/sheets-data";

function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

// Global safety net. A rejected promise or thrown error from a background
// startup task (prod DB / Databricks / Slack) must never take down the whole
// process — without these handlers Node 24 terminates on the first unhandled
// rejection, which kills the server ~1s into boot before the autoscale startup
// health probe at /api/healthz can ever return 200, so the deploy never
// promotes. We log the full stack and keep serving.
process.on("unhandledRejection", (reason) => {
  logger.error(
    { err: describeError(reason) },
    "Unhandled promise rejection — keeping process alive",
  );
});
process.on("uncaughtException", (err) => {
  logger.error(
    { err: describeError(err) },
    "Uncaught exception — keeping process alive",
  );
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Run a single startup task, logging (never rethrowing) any failure so one
// failing task can't abort the rest of boot or escape as a fatal unhandled
// rejection. Each task is attributed by name so the offender is identifiable
// in production logs.
async function runStartupTask(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.error(
      { task: name, err: describeError(err) },
      "Startup task failed (continuing boot)",
    );
  }
}

app.listen(port, () => {
  logger.info({ port, demoMode: isDemoMode() }, "Server listening");
  // Fire startup work from a self-contained guarded chain so the listen
  // callback itself never returns a rejecting promise.
  void (async () => {
    await runStartupTask("runStartupMigrations", runStartupMigrations);
    await runStartupTask(
      "seedReferenceCompensationConfig",
      seedReferenceCompensationConfig,
    );
    await runStartupTask("seedProductLogicConfig", seedProductLogicConfig);

    // Demo mode: the whole upstream layer is served from the bundled snapshot
    // and the DB layer from the bundled seed, so every task below that would
    // reach Google / Databricks / Slack / object storage is skipped. The live
    // path is untouched.
    if (isDemoMode()) {
      logger.info(
        { demoToday: DEMO_TODAY },
        "[Demo] DEMO_MODE active — skipping all live upstream startup tasks",
      );
      await runStartupTask("verifyDemoStructuralNames", async () =>
        verifyDemoStructuralNames(),
      );
      await runStartupTask("ensureDemoSeed", ensureDemoSeed);
      // Product-logic config is seeded above; load it AFTER the demo seed so
      // the fixture's config (not the code defaults) becomes active.
      await runStartupTask(
        "loadActiveProductLogicConfig",
        loadActiveProductLogicConfig,
      );
      // Pre-warm the shared-baseline pipeline caches for the dashboard's
      // default view (frozen month, full-month window, both revenue modes) so
      // the first visitor after a cold start gets data immediately instead of
      // waiting out a multi-minute compute on a small instance. Clean demo
      // sessions share the same baseline cache scope, so this single compute
      // serves every visitor until they make their first edit. Runs after
      // listen(), so requests are served during the warm — a visitor's own
      // request for the same view coalesces onto this in-flight compute.
      await runStartupTask("warmDemoBaselinePipeline", async () => {
        const [y, m] = DEMO_TODAY.split("-").map(Number);
        const from = `${y}-${String(m).padStart(2, "0")}-01`;
        const lastDay = new Date(y!, m!, 0).getDate();
        const to = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
        const window = { from, to };
        await withDemoBaselineSession(async () => {
          const started = Date.now();
          await getLivePipelineData(window, "closeDate", window, "quota");
          await getLivePipelineData(window, "closeDate", window, "sales");
          logger.info(
            { from, to, ms: Date.now() - started },
            "[Demo] Baseline pipeline caches warmed",
          );
        });
      });
      return;
    }

    await runStartupTask(
      "loadActiveProductLogicConfig",
      loadActiveProductLogicConfig,
    );
    await runStartupTask("ensureFinancePpsSnapshot", ensureFinancePpsSnapshot);
    await runStartupTask("ensureErepSnapshot", ensureErepSnapshot);
    await runStartupTask("startNightlySync", startNightlySync);
    await runStartupTask(
      "startNightlySnapshotScheduler",
      startNightlySnapshotScheduler,
    );
  })();
});
