import React, { useMemo, useState, useCallback, useEffect } from "react";
import { FilterState, AggregateBy } from "../../pages/Dashboard";
import { ActivityData } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LabelList } from "recharts";
import { CSVLink } from "react-csv";
import { Download } from "lucide-react";
import { getDateRange, passesChannelFilter } from "@/lib/utils";
import { sfReportUrl, sfClassicReportUrl } from "@/lib/sf-links";
import { SfReportLink } from "../SfReportLink";
import CallDrilldownModal from "../CallDrilldownModal";
import FunnelDrilldownModal from "../FunnelDrilldownModal";
import SbrDrilldownModal from "../SbrDrilldownModal";
import EmailDrilldownModal from "../EmailDrilldownModal";

interface ActivityByRepEntry {
  name: string;
  flm: string;
  slm: string;
  region: string;
  group: string;
  segment: string;
  dials: number;
  convos: number;
  talkMin: number;
  meaningfulTalkMin: number;
  sbrs: number;
  demos: number;
  emails: number;
  opps: number;
}

const SF_REPORT_LINKS: Record<string, string> = {
  "Dials": sfReportUrl("dials"),
  "Meaningful Conversations": sfReportUrl("dials"),
  "Dials and 10+min Convos": sfReportUrl("dials"),
  "Talk Time (min)": sfReportUrl("dials"),
  "Talk Time (hrs)": sfReportUrl("dials"),
  "Demos": sfClassicReportUrl("demosClassic"),
  "SBRs": sfReportUrl("sbrs"),
  "Opps Created": sfClassicReportUrl("demosClassic"),
  "Emails": sfReportUrl("emails"),
};

const CONSOLIDATED_CALLS_TITLE = "Dials and 10+min Convos";
const CONVOS_LIGHT_FILL = "#9BC4FF";

interface ActivityViewProps {
  loading: boolean;
  data?: ActivityData;
  filters: FilterState;
}

type CallDrilldownState = { mode: "dials" | "convos"; nameFilter?: string; nameFilterDimension?: AggregateBy } | null;
type OppsDrilldownState = { nameFilter?: string; nameFilterDimension?: AggregateBy } | null;

const DRILLABLE_CHARTS = new Set(["Dials", "Meaningful Conversations", CONSOLIDATED_CALLS_TITLE, "Opps Created", "Demos", "SBRs", "Emails"]);

function ClickableYTick({ x, y, payload, onClick }: any) {
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={4}
        textAnchor="end"
        fill="#64748b"
        fontSize={11}
        className="cursor-pointer hover:fill-[#006AFF] transition-colors"
        onClick={() => onClick?.(payload?.value)}
        role="button"
        tabIndex={0}
      >
        {payload?.value?.length > 14 ? `${payload.value.slice(0, 13)}…` : payload?.value}
      </text>
    </g>
  );
}

function ExcludedOppsLink() {
  const [show, setShow] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!show) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [show]);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); setShow(s => !s); }}
        className="text-[10px] text-[#006AFF] hover:underline cursor-pointer"
      >
        Excluded Opportunities
      </button>
      {show && (
        <div className="absolute left-0 top-5 z-50 w-[280px] bg-white border border-border rounded-md shadow-lg p-3 text-[11px]">
          <div className="font-semibold text-[12px] mb-1.5 text-[#1e293b]">Excluded from Opps Created</div>
          <div className="text-[#64748b] leading-relaxed">
            The following opportunities are excluded from this count:
          </div>
          <ul className="mt-1.5 space-y-1 text-[#334155]">
            <li>• Stage: <span className="font-medium">Zips Added</span></li>
            <li>• Type: <span className="font-medium">Cart</span></li>
          </ul>
        </div>
      )}
    </div>
  );
}

export default function ActivityView({ loading, data, filters }: ActivityViewProps) {
  void data;
  const [callDrilldown, setCallDrilldown] = useState<CallDrilldownState>(null);
  const [oppsDrilldown, setOppsDrilldown] = useState<OppsDrilldownState>(null);
  const [demosDrilldown, setDemosDrilldown] = useState<OppsDrilldownState>(null);
  const [sbrsDrilldown, setSbrsDrilldown] = useState<OppsDrilldownState>(null);
  const [emailsDrilldown, setEmailsDrilldown] = useState<OppsDrilldownState>(null);
  const [talkUnit, setTalkUnit] = useState<"min" | "hrs">("min");
  const [callsToggle, setCallsToggle] = useState<"dials" | "10min">("dials");
  const [activityCounts, setActivityCounts] = useState<ActivityByRepEntry[] | null>(null);
  const [countsLoading, setCountsLoading] = useState(true);

  const apiBase = import.meta.env.BASE_URL || "/";

  useEffect(() => {
    const dr = getDateRange(filters.timeframe, filters.customRange);
    const params = new URLSearchParams();
    if (dr.from) params.set("from", dr.from);
    if (dr.to) params.set("to", dr.to);
    for (const p of filters.products) params.append("products", p);
    setCountsLoading(true);
    let cancelled = false;
    fetch(`${apiBase}api/sales/activity-by-rep?${params.toString()}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        setActivityCounts(d.reps || []);
        setCountsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setActivityCounts([]);
        setCountsLoading(false);
      });
    return () => { cancelled = true; };
  }, [apiBase, filters.timeframe, filters.customRange, filters.products]);

  const openDrilldown = useCallback((chartTitle: string, nameFilter?: string) => {
    const dim = nameFilter ? filters.aggregateBy : undefined;
    if (chartTitle === "Opps Created") {
      setOppsDrilldown({ nameFilter, nameFilterDimension: dim });
      return;
    }
    if (chartTitle === "Demos") {
      setDemosDrilldown({ nameFilter, nameFilterDimension: dim });
      return;
    }
    if (chartTitle === "SBRs") {
      setSbrsDrilldown({ nameFilter, nameFilterDimension: dim });
      return;
    }
    if (chartTitle === "Emails") {
      setEmailsDrilldown({ nameFilter, nameFilterDimension: dim });
      return;
    }
    if (chartTitle === "Dials" || chartTitle === "Meaningful Conversations") {
      const mode = chartTitle === "Dials" ? "dials" as const : "convos" as const;
      setCallDrilldown({ mode, nameFilter, nameFilterDimension: dim });
      return;
    }
    if (chartTitle === CONSOLIDATED_CALLS_TITLE) {
      const mode = callsToggle === "dials" ? "dials" as const : "convos" as const;
      setCallDrilldown({ mode, nameFilter, nameFilterDimension: dim });
    }
  }, [filters.aggregateBy, callsToggle]);

  const handleBarClick = useCallback((chartTitle: string, payload: any) => {
    openDrilldown(chartTitle, payload?.name);
  }, [openDrilldown]);

  const handleTitleClick = useCallback((chartTitle: string) => {
    openDrilldown(chartTitle);
  }, [openDrilldown]);

  const handleNameClick = useCallback((chartTitle: string, name: string) => {
    openDrilldown(chartTitle, name);
  }, [openDrilldown]);

  const processedData = useMemo(() => {
    if (!activityCounts) return null;

    let reps = activityCounts;

    if (filters.slm.length > 0) reps = reps.filter(r => filters.slm.includes(r.slm));
    if (filters.flm.length > 0) reps = reps.filter(r => filters.flm.includes(r.flm));
    if (filters.rep.length > 0) reps = reps.filter(r => filters.rep.includes(r.name));
    if (filters.region.length > 0) reps = reps.filter(r => filters.region.includes(r.region));
    if (filters.segment.length > 0) reps = reps.filter(r => filters.segment.includes(r.segment));
    reps = reps.filter(r => passesChannelFilter(r.group, filters.group));

    const aggBy = filters.aggregateBy;
    const getKey = (r: ActivityByRepEntry) => {
      if (aggBy === "FLM") return r.flm;
      if (aggBy === "SLM") return r.slm;
      if (aggBy === "Region") return r.region;
      if (aggBy === "Segment") return r.segment || "";
      return r.name;
    };

    const dialsMap: Record<string, number> = {};
    const convosMap: Record<string, number> = {};
    const talkMap: Record<string, number> = {};
    const meaningfulTalkMap: Record<string, number> = {};
    const demosMap: Record<string, number> = {};
    const emailsMap: Record<string, number> = {};
    const sbrsMap: Record<string, number> = {};
    const oppsMap: Record<string, number> = {};

    reps.forEach(r => {
      const key = getKey(r);
      dialsMap[key] = (dialsMap[key] || 0) + r.dials;
      convosMap[key] = (convosMap[key] || 0) + r.convos;
      talkMap[key] = (talkMap[key] || 0) + r.talkMin;
      meaningfulTalkMap[key] = (meaningfulTalkMap[key] || 0) + r.meaningfulTalkMin;
      sbrsMap[key] = (sbrsMap[key] || 0) + r.sbrs;
      demosMap[key] = (demosMap[key] || 0) + r.demos;
      emailsMap[key] = (emailsMap[key] || 0) + (r.emails || 0);
      oppsMap[key] = (oppsMap[key] || 0) + r.opps;
    });

    const toArr = (m: Record<string, number>) =>
      Object.entries(m).map(([name, value]) => ({ name, value: Math.round(value) })).sort((a, b) => b.value - a.value);

    const talkArr = Object.keys(talkMap)
      .map(name => {
        const total = talkMap[name];
        const meaningful = meaningfulTalkMap[name] || 0;
        return { name, total, meaningful, nonMeaningful: Math.max(0, total - meaningful) };
      })
      .sort((a, b) => b.total - a.total);

    return { dials: toArr(dialsMap), convos: toArr(convosMap), talk: talkArr, demos: toArr(demosMap), emails: toArr(emailsMap), sbrs: toArr(sbrsMap), opps: toArr(oppsMap) };
  }, [activityCounts, filters]);

  const talkData = useMemo(() => {
    if (!processedData) return [];
    const conv = (v: number) => talkUnit === "hrs" ? Math.round((v / 60) * 10) / 10 : Math.round(v);
    return processedData.talk.map(d => ({
      name: d.name,
      total: conv(d.total),
      meaningful: conv(d.meaningful),
      nonMeaningful: conv(d.nonMeaningful),
    }));
  }, [processedData, talkUnit]);

  const talkTitle = talkUnit === "hrs" ? "Talk Time (hrs)" : "Talk Time (min)";

  const callsData = useMemo(() => {
    if (!processedData) return [];
    const dialsByName: Record<string, number> = {};
    const convosByName: Record<string, number> = {};
    processedData.dials.forEach(d => { dialsByName[d.name] = d.value; });
    processedData.convos.forEach(d => { convosByName[d.name] = d.value; });
    const names = new Set<string>([...Object.keys(dialsByName), ...Object.keys(convosByName)]);
    const rows = Array.from(names).map(name => {
      const dials = dialsByName[name] || 0;
      const convos = convosByName[name] || 0;
      return {
        name,
        dials,
        convos,
        nonConvos: Math.max(0, dials - convos),
      };
    });
    rows.sort((a, b) => callsToggle === "dials" ? b.dials - a.dials : b.convos - a.convos);
    return rows;
  }, [processedData, callsToggle]);

  if (loading || countsLoading || !processedData) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
        {[...Array(6)].map((_, i) => (
          <Card key={i} className="no-shadow">
            <CardContent className="p-6">
              <Skeleton className="h-4 w-1/2 mb-4" />
              <Skeleton className="h-[250px] w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const callsCsvData = callsToggle === "dials"
    ? callsData.map(d => ({ name: d.name, dials: d.dials }))
    : callsData.map(d => ({ name: d.name, "10+min": d.convos }));
  const callsCsvFilename = callsToggle === "dials" ? "dials.csv" : "10min-convos.csv";

  const charts = [
    { title: CONSOLIDATED_CALLS_TITLE, data: callsData, color: "#006AFF", filename: callsCsvFilename, csvData: callsCsvData },
    { title: talkTitle, data: talkData, color: "#FF6B35", filename: "talk-time.csv", csvData: talkData },
    { title: "Emails", data: processedData.emails, color: "#0EA5E9", filename: "emails.csv", csvData: processedData.emails },
    { title: "SBRs", data: processedData.sbrs, color: "#F59E0B", filename: "sbrs.csv", csvData: processedData.sbrs },
    { title: "Demos", data: processedData.demos, color: "#7C3AED", filename: "demos.csv", csvData: processedData.demos },
    { title: "Opps Created", data: processedData.opps, color: "#EF4444", filename: "opps.csv", csvData: processedData.opps },
  ];

  return (
    <>
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
        {charts.map((chart, i) => {
          const isDrillable = DRILLABLE_CHARTS.has(chart.title);
          return (
          <Card key={i} className="no-shadow flex flex-col">
            <CardHeader className="px-4 pt-4 pb-2 flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-2">
                <CardTitle
                  className={`text-[14px] font-semibold ${isDrillable ? "cursor-pointer hover:text-[#006AFF] transition-colors" : ""}`}
                  onClick={isDrillable ? () => handleTitleClick(chart.title) : undefined}
                >{chart.title.startsWith("Talk Time") ? "Talk Time" : chart.title}</CardTitle>
                {chart.title.startsWith("Talk Time") && (
                  <div className="flex rounded-md border border-gray-200 overflow-hidden text-[11px]">
                    <button
                      className={`px-1.5 py-0.5 transition-colors ${talkUnit === "min" ? "bg-[#006AFF] text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                      onClick={() => setTalkUnit("min")}
                    >min</button>
                    <button
                      className={`px-1.5 py-0.5 transition-colors ${talkUnit === "hrs" ? "bg-[#006AFF] text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                      onClick={() => setTalkUnit("hrs")}
                    >hrs</button>
                  </div>
                )}
                {chart.title === CONSOLIDATED_CALLS_TITLE && (
                  <div className="flex rounded-md border border-gray-200 overflow-hidden text-[11px]">
                    <button
                      className={`px-1.5 py-0.5 transition-colors ${callsToggle === "dials" ? "bg-[#006AFF] text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                      onClick={() => setCallsToggle("dials")}
                    >Dials</button>
                    <button
                      className={`px-1.5 py-0.5 transition-colors ${callsToggle === "10min" ? "bg-[#006AFF] text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                      onClick={() => setCallsToggle("10min")}
                    >10+min</button>
                  </div>
                )}
                {SF_REPORT_LINKS[chart.title] && <SfReportLink href={SF_REPORT_LINKS[chart.title]} />}
                {chart.title === "Opps Created" && <ExcludedOppsLink />}
              </div>
              <CSVLink data={chart.csvData} filename={chart.filename} className="print:hidden p-1 hover:bg-black/5 rounded">
                <Download className="w-3.5 h-3.5" />
              </CSVLink>
            </CardHeader>
            <CardContent className="p-0" style={{ height: 310, overflow: 'hidden' }}>
              <div style={{ height: 310, overflowY: 'auto', overflowX: 'hidden', padding: '0 16px 16px' }}>
                <div style={{ height: Math.max(310, chart.data.length * 26) }}>
                  <ResponsiveContainer width="100%" height="100%" debounce={0}>
                    <BarChart data={chart.data} layout="vertical" margin={{ top: 5, right: 45, left: 5, bottom: 5 }} barSize={14}>
                      <XAxis type="number" hide />
                      <YAxis dataKey="name" type="category" axisLine={false} tickLine={false}
                        tick={isDrillable
                          ? (props: any) => <ClickableYTick {...props} onClick={(name: string) => handleNameClick(chart.title, name)} />
                          : { fontSize: 11, fill: '#64748b' }
                        }
                        width={90}
                      />
                      <Tooltip cursor={{fill: 'rgba(0,0,0,0.05)'}} content={({ active, payload }) => {
                        if (!active || !payload || !payload.length) return null;
                        const p: any = payload[0].payload;
                        if (chart.title.startsWith("Talk Time")) {
                          const unitLabel = talkUnit === "hrs" ? "hrs" : "min";
                          return (
                            <div className="bg-white border p-2 rounded text-[12px] leading-tight">
                              <div className="font-semibold mb-1">{p.name}</div>
                              <div>Total Talk Time: {Number(p.total).toLocaleString()} {unitLabel}</div>
                              <div className="text-[#64748b]">Meaningful TT: {Number(p.meaningful).toLocaleString()} {unitLabel}</div>
                            </div>
                          );
                        }
                        if (chart.title === CONSOLIDATED_CALLS_TITLE) {
                          return (
                            <div className="bg-white border p-2 rounded text-[12px] leading-tight">
                              <div className="font-semibold mb-1">{p.name}</div>
                              <div>Dials: {Number(p.dials).toLocaleString()}</div>
                              <div className="text-[#64748b]">10+min: {Number(p.convos).toLocaleString()}</div>
                            </div>
                          );
                        }
                        return <div className="bg-white border p-2 rounded text-[12px]"><span className="font-semibold">{p.name}</span>: {Number(payload[0].value).toLocaleString()}</div>;
                      }} />
                      {chart.title.startsWith("Talk Time") && (
                        <Bar dataKey="meaningful" stackId="talk" fill="#FFCFAF" isAnimationActive={false} />
                      )}
                      {chart.title.startsWith("Talk Time") && (
                        <Bar dataKey="nonMeaningful" stackId="talk" fill={chart.color} radius={[0, 2, 2, 0]} isAnimationActive={false}>
                          <LabelList dataKey="total" position="right" fontSize={11} fill="#334155" formatter={(v: number) => v > 0 ? v.toLocaleString() : ''} />
                        </Bar>
                      )}
                      {chart.title === CONSOLIDATED_CALLS_TITLE && callsToggle === "dials" && (
                        <Bar dataKey="convos" stackId="calls" fill={CONVOS_LIGHT_FILL} isAnimationActive={false}
                          cursor="pointer"
                          onClick={(barData: any) => handleBarClick(chart.title, barData)}
                        />
                      )}
                      {chart.title === CONSOLIDATED_CALLS_TITLE && callsToggle === "dials" && (
                        <Bar dataKey="nonConvos" stackId="calls" fill={chart.color} radius={[0, 2, 2, 0]} isAnimationActive={false}
                          cursor="pointer"
                          onClick={(barData: any) => handleBarClick(chart.title, barData)}
                        >
                          <LabelList dataKey="dials" position="right" fontSize={11} fill="#334155" formatter={(v: number) => v > 0 ? v.toLocaleString() : ''} />
                        </Bar>
                      )}
                      {chart.title === CONSOLIDATED_CALLS_TITLE && callsToggle === "10min" && (
                        <Bar dataKey="convos" fill={CONVOS_LIGHT_FILL} radius={[0, 2, 2, 0]} isAnimationActive={false}
                          label={{ position: 'right', fontSize: 11, fill: '#334155', formatter: (v: number) => v > 0 ? v.toLocaleString() : '' }}
                          cursor="pointer"
                          onClick={(barData: any) => handleBarClick(chart.title, barData)}
                        />
                      )}
                      {!chart.title.startsWith("Talk Time") && chart.title !== CONSOLIDATED_CALLS_TITLE && (
                        <Bar dataKey="value" fill={chart.color} radius={[0, 2, 2, 0]} isAnimationActive={false}
                          label={{ position: 'right', fontSize: 11, fill: '#334155', formatter: (v: number) => v > 0 ? v.toLocaleString() : '' }}
                          cursor={isDrillable ? "pointer" : undefined}
                          onClick={isDrillable ? (barData: any) => handleBarClick(chart.title, barData) : undefined}
                        />
                      )}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </CardContent>
          </Card>
          );
        })}
    </div>
    {callDrilldown && (
      <CallDrilldownModal
        mode={callDrilldown.mode}
        filters={filters}
        nameFilter={callDrilldown.nameFilter}
        nameFilterDimension={callDrilldown.nameFilterDimension}
        onClose={() => setCallDrilldown(null)}
      />
    )}
    {oppsDrilldown && (
      <FunnelDrilldownModal
        stage=""
        mode="opps"
        filters={filters}
        nameFilter={oppsDrilldown.nameFilter}
        nameFilterDimension={oppsDrilldown.nameFilterDimension}
        onClose={() => setOppsDrilldown(null)}
      />
    )}
    {demosDrilldown && (
      <FunnelDrilldownModal
        stage=""
        mode="demos"
        filters={filters}
        nameFilter={demosDrilldown.nameFilter}
        nameFilterDimension={demosDrilldown.nameFilterDimension}
        onClose={() => setDemosDrilldown(null)}
      />
    )}
    {sbrsDrilldown && (
      <SbrDrilldownModal
        filters={filters}
        nameFilter={sbrsDrilldown.nameFilter}
        nameFilterDimension={sbrsDrilldown.nameFilterDimension}
        onClose={() => setSbrsDrilldown(null)}
      />
    )}
    {emailsDrilldown && (
      <EmailDrilldownModal
        filters={filters}
        nameFilter={emailsDrilldown.nameFilter}
        nameFilterDimension={emailsDrilldown.nameFilterDimension}
        onClose={() => setEmailsDrilldown(null)}
      />
    )}
    </>
  );
}
