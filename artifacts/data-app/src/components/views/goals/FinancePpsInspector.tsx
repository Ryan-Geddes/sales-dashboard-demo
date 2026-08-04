import { useEffect, useState } from "react";
import { Plus, Trash2, Loader2, RefreshCw, AlertCircle, RotateCcw } from "lucide-react";
import type {
  GoalsConfigEnvelope,
  InspectGoalsFinancePps200,
  FinancePpsJoinField,
  FinancePpsOutputMapEntry,
  HierarchyJoinField,
  GoalMetricKey,
  GoalProduct,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionEditorDialog } from "./ui";
import { displayProduct } from "@/lib/product-labels";
import {
  fetchFinancePpsInspect,
  refreshFinancePps,
  saveFinancePpsJoinFields,
  saveFinancePpsOutputMapping,
  saveFinancePpsInspectColumns,
  DEFAULT_FINANCE_PPS_INSPECT_COLUMNS,
  METRIC_LABELS,
} from "./goalsApi";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: GoalsConfigEnvelope;
  canEdit: boolean;
  onConfigSaved: () => void;
}

const HEAD = "whitespace-nowrap text-[11px] font-semibold text-muted-foreground px-2 h-9";
const CELL = "whitespace-nowrap text-[12px] px-2 py-1.5";

// The stored hierarchy join value remains "Group"; we only relabel it to
// "Channel" for display in the editors.
const hierLabel = (h: string) => (h === "Group" ? "Channel" : h);

export default function FinancePpsInspector({
  open,
  onOpenChange,
  config,
  canEdit,
  onConfigSaved,
}: Props) {
  const [data, setData] = useState<InspectGoalsFinancePps200 | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editJoinFields, setEditJoinFields] = useState(false);
  const [editOutputMapping, setEditOutputMapping] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchFinancePpsInspect()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const doRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await refreshFinancePps();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  const persistColumns = async (cols: string[]) => {
    if (!data) return;
    const prev = data;
    setData({ ...data, selectedColumns: cols });
    try {
      await saveFinancePpsInspectColumns(cols);
      onConfigSaved();
    } catch (e) {
      setData(prev);
      setError(e instanceof Error ? e.message : "Failed to save columns");
    }
  };

  const toggleColumn = (col: string) => {
    if (!data) return;
    const set = new Set(data.selectedColumns);
    if (set.has(col)) set.delete(col);
    else set.add(col);
    // Preserve allColumns ordering.
    persistColumns(data.allColumns.filter((c) => set.has(c)));
  };

  const options = config.options;
  const selected = data?.selectedColumns ?? [];

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-6xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[15px]">finance.pps source</DialogTitle>
            <DialogDescription className="text-[12px]">
              Anaplan finance.pps snapshot used to resolve goals.
              {data?.fetchedAt && (
                <> Last fetched {new Date(data.fetchedAt).toLocaleString()}.</>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[12px]"
              onClick={doRefresh}
              disabled={refreshing || !canEdit}
              title={!canEdit ? "Requires edit permission" : "Re-fetch the snapshot"}
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${refreshing ? "animate-spin" : ""}`} />
              Refresh snapshot
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-[12px]"
                  disabled={!data}
                >
                  Columns ({selected.length})
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="max-h-80 overflow-y-auto w-72">
                {canEdit && (
                  <>
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.preventDefault();
                        persistColumns(
                          data
                            ? data.allColumns.filter((c) =>
                                DEFAULT_FINANCE_PPS_INSPECT_COLUMNS.includes(c),
                              )
                            : DEFAULT_FINANCE_PPS_INSPECT_COLUMNS,
                        );
                      }}
                    >
                      <RotateCcw className="w-3.5 h-3.5 mr-2" /> Restore defaults
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {(data?.allColumns ?? []).map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col}
                    checked={selected.includes(col)}
                    disabled={!canEdit}
                    onCheckedChange={() => toggleColumn(col)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {col}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[12px]"
              onClick={() => setEditJoinFields(true)}
            >
              Modify Join Fields
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[12px]"
              onClick={() => setEditOutputMapping(true)}
            >
              Modify Output Mapping
            </Button>
          </div>

          {data?.fetchError && (
            <div className="text-[12px] text-red-600 inline-flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />
              {data.fetchErrorMessage || "The finance.pps snapshot could not be fetched."}
            </div>
          )}
          {error && <div className="text-[12px] text-red-600">{error}</div>}

          {loading ? (
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : !data || data.rows.length === 0 ? (
            <div className="text-[12px] text-muted-foreground border border-border rounded-md px-4 py-8 text-center">
              No finance.pps rows available.
            </div>
          ) : (
            <div className="overflow-x-auto border border-border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    {selected.map((c) => (
                      <TableHead key={c} className={HEAD}>
                        {c}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((row, i) => (
                    <TableRow key={i} className="hover:bg-muted/30">
                      {selected.map((c) => (
                        <TableCell key={c} className={CELL}>
                          {row[c] ?? "—"}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <SectionEditorDialog
        open={editJoinFields}
        onOpenChange={setEditJoinFields}
        title="finance.pps join fields"
        description="Pairs a finance.pps column with the hierarchy field it joins on."
        canEdit={canEdit}
        initial={config.config.financePpsJoinFields}
        onSave={async (v) => {
          await saveFinancePpsJoinFields(v);
          onConfigSaved();
        }}
      >
        {({ draft, setDraft }) => (
          <div className="flex flex-col gap-2">
            {draft.map((entry, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  className="h-8 text-[12px]"
                  placeholder="finance.pps column"
                  value={entry.financePps}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const next = [...draft];
                    next[i] = { ...entry, financePps: e.target.value };
                    setDraft(next);
                  }}
                />
                <span className="text-muted-foreground text-[12px]">↔</span>
                <select
                  className="h-8 rounded border border-input bg-background px-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-[#006AFF] disabled:opacity-60"
                  value={entry.hierarchy}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const next = [...draft];
                    next[i] = { ...entry, hierarchy: e.target.value as HierarchyJoinField };
                    setDraft(next);
                  }}
                >
                  {options.hierarchyJoinFields.map((h) => (
                    <option key={h} value={h}>
                      {hierLabel(h)}
                    </option>
                  ))}
                </select>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-red-600"
                    onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[12px] self-start"
                onClick={() =>
                  setDraft([
                    ...draft,
                    { financePps: "", hierarchy: options.hierarchyJoinFields[0] },
                  ])
                }
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add join field
              </Button>
            )}
          </div>
        )}
      </SectionEditorDialog>

      <SectionEditorDialog
        open={editOutputMapping}
        onOpenChange={setEditOutputMapping}
        title="finance.pps output mapping"
        description="Maps a finance.pps column to a (metric, product) goal target."
        canEdit={canEdit}
        initial={config.config.financePpsOutputMapping}
        onSave={async (v) => {
          await saveFinancePpsOutputMapping(v);
          onConfigSaved();
        }}
      >
        {({ draft, setDraft }) => (
          <div className="flex flex-col gap-2">
            {draft.map((entry, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  className="h-8 text-[12px] flex-1"
                  placeholder="finance.pps column"
                  value={entry.column}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const next = [...draft];
                    next[i] = { ...entry, column: e.target.value };
                    setDraft(next);
                  }}
                />
                <span className="text-muted-foreground text-[12px]">→</span>
                <select
                  className="h-8 rounded border border-input bg-background px-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-[#006AFF] disabled:opacity-60"
                  value={entry.metric}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const next = [...draft];
                    next[i] = { ...entry, metric: e.target.value as GoalMetricKey };
                    setDraft(next);
                  }}
                >
                  {options.metrics.map((m) => (
                    <option key={m} value={m}>
                      {METRIC_LABELS[m] ?? m}
                    </option>
                  ))}
                </select>
                <select
                  className="h-8 rounded border border-input bg-background px-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-[#006AFF] disabled:opacity-60"
                  value={entry.product}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const next = [...draft];
                    next[i] = { ...entry, product: e.target.value as GoalProduct };
                    setDraft(next);
                  }}
                >
                  {options.products.map((p) => (
                    <option key={p} value={p}>
                      {displayProduct(p)}
                    </option>
                  ))}
                </select>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-red-600"
                    onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[12px] self-start"
                onClick={() =>
                  setDraft([
                    ...draft,
                    {
                      column: "",
                      metric: options.metrics[0],
                      product: options.products[0],
                    },
                  ])
                }
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add mapping
              </Button>
            )}
          </div>
        )}
      </SectionEditorDialog>
    </>
  );
}
