// Product display-label translation (public demo anonymization).
//
// In DEMO_MODE the server exposes `demoProductLabels` on /api/sales/config:
// canonical internal product name -> { name, abbrev }. All product-label
// RENDER sites route through the helpers below so the demo shows anonymized
// product names while every piece of state, filtering, and data keying keeps
// using the canonical names (renaming those would silently break attribution
// and color/goal lookups).
//
// Outside the demo the registry is empty and every helper is a no-op
// passthrough, so the internal dashboard is visually unchanged.

export interface ProductLabel {
  name: string;
  abbrev: string;
}

let registry: Record<string, ProductLabel> = {};
// Longest-first canonical names, for substring replacement in free text.
let textPatterns: Array<{ re: RegExp; name: string }> = [];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Called once when /api/sales/config resolves (Dashboard). Idempotent. */
export function registerProductLabels(map: Record<string, ProductLabel> | undefined | null): void {
  registry = map ?? {};
  textPatterns = Object.entries(registry)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([canonical, label]) => ({
      re: new RegExp(escapeRe(canonical), "gi"),
      name: label.name,
    }));
}

/** True when a demo label map is active. */
export function hasProductLabelOverrides(): boolean {
  return textPatterns.length > 0;
}

/** Display name for a product (exact canonical match; passthrough otherwise). */
export function displayProduct(product: string | null | undefined): string {
  if (product == null) return "";
  return registry[product]?.name ?? product;
}

/**
 * Display abbreviation for a product. `fallback` is the existing local
 * abbreviation lookup result so non-demo behavior is byte-identical.
 */
export function displayProductAbbrev(product: string | null | undefined, fallback: string): string {
  if (product == null) return fallback;
  return registry[product]?.abbrev ?? fallback;
}

/**
 * Replace product-name substrings inside free text (tooltips, legends,
 * descriptions that mention products in prose). No-op outside the demo.
 */
export function displayProductText(text: string | null | undefined): string {
  if (text == null) return "";
  if (textPatterns.length === 0) return text;
  let out = text;
  for (const { re, name } of textPatterns) out = out.replace(re, name);
  return out;
}
