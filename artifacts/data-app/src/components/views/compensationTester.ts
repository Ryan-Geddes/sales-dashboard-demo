import type { CompPairedFiresVerdict } from "@workspace/api-client-react";

// Minimal structural view of a paired rule's per-rule test state, enough to
// resolve the overall header badge verdict. Kept dependency-light (no React) so
// the resolution rule is unit-testable in isolation.
export type PairedHeaderState =
  | {
      oppIds?: string[];
      result?: { paired?: { fires?: CompPairedFiresVerdict } } | null;
    }
  | undefined;

// Task #394: resolve the overall "fires" badge verdict shown in a paired rule's
// header.
//   - No ids entered (all blank, or no state at all) → "incomplete". The badge
//     is ALWAYS visible for paired rules, so the user sees "Incomplete" before
//     they paste anything.
//   - A diagnosis present → use its verdict (fires / doesNotFire / incomplete).
//   - Ids entered but no diagnosis yet (first lookup in flight) → undefined, so
//     the badge stays hidden rather than falsely reading "Incomplete".
export function headerFiresVerdict(
  state: PairedHeaderState,
): CompPairedFiresVerdict | undefined {
  const fromResult = state?.result?.paired?.fires;
  if (fromResult) return fromResult;
  const anyId = state?.oppIds?.some((id) => id.trim() !== "") ?? false;
  return anyId ? undefined : "incomplete";
}
