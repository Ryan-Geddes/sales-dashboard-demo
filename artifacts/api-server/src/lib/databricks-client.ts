import { logger } from "./logger";
import { isDemoMode } from "./demo-mode";
import { resolveDatabricks } from "./snapshot-context";
import type { DatabricksStatementResponse } from "./databricks-types";

const DEFAULT_HOST = "zg-stplus-lab.cloud.databricks.com";
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

let cachedToken: CachedToken | null = null;
let inFlightTokenPromise: Promise<CachedToken> | null = null;

function getHost(): string {
  const host = process.env.DATABRICKS_HOST?.trim();
  return host && host.length > 0 ? host : DEFAULT_HOST;
}

/**
 * A Databricks Personal Access Token, read from the `DATABRICKS_TOKEN` secret.
 * Used directly as `Authorization: Bearer <token>` — no OAuth minting or expiry
 * handling. This is the PRIMARY auth method; when absent, auth falls back to the
 * service-principal OAuth client-credentials flow below.
 */
function getPat(): string | null {
  const t = process.env.DATABRICKS_TOKEN?.trim();
  return t && t.length > 0 ? t : null;
}

export function isPatConfigured(): boolean {
  return getPat() !== null;
}

export function isServicePrincipalConfigured(): boolean {
  return Boolean(
    process.env.DATABRICKS_CLIENT_ID?.trim() &&
      process.env.DATABRICKS_CLIENT_SECRET?.trim(),
  );
}

async function mintAccessToken(): Promise<CachedToken> {
  const clientId = process.env.DATABRICKS_CLIENT_ID?.trim();
  const clientSecret = process.env.DATABRICKS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Service principal credentials are not configured");
  }

  const host = getHost();
  const url = `https://${host}/oidc/v1/token`;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "all-apis",
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Token mint failed: HTTP ${resp.status} ${resp.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
    );
  }

  const json = (await resp.json()) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  if (!json.access_token) {
    throw new Error("Token mint response missing access_token");
  }

  const expiresInSec = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  const expiresAtMs = Date.now() + expiresInSec * 1000 - TOKEN_REFRESH_BUFFER_MS;

  return { accessToken: json.access_token, expiresAtMs };
}

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs > now) {
    return cachedToken.accessToken;
  }
  if (inFlightTokenPromise) {
    const tok = await inFlightTokenPromise;
    return tok.accessToken;
  }
  inFlightTokenPromise = (async () => {
    try {
      const tok = await mintAccessToken();
      cachedToken = tok;
      return tok;
    } finally {
      inFlightTokenPromise = null;
    }
  })();
  const tok = await inFlightTokenPromise;
  return tok.accessToken;
}

export class DatabricksServicePrincipalError extends Error {
  constructor(
    message: string,
    public readonly stage: "token" | "execute" | "poll",
    /** True when the failure was an auth rejection (HTTP 401/403). Used to
     *  decide whether to fall back from a PAT to the service principal. */
    public readonly authFailure = false,
  ) {
    super(message);
    this.name = "DatabricksServicePrincipalError";
  }
}

type AuthMode = "pat" | "oauth";

interface ExecuteOptions {
  warehouseId: string;
  waitTimeout?: string;
  pollAttempts?: number;
  pollIntervalMs?: number;
  /** Called when a configured PAT is rejected and the client falls back to the
   *  service-principal OAuth flow. Lets callers surface a degraded-auth notice. */
  onAuthFallback?: (message: string) => void;
}

async function resolveToken(mode: AuthMode): Promise<string> {
  if (mode === "pat") {
    const pat = getPat();
    if (!pat) {
      throw new DatabricksServicePrincipalError("DATABRICKS_TOKEN is not configured", "token");
    }
    return pat;
  }
  try {
    return await getAccessToken();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabricksServicePrincipalError(msg, "token");
  }
}

async function runStatementOnce(
  query: string,
  opts: ExecuteOptions,
  mode: AuthMode,
): Promise<DatabricksStatementResponse> {
  const waitTimeout = opts.waitTimeout ?? "50s";
  const pollAttempts = opts.pollAttempts ?? 10;
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;

  const token = await resolveToken(mode);

  const host = getHost();
  const baseUrl = `https://${host}/api/2.0/sql/statements/`;

  let resp: Response;
  try {
    resp = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        warehouse_id: opts.warehouseId,
        statement: query,
        wait_timeout: waitTimeout,
        on_wait_timeout: "CONTINUE",
        format: "JSON_ARRAY",
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabricksServicePrincipalError(msg, "execute");
  }

  if (resp.status === 401 || resp.status === 403) {
    // Invalidate any cached OAuth token so the next mint is fresh; a PAT has no
    // cached state to clear.
    if (mode === "oauth") cachedToken = null;
    const text = await resp.text().catch(() => "");
    throw new DatabricksServicePrincipalError(
      `Statement execute failed: HTTP ${resp.status} ${resp.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
      "execute",
      true,
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new DatabricksServicePrincipalError(
      `Statement execute failed: HTTP ${resp.status} ${resp.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
      "execute",
    );
  }

  let data: DatabricksStatementResponse;
  try {
    data = (await resp.json()) as DatabricksStatementResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabricksServicePrincipalError(`Failed to parse statement response: ${msg}`, "execute");
  }

  if (data.status?.state === "PENDING" || data.status?.state === "RUNNING") {
    const stmtId = data.statement_id;
    if (!stmtId) {
      throw new DatabricksServicePrincipalError("Missing statement_id while polling", "poll");
    }
    let pollData: DatabricksStatementResponse = data;
    for (let i = 0; i < pollAttempts; i++) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      let pollResp: Response;
      try {
        pollResp = await fetch(`${baseUrl}${stmtId}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new DatabricksServicePrincipalError(msg, "poll");
      }
      if (pollResp.status === 401 || pollResp.status === 403) {
        if (mode === "oauth") cachedToken = null;
        const text = await pollResp.text().catch(() => "");
        throw new DatabricksServicePrincipalError(
          `Poll failed: HTTP ${pollResp.status} ${pollResp.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
          "poll",
          true,
        );
      }
      if (!pollResp.ok) {
        const text = await pollResp.text().catch(() => "");
        throw new DatabricksServicePrincipalError(
          `Poll failed: HTTP ${pollResp.status} ${pollResp.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
          "poll",
        );
      }
      try {
        pollData = (await pollResp.json()) as DatabricksStatementResponse;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new DatabricksServicePrincipalError(`Failed to parse poll response: ${msg}`, "poll");
      }
      if (pollData.status?.state === "SUCCEEDED") break;
      if (pollData.status?.state === "FAILED") {
        throw new DatabricksServicePrincipalError(
          pollData.status?.error?.message || "Query failed",
          "poll",
        );
      }
    }
    if (pollData.status?.state !== "SUCCEEDED") {
      throw new DatabricksServicePrincipalError("Query timed out", "poll");
    }
    data = pollData;
  }

  if (data.status?.state !== "SUCCEEDED") {
    throw new DatabricksServicePrincipalError(
      data.status?.error?.message || `Query state: ${data.status?.state}`,
      "execute",
    );
  }

  return data;
}

/**
 * Execute a SQL statement against Databricks.
 *
 * Auth is PAT-first: when `DATABRICKS_TOKEN` is set it is used directly as the
 * bearer token. The service-principal OAuth client-credentials flow is used only
 * as a fallback — when no PAT is configured, or when a configured PAT is
 * rejected (HTTP 401/403). On a 401/403 the cached OAuth token is invalidated.
 */
export async function executeStatement(
  query: string,
  opts: ExecuteOptions,
): Promise<DatabricksStatementResponse> {
  // Task #393: route through the snapshot context so a capture records the raw
  // data_array and a replay serves the stored one instead of hitting Databricks.
  //
  // Demo mode: resolveDatabricks serves the bundled fixture (or an empty result
  // for an unseen query) and NEVER invokes `live`, so no DATABRICKS_* secret is
  // required. The extra guard here makes that contract explicit — a live call
  // in demo mode is a bug, not a silent outbound request.
  return resolveDatabricks(query, () => {
    if (isDemoMode()) {
      return Promise.reject(
        new Error("[Demo] Live Databricks call attempted in demo mode"),
      );
    }
    return executeStatementLive(query, opts);
  });
}

async function executeStatementLive(
  query: string,
  opts: ExecuteOptions,
): Promise<DatabricksStatementResponse> {
  const modes: AuthMode[] = [];
  if (isPatConfigured()) modes.push("pat");
  if (isServicePrincipalConfigured()) modes.push("oauth");
  if (modes.length === 0) {
    throw new DatabricksServicePrincipalError(
      "No Databricks auth configured: set DATABRICKS_TOKEN (PAT) or DATABRICKS_CLIENT_ID/DATABRICKS_CLIENT_SECRET (service principal)",
      "token",
    );
  }

  let lastErr: unknown;
  for (let i = 0; i < modes.length; i++) {
    const mode = modes[i];
    const isLast = i === modes.length - 1;
    try {
      return await runStatementOnce(query, opts, mode);
    } catch (err) {
      lastErr = err;
      const authFailure = err instanceof DatabricksServicePrincipalError && err.authFailure;
      // Only fall back from a rejected PAT to the service principal. Any other
      // error (or the last available mode failing) propagates to the caller.
      if (mode === "pat" && authFailure && !isLast) {
        const msg = err instanceof Error ? err.message : String(err);
        const fallbackMsg = `PAT rejected (${msg}); fell back to service principal OAuth`;
        logger.warn({ err: msg }, `[Databricks] ${fallbackMsg}`);
        opts.onAuthFallback?.(fallbackMsg);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export function _resetTokenCacheForTests(): void {
  cachedToken = null;
  inFlightTokenPromise = null;
}

export { logger as _dbxLogger };
