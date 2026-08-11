// Shared UI bits for the Goals tab editors/inspectors.

import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, Check, Loader2, Lock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { clone } from "./goalsApi";

export type SaveState = "idle" | "saving" | "saved" | "error";

export function SaveStatusPill({
  state,
  error,
  dirty,
}: {
  state: SaveState;
  error: string | null;
  dirty: boolean;
}) {
  if (state === "error") {
    return (
      <span className="text-[11px] text-red-600 inline-flex items-center gap-1">
        <AlertCircle className="w-3.5 h-3.5" /> {error || "Save failed"}
      </span>
    );
  }
  if (state === "saving") {
    return (
      <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…
      </span>
    );
  }
  if (state === "saved" && !dirty) {
    return (
      <span className="text-[11px] text-green-600 inline-flex items-center gap-1">
        <Check className="w-3.5 h-3.5" /> Saved
      </span>
    );
  }
  if (dirty) {
    return <span className="text-[11px] text-amber-700">Unsaved changes</span>;
  }
  return null;
}

export function ReadOnlyNotice({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted-foreground bg-muted/50 border border-border rounded-md px-3 py-2">
      <Lock className="w-3.5 h-3.5" />
      Read-only — you don't have permission to edit {label}.
    </div>
  );
}

/**
 * A modal wrapper for a config editor section that manages the
 * draft/baseline/dirty/save lifecycle around an initial value.
 */
export function SectionEditorDialog<T>({
  open,
  onOpenChange,
  title,
  description,
  canEdit,
  initial,
  onSave,
  isEqual,
  children,
  extraHeader,
  validate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  canEdit: boolean;
  initial: T;
  onSave: (value: T) => Promise<void>;
  isEqual?: (a: T, b: T) => boolean;
  children: (args: { draft: T; setDraft: (next: T) => void }) => ReactNode;
  extraHeader?: ReactNode;
  validate?: (value: T) => string | null;
}) {
  const [draft, setDraftState] = useState<T>(() => clone(initial));
  const [baseline, setBaseline] = useState<T>(() => clone(initial));
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraftState(clone(initial));
      setBaseline(clone(initial));
      setState("idle");
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const eq = isEqual ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b));
  const dirty = !eq(draft, baseline);
  const validationError = validate ? validate(draft) : null;

  const setDraft = (next: T) => {
    setDraftState(next);
    if (state === "saved") setState("idle");
  };

  const save = async () => {
    if (!canEdit || !dirty) return;
    if (validationError) {
      setError(validationError);
      setState("error");
      return;
    }
    setState("saving");
    setError(null);
    try {
      await onSave(draft);
      setBaseline(clone(draft));
      setState("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setState("error");
    }
  };

  const discard = () => {
    setDraftState(clone(baseline));
    setState("idle");
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[15px]">{title}</DialogTitle>
          {description && (
            <DialogDescription className="text-[12px]">{description}</DialogDescription>
          )}
        </DialogHeader>

        {extraHeader}

        {!canEdit && <ReadOnlyNotice label="goals configuration" />}

        <div className="flex flex-col gap-3 py-1">
          {children({ draft, setDraft })}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            {validationError && dirty && (
              <span className="text-[11px] text-amber-700 inline-flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" /> {validationError}
              </span>
            )}
            <SaveStatusPill state={state} error={error} dirty={dirty} />
          </div>
          {canEdit && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[12px]"
                onClick={discard}
                disabled={!dirty || state === "saving"}
              >
                Discard
              </Button>
              <Button
                size="sm"
                className="h-8 text-[12px] bg-[#006AFF] hover:bg-[#005ce6]"
                onClick={save}
                disabled={!dirty || state === "saving" || !!validationError}
              >
                {state === "saving" ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> Saving…
                  </>
                ) : (
                  "Save changes"
                )}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
