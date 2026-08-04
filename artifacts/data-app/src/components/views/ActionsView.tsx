import React, { useEffect, useMemo, useRef, useState } from "react";
import { FilterState, AggregateBy } from "../../pages/Dashboard";
import { ActionsData } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ArrowUpDown, ArrowUp, ArrowDown, ChevronDown, ExternalLink, Download } from "lucide-react";
import { SfReportLink } from "../SfReportLink";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LabelList } from "recharts";
import { getDateRange, passesChannelFilter } from "@/lib/utils";
import { displayProduct, displayProductText } from "@/lib/product-labels";
import {
  sfReportUrl,
  sfClassicReportUrl,
  sfRecordUrl,
  sfClassicRecordUrl,
} from "@/lib/sf-links";

const SF_OPPS_REPORT = sfReportUrl("opps");
const SF_CC_DECLINES_REPORT = sfClassicReportUrl("ccDeclinesClassic");
const SF_INBOUNDS_REPORT = sfReportUrl("inbounds");

const VIZ_OPTIONS = [
  { key: "inbounds", label: "Inbounds" },
  { key: "staleOpps", label: "Stale Opportunities" },
  { key: "ccDeclines", label: "CC Declines" },
  { key: "actionNeeded", label: "Action Needed" },
  { key: "topAccounts", label: "Top Accounts" },
] as const;

type VizKey = typeof VIZ_OPTIONS[number]["key"];

const COMING_SOON_KEYS = new Set<VizKey>(["actionNeeded", "topAccounts"]);

// Temporarily hidden from all users; code kept for possible future revival.
const HIDDEN_VIZ_KEYS = new Set<VizKey>(["actionNeeded", "topAccounts"]);

// The inbound feeder's "Product of Interest" uses a different vocabulary than
// the canonical Products filter, so map each raw value onto the canonical
// product the header filter already uses. Blank/unknown -> "No Product
// Selected", matching how empty-product opps behave elsewhere.
export const NO_PRODUCT_SELECTED = "No Product Selected";
export function mapInboundProduct(raw: string): string {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return NO_PRODUCT_SELECTED;
  if (v.includes("follow up boss")) return "Follow Up Boss";
  if (v.includes("premier agent")) return "MBP";
  if (v.includes("showingtime") || v.includes("showcase")) return "Showcase";
  if (v.includes("zpro") || v.includes("zillow pro")) return "Zillow Pro";
  return NO_PRODUCT_SELECTED;
}

interface ActionsViewProps {
  loading: boolean;
  data?: ActionsData;
  filters: FilterState;
  onSubViewChange?: (subView: string) => void;
}

const formatCurrency = (val: number) => {
  if (val >= 1000000) return `$${(val / 1000000).toFixed(1)}M`;
  if (val >= 1000) return `$${(val / 1000).toFixed(1)}K`;
  return `$${Math.round(val)}`;
};

const CSV_COLUMNS: Record<string, { header: string; key: string; format?: (v: any) => string }[]> = {
  staleOpps: [
    { header: "Opportunity", key: "oppName" },
    { header: "Rep", key: "rep" },
    { header: "Account", key: "accountName" },
    { header: "Created", key: "createdDate" },
    { header: "Close Date", key: "closeDate" },
    { header: "Amount", key: "amount", format: (v) => (v ?? 0).toString() },
    { header: "Type", key: "type" },
    { header: "Product", key: "product", format: (v) => displayProduct(v ? String(v) : "") },
    { header: "Stage", key: "stage" },
  ],
  inbounds: [
    { header: "Inbound Time", key: "inboundTime" },
    { header: "Last Sales Activity", key: "lastSalesActivity" },
    { header: "Last Called", key: "lastCalled" },
    { header: "Total Calls", key: "totalCalls", format: (v) => (v ? String(v) : "") },
    { header: "Disposition", key: "disposition", format: (v) => (v && String(v).trim()) ? String(v) : "None" },
    { header: "Contact", key: "contact" },
    { header: "Lead Source", key: "leadSource" },
    { header: "Product", key: "productOfInterest", format: (v) => displayProductText(v ? String(v) : "") },
    { header: "Rep", key: "rep" },
    { header: "Opp Owner", key: "oppOwner" },
    { header: "Opportunity Stage", key: "oppStage" },
    { header: "Quote Type", key: "oppQuoteType" },
    { header: "Close Date", key: "oppCloseDate" },
    { header: "Ok to Contact", key: "okToContact" },
    { header: "Flex Status", key: "flexStatus" },
    { header: "Rep Active", key: "ownerActive", format: (v) => (v === false ? "Inactive" : "Active") },
  ],
  ccDeclines: [
    { header: "Account", key: "account" },
    { header: "Rep", key: "rep" },
    { header: "Declined Amount", key: "declinedAmount", format: (v) => (v ?? 0).toString() },
    { header: "Decline Date", key: "declineDate" },
    { header: "MRR", key: "mrr", format: (v) => (v ?? 0).toString() },
  ],
};

function exportCsv(items: any[], vizKey: string, label: string) {
  const cols = CSV_COLUMNS[vizKey];
  if (!cols) return;
  const escape = (s: string) => {
    const str = s ?? "";
    return str.includes(",") || str.includes('"') || str.includes("\n") ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const header = cols.map(c => c.header).join(",");
  const rows = items.map(item =>
    cols.map(c => escape(c.format ? c.format(item[c.key]) : String(item[c.key] ?? ""))).join(",")
  );
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${label.replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

type SortDir = "asc" | "desc";

export default function ActionsView({ loading, data, filters, onSubViewChange }: ActionsViewProps) {
  const [selectedViz, setSelectedViz] = useState<VizKey>("inbounds");
  // Default sort per table: Inbounds sorts by Inbound Time (most recent first);
  // other tables default to Amount descending.
  const defaultSortKey = (viz: VizKey) => (viz === "inbounds" ? "inboundMs" : "amount");
  const [sortKey, setSortKey] = useState<string>(defaultSortKey("inbounds"));
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [barFilter, setBarFilter] = useState<string | null>(null);
  // Task #542: generic per-column multiselect filters for the inbounds table.
  // Each entry is the set of EXCLUDED values for that filter key.
  const [excludedByFilter, setExcludedByFilter] = useState<Record<string, Set<string>>>({});
  const [dispFilterInitialized, setDispFilterInitialized] = useState(false);
  const [openFilterKey, setOpenFilterKey] = useState<string | null>(null);
  const filterDropdownRef = useRef<HTMLDivElement>(null);
  const KEEP_DISPOSITIONS = new Set(["none", "open", "qualified"]);
  // Task #545: chart-local Disposition filter for the Conversion Rate chart
  // (denominator only). Independent of the table's disposition filter.
  const CR_DEFAULT_DISPOSITIONS = new Set([
    "none",
    "open",
    "qualified",
    "contact attempted",
    "closed: won",
    "closed waitlist",
    "closed lost - not interested in purchase or upsell",
    "closed lost - abandoned",
  ]);
  const [crExcluded, setCrExcluded] = useState<Set<string>>(new Set());
  const [crFilterInitialized, setCrFilterInitialized] = useState(false);

  useEffect(() => {
    if (!openFilterKey) return;
    const handler = (e: MouseEvent) => {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(e.target as Node)) setOpenFilterKey(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openFilterKey]);

  const strKeys = new Set(["account", "rep", "declineDate", "contact", "leadSource", "inboundTime", "disposition", "productOfInterest", "oppName", "accountName", "createdDate", "closeDate", "type", "product", "stage", "status", "lastActivity", "lastContact", "lastSalesActivity", "lastActivityDate", "oppStage", "oppQuoteType", "oppCloseDate", "oppOwner", "okToContact", "flexStatus", "enterpriseRelated"]);

  useEffect(() => {
    onSubViewChange?.(selectedViz);
  }, [selectedViz, onSubViewChange]);

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(strKeys.has(key) ? "asc" : "desc"); }
  };

  const SortIcon = ({ col }: { col: string }) => {
    if (sortKey !== col) return <ArrowUpDown className="inline w-3 h-3 ml-0.5 opacity-40" />;
    return sortDir === "asc" ? <ArrowUp className="inline w-3 h-3 ml-0.5" /> : <ArrowDown className="inline w-3 h-3 ml-0.5" />;
  };

  const sortItems = (items: any[], key: string, dir: SortDir) => {
    return [...items].sort((a, b) => {
      const d = dir === "asc" ? 1 : -1;
      if (strKeys.has(key)) return d * ((a[key] || "").localeCompare(b[key] || ""));
      return d * ((a[key] || 0) - (b[key] || 0));
    });
  };

  const applyFilters = (items: any[]) => {
    let res = items;
    if (filters.slm.length > 0) res = res.filter(r => filters.slm.includes(r.slm));
    if (filters.flm.length > 0) res = res.filter(r => filters.flm.includes(r.flm));
    if (filters.rep.length > 0) res = res.filter(r => filters.rep.includes(r.rep || r.name));
    if (filters.region.length > 0) res = res.filter(r => filters.region.includes(r.region));
    res = res.filter(r => passesChannelFilter(r.group, filters.group));
    return res;
  };

  // The global Products filter maps onto each Inbound row's "Product of
  // Interest". Empty selection = all products.
  const applyInboundProductFilter = (items: any[]) => {
    if (!filters.products || filters.products.length === 0) return items;
    const selected = new Set(filters.products);
    return items.filter((r: any) => selected.has(mapInboundProduct(r.productOfInterest)));
  };

  const dateRange = useMemo(() => getDateRange(filters.timeframe, filters.customRange), [filters.timeframe, filters.customRange]);

  const filterByDateField = (items: any[], fieldName: string) => {
    if (!dateRange.from && !dateRange.to) return items;
    const fromMs = dateRange.from ? new Date(dateRange.from + "T00:00:00").getTime() : null;
    const toMs = dateRange.to ? new Date(dateRange.to + "T23:59:59").getTime() : null;
    return items.filter((item: any) => {
      const val = item[fieldName];
      if (!val) return true;
      const ms = typeof val === "number" ? val : new Date(val).getTime();
      if (isNaN(ms)) return true;
      if (fromMs && ms < fromMs) return false;
      if (toMs && ms > toMs) return false;
      return true;
    });
  };

  const processedData = useMemo(() => {
    if (!data) return null;
    return {
      staleOpps: filterByDateField(applyFilters(data.staleOpps || []), "closeDate"),
      inboundItems: applyInboundProductFilter(filterByDateField(applyFilters(data.inboundItems), "inboundMs")),
      ccDeclines: filterByDateField(applyFilters(data.ccDeclines), "declineDate"),
      actionItems: applyFilters(data.actionItems),
      topAccounts: applyFilters(data.topAccounts).sort((a: any, b: any) => b.mrrOpp - a.mrrOpp),
    };
  }, [data, filters]);

  const aggBy = filters.aggregateBy;

  useEffect(() => {
    setBarFilter(null);
  }, [aggBy, filters.slm, filters.flm, filters.rep, filters.region, filters.group]);

  const getAggKey = (item: any) => {
    if (aggBy === "FLM") return item.flm || item.manager || "Unknown";
    if (aggBy === "SLM") return item.slm || "Unknown";
    if (aggBy === "Region") return item.region || "Unknown";
    if (aggBy === "Segment") return item.segment || "Unknown";
    return item.rep || item.name || "Unknown";
  };

  const allItems = useMemo(() => {
    if (!processedData) return [];
    const map: Record<VizKey, any[]> = {
      staleOpps: processedData.staleOpps,
      inbounds: processedData.inboundItems,
      ccDeclines: processedData.ccDeclines,
      actionNeeded: processedData.actionItems,
      topAccounts: processedData.topAccounts,
    };
    return map[selectedViz] || [];
  }, [processedData, selectedViz]);

  const dispositionLabelOf = (item: any) =>
    item.disposition && String(item.disposition).trim() ? String(item.disposition) : "None";

  const blankLabelOf = (v: any) => (v && String(v).trim() ? String(v) : "None");

  // Task #542: inbound table header filters, in left-to-right display order.
  const INBOUND_FILTERS: { key: string; label: string; getValue: (item: any) => string }[] = [
    { key: "disposition", label: "Disposition", getValue: dispositionLabelOf },
    { key: "leadSource", label: "Lead Source", getValue: (i) => blankLabelOf(i.leadSource) },
    { key: "oppStage", label: "Opportunity Stage", getValue: (i) => blankLabelOf(i.oppStage) },
    { key: "repActive", label: "Rep Active", getValue: (i) => (i.ownerActive === false ? "Inactive" : "Active") },
    { key: "okToContact", label: "OK to Contact", getValue: (i) => blankLabelOf(i.okToContact) },
    { key: "flex", label: "Flex", getValue: (i) => blankLabelOf(i.flexStatus) },
  ];

  const distinctFilterValues = useMemo(() => {
    const result: Record<string, string[]> = {};
    if (!data) return result;
    for (const f of INBOUND_FILTERS) {
      const set = new Set<string>();
      for (const item of data.inboundItems || []) set.add(f.getValue(item));
      result[f.key] = Array.from(set).sort((a, b) => a.localeCompare(b));
    }
    return result;
  }, [data]);

  useEffect(() => {
    const dispValues = distinctFilterValues["disposition"] || [];
    if (dispFilterInitialized || dispValues.length === 0) return;
    const excluded = new Set<string>();
    for (const d of dispValues) {
      if (!KEEP_DISPOSITIONS.has(d.toLowerCase())) excluded.add(d);
    }
    setExcludedByFilter(prev => ({ ...prev, disposition: excluded }));
    setDispFilterInitialized(true);
  }, [distinctFilterValues, dispFilterInitialized]);

  useEffect(() => {
    const dispValues = distinctFilterValues["disposition"] || [];
    if (crFilterInitialized || dispValues.length === 0) return;
    const excluded = new Set<string>();
    for (const d of dispValues) {
      if (!CR_DEFAULT_DISPOSITIONS.has(d.toLowerCase())) excluded.add(d);
    }
    setCrExcluded(excluded);
    setCrFilterInitialized(true);
  }, [distinctFilterValues, crFilterInitialized]);

  const currentItems = useMemo(() => {
    let items = allItems;
    if (selectedViz === "inbounds") {
      for (const f of INBOUND_FILTERS) {
        const excluded = excludedByFilter[f.key];
        if (excluded && excluded.size > 0) {
          items = items.filter(i => !excluded.has(f.getValue(i)));
        }
      }
    }
    if (barFilter) {
      items = items.filter(item => getAggKey(item) === barFilter);
    }
    return sortItems(items, sortKey, sortDir);
  }, [allItems, sortKey, sortDir, barFilter, aggBy, selectedViz, excludedByFilter]);

  const barChartData = useMemo(() => {
    if (COMING_SOON_KEYS.has(selectedViz) || !allItems.length) return [];
    const counts: Record<string, number> = {};
    allItems.forEach((item: any) => {
      counts[getAggKey(item)] = (counts[getAggKey(item)] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [allItems, aggBy, selectedViz]);

  // Task #545: Conversion Rate chart data. Numerator = inbounds whose related
  // opp is Closed: Won AND the opp owner matches the inbound's owner (no
  // disposition filter). Denominator = inbounds passing the chart-local
  // Disposition filter. Rolled up by the selected aggregate.
  const conversionChartData = useMemo(() => {
    if (!processedData) return [];
    const agg: Record<string, { num: number; den: number }> = {};
    for (const item of processedData.inboundItems) {
      const key = getAggKey(item);
      if (!agg[key]) agg[key] = { num: 0, den: 0 };
      const stage = (item.oppStage || "").trim().toLowerCase();
      const oppOwner = (item.oppOwner || "").trim();
      const rep = (item.rep || "").trim();
      if (stage === "closed: won" && oppOwner && oppOwner === rep) agg[key].num++;
      if (!crExcluded.has(dispositionLabelOf(item))) agg[key].den++;
    }
    return Object.entries(agg)
      .filter(([, v]) => v.den > 0)
      .map(([name, v]) => ({ name, rate: Math.round((v.num / v.den) * 100), num: v.num, den: v.den }))
      .sort((a, b) => b.rate - a.rate);
  }, [processedData, aggBy, crExcluded]);

  // Task #551: when current filters yield exactly one dimension group, all
  // three top graphs collapse together into big bold aggregate numbers.
  const singleGroup = barChartData.length === 1;

  const vizLabel = VIZ_OPTIONS.find(v => v.key === selectedViz)?.label || "";
  const isComingSoon = COMING_SOON_KEYS.has(selectedViz);

  if (loading || !processedData) {
    return (
      <div className="flex gap-4 h-full">
        <Card className="no-shadow flex-1"><CardContent className="p-6"><Skeleton className="h-4 w-1/2 mb-4" /><Skeleton className="h-[400px] w-full" /></CardContent></Card>
        <Card className="no-shadow flex-[2]"><CardContent className="p-6"><Skeleton className="h-4 w-1/2 mb-4" /><Skeleton className="h-[400px] w-full" /></CardContent></Card>
      </div>
    );
  }

  const sfReportForViz: Record<string, string> = {
    staleOpps: SF_OPPS_REPORT,
    inbounds: SF_INBOUNDS_REPORT,
    ccDeclines: SF_CC_DECLINES_REPORT,
    actionNeeded: SF_OPPS_REPORT,
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 border-b border-border -mt-2">
        {VIZ_OPTIONS.filter(opt => !HIDDEN_VIZ_KEYS.has(opt.key)).map(opt => {
          const active = selectedViz === opt.key;
          return (
            <button
              key={opt.key}
              onClick={() => { setSelectedViz(opt.key); setBarFilter(null); setSortKey(defaultSortKey(opt.key)); setSortDir("desc"); }}
              className={`relative px-3 py-2 text-[12px] font-medium transition-colors ${active ? "text-[#006AFF]" : "text-muted-foreground hover:text-foreground"}`}
            >
              <span className="inline-flex items-center gap-1.5">
                {opt.label}
                {COMING_SOON_KEYS.has(opt.key) && <span className="text-[9px] bg-amber-100 text-amber-800 px-1 py-0.5 rounded">Sample</span>}
              </span>
              {active && <span className="absolute left-2 right-2 -bottom-px h-0.5 bg-[#006AFF] rounded-t" />}
            </button>
          );
        })}
      </div>
      {barFilter && (
        <div className="flex items-center justify-center gap-3 -mt-2">
          <button
            onClick={() => setBarFilter(null)}
            className="text-[11px] text-[#006AFF] hover:underline"
          >
            Clear filter
          </button>
        </div>
      )}
      {selectedViz === "inbounds" && (
        <div className="grid grid-cols-3 gap-4" style={singleGroup ? { height: 120, minHeight: 120 } : { height: "25vh", minHeight: 160 }}>
          <div className="no-shadow flex flex-col rounded-lg border bg-card text-card-foreground overflow-hidden">
            <div className="px-4 pt-3 pb-1 shrink-0">
              <div className="text-[13px] font-semibold">Inbounds by {aggBy}</div>
            </div>
            {singleGroup ? (
              <div className="flex-1 flex items-center justify-center px-2 pb-2">
                <div className="text-2xl font-bold text-[#0f172a] text-center truncate" title={`${barChartData[0].name}: ${barChartData[0].count}`}>
                  {barChartData[0].name}: {barChartData[0].count.toLocaleString()}
                </div>
              </div>
            ) : barChartData.length > 0 ? (
              <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
                <div style={{ height: Math.max(barChartData.length * 28, 80) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={barChartData} layout="vertical" margin={{ left: 10, right: 35, top: 5, bottom: 5 }}>
                      <XAxis type="number" tick={{ fontSize: 10 }} />
                      <YAxis dataKey="name" type="category" width={90} tick={{ fontSize: 10 }} interval={0} />
                      <Tooltip contentStyle={{ fontSize: 11 }} />
                      <Bar dataKey="count" radius={[0, 4, 4, 0]} style={{ cursor: "pointer" }} onClick={(_data: any, idx: number) => {
                        const clickedName = barChartData[idx]?.name;
                        if (clickedName) setBarFilter(prev => prev === clickedName ? null : clickedName);
                      }}>
                        <LabelList dataKey="count" position="right" style={{ fontSize: 10, fill: "#334155" }} />
                        {barChartData.map((entry, idx) => (
                          <Cell
                            key={idx}
                            fill={barFilter === entry.name ? "#004ABF" : (idx % 2 === 0 ? "#006AFF" : "#38bdf8")}
                            opacity={barFilter && barFilter !== entry.name ? 0.35 : 1}
                            stroke={barFilter === entry.name ? "#002060" : "none"}
                            strokeWidth={barFilter === entry.name ? 2 : 0}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground">No data</div>
            )}
          </div>
          <div className="no-shadow flex flex-col rounded-lg border bg-card text-card-foreground overflow-hidden">
            <div className="px-4 pt-3 pb-1 shrink-0 flex items-center justify-between gap-2">
              <div className="text-[13px] font-semibold">Conversion Rate</div>
              <div className="relative" ref={openFilterKey === "crDisposition" ? filterDropdownRef : undefined}>
                <button
                  onClick={() => setOpenFilterKey(o => (o === "crDisposition" ? null : "crDisposition"))}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] border border-border rounded-md bg-white hover:bg-gray-50 transition-colors"
                  title="Filter by Disposition"
                >
                  Disposition
                  {crExcluded.size > 0 && (
                    <span className="text-[10px] bg-[#006AFF]/10 text-[#006AFF] px-1.5 py-0.5 rounded">{(distinctFilterValues["disposition"] || []).length - crExcluded.size}/{(distinctFilterValues["disposition"] || []).length}</span>
                  )}
                  <ChevronDown className="w-3 h-3 text-muted-foreground" />
                </button>
                {openFilterKey === "crDisposition" && (
                  <div className="absolute top-full right-0 mt-1 bg-white border border-border rounded-md shadow-lg z-50 min-w-[200px] max-h-[300px] overflow-auto">
                    <div className="flex justify-between px-2 py-1.5 border-b border-border/60 sticky top-0 bg-white text-[10px]">
                      <button onClick={() => setCrExcluded(new Set())} className="text-[#006AFF] hover:underline">Select all</button>
                      <button onClick={() => setCrExcluded(new Set(distinctFilterValues["disposition"] || []))} className="text-muted-foreground hover:underline">Clear</button>
                    </div>
                    {(distinctFilterValues["disposition"] || []).map(d => {
                      const checked = !crExcluded.has(d);
                      return (
                        <label key={d} className="flex items-center gap-2 px-2 py-1.5 text-[11px] hover:bg-gray-50 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setCrExcluded(prev => {
                              const next = new Set(prev);
                              if (next.has(d)) next.delete(d); else next.add(d);
                              return next;
                            })}
                          />
                          <span className="truncate">{d}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            {singleGroup ? (
              <div className="flex-1 flex items-center justify-center px-2 pb-2">
                <div className="text-2xl font-bold text-[#0f172a] text-center truncate" title={`${barChartData[0].name}: ${conversionChartData.length > 0 ? conversionChartData[0].rate : 0}%`}>
                  {barChartData[0].name}: {conversionChartData.length > 0 ? conversionChartData[0].rate : 0}%
                </div>
              </div>
            ) : conversionChartData.length > 0 ? (
              <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
                <div style={{ height: Math.max(conversionChartData.length * 28, 80) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={conversionChartData} layout="vertical" margin={{ left: 10, right: 35, top: 5, bottom: 5 }}>
                      <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${v}%`} />
                      <YAxis dataKey="name" type="category" width={90} tick={{ fontSize: 10 }} interval={0} />
                      <Tooltip
                        content={({ active, payload }: any) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0].payload;
                          return (
                            <div className="bg-white border border-border rounded-md shadow-md px-2.5 py-1.5" style={{ fontSize: 11 }}>
                              <div className="font-semibold mb-0.5">{d.name}</div>
                              <div>Conversion Rate: {d.rate}%</div>
                              <div>Inbounds Assigned to Rep: {d.den.toLocaleString()}</div>
                              <div>Inbounds Closed by Rep: {d.num.toLocaleString()}</div>
                            </div>
                          );
                        }}
                      />
                      <Bar dataKey="rate" radius={[0, 4, 4, 0]} style={{ cursor: "pointer" }} onClick={(_data: any, idx: number) => {
                        const clickedName = conversionChartData[idx]?.name;
                        if (clickedName) setBarFilter(prev => prev === clickedName ? null : clickedName);
                      }}>
                        <LabelList dataKey="rate" position="right" formatter={(v: any) => `${v}%`} style={{ fontSize: 10, fill: "#334155" }} />
                        {conversionChartData.map((entry, idx) => (
                          <Cell
                            key={idx}
                            fill={barFilter === entry.name ? "#004ABF" : (idx % 2 === 0 ? "#006AFF" : "#38bdf8")}
                            opacity={barFilter && barFilter !== entry.name ? 0.35 : 1}
                            stroke={barFilter === entry.name ? "#002060" : "none"}
                            strokeWidth={barFilter === entry.name ? 2 : 0}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground">No data</div>
            )}
          </div>
          <div className="no-shadow flex flex-col rounded-lg border bg-card text-card-foreground overflow-hidden">
            <div className="px-4 pt-3 pb-1 shrink-0">
              <div className="text-[13px] font-semibold">Touchpoints Per Open Inbound</div>
            </div>
            <div className="flex-1 flex items-center justify-center rounded-lg m-2" style={{ backgroundColor: "rgba(241,245,249,0.85)" }}>
              <div className="text-center">
                <div className="text-[13px] font-semibold text-[#64748b]">Coming soon</div>
                <div className="text-[11px] text-[#94a3b8] mt-0.5">Data source in the works</div>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="flex gap-4" style={{ height: 520 }}>
        {selectedViz !== "inbounds" && (
        <div className="no-shadow flex flex-col rounded-lg border bg-card text-card-foreground" style={{ flex: "0 0 33%", overflow: "hidden" }}>
          <div className="px-4 pt-4 pb-2 shrink-0">
            <div className="text-[13px] font-semibold">Count by {aggBy}</div>
          </div>
          {isComingSoon ? (
            <div className="flex-1 flex items-center justify-center rounded-lg m-2" style={{ backgroundColor: "rgba(241,245,249,0.85)" }}>
              <div className="text-[14px] font-semibold text-[#334155]">Coming Soon!</div>
            </div>
          ) : barChartData.length > 0 ? (
            <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
              <div style={{ height: barChartData.length * 28 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barChartData} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
                    <XAxis type="number" tick={{ fontSize: 10 }} />
                    <YAxis dataKey="name" type="category" width={90} tick={{ fontSize: 10 }} interval={0} />
                    <Tooltip contentStyle={{ fontSize: 11 }} />
                    <Bar dataKey="count" radius={[0, 4, 4, 0]} style={{ cursor: "pointer" }} onClick={(_data: any, idx: number) => {
                      const clickedName = barChartData[idx]?.name;
                      if (clickedName) setBarFilter(prev => prev === clickedName ? null : clickedName);
                    }}>
                      {barChartData.map((entry, idx) => (
                        <Cell
                          key={idx}
                          fill={barFilter === entry.name ? "#004ABF" : (idx % 2 === 0 ? "#006AFF" : "#38bdf8")}
                          opacity={barFilter && barFilter !== entry.name ? 0.35 : 1}
                          stroke={barFilter === entry.name ? "#002060" : "none"}
                          strokeWidth={barFilter === entry.name ? 2 : 0}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground">No data</div>
          )}
        </div>
        )}

        <Card className="no-shadow flex flex-col min-w-0 overflow-hidden" style={{ flex: selectedViz === "inbounds" ? "1 1 100%" : "0 0 67%" }}>
          <CardContent className="p-0 flex-1 min-h-0 flex flex-col relative">
            {(selectedViz === "inbounds" || selectedViz === "staleOpps" || selectedViz === "ccDeclines") && (
              <div className="flex items-center gap-2 px-3 pt-3 pb-2 shrink-0 border-b border-border/40">
                <div className="flex items-center gap-2 flex-nowrap shrink-0">
                  {selectedViz === "inbounds" && INBOUND_FILTERS.map(f => {
                    const values = distinctFilterValues[f.key] || [];
                    const excluded = excludedByFilter[f.key] || new Set<string>();
                    const open = openFilterKey === f.key;
                    return (
                      <div key={f.key} className="relative" ref={open ? filterDropdownRef : undefined}>
                        <button
                          onClick={() => setOpenFilterKey(o => (o === f.key ? null : f.key))}
                          className="flex items-center gap-1 px-2 py-1 text-[11px] border border-border rounded-md bg-white hover:bg-gray-50 transition-colors"
                          title={`Filter by ${f.label}`}
                        >
                          {f.label}
                          {excluded.size > 0 && (
                            <span className="text-[10px] bg-[#006AFF]/10 text-[#006AFF] px-1.5 py-0.5 rounded">{values.length - excluded.size}/{values.length}</span>
                          )}
                          <ChevronDown className="w-3 h-3 text-muted-foreground" />
                        </button>
                        {open && (
                          <div className="absolute top-full left-0 mt-1 bg-white border border-border rounded-md shadow-lg z-50 min-w-[200px] max-h-[300px] overflow-auto">
                            <div className="flex justify-between px-2 py-1.5 border-b border-border/60 sticky top-0 bg-white text-[10px]">
                              <button onClick={() => setExcludedByFilter(prev => ({ ...prev, [f.key]: new Set() }))} className="text-[#006AFF] hover:underline">Select all</button>
                              <button onClick={() => setExcludedByFilter(prev => ({ ...prev, [f.key]: new Set(values) }))} className="text-muted-foreground hover:underline">Clear</button>
                            </div>
                            {values.map(d => {
                              const checked = !excluded.has(d);
                              return (
                                <label key={d} className="flex items-center gap-2 px-2 py-1.5 text-[11px] hover:bg-gray-50 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => setExcludedByFilter(prev => {
                                      const next = new Set(prev[f.key] || []);
                                      if (next.has(d)) next.delete(d); else next.add(d);
                                      return { ...prev, [f.key]: next };
                                    })}
                                  />
                                  <span className="truncate">{f.key === "productOfInterest" ? displayProduct(d) : d}</span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="text-[13px] font-semibold text-center flex-1 min-w-0">{vizLabel}</div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] text-muted-foreground">{currentItems.length} items{barFilter ? ` (filtered: ${barFilter})` : ""}</span>
                  {sfReportForViz[selectedViz] && <SfReportLink href={sfReportForViz[selectedViz]} />}
                  {CSV_COLUMNS[selectedViz] && (
                    <button
                      onClick={() => exportCsv(currentItems, selectedViz, vizLabel)}
                      className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground border border-border rounded-md hover:bg-gray-50 transition-colors"
                      title={`Export ${vizLabel} to CSV`}
                    >
                      <Download className="w-3.5 h-3.5" />
                      CSV
                    </button>
                  )}
                </div>
              </div>
            )}
            {isComingSoon && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg" style={{ backgroundColor: "rgba(241,245,249,0.75)" }}>
                <div className="text-center">
                  <div className="text-[16px] font-semibold text-[#334155]">Coming Soon!</div>
                  <div className="text-[12px] text-[#64748b] mt-1">This view is under development</div>
                </div>
              </div>
            )}
            {selectedViz === "staleOpps" && <StaleOppsTable items={currentItems} handleSort={handleSort} SortIcon={SortIcon} />}
            {selectedViz !== "staleOpps" && (
              <div className="flex-1 min-h-0 overflow-auto">
                {selectedViz === "inbounds" && renderInbounds(currentItems, handleSort, SortIcon)}
                {selectedViz === "ccDeclines" && renderCcDeclines(currentItems, handleSort, SortIcon)}
                {selectedViz === "actionNeeded" && renderActionNeeded(currentItems)}
                {selectedViz === "topAccounts" && renderTopAccounts(currentItems)}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StaleOppsTable({ items, handleSort, SortIcon }: { items: any[]; handleSort: (k: string) => void; SortIcon: React.FC<{ col: string }> }) {
  const TABLE_W = 1400;

  return (
    <div className="flex-1 min-h-0 overflow-auto scrollbar-visible">
      <table className="w-full caption-bottom text-sm table-fixed" style={{ minWidth: TABLE_W }}>
        <TableHeader className="sticky top-0 bg-white z-10 shadow-[0_1px_0_0_#e2e8f0]">
          <TableRow className="hover:bg-transparent">
            <TableHead className="text-[11px] h-8 cursor-pointer select-none hover:bg-gray-50 whitespace-nowrap" style={{ width: 280 }} onClick={() => handleSort("oppName")}>Opportunity <SortIcon col="oppName" /></TableHead>
            <TableHead className="text-[11px] h-8 cursor-pointer select-none hover:bg-gray-50 whitespace-nowrap" style={{ width: 140 }} onClick={() => handleSort("rep")}>Rep <SortIcon col="rep" /></TableHead>
            <TableHead className="text-[11px] h-8 cursor-pointer select-none hover:bg-gray-50 whitespace-nowrap" style={{ width: 220 }} onClick={() => handleSort("accountName")}>Account <SortIcon col="accountName" /></TableHead>
            <TableHead className="text-[11px] h-8 cursor-pointer select-none hover:bg-gray-50 whitespace-nowrap" style={{ width: 100 }} onClick={() => handleSort("createdDate")}>Created <SortIcon col="createdDate" /></TableHead>
            <TableHead className="text-[11px] h-8 cursor-pointer select-none hover:bg-gray-50 whitespace-nowrap" style={{ width: 100 }} onClick={() => handleSort("closeDate")}>Close Date <SortIcon col="closeDate" /></TableHead>
            <TableHead className="text-[11px] h-8 text-right cursor-pointer select-none hover:bg-gray-50 whitespace-nowrap" style={{ width: 90 }} onClick={() => handleSort("amount")}>Amount <SortIcon col="amount" /></TableHead>
            <TableHead className="text-[11px] h-8 cursor-pointer select-none hover:bg-gray-50 whitespace-nowrap" style={{ width: 120 }} onClick={() => handleSort("type")}>Type <SortIcon col="type" /></TableHead>
            <TableHead className="text-[11px] h-8 cursor-pointer select-none hover:bg-gray-50 whitespace-nowrap" style={{ width: 120 }} onClick={() => handleSort("product")}>Product <SortIcon col="product" /></TableHead>
            <TableHead className="text-[11px] h-8 cursor-pointer select-none hover:bg-gray-50 whitespace-nowrap" style={{ width: 130 }} onClick={() => handleSort("stage")}>Stage <SortIcon col="stage" /></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item: any, i: number) => (
            <TableRow key={i}>
              <TableCell title={item.oppName || ""} className="py-2 text-[12px] font-medium overflow-hidden text-ellipsis whitespace-nowrap">
                {item.oppId ? (
                  <a href={`${sfClassicRecordUrl(item.oppId)}`} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline inline-flex items-center gap-1 max-w-full">
                    <span className="truncate">{item.oppName}</span>
                    <ExternalLink className="w-3 h-3 shrink-0" />
                  </a>
                ) : <span className="truncate block">{item.oppName}</span>}
              </TableCell>
              <TableCell title={item.rep || ""} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{item.rep}</TableCell>
              <TableCell title={item.accountName || ""} className="py-2 text-[12px] font-medium overflow-hidden text-ellipsis whitespace-nowrap">
                {item.accountId ? (
                  <a href={`${sfClassicRecordUrl(item.accountId)}`} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline inline-flex items-center gap-1 max-w-full">
                    <span className="truncate">{item.accountName}</span>
                    <ExternalLink className="w-3 h-3 shrink-0" />
                  </a>
                ) : <span className="truncate block">{item.accountName}</span>}
              </TableCell>
              <TableCell title={item.createdDate || ""} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{item.createdDate}</TableCell>
              <TableCell title={item.closeDate || ""} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{item.closeDate}</TableCell>
              <TableCell title={formatCurrency(item.amount)} className="py-2 text-[12px] text-right font-medium whitespace-nowrap">{formatCurrency(item.amount)}</TableCell>
              <TableCell title={item.type || ""} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{item.type}</TableCell>
              <TableCell title={displayProduct(item.product || "")} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{displayProduct(item.product || "")}</TableCell>
              <TableCell title={item.stage || ""} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{item.stage}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </table>
    </div>
  );
}

// Red if the last sales activity happened before the inbound came in, green if
// after. Sheet values are often date-only (no time), so date-only values are
// compared at day granularity (same-day activity counts as "after").
function lastSalesActivityClass(item: any): string {
  const raw = String(item.lastSalesActivity || "").trim();
  const inboundMs = item.inboundMs;
  if (!raw || !inboundMs) return "text-[#64748b]";
  const parsed = new Date(raw);
  const ms = parsed.getTime();
  if (isNaN(ms)) return "text-[#64748b]";
  const hasTime = /\d:\d{2}/.test(raw);
  const activityMs = hasTime
    ? ms
    : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 23, 59, 59, 999).getTime();
  return activityMs >= inboundMs
    ? "bg-[#DCFCE7] text-[#166534]"
    : "bg-[#FEE2E2] text-[#991B1B]";
}

function renderInbounds(items: any[], handleSort: (k: string) => void, SortIcon: React.FC<{ col: string }>) {
  const th = (key: string, label: string, extra = "") => (
    <TableHead className={`text-[11px] h-8 cursor-pointer select-none hover:bg-gray-50 whitespace-nowrap ${extra}`} onClick={() => handleSort(key)}>{label} <SortIcon col={key} /></TableHead>
  );
  return (
    <table className="w-full caption-bottom text-sm">
      <TableHeader className="sticky top-0 bg-white z-10 shadow-[0_1px_0_0_#e2e8f0]">
        <TableRow className="hover:bg-transparent">
          {th("inboundMs", "Inbound Time")}
          {th("lastSalesActivity", "Last Sales Activity")}
          {th("lastCalledMs", "Last Called")}
          {th("totalCalls", "Total Calls")}
          {th("disposition", "Disposition")}
          {th("contact", "Interaction")}
          {th("leadSource", "Lead Source")}
          {th("productOfInterest", "Product")}
          {th("rep", "Rep")}
          {th("oppOwner", "Opp Owner")}
          {th("oppStage", "Related Opportunity")}
          {th("oppQuoteType", "Quote Type")}
          {th("oppCloseDate", "Close Date")}
          {th("okToContact", "Ok to Contact")}
          {th("flexStatus", "Flex Status")}
          <TableHead className="text-[11px] h-8 whitespace-nowrap">Touch Points Before Closed</TableHead>
          {th("ownerActive", "Rep Active")}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item: any, i: number) => {
          const dispositionLabel = item.disposition && String(item.disposition).trim() ? String(item.disposition) : "None";
          return (
          <TableRow key={i}>
            <TableCell title={item.inboundTime || ""} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{item.inboundTime}</TableCell>
            <TableCell title={item.lastSalesActivity || ""} className={`py-2 text-[12px] whitespace-nowrap ${lastSalesActivityClass(item)}`}>{item.lastSalesActivity}</TableCell>
            <TableCell title={item.lastCalled || ""} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">
              {item.lastCalled ? (
                item.lastCalledConversationId ? (
                  <a href={`${sfRecordUrl("Gong__Gong_Call__c", item.lastCalledConversationId)}`} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline">{item.lastCalled}</a>
                ) : item.lastCalled
              ) : "—"}
            </TableCell>
            <TableCell title={item.totalCalls ? String(item.totalCalls) : ""} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{item.totalCalls ? item.totalCalls : "—"}</TableCell>
            <TableCell title={dispositionLabel} className="py-2 text-[12px] whitespace-nowrap">{dispositionLabel}</TableCell>
            <TableCell title={item.contact || ""} className="py-2 text-[12px] font-medium whitespace-nowrap overflow-hidden text-ellipsis" style={{ maxWidth: 120 }}>
              {item.interactionId ? (
                <a href={`${sfRecordUrl("Interaction__c", item.interactionId)}`} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline block truncate">{item.contact}</a>
              ) : <span className="block truncate">{item.contact}</span>}
            </TableCell>
            <TableCell title={item.leadSource || ""} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{item.leadSource}</TableCell>
            <TableCell title={displayProductText(item.productOfInterest || "")} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{displayProductText(item.productOfInterest || "")}</TableCell>
            <TableCell title={item.rep || ""} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{item.rep}</TableCell>
            <TableCell title={item.oppOwner || ""} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{item.oppOwner}</TableCell>
            <TableCell title={item.oppStage || ""} className="py-2 text-[12px] whitespace-nowrap">
              {item.oppId18 ? (
                <a href={`${sfClassicRecordUrl(item.oppId18)}`} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline">{item.oppStage || "View Opp"}</a>
              ) : (item.oppStage || "")}
            </TableCell>
            <TableCell title={item.oppQuoteType || ""} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{item.oppQuoteType}</TableCell>
            <TableCell title={item.oppCloseDate || ""} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{item.oppCloseDate}</TableCell>
            <TableCell title={item.okToContact || ""} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{item.okToContact}</TableCell>
            <TableCell title={item.flexStatus || ""} className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">{item.flexStatus}</TableCell>
            <TableCell title="WIP" className="py-2 text-[12px] text-[#64748b] whitespace-nowrap">WIP</TableCell>
            <TableCell title={item.ownerActive === false ? "Inactive" : "Active"} className="py-2 text-[12px] whitespace-nowrap">
              {item.ownerActive === false
                ? <Badge className="bg-[#EF4444] hover:bg-[#EF4444]/90 text-[10px] px-1.5 py-0">Inactive</Badge>
                : <Badge className="bg-[#00C49F] hover:bg-[#00C49F]/90 text-[10px] px-1.5 py-0">Active</Badge>}
            </TableCell>
          </TableRow>
          );
        })}
      </TableBody>
    </table>
  );
}

function renderCcDeclines(items: any[], handleSort: (k: string) => void, SortIcon: React.FC<{ col: string }>) {
  return (
    <Table>
      <TableHeader className="sticky top-0 bg-white z-10 shadow-[0_1px_0_0_#e2e8f0]">
        <TableRow className="hover:bg-transparent">
          <TableHead className="text-[11px] h-8 cursor-pointer select-none hover:bg-gray-50" onClick={() => handleSort("account")}>Account <SortIcon col="account" /></TableHead>
          <TableHead className="text-[11px] h-8 cursor-pointer select-none hover:bg-gray-50" onClick={() => handleSort("rep")}>Rep <SortIcon col="rep" /></TableHead>
          <TableHead className="text-[11px] h-8 text-right cursor-pointer select-none hover:bg-gray-50" onClick={() => handleSort("declinedAmount")}>Declined Amt <SortIcon col="declinedAmount" /></TableHead>
          <TableHead className="text-[11px] h-8 cursor-pointer select-none hover:bg-gray-50" onClick={() => handleSort("declineDate")}>Decline Date <SortIcon col="declineDate" /></TableHead>
          <TableHead className="text-[11px] h-8 text-right cursor-pointer select-none hover:bg-gray-50" onClick={() => handleSort("mrr")}>MRR <SortIcon col="mrr" /></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item: any, i: number) => (
          <TableRow key={i}>
            <TableCell title={item.account || ""} className="py-2 text-[12px] font-medium">
              {item.contactId ? (
                <a href={`${sfRecordUrl("Contact", item.contactId)}`} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline">{item.account}</a>
              ) : item.account}
            </TableCell>
            <TableCell title={item.rep || ""} className="py-2 text-[12px] text-[#64748b]">{item.rep}</TableCell>
            <TableCell title={formatCurrency(item.declinedAmount)} className="py-2 text-[12px] text-right text-[#EF4444] font-medium">{formatCurrency(item.declinedAmount)}</TableCell>
            <TableCell title={item.declineDate || ""} className="py-2 text-[12px] text-[#64748b]">{item.declineDate}</TableCell>
            <TableCell title={formatCurrency(item.mrr)} className="py-2 text-[12px] text-right font-medium">{formatCurrency(item.mrr)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function renderActionNeeded(items: any[]) {
  return (
    <Table>
      <TableHeader className="sticky top-0 bg-white z-10 shadow-[0_1px_0_0_#e2e8f0]">
        <TableRow className="hover:bg-transparent">
          <TableHead className="text-[11px] h-8">Account</TableHead>
          <TableHead className="text-[11px] h-8">Rep</TableHead>
          <TableHead className="text-[11px] h-8">Opp Status</TableHead>
          <TableHead className="text-[11px] h-8">Last Activity</TableHead>
          <TableHead className="text-[11px] h-8">Last Contact</TableHead>
          <TableHead className="text-[11px] h-8">Awaiting Follow-Up</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item: any, i: number) => (
          <TableRow key={i} className={item.awaiting ? "bg-red-50/50 hover:bg-red-50" : ""}>
            <TableCell title={item.account || ""} className="py-2 text-[12px] font-medium">{item.account}</TableCell>
            <TableCell title={item.rep || ""} className="py-2 text-[12px] text-[#64748b]">{item.rep}</TableCell>
            <TableCell title={item.status || ""} className="py-2 text-[12px] text-[#64748b]">{item.status}</TableCell>
            <TableCell title={item.lastActivity || ""} className="py-2 text-[12px] text-[#64748b]">{item.lastActivity}</TableCell>
            <TableCell title={item.lastContact || ""} className="py-2 text-[12px] text-[#64748b]">{item.lastContact}</TableCell>
            <TableCell title={item.awaiting ? "True" : "False"} className="py-2 text-[12px]">
              {item.awaiting ?
                <Badge className="bg-[#EF4444] hover:bg-[#EF4444]/90 text-[10px] px-1.5 py-0">True</Badge> :
                <Badge className="bg-[#00C49F] hover:bg-[#00C49F]/90 text-[10px] px-1.5 py-0">False</Badge>
              }
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function renderTopAccounts(items: any[]) {
  return (
    <Table>
      <TableHeader className="sticky top-0 bg-white z-10 shadow-[0_1px_0_0_#e2e8f0]">
        <TableRow className="hover:bg-transparent">
          <TableHead className="text-[11px] h-8">Account</TableHead>
          <TableHead className="text-[11px] h-8">Rep</TableHead>
          <TableHead className="text-[11px] h-8">Current MRR</TableHead>
          <TableHead className="text-[11px] h-8 font-bold text-[#006AFF]">MRR Opp</TableHead>
          <TableHead className="text-[11px] h-8">Last Contact</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item: any, i: number) => (
          <TableRow key={i}>
            <TableCell title={item.account || ""} className="py-2 text-[12px] font-medium">{item.account}</TableCell>
            <TableCell title={item.rep || ""} className="py-2 text-[12px] text-[#64748b]">{item.rep}</TableCell>
            <TableCell title={formatCurrency(item.currentMrr)} className="py-2 text-[12px] text-[#64748b]">{formatCurrency(item.currentMrr)}</TableCell>
            <TableCell title={formatCurrency(item.mrrOpp)} className="py-2 text-[12px] font-bold text-[#006AFF]">{formatCurrency(item.mrrOpp)}</TableCell>
            <TableCell title={item.lastContact || ""} className="py-2 text-[12px] text-[#64748b]">{item.lastContact}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
