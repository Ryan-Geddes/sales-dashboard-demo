import { useMemo } from "react";
import type { GoalTableRow } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: GoalTableRow[];
}

interface HierarchyRow {
  rep: string;
  employeeId: string;
  salesRole: string;
  slm: string;
  flm: string;
  region: string;
  segment: string;
  group: string;
}

const HEAD = "whitespace-nowrap text-[11px] font-semibold text-muted-foreground px-2 h-9";
const CELL = "whitespace-nowrap text-[12px] px-2 py-1.5";

export default function RepHierarchyInspector({ open, onOpenChange, rows }: Props) {
  // The hierarchy rows used for joins are the per-rep attributes carried on the
  // goal table; dedupe by rep to present a read-only hierarchy view.
  const hierarchy = useMemo<HierarchyRow[]>(() => {
    const byRep = new Map<string, HierarchyRow>();
    for (const r of rows) {
      if (!byRep.has(r.rep)) {
        byRep.set(r.rep, {
          rep: r.rep,
          employeeId: r.employeeId,
          salesRole: r.salesRole,
          slm: r.slm,
          flm: r.flm,
          region: r.region,
          segment: r.segment,
          group: r.group,
        });
      }
    }
    return [...byRep.values()].sort((a, b) => a.rep.localeCompare(b.rep));
  }, [rows]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Rep hierarchy</DialogTitle>
          <DialogDescription className="text-[12px]">
            Read-only view of the hierarchy rows used to join goal sources to reps,
            scoped to the current filters.
          </DialogDescription>
        </DialogHeader>

        {hierarchy.length === 0 ? (
          <div className="text-[12px] text-muted-foreground border border-border rounded-md px-4 py-8 text-center">
            No reps for the selected filters.
          </div>
        ) : (
          <div className="overflow-x-auto border border-border rounded-md">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className={HEAD}>Rep</TableHead>
                  <TableHead className={HEAD}>Employee ID</TableHead>
                  <TableHead className={HEAD}>Sales Role</TableHead>
                  <TableHead className={HEAD}>SLM</TableHead>
                  <TableHead className={HEAD}>FLM</TableHead>
                  <TableHead className={HEAD}>Region</TableHead>
                  <TableHead className={HEAD}>Segment</TableHead>
                  <TableHead className={HEAD}>Group</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {hierarchy.map((h) => (
                  <TableRow key={h.rep} className="hover:bg-muted/30">
                    <TableCell className={`${CELL} font-medium`}>{h.rep}</TableCell>
                    <TableCell className={CELL}>{h.employeeId || "—"}</TableCell>
                    <TableCell className={CELL}>{h.salesRole || "—"}</TableCell>
                    <TableCell className={CELL}>{h.slm || "—"}</TableCell>
                    <TableCell className={CELL}>{h.flm || "—"}</TableCell>
                    <TableCell className={CELL}>{h.region || "—"}</TableCell>
                    <TableCell className={CELL}>{h.segment || "—"}</TableCell>
                    <TableCell className={CELL}>{h.group || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
