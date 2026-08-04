// Client helpers for the Executive → Roster tab.
//
// Mirrors goalsApi's raw-fetch convention so DEV impersonation
// (x-impersonate-user-id) flows through on writes.

import type {
  GetRoster200,
  UpsertRosterOverride200,
  UpsertRosterOverrideBody,
} from "@workspace/api-client-react";
import { buildHeaders } from "./goalsApi";

const API_BASE = import.meta.env.BASE_URL || "/";

function apiUrl(path: string): string {
  return `${API_BASE}api/${path}`;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body?.error) return String(body.error);
  } catch {
    /* ignore */
  }
  return `Request failed (${res.status})`;
}

export function fetchRoster(month: string): Promise<GetRoster200> {
  const url = apiUrl(`sales/roster?month=${encodeURIComponent(month)}`);
  return fetch(url, {
    headers: buildHeaders(false),
    credentials: "include",
  }).then(async (res) => {
    if (!res.ok) throw new Error(await errorText(res));
    return (await res.json()) as GetRoster200;
  });
}

export function upsertRosterOverride(
  input: UpsertRosterOverrideBody,
): Promise<UpsertRosterOverride200> {
  return fetch(apiUrl("sales/roster/override"), {
    method: "PUT",
    headers: buildHeaders(true),
    credentials: "include",
    body: JSON.stringify(input),
  }).then(async (res) => {
    if (!res.ok) throw new Error(await errorText(res));
    return (await res.json()) as UpsertRosterOverride200;
  });
}
