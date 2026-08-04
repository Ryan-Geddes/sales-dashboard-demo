import { Router, type IRouter, type Request, type Response } from "express";
import { db, userPreferencesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireRole, requireWritable } from "../middlewares/requireRole";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const router: IRouter = Router();

router.get("/me/preferences/:key", requireRole(), async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const key = String(req.params.key);
  const rows = await db
    .select()
    .from(userPreferencesTable)
    .where(and(eq(userPreferencesTable.userId, userId), eq(userPreferencesTable.key, key)))
    .limit(1);
  res.json({ value: rows[0]?.value ?? null });
});

router.put("/me/preferences/:key", requireRole(), requireWritable(), async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const key = String(req.params.key);
  const body = req.body as { value?: unknown } | undefined;
  if (!body || !("value" in body)) {
    res.status(400).json({ error: "Missing 'value' in body" });
    return;
  }
  const value = body.value as JsonValue;
  await db
    .insert(userPreferencesTable)
    .values({ userId, key, value })
    .onConflictDoUpdate({
      target: [userPreferencesTable.userId, userPreferencesTable.key],
      set: { value, updatedAt: new Date() },
    });
  res.json({ value });
});

router.delete("/me/preferences/:key", requireRole(), requireWritable(), async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const key = String(req.params.key);
  await db
    .delete(userPreferencesTable)
    .where(and(eq(userPreferencesTable.userId, userId), eq(userPreferencesTable.key, key)));
  res.json({ success: true });
});

export default router;
