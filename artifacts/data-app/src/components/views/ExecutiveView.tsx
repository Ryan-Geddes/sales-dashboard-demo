import { useState } from "react";
import type { FilterState } from "../../pages/Dashboard";
import type { AuthUser } from "@workspace/replit-auth-web";
import CompensationView from "./CompensationView";
import GoalsView from "./GoalsView";
import RosterView from "./RosterView";
import ProductLogicView from "./ProductLogicView";

// Task #540: this renders the "Comp" tab (formerly "Executive"). The
// "Executive Overview" placeholder section was removed; Compensation is the
// default sub-view.
const SECTION_OPTIONS = [
  { key: "compensation", label: "Compensation" },
  { key: "productLogic", label: "Product Logic" },
  { key: "goals", label: "Goals" },
  { key: "roster", label: "Roster" },
] as const;

type SectionKey = typeof SECTION_OPTIONS[number]["key"];

interface ExecutiveViewProps {
  filters: FilterState;
  authUser: AuthUser;
}

export default function ExecutiveView({ filters, authUser }: ExecutiveViewProps) {
  const [section, setSection] = useState<SectionKey>("compensation");

  // Task #363: every role can view all four Comp sections (read-only).
  // Write actions inside each section stay gated by their own canEdit/viewOnly
  // logic, and all mutation endpoints still reject non-admin/slm/exec users.
  const visibleSections = SECTION_OPTIONS;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 border-b border-border -mt-2">
        {visibleSections.map(opt => {
          const active = section === opt.key;
          return (
            <button
              key={opt.key}
              onClick={() => setSection(opt.key)}
              className={`relative px-3 py-2 text-[12px] font-medium transition-colors ${active ? "text-[#006AFF]" : "text-muted-foreground hover:text-foreground"}`}
            >
              {opt.label}
              {active && <span className="absolute left-2 right-2 -bottom-px h-0.5 bg-[#006AFF] rounded-t" />}
            </button>
          );
        })}
      </div>

      {section === "compensation" && (
        <CompensationView filters={filters} authUser={authUser} />
      )}

      {section === "productLogic" && (
        <ProductLogicView authUser={authUser} />
      )}

      {section === "goals" && (
        <GoalsView filters={filters} authUser={authUser} />
      )}

      {section === "roster" && (
        <RosterView filters={filters} authUser={authUser} />
      )}
    </div>
  );
}
