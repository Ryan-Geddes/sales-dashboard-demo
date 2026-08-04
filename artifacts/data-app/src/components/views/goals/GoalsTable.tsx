import { useEffect, useState } from "react";
import type { GoalTableRow, GoalSourceId } from "@workspace/api-client-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GOAL_SOURCE_IDS, SOURCE_LABELS, fmtMoney } from "./goalsApi";
import { displayProduct } from "@/lib/product-labels";

export interface RowEditPatch {
  source?: GoalSourceId;
  mrrAddedManualMultiplier?: number;
  mrrChurnManualMultiplier?: number;
  // Manual eRep override: a number sets it, `null` clears it back to the
  // Databricks-sourced value (Task #467). Omit to leave it unchanged.
  eRepMultiplier?: number | null;
}

interface GoalsTableProps {
  rows: GoalTableRow[];
  canEdit: boolean;
  onEditRow: (row: GoalTableRow, patch: RowEditPatch) => void;
}

export function rowKey(r: { month: string; rep: string; product: string }): string {
  return `${r.month}__${r.rep}__${r.product}`;
}

// Inline editable, non-negative number cell that commits on blur / Enter.
function MultiplierCell({
  value,
  canEdit,
  onCommit,
}: {
  value: number;
  canEdit: boolean;
  onCommit: (next: number) => void;
}) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) {
      setText(String(value));
      return;
    }
    if (n !== value) onCommit(n);
    else setText(String(value));
  };

  if (!canEdit) {
    return <span className="tabular-nums">{value}</span>;
  }

  return (
    <input
      type="number"
      min={0}
      step="0.05"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(String(value));
      }}
      className="w-16 h-7 rounded border border-input bg-background px-1.5 text-[12px] tabular-nums text-right focus:outline-none focus:ring-1 focus:ring-[#006AFF]"
    />
  );
}

// eRep cell: shows the EFFECTIVE multiplier (manual ?? Databricks ?? 1.0),
// editable to set a manual override, with an indicator of whether the value is
// a manual override or Databricks-sourced and a clear (×) to revert to
// Databricks. (Task #467.)
function ERepCell({
  effective,
  manual,
  databricks,
  canEdit,
  onCommit,
  onClear,
}: {
  effective: number;
  manual: number | null;
  databricks: number | null;
  canEdit: boolean;
  onCommit: (next: number) => void;
  onClear: () => void;
}) {
  const [text, setText] = useState(String(effective));

  useEffect(() => {
    setText(String(effective));
  }, [effective]);

  const isManual = manual != null;
  const sourceLabel = isManual
    ? "Manual override"
    : databricks != null
      ? "From Databricks"
      : "Default (no Databricks value)";

  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) {
      setText(String(effective));
      return;
    }
    // Only commit a real change: a no-op blur on a Databricks-sourced row must
    // NOT silently pin a manual override equal to the current effective value.
    if (n !== effective) onCommit(n);
    else setText(String(effective));
  };

  if (!canEdit) {
    return (
      <span className="inline-flex items-center gap-1 tabular-nums" title={sourceLabel}>
        {effective}
        <span className={isManual ? "text-[#006AFF]" : "text-muted-foreground"}>
          {isManual ? "✎" : "⛁"}
        </span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1" title={sourceLabel}>
      <input
        type="number"
        min={0}
        step="0.05"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setText(String(effective));
        }}
        className={`w-16 h-7 rounded border bg-background px-1.5 text-[12px] tabular-nums text-right focus:outline-none focus:ring-1 focus:ring-[#006AFF] ${
          isManual ? "border-[#006AFF]" : "border-input"
        }`}
      />
      <span
        className={isManual ? "text-[#006AFF] text-[11px]" : "text-muted-foreground text-[11px]"}
        title={sourceLabel}
      >
        {isManual ? "✎" : "⛁"}
      </span>
      {isManual && (
        <button
          type="button"
          onClick={onClear}
          title="Clear manual override (use Databricks value)"
          className="text-[11px] leading-none text-muted-foreground hover:text-destructive"
        >
          ×
        </button>
      )}
    </span>
  );
}

function SourceCell({
  value,
  canEdit,
  onChange,
}: {
  value: GoalSourceId;
  canEdit: boolean;
  onChange: (next: GoalSourceId) => void;
}) {
  if (!canEdit) {
    return <span className="whitespace-nowrap">{SOURCE_LABELS[value]}</span>;
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as GoalSourceId)}
      className="h-7 rounded border border-input bg-background px-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[#006AFF]"
    >
      {GOAL_SOURCE_IDS.map((s) => (
        <option key={s} value={s}>
          {SOURCE_LABELS[s]}
        </option>
      ))}
    </select>
  );
}

const HEAD_CLASS =
  "whitespace-nowrap text-[11px] font-semibold text-muted-foreground px-2 h-9";
const NUM_HEAD = `${HEAD_CLASS} text-right`;
const CELL = "whitespace-nowrap text-[12px] px-2 py-1.5";
const NUM_CELL = `${CELL} text-right tabular-nums`;

export default function GoalsTable({ rows, canEdit, onEditRow }: GoalsTableProps) {
  if (rows.length === 0) {
    return (
      <div className="text-[12px] text-muted-foreground border border-border rounded-md px-4 py-8 text-center">
        No goal rows for the selected month and filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border border-border rounded-md">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead className={HEAD_CLASS}>Source</TableHead>
            <TableHead className={NUM_HEAD}>MRR Added Mult.</TableHead>
            <TableHead className={NUM_HEAD}>MRR Churn Mult.</TableHead>
            <TableHead className={HEAD_CLASS}>Month</TableHead>
            <TableHead className={HEAD_CLASS}>Channel</TableHead>
            <TableHead className={HEAD_CLASS}>Rep</TableHead>
            <TableHead className={NUM_HEAD}>Team</TableHead>
            <TableHead className={HEAD_CLASS}>Employee ID</TableHead>
            <TableHead className={HEAD_CLASS}>Sales Role</TableHead>
            <TableHead className={HEAD_CLASS}>SLM</TableHead>
            <TableHead className={HEAD_CLASS}>FLM</TableHead>
            <TableHead className={HEAD_CLASS}>Region</TableHead>
            <TableHead className={HEAD_CLASS}>Product</TableHead>
            <TableHead className={HEAD_CLASS}>Segment</TableHead>
            <TableHead className={HEAD_CLASS}>LOA Status</TableHead>
            <TableHead className={NUM_HEAD}>eRep Mult.</TableHead>
            <TableHead className={NUM_HEAD}>MRR Added Goal</TableHead>
            <TableHead className={NUM_HEAD}>MRR Churn Goal</TableHead>
            <TableHead className={NUM_HEAD}>MRR Added Min</TableHead>
            <TableHead className={NUM_HEAD}>MRR Churn Max</TableHead>
            <TableHead className={NUM_HEAD}>Final MRR Added</TableHead>
            <TableHead className={NUM_HEAD}>Final Churn</TableHead>
            <TableHead className={NUM_HEAD}>Final MRR Min</TableHead>
            <TableHead className={NUM_HEAD}>Final Churn Max</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={rowKey(r)} className="hover:bg-muted/30">
              <TableCell className={CELL}>
                <SourceCell
                  value={r.source}
                  canEdit={canEdit}
                  onChange={(source) => onEditRow(r, { source })}
                />
              </TableCell>
              <TableCell className={NUM_CELL}>
                <MultiplierCell
                  value={r.mrrAddedManualMultiplier}
                  canEdit={canEdit}
                  onCommit={(n) => onEditRow(r, { mrrAddedManualMultiplier: n })}
                />
              </TableCell>
              <TableCell className={NUM_CELL}>
                <MultiplierCell
                  value={r.mrrChurnManualMultiplier}
                  canEdit={canEdit}
                  onCommit={(n) => onEditRow(r, { mrrChurnManualMultiplier: n })}
                />
              </TableCell>
              <TableCell className={CELL}>{r.month}</TableCell>
              <TableCell className={CELL}>{r.group}</TableCell>
              <TableCell className={`${CELL} font-medium`}>{r.rep}</TableCell>
              <TableCell className={NUM_CELL}>{r.teamSize}</TableCell>
              <TableCell className={CELL}>{r.employeeId || "—"}</TableCell>
              <TableCell className={CELL}>{r.salesRole}</TableCell>
              <TableCell className={CELL}>{r.slm || "—"}</TableCell>
              <TableCell className={CELL}>{r.flm || "—"}</TableCell>
              <TableCell className={CELL}>{r.region || "—"}</TableCell>
              <TableCell className={CELL}>{displayProduct(r.product)}</TableCell>
              <TableCell className={CELL}>{r.segment || "—"}</TableCell>
              <TableCell className={CELL}>{r.loaStatus || "—"}</TableCell>
              <TableCell className={NUM_CELL}>
                <ERepCell
                  effective={r.eRepMultiplier}
                  manual={r.eRepManualMultiplier}
                  databricks={r.eRepDatabricksMultiplier}
                  canEdit={canEdit}
                  onCommit={(n) => onEditRow(r, { eRepMultiplier: n })}
                  onClear={() => onEditRow(r, { eRepMultiplier: null })}
                />
              </TableCell>
              <TableCell className={NUM_CELL}>{fmtMoney(r.mrrAddedGoal)}</TableCell>
              <TableCell className={NUM_CELL}>{fmtMoney(r.mrrChurnGoal)}</TableCell>
              <TableCell className={NUM_CELL}>{fmtMoney(r.mrrAddedMinimum)}</TableCell>
              <TableCell className={NUM_CELL}>{fmtMoney(r.mrrChurnMaximum)}</TableCell>
              <TableCell className={`${NUM_CELL} font-semibold`}>
                {fmtMoney(r.finalMrrAddedGoal)}
              </TableCell>
              <TableCell className={`${NUM_CELL} font-semibold`}>
                {fmtMoney(r.finalChurnGoal)}
              </TableCell>
              <TableCell className={`${NUM_CELL} font-semibold`}>
                {fmtMoney(r.finalMrrMinGoal)}
              </TableCell>
              <TableCell className={`${NUM_CELL} font-semibold`}>
                {fmtMoney(r.finalChurnMaxGoal)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
