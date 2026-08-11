import path from "path";
import { Router, type IRouter } from "express";
import {
  getLiveSalesConfig,
  getLivePipelineData,
  getLiveActivityData,
  getLiveActionsData,
  invalidateCache,
  refreshCacheInBackground,
  getUnmappedStages,
  getOpportunitiesByFunnelStage,
  getOpportunitiesByType,
  getDemos,
  getSbrRecords,
  getModsOpportunities,
  getAnaplanCheck,
  getCallRecords,
  getEmailRecords,
  getOppsCreated,
  getActivityByRep,
  getRecentParseErrors,
  clearParseErrors,
  fetchFeederIndex,
  getCompensationSummary,
  getRuleAffectedOpportunities,
  buildCompTestContext,
  buildCompTestContextMulti,
  buildProductLogicTestContext,
  sanitizeRawConditions,
  type RevenueMode,
  type RawCondition,
} from "../lib/sheets-data";
import {
  getCompensationConfig,
  upsertCompensationConfig,
  validateMultiplierRules,
  validatePairedOppRules,
  isValidMonthKey,
  currentCompMonthKey,
  diagnoseMultiplierRule,
  diagnosePairedRuleForOpp,
  diagnosePairedRuleForOpps,
  rowMatchesAllConditions,
  testConditionsAgainstRow,
  type CompMultiplierRule,
  type PairedOppRule,
  type CompConditionTestStatus,
} from "../lib/compensation";
import {
  getProductLogicConfig,
  upsertProductLogicConfig,
  validateProductLogicRules,
  validateRenameMap,
  getProductLogicExamples,
} from "../lib/product-logic";
import { getPhotoMap, getPhotoBuffer, syncPhotos } from "../lib/photo-sync";
import { isDemoMode } from "../lib/demo-mode";
import { requireRole, requireWritable, isAdmin, isAdminOrSlm } from "../middlewares/requireRole";
import { db } from "@workspace/db";
import {
  contestsTable,
  oppProbabilityOverridesTable,
  stageDefaultProbabilitiesTable,
  usersTable,
  repCoverageTargetsTable,
  HARDCODED_STAGE_DEFAULTS,
} from "@workspace/db/schema";
import { eq, desc, inArray, isNotNull, sql } from "drizzle-orm";
import { invalidateProbabilityCaches, getStageDefaultProbabilities, getOppProbabilityOverrides } from "../lib/probabilities";
import { canonicalizeOppId } from "../lib/sf-id";
import { sendContestNotification } from "../lib/contest-email";
import { fetchUsHolidays } from "../lib/databricks-holidays";
import { listSnapshots } from "../lib/data-snapshots";

const router: IRouter = Router();

// Task #254/#344: Revenue Mode is open to all authenticated users. Honor a
// ?revenueMode=sales query param (Sales Target Revenue) for anyone; any other
// value falls back to "quota" (Quota Target Revenue, the compensable default).
function resolveRevenueMode(req: { query: any; user?: { role?: string | null } }): RevenueMode {
  return (req.query.revenueMode as string) === "sales" ? "sales" : "quota";
}

// Task #484: "eReps Override" toggle. When the client passes `eRepOverride=1`,
// every rep's effective eRep multiplier is forced to 1 in the displayed
// pipeline/quota/forecast goals. Open to all Pipeline viewers (no extra gate);
// the default (absent/anything else) keeps the standard eRep-applied goals.
function resolveERepOverride(req: { query: any }): boolean {
  return req.query.eRepOverride === "1" || req.query.eRepOverride === "true";
}

// Task #361: admin-only "Conditions" filter. The client passes a JSON array of
// `{ field, value }` pairs in the `rawConditions` query param. We honor it ONLY
// for admins; every other role (and malformed payloads) yields an empty list so
// the param is silently ignored server-side regardless of what the client sends.
function resolveRawConditions(req: { query: any; user?: { role?: string | null } }): RawCondition[] {
  if (req.user?.role !== "admin") return [];
  const raw = req.query.rawConditions;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    return sanitizeRawConditions(JSON.parse(raw));
  } catch {
    return [];
  }
}

router.get("/sales/config", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (req, res): Promise<void> => {
  try {
    // Optional `month` (YYYY-MM) makes the selector lists month-aware so
    // per-month roster overrides surface in the dropdowns. Ignored when absent
    // or malformed (falls back to the base hierarchy).
    const month = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month)
      ? req.query.month
      : undefined;
    const data = await getLiveSalesConfig(month);
    res.json(data);
  } catch (e: any) {
    console.error("Config fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch config" });
  }
});

router.get("/sales/pipeline", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (req, res): Promise<void> => {
  try {
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const pipelineMode = (req.query.pipelineMode as string) === "allOpen" ? "allOpen" as const : "closeDate" as const;
    const modsFrom = req.query.modsFrom as string | undefined;
    const modsTo = req.query.modsTo as string | undefined;
    const dateFilter = (from || to) ? { from, to } : undefined;
    const modsDateFilter = (modsFrom || modsTo) ? { from: modsFrom, to: modsTo } : undefined;
    const revenueMode = resolveRevenueMode(req);
    const rawConditions = resolveRawConditions(req);
    const eRepOverride = resolveERepOverride(req);
    const data = await getLivePipelineData(dateFilter, pipelineMode, modsDateFilter, revenueMode, rawConditions, eRepOverride);
    res.json(data);
  } catch (e: any) {
    console.error("Pipeline fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch pipeline data" });
  }
});

router.get("/sales/activity", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (_req, res): Promise<void> => {
  try {
    const data = await getLiveActivityData();
    res.json(data);
  } catch (e: any) {
    console.error("Activity fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch activity data" });
  }
});

router.get("/sales/actions", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (_req, res): Promise<void> => {
  try {
    const data = await getLiveActionsData();
    res.json(data);
  } catch (e: any) {
    console.error("Actions fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch actions data" });
  }
});

router.get("/sales/stage-mapping", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (_req, res): Promise<void> => {
  try {
    await getLivePipelineData();
    const mapping = {
      stages: [
        { funnel: "Discovery", raw: ["Discovery", "New", "Discover", "Engage", "Influence", "Zips Added"] },
        { funnel: "Demo Scheduled", raw: ["Demo Scheduled", "Demo Performed", "Presentation"] },
        { funnel: "Proposal/Negotiation", raw: ["Proposal/Negotiation", "Advance", "Committed to Purchase"] },
        { funnel: "Paperwork Sent", raw: ["Paperwork Sent", "Contract Sent"] },
        { funnel: "Awaiting Payment", raw: ["Awaiting Payment"] },
        { funnel: "Closed Won", raw: ["Closed Won", "Closed: Won"] },
        { funnel: "Closed Lost", raw: ["Closed Lost", "Closed Waitlist"] },
      ],
      unmapped: getUnmappedStages(),
      defaultBucket: "Discovery",
    };
    res.json(mapping);
  } catch (e: any) {
    res.status(500).json({ error: "Failed to get stage mapping" });
  }
});

router.get("/sales/opportunities", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (req, res): Promise<void> => {
  try {
    const stage = req.query.stage as string;
    const type = req.query.type as string;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const dateFilter = (from || to) ? { from, to } : undefined;
    const revenueMode = resolveRevenueMode(req);
    const rawConditions = resolveRawConditions(req);
    if (stage) {
      const pipelineMode = (req.query.pipelineMode as string) === "allOpen" ? "allOpen" : "closeDate";
      const data = await getOpportunitiesByFunnelStage(stage, dateFilter, pipelineMode, revenueMode, rawConditions);
      res.json(data);
    } else if (type === "mrr" || type === "churn") {
      const unattributedOnly = req.query.unattributed === "1" || req.query.unattributed === "true";
      // Task #483: drilldowns that only need Closed Won rows (the ACQ Closed Won
      // funnel drilldown + every Churn drilldown) pass closedWon=1 so the server
      // returns only that slice. The full org MRR set otherwise trips the
      // deployment proxy's response-size limit and surfaces as a browser-side
      // failure while the origin returns 200 (same failure class as #380).
      const closedWonOnly = req.query.closedWon === "1" || req.query.closedWon === "true";
      const data = await getOpportunitiesByType(type, dateFilter, revenueMode, rawConditions, unattributedOnly, closedWonOnly);
      res.json(data);
    } else if (type === "mods") {
      const data = await getModsOpportunities(dateFilter, rawConditions);
      res.json(data);
    } else {
      res.status(400).json({ error: "Missing stage or type query parameter" });
    }
  } catch (e: any) {
    console.error("Opportunities fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch opportunities" });
  }
});

router.get("/sales/anaplan", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (req, res): Promise<void> => {
  try {
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const dateFilter = (from || to) ? { from, to } : undefined;
    const rawConditions = resolveRawConditions(req);
    const data = await getAnaplanCheck(dateFilter, rawConditions);
    res.json(data);
  } catch (e: any) {
    console.error("Anaplan check fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch Anaplan check data" });
  }
});

router.get("/sales/opps-created", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (req, res): Promise<void> => {
  try {
    const timeframe = req.query.timeframe as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const data = await getOppsCreated(timeframe, from, to);
    res.json(data);
  } catch (e: any) {
    console.error("Opps created fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch opps created" });
  }
});

router.get("/sales/demos", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (req, res): Promise<void> => {
  try {
    const timeframe = req.query.timeframe as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const data = await getDemos(timeframe, from, to);
    res.json(data);
  } catch (e: any) {
    console.error("Demos fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch demos" });
  }
});

router.get("/sales/sbrs", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (req, res): Promise<void> => {
  try {
    const timeframe = req.query.timeframe as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const data = await getSbrRecords(timeframe, from, to);
    res.json(data);
  } catch (e: any) {
    console.error("SBRs fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch SBR records" });
  }
});

router.get("/sales/calls", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (req, res): Promise<void> => {
  try {
    const type = req.query.type as string;
    if (type !== "dials" && type !== "convos") {
      res.status(400).json({ error: "type must be 'dials' or 'convos'" });
      return;
    }
    const timeframe = req.query.timeframe as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const data = await getCallRecords(type, timeframe, from, to);
    res.json(data);
  } catch (e: any) {
    console.error("Calls fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch call records" });
  }
});

router.get("/sales/emails", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (req, res): Promise<void> => {
  try {
    const timeframe = req.query.timeframe as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const data = await getEmailRecords(timeframe, from, to);
    res.json(data);
  } catch (e: any) {
    console.error("Emails fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch email records" });
  }
});

router.get("/sales/activity-by-rep", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (req, res): Promise<void> => {
  try {
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const productsParam = req.query.products;
    const products = Array.isArray(productsParam)
      ? productsParam.map(p => String(p))
      : (typeof productsParam === "string" && productsParam.length > 0 ? [productsParam] : []);
    const data = await getActivityByRep(from, to, products);
    res.json(data);
  } catch (e: any) {
    console.error("Activity-by-rep fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch activity-by-rep" });
  }
});

router.post("/sales/refresh", requireRole("admin"), requireWritable(), async (_req, res): Promise<void> => {
  try {
    clearParseErrors();
    refreshCacheInBackground();
    res.json({ success: true, mode: "background" });
  } catch (e: any) {
    console.error("Refresh error:", e.message);
    res.status(500).json({ error: "Failed to refresh" });
  }
});

router.get("/sales/parse-errors", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (_req, res): Promise<void> => {
  res.json({ errors: getRecentParseErrors() });
});

// Task #393: list available data snapshots for the per-user rollback dropdown.
router.get("/sales/snapshots", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (_req, res): Promise<void> => {
  try {
    const snapshots = await listSnapshots();
    res.json(snapshots);
  } catch (e: any) {
    console.error("[Snapshots] list error:", e?.message ?? e);
    res.status(500).json({ error: "Failed to list snapshots" });
  }
});

router.get("/sales/us-holidays", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (_req, res): Promise<void> => {
  try {
    const result = await fetchUsHolidays();
    res.json(result);
  } catch (e: any) {
    console.error("Holidays fetch error:", e?.message ?? e);
    res.status(500).json({ holidays: [], fetchError: true, fetchErrorMessage: e?.message ?? "Failed to fetch holidays" });
  }
});

router.get("/sales/feeder-index", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (_req, res): Promise<void> => {
  try {
    const rows = await fetchFeederIndex();
    res.json({ sheets: rows });
  } catch (e: any) {
    console.error("[FeederIndex] Error:", e.message);
    res.status(500).json({ error: "Failed to fetch feeder index" });
  }
});

router.get("/sales/photos", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (_req, res): Promise<void> => {
  try {
    // Demo mode: no Slack, no object storage. An empty map makes every avatar
    // fall through to the frontend's initials placeholder.
    if (isDemoMode()) {
      res.json({ photos: {} });
      return;
    }
    const photos = await getPhotoMap();
    res.json({ photos });
  } catch (e: unknown) {
    console.error("Photos fetch error:", e instanceof Error ? e.message : e);
    res.status(500).json({ error: "Failed to fetch photos" });
  }
});

router.get("/sales/photos/static/:filename", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), (req, res): void => {
  // Demo mode: the bundled static headshots are real people — 404 so the
  // frontend renders its initials avatar instead.
  if (isDemoMode()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const filename = String(req.params.filename).replace(/[^a-zA-Z0-9._-]/g, "");
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  const filePath = path.resolve(currentDir, "..", "..", "public", "photos", filename);
  res.set("Cache-Control", "public, max-age=604800");
  res.sendFile(filePath, (err) => {
    if (err) res.status(404).json({ error: "Not found" });
  });
});

router.get("/sales/photos/image/:key", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (req, res): Promise<void> => {
  try {
    // Demo mode: never touch object storage.
    if (isDemoMode()) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    const result = await getPhotoBuffer(String(req.params.key));
    if (!result) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    res.set("Content-Type", result.contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(result.buffer);
  } catch (e: unknown) {
    console.error("Photo image error:", e instanceof Error ? e.message : e);
    res.status(500).json({ error: "Failed to fetch photo" });
  }
});

router.post("/sales/photos/sync", requireRole("admin"), requireWritable(), async (_req, res): Promise<void> => {
  try {
    // Demo mode: no Slack, no object storage — nothing to sync.
    if (isDemoMode()) {
      res.status(404).json({ error: "Photo sync is disabled in demo mode" });
      return;
    }
    const result = await syncPhotos(true);
    res.json(result);
  } catch (e: unknown) {
    console.error("Photo sync error:", e instanceof Error ? e.message : e);
    res.status(500).json({ error: "Failed to sync photos" });
  }
});

router.get("/sales/contests", requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"), async (_req, res): Promise<void> => {
  try {
    const contests = await db.select().from(contestsTable).orderBy(desc(contestsTable.createdAt));
    res.json({ contests });
  } catch (e: any) {
    console.error("Contests fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch contests" });
  }
});

router.post("/sales/contests", requireRole("flm", "slm", "exec", "admin"), requireWritable(), async (req, res): Promise<void> => {
  try {
    const session = {
      name: req.user!.hierarchyName || `${req.user!.firstName ?? ""} ${req.user!.lastName ?? ""}`.trim() || (req.user!.email ?? ""),
      role: req.user!.role!,
    };
    const { title, objective, metric, product, startDate, endDate, eligibility, incentiveStructure, rewardDetails, scope } = req.body;
    if (!title || !metric || !startDate || !endDate) {
      res.status(400).json({ error: "Title, metric, startDate, and endDate are required" });
      return;
    }

    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();
    if (isNaN(startMs) || isNaN(endMs)) {
      res.status(400).json({ error: "Invalid date format" });
      return;
    }
    if (startMs > endMs) {
      res.status(400).json({ error: "Start date must be before end date" });
      return;
    }

    const contest = await db.insert(contestsTable).values({
      title,
      objective: objective || null,
      metric,
      product: product || null,
      startDate,
      endDate,
      eligibility: eligibility || null,
      incentiveStructure: incentiveStructure || null,
      rewardDetails: rewardDetails || null,
      createdByName: session.name,
      createdByRole: session.role,
      scope: scope || null,
      status: "pending",
    }).returning();

    sendContestNotification({
      title,
      objective,
      metric,
      startDate,
      endDate,
      createdByName: session.name,
      rewardDetails,
      eligibility,
      incentiveStructure,
      product,
    }).catch(() => {});

    res.json({ contest: contest[0] });
  } catch (e: any) {
    console.error("Contest create error:", e.message);
    res.status(500).json({ error: "Failed to create contest" });
  }
});

router.patch("/sales/contests/:id", requireRole("flm", "slm", "exec", "admin"), requireWritable(), async (req, res): Promise<void> => {
  try {
    const session = {
      name: req.user!.hierarchyName || `${req.user!.firstName ?? ""} ${req.user!.lastName ?? ""}`.trim() || (req.user!.email ?? ""),
      role: req.user!.role!,
    };
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid contest ID" });
      return;
    }

    const existing = await db.select().from(contestsTable).where(eq(contestsTable.id, id)).limit(1);
    if (existing.length === 0) {
      res.status(404).json({ error: "Contest not found" });
      return;
    }
    const contest = existing[0];

    if (!isAdminOrSlm(req) && contest.createdByName !== session.name) {
      res.status(403).json({ error: "You can only edit contests you created" });
      return;
    }

    const { title, objective, metric, product, startDate, endDate, eligibility, incentiveStructure, rewardDetails, scope } = req.body;

    const updates: Record<string, unknown> = {};
    if (title !== undefined) updates.title = title;
    if (objective !== undefined) updates.objective = objective || null;
    if (metric !== undefined) updates.metric = metric;
    if (product !== undefined) updates.product = product || null;
    if (startDate !== undefined) updates.startDate = startDate;
    if (endDate !== undefined) updates.endDate = endDate;
    if (eligibility !== undefined) updates.eligibility = eligibility || null;
    if (incentiveStructure !== undefined) updates.incentiveStructure = incentiveStructure || null;
    if (rewardDetails !== undefined) updates.rewardDetails = rewardDetails || null;
    if (scope !== undefined) updates.scope = scope || null;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const finalStart = (updates.startDate as string) ?? contest.startDate;
    const finalEnd = (updates.endDate as string) ?? contest.endDate;
    if (finalStart && finalEnd && new Date(finalStart) > new Date(finalEnd)) {
      res.status(400).json({ error: "Start date must be before end date" });
      return;
    }

    const updated = await db.update(contestsTable).set(updates).where(eq(contestsTable.id, id)).returning();
    res.json({ contest: updated[0] });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Contest update error:", msg);
    res.status(500).json({ error: "Failed to update contest" });
  }
});

router.post("/sales/contests/:id/approve", requireRole("admin"), requireWritable(), async (req, res): Promise<void> => {
  try {
    const session = {
      name: req.user!.hierarchyName || `${req.user!.firstName ?? ""} ${req.user!.lastName ?? ""}`.trim() || (req.user!.email ?? ""),
      role: req.user!.role!,
    };
    if (!isAdmin(req)) {
      res.status(403).json({ error: "Admin role required to approve contests" });
      return;
    }

    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid contest ID" });
      return;
    }

    const updated = await db.update(contestsTable)
      .set({ status: "active", approvedByName: session.name, approvedAt: new Date() })
      .where(eq(contestsTable.id, id))
      .returning();

    if (updated.length === 0) {
      res.status(404).json({ error: "Contest not found" });
      return;
    }

    res.json({ contest: updated[0] });
  } catch (e: any) {
    console.error("Contest approve error:", e.message);
    res.status(500).json({ error: "Failed to approve contest" });
  }
});

router.delete("/sales/contests/:id", requireRole("flm", "slm", "exec", "admin"), requireWritable(), async (req, res): Promise<void> => {
  try {
    const session = {
      name: req.user!.hierarchyName || `${req.user!.firstName ?? ""} ${req.user!.lastName ?? ""}`.trim() || (req.user!.email ?? ""),
      role: req.user!.role!,
    };
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid contest ID" });
      return;
    }

    const existing = await db.select().from(contestsTable).where(eq(contestsTable.id, id)).limit(1);
    if (existing.length === 0) {
      res.status(404).json({ error: "Contest not found" });
      return;
    }

    const contest = existing[0];
    if (!isAdminOrSlm(req) && contest.createdByName !== session.name) {
      res.status(403).json({ error: "You can only delete your own contests" });
      return;
    }

    await db.delete(contestsTable).where(eq(contestsTable.id, id));
    res.json({ success: true });
  } catch (e: any) {
    console.error("Contest delete error:", e.message);
    res.status(500).json({ error: "Failed to delete contest" });
  }
});

// ============================================================================
// Per-opportunity probability overrides + stage default probabilities
// ============================================================================

// Standard pipeline funnel stages — these are the only values the funnel
// drilldown ever asks about. Sched-mod stages are handled separately
// below since the per-Churn-Type rewrite (task #153) means the set of
// valid stage keys is data-driven (any distinct `churn_type` from the
// Databricks table, plus the synthetic "Manager Estimate" stage, plus
// the legacy "Scheduled Mods" key still sent by the pre-rewrite UI).
const FUNNEL_STAGES = new Set([
  "Discovery",
  "Demo Scheduled",
  "Proposal/Negotiation",
  "Paperwork Sent",
  "Awaiting Payment",
  "Closed Won",
  "Closed Lost",
]);

// Loose validator for stage-default writes. Accepts any non-empty,
// reasonably-bounded string so new churn types surfaced by Databricks
// don't require a code deploy, AND accepts the legacy "Scheduled Mods"
// key still sent by the pre-rewrite Sched Mods drilldown until the UI
// rewrite (follow-up #155) ships.
function isAcceptableStageDefaultKey(stage: string): boolean {
  if (FUNNEL_STAGES.has(stage)) return true;
  const trimmed = stage.trim();
  if (!trimmed) return false;
  if (trimmed.length > 100) return false;
  return true;
}

// Kept for the funnel drilldown handler which only deals in real funnel
// stages; do NOT use this for stage-default writes (use
// `isAcceptableStageDefaultKey` instead so we don't reject churn types).
const ALLOWED_FUNNEL_STAGES = FUNNEL_STAGES;

function clampProb(v: unknown): number | null {
  let n: number;
  if (typeof v === "number") {
    n = v;
  } else if (typeof v === "string") {
    const s = v.trim();
    if (s === "" || !/^-?\d+$/.test(s)) return null;
    n = Number(s);
  } else {
    return null;
  }
  if (!Number.isInteger(n)) return null;
  if (n < 0 || n > 100) return null;
  return n;
}

router.get(
  "/sales/stage-default-probabilities",
  requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"),
  async (_req, res): Promise<void> => {
    try {
      const map = await getStageDefaultProbabilities();
      res.json({ defaults: map });
    } catch (e: any) {
      console.error("Stage defaults fetch error:", e.message);
      res.status(500).json({ error: "Failed to fetch stage defaults" });
    }
  },
);

router.put(
  "/sales/stage-default-probabilities/:stage",
  requireRole("flm", "slm", "exec", "admin"),
  requireWritable(),
  async (req, res): Promise<void> => {
    try {
      const stage = String(req.params.stage);
      if (!isAcceptableStageDefaultKey(stage)) {
        res.status(400).json({ error: "Unknown stage" });
        return;
      }
      const probability = clampProb((req.body as any)?.probability);
      if (probability === null) {
        res.status(400).json({ error: "Probability must be an integer 0-100" });
        return;
      }
      const updatedByName = req.user?.hierarchyName ?? null;
      await db
        .insert(stageDefaultProbabilitiesTable)
        .values({ stage, probability, updatedByName })
        .onConflictDoUpdate({
          target: stageDefaultProbabilitiesTable.stage,
          set: { probability, updatedAt: new Date(), updatedByName },
        });
      invalidateProbabilityCaches();
      res.json({ stage, probability });
    } catch (e: any) {
      console.error("Stage defaults update error:", e.message);
      res.status(500).json({ error: "Failed to update stage default" });
    }
  },
);

router.get(
  "/sales/opp-probabilities",
  requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"),
  async (_req, res): Promise<void> => {
    try {
      const overrides = await getOppProbabilityOverrides();
      res.json({ overrides });
    } catch (e: any) {
      console.error("Opp prob overrides fetch error:", e.message);
      res.status(500).json({ error: "Failed to fetch opp probability overrides" });
    }
  },
);

async function userCanEditOppProbability(
  req: any,
  oppRep: string,
): Promise<boolean> {
  const role = req.user?.role;
  if (role === "admin" || role === "slm" || role === "exec") return true;
  const myName = req.user?.hierarchyName;
  if (!myName) {
    console.warn("userCanEditOppProbability: missing hierarchyName", {
      role,
      userId: req.user?.id,
      oppRep,
    });
    return false;
  }
  if (role === "flm") {
    const { fetchHierarchy } = await import("../lib/sheets-data");
    const hierarchy = await fetchHierarchy();
    const reps = hierarchy.flmToReps[myName] || [];
    // Fallback: an FLM may also legitimately edit their OWN ME slice
    // (oppRep === myName), even when a stale hierarchy snapshot has not
    // yet listed them as a rep on their own team. This avoids a class of
    // 403s caused by transient sheet propagation lag without widening
    // the permission to other reps.
    const allowed = reps.includes(oppRep) || oppRep === myName;
    if (!allowed) {
      console.warn("userCanEditOppProbability: FLM rep not on team", {
        myName,
        oppRep,
        teamSize: reps.length,
      });
    }
    return allowed;
  }
  if (role === "rep") {
    const ok = oppRep === myName;
    if (!ok) {
      console.warn("userCanEditOppProbability: rep != oppRep", { myName, oppRep });
    }
    return ok;
  }
  console.warn("userCanEditOppProbability: unsupported role", { role, oppRep });
  return false;
}

router.put(
  "/sales/opp-probabilities/:oppId",
  requireRole("rep", "flm", "slm", "exec", "admin"),
  requireWritable(),
  async (req, res): Promise<void> => {
    try {
      const oppId = canonicalizeOppId(String(req.params.oppId));
      if (!oppId) {
        res.status(400).json({ error: "Missing oppId" });
        return;
      }
      const probability = clampProb((req.body as any)?.probability);
      if (probability === null) {
        res.status(400).json({ error: "Probability must be an integer 0-100" });
        return;
      }
      const { getOppRepById } = await import("../lib/sheets-data");
      const oppRep = await getOppRepById(oppId);
      if (!oppRep) {
        res.status(404).json({ error: "Opportunity not found" });
        return;
      }
      const canEdit = await userCanEditOppProbability(req, oppRep);
      if (!canEdit) {
        res.status(403).json({ error: "Not allowed to edit this opportunity" });
        return;
      }
      const updatedByName = req.user?.hierarchyName ?? null;
      // Stamp reviewedAt every PUT so the opp clears the "needs review" highlight even when the value matches the stage default.
      const now = new Date();
      await db
        .insert(oppProbabilityOverridesTable)
        .values({ oppId, probability, updatedByName, reviewedAt: now })
        .onConflictDoUpdate({
          target: oppProbabilityOverridesTable.oppId,
          set: { probability, updatedAt: now, updatedByName, reviewedAt: now },
        });
      invalidateProbabilityCaches();
      res.json({ oppId, probability });
    } catch (e: any) {
      console.error("Opp prob override update error:", e.message);
      res.status(500).json({ error: "Failed to update opp probability" });
    }
  },
);

router.delete(
  "/sales/opp-probabilities/:oppId",
  requireRole("rep", "flm", "slm", "exec", "admin"),
  requireWritable(),
  async (req, res): Promise<void> => {
    try {
      const oppId = canonicalizeOppId(String(req.params.oppId));
      if (!oppId) {
        res.status(400).json({ error: "Missing oppId" });
        return;
      }
      const { getOppRepById } = await import("../lib/sheets-data");
      const oppRep = await getOppRepById(oppId);
      if (!oppRep) {
        res.status(404).json({ error: "Opportunity not found" });
        return;
      }
      const canEdit = await userCanEditOppProbability(req, oppRep);
      if (!canEdit) {
        res.status(403).json({ error: "Not allowed to edit this opportunity" });
        return;
      }
      await db
        .delete(oppProbabilityOverridesTable)
        .where(eq(oppProbabilityOverridesTable.oppId, oppId));
      invalidateProbabilityCaches();
      res.json({ success: true });
    } catch (e: any) {
      console.error("Opp prob override delete error:", e.message);
      res.status(500).json({ error: "Failed to delete opp probability override" });
    }
  },
);

// Per-rep coverage targets. Returned as a map keyed by hierarchyName so the
// frontend can compute the effective target for any active filter scope.
// Backed by a dedicated `rep_coverage_targets` table keyed on hierarchy
// name (works for reps even if they have no Replit account).
router.get(
  "/sales/coverage-targets",
  requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"),
  async (_req, res): Promise<void> => {
    try {
      const rows = await db
        .select({ name: repCoverageTargetsTable.hierarchyName, target: repCoverageTargetsTable.coverageTarget })
        .from(repCoverageTargetsTable);
      const targets: Record<string, number> = {};
      for (const r of rows) {
        if (r.name) targets[r.name] = r.target;
      }
      res.json({ targets });
    } catch (e: any) {
      console.error("Coverage targets fetch error:", e.message);
      res.status(500).json({ error: "Failed to fetch coverage targets" });
    }
  },
);

// Bulk update coverage targets for a list of rep names. Caller passes
// `repNames` (the reps they want to update). The server enforces role
// scoping: SLMs may only update reps in their own hierarchy; admins may
// update any reps. FLMs and reps cannot edit (they see static values).
router.put(
  "/sales/coverage-targets",
  requireRole("slm", "exec", "admin"),
  requireWritable(),
  async (req, res): Promise<void> => {
    try {
      const body = req.body as { value?: number; repNames?: string[] };
      const value = Number(body?.value);
      if (!Number.isFinite(value) || value <= 0 || value > 100) {
        res.status(400).json({ error: "Coverage target must be a positive number ≤ 100" });
        return;
      }
      const rounded = Math.round(value * 100) / 100;
      const requested = Array.isArray(body?.repNames)
        ? body!.repNames!.filter((n): n is string => typeof n === "string" && n.length > 0)
        : [];
      if (requested.length === 0) {
        res.status(400).json({ error: "repNames array is required" });
        return;
      }
      // Validate that every requested name is a known IC rep in the
      // hierarchy. We never want to persist coverage targets keyed on
      // FLM/SLM/region/segment labels, even if the frontend mistakenly
      // sends them.
      const { fetchHierarchy } = await import("../lib/sheets-data");
      const hierarchy = await fetchHierarchy();
      const allReps = new Set<string>();
      for (const flm of Object.keys(hierarchy.flmToReps)) {
        for (const rep of hierarchy.flmToReps[flm] || []) allReps.add(rep);
      }
      let allowedRepNames: string[] = requested.filter(n => allReps.has(n));
      if (req.user?.role === "slm") {
        const myName = req.user?.hierarchyName;
        if (!myName) {
          res.status(403).json({ error: "SLM has no hierarchy assignment" });
          return;
        }
        const myFlms = hierarchy.slmToFlms[myName] || [];
        const allowed = new Set<string>();
        for (const flm of myFlms) {
          for (const rep of hierarchy.flmToReps[flm] || []) allowed.add(rep);
        }
        allowedRepNames = allowedRepNames.filter(n => allowed.has(n));
      }
      if (allowedRepNames.length === 0) {
        res.status(403).json({ error: "No reps in your scope to update" });
        return;
      }
      // Upsert one row per rep so the value applies regardless of whether
      // the rep has a Replit account in the `users` table.
      const values = allowedRepNames.map((n) => ({
        hierarchyName: n,
        coverageTarget: rounded,
      }));
      await db
        .insert(repCoverageTargetsTable)
        .values(values)
        .onConflictDoUpdate({
          target: repCoverageTargetsTable.hierarchyName,
          set: { coverageTarget: rounded, updatedAt: sql`now()` },
        });
      res.json({ updated: allowedRepNames.length, value: rounded, repNames: allowedRepNames });
    } catch (e: any) {
      console.error("Coverage targets update error:", e.message);
      res.status(500).json({ error: "Failed to update coverage targets" });
    }
  },
);

// All scheduled mods whose probability has never been changed by any
// user. Mirrors `/sales/unreviewed-opps` for the GNR Churn Forecast
// popup's "Review Unreviewed Mods" button. Mod ids are the composite
// `mod:contactId|date|amount|product` form produced by `modOppIdFor`
// (covers rows without a real Salesforce opportunity_id).
router.get(
  "/sales/unreviewed-mods",
  requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"),
  async (req, res): Promise<void> => {
    try {
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      const dateFilter = from || to ? { from, to } : undefined;
      const rawConditions = resolveRawConditions(req);
      const { getModsOpportunities } = await import("../lib/sheets-data");
      const { opportunities } = await getModsOpportunities(dateFilter, rawConditions);
      const unreviewed = opportunities.filter((o: any) => o.oppId && !o.isReviewed);
      // Contract: { mods, count }. `opportunities` is kept as an alias so a
      // generic client that already speaks the unreviewed-opps shape can
      // read either key without breaking.
      res.json({ mods: unreviewed, opportunities: unreviewed, count: unreviewed.length });
    } catch (e: any) {
      console.error("Unreviewed mods fetch error:", e.message);
      res.status(500).json({ error: "Failed to fetch unreviewed mods" });
    }
  },
);

// All open opportunities whose probability has never been changed by any
// user (i.e. no row in opp_probability_overrides for that opp_id). The
// frontend uses this for the "Unreviewed Opportunities" drilldown.
router.get(
  "/sales/unreviewed-opps",
  requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"),
  async (req, res): Promise<void> => {
    try {
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      const dateFilter = from || to ? { from, to } : undefined;
      const pipelineMode = (req.query.pipelineMode as string) === "allOpen" ? "allOpen" : "closeDate";
      const rawConditions = resolveRawConditions(req);
      const { getAllOpenOpportunities } = await import("../lib/sheets-data");
      const opps = await getAllOpenOpportunities(dateFilter, pipelineMode, "quota", rawConditions);
      const unreviewed = opps.filter((o: any) => o.oppId && !o.isReviewed);
      res.json({ opportunities: unreviewed, count: unreviewed.length });
    } catch (e: any) {
      console.error("Unreviewed opps fetch error:", e.message);
      res.status(500).json({ error: "Failed to fetch unreviewed opportunities" });
    }
  },
);

// ============================================================================
// Manager Estimate (Task #153)
// Per-(FLM, month, product) unweighted churn estimate. Read by everyone in
// the org chart; write requires FLM/SLM/admin. SLM writes are pre-warned
// client-side ("This will overwrite the Manager Estimate set by every FLM
// currently in view…") — server-side we just enforce the role gate.
// ============================================================================

router.get(
  "/sales/manager-estimates",
  requireRole("guest", "rep", "flm", "slm", "exec", "admin", "viewer"),
  async (req, res): Promise<void> => {
    try {
      const month = typeof req.query.month === "string" ? req.query.month : "";
      if (!/^\d{4}-\d{2}$/.test(month)) {
        res.status(400).json({ error: "month must be YYYY-MM" });
        return;
      }
      const flmsParam = typeof req.query.flms === "string" ? req.query.flms : "";
      const requested = flmsParam ? flmsParam.split(",").map((s) => s.trim()).filter(Boolean) : [];

      // Hierarchy-scoped authorization: restrict the queryable FLM set
      // based on requester role so an authenticated rep/viewer cannot
      // pull ME values from arbitrary FLM names.
      const role = req.user?.role || "guest";
      const ownName = (req.user?.hierarchyName || "").trim();
      const { fetchEffectiveHierarchy } = await import("../lib/sheets-data");
      const hierarchy = await fetchEffectiveHierarchy(month);
      const allFlms = new Set<string>(Object.keys(hierarchy.flmToReps || {}));

      let allowedFlms: Set<string>;
      if (role === "admin" || role === "slm" || role === "exec" || role === "viewer") {
        if (role === "slm" && ownName) {
          allowedFlms = new Set(hierarchy.slmToFlms?.[ownName] || []);
        } else {
          allowedFlms = allFlms;
        }
      } else if (role === "flm" && ownName) {
        allowedFlms = new Set([ownName]);
      } else if (role === "rep" && ownName) {
        const myFlm = hierarchy.repToFlm?.[ownName];
        allowedFlms = myFlm ? new Set([myFlm]) : new Set();
      } else {
        allowedFlms = new Set();
      }

      // Optional `?slm=Name` param: scope the FLM set to the SLM's team.
      // Used by the Sched Mods drilldown when opened by clicking an SLM
      // team name on the chart. Resolved server-side via the hierarchy and
      // always intersected with the role-based allowed set above so it can
      // never widen what the requester is permitted to see.
      const slmParam = typeof req.query.slm === "string" ? req.query.slm.trim() : "";
      let requestSet = requested.length > 0
        ? requested.filter((n) => allowedFlms.has(n))
        : Array.from(allowedFlms);
      if (slmParam) {
        const slmFlms = new Set(hierarchy.slmToFlms?.[slmParam] || []);
        requestSet = requestSet.filter((n) => slmFlms.has(n));
      }
      // Critical: when the intersection of requested ∩ allowed is empty,
      // return [] — do NOT fall through to an unfiltered query (which
      // would expose all FLMs for the month).
      if (requestSet.length === 0) {
        res.json({ estimates: [] });
        return;
      }
      const { getManagerEstimates, distributePerRep, managerEstimateOppId: meOppId } = await import("../lib/manager-estimates");
      const rows = await getManagerEstimates(month, requestSet);

      // Pull ME probability overrides so every row can be returned with a
      // matching `weightedAmount` field. Defaults to the full unweighted
      // amount when no override exists (i.e. 100% confidence). The popup
      // ME row + the pinned drilldown ME row both use these to roll up
      // a weighted-avg "current %" across the rep × product slices.
      const { getOppOverrideEntries } = await import("../lib/probabilities");
      const overrideEntries = await getOppOverrideEntries();
      const probFor = (rep: string, product: string): number => {
        const id = meOppId(rep, month, product);
        const e = overrideEntries[id];
        return e && typeof e.probability === "number" ? e.probability : 100;
      };
      const reviewedFor = (rep: string, product: string): boolean => {
        const id = meOppId(rep, month, product);
        const e = overrideEntries[id];
        return !!(e && e.reviewedAt != null);
      };

      // Build per-FLM rep map up front; reused for both the per-rep and
      // per-FLM weighted aggregates below.
      const flmToReps: Record<string, string[]> = {};
      for (const flm of requestSet) {
        flmToReps[flm] = (hierarchy.flmToReps?.[flm] || []).filter(Boolean);
      }

      // Optional `?reps=name1,name2` param: when provided, the response
      // returns per-rep shares (FLM amount / # reps on that FLM's team)
      // restricted to the requested rep names. Reps see only their own
      // share by default. Used by the Sched Mods drilldown's pinned ME
      // row when the view is rep-scoped so each rep sees their slice
      // rather than the whole FLM total.
      const repsParam = typeof req.query.reps === "string" ? req.query.reps : "";
      const repsRequested = repsParam
        ? repsParam.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      if (repsRequested.length > 0) {
        const allShares = distributePerRep(rows, flmToReps);
        const allowedRepSet = new Set(repsRequested);
        // Reps may only see themselves regardless of what they request.
        const repFilter = role === "rep" && ownName ? new Set([ownName]) : allowedRepSet;
        const perRep = allShares
          .filter((s) => repFilter.has(s.rep))
          .map((s) => {
            const prob = probFor(s.rep, s.product);
            return {
              // Surface per-rep rows but keep the same shape the client
              // already understands (flmName + product + amount), with
              // additional repName / weightedAmount / probabilityPct
              // fields so callers can disambiguate.
              flmName: s.flm,
              repName: s.rep,
              monthYyyymm: s.monthYyyymm,
              product: s.product,
              unweightedAmount: s.amount,
              weightedAmount: Math.round(s.amount * (prob / 100)),
              probabilityPct: prob,
              // True iff the rep × product slice has an explicit override
              // row with `reviewed_at` set. Drives the per-product yellow
              // highlight on the pinned ME row's expansion sub-rows.
              isReviewed: reviewedFor(s.rep, s.product),
            };
          });
        res.json({ estimates: perRep });
        return;
      }

      // Per-FLM rows: derive weightedAmount by distributing each FLM
      // amount across its reps, weighting each share by the rep-level
      // probability override, and re-aggregating up to the FLM. This
      // matches what the per-rep mode above would produce when summed,
      // so the two modes stay reconcilable on the client.
      const allShares = distributePerRep(rows, flmToReps);
      const flmWeighted: Record<string, number> = {};
      // Per-(FLM, product) reviewed flag: true iff EVERY rep on that
      // FLM's team has an override row with `reviewed_at` set for the
      // product. Drives the rolled-up yellow highlight at the FLM-level
      // ME row — the highlight only drops once the manager has touched
      // every rep slice for that product.
      const flmAllReviewed: Record<string, boolean> = {};
      const flmAnyShare: Record<string, boolean> = {};
      for (const s of allShares) {
        const key = `${s.flm}|${s.product}`;
        const prob = probFor(s.rep, s.product);
        flmWeighted[key] = (flmWeighted[key] || 0) + s.amount * (prob / 100);
        const reviewed = reviewedFor(s.rep, s.product);
        if (flmAllReviewed[key] === undefined) flmAllReviewed[key] = reviewed;
        else flmAllReviewed[key] = flmAllReviewed[key] && reviewed;
        flmAnyShare[key] = true;
      }
      const enriched = rows.map((r) => {
        const key = `${r.flmName}|${r.product}`;
        return {
          ...r,
          weightedAmount: Math.round(flmWeighted[key] || 0),
          isReviewed: !!flmAnyShare[key] && !!flmAllReviewed[key],
        };
      });
      res.json({ estimates: enriched });
    } catch (e: any) {
      console.error("Manager estimates fetch error:", e.message);
      res.status(500).json({ error: "Failed to fetch manager estimates" });
    }
  },
);

router.put(
  "/sales/manager-estimates",
  requireRole("flm", "slm", "exec", "admin"),
  requireWritable(),
  async (req, res): Promise<void> => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const scope = typeof body.scope === "string" ? body.scope.trim() : "flm";
      const monthYyyymm = typeof body.monthYyyymm === "string" ? body.monthYyyymm.trim() : "";
      const product = typeof body.product === "string" ? body.product.trim() : "";
      const amountRaw = body.unweightedAmount;
      const unweightedAmount =
        typeof amountRaw === "number"
          ? amountRaw
          : typeof amountRaw === "string"
            ? Number(amountRaw)
            : NaN;
      if (!/^\d{4}-\d{2}$/.test(monthYyyymm) || !product) {
        res.status(400).json({ error: "monthYyyymm (YYYY-MM) and product are required" });
        return;
      }
      if (!Number.isFinite(unweightedAmount) || unweightedAmount < 0) {
        res.status(400).json({ error: "unweightedAmount must be a non-negative number" });
        return;
      }
      const role = req.user?.role ?? "guest";
      const myHierarchyName = req.user?.hierarchyName ?? "";
      const updatedByName =
        myHierarchyName ||
        `${req.user?.firstName ?? ""} ${req.user?.lastName ?? ""}`.trim() ||
        (req.user?.email ?? "");
      const { upsertManagerEstimate } = await import("../lib/manager-estimates");

      // ---- SLM scope: fan out to every FLM beneath the requester. ----
      // Each FLM gets `round(unweightedAmount / N)` so the team total
      // matches the SLM-entered $; remainders fall on the first FLM.
      if (scope === "slm") {
        if (role !== "slm" && role !== "admin" && role !== "exec") {
          res.status(403).json({ error: "Only SLMs may use scope=slm" });
          return;
        }
        const slmName = typeof body.slmName === "string" ? body.slmName.trim() : myHierarchyName;
        if (!slmName) {
          res.status(400).json({ error: "slmName required for scope=slm" });
          return;
        }
        if (role === "slm" && slmName !== myHierarchyName) {
          res.status(403).json({ error: "SLMs may only edit their own org" });
          return;
        }
        const { fetchEffectiveHierarchy } = await import("../lib/sheets-data");
        const hierarchy = await fetchEffectiveHierarchy(monthYyyymm);
        const flms = (hierarchy.slmToFlms?.[slmName] || []).filter(Boolean);
        if (flms.length === 0) {
          res.status(400).json({ error: "No FLMs found beneath this SLM" });
          return;
        }
        const total = Math.max(0, Math.round(unweightedAmount));
        const base = Math.floor(total / flms.length);
        const remainder = total - base * flms.length;
        const writes = flms.map((flm, i) =>
          upsertManagerEstimate(
            flm,
            monthYyyymm,
            product,
            base + (i === 0 ? remainder : 0),
            updatedByName,
            role,
          ),
        );
        const rows = await Promise.all(writes);
        invalidateCache();
        res.json({ estimates: rows });
        return;
      }

      // ---- FLM scope (default): write a single (flm, month, product) row. ----
      const flmName = typeof body.flmName === "string" ? body.flmName.trim() : "";
      if (!flmName) {
        res.status(400).json({ error: "flmName required for scope=flm" });
        return;
      }
      // FLMs can only write their own team's value. SLMs and admins can
      // write any FLM's value — the SLM confirm-then-overwrite warning
      // for cross-FLM writes is enforced client-side; the server just
      // gates by role here.
      if (role === "flm" && flmName !== myHierarchyName) {
        res.status(403).json({
          error: "FLMs may only edit their own team's manager estimate",
        });
        return;
      }
      const row = await upsertManagerEstimate(
        flmName,
        monthYyyymm,
        product,
        unweightedAmount,
        updatedByName,
        role,
      );
      // Manager Estimate $ feeds into mods aggregation; bust the live cache
      // so the dashboard sees the new value on the next refresh.
      invalidateCache();
      res.json({ estimate: row });
    } catch (e: any) {
      console.error("Manager estimates upsert error:", e.message);
      res.status(500).json({ error: "Failed to save manager estimate" });
    }
  },
);

// ============================================================================
// Compensation rules config + compensable values
// ============================================================================
// Reads and writes of the per-month compensation config are restricted to
// admin / SLM / exec (the comp-data audience). The compensable summary is
// gated the same way since it exposes adjusted revenue.

function resolveCompMonth(req: any): string {
  const q = req.query?.month;
  const month = typeof q === "string" && q.trim() ? q.trim() : currentCompMonthKey();
  return month;
}

router.get(
  "/sales/compensation/config",
  // Read access opened to all authenticated roles (Task #363): the Executive
  // tab is now read-only-visible to everyone. Writes stay gated below.
  requireRole(),
  async (req, res): Promise<void> => {
    try {
      const month = resolveCompMonth(req);
      if (!isValidMonthKey(month)) {
        res.status(400).json({ error: "month must be in YYYY-MM format" });
        return;
      }
      const config = await getCompensationConfig(month);
      res.json({ config });
    } catch (e: any) {
      console.error("Compensation config fetch error:", e.message);
      res.status(500).json({ error: "Failed to fetch compensation config" });
    }
  },
);

router.put(
  "/sales/compensation/config",
  requireRole("admin", "slm", "exec"),
  requireWritable(),
  async (req, res): Promise<void> => {
    try {
      const month = resolveCompMonth(req);
      if (!isValidMonthKey(month)) {
        res.status(400).json({ error: "month must be in YYYY-MM format" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rulesResult = validateMultiplierRules(body.multiplierRules);
      if (!rulesResult.ok) {
        res.status(400).json({ error: rulesResult.error });
        return;
      }
      const pairedResult = validatePairedOppRules(body.pairedOppRules);
      if (!pairedResult.ok) {
        res.status(400).json({ error: pairedResult.error });
        return;
      }
      const updatedByName =
        req.user!.hierarchyName ||
        `${req.user!.firstName ?? ""} ${req.user!.lastName ?? ""}`.trim() ||
        (req.user!.email ?? null);
      const config = await upsertCompensationConfig(
        month,
        rulesResult.rules!,
        pairedResult.rules!,
        updatedByName,
        req.user!.role ?? null,
      );
      res.json({ config });
    } catch (e: any) {
      console.error("Compensation config update error:", e.message);
      res.status(500).json({ error: "Failed to update compensation config" });
    }
  },
);

// ---------------------------------------------------------------------------
// Product Logic config (Task #350): the global, editable rule set driving
// product attribution, MRR-field selection, and Overage closed-won handling,
// plus the display-only rename map. Gated to the comp-data audience.
// ---------------------------------------------------------------------------

router.get(
  "/sales/product-logic/config",
  // Read access opened to all authenticated roles (Task #363): also backs the
  // dynamic Pipeline "MRR Logic" popup for every viewer. Writes stay gated.
  requireRole(),
  async (_req, res): Promise<void> => {
    try {
      const config = await getProductLogicConfig();
      res.json({ config });
    } catch (e: any) {
      console.error("Product logic config fetch error:", e.message);
      res.status(500).json({ error: "Failed to fetch product logic config" });
    }
  },
);

router.put(
  "/sales/product-logic/config",
  requireRole("admin", "slm", "exec"),
  requireWritable(),
  async (req, res): Promise<void> => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rulesResult = validateProductLogicRules(body.rules);
      if (!rulesResult.ok) {
        res.status(400).json({ error: rulesResult.error });
        return;
      }
      const renameResult = validateRenameMap(body.renameMap ?? []);
      if (!renameResult.ok) {
        res.status(400).json({ error: renameResult.error });
        return;
      }
      const updatedByName =
        req.user!.hierarchyName ||
        `${req.user!.firstName ?? ""} ${req.user!.lastName ?? ""}`.trim() ||
        (req.user!.email ?? null);
      const config = await upsertProductLogicConfig(
        rulesResult.rules!,
        renameResult.renameMap!,
        updatedByName,
        req.user!.role ?? null,
      );
      // Task #440: a saved Product Logic change must refresh the cached
      // aggregate views (goal attainment + pipeline funnel cards), not just the
      // per-request drilldown. The parsed rows carry baked-in product
      // attribution and the computed pipeline result is cached by data version,
      // so drop both here. upsertProductLogicConfig already updated the in-memory
      // active config, so the next request recomputes against the new rules.
      invalidateCache();
      res.json({ config });
    } catch (e: any) {
      console.error("Product logic config update error:", e.message);
      res.status(500).json({ error: "Failed to update product logic config" });
    }
  },
);

router.get(
  "/sales/product-logic/examples",
  // Read access opened to all authenticated roles (Task #363).
  requireRole(),
  async (_req, res): Promise<void> => {
    try {
      const examples = await getProductLogicExamples();
      res.json({ examples });
    } catch (e: any) {
      console.error("Product logic examples fetch error:", e.message);
      res.status(500).json({ error: "Failed to fetch product logic examples" });
    }
  },
);

// Task #572: test a pasted opp id against ONE Product Logic rule inside the
// caller's CURRENT (possibly unsaved) ordered rule list. Read-only diagnostic —
// evaluates every line-item row carrying the opp id:
//   - per-condition match statuses for the tested rule (aggregated worst-case
//     across rows so a multi-line opp goes red if ANY line fails),
//   - the failing rows' Opportunity Product IDs,
//   - the earlier rule (if any) that would claim a row first, so the UI can
//     show "matches, but Rule #N wins first".
router.post(
  "/sales/product-logic/test-opp",
  requireRole(),
  async (req, res): Promise<void> => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const oppId = canonicalizeOppId(
        typeof body.oppId === "string" ? body.oppId : "",
      );
      if (!oppId) {
        res.status(400).json({ error: "oppId is required" });
        return;
      }
      const rulesResult = validateProductLogicRules(body.rules);
      if (!rulesResult.ok) {
        res.status(400).json({ error: rulesResult.error });
        return;
      }
      const rules = rulesResult.rules!;
      const ruleIndex = Number(body.ruleIndex);
      if (
        !Number.isInteger(ruleIndex) ||
        ruleIndex < 0 ||
        ruleIndex >= rules.length
      ) {
        res.status(400).json({ error: "ruleIndex is out of range" });
        return;
      }
      const rule = rules[ruleIndex];

      const ctx = await buildProductLogicTestContext(oppId);
      if (!ctx.found) {
        res.json({ found: false });
        return;
      }

      // Per-row diagnosis against the tested rule + first-match winner across
      // the whole ordered list (mirrors evaluateProductLogic's first-match).
      const perRow = ctx.rows.map((r) => {
        const conditions = testConditionsAgainstRow(r.input, rule.conditions);
        const matched = conditions.every((s) => s === "match");
        let winnerIndex: number | null = null;
        for (let i = 0; i < rules.length; i++) {
          if (rowMatchesAllConditions(r.input, rules[i].conditions)) {
            winnerIndex = i;
            break;
          }
        }
        return { oppProductId: r.oppProductId, matched, conditions, winnerIndex };
      });

      const allMatch = perRow.every((r) => r.matched);
      const failingOppProductIds = perRow
        .filter((r) => !r.matched)
        .map((r) => r.oppProductId);

      // Aggregate per-condition statuses (worst-case across rows).
      const conditions: CompConditionTestStatus[] = rule.conditions.map(
        (_c, i) =>
          perRow.some((r) => r.conditions[i] === "noMatch")
            ? "noMatch"
            : "match",
      );

      // When the tested rule matches but an EARLIER rule claims a row first,
      // surface that rule so the UI can note "matches, but Rule #N wins first".
      let winner: { index: number; label: string } | null = null;
      if (allMatch) {
        const earlier = perRow
          .map((r) => r.winnerIndex)
          .filter((i): i is number => i !== null && i < ruleIndex);
        if (earlier.length > 0) {
          const idx = Math.min(...earlier);
          winner = { index: idx, label: rules[idx].label || "" };
        }
      }

      res.json({
        found: true,
        allMatch,
        conditions,
        failingOppProductIds,
        winner,
        rowCount: perRow.length,
      });
    } catch (e: any) {
      console.error("Product logic test-opp error:", e.message);
      res.status(500).json({ error: "Failed to test opp against rule" });
    }
  },
);

router.get(
  "/sales/compensation/summary",
  // Read access opened to all authenticated roles (Task #363).
  requireRole(),
  async (req, res): Promise<void> => {
    try {
      const month = resolveCompMonth(req);
      if (!isValidMonthKey(month)) {
        res.status(400).json({ error: "month must be in YYYY-MM format" });
        return;
      }
      const summary = await getCompensationSummary(month);
      res.json(summary);
    } catch (e: any) {
      console.error("Compensation summary fetch error:", e.message);
      res.status(500).json({ error: "Failed to fetch compensation summary" });
    }
  },
);

// Every opportunity in the month that matched a currently-applied compensation
// rule (multiplier rules incl. 1×, + FUB↔Zpro), with full raw feeder rows.
// Backs the Compensation tab's CSV/XLSX export. Gated the same as the rest of
// the comp surface since it exposes compensable revenue.
router.get(
  "/sales/compensation/rule-affected",
  // Read access opened to all authenticated roles (Task #363).
  requireRole(),
  async (req, res): Promise<void> => {
    try {
      const month = resolveCompMonth(req);
      if (!isValidMonthKey(month)) {
        res.status(400).json({ error: "month must be in YYYY-MM format" });
        return;
      }
      const data = await getRuleAffectedOpportunities(month);
      res.json(data);
    } catch (e: any) {
      console.error("Compensation rule-affected fetch error:", e.message);
      res.status(500).json({ error: "Failed to fetch rule-affected opportunities" });
    }
  },
);

// Task #375: read-only per-condition diagnostic. Given a pasted opp id and a
// (draft) rule, classify each condition match / noMatch / notTestable. The opp
// is looked up across ALL months; partner opps for paired rules are auto
// resolved. Evaluating the rule sent from the client lets the highlighting track
// unsaved edits in the rule card. Does NOT alter real evaluation behavior.
router.post(
  "/sales/compensation/test-opp",
  // Read-only diagnostic — available to all authenticated roles.
  requireRole(),
  async (req, res): Promise<void> => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const oppId = canonicalizeOppId(
        typeof body.oppId === "string" ? body.oppId : "",
      );
      const kind =
        body.kind === "paired"
          ? "paired"
          : body.kind === "multiplier"
            ? "multiplier"
            : null;
      const rule = body.rule;
      if (!kind) {
        res.status(400).json({ error: "kind must be 'multiplier' or 'paired'" });
        return;
      }
      if (!rule || typeof rule !== "object") {
        res.status(400).json({ error: "rule is required" });
        return;
      }

      // Task #394: paired rules pin a pasted opp id to each named role via
      // `oppTestIds` (aligned to rule.opps; "" = blank). Always returns a
      // diagnosis (per-card found drives "Opp not found"); never `found:false`.
      if (kind === "paired" && Array.isArray(body.oppTestIds)) {
        const oppTestIds = (body.oppTestIds as unknown[]).map((x) =>
          canonicalizeOppId(typeof x === "string" ? x : ""),
        );
        const ctx = await buildCompTestContextMulti(oppTestIds);
        const paired = diagnosePairedRuleForOpps(
          ctx.monthInputs,
          oppTestIds,
          rule as PairedOppRule,
        );
        res.json({ found: true, paired });
        return;
      }

      // Legacy single-id path (multiplier rules + backward-compatible paired).
      if (!oppId) {
        res.status(400).json({ error: "oppId is required" });
        return;
      }
      const ctx = await buildCompTestContext(oppId);
      if (!ctx.found) {
        res.json({ found: false });
        return;
      }

      if (kind === "multiplier") {
        const multiplier = diagnoseMultiplierRule(
          ctx.testInputs,
          rule as CompMultiplierRule,
        );
        res.json({ found: true, multiplier });
      } else {
        const paired = diagnosePairedRuleForOpp(
          ctx.monthInputs,
          oppId,
          rule as PairedOppRule,
        );
        res.json({ found: true, paired });
      }
    } catch (e: any) {
      console.error("Compensation test-opp error:", e.message);
      res.status(500).json({ error: "Failed to test opp against rule" });
    }
  },
);

export default router;
