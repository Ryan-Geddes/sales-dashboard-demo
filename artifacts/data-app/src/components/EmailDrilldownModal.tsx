import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { X, ArrowUpDown, ArrowUp, ArrowDown, Download, Search } from "lucide-react";
import { FilterState, AggregateBy } from "../pages/Dashboard";
import { getDateRange, passesChannelFilter } from "@/lib/utils";
import { sfRecordUrl } from "@/lib/sf-links";
import { useDelayedTooltip, DelayedTooltipPortal } from "../hooks/useDelayedTooltip";

interface EmailRecord {
  activityId: string;
  createdDate: string;
  manager: string;
  rep: string;
  contactName: string;
  contactId: string;
  accountName: string;
  subject: string;
  comments: string;
  direction: "sent" | "received";
  region: string;
  group: string;
  flm: string;
  slm: string;
}

type SortKey = "createdDate" | "rep" | "contactName" | "subject";
type SortDir = "asc" | "desc";

function parseDate(d: string): number {
  const t = Date.parse(d);
  return isNaN(t) ? 0 : t;
}

interface EmailDrilldownModalProps {
  filters: FilterState;
  nameFilter?: string;
  nameFilterDimension?: AggregateBy;
  onClose: () => void;
}

export default function EmailDrilldownModal({ filters, nameFilter, nameFilterDimension, onClose }: EmailDrilldownModalProps) {
  const [emails, setEmails] = useState<EmailRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("createdDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [displayLimit, setDisplayLimit] = useState(200);
  const [searchText, setSearchText] = useState("");
  const { tooltip, showTooltipDelayed, hideTooltip, trackMouseMove } = useDelayedTooltip();

  const apiBase = import.meta.env.BASE_URL || "/";

  useEffect(() => {
    setLoading(true);
    const dr = getDateRange(filters.timeframe, filters.customRange);
    const params = new URLSearchParams();
    if (dr.from) params.set("from", dr.from);
    if (dr.to) params.set("to", dr.to);
    if (!dr.from && !dr.to) params.set("timeframe", filters.timeframe);
    fetch(`${apiBase}api/sales/emails?${params.toString()}`)
      .then(r => r.json())
      .then(data => {
        setEmails(data.emails || []);
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

  const filteredEmails = useMemo(() => {
    let res = emails;
    if (nameFilter && nameFilterDimension) {
      const dim = nameFilterDimension;
      res = res.filter(e => {
        if (dim === "Rep") return e.rep === nameFilter;
        if (dim === "FLM") return e.flm === nameFilter;
        if (dim === "SLM") return e.slm === nameFilter;
        if (dim === "Region") return e.region === nameFilter;
        return true;
      });
    }
    if (filters.slm.length > 0) res = res.filter(e => filters.slm.includes(e.slm));
    if (filters.flm.length > 0) res = res.filter(e => filters.flm.includes(e.flm));
    if (nameFilterDimension !== "Rep" && filters.rep.length > 0) res = res.filter(e => filters.rep.includes(e.rep));
    if (filters.region.length > 0) res = res.filter(e => filters.region.includes(e.region));
    res = res.filter(e => passesChannelFilter(e.group, filters.group));
    const q = searchText.trim().toLowerCase();
    if (q) {
      res = res.filter(e =>
        (e.contactName || "").toLowerCase().includes(q) ||
        (e.subject || "").toLowerCase().includes(q) ||
        (e.comments || "").toLowerCase().includes(q)
      );
    }
    return res;
  }, [emails, nameFilter, nameFilterDimension, filters, searchText]);

  const sortedEmails = useMemo(() => {
    const arr = [...filteredEmails];
    arr.sort((a, b) => {
      if (sortKey === "createdDate") {
        const diff = parseDate(a.createdDate) - parseDate(b.createdDate);
        return sortDir === "asc" ? diff : -diff;
      }
      const cmp = ((a as any)[sortKey] || "").localeCompare((b as any)[sortKey] || "");
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filteredEmails, sortKey, sortDir]);

  const displayedEmails = sortedEmails.slice(0, displayLimit);
  const hasMore = sortedEmails.length > displayLimit;

  const now = new Date();
  const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: userTz });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: userTz });
  const timeframeLabel = filters.timeframe === "mtd" ? "This Month" : filters.timeframe === "lastMonth" ? "Last Month" : filters.timeframe === "mtd2date" ? "MTD" : filters.timeframe === "eom" ? "EOM" : filters.timeframe === "thisWeek" ? "This Week" : filters.timeframe === "today" ? "Today" : filters.timeframe === "custom" && filters.customRange ? `${filters.customRange.from.toLocaleDateString()} – ${filters.customRange.to.toLocaleDateString()}` : "Custom";

  const modeLabel = "Emails — Activity Detail";
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
      `"Total Records: ${filteredEmails.length}"`,
      "",
    ];
    const hdrs = ["Created Date", "Rep", "Contact", "Subject"];
    const rows = sortedEmails.map(e => [
      `"${e.createdDate}"`,
      `"${e.rep.replace(/"/g, '""')}"`,
      `"${(e.contactName || "").replace(/"/g, '""')}"`,
      `"${(e.subject || "").replace(/"/g, '""')}"`,
    ].join(","));
    const csvContent = [...meta, hdrs.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "emails_detail.csv";
    link.click();
    URL.revokeObjectURL(url);
  }, [sortedEmails, modalTitle, dateStr, timeStr, userTz, activeFilters, filteredEmails.length]);

  const columns: { key: SortKey; label: string; width: string }[] = [
    { key: "createdDate", label: "Created Date", width: "w-[110px]" },
    { key: "rep", label: "Rep", width: "min-w-[110px] max-w-[160px]" },
    { key: "contactName", label: "Contact", width: "min-w-[140px] max-w-[220px]" },
    { key: "subject", label: "Subject", width: "min-w-[260px] max-w-[560px]" },
  ];

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "createdDate" ? "desc" : "asc");
    }
  };

  const getCellText = (e: EmailRecord, col: typeof columns[0]): string => {
    const val = (e as any)[col.key];
    return val || "—";
  };

  const renderCell = (e: EmailRecord, col: typeof columns[0]) => {
    if (col.key === "contactName") {
      const label = e.contactName || "—";
      return e.contactId ? (
        <a href={sfRecordUrl("Contact", e.contactId)} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline truncate inline-block max-w-full">{label}</a>
      ) : <span className="truncate">{label}</span>;
    }
    if (col.key === "subject") {
      const label = e.subject || "—";
      const hoverProps = e.comments
        ? {
            onMouseEnter: (ev: React.MouseEvent) => showTooltipDelayed(e.comments, ev, "Comments"),
            onMouseMove: trackMouseMove,
            onMouseLeave: hideTooltip,
          }
        : {};
      return e.activityId ? (
        <a href={sfRecordUrl("Task", e.activityId)} target="_blank" rel="noopener noreferrer" className="text-[#006AFF] hover:underline truncate inline-block max-w-full" {...hoverProps}>{label}</a>
      ) : <span className="truncate" {...hoverProps}>{label}</span>;
    }
    const val = (e as any)[col.key];
    return <span className="truncate">{val || "—"}</span>;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose} role="dialog" aria-modal="true" aria-label={modalTitle}>
      <div className="bg-white dark:bg-[#1e293b] rounded-lg shadow-xl w-[95vw] max-w-[1200px] max-h-[85vh] flex flex-col" onClick={ev => ev.stopPropagation()}>
        <div className="flex items-start justify-between p-4 border-b">
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold truncate">{modalTitle}</h2>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {activeFilters.map((f, i) => (
                <span key={i} className="px-2 py-0.5 bg-[#006AFF]/10 text-[#006AFF] text-[11px] font-medium rounded-full">{f}</span>
              ))}
            </div>
            <div className="flex items-center gap-4 mt-2 text-[11px] text-muted-foreground">
              <span>{filteredEmails.length.toLocaleString()} records</span>
              <span>as of {dateStr} {timeStr}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 ml-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                placeholder="Search contact, subject, comments…"
                className="pl-7 pr-7 py-1 text-[12px] border border-border rounded bg-background w-[260px] focus:outline-none focus:ring-1 focus:ring-[#006AFF]"
              />
              {searchText && (
                <button onClick={() => setSearchText("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 hover:bg-black/5 rounded" title="Clear">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
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
          ) : sortedEmails.length === 0 ? (
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
                {displayedEmails.map((e, i) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
                    {columns.map(col => (
                      <td key={col.key} title={getCellText(e, col)} className={`${col.width} px-3 py-1.5 align-top`}>
                        {renderCell(e, col)}
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
                        Showing {displayLimit.toLocaleString()} of {sortedEmails.length.toLocaleString()} — Load more
                      </button>
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      </div>
      <DelayedTooltipPortal tooltip={tooltip} />

    </div>
  );
}
