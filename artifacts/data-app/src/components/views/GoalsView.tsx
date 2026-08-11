import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Search,
  Replace,
  Upload,
  ChevronDown,
  AlertCircle,
  Check,
} from "lucide-react";
import type { FilterState } from "../../pages/Dashboard";
import type { AuthUser } from "@workspace/replit-auth-web";
import type {
  GoalTableRow,
  GetGoalTable200,
  GoalsConfigEnvelope,
  GoalSourceId,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import GoalsTable, { type RowEditPatch } from "./goals/GoalsTable";
import GoalCsvInspector from "./goals/GoalCsvInspector";
import FinancePpsInspector from "./goals/FinancePpsInspector";
import SoftwarePctInspector from "./goals/SoftwarePctInspector";
import RepHierarchyInspector from "./goals/RepHierarchyInspector";
import UploadGoalsDialog from "./goals/UploadGoalsDialog";
import {
  deriveMonth,
  monthLabel,
  fetchGoalTable,
  fetchGoalsConfig,
  upsertGoalRowOverride,
  bulkSetGoalRowSource,
  computeFinalGoals,
  SOURCE_LABELS,
  GOAL_SOURCE_IDS,
  type GoalTableQuery,
} from "./goals/goalsApi";

interface GoalsViewProps {
  filters: FilterState;
  authUser: AuthUser;
}

type InspectorKey =
  | "goalCsv"
  | "financePps"
  | "softwareGnr"
  | "softwareAcq"
  | "repHierarchy"
  | null;

function lowerSet(values: string[]): Set<string> {
  return new Set(values.map((v) => v.toLowerCase()));
}

export default function GoalsView({ filters, authUser }: GoalsViewProps) {
  const queryClient = useQueryClient();
  const role = authUser?.role ?? null;
  const viewOnly = authUser?.viewOnly === true;
  const canEdit = !viewOnly && (role === "admin" || role === "slm" || role === "exec");

  const month = useMemo(
    () => deriveMonth(filters.timeframe, filters.customRange),
    [filters.timeframe, filters.customRange],
  );

  const query: GoalTableQuery = useMemo(
    () => ({
      month,
      slm: filters.slm,
      flm: filters.flm,
      reps: filters.rep,
      regions: filters.region,
    }),
    [month, filters.slm, filters.flm, filters.rep, filters.region],
  );

  const tableKey = ["goals-table", query] as const;

  const tableQuery = useQuery<GetGoalTable200>({
    queryKey: tableKey,
    queryFn: () => fetchGoalTable(query),
  });

  const configQuery = useQuery<GoalsConfigEnvelope>({
    queryKey: ["goals-config"],
    queryFn: fetchGoalsConfig,
  });

  const [inspector, setInspector] = useState<InspectorKey>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);

  // Client-side slm/flm narrowing to honor dashboard multi-select (the API only
  // accepts a single slm/flm).
  const displayRows: GoalTableRow[] = useMemo(() => {
    const all = tableQuery.data?.rows ?? [];
    const slmSet = filters.slm.length ? lowerSet(filters.slm) : null;
    const flmSet = filters.flm.length ? lowerSet(filters.flm) : null;
    const productSet = filters.products.length ? lowerSet(filters.products) : null;
    const segmentSet = filters.segment.length ? lowerSet(filters.segment) : null;
    if (!slmSet && !flmSet && !productSet && !segmentSet) return all;
    return all.filter(
      (r) =>
        (!slmSet || slmSet.has((r.slm ?? "").toLowerCase())) &&
        (!flmSet || flmSet.has((r.flm ?? "").toLowerCase())) &&
        (!productSet || productSet.has((r.product ?? "").toLowerCase())) &&
        (!segmentSet || segmentSet.has((r.segment ?? "").toLowerCase())),
    );
  }, [tableQuery.data, filters.slm, filters.flm, filters.products, filters.segment]);

  const overrideMutation = useMutation({
    mutationFn: (vars: { row: GoalTableRow; patch: RowEditPatch }) =>
      upsertGoalRowOverride({
        month: vars.row.month,
        rep: vars.row.rep,
        product: vars.row.product,
        ...vars.patch,
      }),
    onMutate: async ({ row, patch }) => {
      await queryClient.cancelQueries({ queryKey: tableKey });
      const prev = queryClient.getQueryData<GetGoalTable200>(tableKey);
      if (prev) {
        const next: GetGoalTable200 = {
          ...prev,
          rows: prev.rows.map((r) => {
            if (r.month !== row.month || r.rep !== row.rep || r.product !== row.product) {
              return r;
            }
            // The eRep patch carries the MANUAL override (number | null); keep it
            // out of the spread so it never poisons the row's effective
            // eRepMultiplier type, then recompute the effective value
            // (manual ?? Databricks ?? 1.0) so the cell + Final columns stay
            // consistent optimistically.
            const { eRepMultiplier: _patchERep, ...restPatch } = patch;
            const manual = "eRepMultiplier" in patch ? (patch.eRepMultiplier ?? null) : r.eRepManualMultiplier;
            const effectiveERep = manual ?? r.eRepDatabricksMultiplier ?? 1;
            const merged: GoalTableRow = {
              ...r,
              ...restPatch,
              eRepManualMultiplier: manual,
              eRepMultiplier: effectiveERep,
            };
            const finals = computeFinalGoals(merged, {
              mrrAddedManualMultiplier: merged.mrrAddedManualMultiplier,
              mrrChurnManualMultiplier: merged.mrrChurnManualMultiplier,
              eRepMultiplier: effectiveERep,
            });
            return { ...merged, ...finals };
          }),
        };
        queryClient.setQueryData(tableKey, next);
      }
      setSaveState("saving");
      setSaveError(null);
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(tableKey, ctx.prev);
      setSaveState("error");
      setSaveError(err instanceof Error ? err.message : "Save failed");
    },
    onSuccess: () => {
      setSaveState("saved");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tableKey });
    },
  });

  const onEditRow = (row: GoalTableRow, patch: RowEditPatch) => {
    if (!canEdit) return;
    overrideMutation.mutate({ row, patch });
  };

  const runBulkSource = async (source: GoalSourceId) => {
    setBulkBusy(true);
    setBulkMsg(null);
    try {
      // When SLM/FLM is multi-select — or a Segment filter is active (the server
      // has no segment param) — the table is narrowed client-side. Scope the bulk
      // update to exactly the displayed reps so we never mutate hidden rows.
      const needsRepScope =
        filters.slm.length > 1 || filters.flm.length > 1 || filters.segment.length > 0;
      // Always forward the product filter so the server scopes the write to the
      // selected products — otherwise bulk-source overwrites every product.
      const scopedQuery: GoalTableQuery = needsRepScope
        ? {
            ...query,
            slm: [],
            flm: [],
            reps: Array.from(new Set(displayRows.map((r) => r.rep))).filter(Boolean),
            products: filters.products,
          }
        : { ...query, products: filters.products };
      const res = await bulkSetGoalRowSource(scopedQuery, source);
      setBulkMsg(`Set ${res.updated} row${res.updated === 1 ? "" : "s"} to ${SOURCE_LABELS[source]}.`);
      await queryClient.invalidateQueries({ queryKey: tableKey });
    } catch (e) {
      setBulkMsg(e instanceof Error ? e.message : "Bulk update failed");
    } finally {
      setBulkBusy(false);
    }
  };

  const config = configQuery.data;

  return (
    <div className="flex flex-col gap-3">
      {/* Header controls */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-foreground">
            Goals — {monthLabel(month)}
          </span>
          {tableQuery.isFetching && (
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

        <div className="flex items-center gap-2">
          {/* Inspect Source */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 text-[12px]" disabled={!config}>
                <Search className="w-3.5 h-3.5 mr-1" /> Inspect Source
                <ChevronDown className="w-3.5 h-3.5 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-[11px]">Inspect source</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => setInspector("goalCsv")}>
                {SOURCE_LABELS.goalCsv}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setInspector("financePps")}>
                {SOURCE_LABELS.financePps}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setInspector("softwareGnr")}>
                {SOURCE_LABELS.softwareGnr}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setInspector("softwareAcq")}>
                {SOURCE_LABELS.softwareAcq}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setInspector("repHierarchy")}>
                Rep Hierarchy
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Bulk Change Source */}
          {canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-[12px]"
                  disabled={bulkBusy || displayRows.length === 0}
                >
                  {bulkBusy ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                  ) : (
                    <Replace className="w-3.5 h-3.5 mr-1" />
                  )}
                  Bulk Change Source
                  <ChevronDown className="w-3.5 h-3.5 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="text-[11px]">
                  Set source for all {displayRows.length} filtered rows
                </DropdownMenuLabel>
                {GOAL_SOURCE_IDS.map((s) => (
                  <DropdownMenuItem key={s} onClick={() => runBulkSource(s)}>
                    {SOURCE_LABELS[s]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Upload */}
          {canEdit && (
            <Button
              size="sm"
              className="h-8 text-[12px] bg-[#006AFF] hover:bg-[#005ce6]"
              onClick={() => setUploadOpen(true)}
            >
              <Upload className="w-3.5 h-3.5 mr-1" /> Upload Goals CSV
            </Button>
          )}
        </div>
      </div>

      {bulkMsg && <div className="text-[11px] text-muted-foreground">{bulkMsg}</div>}

      {/* Main table */}
      {tableQuery.isLoading ? (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading goals…
        </div>
      ) : tableQuery.isError ? (
        <div className="text-[12px] text-red-600 border border-red-200 rounded-md px-4 py-6 text-center">
          {tableQuery.error instanceof Error
            ? tableQuery.error.message
            : "Failed to load the Goals table."}
        </div>
      ) : (
        <GoalsTable rows={displayRows} canEdit={canEdit} onEditRow={onEditRow} />
      )}

      {/* Inspectors */}
      {config && (
        <>
          <GoalCsvInspector
            open={inspector === "goalCsv"}
            onOpenChange={(o) => setInspector(o ? "goalCsv" : null)}
            config={config}
            canEdit={canEdit}
            onConfigSaved={() => {
              configQuery.refetch();
              queryClient.invalidateQueries({ queryKey: tableKey });
            }}
          />
          <FinancePpsInspector
            open={inspector === "financePps"}
            onOpenChange={(o) => setInspector(o ? "financePps" : null)}
            config={config}
            canEdit={canEdit}
            onConfigSaved={() => {
              configQuery.refetch();
              queryClient.invalidateQueries({ queryKey: tableKey });
            }}
          />
          <SoftwarePctInspector
            variant="gnr"
            open={inspector === "softwareGnr"}
            onOpenChange={(o) => setInspector(o ? "softwareGnr" : null)}
            config={config}
            canEdit={canEdit}
            onConfigSaved={() => {
              configQuery.refetch();
              queryClient.invalidateQueries({ queryKey: tableKey });
            }}
          />
          <SoftwarePctInspector
            variant="acq"
            open={inspector === "softwareAcq"}
            onOpenChange={(o) => setInspector(o ? "softwareAcq" : null)}
            config={config}
            canEdit={canEdit}
            onConfigSaved={() => {
              configQuery.refetch();
              queryClient.invalidateQueries({ queryKey: tableKey });
            }}
          />
        </>
      )}
      <RepHierarchyInspector
        open={inspector === "repHierarchy"}
        onOpenChange={(o) => setInspector(o ? "repHierarchy" : null)}
        rows={displayRows}
      />
      <UploadGoalsDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUploaded={() => queryClient.invalidateQueries({ queryKey: tableKey })}
      />
    </div>
  );
}
