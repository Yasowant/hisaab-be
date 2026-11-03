import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middlewares/auth";
import { idempotencyKeySchema } from "../settlement/settlement.schema";
import { friendService } from "./friend.service";

const router = Router();
router.use(requireAuth);

// GET /me/friends: everyone I share a group with, and the balance with each
router.get("/", async (req: Request, res: Response) => {
  res.json({ success: true, data: { friends: await friendService.list(req.user!.id) } });
});

const settleBody = z.object({ note: z.string().trim().max(140).default("") });

// POST /me/friends/:friendId/settle: settle everything with them, across groups
router.post("/:friendId/settle", async (req: Request, res: Response) => {
  const key = idempotencyKeySchema.parse(req.get("Idempotency-Key"));
  const { note } = settleBody.parse(req.body ?? {});
  const out = await friendService.settle(req.user!.id, String(req.params.friendId), key, note);
  res.status(out.replayed ? 200 : 201).json({ success: true, message: "Payment recorded", data: out });
});

router.post("/batches/:batchId/confirm", async (req: Request, res: Response) => {
  const data = await friendService.respond(req.user!.id, String(req.params.batchId), true);
  res.json({ success: true, message: "Payment confirmed", data });
});
router.post("/batches/:batchId/reject", async (req: Request, res: Response) => {
  const data = await friendService.respond(req.user!.id, String(req.params.batchId), false);
  res.json({ success: true, message: "Payment rejected", data });
});

export default router;
