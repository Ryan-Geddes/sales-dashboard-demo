import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Trash2,
  Loader2,
  Check,
  AlertCircle,
  Lock,
  ExternalLink,
  ArrowUp,
  ArrowDown,
  Pencil,
} from "lucide-react";
import type { AuthUser } from "@workspace/replit-auth-web";
import {
  useGetSalesConfig,
  type ProductLogicConfig,
  type ProductLogicRule,
  type ProductLogicExample,
  type CompCondition,
} from "@workspace/api-client-react";
import { sfLightningBase, sfClassicRecordUrl } from "@/lib/sf-links";
import { displayProduct, displayProductText } from "@/lib/product-labels";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// Constants / option lists
// ---------------------------------------------------------------------------

const API_BASE = "/api/sales/product-logic";
const SF_LIGHTNING = sfLightningBase;

type ConditionField = CompCondition["field"];
type ConditionOp = CompCondition["op"];
type MrrField = ProductLogicRule["mrrField"];

const FIELD_OPTIONS: { value: ConditionField; label: string }[] = [
  { value: "type", label: "Type" },
  { value: "rawProduct", label: "Raw Product" },
  { value: "productFamily", label: "Product Family" },
  { value: "product", label: "Product" },
  { value: "quoteType", label: "Quote Type" },
  { value: "termLength", label: "Term Length" },
  { value: "group", label: "Channel" },
  { value: "segment", label: "Segment" },
  { value: "salesRole", label: "Sales Role" },
  { value: "oppName", label: "Opportunity Name" },
  { value: "funnelStage", label: "Funnel Stage" },
];

const OP_OPTIONS: { value: ConditionOp; label: string }[] = [
  { value: "eq", label: "is" },
  { value: "ne", label: "is not" },
  { value: "in", label: "is one of" },
  { value: "notIn", label: "is not one of" },
  { value: "contains", label: "contains" },
  { value: "notContains", label: "does not contain" },
];

// Feeder (Salesforce) MRR columns — shown for feeder-source rules.
const MRR_FIELD_OPTIONS: { value: MrrField; label: string }[] = [
  { value: "changeInMrr", label: "Change in MRR" },
  { value: "totalMrr", label: "Total MRR" },
  { value: "splitTotalPrice", label: "Split Total Price" },
  { value: "totalPrice", label: "Total Price" },
  { value: "amount", label: "Amount" },
  { value: "mrr", label: "MRR" },
];

// CPD-object MRR columns (Databricks frontline_dash_cpds) — shown for
// CPD-source rules instead of the Salesforce feeder fields. Labels are the raw
// column names, matching the Compensation tab.
const CPD_MRR_FIELD_OPTIONS: { value: MrrField; label: string }[] = [
  { value: "mrr_added", label: "mrr_added" },
  { value: "positive_change_in_mrr", label: "positive_change_in_mrr" },
  { value: "negative_change_in_mrr", label: "negative_change_in_mrr" },
];

// Upstream source of each MRR column (mirrors the server's MRR_FIELD_SOURCE).
const MRR_FIELD_SOURCE: Record<MrrField, ProductLogicRule["source"]> = {
  changeInMrr: "feeder",
  totalMrr: "feeder",
  splitTotalPrice: "feeder",
  totalPrice: "feeder",
  amount: "feeder",
  mrr: "feeder",
  mrr_added: "cpd",
  positive_change_in_mrr: "cpd",
  negative_change_in_mrr: "cpd",
};

// The MRR-field picker is source-scoped: a feeder rule may only use feeder
// columns, a CPD rule only CPD columns.
function mrrFieldOptionsForSource(
  source: ProductLogicRule["source"],
): { value: MrrField; label: string }[] {
  return source === "cpd" ? CPD_MRR_FIELD_OPTIONS : MRR_FIELD_OPTIONS;
}

function defaultMrrFieldForSource(source: ProductLogicRule["source"]): MrrField {
  return source === "cpd" ? "mrr_added" : "splitTotalPrice";
}

// ---------------------------------------------------------------------------
// Loose shapes for the opportunities feed reused for the fallthrough table.
// ---------------------------------------------------------------------------

interface FallthroughOpp {
  oppId?: string;
  accountId?: string;
  oppName?: string;
  accountName?: string;
  type?: string;
  product?: string;
  rawProduct?: string;
  productFamily?: string;
  quoteType?: string;
  sfContactId?: string;
  sfCpdId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function genId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

// Same DEV impersonation convention used by the rest of the dashboard's fetches.
function buildHeaders(json: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers["Content-Type"] = "application/json";
  if (import.meta.env.DEV) {
    try {
      const raw = localStorage.getItem("impersonate_user");
      const imp = raw ? JSON.parse(raw) : null;
      if (imp?.id) headers["x-impersonate-user-id"] = String(imp.id);
    } catch {
      /* ignore */
    }
  }
  return headers;
}

// CPD example rows expose their Salesforce targets on sfContactId / sfCpdId
// (Lightning Contact / Compensation__c). Everything else falls back to the
// classic record URL keyed by oppId / accountId.
function sfLinkForExample(
  ex: ProductLogicExample,
  kind: "account" | "opp",
): string | null {
  if (ex.source === "cpd") {
    if (kind === "account" && ex.sfContactId) {
      return `${SF_LIGHTNING}/Contact/${ex.sfContactId}/view`;
    }
    if (kind === "opp" && ex.sfCpdId) {
      return `${SF_LIGHTNING}/Compensation__c/${ex.sfCpdId}/view`;
    }
    return null;
  }
  const id = kind === "account" ? ex.accountId : ex.oppId;
  return id ? sfClassicRecordUrl(id) : null;
}

function sfLinkForOpp(opp: FallthroughOpp): string | null {
  if (opp.sfCpdId) return `${SF_LIGHTNING}/Compensation__c/${opp.sfCpdId}/view`;
  return opp.oppId ? sfClassicRecordUrl(opp.oppId) : null;
}

// Default MRR field for a freshly-authored rule, keyed by the opp's type so the
// prefill matches the legacy seed rules (changeInMrr for Unified/Cancel,
// splitTotalPrice otherwise).
function defaultMrrFieldForType(type?: string): MrrField {
  const t = (type || "").trim();
  if (t === "Unified Opp" || t === "Cancel") return "changeInMrr";
  return "splitTotalPrice";
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchConfig(): Promise<ProductLogicConfig> {
  const res = await fetch(`${API_BASE}/config`, {
    headers: buildHeaders(false),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to load product logic (${res.status})`);
  const data = (await res.json()) as { config: ProductLogicConfig };
  return data.config;
}

async function fetchExamples(): Promise<ProductLogicExample[]> {
  const res = await fetch(`${API_BASE}/examples`, {
    headers: buildHeaders(false),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to load examples (${res.status})`);
  const data = (await res.json()) as { examples: ProductLogicExample[] };
  return data.examples ?? [];
}

async function fetchFallthrough(): Promise<FallthroughOpp[]> {
  // Task #380: ask the server for only the unattributed ("Other" / "No Product
  // Selected") opps. Previously this fetched the entire MRR opportunity set and
  // filtered in the browser, producing a payload large enough to trip the prod
  // proxy (browser saw a 500 while the origin returned 200).
  const res = await fetch(`/api/sales/opportunities?type=mrr&unattributed=1`, {
    headers: buildHeaders(false),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to load opportunities (${res.status})`);
  const data = (await res.json()) as { opportunities?: FallthroughOpp[] };
  return data.opportunities ?? [];
}

// ---------------------------------------------------------------------------
// Opp tester (Task #572) — mirrors the Compensation tab's per-rule tester.
// ---------------------------------------------------------------------------

type PlCondStatus = "match" | "noMatch" | "notTestable";

interface PlTestResult {
  found: boolean;
  allMatch?: boolean;
  // Aligned index-for-index to the tested rule's conditions.
  conditions?: PlCondStatus[];
  failingOppProductIds?: string[];
  // Earlier rule that claims the opp first (only set when allMatch).
  winner?: { index: number; label: string } | null;
  rowCount?: number;
}

type PlTestState = {
  oppId: string;
  result: PlTestResult | null;
  loading: boolean;
  error: string | null;
};

async function fetchPlTest(
  oppId: string,
  ruleIndex: number,
  rules: ProductLogicRule[],
): Promise<PlTestResult> {
  const res = await fetch(`${API_BASE}/test-opp`, {
    method: "POST",
    headers: buildHeaders(true),
    credentials: "include",
    body: JSON.stringify({ oppId, ruleIndex, rules }),
  });
  if (!res.ok) {
    let msg = `Failed to test opp (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as PlTestResult;
}

// Map a per-condition diagnosis to its highlight classes (same palette as the
// Compensation tab testers). `undefined` = no active test → no highlight.
function plCondStatusClasses(status: PlCondStatus | undefined): string {
  if (status === "match") return "bg-green-50 border border-green-300";
  if (status === "noMatch") return "bg-red-50 border border-red-300";
  if (status === "notTestable") return "bg-gray-50 border border-gray-300";
  return "";
}

// ---------------------------------------------------------------------------

type SaveState = "idle" | "saving" | "saved" | "error";

interface ProductLogicViewProps {
  authUser: AuthUser;
}

export default function ProductLogicView({ authUser }: ProductLogicViewProps) {
  const role = authUser?.role ?? null;
  const viewOnly = authUser?.viewOnly === true;
  const canEdit =
    !viewOnly && (role === "admin" || role === "slm" || role === "exec");

  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: ["product-logic-config"],
    queryFn: fetchConfig,
  });
  const examplesQuery = useQuery({
    queryKey: ["product-logic-examples"],
    queryFn: fetchExamples,
  });
  const fallthroughQuery = useQuery({
    queryKey: ["product-logic-fallthrough"],
    queryFn: fetchFallthrough,
  });
  const salesConfigQuery = useGetSalesConfig();

  const [draft, setDraft] = useState<ProductLogicConfig | null>(null);
  const [baseline, setBaseline] = useState<ProductLogicConfig | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [fallthroughPage, setFallthroughPage] = useState(0);

  // Task #572: per-rule opp tester state (keyed by rule id) + debounce timers.
  const [oppTests, setOppTests] = useState<Record<string, PlTestState>>({});
  const oppTestSeq = useRef<Record<string, number>>({});
  const oppTestTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>(
    {},
  );

  // Schedule (debounced) a test of one rule against a pasted opp id, always
  // evaluated against the CURRENT (possibly unsaved) draft rule list.
  const scheduleOppTest = useCallback(
    (ruleId: string, oppId: string, rules: ProductLogicRule[]) => {
      const id = oppId.trim();
      if (oppTestTimers.current[ruleId]) {
        clearTimeout(oppTestTimers.current[ruleId]);
      }
      if (!id) return;
      const ruleIndex = rules.findIndex((r) => r.id === ruleId);
      if (ruleIndex < 0) return;
      // Per-rule request sequencing: only the LATEST scheduled test may write
      // its result, so an older response (old rules snapshot) can never
      // overwrite a newer one arriving out of order.
      const seq = (oppTestSeq.current[ruleId] ?? 0) + 1;
      oppTestSeq.current[ruleId] = seq;
      oppTestTimers.current[ruleId] = setTimeout(() => {
        void (async () => {
          try {
            const result = await fetchPlTest(id, ruleIndex, rules);
            if (oppTestSeq.current[ruleId] !== seq) return; // stale response
            setOppTests((prev) => {
              if ((prev[ruleId]?.oppId ?? "").trim() !== id) return prev; // stale
              return {
                ...prev,
                [ruleId]: {
                  oppId: prev[ruleId].oppId,
                  result,
                  loading: false,
                  error: null,
                },
              };
            });
          } catch (e) {
            if (oppTestSeq.current[ruleId] !== seq) return; // stale response
            setOppTests((prev) => {
              if ((prev[ruleId]?.oppId ?? "").trim() !== id) return prev; // stale
              return {
                ...prev,
                [ruleId]: {
                  oppId: prev[ruleId].oppId,
                  result: null,
                  loading: false,
                  error: e instanceof Error ? e.message : "Failed to test opp",
                },
              };
            });
          }
        })();
      }, 400);
    },
    [],
  );

  // Update a rule's opp-id input and (re)run or reset its test.
  const setOppTestId = useCallback(
    (ruleId: string, oppId: string, rules: ProductLogicRule[]) => {
      const id = oppId.trim();
      setOppTests((prev) => ({
        ...prev,
        [ruleId]: {
          oppId,
          // Keep the prior result visible while a new lookup is in flight;
          // clear entirely when the field is emptied.
          result: id ? (prev[ruleId]?.result ?? null) : null,
          loading: id.length > 0,
          error: null,
        },
      }));
      scheduleOppTest(ruleId, oppId, rules);
    },
    [scheduleOppTest],
  );

  // Re-run active tests whenever the draft rules change so the diagnosis always
  // reflects the CURRENT (possibly unsaved) edits, including rule reordering.
  useEffect(() => {
    const rules = draft?.rules;
    if (!rules) return;
    for (const [ruleId, t] of Object.entries(oppTests)) {
      if (!t.oppId.trim()) continue;
      if (!rules.some((r) => r.id === ruleId)) continue;
      scheduleOppTest(ruleId, t.oppId, rules);
    }
    // Intentionally NOT keyed on oppTests: input changes schedule their own
    // test via setOppTestId; this effect only reacts to rule edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.rules, scheduleOppTest]);

  useEffect(() => {
    if (configQuery.data) {
      setDraft(clone(configQuery.data));
      setBaseline(clone(configQuery.data));
      setSaveState("idle");
      setSaveError(null);
    }
  }, [configQuery.data]);

  // Reset to the first page whenever the underlying list changes (data refresh,
  // filter change) so we never land on an out-of-range page.
  useEffect(() => {
    setFallthroughPage(0);
  }, [fallthroughQuery.data]);

  const dirty = useMemo(() => {
    if (!draft || !baseline) return false;
    return JSON.stringify(draft) !== JSON.stringify(baseline);
  }, [draft, baseline]);

  // Per-rule validation mirroring the server's PUT validator so we never POST a
  // payload it will 400 on: literal assign needs a non-empty product, and
  // in/notIn conditions need at least one value.
  const ruleErrors = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const r of draft?.rules ?? []) {
      const msgs: string[] = [];
      if (r.assign.kind === "literal" && !r.assign.product?.trim()) {
        msgs.push("Choose a product to assign.");
      }
      r.conditions.forEach((c, i) => {
        if (c.op === "in" || c.op === "notIn") {
          if (!Array.isArray(c.value) || c.value.length === 0) {
            msgs.push(`Condition ${i + 1} needs at least one value.`);
          }
        }
      });
      if (msgs.length) map.set(r.id, msgs);
    }
    return map;
  }, [draft]);

  const errorCount = ruleErrors.size;
  const canSave = dirty && errorCount === 0 && saveState !== "saving";

  const exampleByRule = useMemo(() => {
    const map = new Map<string, ProductLogicExample>();
    for (const ex of examplesQuery.data ?? []) {
      if (!map.has(ex.ruleId)) map.set(ex.ruleId, ex);
    }
    return map;
  }, [examplesQuery.data]);

  // Union of known products for the literal-assign picklist and rename dialog:
  // sales-config products + any literal product already referenced by a rule +
  // any product that already has a rename entry.
  const productOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of salesConfigQuery.data?.products ?? []) set.add(p);
    for (const r of draft?.rules ?? []) {
      if (r.assign.kind === "literal" && r.assign.product?.trim()) {
        set.add(r.assign.product.trim());
      }
    }
    for (const e of draft?.renameMap ?? []) {
      if (e.canonical?.trim()) set.add(e.canonical.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [salesConfigQuery.data, draft]);

  // ---- mutators ---------------------------------------------------------

  const mutateRules = (fn: (rules: ProductLogicRule[]) => ProductLogicRule[]) => {
    if (!canEdit) return;
    setDraft((d) => (d ? { ...d, rules: fn(clone(d.rules)) } : d));
  };

  const updateRule = (idx: number, patch: Partial<ProductLogicRule>) =>
    mutateRules((rules) =>
      rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );

  const updateCondition = (
    ruleIdx: number,
    condIdx: number,
    patch: Partial<CompCondition>,
  ) =>
    mutateRules((rules) =>
      rules.map((r, i) => {
        if (i !== ruleIdx) return r;
        const conditions = r.conditions.map((c, j) =>
          j === condIdx ? { ...c, ...patch } : c,
        );
        return { ...r, conditions };
      }),
    );

  const changeOp = (ruleIdx: number, condIdx: number, op: ConditionOp) => {
    const rule = draft?.rules[ruleIdx];
    const cond = rule?.conditions[condIdx];
    if (!cond) return;
    const isList = op === "in" || op === "notIn";
    const wasList = cond.op === "in" || cond.op === "notIn";
    let value = cond.value;
    if (isList && !wasList) {
      const s = String(cond.value ?? "").trim();
      value = s ? [s] : [];
    } else if (!isList && wasList) {
      value = Array.isArray(cond.value) ? String(cond.value[0] ?? "") : "";
    }
    updateCondition(ruleIdx, condIdx, { op, value });
  };

  const addCondition = (ruleIdx: number) =>
    mutateRules((rules) =>
      rules.map((r, i) =>
        i === ruleIdx
          ? {
              ...r,
              conditions: [
                ...r.conditions,
                { field: "type" as ConditionField, op: "eq" as ConditionOp, value: "" },
              ],
            }
          : r,
      ),
    );

  const removeCondition = (ruleIdx: number, condIdx: number) =>
    mutateRules((rules) =>
      rules.map((r, i) =>
        i === ruleIdx
          ? { ...r, conditions: r.conditions.filter((_, j) => j !== condIdx) }
          : r,
      ),
    );

  const insertRule = (rule: ProductLogicRule) => {
    mutateRules((rules) => {
      const catchAllIdx = rules.findIndex((r) => r.isCatchAll);
      if (catchAllIdx === -1) return [...rules, rule];
      const next = [...rules];
      next.splice(catchAllIdx, 0, rule);
      return next;
    });
    setHighlightId(rule.id);
  };

  const addRule = () =>
    insertRule({
      id: genId(),
      label: "New rule",
      conditions: [{ field: "type", op: "eq", value: "" }],
      assign: { kind: "literal", product: "" },
      mrrField: "splitTotalPrice",
      treatAsClosedWon: false,
      source: "feeder",
    });

  const removeRule = (idx: number) =>
    mutateRules((rules) => rules.filter((_, i) => i !== idx));

  const moveRule = (idx: number, dir: -1 | 1) =>
    mutateRules((rules) => {
      const target = idx + dir;
      if (target < 0 || target >= rules.length) return rules;
      // Never reorder past the catch-all; it stays terminal.
      if (rules[idx].isCatchAll || rules[target].isCatchAll) return rules;
      const next = [...rules];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });

  const createRuleFromOpp = (opp: FallthroughOpp) => {
    const conditions: CompCondition[] = [];
    if (opp.type?.trim()) {
      conditions.push({ field: "type", op: "eq", value: opp.type.trim() });
    }
    if (opp.rawProduct?.trim()) {
      conditions.push({
        field: "rawProduct",
        op: "eq",
        value: opp.rawProduct.trim(),
      });
    }
    if (conditions.length === 0) {
      conditions.push({ field: "type", op: "eq", value: "" });
    }
    insertRule({
      id: genId(),
      label: `From: ${opp.oppName || opp.accountName || "opportunity"}`.slice(
        0,
        80,
      ),
      conditions,
      assign: {
        kind: "literal",
        product: opp.rawProduct?.trim() || opp.productFamily?.trim() || "",
      },
      mrrField: defaultMrrFieldForType(opp.type),
      treatAsClosedWon: false,
      source: "feeder",
    });
  };

  const setRename = (
    canonical: string,
    key: "filterName" | "abbreviation" | "oppNameOverride",
    value: string,
  ) => {
    if (!canEdit) return;
    setDraft((d) => {
      if (!d) return d;
      const map = clone(d.renameMap);
      const i = map.findIndex((e) => e.canonical === canonical);
      if (i === -1) map.push({ canonical, [key]: value });
      else map[i] = { ...map[i], [key]: value };
      // Drop entries that carry no overrides so we never persist empty rows.
      const cleaned = map.filter(
        (e) =>
          e.filterName?.trim() ||
          e.abbreviation?.trim() ||
          e.oppNameOverride?.trim(),
      );
      return { ...d, renameMap: cleaned };
    });
  };

  const renameValue = (
    canonical: string,
    key: "filterName" | "abbreviation" | "oppNameOverride",
  ): string => {
    const e = draft?.renameMap.find((x) => x.canonical === canonical);
    return (e?.[key] as string | undefined) ?? "";
  };

  // ---- save -------------------------------------------------------------

  const discard = () => {
    if (baseline) setDraft(clone(baseline));
    setSaveState("idle");
    setSaveError(null);
  };

  const save = async () => {
    if (!draft || !canEdit || errorCount > 0) return;
    setSaveState("saving");
    setSaveError(null);
    try {
      const res = await fetch(`${API_BASE}/config`, {
        method: "PUT",
        headers: buildHeaders(true),
        credentials: "include",
        body: JSON.stringify({ rules: draft.rules, renameMap: draft.renameMap }),
      });
      if (!res.ok) {
        let msg = `Save failed (${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {
          /* ignore */
        }
        setSaveError(msg);
        setSaveState("error");
        return;
      }
      const data = (await res.json()) as { config: ProductLogicConfig };
      setBaseline(clone(data.config));
      setDraft(clone(data.config));
      setSaveState("saved");
      // Attribution + display labels changed server-side; refresh the dashboard
      // and the per-rule examples so they reflect the new rules.
      queryClient.invalidateQueries();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
      setSaveState("error");
    }
  };

  // ---- render -----------------------------------------------------------

  if (configQuery.isError) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-red-600 py-8">
        <AlertCircle className="w-4 h-4" />
        {(configQuery.error as Error)?.message ||
          "Failed to load product logic."}
      </div>
    );
  }

  if (configQuery.isLoading || !draft) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground py-8">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading product logic…
      </div>
    );
  }

  const fallthrough = fallthroughQuery.data ?? [];
  const FALLTHROUGH_PAGE_SIZE = 50;
  const fallthroughPageCount = Math.max(
    1,
    Math.ceil(fallthrough.length / FALLTHROUGH_PAGE_SIZE),
  );
  const fallthroughCurrentPage = Math.min(
    fallthroughPage,
    fallthroughPageCount - 1,
  );
  const fallthroughStart = fallthroughCurrentPage * FALLTHROUGH_PAGE_SIZE;
  const fallthroughPageRows = fallthrough.slice(
    fallthroughStart,
    fallthroughStart + FALLTHROUGH_PAGE_SIZE,
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold text-foreground">
            Product Attribution Rules
          </h3>
          <p className="text-[11px] text-muted-foreground">
            Evaluated top-to-bottom; the first rule whose conditions all match
            attributes the opportunity's product and MRR.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {errorCount > 0 && (
            <span className="text-[11px] text-red-600 inline-flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> Fix {errorCount} rule
              {errorCount === 1 ? "" : "s"} before saving
            </span>
          )}
          <SaveStatus
            saveState={saveState}
            saveError={saveError}
            dirty={dirty}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-[12px]"
            onClick={() => setRenameOpen(true)}
          >
            <Pencil className="w-3.5 h-3.5 mr-1" /> Rename products
          </Button>
          {canEdit && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[12px]"
                onClick={addRule}
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add rule
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[12px]"
                onClick={discard}
                disabled={!dirty || saveState === "saving"}
              >
                Discard
              </Button>
              <Button
                size="sm"
                className="h-8 text-[12px] bg-[#006AFF] hover:bg-[#005ce6]"
                onClick={save}
                disabled={!canSave}
              >
                {saveState === "saving" ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> Saving…
                  </>
                ) : (
                  "Save changes"
                )}
              </Button>
            </>
          )}
        </div>
      </div>

      {!canEdit && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground bg-muted/50 border border-border rounded-md px-3 py-2">
          <Lock className="w-3.5 h-3.5" />
          Read-only — you don't have permission to edit product logic.
        </div>
      )}

      {/* Rule cards */}
      <div className="flex flex-col gap-3">
        {draft.rules.map((rule, idx) => (
          <RuleCard
            key={rule.id}
            rule={rule}
            idx={idx}
            total={draft.rules.length}
            canEdit={canEdit}
            highlight={rule.id === highlightId}
            productOptions={productOptions}
            example={exampleByRule.get(rule.id)}
            errors={ruleErrors.get(rule.id)}
            test={oppTests[rule.id]}
            onTestIdChange={(v) => setOppTestId(rule.id, v, draft.rules)}
            onUpdate={(patch) => updateRule(idx, patch)}
            onUpdateCondition={(ci, patch) => updateCondition(idx, ci, patch)}
            onChangeOp={(ci, op) => changeOp(idx, ci, op)}
            onAddCondition={() => addCondition(idx)}
            onRemoveCondition={(ci) => removeCondition(idx, ci)}
            onRemove={() => removeRule(idx)}
            onMove={(dir) => moveRule(idx, dir)}
          />
        ))}
      </div>

      {/* Fallthrough table */}
      <div className="flex flex-col gap-2 mt-2">
        <div>
          <h3 className="text-[13px] font-semibold text-foreground">
            Unattributed opportunities
          </h3>
          <p className="text-[11px] text-muted-foreground">
            Opps the rules left as “Other” / “No Product Selected”. Author a rule
            to claim them.
          </p>
        </div>
        {fallthroughQuery.isLoading ? (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground py-3">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading opportunities…
          </div>
        ) : fallthroughQuery.isError ? (
          <div className="flex items-center gap-2 text-[12px] text-red-600 py-3">
            <AlertCircle className="w-4 h-4" />
            {(fallthroughQuery.error as Error)?.message ||
              "Failed to load opportunities."}
          </div>
        ) : fallthrough.length === 0 ? (
          <div className="text-[12px] text-muted-foreground py-3">
            No unattributed opportunities — every opp is claimed by a rule.
          </div>
        ) : (
          <div className="border border-border rounded-md overflow-hidden">
            <table className="w-full text-[12px]">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Account</th>
                  <th className="text-left font-medium px-3 py-2">
                    Opportunity
                  </th>
                  <th className="text-left font-medium px-3 py-2">Type</th>
                  <th className="text-left font-medium px-3 py-2">
                    Product Family
                  </th>
                  <th className="text-left font-medium px-3 py-2">Raw Product</th>
                  <th className="text-left font-medium px-3 py-2">Current</th>
                  {canEdit && <th className="px-3 py-2" />}
                </tr>
              </thead>
              <tbody>
                {fallthroughPageRows.map((opp, i) => {
                  const link = sfLinkForOpp(opp);
                  return (
                    <tr key={opp.oppId || i} className="border-t border-border">
                      <td className="px-3 py-1.5">{opp.accountName || "—"}</td>
                      <td className="px-3 py-1.5">
                        {link ? (
                          <a
                            href={link}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[#006AFF] hover:underline inline-flex items-center gap-1"
                          >
                            {opp.oppName || "—"}
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : (
                          opp.oppName || "—"
                        )}
                      </td>
                      <td className="px-3 py-1.5">{opp.type || "—"}</td>
                      <td className="px-3 py-1.5">{opp.productFamily ? displayProductText(opp.productFamily) : "—"}</td>
                      <td className="px-3 py-1.5">{opp.rawProduct ? displayProductText(opp.rawProduct) : "—"}</td>
                      <td className="px-3 py-1.5">{displayProduct(opp.product) || "—"}</td>
                      {canEdit && (
                        <td className="px-3 py-1.5 text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-[11px]"
                            onClick={() => createRuleFromOpp(opp)}
                          >
                            <Plus className="w-3 h-3 mr-1" /> Create rule
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="flex items-center justify-between gap-3 px-3 py-2 bg-muted/30 border-t border-border">
              <span className="text-[11px] text-muted-foreground">
                Page {fallthroughCurrentPage + 1} of {fallthroughPageCount} —{" "}
                {fallthrough.length} unattributed opp
                {fallthrough.length === 1 ? "" : "s"}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => setFallthroughPage((p) => Math.max(0, p - 1))}
                  disabled={fallthroughCurrentPage === 0}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() =>
                    setFallthroughPage((p) =>
                      Math.min(fallthroughPageCount - 1, p + 1),
                    )
                  }
                  disabled={fallthroughCurrentPage >= fallthroughPageCount - 1}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        canEdit={canEdit}
        products={productOptions}
        valueOf={renameValue}
        onChange={setRename}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function SaveStatus({
  saveState,
  saveError,
  dirty,
}: {
  saveState: SaveState;
  saveError: string | null;
  dirty: boolean;
}) {
  if (saveState === "error") {
    return (
      <span className="text-[11px] text-red-600 inline-flex items-center gap-1">
        <AlertCircle className="w-3.5 h-3.5" /> {saveError || "Save failed"}
      </span>
    );
  }
  if (saveState === "saved" && !dirty) {
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

// ---------------------------------------------------------------------------

// Task #572: the per-rule "Test opp id" field, mirroring the Compensation tab's
// tester. Read-only diagnostic — never gated by edit permission. Shows a
// loading hint, an "Opp not found" message, or an error under the input.
function PlOppTesterField({
  test,
  onChange,
}: {
  test: PlTestState | undefined;
  onChange: (value: string) => void;
}) {
  const oppId = test?.oppId ?? "";
  const notFound =
    !!oppId.trim() &&
    !test?.loading &&
    !test?.error &&
    test?.result?.found === false;
  return (
    <div className="flex flex-col gap-1 w-[190px] shrink-0">
      <Input
        value={oppId}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-[12px]"
        placeholder="Test opp id…"
      />
      {test?.loading && (
        <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> Testing…
        </span>
      )}
      {notFound && (
        <span className="text-[10px] text-amber-700">Opp not found</span>
      )}
      {test?.error && (
        <span className="text-[10px] text-red-600">{test.error}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface RuleCardProps {
  rule: ProductLogicRule;
  idx: number;
  total: number;
  canEdit: boolean;
  highlight: boolean;
  productOptions: string[];
  example: ProductLogicExample | undefined;
  errors: string[] | undefined;
  test: PlTestState | undefined;
  onTestIdChange: (value: string) => void;
  onUpdate: (patch: Partial<ProductLogicRule>) => void;
  onUpdateCondition: (condIdx: number, patch: Partial<CompCondition>) => void;
  onChangeOp: (condIdx: number, op: ConditionOp) => void;
  onAddCondition: () => void;
  onRemoveCondition: (condIdx: number) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}

function RuleCard({
  rule,
  idx,
  total,
  canEdit,
  highlight,
  productOptions,
  example,
  errors,
  test,
  onTestIdChange,
  onUpdate,
  onUpdateCondition,
  onChangeOp,
  onAddCondition,
  onRemoveCondition,
  onRemove,
  onMove,
}: RuleCardProps) {
  const isCatchAll = !!rule.isCatchAll;
  const literalProducts = useMemo(() => {
    const set = new Set(productOptions);
    if (rule.assign.kind === "literal" && rule.assign.product?.trim()) {
      set.add(rule.assign.product.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [productOptions, rule.assign]);

  // Task #572: active tester diagnosis for this card. The card border/tint and
  // the per-condition highlights follow the Compensation tab's palette:
  // green = every line item matches, red = at least one fails, gray = opp not
  // found (not testable).
  const hasTest = !!test?.oppId.trim() && !test.loading && !test.error;
  const result = hasTest ? test?.result : null;
  const cardStatus: PlCondStatus | undefined = !result
    ? undefined
    : !result.found
      ? "notTestable"
      : result.allMatch
        ? "match"
        : "noMatch";
  const cardCls =
    cardStatus === "match"
      ? "border-green-300 bg-green-50/40"
      : cardStatus === "noMatch"
        ? "border-red-300 bg-red-50/40"
        : cardStatus === "notTestable"
          ? "border-gray-300 bg-gray-50/40"
          : "";
  const condStatuses =
    result?.found && result.conditions ? result.conditions : undefined;

  return (
    <Card
      className={`no-shadow ${highlight ? "ring-2 ring-[#006AFF]" : ""} ${cardCls}`}
    >
      <CardContent className="p-3 flex flex-col gap-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-[11px] text-muted-foreground w-5 shrink-0">
              {idx + 1}.
            </span>
            <Input
              value={rule.label}
              onChange={(e) => onUpdate({ label: e.target.value })}
              disabled={!canEdit}
              className="h-8 text-[12px] font-medium"
              placeholder="Rule name"
            />
            {isCatchAll && (
              <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded whitespace-nowrap">
                Catch-all
              </span>
            )}
          </div>
          <PlOppTesterField test={test} onChange={onTestIdChange} />
          {canEdit && (
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => onMove(-1)}
                disabled={idx === 0 || isCatchAll}
                title="Move up"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => onMove(1)}
                disabled={idx >= total - 1 || isCatchAll}
                title="Move down"
              >
                <ArrowDown className="w-3.5 h-3.5" />
              </Button>
              {!isCatchAll && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-red-600 hover:text-red-700"
                  onClick={onRemove}
                  title="Delete rule"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Task #572: tester verdict */}
        {cardStatus === "match" && (
          <div className="flex flex-col gap-0.5 bg-green-50 border border-green-200 rounded px-2 py-1.5">
            <span className="text-[11px] text-green-700 inline-flex items-center gap-1">
              <Check className="w-3 h-3 shrink-0" />
              {result?.winner
                ? `Matches this rule, but Rule #${result.winner.index + 1}${
                    result.winner.label ? ` (${result.winner.label})` : ""
                  } wins first.`
                : "Opp matches this rule — it attributes here."}
            </span>
          </div>
        )}
        {cardStatus === "noMatch" && (
          <div className="flex flex-col gap-0.5 bg-red-50 border border-red-200 rounded px-2 py-1.5">
            <span className="text-[11px] text-red-600 inline-flex items-center gap-1">
              <AlertCircle className="w-3 h-3 shrink-0" />
              {(result?.rowCount ?? 1) > 1
                ? "Opp does not match — at least one line item fails this rule."
                : "Opp does not match this rule."}
            </span>
            {(result?.failingOppProductIds?.length ?? 0) > 0 && (
              <span className="text-[11px] text-red-600">
                Failing Opportunity Product ID
                {result!.failingOppProductIds!.length === 1 ? "" : "s"}:{" "}
                {result!.failingOppProductIds!.join(", ")}
              </span>
            )}
          </div>
        )}

        {errors && errors.length > 0 && (
          <div className="flex flex-col gap-0.5 bg-red-50 border border-red-200 rounded px-2 py-1.5">
            {errors.map((msg, i) => (
              <span
                key={i}
                className="text-[11px] text-red-600 inline-flex items-center gap-1"
              >
                <AlertCircle className="w-3 h-3 shrink-0" /> {msg}
              </span>
            ))}
          </div>
        )}

        {/* Conditions */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">
              Conditions
            </span>
            {canEdit && !isCatchAll && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[11px]"
                onClick={onAddCondition}
              >
                <Plus className="w-3 h-3 mr-1" /> Add condition
              </Button>
            )}
          </div>
          {rule.conditions.length === 0 ? (
            <div className="text-[11px] text-muted-foreground italic">
              {isCatchAll
                ? "No conditions — matches every remaining opportunity."
                : "No conditions — matches everything."}
            </div>
          ) : (
            rule.conditions.map((cond, ci) => {
              const isList = cond.op === "in" || cond.op === "notIn";
              const valueText = isList
                ? (Array.isArray(cond.value) ? cond.value : []).join(", ")
                : String(cond.value ?? "");
              return (
                <div
                  key={ci}
                  className={`flex items-center gap-1.5 rounded px-1 py-0.5 ${plCondStatusClasses(condStatuses?.[ci])}`}
                >
                  <Select
                    value={cond.field}
                    onValueChange={(v) =>
                      onUpdateCondition(ci, { field: v as ConditionField })
                    }
                    disabled={!canEdit}
                  >
                    <SelectTrigger className="h-8 w-[150px] text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_OPTIONS.map((o) => (
                        <SelectItem
                          key={o.value}
                          value={o.value}
                          className="text-[12px]"
                        >
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={cond.op}
                    onValueChange={(v) => onChangeOp(ci, v as ConditionOp)}
                    disabled={!canEdit}
                  >
                    <SelectTrigger className="h-8 w-[130px] text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OP_OPTIONS.map((o) => (
                        <SelectItem
                          key={o.value}
                          value={o.value}
                          className="text-[12px]"
                        >
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={valueText}
                    onChange={(e) => {
                      const v = e.target.value;
                      onUpdateCondition(ci, {
                        value: isList
                          ? v
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean)
                          : v,
                      });
                    }}
                    disabled={!canEdit}
                    placeholder={isList ? "comma-separated values" : "value"}
                    className="h-8 text-[12px] flex-1"
                  />
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground"
                      onClick={() => onRemoveCondition(ci)}
                      title="Remove condition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Assignment row */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Assign</span>
            <Select
              value={rule.assign.kind}
              onValueChange={(v) =>
                onUpdate({
                  assign:
                    v === "literal"
                      ? { kind: "literal", product: "" }
                      : { kind: "field", field: "rawProduct" },
                })
              }
              disabled={!canEdit}
            >
              <SelectTrigger className="h-8 w-[130px] text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="literal" className="text-[12px]">
                  Fixed product
                </SelectItem>
                <SelectItem value="field" className="text-[12px]">
                  Copy from field
                </SelectItem>
              </SelectContent>
            </Select>
            {rule.assign.kind === "literal" ? (
              <Select
                value={rule.assign.product || ""}
                onValueChange={(v) =>
                  onUpdate({ assign: { kind: "literal", product: v } })
                }
                disabled={!canEdit}
              >
                <SelectTrigger className="h-8 w-[200px] text-[12px]">
                  <SelectValue placeholder="Select product" />
                </SelectTrigger>
                <SelectContent>
                  {literalProducts.map((p) => (
                    <SelectItem key={p} value={p} className="text-[12px]">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Select
                value={rule.assign.field}
                onValueChange={(v) =>
                  onUpdate({
                    assign: {
                      kind: "field",
                      field: v as "rawProduct" | "productFamily",
                    },
                  })
                }
                disabled={!canEdit}
              >
                <SelectTrigger className="h-8 w-[200px] text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rawProduct" className="text-[12px]">
                    Raw Product
                  </SelectItem>
                  <SelectItem value="productFamily" className="text-[12px]">
                    Product Family
                  </SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">MRR field</span>
            <Select
              value={rule.mrrField}
              onValueChange={(v) => onUpdate({ mrrField: v as MrrField })}
              disabled={!canEdit}
            >
              <SelectTrigger className="h-8 w-[170px] text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {mrrFieldOptionsForSource(rule.source).map((o) => (
                  <SelectItem
                    key={o.value}
                    value={o.value}
                    className="text-[12px]"
                  >
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Source</span>
            <Select
              value={rule.source}
              onValueChange={(v) => {
                const nextSource = v as ProductLogicRule["source"];
                const patch: Partial<ProductLogicRule> = { source: nextSource };
                // Reset the MRR field when the current one belongs to the other
                // source, so an invalid (unscoped) field is never left selected.
                if (MRR_FIELD_SOURCE[rule.mrrField] !== nextSource) {
                  patch.mrrField = defaultMrrFieldForSource(nextSource);
                }
                onUpdate(patch);
              }}
              disabled={!canEdit}
            >
              <SelectTrigger className="h-8 w-[150px] text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="feeder" className="text-[12px]">
                  Salesforce feeder
                </SelectItem>
                <SelectItem value="cpd" className="text-[12px]">
                  CPD (synthetic)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Switch
              checked={rule.treatAsClosedWon}
              onCheckedChange={(c) => onUpdate({ treatAsClosedWon: c })}
              disabled={!canEdit}
            />
            Treat as Closed Won
          </label>
        </div>

        {/* Example opp */}
        <ExampleRow example={example} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ExampleRow({ example }: { example: ProductLogicExample | undefined }) {
  if (!example) {
    return (
      <div className="text-[11px] text-muted-foreground border-t border-border pt-2">
        No example opportunity currently matches this rule.
      </div>
    );
  }
  const oppLink = sfLinkForExample(example, "opp");
  const acctLink = sfLinkForExample(example, "account");
  const fields = example.fields ?? {};
  const entries = Object.entries(fields).filter(([, v]) => v != null && v !== "");
  return (
    <div className="border-t border-border pt-2 flex flex-col gap-1">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium">Example opp:</span>
        {oppLink ? (
          <a
            href={oppLink}
            target="_blank"
            rel="noreferrer"
            className="text-[#006AFF] hover:underline inline-flex items-center gap-1"
          >
            View opportunity <ExternalLink className="w-3 h-3" />
          </a>
        ) : (
          <span>—</span>
        )}
        {acctLink && (
          <a
            href={acctLink}
            target="_blank"
            rel="noreferrer"
            className="text-[#006AFF] hover:underline inline-flex items-center gap-1"
          >
            Account <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
      {entries.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          {entries.map(([k, v]) => (
            <span key={k} className="text-[11px] text-muted-foreground">
              <span className="text-foreground/70">{k}:</span>{" "}
              {displayProductText(String(v))}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RenameDialog({
  open,
  onOpenChange,
  canEdit,
  products,
  valueOf,
  onChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  canEdit: boolean;
  products: string[];
  valueOf: (
    canonical: string,
    key: "filterName" | "abbreviation" | "oppNameOverride",
  ) => string;
  onChange: (
    canonical: string,
    key: "filterName" | "abbreviation" | "oppNameOverride",
    value: string,
  ) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-[14px]">Rename products</DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground -mt-2">
          Display-only overrides. Attribution still uses the canonical product
          name; these change how it appears in filters, abbreviations, and
          drilldown opportunity names.
        </p>
        <div className="max-h-[55vh] overflow-y-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-muted/50 text-muted-foreground sticky top-0">
              <tr>
                <th className="text-left font-medium px-2 py-2">Product</th>
                <th className="text-left font-medium px-2 py-2">
                  Filter label
                </th>
                <th className="text-left font-medium px-2 py-2">Abbreviation</th>
                <th className="text-left font-medium px-2 py-2">
                  Opp-name override
                </th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-2 py-3 text-muted-foreground italic"
                  >
                    No products available yet.
                  </td>
                </tr>
              ) : (
                products.map((p) => (
                  <tr key={p} className="border-t border-border">
                    <td className="px-2 py-1.5 font-medium text-foreground whitespace-nowrap">
                      {p}
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        value={valueOf(p, "filterName")}
                        onChange={(e) =>
                          onChange(p, "filterName", e.target.value)
                        }
                        disabled={!canEdit}
                        placeholder={p}
                        className="h-8 text-[12px]"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        value={valueOf(p, "abbreviation")}
                        onChange={(e) =>
                          onChange(p, "abbreviation", e.target.value)
                        }
                        disabled={!canEdit}
                        placeholder={p}
                        className="h-8 text-[12px]"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        value={valueOf(p, "oppNameOverride")}
                        onChange={(e) =>
                          onChange(p, "oppNameOverride", e.target.value)
                        }
                        disabled={!canEdit}
                        placeholder="(none)"
                        className="h-8 text-[12px]"
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <DialogFooter>
          <Button
            size="sm"
            className="h-8 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
