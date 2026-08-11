import { useState, useCallback } from "react";
import { FileSpreadsheet, Check, AlertCircle, Loader2, X } from "lucide-react";

interface SheetUrlInputProps {
  onDataLoaded: (csv: string, url: string) => void;
}

const API_BASE = import.meta.env.BASE_URL || "/";

export default function SheetUrlInput({ onDataLoaded }: SheetUrlInputProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const handleFetch = useCallback(async () => {
    if (!url.trim()) return;
    setStatus("loading");
    setErrorMsg("");

    try {
      const apiUrl = `${API_BASE}api/sheets/fetch?url=${encodeURIComponent(url.trim())}`;
      const resp = await fetch(apiUrl);

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: "Failed to fetch sheet" }));
        throw new Error(body.error || `HTTP ${resp.status}`);
      }

      const csv = await resp.text();
      if (!csv || csv.length < 10) {
        throw new Error("Sheet returned empty data");
      }

      setStatus("success");
      onDataLoaded(csv, url.trim());
      setTimeout(() => setStatus("idle"), 3000);
    } catch (e: any) {
      setStatus("error");
      setErrorMsg(e.message || "Failed to fetch sheet");
    }
  }, [url, onDataLoaded]);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-1.5 hover:bg-white/10 rounded transition-colors"
        aria-label="Connect Google Sheet"
        title="Connect Google Sheet"
      >
        <FileSpreadsheet className="w-4 h-4" />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-[420px] bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50 p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Connect Google Sheet
              </h3>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
              >
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Paste a Google Sheets URL to fetch data. Works with sheets shared with your account or public sheets.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setStatus("idle"); }}
                placeholder="https://docs.google.com/spreadsheets/d/..."
                className="flex-1 h-8 px-3 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-[#006AFF]"
                onKeyDown={(e) => e.key === "Enter" && handleFetch()}
              />
              <button
                onClick={handleFetch}
                disabled={status === "loading" || !url.trim()}
                className="h-8 px-3 text-xs font-medium bg-[#006AFF] text-white rounded hover:bg-[#0055cc] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {status === "loading" ? (
                  <><Loader2 className="w-3 h-3 animate-spin" /> Fetching...</>
                ) : (
                  "Fetch"
                )}
              </button>
            </div>
            {status === "success" && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-[#00C49F]">
                <Check className="w-3 h-3" />
                Sheet data loaded successfully
              </div>
            )}
            {status === "error" && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-[#EF4444]">
                <AlertCircle className="w-3 h-3" />
                {errorMsg}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
