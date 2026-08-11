import React, { useState, useMemo, useEffect, useCallback } from "react";
import { X, ArrowUpDown, ArrowUp, ArrowDown, Download, ExternalLink } from "lucide-react";
import { FilterState, AggregateBy } from "../pages/Dashboard";
import { getDateRange, passesChannelFilter, nowPST } from "@/lib/utils";
import { sfRecordUrl, sfClassicRecordUrl } from "@/lib/sf-links";

interface CallRecord {
  started: string;
  durationMin: number;
  manager: string;
  rep: string;
  accountName: string;
  accountId: string;
  oppName: string;
  oppStage: string;
  conversationTitle: string;
  conversationId: string;
  gongId: string;
  region: string;
  group: string;
  flm: string;
  slm: string;
}

type SortKey = "started" | "durationMin" | "manager" | "rep" | "accountName" | "oppStage" | "conversationTitle" | "gongId";
type SortDir = "asc" | "desc";

const GONG_NOTES_BASE = "https://us-1761.app.gong.io/call?id=";

function parseDate(d: string): number {
  const t = Date.parse(d);
  return isNaN(t) ? 0 : t;
}

type CallDrilldownMode = "dials" | "convos";

interface CallDrilldownModalProps {
  mode: CallDrilldownMode;
  filters: FilterState;
  nameFilter?: string;
  nameFilterDimension?: AggregateBy;
  onClose: () => void;
}

export default function CallDrilldownModal({ mode, filters, nameFilter, nameFilterDimension, onClose }: CallDrilldownModalProps) {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("started");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [displayLimit, setDisplayLimit] = useState(200);

  const apiBase = import.meta.env.BASE_URL || "/";

  useEffect(() => {
    setLoading(true);
    const dr = getDateRange(filters.timeframe, filters.customRange);
    const params = new URLSearchParams();
    params.set("type", mode);
    if (dr.from) params.set("from", dr.from);
    if (dr.to) params.set("to", dr.to);
    if (!dr.from && !dr.to) params.set("timeframe", filters.timeframe);
    fetch(`${apiBase}api/sales/calls?${params.toString()}`)
      .then(r => r.json())
      .then(data => {
        setCalls(data.calls || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [mode, apiBase, filters.timeframe, filters.customRange]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const filteredCalls = useMemo(() => {
    let res = calls;
    if (nameFilter && nameFilterDimension) {
      switch (nameFilterDimension) {
        case "Rep": res = res.filter(c => c.rep === nameFilter); break;
        case "FLM": res = res.filter(c => c.flm === nameFilter); break;
        case "SLM": res = res.filter(c => c.slm === nameFilter); break;
        case "Region": res = res.filter(c => c.region === nameFilter); break;
      }
    }
    if (filters.slm.length > 0) res = res.filter(c => filters.slm.includes(c.slm));
    if (filters.flm.length > 0) res = res.filter(c => filters.flm.includes(c.flm));
    if (nameFilterDimension !== "Rep" && filters.rep.length > 0) res = res.filter(c => filters.rep.includes(c.rep));
    if (filters.region.length > 0) res = res.filter(c => filters.region.includes(c.region));
    res = res.filter(c => passesChannelFilter(c.group, filters.group));
    return res;
  }, [calls, filters, nameFilter, nameFilterDimension]);

  const sortedCalls = useMemo(() => {
    const sorted = [...filteredCalls].sort((a, b) => {
      if (sortKey === "started") {
        const cmp = parseDate(a.started) - parseDate(b.started);
        return sortDir === "asc" ? cmp : -cmp;
      }
      if (sortKey === "durationMin") {
        const cmp = a.durationMin - b.durationMin;
        return sortDir === "asc" ? cmp : -cmp;
      }
      const aVal = String((a as any)[sortKey] || "").toLowerCase();
      const bVal = String((b as any)[sortKey] || "").toLowerCase();
      const cmp = aVal.localeCompare(bVal);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [filteredCalls, sortKey, sortDir]);

  const displayedCalls = useMemo(() => sortedCalls.slice(0, displayLimit), [sortedCalls, displayLimit]);
  const hasMore = sortedCalls.length > displayLimit;

  const totalDuration = useMemo(() => filteredCalls.reduce((s, c) => s + c.durationMin, 0), [filteredCalls]);

  const now = nowPST();
  const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateStr = now.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: userTz });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: userTz });
  const timeframeLabel = filters.timeframe === "mtd" ? "This Month" : filters.timeframe === "lastMonth" ? "Last Month" : filters.timeframe === "mtd2date" ? "MTD" : filters.timeframe === "eom" ? "EOM" : filters.timeframe === "thisWeek" ? "This Week" : filters.timeframe === "today" ? "Today" : filters.timeframe === "custom" && filters.customRange ? `${filters.customRange.from.toLocaleDateString()} – ${filters.customRange.to.toLocaleDateString()}` : "Custom";
  const modeLabel = mode === "dials" ? "Dials — Call Detail" : "Meaningful Conversations — Call Detail";
  const modalTitle = nameFilter ? `${nameFilter} · ${modeLabel}` : modeLabel;

  const activeFilters = useMemo(() => {
    const parts: string[] = [];
    parts.push(`Timeframe: ${timeframeLabel}`);
    if (nameFilter && nameFilterDimension) parts.push(`${nameFilterDimension}: ${nameFilter}`);
    if (filters.slm.length > 0) parts.push(`SLM: ${filters.slm.join(", ")}`);
    if (filters.flm.length > 0) parts.push(`FLM: ${filters.flm.join(", ")}`);
    if (nameFilterDimension !== "Rep" && filters.rep.length > 0) parts.push(`Rep: ${filters.rep.join(", ")}`);
    if (filters.region.length > 0) parts.push(`Region: ${filters.region.join(", ")}`);
    if (filters.group !== "All Channels") parts.push(`Channel: ${filters.group}`);
    return parts;
  }, [filters, timeframeLabel, nameFilter, nameFilterDimension]);

  const handleExport = useCallback(() => {
    const meta = [
      `"${modalTitle}"`,
      `"Exported: ${dateStr} ${timeStr} ${userTz}"`,
      `"Filters: ${activeFilters.join(" | ")}"`,
      `"Total Records: ${filteredCalls.length}"`,
      `"Total Duration (min): ${Math.round(totalDuration)}"`,
      "",
    ];
    const hdrs = ["Started", "Duration (min)", "Manager", "Rep", "Account", "Account ID", "Opportunity Stage", "Conversation Title", "Conversation ID", "Gong ID"];
    const rows = sortedCalls.map(c => [
      `"${c.started}"`,
      c.durationMin.toString(),
      `"${c.manager.replace(/"/g, '""')}"`,
      `"${c.rep.replace(/"/g, '""')}"`,
      `"${c.accountName.replace(/"/g, '""')}"`,
      `"${c.accountId}"`,
      `"${c.oppStage.replace(/"/g, '""')}"`,
      `"${c.conversationTitle.replace(/"/g, '""')}"`,
      `"${c.conversationId}"`,
      `"${c.gongId}"`,
    ].join(","));
    const csvContent = [...meta, hdrs.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${mode}_call_detail.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [sortedCalls, modalTitle, dateStr, timeStr, userTz, activeFilters, filteredCalls.length, totalDuration, mode]);

  const columns: { key: SortKey; label: string; width: string }[] = [
    { key: "started", label: "Started", width: "w-[130px]" },
    { key: "durationMin", label: "Duration", width: "w-[75px]" },
    { key: "manager", label: "Manager", width: "min-w-[90px] max-w-[130px]" },
    { key: "rep", label: "Rep", width: "min-w-[90px] max-w-[130px]" },
    { key: "accountName", label: "Account", width: "min-w-[100px] max-w-[170px]" },
    { key: "oppStage", label: "Opportunity Stage", width: "min-w-[100px] max-w-[170px]" },
    { key: "conversationTitle", label: "Conversation Title", width: "min-w-[120px] max-w-[200px]" },
    { key: "gongId", label: "Gong Notes", width: "w-[100px]" },
  ];

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "started" || key === "durationMin" ? "desc" : "asc");
    }
  };

  const getCellText = (call: CallRecord, col: typeof columns[0]): string => {
    if (col.key === "accountName") return call.accountName || "—";
    if (col.key === "conversationTitle") return call.conversationTitle || "—";
    if (col.key === "gongId") return call.gongId || "—";
    if (col.key === "durationMin") return call.durationMin > 0 ? `${call.durationMin} min` : "0";
    const val = (call as any)[col.key];
    return val || "—";
  };

  const renderCell = (call: CallRecord, col: typeof columns[0]) => {
    if (col.key === "accountName") {
      if (!call.accountId) return <span className="truncate">{call.accountName || "—"}</span>;
      return (
        <a href={sfClassicRecordUrl(call.accountId)} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline inline-flex items-center gap-1 max-w-full">
          <span className="truncate">{call.accountName || "—"}</span>
          <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
        </a>
      );
    }
    if (col.key === "conversationTitle") {
      if (!call.conversationId) return <span className="truncate">{call.conversationTitle || "—"}</span>;
      return (
        <a href={sfRecordUrl("Gong__Gong_Call__c", call.conversationId)} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline inline-flex items-center gap-1 max-w-full">
          <span className="truncate">{call.conversationTitle || "—"}</span>
          <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
        </a>
      );
    }
    if (col.key === "gongId") {
      if (!call.gongId) return <span>—</span>;
      return (
        <a href={`${GONG_NOTES_BASE}${call.gongId}`} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline inline-flex items-center gap-1">
          <span>View</span>
          <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
        </a>
      );
    }
    if (col.key === "durationMin") {
      return <span>{call.durationMin > 0 ? `${call.durationMin} min` : "0"}</span>;
    }
    const val = (call as any)[col.key];
    return <span className="truncate">{val || "—"}</span>;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose} role="dialog" aria-modal="true" aria-label={modalTitle}>
      <div className="bg-white dark:bg-[#1e293b] rounded-lg shadow-xl w-[95vw] max-w-[1200px] max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between p-4 border-b">
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold truncate">{modalTitle}</h2>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {activeFilters.map((f, i) => (
                <span key={i} className="px-2 py-0.5 bg-[#006AFF]/10 text-[#006AFF] text-[11px] font-medium rounded-full">{f}</span>
              ))}
            </div>
            <div className="flex items-center gap-4 mt-2 text-[11px] text-muted-foreground">
              <span>{filteredCalls.length.toLocaleString()} records</span>
              <span>{Math.round(totalDuration).toLocaleString()} min total duration</span>
              <span>as of {dateStr} {timeStr}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 ml-3">
            <button onClick={handleExport} className="p-1.5 hover:bg-black/5 rounded" title="Export CSV">
              <Download className="w-4 h-4" />
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-black/5 rounded">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[#006AFF]"></div>
            </div>
          ) : sortedCalls.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">No records match the current filters.</div>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-white dark:bg-[#1e293b] z-10">
                <tr className="border-b">
                  {columns.map(col => (
                    <th key={col.key} className={`${col.width} px-3 py-2 text-left font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground`} onClick={() => toggleSort(col.key)}>
                      <div className="flex items-center gap-1">
                        <span className="truncate">{col.label}</span>
                        {sortKey === col.key ? (sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-30" />}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayedCalls.map((call, i) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
                    {columns.map(col => (
                      <td key={col.key} title={getCellText(call, col)} className={`${col.width} px-3 py-1.5 align-top`}>
                        {renderCell(call, col)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {hasMore && (
                <tfoot>
                  <tr>
                    <td colSpan={columns.length} className="px-3 py-3 text-center">
                      <button
                        onClick={() => setDisplayLimit(l => l + 500)}
                        className="text-[12px] text-[#006AFF] hover:underline font-medium"
                      >
                        Showing {displayLimit.toLocaleString()} of {sortedCalls.length.toLocaleString()} — Load more
                      </button>
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
