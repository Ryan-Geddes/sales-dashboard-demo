import { Router, type IRouter } from "express";
import healthRouter from "./health";
import salesRouter from "./sales";
import sheetsRouter from "./sheets";
import authRouter from "./auth";
import demoAuthRouter from "./auth-demo";
import preferencesRouter from "./preferences";
import goalsRouter from "./goals";
import { isDemoMode } from "../lib/demo-mode";

const router: IRouter = Router();

router.use(healthRouter);
// Demo mode only: the role/name + GitHub-owner login, and the demo logout
// override. Mounted BEFORE authRouter so /logout resolves here instead of the
// OIDC end-session redirect. In live mode these routes do not exist at all.
if (isDemoMode()) {
  router.use(demoAuthRouter);
}
router.use(authRouter);
router.use(preferencesRouter);
router.use(salesRouter);
router.use(goalsRouter);
router.use(sheetsRouter);

export default router;
