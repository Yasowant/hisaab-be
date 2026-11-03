import { Router, Request, Response, NextFunction } from "express";
import { recurringService } from "./recurring.service";

/** Adds due repeats before the request reads expenses or balances. */
export const runDueRepeats = async (req: Request, _res: Response, next: NextFunction) => {
  if (req.method === "GET" && req.group && !req.group.closedAt) await recurringService.runDue(req.group);
  next();
};

// Mounted under /groups/:groupId/recurring
const router = Router({ mergeParams: true });

router.get("/", async (req: Request, res: Response) => {
  const recurring = await recurringService.list(req.group!);
  res.json({ success: true, data: { recurring } });
});

router.delete("/:recurringId", async (req: Request<{ recurringId: string }>, res: Response) => {
  await recurringService.stop(req.group!, req.user!.id, req.memberRole!, req.params.recurringId);
  res.status(204).send();
});

export default router;
