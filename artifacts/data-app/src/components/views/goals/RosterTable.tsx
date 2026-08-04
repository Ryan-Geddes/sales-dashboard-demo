import { useEffect, useState } from "react";
import type { RosterPersonRow } from "@workspace/api-client-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// A roster edit patch carries only the field(s) that changed. `null` clears the
// override (the base hierarchy value applies again).
export interface RosterEditPatch {
  active?: boolean | null;
  flm?: string | null;
  slm?: string | null;
  region?: string | null;
  segment?: string | null;
  salesRole?: string | null;
}

type TextField = "flm" | "slm" | "region" | "segment" | "salesRole";

interface RosterTableProps {
  rows: RosterPersonRow[];
  canEdit: boolean;
  onEditRow: (row: RosterPersonRow, patch: RosterEditPatch) => void;
}

export function personKey(r: RosterPersonRow): string {
  return r.person;
}

// Active is tri-state: "default" (no override → base applies), "active",
// "inactive". The select reflects the override; effective active shows the
// resolved value as a hint.
function ActiveCell({
  row,
  canEdit,
  onChange,
}: {
  row: RosterPersonRow;
  canEdit: boolean;
  onChange: (next: boolean | null) => void;
}) {
  const overridden = row.override.active !== null;
  const value: "default" | "active" | "inactive" =
    row.override.active === null
      ? "default"
      : row.override.active
        ? "active"
        : "inactive";

  if (!canEdit) {
    return (
      <span
        className={`whitespace-nowrap ${row.effective.active ? "text-foreground" : "text-red-600"}`}
      >
        {row.effective.active ? "Active" : "Inactive"}
        {overridden && <span className="text-amber-600"> *</span>}
      </span>
    );
  }

  return (
    <select
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "default" ? null : v === "active");
      }}
      className={`h-7 rounded border bg-background px-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[#006AFF] ${overridden ? "border-amber-400" : "border-input"}`}
    >
      <option value="default">
        Default ({row.base.active ? "Active" : "Inactive"})
      </option>
      <option value="active">Active</option>
      <option value="inactive">Inactive</option>
    </select>
  );
}

// Text override cell: shows the override value if set; otherwise the base value
// appears as a greyed placeholder. Committing an empty string clears the
// override; a non-empty string sets it.
function TextOverrideCell({
  row,
  field,
  canEdit,
  onCommit,
}: {
  row: RosterPersonRow;
  field: TextField;
  canEdit: boolean;
  onCommit: (next: string | null) => void;
}) {
  const overrideVal = row.override[field];
  const baseVal = row.base[field];
  const [text, setText] = useState(overrideVal ?? "");

  useEffect(() => {
    setText(overrideVal ?? "");
  }, [overrideVal]);

  if (!canEdit) {
    const eff = row.effective[field];
    return (
      <span className="whitespace-nowrap">
        {eff || "—"}
        {overrideVal !== null && <span className="text-amber-600"> *</span>}
      </span>
    );
  }

  const commit = () => {
    const trimmed = text.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next !== overrideVal) onCommit(next);
  };

  return (
    <input
      type="text"
      value={text}
      placeholder={baseVal ?? "—"}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(overrideVal ?? "");
      }}
      className={`w-32 h-7 rounded border bg-background px-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[#006AFF] ${overrideVal !== null ? "border-amber-400" : "border-input"}`}
    />
  );
}

const HEAD_CLASS =
  "whitespace-nowrap text-[11px] font-semibold text-muted-foreground px-2 h-9";
const CELL = "whitespace-nowrap text-[12px] px-2 py-1.5";

const ROLE_LABEL: Record<string, string> = {
  slm: "SLM",
  flm: "FLM",
  rep: "Rep",
};

export default function RosterTable({ rows, canEdit, onEditRow }: RosterTableProps) {
  if (rows.length === 0) {
    return (
      <div className="text-[12px] text-muted-foreground border border-border rounded-md px-4 py-8 text-center">
        No people found for the selected month.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border border-border rounded-md">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead className={HEAD_CLASS}>Person</TableHead>
            <TableHead className={HEAD_CLASS}>Role</TableHead>
            <TableHead className={HEAD_CLASS}>Active</TableHead>
            <TableHead className={HEAD_CLASS}>FLM / Manager</TableHead>
            <TableHead className={HEAD_CLASS}>SLM</TableHead>
            <TableHead className={HEAD_CLASS}>Region</TableHead>
            <TableHead className={HEAD_CLASS}>Segment</TableHead>
            <TableHead className={HEAD_CLASS}>Sales Role</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow
              key={personKey(r)}
              className={`hover:bg-muted/30 ${r.effective.active ? "" : "opacity-60"}`}
            >
              <TableCell className={`${CELL} font-medium`}>{r.person}</TableCell>
              <TableCell className={CELL}>{ROLE_LABEL[r.role] ?? r.role}</TableCell>
              <TableCell className={CELL}>
                <ActiveCell
                  row={r}
                  canEdit={canEdit}
                  onChange={(active) => onEditRow(r, { active })}
                />
              </TableCell>
              <TableCell className={CELL}>
                <TextOverrideCell
                  row={r}
                  field="flm"
                  canEdit={canEdit}
                  onCommit={(flm) => onEditRow(r, { flm })}
                />
              </TableCell>
              <TableCell className={CELL}>
                <TextOverrideCell
                  row={r}
                  field="slm"
                  canEdit={canEdit}
                  onCommit={(slm) => onEditRow(r, { slm })}
                />
              </TableCell>
              <TableCell className={CELL}>
                <TextOverrideCell
                  row={r}
                  field="region"
                  canEdit={canEdit}
                  onCommit={(region) => onEditRow(r, { region })}
                />
              </TableCell>
              <TableCell className={CELL}>
                <TextOverrideCell
                  row={r}
                  field="segment"
                  canEdit={canEdit}
                  onCommit={(segment) => onEditRow(r, { segment })}
                />
              </TableCell>
              <TableCell className={CELL}>
                <TextOverrideCell
                  row={r}
                  field="salesRole"
                  canEdit={canEdit}
                  onCommit={(salesRole) => onEditRow(r, { salesRole })}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
