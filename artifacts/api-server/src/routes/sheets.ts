import { Router, type IRouter } from "express";
import { getAccessToken } from "../lib/google-auth";
import { isDemoMode } from "../lib/demo-mode";

const router: IRouter = Router();

const ALLOWED_REDIRECT_HOSTS = [
  "docs.google.com",
  "doc-0g-bs-sheets.googleusercontent.com",
  "doc-00-bs-sheets.googleusercontent.com",
];

function isAllowedRedirectHost(location: string): boolean {
  try {
    const url = new URL(location);
    return ALLOWED_REDIRECT_HOSTS.some(
      (h) => url.hostname === h || url.hostname.endsWith(".googleusercontent.com"),
    );
  } catch {
    return false;
  }
}

function looksLikeCSV(text: string): boolean {
  if (text.trim().startsWith("<!DOCTYPE") || text.trim().startsWith("<html")) {
    return false;
  }
  return true;
}

function parseSheetUrl(url: string): { id: string; gid: string } | null {
  try {
    const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) return null;
    const id = match[1];
    const gidMatch = url.match(/[#&?]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : "0";
    return { id, gid };
  } catch {
    return null;
  }
}

router.get("/sheets/fetch", async (req, res): Promise<void> => {
  // Demo mode: this is an unauthenticated live-Google passthrough. Disable it
  // so the public demo can never be used as an open proxy (and never makes an
  // outbound request).
  if (isDemoMode()) {
    res.status(404).json({ error: "Not available in demo mode" });
    return;
  }

  const rawUrl = req.query.url as string;
  if (!rawUrl) {
    res.status(400).json({ error: "Missing url parameter" });
    return;
  }

  if (!rawUrl.includes("docs.google.com/spreadsheets")) {
    res.status(400).json({ error: "Only Google Sheets URLs are supported" });
    return;
  }

  const parsed = parseSheetUrl(rawUrl);
  if (!parsed) {
    res.status(400).json({ error: "Invalid Google Sheets URL" });
    return;
  }

  const token = await getAccessToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const urls = [
    `https://docs.google.com/spreadsheets/d/${parsed.id}/export?format=csv&gid=${parsed.gid}`,
    `https://docs.google.com/spreadsheets/d/${parsed.id}/gviz/tq?tqx=out:csv&gid=${parsed.gid}`,
    `https://docs.google.com/spreadsheets/d/${parsed.id}/pub?output=csv&gid=${parsed.gid}`,
  ];

  for (const url of urls) {
    try {
      const resp = await fetch(url, { headers, redirect: "manual" });
      const location = resp.headers.get("location") || "";
      if (
        location.includes("accounts.google.com") ||
        location.includes("ServiceLogin")
      ) {
        continue;
      }
      if (resp.status >= 200 && resp.status < 400) {
        let csv: string;
        if (resp.status >= 300 && location) {
          if (!isAllowedRedirectHost(location)) continue;
          const followResp = await fetch(location, { headers });
          if (!followResp.ok) continue;
          csv = await followResp.text();
        } else {
          csv = await resp.text();
        }
        if (!looksLikeCSV(csv)) continue;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.send(csv);
        return;
      }
    } catch {
      continue;
    }
  }

  res.status(502).json({
    error:
      "Could not fetch sheet. Ensure it is shared with your Google account or published to the web.",
  });
});

export default router;
