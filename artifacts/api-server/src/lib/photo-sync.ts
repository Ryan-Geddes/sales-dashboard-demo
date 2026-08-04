import { createHash } from "crypto";
import { Storage } from "@google-cloud/storage";
import { fetchHierarchy } from "./sheets-data";
import { clearRemaxCpdsCache } from "./databricks-remax-cpds";
import { clearAnaplanCache } from "./databricks-anaplan";
import { getUncachableSlackClient, checkSlackScopes } from "./slack-client";
import { logger } from "./logger";
import { db } from "@workspace/db";
import { oppProbabilityOverridesTable, userPreferencesTable, usersTable } from "@workspace/db/schema";
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { invalidateProbabilityCaches } from "./probabilities";
import {
  runNightlyQuotaRefresh,
  getLastQuotaError,
  clearLastQuotaError,
  getLastQuotaFallbackWarning,
  clearLastQuotaFallbackWarning,
} from "./databricks-quota";
import {
  runNightlyHolidayRefresh,
  getLastHolidayError,
  clearLastHolidayError,
  getLastHolidayFallbackWarning,
  clearLastHolidayFallbackWarning,
} from "./databricks-holidays";
import {
  refreshFinancePpsSnapshot,
  getLastFinancePpsError,
  clearLastFinancePpsError,
} from "./goals-finance-pps";
import {
  refreshErepSnapshot,
  getLastErepError,
  clearLastErepError,
  getLastErepFallbackWarning,
  clearLastErepFallbackWarning,
} from "./goals-erep";
import { clearGoalsQuotaCache } from "./goals-quota-source";
import { isDemoMode } from "./demo-mode";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function errStack(err: unknown): string {
  if (err instanceof Error) return err.stack || "N/A";
  return "N/A";
}

const gcsClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

function getBucketAndPrefix() {
  const privateDir = process.env.PRIVATE_OBJECT_DIR || "";
  if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR not set");
  const parts = privateDir.replace(/^\//, "").split("/");
  const bucketName = parts[0];
  const prefix = parts.slice(1).join("/");
  return { bucketName, prefix };
}

function photoObjectKey(name: string): string {
  const hash = createHash("md5").update(name).digest("hex").slice(0, 8);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return `${slug}_${hash}`;
}

const photoCache: Record<string, string> = {};
let photoCacheTime = 0;
const PHOTO_CACHE_TTL = 10 * 60 * 1000;

/**
 * Optional static avatar overrides, from the STATIC_PHOTO_MAP env var: a JSON
 * object of `{ "Full Name": "file-name.png" }` whose files live in the
 * server's static photo directory (served at
 * /api/sales/photos/static/<file>). Unset / unparseable => no overrides, so
 * this repo carries no real names.
 */
function loadStaticPhotoMap(): Record<string, string> {
  const raw = process.env.STATIC_PHOTO_MAP?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [name, file] of Object.entries(parsed)) {
      if (typeof file === "string" && file.trim()) {
        out[name] = `/api/sales/photos/static/${file.trim()}`;
      }
    }
    return out;
  } catch (err) {
    logger.warn(
      { err: errMsg(err) },
      "STATIC_PHOTO_MAP is not valid JSON — ignoring static photo overrides",
    );
    return {};
  }
}

const HARDCODED_PHOTOS: Record<string, string> = loadStaticPhotoMap();

export async function getPhotoMap(): Promise<Record<string, string>> {
  // Demo mode: no Slack, no object storage — every avatar falls back to the
  // frontend's initials placeholder.
  if (isDemoMode()) return {};
  const now = Date.now();
  if (now - photoCacheTime < PHOTO_CACHE_TTL && Object.keys(photoCache).length > 0) {
    return { ...HARDCODED_PHOTOS, ...photoCache };
  }

  try {
    const { bucketName, prefix } = getBucketAndPrefix();
    const bucket = gcsClient.bucket(bucketName);
    const photosPrefix = prefix ? `${prefix}/photos/` : "photos/";
    const [files] = await bucket.getFiles({ prefix: photosPrefix });

    const map: Record<string, string> = {};
    for (const file of files) {
      const metadata = file.metadata?.metadata as Record<string, string> | undefined;
      const personName = metadata?.personName;
      if (personName) {
        map[personName] = `/api/sales/photos/image/${photoObjectKey(personName)}`;
      }
    }

    Object.assign(photoCache, map);
    photoCacheTime = now;
    return { ...HARDCODED_PHOTOS, ...map };
  } catch (err: unknown) {
    logger.error({ err: errMsg(err) }, "Failed to build photo map");
    return { ...HARDCODED_PHOTOS, ...photoCache };
  }
}

export async function getPhotoBuffer(key: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (isDemoMode()) return null;
  try {
    const { bucketName, prefix } = getBucketAndPrefix();
    const bucket = gcsClient.bucket(bucketName);
    const photosPrefix = prefix ? `${prefix}/photos/` : "photos/";

    for (const ext of ["jpg", "png"]) {
      const file = bucket.file(`${photosPrefix}${key}.${ext}`);
      const [exists] = await file.exists();
      if (exists) {
        const [buffer] = await file.download();
        const contentType = ext === "png" ? "image/png" : "image/jpeg";
        return { buffer: Buffer.from(buffer), contentType };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function getExistingPhotos(): Promise<Set<string>> {
  try {
    const { bucketName, prefix } = getBucketAndPrefix();
    const bucket = gcsClient.bucket(bucketName);
    const photosPrefix = prefix ? `${prefix}/photos/` : "photos/";
    const [files] = await bucket.getFiles({ prefix: photosPrefix });

    const existing = new Set<string>();
    for (const file of files) {
      const metadata = file.metadata?.metadata as Record<string, string> | undefined;
      if (metadata?.personName) {
        existing.add(metadata.personName);
      }
    }
    return existing;
  } catch {
    return new Set();
  }
}

interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  profile?: {
    email?: string;
    real_name?: string;
    display_name?: string;
    image_original?: string;
    image_512?: string;
    image_192?: string;
    image_72?: string;
  };
  deleted?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamMatchSlackUsers(
  targetNames: Set<string>,
  onMatch: (name: string, user: SlackUser) => void,
): Promise<void> {
  const client = await getUncachableSlackClient();
  let cursor: string | undefined;
  let page = 0;
  const remaining = new Set(targetNames);
  const lowerToOriginal = new Map<string, string>();
  for (const n of targetNames) lowerToOriginal.set(n.toLowerCase(), n);

  do {
    if (page > 0) {
      await sleep(3000);
    }
    try {
      const result = await client.users.list({ limit: 200, cursor });
      const members = (result.members || []) as SlackUser[];
      cursor = result.response_metadata?.next_cursor || undefined;
      page++;

      for (const u of members) {
        if (u.deleted) continue;
        const realName = (u.profile?.real_name || u.real_name || "").toLowerCase();
        const displayName = (u.profile?.display_name || "").toLowerCase();
        const matchedOrig = lowerToOriginal.get(realName) || lowerToOriginal.get(displayName);
        if (matchedOrig && remaining.has(matchedOrig)) {
          onMatch(matchedOrig, u);
          remaining.delete(matchedOrig);
        }
      }

      if (page % 20 === 0 || remaining.size === 0) {
        logger.info({ page, scanned: page * 200, remaining: remaining.size }, "Slack user scan progress");
      }

      if (remaining.size === 0) break;
    } catch (err: unknown) {
      const msg = errMsg(err);
      const isRateLimit = msg.includes("rate_limit") || msg.includes("ratelimited") || msg.includes("rate limit") || msg.includes("429");
      if (isRateLimit) {
        logger.warn({ page, err: msg }, "Rate limited on users.list, waiting 35s...");
        await sleep(35000);
        continue;
      }
      logger.error({ page, err: msg }, "Non-rate-limit error during Slack user scan, continuing...");
      break;
    }
  } while (cursor);

  logger.info({ totalPages: page, matched: targetNames.size - remaining.size, unmatched: remaining.size }, "Slack user scan complete");
}

function getBestProfileImage(user: SlackUser): string | null {
  const p = user.profile;
  if (!p) return null;
  return p.image_original || p.image_512 || p.image_192 || p.image_72 || null;
}

async function downloadImage(url: string): Promise<{ buffer: Buffer; ext: string } | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") || "image/jpeg";
    const arrayBuf = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    if (buffer.length < 100) return null;
    const ext = contentType.includes("png") ? "png" : "jpg";
    return { buffer, ext };
  } catch {
    return null;
  }
}

async function uploadPhoto(
  name: string,
  buffer: Buffer,
  ext: string,
): Promise<void> {
  const { bucketName, prefix } = getBucketAndPrefix();
  const bucket = gcsClient.bucket(bucketName);
  const key = photoObjectKey(name);
  const photosPrefix = prefix ? `${prefix}/photos/` : "photos/";
  const objectName = `${photosPrefix}${key}.${ext}`;
  const file = bucket.file(objectName);

  await file.save(buffer, {
    metadata: {
      contentType: ext === "png" ? "image/png" : "image/jpeg",
      metadata: { personName: name },
    },
  });
}

export interface SyncResult {
  synced: string[];
  failed: { name: string; reason: string }[];
  skipped: string[];
  total: number;
}

export async function syncPhotos(incrementalOnly = true): Promise<SyncResult> {
  logger.info("Starting photo sync...");

  const hierarchy = await fetchHierarchy();
  const allPeople = new Set<string>();
  for (const slm of hierarchy.slms) allPeople.add(slm);
  for (const flms of Object.values(hierarchy.slmToFlms)) {
    for (const flm of flms) allPeople.add(flm);
  }
  for (const reps of Object.values(hierarchy.flmToReps)) {
    for (const rep of reps) allPeople.add(rep);
  }

  const existing = incrementalOnly ? await getExistingPhotos() : new Set<string>();
  const toProcess = [...allPeople].filter((name) => !existing.has(name));

  if (toProcess.length === 0) {
    logger.info("All photos already synced, nothing to do");
    return { synced: [], failed: [], skipped: [...allPeople], total: allPeople.size };
  }

  logger.info({ count: toProcess.length }, "People missing photos, scanning Slack users by name...");

  const result: SyncResult = { synced: [], failed: [], skipped: [...existing], total: allPeople.size };
  const matched = new Map<string, SlackUser>();
  const toProcessSet = new Set(toProcess);

  try {
    await streamMatchSlackUsers(toProcessSet, (name, user) => {
      matched.set(name, user);
    });
  } catch (err: unknown) {
    const msg = errMsg(err);
    logger.error({ err: msg }, "Failed to scan Slack users");
    throw new Error(`Failed to scan Slack users: ${msg}`);
  }

  logger.info({ matched: matched.size, unmatched: toProcess.length - matched.size }, "Slack matching complete, downloading photos...");

  for (const name of toProcess) {
    const slackUser = matched.get(name);

    if (!slackUser) {
      result.failed.push({ name, reason: "No matching Slack user found" });
      continue;
    }

    const imageUrl = getBestProfileImage(slackUser);
    if (!imageUrl) {
      result.failed.push({ name, reason: "No profile image available" });
      continue;
    }

    const downloaded = await downloadImage(imageUrl);
    if (!downloaded) {
      result.failed.push({ name, reason: "Failed to download image" });
      continue;
    }

    try {
      await uploadPhoto(name, downloaded.buffer, downloaded.ext);
      result.synced.push(name);
    } catch (err: unknown) {
      result.failed.push({ name, reason: `Upload failed: ${errMsg(err)}` });
    }

    if (result.synced.length % 25 === 0 && result.synced.length > 0) {
      logger.info({ synced: result.synced.length, total: matched.size }, "Photo upload progress...");
    }
  }

  Object.keys(photoCache).forEach((k) => delete photoCache[k]);
  photoCacheTime = 0;

  logger.info(
    { synced: result.synced.length, failed: result.failed.length, skipped: result.skipped.length },
    "Photo sync complete",
  );

  return result;
}

/**
 * People who receive the sync-failure DM, from the comma-separated
 * SLACK_NOTIFY_NAMES env var (Slack display / real names). Unset => nobody is
 * notified, so no real name is hard-coded here.
 */
function slackNotifyNames(): string[] {
  return (process.env.SLACK_NOTIFY_NAMES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

let cachedSlackDmUserIds: string[] | null = null;

async function sendSlackDm(message: string): Promise<void> {
  try {
    const targetNames = slackNotifyNames();
    if (targetNames.length === 0) {
      logger.warn(
        "SLACK_NOTIFY_NAMES not configured — skipping Slack error notification DM",
      );
      return;
    }

    const client = await getUncachableSlackClient();

    if (!cachedSlackDmUserIds) {
      const found: string[] = [];
      await streamMatchSlackUsers(new Set(targetNames), (_name, user) => {
        found.push((user as SlackUser).id);
      });
      if (found.length === 0) {
        logger.warn(
          { targetNames },
          "Could not find any SLACK_NOTIFY_NAMES user in Slack for DM notification",
        );
        return;
      }
      cachedSlackDmUserIds = found;
    }

    const dmResult = await client.conversations.open({
      users: cachedSlackDmUserIds.join(","),
    });
    const channelId = dmResult.channel?.id;
    if (!channelId) {
      logger.warn("Could not open Slack DM channel — may need chat:write and im:write scopes on Slack connector");
      return;
    }

    await client.chat.postMessage({ channel: channelId, text: message });
    logger.info({ targetNames }, "Sent error notification DM via Slack");
  } catch (err: unknown) {
    logger.error(
      { err: errMsg(err) },
      "Failed to send Slack DM notification — ensure the Slack connector has chat:write and im:write scopes",
    );
  }
}

export function startNightlySync(): void {
  const HST_OFFSET_MS = 10 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const now = Date.now();
  const nowUTC = new Date(now);
  const hstMidnightToday = new Date(
    Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), nowUTC.getUTCDate()) + HST_OFFSET_MS,
  );
  let nextRun = hstMidnightToday.getTime();
  if (nextRun <= now) nextRun += DAY_MS;

  const msUntilFirst = nextRun - now;
  const hoursUntil = (msUntilFirst / (1000 * 60 * 60)).toFixed(1);
  logger.info({ nextRunUTC: new Date(nextRun).toISOString(), hoursUntil }, "Nightly photo sync scheduled");

  // Surface next Sunday-00:00-HST so the weekly opp review reset fire time is visible at deploy.
  let nextSunday = nextRun;
  while (honoluluDayOfWeek(new Date(nextSunday)) !== 0) {
    nextSunday += DAY_MS;
  }
  const hoursUntilSunday = ((nextSunday - now) / (1000 * 60 * 60)).toFixed(1);
  logger.info(
    { nextSundayResetUTC: new Date(nextSunday).toISOString(), hoursUntilSunday },
    "Weekly opp review reset scheduled",
  );

  setTimeout(() => {
    runNightlySync();
    setInterval(runNightlySync, DAY_MS);
  }, msUntilFirst);

  setTimeout(async () => {
    try {
      const scopeCheck = await checkSlackScopes();
      if (!scopeCheck.ok) {
        logger.warn(
          { missing: scopeCheck.missing, available: scopeCheck.scopes },
          "Slack connector is missing required scopes — DM notifications will not work until scopes are added",
        );
      } else {
        logger.info({ scopes: scopeCheck.scopes }, "Slack connector scope check passed");
      }
    } catch (err: unknown) {
      logger.warn({ err: errMsg(err) }, "Could not verify Slack connector scopes");
    }

    logger.info("Running initial photo sync on startup...");
    syncPhotos(true).catch((err: unknown) => {
      logger.error({ err: errMsg(err) }, "Initial photo sync failed");
    });
  }, 15000);
}

// Returns the day-of-week index (0 = Sunday … 6 = Saturday) in
// Pacific/Honolulu local time for the given instant. Honolulu observes no
// DST, so this is always UTC-10, but we go through Intl rather than a hard
// offset so any future ICANN/IANA change is picked up automatically.
export function honoluluDayOfWeek(now: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Pacific/Honolulu",
    weekday: "short",
  });
  const wk = fmt.format(now);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wk] ?? -1;
}

// Weekly opp review reset (Sunday 00:00 HST): clears reviewed_at on
// override rows for opps owned by reps whose SLM has the
// weeklyOppReviewReset preference set (default true when unset).
// Probability values are preserved; orphan-owner opps are skipped.
export function collectAllSlmNames(repToSlm: Record<string, string>): Set<string> {
  const out = new Set<string>();
  for (const slm of Object.values(repToSlm)) {
    if (slm) out.add(slm);
  }
  return out;
}

// Only strict `value === false` opts a SLM out; missing/unset rows default to opt-in.
export function computeEnabledReps(
  repToSlm: Record<string, string>,
  allSlmNames: Set<string>,
  prefRows: Array<{ hierarchyName: string | null; value: unknown }>,
): { enabledSlms: Set<string>; enabledReps: Set<string>; optedOutSlms: Set<string> } {
  const optedOutSlms = new Set<string>();
  for (const r of prefRows) {
    if (r.hierarchyName && r.value === false) optedOutSlms.add(r.hierarchyName);
  }
  const enabledSlms = new Set<string>();
  for (const name of allSlmNames) {
    if (!optedOutSlms.has(name)) enabledSlms.add(name);
  }
  const enabledReps = new Set<string>();
  for (const [rep, slm] of Object.entries(repToSlm)) {
    if (slm && enabledSlms.has(slm)) enabledReps.add(rep);
  }
  return { enabledSlms, enabledReps, optedOutSlms };
}

// Orphan opps (rep missing from live feed) are skipped, never reset.
export function filterOppsToReset(
  reviewedOppIds: string[],
  oppIdToRep: Record<string, string>,
  enabledReps: Set<string>,
): { oppIdsToReset: string[]; orphanCount: number; optedOutOppCount: number } {
  const oppIdsToReset: string[] = [];
  let orphanCount = 0;
  let optedOutOppCount = 0;
  for (const oppId of reviewedOppIds) {
    const rep = oppIdToRep[oppId];
    if (!rep) {
      orphanCount += 1;
      continue;
    }
    if (!enabledReps.has(rep)) {
      optedOutOppCount += 1;
      continue;
    }
    oppIdsToReset.push(oppId);
  }
  return { oppIdsToReset, orphanCount, optedOutOppCount };
}

// Injectable seam for the Sunday opp-review reset. Lets Task #149 race
// regression tests run without a real Postgres.
export interface SundayResetDeps {
  now: () => Date;
  loadHierarchy: () => Promise<{ repToSlm: Record<string, string> }>;
  loadPrefRows: () => Promise<Array<{ hierarchyName: string | null; value: unknown }>>;
  loadReviewedOverrides: (cutoff: Date) => Promise<Array<{ oppId: string }>>;
  loadOppOwners: () => Promise<Record<string, string>>;
  bulkResetReviewed: (oppIds: string[], cutoff: Date) => Promise<void>;
  invalidateCaches: () => void;
}

// Drizzle Update query builder for the cron's bulk reset. Extracted so a
// regression test can inspect the emitted SQL via `.toSQL()` and confirm the
// cutoff predicate (Task #149 fix) is actually present in production.
export function buildSundayBulkResetUpdate(oppIds: string[], cutoff: Date) {
  return db
    .update(oppProbabilityOverridesTable)
    .set({ reviewedAt: sql`NULL` })
    .where(
      and(
        inArray(oppProbabilityOverridesTable.oppId, oppIds),
        lte(oppProbabilityOverridesTable.reviewedAt, cutoff),
      ),
    );
}

export const realSundayResetDeps: SundayResetDeps = {
  now: () => new Date(),
  loadHierarchy: () => fetchHierarchy().then((h) => ({ repToSlm: h.repToSlm })),
  loadPrefRows: () =>
    db
      .select({
        hierarchyName: usersTable.hierarchyName,
        value: userPreferencesTable.value,
      })
      .from(userPreferencesTable)
      .innerJoin(usersTable, eq(userPreferencesTable.userId, usersTable.id))
      .where(
        and(
          eq(userPreferencesTable.key, "weeklyOppReviewReset"),
          isNotNull(usersTable.hierarchyName),
        ),
      ),
  loadReviewedOverrides: (cutoff) =>
    db
      .select({ oppId: oppProbabilityOverridesTable.oppId })
      .from(oppProbabilityOverridesTable)
      .where(
        and(
          isNotNull(oppProbabilityOverridesTable.reviewedAt),
          lte(oppProbabilityOverridesTable.reviewedAt, cutoff),
        ),
      ),
  loadOppOwners: async () => {
    const { getAllOpenOpportunities, getModsOpportunities } = await import("./sheets-data");
    const [openOpps, modsOpps] = await Promise.all([
      getAllOpenOpportunities(),
      getModsOpportunities(),
    ]);
    const oppIdToRep: Record<string, string> = {};
    for (const o of openOpps) {
      if (o.oppId) oppIdToRep[o.oppId] = o.rep;
    }
    for (const m of modsOpps.opportunities) {
      if (m.oppId) oppIdToRep[m.oppId] = m.rep;
    }
    return oppIdToRep;
  },
  bulkResetReviewed: async (oppIds, cutoff) => {
    await buildSundayBulkResetUpdate(oppIds, cutoff);
  },
  invalidateCaches: invalidateProbabilityCaches,
};

export async function runSundayOppReviewResetWithDeps(
  deps: SundayResetDeps,
): Promise<string | null> {
  const dow = honoluluDayOfWeek(deps.now());
  if (dow !== 0) {
    logger.info({ honoluluDay: dow }, "Weekly opp review reset skipped — not Sunday HST");
    return null;
  }

  // Race-safe cutoff: any PUT during the fetch below stamps reviewed_at > resetStart and is preserved by the UPDATE predicate.
  const resetStart = deps.now();

  try {
    const hierarchy = await deps.loadHierarchy();

    const allSlmNames = collectAllSlmNames(hierarchy.repToSlm);
    if (allSlmNames.size === 0) {
      logger.warn("Weekly opp review reset: hierarchy has no SLMs — nothing to do");
      return "Weekly Opp Review Reset: no SLMs found in hierarchy.";
    }

    const prefRows = await deps.loadPrefRows();

    const { enabledSlms, enabledReps, optedOutSlms } = computeEnabledReps(
      hierarchy.repToSlm,
      allSlmNames,
      prefRows,
    );

    if (enabledReps.size === 0) {
      logger.info(
        { optedOutSlmCount: optedOutSlms.size, totalSlms: allSlmNames.size },
        "Weekly opp review reset: no reps eligible (every SLM opted out)",
      );
      return `Weekly Opp Review Reset: every SLM (${allSlmNames.size}) opted out — no opps reset.`;
    }

    // Look up reviewed overrides at-or-before the cutoff; we filter against the live opp feed below.
    const allOverrides = await deps.loadReviewedOverrides(resetStart);

    if (allOverrides.length === 0) {
      logger.info("Weekly opp review reset: no reviewed overrides exist — nothing to clear");
      return `Weekly Opp Review Reset: no reviewed opps in DB.`;
    }

    const oppIdToRep = await deps.loadOppOwners();

    const { oppIdsToReset, orphanCount, optedOutOppCount } = filterOppsToReset(
      allOverrides.map((r) => r.oppId),
      oppIdToRep,
      enabledReps,
    );

    if (oppIdsToReset.length === 0) {
      logger.info(
        { orphanCount, optedOutOppCount, enabledRepCount: enabledReps.size },
        "Weekly opp review reset: no opps matched after filtering",
      );
      return `Weekly Opp Review Reset: 0 opps cleared (orphans=${orphanCount}, opted-out=${optedOutOppCount}).`;
    }

    await deps.bulkResetReviewed(oppIdsToReset, resetStart);

    deps.invalidateCaches();

    logger.info(
      {
        cleared: oppIdsToReset.length,
        enabledSlmCount: enabledSlms.size,
        optedOutSlmCount: optedOutSlms.size,
        enabledRepCount: enabledReps.size,
        orphanCount,
        optedOutOppCount,
      },
      "Weekly opp review reset complete",
    );
    return (
      `Weekly Opp Review Reset: cleared ${oppIdsToReset.length} opps across ` +
      `${enabledSlms.size}/${allSlmNames.size} SLMs ` +
      `(orphans skipped: ${orphanCount}, opted-out opps skipped: ${optedOutOppCount}).`
    );
  } catch (err: unknown) {
    logger.error({ err: errMsg(err), stack: errStack(err) }, "Weekly opp review reset failed");
    return `⚠️ *Weekly Opp Review Reset failed:* ${errMsg(err)}`;
  }
}

async function runSundayOppReviewReset(): Promise<string | null> {
  return runSundayOppReviewResetWithDeps(realSundayResetDeps);
}

async function runNightlySync(): Promise<void> {
  logger.info("Running nightly quota refresh + photo sync...");

  // Sunday-only weekly reset (no-ops on other days). Returns its own failure summary.
  const oppReviewSummary = await runSundayOppReviewReset();
  const oppReviewResetSection = oppReviewSummary
    ? `\n\n*Weekly Opp Review Reset:* ${oppReviewSummary}`
    : "";

  const hierarchy = await fetchHierarchy();
  const employeeIdToName: Record<string, string> = {};
  for (const [name, empId] of Object.entries(hierarchy.personToEmployeeId)) {
    if (empId) employeeIdToName[empId] = name;
  }
  await runNightlyQuotaRefresh(employeeIdToName, hierarchy.repToGroup);
  await runNightlyHolidayRefresh();

  // Goals tab finance.pps snapshot: refresh on the same nightly cadence so the
  // Goals sources stay current. Independent of the live quota pipeline; never
  // throws (errors are surfaced via getLastFinancePpsError).
  await refreshFinancePpsSnapshot();
  const financePpsError = getLastFinancePpsError();
  if (financePpsError) {
    logger.warn({ err: financePpsError }, "[Goals finance.pps] Nightly refresh error");
    clearLastFinancePpsError();
  }

  // Goals tab eRep multiplier snapshot: refresh on the same nightly cadence as
  // finance.pps so the Databricks-sourced eRep values stay current. Never throws
  // (errors/auth-fallback are surfaced via getLastErepError /
  // getLastErepFallbackWarning and reported in the Slack summary below).
  await refreshErepSnapshot();

  // Drop the dashboard's Goals-tab quota cache so the next pipeline request
  // rebuilds from the freshly-refreshed finance.pps + eRep snapshots.
  clearGoalsQuotaCache();

  // SCI-R (Re/Max CPDs) refresh on the nightly cadence so the dashboard
  // picks up newly-paid Re/Max deals without waiting for the in-memory
  // TTL to lapse. Cleared here; the next pipeline request repopulates.
  clearRemaxCpdsCache();

  // Anaplan Check Tool source: drop the in-memory snapshot so the next request
  // re-fetches the latest Anaplan reconciliation data from Databricks.
  clearAnaplanCache();

  const quotaError = getLastQuotaError();
  let quotaSection = "";
  if (quotaError) {
    quotaSection = `\n\n⚠️ *Databricks Quota Refresh Error:*\n${quotaError}`;
    clearLastQuotaError();
  }

  const quotaFallback = getLastQuotaFallbackWarning();
  let quotaFallbackSection = "";
  if (quotaFallback) {
    quotaFallbackSection = `\n\n⚠️ *Databricks Quota Auth Fallback:*\nQuota refresh succeeded via service principal OAuth fallback; ${quotaFallback}`;
    clearLastQuotaFallbackWarning();
  }

  const holidayError = getLastHolidayError();
  let holidaySection = "";
  if (holidayError) {
    holidaySection = `\n\n⚠️ *Databricks Holiday Refresh Error:*\n${holidayError}`;
    clearLastHolidayError();
  }

  const holidayFallback = getLastHolidayFallbackWarning();
  let holidayFallbackSection = "";
  if (holidayFallback) {
    holidayFallbackSection = `\n\n⚠️ *Databricks Holiday Auth Fallback:*\nHoliday refresh succeeded via service principal OAuth fallback; ${holidayFallback}`;
    clearLastHolidayFallbackWarning();
  }

  const erepError = getLastErepError();
  let erepSection = "";
  if (erepError) {
    logger.warn({ err: erepError }, "[Goals eRep] Nightly refresh error");
    erepSection = `\n\n⚠️ *Databricks eRep Refresh Error:*\n${erepError}`;
    clearLastErepError();
  }

  const erepFallback = getLastErepFallbackWarning();
  let erepFallbackSection = "";
  if (erepFallback) {
    erepFallbackSection = `\n\n⚠️ *Databricks eRep Auth Fallback:*\neRep refresh succeeded via service principal OAuth fallback; ${erepFallback}`;
    clearLastErepFallbackWarning();
  }

  try {
    const result = await syncPhotos(true);
    // Always surface the Sunday reset summary, even on a clean run.
    const hasOppResetSummary = oppReviewResetSection.length > 0;
    if (
      result.failed.length > 0 ||
      quotaError ||
      holidayError ||
      erepError ||
      quotaFallback ||
      holidayFallback ||
      erepFallback ||
      hasOppResetSummary
    ) {
      const failedList = result.failed
        .map((f) => `• ${f.name}: ${f.reason}`)
        .join("\n");
      let msg =
        `Nightly photo sync completed with ${result.failed.length} failures:\n\n` +
        `Synced: ${result.synced.length}\n` +
        `Failed: ${result.failed.length}\n` +
        `Skipped (already had photo): ${result.skipped.length}`;
      if (result.failed.length > 0) msg += `\n\nFailed reps:\n${failedList}`;
      msg += quotaSection;
      msg += quotaFallbackSection;
      msg += holidaySection;
      msg += holidayFallbackSection;
      msg += erepSection;
      msg += erepFallbackSection;
      msg += oppReviewResetSection;
      await sendSlackDm(msg);
    }
  } catch (err: unknown) {
    logger.error({ err: errMsg(err) }, "Nightly photo sync error");
    const msg =
      `Nightly photo sync failed with error:\n\n${errMsg(err)}\n\n` +
      `Stack: ${errStack(err)}` +
      quotaSection +
      quotaFallbackSection +
      holidaySection +
      holidayFallbackSection +
      erepSection +
      erepFallbackSection +
      oppReviewResetSection;
    await sendSlackDm(msg);
  }
}
