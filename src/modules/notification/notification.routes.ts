import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import { notificationService } from "./notification.service";
import { streamUserEvents } from "../events/events";

// Mounted at /api/v1/me
const router = Router();
router.use(requireAuth);

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const readSchema = z.preprocess(
  (v) => v ?? {},
  z.object({ ids: z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(100).optional() }),
);

router.get("/notifications", async (req: Request, res: Response) => {
  const { page, limit } = pageQuery.parse(req.query);
  const { items, unread, meta } = await notificationService.list(req.user!.id, page, limit);
  res.json({ success: true, data: { notifications: items, unread }, meta });
});

router.get("/notifications/unread-count", async (req: Request, res: Response) => {
  res.json({ success: true, data: { unread: await notificationService.unreadCount(req.user!.id) } });
});

// { ids: [...] } marks those; an empty body marks everything as read
router.post("/notifications/read", validate(readSchema), async (req: Request, res: Response) => {
  const updated = await notificationService.markRead(req.user!.id, req.body.ids);
  res.json({ success: true, data: { updated } });
});

router.get("/events", streamUserEvents);

export default router;
