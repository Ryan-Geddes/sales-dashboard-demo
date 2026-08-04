import React, { useState, useMemo, useEffect, useCallback } from "react";
import ReactDOM from "react-dom";
import { X, Search, Info } from "lucide-react";
import { displayProduct, displayProductText } from "@/lib/product-labels";

type ExplainerMrrMode = "gnrNet" | "acqNet" | "added" | "amount";

interface ExplainerOpp {
  oppName: string;
  accountName: string;
  accountId: string;
  oppId: string;
  rep: string;
  closeDate: string;
  type: string;
  product: string;
  amount: number;
  mrr: number;
  stage: string;
  funnelStage: string;
  isStale?: boolean;
  isChurnMatch?: boolean;
  excluded?: boolean;
  excludeReason?: string;
}

interface RawApiOpp {
  oppName: string;
  accountName: string;
  accountId: string;
  oppId: string;
  rep: string;
  closeDate: string;
  type: string;
  product: string;
  amount: number;
  mrr: number;
  stage: string;
  funnelStage: string;
}

interface ConfigResponse {
  org: Record<string, Record<string, string[]>>;
}

interface OpportunitiesResponse {
  opportunities: RawApiOpp[];
}

const EXAMPLE_OPPS: ExplainerOpp[] = [
  {
    oppName: "Acme Corp - Showcase Premium",
    accountName: "Acme Corp",
    accountId: "001A",
    oppId: "006A",
    rep: "Example Rep",
    closeDate: new Date().toISOString().slice(0, 10),
    type: "New Business",
    product: "Showcase",
    amount: 30000,
    mrr: 2000,
    stage: "Closed Won",
    funnelStage: "Closed Won",
  },
  {
    oppName: "Beta LLC - SCV4 Upgrade",
    accountName: "Beta LLC",
    accountId: "001B",
    oppId: "006B",
    rep: "Example Rep",
    closeDate: new Date().toISOString().slice(0, 10),
    type: "Unified Opp",
    product: "SCV4",
    amount: 27000,
    mrr: 1500,
    stage: "Closed Won",
    funnelStage: "Closed Won",
  },
  {
    oppName: "Beta LLC - Showcase Cancel",
    accountName: "Beta LLC",
    accountId: "001B",
    oppId: "006C",
    rep: "Example Rep",
    closeDate: new Date().toISOString().slice(0, 10),
    type: "Rebook/Cancel",
    product: "Showcase",
    amount: -2400,
    mrr: -200,
    stage: "Closed Won",
    funnelStage: "Closed Won",
  },
  {
    oppName: "Gamma Inc - Showcase Cancel",
    accountName: "Gamma Inc",
    accountId: "001C",
    oppId: "006D",
    rep: "Example Rep",
    closeDate: new Date().toISOString().slice(0, 10),
    type: "Cancellation",
    product: "Showcase",
    amount: -12000,
    mrr: -1000,
    stage: "Closed Won",
    funnelStage: "Closed Won",
    isChurnMatch: false,
  },
  {
    oppName: "Gamma Inc - Showcase Renewal",
    accountName: "Gamma Inc",
    accountId: "001C",
    oppId: "006E",
    rep: "Example Rep",
    closeDate: new Date().toISOString().slice(0, 10),
    type: "Renewal",
    product: "Showcase",
    amount: 12000,
    mrr: 1000,
    stage: "Closed Won",
    funnelStage: "Closed Won",
    isChurnMatch: true,
  },
  {
    oppName: "Sigma Ltd - Showcase Churn",
    accountName: "Sigma Ltd",
    accountId: "001S",
    oppId: "006S",
    rep: "Example Rep",
    closeDate: new Date().toISOString().slice(0, 10),
    type: "Cancellation",
    product: "Showcase",
    amount: -4800,
    mrr: -400,
    stage: "Closed Won",
    funnelStage: "Closed Won",
  },
  {
    oppName: "Delta Co - MBP Expansion",
    accountName: "Delta Co",
    accountId: "001D",
    oppId: "006F",
    rep: "Example Rep",
    closeDate: new Date().toISOString().slice(0, 10),
    type: "Expansion",
    product: "MBP",
    amount: 48000,
    mrr: 3000,
    stage: "Closed Won",
    funnelStage: "Closed Won",
  },
  {
    oppName: "Epsilon Ltd - Showcase New",
    accountName: "Epsilon Ltd",
    accountId: "001E",
    oppId: "006G",
    rep: "Example Rep",
    closeDate: new Date().toISOString().slice(0, 10),
    type: "New Business",
    product: "Showcase",
    amount: 9600,
    mrr: 800,
    stage: "Proposal/Negotiation",
    funnelStage: "Proposal/Negotiation",
  },
  {
    oppName: "Zeta Group - Showcase Discovery",
    accountName: "Zeta Group",
    accountId: "001F",
    oppId: "006H",
    rep: "Example Rep",
    closeDate: new Date().toISOString().slice(0, 10),
    type: "New Business",
    product: "Showcase",
    amount: 7200,
    mrr: 600,
    stage: "Discovery",
    funnelStage: "Discovery",
  },
  {
    oppName: "Theta Inc - Showcase Demo",
    accountName: "Theta Inc",
    accountId: "001G",
    oppId: "006I",
    rep: "Example Rep",
    closeDate: (() => {
      const d = new Date();
      d.setMonth(d.getMonth() - 1);
      d.setDate(15);
      return d.toISOString().slice(0, 10);
    })(),
    type: "New Business",
    product: "Showcase",
    amount: 15000,
    mrr: 1250,
    stage: "Demo Scheduled",
    funnelStage: "Demo Scheduled",
    isStale: true,
  },
  {
    oppName: "Kappa Corp - MBP Premium",
    accountName: "Kappa Corp",
    accountId: "001H",
    oppId: "006J",
    rep: "Example Rep",
    closeDate: new Date().toISOString().slice(0, 10),
    type: "New Business",
    product: "MBP",
    amount: 60000,
    mrr: 5000,
    stage: "Paperwork Sent",
    funnelStage: "Paperwork Sent",
  },
];

const FUNNEL_STAGES = ["Discovery", "Demo Scheduled", "Proposal/Negotiation", "Paperwork Sent", "Awaiting Payment", "Closed Won"];
const FUNNEL_COLORS: Record<string, string> = {
  Discovery: "#006AFF",
  "Demo Scheduled": "#3B82F6",
  "Proposal/Negotiation": "#8B5CF6",
  "Paperwork Sent": "#F59E0B",
  "Awaiting Payment": "#10B981",
  "Closed Won": "#00C49F",
};

function formatCurrency(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return `${v < 0 ? "-" : ""}$${(abs / 1000).toFixed(abs % 1000 === 0 ? 0 : 1)}k`;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatDollar(v: number): string {
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface TooltipBubbleProps {
  text: string;
  children: React.ReactNode;
}

function TooltipBubble({ text, children }: TooltipBubbleProps) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = React.useRef<HTMLSpanElement>(null);

  const handleEnter = () => {
    setShow(true);
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setPos({ top: rect.top, left: rect.left + rect.width / 2 });
    }
  };

  return (
    <span
      ref={ref}
      className="relative inline-block"
      onMouseEnter={handleEnter}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && pos && ReactDOM.createPortal(
        <div
          className="fixed z-[9999] max-w-[340px] bg-[#1e293b] text-white text-[10px] rounded-md px-3 py-2 shadow-lg pointer-events-none leading-relaxed"
          style={{ top: pos.top - 8, left: Math.max(8, Math.min(pos.left, window.innerWidth - 348)), transform: "translateY(-100%)" }}
        >
          {text}
          <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-[#1e293b]" />
        </div>,
        document.body
      )}
    </span>
  );
}

interface SalesforceExplainerModalProps {
  onClose: () => void;
}

export default function SalesforceExplainerModal({ onClose }: SalesforceExplainerModalProps) {
  const [mrrMode, setMrrMode] = useState<ExplainerMrrMode>("gnrNet");
  const [includeStale, setIncludeStale] = useState(false);
  const [repSearch, setRepSearch] = useState("");
  const [opps, setOpps] = useState<ExplainerOpp[]>(EXAMPLE_OPPS);
  const [loadingRep, setLoadingRep] = useState(false);
  const [activeRepName, setActiveRepName] = useState("Example Rep");
  const [repOptions, setRepOptions] = useState<string[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [hoveredMatchKey, setHoveredMatchKey] = useState<string | null>(null);

  const apiBase = import.meta.env.BASE_URL || "/";

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const [allRepNames, setAllRepNames] = useState<string[]>([]);

  useEffect(() => {
    fetch(`${apiBase}api/sales/config`)
      .then(r => r.json())
      .then((data: ConfigResponse) => {
        const org = data.org || {};
        const names: string[] = [];
        for (const slm of Object.keys(org)) {
          for (const flm of Object.keys(org[slm] || {})) {
            for (const rep of (org[slm][flm] || [])) {
              if (!names.includes(rep)) names.push(rep);
            }
          }
        }
        setAllRepNames(names.sort());
      })
      .catch(() => {});
  }, [apiBase]);

  function isCWStage(o: RawApiOpp): boolean {
    return o.funnelStage === "Closed Won" || o.stage === "Closed Won" || o.stage === "Closed: Won";
  }

  function rawToExplainer(o: RawApiOpp, isStale: boolean, isChurnMatch: boolean): ExplainerOpp {
    return {
      oppName: o.oppName || "",
      accountName: o.accountName || "",
      accountId: o.accountId || "",
      oppId: o.oppId || "",
      rep: o.rep || "",
      closeDate: o.closeDate || "",
      type: o.type || "",
      product: o.product || "",
      amount: o.amount || 0,
      mrr: o.mrr || 0,
      stage: o.stage || "",
      funnelStage: o.funnelStage || "",
      isStale,
      isChurnMatch,
    };
  }

  const fetchRepData = useCallback(async (repName: string) => {
    if (!repName.trim()) {
      setOpps(EXAMPLE_OPPS);
      setActiveRepName("Example Rep");
      return;
    }
    setLoadingRep(true);
    try {
      const now = new Date();
      const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const to = now.toISOString().slice(0, 10);
      const resp = await fetch(`${apiBase}api/sales/opportunities?type=mrr&from=${from}&to=${to}`);
      const data: OpportunitiesResponse = await resp.json();
      const repOpps = (data.opportunities || []).filter((o: RawApiOpp) => o.rep === repName);
      const allOpps: ExplainerOpp[] = repOpps.map((o: RawApiOpp) => {
          const cd = new Date((o.closeDate || "") + "T00:00:00");
          const isStale = !isCWStage(o) && cd < currentMonthStart;
          const isChurnMatch = isCWStage(o) && o.mrr > 0 &&
            repOpps.some((neg: RawApiOpp) => neg.mrr < 0 &&
              neg.rep === o.rep && neg.accountId === o.accountId && neg.product === o.product &&
              isCWStage(neg));
          return rawToExplainer(o, isStale, isChurnMatch);
        });
      setOpps(allOpps.length > 0 ? allOpps : EXAMPLE_OPPS);
      setActiveRepName(allOpps.length > 0 ? repName : "Example Rep");
    } catch {
      setOpps(EXAMPLE_OPPS);
      setActiveRepName("Example Rep");
    }
    setLoadingRep(false);
  }, [apiBase]);

  useEffect(() => {
    if (!repSearch.trim()) {
      setRepOptions([]);
      setShowDropdown(false);
      return;
    }
    const timer = setTimeout(() => {
      const q = repSearch.toLowerCase();
      const matches = allRepNames.filter(r => r.toLowerCase().includes(q)).slice(0, 10);
      setRepOptions(matches);
      setShowDropdown(matches.length > 0);
    }, 150);
    return () => clearTimeout(timer);
  }, [repSearch, allRepNames]);

  const filteredOpps = useMemo(() => {
    let result = opps.map(o => ({ ...o, excluded: false, excludeReason: "" }));

    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    if (!includeStale) {
      result = result.map(o => {
        if (o.excluded) return o;
        if (o.isStale) return { ...o, excluded: true, excludeReason: "Stale opp — close date is prior month but still open. Turn on 'Include Stale Opps' to include." };
        if (o.funnelStage !== "Closed Won") {
          const cd = new Date(o.closeDate + "T00:00:00");
          if (cd < currentMonthStart) return { ...o, excluded: true, excludeReason: "Close date is prior month — excluded from pipeline." };
        }
        return o;
      });
    }

    if (mrrMode === "added") {
      result = result.map(o => {
        if (o.excluded) return o;
        if (o.funnelStage === "Closed Won" && o.mrr <= 0) return { ...o, excluded: true, excludeReason: "Gross Added: Only positive MRR opps are included in this mode." };
        return o;
      });
    } else if (mrrMode === "acqNet") {
      const positiveKeys = new Set<string>();
      for (const o of result) {
        if (!o.excluded && o.mrr > 0 && o.funnelStage === "Closed Won") {
          positiveKeys.add(`${o.rep}||${o.accountId}||${o.product}`);
        }
      }
      result = result.map(o => {
        if (o.excluded) return o;
        if (o.funnelStage !== "Closed Won") return o;
        if (o.mrr >= 0) return o;
        const key = `${o.rep}||${o.accountId}||${o.product}`;
        if (!positiveKeys.has(key)) return { ...o, excluded: true, excludeReason: "ACQ MRR: This churn opp has no matching positive opp (same rep/account/product) closed in the same month, so it's excluded from ACQ MRR (ACQ Single Month MRR). In G&R Net mode, this churn would be included." };
        return o;
      });
    }

    return result;
  }, [opps, mrrMode, includeStale]);

  const getValue = useCallback((o: ExplainerOpp) => {
    return mrrMode === "amount" ? o.amount : o.mrr;
  }, [mrrMode]);

  const includedOpps = useMemo(() => filteredOpps.filter(o => !o.excluded), [filteredOpps]);

  const funnelData = useMemo(() => {
    const sums: Record<string, number> = {};
    for (const s of FUNNEL_STAGES) sums[s] = 0;
    for (const o of includedOpps) {
      if (sums[o.funnelStage] !== undefined) {
        sums[o.funnelStage] += getValue(o);
      }
    }
    return FUNNEL_STAGES.map(s => ({ stage: s, value: sums[s] }));
  }, [includedOpps, getValue]);

  const mrrSummary = useMemo(() => {
    const closedWon = includedOpps.filter(o => o.funnelStage === "Closed Won");
    const positive = closedWon.filter(o => getValue(o) > 0).reduce((s, o) => s + getValue(o), 0);
    const negative = closedWon.filter(o => getValue(o) < 0).reduce((s, o) => s + getValue(o), 0);
    const net = positive + negative;
    const pipeline = includedOpps.filter(o => o.funnelStage !== "Closed Won").reduce((s, o) => s + getValue(o), 0);
    return { positive, negative, net, pipeline, total: net + pipeline };
  }, [includedOpps, getValue]);

  const maxFunnelVal = Math.max(...funnelData.map(d => Math.abs(d.value)), 1);

  const getHighlightInfo = useCallback((opp: ExplainerOpp, field?: string): { rowHighlight: string; cellHighlight: string; tooltip: string } | null => {
    if (opp.excluded) {
      let color = "bg-gray-50/70";
      let cellColor = "bg-gray-100/60";
      if (opp.isStale) { color = "bg-blue-50/40"; cellColor = "bg-blue-100/50"; }
      else if (mrrMode === "added") { color = "bg-red-50/40"; cellColor = "bg-red-100/50"; }
      else if (mrrMode === "acqNet") { color = "bg-purple-50/40"; cellColor = "bg-purple-100/50"; }
      const isRelevantCell = field === "mrr" || field === "amount";
      return {
        rowHighlight: color,
        cellHighlight: isRelevantCell ? cellColor : "",
        tooltip: isRelevantCell ? (opp.excludeReason || "This opp's MRR is excluded in this mode.") : "",
      };
    }

    if (opp.isStale && includeStale) {
      const isStaleCell = field === "closeDate" || field === "funnelStage";
      return {
        rowHighlight: "bg-blue-50/70",
        cellHighlight: isStaleCell ? "bg-blue-100/80" : "",
        tooltip: isStaleCell
          ? `Pipeline Logic: This opp has a close date of ${opp.closeDate} (prior month) but is still open. With "Include Stale Opps" on, it's included in pipeline totals.`
          : "",
      };
    }

    if (opp.isChurnMatch && mrrMode === "acqNet") {
      const isMatchCell = field === "mrr" || field === "amount";
      return {
        rowHighlight: "bg-green-50/70",
        cellHighlight: isMatchCell ? "bg-green-100/80" : "",
        tooltip: isMatchCell
          ? `ACQ MRR: This positive opp has a matching negative opp (same rep/account/product) closed in the same month. The negative counterpart's churn is counted as "in-month matched" ACQ churn. Hover to highlight the match.`
          : "",
      };
    }

    if (!opp.isChurnMatch && opp.mrr < 0 && mrrMode === "acqNet" && hoveredMatchKey &&
      hoveredMatchKey === `${opp.rep}||${opp.accountId}||${opp.product}`) {
      return {
        rowHighlight: "bg-green-200",
        cellHighlight: (field === "mrr" || field === "amount") ? "bg-green-300" : "",
        tooltip: "",
      };
    }

    if (opp.funnelStage === "Closed Won" && opp.mrr < 0 && mrrMode === "gnrNet") {
      const isChurnCell = field === "mrr" || field === "amount";
      return {
        rowHighlight: "bg-red-50/60",
        cellHighlight: isChurnCell ? "bg-red-100/70" : "",
        tooltip: isChurnCell
          ? `G&R Net: This ${formatDollar(opp.mrr)} churn is included because G&R counts all negative Closed Won opps as churn — even without a matching positive opp in the same month. In ACQ MRR (ACQ Single Month MRR) mode, this would only count if there's a matching positive opp.`
          : "",
      };
    }

    if (mrrMode === "amount" && Math.abs(opp.amount / 12 - opp.mrr) > 10) {
      const isAmountCell = field === "amount" || field === "mrr";
      return {
        rowHighlight: "bg-red-50/40",
        cellHighlight: isAmountCell ? "bg-red-100/60" : "",
        tooltip: isAmountCell
          ? `Amount vs MRR: Amount (${formatDollar(opp.amount)}) ÷ 12 = ${formatDollar(opp.amount / 12)}, but actual MRR is ${formatDollar(opp.mrr)}. The "Amount" field includes annualized revenue and doesn't correctly calculate MRR.`
          : "",
      };
    }

    return null;
  }, [mrrMode, includeStale, hoveredMatchKey]);

  const mrrModeLabel = mrrMode === "gnrNet" ? "G&R Net" : mrrMode === "acqNet" ? "ACQ MRR" : mrrMode === "added" ? "Gross" : "Amount";
  const valueLabel = mrrMode === "amount" ? "Amount" : "MRR";

  const columns = [
    { key: "oppName", label: "Opportunity", width: "min-w-[140px] max-w-[220px]" },
    { key: "accountName", label: "Account", width: "min-w-[100px] max-w-[160px]" },
    { key: "closeDate", label: "Close Date", width: "w-[95px]" },
    { key: "type", label: "Type", width: "min-w-[80px] max-w-[110px]" },
    { key: "product", label: "Product", width: "min-w-[70px] max-w-[100px]" },
    { key: "amount", label: "Amount", width: "w-[100px]" },
    { key: "mrr", label: "MRR", width: "w-[100px]" },
    { key: "funnelStage", label: "Stage", width: "min-w-[90px] max-w-[130px]" },
  ];

  return (
    <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Why is my MRR different in Salesforce?"
        className="bg-white rounded-xl shadow-2xl flex flex-col"
        style={{ width: "95vw", height: "92vh" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <div>
            <h2 className="text-[18px] font-bold text-[#1e293b]">Why is my MRR different in Salesforce?</h2>
            <p className="text-[12px] text-[#64748b] mt-0.5">
              Toggle settings below to see how each option affects {activeRepName}'s numbers. {activeRepName === "Example Rep" ? "Search for a rep to see their real data." : ""}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5 text-[#64748b]" />
          </button>
        </div>

        <div className="flex items-center gap-4 px-6 py-3 border-b border-gray-100 bg-gray-50/50 shrink-0 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-medium text-[#64748b] uppercase tracking-wider">MRR Mode</span>
            <div className="flex bg-white rounded-md border border-gray-200 p-0.5">
              {(["gnrNet", "acqNet", "added", "amount"] as ExplainerMrrMode[]).map(mode => (
                <TooltipBubble
                  key={mode}
                  text={
                    mode === "amount"
                      ? "This Salesforce field includes annualized revenue and does not correctly calculate MRR."
                      : mode === "gnrNet"
                        ? "All Closed Won opps including all churn"
                        : mode === "acqNet"
                          ? "Closed Won opps + matched in-month churn only"
                          : "Only positive MRR opps"
                  }
                >
                  <button
                    onClick={() => setMrrMode(mode)}
                    className={`px-2.5 py-1 text-[10px] font-medium rounded transition-all ${
                      mrrMode === mode
                        ? mode === "amount"
                          ? "bg-red-50 text-red-700 shadow-sm ring-1 ring-red-200"
                          : "bg-white text-[#0a1628] shadow-sm ring-1 ring-gray-200"
                        : mode === "amount"
                          ? "text-red-400 hover:text-red-600 hover:bg-red-50/50"
                          : "text-[#64748b] hover:text-[#1e293b]"
                    }`}
                  >
                    {mode === "gnrNet" ? "G&R Net" : mode === "acqNet" ? "ACQ MRR" : mode === "added" ? "Gross" : "Amount"}
                    {mode === "amount" && <Info className="inline w-3 h-3 ml-0.5 text-red-400" />}
                  </button>
                </TooltipBubble>
              ))}
            </div>
          </div>

          <div className="h-6 w-px bg-gray-200" />

          <div className="flex items-center gap-2">
            <span className="text-[10px] font-medium text-[#64748b] uppercase tracking-wider">Pipeline Logic</span>
            <button
              onClick={() => setIncludeStale(v => !v)}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-medium rounded-md border transition-all ${
                includeStale
                  ? "bg-blue-50 border-blue-200 text-blue-700"
                  : "bg-white border-gray-200 text-[#64748b] hover:text-[#1e293b]"
              }`}
            >
              <span>Include Stale Opps</span>
              <div className={`w-6 h-3.5 rounded-full transition-all relative ${includeStale ? "bg-blue-500" : "bg-gray-300"}`}>
                <div className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow-sm transition-all ${includeStale ? "left-3" : "left-0.5"}`} />
              </div>
            </button>
          </div>

          <div className="h-6 w-px bg-gray-200" />

          <div className="relative flex items-center gap-2">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#94a3b8] pointer-events-none" />
            <input
              type="text"
              value={repSearch}
              onChange={e => {
                setRepSearch(e.target.value);
                if (!e.target.value.trim()) {
                  setOpps(EXAMPLE_OPPS);
                  setActiveRepName("Example Rep");
                  setShowDropdown(false);
                }
              }}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setShowDropdown(false);
                  if (repOptions.length > 0) {
                    const exactMatch = repOptions.find(r => r.toLowerCase() === repSearch.toLowerCase());
                    const target = exactMatch || repOptions[0];
                    setRepSearch(target);
                    fetchRepData(target);
                  } else if (repSearch.trim()) {
                    fetchRepData(repSearch.trim());
                  }
                }
              }}
              placeholder="Search rep name..."
              className="pl-7 pr-3 py-1.5 text-[11px] border border-gray-200 rounded-md w-[200px] bg-white text-[#1e293b] placeholder:text-[#94a3b8] focus:outline-none focus:ring-1 focus:ring-[#006AFF]"
            />
            {showDropdown && repOptions.length > 0 && (
              <div className="absolute top-full left-0 mt-1 w-[240px] bg-white border border-gray-200 rounded-md shadow-lg z-50 max-h-[200px] overflow-y-auto">
                {repOptions.map(name => (
                  <button
                    key={name}
                    onClick={() => {
                      setRepSearch(name);
                      setShowDropdown(false);
                      fetchRepData(name);
                    }}
                    className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-blue-50 text-[#1e293b] transition-colors"
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
            {loadingRep && <span className="text-[10px] text-[#64748b]">Loading...</span>}
          </div>
        </div>

        <div className="flex-1 overflow-auto min-h-0 p-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h3 className="text-[13px] font-semibold text-[#1e293b] mb-3">Pipeline Funnel — {mrrModeLabel} {valueLabel}</h3>
              <div className="space-y-1.5">
                {funnelData.map(({ stage, value }) => (
                  <div key={stage} className="flex items-center gap-2">
                    <div className="w-[100px] shrink-0 text-[10px] text-[#64748b] text-right">{stage}</div>
                    <div className="flex-1 relative h-5 bg-gray-100 rounded-r overflow-hidden">
                      <div
                        className="h-full rounded-r transition-all"
                        style={{
                          width: `${Math.max(value !== 0 ? 3 : 0, (Math.abs(value) / maxFunnelVal) * 100)}%`,
                          backgroundColor: value < 0 ? "#EF4444" : (FUNNEL_COLORS[stage] || "#006AFF"),
                        }}
                      />
                    </div>
                    <div className={`w-[70px] shrink-0 text-right text-[10px] font-medium ${value < 0 ? "text-red-500" : "text-[#64748b]"}`}>
                      {formatCurrency(value)}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h3 className="text-[13px] font-semibold text-[#1e293b] mb-3">{mrrModeLabel} {valueLabel} Summary — {activeRepName}</h3>
              <div className="space-y-3">
                <div className="flex justify-between items-center py-2 border-b border-gray-100">
                  <span className="text-[11px] text-[#64748b]">Closed Won (Positive)</span>
                  <span className="text-[13px] font-semibold text-green-600">{formatDollar(mrrSummary.positive)}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-gray-100">
                  <span className="text-[11px] text-[#64748b]">Closed Won (Negative/Churn)</span>
                  <span className="text-[13px] font-semibold text-red-500">{formatDollar(mrrSummary.negative)}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-gray-100">
                  <span className="text-[11px] font-medium text-[#1e293b]">Net Closed Won</span>
                  <span className={`text-[14px] font-bold ${mrrSummary.net >= 0 ? "text-[#1e293b]" : "text-red-500"}`}>{formatDollar(mrrSummary.net)}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-gray-100">
                  <span className="text-[11px] text-[#64748b]">Open Pipeline</span>
                  <span className="text-[13px] font-semibold text-blue-600">{formatDollar(mrrSummary.pipeline)}</span>
                </div>
                <div className="flex justify-between items-center py-2 bg-gray-50 rounded px-2 -mx-2">
                  <span className="text-[11px] font-medium text-[#1e293b]">Total (Pipeline + CW)</span>
                  <span className="text-[14px] font-bold text-[#1e293b]">{formatDollar(mrrSummary.total)}</span>
                </div>
              </div>
              {mrrMode === "amount" && (
                <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-[10px] text-red-700 flex items-start gap-1.5">
                  <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>The "Amount" field shows annualized contract value, not MRR. Dividing Amount by 12 often doesn't match the actual MRR — look for highlighted rows below.</span>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-[#1e293b]">
                Opportunities — {activeRepName}
                <span className="text-[11px] font-normal text-[#64748b] ml-2">{includedOpps.length} included · {filteredOpps.length} total</span>
              </h3>
              <div className="flex items-center gap-3 text-[10px] text-[#64748b]">
                {filteredOpps.some(o => o.excluded) && <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm border border-gray-300" style={{ background: "repeating-linear-gradient(135deg, transparent, transparent 2px, rgba(0,0,0,0.08) 2px, rgba(0,0,0,0.08) 4px)" }} /> Excluded</span>}
                {includeStale && <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-100 border border-blue-200" /> Stale Opp</span>}
                {mrrMode === "acqNet" && <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-green-100 border border-green-200" /> ACQ Churn Match</span>}
                {mrrMode === "amount" && <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-100 border border-red-200" /> Amount ≠ MRR</span>}
              </div>
            </div>
            <div className="overflow-auto" style={{ maxHeight: "calc(92vh - 500px)" }}>
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-gray-50 z-10">
                  <tr>
                    {columns.map(col => (
                      <th
                        key={col.key}
                        className={`${col.width} text-left px-3 py-2.5 font-semibold text-[10px] text-[#64748b] uppercase tracking-wide whitespace-nowrap`}
                      >
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredOpps.map((opp, i) => {
                    const highlight = getHighlightInfo(opp);
                    const rowClass = highlight?.rowHighlight || "";
                    const isExcluded = !!opp.excluded;
                    return (
                      <tr key={opp.oppId || i} className={`hover:bg-gray-50/80 transition-colors ${rowClass} ${isExcluded ? "opacity-50" : ""}`}>
                        {columns.map(col => {
                          const cellHighlight = getHighlightInfo(opp, col.key);
                          const cellClass = cellHighlight?.cellHighlight || "";
                          const tooltip = cellHighlight?.tooltip || "";
                          const isNum = col.key === "amount" || col.key === "mrr";
                          const val = opp[col.key as keyof ExplainerOpp];
                          const content = isNum
                            ? formatDollar(val as number)
                            : col.key === "funnelStage"
                              ? displayProductText(opp.funnelStage)
                              : col.key === "product"
                                ? displayProduct(String(val || ""))
                                : col.key === "oppName" || col.key === "type"
                                  ? displayProductText(String(val || ""))
                                  : String(val || "");

                          const inner = (
                            <span className={`${isNum ? "font-medium" : "truncate"} ${isNum && (val as number) < 0 ? "text-red-500" : ""} ${isExcluded && isNum ? "line-through" : ""}`}>
                              {col.key === "oppName" && opp.isStale && (
                                <span className="inline-flex items-center px-1 py-0.5 rounded text-[8px] font-semibold bg-blue-100 text-blue-700 mr-1">STALE</span>
                              )}
                              {content}
                            </span>
                          );

                          const matchKey = opp.isChurnMatch && isNum && mrrMode === "acqNet"
                            ? `${opp.rep}||${opp.accountId}||${opp.product}`
                            : null;

                          return (
                            <td
                              key={col.key}
                              className={`px-3 py-2 ${col.width} ${isNum ? "text-right whitespace-nowrap" : col.key === "closeDate" ? "whitespace-nowrap" : "truncate"} ${cellClass}`}
                              onMouseEnter={matchKey ? () => setHoveredMatchKey(matchKey) : undefined}
                              onMouseLeave={matchKey ? () => setHoveredMatchKey(null) : undefined}
                            >
                              {tooltip ? (
                                <TooltipBubble text={tooltip}>{inner}</TooltipBubble>
                              ) : inner}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
