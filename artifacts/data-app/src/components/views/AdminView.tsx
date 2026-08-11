import { useState } from "react";
import type { AuthUser } from "@workspace/replit-auth-web";
import AnaplanTransactionsTool from "./AnaplanTransactionsTool";

// Task #493: Admin-only top-level view. Uses the same horizontal sub-tab bar
// pattern/styling as ExecutiveView (options list + blue active underline). Seeded
// with a single sub-tab: Anaplan Transactions Tool.
const SECTION_OPTIONS = [
  { key: "anaplanTransactions", label: "Anaplan Transactions Tool" },
] as const;

type SectionKey = typeof SECTION_OPTIONS[number]["key"];

interface AdminViewProps {
  authUser: AuthUser;
}

export default function AdminView(_props: AdminViewProps) {
  const [section, setSection] = useState<SectionKey>("anaplanTransactions");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 border-b border-border -mt-2">
        {SECTION_OPTIONS.map(opt => {
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

      {section === "anaplanTransactions" && <AnaplanTransactionsTool />}
    </div>
  );
}
