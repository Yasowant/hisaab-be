import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middlewares/auth";
import { fxService } from "./fx.service";

const router = Router();

const rateQuery = z.object({
  from: z
    .string()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code").refine((c) => c !== "INR", "That's already rupees")),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-02")
    .optional(),
});

// GET /fx/rate?from=THB&date=2026-11-02 → rupees for 1 baht that day
router.get("/rate", requireAuth, async (req: Request, res: Response) => {
  const { from, date } = rateQuery.parse(req.query);
  res.json({ success: true, data: await fxService.rate(from, date) });
});

export default router;
