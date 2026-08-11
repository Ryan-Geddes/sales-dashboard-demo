import { useCallback, useRef, useState } from "react";
import Papa from "papaparse";
import { Card, CardContent } from "@/components/ui/card";
import { Upload, FileText, Download, X, AlertCircle, CheckCircle2 } from "lucide-react";

// Task #493: Anaplan Transactions Tool. Admin-only utility that takes one or more
// raw per-SLM Anaplan CSV exports, reformats each (see transformFile), combines
// them into a single .xlsx workbook with one header row, and offers it as a
// download. This is download-only; writing the Databricks fld_temp_anaplan_data
// table is a separate future task.

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Reformat a "Mon YY" compensation-month value (e.g. "Jun 26") to "YYYY-MM-01"
// (e.g. "2026-06-01"). Year is 20YY, day is always 01. Returns null if the value
// doesn't match the expected shape so the caller can surface an error.
function formatCompensationDate(raw: string): string | null {
  const trimmed = raw.trim();
  const m = /^([A-Za-z]{3})\s+(\d{2})$/.exec(trimmed);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  return `20${m[2]}-${month}-01`;
}

// Normalize boolean text false/true -> FALSE/TRUE to match the expected output.
// All other cell values pass through unchanged.
function normalizeCell(value: string): string {
  if (value === "false") return "FALSE";
  if (value === "true") return "TRUE";
  return value;
}

interface ProcessedFile {
  name: string;
  slm: string;
  headers: string[];
  rows: string[][];
  dataRowCount: number;
}

interface FileError {
  name: string;
  message: string;
}

// Transform a single parsed input file (array-of-arrays) into the combined
// output shape. Throws with a clear message when the structure is unexpected.
function transformFile(name: string, matrix: string[][]): ProcessedFile {
  if (matrix.length < 2) {
    throw new Error("File has fewer than 2 rows (expected a title row + a header row).");
  }

  const titleRow = matrix[0];
  const slm = (titleRow[1] ?? "").trim();
  if (!slm) {
    throw new Error("Could not read the SLM name from cell B1 (row 1, column 2).");
  }

  const inputHeader = matrix[1];
  if (
    (inputHeader[1] ?? "").trim() !== "Owner" ||
    (inputHeader[2] ?? "").trim() !== "Compensation Date" ||
    (inputHeader[3] ?? "").trim() !== "Partner Name"
  ) {
    throw new Error(
      'Header row does not match the expected Anaplan layout (expected columns "Owner", "Compensation Date", "Partner Name").',
    );
  }

  // Build the output header: blank first column becomes cpd_id, insert SLM as the
  // 2nd column, then keep every other input header in its original order.
  const headers = ["cpd_id", "SLM", ...inputHeader.slice(1)];

  // Compensation Date is the 3rd input column (index 2), which lands at output
  // index 3 after cpd_id + SLM are prepended.
  const compDateOutIdx = 3;

  const rows: string[][] = [];
  for (let i = 2; i < matrix.length; i++) {
    const src = matrix[i];
    // Skip fully-empty trailing rows papaparse may emit.
    if (src.length === 0 || (src.length === 1 && (src[0] ?? "").trim() === "")) {
      continue;
    }
    const out = [src[0] ?? "", slm, ...src.slice(1).map(normalizeCell)];

    const rawDate = out[compDateOutIdx] ?? "";
    const formatted = formatCompensationDate(rawDate);
    if (formatted === null) {
      throw new Error(
        `Row ${i + 1}: could not parse Compensation Date "${rawDate}" (expected "Mon YY", e.g. "Jun 26").`,
      );
    }
    out[compDateOutIdx] = formatted;

    rows.push(out);
  }

  return { name, slm, headers, rows, dataRowCount: rows.length };
}

function parseCsv(file: File): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(file, {
      skipEmptyLines: "greedy",
      complete: (result) => resolve(result.data as string[][]),
      error: (err: unknown) =>
        reject(err instanceof Error ? err : new Error(String(err))),
    });
  });
}

export default function AnaplanTransactionsTool() {
  const [processed, setProcessed] = useState<ProcessedFile[]>([]);
  const [errors, setErrors] = useState<FileError[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setBusy(true);

    const files = Array.from(fileList).filter(
      (f) => f.name.toLowerCase().endsWith(".csv") || f.type === "text/csv",
    );
    const skipped = Array.from(fileList).filter((f) => !files.includes(f));

    const nextProcessed: ProcessedFile[] = [];
    const nextErrors: FileError[] = [];

    for (const f of skipped) {
      nextErrors.push({ name: f.name, message: "Not a .csv file — skipped." });
    }

    for (const f of files) {
      try {
        const matrix = await parseCsv(f);
        nextProcessed.push(transformFile(f.name, matrix));
      } catch (err) {
        nextErrors.push({
          name: f.name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    setProcessed((prev) => [...prev, ...nextProcessed]);
    setErrors(nextErrors);
    setBusy(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      void handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const removeFile = useCallback((name: string) => {
    setProcessed((prev) => prev.filter((p) => p.name !== name));
  }, []);

  const clearAll = useCallback(() => {
    setProcessed([]);
    setErrors([]);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const download = useCallback(async () => {
    if (processed.length === 0) return;
    // Keep exactly one header row (all files share identical headers); append the
    // data rows from every processed file.
    const headers = processed[0].headers;
    const allRows: string[][] = [headers];
    for (const p of processed) allRows.push(...p.rows);

    // Emit a real .xlsx (not a CSV). Excel auto-detects a plain CSV's
    // Compensation Date column as a date and rewrites "2026-06-01" to "6/1/26",
    // which the Databricks uploader rejects. Marking every column as Text (`@`)
    // — column D (Compensation Date) in particular — keeps values verbatim
    // through an Excel round-trip.
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Anaplan Transactions");
    for (const row of allRows) ws.addRow(row);
    // Force Text format on all columns so nothing is coerced (dates, booleans,
    // ids). Column D is Compensation Date; the loop covers it plus every other.
    const colCount = headers.length;
    for (let c = 1; c <= colCount; c++) {
      ws.getColumn(c).numFmt = "@";
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "combined_anaplan_transactions.xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [processed]);

  const totalRows = processed.reduce((sum, p) => sum + p.dataRowCount, 0);

  // Count rows whose cpd_id (first output column) appears more than once across
  // the combined data from all processed files. Surfaced as a data-quality
  // warning beneath the "combined data rows ready" line.
  const duplicateCpdIdRows = (() => {
    const counts = new Map<string, number>();
    for (const p of processed) {
      for (const row of p.rows) {
        const cpdId = row[0] ?? "";
        counts.set(cpdId, (counts.get(cpdId) ?? 0) + 1);
      }
    }
    let dupes = 0;
    for (const count of counts.values()) {
      if (count > 1) dupes += count;
    }
    return dupes;
  })();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-[15px] font-semibold text-foreground">Anaplan Transactions Tool</div>
        <div className="text-[12px] text-muted-foreground mt-1 max-w-2xl">
          Upload one or more raw per-SLM Anaplan CSV exports. Each file is reformatted
          (adds <code className="text-[11px]">cpd_id</code> + <code className="text-[11px]">SLM</code> columns,
          converts compensation dates to <code className="text-[11px]">YYYY-MM-01</code>, and uppercases
          booleans), then all files are combined into a single downloadable Excel
          (<code className="text-[11px]">.xlsx</code>) workbook.
        </div>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer border-2 border-dashed rounded-lg p-8 flex flex-col items-center justify-center gap-2 transition-colors ${
          dragging ? "border-[#006AFF] bg-[#006AFF]/5" : "border-border hover:border-[#006AFF]/50"
        }`}
      >
        <Upload className="w-6 h-6 text-muted-foreground" />
        <div className="text-[13px] font-medium text-foreground">
          Drop CSV files here, or click to browse
        </div>
        <div className="text-[11px] text-muted-foreground">
          Multiple files supported — CSV only
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          multiple
          className="hidden"
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {busy && (
        <div className="text-[12px] text-muted-foreground">Processing files…</div>
      )}

      {errors.length > 0 && (
        <div className="flex flex-col gap-2">
          {errors.map((err) => (
            <div
              key={err.name}
              className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 px-3 py-2"
            >
              <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
              <div className="text-[12px]">
                <span className="font-semibold text-red-700 dark:text-red-400">{err.name}</span>
                <span className="text-red-600 dark:text-red-400"> — {err.message}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {processed.length > 0 && (
        <Card className="no-shadow">
          <CardContent className="p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-semibold text-foreground">
                Processed files ({processed.length})
              </div>
              <button
                onClick={clearAll}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Clear all
              </button>
            </div>

            <div className="flex flex-col divide-y divide-border">
              {processed.map((p) => (
                <div key={p.name} className="flex items-center gap-3 py-2">
                  <FileText className="w-4 h-4 text-[#006AFF] shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-foreground truncate">{p.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      SLM: {p.slm} · {p.dataRowCount.toLocaleString()} rows
                    </div>
                  </div>
                  <button
                    onClick={() => removeFile(p.name)}
                    className="text-muted-foreground hover:text-red-600 transition-colors shrink-0"
                    title="Remove file"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between pt-1">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                  {totalRows.toLocaleString()} combined data rows ready
                </div>
                {duplicateCpdIdRows > 0 && (
                  <div className="flex items-center gap-1.5 text-[12px] text-amber-700 dark:text-amber-500">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {duplicateCpdIdRows.toLocaleString()} rows with duplicate cpd_id
                  </div>
                )}
              </div>
              <button
                onClick={() => void download()}
                className="h-[32px] px-4 bg-[#006AFF] text-white rounded-md text-[12px] font-medium hover:bg-[#005ce6] transition-colors flex items-center gap-1.5"
              >
                <Download className="w-4 h-4" />
                Download combined Excel
              </button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
