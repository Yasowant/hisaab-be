import { Request, Response } from "express";
import { statsService } from "../stats/stats.service";
import { placeholderService } from "../placeholder/placeholder.service";

type Params = { groupId: string; placeholderId: string };

export const extrasController = {
  /** GET /groups/:groupId/stats: spending by category, payer and month, plus the budget */
  async stats(req: Request, res: Response) {
    const stats = await statsService.forGroup(req.group!, req.user!.id);
    res.json({ success: true, data: { stats } });
  },

  /** GET /groups/:groupId/export.csv: every expense and payment as a spreadsheet */
  async exportCsv(req: Request, res: Response) {
    const csv = await statsService.csv(req.group!);
    const safeName = req.group!.name.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "group";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="hisaab-${safeName}.csv"`);
    res.send(csv);
  },

  /** POST /groups/:groupId/placeholders: add someone who isn't on Hisaab yet */
  async addPlaceholder(req: Request, res: Response) {
    const member = await placeholderService.add(req.group!, req.body.name);
    res.status(201).json({ success: true, message: `${member.name} added`, data: { member } });
  },

  /** POST /groups/:groupId/placeholders/:placeholderId/claim: "That's me" */
  async claimPlaceholder(req: Request<Params>, res: Response) {
    await placeholderService.claim(
      req.group!,
      req.user!.id,
      req.memberRole!,
      req.params.placeholderId,
      req.body.userId,
    );
    res.json({ success: true, message: "Linked. Everything they had is now yours." });
  },
};
