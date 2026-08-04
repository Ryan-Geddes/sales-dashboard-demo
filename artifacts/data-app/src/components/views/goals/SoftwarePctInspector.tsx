import type {
  GoalsConfigEnvelope,
  SoftwarePctRules,
  SoftwarePctRulesSubSource,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionEditorDialog } from "./ui";
import { displayProduct } from "@/lib/product-labels";
import {
  saveSoftwareGnrRules,
  saveSoftwareAcqRules,
  SOURCE_LABELS,
  METRIC_LABELS,
  GOAL_METRIC_KEYS,
} from "./goalsApi";

export type SoftwarePctVariant = "gnr" | "acq";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: GoalsConfigEnvelope;
  canEdit: boolean;
  onConfigSaved: () => void;
  /** Which independent rule set this inspector edits. */
  variant: SoftwarePctVariant;
}

const VARIANT_META: Record<
  SoftwarePctVariant,
  {
    title: string;
    configField: "softwareGnrRules" | "softwareAcqRules";
    save: (v: SoftwarePctRules) => Promise<{ value: SoftwarePctRules }>;
  }
> = {
  gnr: {
    title: "Software % GNR",
    configField: "softwareGnrRules",
    save: saveSoftwareGnrRules,
  },
  acq: {
    title: "Software % ACQ",
    configField: "softwareAcqRules",
    save: saveSoftwareAcqRules,
  },
};

const SOFTWARE_PRODUCTS = ["Showcase", "Zillow Pro", "Follow Up Boss", "ZMX"] as const;
type SoftwareProductKey = (typeof SOFTWARE_PRODUCTS)[number];

function pctSum(p: SoftwarePctRules["percentages"]): number {
  return SOFTWARE_PRODUCTS.reduce((acc, k) => acc + (Number(p[k]) || 0), 0);
}

export default function SoftwarePctInspector({
  open,
  onOpenChange,
  config,
  canEdit,
  onConfigSaved,
  variant,
}: Props) {
  const meta = VARIANT_META[variant];
  return (
    <SectionEditorDialog
      open={open}
      onOpenChange={onOpenChange}
      title={meta.title}
      description="Splits a software MRR pool across software products by percentage, sourced from the chosen sub-source columns."
      canEdit={canEdit}
      initial={config.config[meta.configField]}
      onSave={async (v) => {
        await meta.save(v);
        onConfigSaved();
      }}
      validate={(v) => {
        const sum = pctSum(v.percentages);
        return sum === 100 ? null : `Percentages must sum to 100 (currently ${sum}).`;
      }}
    >
      {({ draft, setDraft }) => {
        const sub = draft.subSource;
        const colMap = draft.columnMapping[sub];
        const sum = pctSum(draft.percentages);
        return (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label className="text-[12px]">Sub-source</Label>
              <select
                className="h-8 rounded border border-input bg-background px-2 text-[12px] w-48 focus:outline-none focus:ring-1 focus:ring-[#006AFF] disabled:opacity-60"
                value={sub}
                disabled={!canEdit}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    subSource: e.target.value as SoftwarePctRulesSubSource,
                  })
                }
              >
                <option value="financePps">{SOURCE_LABELS.financePps}</option>
                <option value="goalCsv">{SOURCE_LABELS.goalCsv}</option>
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-[12px]">
                Column mapping ({SOURCE_LABELS[sub]})
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {GOAL_METRIC_KEYS.map((metric) => (
                  <div key={metric} className="flex flex-col gap-1">
                    <span className="text-[11px] text-muted-foreground">
                      {METRIC_LABELS[metric]}
                    </span>
                    <Input
                      className="h-8 text-[12px]"
                      placeholder="Source column"
                      value={colMap[metric]}
                      disabled={!canEdit}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          columnMapping: {
                            ...draft.columnMapping,
                            [sub]: { ...colMap, [metric]: e.target.value },
                          },
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-[12px]">Product percentages</Label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {SOFTWARE_PRODUCTS.map((product) => (
                  <div key={product} className="flex flex-col gap-1">
                    <span className="text-[11px] text-muted-foreground">{displayProduct(product)}</span>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        className="h-8 text-[12px] tabular-nums"
                        value={draft.percentages[product as SoftwareProductKey]}
                        disabled={!canEdit}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            percentages: {
                              ...draft.percentages,
                              [product]: Math.round(Number(e.target.value) || 0),
                            },
                          })
                        }
                      />
                      <span className="text-[12px] text-muted-foreground">%</span>
                    </div>
                  </div>
                ))}
              </div>
              <div
                className={`text-[11px] mt-1 ${sum === 100 ? "text-green-600" : "text-amber-700"}`}
              >
                Total: {sum}% {sum === 100 ? "✓" : "(must equal 100%)"}
              </div>
            </div>
          </div>
        );
      }}
    </SectionEditorDialog>
  );
}
