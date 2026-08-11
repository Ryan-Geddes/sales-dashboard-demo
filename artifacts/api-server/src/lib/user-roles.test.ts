import { test } from "node:test";
import assert from "node:assert/strict";

// The role overrides and the viewer-fallback domain are configuration
// (ADMIN_EMAILS / EXEC_EMAILS / INTERNAL_EMAIL_DOMAIN env vars), so the suite
// pins its own fixture values and loads the module afterwards. This keeps the
// tests hermetic — they pass on a fresh clone with no environment at all, and
// they don't drift when the real deployment's lists change.
process.env.ADMIN_EMAILS = "admin.one@example.com,admin.two@example.com";
process.env.EXEC_EMAILS = "exec.one@example.com,exec.two@example.com";
process.env.INTERNAL_EMAIL_DOMAIN = "@example.com";
delete process.env.DEV_ADMIN_EMAILS;

const {
  ADMIN_EMAILS,
  EXEC_EMAILS,
  extractEmailFromClaims,
  resolveUserRole,
} = await import("./user-roles");

// Minimal stand-in for the OrgHierarchy shape that resolveUserRole reads.
// Only the fields it actually touches matter here.
type StubHierarchy = {
  slms: string[];
  flmToReps: Record<string, string[]>;
  allReps: Set<string>;
  personToEmail: Record<string, string>;
  // Unused-but-required by the structural type the resolver expects.
  slmToFlms: Record<string, string[]>;
  repToFlm: Record<string, string>;
  repToSlm: Record<string, string>;
  repToRegion: Record<string, string>;
  repToGroup: Record<string, string>;
  repToSegment: Record<string, string>;
  personToEmployeeId: Record<string, string>;
  people: never[];
  emailToPerson: Record<string, never>;
  employeeIdToPerson: Record<string, never>;
};

function makeHierarchy(opts: {
  slms?: string[];
  flmToReps?: Record<string, string[]>;
  reps?: string[];
  personToEmail?: Record<string, string>;
}): StubHierarchy {
  return {
    slms: opts.slms ?? [],
    flmToReps: opts.flmToReps ?? {},
    allReps: new Set(opts.reps ?? []),
    personToEmail: opts.personToEmail ?? {},
    slmToFlms: {},
    repToFlm: {},
    repToSlm: {},
    repToRegion: {},
    repToGroup: {},
    repToSegment: {},
    personToEmployeeId: {},
    people: [],
    emailToPerson: {},
    employeeIdToPerson: {},
  };
}

const okHierarchy = () =>
  makeHierarchy({
    slms: ["Sandra SLM"],
    flmToReps: { "Frank FLM": ["Reggie Rep"] },
    reps: ["Reggie Rep", "Frank FLM"],
    personToEmail: {
      "Sandra SLM": "sandra.slm@example.com",
      "Frank FLM": "frank.flm@example.com",
      "Reggie Rep": "reggie.rep@example.com",
    },
  });

// (a) Internal email not in the hierarchy and not an admin → viewer fallback.
test("internal email not in hierarchy resolves to viewer", async () => {
  const out = await resolveUserRole("emilybate@example.com", {
    fetchHierarchy: async () => okHierarchy() as never,
  });
  assert.equal(out.role, "viewer");
  assert.equal(out.hierarchyName, null);
});

// (b) Internal email present in hierarchy as a rep → rep.
test("internal email present as a rep resolves to rep", async () => {
  const out = await resolveUserRole("reggie.rep@example.com", {
    fetchHierarchy: async () => okHierarchy() as never,
  });
  assert.equal(out.role, "rep");
  assert.equal(out.hierarchyName, "Reggie Rep");
});

// (c) Admin email always resolves to admin, regardless of hierarchy presence.
test("admin email resolves to admin even when not in hierarchy", async () => {
  const adminEmail = [...ADMIN_EMAILS][0];
  const out = await resolveUserRole(adminEmail, {
    fetchHierarchy: async () => makeHierarchy({}) as never,
  });
  assert.equal(out.role, "admin");
});

test("exec email resolves to exec even when not in hierarchy", async () => {
  const execEmail = [...EXEC_EMAILS][0];
  const out = await resolveUserRole(execEmail, {
    fetchHierarchy: async () => makeHierarchy({}) as never,
  });
  assert.equal(out.role, "exec");
});

// Every configured EXEC_EMAILS entry — not just the first — resolves to exec.
test("all configured exec emails resolve to exec when not in hierarchy", async () => {
  assert.ok(EXEC_EMAILS.size > 1);
  for (const email of EXEC_EMAILS) {
    const out = await resolveUserRole(email, {
      fetchHierarchy: async () => makeHierarchy({}) as never,
    });
    assert.equal(out.role, "exec", `${email} should resolve to exec`);
  }
});

test("exec email still resolves to exec when hierarchy fetch throws", async () => {
  const execEmail = [...EXEC_EMAILS][0];
  const out = await resolveUserRole(execEmail, {
    fetchHierarchy: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(out.role, "exec");
});

// (d) External email not in hierarchy → null (the "not provisioned" wall).
test("external email not in hierarchy resolves to null", async () => {
  const out = await resolveUserRole("stranger@external.test", {
    fetchHierarchy: async () => okHierarchy() as never,
  });
  assert.equal(out.role, null);
  assert.equal(out.hierarchyName, null);
});

// (e) `claims.email` missing but a fallback claim is present resolves
// correctly off the fallback. Tests the email-extraction layer plus
// resolveUserRole end-to-end.
test("email extraction falls back to email_address / preferred_username / upn", () => {
  assert.equal(extractEmailFromClaims({ email: "a@example.com" }), "a@example.com");
  assert.equal(
    extractEmailFromClaims({ email_address: "b@example.com" }),
    "b@example.com",
  );
  assert.equal(
    extractEmailFromClaims({ preferred_username: "c@example.com" }),
    "c@example.com",
  );
  assert.equal(
    extractEmailFromClaims({ upn: "d@example.com" }),
    "d@example.com",
  );
  // preferred_username that isn't email-shaped is rejected.
  assert.equal(
    extractEmailFromClaims({ preferred_username: "just-a-handle" }),
    null,
  );
  // Whitespace gets trimmed.
  assert.equal(
    extractEmailFromClaims({ email: "  e@example.com  " }),
    "e@example.com",
  );
  // Claims missing entirely.
  assert.equal(extractEmailFromClaims({}), null);
  assert.equal(extractEmailFromClaims(null), null);
});

test("resolveUserRole resolves off a fallback email claim (no claims.email)", async () => {
  const claims = { preferred_username: "ginap@example.com" };
  const email = extractEmailFromClaims(claims);
  assert.equal(email, "ginap@example.com");
  const out = await resolveUserRole(email, {
    fetchHierarchy: async () => okHierarchy() as never,
  });
  assert.equal(out.role, "viewer");
});

// (f) Hierarchy fetch throws → Internal email still resolves to viewer.
test("internal email still resolves to viewer when hierarchy fetch throws", async () => {
  const out = await resolveUserRole("robynp@example.com", {
    fetchHierarchy: async () => {
      throw new Error("sheets unreachable");
    },
  });
  assert.equal(out.role, "viewer");
  assert.equal(out.hierarchyName, null);
});

test("external email returns null when hierarchy fetch throws", async () => {
  const out = await resolveUserRole("stranger@external.test", {
    fetchHierarchy: async () => {
      throw new Error("sheets unreachable");
    },
  });
  assert.equal(out.role, null);
});

test("admin email still resolves to admin when hierarchy fetch throws", async () => {
  const adminEmail = [...ADMIN_EMAILS][0];
  const out = await resolveUserRole(adminEmail, {
    fetchHierarchy: async () => {
      throw new Error("sheets unreachable");
    },
  });
  assert.equal(out.role, "admin");
});

test("missing/empty email resolves to null", async () => {
  const out1 = await resolveUserRole(null, {
    fetchHierarchy: async () => okHierarchy() as never,
  });
  assert.equal(out1.role, null);
  const out2 = await resolveUserRole("", {
    fetchHierarchy: async () => okHierarchy() as never,
  });
  assert.equal(out2.role, null);
  const out3 = await resolveUserRole("   ", {
    fetchHierarchy: async () => okHierarchy() as never,
  });
  assert.equal(out3.role, null);
});

test("internal email matching is case-insensitive and trims whitespace", async () => {
  const out = await resolveUserRole("  Andym@Example.com  ", {
    fetchHierarchy: async () => okHierarchy() as never,
  });
  assert.equal(out.role, "viewer");
});

test("internal SLM in hierarchy resolves to slm, not viewer", async () => {
  const out = await resolveUserRole("sandra.slm@example.com", {
    fetchHierarchy: async () => okHierarchy() as never,
  });
  assert.equal(out.role, "slm");
  assert.equal(out.hierarchyName, "Sandra SLM");
});

test("internal FLM in hierarchy resolves to flm, not viewer", async () => {
  const out = await resolveUserRole("frank.flm@example.com", {
    fetchHierarchy: async () => okHierarchy() as never,
  });
  assert.equal(out.role, "flm");
  assert.equal(out.hierarchyName, "Frank FLM");
});
