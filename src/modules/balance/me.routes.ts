import { Router, Request, Response } from "express";
import { z } from "zod";
import { reportService } from "../report/report.service";
import { requireAuth } from "../../middlewares/auth";
import { balanceController } from "./balance.controller";

const router = Router();

router.get("/summary", requireAuth, balanceController.mySummary);

const thisMonth = () => new Date().toISOString().slice(0, 7);
const reportQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month like 2026-11")
    .default(thisMonth),
});

// GET /me/report?month=2026-11: my own spending that month, across all groups
router.get("/report", requireAuth, async (req: Request, res: Response) => {
  const { month } = reportQuery.parse(req.query);
  const report = await reportService.monthly(req.user!.id, month);
  res.json({ success: true, data: { report } });
});

export default router;
