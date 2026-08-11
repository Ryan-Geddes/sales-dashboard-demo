import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, AlertCircle, Check } from "lucide-react";
import type { FilterState } from "../../pages/Dashboard";
import type { AuthUser } from "@workspace/replit-auth-web";
import type { GetRoster200, RosterPersonRow } from "@workspace/api-client-react";
import RosterTable, { type RosterEditPatch } from "./goals/RosterTable";
import { deriveMonth, monthLabel } from "./goals/goalsApi";
import { fetchRoster, upsertRosterOverride } from "./goals/rosterApi";

interface RosterViewProps {
  filters: FilterState;
  authUser: AuthUser;
}

export default function RosterView({ filters, authUser }: RosterViewProps) {
  const queryClient = useQueryClient();
  const role = authUser?.role ?? null;
  const viewOnly = authUser?.viewOnly === true;
  const canEdit = !viewOnly && (role === "admin" || role === "slm" || role === "exec");

  const month = useMemo(
    () => deriveMonth(filters.timeframe, filters.customRange),
    [filters.timeframe, filters.customRange],
  );

  const rosterKey = ["roster", month] as const;

  const rosterQuery = useQuery<GetRoster200>({
    queryKey: rosterKey,
    queryFn: () => fetchRoster(month),
  });

  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Honor the dashboard header filters (SLM / FLM / rep / region / segment) so
  // the roster scopes to the same selection as the rest of the dashboard. SLM
  // and FLM filters are hierarchical: the named manager AND everyone under them
  // (matched on effective values) are kept.
  const displayRows: RosterPersonRow[] = useMemo(() => {
    const all = rosterQuery.data?.rows ?? [];
    const lower = (vals: string[]) =>
      vals.length ? new Set(vals.map((v) => v.toLowerCase())) : null;
    const slmSet = lower(filters.slm);
    const flmSet = lower(filters.flm);
    const repSet = lower(filters.rep);
    const regionSet = lower(filters.region);
    const segmentSet = lower(filters.segment);
    const q = search.trim().toLowerCase();

    return all.filter((r) => {
      if (!showInactive && !r.effective.active) return false;
      const person = r.person.toLowerCase();
      const effSlm = (r.effective.slm ?? "").toLowerCase();
      const effFlm = (r.effective.flm ?? "").toLowerCase();
      const effRegion = (r.effective.region ?? "").toLowerCase();
      const effSegment = (r.effective.segment ?? "").toLowerCase();
      if (slmSet && !slmSet.has(effSlm) && !slmSet.has(person)) return false;
      if (flmSet && !flmSet.has(effFlm) && !flmSet.has(person)) return false;
      if (repSet && !repSet.has(person)) return false;
      if (regionSet && !regionSet.has(effRegion)) return false;
      if (segmentSet && !segmentSet.has(effSegment)) return false;
      if (!q) return true;
      return (
        person.includes(q) ||
        effFlm.includes(q) ||
        effSlm.includes(q) ||
        effRegion.includes(q) ||
        effSegment.includes(q)
      );
    });
  }, [
    rosterQuery.data,
    search,
    showInactive,
    filters.slm,
    filters.flm,
    filters.rep,
    filters.region,
    filters.segment,
  ]);

  const overrideMutation = useMutation({
    mutationFn: (vars: { row: RosterPersonRow; patch: RosterEditPatch }) =>
      upsertRosterOverride({
        month,
        person: vars.row.person,
        ...vars.patch,
      }),
    onMutate: async ({ row, patch }) => {
      await queryClient.cancelQueries({ queryKey: rosterKey });
      const prev = queryClient.getQueryData<GetRoster200>(rosterKey);
      if (prev) {
        const next: GetRoster200 = {
          ...prev,
          rows: prev.rows.map((r) => {
            if (r.person !== row.person) return r;
            const override = { ...r.override, ...patch };
            const effective = {
              active: override.active ?? r.base.active,
              flm: override.flm ?? r.base.flm,
              slm: override.slm ?? r.base.slm,
              region: override.region ?? r.base.region,
              segment: override.segment ?? r.base.segment,
              salesRole: override.salesRole ?? r.base.salesRole,
            };
            return { ...r, override, effective };
          }),
        };
        queryClient.setQueryData(rosterKey, next);
      }
      setSaveState("saving");
      setSaveError(null);
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(rosterKey, ctx.prev);
      setSaveState("error");
      setSaveError(err instanceof Error ? err.message : "Save failed");
    },
    onSuccess: (data) => {
      // Server returns the refreshed roster (its reassembly may differ from the
      // optimistic patch — e.g. effective SLM derived from a new FLM).
      queryClient.setQueryData(rosterKey, data);
      setSaveState("saved");
    },
  });

  const onEditRow = (row: RosterPersonRow, patch: RosterEditPatch) => {
    if (!canEdit) return;
    overrideMutation.mutate({ row, patch });
  };

  const total = rosterQuery.data?.rows.length ?? 0;
  const inactiveCount =
    rosterQuery.data?.rows.filter((r) => !r.effective.active).length ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-foreground">
            Roster — {monthLabel(month)}
          </span>
          {rosterQuery.isFetching && (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
          )}
          {saveState === "saving" && (
            <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Saving…
            </span>
          )}
          {saveState === "saved" && (
            <span className="text-[11px] text-green-600 inline-flex items-center gap-1">
              <Check className="w-3 h-3" /> Saved
            </span>
          )}
          {saveState === "error" && (
            <span className="text-[11px] text-red-600 inline-flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> {saveError}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="accent-[#006AFF]"
            />
            Show inactive ({inactiveCount})
          </label>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search people…"
            className="h-8 w-48 rounded border border-input bg-background px-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-[#006AFF]"
          />
        </div>
      </div>

      <div className="text-[11px] text-muted-foreground">
        Overrides apply only to {monthLabel(month)} and are never carried forward.
        Cleared fields fall back to the base hierarchy ({total} people total).
      </div>

      {rosterQuery.isLoading ? (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading roster…
        </div>
      ) : rosterQuery.isError ? (
        <div className="text-[12px] text-red-600 border border-red-200 rounded-md px-4 py-6 text-center">
          {rosterQuery.error instanceof Error
            ? rosterQuery.error.message
            : "Failed to load the roster."}
        </div>
      ) : (
        <RosterTable rows={displayRows} canEdit={canEdit} onEditRow={onEditRow} />
      )}
    </div>
  );
}
