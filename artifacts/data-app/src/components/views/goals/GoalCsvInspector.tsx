import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import type {
  GoalsConfigEnvelope,
  InspectGoalsGoalCsv200,
  GoalCsvJoinField,
  FinancePpsOutputMapEntry,
  GoalCsvProductValueEntry,
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
  fetchGoalCsvInspect,
  saveRoleGroupMapping,
  saveGoalCsvJoinFields,
  saveGoalCsvOutputMapping,
  saveGoalCsvInspectColumns,
  saveGoalCsvProductMapping,
  DEFAULT_GOAL_CSV_INSPECT_COLUMNS,
  CANONICAL_GOAL_CSV_HEADERS,
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

// The output mapping is edited as a fixed product × metric matrix. Each cell
// holds the chosen uploaded CSV column header, or "" when unset.
type GoalColumnMatrix = Record<string, Record<string, string>>;

function buildGoalColumnMatrix(
  mapping: FinancePpsOutputMapEntry[],
  products: readonly string[],
  metrics: readonly string[],
  uploadedColumns: readonly string[],
): GoalColumnMatrix {
  const matrix: GoalColumnMatrix = {};
  for (const p of products) {
    matrix[p] = {};
    for (const m of metrics) matrix[p][m] = "";
  }
  // Saved mapping wins over any prefill.
  for (const e of mapping) {
    if (matrix[e.product] && e.metric in matrix[e.product]) {
      matrix[e.product][e.metric] = e.column;
    }
  }
  // Prefill still-unset cells from canonical headers that the upload contains.
  const uploaded = new Set(uploadedColumns);
  for (const c of CANONICAL_GOAL_CSV_HEADERS) {
    const row = matrix[c.product];
    if (row && c.metric in row && row[c.metric] === "" && uploaded.has(c.column)) {
      row[c.metric] = c.column;
    }
  }
  return matrix;
}

function goalColumnMatrixToMapping(
  matrix: GoalColumnMatrix,
  products: readonly string[],
  metrics: readonly string[],
): FinancePpsOutputMapEntry[] {
  const out: FinancePpsOutputMapEntry[] = [];
  for (const p of products) {
    for (const m of metrics) {
      const col = matrix[p]?.[m] ?? "";
      if (col) {
        out.push({ column: col, metric: m as GoalMetricKey, product: p as GoalProduct });
      }
    }
  }
  return out;
}

// The "Modify Goal Columns" dialog edits three things together: the metric
// matrix, the single CSV column that distinguishes products, and the value in
// that column that maps to each dashboard product.
interface GoalColumnsDraft {
  matrix: GoalColumnMatrix;
  productColumn: string;
  productValues: Record<string, string>;
}

export default function GoalCsvInspector({
  open,
  onOpenChange,
  config,
  canEdit,
  onConfigSaved,
}: Props) {
  const [data, setData] = useState<InspectGoalsGoalCsv200 | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editRoleGroups, setEditRoleGroups] = useState(false);
  const [editJoinFields, setEditJoinFields] = useState(false);
  const [editOutputMapping, setEditOutputMapping] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchGoalCsvInspect()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const persistColumns = async (cols: string[]) => {
    if (!data) return;
    const prev = data;
    setData({ ...data, selectedColumns: cols });
    try {
      await saveGoalCsvInspectColumns(cols);
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

  // Fixed product × metric matrix seeded from the saved mapping and prefilled
  // from canonical headers present in the current upload.
  const outputMatrixInitial = useMemo(
    () =>
      buildGoalColumnMatrix(
        config.config.goalCsvOutputMapping,
        options.products,
        options.metrics,
        data?.allColumns ?? [],
      ),
    [config.config.goalCsvOutputMapping, options.products, options.metrics, data?.allColumns],
  );

  // Combined initial draft for the "Modify Goal Columns" dialog: the metric
  // matrix plus the Product column + its per-product values.
  const goalColumnsInitial = useMemo<GoalColumnsDraft>(
    () => ({
      matrix: outputMatrixInitial,
      productColumn: config.config.goalCsvProductColumn ?? "",
      productValues: Object.fromEntries(
        options.products.map((p) => [
          p,
          config.config.goalCsvProductValueMapping.find((e) => e.product === p)?.value ?? "",
        ]),
      ),
    }),
    [
      outputMatrixInitial,
      config.config.goalCsvProductColumn,
      config.config.goalCsvProductValueMapping,
      options.products,
    ],
  );

  // Distinct non-empty values present in a column across the uploaded rows.
  const distinctColumnValues = (column: string): string[] => {
    if (!column) return [];
    const set = new Set<string>();
    for (const row of data?.rows ?? []) {
      const v = String(row[column] ?? "").trim();
      if (v) set.add(v);
    }
    return [...set].sort();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-6xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[15px]">Goal CSV source</DialogTitle>
            <DialogDescription className="text-[12px]">
              Uploaded Goal CSV rows used to resolve goals.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[12px]"
              onClick={load}
              disabled={loading}
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
              Reload
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
                                DEFAULT_GOAL_CSV_INSPECT_COLUMNS.includes(c),
                              )
                            : DEFAULT_GOAL_CSV_INSPECT_COLUMNS,
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
              onClick={() => setEditRoleGroups(true)}
            >
              Modify Role-Group Mappings
            </Button>
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
              Modify Goal Columns
            </Button>
          </div>

          {error && <div className="text-[12px] text-red-600">{error}</div>}

          {loading ? (
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : !data || data.rows.length === 0 ? (
            <div className="text-[12px] text-muted-foreground border border-border rounded-md px-4 py-8 text-center">
              No Goal CSV rows available.
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
        open={editRoleGroups}
        onOpenChange={setEditRoleGroups}
        title="Role → Channel mappings"
        description="Maps a hierarchy sales role to the Channel label used by the Goal CSV join."
        canEdit={canEdit}
        initial={config.config.roleGroupMapping}
        onSave={async (v) => {
          await saveRoleGroupMapping(v);
          onConfigSaved();
        }}
      >
        {({ draft, setDraft }) => (
          <div className="flex flex-col gap-2">
            {draft.map((entry, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  className="h-8 text-[12px]"
                  placeholder="Sales role"
                  value={entry.salesRole}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const next = [...draft];
                    next[i] = { ...entry, salesRole: e.target.value };
                    setDraft(next);
                  }}
                />
                <span className="text-muted-foreground text-[12px]">→</span>
                <Input
                  className="h-8 text-[12px]"
                  placeholder="Channel"
                  value={entry.group}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const next = [...draft];
                    next[i] = { ...entry, group: e.target.value };
                    setDraft(next);
                  }}
                />
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
                onClick={() => setDraft([...draft, { salesRole: "", group: "" }])}
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add mapping
              </Button>
            )}
          </div>
        )}
      </SectionEditorDialog>

      <SectionEditorDialog
        open={editJoinFields}
        onOpenChange={setEditJoinFields}
        title="Goal CSV join fields"
        description="Pairs a Goal CSV column with the hierarchy field it joins on."
        canEdit={canEdit}
        initial={config.config.goalCsvJoinFields}
        onSave={async (v) => {
          await saveGoalCsvJoinFields(v);
          onConfigSaved();
        }}
      >
        {({ draft, setDraft }) => (
          <div className="flex flex-col gap-2">
            {draft.map((entry, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  className="h-8 text-[12px]"
                  placeholder="CSV column"
                  value={entry.csv}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const next = [...draft];
                    next[i] = { ...entry, csv: e.target.value };
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
                    { csv: "", hierarchy: options.hierarchyJoinFields[0] },
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
        title="Modify Goal Columns"
        description="Pick the CSV Product column that distinguishes products, then map each dashboard product to its value in that column — each row only feeds the product whose value matches. For each product and goal metric, pick which uploaded Goal CSV column feeds it (or leave unset). Mapped cells replace that product's Software % split; unmapped cells still resolve via the % split. If no Product column is set, the Goal CSV attributes nothing."
        canEdit={canEdit}
        initial={goalColumnsInitial}
        onSave={async (d) => {
          await saveGoalCsvOutputMapping(
            goalColumnMatrixToMapping(d.matrix, options.products, options.metrics),
          );
          const mapping: GoalCsvProductValueEntry[] = options.products
            .map((p) => ({ product: p as GoalProduct, value: (d.productValues[p] ?? "").trim() }))
            .filter((e) => e.value !== "");
          await saveGoalCsvProductMapping(d.productColumn.trim(), mapping);
          onConfigSaved();
        }}
      >
        {({ draft, setDraft }) => {
          const uploaded = data?.allColumns ?? [];
          // Keep a saved Product column visible even if absent from the upload.
          const productColumnOptions =
            draft.productColumn && !uploaded.includes(draft.productColumn)
              ? [draft.productColumn, ...uploaded]
              : uploaded;
          const valueOptions = distinctColumnValues(draft.productColumn);
          return (
            <div className="flex flex-col gap-3">
              <div className="overflow-x-auto border border-border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead className={HEAD}>Product</TableHead>
                      <TableHead className={`${HEAD} align-top`}>
                        <div className="flex flex-col gap-1 py-1">
                          <span>CSV Product Column</span>
                          <select
                            className="h-8 min-w-[10rem] rounded border border-input bg-background px-2 text-[12px] font-normal focus:outline-none focus:ring-1 focus:ring-[#006AFF] disabled:opacity-60"
                            value={draft.productColumn}
                            disabled={!canEdit}
                            onChange={(e) =>
                              setDraft({ ...draft, productColumn: e.target.value })
                            }
                          >
                            <option value="">— None (attribute nothing) —</option>
                            {productColumnOptions.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </div>
                      </TableHead>
                      {options.metrics.map((m) => (
                        <TableHead key={m} className={HEAD}>
                          {METRIC_LABELS[m] ?? m}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {options.products.map((p) => {
                      const rowValue = draft.productValues[p] ?? "";
                      // Keep the saved value visible even if absent from upload.
                      const rowValueOptions =
                        rowValue && !valueOptions.includes(rowValue)
                          ? [rowValue, ...valueOptions]
                          : valueOptions;
                      return (
                        <TableRow key={p} className="hover:bg-muted/30">
                          <TableCell className={`${CELL} font-medium`}>{displayProduct(p)}</TableCell>
                          <TableCell className={CELL}>
                            <select
                              className="h-8 w-full min-w-[10rem] rounded border border-input bg-background px-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-[#006AFF] disabled:opacity-60"
                              value={rowValue}
                              disabled={!canEdit || !draft.productColumn}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  productValues: {
                                    ...draft.productValues,
                                    [p]: e.target.value,
                                  },
                                })
                              }
                            >
                              <option value="">— Unset —</option>
                              {rowValueOptions.map((v) => (
                                <option key={v} value={v}>
                                  {v}
                                </option>
                              ))}
                            </select>
                          </TableCell>
                          {options.metrics.map((m) => {
                            const value = draft.matrix[p]?.[m] ?? "";
                            // Always include the saved value, even if it is not
                            // in the current upload, so it stays visible.
                            const colOptions =
                              value && !uploaded.includes(value)
                                ? [value, ...uploaded]
                                : uploaded;
                            return (
                              <TableCell key={m} className={CELL}>
                                <select
                                  className="h-8 w-full min-w-[10rem] rounded border border-input bg-background px-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-[#006AFF] disabled:opacity-60"
                                  value={value}
                                  disabled={!canEdit}
                                  onChange={(e) => {
                                    setDraft({
                                      ...draft,
                                      matrix: {
                                        ...draft.matrix,
                                        [p]: { ...draft.matrix[p], [m]: e.target.value },
                                      },
                                    });
                                  }}
                                >
                                  <option value="">— Unset —</option>
                                  {colOptions.map((c) => (
                                    <option key={c} value={c}>
                                      {c}
                                    </option>
                                  ))}
                                </select>
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          );
        }}
      </SectionEditorDialog>
    </>
  );
}
