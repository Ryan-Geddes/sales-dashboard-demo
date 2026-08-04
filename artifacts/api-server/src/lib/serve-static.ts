// Serve the built data-app frontend from the API server.
//
// On Replit the frontend and the API are two separate deployments, so this is
// OFF by default and the live topology is untouched. The public demo, by
// contrast, is a SINGLE free-tier web service (see render.yaml): one Node
// process serves both `/api/*` and the static React bundle at `/`.
//
// Enabled when DEMO_MODE is on, or explicitly with SERVE_STATIC=1. The bundle
// directory can be overridden with STATIC_DIR; otherwise we probe the usual
// locations of `artifacts/data-app/dist/public` relative to this module and
// the CWD.
//
// The data-app is built with base "/" (see vite.config.ts BASE_PATH default),
// so it must be mounted at the root — which is what happens here. Any non-API
// path that isn't a real file falls through to index.html so client-side
// routing (wouter) works on a hard refresh.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import { logger } from "./logger";
import { isDemoMode } from "./demo-mode";

/** True when this process should also serve the built frontend. */
export function shouldServeStatic(): boolean {
  const explicit = process.env.SERVE_STATIC?.trim().toLowerCase();
  if (explicit === "0" || explicit === "false") return false;
  if (explicit === "1" || explicit === "true") return true;
  return isDemoMode();
}

/** Directory of THIS module, whether running under tsx (ESM) or bundled (CJS). */
function moduleDir(): string | null {
  try {
    if (typeof __dirname === "string" && __dirname.length > 0) return __dirname;
  } catch {
    /* not CJS */
  }
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

/** Candidate locations of the built data-app, most specific first. */
function staticDirCandidates(): string[] {
  const out: string[] = [];
  const fromEnv = process.env.STATIC_DIR?.trim();
  if (fromEnv) out.push(path.resolve(fromEnv));
  const dir = moduleDir();
  const rel = ["artifacts", "data-app", "dist", "public"];
  if (dir) {
    // src/lib -> api-server -> artifacts -> repo root
    out.push(path.resolve(dir, "..", "..", "..", "..", ...rel));
    // dist -> api-server -> artifacts -> repo root
    out.push(path.resolve(dir, "..", "..", "..", ...rel));
  }
  out.push(path.resolve(process.cwd(), ...rel));
  out.push(path.resolve(process.cwd(), "..", "data-app", "dist", "public"));
  return out;
}

function resolveStaticDir(): string | null {
  for (const dir of staticDirCandidates()) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

/**
 * Mount the static frontend on `app`. Call AFTER the /api router so API routes
 * always win. No-op (with a log) when disabled or when no build is present.
 */
export function installStaticFrontend(app: Express): void {
  if (!shouldServeStatic()) return;

  const dir = resolveStaticDir();
  if (!dir) {
    logger.warn(
      { tried: staticDirCandidates() },
      "SERVE_STATIC is on but no built frontend was found — serving API only",
    );
    return;
  }

  // Hashed asset filenames can be cached hard; index.html must not be.
  app.use(
    express.static(dir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  const indexHtml = path.join(dir, "index.html");
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexHtml);
  });

  logger.info({ dir }, "Serving built frontend at /");
}
