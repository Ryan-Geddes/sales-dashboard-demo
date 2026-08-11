// Salesforce 15→18 character id canonicalization.
//
// A Salesforce 18-char id is the 15-char id plus a 3-character checksum derived
// purely from the case pattern of the first 15 chars, so the conversion is a
// deterministic pure function. Databricks enrichment tables store the 18-char
// id; the Pipeline / Stale-Opps feeder sheets historically carry the 15-char
// form. Canonicalizing every opp id up to 18-char at ingestion lets both sides
// join natively and removes the fragile 15-char-prefix bridging.
//
// Synthetic ids (`mod:`, `me:`, `mgr_est:`, composite `{rep}|{date}|{mrr}`
// keys, etc.) are NOT Salesforce ids and must never be rewritten. They all
// contain non-alphanumeric characters, so the strict 15-char-alphanumeric guard
// in `canonicalizeOppId` excludes them. An already-18-char id passes through
// unchanged. Note: Re/Max & ZMX CPD rows now carry their bare Salesforce CPD id
// (a6B…) as their oppId, so they are canonicalized like any other real id.

const SUFFIX_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

// Convert a bare 15-char Salesforce id to its canonical 18-char form. Any input
// that is not exactly 15 alphanumeric chars is returned unchanged.
export function to18CharId(id15: string): string {
  if (id15.length !== 15 || !/^[A-Za-z0-9]{15}$/.test(id15)) return id15;
  let suffix = "";
  for (let chunk = 0; chunk < 3; chunk++) {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const ch = id15[chunk * 5 + i];
      if (ch >= "A" && ch <= "Z") value += 1 << i;
    }
    suffix += SUFFIX_CHARS[value];
  }
  return id15 + suffix;
}

// Canonicalize any opp id to 18-char when (and only when) it is a real bare
// 15-char Salesforce id. Trims whitespace; empty → "". 18-char ids and all
// synthetic / composite ids pass through untouched.
export function canonicalizeOppId(raw: string | undefined | null): string {
  const id = (raw || "").trim();
  if (!id) return "";
  if (id.length === 15 && /^[A-Za-z0-9]{15}$/.test(id)) return to18CharId(id);
  return id;
}
