// Salesforce deep-link builders.
//
// Every Salesforce URL the dashboard renders is derived from this module so no
// org-specific host or report id is hard-coded anywhere in the source. The
// three inputs come from Vite env vars, baked in at build time:
//
//   VITE_SF_BASE_URL          Lightning host, e.g. https://acme.lightning.force.com
//   VITE_SF_CLASSIC_BASE_URL  Classic host,   e.g. https://acme.my.salesforce.com
//   VITE_SF_REPORTS           JSON string of report ids, keys listed in
//                             SF_REPORT_KEYS below.
//
// When they are unset (the public demo build) every link points at an
// obviously-fake placeholder org, so the UI keeps its "open in Salesforce"
// affordances without exposing anything real.

const DEMO_BASE = "https://demo-crm.example.com";
const DEMO_REPORT_ID = "00ODEMO000000000AA";

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Lightning base host, no trailing slash. */
export const sfBaseUrl: string = stripTrailingSlash(
  (import.meta.env.VITE_SF_BASE_URL as string | undefined)?.trim() || DEMO_BASE,
);

/** Classic base host, no trailing slash. Record ids append as `/<id>`. */
export const sfClassicBaseUrl: string = stripTrailingSlash(
  (import.meta.env.VITE_SF_CLASSIC_BASE_URL as string | undefined)?.trim() ||
    DEMO_BASE,
);

export type SfReportKey =
  | "dials"
  | "demosClassic"
  | "sbrs"
  | "emails"
  | "opps"
  | "ccDeclinesClassic"
  | "inbounds"
  // Scheduled-modifications report. Optional in VITE_SF_REPORTS — falls back to
  // the placeholder id when absent.
  | "mods";

const SF_REPORT_KEYS: SfReportKey[] = [
  "dials",
  "demosClassic",
  "sbrs",
  "emails",
  "opps",
  "ccDeclinesClassic",
  "inbounds",
  "mods",
];

function parseReportIds(): Record<SfReportKey, string> {
  const out = {} as Record<SfReportKey, string>;
  for (const k of SF_REPORT_KEYS) out[k] = DEMO_REPORT_ID;
  const raw = (import.meta.env.VITE_SF_REPORTS as string | undefined)?.trim();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const k of SF_REPORT_KEYS) {
      const v = parsed[k];
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
  } catch {
    // Malformed env value: keep the placeholder ids rather than breaking render.
  }
  return out;
}

/** Report id per logical report. Placeholder ids when VITE_SF_REPORTS is unset. */
export const sfReportIds: Record<SfReportKey, string> = parseReportIds();

/** Lightning report viewer URL: `<base>/lightning/r/Report/<id>/view`. */
export function sfReportUrl(key: SfReportKey): string {
  return `${sfBaseUrl}/lightning/r/Report/${sfReportIds[key]}/view`;
}

/**
 * Classic report URL wrapped in the Lightning shell:
 * `<base>/lightning/_classic/%2F<id>`. Used by the couple of reports that only
 * render correctly in Classic.
 */
export function sfClassicReportUrl(key: SfReportKey): string {
  return `${sfBaseUrl}/lightning/_classic/%2F${sfReportIds[key]}`;
}

/** Lightning record root: `<base>/lightning/r` (append `/<Object>/<id>/view`). */
export const sfLightningBase: string = `${sfBaseUrl}/lightning/r`;

/** Lightning record URL for an sObject: `<base>/lightning/r/<object>/<id>/view`. */
export function sfRecordUrl(object: string, id: string): string {
  return `${sfLightningBase}/${object}/${id}/view`;
}

/** Classic record URL: `<classicBase>/<id>`. */
export function sfClassicRecordUrl(id: string): string {
  return `${sfClassicBaseUrl}/${id}`;
}
