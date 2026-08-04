// Google Docs OAuth integration via Replit connector

import { isDemoMode } from "./demo-mode";

interface ConnectorOAuthCredentials {
  access_token?: string;
}

interface ConnectorSettings {
  access_token?: string;
  expires_at?: string;
  oauth?: { credentials?: ConnectorOAuthCredentials };
}

interface ConnectorItem {
  settings?: ConnectorSettings;
}

interface ConnectorsListResponse {
  items?: ConnectorItem[];
}

let connectionSettings: ConnectorItem | null = null;

export async function getAccessToken(): Promise<string | null> {
  // Demo mode never talks to Google — no connector, no token.
  if (isDemoMode()) return null;
  try {
    if (
      connectionSettings &&
      connectionSettings.settings?.expires_at &&
      new Date(connectionSettings.settings.expires_at).getTime() > Date.now()
    ) {
      return (
        connectionSettings.settings.access_token ||
        connectionSettings.settings?.oauth?.credentials?.access_token ||
        null
      );
    }

    const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
    const xReplitToken = process.env.REPL_IDENTITY
      ? "repl " + process.env.REPL_IDENTITY
      : process.env.WEB_REPL_RENEWAL
        ? "depl " + process.env.WEB_REPL_RENEWAL
        : null;

    if (!hostname || !xReplitToken) return null;

    const resp = await fetch(
      "https://" +
        hostname +
        "/api/v2/connection?include_secrets=true&connector_names=google-docs",
      {
        headers: {
          Accept: "application/json",
          "X-Replit-Token": xReplitToken,
        },
      },
    );
    const data = (await resp.json()) as ConnectorsListResponse;
    connectionSettings = data.items?.[0] ?? null;

    const accessToken =
      connectionSettings?.settings?.access_token ||
      connectionSettings?.settings?.oauth?.credentials?.access_token;

    return accessToken || null;
  } catch {
    return null;
  }
}
