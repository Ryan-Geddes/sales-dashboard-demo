import { getAccessToken } from "./google-auth";
import { canonicalizeOppId } from "./sf-id";
import { getDataVersion, bumpDataVersion } from "./cache-version";
import {
  snapshotCtxActive,
  isReplayActive,
  resolveSheetCSV,
  runCapture,
  sheetSnapshotKey,
  type SnapshotPayload,
} from "./snapshot-context";
import {
  isDemoMode,
  currentDate,
  demoNow,
  demoName,
  DEMO_SHEET_IDS,
  DEMO_VP_NAME,
  DEMO_COMPLIANCE_SALES_REP,
} from "./demo-mode";
import { DEMO_PRODUCT_LABELS } from "./demo-product-labels";
import { dbScopeKey } from "./demo-session";
import { clearQuotaCache, type RepQuota } from "./databricks-quota";
import { getDashboardQuotas, clearGoalsQuotaCache, isAcqGroup as isAcqChannelGroup } from "./goals-quota-source";
import {
  getOppProbabilityOverrides,
  getOppReviewedMap,
  getStageDefaultProbabilities,
} from "./probabilities";
import {
  fetchSchedMods,
  filterSchedMods,
  modOppIdFor,
  clearSchedModsCache,
  type RawScheduledMod,
} from "./databricks-sched-mods";
import { fetchRemaxCpds, clearRemaxCpdsCache } from "./databricks-remax-cpds";
import { fetchAnaplanData, clearAnaplanCache, ANAPLAN_COL } from "./databricks-anaplan";
import { fetchUsHolidays } from "./databricks-holidays";
import {
  fetchFubFirstPurchase,
  clearFubFirstPurchaseCache,
  buildFubFirstPurchaseIndex,
  lookupFubFirstPurchase,
} from "./databricks-fub-first-purchase";
import {
  getManagerEstimates,
  ensureCurrentMonthRows,
  distributePerRep,
  managerEstimateOppId,
  monthKey,
  currentMonthKey,
} from "./manager-estimates";
import {
  getCompensationConfig,
  computeCompensation,
  filterConfigForMode,
  compMonthKey,
  type CompRowInput,
  type CompensationConfig,
  type CompensationResult,
  type MrrField,
  type PairedOppPairSummary,
} from "./compensation";
import {
  MRR_FIELD_OPTIONS,
  FEEDER_MRR_FIELD_OPTIONS,
  CPD_MRR_FIELD_OPTIONS,
  CPD_SOURCED_VALUES,
} from "@workspace/db/schema";
import {
  resolveProduct,
  resolveMrrField,
  resolveStandardizedMrrDetailed,
  isTreatedAsClosedWon,
  evaluateProductLogic,
  getActiveRules,
  refreshActiveProductLogicConfig,
  replaceProductLogicExamples,
  oppNameOverrideFor,
  FALLTHROUGH_PRODUCTS,
  type ProductLogicExampleInput,
  type ProductLogicMatchRow,
} from "./product-logic";
import {
  getRosterOverridesForMonth,
  canonicalRosterMonth,
} from "./roster-overrides";
import type { RosterOverride } from "@workspace/db/schema";
import { logger } from "./logger";

/**
 * Pure helper that computes the quota-related scalar and per-month-map fields
 * for a single rep row in the pipeline payload.
 *
 * - `selectedQuotas`: month-sensitive quotas (current or last month depending
 *   on the active date filter). Used for the scalar `goal30d`/`showcaseGoal`/
 *   `mbpGoal` fields so non-prorated totals remain unchanged.
 * - `currentQuotas` / `lastMonthQuotas`: always the calendar current- and
 *   last-month quota sets. Used for the `*ByYm` per-month maps so prorated
 *   proration looks up each month's own M GOAL.
 * - Managers (FLMs / SLMs) receive empty `{}` for all three `*ByYm` maps and
 *   zero for all scalar goals so their quotas never leak into team totals.
 *
 * Exported for unit testing (Task #175 regression guard). Do NOT call from
 * outside sheets-data.ts production paths — use the full rep payload instead.
 */
export function buildRepQuotaFields(
  repName: string,
  isManager: boolean,
  currentMonthYm: string,
  lastMonthYm: string,
  selectedQuotas: Record<string, RepQuota>,
  currentQuotas: Record<string, RepQuota>,
  lastMonthQuotas: Record<string, RepQuota>,
): {
  goal30d: number;
  showcaseGoal: number;
  mbpGoal: number;
  showcaseGoalByYm: Record<string, number>;
  mbpGoalByYm: Record<string, number>;
  goal30dByYm: Record<string, number>;
} {
  // Scalars use the month-sensitive selectedQuotas so non-prorated totals
  // remain correct when the user has filtered to a prior month.
  const repQuota = isManager ? undefined : selectedQuotas[repName];
  const goal30d = repQuota ? repQuota.totalQuota : 0;
  return {
    goal30d: Math.round(goal30d),
    showcaseGoal: repQuota ? Math.round(repQuota.showcaseQuota) : 0,
    mbpGoal: repQuota ? Math.round(repQuota.mbpQuota) : 0,
    // Per-month maps use the fixed current/last sets so prorated proration
    // can surface each month's own M GOAL regardless of which month is loaded.
    showcaseGoalByYm: isManager
      ? {}
      : {
          [currentMonthYm]: Math.round(
            currentQuotas[repName]?.showcaseQuota ?? 0,
          ),
          [lastMonthYm]: Math.round(
            lastMonthQuotas[repName]?.showcaseQuota ?? 0,
          ),
        },
    mbpGoalByYm: isManager
      ? {}
      : {
          [currentMonthYm]: Math.round(currentQuotas[repName]?.mbpQuota ?? 0),
          [lastMonthYm]: Math.round(lastMonthQuotas[repName]?.mbpQuota ?? 0),
        },
    goal30dByYm: isManager
      ? {}
      : {
          [currentMonthYm]: Math.round(currentQuotas[repName]?.totalQuota ?? 0),
          [lastMonthYm]: Math.round(lastMonthQuotas[repName]?.totalQuota ?? 0),
        },
  };
}

// Google Sheet ids come entirely from the environment — no workbook id is
// hard-coded, so this repo can be public. In demo mode the ids resolve to the
// `demo-sheet-*` placeholders the bundled fixture is keyed by (the demo never
// has, or needs, the real ids). GIDs are identical in both modes so the fixture
// keys line up.
//
// A missing env var in live mode is a configuration error: we log it loudly and
// return a sentinel id so the failing sheet is obvious in the logs instead of
// silently pointing at the wrong workbook.
function sheetId(envVar: string, demoId: string): string {
  if (isDemoMode()) return demoId;
  const fromEnv = process.env[envVar]?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  logger.error(
    { envVar },
    `${envVar} env var required — set it to the Google Sheet id for this feed`,
  );
  return `missing-env-${envVar}`;
}

const PIPELINE_SHEET_ID = sheetId(
  "PIPELINE_SHEET_ID",
  DEMO_SHEET_IDS.pipeline,
);
const PIPELINE_SHEET_GID = "1398220108";

// Task #392: On-Demand opportunities were split into a second feeder sheet
// (`ondemand_frontline_opps_data_V2`) to avoid Salesforce API rate limits. It
// shares the exact columns of the main opps sheet and is unioned into the opps
// data source at parse time (_fetchRowsImpl).
const ONDEMAND_OPPS_SHEET_ID = sheetId(
  "ONDEMAND_OPPS_SHEET_ID",
  DEMO_SHEET_IDS.ondemand,
);
const ONDEMAND_OPPS_SHEET_GID = "1805627516";

const HIERARCHY_SHEET_ID = sheetId(
  "HIERARCHY_SHEET_ID",
  DEMO_SHEET_IDS.hierarchy,
);
const HIERARCHY_SHEET_GID = "428237012";

const SBR_SHEET_ID = sheetId(
  "SBR_SHEET_ID",
  DEMO_SHEET_IDS.sbr,
);
const SBR_SHEET_GID = "566258000";

const DIALS_SHEET_ID = sheetId(
  "DIALS_SHEET_ID",
  DEMO_SHEET_IDS.dials,
);
const DIALS_SHEET_GID = "1364178671";

const CC_DECLINES_SHEET_ID = sheetId(
  "CC_DECLINES_SHEET_ID",
  DEMO_SHEET_IDS.ccDeclines,
);
const CC_DECLINES_SHEET_GID = "1719598493";

const INBOUNDS_SHEET_ID = sheetId(
  "INBOUNDS_SHEET_ID",
  DEMO_SHEET_IDS.inbounds,
);
const INBOUNDS_SHEET_GID = "193611713";

const WEIGHTED_PIPE_SHEET_ID = sheetId(
  "WEIGHTED_PIPE_SHEET_ID",
  DEMO_SHEET_IDS.weighted,
);
const WEIGHTED_PIPE_SHEET_GID = "1055516958";

// Same workbook as the weighted pipe, different tab.
const STALE_OPPS_SHEET_ID = sheetId(
  "WEIGHTED_PIPE_SHEET_ID",
  DEMO_SHEET_IDS.weighted,
);
const STALE_OPPS_SHEET_GID = "140470526";

const FEEDER_INDEX_SHEET_ID = sheetId(
  "FEEDER_INDEX_SHEET_ID",
  DEMO_SHEET_IDS.feederIndex,
);
const FEEDER_INDEX_SHEET_GID = "0";

const EMAILS_SHEET_ID = sheetId(
  "EMAILS_SHEET_ID",
  DEMO_SHEET_IDS.emails,
);
const EMAILS_SHEET_GID = "823100951";

// The name of the VP the org tree is rooted at. Live comes from the VP_NAME
// env var (no hard-coded real name in this repo); the demo fixtures are
// anonymized so demo mode uses the fake counterpart the anonymizer assigned.
const VP_NAME = demoName(process.env.VP_NAME?.trim() || "", DEMO_VP_NAME);
if (!isDemoMode() && !VP_NAME) {
  logger.error(
    { envVar: "VP_NAME" },
    "VP_NAME env var required — set it to the name the sales hierarchy is rooted at",
  );
}

// On Demand channel (synthetic). Pipeline-only rep identities (matched on the
// feeder's User column, falling back to Opportunity Owner) that never appear in
// the Hierarchy sheet. They form a standalone third channel
// whose entire hierarchy (group / SLM / FLM / region / segment / sales role)
// is hard-coded to "On Demand". Injected in assembleHierarchy so both the base
// and the month-aware effective hierarchy include them. Deliberately kept out
// of the VP-rooted `slms` list so the channel never leaks into the SLM
// dropdown, the org tree, or the Acquisitions / G&R / All-Channels presets — it
// is reachable only via its own "On Demand" group filter.
const ON_DEMAND_CHANNEL = "On Demand";
const ON_DEMAND_REPS = [
  "Account Sales",
  // Anonymized in the demo fixtures (the other two are on the keep-list).
  demoName("Compliance Sales", DEMO_COMPLIANCE_SALES_REP),
  "Zillow Sales",
];

const CACHE_TTL_MS = 30 * 60 * 1000;
let cachedRows: ParsedRow[] | null = null;
let cacheTime = 0;
let cachedHierarchy: OrgHierarchy | null = null;
let hierarchyCacheTime = 0;

let pendingHierarchy: Promise<OrgHierarchy> | null = null;
let pendingRows: Promise<ParsedRow[]> | null = null;
let pendingWeightedPipeRows: Promise<ParsedRow[]> | null = null;
interface ModsData {
  byRep: Record<string, number>;
  byRepByProduct: Record<string, Record<string, number>>;
  byRepWeighted: Record<string, number>;
  byRepByProductWeighted: Record<string, Record<string, number>>;
  // Task #116 follow-up: per-rep × product count of scheduled mods,
  // surfaced so the Churn Forecast drilldown popup can show the
  // underlying count alongside booked/weighted amounts.
  byRepByProductCount: Record<string, Record<string, number>>;
  // Task #157: per-rep × product × churn_type breakdowns. ME contributions
  // are intentionally excluded — the ME row is a separate pinned row.
  byRepByProductByChurnType: Record<
    string,
    Record<string, Record<string, number>>
  >;
  byRepByProductByChurnTypeWeighted: Record<
    string,
    Record<string, Record<string, number>>
  >;
  byRepByProductByChurnTypeCount: Record<
    string,
    Record<string, Record<string, number>>
  >;
}
let pendingSbrs: Promise<SbrEntry[]> | null = null;
let pendingCalls: Promise<CallEntry[]> | null = null;
let pendingEmails: Promise<EmailEntry[]> | null = null;
let pendingCcDeclines: Promise<CcDeclineEntry[]> | null = null;
let pendingInbounds: Promise<InboundEntry[]> | null = null;
interface StaleOppRow {
  oppName: string;
  oppId: string;
  rep: string;
  manager: string;
  accountName: string;
  accountId: string;
  createdDate: string;
  closeDate: string;
  amount: number;
  type: string;
  product: string;
  stage: string;
}
let pendingStaleOpps: Promise<StaleOppRow[]> | null = null;

export interface SheetParseError {
  sheet: string;
  sheetUrl: string;
  message: string;
  expectedHeaders: string[];
  actualHeaders: string[];
  timestamp: number;
}

const recentParseErrors: SheetParseError[] = [];

export function addParseError(err: SheetParseError) {
  recentParseErrors.push(err);
  if (recentParseErrors.length > 50) recentParseErrors.shift();
}

export function getRecentParseErrors(): SheetParseError[] {
  return [...recentParseErrors];
}

export function clearParseErrors() {
  recentParseErrors.length = 0;
}

function sheetUrl(sheetId: string, gid: string): string {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${gid}`;
}

interface SbrEntry {
  name: string;
  timestamp: number;
  learningSessionId: string;
  manager: string;
  eventDate: string;
  contactName: string;
  contactId: string;
}
let cachedSbrs: SbrEntry[] | null = null;
let sbrCacheTime = 0;

interface CallEntry {
  name: string;
  timestamp: number;
  durationMin: number;
  isMeaningful: boolean;
  manager: string;
  accountName: string;
  accountId: string;
  oppName: string;
  oppStage: string;
  conversationTitle: string;
  conversationId: string;
  gongId: string;
  started: string;
}
let cachedCalls: CallEntry[] | null = null;
let callsCacheTime = 0;

interface EmailEntry {
  name: string;
  timestamp: number;
  createdDate: string;
  manager: string;
  contactName: string;
  contactId: string;
  accountName: string;
  subject: string;
  direction: "sent" | "received";
  activityId: string;
  comments: string;
}
let cachedEmails: EmailEntry[] | null = null;
let emailsCacheTime = 0;

interface CcDeclineEntry {
  account: string;
  contactId: string;
  rep: string;
  declinedAmount: number;
  declineDate: string;
  mrr: number;
}
let cachedCcDeclines: CcDeclineEntry[] | null = null;
let ccDeclinesCacheTime = 0;

interface InboundEntry {
  contact: string;
  interactionId: string;
  rep: string;
  leadSource: string;
  inboundTime: string;
  inboundMs: number;
  hoursSinceReply: number;
  disposition: string;
  productOfInterest: string;
  daysSinceLastActivity: number | null;
  ownerActive: boolean;
  // Task #542: new Salesforce feeder columns
  lastSalesActivity: string;
  lastActivityDate: string;
  okToContact: string;
  flexStatus: string;
  enterpriseRelated: string;
  oppStage: string;
  oppQuoteType: string;
  oppCloseDate: string;
  oppOwner: string;
  oppId18: string;
  // Task #555: 18-digit Account ID used to cross-reference the Calls (dials)
  // feed for the Last Called / Total Calls columns.
  accountId: string;
}
let cachedInbounds: InboundEntry[] | null = null;
let inboundsCacheTime = 0;

let cachedWeightedPipeRows: ParsedRow[] | null = null;
let weightedPipeCacheTime = 0;

// Original Pipeline-sheet header row (in source column order). Captured during
// parsing so the compensation export can render every raw cell under its
// original header in a consistent position. Read via getPipelineRawHeaders().
let pipelineRawHeaders: string[] = [];

// Header names (in source column order) for the raw Pipeline feeder sheet.
// Returns a defensive copy so callers can't mutate the cached header row.
export function getPipelineRawHeaders(): string[] {
  return pipelineRawHeaders.slice();
}

interface ParsedRow {
  manager: string;
  accountId: string;
  contactName: string;
  oppId: string;
  salesRole: string;
  closeDate: string;
  amount: number;
  forecastedRevenue: number;
  daysSinceActivity: number;
  type: string;
  oppName: string;
  createdDate: string;
  expectedRevenue: number;
  mrr: number;
  totalMrr: number;
  product: string;
  rep: string;
  selectProduct: string;
  stage: string;
  demoPerformedDate: string;
  splitTotalPrice: number;
  totalPrice: number;
  productFamily: string;
  rawProduct: string;
  changeInMrr: number;
  quoteType: string;
  // Task #434: the raw `User` and `Opportunity Owner` feeder columns, kept
  // independently of the blended `rep` (User || Opportunity Owner) so comp
  // conditions can test/join on each raw column. Blank when the column is
  // absent or empty.
  user: string;
  oppOwner: string;
  // Full raw feeder-sheet row for this line item, aligned positionally to
  // `pipelineRawHeaders`. Retained so the compensation export can surface the
  // untouched source row (original headers + every cell). Populated only for
  // real Pipeline-sheet rows; undefined on synthetic rows (e.g. Re/Max CPDs).
  // Kept as the parsed cell array (no per-row header duplication) so it adds
  // negligible memory and never leaks into the normal aggregation responses.
  rawCells?: string[];
  // Compensation source fields read from the Pipeline feeder sheet. Blank
  // when the sheet omits them; consumed by the downstream comp logic.
  flexFlipAgentStatus?: string;
  termLength?: string;
  // Task #347: FUB first-purchase enrichment from the
  // frontline_dash_product_data Databricks table, joined by 18-char opp id.
  // Blank/undefined for opps without a matching row (almost every non-FUB opp).
  // Exposed as a selectable comp-rule condition field; the opp id is ingested
  // and stored for future use only.
  fubFirstPurchaseDate?: string;
  fubFirstPurchaseOppId?: string;
  // legacy_flag from the frontline_dash_cpds Databricks table. Populated
  // only on synthetic ZMX CPD rows; undefined elsewhere.
  legacyFlag?: boolean;
  // Task #314: CPD change-in-MRR manual-adjustment columns from
  // frontline_dash_cpds. Populated only on synthetic CPD rows (ZMX / Showcase
  // Incremental - Re/Max). Distinct from the mrr_added-derived fields above; a
  // per-rule CPD base-MRR override may pick these instead of mrr_added.
  cpdPositiveChangeInMrr?: number;
  cpdNegativeChangeInMrr?: number;
  // Synthetic rows pulled from non-Salesforce-pipeline sources (e.g. the
  // Showcase Incremental - Re/Max CPDs Databricks table) carry their own
  // Salesforce link IDs because their `accountId` / `oppId` are not real
  // SF Account / Opportunity IDs. Populated only for those rows so the
  // drilldown can build product-specific hyperlinks.
  sfContactId?: string;
  sfCpdId?: string;
}

export interface SheetPerson {
  // Canonical full name as it appears in the sheet hierarchy.
  name: string;
  // Lowercased email; null when the sheet has no email for this person.
  email: string | null;
  // Employee ID from the sheet; null when not present. Used as a fallback
  // identity when email is missing.
  employeeId: string | null;
  // Resolved role with precedence slm > flm > rep so player-coach FLMs
  // collapse to a single row with role "flm".
  role: "slm" | "flm" | "rep";
  // The person's SLM (themselves if they are an SLM).
  slm: string | null;
  // The person's FLM (themselves if they are an FLM, null for SLMs).
  flm: string | null;
}

interface OrgHierarchy {
  slms: string[];
  slmToFlms: Record<string, string[]>;
  flmToReps: Record<string, string[]>;
  repToFlm: Record<string, string>;
  repToSlm: Record<string, string>;
  repToRegion: Record<string, string>;
  repToGroup: Record<string, string>;
  repToSegment: Record<string, string>;
  // Raw sales role per rep/flm (e.g. "Advisor", "ASA Acquisition Sales").
  // Group is derived from this; the Goals tab applies a user-editable
  // role→group mapping over these raw roles, so it needs the role itself.
  repToSalesRole: Record<string, string>;
  allReps: Set<string>;
  personToEmail: Record<string, string>;
  personToEmployeeId: Record<string, string>;
  // Per-person active flag from the hierarchy sheet's `Active` column. Absent /
  // blank entries default to active (true). The BASE hierarchy retains both
  // active and inactive people, each flagged here; the month-aware effective
  // hierarchy (fetchEffectiveHierarchy) is what actually drops inactive people.
  personToActive: Record<string, boolean>;
  // Deduped identity index for the org. Each real person appears once,
  // keyed by lowercased email (with employeeId as a fallback). Used by the
  // impersonation-list endpoint to dedupe player-coach FLMs.
  people: SheetPerson[];
  emailToPerson: Record<string, SheetPerson>;
  employeeIdToPerson: Record<string, SheetPerson>;
}

const ACQ_ROLES = new Set(["ASA Acquisition Sales"]);
const GNR_ROLES = new Set(["Advisor", "Senior Advisor", "Strategic Advisor"]);

function salesRoleToGroup(role: string): string {
  if (GNR_ROLES.has(role)) return "G&R";
  if (ACQ_ROLES.has(role)) return "Acquisitions";
  return "";
}

export { fetchSheetCSV, fetchHierarchy };

export interface FeederIndexRow {
  name: string;
  description: string;
  url: string;
  sfReportUrl: string;
}

let cachedFeederIndex: FeederIndexRow[] | null = null;
let feederIndexCacheTime = 0;

export async function fetchFeederIndex(): Promise<FeederIndexRow[]> {
  const now = Date.now();
  if (!snapshotCtxActive() && cachedFeederIndex && now - feederIndexCacheTime < CACHE_TTL_MS)
    return cachedFeederIndex;
  const text = await fetchSheetCSV(
    FEEDER_INDEX_SHEET_ID,
    FEEDER_INDEX_SHEET_GID,
  );
  const lines = text.split("\n");
  if (lines.length < 2) return [];
  const results: FeederIndexRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols: string[] = [];
    let inQuote = false;
    let field = "";
    for (const ch of line) {
      if (ch === '"') {
        inQuote = !inQuote;
        continue;
      }
      if (ch === "," && !inQuote) {
        cols.push(field.trim());
        field = "";
        continue;
      }
      field += ch;
    }
    cols.push(field.trim());
    const name = cols[0] || "";
    const description = cols[1] || "";
    const url = cols[2] || "";
    const sfReportUrl = cols[3] || "";
    if (name || url) results.push({ name, description, url, sfReportUrl });
  }
  if (!isReplayActive()) {
    cachedFeederIndex = results;
    feederIndexCacheTime = now;
  }
  return results;
}

export function invalidateCache() {
  cachedRows = null;
  cacheTime = 0;
  cachedHierarchy = null;
  hierarchyCacheTime = 0;
  // Task #428: drop the computed pipeline-result cache in lockstep so the next
  // request recomputes from fresh inputs.
  bumpDataVersion();
  // The effective hierarchies are built on top of the base hierarchy, so a base
  // refresh must drop them too or month-scoped paths would serve stale trees.
  invalidateEffectiveHierarchy();
  cachedFeederIndex = null;
  feederIndexCacheTime = 0;
  clearSchedModsCache();
  cachedSbrs = null;
  sbrCacheTime = 0;
  cachedCalls = null;
  callsCacheTime = 0;
  cachedEmails = null;
  emailsCacheTime = 0;
  cachedCcDeclines = null;
  ccDeclinesCacheTime = 0;
  cachedInbounds = null;
  inboundsCacheTime = 0;
  cachedWeightedPipeRows = null;
  weightedPipeCacheTime = 0;
  cachedStaleOpps = null;
  staleOppsCacheTime = 0;
  clearQuotaCache();
  clearGoalsQuotaCache();
  clearRemaxCpdsCache();
  clearFubFirstPurchaseCache();
  // Task #536: the Anaplan Databricks snapshot was previously omitted here, so
  // "Refresh Data" left the CPD group MRR stale until its own 30-min TTL lapsed
  // (or a restart). Clear it in lockstep so a refresh actually refetches it.
  // bumpDataVersion() already ran above, so skip clearAnaplanCache's own bump.
  clearAnaplanCache(false);
  unmappedStages.clear();
  unmappedMrrTypes.clear();
}

// Run a full upstream fetch pass that touches every chokepoint (all Google
// Sheets via fetchSheetCSV + all Databricks via executeStatement), warming the
// module caches. When `capture` is true the pass runs inside a snapshot capture
// context and the recorded raw payload is returned; otherwise null is returned.
async function runFullFetchPass(): Promise<{
  rowCount: number;
  slmCount: number;
}> {
  const [newRows, newHierarchy] = await Promise.all([
    fetchRows(),
    fetchHierarchy(),
  ]);
  await Promise.allSettled([
    fetchWeightedPipeRows(),
    fetchModsByRep(),
    fetchSbrs(),
    fetchCalls(),
    fetchEmails(),
    fetchCcDeclines(newHierarchy),
    fetchInbounds(newHierarchy),
    fetchStaleOpps(newHierarchy),
    fetchFeederIndex(),
    fetchUsHolidays(),
    // Task #536: warm (and, in capture mode, record) the Anaplan Databricks
    // snapshot as part of the full fetch pass so "Refresh Data" pulls fresh CPD
    // group MRR and the rolling good-refresh snapshot includes Anaplan data.
    fetchAnaplanData(),
  ]);
  return { rowCount: newRows.length, slmCount: newHierarchy.slms.length };
}

/**
 * Task #393: capture every raw upstream payload (Sheets CSVs + Databricks
 * data_arrays) for one full dashboard fetch pass, returning the snapshot
 * payload. Runs inside a capture context so the chokepoints record their input.
 */
export async function captureDashboardSnapshot(): Promise<SnapshotPayload> {
  return runCapture(async () => {
    await runFullFetchPass();
  });
}

/**
 * Count the pipeline data rows recorded in a captured snapshot (non-empty CSV
 * lines minus the header). Used by the snapshot health check.
 */
export function snapshotPipelineRowCount(payload: SnapshotPayload): number {
  const csv = payload.sheets[sheetSnapshotKey(PIPELINE_SHEET_ID, PIPELINE_SHEET_GID)];
  if (!csv) return 0;
  const lines = csv.split("\n").filter((l) => l.trim() !== "");
  return Math.max(0, lines.length - 1);
}

export async function refreshCacheInBackground(): Promise<void> {
  console.log("[BackgroundRefresh] Starting background cache refresh...");
  try {
    invalidateCache();
    clearQuotaCache();
    clearSchedModsCache();
    clearRemaxCpdsCache();
    clearFubFirstPurchaseCache();

    // Run the refresh inside a snapshot capture so a healthy refresh doubles as
    // the rolling "last good refresh" snapshot (Task #393). Capture mode still
    // warms the live caches.
    const payload = await runCapture(async () => {
      const { rowCount, slmCount } = await runFullFetchPass();
      console.log(
        `[BackgroundRefresh] Complete. ${rowCount} pipeline rows, ${slmCount} SLMs refreshed.`,
      );
    });

    // Persist the captured payload as last_good_refresh if it passes the health
    // check. Dynamic import avoids a static circular dependency with this file.
    // Demo mode re-reads the bundled fixture, so persisting it as a "good
    // refresh" would just copy tens of MB of fixture into the demo DB.
    if (isDemoMode()) return;
    try {
      const { storeGoodRefreshIfHealthy } = await import("./data-snapshots");
      await storeGoodRefreshIfHealthy(payload);
    } catch (e) {
      console.error(
        "[BackgroundRefresh] Failed to store good-refresh snapshot:",
        (e as Error).message,
      );
    }
  } catch (e) {
    console.error("[BackgroundRefresh] Failed:", (e as Error).message);
  }
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (line[i] === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += line[i];
    }
  }
  result.push(current.trim());
  return result;
}

function isAllowedRedirectHost(location: string): boolean {
  try {
    const url = new URL(location);
    return (
      url.hostname === "docs.google.com" ||
      url.hostname.endsWith(".googleusercontent.com")
    );
  } catch {
    return false;
  }
}

async function fetchSheetCSV(
  sheetId: string,
  gid: string = "0",
): Promise<string> {
  // Task #393: route through the snapshot context so a capture records the raw
  // CSV and a replay serves the stored one instead of hitting Google Sheets.
  return resolveSheetCSV(sheetId, gid, () => fetchSheetCSVLive(sheetId, gid));
}

async function fetchSheetCSVLive(
  sheetId: string,
  gid: string = "0",
): Promise<string> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const urls = [
    `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`,
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`,
    `https://docs.google.com/spreadsheets/d/${sheetId}/pub?output=csv&gid=${gid}`,
  ];

  for (const url of urls) {
    try {
      const resp = await fetch(url, { headers, redirect: "manual" });
      const location = resp.headers.get("location") || "";
      if (
        location.includes("accounts.google.com") ||
        location.includes("ServiceLogin")
      ) {
        continue;
      }
      if (resp.status >= 200 && resp.status < 400) {
        if (resp.status >= 300) {
          if (!isAllowedRedirectHost(location)) continue;
          const followResp = await fetch(location, { headers });
          if (followResp.ok) return await followResp.text();
          continue;
        }
        return await resp.text();
      }
    } catch {
      continue;
    }
  }
  throw new Error("Could not fetch sheet — tried all endpoints");
}

async function fetchHierarchy(): Promise<OrgHierarchy> {
  const now = Date.now();
  if (!snapshotCtxActive() && cachedHierarchy && now - hierarchyCacheTime < CACHE_TTL_MS)
    return cachedHierarchy;
  if (!snapshotCtxActive() && pendingHierarchy) return pendingHierarchy;
  const run = _fetchHierarchyImpl().finally(() => {
    pendingHierarchy = null;
  });
  pendingHierarchy = run;
  return run;
}

async function _fetchHierarchyImpl(): Promise<OrgHierarchy> {
  const now = Date.now();
  const text = await fetchSheetCSV(HIERARCHY_SHEET_ID, HIERARCHY_SHEET_GID);
  const lines = text.split("\n");

  let headerRowIdx = 0;
  let foundHeader = false;
  for (let r = 0; r < Math.min(10, lines.length); r++) {
    const cols = parseCSVLine(lines[r]);
    if (cols.some((c) => c.toLowerCase().trim() === "full name")) {
      headerRowIdx = r;
      foundHeader = true;
      break;
    }
  }
  const headerLine = lines[headerRowIdx]
    ? parseCSVLine(lines[headerRowIdx])
    : [];

  if (!foundHeader) {
    const first5 = lines
      .slice(0, 5)
      .map((l) => parseCSVLine(l).slice(0, 8).join(", "));
    const errMsg = `[Hierarchy] Could not find header row containing "full name". First 5 rows: ${first5.join(" | ")}`;
    console.error(errMsg);
    addParseError({
      sheet: "Hierarchy",
      sheetUrl: sheetUrl(HIERARCHY_SHEET_ID, HIERARCHY_SHEET_GID),
      message: 'Header row not found — expected a column called "full name"',
      expectedHeaders: [
        "full name",
        "email",
        "sales region",
        "sales role",
        "manager: full name",
      ],
      actualHeaders: headerLine.slice(0, 10),
      timestamp: Date.now(),
    });
  }

  const colIdx = (names: string[]) =>
    headerLine.findIndex((h) => names.includes(h.toLowerCase().trim()));

  const emailColIdx = colIdx(["email", "email address"]);
  const empIdColIdx = colIdx([
    "employee number",
    "employee id",
    "employee id number",
    "emp id",
    "employeeid",
    "eid",
  ]);
  const headshotColIdx = colIdx([
    "headshot photo url",
    "headshot",
    "photo url",
  ]);
  const regionColIdx = colIdx(["sales region"]);
  const roleColIdx = colIdx(["sales role"]);
  const segmentColIdx = colIdx(["sales segment", "segment"]);
  const managerColIdx = colIdx(["manager: full name", "manager"]);
  const nameColIdx = colIdx(["full name"]);
  const activeColIdx = colIdx(["active", "is active", "active?"]);

  const criticalCols = { nameColIdx, managerColIdx, regionColIdx, roleColIdx };
  const missing = Object.entries(criticalCols)
    .filter(([, v]) => v === -1)
    .map(([k]) => k.replace("ColIdx", ""));
  if (missing.length > 0) {
    const errMsg = `[Hierarchy] Missing critical columns: ${missing.join(", ")}. Available headers: ${headerLine.slice(0, 15).join(", ")}`;
    console.error(errMsg);
    addParseError({
      sheet: "Hierarchy",
      sheetUrl: sheetUrl(HIERARCHY_SHEET_ID, HIERARCHY_SHEET_GID),
      message: `Missing critical columns: ${missing.join(", ")}`,
      expectedHeaders: [
        "full name",
        "manager: full name",
        "sales region",
        "sales role",
      ],
      actualHeaders: headerLine.slice(0, 15),
      timestamp: Date.now(),
    });
  }

  console.log(
    "[Hierarchy] Header row:",
    headerRowIdx,
    "| cols:",
    headerLine.length,
    "| empIdCol:",
    empIdColIdx,
    "| emailCol:",
    emailColIdx,
    "| headshotCol:",
    headshotColIdx,
  );

  const personToManager: Record<string, string> = {};
  const personToRegion: Record<string, string> = {};
  const personToGroup: Record<string, string> = {};
  const personToSalesRole: Record<string, string> = {};
  const personToSegment: Record<string, string> = {};
  const personToEmail: Record<string, string> = {};
  const personToEmployeeId: Record<string, string> = {};
  const personToActive: Record<string, boolean> = {};

  for (let i = headerRowIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVLine(line);
    if (cols.length < 10) continue;
    const salesRegion = regionColIdx >= 0 ? cols[regionColIdx] : cols[3];
    const salesRole = roleColIdx >= 0 ? cols[roleColIdx] : cols[4];
    const managerName = managerColIdx >= 0 ? cols[managerColIdx] : cols[8];
    const fullName = nameColIdx >= 0 ? cols[nameColIdx] : cols[9];
    if (!fullName || fullName === "Full Name") continue;
    personToManager[fullName] = managerName;
    if (salesRegion) personToRegion[fullName] = salesRegion;
    const group = salesRoleToGroup(salesRole);
    if (group) personToGroup[fullName] = group;
    if (salesRole) personToSalesRole[fullName] = salesRole.trim();
    const salesSegment =
      segmentColIdx >= 0 ? (cols[segmentColIdx] || "").trim() : "";
    if (salesSegment) personToSegment[fullName] = salesSegment;
    if (emailColIdx >= 0 && cols[emailColIdx]) {
      personToEmail[fullName] = cols[emailColIdx].trim().toLowerCase();
    }
    if (empIdColIdx >= 0 && cols[empIdColIdx]) {
      personToEmployeeId[fullName] = cols[empIdColIdx].trim();
    }
    // Active column: TRUE/FALSE (case-insensitive); blank/missing defaults to
    // active. Only an explicit falsey value (FALSE / NO / 0) marks inactive.
    personToActive[fullName] = parseActiveFlag(
      activeColIdx >= 0 ? cols[activeColIdx] : undefined,
    );
  }

  const assembled = assembleHierarchy({
    personToManager,
    personToRegion,
    personToGroup,
    personToSalesRole,
    personToSegment,
    personToEmail,
    personToEmployeeId,
    personToActive,
  });
  if (!isReplayActive()) {
    cachedHierarchy = assembled;
    hierarchyCacheTime = now;
  }
  return assembled;
}

/** Normalize a sheet `Active` cell to a boolean (blank/missing ⇒ active). */
export function parseActiveFlag(raw: string | undefined): boolean {
  if (raw == null) return true;
  const v = raw.trim().toLowerCase();
  if (v === "") return true;
  return !(v === "false" || v === "no" || v === "n" || v === "0" || v === "inactive");
}

interface AssembleHierarchyInputs {
  // Each person's manager (full name); the SLM tier is whoever reports to the VP.
  personToManager: Record<string, string>;
  personToRegion: Record<string, string>;
  personToGroup: Record<string, string>;
  personToSalesRole: Record<string, string>;
  personToSegment: Record<string, string>;
  personToEmail: Record<string, string>;
  personToEmployeeId: Record<string, string>;
  personToActive: Record<string, boolean>;
}

/**
 * Pure tree-assembly: turns the per-person attribute maps into the full
 * OrgHierarchy (SLM → FLM → Rep tree + the flat lookup maps + deduped identity
 * index). Used both for the BASE hierarchy (every parsed person) and for the
 * month-aware effective hierarchy (after overrides are applied and inactive
 * people are removed from `personToManager`). To drop a person from the
 * effective org, omit them from `personToManager` before calling.
 */
export function assembleHierarchy(inp: AssembleHierarchyInputs): OrgHierarchy {
  const {
    personToManager,
    personToRegion,
    personToGroup,
    personToSalesRole,
    personToSegment,
    personToEmail,
    personToEmployeeId,
    personToActive,
  } = inp;

  const directReports = Object.entries(personToManager)
    .filter(([_, mgr]) => mgr === VP_NAME)
    .map(([name]) => name)
    .sort();

  const slmToFlms: Record<string, string[]> = {};
  const flmToReps: Record<string, string[]> = {};
  const repToFlm: Record<string, string> = {};
  const repToSlm: Record<string, string> = {};
  const repToRegion: Record<string, string> = {};
  const repToGroup: Record<string, string> = {};
  const repToSegment: Record<string, string> = {};
  const repToSalesRole: Record<string, string> = {};
  const allReps = new Set<string>();

  for (const slm of directReports) {
    const flms = Object.entries(personToManager)
      .filter(([_, mgr]) => mgr === slm)
      .map(([name]) => name)
      .sort();

    slmToFlms[slm] = flms;

    for (const flm of flms) {
      const reps = Object.entries(personToManager)
        .filter(([_, mgr]) => mgr === flm)
        .map(([name]) => name)
        .sort();

      flmToReps[flm] = reps;

      for (const rep of reps) {
        repToFlm[rep] = flm;
        repToSlm[rep] = slm;
        if (personToRegion[rep]) repToRegion[rep] = personToRegion[rep];
        if (personToGroup[rep]) repToGroup[rep] = personToGroup[rep];
        if (personToSegment[rep]) repToSegment[rep] = personToSegment[rep];
        if (personToSalesRole[rep])
          repToSalesRole[rep] = personToSalesRole[rep];
        allReps.add(rep);
      }

      repToFlm[flm] = flm;
      repToSlm[flm] = slm;
      if (personToRegion[flm]) repToRegion[flm] = personToRegion[flm];
      if (personToGroup[flm]) repToGroup[flm] = personToGroup[flm];
      if (personToSegment[flm]) repToSegment[flm] = personToSegment[flm];
      if (personToSalesRole[flm]) repToSalesRole[flm] = personToSalesRole[flm];
      allReps.add(flm);
    }

    slmToFlms[slm].forEach((flm) => {
      repToSlm[flm] = slm;
    });
  }

  // Inject the synthetic On Demand channel: a standalone SLM=FLM="On Demand"
  // branch holding the Pipeline-only On Demand reps. They are added to the flat lookup
  // maps + allReps (so every per-rep aggregation/drop-check keeps them) and to
  // slmToFlms/flmToReps (so the channel renders as its own branch), but NOT to
  // `directReports`/`slms` above — keeping it out of config.org, the SLM
  // dropdown, and the SLM-list presets. Their MRR (added/churn/acqNet) is
  // bucketed by the same per-rep logic as everyone else; the G&R-style net is
  // selected on the frontend. They carry no email/employeeId, so they are
  // intentionally absent from the identity index (not impersonatable).
  slmToFlms[ON_DEMAND_CHANNEL] = [ON_DEMAND_CHANNEL];
  flmToReps[ON_DEMAND_CHANNEL] = [...ON_DEMAND_REPS];
  for (const rep of ON_DEMAND_REPS) {
    repToFlm[rep] = ON_DEMAND_CHANNEL;
    repToSlm[rep] = ON_DEMAND_CHANNEL;
    repToRegion[rep] = ON_DEMAND_CHANNEL;
    repToGroup[rep] = ON_DEMAND_CHANNEL;
    repToSegment[rep] = ON_DEMAND_CHANNEL;
    repToSalesRole[rep] = ON_DEMAND_CHANNEL;
    allReps.add(rep);
    if (personToActive[rep] === undefined) personToActive[rep] = true;
  }

  // Build the deduped identity index. Walk SLM → FLM → Rep so that role
  // precedence is slm > flm > rep: anyone first seen as an SLM/FLM stays at
  // that role even if they appear again later as one of their own reps
  // (player-coach FLMs). The dedupe key is lowercased email when present,
  // employee ID as a fallback, and finally the canonical name — so two sheet
  // rows that share an email/eid collapse to one entry even if the name
  // varies.
  const peopleByKey = new Map<string, SheetPerson>();
  const identityKey = (name: string): string => {
    const email = (personToEmail[name] || "").trim().toLowerCase();
    if (email) return `email:${email}`;
    const eid = (personToEmployeeId[name] || "").trim();
    if (eid) return `eid:${eid}`;
    return `name:${name}`;
  };
  const addPerson = (
    name: string,
    role: "slm" | "flm" | "rep",
    slm: string | null,
    flm: string | null,
  ) => {
    if (!name) return;
    const key = identityKey(name);
    if (peopleByKey.has(key)) return;
    peopleByKey.set(key, {
      name,
      email: personToEmail[name] ? personToEmail[name].toLowerCase() : null,
      employeeId: personToEmployeeId[name] ?? null,
      role,
      slm,
      flm,
    });
  };
  for (const slmName of directReports) {
    addPerson(slmName, "slm", slmName, null);
    for (const flmName of slmToFlms[slmName] || []) {
      addPerson(flmName, "flm", slmName, flmName);
      for (const repName of flmToReps[flmName] || []) {
        addPerson(repName, "rep", slmName, flmName);
      }
    }
  }
  const people = [...peopleByKey.values()];
  const emailToPerson: Record<string, SheetPerson> = {};
  const employeeIdToPerson: Record<string, SheetPerson> = {};
  for (const p of people) {
    if (p.email) emailToPerson[p.email] = p;
    if (p.employeeId) employeeIdToPerson[p.employeeId] = p;
  }

  return {
    slms: directReports,
    slmToFlms,
    flmToReps,
    repToFlm,
    repToSlm,
    repToRegion,
    repToGroup,
    repToSegment,
    repToSalesRole,
    allReps,
    personToEmail,
    personToEmployeeId,
    personToActive,
    people,
    emailToPerson,
    employeeIdToPerson,
  };
}

// ---------------------------------------------------------------------------
// Month-aware effective hierarchy
// ---------------------------------------------------------------------------
//
// The effective hierarchy = the base sheet hierarchy + that month's roster
// overrides, with inactive people removed. Every month-scoped data /
// aggregation / quota / comp / drilldown path resolves the hierarchy through
// this layer so the default inactive-exclusion and per-month overrides
// (Active, FLM/manager, SLM, region, segment, sales role) propagate everywhere
// for the selected month. Auth / role / impersonation deliberately stay on the
// BASE hierarchy (fetchHierarchy) so eligibility never changes month-to-month.

interface EffectiveHierarchyCacheEntry {
  hierarchy: OrgHierarchy;
  at: number;
}
const effectiveHierarchyCache = new Map<string, EffectiveHierarchyCacheEntry>();

/** Drop cached effective hierarchies (all, or one month) after override writes. */
export function invalidateEffectiveHierarchy(month?: string): void {
  if (month) {
    // Keys are `<db scope>|<month>` (scope is "" in live mode); drop that month
    // across every scope.
    const suffix = `|${canonicalRosterMonth(month) ?? month}`;
    for (const k of [...effectiveHierarchyCache.keys()]) {
      if (k.endsWith(suffix)) effectiveHierarchyCache.delete(k);
    }
  } else {
    effectiveHierarchyCache.clear();
  }
}

/**
 * Resolve the org hierarchy for a specific month, applying that month's roster
 * overrides on top of the base sheet hierarchy and excluding inactive people.
 * Returns the same OrgHierarchy shape as fetchHierarchy so callers are
 * drop-in. Cached per month (TTL matches the base hierarchy) and invalidated
 * explicitly on override writes.
 */
export async function fetchEffectiveHierarchy(
  month: string,
): Promise<OrgHierarchy> {
  const key = canonicalRosterMonth(month) ?? month;
  // Roster overrides are DB-backed and therefore per-session in demo mode, so
  // the cache key carries the DB scope ("" in live mode ⇒ unchanged keys).
  const cacheKey = `${dbScopeKey()}|${key}`;
  const now = Date.now();
  if (!snapshotCtxActive()) {
    const cached = effectiveHierarchyCache.get(cacheKey);
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.hierarchy;
  }

  const [base, overrides] = await Promise.all([
    fetchHierarchy(),
    getRosterOverridesForMonth(key),
  ]);

  const built = buildEffectiveHierarchy(base, overrides);
  if (!isReplayActive()) {
    effectiveHierarchyCache.set(cacheKey, { hierarchy: built, at: now });
  }
  return built;
}

/**
 * Durable identity key for a person: email -> employee ID -> canonical name.
 * Roster overrides are stored against this key (not the raw display name) so an
 * override survives feeder name changes. Mirrors the dedupe identity used when
 * the base hierarchy is assembled.
 */
export function personIdentityKey(h: OrgHierarchy, name: string): string {
  const email = (h.personToEmail[name] || "").trim().toLowerCase();
  if (email) return `email:${email}`;
  const eid = (h.personToEmployeeId[name] || "").trim();
  if (eid) return `eid:${eid}`;
  return `name:${name}`;
}

/** Pure: apply a month's roster overrides to the base hierarchy. Exported for tests.
 * `overrides` is keyed by durable person identity (see personIdentityKey). */
export function buildEffectiveHierarchy(
  base: OrgHierarchy,
  overrides: Map<string, RosterOverride>,
): OrgHierarchy {
  // Reconstruct each in-tree person's role + manager from the base hierarchy.
  const roleOf = new Map<string, "slm" | "flm" | "rep">();
  for (const p of base.people) roleOf.set(p.name, p.role);

  const baseManagerOf = (name: string): string => {
    const role = roleOf.get(name);
    if (role === "slm") return VP_NAME;
    if (role === "flm") return base.repToSlm[name] ?? VP_NAME;
    return base.repToFlm[name] ?? "";
  };

  const ovFor = (name: string): RosterOverride | undefined =>
    overrides.get(personIdentityKey(base, name));

  const effectiveActive = (name: string): boolean => {
    const ov = ovFor(name);
    if (ov && ov.active != null) return ov.active;
    return base.personToActive[name] !== false;
  };

  // Effective manager for a person (same override precedence as the main
  // loop below) — used to walk ancestor chains before assembly.
  const effManagerOf = (name: string): string => {
    const ov = ovFor(name);
    const role = roleOf.get(name) ?? "rep";
    let manager = baseManagerOf(name);
    if (role === "rep" && ov?.flm != null && ov.flm.trim() !== "") {
      manager = ov.flm.trim();
    } else if (role === "flm" && ov?.slm != null && ov.slm.trim() !== "") {
      manager = ov.slm.trim();
    }
    return manager;
  };

  // Container retention: an INACTIVE FLM/SLM is kept in the tree (as a
  // container-only node) when at least one ACTIVE person remains beneath
  // them; they are dropped only once their whole subtree is inactive. Walk up
  // from every effective-active person and retain each inactive ancestor.
  const retained = new Set<string>();
  for (const p of base.people) {
    if (!effectiveActive(p.name)) continue;
    let cur = effManagerOf(p.name);
    let guard = 0;
    while (cur && cur !== VP_NAME && guard++ < 4) {
      if (!effectiveActive(cur)) retained.add(cur);
      cur = roleOf.has(cur) ? effManagerOf(cur) : "";
    }
    // A rep-level SLM override re-points the rep under that SLM; retain the
    // target SLM too if it is inactive.
    const ov = ovFor(p.name);
    if (
      (roleOf.get(p.name) ?? "rep") === "rep" &&
      ov?.slm != null &&
      ov.slm.trim() !== "" &&
      !effectiveActive(ov.slm.trim())
    ) {
      retained.add(ov.slm.trim());
    }
  }

  // Build the per-person attribute maps the assembler consumes, applying
  // overrides. Inactive people are simply omitted from personToManager so the
  // tree assembly never sees them (they vanish from every list / total / quota).
  const personToManager: Record<string, string> = {};
  const personToRegion: Record<string, string> = {};
  const personToGroup: Record<string, string> = {};
  const personToSalesRole: Record<string, string> = {};
  const personToSegment: Record<string, string> = {};
  const personToActive: Record<string, boolean> = {};
  // Explicit rep-level SLM overrides applied AFTER assembly (a rep can be put
  // under a different SLM than their FLM's; the manager-link tree can't express
  // that, so we post-patch repToSlm).
  const repSlmPatch: Record<string, string> = {};

  for (const p of base.people) {
    const name = p.name;
    personToActive[name] = effectiveActive(name);
    // Dropped from the effective org — unless retained as a container-only
    // manager node (inactive FLM/SLM with active people beneath).
    if (!personToActive[name] && !retained.has(name)) continue;

    const ov = ovFor(name);
    const role = roleOf.get(name) ?? "rep";

    // Manager / reassignment.
    let manager = baseManagerOf(name);
    if (role === "rep" && ov?.flm != null && ov.flm.trim() !== "") {
      manager = ov.flm.trim();
    } else if (role === "flm" && ov?.slm != null && ov.slm.trim() !== "") {
      manager = ov.slm.trim();
    }
    personToManager[name] = manager;

    // A rep that only overrides its SLM (not its FLM) keeps its FLM but is
    // re-pointed to the chosen SLM after assembly.
    if (role === "rep" && ov?.slm != null && ov.slm.trim() !== "") {
      repSlmPatch[name] = ov.slm.trim();
    }

    // Attribute overrides (fall back to the base value when not overridden).
    const region = ov?.region != null && ov.region.trim() !== ""
      ? ov.region.trim()
      : base.repToRegion[name];
    if (region) personToRegion[name] = region;

    const segment = ov?.segment != null && ov.segment.trim() !== ""
      ? ov.segment.trim()
      : base.repToSegment[name];
    if (segment) personToSegment[name] = segment;

    const salesRole = ov?.salesRole != null && ov.salesRole.trim() !== ""
      ? ov.salesRole.trim()
      : base.repToSalesRole[name];
    if (salesRole) personToSalesRole[name] = salesRole;

    // Group is derived from the (possibly overridden) sales role; fall back to
    // the base group when the role maps to no group.
    const group = salesRole ? salesRoleToGroup(salesRole) : "";
    const finalGroup = group || base.repToGroup[name];
    if (finalGroup) personToGroup[name] = finalGroup;
  }

  const built = assembleHierarchy({
    personToManager,
    personToRegion,
    personToGroup,
    personToSalesRole,
    personToSegment,
    personToEmail: base.personToEmail,
    personToEmployeeId: base.personToEmployeeId,
    personToActive,
  });

  // Apply explicit rep-level SLM overrides that the manager-link tree can't
  // express (rep kept under their FLM but rolled up to a different SLM).
  for (const [rep, slm] of Object.entries(repSlmPatch)) {
    if (built.repToSlm[rep]) built.repToSlm[rep] = slm;
  }

  // Orphaned FLM support: an FLM-role person with no SLM mapping resolves to
  // manager=VP, which makes the assembler place them on the SLM tier and
  // misclassify their direct reports as FLM nodes. Rewire such branches into
  // the SLM=FLM shape (like the On Demand channel): the orphan FLM stays at
  // the org root as its own single-FLM branch and their reports become reps.
  for (const p of base.people) {
    const name = p.name;
    if (roleOf.get(name) !== "flm") continue;
    if (personToManager[name] !== VP_NAME) continue;
    if (!built.slms.includes(name)) continue;

    const reports = Object.entries(personToManager)
      .filter(([, mgr]) => mgr === name)
      .map(([n]) => n)
      .sort();

    built.slmToFlms[name] = [name];
    built.flmToReps[name] = reports;
    // The orphan FLM gets the standard FLM self-rep entries (stripped below
    // when they are a retained inactive container).
    built.repToFlm[name] = name;
    built.repToSlm[name] = name;
    built.allReps.add(name);

    for (const r of reports) {
      // Undo the assembler's FLM-tier classification of the reports.
      delete built.flmToReps[r];
      built.repToFlm[r] = name;
      built.repToSlm[r] = name;
      built.allReps.add(r);
      const person = built.people.find((pp) => pp.name === r);
      if (person) {
        person.role = "rep";
        person.flm = name;
        person.slm = name;
      }
    }
    const self = built.people.find((pp) => pp.name === name);
    if (self) {
      self.role = "flm";
      self.flm = name;
      self.slm = name;
    }
  }

  // Container-only nodes: retained inactive FLMs must NOT count as their own
  // rep — remove the self-rep entries the assembler adds for every FLM so
  // their personal rows are excluded from all per-rep row guards
  // (allReps.has(rep) / repToFlm[rep]) while the tree structure stays intact.
  for (const name of retained) {
    if (built.repToFlm[name] === name) {
      built.allReps.delete(name);
      delete built.repToFlm[name];
    }
  }

  return built;
}

// ---------------------------------------------------------------------------
// Roster view (Executive → Roster)
// ---------------------------------------------------------------------------

/** A non-null field set (base / effective). */
export interface RosterFieldSet {
  active: boolean;
  flm: string | null;
  slm: string | null;
  region: string | null;
  segment: string | null;
  salesRole: string | null;
}

/** The override field set — every field nullable (`null` = no override). */
export interface RosterOverrideSet {
  active: boolean | null;
  flm: string | null;
  slm: string | null;
  region: string | null;
  segment: string | null;
  salesRole: string | null;
}

/** One roster row: a person's base values, their month override, and the
 * resulting effective values. Includes everyone (active AND inactive). */
export interface RosterPersonRow {
  person: string;
  role: "slm" | "flm" | "rep";
  base: RosterFieldSet;
  override: RosterOverrideSet;
  effective: RosterFieldSet;
}

/**
 * Build the editable Roster for a month: every person in the base hierarchy
 * (active + inactive) with their base hierarchy values, the stored per-month
 * overrides, and the resolved effective values (override ?? base). Used by the
 * Executive → Roster tab.
 */
export async function buildRosterForMonth(
  month: string,
): Promise<{ month: string; rows: RosterPersonRow[] }> {
  const key = canonicalRosterMonth(month) ?? month;
  const [base, overrides] = await Promise.all([
    fetchHierarchy(),
    getRosterOverridesForMonth(key),
  ]);

  const roleOf = new Map<string, "slm" | "flm" | "rep">();
  for (const p of base.people) roleOf.set(p.name, p.role);

  const rows: RosterPersonRow[] = base.people.map((p) => {
    const name = p.name;
    const baseActive = base.personToActive[name] !== false;
    const baseFlm = base.repToFlm[name] ?? null;
    const baseSlm = base.repToSlm[name] ?? null;
    const baseRegion = base.repToRegion[name] ?? null;
    const baseSegment = base.repToSegment[name] ?? null;
    const baseSalesRole = base.repToSalesRole[name] ?? null;

    const ov = overrides.get(personIdentityKey(base, name));
    const ovActive = ov?.active ?? null;
    const ovFlm = ov?.flm ?? null;
    const ovSlm = ov?.slm ?? null;
    const ovRegion = ov?.region ?? null;
    const ovSegment = ov?.segment ?? null;
    const ovSalesRole = ov?.salesRole ?? null;

    return {
      person: name,
      role: roleOf.get(name) ?? "rep",
      base: {
        active: baseActive,
        flm: baseFlm,
        slm: baseSlm,
        region: baseRegion,
        segment: baseSegment,
        salesRole: baseSalesRole,
      },
      override: {
        active: ovActive,
        flm: ovFlm,
        slm: ovSlm,
        region: ovRegion,
        segment: ovSegment,
        salesRole: ovSalesRole,
      },
      effective: {
        active: ovActive ?? baseActive,
        flm: ovFlm ?? baseFlm,
        slm: ovSlm ?? baseSlm,
        region: ovRegion ?? baseRegion,
        segment: ovSegment ?? baseSegment,
        salesRole: ovSalesRole ?? baseSalesRole,
      },
    };
  });

  rows.sort((a, b) => a.person.localeCompare(b.person));
  return { month: key, rows };
}

export async function fetchRows(): Promise<ParsedRow[]> {
  // Task #440: keep the in-memory Product Logic config coherent with the
  // persisted DB config before any per-row resolution (product attribution is
  // baked into the parsed rows; standardizeMrr / resolveMrrField read the active
  // config synchronously per row). TTL-guarded and backed by getProductLogicConfig's
  // own 30s cache, so this is a cheap no-op on the hot path. When the config
  // actually changed (drift correction or an out-of-band write), drop the parsed-
  // rows cache so attribution re-resolves and bump the data version so the
  // computed pipeline-result cache rebuilds — keeping the aggregate cards in
  // lockstep with the per-request drilldown. Skipped during snapshot/replay,
  // which run against pinned data and must not mutate live caches.
  if (!snapshotCtxActive() && !isReplayActive()) {
    const plChanged = await refreshActiveProductLogicConfig();
    if (plChanged) {
      cachedRows = null;
      cacheTime = 0;
      bumpDataVersion();
    }
  }
  const now = Date.now();
  if (!snapshotCtxActive() && cachedRows && now - cacheTime < CACHE_TTL_MS)
    return cachedRows;
  if (!snapshotCtxActive() && pendingRows) return pendingRows;
  const run = (async () => {
    const [sheetRows, remaxRows] = await Promise.all([
      _fetchRowsImpl(),
      _fetchRemaxCpdRowsAsParsed(),
    ]);
    const all = [...sheetRows, ...remaxRows];
    if (!isReplayActive()) {
      cachedRows = all;
      cacheTime = Date.now();
      // Task #428: a fresh raw-rows store (TTL expiry or refresh) advances the
      // data version so the computed pipeline-result cache rebuilds.
      bumpDataVersion();
      // Snapshot one representative opp per Product Logic rule (Task #350) so
      // the editor always has a concrete example, even outside the ~2-month
      // feeder window. Fire-and-forget — never blocks or fails the data load.
      captureProductLogicExamples(all);
    }
    return all;
  })().finally(() => {
    pendingRows = null;
  });
  pendingRows = run;
  return run;
}

// Snapshot a representative example opportunity for each Product Logic rule
// (Task #350). Persists the first row that matched each rule so the editor can
// always show a concrete example and prefill new rules, even for products that
// fall outside the ~2-month feeder window. Never throws.
function captureProductLogicExamples(allRows: ParsedRow[]): void {
  try {
    const sourceByRule = new Map(getActiveRules().map((r) => [r.id, r.source]));
    const seen = new Map<string, ProductLogicExampleInput>();
    for (const r of allRows) {
      const m = evaluateProductLogic(r);
      if (!m.ruleId || seen.has(m.ruleId)) continue;
      seen.set(m.ruleId, {
        ruleId: m.ruleId,
        source: sourceByRule.get(m.ruleId) ?? "feeder",
        fields: {
          oppName: r.oppName || "",
          type: r.type || "",
          rawProduct: r.rawProduct || "",
          productFamily: r.productFamily || "",
          product: r.product || "",
          stage: r.stage || "",
          closeDate: r.closeDate || "",
          changeInMrr: String(r.changeInMrr ?? ""),
          splitTotalPrice: String(r.splitTotalPrice ?? ""),
        },
        oppId: r.oppId || null,
        accountId: r.accountId || null,
        sfContactId: r.sfContactId || null,
        sfCpdId: r.sfCpdId || null,
      });
    }
    if (seen.size > 0) void replaceProductLogicExamples([...seen.values()]);
  } catch (err) {
    console.error(
      "[ProductLogic] captureProductLogicExamples failed:",
      (err as Error).message,
    );
  }
}

// Pulls Re/Max CPDs from Databricks and projects them into synthetic
// `ParsedRow` entries so they flow through every downstream pipeline
// aggregation (productCwMtd, productCwByMonth, productCwDaysByMonth,
// productFunnel) automatically as "Showcase Incremental - Re/Max"
// Closed Won rows. Failures are logged inside fetchRemaxCpds and surface
// as an empty list here — the rest of the pipeline still loads.
async function _fetchRemaxCpdRowsAsParsed(): Promise<ParsedRow[]> {
  try {
    const cpds = await fetchRemaxCpds();
    return cpds.map((c) => {
      // The CPD table (frontline_dash_cpds) carries two products in its
      // `product` column: "Showcase Incremental - Re/Max" (a Showcase
      // subtype that rolls up into the Showcase quota row) and "ZMX" (a
      // fully independent product that does NOT roll into Showcase).
      // Re/Max rows keep their original attribution unchanged; ZMX rows
      // become their own first-class product bucket.
      const isZmx = (c.product || "").trim() === "ZMX";
      const productName = isZmx ? "ZMX" : "Showcase Incremental - Re/Max";
      return {
        manager: c.flmName || "",
        // accountId / oppId carry the identity used everywhere in the
        // aggregation pipeline (dedupe keys, ownership lookups). These rows
        // reuse their bare Salesforce ids directly: accountId = the Contact
        // id (sfContactId), oppId = the canonicalized CPD id (sfCpdId). When
        // a row has no Contact id we fall back to a composite key so ownership
        // routing still has a stable, unique handle. The same ids also ride on
        // sfContactId / sfCpdId so the drilldown can build the Contact /
        // Compensation__c hyperlinks (the default Account / Opportunity link
        // templates would 404 on these Contact / CPD object types).
        accountId: c.sfContactId
          ? c.sfContactId
          : `${c.repName}|${c.closeDate}|${c.mrrAdded}`,
        contactName: c.contactName || "",
        oppId: c.sfCpdId ? canonicalizeOppId(c.sfCpdId) : "",
        salesRole: "",
        closeDate: c.closeDate,
        amount: c.mrrAdded,
        forecastedRevenue: 0,
        daysSinceActivity: 0,
        // SCI-R and ZMX are each their own distinct product bucket throughout
        // every aggregator (productFunnel, productCwMtd, productCwByMonth,
        // productCwDaysByMonth, weightedProductFunnel, productChurn). SCI-R
        // rolls up into the Showcase quota row alongside SCI in
        // PipelineView.tsx; ZMX is an independent top-level product.
        type: productName,
        oppName: productName,
        createdDate: "",
        expectedRevenue: 0,
        mrr: c.mrrAdded,
        totalMrr: c.mrrAdded,
        product: productName,
        rep: c.repName,
        selectProduct: "",
        stage: "Closed Won",
        demoPerformedDate: "",
        // Routed through standardizeMrr() — the new branch returns
        // splitTotalPrice for this type, so this is what shows up as MRR.
        splitTotalPrice: c.mrrAdded,
        totalPrice: c.mrrAdded,
        productFamily: "",
        rawProduct: c.product || "",
        changeInMrr: c.mrrAdded,
        quoteType: "",
        // Task #434: CPD rows have no separate User column; their owner is the
        // synthetic repName. Surface it as oppOwner; user stays blank.
        user: "",
        oppOwner: c.repName,
        // legacy_flag only carries meaning for ZMX rows; leave it undefined
        // for SCI-R so it never participates in non-ZMX comp logic.
        legacyFlag: isZmx ? c.legacyFlag : undefined,
        sfContactId: c.sfContactId || undefined,
        sfCpdId: c.sfCpdId || undefined,
        // Task #314: dedicated CPD change-in-MRR columns, distinct from the
        // mrr_added-derived fields above. A CPD rule's base-MRR override can
        // select these; mrr_added stays the default base.
        cpdPositiveChangeInMrr: c.positiveChangeInMrr,
        cpdNegativeChangeInMrr: c.negativeChangeInMrr,
      };
    });
  } catch (err) {
    console.error(
      "[RemaxCpds] _fetchRemaxCpdRowsAsParsed failed:",
      (err as Error).message,
    );
    return [];
  }
}

function findHeaderColumns(headerLine: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  const norm = (s: string) => s.toLowerCase().trim();
  headerLine.forEach((h, i) => {
    map[norm(h)] = i;
  });
  return map;
}

function colIdx(map: Record<string, number>, names: string[]): number {
  for (const n of names) {
    const idx = map[n.toLowerCase().trim()];
    if (idx !== undefined) return idx;
  }
  return -1;
}

// Attribute a feeder opp to its canonical product. Thin wrapper over the
// Product Logic engine (Task #350): the legacy hardcoded type-switch now lives
// in the editable, DB-stored, first-match rule set whose seed reproduces this
// exactly. Task #575: takes the FULL row (not just type/rawProduct/
// productFamily) so rules conditioned on quoteType, termLength, closeDate,
// etc. match identically here and in standardizeMrr — a partial row silently
// fails any condition on an omitted field and falls to the catch-all, which is
// how FUB/zPro amend & cancel opps got bucketed under "Unified Opp". CPD
// synthetic rows set their product directly and never call this.
export function attributeProduct(row: ProductLogicMatchRow): string {
  return resolveProduct(row);
}

interface ParsedOppsSheet {
  rows: ParsedRow[];
  headerCols: string[];
  headerIdx: number;
  userMatchedCount: number;
}

// Parses one opportunity feeder sheet — the main `frontline_opps_data_V2` or the
// split-out `ondemand_frontline_opps_data_V2` (Task #392). Both sheets share the
// exact same columns, so a single header detection + column map + row builder is
// shared between them. Returns null when the header row can't be found (a parse
// error is recorded here; the caller decides whether that is fatal).
//
// `refHeaders`: when unioning a second sheet, pass the main sheet's header row.
// If the second sheet's column ORDER differs, each row's `rawCells` is realigned
// to the reference order so the unioned dataset's `pipelineRawHeaders`/`rawCells`
// (consumed positionally by the compensation export) stay consistent.
function parseOppsSheet(
  text: string,
  fubIndex: ReturnType<typeof buildFubFirstPurchaseIndex>,
  opts: {
    sheetLabel: string;
    sheetId: string;
    gid: string;
    refHeaders?: string[];
  },
): ParsedOppsSheet | null {
  const lines = text.split("\n");

  let headerIdx = -1;
  let headerCols: string[] = [];
  for (let li = 0; li < Math.min(20, lines.length); li++) {
    const cols = parseCSVLine(lines[li]);
    const lower = cols.map((c) => c.toLowerCase().trim());
    if (
      lower.includes("opportunity owner: manager") &&
      lower.some((c) => c.includes("opportunity id")) &&
      lower.includes("stage")
    ) {
      headerIdx = li;
      headerCols = cols;
      break;
    }
  }
  if (headerIdx === -1) {
    const first5 = lines.slice(0, 5).map((l) => l.substring(0, 120));
    console.error(
      `[${opts.sheetLabel}] Header row not found. First 5 rows: ${JSON.stringify(first5)}`,
    );
    addParseError({
      sheet: opts.sheetLabel,
      sheetUrl: sheetUrl(opts.sheetId, opts.gid),
      message:
        'Header row not found — expected "Opportunity Owner: Manager", "Opportunity ID", "Stage"',
      expectedHeaders: [
        "Opportunity Owner: Manager",
        "Opportunity ID",
        "Stage",
        "MRR",
        "Type",
        "Product",
        "Product Family",
        "Change in MRR",
        "Quote Type",
        "Split Total Price",
      ],
      actualHeaders: first5.map((l) => l.substring(0, 60)),
      timestamp: Date.now(),
    });
    return null;
  }

  const cmap = findHeaderColumns(headerCols);
  const cols = {
    manager: colIdx(cmap, ["Opportunity Owner: Manager"]),
    oppName: colIdx(cmap, ["Opportunity Name"]),
    rep: colIdx(cmap, ["Opportunity Owner"]),
    user: colIdx(cmap, ["User"]),
    productName: colIdx(cmap, ["Product Name"]),
    product: colIdx(cmap, ["Product"]),
    productFamily: colIdx(cmap, ["Product Family"]),
    type: colIdx(cmap, ["Type"]),
    mrr: colIdx(cmap, ["MRR"]),
    amount: colIdx(cmap, ["Amount"]),
    totalPrice: colIdx(cmap, ["Total Price"]),
    splitTotalPrice: colIdx(cmap, ["Split Total Price"]),
    changeInMrr: colIdx(cmap, ["Change in MRR"]),
    quoteType: colIdx(cmap, ["Quote Type"]),
    oppId: colIdx(cmap, ["Opportunity ID (18-digit)", "Opportunity ID"]),
    accountName: colIdx(cmap, ["Account Name"]),
    stage: colIdx(cmap, ["Stage"]),
    closeDate: colIdx(cmap, ["Close Date"]),
    salesRole: colIdx(cmap, ["Sales Role"]),
    daysSinceActivity: colIdx(cmap, ["Days Since Last Activity"]),
    createdDate: colIdx(cmap, ["Created Date"]),
    demoPerformedDate: colIdx(cmap, ["Demo Performed Date"]),
    accountId: colIdx(cmap, ["Account ID (18-digit)", "Account ID"]),
    flexFlipAgentStatus: colIdx(cmap, ["Flex Flip Agent Status"]),
    termLength: colIdx(cmap, ["Term Length"]),
  };

  const get = (arr: string[], idx: number) =>
    idx >= 0 && idx < arr.length ? arr[idx] || "" : "";

  // Realign rawCells to the reference (main) header order only when a second
  // sheet's columns are in a different order. Identical order (the expected
  // case) keeps the raw cell array untouched.
  let rawRemap: number[] | null = null;
  if (opts.refHeaders) {
    const norm = (s: string) => s.toLowerCase().trim();
    const sameOrder =
      opts.refHeaders.length === headerCols.length &&
      opts.refHeaders.every((h, i) => norm(h) === norm(headerCols[i] || ""));
    if (!sameOrder) {
      rawRemap = opts.refHeaders.map((h) =>
        headerCols.findIndex((hc) => norm(hc) === norm(h)),
      );
    }
  }

  const rows: ParsedRow[] = [];
  let userMatchedCount = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = parseCSVLine(line);
    if (c.length < 5) continue;
    const owner = get(c, cols.rep);
    // Task #386: prefer the `User` column for rep identity; fall back to the
    // `Opportunity Owner` when User is blank (or the column is absent entirely).
    const userVal = get(c, cols.user).trim();
    const rep = userVal || owner;
    // On Demand reps ("Account Sales" / "Compliance Sales" / "Zillow Sales")
    // are Pipeline-only owners with NO Manager value in the feeder sheet. Left
    // alone, the blank-manager guard below silently drops their rows, excluding
    // On-Demand-owned opps (e.g. FUB Cancel subscriptions) from every
    // pipeline-derived feeder AND from paired comp rules that look for them
    // (an EXISTS partner that never reaches the engine can never match).
    // Hard-code their manager to the On Demand channel so the row survives
    // ingestion; slm/flm/group still resolve via the injected On Demand
    // hierarchy entries, and any downstream `|| r.manager` fallback yields it.
    let manager = get(c, cols.manager);
    if (!manager && ON_DEMAND_REPS.includes(rep)) manager = ON_DEMAND_CHANNEL;
    if (!manager || !rep) continue;
    if (userVal) userMatchedCount++;

    const rawProduct = get(c, cols.product);
    const productFamily = get(c, cols.productFamily);
    const type = get(c, cols.type);

    const oppId = canonicalizeOppId(get(c, cols.oppId));
    const fub = lookupFubFirstPurchase(fubIndex, oppId);

    const rawCells = rawRemap
      ? rawRemap.map((idx) => (idx >= 0 ? c[idx] || "" : ""))
      : c;

    // Task #575: build the FULL row first, then attribute the product from it,
    // so every condition field a Product Logic rule can reference (quoteType,
    // termLength, closeDate, MRR columns, ...) is present during attribution —
    // exactly the same inputs standardizeMrr later evaluates. Attributing from
    // a partial row made quoteType-conditioned rules unmatchable and dumped
    // FUB/zPro amend & cancel opps into the "Unified Opp" catch-all bucket.
    const row: ParsedRow = {
      manager,
      accountId: get(c, cols.accountId),
      contactName: get(c, cols.accountName),
      oppId,
      salesRole: get(c, cols.salesRole),
      closeDate: get(c, cols.closeDate),
      amount: parseFloat(get(c, cols.amount)) || 0,
      forecastedRevenue: 0,
      daysSinceActivity: parseInt(get(c, cols.daysSinceActivity)) || 0,
      type,
      oppName: get(c, cols.oppName),
      createdDate: get(c, cols.createdDate),
      expectedRevenue: 0,
      mrr: parseFloat(get(c, cols.mrr)) || 0,
      totalMrr: parseFloat(get(c, cols.mrr)) || 0,
      product: "",
      rep,
      selectProduct: "",
      stage: get(c, cols.stage),
      demoPerformedDate: get(c, cols.demoPerformedDate),
      splitTotalPrice: parseFloat(get(c, cols.splitTotalPrice)) || 0,
      totalPrice: parseFloat(get(c, cols.totalPrice)) || 0,
      productFamily,
      rawProduct,
      changeInMrr: parseFloat(get(c, cols.changeInMrr)) || 0,
      quoteType: get(c, cols.quoteType),
      // Task #434: raw people columns, independent of the blended `rep` above.
      user: userVal,
      oppOwner: owner,
      flexFlipAgentStatus: get(c, cols.flexFlipAgentStatus),
      termLength: get(c, cols.termLength),
      fubFirstPurchaseDate: fub?.fubFirstPurchaseDate || "",
      fubFirstPurchaseOppId: fub?.fubFirstPurchaseOppId || "",
      rawCells,
    };
    row.product = attributeProduct(row);
    rows.push(row);
  }

  return { rows, headerCols, headerIdx, userMatchedCount };
}

async function _fetchRowsImpl(): Promise<ParsedRow[]> {
  // Fetch the main opps sheet, the On-Demand opps sheet (Task #392), and the FUB
  // enrichment in parallel. The On-Demand fetch is wrapped so a failure there is
  // non-fatal — the main opps data must still load.
  const [text, ondemandResult, fubFirstPurchaseRows] = await Promise.all([
    fetchSheetCSV(PIPELINE_SHEET_ID, PIPELINE_SHEET_GID),
    fetchSheetCSV(ONDEMAND_OPPS_SHEET_ID, ONDEMAND_OPPS_SHEET_GID).then(
      (t) => ({ ok: true as const, text: t }),
      (e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }),
    ),
    fetchFubFirstPurchase(),
  ]);
  // Task #347: enrichment lookup keyed by 18-char opp id. Almost every entry is
  // a FUB opp; non-FUB opps have no match and stay blank. Shared across both
  // opps sheets.
  const fubIndex = buildFubFirstPurchaseIndex(fubFirstPurchaseRows);

  // Main opps sheet — a missing header here is fatal (current behavior).
  const main = parseOppsSheet(text, fubIndex, {
    sheetLabel: "Pipeline V2",
    sheetId: PIPELINE_SHEET_ID,
    gid: PIPELINE_SHEET_GID,
  });
  if (!main) throw new Error("Header row not found in Pipeline V2 sheet");
  pipelineRawHeaders = main.headerCols.slice();

  // On-Demand opps sheet — unioned in. Non-fatal: if it fails to fetch or its
  // header can't be found, record a parse error and serve only the main rows.
  let ondemandRows: ParsedRow[] = [];
  let ondemandUserMatched = 0;
  if (!ondemandResult.ok) {
    console.error(
      `[On Demand Opps] Failed to fetch sheet, skipping: ${ondemandResult.error}`,
    );
    addParseError({
      sheet: "On Demand Opps",
      sheetUrl: sheetUrl(ONDEMAND_OPPS_SHEET_ID, ONDEMAND_OPPS_SHEET_GID),
      message: `Failed to fetch sheet: ${ondemandResult.error}`,
      expectedHeaders: [],
      actualHeaders: [],
      timestamp: Date.now(),
    });
  } else {
    const od = parseOppsSheet(ondemandResult.text, fubIndex, {
      sheetLabel: "On Demand Opps",
      sheetId: ONDEMAND_OPPS_SHEET_ID,
      gid: ONDEMAND_OPPS_SHEET_GID,
      refHeaders: main.headerCols,
    });
    if (od) {
      ondemandRows = od.rows;
      ondemandUserMatched = od.userMatchedCount;
    }
  }

  // Task #558: an upstream export bug duplicates rows in the v2 opps feeder
  // (same Opportunity Product ID, byte-identical in every column). Drop rows
  // whose ENTIRE raw cell array matches an already-seen row — this only ever
  // collapses exact duplicates, so legitimate split-owner rows (which differ
  // in owner/user/split columns) are untouched. Applies to the main feeder
  // ONLY; the On-Demand feeder is never deduplicated.
  const norm = (s: string) => s.toLowerCase().trim();
  const oppProductIdCol = main.headerCols.findIndex((h) =>
    norm(h).includes("opportunity product id"),
  );
  const seenRaw = new Set<string>();
  const droppedOppProductIds: string[] = [];
  let droppedDupes = 0;
  const mainRows = main.rows.filter((r) => {
    const raw = r.rawCells;
    if (!raw) return true;
    const key = JSON.stringify(raw);
    if (seenRaw.has(key)) {
      droppedDupes++;
      const opid =
        oppProductIdCol >= 0 ? raw[oppProductIdCol] || r.oppId : r.oppId;
      if (opid) droppedOppProductIds.push(opid);
      return false;
    }
    seenRaw.add(key);
    return true;
  });
  if (droppedDupes > 0) {
    console.warn(
      `[Pipeline V2] Dropped ${droppedDupes} exact-duplicate feeder row(s) (upstream data issue). Opportunity Product IDs: ${droppedOppProductIds.slice(0, 50).join(", ")}${droppedOppProductIds.length > 50 ? ", …" : ""}`,
    );
  }

  // Union the two disjoint imports. Beyond the exact-duplicate drop above, no
  // dedupe: split-owner opps legitimately have multiple rows per opp id, so a
  // plain concat is correct.
  const rows = mainRows.concat(ondemandRows);

  const withDemo = rows.filter((r) => r.demoPerformedDate).length;
  console.log(
    `[Pipeline V2] Parsed ${mainRows.length} main + ${ondemandRows.length} On-Demand = ${rows.length} opps rows, ${withDemo} with demoPerformedDate, ${main.userMatchedCount} (main) + ${ondemandUserMatched} (On-Demand) attributed by User column`,
  );
  // NOTE: cachedRows / cacheTime are written by the fetchRows() wrapper
  // after merging in Re/Max CPDs — don't set them here.
  return rows;
}

async function fetchWeightedPipeRows(): Promise<ParsedRow[]> {
  const now = Date.now();
  if (!snapshotCtxActive() && cachedWeightedPipeRows && now - weightedPipeCacheTime < CACHE_TTL_MS)
    return cachedWeightedPipeRows;
  if (!snapshotCtxActive() && pendingWeightedPipeRows) return pendingWeightedPipeRows;
  const run = _fetchWeightedPipeRowsImpl().finally(() => {
    pendingWeightedPipeRows = null;
  });
  pendingWeightedPipeRows = run;
  return run;
}

async function _fetchWeightedPipeRowsImpl(): Promise<ParsedRow[]> {
  try {
    var text = await fetchSheetCSV(
      WEIGHTED_PIPE_SHEET_ID,
      WEIGHTED_PIPE_SHEET_GID,
    );
  } catch (e) {
    console.error(
      "[WeightedPipe] Failed to fetch sheet, returning empty:",
      (e as Error).message,
    );
    return [];
  }
  const lines = text.split("\n");

  const headerIdx = lines.findIndex((l) =>
    l.includes("Opportunity Owner: Manager: Full Name"),
  );
  if (headerIdx === -1) {
    const first5 = lines.slice(0, 5).map((l) => l.substring(0, 120));
    console.warn(
      "[WeightedPipe] Header row not found in weighted pipeline sheet, returning empty",
    );
    addParseError({
      sheet: "Weighted Pipeline",
      sheetUrl: sheetUrl(WEIGHTED_PIPE_SHEET_ID, WEIGHTED_PIPE_SHEET_GID),
      message:
        'Header row not found — expected "Opportunity Owner: Manager: Full Name"',
      expectedHeaders: ["Opportunity Owner: Manager: Full Name"],
      actualHeaders: first5.map((l) => l.substring(0, 60)),
      timestamp: Date.now(),
    });
    return [];
  }

  const headerCols = parseCSVLine(lines[headerIdx]);
  const demoDateColIdx = headerCols.findIndex((h) =>
    h.toLowerCase().includes("demo performed date"),
  );

  const rows: ParsedRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVLine(line);
    if (cols.length < 21) continue;
    // Same On Demand rescue as the main Pipeline parser: On-Demand reps
    // (cols[19]) carry a blank Manager (cols[0]) and would otherwise be
    // dropped by the guard below. Hard-code their manager to the On Demand
    // channel so they survive ingestion.
    let mgr = cols[0];
    if (!mgr && ON_DEMAND_REPS.includes(cols[19])) mgr = ON_DEMAND_CHANNEL;
    if (!mgr || !cols[19] || !cols[20]) continue;

    rows.push({
      manager: mgr,
      accountId: cols[1],
      contactName: cols[2],
      oppId: cols[3],
      salesRole: cols[4],
      closeDate: cols[5],
      amount: parseFloat(cols[6]) || 0,
      forecastedRevenue: parseFloat(cols[7]) || 0,
      daysSinceActivity: parseInt(cols[8]) || 0,
      type: cols[9],
      oppName: cols[10],
      createdDate: cols[11],
      expectedRevenue: parseFloat(cols[12]) || 0,
      mrr: parseFloat(cols[13]) || 0,
      totalMrr: parseFloat(cols[14]) || 0,
      product: cols[18] === "Zillow Pro" ? cols[18] : cols[15],
      rep: cols[19],
      selectProduct: cols[18],
      stage: cols[20],
      demoPerformedDate: demoDateColIdx >= 0 ? cols[demoDateColIdx] || "" : "",
      splitTotalPrice: 0,
      totalPrice: 0,
      productFamily: "",
      rawProduct: cols[15] || "",
      changeInMrr: 0,
      quoteType: "",
      // Task #434: this weighted-pipe sheet has no separate User column; the
      // owner column (cols[19]) doubles as the rep. These rows never reach the
      // comp engine, so both raw people fields fall back to the owner value.
      user: "",
      oppOwner: cols[19],
    });
  }

  if (!isReplayActive()) {
    cachedWeightedPipeRows = rows;
    weightedPipeCacheTime = Date.now();
  }
  return rows;
}

export async function getOppRepById(oppId: string): Promise<string | null> {
  if (!oppId) return null;
  // Synthetic ID for Manager Estimate per-(rep, month, product) overrides
  // — `mgr_est:{rep}|{yyyymm}|{product}`. Parse the rep directly so the
  // permission check on PUT /sales/opp-probabilities/:id can resolve
  // ownership without a sheet round-trip.
  if (oppId.startsWith("mgr_est:")) {
    const rest = oppId.slice("mgr_est:".length);
    const pipeIdx = rest.indexOf("|");
    if (pipeIdx > 0) return rest.slice(0, pipeIdx) || null;
    return null;
  }
  // Synthetic ID for Sched Mod rows lacking a real opportunity_id
  // (`mod:{contactId}|{cancellationDate}|{amount}|{product}`). Resolve
  // through the cached sched-mods feed.
  if (oppId.startsWith("mod:")) {
    try {
      const { fetchSchedMods } = await import("./databricks-sched-mods");
      const mods = await fetchSchedMods();
      for (const m of mods) {
        if (!m.opportunityId) {
          const id = `mod:${m.contactId}|${m.cancellationDate}|${m.amount}|${m.product}`;
          if (id === oppId) return m.repName || null;
        }
      }
    } catch {
      return null;
    }
    return null;
  }
  const rows = await fetchRows();
  for (const r of rows) {
    if (r.oppId === oppId) return r.rep || null;
  }
  // Real Salesforce opportunity_id may also belong to a sched-mod row
  // (cross-surface identity per #153). Fall back to the sched-mods feed.
  try {
    const { fetchSchedMods } = await import("./databricks-sched-mods");
    const mods = await fetchSchedMods();
    for (const m of mods) {
      if (m.opportunityId && canonicalizeOppId(m.opportunityId) === oppId)
        return m.repName || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function getLiveSalesConfig(month?: string) {
  // When a month (YYYY-MM) is supplied, derive the selector lists from the
  // month-aware effective hierarchy so per-month roster overrides (e.g. a
  // person reactivated for a single month) flow into the dropdowns and agree
  // with the data/quota paths. When omitted, fall back to the base hierarchy
  // (today's default behavior).
  const useMonth = typeof month === "string" && /^\d{4}-\d{2}$/.test(month);
  const [rows, hierarchy] = await Promise.all([
    fetchRows(),
    useMonth ? fetchEffectiveHierarchy(month!) : fetchHierarchy(),
  ]);

  const products = new Set<string>();
  const types = new Set<string>();
  const salesRoles = new Set<string>();
  const quoteTypes = new Set<string>();
  // Task #361: distinct raw-field values for the admin-only Conditions filter.
  const rawProducts = new Set<string>();
  const productFamilies = new Set<string>();
  const termLengths = new Set<string>();
  const funnelStages = new Set<string>();
  for (const r of rows) {
    if (r.product) products.add(r.product);
    if (r.selectProduct) products.add(r.selectProduct);
    if (r.type) types.add(r.type);
    if (r.salesRole) salesRoles.add(r.salesRole);
    if (r.quoteType) quoteTypes.add(r.quoteType);
    if (r.rawProduct) rawProducts.add(r.rawProduct);
    if (r.productFamily) productFamilies.add(r.productFamily);
    if (r.termLength) termLengths.add(r.termLength);
    const fs = effectiveFunnelStage(r);
    if (fs) funnelStages.add(fs);
  }

  // Hide inactive people from the selector lists (Task: Active column). When a
  // month is supplied, `hierarchy` is the month-aware effective hierarchy:
  // inactive people are already dropped from its tree maps and per-month roster
  // overrides (reactivations / deactivations) are baked in, so this flag check
  // surfaces month-reactivated people and hides month-deactivated ones. When no
  // month is supplied, it is the base hierarchy filtered by the sheet-level
  // Active flag. There is intentionally no global show-inactive toggle.
  const isActive = (name: string) => hierarchy.personToActive[name] !== false;

  const org: Record<string, Record<string, string[]>> = {};

  // Inactive FLMs/SLMs are kept as container-only nodes while at least one
  // active rep remains beneath them (they disappear once their whole subtree
  // is inactive). Container FLMs never count as their own rep, so their
  // personal rows are excluded from the dropdown and all totals.
  for (const slm of hierarchy.slms) {
    const flmGroup: Record<string, string[]> = {};
    const flms = hierarchy.slmToFlms[slm] || [];

    for (const flm of flms) {
      const repsInHierarchy = (hierarchy.flmToReps[flm] || []).filter(isActive);
      const allRepsForFlm = [...repsInHierarchy];
      const flmHasOwnData = rows.some((r) => r.rep === flm);
      if (isActive(flm) && flmHasOwnData && !allRepsForFlm.includes(flm)) {
        allRepsForFlm.push(flm);
      }
      if (allRepsForFlm.length === 0) continue;
      flmGroup[flm] = allRepsForFlm.sort();
    }

    if (Object.keys(flmGroup).length === 0) continue;
    org[slm] = flmGroup;
  }

  const regions = new Set<string>();
  for (const [rep, region] of Object.entries(hierarchy.repToRegion)) {
    if (region && isActive(rep)) regions.add(region);
  }
  const groups = new Set<string>();
  for (const [rep, group] of Object.entries(hierarchy.repToGroup)) {
    if (group && isActive(rep)) groups.add(group);
  }
  const segments = new Set<string>();
  for (const [rep, seg] of Object.entries(hierarchy.repToSegment)) {
    if (seg && isActive(rep)) segments.add(seg);
  }

  // Data-driven Acquisitions SLM set: an SLM belongs to the Acquisitions
  // channel when anyone in their subtree (self, FLMs, or reps) maps to the
  // Acquisitions group. Drives the frontend channel presets without any
  // hardcoded names (which broke in the anonymized public demo and leaked
  // real names into the public repo).
  const acqSlms: string[] = [];
  for (const slm of Object.keys(org)) {
    const members = [slm, ...Object.keys(org[slm]), ...Object.values(org[slm]).flat()];
    if (members.some((p) => isAcqChannelGroup(hierarchy.repToGroup[p] ?? ""))) {
      acqSlms.push(slm);
    }
  }

  return {
    org,
    acqSlms: acqSlms.sort(),
    // Demo-only product display labels: the public demo renames products at
    // the display boundary. Absent outside DEMO_MODE so the internal
    // dashboard is untouched.
    ...(isDemoMode() ? { demoProductLabels: DEMO_PRODUCT_LABELS } : {}),
    segments: [...segments].sort(),
    regions: [...regions].sort(),
    groups: [...groups].sort(),
    products: [...products].filter(Boolean).sort(),
    types: [...types].filter(Boolean).sort(),
    salesRoles: [...salesRoles].filter(Boolean).sort(),
    quoteTypes: [...quoteTypes].filter(Boolean).sort(),
    // Task #361: distinct value lists for the admin-only raw-field Conditions
    // filter (the ones not already surfaced above).
    rawProducts: [...rawProducts].filter(Boolean).sort(),
    productFamilies: [...productFamilies].filter(Boolean).sort(),
    termLengths: [...termLengths].filter(Boolean).sort(),
    funnelStages: [...funnelStages].filter(Boolean).sort(),
    // Task #276: canonical MRR-source-field options for the per-rule picker on
    // the Compensation Rules tab (data-driven so the UI stays in sync).
    mrrFields: MRR_FIELD_OPTIONS,
    // Task #314: the MRR-field options grouped by upstream source plus the set
    // of CPD-sourced product/type values, so the rules UI can offer the right
    // option subset and keep each rule single-source.
    mrrFieldSources: {
      feeder: FEEDER_MRR_FIELD_OPTIONS.map((o) => o.value),
      cpd: CPD_MRR_FIELD_OPTIONS.map((o) => o.value),
    },
    cpdSourcedValues: CPD_SOURCED_VALUES,
  };
}

const PIPELINE_STAGES = [
  "Discovery",
  "Demo Scheduled",
  "Proposal/Negotiation",
  "Paperwork Sent",
  "Awaiting Payment",
  "Closed Won",
  "Closed Lost",
];

const unmappedStages = new Set<string>();

function mapStageToFunnel(stage: string): string {
  if (PIPELINE_STAGES.includes(stage)) return stage;
  if (["New", "Discover", "Engage", "Influence", "Zips Added"].includes(stage))
    return "Discovery";
  if (["Demo Performed", "Presentation"].includes(stage))
    return "Demo Scheduled";
  if (["Advance", "Committed to Purchase"].includes(stage))
    return "Proposal/Negotiation";
  if (["Contract Sent"].includes(stage)) return "Paperwork Sent";
  if (stage === "Closed: Won") return "Closed Won";
  if (stage === "Closed Lost" || stage === "Closed Waitlist")
    return "Closed Lost";
  if (!unmappedStages.has(stage)) {
    unmappedStages.add(stage);
    console.warn(
      `[StageMapping] Unmapped stage "${stage}" → defaulting to "Discovery"`,
    );
  }
  return "Discovery";
}

// Overage opportunities are created at the start of each month in the Discovery
// stage and only flipped to Closed Won on the last day, even though their MRR
// accrues throughout the month as credits are purchased. Identify them by the
// same signal the rest of the pipeline uses (opp Type / attributed Product
// "Overage"). Both fields survive onto ParsedRow: `type` stays the raw feed
// value and `product` is the attributed product.
function isOverageRow(r: ParsedRow): boolean {
  // "Treated as Closed Won" is now driven by the Product Logic engine (Task
  // #350): a row qualifies when its attributed product is produced by a rule
  // flagged treatAsClosedWon (seed: Overage). Because type "Overage" always
  // attributes to product "Overage", checking the product reproduces the old
  // (type === "Overage" || product === "Overage") signal.
  return isTreatedAsClosedWon((r.product || "").trim());
}

// Standardized funnel stage with one override: a Discovery-stage Overage opp is
// treated as Closed Won so its accrued MRR is counted (in headline Added/Churn,
// the funnel, product breakdowns, weighting, and drilldowns) throughout the
// month instead of appearing all at once on the end-of-month status flip. All
// other rows pass through unchanged. Centralized here so the aggregation and the
// drilldowns always agree on which bucket a row lands in.
export function effectiveFunnelStage(r: ParsedRow): string {
  const stage = mapStageToFunnel(r.stage);
  if (stage === "Discovery" && isOverageRow(r)) return "Closed Won";
  return stage;
}

// True when a row is an Overage opp still sitting in its raw Discovery stage —
// i.e. one that effectiveFunnelStage() reclassifies to Closed Won. Drives both
// the effective-close-date override below and the drilldown "i" tooltip flag.
export function isOverageReclassified(r: ParsedRow): boolean {
  return isOverageRow(r) && mapStageToFunnel(r.stage) === "Discovery";
}

// Effective close date used for ALL date-window filtering and monthly/day
// bucketing. A reclassified Overage opp carries an end-of-month close date even
// though its MRR accrues from the very start of the month, so pin its effective
// close date to the first day of that same calendar month. This keeps it in the
// same month bucket while letting any month-to-date window include it
// immediately instead of only on the final day. All other rows use their real
// close date. Returns null when the close date is missing/invalid.
export function effectiveCloseDate(r: ParsedRow): Date | null {
  if (!r.closeDate) return null;
  const cd = new Date(r.closeDate);
  if (isNaN(cd.getTime())) return null;
  if (isOverageReclassified(r)) {
    return new Date(cd.getFullYear(), cd.getMonth(), 1);
  }
  return cd;
}

// Task #472: the close date *displayed* in opportunity drilldowns. For
// reclassified Overage opps (raw close date is end-of-month, but the opp is
// counted from the 1st via effectiveCloseDate), surface the 1st-of-month date
// so the shown value — and the sort / min-max aggregation / export that read
// it — stay consistent with how the opp is actually bucketed. Every other opp
// keeps its raw Salesforce close date untouched. Formatted as M/D/YYYY to match
// the US sheet format already emitted for non-Overage rows.
export function displayCloseDate(r: ParsedRow): string {
  if (isOverageReclassified(r)) {
    const eff = effectiveCloseDate(r);
    if (eff) return `${eff.getMonth() + 1}/${eff.getDate()}/${eff.getFullYear()}`;
  }
  return r.closeDate;
}

// ============================================================================
// Task #361: Admin-only raw-field "Conditions" filter.
//
// Admins can slice the entire Pipeline view by raw opportunity fields. Each
// condition is `{ field, value }` combined with AND; the operator is always
// "is" (case/whitespace-normalized equality). The matching runs on the raw
// parsed rows BEFORE aggregation so every derived number reflects it, via a
// single shared predicate reused by all Pipeline-feeding endpoints.
//
// Field → raw-row mapping (documented per task spec):
//   type         → r.type
//   rawProduct   → r.rawProduct
//   productFamily→ r.productFamily
//   product      → r.product OR r.selectProduct (matches either)
//   quoteType    → r.quoteType
//   termLength   → r.termLength
//   channel      → hierarchy.repToGroup[r.rep]   (rep-derived; post-join)
//   segment      → hierarchy.repToSegment[r.rep] (rep-derived; post-join)
//   salesRole    → r.salesRole
//   oppName      → r.oppName
//   funnelStage  → effectiveFunnelStage(r)  (the canonical mapped bucket the
//                  UI labels "Funnel Stage", e.g. "Closed Won", not the raw
//                  Salesforce stage string)
// ============================================================================
export interface RawCondition {
  field: string;
  value: string;
}

export const RAW_CONDITION_FIELDS = [
  "type",
  "rawProduct",
  "productFamily",
  "product",
  "quoteType",
  "termLength",
  "channel",
  "segment",
  "salesRole",
  "oppName",
  "funnelStage",
] as const;

const RAW_CONDITION_FIELD_SET = new Set<string>(RAW_CONDITION_FIELDS);

const normalizeConditionValue = (s: unknown): string =>
  String(s ?? "").trim().toLowerCase();

// Validate/normalize an untrusted conditions payload into known fields with
// non-empty values. Unknown fields and blank values are dropped.
export function sanitizeRawConditions(input: unknown): RawCondition[] {
  if (!Array.isArray(input)) return [];
  const out: RawCondition[] = [];
  for (const c of input) {
    if (!c || typeof c !== "object") continue;
    const field = typeof (c as any).field === "string" ? (c as any).field : "";
    const value = typeof (c as any).value === "string" ? (c as any).value : "";
    if (!RAW_CONDITION_FIELD_SET.has(field)) continue;
    if (value.trim() === "") continue;
    out.push({ field, value });
  }
  return out;
}

function rawRowFieldValues(
  r: ParsedRow,
  field: string,
  hierarchy?: OrgHierarchy,
): string[] {
  switch (field) {
    case "type":
      return [r.type];
    case "rawProduct":
      return [r.rawProduct];
    case "productFamily":
      return [r.productFamily];
    case "product":
      return [r.product, r.selectProduct];
    case "quoteType":
      return [r.quoteType];
    case "termLength":
      return [r.termLength ?? ""];
    case "channel":
      return [hierarchy?.repToGroup?.[r.rep] ?? ""];
    case "segment":
      return [hierarchy?.repToSegment?.[r.rep] ?? ""];
    case "salesRole":
      return [r.salesRole];
    case "oppName":
      return [r.oppName];
    case "funnelStage":
      return [effectiveFunnelStage(r)];
    default:
      return [];
  }
}

// Shared predicate: a row matches when EVERY condition matches (AND), where a
// single condition matches if any of the row's value(s) for that field equals
// the target (case/whitespace-normalized). Unknown fields are ignored.
// Task #529: exported as a standalone per-row predicate so the Anaplan view can
// gate at the CPD level (any matching row keeps the whole CPD) with the exact
// same field semantics as the Pipeline row filter below.
export function rowMatchesRawConditions(
  r: ParsedRow,
  conditions: RawCondition[],
  hierarchy?: OrgHierarchy,
): boolean {
  return conditions.every((c) => {
    const vals = rawRowFieldValues(r, c.field, hierarchy);
    if (vals.length === 0) return true; // unknown field → no-op
    const target = normalizeConditionValue(c.value);
    return vals.some((v) => normalizeConditionValue(v) === target);
  });
}

export function filterRowsByRawConditions(
  rows: ParsedRow[],
  conditions?: RawCondition[],
  hierarchy?: OrgHierarchy,
): ParsedRow[] {
  if (!conditions || conditions.length === 0) return rows;
  return rows.filter((r) => rowMatchesRawConditions(r, conditions, hierarchy));
}

// Scheduled Mods carry only a subset of the raw opportunity dimensions, so a
// dedicated predicate maps the fields a mod can express (type/product/channel/
// segment). Conditions on fields a mod doesn't carry are ignored for mods (so
// the churn forecast still narrows on the dimensions it shares with opps rather
// than emptying out entirely).
function modFieldValues(
  m: RawScheduledMod,
  field: string,
  hierarchy?: OrgHierarchy,
): string[] | null {
  switch (field) {
    case "type":
      return [m.opportunityType];
    case "product":
      return [m.product];
    case "channel":
      return [hierarchy?.repToGroup?.[m.repName] ?? ""];
    case "segment":
      return [hierarchy?.repToSegment?.[m.repName] ?? m.segment ?? ""];
    default:
      return null; // not applicable to mods
  }
}

function filterSchedModsByRawConditions<T extends RawScheduledMod>(
  mods: T[],
  conditions?: RawCondition[],
  hierarchy?: OrgHierarchy,
): T[] {
  if (!conditions || conditions.length === 0) return mods;
  return mods.filter((m) =>
    conditions.every((c) => {
      const vals = modFieldValues(m, c.field, hierarchy);
      if (vals === null) return true; // field not applicable to mods → no-op
      const target = normalizeConditionValue(c.value);
      return vals.some((v) => normalizeConditionValue(v) === target);
    }),
  );
}

export function getUnmappedStages(): string[] {
  return [...unmappedStages].sort();
}

const unmappedMrrTypes = new Set<string>();
export function getUnmappedMrrTypes(): string[] {
  return [...unmappedMrrTypes].sort();
}

// Standardized MRR for a row. Delegates to the Product Logic engine (Task
// #350): the matched rule's MRR field selects which numeric column is read. The
// seed reproduces the legacy type-switch exactly; the "unknown type" warning is
// preserved by firing whenever the row falls through to the catch-all rule.
export function standardizeMrr(r: ParsedRow): number {
  const { value, match } = resolveStandardizedMrrDetailed(r);
  if (match.isCatchAll) {
    const key = (r.type || "").trim() || "(blank)";
    if (!unmappedMrrTypes.has(key)) {
      unmappedMrrTypes.add(key);
      console.warn(
        `[standardizeMrr] Unknown Type "${key}" — falling back to Change in MRR`,
      );
    }
  }
  return value;
}

// Task #276: the feeder-sheet column standardizeMrr() reads for a given Type,
// expressed as an MrrField. Resolved via the Product Logic engine (Task #350)
// keyed on Type alone, so the drilldown can show the *default* MRR source when
// no rule override applied.
export function defaultMrrFieldForType(type: string): MrrField {
  return resolveMrrField({ type });
}

// Task #440: the MRR-source field that standardizeMrr() actually reads for a
// FULL row (full product-logic match), not the Type alone. The drilldown's
// displayed "MRR field" falls back to this when no comp-rule override applied,
// so the displayed field can never disagree with the value: standardizeMrr ->
// resolveStandardizedMrrDetailed evaluates the same full-row match. Resolving
// from r.type alone (the old fallback) could pick a different rule than the one
// that fed the value when a rule keys on more than Type.
export function appliedBaseMrrFieldForRow(r: ParsedRow): MrrField {
  return resolveMrrField(r);
}

// Task #276: CPD-sourced rows (ZMX / Showcase Incremental - Re/Max) get their
// MRR from Databricks, not the feeder sheet, so per-rule MRR-field overrides
// don't apply. Matches either the Type or the attributed Product.
function isCpdSourcedRow(r: ParsedRow): boolean {
  const t = (r.type || "").trim();
  const p = (r.product || "").trim();
  return (
    t === "ZMX" ||
    t === "Showcase Incremental - Re/Max" ||
    p === "ZMX" ||
    p === "Showcase Incremental - Re/Max"
  );
}

function isShowcaseProduct(product: string): boolean {
  return (
    product === "Showcase" ||
    product === "Showcase Incremental" ||
    product === "Showcase Incremental - Re/Max" ||
    product === "Overage"
  );
}

// Per-line-item shape attached to each merged opp by `dedupeOppsByOppId`.
// Each split row in the source data becomes one entry, in source order.
// The comp* fields are populated only in Compensable Revenue mode (null
// otherwise) and let the drilldown render per-line raw MRR, applied
// multipliers, and rule names.
export type OppLineItem = {
  product: string;
  mrr: number;
  amount: number;
  rawMrr: number | null;
  multipliers: number[] | null;
  ruleNames: string[] | null;
  // Task #317: description of the paired-opp adjustment applied to this line's
  // side (e.g. "Side B: × 0.1"), null when the line isn't part of a pair.
  pairAdjustmentLabel: string | null;
};

function dedupeOppsByOppId<
  T extends {
    oppId: string;
    rep: string;
    product: string;
    mrr: number;
    amount: number;
    rawMrr?: number | null;
    compMultipliers?: number[] | null;
    compRuleNames?: string[] | null;
    pairAdjustmentLabel?: string | null;
  },
>(opps: T[]): (T & { lineItems: OppLineItem[] })[] {
  type Merged = T & { lineItems: OppLineItem[] };
  const map = new Map<string, Merged>();
  const noIdRows: Merged[] = [];
  for (const o of opps) {
    const li: OppLineItem = {
      product: (o.product || "").trim(),
      mrr: o.mrr || 0,
      amount: o.amount || 0,
      rawMrr: o.rawMrr ?? null,
      multipliers: o.compMultipliers ?? null,
      ruleNames: o.compRuleNames ?? null,
      pairAdjustmentLabel: o.pairAdjustmentLabel ?? null,
    };
    if (!o.oppId) {
      noIdRows.push({ ...o, product: o.product || "", lineItems: [li] });
      continue;
    }
    // Task #390: key on oppId + rep (the User field), not oppId alone. A single
    // opportunity whose line items are split across owners/channels (e.g. an
    // On Demand rep + an Acquisition/GnR rep) must stay as one row PER OWNER —
    // each carrying that owner's own MRR — so it surfaces in each owner's
    // channel-scoped drilldown instead of collapsing into the first row's
    // channel. This is also the forward-compatible seam for a future
    // owner-reassignment rule. Counts stay distinct-per-opp within any single
    // channel scope because the channel filter shows only one owner's row.
    const key = `${o.oppId}||${o.rep || ""}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...o, product: o.product || "", lineItems: [li] });
    } else {
      const products = String(existing.product || "")
        .split(", ")
        .filter(Boolean);
      const newProduct = (o.product || "").trim();
      if (newProduct && !products.includes(newProduct))
        products.push(newProduct);
      existing.product = products.join(", ");
      existing.mrr = (existing.mrr || 0) + (o.mrr || 0);
      existing.amount = (existing.amount || 0) + (o.amount || 0);
      existing.lineItems.push(li);
    }
  }
  return [...Array.from(map.values()), ...noIdRows];
}

// Task #566: "Amend Subscription" quote-type churn is exempt from the ACQ
// same-month pairing gate — its churn always counts toward ACQ net, even
// unpaired. Case-insensitive, trimmed. Shared by the Pipeline gate
// (acqGateBypassed) and the Anaplan netContribution gate so they reconcile.
export function isAmendSubscriptionQuoteType(quoteType: string): boolean {
  return quoteType.trim().toLowerCase() === "amend subscription";
}

// Task #220 / Task #252: Follow Up Boss "Amend Subscription" Closed-Won
// opportunities carry paired +/- line items under a single oppId (cancel old
// plan, add new plan) that net to the true monthly MRR change for that opp.
// Collapse rows sharing rep+oppId+product+funnel-stage into one net row so any
// downstream per-opportunity sign gating (MRR Added / Churn / AcqNet) is
// computed on the netted value, matching the opp-level net rather than each
// raw line item's sign. This merge is net-preserving, so funnel / weighted /
// product MRR totals are identical for every product; only products with
// intra-opp mixed-sign line items (FUB) shift, leaving MBP / Showcase / SCi /
// SCi-R / Zillow Pro numerically unchanged. Shared by the aggregate-card
// pipeline (getLivePipelineData) and the opportunity-detail endpoint
// (getOpportunitiesByType) so the cards and drilldowns stay in lockstep.
export function mergePipelineRowsByOpp(input: ParsedRow[]): ParsedRow[] {
  const merged = new Map<string, ParsedRow>();
  const passthrough: ParsedRow[] = [];
  for (const r of input) {
    if (!r.oppId) {
      passthrough.push(r);
      continue;
    }
    const key = `${r.rep}||${r.oppId}||${r.product || ""}||${mapStageToFunnel(r.stage)}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...r });
      continue;
    }
    existing.changeInMrr = (existing.changeInMrr || 0) + (r.changeInMrr || 0);
    existing.splitTotalPrice =
      (existing.splitTotalPrice || 0) + (r.splitTotalPrice || 0);
    existing.totalPrice = (existing.totalPrice || 0) + (r.totalPrice || 0);
    existing.amount = (existing.amount || 0) + (r.amount || 0);
    existing.mrr = (existing.mrr || 0) + (r.mrr || 0);
    existing.totalMrr = (existing.totalMrr || 0) + (r.totalMrr || 0);
    existing.forecastedRevenue =
      (existing.forecastedRevenue || 0) + (r.forecastedRevenue || 0);
    existing.expectedRevenue =
      (existing.expectedRevenue || 0) + (r.expectedRevenue || 0);
  }
  return [...merged.values(), ...passthrough];
}

// Task #241: compensable-revenue info for opportunity drilldowns. When present
// (Compensable Revenue mode), mapRowToOpp swaps in the per-row compensation-
// adjusted MRR and attaches the FUB↔Zpro pairing role/key so the drilldown can
// visually link the pair (same treatment as cancel/rebook).
interface CompOppInfo {
  mrrByRow: Map<ParsedRow, number>;
  // Generic paired-opp pairing metadata. `oppNameByOppId` is the matched rule's
  // named opp this row belongs to; `keyByOppId` links the members of one matched
  // group; the remaining per-row maps carry the rule label / adjustment label /
  // churn-suppression / owner-reassignment so the drilldown can render + reverse.
  oppNameByOppId: Map<string, string>;
  keyByOppId: Map<string, string>;
  ruleLabelByOppId: Map<string, string>;
  // Per-row compensation detail for the drilldown's Multipliers / Rules cells.
  // `multipliersByRow` is empty for paired override rows (the pairing isn't a
  // plain multiplier — the adjustment label below describes it instead).
  multipliersByRow: Map<ParsedRow, number[]>;
  ruleNamesByRow: Map<ParsedRow, string[]>;
  pairAdjLabelByRow: Map<ParsedRow, string>;
  churnSuppressedByRow: Map<ParsedRow, boolean>;
  ownerReassignedByRow: Map<ParsedRow, string>;
  // Task #276: effective base MRR-source field per row (rule override ?? the
  // Type-driven default), so the drilldown can always show which column fed the
  // compensable MRR. `mrrFieldRuleLabelsByRow` lists every matching field-setting
  // rule (length > 1 ⇒ the opp matched conflicting field rules) and
  // `mrrFieldWinnerByRow` names the rule that actually won (only when an override
  // was applied).
  mrrFieldByRow: Map<ParsedRow, MrrField>;
  mrrFieldRuleLabelsByRow: Map<ParsedRow, string[]>;
  mrrFieldWinnerByRow: Map<ParsedRow, string>;
  // Rows flagged by an "Ignore ACQ Churn Logic" paired-rule adjustment to
  // bypass the global ACQ same-month churn gate.
  acqChurnIgnoredRows: Set<ParsedRow>;
}

function mapRowToOpp(
  r: ParsedRow,
  hierarchy: OrgHierarchy,
  overrides?: Record<string, number>,
  stageDefaults?: Record<string, number>,
  reviewedMap?: Record<string, boolean>,
  compInfo?: CompOppInfo | null,
) {
  const group = hierarchy.repToGroup[r.rep] || "";
  const funnelStage = effectiveFunnelStage(r);
  const probabilityOverride =
    overrides && r.oppId && overrides[r.oppId] !== undefined
      ? overrides[r.oppId]
      : null;
  const stageDefault = stageDefaults
    ? (stageDefaults[funnelStage] ?? null)
    : null;
  const isReviewed = !!(
    reviewedMap &&
    r.oppId &&
    reviewedMap[r.oppId] === true
  );
  const compMrr = compInfo
    ? (compInfo.mrrByRow.get(r) ?? standardizeMrr(r))
    : null;
  // Generic paired-opp pairing metadata for the drilldown.
  const pairOppName =
    compInfo && r.oppId ? (compInfo.oppNameByOppId.get(r.oppId) ?? null) : null;
  const pairKey =
    compInfo && r.oppId ? (compInfo.keyByOppId.get(r.oppId) ?? null) : null;
  const pairRuleLabel =
    compInfo && r.oppId ? (compInfo.ruleLabelByOppId.get(r.oppId) ?? null) : null;
  const pairAdjustmentLabel = compInfo
    ? (compInfo.pairAdjLabelByRow.get(r) ?? null)
    : null;
  const churnSuppressed = compInfo
    ? (compInfo.churnSuppressedByRow.get(r) ?? false)
    : null;
  const ownerReassignedTo = compInfo
    ? (compInfo.ownerReassignedByRow.get(r) ?? null)
    : null;
  // Per-row compensation detail for the drilldown columns (compensable mode
  // only; all null in Total mode so the payload shape matches Task #241).
  const rawMrr = compInfo ? standardizeMrr(r) : null;
  const compMultipliers = compInfo
    ? (compInfo.multipliersByRow.get(r) ?? [])
    : null;
  const compRuleNames = compInfo
    ? (compInfo.ruleNamesByRow.get(r) ?? [])
    : null;
  // Task #276: effective base MRR-source field + which rule(s) drove it.
  const appliedMrrField = compInfo
    ? (compInfo.mrrFieldByRow.get(r) ?? appliedBaseMrrFieldForRow(r))
    : null;
  const mrrFieldRuleLabels = compInfo
    ? (compInfo.mrrFieldRuleLabelsByRow.get(r) ?? [])
    : null;
  const mrrFieldWinner = compInfo
    ? (compInfo.mrrFieldWinnerByRow.get(r) ?? null)
    : null;
  return {
    // Task #350: a per-product display rename may override the opportunity name
    // shown in drilldowns. Display-only and keyed on the attributed product; the
    // default (empty) rename map leaves r.oppName untouched.
    oppName: oppNameOverrideFor(r.product) ?? r.oppName,
    accountName: r.contactName,
    accountId: r.accountId,
    oppId: r.oppId,
    // Pass through the CPD-source SF link IDs (currently only Re/Max
    // CPDs). The drilldown uses these to build Contact / Compensation__c
    // hyperlinks for SCI-R / ZMX rows instead of the default Account / Opp
    // link template, which would 404 on these Contact / CPD object ids.
    sfContactId: r.sfContactId,
    sfCpdId: r.sfCpdId,
    manager: r.manager,
    rep: r.rep,
    salesRole: r.salesRole,
    // Task #472: reclassified Overage opps display their 1st-of-month effective
    // close date (see displayCloseDate); all other opps show the raw close date.
    closeDate: displayCloseDate(r),
    // Task #295: true when this is an Overage opp shown as Closed Won only
    // because of the Discovery->Closed Won reclassification. Drives the "i"
    // tooltip in the drilldown Stage column.
    overageReclassified: isOverageReclassified(r),
    type: r.type,
    quoteType: r.quoteType,
    product: r.product,
    rawProduct: r.rawProduct,
    amount: r.amount,
    mrr: compMrr ?? standardizeMrr(r),
    // Task #241: in Compensable Revenue mode, surface the compensation-adjusted
    // amount and the FUB↔Zpro pairing so the drilldown can link the pair. Both
    // are null in Total Revenue mode, leaving the payload byte-for-byte identical.
    compensableMrr: compMrr,
    rawMrr,
    compMultipliers,
    compRuleNames,
    // Generic paired-opp pairing surface. `pairOppName`/`pairKey` link the
    // members of one matched group; `pairAdjustmentLabel` describes the applied
    // adjustment; `churnSuppressed`/`ownerReassignedTo` flag waived churn +
    // gated reassign.
    pairOppName,
    pairKey,
    pairRuleLabel,
    pairAdjustmentLabel,
    churnSuppressed,
    ownerReassignedTo,
    // Task #276: which feeder-sheet column fed the compensable base MRR, plus
    // the rule(s) that drove it. `appliedMrrField` is the effective field
    // (override ?? Type default); null in Total mode. `mrrFieldWinner` is set
    // only when a rule override actually applied; `mrrFieldRuleLabels` lists all
    // matching field-setting rules so the UI can flag conflicts.
    appliedMrrField,
    mrrFieldRuleLabels,
    mrrFieldWinner,
    stage: r.stage,
    funnelStage,
    region: hierarchy.repToRegion[r.rep] || "",
    segment: hierarchy.repToSegment[r.rep] || "",
    group,
    flm: hierarchy.repToFlm[r.rep] || "",
    slm: hierarchy.repToSlm[r.rep] || "",
    probabilityOverride,
    stageDefaultProbability: stageDefault,
    effectiveProbability: probabilityOverride ?? stageDefault,
    isReviewed,
  };
}

function applyDateFilter(
  rows: ParsedRow[],
  dateFilter?: { from?: string; to?: string },
): ParsedRow[] {
  if (!dateFilter?.from && !dateFilter?.to) return rows;
  const fromDate = dateFilter.from
    ? new Date(dateFilter.from + "T00:00:00")
    : null;
  const toDate = dateFilter.to ? new Date(dateFilter.to + "T23:59:59") : null;
  return rows.filter((r) => {
    const cd = effectiveCloseDate(r);
    if (!cd) return false;
    if (fromDate && cd < fromDate) return false;
    if (toDate && cd > toDate) return false;
    return true;
  });
}

export async function getOpportunitiesByFunnelStage(
  funnelStage: string,
  dateFilter?: { from?: string; to?: string },
  pipelineMode: "closeDate" | "allOpen" = "closeDate",
  revenueMode: RevenueMode = "quota",
  rawConditions?: RawCondition[],
) {
  const [allRows, hierarchy, overrides, stageDefaults, reviewedMap] =
    await Promise.all([
      fetchRows(),
      fetchEffectiveHierarchy(monthFromFilter(dateFilter)),
      getOppProbabilityOverrides(),
      getStageDefaultProbabilities(),
      getOppReviewedMap(),
    ]);
  // Task #361: admin Conditions filter on the raw rows before aggregation.
  const rows = filterRowsByRawConditions(allRows, rawConditions, hierarchy);

  const closedStages = new Set(["Closed Won", "Closed Lost"]);

  let filtered: ParsedRow[];
  if (pipelineMode === "closeDate") {
    filtered = applyDateFilter(rows, dateFilter);
  } else {
    const toDate = dateFilter?.to
      ? new Date(dateFilter.to + "T23:59:59")
      : null;
    const fromDate = dateFilter?.from
      ? new Date(dateFilter.from + "T00:00:00")
      : null;
    filtered = rows.filter((r) => {
      const cd = effectiveCloseDate(r);
      if (!cd) return false;
      const fs = effectiveFunnelStage(r);
      if (closedStages.has(fs)) {
        if (!fromDate && !toDate) return true;
        if (fromDate && cd < fromDate) return false;
        if (toDate && cd > toDate) return false;
        return true;
      }
      if (toDate && cd > toDate) return false;
      return true;
    });
  }

  // Both revenue modes are compensation-adjusted now: the per-rule scope is
  // applied inside buildCompensableOppInfo (mode-filtered config), so a mode
  // with no applicable rules naturally yields raw MRR.
  const compInfo = await buildCompensableOppInfo(filtered, hierarchy, revenueMode);
  const opps = filtered
    .filter((r) => {
      if (!hierarchy.allReps.has(r.rep)) return false;
      return effectiveFunnelStage(r) === funnelStage;
    })
    .map((r) =>
      mapRowToOpp(
        r,
        hierarchy,
        overrides,
        stageDefaults,
        reviewedMap,
        compInfo,
      ),
    );

  return { opportunities: dedupeOppsByOppId(opps) };
}

// Returns every open (non-closed) opportunity for the given filter scope.
// Used by the "Unreviewed Opportunities" drilldown which then filters out
// any opp whose probability has already been overridden.
export async function getAllOpenOpportunities(
  dateFilter?: { from?: string; to?: string },
  pipelineMode: "closeDate" | "allOpen" = "closeDate",
  revenueMode: RevenueMode = "quota",
  rawConditions?: RawCondition[],
) {
  const [allRows, hierarchy, overrides, stageDefaults, reviewedMap] =
    await Promise.all([
      fetchRows(),
      fetchEffectiveHierarchy(monthFromFilter(dateFilter)),
      getOppProbabilityOverrides(),
      getStageDefaultProbabilities(),
      getOppReviewedMap(),
    ]);
  // Task #361: admin Conditions filter on the raw rows before aggregation.
  const rows = filterRowsByRawConditions(allRows, rawConditions, hierarchy);

  const closedStages = new Set(["Closed Won", "Closed Lost"]);

  let filtered: ParsedRow[];
  if (pipelineMode === "closeDate") {
    filtered = applyDateFilter(rows, dateFilter);
  } else {
    const toDate = dateFilter?.to
      ? new Date(dateFilter.to + "T23:59:59")
      : null;
    const fromDate = dateFilter?.from
      ? new Date(dateFilter.from + "T00:00:00")
      : null;
    filtered = rows.filter((r) => {
      const cd = effectiveCloseDate(r);
      if (!cd) return false;
      const fs = effectiveFunnelStage(r);
      if (closedStages.has(fs)) {
        if (!fromDate && !toDate) return true;
        if (fromDate && cd < fromDate) return false;
        if (toDate && cd > toDate) return false;
        return true;
      }
      if (toDate && cd > toDate) return false;
      return true;
    });
  }

  // Both revenue modes are compensation-adjusted now (mode-filtered config).
  const compInfo = await buildCompensableOppInfo(filtered, hierarchy, revenueMode);
  const opps = filtered
    .filter((r) => {
      if (!hierarchy.allReps.has(r.rep)) return false;
      return !closedStages.has(effectiveFunnelStage(r));
    })
    .map((r) =>
      mapRowToOpp(
        r,
        hierarchy,
        overrides,
        stageDefaults,
        reviewedMap,
        compInfo,
      ),
    );

  return dedupeOppsByOppId(opps);
}

export async function getOpportunitiesByType(
  oppType: "mrr" | "churn",
  dateFilter?: { from?: string; to?: string },
  revenueMode: RevenueMode = "quota",
  rawConditions?: RawCondition[],
  unattributedOnly = false,
  closedWonOnly = false,
) {
  const [allRows, hierarchy, overrides, stageDefaults, reviewedMap] =
    await Promise.all([
      fetchRows(),
      fetchEffectiveHierarchy(monthFromFilter(dateFilter)),
      getOppProbabilityOverrides(),
      getStageDefaultProbabilities(),
      getOppReviewedMap(),
    ]);
  // Task #361: admin Conditions filter on the raw rows before aggregation.
  const rows = filterRowsByRawConditions(allRows, rawConditions, hierarchy);

  // Task #252: net FUB "Amend Subscription" opps per opportunity BEFORE the
  // per-row sign gate below, mirroring the aggregate-card pipeline
  // (getLivePipelineData). Without this, an opp's paired +/- line items get
  // split across the churn and MRR-Added buckets (e.g. opp 006Do00000CkGFUIA3
  // nets +$10 but its cancellation half alone shows -$6,305 in churn). The
  // merge is net-preserving, so non-FUB products are numerically unchanged.
  // compInfo is built from the merged rows so the compensable-mode MRR lookup
  // (keyed by row identity) and FUB↔Zpro pairing stay correct.
  const filtered = mergePipelineRowsByOpp(applyDateFilter(rows, dateFilter));
  // Both revenue modes are compensation-adjusted now (mode-filtered config).
  const compInfo = await buildCompensableOppInfo(filtered, hierarchy, revenueMode);
  const opps = filtered
    .filter((r) => {
      if (!hierarchy.allReps.has(r.rep) && !hierarchy.repToFlm[r.rep])
        return false;
      // Task #483: Closed-Won-only drilldowns (ACQ Closed Won funnel + Churn
      // drilldowns) need only the Closed Won slice (both signs — the client
      // links closed-won churn to closed-won sales). Gate on the EFFECTIVE
      // funnel stage so reclassified Overage Discovery rows are included,
      // matching the frontend's isEffectiveClosedWon predicate.
      if (closedWonOnly && effectiveFunnelStage(r) !== "Closed Won") return false;
      // Churn classification follows the active revenue mode so the sign of the
      // displayed value matches the bucket the opp lands in.
      if (oppType === "churn") {
        const val = compInfo
          ? (compInfo.mrrByRow.get(r) ?? standardizeMrr(r))
          : standardizeMrr(r);
        return val < 0;
      }
      return true;
    })
    .map((r) =>
      mapRowToOpp(
        r,
        hierarchy,
        overrides,
        stageDefaults,
        reviewedMap,
        compInfo,
      ),
    );

  // Task #380: when the Product Logic "Unattributed opportunities" panel asks
  // for these, filter to the fallthrough ("Other" / "No Product Selected") set
  // server-side so prod returns only the small relevant slice instead of the
  // entire MRR opportunity set (the full payload trips a proxy size limit and
  // surfaces as a browser-side 500 while the origin returns 200).
  const finalOpps = unattributedOnly
    ? opps.filter((o) =>
        FALLTHROUGH_PRODUCTS.has(((o.product as string) || "").trim()),
      )
    : opps;

  return { opportunities: dedupeOppsByOppId(finalOpps) };
}

// ─── Scheduled Mods (Databricks) ──────────────────────────────────────────
// Source: sandbox_stplus.sai_analyst.frontline_dash_sched_mods. Replaces
// the legacy Salesforce-via-sheet feed. New columns surfaced (churn_type,
// product, contact_id, contact_name, opportunity_id, opportunity_type,
// reason, description, segment) flow through ModOpp into the Sched Mods
// drilldown and the per-Churn-Type rows in the GNR Churn Forecast popup.

export const NO_PRODUCT_SELECTED = "No Product Selected";

// Stage-default key used by the per-churn-type rows in the GNR Churn
// Forecast popup. Each distinct churn_type writes its own
// stage_default_probabilities row keyed by the raw value (e.g.
// "Scheduled Mod", "CC Decline"). Default 100% on first read.
function modStageDefaultPct(
  stageDefaults: Record<string, number>,
  churnType: string,
): number {
  return stageDefaults[churnType] ?? 100;
}

// Pull the YYYY-MM month key out of a date filter. Used when looking up
// Manager Estimate values (stored per month). Falls back to current month
// when no filter is set. If the filter spans multiple months we still pick
// the `from` month — Sched Mods Window in the UI is always single-month.
function monthFromFilter(dateFilter?: { from?: string; to?: string }): string {
  if (dateFilter?.from) return monthKey(dateFilter.from);
  if (dateFilter?.to) return monthKey(dateFilter.to);
  return currentMonthKey();
}

async function fetchModsByRep(
  dateFilter?: { from?: string; to?: string },
  probOverrides?: Record<string, number>,
  stageDefaults?: Record<string, number>,
  hierarchy?: OrgHierarchy,
  rawConditions?: RawCondition[],
): Promise<ModsData> {
  const raw = await fetchSchedMods();
  // Task #361: admin Conditions filter on the raw mods before aggregation,
  // limited to the dimensions a mod actually carries (type/product/channel/
  // segment). Other condition fields are no-ops for mods.
  const conditioned = filterSchedModsByRawConditions(raw, rawConditions, hierarchy);
  const filtered = filterSchedMods(conditioned, dateFilter);

  const overrides = probOverrides ?? {};
  const sd = stageDefaults ?? {};

  const byRep: Record<string, number> = {};
  const byRepByProduct: Record<string, Record<string, number>> = {};
  const byRepWeighted: Record<string, number> = {};
  const byRepByProductWeighted: Record<string, Record<string, number>> = {};
  const byRepByProductCount: Record<string, Record<string, number>> = {};
  const byRepByProductByChurnType: Record<
    string,
    Record<string, Record<string, number>>
  > = {};
  const byRepByProductByChurnTypeWeighted: Record<
    string,
    Record<string, Record<string, number>>
  > = {};
  const byRepByProductByChurnTypeCount: Record<
    string,
    Record<string, Record<string, number>>
  > = {};

  // Dedupe by (opportunity_id) when present, else by composite key.
  const seen = new Set<string>();
  for (const m of filtered) {
    const oppId = modOppIdFor(m);
    if (seen.has(oppId)) continue;
    seen.add(oppId);

    const product = m.product || NO_PRODUCT_SELECTED;
    const churnType = m.churnType || "";
    const stageDefault = modStageDefaultPct(sd, m.churnType);
    const override = overrides[oppId];
    const effectiveProb = override == null ? stageDefault : override;
    const weighted = m.amount * (effectiveProb / 100);

    byRep[m.repName] = (byRep[m.repName] || 0) + m.amount;
    if (!byRepByProduct[m.repName]) byRepByProduct[m.repName] = {};
    byRepByProduct[m.repName][product] =
      (byRepByProduct[m.repName][product] || 0) + m.amount;

    byRepWeighted[m.repName] = (byRepWeighted[m.repName] || 0) + weighted;
    if (!byRepByProductWeighted[m.repName])
      byRepByProductWeighted[m.repName] = {};
    byRepByProductWeighted[m.repName][product] =
      (byRepByProductWeighted[m.repName][product] || 0) + weighted;

    if (!byRepByProductCount[m.repName]) byRepByProductCount[m.repName] = {};
    byRepByProductCount[m.repName][product] =
      (byRepByProductCount[m.repName][product] || 0) + 1;

    if (!byRepByProductByChurnType[m.repName])
      byRepByProductByChurnType[m.repName] = {};
    if (!byRepByProductByChurnType[m.repName][product])
      byRepByProductByChurnType[m.repName][product] = {};
    byRepByProductByChurnType[m.repName][product][churnType] =
      (byRepByProductByChurnType[m.repName][product][churnType] || 0) +
      m.amount;

    if (!byRepByProductByChurnTypeWeighted[m.repName])
      byRepByProductByChurnTypeWeighted[m.repName] = {};
    if (!byRepByProductByChurnTypeWeighted[m.repName][product])
      byRepByProductByChurnTypeWeighted[m.repName][product] = {};
    byRepByProductByChurnTypeWeighted[m.repName][product][churnType] =
      (byRepByProductByChurnTypeWeighted[m.repName][product][churnType] || 0) +
      weighted;

    if (!byRepByProductByChurnTypeCount[m.repName])
      byRepByProductByChurnTypeCount[m.repName] = {};
    if (!byRepByProductByChurnTypeCount[m.repName][product])
      byRepByProductByChurnTypeCount[m.repName][product] = {};
    byRepByProductByChurnTypeCount[m.repName][product][churnType] =
      (byRepByProductByChurnTypeCount[m.repName][product][churnType] || 0) + 1;
  }

  // Manager Estimate contributions: per-(flm, month, product) value
  // distributed evenly across the FLM's reps, weighted by per-rep prob %
  // override (id `mgr_est:{rep}|{month}|{product}`) — defaults 100%.
  // Counts are NOT incremented (these are estimates, not real mod rows).
  if (hierarchy) {
    const month = monthFromFilter(dateFilter);
    const flmToReps: Record<string, string[]> = {};
    for (const [rep, flm] of Object.entries(hierarchy.repToFlm || {})) {
      if (!flm) continue;
      (flmToReps[flm] = flmToReps[flm] || []).push(rep);
    }
    const flmsInScope = Object.keys(flmToReps);
    if (flmsInScope.length > 0) {
      const ests = await getManagerEstimates(month, flmsInScope);
      const shares = distributePerRep(ests, flmToReps);
      for (const s of shares) {
        if (!hierarchy.allReps.has(s.rep)) continue;
        if (s.amount <= 0) continue;
        const meId = managerEstimateOppId(s.rep, s.monthYyyymm, s.product);
        const override = overrides[meId];
        const effectiveProb = override == null ? 100 : override;
        const weighted = s.amount * (effectiveProb / 100);

        byRep[s.rep] = (byRep[s.rep] || 0) + s.amount;
        if (!byRepByProduct[s.rep]) byRepByProduct[s.rep] = {};
        byRepByProduct[s.rep][s.product] =
          (byRepByProduct[s.rep][s.product] || 0) + s.amount;

        byRepWeighted[s.rep] = (byRepWeighted[s.rep] || 0) + weighted;
        if (!byRepByProductWeighted[s.rep]) byRepByProductWeighted[s.rep] = {};
        byRepByProductWeighted[s.rep][s.product] =
          (byRepByProductWeighted[s.rep][s.product] || 0) + weighted;
      }
    }
  }

  return {
    byRep,
    byRepByProduct,
    byRepWeighted,
    byRepByProductWeighted,
    byRepByProductCount,
    byRepByProductByChurnType,
    byRepByProductByChurnTypeWeighted,
    byRepByProductByChurnTypeCount,
  };
}

export interface ModOpp {
  oppId: string;
  // Real Salesforce opportunity_id when present (null for half of CC
  // Decline rows). When present, the Sched Mods drilldown's Opportunity
  // Type cell links to the SF opportunity record.
  opportunityId: string | null;
  opportunityType: string;
  contactId: string;
  contactName: string;
  contactZuid: string;
  segment: string;
  reason: string;
  description: string;
  churnType: string;
  rep: string;
  product: string;
  modDate: string;
  amount: number;
  region: string;
  group: string;
  flm: string;
  slm: string;
  // The legacy `manager` field used to be sourced from the sheet's
  // Owner: Manager column. We now source it from the hierarchy lookup
  // (rep → FLM) so the value is consistent across the dashboard.
  manager: string;
  // Legacy fields kept for back-compat with downstream consumers that
  // still read them (mostly drilldown column rendering during the
  // multi-step migration). `oppName` mirrors `opportunityType` and
  // `accountName` mirrors `contactName` so existing renders don't blank
  // out before the column rewrite ships.
  oppName: string;
  accountName: string;
  // Per-row probability — `stageDefaultProbability` reads the per-
  // churn-type stage default rather than the legacy "Scheduled Mods"
  // single key. Override / effective behave like the rest of the app.
  stageDefaultProbability: number | null;
  probabilityOverride: number | null;
  effectiveProbability: number | null;
  isReviewed: boolean;
}

export async function getModsOpportunities(
  dateFilter?: {
    from?: string;
    to?: string;
  },
  rawConditions?: RawCondition[],
): Promise<{ opportunities: ModOpp[] }> {
  const [hierarchy, raw, probOverrides, stageDefaults, reviewedMap] =
    await Promise.all([
      fetchEffectiveHierarchy(monthFromFilter(dateFilter)),
      fetchSchedMods(),
      getOppProbabilityOverrides(),
      getStageDefaultProbabilities(),
      getOppReviewedMap(),
    ]);
  // Task #361: admin Conditions filter on the raw mods before aggregation.
  const conditioned = filterSchedModsByRawConditions(raw, rawConditions, hierarchy);
  const filtered = filterSchedMods(conditioned, dateFilter);

  const groupedMap = new Map<string, ModOpp>();
  for (const m of filtered) {
    if (!hierarchy.allReps.has(m.repName) && !hierarchy.repToFlm[m.repName])
      continue;

    const flm = hierarchy.repToFlm[m.repName] || "";
    const slm = hierarchy.repToSlm[m.repName] || "";
    const region = hierarchy.repToRegion[m.repName] || m.repRegion || "";
    const group = hierarchy.repToGroup[m.repName] || "";
    const oppId = modOppIdFor(m);

    // Dedupe — keep highest amount when the same id surfaces twice.
    const existing = groupedMap.get(oppId);
    if (existing && existing.amount >= m.amount) continue;

    const stageDefault = modStageDefaultPct(stageDefaults, m.churnType);
    const override = probOverrides[oppId];
    const probabilityOverride = override == null ? null : override;
    const effectiveProbability = probabilityOverride ?? stageDefault;
    const isReviewed = reviewedMap[oppId] === true;

    groupedMap.set(oppId, {
      oppId,
      opportunityId: m.opportunityId,
      opportunityType: m.opportunityType,
      contactId: m.contactId,
      contactName: m.contactName,
      contactZuid: m.contactZuid,
      segment: m.segment,
      reason: m.reason,
      description: m.description,
      churnType: m.churnType,
      rep: m.repName,
      product: m.product || NO_PRODUCT_SELECTED,
      modDate: m.cancellationDate,
      amount: m.amount,
      region,
      group,
      flm,
      slm,
      manager: flm,
      oppName: m.opportunityType,
      accountName: m.contactName,
      stageDefaultProbability: stageDefault,
      probabilityOverride,
      effectiveProbability,
      isReviewed,
    });
  }

  return { opportunities: Array.from(groupedMap.values()) };
}

// ── Anaplan Check Tool ──────────────────────────────────────────────────────
// Reconciles Anaplan's per-CPD "Current Month MRR" (the comp source of truth)
// against the dashboard's comp-engine quota-mode compensable MRR, joined by the
// CPD's opportunity_ids. Surfaces divergences; no hierarchy scoping (every role
// sees every CPD row). See .agents/memory/anaplan-fld-reconciliation.md for the
// structural reasons the two bases diverge.

// A single opportunity referenced by an Anaplan CPD (or, in `unmatchedOpps`, a
// dashboard opp not referenced by any CPD), with its joined dashboard data.
// One product line item within an opportunity (an opp can carry several).
export interface AnaplanRawMrr {
  changeInMrr: number;
  totalMrr: number;
  splitTotalPrice: number;
  totalPrice: number;
  amount: number;
  mrr: number;
}

export interface AnaplanLineItem {
  product: string;
  compensableMrr: number;
  // The line item's owner (effective rep after any comp owner-reassignment),
  // so a multi-owner opportunity can show every line beside its owner name —
  // even owners outside the opp's attributed channel.
  rep: string;
  // The owner's effective channel/group (post owner-reassignment).
  group: string;
  // Task #487: true when this line item belongs to a different channel than the
  // opp line it is shown under. Out-of-channel lines are displayed for context
  // (with their owner name) but DO NOT add to the opp's compensableMrr total
  // unless a compensation/product rule reassigns the credit into this channel.
  outOfChannel: boolean;
  ruleNames: string[];
  multipliers: number[];
  // Task #531: paired-opp adjustment label for this line's side (e.g.
  // "zpro: × 0.1", "fub: waived"), mirroring the drilldown's Multipliers
  // column text. Null when the line is not part of a fired pair.
  pairAdjustmentLabel: string | null;
  // Raw feeder-sheet MRR columns for this line, so the Anaplan table can show
  // every candidate MRR field beside the compensable total.
  rawMrr: AnaplanRawMrr;
  // The feeder MrrField the engine's Type-driven product logic uses as the base
  // compensable MRR (no rule override). Blank for CPD-sourced rows.
  baseMrrField: string;
  // The feeder MrrField actually used after rule overrides — equals
  // baseMrrField unless a rule's MRR-field override won.
  effectiveMrrField: string;
  // Label of the rule whose MRR-field override applied (null when the default
  // field was used).
  mrrFieldWinner: string | null;
  // Labels of every matching MRR-field-setting rule (length > 1 = conflict).
  mrrFieldRuleLabels: string[];
  // Label of the Product Logic rule (first-match) that selected this line's
  // base MRR field. Blank when no rule matched (legacy passthrough).
  productLogicLabel: string;
  // 1-based position of that rule in the active rule list (mirrors the Product
  // Logic tab numbering). Null when no rule matched.
  productLogicNumber: number | null;
  // Task #475: true when this line is an Acquisitions-channel churn line item
  // that the Acquisition churn gate drops from Quota Target MRR (a negative
  // Closed Won line with no paired positive Closed Won for the same
  // rep/account/product this month). Its compensableMrr is forced to 0 so the
  // Anaplan total reconciles to the Pipeline acqNet total; the UI renders it red.
  excludedByAcqChurn: boolean;
  // Task #563: true when this line WOULD have been dropped by the Acquisition
  // churn gate but an "Ignore ACQ Churn Logic" adjustment flagged its opp to
  // bypass the gate, so its churn counts toward Quota Target MRR anyway.
  acqChurnOverridden: boolean;
}

// Task #524: a partner opportunity that satisfied a paired-opp comp rule's
// trigger alongside the opp it is shown under (same engine pairKey). Purely
// display context for the Anaplan table's expandable pair rows — partner MRR is
// NEVER added to the CPD's Quota Target MRR or any Anaplan aggregate. Partner
// opps are often owned by other reps (e.g. an On Demand "V3 Cancel: waived"
// cancel) and absent from the CPD's own opp list, so they are embedded here.
export interface AnaplanPartnerOpp {
  oppId: string;
  oppName: string;
  accountId: string;
  rep: string;
  product: string;
  // The paired rule's label for the partner's side (e.g. "V3 Cancel: waived").
  ruleLabel: string;
  // Context-only compensable MRR of the partner rows (e.g. $0.00 waived).
  compensableMrr: number;
  // Raw feeder MRR columns summed across the partner's rows (context only).
  rawMrr: AnaplanRawMrr;
}

export interface AnaplanOppLine {
  oppId: string;
  found: boolean;
  compensableMrr: number;
  product: string;
  rep: string;
  oppName: string;
  accountId: string;
  // No account-name column exists upstream; the opportunity name is the best
  // human-readable label and is what the Opportunities cell / lookup use.
  accountName: string;
  // Org-hierarchy dimensions for the opp's rep, so the client header filters
  // (slm/flm/rep/region/segment/group) can narrow the table like other views.
  slm: string;
  flm: string;
  region: string;
  segment: string;
  group: string;
  sfContactId?: string;
  sfCpdId?: string;
  ruleNames: string[];
  multipliers: number[];
  lineItemCount: number;
  lineItems: AnaplanLineItem[];
  // Opp-level sum of each raw feeder MRR column across its line items.
  rawMrr: AnaplanRawMrr;
  // Task #475: true when at least one of this opp's line items was dropped by
  // the Acquisition churn gate (see AnaplanLineItem.excludedByAcqChurn). The
  // dropped lines contribute 0 to compensableMrr; the UI renders the opp red.
  excludedByAcqChurn: boolean;
  // Task #563: true when at least one line item bypassed the Acquisition churn
  // gate via an "Ignore ACQ Churn Logic" adjustment (see
  // AnaplanLineItem.acqChurnOverridden).
  acqChurnOverridden: boolean;
  // The opportunity's displayed close date (M/D/YYYY), from the anchor row's
  // displayCloseDate. Shown in the "opps missing CPDs" table on the Anaplan tab.
  closeDate: string;
  // Task #524: paired-opp rule metadata, mirroring the pipeline drilldown's
  // pair badge/expansion (same engine pairKey/pairOppName/pairRuleLabel). Set
  // only when a fired paired rule pairs this opp; partnerOpps embeds the
  // context-only partner rows sharing the pairKey (see AnaplanPartnerOpp).
  pairOppName?: string;
  pairRuleLabel?: string;
  pairKey?: string;
  partnerOpps?: AnaplanPartnerOpp[];
}

// Header-filter dimensions derived from a CPD's own fields plus the rep
// hierarchy. Used so an opp-less CPD (one with no found opportunity to supply
// dims) stays visible and filterable by the normal header filters instead of
// disappearing. Any dimension that cannot be resolved is the literal "None".
export interface AnaplanFallbackDims {
  slm: string;
  flm: string;
  rep: string;
  region: string;
  segment: string;
  group: string;
  product: string;
}

export interface AnaplanCpdRow {
  cpdId: string;
  slm: string;
  owner: string;
  partnerName: string;
  compensationDate: string;
  // Every raw Anaplan source column, preserved verbatim for the column picker.
  source: Record<string, string>;
  groupAMrr: number;
  groupBMrr: number;
  groupCMrr: number;
  anaplanMrr: number;
  quotaTargetMrr: number;
  opportunityIds: string[];
  opps: AnaplanOppLine[];
  // Fallback header dimensions for opp-less CPDs (see AnaplanFallbackDims).
  fallbackDims: AnaplanFallbackDims;
  // Whether the CPD's Owner (normalized) is a member of the month-scoped
  // effective hierarchy: true = in hierarchy, false = not found, null = the
  // Owner field is blank (such rows are never owner-filterable).
  ownerInHierarchy: boolean | null;
}

export interface AnaplanCheckResult {
  month: string;
  // Inclusive opportunity-data window actually reflected in the reconciliation.
  // start = selected month's first day; end = min(yesterday-PST cutoff, month
  // end). Surfaced so the legend can state the exact range in use.
  oppWindowStart: string;
  oppWindowEnd: string;
  lastUpdate: string | null;
  fetchedAt: string | null;
  fetchError: boolean;
  fetchErrorMessage?: string;
  allColumns: string[];
  rows: AnaplanCpdRow[];
  unmatchedOpps: AnaplanOppLine[];
}

export async function getAnaplanCheck(
  dateFilter?: {
    from?: string;
    to?: string;
  },
  rawConditions: RawCondition[] = [],
): Promise<AnaplanCheckResult> {
  const month = monthFromFilter(dateFilter);
  const [snapshot, rows, hierarchy] = await Promise.all([
    fetchAnaplanData(),
    fetchRows(),
    fetchEffectiveHierarchy(month),
  ]);

  // Task #529: the admin "Conditions" builder gates the Anaplan view at the
  // CPD level, NOT the row level. Pre-filtering rows here (the old behavior)
  // silently dropped non-matching line items inside a surviving CPD, changing
  // its MRR. Instead the full computation runs on UNFILTERED rows (so the comp
  // engine sees every partner opp and totals stay intact), and the final CPD
  // result set is gated below: a CPD survives iff at least one of its linked
  // opportunities has a matching underlying row, and keeps ALL its rows.
  const conditionsActive = rawConditions.length > 0;

  // Scope dashboard rows to the selected close-date month — the same window the
  // quota / compensable views use — then compute quota-mode compensable MRR.
  // All close dates within the selected month are included (no yesterday-PST
  // cutoff), so opportunities closing "today" appear immediately.
  //
  // Overage opps are filtered by their EFFECTIVE close date (the 1st of the
  // accrual month — `effectiveCloseDate` pins reclassified Overage to day 1),
  // not the raw close date. This keeps reclassified Overage inside its month,
  // matching how the pipeline tab counts Overage MTD. Non-Overage rows keep the
  // raw close date.
  const unmergedSubset = rows.filter((r) => {
    if (isOverageReclassified(r)) {
      const eff = effectiveCloseDate(r);
      if (!eff) return false;
      const effMonth = `${eff.getFullYear()}-${String(eff.getMonth() + 1).padStart(2, "0")}`;
      return effMonth === month;
    }
    return compMonthKey(r.closeDate) === month;
  });
  // Task #475: collapse paired/amended line items per opportunity using the
  // SAME merge the Pipeline view applies (mergePipelineRowsByOpp, keyed on
  // rep||oppId||product||funnelStage, so owner-scoping is preserved). This nets
  // the FUB "Amend Subscription" ± line-item pairs (and any other intra-opp
  // offsets) into one row per opp/product before the comp engine + churn gate
  // run, so the Anaplan opp/line counts and summed MRR no longer double up on
  // ± pairs — matching the Pipeline net Quota Target MRR.
  const subset = mergePipelineRowsByOpp(unmergedSubset);
  const compInfo = await buildCompensableOppInfo(subset, hierarchy, "quota");

  // Opportunity-data window actually reflected above: start = the selected
  // month's first day; end = the selected month's last day (the full month, with
  // no yesterday-PST truncation).
  const [winY, winM] = month.split("-").map(Number);
  const fmtDate = (y: number, m: number, d: number): string =>
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const oppWindowStart = `${month}-01`;
  const monthEndD = new Date(winY, winM, 0);
  const oppWindowEnd = fmtDate(
    monthEndD.getFullYear(),
    monthEndD.getMonth() + 1,
    monthEndD.getDate(),
  );

  // The Anaplan reconciliation only analyses Closed Won opps. Pipeline / quota
  // actuals gate compensable MRR on effectiveFunnelStage === "Closed Won", so
  // non-closed-won rows (open pipeline, closed lost) must NOT inflate a CPD's
  // Quota Target MRR or surface in the "opps missing CPDs" list. The comp engine
  // still ran over the FULL month subset above so paired-opp rules can see their
  // partner opps; only the join index + reverse-unmatched set are gated here.
  const subsetCW = subset.filter(
    (r) => effectiveFunnelStage(r) === "Closed Won",
  );

  // Task #529: canonical opp/CPD ids whose underlying rows match the admin
  // Conditions. Evaluated on the UNMERGED month rows (the same pre-merge rows
  // the Pipeline row filter sees, so field semantics — e.g. Type on a mixed-
  // type opp — stay identical), gated to Closed Won like the join index. A CPD
  // survives the filter iff at least one of its linked ids appears here; the
  // reverse-unmatched list keeps only opps whose id appears here.
  const conditionMatchedIds = new Set<string>();
  if (conditionsActive) {
    for (const r of unmergedSubset) {
      if (effectiveFunnelStage(r) !== "Closed Won") continue;
      if (!rowMatchesRawConditions(r, rawConditions, hierarchy)) continue;
      const oppKey = canonicalizeOppId(r.oppId);
      const cpdKey = canonicalizeOppId(r.sfCpdId);
      if (oppKey) conditionMatchedIds.add(oppKey);
      if (cpdKey) conditionMatchedIds.add(cpdKey);
    }
  }

  // Task #475: per-channel churn parity with the Pipeline view (acqNet vs
  // gnrNet). Mirrors computePipelineData:
  //   - Acquisitions reps: a negative Closed Won line ("churn") only nets if a
  //     positive Closed Won line for the SAME rep+account+product exists this
  //     month (paired). Unpaired Acquisition churn is dropped from Quota Target
  //     MRR (and flagged so the UI can render it red) — Pipeline's acqNet does
  //     the same via positiveClosedWonKeys.
  //   - G&R / On Demand reps: net = added − |all churn| (every negative line
  //     counts), so no churn is dropped.
  // The gate keys off each opp's OWN rep channel, independent of the selected
  // channel filter, so Acquisitions and G&R both reconcile to their Pipeline
  // net for the same date range.
  const positiveClosedWonKeys = new Set<string>();
  for (const r of subsetCW) {
    if ((compInfo.mrrByRow.get(r) ?? 0) > 0)
      positiveClosedWonKeys.add(
        `${r.rep}||${r.accountId}||${r.product || "No Product Selected"}`,
      );
  }
  const isAcqGroup = (g: string): boolean =>
    g.trim().toLowerCase().startsWith("acq");
  // The compensable contribution of a row after the per-channel churn gate, plus
  // whether the Acquisition gate dropped it. Acquisition unpaired churn → 0 and
  // excluded; everything else → its raw compensable MRR.
  const netContribution = (
    r: ParsedRow,
  ): { value: number; excluded: boolean; overridden: boolean } => {
    const m = compInfo.mrrByRow.get(r) ?? 0;
    if (m < 0 && isAcqGroup(hierarchy.repToGroup[r.rep] ?? "")) {
      const key = `${r.rep}||${r.accountId}||${r.product || "No Product Selected"}`;
      if (!positiveClosedWonKeys.has(key)) {
        // Task #563: an "Ignore ACQ Churn Logic" paired-rule adjustment
        // bypasses the gate — the churn counts, flagged as overridden so the
        // UI can still identify the rescued line.
        if (compInfo.acqChurnIgnoredRows.has(r))
          return { value: m, excluded: false, overridden: true };
        // Task #566: "Amend Subscription" quote-type churn always counts —
        // exempt from the pairing gate (mirrors Pipeline's acqGateBypassed).
        // Counts normally (not flagged overridden: it isn't an adjustment
        // rescue, it's a standing quote-type exemption).
        if (isAmendSubscriptionQuoteType(r.quoteType))
          return { value: m, excluded: false, overridden: false };
        return { value: 0, excluded: true, overridden: false };
      }
    }
    return { value: m, excluded: false, overridden: false };
  };

  // Index dashboard line items by canonical opp id, aliasing synthetic CPD rows
  // under their raw Salesforce CPD id (sfCpdId) so the Anaplan opportunity_ids
  // (which list the a6B… CPD ids) join to them.
  const rowsByOppId = new Map<string, ParsedRow[]>();
  const addToIndex = (key: string, r: ParsedRow) => {
    if (!key) return;
    let list = rowsByOppId.get(key);
    if (!list) {
      list = [];
      rowsByOppId.set(key, list);
    }
    list.push(r);
  };
  for (const r of subsetCW) {
    const oppKey = canonicalizeOppId(r.oppId);
    const cpdKey = canonicalizeOppId(r.sfCpdId);
    if (oppKey) addToIndex(oppKey, r);
    // Synthetic CPD rows now carry their bare (canonicalized) sfCpdId as oppId,
    // so oppKey and cpdKey can coincide — only alias under the CPD id when it
    // differs, otherwise the row would be listed twice under one key.
    if (cpdKey && cpdKey !== oppKey) addToIndex(cpdKey, r);
  }

  // Task #524: index Closed Won rows by the comp engine's pairKey so a
  // paired-affected opp line can embed its partner opp(s) — the SAME pairKey
  // grouping the pipeline drilldown's linked-opp expansion uses. Partner rows
  // are display context only; they never feed quotaTargetMrr or claiming.
  const pairRowsByKey = new Map<string, ParsedRow[]>();
  for (const r of subsetCW) {
    if (!r.oppId) continue;
    const pk = compInfo.keyByOppId.get(r.oppId);
    if (!pk) continue;
    let list = pairRowsByKey.get(pk);
    if (!list) {
      list = [];
      pairRowsByKey.set(pk, list);
    }
    list.push(r);
  }

  const numFrom = (v: string | undefined): number => {
    const n = parseFloat((v ?? "").toString());
    return Number.isFinite(n) ? n : 0;
  };
  const parseOppIds = (raw: string | undefined): string[] => {
    const s = (raw ?? "").trim();
    if (!s) return [];
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr))
        return arr.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      /* fall through to delimiter split */
    }
    return s
      .replace(/[[\]"]/g, "")
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  };

  // Rows referenced by at least one CPD, so the reverse "opps missing CPDs"
  // list can exclude them.
  const claimed = new Set<ParsedRow>();
  // Task #487: a row's channel for the unmatched per-channel split mirrors the
  // Pipeline net exactly. computePipelineData buckets every line by its RAW rep
  // (repMap[r.rep] / repToGroup[r.rep]) with no owner-reassignment shift, and
  // netContribution's acq-churn gate keys off that same raw rep group. Using the
  // reassigned owner here would move credit across channels that Pipeline keeps
  // in place and break the reconciliation, so the split stays on the raw rep.
  const effRepOf = (r: ParsedRow): string => r.rep;
  const effGroupOf = (r: ParsedRow): string =>
    hierarchy.repToGroup[r.rep] ?? "";
  const lineFromRows = (
    key: string,
    matched: ParsedRow[],
    markClaimed: boolean,
    // When set, only rows whose effective channel equals countedChannel add to
    // the opp total; rows in other channels are still emitted as line items
    // (flagged outOfChannel) for context but contribute 0 to compensableMrr.
    countedChannel?: string,
  ): AnaplanOppLine => {
    let compensableMrr = 0;
    const ruleNameSet = new Set<string>();
    const multipliers: number[] = [];
    const lineItems: AnaplanLineItem[] = [];
    // Opp-level sum of each raw feeder MRR column across its line items, so the
    // Anaplan table can show every candidate MRR field beside the compensable
    // total (Task #470 follow-on).
    const oppRawMrr = {
      changeInMrr: 0,
      totalMrr: 0,
      splitTotalPrice: 0,
      totalPrice: 0,
      amount: 0,
      mrr: 0,
    };
    const plRules = getActiveRules();
    let anyExcluded = false;
    let anyOverridden = false;
    // Task #487: order in-channel rows first so the opp header + line list lead
    // with the counted owner; out-of-channel context rows follow.
    const ordered =
      countedChannel == null
        ? matched
        : [...matched].sort(
            (a, b) =>
              (effGroupOf(a) === countedChannel ? 0 : 1) -
              (effGroupOf(b) === countedChannel ? 0 : 1),
          );
    for (const r of ordered) {
      if (markClaimed) claimed.add(r);
      // Task #487: a row outside the attributed channel is shown for context but
      // never adds to this channel's total (its credit belongs to its own
      // channel's line). When countedChannel is unset (matched CPD path), every
      // row counts as before.
      const outOfChannel =
        countedChannel != null && effGroupOf(r) !== countedChannel;
      // Task #475: apply the per-channel churn gate. An Acquisition unpaired
      // churn line contributes 0 to compensableMrr and is flagged excluded so
      // the UI renders it red; everything else contributes its compensable MRR.
      const nc = netContribution(r);
      const rowMrr = nc.value;
      const rowRules = [...(compInfo.ruleNamesByRow.get(r) ?? [])];
      const rowMults = [...(compInfo.multipliersByRow.get(r) ?? [])];
      if (!outOfChannel) {
        if (nc.excluded) anyExcluded = true;
        if (nc.overridden) anyOverridden = true;
        compensableMrr += rowMrr;
        for (const n of rowRules) ruleNameSet.add(n);
        for (const m of rowMults) multipliers.push(m);
      }
      const baseMrrField = appliedBaseMrrFieldForRow(r);
      // Which Product Logic rule selected the base MRR field (first-match,
      // top-down) — its label + 1-based position mirror the Product Logic tab.
      const plMatch = evaluateProductLogic(r, plRules);
      const plIdx = plMatch.ruleId
        ? plRules.findIndex((x) => x.id === plMatch.ruleId)
        : -1;
      const productLogicLabel = plIdx >= 0 ? plRules[plIdx].label : "";
      const productLogicNumber = plIdx >= 0 ? plIdx + 1 : null;
      const effectiveMrrField =
        compInfo.mrrFieldByRow.get(r) ?? baseMrrField;
      const rowRaw = {
        changeInMrr: r.changeInMrr,
        totalMrr: r.totalMrr,
        splitTotalPrice: r.splitTotalPrice,
        totalPrice: r.totalPrice,
        amount: r.amount,
        mrr: r.mrr,
      };
      oppRawMrr.changeInMrr += rowRaw.changeInMrr;
      oppRawMrr.totalMrr += rowRaw.totalMrr;
      oppRawMrr.splitTotalPrice += rowRaw.splitTotalPrice;
      oppRawMrr.totalPrice += rowRaw.totalPrice;
      oppRawMrr.amount += rowRaw.amount;
      oppRawMrr.mrr += rowRaw.mrr;
      lineItems.push({
        product: r.product,
        compensableMrr: rowMrr,
        rep: effRepOf(r),
        group: effGroupOf(r),
        outOfChannel,
        ruleNames: rowRules,
        multipliers: rowMults,
        pairAdjustmentLabel: compInfo.pairAdjLabelByRow.get(r) ?? null,
        rawMrr: rowRaw,
        baseMrrField,
        effectiveMrrField,
        mrrFieldWinner: compInfo.mrrFieldWinnerByRow.get(r) ?? null,
        mrrFieldRuleLabels: [...(compInfo.mrrFieldRuleLabelsByRow.get(r) ?? [])],
        productLogicLabel,
        productLogicNumber,
        excludedByAcqChurn: nc.excluded,
        acqChurnOverridden: nc.overridden,
      });
    }
    // Header fields lead with the counted (in-channel) owner so the opp's rep /
    // dims / group describe the channel it is attributed to. `ordered` already
    // places in-channel rows first, so ordered[0] is the right anchor. The
    // matched CPD path (countedChannel unset) keeps its exact prior behavior:
    // the raw first-row rep, no owner-reassignment shift.
    const first = ordered[0];
    const rep =
      countedChannel != null
        ? first
          ? effRepOf(first)
          : ""
        : (first?.rep ?? "");
    // Task #524: paired-opp rule metadata + embedded partner opps, mirroring
    // the pipeline drilldown's badge/expansion. Anchor on the first matched row
    // the engine paired (keyByOppId); partners are the OTHER side of the pair
    // group (different oppId AND different named-opp role — the same filter the
    // drilldown's getLinkedOpps applies). Partner MRR is display context only:
    // nothing here touches compensableMrr, quotaTargetMrr, or claiming.
    let pairOppName: string | undefined;
    let pairRuleLabel: string | undefined;
    let pairKey: string | undefined;
    let partnerOpps: AnaplanPartnerOpp[] | undefined;
    const pairAnchor = ordered.find(
      (r) => r.oppId && compInfo.keyByOppId.has(r.oppId),
    );
    if (pairAnchor) {
      pairKey = compInfo.keyByOppId.get(pairAnchor.oppId);
      pairOppName = compInfo.oppNameByOppId.get(pairAnchor.oppId);
      pairRuleLabel = compInfo.ruleLabelByOppId.get(pairAnchor.oppId);
      const ownOppIds = new Set(
        matched.map((r) => r.oppId).filter((x): x is string => !!x),
      );
      const ownRows = new Set(matched);
      const partnersById = new Map<string, AnaplanPartnerOpp>();
      for (const pr of pairRowsByKey.get(pairKey ?? "") ?? []) {
        if (!pr.oppId || ownRows.has(pr) || ownOppIds.has(pr.oppId)) continue;
        if (compInfo.oppNameByOppId.get(pr.oppId) === pairOppName) continue;
        let agg = partnersById.get(pr.oppId);
        if (!agg) {
          agg = {
            oppId: pr.oppId,
            oppName: pr.oppName,
            accountId: pr.accountId,
            rep: pr.rep,
            product: pr.product,
            ruleLabel: compInfo.ruleLabelByOppId.get(pr.oppId) ?? "",
            compensableMrr: 0,
            rawMrr: {
              changeInMrr: 0,
              totalMrr: 0,
              splitTotalPrice: 0,
              totalPrice: 0,
              amount: 0,
              mrr: 0,
            },
          };
          partnersById.set(pr.oppId, agg);
        }
        agg.compensableMrr += compInfo.mrrByRow.get(pr) ?? 0;
        agg.rawMrr.changeInMrr += pr.changeInMrr;
        agg.rawMrr.totalMrr += pr.totalMrr;
        agg.rawMrr.splitTotalPrice += pr.splitTotalPrice;
        agg.rawMrr.totalPrice += pr.totalPrice;
        agg.rawMrr.amount += pr.amount;
        agg.rawMrr.mrr += pr.mrr;
      }
      if (partnersById.size > 0) partnerOpps = [...partnersById.values()];
    }
    return {
      oppId: key,
      found: matched.length > 0,
      compensableMrr,
      excludedByAcqChurn: anyExcluded,
      acqChurnOverridden: anyOverridden,
      product: first?.product ?? "",
      rep,
      oppName: first?.oppName ?? "",
      accountId: first?.accountId ?? "",
      accountName: first?.oppName ?? "",
      slm: hierarchy.repToSlm[rep] ?? "",
      flm: hierarchy.repToFlm[rep] ?? "",
      region: hierarchy.repToRegion[rep] ?? "",
      segment: hierarchy.repToSegment[rep] ?? "",
      group: countedChannel ?? hierarchy.repToGroup[rep] ?? "",
      sfContactId: first?.sfContactId,
      sfCpdId: first?.sfCpdId,
      ruleNames: [...ruleNameSet],
      multipliers,
      lineItemCount: matched.length,
      lineItems,
      rawMrr: oppRawMrr,
      closeDate: first ? displayCloseDate(first) : "",
      pairOppName,
      pairRuleLabel,
      pairKey,
      partnerOpps,
    };
  };

  // Anaplan rows scoped to the selected month via Compensation Date.
  const monthAnaplan = snapshot.rows.filter(
    (r) => compMonthKey(r[ANAPLAN_COL.compensationDate]) === month,
  );

  const normalizeAnaplanName = (s: string | undefined | null) =>
    (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

  // Normalized names of every member of the month-scoped EFFECTIVE hierarchy
  // (reps + FLMs + SLMs). The effective hierarchy already drops people who are
  // inactive for the selected month, so "in hierarchy" here means active this
  // month. Used to stamp each CPD row's `ownerInHierarchy` flag so the client
  // can filter Anaplan owners that aren't part of the dashboard org.
  const hierarchyMembers = new Set<string>();
  {
    const addMember = (n: string | undefined | null) => {
      const k = normalizeAnaplanName(n);
      if (k) hierarchyMembers.add(k);
    };
    for (const r of hierarchy.allReps) addMember(r);
    for (const s of hierarchy.slms) addMember(s);
    for (const flms of Object.values(hierarchy.slmToFlms))
      for (const f of flms) addMember(f);
    for (const f of Object.keys(hierarchy.flmToReps)) addMember(f);
  }

  const allCpdRows: AnaplanCpdRow[] = monthAnaplan.map((src) => {
    const opportunityIds = parseOppIds(src[ANAPLAN_COL.opportunityIds]);
    // Task #451: scope each opportunity's line items to the CPD owner, mirroring
    // the pipeline opportunity drilldown's per-(oppId, rep) split
    // (dedupeOppsByOppId keyed on `oppId||rep`). A single opportunity can carry
    // line items for multiple reps — e.g. the CPD owner's Showcase Ad Hoc credit
    // at 75% MRR PLUS a separate "Compliance Sales" credit at full MRR under the
    // same oppId. Only the owner's own rows belong in THIS owner's Quota Target
    // MRR; summing every rep's rows double-counts other owners' credit (the
    // reported $1,575 instead of the correct $675). When the Owner is blank we
    // fall back to all rows so the join never silently drops everything.
    const ownerKey = normalizeAnaplanName(src[ANAPLAN_COL.owner]);
    // Owner-scoped Quota Target MRR (Task #451): only the CPD owner's own rows
    // ever count toward THIS CPD's quota. Accumulated per opp below so that
    // resolving paired partner opps as "found" (Task #465) never alters the sum.
    let quotaTargetMrr = 0;
    const opps = opportunityIds.map((rawId) => {
      const id = canonicalizeOppId(rawId);
      const all = rowsByOppId.get(id) ?? [];
      // Claim EVERY row referenced by this CPD's opp id — including other reps'
      // line items (e.g. the "Compliance Sales" credit) — so the reverse
      // direction "opps missing CPDs" never flags an opportunity that IS
      // referenced by a CPD. Quota Target MRR below, however, counts only the
      // owner's own rows (markClaimed=false on lineFromRows so claiming isn't
      // re-scoped to the owner subset).
      for (const r of all) claimed.add(r);
      const ownerRows = ownerKey
        ? all.filter((r) => normalizeAnaplanName(r.rep) === ownerKey)
        : all;
      // Only the owner's own rows count toward Quota Target MRR (Task #451),
      // and Task #475 applies the per-channel churn gate so unpaired Acquisition
      // churn does not subtract from the total (reconciles to Pipeline acqNet).
      quotaTargetMrr += ownerRows.reduce(
        (s, r) => s + netContribution(r).value,
        0,
      );
      if (ownerRows.length > 0) return lineFromRows(id, ownerRows, false);
      // Task #465: no owner rows, but the opp may still be a Closed Won partner
      // opp that the compensation engine paired into a paired-opp group — the
      // SAME pairKey grouping the pipeline drilldown uses to surface partner
      // opps (e.g. a Compliance Sales / On Demand–owned waived cancel tied to
      // the owner's win via "fub: waived" / "V3 Cancel: waived"). Resolve it as
      // FOUND with the partner rows' rule/MRR metadata so the Anaplan view
      // matches the drilldown, instead of "(opp_id not found)". The Closed Won
      // gate is preserved (`all` only ever contains subsetCW rows), and quota is
      // untouched: these partner rows carry $0 owner credit (counted above as
      // ownerRows is empty), so they never inflate Quota Target MRR.
      if (
        all.length > 0 &&
        all.some((r) => r.oppId && compInfo.keyByOppId.has(r.oppId))
      )
        return lineFromRows(id, all, false);
      // Genuinely unresolved — no Closed Won row at all, or a non-paired
      // other-rep opp the drilldown wouldn't link either. Keep the existing
      // "(opp_id not found)" marker / CW gate.
      return lineFromRows(id, [], false);
    });
    const groupAMrr = numFrom(src[ANAPLAN_COL.groupAMrr]);
    const groupBMrr = numFrom(src[ANAPLAN_COL.groupBMrr]);
    const groupCMrr = numFrom(src[ANAPLAN_COL.groupCMrr]);
    // Fallback header dimensions for an opp-less CPD. When none of a CPD's
    // opportunities are "found" (no Closed Won row supplies rep/product/SLM/
    // etc.), the CPD would carry no dimensions and vanish under any active
    // header filter. Derive its dims from the CPD's own fields plus the owner's
    // entry in the rep hierarchy so the normal filters narrow it correctly:
    //   SLM     ← CPD `slm` field
    //   Rep     ← CPD `owner` field
    //   FLM     ← owner's manager in the hierarchy
    //   Region  ← owner's region in the hierarchy
    //   Segment ← owner's segment in the hierarchy
    //   Group   ← owner's channel in the hierarchy
    //   Product ← "No Product Selected" (blank-product convention)
    // Any dim that can't be resolved becomes the literal "None" so the client
    // can surface it as a selectable filter value.
    const owner = src[ANAPLAN_COL.owner] ?? "";
    const orNone = (v: string | undefined | null): string => {
      const s = (v ?? "").trim();
      return s === "" ? "None" : s;
    };
    const fallbackDims: AnaplanFallbackDims = {
      slm: orNone(src[ANAPLAN_COL.slm]),
      flm: orNone(hierarchy.repToFlm[owner]),
      rep: orNone(owner),
      region: orNone(hierarchy.repToRegion[owner]),
      segment: orNone(hierarchy.repToSegment[owner]),
      group: orNone(hierarchy.repToGroup[owner]),
      product: "No Product Selected",
    };
    return {
      cpdId: src[ANAPLAN_COL.cpdId] ?? "",
      slm: src[ANAPLAN_COL.slm] ?? "",
      owner: src[ANAPLAN_COL.owner] ?? "",
      partnerName: src[ANAPLAN_COL.partnerName] ?? "",
      compensationDate: src[ANAPLAN_COL.compensationDate] ?? "",
      source: src,
      groupAMrr,
      groupBMrr,
      groupCMrr,
      anaplanMrr: groupAMrr + groupBMrr + groupCMrr,
      quotaTargetMrr,
      opportunityIds,
      opps,
      fallbackDims,
      // Blank owner ⇒ null (never owner-filterable); otherwise membership in
      // the month-scoped effective hierarchy (reps + FLMs + SLMs, normalized).
      ownerInHierarchy: ownerKey ? hierarchyMembers.has(ownerKey) : null,
    };
  });

  // Task #529: CPD-level Conditions gate. A CPD survives iff at least one of
  // its linked opportunity ids has a matching underlying Closed Won row — and
  // a surviving CPD keeps ALL its opp rows (matching and not), so its MRR /
  // summary figures are unchanged by the filter. Opp-less CPDs (no found
  // opportunities) are hidden while conditions are active, since no opp can
  // match. Claiming above ran over the FULL CPD set, so the reverse-unmatched
  // definition ("referenced by no CPD") is independent of the conditions.
  const cpdRows: AnaplanCpdRow[] = conditionsActive
    ? allCpdRows.filter(
        (c) =>
          c.opps.some((o) => o.found) &&
          c.opportunityIds.some((id) =>
            conditionMatchedIds.has(canonicalizeOppId(id)),
          ),
      )
    : allCpdRows;

  // Reverse direction: opps carrying dashboard compensable MRR this month that
  // no Anaplan CPD references (the "opps missing CPDs" toggle on the client).
  const unmatchedByOpp = new Map<string, ParsedRow[]>();
  for (const r of subsetCW) {
    if (claimed.has(r)) continue;
    const key = r.oppId ? canonicalizeOppId(r.oppId) : "";
    if (!key) continue;
    let list = unmatchedByOpp.get(key);
    if (!list) {
      list = [];
      unmatchedByOpp.set(key, list);
    }
    list.push(r);
  }
  // Task #487: split each unmatched opp into one line PER CHANNEL, mirroring the
  // pipeline (which buckets every line item by its own rep's channel) and the
  // matched CPD path (owner-scoped). A single opp owned across channels — e.g.
  // an Acquisitions rep line plus an On Demand "Account Sales" line — must NOT
  // fold the On Demand credit into the Acquisitions total. Each channel line
  // counts only its own rows but still shows the others as context (outOfChannel
  // line items), unless a comp rule reassigns a cross-channel row's credit into
  // this channel (handled via effGroupOf honoring owner-reassignment).
  const unmatchedOpps: AnaplanOppLine[] = [];
  for (const [key, matched] of unmatchedByOpp) {
    // Task #529: with Conditions active, the "opps missing CPDs" list keeps
    // only opps whose underlying rows match the conditions.
    if (conditionsActive && !conditionMatchedIds.has(key)) continue;
    const channels = new Set<string>();
    for (const r of matched) channels.add(effGroupOf(r));
    for (const ch of channels) {
      const line = lineFromRows(key, matched, false, ch);
      if (Math.abs(line.compensableMrr) < 0.005) continue; // ignore $0 noise
      unmatchedOpps.push(line);
    }
  }

  return {
    month,
    oppWindowStart,
    oppWindowEnd,
    lastUpdate: snapshot.lastUpdate,
    fetchedAt:
      snapshot.fetchedAt == null
        ? null
        : new Date(snapshot.fetchedAt).toISOString(),
    fetchError: snapshot.fetchError,
    fetchErrorMessage: snapshot.fetchErrorMessage,
    allColumns: snapshot.columns,
    rows: cpdRows,
    unmatchedOpps,
  };
}

export type RevenueMode = "quota" | "sales";

// Map a raw pipeline row to the standardized compensation engine input.
// Shared by buildCompensationRowInputs (per-month summary endpoint) and
// buildCompensableMrrMap (per-request mode-aware MRR for the views).
export function rowToCompInput(r: ParsedRow, hierarchy: OrgHierarchy): CompRowInput {
  return {
    oppId: r.oppId,
    accountId: r.accountId,
    product: r.product,
    rawProduct: r.rawProduct,
    productFamily: r.productFamily,
    type: r.type,
    closeDate: r.closeDate,
    // Task #295: Overage opps in their raw Discovery stage are treated as Closed
    // Won here too (via effectiveFunnelStage), so the compensation engine credits
    // their accruing MRR mid-month in step with the pipeline/MRR views instead of
    // waiting for the end-of-month status flip.
    funnelStage: effectiveFunnelStage(r),
    termLength: r.termLength,
    legacyFlag: r.legacyFlag,
    flexFlipAgentStatus: r.flexFlipAgentStatus,
    // Task #347: FUB first-purchase enrichment, selectable as a comp-rule
    // condition / paired-rule identity field.
    fubFirstPurchaseDate: r.fubFirstPurchaseDate,
    group: hierarchy.repToGroup[r.rep] || "",
    segment: hierarchy.repToSegment[r.rep] || "",
    salesRole: r.salesRole,
    quoteType: r.quoteType,
    // Task #410: opportunity name, so paired-rule conditions on "Opportunity
    // Name" (contains / does not contain) evaluate against the real name rather
    // than a blank string (which made `does not contain` always pass).
    oppName: r.oppName,
    // Task #434: raw User / Opportunity Owner columns, carried independently of
    // the blended `rep` so comp conditions can test/join on each on its own.
    user: r.user,
    oppOwner: r.oppOwner,
    standardizedMrr: standardizeMrr(r),
    // Task #276: raw feeder-sheet columns + CPD-source flag, so a matching rule
    // can override the base MRR source field.
    changeInMrr: r.changeInMrr,
    totalMrr: r.totalMrr,
    splitTotalPrice: r.splitTotalPrice,
    totalPrice: r.totalPrice,
    amount: r.amount,
    mrr: r.mrr,
    isCpdSourced: isCpdSourcedRow(r),
    // Task #314: CPD change-in-MRR columns so a CPD rule's base-MRR override can
    // select them. Undefined on feeder rows.
    cpdPositiveChangeInMrr: r.cpdPositiveChangeInMrr,
    cpdNegativeChangeInMrr: r.cpdNegativeChangeInMrr,
  };
}

// Compute compensation-adjusted MRR for an arbitrary set of rows, keyed by
// row identity. Rows are grouped by close-date month so each month's own
// compensation config (multiplier rules + FUB↔Zpro rule) applies, mirroring
// the per-month semantics of the compensation summary endpoint. Rows without
// a resolvable month are omitted (callers fall back to actual MRR for those).
//
// IMPORTANT: pass a single coherent row set per call. The FUB↔Zpro pairing
// groups by (account, month) internally, so mixing the merged pipeline rows
// with the raw closed-won rows in one call would double-count a pairing.
// Call once per row set and merge the resulting maps (keys are distinct
// objects, so there are no collisions).
// Task #362: per-month guard around the compensation engine. computeCompensation
// is pure and runs once per close-date month present in the row set. The Product
// Logic "Unattributed opportunities" panel is the only UNFILTERED caller, so it
// folds in EVERY month in the feeder window at once — meaning a single month's
// config/data combination throwing (e.g. a reference-default config applied to a
// month with no saved row) would 500 the entire endpoint. This isolates each
// month: on a throw it logs the offending month + error and returns a safe
// fallback result (raw standardized MRR, no multipliers / pairing / overrides)
// so that month degrades gracefully while every other month stays intact.
function safeComputeCompensation(
  inputs: CompRowInput[],
  config: CompensationConfig,
  month: string,
): CompensationResult {
  try {
    return computeCompensation(inputs, config);
  } catch (e) {
    console.error(
      `[Compensation] computeCompensation failed for month ${month}; ` +
        `degrading to raw MRR for that month: ${(e as Error).message}`,
    );
    const n = inputs.length;
    const byProduct: Record<string, { actual: number; compensable: number }> = {};
    let totalActual = 0;
    const compensable = inputs.map((r) => {
      const v = r.standardizedMrr;
      totalActual += v;
      const p = r.product || "(blank)";
      const bucket = byProduct[p] ?? (byProduct[p] = { actual: 0, compensable: 0 });
      bucket.actual += v;
      bucket.compensable += v;
      return v;
    });
    return {
      compensable,
      multipliers: new Array<number>(n).fill(1),
      appliedRules: Array.from({ length: n }, () => []),
      pairRuleId: new Array<string | null>(n).fill(null),
      pairRuleLabel: new Array<string | null>(n).fill(null),
      pairKey: new Array<string | null>(n).fill(null),
      pairOppName: new Array<string | null>(n).fill(null),
      pairAdjustmentLabel: new Array<string | null>(n).fill(null),
      churnSuppressed: new Array<boolean>(n).fill(false),
      acqChurnIgnored: new Array<boolean>(n).fill(false),
      ownerReassignedTo: new Array<string | null>(n).fill(null),
      pairSummaries: [],
      appliedMrrField: new Array<MrrField | null>(n).fill(null),
      mrrFieldRuleLabel: new Array<string | null>(n).fill(null),
      mrrFieldRuleLabels: Array.from({ length: n }, () => []),
      totalActual,
      totalCompensable: totalActual,
      byProduct,
    };
  }
}

async function buildCompensableMrrMap(
  subset: ParsedRow[],
  hierarchy: OrgHierarchy,
  mode: RevenueMode = "quota",
): Promise<{
  mrrByRow: Map<ParsedRow, number>;
  // Rows flagged by an "Ignore ACQ Churn Logic" adjustment to bypass the
  // global ACQ same-month churn gate.
  acqChurnIgnoredRows: Set<ParsedRow>;
}> {
  const byMonth = new Map<string, ParsedRow[]>();
  for (const r of subset) {
    const mk = compMonthKey(r.closeDate);
    if (!mk) continue;
    let list = byMonth.get(mk);
    if (!list) {
      list = [];
      byMonth.set(mk, list);
    }
    list.push(r);
  }
  const out = new Map<ParsedRow, number>();
  const acqChurnIgnoredRows = new Set<ParsedRow>();
  await Promise.all(
    Array.from(byMonth.entries()).map(async ([mk, monthRows]) => {
      const config = filterConfigForMode(await getCompensationConfig(mk), mode);
      const inputs = monthRows.map((r) => rowToCompInput(r, hierarchy));
      // Task #362: same per-month isolation as buildCompensableOppInfo — one
      // bad month degrades to raw MRR rather than failing the whole map.
      const result = safeComputeCompensation(inputs, config, mk);
      monthRows.forEach((r, i) => {
        out.set(r, result.compensable[i]);
        if (result.acqChurnIgnored[i]) acqChurnIgnoredRows.add(r);
      });
    }),
  );
  return { mrrByRow: out, acqChurnIgnoredRows };
}

// ── Rule-affected flagging (drilldown ↔ export parity) ──────────────────────
// Tasks #402/#403 fixed a divergence where the on-screen drilldown and the CSV
// export disagreed about which opps a FIRED paired rule (e.g. FUB→Zpro) affects.
// Both surfaces must flag EVERY fired-pair Match member, not only the
// adjustment's target opp. The two builders intentionally stay separate (the
// drilldown also drives multiplier display), so the per-row flag derivation is
// factored into these two pure helpers and exercised by a parity test
// (compensation.test.ts). If you change one's pair-flagging, change the other —
// the test asserts the set of opps each flags for a paired rule is identical.

// Drilldown per-row flagging: returns the rule labels shown in the drilldown's
// "Rules" cell plus the multiplier list. A paired override row (its value WAS
// changed by an adjustment) counts as one named pairing rule, not a plain
// multiplier, so its multipliers are blank. Otherwise the row's own multiplier
// rules show, with the pair label prepended when this row is a non-target
// member of a fired pair.
export function ruleAffectmentForDrilldown(
  result: CompensationResult,
  i: number,
): { ruleNames: string[]; multipliers: number[] } {
  const applied = result.appliedRules[i];
  const pairLabel = result.pairRuleLabel[i];
  if (
    pairLabel &&
    result.multipliers[i] !== 1 &&
    applied.length === 1 &&
    applied[0].id === result.pairRuleId[i]
  ) {
    return { ruleNames: [pairLabel], multipliers: [] };
  }
  const names = applied.map((a) => a.label);
  if (pairLabel && !names.includes(pairLabel)) names.unshift(pairLabel);
  return { ruleNames: names, multipliers: applied.map((a) => a.multiplier) };
}

// Export per-line-item flagging: returns the rule names/ids carried by the
// CSV export plus the `matched` flag. A non-null `pairRuleLabel` means the row
// is a Match-opp member of a FIRED pair (the engine sets it only for fired
// pairs), so prepend it when `appliedRules` doesn't already carry the pair
// (e.g. the zpro partner whose value was not overridden).
export function ruleAffectmentForExport(
  result: CompensationResult,
  i: number,
): { ruleNames: string[]; ruleIds: string[]; matched: boolean } {
  const applied = result.appliedRules[i];
  const ruleNames = applied.map((a) => a.label);
  const ruleIds = applied.map((a) => a.id);
  const pairLabel = result.pairRuleLabel[i];
  const pairId = result.pairRuleId[i];
  if (pairLabel && pairId && !ruleIds.includes(pairId)) {
    ruleNames.unshift(pairLabel);
    ruleIds.unshift(pairId);
  }
  return { ruleNames, ruleIds, matched: ruleIds.length > 0 };
}

// Like buildCompensableMrrMap, but also returns the FUB↔Zpro pairing role/key
// per opportunity id (derived from the engine's emitted pairs) so opportunity
// drilldowns can render the linked pair. Used by the opp-list endpoints when in
// Compensable Revenue mode.
export async function buildCompensableOppInfo(
  subset: ParsedRow[],
  hierarchy: OrgHierarchy,
  mode: RevenueMode = "quota",
): Promise<CompOppInfo> {
  const byMonth = new Map<string, ParsedRow[]>();
  for (const r of subset) {
    const mk = compMonthKey(r.closeDate);
    if (!mk) continue;
    let list = byMonth.get(mk);
    if (!list) {
      list = [];
      byMonth.set(mk, list);
    }
    list.push(r);
  }
  const mrrByRow = new Map<ParsedRow, number>();
  const oppNameByOppId = new Map<string, string>();
  const keyByOppId = new Map<string, string>();
  const ruleLabelByOppId = new Map<string, string>();
  const multipliersByRow = new Map<ParsedRow, number[]>();
  const ruleNamesByRow = new Map<ParsedRow, string[]>();
  const pairAdjLabelByRow = new Map<ParsedRow, string>();
  const churnSuppressedByRow = new Map<ParsedRow, boolean>();
  const ownerReassignedByRow = new Map<ParsedRow, string>();
  const mrrFieldByRow = new Map<ParsedRow, MrrField>();
  const mrrFieldRuleLabelsByRow = new Map<ParsedRow, string[]>();
  const mrrFieldWinnerByRow = new Map<ParsedRow, string>();
  const acqChurnIgnoredRows = new Set<ParsedRow>();
  await Promise.all(
    Array.from(byMonth.entries()).map(async ([mk, monthRows]) => {
      const config = filterConfigForMode(await getCompensationConfig(mk), mode);
      const inputs = monthRows.map((r) => rowToCompInput(r, hierarchy));
      // Task #362: a malformed or fallback (reference-default) comp config for a
      // single month must not 500 the whole opportunities endpoint — this is the
      // only UNFILTERED caller, so it runs computeCompensation once per month
      // present in the feeder window. Isolate each month: if the engine throws
      // for one month, log it (with the month + error) and degrade THAT month to
      // raw standardized MRR (no multipliers / pairing), leaving every other
      // month intact, instead of letting the throw bubble up to a 500.
      const result = safeComputeCompensation(inputs, config, mk);
      monthRows.forEach((r, i) => {
        mrrByRow.set(r, result.compensable[i]);
        if (result.acqChurnIgnored[i]) acqChurnIgnoredRows.add(r);
        // Task #276: effective base MRR field (override ?? Type default) +
        // which rule(s) drove it, so the drilldown can always show the source.
        mrrFieldByRow.set(
          r,
          result.appliedMrrField[i] ?? appliedBaseMrrFieldForRow(r),
        );
        const fieldLabels = result.mrrFieldRuleLabels[i];
        if (fieldLabels && fieldLabels.length)
          mrrFieldRuleLabelsByRow.set(r, fieldLabels);
        const fieldWinner = result.mrrFieldRuleLabel[i];
        if (fieldWinner) mrrFieldWinnerByRow.set(r, fieldWinner);
        // Task #317: generic paired-opp metadata. A paired override row counts
        // as one named pairing rule, not a plain multiplier, so leave
        // multipliersByRow empty and surface the adjustment label instead.
        const pairLabel = result.pairRuleLabel[i];
        const oppName = result.pairOppName[i];
        const pKey = result.pairKey[i];
        if (pairLabel && oppName && pKey) {
          if (r.oppId) {
            oppNameByOppId.set(r.oppId, oppName);
            keyByOppId.set(r.oppId, pKey);
            ruleLabelByOppId.set(r.oppId, pairLabel);
          }
          const adjLabel = result.pairAdjustmentLabel[i];
          if (adjLabel) pairAdjLabelByRow.set(r, adjLabel);
          if (result.churnSuppressed[i]) churnSuppressedByRow.set(r, true);
          const reassigned = result.ownerReassignedTo[i];
          if (reassigned) ownerReassignedByRow.set(r, reassigned);
        }
        // The Rules / Multipliers cells. Task #402: every opp participating in a
        // FIRED paired rule must be flagged as affected by that rule in the
        // drilldown — not only the adjustment's target opp — so "Filter by
        // rule", the RULES count, and the rule facet counts all include it.
        // Derivation lives in the shared `ruleAffectmentForDrilldown` helper,
        // kept in lockstep with the export's `ruleAffectmentForExport` (parity
        // guarded by compensation.test.ts).
        const { ruleNames, multipliers } = ruleAffectmentForDrilldown(result, i);
        ruleNamesByRow.set(r, ruleNames);
        multipliersByRow.set(r, multipliers);
      });
    }),
  );
  return {
    mrrByRow,
    oppNameByOppId,
    keyByOppId,
    ruleLabelByOppId,
    multipliersByRow,
    ruleNamesByRow,
    pairAdjLabelByRow,
    churnSuppressedByRow,
    ownerReassignedByRow,
    mrrFieldByRow,
    mrrFieldRuleLabelsByRow,
    mrrFieldWinnerByRow,
    acqChurnIgnoredRows,
  };
}

type PipelineResult = Awaited<ReturnType<typeof computePipelineData>>;

// Task #428: computed pipeline-result cache. Toggling Sales <-> Quota mode (and
// any unchanged re-query) used to re-run merge / comp-map / two ~8k-row
// aggregation loops every time, because only the RAW sheet rows were cached.
// We now cache the fully computed result keyed by every input that affects it
// plus the data-version stamp (bumped whenever any contributing cache clears or
// refreshes — see cache-version.ts), so a result is only ever served while all
// underlying inputs are unchanged. Snapshot/replay contexts bypass the cache.
interface PipelineCacheEntry {
  version: number;
  storedAt: number;
  result: PipelineResult;
}
const pipelineResultCache = new Map<string, PipelineCacheEntry>();
const pipelineResultPending = new Map<string, Promise<PipelineResult>>();
const PIPELINE_CACHE_MAX = 64;
// The computed result is invalidated by the data-version stamp whenever a
// contributing cache clears/refreshes, but those bumps only fire when the
// underlying fetchers actually run. If pipeline requests keep hitting this
// computed cache, TTL-based fetchers like fetchRows never execute, so the
// version never advances and a stale result could be served indefinitely past
// the raw-data TTL. We therefore also expire computed entries on the SAME
// 30-min TTL as the raw cache: once expired, the recompute re-runs fetchRows,
// which re-validates its own TTL and bumps the version if the source changed.
const PIPELINE_RESULT_TTL_MS = CACHE_TTL_MS;

function isPipelineEntryFresh(
  entry: PipelineCacheEntry | undefined,
  version: number,
): entry is PipelineCacheEntry {
  return (
    entry !== undefined &&
    entry.version === version &&
    Date.now() - entry.storedAt < PIPELINE_RESULT_TTL_MS
  );
}

function pipelineCacheKey(
  dateFilter: { from?: string; to?: string } | undefined,
  pipelineMode: "closeDate" | "allOpen",
  modsDateFilter: { from?: string; to?: string } | undefined,
  revenueMode: RevenueMode,
  rawConditions: RawCondition[] | undefined,
  eRepOverride: boolean,
): string {
  // Stable, collision-free serialization: every distinct combination maps to a
  // distinct string. rawConditions order is preserved (resolveRawConditions
  // sanitizes deterministically); we JSON-encode to keep field/value separators
  // unambiguous. Task #484: the eReps-override flag is part of the key so the
  // override view never serves the standard cached numbers (and vice versa).
  return JSON.stringify({
    f: dateFilter?.from ?? null,
    t: dateFilter?.to ?? null,
    m: pipelineMode,
    mf: modsDateFilter?.from ?? null,
    mt: modsDateFilter?.to ?? null,
    rm: revenueMode,
    rc: rawConditions && rawConditions.length > 0 ? rawConditions : null,
    er: eRepOverride,
    // Demo mode only: the computed result folds in DB-backed overrides, which
    // are per-session (uncommitted) for a demo user. Empty string outside a
    // demo session, so live keys are unchanged.
    ds: dbScopeKey() || null,
  });
}

export async function getLivePipelineData(
  dateFilter?: { from?: string; to?: string },
  pipelineMode: "closeDate" | "allOpen" = "closeDate",
  modsDateFilter?: { from?: string; to?: string },
  revenueMode: RevenueMode = "quota",
  rawConditions?: RawCondition[],
  eRepOverride = false,
): Promise<PipelineResult> {
  // Snapshot capture / historical replay must never read or write the live
  // result cache — they run against pinned data and would otherwise pollute or
  // be polluted by live entries.
  if (snapshotCtxActive() || isReplayActive()) {
    return computePipelineData(
      dateFilter,
      pipelineMode,
      modsDateFilter,
      revenueMode,
      rawConditions,
      eRepOverride,
    );
  }

  const key = pipelineCacheKey(
    dateFilter,
    pipelineMode,
    modsDateFilter,
    revenueMode,
    rawConditions,
    eRepOverride,
  );
  const hit = pipelineResultCache.get(key);
  if (isPipelineEntryFresh(hit, getDataVersion())) return hit.result;

  // Collapse concurrent identical requests (incl. a real request racing the
  // sibling-mode warm) onto a single in-flight computation.
  const inflight = pipelineResultPending.get(key);
  if (inflight) return inflight;

  const run = (async () => {
    try {
      // Capture the version BEFORE compute. computePipelineData reads its inputs
      // (raw rows, comp config, etc.) at this version; if a contributing cache
      // refreshes mid-compute the version advances and the result we produced is
      // a mix of stale + fresh inputs — never store it under the new version
      // (that would mislabel stale data as current). storePipelineResult only
      // persists when the version is unchanged across the compute.
      const startVersion = getDataVersion();
      const result = await computePipelineData(
        dateFilter,
        pipelineMode,
        modsDateFilter,
        revenueMode,
        rawConditions,
        eRepOverride,
      );
      storePipelineResult(key, startVersion, result);
      return result;
    } finally {
      pipelineResultPending.delete(key);
    }
  })();
  pipelineResultPending.set(key, run);

  const result = await run;
  // Warm the sibling revenue mode in the background so the first toggle is also
  // instant. Best-effort: never blocks this response and never surfaces errors.
  // The eReps-override flag carries through so the warm matches the active view.
  warmSiblingMode(
    dateFilter,
    pipelineMode,
    modsDateFilter,
    revenueMode,
    rawConditions,
    eRepOverride,
  );
  return result;
}

function storePipelineResult(
  key: string,
  startVersion: number,
  result: PipelineResult,
): void {
  // Version-safe write: only persist if no contributing cache refreshed during
  // the compute. If the version advanced, the result was computed from inputs
  // that are now stale, so dropping it forces the next request to recompute
  // against the fresh data rather than serving a mislabeled-current result.
  if (getDataVersion() !== startVersion) return;
  pipelineResultCache.set(key, {
    version: startVersion,
    storedAt: Date.now(),
    result,
  });
  // Bound the cache: drop entries from a stale version first, then oldest-
  // inserted, so it can't grow without limit across many filter combinations.
  if (pipelineResultCache.size > PIPELINE_CACHE_MAX) {
    for (const [k, v] of pipelineResultCache) {
      if (v.version !== startVersion) pipelineResultCache.delete(k);
      if (pipelineResultCache.size <= PIPELINE_CACHE_MAX) break;
    }
    while (pipelineResultCache.size > PIPELINE_CACHE_MAX) {
      const oldest = pipelineResultCache.keys().next().value;
      if (oldest === undefined) break;
      pipelineResultCache.delete(oldest);
    }
  }
}

// Fire-and-forget warm of the opposite revenue mode for the same filters. Any
// failure is swallowed — warming must never affect the in-flight response or
// produce a user-facing error.
function warmSiblingMode(
  dateFilter: { from?: string; to?: string } | undefined,
  pipelineMode: "closeDate" | "allOpen",
  modsDateFilter: { from?: string; to?: string } | undefined,
  revenueMode: RevenueMode,
  rawConditions: RawCondition[] | undefined,
  eRepOverride: boolean,
): void {
  const sibling: RevenueMode = revenueMode === "sales" ? "quota" : "sales";
  const key = pipelineCacheKey(
    dateFilter,
    pipelineMode,
    modsDateFilter,
    sibling,
    rawConditions,
    eRepOverride,
  );
  const hit = pipelineResultCache.get(key);
  if (isPipelineEntryFresh(hit, getDataVersion())) return;
  if (pipelineResultPending.has(key)) return;

  const run = (async () => {
    try {
      const startVersion = getDataVersion();
      const result = await computePipelineData(
        dateFilter,
        pipelineMode,
        modsDateFilter,
        sibling,
        rawConditions,
        eRepOverride,
      );
      storePipelineResult(key, startVersion, result);
      return result;
    } finally {
      pipelineResultPending.delete(key);
    }
  })();
  pipelineResultPending.set(key, run);
  run.catch(() => {
    /* best-effort warm; ignore failures */
  });
}

async function computePipelineData(
  dateFilter?: { from?: string; to?: string },
  pipelineMode: "closeDate" | "allOpen" = "closeDate",
  modsDateFilter?: { from?: string; to?: string },
  revenueMode: RevenueMode = "quota",
  rawConditions?: RawCondition[],
  eRepOverride = false,
) {
  const effectiveModsFilter = modsDateFilter ?? dateFilter;
  const [allRows, hierarchy, probOverrides, stageDefaults] = await Promise.all([
    fetchRows(),
    fetchEffectiveHierarchy(monthFromFilter(dateFilter)),
    getOppProbabilityOverrides(),
    getStageDefaultProbabilities(),
  ]);
  // Side-effect: materialize $0 Manager Estimate rows for the current
  // month for every (FLM × product) pair in scope. Idempotent. Done before
  // the read so the matrix is always populated. Uses the UNFILTERED rows so
  // the ME matrix stays complete regardless of any admin Conditions filter.
  const currentProducts = Array.from(
    new Set(allRows.map((r) => r.product).filter(Boolean) as string[]),
  );
  const currentFlms = Array.from(
    new Set(
      Object.values(hierarchy.repToFlm || {}).filter(Boolean) as string[],
    ),
  );
  if (currentFlms.length > 0 && currentProducts.length > 0) {
    const pairs: Array<{ flm: string; product: string }> = [];
    for (const flm of currentFlms)
      for (const product of currentProducts) pairs.push({ flm, product });
    await ensureCurrentMonthRows(pairs);
  }

  // Task #361: apply the admin Conditions filter to the raw rows BEFORE any
  // aggregation so every derived number reflects it. The ME side-effect above
  // intentionally ran on the unfiltered set.
  const rows = filterRowsByRawConditions(allRows, rawConditions, hierarchy);

  const modsByRep = await fetchModsByRep(
    effectiveModsFilter,
    probOverrides,
    stageDefaults,
    hierarchy,
    rawConditions,
  );

  const closedStages = new Set(["Closed Won", "Closed Lost"]);
  const activeStages = new Set([
    "Discovery",
    "Demo Scheduled",
    "Proposal/Negotiation",
    "Paperwork Sent",
    "Awaiting Payment",
  ]);

  let pipelineRows: ParsedRow[];
  if (pipelineMode === "closeDate") {
    pipelineRows = applyDateFilter(rows, dateFilter);
  } else {
    const toDate = dateFilter?.to
      ? new Date(dateFilter.to + "T23:59:59")
      : null;
    pipelineRows = rows.filter((r) => {
      const cd = effectiveCloseDate(r);
      if (!cd) return false;
      const funnelStage = effectiveFunnelStage(r);
      if (closedStages.has(funnelStage)) {
        if (!dateFilter?.from && !dateFilter?.to) return true;
        const fromDate = dateFilter.from
          ? new Date(dateFilter.from + "T00:00:00")
          : null;
        if (fromDate && cd < fromDate) return false;
        if (toDate && cd > toDate) return false;
        return true;
      }
      if (toDate && cd > toDate) return false;
      return true;
    });
  }

  // Task #220: Follow Up Boss "Amend Subscription" Closed-Won opportunities
  // carry paired +/- line items under a single oppId (cancel old plan, add new
  // plan) that net to the true monthly MRR change for that opp. The row-level
  // sign gating in the build loop below classifies each line item on its own
  // sign (positive rows -> MRR Added, |negative rows| -> Churn), which grosses
  // these opps up ~58x vs. the opp-level net that the pipeline drilldown shows
  // (it dedupes by oppId first). Collapse rows per opportunity (net-preserving)
  // so Added / Churn / AcqNet are computed per opportunity — see
  // mergePipelineRowsByOpp, shared with the opportunity-detail endpoint.
  pipelineRows = mergePipelineRowsByOpp(pipelineRows);

  // Task #241: Revenue Mode. Both modes ("quota" / "sales") are now
  // compensation-adjusted: the per-month multiplier engine + paired-opp netting
  // runs with the rules scoped to the active mode (see filterConfigForMode), and
  // the resulting MRR replaces actual MRR everywhere a row's MRR is read below.
  // `mrrOf` falls back to the actual standardized MRR for any row not covered by
  // the map (no resolvable month). A mode with no applicable rules yields raw
  // MRR (multiplier 1). The map is built per coherent row set
  // (merged pipeline rows here; raw closed-won rows for the proration buckets
  // are added later) to keep FUB↔Zpro pairing correct — see buildCompensableMrrMap.
  const { mrrByRow: compMrrByRow, acqChurnIgnoredRows } =
    await buildCompensableMrrMap(pipelineRows, hierarchy, revenueMode);
  const mrrOf = (r: ParsedRow): number =>
    compMrrByRow
      ? (compMrrByRow.get(r) ?? standardizeMrr(r))
      : standardizeMrr(r);
  // Task #563: an "Ignore ACQ Churn Logic" paired-rule adjustment flags a row
  // to bypass the ACQ same-month churn gate — its churn counts as if paired.
  // Task #566: "Amend Subscription" quote-type churn is always exempt from the
  // gate — its churn counts even when unpaired (after FUB +/- netting).
  const acqGateBypassed = (r: ParsedRow): boolean =>
    acqChurnIgnoredRows.has(r) || isAmendSubscriptionQuoteType(r.quoteType);

  const repMap: Record<
    string,
    {
      name: string;
      manager: string;
      funnel: Record<string, number>;
      funnelAdded: Record<string, number>;
      funnelAcqNet: Record<string, number>;
      totalMrr: number;
      totalMrrAdded: number;
      totalMrrAcqNet: number;
      totalChurn: number;
      totalAcqChurn: number;
      productChurn: Record<string, number>;
      acqProductChurn: Record<string, number>;
      products: Record<string, number>;
      productsAdded: Record<string, number>;
      productsAcqNet: Record<string, number>;
      productFunnel: Record<string, Record<string, number>>;
      productFunnelAdded: Record<string, Record<string, number>>;
      productFunnelAcqNet: Record<string, Record<string, number>>;
      weightedFunnel: Record<string, number>;
      weightedProductFunnel: Record<string, Record<string, number>>;
      weightedClosedWonAdded: number;
      weightedClosedWonAcqNet: number;
      weightedProductClosedWonAdded: Record<string, number>;
      weightedProductClosedWonAcqNet: Record<string, number>;
      funnelProbSum: Record<string, number>;
      productFunnelProbSum: Record<string, Record<string, number>>;
      funnelProbSeen: Record<string, Set<string>>;
      productFunnelProbSeen: Record<string, Record<string, Set<string>>>;
      funnelOppIds: Record<string, Set<string>>;
      productFunnelOppIds: Record<string, Record<string, Set<string>>>;
      funnelOppIdsAdded: Record<string, Set<string>>;
      productFunnelOppIdsAdded: Record<string, Record<string, Set<string>>>;
      closedWonOppIdsAdded: Set<string>;
      closedWonOppIdsAcqNet: Set<string>;
      productClosedWonOppIdsAdded: Record<string, Set<string>>;
      productClosedWonOppIdsAcqNet: Record<string, Set<string>>;
    }
  > = {};

  const initRep = (repName: string, manager: string) => {
    if (!repMap[repName]) {
      repMap[repName] = {
        name: repName,
        manager,
        funnel: {},
        funnelAdded: {},
        funnelAcqNet: {},
        totalMrr: 0,
        totalMrrAdded: 0,
        totalMrrAcqNet: 0,
        totalChurn: 0,
        totalAcqChurn: 0,
        productChurn: {},
        acqProductChurn: {},
        products: {},
        productsAdded: {},
        productsAcqNet: {},
        productFunnel: {},
        productFunnelAdded: {},
        productFunnelAcqNet: {},
        weightedFunnel: {},
        weightedProductFunnel: {},
        weightedClosedWonAdded: 0,
        weightedClosedWonAcqNet: 0,
        weightedProductClosedWonAdded: {},
        weightedProductClosedWonAcqNet: {},
        funnelProbSum: {},
        productFunnelProbSum: {},
        funnelProbSeen: {},
        productFunnelProbSeen: {},
        funnelOppIds: {},
        productFunnelOppIds: {},
        funnelOppIdsAdded: {},
        productFunnelOppIdsAdded: {},
        closedWonOppIdsAdded: new Set(),
        closedWonOppIdsAcqNet: new Set(),
        productClosedWonOppIdsAdded: {},
        productClosedWonOppIdsAcqNet: {},
      };
    }
  };

  const positiveClosedWonKeys = new Set<string>();
  for (const r of pipelineRows) {
    if (!hierarchy.allReps.has(r.rep) && !hierarchy.repToFlm[r.rep]) continue;
    const stdMrr = mrrOf(r);
    if (stdMrr > 0 && effectiveFunnelStage(r) === "Closed Won") {
      const acqKey = `${r.rep}||${r.accountId}||${r.product || "No Product Selected"}`;
      positiveClosedWonKeys.add(acqKey);
    }
  }
  for (const r of pipelineRows) {
    if (!hierarchy.allReps.has(r.rep) && !hierarchy.repToFlm[r.rep]) continue;

    initRep(r.rep, r.manager);
    const rep = repMap[r.rep];

    const stdMrrVal = mrrOf(r);
    // Churn only counts once it has actually processed: the churn opp's own
    // effective stage must be Closed Won (mirrors the MRR card's CW gate).
    // effectiveFunnelStage (not raw stage) preserves reclassified Overage.
    if (stdMrrVal < 0 && effectiveFunnelStage(r) === "Closed Won") {
      const churnAmt = Math.abs(stdMrrVal);
      rep.totalChurn += churnAmt;
      const churnProd = r.product || "No Product Selected";
      rep.productChurn[churnProd] =
        (rep.productChurn[churnProd] || 0) + churnAmt;

      const acqKey = `${r.rep}||${r.accountId}||${churnProd}`;
      if (positiveClosedWonKeys.has(acqKey) || acqGateBypassed(r)) {
        rep.totalAcqChurn += churnAmt;
        rep.acqProductChurn[churnProd] =
          (rep.acqProductChurn[churnProd] || 0) + churnAmt;
      }
    }

    const stdMrr = stdMrrVal;
    const funnelStage = effectiveFunnelStage(r);

    rep.funnel[funnelStage] = (rep.funnel[funnelStage] || 0) + stdMrr;
    rep.totalMrr += stdMrr;

    const prod = r.product || "No Product Selected";
    rep.products[prod] = (rep.products[prod] || 0) + stdMrr;
    if (!rep.productFunnel[prod]) rep.productFunnel[prod] = {};
    rep.productFunnel[prod][funnelStage] =
      (rep.productFunnel[prod][funnelStage] || 0) + stdMrr;

    const oppKey = r.oppId
      ? r.oppId
      : `__noid__${r.rep}||${r.accountId || ""}||${r.oppName || ""}||${r.product || ""}||${r.closeDate || ""}`;
    if (!rep.funnelOppIds[funnelStage])
      rep.funnelOppIds[funnelStage] = new Set();
    rep.funnelOppIds[funnelStage].add(oppKey);
    if (!rep.productFunnelOppIds[prod]) rep.productFunnelOppIds[prod] = {};
    if (!rep.productFunnelOppIds[prod][funnelStage])
      rep.productFunnelOppIds[prod][funnelStage] = new Set();
    rep.productFunnelOppIds[prod][funnelStage].add(oppKey);

    if (funnelStage === "Closed Won") {
      const cwAcqKey = `${r.rep}||${r.accountId}||${prod}`;
      const ensureProdSet = (
        bag: Record<string, Set<string>>,
        key: string,
      ): Set<string> => {
        if (!bag[key]) bag[key] = new Set();
        return bag[key];
      };
      if (stdMrr > 0) {
        rep.closedWonOppIdsAdded.add(oppKey);
        ensureProdSet(rep.productClosedWonOppIdsAdded, prod).add(oppKey);
      }
      const acqInclude =
        stdMrr >= 0 ||
        (stdMrr < 0 &&
          (positiveClosedWonKeys.has(cwAcqKey) || acqGateBypassed(r)));
      if (acqInclude) {
        rep.closedWonOppIdsAcqNet.add(oppKey);
        ensureProdSet(rep.productClosedWonOppIdsAcqNet, prod).add(oppKey);
      }
    }

    const effProb =
      r.oppId && probOverrides[r.oppId] !== undefined
        ? probOverrides[r.oppId]
        : (stageDefaults[funnelStage] ?? 0);
    const weightedMrr = (stdMrr * effProb) / 100;

    if (stdMrr > 0) {
      rep.funnelAdded[funnelStage] =
        (rep.funnelAdded[funnelStage] || 0) + stdMrr;
      rep.totalMrrAdded += stdMrr;
      rep.productsAdded[prod] = (rep.productsAdded[prod] || 0) + stdMrr;
      if (!rep.productFunnelAdded[prod]) rep.productFunnelAdded[prod] = {};
      rep.productFunnelAdded[prod][funnelStage] =
        (rep.productFunnelAdded[prod][funnelStage] || 0) + stdMrr;

      // Task #476: positives-only distinct opp ids per (stage) and
      // (product, stage), so the Pipeline Funnel's Gross view can show
      // accurate opp counts that exclude negative-MRR opps in every stage.
      if (!rep.funnelOppIdsAdded[funnelStage])
        rep.funnelOppIdsAdded[funnelStage] = new Set();
      rep.funnelOppIdsAdded[funnelStage].add(oppKey);
      if (!rep.productFunnelOppIdsAdded[prod])
        rep.productFunnelOppIdsAdded[prod] = {};
      if (!rep.productFunnelOppIdsAdded[prod][funnelStage])
        rep.productFunnelOppIdsAdded[prod][funnelStage] = new Set();
      rep.productFunnelOppIdsAdded[prod][funnelStage].add(oppKey);

      rep.funnelAcqNet[funnelStage] =
        (rep.funnelAcqNet[funnelStage] || 0) + stdMrr;
      rep.totalMrrAcqNet += stdMrr;
      rep.productsAcqNet[prod] = (rep.productsAcqNet[prod] || 0) + stdMrr;
      if (!rep.productFunnelAcqNet[prod]) rep.productFunnelAcqNet[prod] = {};
      rep.productFunnelAcqNet[prod][funnelStage] =
        (rep.productFunnelAcqNet[prod][funnelStage] || 0) + stdMrr;

      // Mode-aware weighted Closed Won: positives contribute to both Added
      // and AcqNet weighted sums, mirroring the unweighted funnel logic above.
      if (funnelStage === "Closed Won") {
        rep.weightedClosedWonAdded += weightedMrr;
        rep.weightedProductClosedWonAdded[prod] =
          (rep.weightedProductClosedWonAdded[prod] || 0) + weightedMrr;
        rep.weightedClosedWonAcqNet += weightedMrr;
        rep.weightedProductClosedWonAcqNet[prod] =
          (rep.weightedProductClosedWonAcqNet[prod] || 0) + weightedMrr;
      }
    } else if (stdMrr < 0 && funnelStage === "Closed Won") {
      // ACQ-net churn requires the churn opp's own stage be Closed Won, in
      // addition to the paired positive Closed Won key below (or an "Ignore
      // ACQ Churn Logic" bypass flag).
      const acqKey = `${r.rep}||${r.accountId}||${prod}`;
      if (positiveClosedWonKeys.has(acqKey) || acqGateBypassed(r)) {
        rep.funnelAcqNet[funnelStage] =
          (rep.funnelAcqNet[funnelStage] || 0) + stdMrr;
        rep.totalMrrAcqNet += stdMrr;
        rep.productsAcqNet[prod] = (rep.productsAcqNet[prod] || 0) + stdMrr;
        if (!rep.productFunnelAcqNet[prod]) rep.productFunnelAcqNet[prod] = {};
        rep.productFunnelAcqNet[prod][funnelStage] =
          (rep.productFunnelAcqNet[prod][funnelStage] || 0) + stdMrr;

        // Matched churn against a positive CW: included in AcqNet weighted CW.
        if (funnelStage === "Closed Won") {
          rep.weightedClosedWonAcqNet += weightedMrr;
          rep.weightedProductClosedWonAcqNet[prod] =
            (rep.weightedProductClosedWonAcqNet[prod] || 0) + weightedMrr;
        }
      }
    }

    if (activeStages.has(funnelStage) || funnelStage === "Closed Won") {
      rep.weightedFunnel[funnelStage] =
        (rep.weightedFunnel[funnelStage] || 0) + weightedMrr;
      if (!rep.weightedProductFunnel[prod])
        rep.weightedProductFunnel[prod] = {};
      rep.weightedProductFunnel[prod][funnelStage] =
        (rep.weightedProductFunnel[prod][funnelStage] || 0) + weightedMrr;
    }
    if (!rep.funnelProbSeen[funnelStage])
      rep.funnelProbSeen[funnelStage] = new Set();
    if (!rep.funnelProbSeen[funnelStage].has(oppKey)) {
      rep.funnelProbSeen[funnelStage].add(oppKey);
      rep.funnelProbSum[funnelStage] =
        (rep.funnelProbSum[funnelStage] || 0) + effProb;
    }
    if (!rep.productFunnelProbSeen[prod]) rep.productFunnelProbSeen[prod] = {};
    if (!rep.productFunnelProbSeen[prod][funnelStage])
      rep.productFunnelProbSeen[prod][funnelStage] = new Set();
    if (!rep.productFunnelProbSeen[prod][funnelStage].has(oppKey)) {
      rep.productFunnelProbSeen[prod][funnelStage].add(oppKey);
      if (!rep.productFunnelProbSum[prod]) rep.productFunnelProbSum[prod] = {};
      rep.productFunnelProbSum[prod][funnelStage] =
        (rep.productFunnelProbSum[prod][funnelStage] || 0) + effProb;
    }
  }

  const employeeIdToName: Record<string, string> = {};
  for (const [name, empId] of Object.entries(hierarchy.personToEmployeeId)) {
    if (empId) employeeIdToName[empId] = name;
  }
  const quotasByMonth = await getDashboardQuotas(
    employeeIdToName,
    hierarchy.repToGroup,
    eRepOverride,
  );
  const filterMonth = dateFilter?.from
    ? dateFilter.from.slice(0, 7)
    : currentDate().toISOString().slice(0, 7);
  const currentMonth = currentDate().toISOString().slice(0, 7);
  // When the upstream quota fetch failed/timed out, surface zeros for all reps
  // rather than potentially-stale cached values. The frontend shows a warning
  // next to the refresh button so the user knows the values are unavailable.
  const quotas = quotasByMonth.fetchError
    ? {}
    : filterMonth === currentMonth
      ? quotasByMonth.current
      : quotasByMonth.lastMonth;
  // Task #165: expose both current-month and last-month per-rep quotas so
  // the per-month proration table can show each month's own M GOAL instead
  // of bleeding the loaded snapshot's value across all month rows.
  const lastMonthYm = (() => {
    const d = currentDate();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 7);
  })();

  const nowDate = currentDate();
  const currentMonthYm = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, "0")}`;
  const currentQuotas = quotasByMonth.fetchError ? {} : quotasByMonth.current;
  const lastMonthQuotas = quotasByMonth.fetchError
    ? {}
    : quotasByMonth.lastMonth;

  for (const repName of hierarchy.allReps) {
    if (!repMap[repName]) {
      const mgr = hierarchy.repToFlm[repName] || "";
      repMap[repName] = {
        name: repName,
        manager: mgr,
        funnel: {},
        funnelAdded: {},
        funnelAcqNet: {},
        totalMrr: 0,
        totalMrrAdded: 0,
        totalMrrAcqNet: 0,
        totalChurn: 0,
        totalAcqChurn: 0,
        productChurn: {},
        acqProductChurn: {},
        products: {},
        productsAdded: {},
        productsAcqNet: {},
        productFunnel: {},
        productFunnelAdded: {},
        productFunnelAcqNet: {},
        weightedFunnel: {},
        weightedProductFunnel: {},
        weightedClosedWonAdded: 0,
        weightedClosedWonAcqNet: 0,
        weightedProductClosedWonAdded: {},
        weightedProductClosedWonAcqNet: {},
        funnelProbSum: {},
        productFunnelProbSum: {},
        funnelProbSeen: {},
        productFunnelProbSeen: {},
        funnelOppIds: {},
        productFunnelOppIds: {},
        funnelOppIdsAdded: {},
        productFunnelOppIdsAdded: {},
        closedWonOppIdsAdded: new Set(),
        closedWonOppIdsAcqNet: new Set(),
        productClosedWonOppIdsAdded: {},
        productClosedWonOppIdsAcqNet: {},
      };
    }
  }

  // ---- Per-rep per-calendar-month Closed Won (for quota proration) ----
  // Independent of `dateFilter` so the client can subtract MTD-already-booked
  // from the monthly quota when computing prorated goals over an arbitrary
  // timeframe (Task #159). Bucketed by closeDate's calendar month (YYYY-MM).
  // For the current month we also emit an MTD snapshot — closed-won where
  // closeDate ∈ [monthStart, today] — so the proration math doesn't double
  // count CW that's already booked this month.
  type CwBucket = {
    added: number;
    acqNet: number;
    std: number;
    churn: number;
  };
  const newCwBucket = (): CwBucket => ({
    added: 0,
    acqNet: 0,
    std: 0,
    churn: 0,
  });
  // Anchor "today" in PST (America/Los_Angeles) so the MTD boundary on the
  // server matches the client's `getTodayPST()` math. Using `new Date()` here
  // would drift around midnight in non-PST host timezones (the server runs in
  // UTC) and cause "today's" Closed Won to be missed/double-counted.
  const todayPstStr = currentDate().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
  });
  const todayPst = new Date(todayPstStr);
  const todayY = todayPst.getFullYear();
  const todayM = todayPst.getMonth();
  const todayD = todayPst.getDate();
  const currentMonthKey = `${todayY}-${String(todayM + 1).padStart(2, "0")}`;
  const cwByMonthByRep: Record<string, Record<string, CwBucket>> = {};
  const productCwByMonthByRep: Record<
    string,
    Record<string, Record<string, CwBucket>>
  > = {};
  const cwMtdByRep: Record<string, CwBucket> = {};
  const productCwMtdByRep: Record<string, Record<string, CwBucket>> = {};
  // Sparse per-day breakdown of the same Closed Won so the client can compute
  // exact subtractable amounts for partial-month boundaries in custom date
  // ranges (Task #159 review). Only days with activity are emitted; the
  // outer key is "YYYY-MM" and the inner key is the calendar day-of-month
  // ("1".."31"). Sums across the full month equal the matching cwByMonth /
  // productCwByMonth values so the existing aggregate fields stay valid.
  const cwDaysByMonthByRep: Record<
    string,
    Record<string, Record<string, CwBucket>>
  > = {};
  const productCwDaysByMonthByRep: Record<
    string,
    Record<string, Record<string, Record<string, CwBucket>>>
  > = {};
  // Bucket all Closed Won rows (unfiltered by dateFilter) by month so the
  // standardization below mirrors what `pipelineRows` would produce when
  // filtered to that month alone. We only need ~24 months of data; older
  // months are dropped to keep the payload compact.
  const minMonthYM = todayY * 12 + todayM - 14; // 14 months back
  const maxMonthYM = todayY * 12 + todayM + 6; // 6 months forward
  const cwRowsByMonth: Record<string, ParsedRow[]> = {};
  for (const r of rows) {
    if (!hierarchy.allReps.has(r.rep) && !hierarchy.repToFlm[r.rep]) continue;
    if (effectiveFunnelStage(r) !== "Closed Won") continue;
    const cd = effectiveCloseDate(r);
    if (!cd) continue;
    const ymOrd = cd.getFullYear() * 12 + cd.getMonth();
    if (ymOrd < minMonthYM || ymOrd > maxMonthYM) continue;
    const ymKey = `${cd.getFullYear()}-${String(cd.getMonth() + 1).padStart(2, "0")}`;
    (cwRowsByMonth[ymKey] ||= []).push(r);
  }
  // Task #241: the proration buckets iterate the *raw* closed-won rows (not the
  // merged pipeline rows), so they need their own compensable values. Build a
  // separate map over this row set and fold it into compMrrByRow (keys are
  // distinct objects from the merged pipeline rows, so no collisions). Run as a
  // separate pass to keep FUB↔Zpro pairing from double-counting across sets.
  if (compMrrByRow) {
    const cwRowsFlat = Object.values(cwRowsByMonth).flat();
    const cwComp = await buildCompensableMrrMap(cwRowsFlat, hierarchy, revenueMode);
    for (const [row, val] of cwComp.mrrByRow) compMrrByRow.set(row, val);
    for (const row of cwComp.acqChurnIgnoredRows) acqChurnIgnoredRows.add(row);
  }
  for (const [ymKey, monthRows] of Object.entries(cwRowsByMonth)) {
    // Build per-month positive-CW keys and SCv4-upgrade keys from CW rows
    // in this month so acqNet/CR semantics match the existing main-loop logic.
    const monthPosKeys = new Set<string>();
    for (const r of monthRows) {
      const stdMrr = mrrOf(r);
      if (stdMrr > 0) {
        const prod = r.product || "No Product Selected";
        monthPosKeys.add(`${r.rep}||${r.accountId}||${prod}`);
      }
    }
    for (const r of monthRows) {
      initRep(r.rep, r.manager);
      const stdMrr = mrrOf(r);
      const prod = r.product || "No Product Selected";
      const repBuckets = (cwByMonthByRep[r.rep] ||= {});
      const bucket = (repBuckets[ymKey] ||= newCwBucket());
      const prodReps = (productCwByMonthByRep[r.rep] ||= {});
      const prodBuckets = (prodReps[prod] ||= {});
      const prodBucket = (prodBuckets[ymKey] ||= newCwBucket());
      // Day-of-month sparse buckets (closeDate.getDate() in PST). Closed-won
      // rows from the sheet carry day-precision close dates so this is the
      // finest granularity we can attribute without altering source data.
      const cd = effectiveCloseDate(r)!;
      const dayKey = String(cd.getDate());
      const repDays = (cwDaysByMonthByRep[r.rep] ||= {});
      const monthDays = (repDays[ymKey] ||= {});
      const dayBucket = (monthDays[dayKey] ||= newCwBucket());
      const prodDayReps = (productCwDaysByMonthByRep[r.rep] ||= {});
      const prodDayMonths = (prodDayReps[prod] ||= {});
      const prodDayMonth = (prodDayMonths[ymKey] ||= {});
      const prodDayBucket = (prodDayMonth[dayKey] ||= newCwBucket());
      let mtdBucket: CwBucket | null = null;
      let prodMtdBucket: CwBucket | null = null;
      if (ymKey === currentMonthKey) {
        const cdY = cd.getFullYear();
        const cdM = cd.getMonth();
        const cdD = cd.getDate();
        const isMtd =
          cdY < todayY ||
          (cdY === todayY && cdM < todayM) ||
          (cdY === todayY && cdM === todayM && cdD <= todayD);
        if (isMtd) {
          mtdBucket = cwMtdByRep[r.rep] ||= newCwBucket();
          prodMtdBucket = (productCwMtdByRep[r.rep] ||= {})[prod] ||=
            newCwBucket();
        }
      }
      bucket.std += stdMrr;
      prodBucket.std += stdMrr;
      dayBucket.std += stdMrr;
      prodDayBucket.std += stdMrr;
      if (mtdBucket) {
        mtdBucket.std += stdMrr;
        prodMtdBucket!.std += stdMrr;
      }
      if (stdMrr > 0) {
        bucket.added += stdMrr;
        prodBucket.added += stdMrr;
        bucket.acqNet += stdMrr;
        prodBucket.acqNet += stdMrr;
        dayBucket.added += stdMrr;
        prodDayBucket.added += stdMrr;
        dayBucket.acqNet += stdMrr;
        prodDayBucket.acqNet += stdMrr;
        if (mtdBucket) {
          mtdBucket.added += stdMrr;
          prodMtdBucket!.added += stdMrr;
          mtdBucket.acqNet += stdMrr;
          prodMtdBucket!.acqNet += stdMrr;
        }
      } else if (stdMrr < 0) {
        const acqKey = `${r.rep}||${r.accountId}||${prod}`;
        // Task #182: per-day churn = sum of negative-MRR Closed Won.
        // Sign-preserving (negative values) so the calendar renders them
        // red via its existing < 0 branch.
        bucket.churn += stdMrr;
        prodBucket.churn += stdMrr;
        dayBucket.churn += stdMrr;
        prodDayBucket.churn += stdMrr;
        if (mtdBucket) {
          mtdBucket.churn += stdMrr;
          prodMtdBucket!.churn += stdMrr;
        }
        if (monthPosKeys.has(acqKey) || acqGateBypassed(r)) {
          bucket.acqNet += stdMrr;
          prodBucket.acqNet += stdMrr;
          dayBucket.acqNet += stdMrr;
          prodDayBucket.acqNet += stdMrr;
          if (mtdBucket) {
            mtdBucket.acqNet += stdMrr;
            prodMtdBucket!.acqNet += stdMrr;
          }
        }
      }
    }
  }
  // Task #437: emit RAW float cw buckets. Rounding happens once at display on
  // the frontend; summing pre-rounded per-rep/per-day buckets into team totals
  // produced penny-off drift vs. the unrounded drilldown sums. (Renamed from
  // outCwBucket — it no longer rounds.)
  const outCwBucket = (b: CwBucket): CwBucket => ({
    added: b.added,
    acqNet: b.acqNet,
    std: b.std,
    churn: b.churn,
  });
  const outCwByMonth = (
    m: Record<string, CwBucket>,
  ): Record<string, CwBucket> => {
    const out: Record<string, CwBucket> = {};
    for (const [k, v] of Object.entries(m)) out[k] = outCwBucket(v);
    return out;
  };
  const outProductCwByMonth = (
    m: Record<string, Record<string, CwBucket>>,
  ): Record<string, Record<string, CwBucket>> => {
    const out: Record<string, Record<string, CwBucket>> = {};
    for (const [p, byMonth] of Object.entries(m))
      out[p] = outCwByMonth(byMonth);
    return out;
  };
  const outProductCwMtd = (
    m: Record<string, CwBucket>,
  ): Record<string, CwBucket> => {
    const out: Record<string, CwBucket> = {};
    for (const [p, b] of Object.entries(m)) out[p] = outCwBucket(b);
    return out;
  };
  const outCwDays = (
    m: Record<string, Record<string, CwBucket>>,
  ): Record<string, Record<string, CwBucket>> => {
    const out: Record<string, Record<string, CwBucket>> = {};
    for (const [ym, days] of Object.entries(m)) {
      const dayOut: Record<string, CwBucket> = {};
      for (const [d, b] of Object.entries(days)) dayOut[d] = outCwBucket(b);
      out[ym] = dayOut;
    }
    return out;
  };
  const outProductCwDays = (
    m: Record<string, Record<string, Record<string, CwBucket>>>,
  ): Record<string, Record<string, Record<string, CwBucket>>> => {
    const out: Record<string, Record<string, Record<string, CwBucket>>> = {};
    for (const [p, byMonth] of Object.entries(m)) out[p] = outCwDays(byMonth);
    return out;
  };

  const reps = Object.values(repMap).map((rep) => {
    const productShare: Record<string, number> = {};
    if (rep.totalMrr > 0) {
      for (const [p, amt] of Object.entries(rep.products)) {
        productShare[p] = amt / rep.totalMrr;
      }
    }

    const isManager =
      hierarchy.slms.includes(rep.name) || !!hierarchy.flmToReps[rep.name];
    const repQuota = isManager ? undefined : quotas[rep.name];

    const flm = hierarchy.repToFlm[rep.name] || rep.manager;
    const slm = hierarchy.repToSlm[rep.name] || rep.manager;

    // Task #437: per-product funnel actuals stay as raw floats so the frontend
    // sums unrounded values into team/product totals (rounding once at display).
    const productFunnel: Record<string, Record<string, number>> = {};
    for (const [prod, stages] of Object.entries(rep.productFunnel)) {
      productFunnel[prod] = {};
      for (const [stage, val] of Object.entries(stages)) {
        productFunnel[prod][stage] = val;
      }
    }

    // Task #165 / Task #175: per-month quotas keyed by ym so the per-month
    // proration table looks up each month's own M GOAL. Managers (FLMs/SLMs)
    // get empty maps so their quota never leaks into prorated team totals.
    // Only current-month and last-month are available from Anaplan upstream.
    const quotaFields = buildRepQuotaFields(
      rep.name,
      isManager,
      currentMonthYm,
      lastMonthYm,
      quotas,
      currentQuotas,
      lastMonthQuotas,
    );

    return {
      name: rep.name,
      flm,
      slm,
      region: hierarchy.repToRegion[rep.name] || "",
      segment: hierarchy.repToSegment[rep.name] || "",
      group: hierarchy.repToGroup[rep.name] || "",
      ...quotaFields,
      scChurnGoal: repQuota ? Math.round(repQuota.scChurnGoal) : 0,
      mbpChurnGoal: repQuota ? Math.round(repQuota.mbpChurnGoal) : 0,
      scMrrAddedGoal: repQuota ? Math.round(repQuota.scMrrAddedGoal) : 0,
      mbpMrrAddedGoal: repQuota ? Math.round(repQuota.mbpMrrAddedGoal) : 0,
      // Per-product, data-driven GnR goal map. Showcase + MBP populated from
      // the same source as the scalar fields above; other products appear here
      // automatically once finance supplies their goal data (see
      // buildProductGoals in databricks-quota.ts). Managers get an empty map.
      productGoals: repQuota
        ? Object.fromEntries(
            Object.entries(repQuota.productGoals).map(([prod, g]) => [
              prod,
              {
                mrrAddedGoal: Math.round(g.mrrAddedGoal),
                churnGoal: Math.round(g.churnGoal),
                netGoal: Math.round(g.netGoal),
              },
            ]),
          )
        : {},
      // Task #437: all MRR/funnel/churn ACTUALS below are emitted as raw floats.
      // The frontend sums these per-rep/per-product pieces into team totals and
      // rounds once at display, so pre-rounding here no longer drifts the totals
      // off the unrounded drilldown sums. (Goal fields above stay rounded.)
      mrr30d: rep.totalMrr,
      mrrAdded30d: rep.totalMrrAdded,
      mrrAcqNet30d: rep.totalMrrAcqNet,
      mrr24h: rep.totalMrr / 22,
      closedWonMrr: rep.funnel["Closed Won"] || 0,
      churn30d: rep.totalChurn,
      acqChurn30d: rep.totalAcqChurn,
      churn24h: rep.totalChurn / 22,
      mods30d: modsByRep.byRep[rep.name] || 0,
      mods24h: (modsByRep.byRep[rep.name] || 0) / 22,
      funnel: {
        Discovery: rep.funnel["Discovery"] || 0,
        "Demo Scheduled": rep.funnel["Demo Scheduled"] || 0,
        "Proposal/Negotiation": rep.funnel["Proposal/Negotiation"] || 0,
        "Paperwork Sent": rep.funnel["Paperwork Sent"] || 0,
        "Awaiting Payment": rep.funnel["Awaiting Payment"] || 0,
        "Closed Won": rep.funnel["Closed Won"] || 0,
        "Closed Lost": rep.funnel["Closed Lost"] || 0,
      },
      funnelAdded: {
        Discovery: rep.funnelAdded["Discovery"] || 0,
        "Demo Scheduled": rep.funnelAdded["Demo Scheduled"] || 0,
        "Proposal/Negotiation": rep.funnelAdded["Proposal/Negotiation"] || 0,
        "Paperwork Sent": rep.funnelAdded["Paperwork Sent"] || 0,
        "Awaiting Payment": rep.funnelAdded["Awaiting Payment"] || 0,
        "Closed Won": rep.funnelAdded["Closed Won"] || 0,
        "Closed Lost": rep.funnelAdded["Closed Lost"] || 0,
      },
      productShare,
      productFunnel,
      funnelAcqNet: {
        Discovery: rep.funnelAcqNet["Discovery"] || 0,
        "Demo Scheduled": rep.funnelAcqNet["Demo Scheduled"] || 0,
        "Proposal/Negotiation": rep.funnelAcqNet["Proposal/Negotiation"] || 0,
        "Paperwork Sent": rep.funnelAcqNet["Paperwork Sent"] || 0,
        "Awaiting Payment": rep.funnelAcqNet["Awaiting Payment"] || 0,
        "Closed Won": rep.funnelAcqNet["Closed Won"] || 0,
        "Closed Lost": rep.funnelAcqNet["Closed Lost"] || 0,
      },
      productFunnelAdded: Object.fromEntries(
        Object.entries(rep.productFunnelAdded).map(([prod, stages]) => {
          const out: Record<string, number> = {};
          for (const [stage, val] of Object.entries(stages)) {
            out[stage] = val;
          }
          return [prod, out];
        }),
      ),
      productFunnelAcqNet: Object.fromEntries(
        Object.entries(rep.productFunnelAcqNet).map(([prod, stages]) => {
          const out: Record<string, number> = {};
          for (const [stage, val] of Object.entries(stages)) {
            out[stage] = val;
          }
          return [prod, out];
        }),
      ),
      weightedFunnel: {
        Discovery: rep.weightedFunnel["Discovery"] || 0,
        "Demo Scheduled": rep.weightedFunnel["Demo Scheduled"] || 0,
        "Proposal/Negotiation": rep.weightedFunnel["Proposal/Negotiation"] || 0,
        "Paperwork Sent": rep.weightedFunnel["Paperwork Sent"] || 0,
        "Awaiting Payment": rep.weightedFunnel["Awaiting Payment"] || 0,
        "Closed Won": rep.weightedFunnel["Closed Won"] || 0,
      },
      weightedProductFunnel: Object.fromEntries(
        Object.entries(rep.weightedProductFunnel).map(([prod, stages]) => {
          const out: Record<string, number> = {};
          for (const [stage, val] of Object.entries(stages)) {
            out[stage] = val;
          }
          return [prod, out];
        }),
      ),
      weightedClosedWonAdded: rep.weightedClosedWonAdded,
      weightedClosedWonAcqNet: rep.weightedClosedWonAcqNet,
      weightedProductClosedWonAdded: Object.fromEntries(
        Object.entries(rep.weightedProductClosedWonAdded).map(([p, v]) => [
          p,
          v,
        ]),
      ),
      weightedProductClosedWonAcqNet: Object.fromEntries(
        Object.entries(rep.weightedProductClosedWonAcqNet).map(([p, v]) => [
          p,
          v,
        ]),
      ),
      funnelProbSum: { ...rep.funnelProbSum },
      productFunnelProbSum: Object.fromEntries(
        Object.entries(rep.productFunnelProbSum).map(([prod, stages]) => [
          prod,
          { ...stages },
        ]),
      ),
      productClosedWonMrr: Object.fromEntries(
        Object.entries(productFunnel).map(([p, stages]) => [
          p,
          stages["Closed Won"] || 0,
        ]),
      ),
      productChurn: Object.fromEntries(
        Object.entries(rep.productChurn).map(([p, v]) => [p, v]),
      ),
      acqProductChurn: Object.fromEntries(
        Object.entries(rep.acqProductChurn).map(([p, v]) => [p, v]),
      ),
      productMods: modsByRep.byRepByProduct[rep.name] || {},
      productModsWeighted: modsByRep.byRepByProductWeighted[rep.name] || {},
      productModsCount: modsByRep.byRepByProductCount[rep.name] || {},
      productChurnTypeMods: modsByRep.byRepByProductByChurnType[rep.name] || {},
      productChurnTypeModsWeighted:
        modsByRep.byRepByProductByChurnTypeWeighted[rep.name] || {},
      productChurnTypeModsCount:
        modsByRep.byRepByProductByChurnTypeCount[rep.name] || {},
      funnelOppCount: {
        Discovery: rep.funnelOppIds["Discovery"]?.size || 0,
        "Demo Scheduled": rep.funnelOppIds["Demo Scheduled"]?.size || 0,
        "Proposal/Negotiation":
          rep.funnelOppIds["Proposal/Negotiation"]?.size || 0,
        "Paperwork Sent": rep.funnelOppIds["Paperwork Sent"]?.size || 0,
        "Awaiting Payment": rep.funnelOppIds["Awaiting Payment"]?.size || 0,
        "Closed Won": rep.funnelOppIds["Closed Won"]?.size || 0,
        "Closed Lost": rep.funnelOppIds["Closed Lost"]?.size || 0,
      },
      productFunnelOppCount: Object.fromEntries(
        Object.entries(rep.productFunnelOppIds).map(([prod, stages]) => {
          const counts: Record<string, number> = {};
          for (const [stage, set] of Object.entries(stages)) {
            counts[stage] = set.size;
          }
          return [prod, counts];
        }),
      ),
      // Opp ID arrays per (product, stage) so the frontend can compute distinct
      // unions when multiple products are selected (avoids overcounting opps
      // present in more than one selected product).
      productFunnelOppIds: Object.fromEntries(
        Object.entries(rep.productFunnelOppIds).map(([prod, stages]) => {
          const arr: Record<string, string[]> = {};
          for (const [stage, set] of Object.entries(stages)) {
            arr[stage] = Array.from(set);
          }
          return [prod, arr];
        }),
      ),
      // Task #476: positives-only per-stage opp count (no product filter path)
      // and per-(product, stage) opp ID arrays (product-filtered union path),
      // mirroring funnelOppCount/productFunnelOppIds but excluding negative-MRR
      // opps. Used by the Pipeline Funnel Gross view.
      funnelOppCountAdded: {
        Discovery: rep.funnelOppIdsAdded["Discovery"]?.size || 0,
        "Demo Scheduled": rep.funnelOppIdsAdded["Demo Scheduled"]?.size || 0,
        "Proposal/Negotiation":
          rep.funnelOppIdsAdded["Proposal/Negotiation"]?.size || 0,
        "Paperwork Sent": rep.funnelOppIdsAdded["Paperwork Sent"]?.size || 0,
        "Awaiting Payment": rep.funnelOppIdsAdded["Awaiting Payment"]?.size || 0,
        "Closed Won": rep.funnelOppIdsAdded["Closed Won"]?.size || 0,
        "Closed Lost": rep.funnelOppIdsAdded["Closed Lost"]?.size || 0,
      },
      productFunnelOppIdsAdded: Object.fromEntries(
        Object.entries(rep.productFunnelOppIdsAdded).map(([prod, stages]) => {
          const arr: Record<string, string[]> = {};
          for (const [stage, set] of Object.entries(stages)) {
            arr[stage] = Array.from(set);
          }
          return [prod, arr];
        }),
      ),
      closedWonOppCountAdded: rep.closedWonOppIdsAdded.size,
      closedWonOppCountAcqNet: rep.closedWonOppIdsAcqNet.size,
      productClosedWonOppCountAdded: Object.fromEntries(
        Object.entries(rep.productClosedWonOppIdsAdded).map(([p, s]) => [
          p,
          s.size,
        ]),
      ),
      productClosedWonOppCountAcqNet: Object.fromEntries(
        Object.entries(rep.productClosedWonOppIdsAcqNet).map(([p, s]) => [
          p,
          s.size,
        ]),
      ),
      productClosedWonOppIdsAdded: Object.fromEntries(
        Object.entries(rep.productClosedWonOppIdsAdded).map(([p, s]) => [
          p,
          Array.from(s),
        ]),
      ),
      productClosedWonOppIdsAcqNet: Object.fromEntries(
        Object.entries(rep.productClosedWonOppIdsAcqNet).map(([p, s]) => [
          p,
          Array.from(s),
        ]),
      ),
      // Per-rep per-calendar-month Closed Won (Task #159 quota proration).
      // `cwByMonth` is the full month's CW; `cwMtd` is the current month's
      // CW restricted to closeDate <= today (PST). Used by the client to
      // subtract already-booked CW from monthly_goal before applying the
      // business-day proration factor. See PipelineView's quota proration.
      cwByMonth: outCwByMonth(cwByMonthByRep[rep.name] || {}),
      productCwByMonth: outProductCwByMonth(
        productCwByMonthByRep[rep.name] || {},
      ),
      cwMtd: outCwBucket(cwMtdByRep[rep.name] || newCwBucket()),
      productCwMtd: outProductCwMtd(productCwMtdByRep[rep.name] || {}),
      cwDaysByMonth: outCwDays(cwDaysByMonthByRep[rep.name] || {}),
      productCwDaysByMonth: outProductCwDays(
        productCwDaysByMonthByRep[rep.name] || {},
      ),
    };
  });

  // quotaDataAvailable reflects whether the *selected* month's quotas were
  // populated, not the absolute current month. This matters around the start
  // of each month when the upstream Anaplan upload hasn't landed yet — e.g.
  // viewing the dashboard at 11pm HST on Apr 30 (= 9am UTC May 1) was
  // incorrectly reporting "quota data not available" for March/April views
  // because the May upload wasn't published until ~5th of the month.
  const quotaDataAvailable =
    !quotasByMonth.fetchError &&
    Object.values(quotas).some((q) => q.totalQuota !== 0);

  return {
    reps,
    quotaDataAvailable,
    quotaError: quotasByMonth.fetchError,
    quotaErrorMessage: quotasByMonth.fetchErrorMessage,
    stageDefaultProbabilities: stageDefaults,
  };
}

let cachedStaleOpps: StaleOppRow[] | null = null;
let staleOppsCacheTime = 0;

async function fetchStaleOpps(hierarchy: OrgHierarchy): Promise<StaleOppRow[]> {
  const now = Date.now();
  if (!snapshotCtxActive() && cachedStaleOpps && now - staleOppsCacheTime < CACHE_TTL_MS)
    return cachedStaleOpps;
  if (!snapshotCtxActive() && pendingStaleOpps) return pendingStaleOpps;
  const run = _fetchStaleOppsImpl(hierarchy).finally(() => {
    pendingStaleOpps = null;
  });
  pendingStaleOpps = run;
  return run;
}

async function _fetchStaleOppsImpl(
  hierarchy: OrgHierarchy,
): Promise<StaleOppRow[]> {
  const rows = await fetchRows();
  const now = currentDate();
  const currentYearMonth = now.getFullYear() * 12 + now.getMonth();

  const byOppId = new Map<string, StaleOppRow & { _products: string[] }>();
  const noIdRows: StaleOppRow[] = [];
  for (const r of rows) {
    if (!hierarchy.allReps.has(r.rep) && !hierarchy.repToFlm[r.rep]) continue;
    if (!r.closeDate) continue;
    const cd = new Date(r.closeDate);
    if (isNaN(cd.getTime())) continue;
    const ym = cd.getFullYear() * 12 + cd.getMonth();
    if (ym >= currentYearMonth) continue;
    const funnel = effectiveFunnelStage(r);
    if (funnel === "Closed Won" || funnel === "Closed Lost") continue;

    const stdMrr = standardizeMrr(r);
    if (!r.oppId) {
      noIdRows.push({
        oppName: r.oppName,
        oppId: "",
        rep: r.rep,
        manager: r.manager,
        accountName: r.contactName || r.oppName,
        accountId: r.accountId,
        createdDate: r.createdDate,
        closeDate: r.closeDate,
        amount: stdMrr,
        type: r.type,
        product: r.product,
        stage: r.stage,
      });
      continue;
    }

    // Task #390: key on oppId + rep so an opp split across owners/channels
    // stays as one stale row per owner (mirrors dedupeOppsByOppId).
    const staleKey = `${r.oppId}||${r.rep || ""}`;
    const existing = byOppId.get(staleKey);
    if (!existing) {
      byOppId.set(staleKey, {
        oppName: r.oppName,
        oppId: r.oppId,
        rep: r.rep,
        manager: r.manager,
        accountName: r.contactName || r.oppName,
        accountId: r.accountId,
        createdDate: r.createdDate,
        closeDate: r.closeDate,
        amount: stdMrr,
        type: r.type,
        product: r.product,
        stage: r.stage,
        _products: r.product ? [r.product] : [],
      });
    } else {
      existing.amount += stdMrr;
      const p = (r.product || "").trim();
      if (p && !existing._products.includes(p)) existing._products.push(p);
      existing.product = existing._products.join(", ");
    }
  }

  const results: StaleOppRow[] = [
    ...Array.from(byOppId.values()).map(({ _products, ...rest }) => {
      void _products;
      return rest;
    }),
    ...noIdRows,
  ];

  if (!isReplayActive()) {
    cachedStaleOpps = results;
    staleOppsCacheTime = Date.now();
  }
  return results;
}

async function _legacyFetchStaleOppsImpl_unused(
  hierarchy: OrgHierarchy,
): Promise<StaleOppRow[]> {
  void hierarchy;
  const text = await fetchSheetCSV(STALE_OPPS_SHEET_ID, STALE_OPPS_SHEET_GID);
  const lines = text.split("\n");
  if (lines.length < 2) return [];

  let headerRowIdx = 0;
  for (let li = 0; li < Math.min(10, lines.length); li++) {
    const low = lines[li].toLowerCase();
    if (low.includes("opportunity name") || low.includes("opportunity id")) {
      headerRowIdx = li;
      break;
    }
  }

  const headerLine = lines[headerRowIdx].toLowerCase();
  const headers = headerLine.split(",").map((h) => h.trim().replace(/"/g, ""));
  const colExact = (needles: string[]) => {
    for (const n of needles) {
      const idx = headers.findIndex((h) => h === n);
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const colIncludes = (needles: string[]) => {
    for (const n of needles) {
      const idx = headers.findIndex((h) => h === n || h.includes(n));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const oppNameIdx = colIncludes(["opportunity name"]);
  const oppIdIdx = colExact(["opportunity id (18-digit)", "opportunity id"]);
  const repIdx = colExact(["opportunity owner: full name", "full name"]);
  const managerIdx = colIncludes([
    "opportunity owner: manager: full name",
    "manager",
  ]);
  const accountIdIdx = colIncludes([
    "account name: account id",
    "account id (18",
  ]);
  const createdIdx = colExact(["created date"]);
  const closedIdx = colExact(["closed date", "close date"]);
  const amountIdx = colExact(["amount"]);
  const typeIdx = colExact(["type"]);
  const productIdx = colExact(["product"]);
  const stageIdx = colExact(["stage"]);

  const results: StaleOppRow[] = [];
  for (let i = headerRowIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols: string[] = [];
    let inQuote = false;
    let field = "";
    for (const ch of line) {
      if (ch === '"') {
        inQuote = !inQuote;
        continue;
      }
      if (ch === "," && !inQuote) {
        cols.push(field.trim());
        field = "";
        continue;
      }
      field += ch;
    }
    cols.push(field.trim());

    const rep = repIdx >= 0 ? cols[repIdx] || "" : "";
    if (!rep) continue;
    if (!hierarchy.allReps.has(rep) && !hierarchy.repToFlm[rep]) continue;

    const oppName = oppNameIdx >= 0 ? cols[oppNameIdx] || "" : "";
    results.push({
      oppName,
      oppId: canonicalizeOppId(oppIdIdx >= 0 ? cols[oppIdIdx] || "" : ""),
      rep,
      manager: managerIdx >= 0 ? cols[managerIdx] || "" : "",
      accountName: oppName.split(" - ")[0] || oppName,
      accountId: accountIdIdx >= 0 ? cols[accountIdIdx] || "" : "",
      createdDate: createdIdx >= 0 ? cols[createdIdx] || "" : "",
      closeDate: closedIdx >= 0 ? cols[closedIdx] || "" : "",
      amount: amountIdx >= 0 ? parseFloat(cols[amountIdx]) || 0 : 0,
      type: typeIdx >= 0 ? cols[typeIdx] || "" : "",
      product: productIdx >= 0 ? cols[productIdx] || "" : "",
      stage: stageIdx >= 0 ? cols[stageIdx] || "" : "",
    });
  }

  if (!isReplayActive()) {
    cachedStaleOpps = results;
    staleOppsCacheTime = Date.now();
  }
  return results;
}

export async function getLiveActionsData() {
  const [rows, hierarchy] = await Promise.all([fetchRows(), fetchHierarchy()]);
  const [ccDeclinesData, inboundsData, staleOppsData, callsData] =
    await Promise.all([
      fetchCcDeclines(hierarchy),
      fetchInbounds(hierarchy),
      fetchStaleOpps(hierarchy),
      fetchCalls(),
    ]);

  // Task #555: index dials by (18-digit Account ID + rep Full Name) so each
  // inbound can look up its rep's post-inbound dials for the Last Called /
  // Total Calls columns.
  const callsByAcctRep = new Map<string, CallEntry[]>();
  for (const c of callsData) {
    if (!c.accountId || !c.name) continue;
    const key = `${c.accountId}||${c.name.toLowerCase()}`;
    let bucket = callsByAcctRep.get(key);
    if (!bucket) {
      bucket = [];
      callsByAcctRep.set(key, bucket);
    }
    bucket.push(c);
  }

  // Compute the windowed Last Called / Total Calls for a single inbound.
  // Window: dial Started AFTER the inbound Created time AND (if the related
  // opp has a Closed Date) BEFORE that Closed Date; blank Closed Date => no
  // upper bound.
  const computeCallStats = (d: InboundEntry) => {
    const empty = { lastCalled: "", lastCalledMs: 0, lastCalledConversationId: "", totalCalls: 0 };
    if (!d.accountId || !d.rep || !d.inboundMs) return empty;
    const bucket = callsByAcctRep.get(`${d.accountId}||${d.rep.toLowerCase()}`);
    if (!bucket || bucket.length === 0) return empty;
    const closeMs = d.oppCloseDate ? new Date(d.oppCloseDate).getTime() : NaN;
    const hasUpper = !isNaN(closeMs);
    const windowed = bucket.filter(
      (c) =>
        c.timestamp > d.inboundMs && (!hasUpper || c.timestamp < closeMs),
    );
    if (windowed.length === 0) return empty;
    let latest = windowed[0];
    const uniqueConvos = new Set<string>();
    for (const c of windowed) {
      if (c.timestamp > latest.timestamp) latest = c;
      uniqueConvos.add(c.conversationId || `${c.timestamp}`);
    }
    const lastCalledMs = latest.timestamp;
    const lastCalled = new Date(lastCalledMs).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    return {
      lastCalled,
      lastCalledMs,
      lastCalledConversationId: latest.conversationId || "",
      totalCalls: uniqueConvos.size,
    };
  };

  const staleThreshold = 7;

  const filteredRows = rows.filter(
    (r) => hierarchy.allReps.has(r.rep) || hierarchy.repToFlm[r.rep],
  );

  const actionItems = filteredRows
    .filter((r) => r.daysSinceActivity >= staleThreshold)
    .sort((a, b) => b.daysSinceActivity - a.daysSinceActivity)
    .slice(0, 50)
    .map((r) => ({
      account: r.contactName || r.oppName,
      rep: r.rep,
      flm: hierarchy.repToFlm[r.rep] || r.manager,
      slm: hierarchy.repToSlm[r.rep] || r.manager,
      region: hierarchy.repToRegion[r.rep] || "",
      group: hierarchy.repToGroup[r.rep] || "",
      status: r.stage,
      lastActivity: `${r.daysSinceActivity} days ago`,
      lastContact: r.closeDate,
      awaiting: r.daysSinceActivity >= 14,
    }));

  const topAccounts = filteredRows
    .map((r) => ({ row: r, stdMrr: standardizeMrr(r) }))
    .filter(({ stdMrr }) => stdMrr > 0)
    .sort((a, b) => b.stdMrr - a.stdMrr)
    .slice(0, 30)
    .map(({ row: r, stdMrr }) => ({
      account: r.contactName || r.oppName,
      rep: r.rep,
      flm: hierarchy.repToFlm[r.rep] || r.manager,
      slm: hierarchy.repToSlm[r.rep] || r.manager,
      region: hierarchy.repToRegion[r.rep] || "",
      group: hierarchy.repToGroup[r.rep] || "",
      currentMrr: stdMrr,
      mrrOpp: stdMrr,
      lastContact: r.closeDate,
    }));

  return {
    actionItems,
    inboundItems: inboundsData.map((d) => ({
      contact: d.contact,
      interactionId: d.interactionId,
      ...computeCallStats(d),
      rep: d.rep,
      flm: hierarchy.repToFlm[d.rep] || "Unknown",
      slm: hierarchy.repToSlm[d.rep] || "Unknown",
      region: hierarchy.repToRegion[d.rep] || "",
      group: hierarchy.repToGroup[d.rep] || "",
      leadSource: d.leadSource,
      inboundTime: d.inboundTime,
      inboundMs: d.inboundMs,
      hoursSinceReply: d.hoursSinceReply,
      disposition: d.disposition,
      productOfInterest: d.productOfInterest,
      daysSinceLastActivity: d.daysSinceLastActivity,
      ownerActive: d.ownerActive,
      lastSalesActivity: d.lastSalesActivity,
      lastActivityDate: d.lastActivityDate,
      okToContact: d.okToContact,
      flexStatus: d.flexStatus,
      enterpriseRelated: d.enterpriseRelated,
      oppStage: d.oppStage,
      oppQuoteType: d.oppQuoteType,
      oppCloseDate: d.oppCloseDate,
      oppOwner: d.oppOwner,
      oppId18: d.oppId18,
    })),
    ccDeclines: ccDeclinesData.map((d) => ({
      account: d.account,
      contactId: d.contactId,
      rep: d.rep,
      flm: hierarchy.repToFlm[d.rep] || "Unknown",
      slm: hierarchy.repToSlm[d.rep] || "Unknown",
      region: hierarchy.repToRegion[d.rep] || "",
      group: hierarchy.repToGroup[d.rep] || "",
      declinedAmount: d.declinedAmount,
      declineDate: d.declineDate,
      mrr: d.mrr,
    })),
    topAccounts,
    staleOpps: staleOppsData.map((d) => ({
      oppName: d.oppName,
      oppId: d.oppId,
      rep: d.rep,
      flm: hierarchy.repToFlm[d.rep] || d.manager,
      slm: hierarchy.repToSlm[d.rep] || "",
      region: hierarchy.repToRegion[d.rep] || "",
      group: hierarchy.repToGroup[d.rep] || "",
      segment: hierarchy.repToSegment[d.rep] || "",
      accountName: d.accountName,
      accountId: d.accountId,
      createdDate: d.createdDate,
      closeDate: d.closeDate,
      amount: d.amount,
      type: d.type,
      product: d.product,
      stage: d.stage,
    })),
  };
}

async function fetchSbrs(): Promise<SbrEntry[]> {
  const now = Date.now();
  if (!snapshotCtxActive() && cachedSbrs && now - sbrCacheTime < CACHE_TTL_MS)
    return cachedSbrs;
  if (!snapshotCtxActive() && pendingSbrs) return pendingSbrs;
  const run = _fetchSbrsImpl().finally(() => {
    pendingSbrs = null;
  });
  pendingSbrs = run;
  return run;
}

async function _fetchSbrsImpl(): Promise<SbrEntry[]> {
  const text = await fetchSheetCSV(SBR_SHEET_ID, SBR_SHEET_GID);
  const lines = text.split("\n");
  const entries: SbrEntry[] = [];

  let headerIdx = -1;
  let colMap = {
    learningSessionId: 0,
    manager: 1,
    name: 2,
    eventDate: 3,
    contactName: 4,
    contactId: 5,
  };
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const cols = parseCSVLine(lines[i]);
    const lower = cols.map((c) => c.toLowerCase().trim());
    if (
      lower.some((c) => c.includes("full name")) &&
      lower.some((c) => c.includes("event date"))
    ) {
      headerIdx = i;
      const lsIdx = lower.findIndex((c) => c.includes("learning session id"));
      if (lsIdx !== -1) colMap.learningSessionId = lsIdx;
      const mgrIdx = lower.findIndex((c) => c.includes("manager"));
      if (mgrIdx !== -1) colMap.manager = mgrIdx;
      const nameIdx = lower.findIndex(
        (c) => c === "completed by: full name" || c === "full name",
      );
      if (nameIdx !== -1) colMap.name = nameIdx;
      const dateIdx = lower.findIndex((c) => c.includes("event date"));
      if (dateIdx !== -1) colMap.eventDate = dateIdx;
      const contactIdx = lower.findIndex((c) => c === "contact: full name");
      if (contactIdx !== -1) colMap.contactName = contactIdx;
      const contactIdIdx = lower.findIndex((c) => c.includes("contact id"));
      if (contactIdIdx !== -1) colMap.contactId = contactIdIdx;
      break;
    }
  }
  if (headerIdx === -1) {
    console.warn(
      "[SBRs] Header row not found (expected 'full name' + 'event date' columns). Defaulting to row 2.",
    );
    addParseError({
      sheet: "SBRs",
      sheetUrl: sheetUrl(SBR_SHEET_ID, SBR_SHEET_GID),
      message:
        'Header row not found — expected columns "full name" and "event date"',
      expectedHeaders: [
        "full name",
        "event date",
        "learning session id",
        "manager",
      ],
      actualHeaders: lines
        .slice(0, 3)
        .map((l) => parseCSVLine(l).slice(0, 6).join(", ")),
      timestamp: Date.now(),
    });
    headerIdx = 2;
  }

  const getCol = (cols: string[], idx: number) =>
    idx >= 0 && idx < cols.length ? cols[idx]?.trim() || "" : "";

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 3) continue;

    const name = getCol(cols, colMap.name);
    const rawDate = getCol(cols, colMap.eventDate);
    if (!name) continue;

    const parsed = rawDate ? new Date(rawDate) : null;
    if (rawDate && (!parsed || isNaN(parsed.getTime()))) continue;

    entries.push({
      name,
      timestamp: parsed ? parsed.getTime() : 0,
      learningSessionId: getCol(cols, colMap.learningSessionId),
      manager: getCol(cols, colMap.manager),
      eventDate: rawDate,
      contactName: getCol(cols, colMap.contactName),
      contactId: getCol(cols, colMap.contactId),
    });
  }

  if (!isReplayActive()) {
    cachedSbrs = entries;
    sbrCacheTime = Date.now();
  }
  return entries;
}

async function fetchCalls(): Promise<CallEntry[]> {
  const now = Date.now();
  if (!snapshotCtxActive() && cachedCalls && now - callsCacheTime < CACHE_TTL_MS)
    return cachedCalls;
  if (!snapshotCtxActive() && pendingCalls) return pendingCalls;
  const run = _fetchCallsImpl().finally(() => {
    pendingCalls = null;
  });
  pendingCalls = run;
  return run;
}

async function _fetchCallsImpl(): Promise<CallEntry[]> {
  const text = await fetchSheetCSV(DIALS_SHEET_ID, DIALS_SHEET_GID);
  const lines = text.split("\n");
  const entries: CallEntry[] = [];

  let headerIdx = -1;
  let colMap = {
    date: 0,
    createdDate: -1,
    name: 2,
    duration: -1,
    manager: -1,
    accountName: -1,
    accountId: -1,
    oppName: -1,
    oppStage: -1,
    conversationTitle: -1,
    conversationId: -1,
    gongId: -1,
  };
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const cols = parseCSVLine(lines[i]);
    const lower = cols.map((c) => c.toLowerCase().trim());
    const createdIdx = lower.findIndex((c) => c === "created date");
    const startedIdx = lower.findIndex((c) => c === "started");
    const nameIdx = lower.findIndex((c) => c === "full name");
    if (createdIdx !== -1 && nameIdx !== -1) {
      headerIdx = i;
      // Task #553: dials bucket by the full "Started" timestamp when present;
      // "Created Date" (date-only) is kept as a per-row fallback.
      colMap.createdDate = createdIdx;
      colMap.date = startedIdx !== -1 ? startedIdx : createdIdx;
      colMap.name = nameIdx;
      const durIdx = lower.findIndex((c) => c.includes("duration"));
      if (durIdx !== -1) colMap.duration = durIdx;
      const mgrIdx = lower.indexOf("manager: full name");
      if (mgrIdx !== -1) colMap.manager = mgrIdx;
      const accNameIdx = lower.indexOf("primary account: account name");
      if (accNameIdx !== -1) colMap.accountName = accNameIdx;
      const accIdIdx = lower.findIndex(
        (c) => c.includes("primary account") && c.includes("account id"),
      );
      if (accIdIdx !== -1) colMap.accountId = accIdIdx;
      const oppIdx = lower.findIndex(
        (c) =>
          c.includes("primary opportunity") && c.includes("opportunity name"),
      );
      if (oppIdx !== -1) colMap.oppName = oppIdx;
      const oppStageIdx = lower.findIndex((c) => c === "opportunity stage");
      if (oppStageIdx !== -1) colMap.oppStage = oppStageIdx;
      const convoTitleIdx = lower.indexOf("conversation title");
      if (convoTitleIdx !== -1) colMap.conversationTitle = convoTitleIdx;
      const convoIdIdx = lower.indexOf("conversation id");
      if (convoIdIdx !== -1) colMap.conversationId = convoIdIdx;
      const gongIdx = lower.indexOf("gong id");
      if (gongIdx !== -1) colMap.gongId = gongIdx;
      break;
    }
  }
  if (headerIdx === -1) {
    console.warn(
      "[fetchCalls] Could not find header row with 'Created Date' and 'Full Name'; falling back to row 0 with default column positions",
    );
    headerIdx = 0;
    const fallbackCols = parseCSVLine(lines[0] || "");
    const fallbackLower = fallbackCols.map((c) => c.toLowerCase().trim());
    const durFallback = fallbackLower.findIndex((c) => c.includes("duration"));
    if (durFallback !== -1) colMap.duration = durFallback;
  }

  const MEANINGFUL_THRESHOLD_MIN = 10;
  const getCol = (cols: string[], idx: number) =>
    idx >= 0 && idx < cols.length ? cols[idx]?.trim() || "" : "";

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length <= colMap.name) continue;

    const name = cols[colMap.name]?.trim();
    if (!name) continue;

    // Task #553: prefer the full "Started" timestamp; fall back to the
    // date-only "Created Date" so a blank Started doesn't drop the row.
    const rawStarted = getCol(cols, colMap.date);
    const rawCreated = getCol(cols, colMap.createdDate);
    const rawDate = rawStarted || rawCreated;
    if (!rawDate) continue;

    const parsed = new Date(rawDate);
    if (isNaN(parsed.getTime())) continue;

    let durationMin = 0;
    if (colMap.duration !== -1 && cols[colMap.duration]) {
      durationMin = parseFloat(cols[colMap.duration].trim()) || 0;
    }

    entries.push({
      name,
      timestamp: parsed.getTime(),
      durationMin,
      isMeaningful: durationMin > MEANINGFUL_THRESHOLD_MIN,
      manager: getCol(cols, colMap.manager),
      accountName: getCol(cols, colMap.accountName),
      accountId: getCol(cols, colMap.accountId),
      oppName: getCol(cols, colMap.oppName),
      oppStage: getCol(cols, colMap.oppStage),
      conversationTitle: getCol(cols, colMap.conversationTitle),
      conversationId: getCol(cols, colMap.conversationId),
      gongId: getCol(cols, colMap.gongId),
      started: rawDate,
    });
  }

  if (!isReplayActive()) {
    cachedCalls = entries;
    callsCacheTime = Date.now();
  }
  console.log(
    `[fetchCalls] Parsed ${entries.length} call entries (${entries.filter((e) => e.isMeaningful).length} meaningful)`,
  );
  return entries;
}

function parseCsvAll(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (ch === "\r") {
        /* skip */
      } else field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function fetchEmails(): Promise<EmailEntry[]> {
  const now = Date.now();
  if (!snapshotCtxActive() && cachedEmails && now - emailsCacheTime < CACHE_TTL_MS)
    return cachedEmails;
  if (!snapshotCtxActive() && pendingEmails) return pendingEmails;
  const run = _fetchEmailsImpl().finally(() => {
    pendingEmails = null;
  });
  pendingEmails = run;
  return run;
}

async function _fetchEmailsImpl(): Promise<EmailEntry[]> {
  const text = await fetchSheetCSV(EMAILS_SHEET_ID, EMAILS_SHEET_GID);
  const rows = parseCsvAll(text);

  let headerIdx = -1;
  let colMap = {
    contactName: -1,
    rep: -1,
    manager: -1,
    createdDate: -1,
    subject: -1,
    activityType: -1,
    contactId: -1,
    activityId: -1,
    comments: -1,
  };
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const lower = rows[i].map((c) => (c || "").toLowerCase().trim());
    const dateIdx = lower.findIndex((c) => c === "created date");
    const repIdx = lower.findIndex(
      (c) => c.includes("assigned to") && c.includes("full name"),
    );
    if (dateIdx !== -1 && repIdx !== -1) {
      headerIdx = i;
      colMap.createdDate = dateIdx;
      colMap.rep = repIdx;
      colMap.contactName = lower.findIndex((c) => c === "contact name");
      colMap.manager = lower.findIndex(
        (c) => c.includes("assigned to") && c.includes("manager"),
      );
      colMap.subject = lower.findIndex((c) => c === "subject");
      colMap.activityType = lower.findIndex((c) => c === "activity type");
      colMap.contactId = lower.findIndex((c) => c === "contact id");
      colMap.activityId = lower.findIndex(
        (c) => c.includes("acitivty id") || c.includes("activity id"),
      );
      colMap.comments = lower.findIndex(
        (c) => c === "comments" || c === "description" || c === "body",
      );
      break;
    }
  }
  if (headerIdx === -1) {
    console.warn(
      "[fetchEmails] Header row not found (expected 'Created Date' + 'Assigned To: Full Name'); skipping.",
    );
    addParseError({
      sheet: "Emails",
      sheetUrl: sheetUrl(EMAILS_SHEET_ID, EMAILS_SHEET_GID),
      message:
        'Header row not found — expected columns "Created Date" and "Assigned To: Full Name"',
      expectedHeaders: ["Created Date", "Assigned To: Full Name", "Subject"],
      actualHeaders: rows.slice(0, 3).map((r) => r.slice(0, 8).join(", ")),
      timestamp: Date.now(),
    });
    if (!isReplayActive()) {
      cachedEmails = [];
      emailsCacheTime = Date.now();
    }
    return [];
  }

  const getCol = (cols: string[], idx: number) =>
    idx >= 0 && idx < cols.length ? (cols[idx] || "").trim() : "";
  const entries: EmailEntry[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cols = rows[i];
    if (!cols || cols.length < 3) continue;
    const name = getCol(cols, colMap.rep);
    const rawDate = getCol(cols, colMap.createdDate);
    if (!name || !rawDate) continue;
    const parsed = new Date(rawDate);
    if (isNaN(parsed.getTime())) continue;
    if (colMap.activityType !== -1) {
      const t = getCol(cols, colMap.activityType).toLowerCase();
      if (t && !t.includes("email")) continue;
    }
    const subject = getCol(cols, colMap.subject);
    const lowerSubj = subject.toLowerCase();
    let direction: "sent" | "received";
    if (lowerSubj.startsWith("sent email")) direction = "sent";
    else if (lowerSubj.startsWith("reply:")) direction = "received";
    else if (lowerSubj.startsWith("email:")) direction = "received";
    else direction = "sent";

    let manager = getCol(cols, colMap.manager);
    if (manager.startsWith("CN=")) manager = manager.slice(3);

    entries.push({
      name,
      timestamp: parsed.getTime(),
      createdDate: rawDate,
      manager,
      contactName: getCol(cols, colMap.contactName),
      contactId: getCol(cols, colMap.contactId),
      accountName: getCol(cols, colMap.contactName),
      subject,
      direction,
      activityId: getCol(cols, colMap.activityId),
      comments: getCol(cols, colMap.comments),
    });
  }

  if (!isReplayActive()) {
    cachedEmails = entries;
    emailsCacheTime = Date.now();
  }
  console.log(
    `[fetchEmails] Parsed ${entries.length} email entries (${entries.filter((e) => e.direction === "sent").length} sent, ${entries.filter((e) => e.direction === "received").length} received)`,
  );
  return entries;
}

async function fetchCcDeclines(
  hierarchy: OrgHierarchy,
): Promise<CcDeclineEntry[]> {
  const now = Date.now();
  if (!snapshotCtxActive() && cachedCcDeclines && now - ccDeclinesCacheTime < CACHE_TTL_MS)
    return cachedCcDeclines;
  if (!snapshotCtxActive() && pendingCcDeclines) return pendingCcDeclines;
  const run = _fetchCcDeclinesImpl(hierarchy).finally(() => {
    pendingCcDeclines = null;
  });
  pendingCcDeclines = run;
  return run;
}

async function _fetchCcDeclinesImpl(
  hierarchy: OrgHierarchy,
): Promise<CcDeclineEntry[]> {
  const text = await fetchSheetCSV(CC_DECLINES_SHEET_ID, CC_DECLINES_SHEET_GID);
  const lines = text.split("\n");
  const entries: CcDeclineEntry[] = [];

  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const lower = lines[i].toLowerCase();
    if (
      lower.includes("contact") &&
      (lower.includes("decline") || lower.includes("mrr"))
    ) {
      headerIdx = i;
      headers = parseCSVLine(lines[i]).map((h) => h.toLowerCase().trim());
      break;
    }
  }
  if (headerIdx === -1) {
    headerIdx = 0;
    headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase().trim());
  }

  const findCol = (keywords: string[]) =>
    headers.findIndex((h) => keywords.every((k) => h.includes(k)));
  const accountCol = findCol(["account", "name"]);
  const contactIdCol = findCol(["contact", "id"]);
  const repCol =
    findCol(["account team member: full name"]) >= 0
      ? findCol(["account team member: full name"])
      : findCol(["full name"]) >= 0
        ? findCol(["full name"])
        : findCol(["rep"]);
  const declinedAmtCol =
    findCol(["declined", "amount"]) >= 0
      ? findCol(["declined", "amount"])
      : findCol(["declined"]);
  const declineDateCol = findCol(["decline", "date"]);
  const mrrCol = findCol(["mrr"]);

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVLine(line);

    const rep = repCol >= 0 ? cols[repCol]?.trim() : "";
    if (!rep || !hierarchy.allReps.has(rep)) continue;

    const account = accountCol >= 0 ? cols[accountCol]?.trim() || "" : "";
    const contactId = contactIdCol >= 0 ? cols[contactIdCol]?.trim() || "" : "";
    const declinedAmount =
      declinedAmtCol >= 0 ? parseFloat(cols[declinedAmtCol]) || 0 : 0;
    const declineDate =
      declineDateCol >= 0 ? cols[declineDateCol]?.trim() || "" : "";
    const mrr = mrrCol >= 0 ? parseFloat(cols[mrrCol]) || 0 : 0;

    entries.push({ account, contactId, rep, declinedAmount, declineDate, mrr });
  }

  entries.sort((a, b) => b.mrr - a.mrr);

  if (!isReplayActive()) {
    cachedCcDeclines = entries;
    ccDeclinesCacheTime = Date.now();
  }
  return entries;
}

async function fetchInbounds(hierarchy: OrgHierarchy): Promise<InboundEntry[]> {
  const now = Date.now();
  if (!snapshotCtxActive() && cachedInbounds && now - inboundsCacheTime < CACHE_TTL_MS)
    return cachedInbounds;
  if (!snapshotCtxActive() && pendingInbounds) return pendingInbounds;
  pendingInbounds = _fetchInboundsImpl(hierarchy).finally(() => {
    pendingInbounds = null;
  });
  return pendingInbounds;
}

async function _fetchInboundsImpl(
  hierarchy: OrgHierarchy,
): Promise<InboundEntry[]> {
  const text = await fetchSheetCSV(INBOUNDS_SHEET_ID, INBOUNDS_SHEET_GID);
  const lines = text.split("\n");
  const entries: InboundEntry[] = [];

  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const lower = lines[i].toLowerCase();
    if (
      lower.includes("interaction") &&
      (lower.includes("created") || lower.includes("lead"))
    ) {
      headerIdx = i;
      headers = parseCSVLine(lines[i]).map((h) => h.toLowerCase().trim());
      break;
    }
  }
  if (headerIdx === -1) {
    headerIdx = 0;
    headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase().trim());
  }

  const findCol = (keywords: string[]) =>
    headers.findIndex((h) => keywords.every((k) => h.includes(k)));
  const findColExact = (label: string) =>
    headers.findIndex((h) => h === label.toLowerCase());
  const contactCol =
    findCol(["contact"]) >= 0 ? findCol(["contact"]) : findCol(["name"]);
  const interactionIdCol =
    findColExact("interaction id") >= 0
      ? findColExact("interaction id")
      : findCol(["interaction", "id"]);
  const repCol =
    headers.findIndex((h) => h === "owner") >= 0
      ? headers.findIndex((h) => h === "owner")
      : findCol(["rep"]);
  const leadSourceCol =
    findCol(["warm", "lead", "source"]) >= 0
      ? findCol(["warm", "lead", "source"])
      : findCol(["lead", "source"]);
  const createdDateCol =
    findCol(["interaction", "created"]) >= 0
      ? findCol(["interaction", "created"])
      : findCol(["created", "date"]);
  const hoursSinceCol =
    findCol(["hours", "since"]) >= 0
      ? findCol(["hours", "since"])
      : findCol(["hours"]);
  const dispositionCol =
    findColExact("interaction disposition") >= 0
      ? findColExact("interaction disposition")
      : findCol(["disposition"]);
  const productCol = findCol(["product", "interest"]);
  const daysSinceActivityCol =
    findCol(["days", "since", "asa"]) >= 0
      ? findCol(["days", "since", "asa"])
      : findCol(["days", "since", "activity"]);
  const ownerActiveCol =
    findColExact("interaction : owner : active") >= 0
      ? findColExact("interaction : owner : active")
      : findCol(["owner", "active"]);
  // Task #542: new Salesforce feeder columns (match first occurrence — some
  // headers repeat in the sheet).
  const lastSalesActivityCol = findColExact(
    "interaction : contact : asa sales last activity date",
  );
  const lastActivityDateCol = findColExact(
    "interaction : contact : most recent interaction date",
  );
  const okToContactCol = findColExact("ok to contact");
  const flexStatusCol = findColExact(
    "interaction : contact : flex flip agent status",
  );
  const enterpriseCol = findColExact("enterprise related");
  const oppStageCol = findColExact("interaction : related opportunity : stage");
  const oppQuoteTypeCol = findColExact(
    "interaction : related opportunity : quote type",
  );
  const oppCloseDateCol = findColExact(
    "interaction : related opportunity : closed date",
  );
  const oppOwnerCol = findColExact(
    "interaction : related opportunity : opportunity owner",
  );
  const oppId18Col = findColExact(
    "interaction : related opportunity : opportunity id (18-digit)",
  );
  // Task #555: 18-digit Account ID used to join against the Calls (dials) feed.
  const accountIdCol =
    findColExact(
      "interaction : contact : account name : account id (18-digit)",
    ) >= 0
      ? findColExact(
          "interaction : contact : account name : account id (18-digit)",
        )
      : findCol(["account", "id", "18"]);

  // Rolling "hours since reply" window — frozen in demo mode, live clock
  // otherwise (demoNow() === Date.now() when DEMO_MODE is unset).
  const nowMs = demoNow();

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVLine(line);

    const rep = repCol >= 0 ? cols[repCol]?.trim() : "";
    if (!rep) continue;
    const ownerActiveRaw =
      ownerActiveCol >= 0
        ? (cols[ownerActiveCol]?.trim() || "").toLowerCase()
        : "";
    const ownerActive = !(
      ownerActiveRaw === "false" ||
      ownerActiveRaw === "0" ||
      ownerActiveRaw === "no" ||
      ownerActiveRaw === "n"
    );
    // Skip if rep not in active hierarchy AND owner is active (i.e. unknown rep we shouldn't display anywhere).
    // Always keep rows whose owner is explicitly inactive — Rep Active is a
    // visible column/filter in the inbounds table.
    if (!hierarchy.allReps.has(rep) && ownerActive) continue;

    const contact = contactCol >= 0 ? cols[contactCol]?.trim() || "" : "";
    const interactionId =
      interactionIdCol >= 0 ? cols[interactionIdCol]?.trim() || "" : "";
    const leadSource =
      leadSourceCol >= 0 ? cols[leadSourceCol]?.trim() || "" : "";
    const createdDateRaw =
      createdDateCol >= 0 ? cols[createdDateCol]?.trim() || "" : "";
    const disposition =
      dispositionCol >= 0 ? cols[dispositionCol]?.trim() || "" : "";
    const productOfInterest =
      productCol >= 0 ? cols[productCol]?.trim() || "" : "";
    const daysSinceRaw =
      daysSinceActivityCol >= 0 ? cols[daysSinceActivityCol]?.trim() || "" : "";
    const daysSinceLastActivity =
      daysSinceRaw === ""
        ? null
        : Number.isFinite(parseFloat(daysSinceRaw))
          ? Math.round(parseFloat(daysSinceRaw))
          : null;

    let inboundMs = 0;
    let inboundTime = createdDateRaw;
    let hoursSinceReply = 0;

    if (hoursSinceCol >= 0 && cols[hoursSinceCol]) {
      hoursSinceReply = Math.round(parseFloat(cols[hoursSinceCol]) || 0);
    } else if (createdDateRaw) {
      const parsed = new Date(createdDateRaw);
      if (!isNaN(parsed.getTime())) {
        inboundMs = parsed.getTime();
        hoursSinceReply = Math.round((nowMs - inboundMs) / (1000 * 60 * 60));
      }
    }

    if (createdDateRaw) {
      const parsed = new Date(createdDateRaw);
      if (!isNaN(parsed.getTime())) {
        inboundMs = parsed.getTime();
        inboundTime = parsed.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
      }
    }

    const cell = (idx: number) => (idx >= 0 ? cols[idx]?.trim() || "" : "");

    entries.push({
      contact,
      interactionId,
      rep,
      leadSource,
      inboundTime,
      inboundMs,
      hoursSinceReply,
      disposition,
      productOfInterest,
      daysSinceLastActivity,
      ownerActive,
      lastSalesActivity: cell(lastSalesActivityCol),
      lastActivityDate: cell(lastActivityDateCol),
      okToContact: cell(okToContactCol),
      flexStatus: cell(flexStatusCol),
      enterpriseRelated: cell(enterpriseCol),
      oppStage: cell(oppStageCol),
      oppQuoteType: cell(oppQuoteTypeCol),
      oppCloseDate: cell(oppCloseDateCol),
      oppOwner: cell(oppOwnerCol),
      oppId18: cell(oppId18Col),
      accountId: cell(accountIdCol),
    });
  }

  entries.sort((a, b) => b.hoursSinceReply - a.hoursSinceReply);

  if (!isReplayActive()) {
    cachedInbounds = entries;
    inboundsCacheTime = Date.now();
  }
  return entries;
}

function getTimeframeCutoff(timeframe?: string): number {
  const nowMs = demoNow();
  if (timeframe === "allTime") return Number.NEGATIVE_INFINITY;
  if (timeframe === "24h") return nowMs - 24 * 60 * 60 * 1000;
  if (timeframe === "60d") return nowMs - 60 * 24 * 60 * 60 * 1000;
  return nowMs - 30 * 24 * 60 * 60 * 1000;
}

function parseRangeMs(
  from?: string,
  to?: string,
): { fromMs: number; toMs: number } {
  const fromMs = from
    ? new Date(`${from}T00:00:00`).getTime()
    : Number.NEGATIVE_INFINITY;
  const toMs = to
    ? new Date(`${to}T00:00:00`).getTime() + 86400000
    : Number.POSITIVE_INFINITY;
  return { fromMs, toMs };
}

function getActivityRange(
  timeframe?: string,
  from?: string,
  to?: string,
): { fromMs: number; toMs: number } {
  if (from || to) return parseRangeMs(from, to);
  return {
    fromMs: getTimeframeCutoff(timeframe),
    toMs: Number.POSITIVE_INFINITY,
  };
}

function productMatchesFilter(
  rowProduct: string,
  filter: Set<string>,
): boolean {
  if (filter.size === 0) return true;
  const trimmed = (rowProduct || "").trim();
  if (!trimmed) return false;
  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of parts) if (filter.has(p)) return true;
  return false;
}

export async function getOppsCreated(
  timeframe?: string,
  from?: string,
  to?: string,
) {
  const [rows, hierarchy, overrides, stageDefaults, reviewedMap] =
    await Promise.all([
      fetchRows(),
      fetchEffectiveHierarchy(monthFromFilter({ from, to })),
      getOppProbabilityOverrides(),
      getStageDefaultProbabilities(),
      getOppReviewedMap(),
    ]);
  const useRange = !!(from || to);
  const { fromMs, toMs } = useRange
    ? getActivityRange(undefined, from, to)
    : { fromMs: getTimeframeCutoff(timeframe), toMs: Number.POSITIVE_INFINITY };

  const filtered = rows.filter((r) => {
    if (!hierarchy.allReps.has(r.rep)) return false;
    if (!r.createdDate) return false;
    if (r.type === "Cart") return false;
    if (r.stage === "Zips Added") return false;
    const created = new Date(r.createdDate);
    if (isNaN(created.getTime())) return false;
    const t = created.getTime();
    if (t < fromMs || t >= toMs) return false;
    return true;
  });

  const mapped = filtered.map((r) =>
    mapRowToOpp(r, hierarchy, overrides, stageDefaults, reviewedMap),
  );
  return { opportunities: dedupeOppsByOppId(mapped) };
}

export async function getDemos(timeframe?: string, from?: string, to?: string) {
  const [rows, hierarchy, overrides, stageDefaults, reviewedMap] =
    await Promise.all([
      fetchRows(),
      fetchEffectiveHierarchy(monthFromFilter({ from, to })),
      getOppProbabilityOverrides(),
      getStageDefaultProbabilities(),
      getOppReviewedMap(),
    ]);
  const { fromMs, toMs } = getActivityRange(timeframe, from, to);

  const filtered = rows.filter((r) => {
    if (!hierarchy.allReps.has(r.rep)) return false;
    if (!r.demoPerformedDate) return false;
    const demoDate = new Date(r.demoPerformedDate);
    if (isNaN(demoDate.getTime())) return false;
    const t = demoDate.getTime();
    if (t < fromMs || t >= toMs) return false;
    return true;
  });

  const mapped = filtered.map((r) =>
    mapRowToOpp(r, hierarchy, overrides, stageDefaults, reviewedMap),
  );
  return { opportunities: dedupeOppsByOppId(mapped) };
}

export async function getSbrRecords(
  timeframe?: string,
  from?: string,
  to?: string,
) {
  const [sbrEntries, hierarchy] = await Promise.all([
    fetchSbrs(),
    fetchEffectiveHierarchy(monthFromFilter({ from, to })),
  ]);
  const { fromMs, toMs } = getActivityRange(timeframe, from, to);

  const records = sbrEntries
    .filter((e) => {
      if (!hierarchy.allReps.has(e.name)) return false;
      if (e.timestamp <= 0) return false;
      if (e.timestamp < fromMs || e.timestamp >= toMs) return false;
      return true;
    })
    .map((e) => ({
      learningSessionId: e.learningSessionId,
      eventDate: e.eventDate,
      manager: e.manager,
      rep: e.name,
      contactName: e.contactName,
      contactId: e.contactId,
      region: hierarchy.repToRegion[e.name] || "",
      group: hierarchy.repToGroup[e.name] || "",
      flm: hierarchy.repToFlm[e.name] || "",
      slm: hierarchy.repToSlm[e.name] || "",
    }));

  records.sort(
    (a, b) => new Date(b.eventDate).getTime() - new Date(a.eventDate).getTime(),
  );
  return { sbrs: records };
}

export async function getCallRecords(
  type: "dials" | "convos",
  timeframe?: string,
  from?: string,
  to?: string,
) {
  const [callEntries, hierarchy] = await Promise.all([
    fetchCalls(),
    fetchEffectiveHierarchy(monthFromFilter({ from, to })),
  ]);
  const { fromMs, toMs } = getActivityRange(timeframe, from, to);

  const records = callEntries
    .filter((e) => {
      if (!hierarchy.allReps.has(e.name)) return false;
      if (e.timestamp < fromMs || e.timestamp >= toMs) return false;
      if (type === "convos" && !e.isMeaningful) return false;
      return true;
    })
    .map((e) => ({
      started: e.started,
      durationMin: Math.round(e.durationMin * 10) / 10,
      manager: e.manager,
      rep: e.name,
      accountName: e.accountName,
      accountId: e.accountId,
      oppName: e.oppName,
      oppStage: e.oppStage,
      conversationTitle: e.conversationTitle,
      conversationId: e.conversationId,
      gongId: e.gongId,
      region: hierarchy.repToRegion[e.name] || "",
      group: hierarchy.repToGroup[e.name] || "",
      flm: hierarchy.repToFlm[e.name] || "",
      slm: hierarchy.repToSlm[e.name] || "",
    }));

  records.sort(
    (a, b) =>
      new Date(b.started).getTime() - new Date(a.started).getTime(),
  );
  return { calls: records };
}

export interface ActivityByRepEntry {
  name: string;
  flm: string;
  slm: string;
  region: string;
  group: string;
  segment: string;
  dials: number;
  convos: number;
  talkMin: number;
  meaningfulTalkMin: number;
  sbrs: number;
  demos: number;
  emails: number;
  opps: number;
}

export async function getActivityByRep(
  from?: string,
  to?: string,
  products?: string[],
): Promise<{ reps: ActivityByRepEntry[] }> {
  const [sbrEntries, callEntries, emailEntries, pipelineRows, hierarchy] =
    await Promise.all([
      fetchSbrs(),
      fetchCalls(),
      fetchEmails(),
      fetchRows(),
      fetchEffectiveHierarchy(monthFromFilter({ from, to })),
    ]);
  const { fromMs, toMs } = parseRangeMs(from, to);
  const productFilter = new Set((products || []).filter(Boolean));

  const repMap: Record<string, ActivityByRepEntry> = {};
  const ensureRep = (name: string): ActivityByRepEntry => {
    if (!repMap[name]) {
      repMap[name] = {
        name,
        flm: hierarchy.repToFlm[name] || "Unknown",
        slm: hierarchy.repToSlm[name] || "Unknown",
        region: hierarchy.repToRegion[name] || "",
        group: hierarchy.repToGroup[name] || "",
        segment: hierarchy.repToSegment[name] || "",
        dials: 0,
        convos: 0,
        talkMin: 0,
        meaningfulTalkMin: 0,
        sbrs: 0,
        demos: 0,
        emails: 0,
        opps: 0,
      };
    }
    return repMap[name];
  };

  for (const name of hierarchy.allReps) ensureRep(name);

  for (const e of callEntries) {
    if (!hierarchy.allReps.has(e.name)) continue;
    if (e.timestamp < fromMs || e.timestamp >= toMs) continue;
    const rm = ensureRep(e.name);
    rm.dials += 1;
    rm.talkMin += e.durationMin;
    if (e.isMeaningful) {
      rm.convos += 1;
      rm.meaningfulTalkMin += e.durationMin;
    }
  }

  for (const e of sbrEntries) {
    if (!hierarchy.allReps.has(e.name)) continue;
    if (e.timestamp <= 0) continue;
    if (e.timestamp < fromMs || e.timestamp >= toMs) continue;
    ensureRep(e.name).sbrs += 1;
  }

  function appendProduct(existing: string, next: string): string {
    const cur = existing.split(", ").filter(Boolean);
    const n = (next || "").trim();
    if (n && !cur.includes(n)) cur.push(n);
    return cur.join(", ");
  }

  const oppById = new Map<string, { rep: string; product: string }>();
  const oppNoId: { rep: string; product: string }[] = [];
  for (const row of pipelineRows) {
    if (!hierarchy.allReps.has(row.rep)) continue;
    if (!row.createdDate) continue;
    if (row.stage === "Zips Added") continue;
    if (row.type === "Cart") continue;
    const t = new Date(row.createdDate).getTime();
    if (isNaN(t) || t < fromMs || t >= toMs) continue;
    if (!row.oppId) {
      oppNoId.push({ rep: row.rep, product: (row.product || "").trim() });
      continue;
    }
    const existing = oppById.get(row.oppId);
    if (!existing) {
      oppById.set(row.oppId, {
        rep: row.rep,
        product: (row.product || "").trim(),
      });
    } else {
      existing.product = appendProduct(existing.product, row.product || "");
    }
  }
  for (const { rep, product } of oppById.values()) {
    if (!productMatchesFilter(product, productFilter)) continue;
    ensureRep(rep).opps += 1;
  }
  for (const { rep, product } of oppNoId) {
    if (!productMatchesFilter(product, productFilter)) continue;
    ensureRep(rep).opps += 1;
  }

  const demoById = new Map<string, { rep: string; product: string }>();
  const demoNoId: { rep: string; product: string }[] = [];
  for (const row of pipelineRows) {
    if (!hierarchy.allReps.has(row.rep)) continue;
    if (!row.demoPerformedDate) continue;
    const t = new Date(row.demoPerformedDate).getTime();
    if (isNaN(t) || t < fromMs || t >= toMs) continue;
    if (!row.oppId) {
      demoNoId.push({ rep: row.rep, product: (row.product || "").trim() });
      continue;
    }
    const existing = demoById.get(row.oppId);
    if (!existing) {
      demoById.set(row.oppId, {
        rep: row.rep,
        product: (row.product || "").trim(),
      });
    } else {
      existing.product = appendProduct(existing.product, row.product || "");
    }
  }
  for (const { rep, product } of demoById.values()) {
    if (!productMatchesFilter(product, productFilter)) continue;
    ensureRep(rep).demos += 1;
  }
  for (const { rep, product } of demoNoId) {
    if (!productMatchesFilter(product, productFilter)) continue;
    ensureRep(rep).demos += 1;
  }

  for (const e of emailEntries) {
    if (!hierarchy.allReps.has(e.name)) continue;
    if (e.timestamp < fromMs || e.timestamp >= toMs) continue;
    ensureRep(e.name).emails += 1;
  }

  return { reps: Object.values(repMap) };
}

export async function getEmailRecords(
  timeframe?: string,
  from?: string,
  to?: string,
) {
  const [emailEntries, hierarchy] = await Promise.all([
    fetchEmails(),
    fetchEffectiveHierarchy(monthFromFilter({ from, to })),
  ]);
  const { fromMs, toMs } = getActivityRange(timeframe, from, to);

  const records = emailEntries
    .filter((e) => {
      if (!hierarchy.allReps.has(e.name)) return false;
      if (e.timestamp <= 0) return false;
      if (e.timestamp < fromMs || e.timestamp >= toMs) return false;
      return true;
    })
    .map((e) => ({
      activityId: e.activityId,
      createdDate: e.createdDate,
      manager: e.manager,
      rep: e.name,
      contactName: e.contactName,
      contactId: e.contactId,
      accountName: e.accountName,
      subject: e.subject,
      comments: e.comments,
      direction: e.direction,
      region: hierarchy.repToRegion[e.name] || "",
      group: hierarchy.repToGroup[e.name] || "",
      flm: hierarchy.repToFlm[e.name] || "",
      slm: hierarchy.repToSlm[e.name] || "",
    }));

  records.sort(
    (a, b) =>
      new Date(b.createdDate).getTime() - new Date(a.createdDate).getTime(),
  );
  return { emails: records };
}

export async function getLiveActivityData() {
  const [sbrEntries, callEntries, pipelineRows, hierarchy] = await Promise.all([
    fetchSbrs(),
    fetchCalls(),
    fetchRows(),
    fetchHierarchy(),
  ]);

  const nowMs = demoNow();
  const thirtyDaysAgoMs = nowMs - 30 * 24 * 60 * 60 * 1000;
  const twentyFourHoursAgoMs = nowMs - 24 * 60 * 60 * 1000;

  const repMap: Record<
    string,
    {
      talk30d: number;
      talk24h: number;
      sbrs30d: number;
      sbrs24h: number;
      convos30d: number;
      convos24h: number;
      dials30d: number;
      dials24h: number;
      opps30d: number;
      opps24h: number;
      demos30d: number;
      demos24h: number;
      dailyTalk: Record<string, number>;
      oppsByProduct30d: Record<string, number>;
      oppsByProduct24h: Record<string, number>;
      demosByProduct30d: Record<string, number>;
      demosByProduct24h: Record<string, number>;
    }
  > = {};

  function ensureRep(name: string) {
    if (!repMap[name]) {
      repMap[name] = {
        talk30d: 0,
        talk24h: 0,
        sbrs30d: 0,
        sbrs24h: 0,
        convos30d: 0,
        convos24h: 0,
        dials30d: 0,
        dials24h: 0,
        opps30d: 0,
        opps24h: 0,
        demos30d: 0,
        demos24h: 0,
        dailyTalk: {},
        oppsByProduct30d: {},
        oppsByProduct24h: {},
        demosByProduct30d: {},
        demosByProduct24h: {},
      };
    }
    return repMap[name];
  }

  for (const entry of sbrEntries) {
    if (!hierarchy.allReps.has(entry.name)) continue;
    if (entry.timestamp <= 0) continue;
    if (entry.timestamp < thirtyDaysAgoMs) continue;

    const rm = ensureRep(entry.name);
    rm.sbrs30d += 1;

    if (entry.timestamp >= twentyFourHoursAgoMs) {
      rm.sbrs24h += 1;
    }
  }

  for (const entry of callEntries) {
    if (!hierarchy.allReps.has(entry.name)) continue;
    if (entry.timestamp < thirtyDaysAgoMs) continue;

    const rm = ensureRep(entry.name);
    rm.dials30d += 1;
    rm.talk30d += entry.durationMin;
    const entryDate = new Date(entry.timestamp);
    const dateKey = `${entryDate.getFullYear()}-${String(entryDate.getMonth() + 1).padStart(2, "0")}-${String(entryDate.getDate()).padStart(2, "0")}`;
    rm.dailyTalk[dateKey] = (rm.dailyTalk[dateKey] || 0) + entry.durationMin;
    if (entry.timestamp >= twentyFourHoursAgoMs) {
      rm.dials24h += 1;
      rm.talk24h += entry.durationMin;
    }
    if (entry.isMeaningful) {
      rm.convos30d += 1;
      if (entry.timestamp >= twentyFourHoursAgoMs) {
        rm.convos24h += 1;
      }
    }
  }

  function appendProduct(existing: string, next: string): string {
    const cur = existing.split(", ").filter(Boolean);
    const n = (next || "").trim();
    if (n && !cur.includes(n)) cur.push(n);
    return cur.join(", ");
  }

  const oppById = new Map<
    string,
    { rep: string; within24h: boolean; product: string }
  >();
  for (const row of pipelineRows) {
    if (!hierarchy.allReps.has(row.rep)) continue;
    if (!row.oppId) continue;
    if (!row.createdDate) continue;
    if (row.stage === "Zips Added") continue;
    if (row.type === "Cart") continue;

    const created = new Date(row.createdDate);
    if (isNaN(created.getTime())) continue;
    const createdMs = created.getTime();
    if (createdMs < thirtyDaysAgoMs) continue;

    const existing = oppById.get(row.oppId);
    if (!existing) {
      oppById.set(row.oppId, {
        rep: row.rep,
        within24h: createdMs >= twentyFourHoursAgoMs,
        product: (row.product || "").trim(),
      });
    } else {
      existing.product = appendProduct(existing.product, row.product || "");
    }
  }
  for (const { rep, within24h, product } of oppById.values()) {
    const rm = ensureRep(rep);
    rm.opps30d += 1;
    rm.oppsByProduct30d[product] = (rm.oppsByProduct30d[product] || 0) + 1;
    if (within24h) {
      rm.opps24h += 1;
      rm.oppsByProduct24h[product] = (rm.oppsByProduct24h[product] || 0) + 1;
    }
  }

  const demoById = new Map<
    string,
    { rep: string; within24h: boolean; product: string }
  >();
  for (const row of pipelineRows) {
    if (!hierarchy.allReps.has(row.rep)) continue;
    if (!row.oppId) continue;
    if (!row.demoPerformedDate) continue;

    const demoDate = new Date(row.demoPerformedDate);
    if (isNaN(demoDate.getTime())) continue;
    const demoMs = demoDate.getTime();
    if (demoMs < thirtyDaysAgoMs) continue;

    const existing = demoById.get(row.oppId);
    if (!existing) {
      demoById.set(row.oppId, {
        rep: row.rep,
        within24h: demoMs >= twentyFourHoursAgoMs,
        product: (row.product || "").trim(),
      });
    } else {
      existing.product = appendProduct(existing.product, row.product || "");
    }
  }
  for (const { rep, within24h, product } of demoById.values()) {
    const rm = ensureRep(rep);
    rm.demos30d += 1;
    rm.demosByProduct30d[product] = (rm.demosByProduct30d[product] || 0) + 1;
    if (within24h) {
      rm.demos24h += 1;
      rm.demosByProduct24h[product] = (rm.demosByProduct24h[product] || 0) + 1;
    }
  }

  const reps = Object.entries(repMap).map(([name, data]) => {
    const flm = hierarchy.repToFlm[name] || "Unknown";
    const slm = hierarchy.repToSlm[name] || "Unknown";

    return {
      name,
      flm,
      slm,
      region: hierarchy.repToRegion[name] || "",
      group: hierarchy.repToGroup[name] || "",
      dials30d: data.dials30d,
      dials24h: data.dials24h,
      convos30d: data.convos30d,
      convos24h: data.convos24h,
      talk30d: Math.round(data.talk30d),
      talk24h: Math.round(data.talk24h),
      emails30d: data.demos30d,
      emails24h: data.demos24h,
      sbrs30d: data.sbrs30d,
      sbrs24h: data.sbrs24h,
      opps30d: data.opps30d,
      opps24h: data.opps24h,
      dailyTalk: data.dailyTalk,
      oppsByProduct30d: data.oppsByProduct30d,
      oppsByProduct24h: data.oppsByProduct24h,
      demosByProduct30d: data.demosByProduct30d,
      demosByProduct24h: data.demosByProduct24h,
    };
  });

  return { reps };
}

// ============================================================================
// Compensation ("compensable revenue")
// ============================================================================
// Build the standardized comp inputs for a month from the cached pipeline rows
// + org hierarchy, run the multiplier engine + FUB↔Zpro rule, and return a
// summary (actual vs. compensable MRR overall, per product, and the FUB↔Zpro
// pairings). The heavy work — fetchRows / fetchHierarchy — is cache-backed, so
// this is cheap to call per request and ready to be precomputed per refresh
// when the views are wired up.

export async function buildCompensationRowInputs(
  month: string,
): Promise<CompRowInput[]> {
  const [rows, hierarchy] = await Promise.all([
    fetchRows(),
    fetchEffectiveHierarchy(month),
  ]);
  const inputs: CompRowInput[] = [];
  for (const r of rows) {
    if (compMonthKey(r.closeDate) !== month) continue;
    inputs.push(rowToCompInput(r, hierarchy));
  }
  return inputs;
}

export interface CompensationSummary {
  month: string;
  config: CompensationConfig;
  totalActual: number;
  totalCompensable: number;
  oppCount: number;
  byProduct: Record<string, { actual: number; compensable: number }>;
  pairs: PairedOppPairSummary[];
}

export async function getCompensationSummary(
  month: string,
): Promise<CompensationSummary> {
  const [inputs, config] = await Promise.all([
    buildCompensationRowInputs(month),
    getCompensationConfig(month),
  ]);
  const result = computeCompensation(inputs, config);
  return {
    month,
    config,
    totalActual: result.totalActual,
    totalCompensable: result.totalCompensable,
    oppCount: inputs.length,
    byProduct: result.byProduct,
    pairs: result.pairSummaries,
  };
}

// ─── Rule-affected opportunities export ──────────────────────────────────────
// Every opportunity in `month` that matched the conditions of at least one
// currently-applied compensation rule — multiplier rules (including 1× rules
// that produced no dollar change) and the FUB↔Zpro linking rule. Matching keys
// purely on whether a rule's conditions fired, never on whether compensable MRR
// actually changed. Returns one line item per raw source row (Option C) with
// the full raw feeder row attached, plus per-line-item and opp-level comp
// values, for the Compensation tab's CSV/XLSX export.

export interface RuleAffectedLineItem {
  // Attributed product bucket (as shown everywhere in the app).
  product: string;
  // Raw "Product" cell from the feeder sheet, before attribution.
  rawProduct: string;
  type: string;
  // Standardized actual MRR for this line item (== app "MRR" in comp mode).
  rawMrr: number;
  // Engine compensable MRR for this line item.
  compensableMrr: number;
  // Effective multiplier for this line item (FUB↔Zpro rows carry the ratio).
  multiplier: number;
  // Applied rule labels / ids (FUB↔Zpro pairs carry one synthetic entry).
  ruleNames: string[];
  ruleIds: string[];
  // Task #276: effective base MRR-source field for this line item (a rule
  // override, else the Type default), so the export shows which column fed the
  // compensable base MRR.
  mrrField: MrrField;
  // Whether this specific line item matched a rule. Unmatched line items of an
  // otherwise-matched opp are still included for full inspection.
  matched: boolean;
  // Raw feeder row aligned positionally to `rawHeaders`. Empty on synthetic
  // rows (e.g. Re/Max CPDs) that have no source sheet row.
  rawCells: string[];
}

export interface RuleAffectedOpp {
  oppId: string;
  accountId: string;
  accountName: string;
  oppName: string;
  manager: string;
  rep: string;
  salesRole: string;
  group: string;
  segment: string;
  closeDate: string;
  quoteType: string;
  stage: string;
  // Comma-joined distinct line-item products.
  product: string;
  // Opportunity-level totals (sum across all line items).
  amount: number;
  rawMrr: number;
  compensableMrr: number;
  lineItems: RuleAffectedLineItem[];
}

export interface RuleAffectedExport {
  month: string;
  config: CompensationConfig;
  rawHeaders: string[];
  opportunities: RuleAffectedOpp[];
}

export async function getRuleAffectedOpportunities(
  month: string,
): Promise<RuleAffectedExport> {
  const [rows, hierarchy, config] = await Promise.all([
    fetchRows(),
    fetchEffectiveHierarchy(month),
    getCompensationConfig(month),
  ]);

  // Scope to the selected compensation month (keyed by close date), then run
  // the same engine the views use so multipliers + FUB↔Zpro pairings match.
  const monthRows = rows.filter((r) => compMonthKey(r.closeDate) === month);
  const inputs = monthRows.map((r) => rowToCompInput(r, hierarchy));
  const result = computeCompensation(inputs, config);

  interface Acc {
    opp: RuleAffectedOpp;
    anyMatched: boolean;
  }
  const byOpp = new Map<string, Acc>();
  const order: string[] = [];

  monthRows.forEach((r, i) => {
    // Task #403: every opp participating in a FIRED paired rule must be flagged
    // as affected in the export — not only the adjustment's target opp — so the
    // export agrees with the drilldown (Task #402). Derivation lives in the
    // shared `ruleAffectmentForExport` helper, kept in lockstep with the
    // drilldown's `ruleAffectmentForDrilldown` (parity guarded by
    // compensation.test.ts).
    const { ruleNames, ruleIds, matched } = ruleAffectmentForExport(result, i);
    const lineItem: RuleAffectedLineItem = {
      product: r.product,
      rawProduct: r.rawProduct,
      type: r.type,
      rawMrr: inputs[i].standardizedMrr,
      compensableMrr: result.compensable[i],
      multiplier: result.multipliers[i],
      ruleNames,
      ruleIds,
      mrrField: result.appliedMrrField[i] ?? appliedBaseMrrFieldForRow(r),
      matched,
      rawCells: r.rawCells ? r.rawCells.slice() : [],
    };
    // Rows sharing an oppId are line items of one opp; rows without an oppId
    // are each their own opp (mirrors dedupeOppsByOppId's no-id handling).
    const key = r.oppId ? `id:${r.oppId}` : `noid:${i}`;
    let acc = byOpp.get(key);
    if (!acc) {
      acc = {
        anyMatched: false,
        opp: {
          oppId: r.oppId,
          accountId: r.accountId,
          accountName: r.contactName,
          oppName: r.oppName,
          manager: r.manager,
          rep: r.rep,
          salesRole: r.salesRole,
          group: hierarchy.repToGroup[r.rep] || "",
          segment: hierarchy.repToSegment[r.rep] || "",
          closeDate: r.closeDate,
          quoteType: r.quoteType,
          stage: r.stage,
          product: "",
          amount: 0,
          rawMrr: 0,
          compensableMrr: 0,
          lineItems: [],
        },
      };
      byOpp.set(key, acc);
      order.push(key);
    }
    acc.opp.lineItems.push(lineItem);
    acc.opp.amount += r.amount;
    acc.opp.rawMrr += lineItem.rawMrr;
    acc.opp.compensableMrr += lineItem.compensableMrr;
    if (matched) acc.anyMatched = true;
  });

  const opportunities: RuleAffectedOpp[] = [];
  for (const key of order) {
    const acc = byOpp.get(key)!;
    if (!acc.anyMatched) continue;
    const products = Array.from(
      new Set(acc.opp.lineItems.map((li) => li.product).filter(Boolean)),
    );
    acc.opp.product = products.join(", ");
    opportunities.push(acc.opp);
  }

  return { month, config, rawHeaders: getPipelineRawHeaders(), opportunities };
}

// Task #375: build the comp inputs needed to diagnose a single pasted opp id
// against a rule. The opp is looked up across ALL months; whichever close month
// it falls in supplies the row set used to resolve paired-opp partners. Returns
// `found: false` when no row carries that opp id.
export async function buildCompTestContext(oppId: string): Promise<{
  found: boolean;
  testInputs: CompRowInput[];
  monthInputs: CompRowInput[];
}> {
  const id = (oppId || "").trim();
  if (!id) return { found: false, testInputs: [], monthInputs: [] };

  const rows = await fetchRows();
  const testRows = rows.filter((r) => r.oppId && r.oppId === id);
  if (testRows.length === 0) {
    return { found: false, testInputs: [], monthInputs: [] };
  }

  // Resolve partners within the pasted opp's own close month (the engine groups
  // paired deals by close month), using that month's effective hierarchy.
  const mk = compMonthKey(testRows[0].closeDate);
  const hierarchy = await fetchEffectiveHierarchy(mk);
  const monthRows = rows.filter((r) => compMonthKey(r.closeDate) === mk);
  const testInputs = testRows.map((r) => rowToCompInput(r, hierarchy));
  const monthInputs = monthRows.map((r) => rowToCompInput(r, hierarchy));
  return { found: true, testInputs, monthInputs };
}

// Task #394: build the comp inputs needed to diagnose a paired rule with an opp
// id PINNED to each named role. `oppTestIds` is aligned index-for-index to the
// rule's opps ("" = blank). The resolution pool is the close month of the first
// pasted id that exists (paired deals group by close month), PLUS any pasted
// opp's rows from other months so a cross-month pin is still testable. Returns
// `found: false` (empty pool) when no pasted id resolves to a row.
export async function buildCompTestContextMulti(oppTestIds: string[]): Promise<{
  found: boolean;
  monthInputs: CompRowInput[];
}> {
  const trimmed = oppTestIds.map((s) => (s || "").trim());
  const ids = new Set(trimmed.filter(Boolean));
  if (ids.size === 0) return { found: false, monthInputs: [] };

  const rows = await fetchRows();

  // Primary month = close month of the first pasted id (declaration order, so
  // the anchor wins) that resolves to a row.
  let primaryMonth: string | null = null;
  for (const id of trimmed) {
    if (!id) continue;
    const r = rows.find((x) => x.oppId && x.oppId === id);
    if (r) {
      primaryMonth = compMonthKey(r.closeDate);
      break;
    }
  }
  if (primaryMonth === null) return { found: false, monthInputs: [] };

  const hierarchy = await fetchEffectiveHierarchy(primaryMonth);
  const picked = rows.filter(
    (r) =>
      compMonthKey(r.closeDate) === primaryMonth ||
      (r.oppId !== "" && ids.has(r.oppId)),
  );
  const monthInputs = picked.map((r) => rowToCompInput(r, hierarchy));
  return { found: true, monthInputs };
}

// Task #572: build the inputs needed to test a pasted opp id against a Product
// Logic rule. Returns EVERY line-item row carrying that opp id (a multi-line
// opp is red if ANY line fails), each with its Opportunity Product ID (from the
// raw feeder cells; falls back to the SF CPD id or the opp id itself) so the UI
// can name the failing line items.
export interface ProductLogicTestRow {
  input: CompRowInput;
  oppProductId: string;
}

export async function buildProductLogicTestContext(oppId: string): Promise<{
  found: boolean;
  rows: ProductLogicTestRow[];
}> {
  const id = (oppId || "").trim();
  if (!id) return { found: false, rows: [] };

  const rows = await fetchRows();
  const testRows = rows.filter((r) => r.oppId && r.oppId === id);
  if (testRows.length === 0) return { found: false, rows: [] };

  // Hierarchy of the opp's own close month (supplies group/segment for the
  // Channel / Segment condition fields), mirroring buildCompTestContext.
  const mk = compMonthKey(testRows[0].closeDate);
  const hierarchy = await fetchEffectiveHierarchy(mk);

  const norm = (s: string) => s.toLowerCase().trim();
  const oppProductIdCol = pipelineRawHeaders.findIndex((h) =>
    norm(h).includes("opportunity product id"),
  );

  return {
    found: true,
    rows: testRows.map((r) => ({
      input: rowToCompInput(r, hierarchy),
      oppProductId:
        (oppProductIdCol >= 0 && r.rawCells?.[oppProductIdCol]) ||
        r.sfCpdId ||
        r.oppId,
    })),
  };
}
