import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildImpersonationList,
  type DbUserLite,
} from "./impersonation-list";
import type { SheetPerson } from "./sheets-data";

const slm = (overrides: Partial<SheetPerson> & { name: string }): SheetPerson => ({
  email: `${overrides.name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
  employeeId: null,
  role: "slm",
  slm: overrides.name,
  flm: null,
  ...overrides,
});
const flm = (overrides: Partial<SheetPerson> & { name: string; slm: string }): SheetPerson => ({
  email: `${overrides.name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
  employeeId: null,
  role: "flm",
  flm: overrides.name,
  ...overrides,
});
const rep = (overrides: Partial<SheetPerson> & { name: string; slm: string; flm: string }): SheetPerson => ({
  email: `${overrides.name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
  employeeId: null,
  role: "rep",
  ...overrides,
});

const dbUser = (overrides: Partial<DbUserLite> & { id: string; email: string | null }): DbUserLite => ({
  firstName: null,
  lastName: null,
  profileImageUrl: null,
  role: "rep",
  hierarchyName: null,
  ...overrides,
});

test("player-coach FLM appears once with role flm", () => {
  // Sheet input is already deduped by sheets-data: walking SLM > FLM > Rep
  // collapses player-coach FLMs to a single entry with role "flm". The
  // merge function should preserve that — never produce a separate "rep" row.
  const people: SheetPerson[] = [
    slm({ name: "Alice SLM" }),
    flm({ name: "Pat Coach", slm: "Alice SLM" }),
    rep({ name: "Reggie Rep", slm: "Alice SLM", flm: "Pat Coach" }),
  ];
  const dbUsers: DbUserLite[] = [
    dbUser({ id: "db-pat", email: "pat.coach@example.com", firstName: "Pat", lastName: "Coach", role: "rep" }),
  ];

  const list = buildImpersonationList(people, dbUsers);
  const patRows = list.filter((u) => u.email === "pat.coach@example.com");
  assert.equal(patRows.length, 1, "player-coach FLM must appear exactly once");
  assert.equal(patRows[0].role, "flm", "role precedence slm > flm > rep collapses to flm");
  assert.equal(patRows[0].id, "db-pat", "uses DB id for impersonation");
  assert.equal(patRows[0].source, "db+sheet");
});

test("sheet-only rep without DB account gets a virtual id", () => {
  const people: SheetPerson[] = [
    slm({ name: "Alice SLM" }),
    flm({ name: "Frank FLM", slm: "Alice SLM" }),
    rep({ name: "Ruby Rep", slm: "Alice SLM", flm: "Frank FLM" }),
  ];
  const list = buildImpersonationList(people, []);
  const ruby = list.find((u) => u.hierarchyName === "Ruby Rep");
  assert.ok(ruby, "Ruby Rep should be present");
  assert.equal(ruby!.id, "org:ruby.rep@example.com", "virtual id is org:<email>");
  assert.equal(ruby!.source, "sheet-only");
  assert.equal(ruby!.role, "rep");
  assert.equal(ruby!.firstName, "Ruby");
  assert.equal(ruby!.lastName, "Rep");
});

test("sheet-only person with no email falls back to org:eid:<employeeId>", () => {
  const people: SheetPerson[] = [
    {
      name: "Edge Case",
      email: null,
      employeeId: "EID-9999",
      role: "rep",
      slm: "Alice SLM",
      flm: "Frank FLM",
    },
  ];
  const list = buildImpersonationList(people, []);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "org:eid:EID-9999");
  assert.equal(list[0].source, "sheet-only");
});

test("DB role disagreeing with sheet role: sheet wins, single row", () => {
  // The DB row says rep but the sheet says flm (sheet was updated, DB is
  // stale). The dedupe key is lowercased email so the rows must collapse.
  const people: SheetPerson[] = [
    slm({ name: "Alice SLM" }),
    flm({ name: "Drift FLM", slm: "Alice SLM", email: "drift@example.com" }),
  ];
  const dbUsers: DbUserLite[] = [
    dbUser({
      id: "db-drift",
      email: "drift@example.com",
      firstName: "Drift",
      lastName: "Person",
      role: "rep",
      hierarchyName: "Drift FLM (Old)",
    }),
  ];

  const list = buildImpersonationList(people, dbUsers);
  const driftRows = list.filter((u) => u.email === "drift@example.com");
  assert.equal(driftRows.length, 1, "stale DB role should not split the row");
  assert.equal(driftRows[0].role, "flm", "sheet role wins");
  assert.equal(driftRows[0].hierarchyName, "Drift FLM", "sheet hierarchy name wins");
  assert.equal(driftRows[0].id, "db-drift", "DB id is preserved");
  assert.equal(driftRows[0].source, "db+sheet");
});

test("DB user with no sheet match is surfaced as an Unmatched row", () => {
  const people: SheetPerson[] = [
    slm({ name: "Alice SLM" }),
  ];
  const dbUsers: DbUserLite[] = [
    dbUser({
      id: "db-stranger",
      email: "stranger@example.com",
      firstName: "Stranger",
      lastName: "Danger",
      role: "rep",
    }),
  ];

  const list = buildImpersonationList(people, dbUsers);
  const stranger = list.find((u) => u.id === "db-stranger");
  assert.ok(stranger, "unmatched DB user should appear");
  assert.equal(stranger!.source, "db-only");
  // And it must come last (after the matched/sheet-only group).
  assert.equal(list[list.length - 1].id, "db-stranger");
});

test("case-only email differences between sheet and DB still match", () => {
  const people: SheetPerson[] = [
    slm({ name: "Alice SLM" }),
    flm({ name: "Casey Case", slm: "Alice SLM", email: "casey.case@example.com" }),
  ];
  const dbUsers: DbUserLite[] = [
    dbUser({
      id: "db-casey",
      // DB stores it with a different case from the sheet.
      email: "Casey.Case@Example.com",
      firstName: "Casey",
      lastName: "Case",
      role: "flm",
    }),
  ];

  const list = buildImpersonationList(people, dbUsers);
  const caseyRows = list.filter((u) => u.id === "db-casey" || u.email?.toLowerCase() === "casey.case@example.com");
  assert.equal(caseyRows.length, 1, "case-only email differences must not split the row");
  assert.equal(caseyRows[0].source, "db+sheet");
  assert.equal(caseyRows[0].id, "db-casey", "uses DB id");
});

test("sort order: SLM, FLM, Rep alphabetical, then Unmatched at the end", () => {
  const people: SheetPerson[] = [
    rep({ name: "Zed Rep", slm: "Alice SLM", flm: "Frank FLM" }),
    rep({ name: "Anna Rep", slm: "Alice SLM", flm: "Frank FLM" }),
    flm({ name: "Frank FLM", slm: "Alice SLM" }),
    slm({ name: "Alice SLM" }),
  ];
  const dbUsers: DbUserLite[] = [
    dbUser({ id: "db-z", email: "z.unmatched@example.com", firstName: "Z", lastName: "Unmatched" }),
    dbUser({ id: "db-a", email: "a.unmatched@example.com", firstName: "A", lastName: "Unmatched" }),
  ];

  const list = buildImpersonationList(people, dbUsers);
  const order = list.map((u) => `${u.source}:${u.role}:${u.hierarchyName ?? u.email}`);
  assert.deepEqual(order, [
    "sheet-only:slm:Alice SLM",
    "sheet-only:flm:Frank FLM",
    "sheet-only:rep:Anna Rep",
    "sheet-only:rep:Zed Rep",
    "db-only:rep:a.unmatched@example.com",
    "db-only:rep:z.unmatched@example.com",
  ]);
});
