// Fake Salesforce pages for the public demo (Task #9).
//
// In the demo build every "open in Salesforce" link the frontend renders is
// same-origin (see data-app/src/lib/sf-links.ts: with no VITE_SF_* env vars the
// base URL is empty, so classic links become `/<id>` and Lightning links become
// `/lightning/r/<Object>/<id>/view`). This module mounts DEMO_MODE-only routes
// that catch those URLs and render a minimal one-card HTML page:
//
//   "<Name> — Salesforce <Type>"
//
// The record type is classified from the Salesforce id key prefix (006 = Opp,
// 001 = Account, 00O = Report, a6B = CPD/Compensation__c, 003 = Contact, ...).
// The display name is best-effort resolved from the bundled demo snapshot
// (Pipeline / On-Demand sheet CSVs for opps & accounts, the frontline_dash_cpds
// Databricks capture for CPDs & contacts), falling back to a generic label.
//
// Route-order contract: mounted AFTER the /api router and BEFORE
// installStaticFrontend, and every route matches only Salesforce-shaped paths
// (bare 15/18-char alphanumeric ids or /lightning/...), so neither the API nor
// the SPA catch-all is shadowed. In live mode installFakeCrm is a no-op and
// none of these routes exist.

import type { Express, Request, Response } from "express";
import { isDemoMode, demoSnapshotPayload } from "./demo-mode";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Record-type classification by id key prefix
// ---------------------------------------------------------------------------

const KEY_PREFIX_TYPES: Record<string, string> = {
  "001": "Account",
  "003": "Contact",
  "006": "Opportunity",
  "00O": "Report",
  "00T": "Task",
  "500": "Case",
  "701": "Campaign",
  a6B: "CPD",
};

function typeForId(id: string): string {
  return KEY_PREFIX_TYPES[id.slice(0, 3)] ?? "Record";
}

/** Human label for a Lightning sObject API name, e.g. Gong__Gong_Call__c. */
function typeForObject(object: string): string {
  if (object === "Compensation__c") return "CPD";
  return object
    .replace(/__c$/i, "")
    .replace(/__/g, " ")
    .replace(/_/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Name lookup from the bundled demo snapshot
// ---------------------------------------------------------------------------

/** Minimal quote-aware CSV line split (mirrors sheets-data's parseCSVLine). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// id -> display name, keyed by the 15-char prefix. The anonymized demo ids are
// random strings, so the deterministic 15→18 checksum does NOT hold between a
// record's 15- and 18-char forms; the only safe join is the 15-char prefix
// (same convention as the Databricks enrichment join). Built lazily on first
// lookup; the snapshot is frozen, so a one-time build is always current.
let nameIndex: Map<string, string> | null = null;

/** 15-char-prefix lookup key for a Salesforce-shaped id, or null. */
function idKey(rawId: string): string | null {
  const id = (rawId || "").trim();
  if (!/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(id)) return null;
  return id.slice(0, 15);
}

function addName(index: Map<string, string>, rawId: string, name: string): void {
  const key = idKey(rawId);
  const n = name.trim();
  if (!key || !n || index.has(key)) return;
  index.set(key, n);
}

/** Index a Pipeline-shaped sheet CSV: opp/account ids -> names. */
function indexSheetCsv(index: Map<string, string>, csv: string): void {
  const lines = csv.split(/\r?\n/);
  // The feeder sheets may carry preamble rows; find the header row.
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (lines[i].includes("Opportunity ID")) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx < 0) return;
  const header = splitCsvLine(lines[headerRowIdx]).map((h) => h.trim());
  const col = (...names: string[]): number => {
    for (const n of names) {
      const idx = header.indexOf(n);
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const oppId = col("Opportunity ID (18-digit)", "Opportunity ID");
  const oppName = col("Opportunity Name");
  const acctId = col("Account ID (18-digit)", "Account ID");
  const acctName = col("Account Name");
  if (oppId < 0 && acctId < 0) return;
  for (let i = headerRowIdx + 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cols = splitCsvLine(lines[i]);
    if (oppId >= 0 && oppName >= 0 && cols[oppId]) {
      addName(index, cols[oppId], cols[oppName] ?? "");
    }
    if (acctId >= 0 && acctName >= 0 && cols[acctId]) {
      addName(index, cols[acctId], cols[acctName] ?? "");
    }
  }
}

function buildNameIndex(): Map<string, string> {
  const index = new Map<string, string>();
  try {
    const payload = demoSnapshotPayload();
    // Opps & accounts: the Pipeline and On-Demand feeder sheets.
    for (const [key, csv] of Object.entries(payload.sheets)) {
      if (
        key.startsWith("demo-sheet-pipeline:") ||
        key.startsWith("demo-sheet-ondemand:")
      ) {
        indexSheetCsv(index, csv);
      }
    }
    // CPDs & contacts: the frontline_dash_cpds capture. Column order matches
    // the SELECT in databricks-remax-cpds.ts: contact_name, sf_contact_id,
    // sf_cpd_id, ...
    for (const [key, capture] of Object.entries(payload.databricks)) {
      if (!key.includes("frontline_dash_cpds")) continue;
      for (const row of capture.data_array ?? []) {
        const contactName = (row[0] ?? "").toString();
        addName(index, (row[1] ?? "").toString(), contactName);
        addName(index, (row[2] ?? "").toString(), contactName);
      }
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[Demo] Fake-CRM name index build failed — serving generic labels",
    );
  }
  logger.info({ records: index.size }, "[Demo] Fake-CRM name index built");
  return index;
}

function lookupName(id: string): string | null {
  if (!nameIndex) nameIndex = buildNameIndex();
  const key = idKey(id);
  return (key && nameIndex.get(key)) || null;
}

// ---------------------------------------------------------------------------
// Page rendering
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRecordPage(res: Response, id: string, type: string): void {
  const name = lookupName(id);
  const title = name
    ? `${name} — Salesforce ${type}`
    : `Salesforce ${type} ${id}`;
  const heading = escapeHtml(name ?? `Salesforce ${type}`);
  res
    .status(200)
    .type("html")
    .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #f3f3f3; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #181818; }
  .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.08);
          padding: 32px 40px; max-width: 560px; width: calc(100% - 48px); }
  .kicker { display: flex; align-items: center; gap: 10px; color: #706e6b; font-size: 13px; margin-bottom: 10px; }
  .cloud { width: 34px; height: 22px; border-radius: 11px; background: #00a1e0; position: relative; flex: none; }
  h1 { font-size: 22px; margin: 0 0 6px; font-weight: 600; }
  .sub { color: #706e6b; font-size: 14px; margin: 0 0 18px; }
  code { background: #f3f3f3; border: 1px solid #e5e5e5; border-radius: 4px; padding: 2px 6px; font-size: 13px; }
  .note { margin-top: 20px; padding-top: 14px; border-top: 1px solid #eee; color: #706e6b; font-size: 12px; }
</style>
</head>
<body>
  <div class="card">
    <div class="kicker"><span class="cloud"></span>Salesforce ${escapeHtml(type)}</div>
    <h1>${heading}</h1>
    <p class="sub">Salesforce ${escapeHtml(type)} &middot; <code>${escapeHtml(id)}</code></p>
    <div class="note">This is a simulated Salesforce page in the public demo. In a live deployment this link opens the real record in your Salesforce org.</div>
  </div>
</body>
</html>`);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const SF_ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

/** First Salesforce-id-shaped token in a string, or null. */
function extractId(s: string): string | null {
  const m = s.match(/[a-zA-Z0-9]{18}|[a-zA-Z0-9]{15}/);
  return m ? m[0] : null;
}

/**
 * Mount the demo fake-CRM routes. Call AFTER the /api router and BEFORE
 * installStaticFrontend. No-op outside DEMO_MODE.
 */
export function installFakeCrm(app: Express): void {
  if (!isDemoMode()) return;

  // Lightning record URL: /lightning/r/<Object>/<id>/view
  app.get(
    /^\/lightning\/r\/([^/]+)\/([a-zA-Z0-9]{15,18})\/view\/?$/,
    (req: Request, res: Response) => {
      const object = decodeURIComponent(req.params[0]);
      const id = req.params[1];
      const type = object === "Report" ? "Report" : typeForObject(object);
      renderRecordPage(res, id, type || typeForId(id));
    },
  );

  // Lightning classic shell: /lightning/_classic/%2F<id> (id URL-encoded).
  // Plus a generic catch-all for any other /lightning/... shape so no demo
  // Salesforce link can dead-end.
  app.get(/^\/lightning(\/.*)?$/, (req: Request, res: Response) => {
    let rest = req.params[0] ?? "";
    try {
      rest = decodeURIComponent(rest);
    } catch {
      /* keep raw */
    }
    const id = extractId(rest);
    if (id) {
      renderRecordPage(res, id, typeForId(id));
    } else {
      renderRecordPage(res, "unknown", "Record");
    }
  });

  // Classic record URL: /<15-or-18-char-id>. The strict shape (exactly 15 or
  // 18 alphanumerics) cannot collide with any SPA route or static asset.
  app.get(/^\/([a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})$/, (req: Request, res: Response) => {
    const id = req.params[0];
    if (!SF_ID_RE.test(id)) {
      res.status(404).send("Not found");
      return;
    }
    renderRecordPage(res, id, typeForId(id));
  });

  logger.info("[Demo] Fake Salesforce CRM routes mounted");
}
