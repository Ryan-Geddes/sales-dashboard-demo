import type { CompPairedCondition } from "@workspace/api-client-react";

// Task #422 — the paired-rule comparative-identity card renders a month/exact
// granularity dropdown next to BOTH the left date field and the right
// `compare-to` date field. The two dropdowns are SLAVED to each other: they read
// and write a single shared `dateGranularity` value (and share their disabled
// state), so editing either one moves the same value and they can never display
// differing granularities. Each dropdown only APPEARS next to its own side when
// that side's field is a date type — so in the normal date-vs-date comparison
// both render together (month / month), making the shared granularity obvious,
// while a non-date field never sprouts a stray granularity control.
// This module is the one source of truth for that behaviour so the two controls
// cannot drift apart, and so it is testable without a DOM.

export type CompDateGranularityValue = "month" | "exact";
export type CompDateGranularitySide = "left" | "right";

// Date-typed identity fields. Mirrors the engine's DATE_IDENTITY_FIELDS: these
// are the only comparative-identity fields that carry a month/exact granularity.
export const DATE_IDENTITY_FIELD_VALUES = new Set([
  "closeDate",
  "fub_first_purchase_date",
]);

export const isCompDateField = (field: unknown): boolean =>
  typeof field === "string" && DATE_IDENTITY_FIELD_VALUES.has(field);

// The single shared granularity value BOTH date dropdowns read. Defaulting here
// (not at each call site) guarantees the left and right controls always display
// the same value.
export const compDateGranularityValue = (
  cond: Pick<CompPairedCondition, "dateGranularity">,
): CompDateGranularityValue =>
  (cond.dateGranularity ?? "month") as CompDateGranularityValue;

// The patch BOTH dropdowns emit on change. It is identical regardless of which
// side the user clicked, which is precisely why editing either one updates the
// single shared value — the controls can never be set to differing values.
export const compDateGranularityPatch = (
  v: CompDateGranularityValue,
): Partial<CompPairedCondition> => ({ dateGranularity: v });

// Whether a given side's granularity dropdown shows. The left control gates on
// the comparative `field`; the right control gates on `compareToField`. A
// dropdown only appears next to a date-typed field, so non-date fields never get
// a stray control.
export const showCompDateGranularity = (
  cond: Pick<CompPairedCondition, "field" | "compareToField">,
  side: CompDateGranularitySide,
): boolean =>
  isCompDateField(side === "left" ? cond.field : cond.compareToField);

export interface CompDateGranularityControl {
  visible: boolean;
  value: CompDateGranularityValue;
  disabled: boolean;
}

// Everything one granularity dropdown needs to render. Visibility is per-side
// (date-typed field only), but `value` and `disabled` come from the shared
// helpers with no side argument — so whenever both sides render they are slaved
// to one another and can never show differing granularities.
export const compDateGranularityControl = (
  cond: Pick<
    CompPairedCondition,
    "field" | "compareToField" | "dateGranularity"
  >,
  side: CompDateGranularitySide,
  canEdit: boolean,
): CompDateGranularityControl => ({
  visible: showCompDateGranularity(cond, side),
  value: compDateGranularityValue(cond),
  disabled: !canEdit,
});
