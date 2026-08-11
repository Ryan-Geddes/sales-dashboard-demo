import React, { useState, useMemo, useEffect, useCallback } from "react";
import { X, ArrowUpDown, ArrowUp, ArrowDown, Download, ExternalLink } from "lucide-react";
import { FilterState, AggregateBy } from "../pages/Dashboard";
import { getDateRange, passesChannelFilter, nowPST } from "@/lib/utils";
import { sfRecordUrl } from "@/lib/sf-links";

interface SbrRecord {
  learningSessionId: string;
  eventDate: string;
  manager: string;
  rep: string;
  contactName: string;
  contactId: string;
  region: string;
  group: string;
  flm: string;
  slm: string;
}

type SortKey = "learningSessionId" | "eventDate" | "manager" | "rep" | "contactName";
type SortDir = "asc" | "desc";

function parseDate(d: string): number {
  const t = Date.parse(d);
  return isNaN(t) ? 0 : t;
}

const strKeys = new Set<string>(["learningSessionId", "manager", "rep", "contactName"]);

interface SbrDrilldownModalProps {
  filters: FilterState;
  nameFilter?: string;
  nameFilterDimension?: AggregateBy;
  onClose: () => void;
}

export default function SbrDrilldownModal({ filters, nameFilter, nameFilterDimension, onClose }: SbrDrilldownModalProps) {
  const [sbrs, setSbrs] = useState<SbrRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("eventDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [displayLimit, setDisplayLimit] = useState(200);

  const apiBase = import.meta.env.BASE_URL || "/";

  useEffect(() => {
    setLoading(true);
    const dr = getDateRange(filters.timeframe, filters.customRange);
    const params = new URLSearchParams();
    if (dr.from) params.set("from", dr.from);
    if (dr.to) params.set("to", dr.to);
    if (!dr.from && !dr.to) params.set("timeframe", filters.timeframe);
    fetch(`${apiBase}api/sales/sbrs?${params.toString()}`)
      .then(r => r.json())
      .then(data => {
        setSbrs(data.sbrs || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [apiBase, filters.timeframe, filters.customRange]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const filteredSbrs = useMemo(() => {
    let res = sbrs;
    if (nameFilter && nameFilterDimension) {
      const dim = nameFilterDimension;
      res = res.filter(s => {
        if (dim === "Rep") return s.rep === nameFilter;
        if (dim === "FLM") return s.flm === nameFilter;
        if (dim === "SLM") return s.slm === nameFilter;
        if (dim === "Region") return s.region === nameFilter;
        return true;
      });
    }
    if (filters.slm.length > 0) res = res.filter(s => filters.slm.includes(s.slm));
    if (filters.flm.length > 0) res = res.filter(s => filters.flm.includes(s.flm));
    if (nameFilterDimension !== "Rep" && filters.rep.length > 0) res = res.filter(s => filters.rep.includes(s.rep));
    if (filters.region.length > 0) res = res.filter(s => filters.region.includes(s.region));
    res = res.filter(s => passesChannelFilter(s.group, filters.group));
    return res;
  }, [sbrs, nameFilter, nameFilterDimension, filters]);

  const sortedSbrs = useMemo(() => {
    const arr = [...filteredSbrs];
    arr.sort((a, b) => {
      if (sortKey === "eventDate") {
        const diff = parseDate(a.eventDate) - parseDate(b.eventDate);
        return sortDir === "asc" ? diff : -diff;
      }
      if (strKeys.has(sortKey)) {
        const cmp = ((a as any)[sortKey] || "").localeCompare((b as any)[sortKey] || "");
        return sortDir === "asc" ? cmp : -cmp;
      }
      return 0;
    });
    return arr;
  }, [filteredSbrs, sortKey, sortDir]);

  const displayedSbrs = sortedSbrs.slice(0, displayLimit);
  const hasMore = sortedSbrs.length > displayLimit;

  const now = nowPST();
  const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: userTz });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: userTz });
  const timeframeLabel = filters.timeframe === "mtd" ? "This Month" : filters.timeframe === "lastMonth" ? "Last Month" : filters.timeframe === "mtd2date" ? "MTD" : filters.timeframe === "eom" ? "EOM" : filters.timeframe === "thisWeek" ? "This Week" : filters.timeframe === "today" ? "Today" : filters.timeframe === "custom" && filters.customRange ? `${filters.customRange.from.toLocaleDateString()} – ${filters.customRange.to.toLocaleDateString()}` : "Custom";

  const modeLabel = "SBRs — Learning Session Detail";
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
  }, [timeframeLabel, nameFilter, nameFilterDimension, filters]);

  const handleExport = useCallback(() => {
    const meta = [
      `"${modalTitle}"`,
      `"Exported: ${dateStr} ${timeStr} ${userTz}"`,
      `"Filters: ${activeFilters.join(" | ")}"`,
      `"Total Records: ${filteredSbrs.length}"`,
      "",
    ];
    const hdrs = ["Learning Session ID", "Event Date", "Manager", "Rep", "Contact Name", "Contact ID"];
    const rows = sortedSbrs.map(s => [
      `"${s.learningSessionId}"`,
      `"${s.eventDate}"`,
      `"${s.manager.replace(/"/g, '""')}"`,
      `"${s.rep.replace(/"/g, '""')}"`,
      `"${s.contactName.replace(/"/g, '""')}"`,
      `"${s.contactId}"`,
    ].join(","));
    const csvContent = [...meta, hdrs.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "sbr_detail.csv";
    link.click();
    URL.revokeObjectURL(url);
  }, [sortedSbrs, modalTitle, dateStr, timeStr, userTz, activeFilters, filteredSbrs.length]);

  const columns: { key: SortKey; label: string; width: string }[] = [
    { key: "learningSessionId", label: "Learning Session", width: "min-w-[120px] max-w-[200px]" },
    { key: "eventDate", label: "Event Date", width: "w-[95px]" },
    { key: "manager", label: "Manager", width: "min-w-[90px] max-w-[130px]" },
    { key: "rep", label: "Rep", width: "min-w-[90px] max-w-[130px]" },
    { key: "contactName", label: "Contact", width: "min-w-[100px] max-w-[170px]" },
  ];

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "eventDate" ? "desc" : "asc");
    }
  };

  const getCellText = (sbr: SbrRecord, col: typeof columns[0]): string => {
    if (col.key === "learningSessionId") return sbr.learningSessionId || "—";
    const val = (sbr as any)[col.key];
    return val || "—";
  };

  const renderCell = (sbr: SbrRecord, col: typeof columns[0]) => {
    if (col.key === "learningSessionId") {
      if (!sbr.learningSessionId) return <span>—</span>;
      return (
        <a href={sfRecordUrl("Learning_Session__c", sbr.learningSessionId)} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline inline-flex items-center gap-1 max-w-full">
          <span className="truncate">{sbr.learningSessionId}</span>
          <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
        </a>
      );
    }
    const val = (sbr as any)[col.key];
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
              <span>{filteredSbrs.length.toLocaleString()} records</span>
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
          ) : sortedSbrs.length === 0 ? (
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
                {displayedSbrs.map((sbr, i) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
                    {columns.map(col => (
                      <td key={col.key} title={getCellText(sbr, col)} className={`${col.width} px-3 py-1.5 align-top`}>
                        {renderCell(sbr, col)}
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
                        Showing {displayLimit.toLocaleString()} of {sortedSbrs.length.toLocaleString()} — Load more
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
