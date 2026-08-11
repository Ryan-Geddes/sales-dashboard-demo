import React, { useEffect, useMemo, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import { FilterState } from "../../pages/Dashboard";
import { ActivityData, PipelineData, SalesConfig } from "@workspace/api-client-react";
import type { AuthUser } from "@workspace/replit-auth-web";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { getDateRange, passesChannelFilter, getTodayPST, fmtDate, nowPST } from "@/lib/utils";
import { Trophy, Plus, Check, Trash2, Clock, Pencil } from "lucide-react";
import { usePhotoMap } from "../../hooks/usePhotoMap";
import { displayProduct, displayProductText } from "@/lib/product-labels";

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
  sbrs: number;
  demos: number;
  opps: number;
}

const SPIFF_METRIC_FIELD: Record<string, keyof ActivityByRepEntry> = {
  dials: "dials",
  convos: "convos",
  talk: "talkMin",
  sbrs: "sbrs",
  emails: "demos",
  opps: "opps",
};

const API_BASE = import.meta.env.BASE_URL || "/";

interface SpiffViewProps {
  loading: boolean;
  data?: ActivityData;
  pipelineData?: PipelineData;
  config?: SalesConfig;
  filters: FilterState;
  authUser: AuthUser;
}

export interface SpiffViewRef {
  toggleCreateForm: () => void;
}

interface Contest {
  id: number;
  title: string;
  objective: string | null;
  metric: string;
  product: string | null;
  startDate: string;
  endDate: string;
  eligibility: string | null;
  incentiveStructure: string | null;
  rewardDetails: string | null;
  createdByName: string;
  createdByRole: string;
  scope: string | null;
  status: string;
  approvedByName: string | null;
  approvedAt: string | null;
  createdAt: string;
}

const ACTIVITY_METRICS = [
  { id: "dials", label: "Dials" },
  { id: "convos", label: "Meaningful Conversations" },
  { id: "talk", label: "Talk Time" },
  { id: "emails", label: "Emails" },
  { id: "sbrs", label: "SBRs" },
  { id: "opps", label: "Opps Created" },
];

const MRR_METRICS = [
  { id: "acqNetMrr", label: "ACQ MRR" },
  { id: "gnrNetMrr", label: "G&R Net MRR" },
  { id: "grossMrr", label: "Gross MRR (Closed Won)" },
];

function ProfilePhoto({ name, photos, size = 32 }: { name: string; photos: Record<string, string>; size?: number }) {
  const url = photos[name];
  const [error, setError] = useState(false);

  if (!url || error) {
    return (
      <div
        className="rounded-full bg-gray-200 shrink-0 flex items-center justify-center text-gray-400 font-medium"
        style={{ width: size, height: size, fontSize: size * 0.35 }}
      >
        {name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}
      </div>
    );
  }

  return (
    <img
      src={`${API_BASE}${url.replace(/^\/api\//, "api/")}`}
      alt={name}
      className="rounded-full shrink-0 object-cover"
      style={{ width: size, height: size }}
      onError={() => setError(true)}
    />
  );
}


function CreateContestForm({ products, onCreated, onCancel }: { products: string[]; onCreated: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [metric, setMetric] = useState("dials");
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [startDate, setStartDate] = useState(() => fmtDate(getTodayPST()));
  const [endDate, setEndDate] = useState(() => {
    const d = getTodayPST();
    d.setDate(d.getDate() + 7);
    return fmtDate(d);
  });
  const [eligibility, setEligibility] = useState("");
  const [incentiveStructure, setIncentiveStructure] = useState("");
  const [rewardDetails, setRewardDetails] = useState("");
  const [scope, setScope] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (new Date(startDate) > new Date(endDate)) {
      setError("Start date must be before end date");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}api/sales/contests`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, objective, metric, product: selectedProducts.join(","), startDate, endDate, eligibility, incentiveStructure, rewardDetails, scope }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create contest");
        return;
      }
      onCreated();
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="no-shadow mb-6">
      <CardContent className="p-6">
        <h3 className="text-[16px] font-bold text-[#0a1628] mb-4 flex items-center gap-2">
          <Plus className="w-4 h-4" /> New Contest
        </h3>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <label className="text-[11px] font-medium text-[#64748b] block mb-1">Title *</label>
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. March Dials Blitz" className="h-[32px] text-[13px]" required />
          </div>
          <div className="md:col-span-2">
            <label className="text-[11px] font-medium text-[#64748b] block mb-1">Objective</label>
            <Input value={objective} onChange={e => setObjective(e.target.value)} placeholder="What is the goal of this contest?" className="h-[32px] text-[13px]" />
          </div>
          <div>
            <label className="text-[11px] font-medium text-[#64748b] block mb-1">Metric *</label>
            <Select value={metric} onValueChange={setMetric}>
              <SelectTrigger className="h-[32px] text-[12px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_activity_header" disabled className="text-[11px] font-bold text-[#64748b]">Activity Metrics</SelectItem>
                {ACTIVITY_METRICS.map(m => <SelectItem key={m.id} value={m.id} className="text-[12px]">{m.label}</SelectItem>)}
                <SelectItem value="_mrr_header" disabled className="text-[11px] font-bold text-[#64748b]">MRR Metrics</SelectItem>
                {MRR_METRICS.map(m => <SelectItem key={m.id} value={m.id} className="text-[12px]">{m.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[11px] font-medium text-[#64748b] block mb-1">Product Filter</label>
            <div className="border rounded-md p-2 max-h-[120px] overflow-y-auto space-y-1">
              {products.length === 0 && <span className="text-[11px] text-[#94a3b8]">No products available</span>}
              {products.map(p => (
                <label key={p} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5">
                  <input
                    type="checkbox"
                    checked={selectedProducts.includes(p)}
                    onChange={() => setSelectedProducts(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])}
                    className="w-3.5 h-3.5 rounded border-gray-300"
                  />
                  <span className="text-[12px] text-[#0a1628]">{displayProduct(p)}</span>
                </label>
              ))}
            </div>
            {selectedProducts.length > 0 && (
              <div className="text-[10px] text-[#64748b] mt-1">{selectedProducts.length} selected</div>
            )}
          </div>
          <div>
            <label className="text-[11px] font-medium text-[#64748b] block mb-1">Start Date *</label>
            <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="h-[32px] text-[13px]" required />
          </div>
          <div>
            <label className="text-[11px] font-medium text-[#64748b] block mb-1">End Date *</label>
            <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} min={startDate} className="h-[32px] text-[13px]" required />
          </div>
          <div>
            <label className="text-[11px] font-medium text-[#64748b] block mb-1">Eligibility</label>
            <Input value={eligibility} onChange={e => setEligibility(e.target.value)} placeholder="e.g. All Acquisitions reps" className="h-[32px] text-[13px]" />
          </div>
          <div>
            <label className="text-[11px] font-medium text-[#64748b] block mb-1">Incentive Structure</label>
            <Input value={incentiveStructure} onChange={e => setIncentiveStructure(e.target.value)} placeholder="e.g. Top 3 win, team bonus at 500+" className="h-[32px] text-[13px]" />
          </div>
          <div className="md:col-span-2">
            <label className="text-[11px] font-medium text-[#64748b] block mb-1">Reward Details</label>
            <Input value={rewardDetails} onChange={e => setRewardDetails(e.target.value)} placeholder="e.g. $100 gift card, team lunch" className="h-[32px] text-[13px]" />
          </div>
          <div className="md:col-span-2">
            <label className="text-[11px] font-medium text-[#64748b] block mb-1">Scope (FLM name or leave blank for all)</label>
            <Input value={scope} onChange={e => setScope(e.target.value)} placeholder="All reps (leave blank)" className="h-[32px] text-[13px]" />
          </div>
          {error && <p className="text-red-500 text-[12px] md:col-span-2">{error}</p>}
          <div className="md:col-span-2 flex gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="h-[34px] px-6 bg-[#006AFF] text-white rounded-md text-[13px] font-medium hover:bg-[#005ce6] transition-colors disabled:opacity-50"
            >
              {submitting ? "Submitting..." : "Submit for Approval"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="h-[34px] px-4 bg-gray-100 text-[#64748b] rounded-md text-[13px] font-medium hover:bg-gray-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function EditContestForm({ contest, products, onSaved, onCancel }: { contest: Contest; products: string[]; onSaved: (updated: Contest) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(contest.title);
  const [objective, setObjective] = useState(contest.objective || "");
  const [metric, setMetric] = useState(contest.metric);
  const [selectedProducts, setSelectedProducts] = useState<string[]>(contest.product ? contest.product.split(",").filter(Boolean) : []);
  const [startDate, setStartDate] = useState(contest.startDate);
  const [endDate, setEndDate] = useState(contest.endDate);
  const [eligibility, setEligibility] = useState(contest.eligibility || "");
  const [incentiveStructure, setIncentiveStructure] = useState(contest.incentiveStructure || "");
  const [rewardDetails, setRewardDetails] = useState(contest.rewardDetails || "");
  const [scope, setScope] = useState(contest.scope || "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (new Date(startDate) > new Date(endDate)) {
      setError("Start date must be before end date");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}api/sales/contests/${contest.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, objective, metric, product: selectedProducts.join(","), startDate, endDate, eligibility, incentiveStructure, rewardDetails, scope }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to update contest");
        return;
      }
      onSaved(data.contest || data);
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h3 className="text-[16px] font-bold text-[#0a1628] mb-4 flex items-center gap-2">
        <Pencil className="w-4 h-4" /> Edit Contest
      </h3>
      <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="md:col-span-2">
          <label className="text-[11px] font-medium text-[#64748b] block mb-1">Title *</label>
          <Input value={title} onChange={e => setTitle(e.target.value)} className="h-[32px] text-[13px]" required />
        </div>
        <div className="md:col-span-2">
          <label className="text-[11px] font-medium text-[#64748b] block mb-1">Objective</label>
          <Input value={objective} onChange={e => setObjective(e.target.value)} className="h-[32px] text-[13px]" />
        </div>
        <div>
          <label className="text-[11px] font-medium text-[#64748b] block mb-1">Metric *</label>
          <Select value={metric} onValueChange={setMetric}>
            <SelectTrigger className="h-[32px] text-[12px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_activity_header" disabled className="text-[11px] font-bold text-[#64748b]">Activity Metrics</SelectItem>
              {ACTIVITY_METRICS.map(m => <SelectItem key={m.id} value={m.id} className="text-[12px]">{m.label}</SelectItem>)}
              <SelectItem value="_mrr_header" disabled className="text-[11px] font-bold text-[#64748b]">MRR Metrics</SelectItem>
              {MRR_METRICS.map(m => <SelectItem key={m.id} value={m.id} className="text-[12px]">{m.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-[11px] font-medium text-[#64748b] block mb-1">Product Filter</label>
          <div className="border rounded-md p-2 max-h-[100px] overflow-y-auto space-y-1">
            {products.length === 0 && <span className="text-[11px] text-[#94a3b8]">No products available</span>}
            {products.map(p => (
              <label key={p} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5">
                <input type="checkbox" checked={selectedProducts.includes(p)} onChange={() => setSelectedProducts(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])} className="w-3.5 h-3.5 rounded border-gray-300" />
                <span className="text-[12px] text-[#0a1628]">{displayProduct(p)}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="text-[11px] font-medium text-[#64748b] block mb-1">Start Date *</label>
          <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="h-[32px] text-[13px]" required />
        </div>
        <div>
          <label className="text-[11px] font-medium text-[#64748b] block mb-1">End Date *</label>
          <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} min={startDate} className="h-[32px] text-[13px]" required />
        </div>
        <div>
          <label className="text-[11px] font-medium text-[#64748b] block mb-1">Eligibility</label>
          <Input value={eligibility} onChange={e => setEligibility(e.target.value)} className="h-[32px] text-[13px]" />
        </div>
        <div>
          <label className="text-[11px] font-medium text-[#64748b] block mb-1">Incentive Structure</label>
          <Input value={incentiveStructure} onChange={e => setIncentiveStructure(e.target.value)} className="h-[32px] text-[13px]" />
        </div>
        <div className="md:col-span-2">
          <label className="text-[11px] font-medium text-[#64748b] block mb-1">Reward Details</label>
          <Input value={rewardDetails} onChange={e => setRewardDetails(e.target.value)} className="h-[32px] text-[13px]" />
        </div>
        <div className="md:col-span-2">
          <label className="text-[11px] font-medium text-[#64748b] block mb-1">Scope</label>
          <Input value={scope} onChange={e => setScope(e.target.value)} className="h-[32px] text-[13px]" />
        </div>
        {error && <p className="text-red-500 text-[12px] md:col-span-2">{error}</p>}
        <div className="md:col-span-2 flex gap-3">
          <button type="submit" disabled={submitting} className="h-[34px] px-6 bg-[#006AFF] text-white rounded-md text-[13px] font-medium hover:bg-[#005ce6] transition-colors disabled:opacity-50">
            {submitting ? "Saving..." : "Save Changes"}
          </button>
          <button type="button" onClick={onCancel} className="h-[34px] px-4 bg-gray-100 text-[#64748b] rounded-md text-[13px] font-medium hover:bg-gray-200 transition-colors">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function getContestStatusBadge(status: string) {
  if (status === "active") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700"><Check className="w-3 h-3" /> Active</span>;
  if (status === "pending") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700"><Clock className="w-3 h-3" /> Awaiting Approval</span>;
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-600">{status}</span>;
}

function isContestActive(contest: Contest): boolean {
  if (contest.status !== "active") return false;
  const now = nowPST();
  const start = new Date(contest.startDate);
  const end = new Date(contest.endDate);
  end.setHours(23, 59, 59, 999);
  return now >= start && now <= end;
}

function CountdownTimer({ endDate }: { endDate: string }) {
  const [remaining, setRemaining] = useState("");

  useEffect(() => {
    const calc = () => {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      const diff = end.getTime() - Date.now();
      if (diff <= 0) { setRemaining("Ended"); return; }
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const secs = Math.floor((diff % (1000 * 60)) / 1000);
      if (days > 0) setRemaining(`${days}d ${hours}h ${mins}m`);
      else setRemaining(`${hours}h ${mins}m ${secs}s`);
    };
    calc();
    const interval = setInterval(calc, 1000);
    return () => clearInterval(interval);
  }, [endDate]);

  return <span className="text-[11px] font-mono font-bold text-green-600">{remaining}</span>;
}

function getAllMetricLabel(id: string): string {
  return [...ACTIVITY_METRICS, ...MRR_METRICS].find(m => m.id === id)?.label || id;
}

function computeMrrValue(rep: PipelineData["reps"][0], metricId: string): number {
  if (metricId === "acqNetMrr") {
    return rep.group === "Acquisitions" ? rep.mrr30d : 0;
  }
  if (metricId === "gnrNetMrr") {
    return rep.group === "G&R" ? rep.mrr30d : 0;
  }
  if (metricId === "grossMrr") {
    return rep.mrr30d;
  }
  return 0;
}

function isMrrMetric(metricId: string): boolean {
  return metricId.startsWith("acqNet") || metricId.startsWith("gnrNet") || metricId.startsWith("gross");
}

const SpiffView = forwardRef<SpiffViewRef, SpiffViewProps>(function SpiffView({ loading, data, pipelineData, config, filters, authUser }, ref) {
  const configProducts = useMemo(() => config?.products ?? [], [config?.products]);
  const [contests, setContests] = useState<Contest[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedContest, setSelectedContest] = useState<Contest | null>(null);
  const { data: photosData } = usePhotoMap();
  const photos = photosData ?? {};
  const [contestsLoading, setContestsLoading] = useState(true);
  const [activityCounts, setActivityCounts] = useState<ActivityByRepEntry[] | null>(null);
  const [editingContest, setEditingContest] = useState<Contest | null>(null);

  useEffect(() => {
    const dr = getDateRange(filters.timeframe, filters.customRange);
    const params = new URLSearchParams();
    if (dr.from) params.set("from", dr.from);
    if (dr.to) params.set("to", dr.to);
    let cancelled = false;
    fetch(`${API_BASE}api/sales/activity-by-rep?${params.toString()}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => { if (!cancelled) setActivityCounts(d.reps || []); })
      .catch(() => { if (!cancelled) setActivityCounts([]); });
    return () => { cancelled = true; };
  }, [filters.timeframe, filters.customRange]);

  const fetchContests = useCallback(async () => {
    try {
      setContestsLoading(true);
      const res = await fetch(`${API_BASE}api/sales/contests`, { credentials: "include" });
      const d = await res.json();
      if (d.contests) setContests(d.contests);
    } catch {} finally {
      setContestsLoading(false);
    }
  }, []);

  useEffect(() => { fetchContests(); }, [fetchContests]);

  useImperativeHandle(ref, () => ({
    toggleCreateForm: () => setShowCreate(prev => !prev),
  }), []);

  const handleApprove = async (id: number) => {
    try {
      const res = await fetch(`${API_BASE}api/sales/contests/${id}/approve`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) fetchContests();
    } catch {}
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this contest?")) return;
    try {
      const res = await fetch(`${API_BASE}api/sales/contests/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        fetchContests();
        if (selectedContest?.id === id) setSelectedContest(null);
      }
    } catch {}
  };

  const userName = authUser.hierarchyName ?? `${authUser.firstName ?? ""} ${authUser.lastName ?? ""}`.trim();
  const role = authUser.role ?? "";
  const canManage = role === "flm" || role === "slm" || role === "exec" || role === "admin";
  const canApprove = role === "admin";
  const canEdit = (contest: Contest) => {
    if (!canManage) return false;
    if (role === "admin" || role === "slm" || role === "exec") return true;
    return contest.createdByName === userName;
  };
  const canDelete = canEdit;

  const activeContests = contests.filter(c => c.status === "active");
  const pendingContests = contests.filter(c => c.status === "pending");

  const leaderboardData = useMemo(() => {
    if (!selectedContest) return null;
    const contest = selectedContest;
    const metricId = contest.metric;
    const isMrr = isMrrMetric(metricId);

    if (isMrr && pipelineData?.reps) {
      let reps = pipelineData.reps;
      if (filters.slm.length > 0) reps = reps.filter(r => filters.slm.includes(r.slm));
      reps = reps.filter(r => passesChannelFilter(r.group, filters.group));
      if (contest.scope) reps = reps.filter(r => r.flm === contest.scope);

      const scores: { name: string; value: number }[] = [];
      for (const rep of reps) {
        let val = computeMrrValue(rep, metricId);
        if (contest.product && rep.productShare) {
          const contestProducts = contest.product.split(",").map(p => p.trim()).filter(Boolean);
          if (contestProducts.length > 0) {
            let totalShare = 0;
            for (const cp of contestProducts) {
              totalShare += rep.productShare[cp] ?? 0;
            }
            val = Math.round(val * totalShare);
          }
        }
        if (val !== 0) scores.push({ name: rep.name, value: val });
      }
      scores.sort((a, b) => b.value - a.value);
      return scores;
    }

    if (!isMrr && activityCounts) {
      let reps = activityCounts;
      if (filters.slm.length > 0) reps = reps.filter(r => filters.slm.includes(r.slm));
      reps = reps.filter(r => passesChannelFilter(r.group, filters.group));
      if (contest.scope) reps = reps.filter(r => r.flm === contest.scope);

      const field = SPIFF_METRIC_FIELD[metricId];
      if (!field) return null;

      const scores: { name: string; value: number }[] = [];
      for (const rep of reps) {
        const base = (rep[field] as number) || 0;
        scores.push({ name: rep.name, value: Math.round(base) });
      }
      scores.sort((a, b) => b.value - a.value);
      return scores;
    }

    return null;
  }, [selectedContest, activityCounts, pipelineData, filters]);

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 w-full" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Skeleton className="h-[400px] w-full" />
          <Skeleton className="h-[400px] w-full" />
        </div>
      </div>
    );
  }

  const hasNoContests = !contestsLoading && contests.length === 0;

  if (hasNoContests && !canManage) {
    return (
      <div className="flex flex-col items-center justify-center py-32">
        <Trophy className="w-16 h-16 text-[#e2e8f0] mb-4" />
        <h2 className="text-xl font-bold text-[#0a1628] mb-2">No Active Contests</h2>
        <p className="text-[13px] text-[#64748b] mb-6">Sales contests will appear here once created by a manager.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {canManage && showCreate && (
        <CreateContestForm
          products={configProducts}
          onCreated={() => { setShowCreate(false); fetchContests(); }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      <div className="space-y-4">
          {pendingContests.length > 0 && (
            <Card className="no-shadow border-amber-200">
              <CardContent className="p-4">
                <h3 className="text-[14px] font-bold text-amber-700 mb-3 flex items-center gap-2">
                  <Clock className="w-4 h-4" /> Awaiting Analytics Approval ({pendingContests.length})
                </h3>
                <div className="space-y-2">
                  {pendingContests.map(c => (
                    <div key={c.id} className={`p-3 rounded-lg border cursor-pointer transition-colors ${selectedContest?.id === c.id ? "border-[#006AFF] bg-[#006AFF]/5" : "border-border hover:bg-gray-50"}`} onClick={() => setSelectedContest(c)}>
                      <div className="flex items-center gap-3">
                        <ProfilePhoto name={c.createdByName} photos={photos} size={36} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="text-[13px] font-semibold text-[#0a1628]">{c.title}</span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {getContestStatusBadge(c.status)}
                              {canApprove && (
                                <button onClick={(e) => { e.stopPropagation(); handleApprove(c.id); }} className="p-1 rounded hover:bg-green-100 text-green-600" title="Approve">
                                  <Check className="w-4 h-4" />
                                </button>
                              )}
                              {canEdit(c) && (
                                <button onClick={(e) => { e.stopPropagation(); setEditingContest(c); setSelectedContest(c); }} className="p-1 rounded hover:bg-blue-100 text-blue-500" title="Edit">
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {canDelete(c) && (
                                <button onClick={(e) => { e.stopPropagation(); handleDelete(c.id); }} className="p-1 rounded hover:bg-red-100 text-red-500" title="Delete">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="text-[11px] text-[#64748b] mt-0.5">{getAllMetricLabel(c.metric)} &middot; {c.startDate} → {c.endDate} &middot; by {c.createdByName}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="no-shadow">
            <CardContent className="p-4">
              <h3 className="text-[14px] font-bold text-[#1e293b] mb-3 flex items-center gap-2">
                <Trophy className="w-4 h-4 text-[#F59E0B]" /> Active Contests ({activeContests.length})
              </h3>
              {activeContests.length === 0 && !contestsLoading ? (
                <div className="text-center py-8 text-[#64748b] text-[13px]">
                  No active contests. {canManage ? "Create one to get started!" : "Check back soon."}
                </div>
              ) : (
                <div className="space-y-2">
                  {activeContests.map(c => {
                    const active = isContestActive(c);
                    return (
                      <div
                        key={c.id}
                        className={`p-3 rounded-lg border cursor-pointer transition-colors ${selectedContest?.id === c.id ? "border-[#006AFF] bg-[#006AFF]/5" : active ? "border-green-300 bg-green-50/50" : "border-border hover:bg-gray-50"}`}
                        onClick={() => setSelectedContest(c)}
                      >
                        <div className="flex items-center gap-3">
                          <ProfilePhoto name={c.createdByName} photos={photos} size={36} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-[13px] font-semibold text-[#0a1628]">{c.title}</span>
                                {active && <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {getContestStatusBadge(c.status)}
                                {canEdit(c) && (
                                  <button onClick={(e) => { e.stopPropagation(); setEditingContest(c); setSelectedContest(c); }} className="p-1 rounded hover:bg-blue-100 text-blue-500" title="Edit">
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                {canDelete(c) && (
                                  <button onClick={(e) => { e.stopPropagation(); handleDelete(c.id); }} className="p-1 rounded hover:bg-red-100 text-red-500" title="Delete">
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </div>
                            <div className="text-[11px] text-[#64748b] mt-0.5 flex items-center gap-1.5 flex-wrap">
                              <span>{getAllMetricLabel(c.metric)} &middot; {c.startDate} → {c.endDate}</span>
                              {active && <CountdownTimer endDate={c.endDate} />}
                              {c.rewardDetails && <span>&middot; Reward: {c.rewardDetails}</span>}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

        <Card className="no-shadow">
          <CardContent className="p-6">
            {selectedContest && editingContest?.id === selectedContest.id ? (
              <EditContestForm
                contest={editingContest}
                products={configProducts}
                onSaved={(updated) => { setEditingContest(null); setSelectedContest(updated); fetchContests(); }}
                onCancel={() => setEditingContest(null)}
              />
            ) : selectedContest ? (
              <>
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-[16px] font-bold text-[#1e293b]">{selectedContest.title}</h3>
                  {canEdit(selectedContest) && (
                    <button onClick={() => setEditingContest(selectedContest)} className="p-1.5 rounded hover:bg-blue-100 text-blue-500" title="Edit">
                      <Pencil className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <div className="text-[12px] text-[#64748b] mb-4 flex items-center gap-2 flex-wrap">
                  <span>{getAllMetricLabel(selectedContest.metric)} &middot; {selectedContest.startDate} → {selectedContest.endDate}</span>
                  {isContestActive(selectedContest) && <CountdownTimer endDate={selectedContest.endDate} />}
                  {selectedContest.scope && <span>&middot; Scope: {selectedContest.scope}</span>}
                  {selectedContest.product && <span>&middot; Products: {displayProductText(selectedContest.product.split(",").join(", "))}</span>}
                </div>
                {selectedContest.objective && <p className="text-[12px] text-[#64748b] mb-3 italic">Objective: {selectedContest.objective}</p>}
                {selectedContest.eligibility && <p className="text-[12px] text-[#64748b] mb-1">Eligibility: {selectedContest.eligibility}</p>}
                {selectedContest.incentiveStructure && <p className="text-[12px] text-[#64748b] mb-1">Incentive: {selectedContest.incentiveStructure}</p>}
                {selectedContest.rewardDetails && (
                  <div className="text-[12px] text-[#F59E0B] font-medium mb-4">Reward: {selectedContest.rewardDetails}</div>
                )}

                {selectedContest.status !== "active" ? (
                  <div className="text-center py-10 text-[#64748b] text-[13px]">
                    This contest is awaiting approval. Leaderboard will be available once approved.
                  </div>
                ) : leaderboardData && leaderboardData.length > 0 ? (
                  <>
                    <div className="border-b pb-4 mb-4">
                      <h4 className="text-[12px] font-bold text-[#64748b] tracking-wider uppercase mb-4">Leaderboard</h4>
                    </div>

                    {leaderboardData[0] && (
                      <div className="flex flex-col items-center mb-6">
                        <div className="w-14 h-14 rounded-full border-2 border-[#F59E0B] overflow-hidden mb-2 shadow-sm">
                          <ProfilePhoto name={leaderboardData[0].name} photos={photos} size={56} />
                        </div>
                        <div className="text-[10px] font-bold text-[#64748b] tracking-wider uppercase">Leader</div>
                        <div className="text-[15px] font-bold text-[#0a1628]">{leaderboardData[0].name}</div>
                        <div className="text-[18px] font-black text-[#006AFF]">
                          {isMrrMetric(selectedContest.metric) ? `$${leaderboardData[0].value.toLocaleString()}` : leaderboardData[0].value.toLocaleString()}
                        </div>
                      </div>
                    )}

                    {leaderboardData[1] && (
                      <div className="flex flex-col items-center mb-6 pb-4 border-b border-border/50">
                        <div className="w-10 h-10 rounded-full border-2 border-gray-300 overflow-hidden mb-1">
                          <ProfilePhoto name={leaderboardData[1].name} photos={photos} size={40} />
                        </div>
                        <div className="text-[13px] font-semibold text-[#1e293b]">{leaderboardData[1].name}</div>
                        <div className="text-[15px] font-bold text-[#006AFF]">
                          {isMrrMetric(selectedContest.metric) ? `$${leaderboardData[1].value.toLocaleString()}` : leaderboardData[1].value.toLocaleString()}
                        </div>
                      </div>
                    )}

                    <div className="space-y-3">
                      {leaderboardData.slice(2, 15).map((score, i) => {
                        const maxVal = leaderboardData[0]?.value || 1;
                        return (
                          <div key={score.name} className="flex items-center">
                            <div className="w-6 text-center text-[11px] font-bold text-[#64748b]">{i + 3}</div>
                            <div className="mx-2">
                              <ProfilePhoto name={score.name} photos={photos} size={28} />
                            </div>
                            <div className="w-[120px] font-medium text-[12px] truncate" title={score.name}>{score.name}</div>
                            <div className="flex-1 mx-3">
                              <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
                                <div className="h-full bg-[#006AFF]" style={{ width: `${(score.value / maxVal) * 100}%` }} />
                              </div>
                            </div>
                            <div className="w-[60px] text-right font-bold text-[12px] text-[#1e293b]">
                              {isMrrMetric(selectedContest.metric) ? `$${score.value.toLocaleString()}` : score.value.toLocaleString()}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <div className="text-center py-10 text-[#64748b] text-[13px]">
                    No data available for this contest's metric and filters.
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-[#64748b]">
                <Trophy className="w-12 h-12 text-gray-300 mb-3" />
                <p className="text-[14px] font-medium">Select a contest to view its leaderboard</p>
                <p className="text-[12px] mt-1">Click on any contest above</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
});

export default SpiffView;
