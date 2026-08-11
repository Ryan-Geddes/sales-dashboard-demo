import express, { type Express } from "express";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";
import { devImpersonate } from "./middlewares/devImpersonate";
import { snapshotReplay } from "./middlewares/snapshotReplay";
import { demoSessionScope } from "./middlewares/demoSessionScope";
import { installDemoDbRouting } from "./lib/demo-session";
import { installStaticFrontend } from "./lib/serve-static";
import { installFakeCrm } from "./lib/fake-crm";

// No-op outside DEMO_MODE: with no resolver installed, every query the shared
// `db` handle makes goes straight to the pool exactly as before.
installDemoDbRouting();

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ credentials: true, origin: true }));
// Task #483: gzip responses so large drilldown payloads (e.g. the "All Stages"
// MRR opportunity list) stay under the deployment proxy's response-size limit.
app.use(compression());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(authMiddleware);
app.use(devImpersonate);
// Demo mode: route this request's DB work onto the signed-in demo user's own
// uncommitted transaction (no-op in live mode and for the Owner session).
app.use(demoSessionScope);
// Task #393: per-request data snapshot replay (after auth/impersonation so the
// live DB overrides layered on top still resolve the real user).
app.use(snapshotReplay);

app.use("/api", router);

// Demo mode only: fake Salesforce record pages for the placeholder links the
// demo frontend renders (classic /<id> and /lightning/... URLs). Mounted after
// the /api router and before the SPA catch-all; no-op in live mode.
installFakeCrm(app);

// Single-service demo deployment: also serve the built data-app at /. No-op on
// Replit, where the frontend is its own deployment (see serve-static.ts).
installStaticFrontend(app);

export default app;
