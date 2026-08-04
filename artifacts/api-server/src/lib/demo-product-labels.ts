// Demo-mode product display labels.
//
// The public demo must not show real product names anywhere a user can see
// them (UI labels, drilldown data, CSV exports). The engine keeps computing
// with the canonical internal names — renaming the values the engine matches
// on would silently break product attribution (rules, goals, comp all key on
// canonical names). Instead, this single source-of-truth map is exposed to
// the frontend via /api/sales/config (only when DEMO_MODE=1) and every
// product-label render site translates at display time.
//
// The anonymizer script (scripts/anonymize-demo-data.ts) imports this same
// map when rewriting opportunity names, so the mapping is never duplicated.

export interface DemoProductLabel {
  /** Demo-facing full display name. */
  name: string;
  /** Demo-facing abbreviation (used wherever the UI shows SC/FUB/etc.). */
  abbrev: string;
}

/**
 * Canonical internal product name -> demo display label.
 * Keys cover the canonical engine outputs plus raw sheet variants that can
 * surface in user-visible fields (drilldown "Product" columns, tooltips).
 */
export const DEMO_PRODUCT_LABELS: Record<string, DemoProductLabel> = {
  // Canonical engine products
  "MBP": { name: "Legacy Advertising Product", abbrev: "LAP" },
  "Showcase": { name: "Marketing Subscription", abbrev: "MKT" },
  "Showcase Incremental": { name: "Marketing Adhoc Purchases", abbrev: "MKT-A" },
  "Showcase Incremental - Re/Max": { name: "Marketing Adhoc: Enterprise", abbrev: "MKT-E" },
  "Overage": { name: "Marketing Adhoc Overage Credits", abbrev: "MKT-O" },
  "Zillow Pro": { name: "Platform Subscription", abbrev: "PS" },
  "Follow Up Boss": { name: "CRM Product", abbrev: "CRM" },
  "ZMX": { name: "Photography Product", abbrev: "PP" },
  // Internal abbreviations/aliases that can appear in rendered text
  "SCV4": { name: "Marketing Subscription", abbrev: "MKT" },
  // Raw sheet/product-column variants that can appear in user-visible data
  "Market Based Pricing": { name: "Legacy Advertising Product", abbrev: "LAP" },
  "Premier Agent Program": { name: "Legacy Advertising Product", abbrev: "LAP" },
  "Showcase Listing Ad Hoc": { name: "Marketing Adhoc Purchases", abbrev: "MKT-A" },
  "Showcase Cancellation": { name: "Marketing Subscription Cancellation", abbrev: "MKT" },
  "ShowingTimePlus Showcase": { name: "Marketing Subscription Plus", abbrev: "MKT+" },
  "ShowingTimePlus ShowCase": { name: "Marketing Subscription Plus", abbrev: "MKT+" },
  "ShowingTimePlus Showcase; Zillow Pro": { name: "Marketing Subscription Plus + Platform Subscription", abbrev: "MKT+PS" },
};
