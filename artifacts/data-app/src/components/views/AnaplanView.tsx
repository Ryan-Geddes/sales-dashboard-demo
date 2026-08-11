import React, { useMemo, useState, useRef, useLayoutEffect } from "react";
import { FilterState } from "../../pages/Dashboard";
import {
  AnaplanCheckResult,
  AnaplanCpdRow,
  AnaplanOppLine,
  AnaplanLineItem,
  AnaplanRawMrr,
} from "@workspace/api-client-react";
import {
  useDelayedTooltip,
  DelayedTooltipPortal,
} from "../../hooks/useDelayedTooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { passesChannelFilter, ALL_CHANNELS } from "@/lib/utils";
import { sfLightningBase } from "@/lib/sf-links";
import {
  displayProduct,
  displayProductText,
} from "@/lib/product-labels";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  ChevronRight,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Search,
  SlidersHorizontal,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Info,
  Pin,
  PinOff,
} from "lucide-react";

// Salesforce Lightning links. CPD ids point at the Compensation__c record; the
// Opportunities cell links the first opp's account, opp rows link the opp.
const SF_LIGHTNING = sfLightningBase;
const cpdLink = (id: string) => `${SF_LIGHTNING}/Compensation__c/${id}/view`;
const accountLink = (id: string) => `${SF_LIGHTNING}/Account/${id}/view`;
const oppLink = (id: string) => `${SF_LIGHTNING}/Opportunity/${id}/view`;

// Route any Salesforce id to its Lightning object URL by id prefix. Anaplan's
// opportunity_ids mix real Opportunity ids (006…) with CPD ids: `a6B…` =
// Compensation_Product_Detail__c, `a6W…` = Compensation__c. The collapsed
// summary also links account/contact ids (001…/003…). Re/Max & ZMX CPD rows now
// carry bare Salesforce ids (no prefix). A defensive generic `word:` prefix
// strip is kept in case any other synthetic-prefixed id flows through here.
// Returns null when the id isn't a linkable SF object, so callers can fall back
// to plain text. This makes even genuinely-unresolved ids clickable (they still
// read as "not found").
const sfObjectLink = (rawId: string | undefined | null): string | null => {
  const id = (rawId || "").trim().replace(/^[a-z][a-z-]*:/i, "");
  if (!id) return null;
  const prefix = id.slice(0, 3);
  if (prefix === "006") return oppLink(id);
  if (prefix === "a6B")
    return `${SF_LIGHTNING}/Compensation_Product_Detail__c/${id}/view`;
  if (prefix === "a6W") return cpdLink(id);
  if (prefix === "001") return accountLink(id);
  if (prefix === "003") return `${SF_LIGHTNING}/Contact/${id}/view`;
  return null;
};

// Render `label` as a prefix-routed Salesforce hyperlink, or as plain text when
// the id has no linkable form. `className` carries the color/truncate styling;
// hover:underline is added only when it becomes a link.
function IdLink({
  id,
  label,
  className,
}: {
  id: string | undefined | null;
  label: string;
  className: string;
}) {
  const href = sfObjectLink(id);
  if (!href) return <span className={className}>{label}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${className} hover:underline`}
    >
      {label}
    </a>
  );
}

const NOT_FOUND_LABEL = "(opp_id not found)";

// Task #475: tooltip shown on opp/line rows that the Acquisition churn gate
// dropped from Quota Target MRR. They are rendered bright red.
const ACQ_CHURN_TOOLTIP =
  "Excluded by Acquisition Churn Logic: Acquisitions only counts same month churn by rep/account/product/close month";
const ACQ_CHURN_RED = "text-red-600 dark:text-red-500";

const fmtMoney = (val: number): string => {
  const sign = val < 0 ? "-" : "";
  return `${sign}$${Math.abs(val).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

// Human-readable labels for the feeder MrrField codes, mirroring the funnel
// drilldown's MRR_FIELD_LABELS.
const MRR_FIELD_LABELS: Record<string, string> = {
  changeInMrr: "Change in MRR",
  totalMrr: "Total MRR",
  splitTotalPrice: "Split Total Price",
  totalPrice: "Total Price",
  amount: "Amount",
  mrr: "MRR",
};

// The six raw feeder-sheet MRR columns shown to the LEFT of Matched Quota Target
// MRR, in display order.
const RAW_MRR_COLS: { key: keyof AnaplanRawMrr; label: string }[] = [
  { key: "changeInMrr", label: "Change in MRR" },
  { key: "totalMrr", label: "Total MRR" },
  { key: "splitTotalPrice", label: "Split Total Price" },
  { key: "totalPrice", label: "Total Price" },
  { key: "amount", label: "Amount" },
  { key: "mrr", label: "MRR" },
];

// Highlight colors: the product-logic base MRR field is sky; the rule-applied
// override field is amber (a rule override "wins" the cell when both apply).
const BASE_CELL_CLASS =
  "bg-sky-100 dark:bg-sky-950/50 text-sky-900 dark:text-sky-200 font-medium";
const OVERRIDE_CELL_CLASS =
  "bg-amber-100 dark:bg-amber-950/50 text-amber-900 dark:text-amber-200 font-medium";

const ZERO_RAW_MRR: AnaplanRawMrr = {
  changeInMrr: 0,
  totalMrr: 0,
  splitTotalPrice: 0,
  totalPrice: 0,
  amount: 0,
  mrr: 0,
};

// Sum each raw feeder MRR column across a set of opps (for the CPD-level row).
// `rawMrr` is guarded against missing/stale payloads (e.g. a cached pre-upgrade
// response) so the view never crashes.
function sumRawMrr(opps: AnaplanOppLine[]): AnaplanRawMrr {
  const acc: AnaplanRawMrr = { ...ZERO_RAW_MRR };
  for (const o of opps) {
    const raw = o.rawMrr ?? ZERO_RAW_MRR;
    for (const { key } of RAW_MRR_COLS) acc[key] += raw[key] ?? 0;
  }
  return acc;
}

// All line items across a set of opps, for base/override highlight aggregation.
function allLineItems(opps: AnaplanOppLine[]): AnaplanLineItem[] {
  return opps.flatMap((o) => o.lineItems);
}

// Task #531: human-readable Multipliers text, mirroring the drilldown's
// semantics — a paired-opp adjustment label wins (e.g. "zpro: × 0.1"),
// otherwise each DISTINCT decimal multiplier is listed once ("0.1x"),
// otherwise "1x" when nothing applied.
function multipliersTextFor(items: AnaplanLineItem[]): string {
  const labels = uniq(
    items.map((li) => li.pairAdjustmentLabel ?? "").filter((s) => s !== ""),
  );
  if (labels.length > 0) return labels.join(", ");
  const distinct = [...new Set(items.flatMap((li) => li.multipliers))];
  if (distinct.length === 0) return "1x";
  return distinct.map((m) => `${m}x`).join(", ");
}

interface FieldInfo {
  baseFields: Set<string>;
  overrideFields: Set<string>;
  winners: Set<string>;
  ruleLabels: Set<string>;
  // Distinct Product Logic rule names + 1-based numbers that selected the base
  // MRR field across these line items (for the base-field "Product" tooltip).
  productLogics: Set<string>;
  productLogicNumbers: Set<number>;
}

// Collect base / override MRR-field metadata across a set of line items, so the
// raw-MRR cells can be highlighted and explained at the CPD / opp / line level.
function collectFieldInfo(lineItems: AnaplanLineItem[]): FieldInfo {
  const baseFields = new Set<string>();
  const overrideFields = new Set<string>();
  const winners = new Set<string>();
  const ruleLabels = new Set<string>();
  const productLogics = new Set<string>();
  const productLogicNumbers = new Set<number>();
  for (const li of lineItems) {
    if (li.baseMrrField) baseFields.add(li.baseMrrField);
    if (li.mrrFieldWinner) {
      if (li.effectiveMrrField) overrideFields.add(li.effectiveMrrField);
      winners.add(li.mrrFieldWinner);
    }
    for (const lbl of li.mrrFieldRuleLabels ?? []) ruleLabels.add(lbl);
    if (li.productLogicLabel) productLogics.add(li.productLogicLabel);
    if (li.productLogicNumber != null)
      productLogicNumbers.add(li.productLogicNumber);
  }
  return {
    baseFields,
    overrideFields,
    winners,
    ruleLabels,
    productLogics,
    productLogicNumbers,
  };
}

// Distinct, order-preserving string list.
const uniq = (arr: string[]): string[] => [...new Set(arr)];

// Distinct multipliers formatted "×1, ×2" (blank when none).
function fmtMultipliers(multipliers: number[]): string {
  return [...new Set(multipliers)].map((m) => `×${m}`).join(", ");
}

// Distinct Product Logic entries ("#3 ACQ Showcase") across a set of line
// items, sorted by rule number, for the Product Logic column + tooltip.
function productLogicEntries(lineItems: AnaplanLineItem[]): string[] {
  const seen = new Map<string, { num: number | null; text: string }>();
  for (const li of lineItems) {
    const label = li.productLogicLabel ?? "";
    const num = li.productLogicNumber ?? null;
    if (!label && num == null) continue;
    const key = `${num ?? ""}|${label}`;
    if (seen.has(key)) continue;
    const text = num != null ? `#${num} ${label}`.trim() : label;
    seen.set(key, { num, text });
  }
  return [...seen.values()]
    .sort((a, b) => (a.num ?? Infinity) - (b.num ?? Infinity))
    .map((e) => e.text);
}

// Build the mouse-following tooltip text for one raw-MRR cell. An amber
// (rule-applied) cell explains the rule override; a sky (product-logic base)
// cell explains which Product Logic rule selected the default field. All lists
// are de-duplicated to distinct values.
function rawTipFor(
  colKey: string,
  info: FieldInfo,
  ruleNames: string[],
  multipliers: number[],
): string {
  const isOverride = info.overrideFields.has(colKey);
  const isBase = info.baseFields.has(colKey);
  const baseLabels = [...info.baseFields].map((c) => MRR_FIELD_LABELS[c] ?? c);
  if (isOverride) {
    return [
      "MRR Field Applied by Rule",
      `Original Product Field: ${baseLabels.join(", ") || "—"}`,
      `Rules: ${uniq(ruleNames).join(", ") || "—"}`,
      `Multipliers: ${fmtMultipliers(multipliers) || "—"}`,
    ].join("\n");
  }
  if (isBase) {
    return [
      `Default MRR Field: ${baseLabels.join(", ") || "—"}`,
      `Product Logic: ${[...info.productLogics].join(", ") || "—"}`,
      `Product Logic #: ${
        [...info.productLogicNumbers].sort((a, b) => a - b).join(", ") || "—"
      }`,
    ].join("\n");
  }
  return "Not the compensable MRR field for this opp.";
}

interface AnaplanViewProps {
  loading: boolean;
  data?: AnaplanCheckResult;
  filters: FilterState;
}

function rowDiff(row: AnaplanCpdRow): number {
  return row.anaplanMrr - row.quotaTargetMrr;
}

function isMatch(row: AnaplanCpdRow, delta: number): boolean {
  return Math.abs(rowDiff(row)) <= delta;
}

export default function AnaplanView({ loading, data, filters }: AnaplanViewProps) {
  const [matchDelta, setMatchDelta] = useState(1);
  const [search, setSearch] = useState("");
  const [onlyCpdsMissingOpps, setOnlyCpdsMissingOpps] = useState(false);
  const [onlyOppsMissingCpds, setOnlyOppsMissingCpds] = useState(false);
  // Task #563: keep only CPDs with at least one opp line touched by the ACQ
  // same-month churn gate (excluded by it, or rescued via "Ignore ACQ Churn
  // Logic"). Client-side, ANDed with every other filter.
  const [onlyAcqChurn, setOnlyAcqChurn] = useState(false);
  const [selectedRuleNames, setSelectedRuleNames] = useState<string[]>([]);
  // "Filter Anaplan Users": scope CPD rows by whether their Owner is a member
  // of the month-scoped effective hierarchy (server-stamped ownerInHierarchy).
  // Blank-owner rows (ownerInHierarchy == null) always pass every mode.
  const [ownerHierarchyMode, setOwnerHierarchyMode] = useState<
    "all" | "in" | "out"
  >("all");
  // Dynamic extra source columns toggled on from data.allColumns. Empty = none.
  const [extraCols, setExtraCols] = useState<Set<string>>(new Set());
  const [expandedCpds, setExpandedCpds] = useState<Set<string>>(new Set());
  const [expandedOpps, setExpandedOpps] = useState<Set<string>>(new Set());
  // Task #524: opp rows whose paired-opp partner rows are expanded (keyed like
  // expandedOpps), mirroring the pipeline drilldown's linked-opp expansion.
  const [expandedPairs, setExpandedPairs] = useState<Set<string>>(new Set());
  // Column sort. sortKey is "" (no sort), a fixed column key, or "col:<name>"
  // for a dynamic source column. Toggling the active key flips the direction.
  const [sortKey, setSortKey] = useState<string>("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // Task #509: freeze (pin) the reconciliation table header so both header rows
  // stay visible while scrolling the long CPD/opp list. Default unfrozen.
  const [frozenHeader, setFrozenHeader] = useState(false);
  // Toggle visibility of the 6 raw Salesforce MRR columns and the Multipliers
  // column (display-only; CSV export always includes them).
  const [showRawMrr, setShowRawMrr] = useState(false);
  const [showMultipliers, setShowMultipliers] = useState(true);
  // Measured height of the grouping super-header row so the main column-label
  // row can stick directly beneath it when the header is frozen.
  const superHeaderRef = useRef<HTMLTableRowElement>(null);
  const [superHeaderH, setSuperHeaderH] = useState(0);

  const rows = data?.rows ?? [];
  const allColumns = data?.allColumns ?? [];

  // All distinct rule names present across every opp line, for the rule filter.
  const allRuleNames = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) {
      for (const o of r.opps) for (const rn of o.ruleNames) s.add(rn);
    }
    return Array.from(s).sort();
  }, [rows]);

  // Whether any header dimension filter is active. When none are, every CPD
  // passes (no scoping) — matching how the rest of the dashboard behaves.
  const dimActive =
    filters.slm.length > 0 ||
    filters.flm.length > 0 ||
    filters.rep.length > 0 ||
    filters.region.length > 0 ||
    filters.segment.length > 0 ||
    filters.group !== ALL_CHANNELS ||
    filters.products.length > 0;

  // Per-opp header-filter predicate, mirroring the drilldown modals: an opp's
  // org-hierarchy dims (slm/flm/rep/region/segment/group) and product(s) must
  // match the active header filters.
  const oppPasses = useMemo(() => {
    return (o: AnaplanOppLine): boolean => {
      if (filters.slm.length > 0 && !filters.slm.includes(o.slm)) return false;
      if (filters.flm.length > 0 && !filters.flm.includes(o.flm)) return false;
      if (filters.rep.length > 0 && !filters.rep.includes(o.rep)) return false;
      if (filters.region.length > 0 && !filters.region.includes(o.region))
        return false;
      if (filters.segment.length > 0 && !filters.segment.includes(o.segment))
        return false;
      if (!passesChannelFilter(o.group, filters.group)) return false;
      if (filters.products.length > 0) {
        const prods = [o.product, ...o.lineItems.map((li) => li.product)];
        if (!prods.some((p) => filters.products.includes(p))) return false;
      }
      return true;
    };
  }, [filters]);

  // Per-rule opp counts for the rule multi-select, mirroring the funnel
  // drilldown's facet badges: each opp is counted once per distinct rule, and
  // the counts respect the active header dimension filters but NOT the rule
  // selection itself (so every rule keeps a stable badge as you toggle).
  const ruleCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      for (const o of r.opps) {
        if (dimActive && !oppPasses(o)) continue;
        const seen = new Set<string>();
        for (const rn of o.ruleNames) {
          if (seen.has(rn)) continue;
          seen.add(rn);
          m.set(rn, (m.get(rn) ?? 0) + 1);
        }
      }
    }
    return m;
  }, [rows, dimActive, oppPasses]);

  const toggleRule = (rn: string) =>
    setSelectedRuleNames((prev) =>
      prev.includes(rn) ? prev.filter((x) => x !== rn) : [...prev, rn]
    );

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  // Renders a sortable header cell. Clicking sets/toggles the active sort key
  // and shows a direction caret on the active column.
  const sortTh = (
    key: string,
    label: string,
    align: "left" | "right" | "center" = "left",
    emphasize = false,
    extraClass = ""
  ) => (
    <th
      className={`px-2 py-2 ${extraClass} ${
        align === "right"
          ? "text-right"
          : align === "center"
            ? "text-center"
            : "text-left"
      }`}
    >
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${
          emphasize ? "font-bold text-foreground" : ""
        }`}
      >
        {label}
        {sortKey === key && (
          <span className="text-[9px]">{sortDir === "asc" ? "▲" : "▼"}</span>
        )}
      </button>
    </th>
  );

  // Fallback header-filter predicate for an opp-less CPD (one with no found
  // opportunity to supply dims). The server derives each CPD's fallback dims
  // from its own fields plus the owner's rep-hierarchy entry (unresolved dims
  // become the literal "None"), so the same header filters that narrow normal
  // opps can narrow these CPDs too instead of dropping them.
  const cpdFallbackPasses = useMemo(() => {
    return (r: AnaplanCpdRow): boolean => {
      const fb = r.fallbackDims;
      if (filters.slm.length > 0 && !filters.slm.includes(fb.slm)) return false;
      if (filters.flm.length > 0 && !filters.flm.includes(fb.flm)) return false;
      if (filters.rep.length > 0 && !filters.rep.includes(fb.rep)) return false;
      if (filters.region.length > 0 && !filters.region.includes(fb.region))
        return false;
      if (filters.segment.length > 0 && !filters.segment.includes(fb.segment))
        return false;
      if (!passesChannelFilter(fb.group, filters.group)) return false;
      if (filters.products.length > 0 && !filters.products.includes(fb.product))
        return false;
      return true;
    };
  }, [filters]);

  const matchesSearch = (r: AnaplanCpdRow, q: string): boolean => {
    if (!q) return true;
    const hay = [
      r.cpdId,
      r.owner,
      r.slm,
      r.partnerName,
      ...r.opps.map(
        (o) => `${o.oppId} ${o.oppName} ${o.accountName} ${o.rep} ${o.product}`
      ),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  };

  // Header dimension filters narrow which CPD rows are VISIBLE (spec: "header
  // filters still narrow results"). A CPD is the atomic reconciliation unit
  // (Anaplan MRR is per-CPD, matched against ΣQuotaTarget over the whole CPD),
  // so a CPD is shown when ANY of its opps passes the active dimensions and its
  // per-CPD Anaplan/Quota totals are kept intact (never recomputed from the
  // narrowed opp subset, which would manufacture false mismatches).
  // Rows passing every filter EXCEPT the "Filter Anaplan Users" dropdown. The
  // dropdown's per-option distinct-owner counts are computed from this set so
  // each count tells the user what selecting that option would show.
  const filteredRowsBase = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      // Opps in scope for the active header dimensions. The missing-opp and
      // rule-selection checks run against THIS subset (mirroring the funnel
      // drilldown) so a CPD can't pass on one opp matching the dimensions while
      // a different, out-of-scope opp satisfies the rule selection.
      const eligible = dimActive ? r.opps.filter(oppPasses) : r.opps;
      // A not-found opp has no matching dashboard row, so it carries blank
      // rep/product/SLM/region/segment/channel and can never pass a header
      // filter — it is always narrowed out of `eligible`. But a not-found opp is
      // exactly the signal the "CPDs missing opps" filter (and the summary count)
      // look for, so test it against the CPD's FULL opp list, not the narrowed
      // subset, to keep the two consistent.
      const hasMissingOpp = r.opps.some((o) => !o.found);
      // A CPD is "opp-less" when NONE of its opps was found among this month's
      // Closed Won rows, so it has no opp that can supply header dimensions.
      // Such a CPD is scoped by its server-derived fallback dims instead.
      const hasFoundOpp = r.opps.some((o) => o.found);
      // "CPDs missing opps" is a pure filter: when on, keep only CPDs with at
      // least one missing opp and hide the rest; when off, it hides nothing.
      if (onlyCpdsMissingOpps && !hasMissingOpp) return false;
      // "ACQ Churn": keep only CPDs where some opp line hit the ACQ churn
      // gate (dropped) or bypassed it via an Ignore ACQ Churn Logic rule.
      if (
        onlyAcqChurn &&
        !r.opps.some((o) => o.excludedByAcqChurn || o.acqChurnOverridden)
      )
        return false;
      // Header dimension scoping. When a filter is active, a CPD stays visible
      // if any of its dim-bearing opps passes. An opp-less CPD (no found opp)
      // has no such opp, so it is tested against its fallback dims instead of
      // being dropped — this is what keeps every CPD filterable by default.
      if (dimActive && eligible.length === 0) {
        if (hasFoundOpp) return false; // real opps exist, none matched
        if (!cpdFallbackPasses(r)) return false; // opp-less: fallback must pass
      }
      if (selectedRuleNames.length > 0) {
        const sel = new Set(selectedRuleNames);
        if (!eligible.some((o) => o.ruleNames.some((n) => sel.has(n))))
          return false;
      }
      if (!matchesSearch(r, q)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rows,
    search,
    onlyCpdsMissingOpps,
    onlyAcqChurn,
    selectedRuleNames,
    dimActive,
    oppPasses,
    cpdFallbackPasses,
  ]);

  // Distinct-owner counts for the "Filter Anaplan Users" dropdown, computed
  // from the rows passing all OTHER filters/search. Owners are normalized the
  // same way the server's Anaplan join normalizes names (trim, lowercase,
  // collapse whitespace); blank-owner rows are excluded from every count.
  const ownerHierarchyCounts = useMemo(() => {
    const all = new Set<string>();
    const inH = new Set<string>();
    const out = new Set<string>();
    for (const r of filteredRowsBase) {
      if (r.ownerInHierarchy == null) continue; // blank owner
      const key = (r.owner ?? "").trim().toLowerCase().replace(/\s+/g, " ");
      if (!key) continue;
      all.add(key);
      (r.ownerInHierarchy ? inH : out).add(key);
    }
    return { all: all.size, inHierarchy: inH.size, notInHierarchy: out.size };
  }, [filteredRowsBase]);

  // Visible CPD rows: the base filter set narrowed by the "Filter Anaplan
  // Users" mode. Blank-owner rows (ownerInHierarchy == null) always pass, so
  // they are shown in all three modes. Summary cards, counts and the CSV
  // export all derive from this set, so they follow the dropdown naturally.
  const filteredRows = useMemo(() => {
    if (ownerHierarchyMode === "all") return filteredRowsBase;
    const want = ownerHierarchyMode === "in";
    return filteredRowsBase.filter(
      (r) => r.ownerInHierarchy == null || r.ownerInHierarchy === want
    );
  }, [filteredRowsBase, ownerHierarchyMode]);

  // Unmatched dashboard opps (no CPD references them), narrowed by the same
  // header filters / lookup so the "Opps Missing CPDs" view stays consistent.
  const filteredUnmatched = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.unmatchedOpps ?? []).filter((o) => {
      if (dimActive && !oppPasses(o)) return false;
      if (q) {
        const hay =
          `${o.oppId} ${o.oppName} ${o.accountName} ${o.rep} ${o.product}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.unmatchedOpps, search, dimActive, oppPasses]);

  // Summary across the visible CPD rows. Anaplan MRR is sourced per CPD (Group
  // A+B+C) and Quota Target is the per-CPD sum, so the money totals aggregate
  // over CPDs. The three COUNTS are opp-level per the spec ("# opps match / does
  // not match / delta > match-delta"): match/delta are only defined per CPD
  // (|Anaplan − ΣQuotaTarget| <= matchDelta), so each opp inherits its parent
  // CPD's reconciliation status. CPDs with no opps contribute to the totals but
  // not to the opp counts.
  const summary = useMemo(() => {
    let anaplanTotal = 0;
    let quotaTotal = 0;
    let absDeltaTotal = 0;
    let cpdsMatch = 0;
    let cpdsNoMatch = 0;
    let oppsMatch = 0;
    let oppsNoMatch = 0;
    let oppsOverDelta = 0;
    let cpdsMissingOpps = 0;
    for (const r of filteredRows) {
      anaplanTotal += r.anaplanMrr;
      quotaTotal += r.quotaTargetMrr;
      absDeltaTotal += Math.abs(rowDiff(r));
      const matched = isMatch(r, matchDelta);
      if (matched) cpdsMatch++;
      else cpdsNoMatch++;
      const overDelta = Math.abs(rowDiff(r)) > matchDelta;
      // A CPD is "missing opps" when its opportunity_ids array references at
      // least one opp that was not found among this month's Closed Won FLD rows.
      if (r.opps.some((o) => !o.found)) cpdsMissingOpps++;
      for (let i = 0; i < r.opps.length; i++) {
        if (matched) oppsMatch++;
        else oppsNoMatch++;
        if (overDelta) oppsOverDelta++;
      }
    }
    // Total Quota Target MRR = matched (owner-scoped CPD) quota plus the
    // compensable MRR of the filtered unmatched opps ("opps missing CPDs").
    const unmatchedTotal = filteredUnmatched.reduce(
      (s, o) => s + o.compensableMrr,
      0
    );
    return {
      count: filteredRows.length,
      anaplanTotal,
      quotaTotal,
      unmatchedTotal,
      totalQuotaTarget: quotaTotal + unmatchedTotal,
      diff: anaplanTotal - quotaTotal,
      absDeltaTotal,
      cpdsMatch,
      cpdsNoMatch,
      oppsMatch,
      oppsNoMatch,
      oppsOverDelta,
      cpdsMissingOpps,
    };
  }, [filteredRows, filteredUnmatched, matchDelta]);

  // Client-side sort of the visible CPD rows. Sorting never changes membership
  // (so the summary aggregates are unaffected); it only reorders what the table
  // and CSV present. Money/count columns compare numerically; text columns and
  // dynamic source columns ("col:<name>") compare case-insensitively, falling
  // back to numeric when a source value parses cleanly as a number.
  const sortedRows = useMemo(() => {
    if (!sortKey) return filteredRows;
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (r: AnaplanCpdRow): string | number => {
      switch (sortKey) {
        case "owner":
          return r.owner ?? "";
        case "slm":
          return r.slm ?? "";
        case "cpdId":
          return r.cpdId ?? "";
        case "opps": {
          const o = r.opps[0];
          return (o ? o.accountName || o.oppName : "") ?? "";
        }
        case "quota":
          return r.quotaTargetMrr;
        case "anaplan":
          return r.anaplanMrr;
        case "delta":
          return Math.abs(rowDiff(r));
        case "match":
          return isMatch(r, matchDelta) ? 1 : 0;
        case "groupA":
          return r.groupAMrr;
        case "groupB":
          return r.groupBMrr;
        case "groupC":
          return r.groupCMrr;
        default: {
          if (sortKey.startsWith("col:")) {
            const raw = r.source?.[sortKey.slice(4)] ?? "";
            const n = parseFloat(raw);
            return raw.trim() !== "" && Number.isFinite(n)
              ? n
              : raw.toLowerCase();
          }
          return "";
        }
      }
    };
    return [...filteredRows].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (typeof av === "number" && typeof bv === "number")
        return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [filteredRows, sortKey, sortDir, matchDelta]);

  const toggleSet = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    key: string
  ) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleCpd = (id: string) => toggleSet(setExpandedCpds, id);
  const toggleOpp = (key: string) => toggleSet(setExpandedOpps, key);
  const togglePair = (key: string) => toggleSet(setExpandedPairs, key);
  const toggleExtraCol = (key: string) => toggleSet(setExtraCols, key);

  // Near-instant tooltips for this table (product/rule hovers feel immediate);
  // the default 600ms delay is kept for other views sharing the hook.
  const reasonTip = useDelayedTooltip(0);

  // Visible extra source columns, in source-declared order.
  const visibleExtraCols = allColumns.filter((c) => extraCols.has(c));
  // Default columns: # (index), Owner, SLM, CPD ID, Opportunities, Product
  // Logic, Rules = 7, then the raw-MRR group (6 columns when expanded, or a
  // single click-to-expand placeholder when collapsed), the Multipliers column
  // (always 1 column — the value when expanded, an expand affordance when
  // collapsed), then Quota Target, Anaplan MRR, Delta, Match, Group A/B/C = 7,
  // plus any extra source columns.
  const rawGroupSpan = showRawMrr ? RAW_MRR_COLS.length : 1;
  const totalCols = 15 + rawGroupSpan + visibleExtraCols.length;

  // Measure the grouping super-header row height so the main column-label row can
  // stick immediately below it when the header is frozen. Re-measures whenever the
  // freeze toggles or the visible column set changes the header's rendered height.
  useLayoutEffect(() => {
    if (!frozenHeader) return;
    const measure = () => {
      const el = superHeaderRef.current;
      if (el) setSuperHeaderH(el.offsetHeight);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [frozenHeader, totalCols, onlyOppsMissingCpds]);

  // Centered count chip mirroring the funnel drilldown: distinct entries count +
  // a hover tooltip listing them; plain muted "0" otherwise. Shared by the
  // Product Logic and Rules columns.
  const renderBadgeCell = (
    rawItems: string[],
    dense: boolean,
    label: string,
  ) => {
    const items = uniq(rawItems);
    const pad = dense ? "py-1" : "py-1.5";
    if (items.length === 0) {
      return (
        <td className={`px-2 ${pad} text-center text-muted-foreground`}>0</td>
      );
    }
    return (
      <td className={`px-2 ${pad} text-center`}>
        <span
          className="inline-flex items-center justify-center min-w-[20px] px-1.5 py-0.5 rounded-md tabular-nums font-medium cursor-help bg-black/5 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20 transition-colors"
          onMouseEnter={(ev) =>
            reasonTip.showTooltipDelayed(
              displayProductText(items.join("\n")),
              ev,
              label,
            )
          }
          onMouseMove={reasonTip.trackMouseMove}
          onMouseLeave={reasonTip.hideTooltip}
        >
          {items.length}
        </span>
      </td>
    );
  };

  const renderRulesCell = (names: string[], dense: boolean) =>
    renderBadgeCell(names, dense, "Rules");

  // Task #531: dedicated Multipliers cell between the raw MRR columns and
  // Matched Quota Target MRR, mirroring the drilldown's Multipliers column.
  const renderMultipliersCell = (items: AnaplanLineItem[], dense: boolean) => {
    const text = displayProductText(multipliersTextFor(items));
    return (
      <td
        className={`px-2 ${
          dense ? "py-1 text-[11px]" : "py-1.5"
        } tabular-nums border-l border-border`}
        title={text}
      >
        <span className="block max-w-[80px] truncate">{text}</span>
      </td>
    );
  };

  // Narrow click-to-expand placeholder rendered in a body row where a column
  // group is collapsed, so it's obvious columns are hidden and how to show them.
  const renderCollapsedTd = (
    onExpand: () => void,
    title: string,
    dense: boolean,
    key?: string,
  ) => (
    <td
      key={key}
      onClick={onExpand}
      title={title}
      className={`px-1 ${
        dense ? "py-1" : "py-1.5"
      } text-center border-l border-border cursor-pointer bg-muted/40 hover:bg-muted text-muted-foreground`}
    >
      <ChevronsRight className="w-3.5 h-3.5 inline" />
    </td>
  );

  const renderProductLogicCell = (
    lineItems: AnaplanLineItem[],
    dense: boolean,
  ) => renderBadgeCell(productLogicEntries(lineItems), dense, "Product Logic");

  // The six raw-MRR cells with base/override highlight and a mouse-following
  // tooltip on each, rendered for a CPD / opp / line-item level.
  const renderRawCells = (
    rawMrr: AnaplanRawMrr,
    lineItems: AnaplanLineItem[],
    ruleNames: string[],
    multipliers: number[],
    dense: boolean,
  ) => {
    const info = collectFieldInfo(lineItems);
    const raw = rawMrr ?? ZERO_RAW_MRR;
    const pad = dense ? "py-1 text-[11px]" : "py-1.5";
    return RAW_MRR_COLS.map(({ key, label }, i) => {
      const isOverride = info.overrideFields.has(key);
      const isBase = info.baseFields.has(key);
      const cls = isOverride
        ? OVERRIDE_CELL_CLASS
        : isBase
          ? BASE_CELL_CLASS
          : "";
      const tip = displayProductText(rawTipFor(key, info, ruleNames, multipliers));
      return (
        <td
          key={key}
          className={`px-2 ${pad} text-right tabular-nums cursor-help ${
            i === 0 ? "border-l border-border" : ""
          } ${cls}`}
          onMouseEnter={(ev) =>
            reasonTip.showTooltipDelayed(tip, ev, label)
          }
          onMouseMove={reasonTip.trackMouseMove}
          onMouseLeave={reasonTip.hideTooltip}
        >
          {fmtMoney(raw[key])}
        </td>
      );
    });
  };

  const exportCsv = () => {
    const headers = [
      "Owner",
      "SLM",
      "CPD ID",
      "Opportunities",
      "Product Logic (max per opp)",
      "Rules (max per opp)",
      ...RAW_MRR_COLS.map((c) => c.label),
      "Multipliers",
      "Matched Quota Target MRR",
      "Anaplan MRR",
      "Delta",
      "Match",
      "Group A MRR",
      "Group B MRR",
      "Group C MRR",
      ...visibleExtraCols,
    ];
    const lines = [headers.join(",")];
    const esc = (v: string | number) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    for (const r of sortedRows) {
      const firstOpp = r.opps[0];
      const oppLabel = firstOpp
        ? `${firstOpp.found ? firstOpp.accountName || firstOpp.oppName : NOT_FOUND_LABEL}${r.opps.length > 1 ? ` (+${r.opps.length - 1})` : ""}`
        : "";
      const maxRules = r.opps.reduce(
        (m, o) => Math.max(m, uniq(o.ruleNames).length),
        0,
      );
      const maxProductLogic = r.opps.reduce(
        (m, o) => Math.max(m, productLogicEntries(o.lineItems).length),
        0,
      );
      const rowRaw = sumRawMrr(r.opps);
      lines.push(
        [
          r.owner,
          r.slm,
          r.cpdId,
          oppLabel,
          maxProductLogic,
          maxRules,
          ...RAW_MRR_COLS.map((c) => rowRaw[c.key].toFixed(2)),
          displayProductText(multipliersTextFor(allLineItems(r.opps))),
          r.quotaTargetMrr.toFixed(2),
          r.anaplanMrr.toFixed(2),
          Math.abs(rowDiff(r)).toFixed(2),
          isMatch(r, matchDelta) ? "MATCH" : "NO MATCH",
          r.groupAMrr.toFixed(2),
          r.groupBMrr.toFixed(2),
          r.groupCMrr.toFixed(2),
          ...visibleExtraCols.map((c) => r.source?.[c] ?? ""),
        ]
          .map(esc)
          .join(",")
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `anaplan-check-${data?.month ?? "export"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (data?.fetchError) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-4 text-[13px] text-red-700">
        Failed to load Anaplan source data
        {data.fetchErrorMessage ? `: ${data.fetchErrorMessage}` : "."}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Opp-level summary */}
      <div className="flex flex-col gap-3">
        <div className="border border-border rounded-md overflow-x-auto flex-1">
          <table className="w-full text-[12px]">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-right whitespace-nowrap">
                  Total Quota Target MRR
                </th>
                <th className="px-3 py-2 text-right whitespace-nowrap">
                  Anaplan MRR
                </th>
                <th className="px-3 py-2 text-right whitespace-nowrap">
                  Matched Quota Target MRR
                </th>
                <th className="px-3 py-2 text-right whitespace-nowrap">
                  Total Δ
                </th>
                <th className="px-3 py-2 text-right whitespace-nowrap">
                  CPDs Match
                </th>
                <th className="px-3 py-2 text-right whitespace-nowrap">
                  CPDs No Match
                </th>
                <th className="px-3 py-2 text-right whitespace-nowrap">
                  Opps Match
                </th>
                <th className="px-3 py-2 text-right whitespace-nowrap">
                  Opps No Match
                </th>
                <th className="px-3 py-2 text-right whitespace-nowrap">
                  Opps Δ &gt; ${matchDelta}
                </th>
                <th className="px-3 py-2 text-right whitespace-nowrap">
                  #CPDs Missing Opps
                </th>
                <th className="px-3 py-2 text-right whitespace-nowrap">
                  #Opps Missing CPD
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border text-[20px] leading-tight">
                <td className="px-3 py-3 text-right font-semibold">
                  {fmtMoney(summary.totalQuotaTarget)}
                </td>
                <td className="px-3 py-3 text-right font-semibold">
                  {fmtMoney(summary.anaplanTotal)}
                </td>
                <td className="px-3 py-3 text-right font-semibold">
                  {fmtMoney(summary.quotaTotal)}
                </td>
                <td
                  className={`px-3 py-3 text-right font-semibold ${
                    summary.absDeltaTotal > matchDelta
                      ? "text-red-600"
                      : "text-green-600"
                  }`}
                >
                  {fmtMoney(summary.absDeltaTotal)}
                </td>
                <td className="px-3 py-3 text-right font-semibold text-green-600">
                  {summary.cpdsMatch.toLocaleString()}
                </td>
                <td
                  className={`px-3 py-3 text-right font-semibold ${
                    summary.cpdsNoMatch > 0 ? "text-red-600" : ""
                  }`}
                >
                  {summary.cpdsNoMatch.toLocaleString()}
                </td>
                <td className="px-3 py-3 text-right font-semibold text-green-600">
                  {summary.oppsMatch.toLocaleString()}
                </td>
                <td
                  className={`px-3 py-3 text-right font-semibold ${
                    summary.oppsNoMatch > 0 ? "text-red-600" : ""
                  }`}
                >
                  {summary.oppsNoMatch.toLocaleString()}
                </td>
                <td
                  className={`px-3 py-3 text-right font-semibold ${
                    summary.oppsOverDelta > 0 ? "text-red-600" : ""
                  }`}
                >
                  {summary.oppsOverDelta.toLocaleString()}
                </td>
                <td
                  className={`px-3 py-3 text-right font-semibold ${
                    summary.cpdsMissingOpps > 0 ? "text-red-600" : ""
                  }`}
                >
                  {summary.cpdsMissingOpps.toLocaleString()}
                </td>
                <td
                  className={`px-3 py-3 text-right font-semibold ${
                    filteredUnmatched.length > 0 ? "text-red-600" : ""
                  }`}
                >
                  {filteredUnmatched.length.toLocaleString()}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Lookup CPD / opp id / account…"
            className="h-[28px] pl-7 pr-2 text-[12px] border border-border rounded-md bg-background w-[240px]"
          />
        </div>
        <label
          className="flex items-center gap-1 text-[12px] cursor-help"
          title={`Match when |Anaplan − Quota Target| ≤ $${matchDelta}; No Match otherwise.`}
        >
          <span className="text-muted-foreground">Match Δ $</span>
          <input
            type="number"
            min={0}
            step={0.01}
            value={matchDelta}
            onChange={(e) =>
              setMatchDelta(Math.max(0, Number(e.target.value) || 0))
            }
            className="h-[28px] w-[72px] px-2 text-[12px] border border-border rounded-md bg-background"
          />
        </label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="h-[28px] px-3 text-[12px] border border-border rounded-md bg-background hover:bg-muted flex items-center gap-1">
              Rules
              {selectedRuleNames.length > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  ({selectedRuleNames.length})
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-[320px] overflow-y-auto w-[300px]"
          >
            <DropdownMenuLabel className="flex items-center justify-between">
              <span>Filter by rule</span>
              {selectedRuleNames.length > 0 && (
                <button
                  onClick={() => setSelectedRuleNames([])}
                  className="text-[11px] text-[#006AFF] hover:underline font-normal"
                >
                  Clear
                </button>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {allRuleNames.length === 0 && (
              <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
                No rules.
              </div>
            )}
            {allRuleNames.map((rn) => (
              <DropdownMenuCheckboxItem
                key={rn}
                checked={selectedRuleNames.includes(rn)}
                onCheckedChange={() => toggleRule(rn)}
                onSelect={(e) => e.preventDefault()}
              >
                <span className="flex-1 truncate pr-2">{rn}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {ruleCounts.get(rn) ?? 0}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <label
          className="flex items-center gap-1 text-[12px] cursor-help"
          title="Scope CPD rows by whether the Anaplan Owner is found in the dashboard hierarchy for the selected month. Rows with a blank Owner are always shown; counts are distinct owners among the rows passing the other filters."
        >
          <span className="text-muted-foreground">Filter Anaplan Users</span>
          <select
            value={ownerHierarchyMode}
            onChange={(e) =>
              setOwnerHierarchyMode(e.target.value as "all" | "in" | "out")
            }
            className="h-[28px] px-2 text-[12px] border border-border rounded-md bg-background"
          >
            <option value="all">
              All users ({ownerHierarchyCounts.all})
            </option>
            <option value="in">
              Anaplan users in hierarchy ({ownerHierarchyCounts.inHierarchy})
            </option>
            <option value="out">
              Anaplan owners not in hierarchy (
              {ownerHierarchyCounts.notInHierarchy})
            </option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-[12px] cursor-pointer">
          <input
            type="checkbox"
            checked={onlyCpdsMissingOpps}
            onChange={(e) => setOnlyCpdsMissingOpps(e.target.checked)}
          />
          CPDs missing opps
        </label>
        <label className="flex items-center gap-1 text-[12px] cursor-pointer">
          <input
            type="checkbox"
            checked={onlyOppsMissingCpds}
            onChange={(e) => setOnlyOppsMissingCpds(e.target.checked)}
          />
          Opps missing CPDs
        </label>
        <label className="flex items-center gap-1 text-[12px] cursor-pointer">
          <input
            type="checkbox"
            checked={onlyAcqChurn}
            onChange={(e) => setOnlyAcqChurn(e.target.checked)}
          />
          ACQ Churn
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <button className="h-[28px] px-3 text-[12px] border border-border rounded-md bg-background hover:bg-muted flex items-center gap-1">
                <Info className="w-3.5 h-3.5" /> Legend
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-[320px] text-[11px] text-muted-foreground space-y-1"
            >
              <div className="font-medium text-foreground text-[12px]">
                Legend
              </div>
              <div className="pt-1">
                <strong>Product Group A</strong> ={" "}
                {displayProductText("MBP Subscription Sales")}
              </div>
              <div>
                <strong>Product Group B</strong> ={" "}
                {displayProductText(
                  "Showcase Subscription Sales, Showcase Non-Subscription Revenue, ZMX Non-Subscription Revenue",
                )}
              </div>
              <div>
                <strong>Product Group C</strong> ={" "}
                {displayProductText("zPro and FUB Subscription Sales")}{" "}
                <strong>Currently included in Product Group B</strong>
              </div>
              {data?.lastUpdate && (
                <div className="pt-1">
                  Source last edited (hand-updated): {data.lastUpdate}
                </div>
              )}
              {data?.fetchedAt && (
                <div>
                  Data last pulled from source:{" "}
                  {new Date(data.fetchedAt).toLocaleString()}
                </div>
              )}
              {data?.oppWindowStart && data?.oppWindowEnd && (
                <div>
                  Opportunity data between {data.oppWindowStart} and{" "}
                  {data.oppWindowEnd}
                </div>
              )}
              <div className="pt-2 border-t border-border mt-2">
                Source of Anaplan data is the{" "}
                <a
                  href="https://us1a.app.anaplan.com/a/apps/app/517fefb2-006d-4834-94d0-0f427070c0a1/boards/478b7292-23be-447d-9e7f-196b17b694a7"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#006AFF] hover:underline"
                >
                  Acquisition Transactions Dashboard
                </a>
                .
              </div>
              <div className="pt-1">
                This Anaplan data is updated by hand on a weekly basis. "Source
                last edited" is when the source was last hand-updated; "Data last
                pulled from source" is when this dashboard last fetched it — use
                Refresh Data to pull the latest.
              </div>
            </PopoverContent>
          </Popover>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="h-[28px] px-3 text-[12px] border border-border rounded-md bg-background hover:bg-muted flex items-center gap-1">
                <SlidersHorizontal className="w-3.5 h-3.5" /> Columns
                {visibleExtraCols.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    ({visibleExtraCols.length})
                  </span>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="max-h-[320px] overflow-y-auto w-[240px]"
            >
              <DropdownMenuLabel>Extra source columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {allColumns.length === 0 && (
                <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
                  No source columns.
                </div>
              )}
              {allColumns.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c}
                  checked={extraCols.has(c)}
                  onCheckedChange={() => toggleExtraCol(c)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {c}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {!onlyOppsMissingCpds && (
            <button
              onClick={() => setFrozenHeader((v) => !v)}
              aria-pressed={frozenHeader}
              title={
                frozenHeader
                  ? "Unfreeze the table header"
                  : "Freeze the table header so it stays visible while scrolling"
              }
              className={`h-[28px] px-3 text-[12px] border rounded-md flex items-center gap-1 ${
                frozenHeader
                  ? "border-sky-400 bg-sky-100 text-sky-800 hover:bg-sky-200 dark:border-sky-700 dark:bg-sky-950/50 dark:text-sky-200 dark:hover:bg-sky-900/60"
                  : "border-border bg-background hover:bg-muted"
              }`}
            >
              {frozenHeader ? (
                <>
                  <PinOff className="w-3.5 h-3.5" /> Unfreeze header
                </>
              ) : (
                <>
                  <Pin className="w-3.5 h-3.5" /> Freeze header
                </>
              )}
            </button>
          )}
          <button
            onClick={exportCsv}
            className="h-[28px] px-3 text-[12px] border border-border rounded-md bg-background hover:bg-muted flex items-center gap-1"
          >
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
        </div>
      </div>

      {/* Main reconciliation table */}
      {!onlyOppsMissingCpds && (
        <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-sky-100 dark:bg-sky-950/50 border border-sky-300 dark:border-sky-800" />
            Product-logic base MRR field
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-amber-100 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800" />
            Rule-applied (override) MRR field
          </span>
          <span className="inline-flex items-center gap-1">
            <Info className="w-3 h-3" />
            Hover a raw cell, Product Logic, or Rules count for details
          </span>
        </div>
      )}
      {!onlyOppsMissingCpds && (
        <div
          className={`border border-border rounded-md ${
            frozenHeader ? "overflow-auto max-h-[70vh]" : "overflow-x-auto"
          }`}
        >
          <table className="w-full text-[12px]">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr
                ref={superHeaderRef}
                className={`text-left ${
                  frozenHeader ? "sticky top-0 z-20 bg-muted" : ""
                }`}
              >
                <th colSpan={7} className="px-2 py-1" aria-hidden />
                {showRawMrr ? (
                  <th
                    colSpan={RAW_MRR_COLS.length}
                    className="px-2 py-1 text-center font-normal text-[10px] uppercase tracking-wide text-muted-foreground/70 border-l border-border"
                  >
                    <button
                      type="button"
                      onClick={() => setShowRawMrr(false)}
                      title="Hide the Raw Salesforce MRR Fields columns"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      Raw Salesforce MRR Fields
                      <ChevronsLeft className="w-3 h-3" />
                    </button>
                  </th>
                ) : (
                  <th
                    colSpan={1}
                    onClick={() => setShowRawMrr(true)}
                    title="Show the Raw Salesforce MRR Fields columns (6 hidden)"
                    className="px-1 py-1 text-center border-l border-border cursor-pointer bg-muted/40 hover:bg-muted"
                  >
                    <ChevronsRight className="w-3 h-3 inline text-muted-foreground" />
                  </th>
                )}
                <th
                  colSpan={5}
                  className="px-2 py-1 border-l border-border"
                  aria-hidden
                />
                <th
                  colSpan={3}
                  className="px-2 py-1 text-center font-normal text-[10px] uppercase tracking-wide text-muted-foreground/70 border-l border-border"
                >
                  Anaplan MRR Fields
                </th>
                {visibleExtraCols.length > 0 && (
                  <th
                    colSpan={visibleExtraCols.length}
                    className="px-2 py-1"
                    aria-hidden
                  />
                )}
              </tr>
              <tr
                className={`text-left ${
                  frozenHeader ? "sticky z-20 bg-muted" : ""
                }`}
                style={frozenHeader ? { top: superHeaderH } : undefined}
              >
                <th className="px-2 py-2 text-right whitespace-nowrap font-normal text-muted-foreground/70">
                  #
                </th>
                {sortTh("owner", "Owner")}
                {sortTh("slm", "SLM")}
                {sortTh("cpdId", "CPD ID")}
                {sortTh("opps", "Opportunities")}
                <th className="px-2 py-2 text-center whitespace-nowrap">
                  Product Logic
                </th>
                <th className="px-2 py-2 text-center whitespace-nowrap">
                  Rules
                </th>
                {showRawMrr ? (
                  RAW_MRR_COLS.map((c, i) => (
                    <th
                      key={c.key}
                      className={`px-2 py-2 text-right whitespace-nowrap ${
                        i === 0 ? "border-l border-border" : ""
                      }`}
                    >
                      {c.label}
                    </th>
                  ))
                ) : (
                  <th
                    onClick={() => setShowRawMrr(true)}
                    title="Show the Raw Salesforce MRR Fields columns (6 hidden)"
                    className="px-1 py-2 text-center border-l border-border cursor-pointer bg-muted/40 hover:bg-muted text-muted-foreground"
                  >
                    <ChevronsRight className="w-3.5 h-3.5 inline" />
                  </th>
                )}
                {showMultipliers ? (
                  <th className="px-2 py-2 text-left whitespace-nowrap border-l border-border">
                    <button
                      type="button"
                      onClick={() => setShowMultipliers(false)}
                      title="Hide the Multipliers column"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      Multipliers
                      <ChevronsLeft className="w-3 h-3" />
                    </button>
                  </th>
                ) : (
                  <th
                    onClick={() => setShowMultipliers(true)}
                    title="Show the Multipliers column"
                    className="px-1 py-2 text-center border-l border-border cursor-pointer bg-muted/40 hover:bg-muted text-muted-foreground"
                  >
                    <ChevronsRight className="w-3.5 h-3.5 inline" />
                  </th>
                )}
                {sortTh(
                  "quota",
                  "Matched Quota Target MRR",
                  "right",
                  true,
                  "border-l border-border"
                )}
                {sortTh("anaplan", "Anaplan MRR", "right", true)}
                {sortTh("delta", "Delta", "right")}
                {sortTh("match", "Match", "center")}
                {sortTh("groupA", "Group A", "right", false, "border-l border-border")}
                {sortTh("groupB", "Group B", "right")}
                {sortTh("groupC", "Group C", "right")}
                {visibleExtraCols.map((c) => (
                  <th key={c} className="px-2 py-2 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => toggleSort(`col:${c}`)}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      {c}
                      {sortKey === `col:${c}` && (
                        <span className="text-[9px]">
                          {sortDir === "asc" ? "▲" : "▼"}
                        </span>
                      )}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 && (
                <tr>
                  <td
                    colSpan={totalCols}
                    className="px-2 py-8 text-center text-muted-foreground"
                  >
                    No CPD rows match the current filters.
                  </td>
                </tr>
              )}
              {sortedRows.map((r, rIdx) => {
                const match = isMatch(r, matchDelta);
                const rowKey = `${r.cpdId}::${rIdx}`;
                const open = expandedCpds.has(rowKey);
                const firstOpp = r.opps[0];
                return (
                  <React.Fragment key={rowKey}>
                    <tr
                      className={`border-t border-border ${
                        match
                          ? "bg-green-50 dark:bg-green-950/20"
                          : "bg-red-50 dark:bg-red-950/20"
                      }`}
                    >
                      <td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">
                        {rIdx + 1}
                      </td>
                      <td className="px-2 py-1.5">{r.owner}</td>
                      <td className="px-2 py-1.5">{r.slm}</td>
                      <td className="px-2 py-1.5 font-mono">
                        <a
                          href={cpdLink(r.cpdId)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#006AFF] hover:underline inline-flex items-center gap-1"
                        >
                          {r.cpdId}
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </td>
                      {/* Opportunities: first opp's account name + expand caret */}
                      <td className="px-2 py-1.5">
                        {r.opps.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => toggleCpd(rowKey)}
                              className="shrink-0 text-muted-foreground hover:text-foreground"
                              aria-label="Expand opportunities"
                            >
                              {open ? (
                                <ChevronDown className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                              )}
                            </button>
                            {firstOpp.found ? (
                              <IdLink
                                id={firstOpp.accountId || firstOpp.oppId}
                                label={firstOpp.accountName || firstOpp.oppName}
                                className="text-[#006AFF] truncate max-w-[220px]"
                              />
                            ) : (
                              <IdLink
                                id={firstOpp.oppId}
                                label={NOT_FOUND_LABEL}
                                className="text-red-700 truncate max-w-[220px]"
                              />
                            )}
                            {r.opps.length > 1 && (
                              <span className="text-[11px] text-muted-foreground shrink-0">
                                +{r.opps.length - 1}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      {renderBadgeCell(
                        r.opps.reduce(
                          (best, o) => {
                            const e = productLogicEntries(o.lineItems);
                            return e.length > best.length ? e : best;
                          },
                          [] as string[],
                        ),
                        false,
                        "Product Logic",
                      )}
                      {renderBadgeCell(
                        r.opps.reduce(
                          (best, o) => {
                            const u = uniq(o.ruleNames);
                            return u.length > best.length ? u : best;
                          },
                          [] as string[],
                        ),
                        false,
                        "Rules",
                      )}
                      {showRawMrr
                        ? renderRawCells(
                            sumRawMrr(r.opps),
                            allLineItems(r.opps),
                            r.opps.flatMap((o) => o.ruleNames),
                            r.opps.flatMap((o) => o.multipliers),
                            false,
                          )
                        : renderCollapsedTd(
                            () => setShowRawMrr(true),
                            "Show the Raw Salesforce MRR Fields columns (6 hidden)",
                            false,
                          )}
                      {showMultipliers
                        ? renderMultipliersCell(allLineItems(r.opps), false)
                        : renderCollapsedTd(
                            () => setShowMultipliers(true),
                            "Show the Multipliers column",
                            false,
                          )}
                      <td className="px-2 py-1.5 text-right font-bold border-l border-border">
                        {fmtMoney(r.quotaTargetMrr)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-bold">
                        {fmtMoney(r.anaplanMrr)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-medium">
                        {fmtMoney(Math.abs(rowDiff(r)))}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {match ? (
                          <CheckCircle2 className="w-4 h-4 text-green-600 inline" />
                        ) : (
                          <AlertTriangle className="w-4 h-4 text-red-600 inline" />
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right border-l border-border">
                        {fmtMoney(r.groupAMrr)}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {fmtMoney(r.groupBMrr)}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {fmtMoney(r.groupCMrr)}
                      </td>
                      {visibleExtraCols.map((c) => (
                        <td
                          key={c}
                          className="px-2 py-1.5 whitespace-nowrap text-muted-foreground"
                        >
                          {r.source?.[c] ?? ""}
                        </td>
                      ))}
                    </tr>
                    {open &&
                      r.opps.map((o, oIdx) => {
                        const oppKey = `${rowKey}::${o.oppId}::${oIdx}`;
                        const oppOpen = expandedOpps.has(oppKey);
                        const hasItems = o.lineItems.length > 1;
                        // Task #524: paired-opp rule badge + expandable partner
                        // rows, mirroring the pipeline drilldown's affordance.
                        const isPaired = !!o.pairOppName;
                        const partners = o.partnerOpps ?? [];
                        const hasPartners = partners.length > 0;
                        const pairOpen = expandedPairs.has(oppKey);
                        return (
                          <React.Fragment key={oppKey}>
                            <tr
                              className={`border-t border-border bg-background ${
                                o.excludedByAcqChurn ? ACQ_CHURN_RED : ""
                              }`}
                              title={
                                o.excludedByAcqChurn
                                  ? ACQ_CHURN_TOOLTIP
                                  : undefined
                              }
                            >
                              <td />
                              <td colSpan={4} className="px-2 py-1.5">
                                <div className="flex items-center gap-2 pl-6">
                                  {hasItems ? (
                                    <button
                                      onClick={() => toggleOpp(oppKey)}
                                      className="shrink-0 text-muted-foreground hover:text-foreground"
                                      aria-label="Expand line items"
                                    >
                                      <ChevronRight
                                        className={`w-3 h-3 transition-transform ${
                                          oppOpen ? "rotate-90" : ""
                                        }`}
                                      />
                                    </button>
                                  ) : (
                                    <span className="w-3 shrink-0" />
                                  )}
                                  {isPaired && (
                                    <>
                                      {hasPartners ? (
                                        <button
                                          onClick={() => togglePair(oppKey)}
                                          className="shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                                          aria-label={
                                            pairOpen
                                              ? "Collapse linked opps"
                                              : "Expand linked opps"
                                          }
                                        >
                                          {pairOpen ? (
                                            <ChevronDown className="w-3.5 h-3.5 text-[#006AFF]" />
                                          ) : (
                                            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                                          )}
                                        </button>
                                      ) : (
                                        <span className="w-[18px] shrink-0" />
                                      )}
                                      <span
                                        className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 mr-0.5"
                                        title={`${o.pairRuleLabel ?? "Paired-opp rule"} — "${o.pairOppName}" linked opp (compensable revenue)`}
                                      >
                                        {o.pairOppName}
                                      </span>
                                    </>
                                  )}
                                  {o.found ? (
                                    <IdLink
                                      id={o.oppId}
                                      label={o.oppName || o.oppId}
                                      className="text-[#006AFF] truncate max-w-[320px]"
                                    />
                                  ) : (
                                    <IdLink
                                      id={o.oppId}
                                      label={`${o.oppId} ${NOT_FOUND_LABEL}`}
                                      className="text-red-700 font-mono"
                                    />
                                  )}
                                  {o.found && (
                                    <span className="text-muted-foreground truncate">
                                      {displayProduct(o.product)}
                                      {o.lineItemCount > 1
                                        ? ` +${o.lineItemCount - 1}`
                                        : ""}{" "}
                                      · {o.rep}
                                    </span>
                                  )}
                                </div>
                              </td>
                              {renderProductLogicCell(o.lineItems, false)}
                              {renderRulesCell(o.ruleNames, false)}
                              {showRawMrr
                                ? renderRawCells(
                                    o.rawMrr,
                                    o.lineItems,
                                    o.ruleNames,
                                    o.multipliers,
                                    false,
                                  )
                                : renderCollapsedTd(
                                    () => setShowRawMrr(true),
                                    "Show the Raw Salesforce MRR Fields columns (6 hidden)",
                                    false,
                                  )}
                              {showMultipliers
                                ? renderMultipliersCell(o.lineItems, false)
                                : renderCollapsedTd(
                                    () => setShowMultipliers(true),
                                    "Show the Multipliers column",
                                    false,
                                  )}
                              <td className="px-2 py-1.5 text-right font-medium border-l border-border">
                                {fmtMoney(o.compensableMrr)}
                              </td>
                              <td />
                              <td colSpan={2} />
                              <td
                                colSpan={3 + visibleExtraCols.length}
                                className="border-l border-border"
                              />
                            </tr>
                            {oppOpen &&
                              o.lineItems.map((li, i) => (
                                <tr
                                  key={`${oppKey}::li${i}`}
                                  className={`bg-muted/30 ${
                                    li.excludedByAcqChurn ? ACQ_CHURN_RED : ""
                                  }`}
                                  title={
                                    li.excludedByAcqChurn
                                      ? ACQ_CHURN_TOOLTIP
                                      : undefined
                                  }
                                >
                                  <td />
                                  <td
                                    colSpan={4}
                                    className="px-2 py-1 text-[11px]"
                                  >
                                    <div className="flex items-center gap-2 pl-14">
                                      <span className="text-[10px] shrink-0">
                                        ↳
                                      </span>
                                      <span className="shrink-0 whitespace-nowrap">
                                        Line item {i + 1}
                                      </span>
                                      <span className="text-muted-foreground truncate">
                                        {displayProduct(li.product) || "—"}
                                      </span>
                                      {li.ruleNames.length > 0 && (
                                        <span className="text-muted-foreground truncate">
                                          {displayProductText(li.ruleNames.join(", "))}
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  {renderProductLogicCell([li], true)}
                                  {renderRulesCell(li.ruleNames, true)}
                                  {showRawMrr
                                    ? renderRawCells(
                                        li.rawMrr,
                                        [li],
                                        li.ruleNames,
                                        li.multipliers,
                                        true,
                                      )
                                    : renderCollapsedTd(
                                        () => setShowRawMrr(true),
                                        "Show the Raw Salesforce MRR Fields columns (6 hidden)",
                                        true,
                                      )}
                                  {showMultipliers
                                    ? renderMultipliersCell([li], true)
                                    : renderCollapsedTd(
                                        () => setShowMultipliers(true),
                                        "Show the Multipliers column",
                                        true,
                                      )}
                                  <td className="px-2 py-1 text-[11px] text-right font-medium border-l border-border">
                                    {fmtMoney(li.compensableMrr)}
                                  </td>
                                  <td />
                                  <td colSpan={2} />
                                  <td
                                    colSpan={3 + visibleExtraCols.length}
                                    className="border-l border-border"
                                  />
                                </tr>
                              ))}
                            {/* Task #524: paired-opp partner rows — context
                                only, never counted in Quota Target MRR or any
                                Anaplan aggregate. Mirrors the drilldown's
                                linked-opp sub-row styling. */}
                            {pairOpen &&
                              partners.map((p, pi) => (
                                <tr
                                  key={`${oppKey}::pair${pi}`}
                                  className="bg-[#006AFF]/[0.03] dark:bg-[#006AFF]/[0.06]"
                                >
                                  <td />
                                  <td
                                    colSpan={4}
                                    className="px-2 py-1.5 text-[11px]"
                                  >
                                    <div className="flex items-center gap-2 pl-14">
                                      <span className="text-[10px] font-semibold text-[#22c55e] mr-1">
                                        +
                                      </span>
                                      <IdLink
                                        id={p.oppId}
                                        label={p.oppName || p.oppId}
                                        className="text-[#22c55e] truncate max-w-[280px]"
                                      />
                                      <span className="text-muted-foreground truncate">
                                        {displayProduct(p.product) || "—"} · {p.rep}
                                      </span>
                                      {p.ruleLabel && (
                                        <span className="text-muted-foreground truncate">
                                          {displayProductText(p.ruleLabel)}
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td colSpan={2} />
                                  {showRawMrr
                                    ? RAW_MRR_COLS.map(({ key: rk }, ri) => (
                                        <td
                                          key={rk}
                                          className={`px-2 py-1.5 text-[11px] text-right tabular-nums text-[#22c55e] ${
                                            ri === 0
                                              ? "border-l border-border"
                                              : ""
                                          }`}
                                        >
                                          {fmtMoney(
                                            (p.rawMrr ?? ZERO_RAW_MRR)[rk] ?? 0,
                                          )}
                                        </td>
                                      ))
                                    : renderCollapsedTd(
                                        () => setShowRawMrr(true),
                                        "Show the Raw Salesforce MRR Fields columns (6 hidden)",
                                        false,
                                      )}
                                  {showMultipliers ? (
                                    <td
                                      className="px-2 py-1.5 text-[11px] tabular-nums text-[#22c55e] border-l border-border"
                                      title={p.ruleLabel || undefined}
                                    >
                                      <span className="block max-w-[80px] truncate">
                                        {p.ruleLabel || "1x"}
                                      </span>
                                    </td>
                                  ) : (
                                    renderCollapsedTd(
                                      () => setShowMultipliers(true),
                                      "Show the Multipliers column",
                                      false,
                                    )
                                  )}
                                  <td
                                    className="px-2 py-1.5 text-[11px] text-right font-medium text-[#22c55e] border-l border-border"
                                    title="Partner opp shown for context — not counted in Quota Target MRR"
                                  >
                                    {fmtMoney(p.compensableMrr)}
                                  </td>
                                  <td />
                                  <td colSpan={2} />
                                  <td
                                    colSpan={3 + visibleExtraCols.length}
                                    className="border-l border-border"
                                  />
                                </tr>
                              ))}
                          </React.Fragment>
                        );
                      })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Opportunities in the dashboard not referenced by any CPD */}
      {(onlyOppsMissingCpds || filteredUnmatched.length > 0) && (
        <UnmatchedOpps
          opps={filteredUnmatched}
          startOpen={onlyOppsMissingCpds}
        />
      )}
      <DelayedTooltipPortal tooltip={reasonTip.tooltip} />
    </div>
  );
}

function UnmatchedOpps({
  opps,
  startOpen,
}: {
  opps: AnaplanOppLine[];
  startOpen: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  return (
    <div className="border border-border rounded-md overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/20 text-[12px] font-medium"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        Opps missing CPDs ({opps.length.toLocaleString()})
        <span className="text-muted-foreground font-normal">
          — dashboard opportunities not referenced by any Anaplan CPD
        </span>
      </button>
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="text-left">
                <th className="px-2 py-2">Account</th>
                <th className="px-2 py-2">Opportunity</th>
                <th className="px-2 py-2">Rep</th>
                <th className="px-2 py-2">Product</th>
                <th className="px-2 py-2">Close Date</th>
                <th className="px-2 py-2 text-right">Quota Target MRR</th>
              </tr>
            </thead>
            <tbody>
              {opps.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-2 py-6 text-center text-muted-foreground"
                  >
                    No unmatched opportunities.
                  </td>
                </tr>
              )}
              {opps.map((o, oIdx) => {
                const key = `${o.oppId}::${oIdx}`;
                // Only worth expanding when the opp carries more than one line
                // item, or any line belongs to another channel (so the user can
                // see the co-owner rows that are NOT counted in this total).
                const hasDetail =
                  o.lineItems.length > 1 ||
                  o.lineItems.some((li) => li.outOfChannel);
                const isOpen = expanded.has(key);
                return (
                  <React.Fragment key={key}>
                    <tr
                      className={`border-t border-border ${
                        o.excludedByAcqChurn ? ACQ_CHURN_RED : ""
                      }`}
                      title={
                        o.excludedByAcqChurn ? ACQ_CHURN_TOOLTIP : undefined
                      }
                    >
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          {hasDetail ? (
                            <button
                              onClick={() => toggle(key)}
                              className="shrink-0 text-muted-foreground hover:text-foreground"
                              aria-label="Expand line items"
                            >
                              <ChevronRight
                                className={`w-3 h-3 transition-transform ${
                                  isOpen ? "rotate-90" : ""
                                }`}
                              />
                            </button>
                          ) : (
                            <span className="w-3 shrink-0" />
                          )}
                          {o.accountId ? (
                            <a
                              href={accountLink(o.accountId)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#006AFF] hover:underline truncate max-w-[240px] inline-block align-bottom"
                            >
                              {o.accountName || o.oppName}
                            </a>
                          ) : (
                            o.accountName || o.oppName
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-1.5">
                        <a
                          href={oppLink(o.oppId)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#006AFF] hover:underline truncate max-w-[280px] inline-block align-bottom"
                        >
                          {o.oppName || o.oppId}
                        </a>
                      </td>
                      <td className="px-2 py-1.5">{o.rep}</td>
                      <td className="px-2 py-1.5">
                        {displayProduct(o.product)}
                        {o.lineItemCount > 1 ? ` +${o.lineItemCount - 1}` : ""}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {o.closeDate || "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right font-medium">
                        {fmtMoney(o.compensableMrr)}
                      </td>
                    </tr>
                    {isOpen &&
                      o.lineItems.map((li, i) => (
                        <tr
                          key={`${key}::li${i}`}
                          className={`bg-muted/30 text-[11px] ${
                            li.outOfChannel
                              ? "text-muted-foreground italic"
                              : li.excludedByAcqChurn
                                ? ACQ_CHURN_RED
                                : ""
                          }`}
                          title={
                            li.outOfChannel
                              ? `${li.group || "Other channel"} — shown for context, not counted in this channel's total`
                              : li.excludedByAcqChurn
                                ? ACQ_CHURN_TOOLTIP
                                : undefined
                          }
                        >
                          <td className="px-2 py-1" />
                          <td className="px-2 py-1 pl-6">
                            {li.outOfChannel ? "↳ out of channel" : "↳"}
                          </td>
                          <td className="px-2 py-1">
                            {li.rep}
                            {li.group ? (
                              <span className="text-muted-foreground">
                                {" "}
                                · {li.group}
                              </span>
                            ) : null}
                          </td>
                          <td className="px-2 py-1">{displayProduct(li.product) || "—"}</td>
                          <td className="px-2 py-1" />
                          <td className="px-2 py-1 text-right font-medium">
                            {li.outOfChannel ? (
                              <span title="Not included in this channel's total">
                                ({fmtMoney(li.compensableMrr)})
                              </span>
                            ) : (
                              fmtMoney(li.compensableMrr)
                            )}
                          </td>
                        </tr>
                      ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
