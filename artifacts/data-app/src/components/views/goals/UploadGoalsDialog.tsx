import { useEffect, useRef, useState } from "react";
import { Loader2, Upload, Check, AlertCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { uploadGoalCsv } from "./goalsApi";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded: () => void;
}

export default function UploadGoalsDialog({ open, onOpenChange, onUploaded }: Props) {
  const [csv, setCsv] = useState("");
  const [state, setState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setCsv("");
      setState("idle");
      setMessage(null);
    }
  }, [open]);

  const onFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const submit = async () => {
    if (!csv.trim()) return;
    setState("uploading");
    setMessage(null);
    try {
      const res = await uploadGoalCsv(csv);
      setState("done");
      setMessage(`Uploaded ${res.inserted} row${res.inserted === 1 ? "" : "s"}.`);
      onUploaded();
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : "Upload failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Upload Goals CSV</DialogTitle>
          <DialogDescription className="text-[12px]">
            Paste the Goal CSV contents or choose a .csv file. Existing rows for the
            same month/group/region/segment are replaced.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[12px]"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="w-3.5 h-3.5 mr-1" /> Choose file…
            </Button>
          </div>

          <Textarea
            className="min-h-48 text-[12px] font-mono"
            placeholder="month,group,region,segment,..."
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
          />

          {message && (
            <div
              className={`text-[12px] inline-flex items-center gap-1 ${
                state === "error" ? "text-red-600" : "text-green-600"
              }`}
            >
              {state === "error" ? (
                <AlertCircle className="w-3.5 h-3.5" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              {message}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          <Button
            size="sm"
            className="h-8 text-[12px] bg-[#006AFF] hover:bg-[#005ce6]"
            onClick={submit}
            disabled={!csv.trim() || state === "uploading"}
          >
            {state === "uploading" ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> Uploading…
              </>
            ) : (
              "Upload"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
