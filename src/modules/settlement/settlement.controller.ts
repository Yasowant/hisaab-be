import { Request, Response } from "express";
import { settlementService } from "./settlement.service";
import { idempotencyKeySchema, pageQuery } from "./settlement.schema";

type Params = { groupId: string; settlementId: string };

export const settlementController = {
  async record(req: Request, res: Response) {
    const key = idempotencyKeySchema.parse(req.get("Idempotency-Key"));
    const { settlement, replayed } = await settlementService.record(
      req.group!,
      req.user!.id,
      req.memberRole!,
      req.body,
      key,
    );
    res.status(replayed ? 200 : 201).json({
      success: true,
      message: replayed ? "Payment was already recorded" : "Payment recorded",
      data: { settlement },
    });
  },

  async list(req: Request, res: Response) {
    const { page, limit } = pageQuery.parse(req.query);
    const { items, meta } = await settlementService.list(req.group!, page, limit);
    res.json({ success: true, data: { settlements: items }, meta });
  },

  async confirm(req: Request<Params>, res: Response) {
    const settlement = await settlementService.respond(req.group!, req.user!.id, req.memberRole!, req.params.settlementId, true);
    res.json({ success: true, message: "Payment confirmed", data: { settlement } });
  },

  async reject(req: Request<Params>, res: Response) {
    const settlement = await settlementService.respond(req.group!, req.user!.id, req.memberRole!, req.params.settlementId, false);
    res.json({ success: true, message: "Payment rejected", data: { settlement } });
  },

  async remove(req: Request<Params>, res: Response) {
    await settlementService.remove(req.group!, req.user!.id, req.memberRole!, req.params.settlementId);
    res.status(204).send();
  },
};
