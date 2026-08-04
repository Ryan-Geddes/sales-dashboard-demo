import React from "react";
import { ExternalLink } from "lucide-react";

export function SfReportLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[10px] text-[#64748b] hover:text-[#006AFF] transition-colors print:hidden"
      title="View Salesforce Report"
    >
      <ExternalLink className="w-3 h-3" />
      <span>SF Report</span>
    </a>
  );
}
