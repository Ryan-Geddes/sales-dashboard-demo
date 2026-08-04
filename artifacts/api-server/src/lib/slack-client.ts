import { WebClient } from "@slack/web-api";

interface ConnectorSettings {
  settings: {
    access_token?: string;
    expires_at?: string;
    oauth?: {
      credentials?: {
        access_token?: string;
      };
    };
  };
}

let connectionSettings: ConnectorSettings | null = null;

async function getAccessToken(): Promise<string> {
  if (
    connectionSettings &&
    connectionSettings.settings.expires_at &&
    new Date(connectionSettings.settings.expires_at).getTime() > Date.now() &&
    connectionSettings.settings.access_token
  ) {
    return connectionSettings.settings.access_token;
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    throw new Error("X-Replit-Token not found for repl/depl");
  }

  const resp = await fetch(
    "https://" +
      hostname +
      "/api/v2/connection?include_secrets=true&connector_names=slack",
    {
      headers: {
        Accept: "application/json",
        "X-Replit-Token": xReplitToken,
      },
    },
  );
  const data = (await resp.json()) as { items?: ConnectorSettings[] };
  connectionSettings = data.items?.[0] ?? null;

  const accessToken =
    connectionSettings?.settings?.access_token ||
    connectionSettings?.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error("Slack not connected");
  }
  return accessToken;
}

export async function getUncachableSlackClient(): Promise<WebClient> {
  const token = await getAccessToken();
  return new WebClient(token);
}

export async function checkSlackScopes(): Promise<{ ok: boolean; scopes: string[]; missing: string[] }> {
  const token = await getAccessToken();
  const resp = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  const scopeHeader = resp.headers.get("x-oauth-scopes") || "";
  const scopes = scopeHeader
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
  const required = ["users:read", "chat:write"];
  const missing = required.filter((r) => !scopes.includes(r));
  return { ok: missing.length === 0, scopes, missing };
}
